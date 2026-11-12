# GAP 2 — Browsix (ASPLOS '17, not ATC '17), StackBlitz WebContainer, wanix's CallBuffer, and other shipped browser kernels: what is proven to work, with numbers, and what is proven not to.

## Verdict

Your established syscall channel is correct but your first instinct for it is the one thing already measured dead: Browsix mapped the process's whole heap as the SAB, and that died when the target became WebAssembly. Its successor replaced it with a separate per-process 64 MB SharedArrayBuffer bounce buffer carrying offsets in the message, measured at 0.2% average / 1.2% max overhead on SPEC — build that. Also settled: fork is incompatible with a blocking syscall channel (Browsix says so and ships spawn instead); a host-visible process table has only ever worked when processes are files (wanix); and WebContainer, the one shipped commercial kernel, exposes no PID at all and runs its kernel on a different origin.

## Detail

**Venue correction.** Browsix is ASPLOS '17, pp. 253–266, DOI 10.1145/3037697.3037727, by Bobby Powers, John Vilk, Emery D. Berger (Crossref metadata). Not ATC '17; "Vargas" and "Prato" are not authors. ATC '19 is the *successor*, Browsix-Wasm (Jangda, Powers, Berger, Guha). I read arXiv:1611.07862v2 (12pp) and arXiv:1901.09056v3; dl.acm.org returned 403.

**attempted / outcome / number / citation**

