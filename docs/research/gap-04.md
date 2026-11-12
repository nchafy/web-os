# GAP 4: the hot path of "process = Worker" was unpriced. Null syscall round trip through a SharedArrayBuffer ring, OPFS synchronous I/O, Worker spawn and kill, live-worker memory and ceiling, cross-origin iframe cost, and the frame cost of Aero glass — all measured on real Chrome rather than estimated.

## Verdict

A null syscall through a SAB ring costs 14-16 us mean (p50 10-15 us, p95 25-30 us) — about 1/120th of a frame, so a syscall-per-操作 VFS is affordable. A Worker process costs 1.9 ms to spawn from a Blob URL, 271 KiB of JS-attributed memory, and the renderer survives 3200 live workers but dies between 3200 and 4800. The kernel MUST live in a Worker, not on the main thread: with the main thread 60% busy, a main-thread kernel stalled 52 of 20000 syscalls past 10 ms, while a worker kernel stalled none past 0.52 ms.

## Detail

Harness: `/Users/chafyni/.claude/jobs/e856c39e/tmp/harness/` — `run.py {core|ceiling|frames|aero}`, tables via `table.py` and `area.py`, raw JSON in `out/`. Machine: Apple M2 Pro, 12 cores, 34359738368 B RAM, macOS 26.7.2 arm64, Chrome 157.0.8103.38. Gate: `preflight()` asserted `crossOriginIsolated===true`; observed clock resolution 5.0 us, and 100 us when `negative.py` serves the same tree without COOP/COEP — matching MDN's documented 5 vs 100 us, which validates both gate and clock.

**1. Null syscall, 20000 iterations each (`run.py core`, `www/proc-worker.js`)**

| kernel / main thread | channel | p50 | p95 | mean | max | >10 ms |
|---|---|---|---|---|---|---|
| main, idle | SAB+Atomics.wait | 15.0 us | 30 us | 16.1 us | 0.90 ms | 0 |
| main, idle | async postMessage | 15.0 us | 35 us | 20.6 us | 7.31 ms | 0 |
| worker, idle | SAB+Atomics.wait | 10.0 us | 25 us | 14.0 us | 0.58 ms | 0 |
| worker, idle | async postMessage | 15.0 us | 30 us | 17.3 us | 1.44 ms | 0 |
| main, busy 10 ms/frame | SAB+Atomics.wait | 15.0 us | 30 us | 43.4 us | **10.23 ms** | **52** |
| worker, main busy 10 ms | SAB+Atomics.wait | 15.0 us | 30 us | 15.8 us | 0.52 ms | 0 |

Blocking is not a tax — the SAB ring is *faster* than async postMessage (14.0 vs 17.3 us mean, worker kernel), because `Atomics.wait` skips a task-queue turn. 99.8% of waits genuinely parked (`atomics_wait_outcomes`), so this is not a fast-path artefact. p50 sits at 2-3 ticks of the 5 us clock, so means are the trustworthy figure.

**2. OPFS `createSyncAccessHandle` in a dedicated worker (`www/opfs-worker.js`)**

| op | p50 | p95 | n |
|---|---|---|---|
| `createSyncAccessHandle()` | 495 us | 605 us | 2000 |
| `close()` | 120 us | 155 us | 2000 |
| `getDirectoryHandle` (one component) | 85 us | 110 us | 2000 |
| dir+`getFileHandle` (two components) | 180 us | 225 us | 2000 |
| write 4 KiB / 64 KiB / 1 MiB | 5 / 5 / 30 us | 10 / 10 / 35 us | 2000/2000/300 |
| read 4 KiB / 64 KiB / 1 MiB | 0 / 5 / 55 us | 10 / 10 / 85 us | 2000/2000/300 |
| `flush()` after 4 KiB / 1 MiB | 260 / 375 us | 325 / 435 us | 2000/300 |

Reads and writes are 1-2 syscall round trips; **opening a handle is 100x a syscall, a path walk is 85 us per component, and `flush()` is 50x a 4 KiB write.** `[Exposed=DedicatedWorker]` per spec — it is absent on the window, which broke the first preflight.

**3. Process creation (1000 iterations; 500 for 149 KB)**

| program | spawn→first message p50 | p95 | `terminate()` returns |
|---|---|---|---|
| trivial, HTTP `no-store` | 3.45 ms | 4.41 ms | 10 us |
| trivial, **Blob URL** | **1.86 ms** | 2.29 ms | 10 us |
| wasm 40 B, HTTP | 6.68 ms | 8.80 ms | 10 us |
| wasm 148796 B, HTTP | 7.92 ms | 10.37 ms | 10 us |

`terminate()` is ~10 us to the caller but does not reclaim: 50 workers killed in 1.0 ms total, yet the next spawn took 22.7 ms. Blob URL is the honest figure — HTTP refetches the script.

**4. Live workers (`run.py ceiling`)**

| N | agent mem | KiB/worker | rend RSS | spawn p50 | broadcast-to-all |
|---|---|---|---|---|---|
| 10 | 3.2 MiB | 271 | 632 MiB | 5.9 ms | 0.6 ms |
| 400 | 106.2 MiB | 271 | 1044 MiB | 4.1 ms | 13.7 ms |
| 1600 | 423.3 MiB | 271 | 1939 MiB | 5.5 ms | 502 ms |
| 3200 | 846.4 MiB | 271 | 2673 MiB | 7.8 ms | 1211 ms |
| 4800 | — | — | — | — | **renderer dead** |

271 KiB/worker is exactly linear over 10→3200 (`measureUserAgentSpecificMemory`); renderer RSS slope is 617 KiB/worker (100→3200). Spawn stays under 8 ms throughout — **the wall is fan-out, 378 us per worker to round-trip all of them, not spawn or memory.** The 4800 failure was diagnosed by opening a fresh CDP session and failing to evaluate `1+1`, not inferred from a timeout; two earlier "ceilings" were my own socket timeout and are discarded.

**5. Cross-origin iframe (`run.py frames`)**

| rung | renderer procs | ready p50 | n |
|---|---|---|---|
| +1 cross-**site** (`localhost`, `[::1]`) | **+3, +4** | 75.9, 83.1 ms | 1, 1 |
| +1 same-site, other port | **+0** | 12.9 ms | 1 |
| 50 same-origin frames | +0 | 9.3 ms | 40 |
| cross-site create/remove, process warm | +0 | 7.80 ms | 200 |

Fresh renderer floor: 68-80 MiB RSS. A cold process costs ~76-83 ms (40x a Blob Worker); warm, 7.8 ms (4x). **Two ports on one IP buy no process:** Chrome isolates by site, and `--isolate-origins` ignored the port (8 origins collapsed to one process), so the first version of this test measured nothing.

**6. Aero, headed window, 120 Hz, rAF deltas, drag of the *bottom* window so all N re-blur**

| blurred device px/frame | blur on | blur off (control) |
|---|---|---|
| 31.0 M (30x 640x440) | 119.6 fps, p50 8.33 | 119.6 fps |
| 35.0 M (60x 640x440) | 120.0 fps | 120.0 fps |
| 51.4 M | 110.4 fps, p95 16.68 | 119.6 fps |
| 57.8 M | 117.8 fps | 120.0 fps |
| **63.0 M** | **62.2 fps, p50 16.61** | 120.0 fps |
| 70.0 M (30 full-screen) | 61.7 fps | 120.0 fps |

**The budget is ~58-63 M blurred device px per frame** (~51 fully-visible 640x440 glass windows at dpr 2, or ~13 full-screen ones). Past it the frame rate halves exactly. Predictor is area, not layer count: 60 windows at 35 M is free. Both controls fire — a 20 ms main-thread stall gives 49.3 fps, and the no-blur control is flat at 120 fps at every geometry — so the metric detects GPU *and* main-thread misses.