| Attempted | Outcome | Number | Cite |
|---|---|---|---|
| Browsix: process heap *is* the SAB; kernel writes directly into it; wake = 2 int32 slots at `waitOff` | Worked for asm.js, Chrome-with-flags only. Dead on WASM: `WebAssembly.Memory` was not shareable and had no Atomics | — | [kernel.ts#L2024](https://github.com/plasma-umass/browsix/blob/04f0830088560f27d480cde3e37c28269375f59f/src/kernel/kernel.ts#L2024), [ld.js#L5113](https://github.com/plasma-umass/browsix/blob/04f0830088560f27d480cde3e37c28269375f59f/src/ld.js#L5113), [arXiv §2](https://arxiv.org/abs/1901.09056) |
| sync (SAB+Atomics.wait) vs async (postMessage/CPS) on a syscall-heavy load | sync ~4× faster | pdflatex, 1 page+bib: **~100 ms native, just under 3 s sync, ~12 s async**; Thinkpad X1 Carbon i7-5600U, 8 GB, Linux 4.7.0 | [arXiv §5.2](https://arxiv.org/abs/1611.07862) |
| Browsix async path for Node/Go | Works in every browser, but needs a runtime that can unwind/rewind the stack: GopherJS goroutines, or Emscripten's Emterpreter (interpreted, slow) | — | arXiv §3.2, §4.3 |
| **fork** | Only C/C++ in Emterpreter mode. "fork is not compatible with synchronous system calls, as there is no way to re-wind or jump to a particular call stack in the child Web Worker." Mechanism: copy whole global memory (stack+heap) + the Emterpreter PC, *transfer* them in the child's `init` message, resume | slot 57 `fork` = `sys_ni_syscall` in the numeric table | arXiv §3.3/§4; [table.ts#L348](https://github.com/plasma-umass/browsix/blob/04f0830088560f27d480cde3e37c28269375f59f/src/syscall-api/table.ts#L348), [kernel.ts#L1871](https://github.com/plasma-umass/browsix/blob/04f0830088560f27d480cde3e37c28269375f59f/src/kernel/kernel.ts#L1871), [#L2259](https://github.com/plasma-umass/browsix/blob/04f0830088560f27d480cde3e37c28269375f59f/src/kernel/kernel.ts#L2259) |
| **spawn** (the one that works) | Blob URL from the VFS file → `new Worker(blobUrl)` → `init` message carries argv/env, because a Worker takes no startup data; main() is delayed until it arrives | non-Linux slot 326 | arXiv §3.3; table.ts#L618 |
| pipes | In-memory buffer; the syscall-response continuation is queued on the read side when empty and on the write side when full | — | arXiv §3.4 |
| sockets + HTTP | TCP between processes (bind/listen/accept/connect) + XHR-shaped host API | **1.7 ms native / 9 ms Chrome / 6 ms Firefox** for one request | arXiv §3.5, §5.2 |
| signals | `kill` + handlers over the same message channel; `Atomics.wait` woken by a signal; SIGKILL cancels a build | 27 of 327 slots implemented | table.ts |
| kernel on the **main browser thread** | Worked; also forced all Worker creation through the UI thread (nested workers unsupported then). Now obsolete: nested workers Chrome 69 / FF 34 / Safari 16.4 | | arXiv §3.1; [BCD v6.0.0 Worker.json](https://github.com/mdn/browser-compat-data/blob/v6.0.0/api/Worker.json) |
| protection between processes | Explicit non-goal: no users, no permissions, relies on same-origin sandbox | 8,126 LoC total, kernel 2,249 (Fig. 2) | arXiv §3.1, Fig. 2 |
| **Browsix-Wasm: separate 64 MB SAB per process, args copied in, offsets in the message, calls >64 MB split** | **Worked.** Copy cost "dwarfed by the overall cost of the system call invocation, which involves sending a message between process and kernel JavaScript contexts" | **avg 0.2%, max 1.2%, 14/15 SPEC <0.5%** (Fig. 4, Firefox); 6-core Xeon E5-1650 v3, 64 GB, Ubuntu 16.04/4.4.0, Chrome 74.0, Firefox 66.0, 5 runs | [arXiv:1901.09056 §2, §4.2.1](https://arxiv.org/abs/1901.09056) |
| original Browsix kernel as a harness | **Failed.** "several common system calls have very high overhead"; "performance problems that would have been a threat to the validity of our results" | — | same, §2, §4.2.2 |
| Browsix today | master frozen 2019-04-24 (last commit converts it to the ATC'19 benchmark harness), 0 releases, 49 open issues, 3,188 stars, not archived. Emterpreter — the only fork path — was deleted in Emscripten 1.39.18 (2020-06-12) | — | [ChangeLog@3.1.74](https://github.com/emscripten-core/emscripten/blob/3.1.74/ChangeLog.md#L1975) |
| **WebContainer**: WASM micro-OS, "ephemeral virtual file system stored in memory", `jsh` shell, PTY (`resize`), `kill()`, **no PID, no process table**; `fs` = Node `fs.promises` subset + `watch`; `mount`/`export`; TCP mapped to ServiceWorker | Shipped, closed source. The *kernel runs on another origin*: `@webcontainer/api` boots a hidden iframe at `https://stackblitz.com/headless` and talks to it over a MessagePort wrapped in Comlink | COEP `require-corp`\|`credentialless` + COOP `same-origin` mandatory; one instance per page; no native addons; JS/WASM only | [api ref](https://webcontainers.io/api), [headers](https://webcontainers.io/guides/configuring-headers), [troubleshooting](https://webcontainers.io/guides/troubleshooting), `dist/internal/constants.js` + `dist/internal/iframe-url.js` in [api-1.6.4.tgz](https://registry.npmjs.org/@webcontainer/api/-/api-1.6.4.tgz) |
| WebContainer licence | `@webcontainer/api` is **MIT — but it is only the client proxy**. `stackblitz/webcontainer-core` holds just `.github/ LICENSE README.md browsers/ repro.md` (issue tracker). Licence required for production commercial use | no public prices | [npm 1.6.4](https://www.npmjs.com/package/@webcontainer/api/v/1.6.4), [enterprise](https://webcontainers.io/enterprise) |
| **wanix CallBuffer** | Single slot, **not a ring**. 16 KB SAB: `ctrl` int32 @0, `len` int32 @4, `data` @8. `call()`: zero ctrl → `postMessage(params)` (method is a *string* field) → `Atomics.wait(ctrl,0,0)` → CBOR-decode. `respond()`: encode, set len, `Atomics.store(ctrl,0,1)`, `Atomics.notify`. **12 methods, all file ops** (`path_open/truncate/size/readdir/remove/mkdir/touch`, `fd_close/flush/read/write`, `exit`) | `maxData` = 16384−8−16 = **16360 B**; Uint8Array replies are silently `slice(0,limit)`d, non-buffer overflow is an unhandled `// TODO` | [callbuffer.ts](https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/wasi/callbuffer.ts), [worker.js#L35](https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/wasi/worker/worker.js#L35) |
| wanix two-worker split | An **async coordinator worker** owns the kernel MessagePort; it spawns a second **blocking worker** that runs the WASI module and parks on Atomics.wait. Built on `@bjorn3/browser_wasi_shim` ^0.4.1, patched for `poll_oneoff` | — | worker.js#L29-L125, [package.json](https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/package.json) |
| wanix Plan 9 namespaces | **Real union mounts**: `BindAfter` / `BindBefore` / `BindReplace`. Process table is files: `#task/<tid>/{ctl,id,kind,args,cmd,env,exit,fd/N,binds}`; `ctl` accepts `bind`, `unbind`, `start` — **no `kill`**; `#signal` is a pub/sub broadcaster, not POSIX signals | — | [bind/table.go#L312](https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/fs/bind/table.go#L312), [task.go#L239](https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/task.go#L239) |
| (d) others | jor1k = OpenRISC+Linux emulator, same black box as v86 (BSD-2-Clause). emception = Clang/LLVM in WASM — a toolchain, not a kernel. wasmer-js = WASI sandbox, no process table. Gitpod/Codespaces = remote VM, not browser-resident — not relevant | — | [jor1k](https://github.com/s-macke/jor1k), [emception](https://github.com/jprendes/emception), [wasmer-js](https://github.com/wasmerio/wasmer-js) |

## Claims

- [documented] Browsix was published at ASPLOS '17 (pp. 253-266), not USENIX ATC '17; authors are Bobby Powers, John Vilk, Emery D. Berger.
  - https://doi.org/10.1145/3037697.3037727
- [documented] Browsix offered two syscall transports: async postMessage in continuation-passing style (works in all browsers; suits Node.js and GopherJS, which can unwind and rewind the stack), and synchronous calls where the process's heap is a SharedArrayBuffer shared with the kernel, with return value and wake slots at a pre-arranged offset.
  - https://arxiv.org/abs/1611.07862
- [documented] In Browsix's sync path the kernel writes the return value to heap32[(waitOff>>2)+1], sets heap32[waitOff>>2]=1, then Atomics.wake; the client arranges waitOff via an async 'personality' call passing PER_BLOCKING (0x80) and transferring the heap.
  - https://github.com/plasma-umass/browsix/blob/04f0830088560f27d480cde3e37c28269375f59f/src/kernel/kernel.ts#L2024
- [measured] pdflatex on a one-page document with a bibliography: ~100 ms native Linux, just under 3 s under Browsix with synchronous syscalls (Chrome), ~12 s with asynchronous syscalls and the Emterpreter. Thinkpad X1 Carbon, Intel i7-5600U, 8 GB RAM, Linux 4.7.0.
  - https://arxiv.org/abs/1611.07862
- [measured] Browsix utility runtimes (Figure 9): sha1sum 0.002 s native / 0.067 s Node.js / 0.189 s Browsix; ls 0.001 s / 0.044 s / 0.108 s. Mean of 100 runs after a 20-run warmup. No browser version is named for these figures.
  - https://arxiv.org/abs/1611.07862
- [measured] Browsix in-browser HTTP request for a background-image list: 1.7 ms native, 9 ms Google Chrome, 6 ms Firefox; meme generation ~2 s in-browser vs 200 ms server-side.
  - https://arxiv.org/abs/1611.07862
- [documented] Browsix states fork is not compatible with synchronous system calls, because there is no way to rewind or jump to a particular call stack in the child Web Worker; Figure 3 notes fork is only supported for C and C++ programs.
  - https://arxiv.org/abs/1611.07862
- [documented] Browsix fork for C/C++ sends a copy of the global memory array (C stack and heap) plus the current program counter to the kernel; the kernel transfers them to the new Worker in its initialization message and the Emterpreter resumes from the fork point.
  - https://arxiv.org/abs/1611.07862
- [measured] In Browsix's numeric Linux x86-64 syscall table, 27 of 327 slots are implemented; fork (57) and vfork (58) are sys_ni_syscall, and process creation is a non-Linux slot 326 sys_spawn. kill is slot 62.
  - https://github.com/plasma-umass/browsix/blob/04f0830088560f27d480cde3e37c28269375f59f/src/syscall-api/table.ts#L348
- [documented] Browsix spawn works around two Worker limitations: files in its VFS may not exist on a web server, so it creates a Blob and a blob URL for the Worker constructor; and a Worker takes no startup data, so runtimes delay main() until an 'init' message carrying argv and env arrives.
  - https://arxiv.org/abs/1611.07862
- [documented] Browsix pipes are in-memory buffers that enqueue the continuation encapsulating the syscall response, on the read side when there is no data and on the write side when there is no room. Signals travel over the same message-passing interface as syscalls, and Atomics.wait is woken when a syscall completes or a signal arrives.
  - https://arxiv.org/abs/1611.07862
- [documented] The Browsix kernel runs in the main browser thread, and in 2017 Chrome and Safari did not support nested workers, so a Worker needing parallelism had to delegate to the main thread and proxy all messages through it.
  - https://arxiv.org/abs/1611.07862
- [documented] Nested dedicated Workers are now available: Chrome 69, Firefox 34, Safari 16.4 (not in shared workers in Chrome or Safari).
  - https://github.com/mdn/browser-compat-data/blob/v6.0.0/api/Worker.json
- [documented] Browsix explicitly does not support multiple users or permission checks; it relies on the browser sandbox and same-origin policy, so a Browsix app has the same protection as any web app.
  - https://arxiv.org/abs/1611.07862
- [measured] Browsix size (Figure 2): kernel 2,249 LoC, BrowserFS modifications 1,231, shared syscall module 421, Emscripten integration 1,557, GopherJS 926, Node.js 1,742 - total 8,126 LoC.
  - https://arxiv.org/abs/1611.07862
- [documented] Browsix-Wasm abandoned the shared-process-heap transport because WebAssembly memory was not shared across Web Workers and did not support the Atomics API; it instead gives each process a 64 MB SharedArrayBuffer auxiliary buffer distinct from process memory, copies syscall buffers in and out, passes auxiliary-memory offsets in the message, and splits any call reading or writing more than 64 MB.
  - https://arxiv.org/abs/1901.09056
- [measured] Browsix-Wasm syscall overhead, instrumented over SPEC CPU in Firefox (Figure 4): average 0.2%, maximum 1.2%, below 0.5% for 14 of 15 benchmarks. Machine: 6-core Intel Xeon E5-1650 v3 with hyperthreading, 64 GB RAM, Ubuntu 16.04, Linux 4.4.0; Chrome 74.0 and Firefox 66.0; Clang 4.0; five runs per benchmark.
  - https://arxiv.org/abs/1901.09056
- [documented] The authors state the original Browsix kernel had significant performance issues, that several common syscalls had very high overhead, and that benchmarking under original Browsix would have been a threat to the validity of their results.
  - https://arxiv.org/abs/1901.09056
- [measured] The Browsix repository's master branch has not advanced since 2019-04-24 (last commit adds the Browsix-SPEC benchmark harness), has zero releases, 49 open issues and 3,188 stars, and is not archived.
  - https://github.com/plasma-umass/browsix/commit/04f0830088560f27d480cde3e37c28269375f59f
- [documented] Emscripten removed the Emterpreter and the EMTERPRETIFY settings in version 1.39.18 (2020-06-12), stating it was largely replaced by Asyncify - removing the only compiler mode Browsix's fork depended on.
  - https://github.com/emscripten-core/emscripten/blob/3.1.74/ChangeLog.md
- [documented] StackBlitz describes WebContainers as a novel WebAssembly-based operating system / micro-operating system that enables Node.js to run entirely inside the browser, booting with an ephemeral virtual file system stored in memory, with a virtualized TCP network stack mapped to the browser's ServiceWorker API.
  - https://blog.stackblitz.com/posts/webcontainer-api-is-here/
- [documented] WebContainer's public API exposes spawn(command, args?, options?) returning a WebContainerProcess with exit: Promise<number>, input: WritableStream<string>, output: ReadableStream<string>, kill() and resize({cols,rows}) - and no PID, process list, or process table.
  - https://webcontainers.io/api
- [documented] WebContainer ships a shell named jsh, spawned as webcontainerInstance.spawn('jsh', { terminal: { cols, rows } }) and wired to xterm.js.
  - https://webcontainers.io/tutorial/7-add-interactivity
- [spec-normative] WebContainer requires Cross-Origin-Embedder-Policy: require-corp (or credentialless) and Cross-Origin-Opener-Policy: same-origin on every page including in development, because it requires SharedArrayBuffer, which requires cross-origin isolation.
  - https://webcontainers.io/guides/configuring-headers
- [documented] WebContainer limitations: only one instance can be booted concurrently; native addons cannot run unless compiled to WebAssembly and are disabled by default; it can only execute languages natively supported on the web (JavaScript and WebAssembly); cookie blockers break it; several open projects can exhaust WASM memory; booting without package-lock.json is slower.
  - https://webcontainers.io/guides/troubleshooting
- [measured] The @webcontainer/api npm package (1.6.4) is MIT licensed but is only a client proxy: dist/internal/constants.js sets DEFAULT_EDITOR_ORIGIN = 'https://stackblitz.com' and dist/internal/iframe-url.js sets pathname '/headless'; index.js creates an iframe at that URL and wraps event.ports[0] with Comlink. The kernel therefore runs on a separate origin from the host app.
  - https://registry.npmjs.org/@webcontainer/api/-/api-1.6.4.tgz
- [measured] The stackblitz/webcontainer-core repository contains only .github, .gitignore, LICENSE, README.md, browsers and repro.md - it is an issue tracker, not the kernel source. WebContainer's core is closed source.
  - https://github.com/stackblitz/webcontainer-core
- [documented] StackBlitz requires a licence for production use of the WebContainer API in a commercial for-profit setting; prototypes and POCs do not need one; no prices are published and enterprise terms are contact-only.
  - https://webcontainers.io/enterprise
- [unverified] StackBlitz's published speed figures are vendor claims with no stated method, machine or browser: 'Boot a Node.js project in your browser in milliseconds', 'Builds complete up to 20% faster and package installs complete >= 5x faster than yarn/npm', and 'up to 10x faster than local'.
  - https://blog.stackblitz.com/posts/introducing-webcontainers/
- [measured] wanix's CallBuffer is a single-slot protocol, not a ring: ctrl Int32 at byte 0, len Int32 at byte 4, data from byte 8. call() zeroes ctrl[0], adds a 'method' string to the params object, postMessages it, then Atomics.wait(ctrl,0,0) and CBOR-decodes data[0:len]. respond() CBOR-encodes, writes len and data, Atomics.store(ctrl,0,1), Atomics.notify.
  - https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/wasi/callbuffer.ts
- [measured] wanix allocates a 16384-byte SharedArrayBuffer per WASI task, giving maxData = 16384 - 8 - 16 = 16360 bytes; Uint8Array replies larger than that are silently sliced, and the non-buffer overflow case carries an unresolved '// TODO: check if it exceeds the buffer size'.
  - https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/wasi/worker/worker.js#L35
- [measured] wanix's CallBuffer dispatch handles 12 methods, all file operations: path_open, path_truncate, path_size, path_readdir, path_remove, path_mkdir, path_touch, fd_close, fd_flush, fd_read, fd_write, exit.
  - https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/wasi/worker/worker.js
- [measured] wanix splits each WASI task into two workers: an async coordinator holding the kernel MessagePort, which spawns a second worker that runs the WASM module and blocks on Atomics.wait. It uses @bjorn3/browser_wasi_shim ^0.4.1, patched for poll_oneoff.
  - https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/package.json
- [measured] wanix implements real Plan 9 union mounts with placement options fs.BindAfter (default), fs.BindBefore and fs.BindReplace.
  - https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/fs/bind/table.go#L312
- [measured] wanix exposes each process as a directory of files - ctl, id, kind, args, cmd, alias, env, exit, binds, fd/N under #task/<tid>/ - and its ctl file accepts only bind, unbind and start. There is no kill, and #signal is a pub/sub broadcaster rather than POSIX signals.
  - https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/task.go#L239
- [measured] The host-facing wanix API surface is file operations plus namespace composition: bind, unbind, open, openFile, close, read, write, writeAt, readFile, writeFile, appendFile, readDir, makeDir, stat, fstat, lstat, symlink, readlink, rename, copy, remove, truncate, chmod, chown, chtimes, sync, waitFor.
  - https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/api/handle.js
- [documented] SharedArrayBuffer was effectively disabled at the start of 2018 in light of Spectre; a secure approach was standardized in 2020 requiring a secure context and cross-origin isolation, and it has been available across browsers since December 2021.
  - https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
- [documented] jor1k is an OpenRISC (OR1K) emulator running Linux in the browser, BSD-2-Clause - the same black-box category as v86, with no host visibility into guest processes.
  - https://github.com/s-macke/jor1k
- [documented] emception runs Emscripten/Clang in the browser - a toolchain compiled to WASM, not a kernel or process model.
  - https://github.com/jprendes/emception
- [documented] Browsix's filesystem is BrowserFS (from Doppio) extended with multi-process support, overlay locking to stop interleaved operations, and a lazy read-only underlay that cut kernel startup time.
  - https://arxiv.org/abs/1611.07862

## Design consequences

- Build a per-process bounce buffer, not a shared process heap. Mapping the process's memory as the SAB is the one transport that has been measured dead (it cannot survive a WASM target). The replacement measured at 0.2% average overhead copies args into a separate SAB and puts offsets in the postMessage. Copy cost is noise; the postMessage is the cost.
- Size the buffer deliberately and define overflow. Browsix-Wasm used 64 MB and split any call above it. wanix uses 16 KB with an unhandled overflow TODO and silently truncates >16360-byte replies. Pick a size, then make an oversized call split or fail loudly, and make that a check.
- Do not design around fork. Browsix states fork is incompatible with a blocking syscall channel, and its only fork path (copy the whole heap + an interpreter PC) required Emscripten's Emterpreter, deleted in 1.39.18. Browsix, wanix and WebContainer all converge on spawn. Give the shell job control via spawn + pipes, not fork.
- Budget two Workers per process. A worker parked in Atomics.wait cannot service postMessage, so it cannot receive a signal or a kill. wanix pays an async coordinator worker per task; Browsix paid by putting the kernel on the main thread. Pick the coordinator — your window manager needs the main thread.
- Put the kernel in a Worker, not the main thread. Browsix's main-thread kernel was forced by nested workers being unavailable in 2017; that constraint is gone (Chrome 69, Firefox 34, Safari 16.4), so the 2017 layout should not be copied.
- Model the process table as a filesystem. wanix's #task/<tid>/ directory is the only surveyed design where the host can enumerate, inspect and address a process without a bespoke API - which is exactly what routing a window to a PID needs. WebContainer's opaque handle with kill() but no PID is the failure mode to avoid.
- Add kill and signals yourself. wanix has neither; Browsix has both but only reaches a blocked process through the SAB wake. Reserve a control word in the SAB for pending-signal delivery, so a parked process is interruptible, and treat 'kill a backgrounded window' as a first-class check.
- Cross-origin isolation is unavoidable and shapes hosting: COOP same-origin + COEP require-corp or credentialless on every document, iframes need allow="cross-origin-isolated", and third-party-cookie blockers break WebContainer today.
- Cost anchor from the only measured datapoint: a 27-syscall Unix kernel in the browser was 2,249 LoC, 8,126 LoC with all runtime integrations.
- Protection remains unsolved outside Puter. Browsix names no-users-no-permissions as an explicit non-goal and leans on the same-origin sandbox - the same hole as anuraOS. If isolation is the reason webxp failed, a Worker boundary alone does not close it; only a distinct origin does, which is what WebContainer itself does for its kernel.

## Could not determine

- Browsix publishes no per-syscall latency table or figure. I searched arXiv:1611.07862v2 (12 pages) for 'latency', 'microbenchmark', 'lmbench', 'hbench' and microsecond units and found none; the only timing figures are Figure 9 (whole-utility runtimes) and the pdflatex/HTTP numbers in §5.2. The ACM camera-ready is 14 pages (pp. 253-266) versus 12 on arXiv, and dl.acm.org/doi/10.1145/3037697.3037727 returned HTTP 403, so I cannot rule out a latency table present only in the published version. Do not cite a Browsix per-syscall latency number to me; I did not find one.
- The Browsix repo contains bench/hbench-os as a submodule (github.com/bpowers/HBench-OS), suggesting an OS microbenchmark suite was wired up, but I did not clone or run it and found no published results from it.
- Browsix's Figure 9 names the machine (Thinkpad X1 Carbon, i7-5600U, 8 GB, Linux 4.7.0) but no browser version, so those numbers have no full reproduction path.
- Why Browsix stopped: I found no maintainer statement, no archive notice, and no deprecation note. The evidence is circumstantial - master frozen 2019-04-24 with the last commit converting it into the ATC'19 benchmark harness, zero releases, 49 open issues - plus two structural facts (SharedArrayBuffer disabled globally in Jan 2018, Emterpreter deleted in Emscripten 1.39.18). I did not verify a causal link.
- Whether WebContainer is the upstream Node.js source tree recompiled to WebAssembly. StackBlitz says 'a novel WebAssembly-based operating system which enables Node.js to run entirely inside the browser' and 'Native Node.js inside the browser', and the docs say native addons must be compiled to WASM - but no public statement says the Node source is what is compiled, versus a Node-API-compatible reimplementation. The core is closed source so I could not check.
- WebContainer boot and install times: no vendor measurement with a command, browser, or machine. Only 'in milliseconds', '>= 5x faster than yarn/npm', 'up to 20% faster builds', 'up to 10x faster than local'. I did not run my own benchmark.
- WebContainer pricing: no figures are published; the enterprise page is contact-only.
- Whether WebContainer has an internal process table with PIDs. The public API exposes none; kill() and resize() imply per-process state and a pseudoterminal internally, but I could not inspect the closed-source core.
- 'Nebula' as a browser-resident kernel: I could not identify any such project and did not guess at one.
- The USENIX-hosted ATC'19 PDF (https://www.usenix.org/system/files/atc19-jangda.pdf) returned HTML/404 to both curl and WebFetch. I used arXiv:1901.09056v3 instead; section and figure numbers are from that version and may differ from the USENIX camera-ready.
- wanix's gojs (Go js/wasm) task driver syscall encoding. I read only the WASI path's CallBuffer. The Go driver (gojs/driver.go) and the @progrium/duplex RPC it uses were not inspected, so the 12-method count applies to the WASI shim only, not to wanix as a whole.
- No measurement of my own was taken. Every number above is someone else's published figure with its stated setup; I ran no benchmark on this machine.