## Claims

- [measured] A null syscall from a Worker through a SharedArrayBuffer ring - postMessage out, Atomics.wait, kernel notifies - costs 14.0 us mean (p50 10 us, p95 25 us, max 0.58 ms) with the kernel in a dedicated worker, over 20000 iterations on Chrome 157.0.8103.38, Apple M2 Pro
  - /Users/chafyni/.claude/jobs/e856c39e/tmp/harness/run.py core (out/core.json, syscall.kernel_in_worker_idle.sab_atomics_wait)
- [measured] The blocking SAB channel is faster than a plain async postMessage round trip on the same worker and peer: 14.0 us vs 17.3 us mean, 20000 iterations each
  - /Users/chafyni/.claude/jobs/e856c39e/tmp/harness/www/proc-worker.js
- [measured] With the main thread burning 10 ms of every animation frame, a main-thread kernel stalled 52 of 20000 syscalls past 10 ms (max 10.23 ms) while a worker kernel under the same load stalled 0 past 1 ms (max 0.52 ms)
  - /Users/chafyni/.claude/jobs/e856c39e/tmp/harness/out/core.json
- [spec-normative] A worker kernel is legal: the HTML spec gives dedicated worker agents [[CanBlock]] = true and similar-origin window agents false, stating 'Only shared and dedicated worker agents allow the use of JavaScript Atomics APIs to potentially block'
  - https://html.spec.whatwg.org/multipage/webappapis.html#integration-with-the-javascript-agent-formalism
- [measured] OPFS createSyncAccessHandle costs 495 us p50, close 120 us, getDirectoryHandle 85 us per path component, 4 KiB write 5 us, 1 MiB write 30 us, 4 KiB read 0-5 us, 1 MiB read 55 us, flush() after a 4 KiB write 260 us
  - /Users/chafyni/.claude/jobs/e856c39e/tmp/harness/www/opfs-worker.js
- [spec-normative] createSyncAccessHandle is [Exposed=DedicatedWorker] and takes an exclusive lock on the file entry until closed, so it is genuinely absent on the window's FileSystemFileHandle.prototype
  - https://fs.spec.whatwg.org/#dom-filesystemfilehandle-createsyncaccesshandle
- [measured] new Worker() to first message is 1.86 ms p50 from a Blob URL and 3.45 ms p50 from an HTTP URL sent with Cache-Control: no-store; 7.92 ms p50 when the worker also instantiates a 148796-byte wasm module. 1000 iterations (500 for the large wasm)
  - /Users/chafyni/.claude/jobs/e856c39e/tmp/harness/out/core.json
- [measured] worker.terminate() returns in 10 us p50 but does not reclaim promptly: 50 terminate() calls returned in 1.0 ms total, yet the next spawn took 22.7 ms
  - /Users/chafyni/.claude/jobs/e856c39e/tmp/harness/out/core.json (terminate_drain)
- [measured] A live trivial Worker costs exactly 271 KiB of agent-attributed memory, linear from 10 to 3200 workers, and ~617 KiB of renderer RSS by slope from 100 to 3200
  - /Users/chafyni/.claude/jobs/e856c39e/tmp/harness/run.py ceiling (out/ceiling.json)
- [documented] performance.measureUserAgentSpecificMemory() requires a secure, cross-origin-isolated context and attributes realms including DedicatedWorkerGlobalScope
  - https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory
- [measured] 3200 live trivial workers stay responsive in one renderer; at 4800 the renderer died, confirmed by opening a fresh CDP session that could not evaluate 1+1. Spawn p50 stayed under 8 ms throughout; the degradation is fan-out, 378 us per worker to round-trip all of them (1211 ms at N=3200)
  - /Users/chafyni/.claude/jobs/e856c39e/tmp/harness/out/ceiling.json (worker_memory_ladder, diagnosis)
- [measured] A cross-site iframe needing a new renderer takes 75.9 and 83.1 ms create-to-ready (n=1 each) with a per-renderer RSS floor of 68-80 MiB; once the process is warm it is 7.80 ms p50 over 200 cycles. A same-site iframe on another port adds no renderer process at all
  - /Users/chafyni/.claude/jobs/e856c39e/tmp/harness/run.py frames (out/frames.json)
- [documented] Chrome's isolation unit is the site - 'the scheme and registered domain name, including the public suffix, but ignoring subdomains, port, or path' - which is why two ports on 127.0.0.1 share one renderer
  - https://www.chromium.org/Home/chromium-security/site-isolation/
- [measured] backdrop-filter: blur(9px) holds 120 fps up to ~58 M blurred device px per frame and halves to ~62 fps at 63 M, while the no-backdrop-filter control stays at 120 fps at every geometry up to 70 M. The predictor is blurred area, not layer count: 60 windows at 35 M is free, 30 at 63 M is not
  - /Users/chafyni/.claude/jobs/e856c39e/tmp/harness/run.py aero (out/aero.json, area.py)
- [spec-normative] backdrop-filter filters the element's Backdrop Root Image 'clipped to the element's border box', which is why total cost scales as the sum of each glass element's own area
  - https://drafts.csswg.org/filter-effects-2/#BackdropFilterProperty
- [measured] The frame metric is capable of failing: a 20 ms main-thread stall per frame drops rAF cadence to 49.3 fps, and 30 full-viewport glass windows drop it to 61.7 fps, so a flat 120 fps result is a real pass rather than a blind metric
  - /Users/chafyni/.claude/jobs/e856c39e/tmp/harness/www/aero.html (stall= parameter)
- [measured] The isolation gate is capable of failing: serving the same tree without COOP/COEP makes preflight abort, with crossOriginIsolated false, SharedArrayBuffer absent, and the clock coarsened from 5.0 us to 100 us
  - /Users/chafyni/.claude/jobs/e856c39e/tmp/harness/negative.py
- [documented] The observed clock coarsening matches the documented values exactly: 5 us resolution in cross-origin isolated contexts, 100 us in non-isolated ones
  - https://developer.mozilla.org/en-US/docs/Web/API/Performance/now
- [documented] SharedArrayBuffer requires a secure context that is cross-origin isolated, which is why the harness serves Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp rather than using python3 -m http.server
  - https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
- [spec-normative] Atomics.wait given the sequence value read before the postMessage cannot lose a wakeup: it returns 'not-equal' immediately if the kernel already stored the new value. 99.8% of 20000 waits returned 'ok', so the measured latency is of genuinely parked threads
  - https://tc39.es/ecma262/multipage/structured-data.html#sec-atomics.wait
- [measured] The synthetic benchmark wasm modules are valid per the binary format section ids used by the generator - type 1, function 3, export 7, code 10 - and were verified to instantiate and compute correctly (tiny.wasm 40 B, f0(3,4)=7; synth.wasm 148796 B, 2000 exports, f0(3,4)=83)
  - https://webassembly.github.io/spec/core/binary/modules.html

## Design consequences

- The kernel MUST be a dedicated Worker, never the main thread. Same median either way, but a main-thread kernel inherits every long main-thread task as syscall latency: 52 of 20000 syscalls past 10 ms with the main thread 60% busy, versus 0 past 0.52 ms with a worker kernel. Window dragging, layout and raster live on the main thread, so this is the normal case, not the pathological one.
- Blocking is free. The SAB+Atomics.wait channel is faster than async postMessage (14.0 vs 17.3 us mean), so there is no latency argument for an async syscall API. Build the synchronous one.
- A ~15 us syscall means a syscall per read()/write() is affordable: ~550 syscalls fit in one 8.3 ms frame. But do NOT put a syscall per path component - 85 us per getDirectoryHandle makes a 4-component walk 340 us, 23x a syscall. Resolve paths to a handle/inode once in the kernel and cache; hand processes an fd, not a path.
- Keep sync access handles open in a kernel-side descriptor table. createSyncAccessHandle is 495 us, 100x a syscall and 100x a 4 KiB write. open() must be rare and fd-based I/O common - exactly POSIX's shape.
- fsync MUST be a separate syscall from write. flush() is 260 us against a 5 us 4 KiB write; flushing per write makes the VFS 50x slower for durability nobody asked for.
- Spawn processes from Blob URLs built from VFS bytes (1.86 ms), not from HTTP URLs (3.45 ms). Add ~5-6 ms if the program instantiates wasm, so budget ~8 ms for a real process - under one frame, so exec can be synchronous from the user's point of view.
- kill() is ~10 us to the caller but does not reclaim the thread: the spawn after a mass kill took 22.7 ms. A process table must not assume terminate() frees anything, and a respawn-after-kill path needs a grace period.
- Budget ~600 KiB resident per live process (271 KiB JS-attributed). A few hundred processes is nothing; the ceiling is 3200 live workers, with the renderer dying between 3200 and 4800. Treat 1000 as the design limit and keep a hard cap in the process table - exceeding it kills the whole OS, since every process shares one renderer.
- Do NOT fan out to all processes per frame. Round-tripping all live workers costs 378 us each; at 1600 workers that is 502 ms. Signals, broadcasts and 'poll every process' designs must be O(interested), not O(N).
- One origin per app (the Puter model) costs 68-80 MiB and ~80 ms of cold process start - 40x a Worker - so it cannot be the unit of a process. Reserve it for an untrusted-code tier, keep it warm, and note that a port-differentiated origin on one host buys zero process isolation: it must be a distinct site.
- Aero glass has a hard budget of ~58-63 M blurred device px per frame. At dpr 2 that is ~51 windows of 640x440, but only ~13 full-screen ones - so the limit binds on window *size*, not window count. Cap total blurred area, not the number of glass windows, and drop to a cheap fill when a drag would cross the budget.

## Could not determine

- Per-origin process cost for N distinct app origins. Chrome isolates by site (scheme+host, port ignored), and `--isolate-origins` did not honour ports - 8 origins on 127.0.0.1 collapsed into one renderer. Only `127.0.0.1`, `localhost` and `[::1]` are distinct sites on loopback without root (`ifconfig lo0 alias` for 127.0.0.2 needs elevation), so there are exactly two cross-site samples and the cold figures (75.9, 83.1 ms) are n=1 each.
- A cold cross-site iframe distribution. Chrome keeps the renderer warm after the frame is removed, so the 200-iteration cycle measures the warm case (7.80 ms); the cold case cannot be repeated without a fresh site per sample.
- The exact worker ceiling between 3200 and 4800, and the failure mode. The renderer was confirmed dead at 4800 (fresh CDP session could not evaluate `1+1`), but whether it was an OS thread limit, V8 isolate exhaustion or OOM was not determined - no crash reason was read from Chrome.
- Cold or random-offset OPFS I/O. Every read and write in table 2 is at offset 0 on a hot file in a steady-state loop, which is a best case; a cold open, a random-offset read, and a file larger than the page cache were not measured.
- Dropped frames as the compositor sees them. Frame cost is rAF callback-to-callback delta, not a presentation timestamp; CDP tracing with the DevTools frame category was not used. The two negative controls show the metric responds to both GPU and main-thread overload, but it cannot attribute a miss to one of them.
- Whether the 58-63 M device-px blur budget holds on other GPUs. One machine, one 120 Hz display, dpr 2. A 60 Hz panel would have twice the budget per frame and an integrated GPU far less.
- Aero frame cost under a real process load. The glass benchmark ran with no workers alive, so the interaction between 100+ live processes and the compositor is unmeasured.
- The `Documents`/`Frames` counters and metric names from CDP Performance.getMetrics are reported as observed on Chrome 157; the protocol doc page redirects and does not enumerate them.
