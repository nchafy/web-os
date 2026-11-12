# Cost of running real Linux / real Linux binaries in a browser tab (2026): v86, CheerpX/WebVM, container2wasm, WASI/WASIX, Asyncify+SAB sync syscalls, and POSIX-in-JS prior art

## Summary

"Actual Linux" and "a kernel boundary" are orthogonal. Every full-system emulator (v86, CheerpX, container2wasm) gives you a real kernel — but it is a *black box at the far end of a serial cable*. The host JS cannot see processes, cannot route a window to a PID, and cannot read the guest FS except through a narrow hatch. You get Linux and lose the thing webxp was missing: host-side control of processes.

The inversion that matters: a kernel boundary in the browser is not a VM, it is **a synchronous syscall channel from a Worker into an async host kernel**. One Worker per process, `postMessage` out, `Atomics.wait` on a `SharedArrayBuffer` for the reply. ~50 lines (wanix `CallBuffer`). The host JS *is* the kernel: it owns the process table, the fd tables, the VFS, and so it can kill, background, and re-parent. That costs COOP/COEP on every response and locks out the main thread.

Two separate decisions, then: what runs the binaries (WASIX gives real `fork`/`exec`/pipes and measured near-native exec cost; v86 gives real Linux at ~20x), and who owns the process table (you, via a CallBuffer, or nobody). Running real Linux does not buy you a kernel boundary. Writing the syscall channel does.

## Findings

### VERDICT ROW — v86: boot 3.5s to a shell, engine 476 KB gzipped + 5.7 MB image, ~20x native, BSD-2-Clause, hosts a real shell, cannot host JS apps in the same process tree. Single reason to reject: the guest is opaque to the host — JS sees a serial byte stream and a 9p channel, never a PID.

- Evidence: https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/LICENSE
- Confidence: verified
- Why it matters: v86 solves 'real Linux' and does nothing for 'killable, backgroundable windows'. A window manager over v86 is a terminal multiplexer, not a process manager.

### Measured on this host: v86 (npm `v86@0.5.473`, Node 18.20.2, macOS/arm64) boots Buildroot `linux.iso` (5,666,816 bytes, from copy/images) to a login prompt in 3,529-3,540 ms and to a root shell in 3,562-3,572 ms across 3 runs. A `serial0_send` command round-trip is 10-13 ms. `save_state()` on a 128 MB-RAM VM returns 32,032,352 bytes in 38-59 ms. Produced by a 60-line script driving `V86` + the `serial0-output-byte` listener.

- Evidence: https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/v86.d.ts
- Confidence: verified
- Why it matters: Boot is a one-time 3.5s, and `save_state`/`restore_state` can hide it behind a 32 MB snapshot — but 32 MB per snapshot is the real persistence budget, not the 5.7 MB image.

### Measured: v86 runs integer/memory work at roughly 1/20th native. Guest busybox `sh` loop of 20,000 iterations: 1.68s vs 0.084s for macOS /bin/sh (20x). Guest `dd if=/dev/zero of=/dev/null bs=1M count=200`: 0.08s vs 0.0045s native (18x). Two independent benchmarks agree on the order of magnitude; shells differ between host and guest so treat 20x as a class, not a constant.

- Evidence: https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/docs/how-it-works.md
- Confidence: verified
- Why it matters: 20x is survivable for a shell and `ls`, fatal for compiling or anything with a frame budget. It prices v86 as a 'legacy app' container, not the runtime for the whole desktop.

### Measured: the v86 engine is 2,007,347 bytes of wasm (382,297 gzipped) plus 359,819 bytes of JS (94,274 gzipped) — about 476 KB gzipped over the wire, from `npm pack v86` at 0.5.473 and `gzip -c | wc -c`.

- Evidence: https://www.npmjs.com/package/v86/v/0.5.473
- Confidence: verified
- Why it matters: The engine is cheap. The image dominates, so the lever is image size (Buildroot, 5.7 MB) not engine size.

### v86 CAN be driven programmatically, and more deeply than its reputation suggests: `create_file(path, Uint8Array)` and `read_file(path)` move bytes across the 9p boundary; `serial0_send(string)` plus the `serial0-output-byte` event give command-in/output-out; `save_state()`/`restore_state()` snapshot the whole machine; `read_memory`/`write_memory` reach into guest RAM. Critically, `filesystem: { handle9p: async (reqBuf, reply) => {...} }` lets host JS implement the guest's entire filesystem as a 9p server in JavaScript.

- Evidence: https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/docs/filesystem.md
- Confidence: verified
- Why it matters: `handle9p` is the one place where a host-owned VFS and a real Linux guest meet. A JS kernel's VFS can back the guest's root filesystem, so one source of truth for files survives even with a VM in the picture.

### The `handle9p` hatch has a documented price: 'this filesystem will not be cached (unless cached in the guest OS), functions like `create_file` and `read_file` will not be available, and you will be responsible for keeping its state in sync with any machine save states.' `create_file`/`read_file` also do nothing at all unless a 9p filesystem was configured — they are unavailable when booting from a raw disk or ISO.

- Evidence: https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/docs/filesystem.md
- Confidence: verified
- Why it matters: You pick one: convenient host file I/O, or host-implemented VFS. Taking the second means hand-writing 9p2000.L and reconciling it with snapshots yourself.

### v86 networking works but always needs an out-of-tab relay. The documented backends are `inbrowser` (guest-to-guest only), `wsproxy` (`ws://`/`wss://`), `wisp`, and `fetch` (needs a CORS proxy). There is no backend that reaches the real internet without a proxy you run or borrow.

- Evidence: https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/docs/networking.md
- Confidence: verified
- Why it matters: 'No backend required' is false for any option in this report that offers TCP. Browser sandboxing has no raw sockets; every one of these ships a relay.

### v86 cannot run a 64-bit kernel: 'Linux works pretty well. 64-bit kernels are not supported' and the emulated CPU explicitly lacks '64-bit extensions'. The Buildroot image I booted reports kernel 2.6.34.14.

- Evidence: https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/Readme.md
- Confidence: verified
- Why it matters: i386 is end-of-life across distros. Debian/Ubuntu stop at 16.04/18.04. Choosing v86 means a 32-bit userland with a shrinking package universe, permanently.

### VERDICT ROW — CheerpX/WebVM: faster than v86 (JIT, unquantified here), 600 MiB-1.9 GiB disk image, proprietary, hosts a real shell, cannot host JS apps. Single reason to reject: the engine is a closed binary you may only load from `cxrtnc.leaningtech.com`. 'Self hosting CheerpX... you will need a Commercial License.' Your whole OS would hard-depend on one company's CDN staying up and staying free.

- Evidence: https://github.com/leaningtech/labs/blob/main/sites/cheerpx/src/content/docs/23-licensing.md
- Confidence: verified
- Why it matters: This is a single point of failure outside your control, in the kernel position. No amount of good architecture above it compensates.

### Verified by unpacking the package: `@leaningtech/cheerpx@1.4.0` from npm contains no engine at all. It is a 581-byte `index.js` whose entire body is `const CheerpX = await dynImport('https://cxrtnc.leaningtech.com/1.4.0/cx.esm.js')` plus re-exports. That URL serves a 605-byte ESM shim which imports `cx_esm.js` (386,274 bytes, measured) which in turn fetches runtime-computed `.wasm`/`.data` chunks from the same CDN.

- Evidence: https://www.npmjs.com/package/@leaningtech/cheerpx/v/1.4.0
- Confidence: verified
- Why it matters: There is no artifact to vendor, pin, or audit. 'Every build is immutable' is true of their CDN, not of your deployment. Offline use and air-gapped use are impossible.

### The CheerpX licence text shipped in the npm tarball (`LICENSE.txt`, 24 KB) is more restrictive than the marketing summary. Clause 1.4(a) permits individuals 'for any purpose (including... personal projects that do or don't generate revenue, open-source projects, public-facing applications)'. Clause 1.4(b) permits a Business 'strictly for the purpose of technical evaluation and testing'. Clause 1.5 scopes a Licensee Application to assets 'drawn from a single designated origin domain'. Clause 2.1(e) forbids modification; 2.1(f) forbids 'disassemble, decompile, reverse-engineer or create derivative works'; 2.1(i) forbids making it available 'to any person other than your employees without prior written consent'. Clause 1.4(b) closes with 'Our determination... will be final in the event of any dispute.'

- Evidence: https://github.com/leaningtech/cheerpx-meta/blob/main/LICENSE.txt
- Confidence: verified
- Why it matters: For a personal web OS this is genuinely free. The moment it becomes a company product, or a second origin, or needs a patched engine, the licence blocks it — and clause 2.1(f) also forbids writing your own block server by reverse-engineering their wire protocol.

### WebVM itself (the UI, Svelte, xterm wiring) is Apache-2.0 and genuinely forkable; the engine is not. The repo's own README states it plainly: 'Downloading a CheerpX build for the purpose of hosting it elsewhere is not permitted without a commercial license.'

- Evidence: https://github.com/leaningtech/webvm/blob/667a02d79a3b91a48ed7bee8dca3693c33ef95a2/README.md
- Confidence: verified
- Why it matters: The Apache-2.0 badge on the repo is about the chrome, not the kernel. Do not read the repo licence as the engine licence.

### Measured from the GitHub release assets: WebVM's disk images are `debian_mini_20230519_5022088024.ext2` at 629,145,600 bytes (600 MiB) and `debian_large_20230522_5044875331.ext2` at 2,000,000,000 bytes (1.86 GiB). The public deployment streams blocks from `wss://disks.webvm.io/...` via `CloudDevice`; the self-serve path is `diskImageType = "bytes"` (`HttpBytesDevice`, HTTP range requests over a static .ext2).

- Evidence: https://github.com/leaningtech/webvm/releases/tag/ext2_image
- Confidence: verified
- Why it matters: The disk CAN be self-hosted even though the engine cannot. Only touched blocks download, so first-boot transfer is far under 600 MiB — but you are hosting a 600 MiB artifact and the README notes the large image 'is too large of an image for GitHub pages'.

### CheerpX's host-side API is narrower than v86's for reading the guest. `Linux.run(fileName, args, {env, cwd, uid, gid})` returns `{status}` — a real exec interface with an exit code. But output capture is only `setCustomConsole(writeFunc(buffer, vt))`, one global console callback for the whole machine, not per-process stdout. And getting a file out requires copying it inside the guest to a mounted `IDBDevice`, then `readFileAsBlob` from JS; there is no API to read an arbitrary guest path.

- Evidence: https://github.com/leaningtech/labs/blob/main/sites/cheerpx/src/content/docs/11-guides/input-output.md
- Confidence: verified
- Why it matters: 'Run a command and get its output' requires multiplexing one console stream yourself. Per-process stdout — table stakes for a process manager — is not exposed.

### CheerpX requires cross-origin isolation, confirmed from two independent places in their own tree: WebVM's `nginx.conf` sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, and their nginx guide states 'CheerpX requires SharedArrayBuffer, which itself requires the site to be cross-origin isolated.'

- Evidence: https://github.com/leaningtech/webvm/blob/667a02d79a3b91a48ed7bee8dca3693c33ef95a2/nginx.conf
- Confidence: verified
- Why it matters: COOP/COEP is non-negotiable for every serious option here. It is a property of your whole deployment, not of one component — decide it before writing anything.

### VERDICT ROW — container2wasm: Apache-2.0, boots real OCI containers, 64-bit guests, two backends. Single reason to reject: the browser path is an emulator inside an emulator. The project's own docs say the WASI-on-browser route 'runs containers on emulators with interpreter approach with a single thread so the execution can be slower than the emscripten example' — i.e. Bochs interpreting x86 inside wasm, no JIT. The faster route is QEMU-TCG-in-emscripten, which is a much heavier dependency than v86 for the same outcome.

- Evidence: https://github.com/container2wasm/container2wasm/blob/3f0f9be4d5ee201ea1a12f9700e6e3ef52c8b345/examples/wasi-browser/README.md
- Confidence: verified
- Why it matters: Strictly worse than v86 for a browser desktop: slower than v86 on the WASI path, heavier than v86 on the QEMU path, and the same opaque-guest problem either way. Its real value is the `docker build` → image pipeline, not the runtime.

### container2wasm is Apache-2.0 and actively released (v0.8.5, 2026-11-04), and it self-describes as 'This is an experimental software.' Its network proxy artifact alone is 21,596,090 bytes (`c2w-net-proxy.wasm`, measured from the release assets). Its browser example also requires COOP/COEP (`xterm-pty.conf` sets both headers).

- Evidence: https://github.com/container2wasm/container2wasm/releases/tag/v0.8.5
- Confidence: verified
- Why it matters: Licence is clean and the tooling is real. 'Experimental', by the authors' own label, is the wrong substrate for the layer everything else sits on.

### Worth stealing regardless of verdict: container2wasm's browser demo uses `coi-serviceworker.js` to synthesize COOP/COEP via a service worker on hosts (like GitHub Pages) where you cannot set response headers.

- Evidence: https://github.com/container2wasm/container2wasm/blob/3f0f9be4d5ee201ea1a12f9700e6e3ef52c8b345/examples/wasi-browser/README.md
- Confidence: likely
- Why it matters: Removes 'I need a custom server to set headers' as a blocker on static hosting — the single most common reason people abandon the SharedArrayBuffer approach.

### VERDICT ROW — WASI preview 1 + browser_wasi_shim: ~100 KB of JS, near-native speed, MIT/Apache-2.0 dual, CANNOT host a shell, composes perfectly with JS apps. Single reason to reject as a shell substrate: preview 1 has exactly 46 functions and not one of them creates a process or a pipe.

- Evidence: https://github.com/WebAssembly/WASI/blob/snapshot-01/phases/snapshot/docs.md
- Confidence: verified
- Why it matters: This is the cheapest, cleanest option and it cannot run `ls | sort`. It is a per-process sandbox, not a kernel.

### The complete WASI preview 1 syscall list, extracted from the pinned `snapshot-01` spec: args_get, args_sizes_get, clock_res_get, clock_time_get, environ_get, environ_sizes_get, fd_advise, fd_allocate, fd_close, fd_datasync, fd_fdstat_get, fd_fdstat_set_flags, fd_fdstat_set_rights, fd_filestat_get, fd_filestat_set_size, fd_filestat_set_times, fd_pread, fd_prestat_dir_name, fd_prestat_get, fd_pwrite, fd_read, fd_readdir, fd_renumber, fd_seek, fd_sync, fd_tell, fd_write, path_create_directory, path_filestat_get, path_filestat_set_times, path_link, path_open, path_readlink, path_remove_directory, path_rename, path_symlink, path_unlink_file, poll_oneoff, proc_exit, proc_raise, random_get, sched_yield, sock_recv, sock_send, sock_shutdown. Absent, each one load-bearing for a shell: no pipe (no `|`), no fork/clone, no exec (the module IS the process), no wait/waitpid (no `$?` for a child), no signal delivery (`proc_raise` only raises within the current instance; no handler registration, so no Ctrl-C), no ioctl/tcgetattr/tcsetattr/TIOCGWINSZ (no raw mode, no terminal size, no line discipline), no chmod (no `chmod +x`), no socket/bind/listen/connect (sock_recv/send work only on fds the host pre-opened).

- Evidence: https://github.com/WebAssembly/WASI/blob/snapshot-01/phases/snapshot/docs.md
- Confidence: verified
- Why it matters: Every one of these absences has to be forged by the host kernel. That is the actual work of the project, and it is identical whether you use WASI or not.

### WASI preview 2 / 0.3 does not fix this, and no proposal in the pipeline does. The `wasi-cli` world's WIT has `environment`, `exit`, `run`, `stdio`, `terminal` — and no process, spawn, fork, signal, or job-control interface. `terminal.wit` even defers the basics: 'In the future, this may include functions for querying the terminal size.' The proposals register shows nothing at Phase 4 or 5; the whole of WASI is Phase 3 at best; Threads is Phase 1; there is no process/spawn/signals proposal at ANY phase, including Phase 0.

- Evidence: https://github.com/WebAssembly/WASI/blob/463701e0f6c575a5d24ae31c2ec1e0ebf09d28e1/docs/Proposals.md
- Confidence: verified
- Why it matters: 'Wait for WASI p2/p3 to add processes' is not a plan. Nobody is championing it. Betting the architecture on standards-track POSIX process support is betting on a proposal that does not exist.

### browser_wasi_shim is honest about being partial — 'A subset of wasi_snapshot_preview1 is implemented. The rest either throws an exception, returns an error or is incorrectly implemented' — and its code matches: `proc_raise` is `throw 'raised signal ' + sig`, `sock_recv`/`sock_send` are `throw 'sockets not supported'`. It is MIT OR Apache-2.0. Its separate `threads/` directory carries its own warning: 'less production ready', requires SharedArrayBuffer + waitAsync + Atomics + cross-origin isolation, and 'Firefox failed to run the demo in this directory. Chrome worked fine.' It also ships an OPFS backend (`src/fs_opfs.ts`).

- Evidence: https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/wasi.ts
- Confidence: verified
- Why it matters: Excellent, small, permissively-licensed reference for the shape of a WASI host — and a clear signal that even its author treats the threaded version as unfinished.

### VERDICT ROW — WASIX via @wasmer/sdk: the surprise winner for 'real binaries + real shell'. Measured: 150-202 ms sandbox creation, ~1s first command (cold), 20-180 ms warm, real pipes, real fork/exec, real signals, Modified-MIT licence, hosts a shell AND composes with JS. Single reason to reject: WASIX is one vendor's non-standard extension with no second implementation, and the registry rots under you.

- Evidence: https://github.com/wasmerio/wasmer-js/blob/ddbd6cda7ae1ddc7f744ae42225137c859e9b981/js/README.md
- Confidence: verified
- Why it matters: This is the only option that gives a genuine POSIX process model at near-native speed without emulating a CPU. It reframes the whole decision.

### VERIFIED BY EXECUTION: a real multi-stage pipeline works under WASIX. Running `bash -c "echo a b c | tr ' ' '\n' | sort -r | head -2; echo CODE=$?"` in a `wasmer/bash` sandbox returned exactly `"c\nb\nCODE=0\n"` in 996 ms (cold) under @wasmer/sdk/node on Node 20.19.0. That requires fd_pipe, proc_fork, proc_exec and waitpid to all actually work. Further probes in the same sandbox: `sleep 1 & P=$!; wait $P` returned `BG=2` then `WAITED=0` (background jobs and waitpid work); `trap 'echo GOT_TERM' TERM; kill -TERM $$` printed `GOT_TERM` then `AFTER` (signal handlers work); `/dev` contains `null shm stderr stdin stdout tty urandom zero` and `tty` returns `/dev/tty` with rc=0; file I/O works (`echo data > /tmp/x && ls -la` shows `-rwxrwxrwx 1 somebody somegroup 5`).

- Evidence: https://github.com/wasmerio/wasmer-js/blob/ddbd6cda7ae1ddc7f744ae42225137c859e9b981/js/README.md
- Confidence: verified
- Why it matters: Pipes, job control and signals are the three things everyone assumes are impossible without a VM. They are not. This is the single most consequential fact in this report.

### MEASURED, AND IT CORRECTS THE OBVIOUS ASSUMPTION: WASIX fork/exec is roughly at parity with native macOS exec, not 10x slower. 100 sequential `/bin/true` execs from bash inside the sandbox took 1,090 ms (~11 ms each). The same loop with `/usr/bin/true` in native macOS bash took 844 ms (~8.4 ms each). I expected a large penalty and measured ~1.3x.

- Evidence: https://github.com/wasmerio/wasmer-js/blob/ddbd6cda7ae1ddc7f744ae42225137c859e9b981/js/README.md
- Confidence: verified
- Why it matters: Process churn — the thing a shell does constantly — is not the bottleneck. Compare against v86's measured 18-20x on plain compute. Do not reject WASIX on an assumed fork cost.

### Real coreutils compiled to WASIX exist and run: `wasmer/bash`'s `/bin` contains uutils `coreutils 0.13.0 (multi-call binary)` — arch, b2sum, base32/64, basename, cat, cksum, comm, cp, csplit, cut, date, dd, dir, dircolors, dirname, echo, env, expand, expr, factor, fmt, fold, head, hostid, join, link, ln, ls, md5sum, mkdir, mktemp, mv, nice, nl, nohup, nproc, numfmt, od, paste, pathchk, pr, printenv, printf, ptx, pwd, readlink, realpath, rm, rmdir, seq, sha*sum, shred, shuf, sleep, sort, split, sum, tac, tail, tee, test, touch, tr, true, truncate, tsort, tty, uname, unexpand, uniq, unlink, vdir, wc, yes. Cold `coreutils --help` in a fresh sandbox: 20 ms. uutils itself is MIT.

- Evidence: https://github.com/uutils/coreutils/blob/main/LICENSE
- Confidence: verified
- Why it matters: Answers 'can you compile real coreutils to WASI' with a yes and a prebuilt artifact. Note what is NOT there: no grep, sed, awk, find, ps, kill, chmod, mkfifo, stty, mount. The 80% is free; the last 20% is yours.

### The Wasmer registry rots, verified by execution. In the same script: `wasmer/bash` OK; `sharrattj/bash` (the namespace in most tutorials and blog posts) FAILS with `RuntimeError: js: null function or function signature mismatch`; `python/python@=3.13.20` — the exact pinned version in the SDK's own README — FAILS with `compile error: Validate("Unknown validation error")`; `sharrattj/coreutils` FAILS at load with `InvalidMagic... Expected the magic bytes to be "\x00webc"` because it is still an old tar.gz package. Three of five documented packages are broken today.

- Evidence: https://github.com/wasmerio/wasmer-js/blob/ddbd6cda7ae1ddc7f744ae42225137c859e9b981/js/README.md
- Confidence: verified
- Why it matters: The runtime works; the package ecosystem is unmaintained. Any dependency on the registry must be vendored at a pinned version and tested in CI, or your OS breaks when someone else's package rots.

### WASIX adds precisely the syscalls preview 1 lacks — `proc_fork`, `proc_exec`, `proc_spawn`, `proc_join`, `proc_signal`, `fd_pipe`, `fd_dup`, `tty_get`, `tty_set`, `getcwd`, `chdir`, `thread_spawn`/`thread_join`, `futex_wait`/`futex_wake`, `stack_checkpoint`/`stack_restore`, and a full `sock_*`/`port_*` network stack. `stack_checkpoint`/`stack_restore` is how `proc_fork` is implemented on a stack machine with no address-space copy.

- Evidence: https://wasix.org/docs/api-reference
- Confidence: likely
- Why it matters: WASIX is the only shipped answer to 'what does WASI not give you that a shell needs'. It is also entirely outside the standards process — one implementation, one vendor, no second source.

### The @wasmer/sdk host API is a process manager, not a console: `sandbox.command(name, args).spawn({stdin:'pipe', stdout:'pipe', stderr:'capture', terminal:{columns, rows}})` gives per-process streams you iterate (`for await (const line of process.stdout.lines())`), `process.wait({check})` gives an exit status, and `resizeTerminal(cols, rows)` propagates SIGWINCH-equivalents. `packages.create({modules:{app: wasmBytes}, commands:{hello:{module:'app'}}, files:{...}})` runs your own local wasm with no registry involvement at all.

- Evidence: https://github.com/wasmerio/wasmer-js/blob/ddbd6cda7ae1ddc7f744ae42225137c859e9b981/js/README.md
- Confidence: verified
- Why it matters: Per-process stdout/stdin/exit-status is exactly what CheerpX and v86 withhold and exactly what a window manager needs to route a window to a process. `packages.create` is the escape hatch from registry rot.

### The @wasmer/sdk licence is 'Modified MIT': full MIT terms plus one clause — 'if the Software... is used for any of your commercial products or services that have more than 1 million monthly active users, or more than 1 million US dollars... in monthly revenue, you shall prominently display "Wasmer" on the user interface'. No fee, no self-hosting restriction, and the engine ships in the npm package rather than loading from a CDN.

- Evidence: https://github.com/wasmerio/wasmer-js/blob/ddbd6cda7ae1ddc7f744ae42225137c859e9b981/LICENSE
- Confidence: verified
- Why it matters: The direct opposite of CheerpX on every axis that matters: vendorable, self-hostable, offline-capable, and free at any scale this project will reach. Compare the two licences side by side before choosing.

### WASIX in the browser requires cross-origin isolation, and the SDK fails loudly without it rather than silently degrading: 'Worker-backed WASIX execution requires a cross-origin-isolated page so the browser can use SharedArrayBuffer. Serve the page with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.' The error string in the source is 'You can only run packages from "Cross-Origin Isolated" websites.'

- Evidence: https://github.com/wasmerio/wasmer-js/blob/ddbd6cda7ae1ddc7f744ae42225137c859e9b981/js/bindgen/src/tasks/thread_pool.rs
- Confidence: verified
- Why it matters: Every real option converges on the same deployment constraint. COOP/COEP is the price of admission for a POSIX-like browser runtime, full stop.

### THE KEY MECHANISM, and it is ~50 lines. Synchronous syscalls from a Worker into an async host kernel work like this, as implemented in wanix's `CallBuffer`: allocate a SharedArrayBuffer laid out as [Int32Array ctrl(2), Int32Array len(1), Uint8Array data]. In the Worker, `this.ctrl[0] = 0; postMessage(params); Atomics.wait(this.ctrl, 0, 0); return decode(this.data.slice(0, this.len[0]))`. On the host, after awaiting whatever async work the syscall needed: write the CBOR reply into `data`, set `len[0]`, then `Atomics.store(this.ctrl, 0, 1); Atomics.notify(this.ctrl, 0)`. The guest blocks in a real synchronous call; the host serviced it with `await`.

- Evidence: https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/wasi/callbuffer.ts
- Confidence: verified
- Why it matters: This is the kernel boundary. It is small, MIT-licensed, readable in one sitting, and it is the entire reason a JS kernel can serve blocking POSIX semantics. Everything else in this report is a choice about what sits on top of it.

### `Atomics.wait` is specified to be unusable on the main thread, and throws rather than degrading: 'It is blocking and cannot be used in the main thread' and it throws `TypeError` 'If the current thread cannot be blocked (for example, because it's the main thread).' It only works on an `Int32Array` or `BigInt64Array` viewing a `SharedArrayBuffer`.

- Evidence: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait
- Confidence: verified
- Why it matters: Forces the architecture: every process must be a Worker, and the kernel must be on the other side. There is no main-thread shortcut. This is a constraint worth welcoming — it is the same constraint that makes processes killable.

### SharedArrayBuffer's availability is gated on cross-origin isolation, and the failure mode is confusing rather than clean: 'To use shared memory your document must be in a secure context and cross-origin isolated.' Without COOP/COEP, 'the constructor on the global object is hidden' and 'the various postMessage() APIs will throw for SharedArrayBuffer objects' — but `Atomics` is always present and `WebAssembly.Memory` can still yield a shared instance. It is also growable via `maxByteLength` + `grow()`, and can only grow, never shrink.

- Evidence: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
- Confidence: verified
- Why it matters: COOP/COEP has a real cost beyond a header: `require-corp` means every cross-origin subresource — fonts, images, CDN scripts, iframes — must opt in via CORP/CORS or it fails to load. For a desktop that embeds third-party web content in windows, this is the most under-appreciated constraint in the whole report.

### Asyncify is the alternative when you cannot use threads, and its cost is documented by Emscripten: it 'automatically transforms your compiled code into a form that can be paused and resumed', 'can cause the Wasm output to be much larger', and runtime overhead is 'usually not extreme, something like 50% or so'. `ASYNCIFY_IMPORTS` lists which imports may suspend so no overhead is added elsewhere; `ASYNCIFY_ONLY` narrows instrumentation but the docs warn these manual lists 'are error-prone and can break an application if set incorrectly'. JSPI is offered as the successor with the note that with it 'The code size will remain the same'.

- Evidence: https://emscripten.org/docs/porting/asyncify.html
- Confidence: likely
- Why it matters: Asyncify buys you main-thread operation and no COOP/COEP, at ~50% speed and a much larger binary. SAB+Atomics.wait buys full speed at the cost of COOP/COEP and Worker-only. That is the real trade, and it is the first architectural decision to make.

### The two mechanisms are not theoretical — xterm-pty ships both, side by side, with the gotcha documented. 'We can't block the main thread as that will prevent any events, including user input, from waking the application and causing the deadlock.' Mode 1 is `-s ASYNCIFY`. Mode 2 is `-pthread -s PROXY_TO_PTHREAD`, which moves the app into a Worker and uses proxying, with `Atomics.wait(HEAP32, PTY_atomicIndex, -1)` in its Emscripten JS library. The Asyncify caveat is explicit: 'for performance reasons, we'll only automatically pause to read user input (e.g. via fgets) and not to flush any output, so if your application writes a lot of output non-stop... you won't see it appear on the screen until you manually pause the application with e.g. emscripten_sleep(0)'.

- Evidence: https://github.com/mame/xterm-pty/blob/05ed1ad11003254bdea32e37032402b068fffca5/emscripten-pty.js
- Confidence: verified
- Why it matters: The Asyncify output-flush bug is exactly the class of defect that makes a terminal feel broken while every test passes. Worth knowing before choosing Asyncify, not after.

### xterm-pty (MIT, 126 stars, last pushed 2026-04-07) is a real termios implementation in TypeScript: 493 lines of `lineDiscipline.ts` and 156 of `termios.ts`, with a unit test file, exposing `openpty()` returning `{master, slave}` and `slave.ioctl('TCGETS'|'TCSETS')` over an actual `Termios` struct with iflag/oflag/lflag/cflag. container2wasm's demo drives it exactly this way, clearing ISTRIP/INLCR/IGNCR/ICRNL/IXON, OPOST, and ECHO/ECHONL/ICANON/ISIG/IEXTEN.

- Evidence: https://github.com/mame/xterm-pty/blob/05ed1ad11003254bdea32e37032402b068fffca5/src/lineDiscipline.ts
- Confidence: verified
- Why it matters: 'No ptys' is the standard objection to a browser shell, and it is answerable with 649 lines of MIT TypeScript that someone already wrote and tested. This fills the single largest hole in the WASI syscall list.

### PRIOR ART, THE CLOSEST MATCH — wanix (MIT, 857 stars, pushed 2026-10-26) is a Plan 9-style browser runtime that has already built the kernel boundary webxp lacked. Its `Task` struct carries `driver TaskDriver, parent *Task, ns *vfs.NS, id int, kind, cmd, args, env, exit, dir, fds map[int]*openFile, fdIdx, closer, worker, export fs.FS` — an honest process table with per-process fd tables and per-process namespaces. Pluggable drivers run Go/TinyGo, WASI wasm, JS workers, and x86 Linux via v86 as tasks in the same namespace. Processes and terminals are files (`#task/1/term`). It requires COOP/COEP (set in `cmd/wanix/serve.go` and its service worker) and persists via OPFS.

- Evidence: https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/task.go
- Confidence: verified
- Why it matters: Someone has solved the exact problem — a kernel boundary with pluggable compute, where a v86 VM and a wasm binary and a JS app are all just tasks. Read `task.go` before designing a process table. The architecture is the deliverable, not the code.

### But wanix does NOT implement fork — I grepped the whole tree for it and found no `proc_fork`, no fork driver, no COW. It is spawn/exec only, with per-task namespaces standing in for Plan 9's `rfork`. Its `TaskDriver` interface is just `Check(*Task) bool` and `Start(*Task) error`.

- Evidence: https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/task.go
- Confidence: verified
- Why it matters: Directly answers 'any JS kernel that implements fork/exec honestly': the best-architected one implements exec honestly and declines fork. Of everything surveyed, only WASIX does fork, and it does it via stack_checkpoint rather than address-space copy. Plan a spawn-only process model unless you have a concrete reason to need fork.

### PRIOR ART — JSLinux: reject. It is TinyEMU compiled with emscripten, emulating a 64-bit x86 (SSE4.2, AVX2, AVX-512) or RISC-V, at 'about 100 MIPS' on a 2017 desktop in Firefox. But only the RISC-V version's source is available (in TinyEMU); the page states no licence terms for the x86 version; there is no documented host API; and its networking is a shared public websocket VPN 'capped to 40 kB/s and at most two connections per public IP' with 'Please don't abuse the service.'

- Evidence: https://bellard.org/jslinux/tech.html
- Confidence: verified
- Why it matters: The most impressive demo in the space and the least usable as a dependency: no licence, no source for the x86 build, no API, no self-hostable network. It is a proof that this is possible, nothing more.

### PRIOR ART — BrowserFS is dead and ZenFS is its LGPL-3.0 successor. BrowserFS last saw a push on 2024-07-12 and GitHub reports its licence as NOASSERTION. ZenFS core (`zen-fs/core`, 431 stars) was pushed 2026-11-10 and is LGPL-3.0.

- Evidence: https://github.com/zen-fs/core
- Confidence: verified
- Why it matters: LGPL-3.0 in a bundled browser application is a genuine problem, not a formality: bundling is static linking, which triggers LGPL §4's relinking obligations, and there is no settled practice for satisfying them with a minified JS bundle. Decide this before it becomes load-bearing — a VFS is not a layer you swap late.

### PRIOR ART — Emscripten's FS is the most mature POSIX-in-JS layer and it fakes the process model outright. `emscripten_syscall_stubs.c` hardcodes `static int g_pid = 42; static int g_pgid = 42; static int g_ppid = 1;` and declares `UNIMPLEMENTED(wait4, ...)`, `UNIMPLEMENTED(pipe2, ...)`, `UNIMPLEMENTED(socketpair, ...)` — all returning `-ENOSYS` with a runtime warning. There is no clone/fork/execve syscall at all, so musl's `fork.c` cannot work. `__syscall_uname` returns sysname 'Emscripten'. The file's own header classifies its contents as '1. Fake it... 2. Fake it, as above but warn... 3. Return ENOSYS and warn.'

- Evidence: https://github.com/emscripten-core/emscripten/blob/4.0.17/system/lib/libc/emscripten_syscall_stubs.c
- Confidence: verified
- Why it matters: The reference implementation of POSIX-in-the-browser decided a process model was out of scope and returns a constant PID of 42. If you want processes, you are writing that layer — nobody in the Emscripten lineage has.

### Emscripten's filesystem backends are MEMFS (default, lost on reload), NODEFS/NODERAWFS (Node only), IDBFS (browser, persists via `FS.syncfs()`), WORKERFS (read-only Files/Blobs in a worker), PROXYFS (mount another module's FS). WasmFS is 'Stable, but not yet feature-complete with the old FS'. The core tension is stated outright: 'Applications compiled with Emscripten usually expect synchronous I/O', yet browsers 'do not offer synchronous APIs for persistent storage', and 'Currently, only the IDBFS file system implements the interfaces needed for synchronization.'

- Evidence: https://emscripten.org/docs/api_reference/Filesystem-API.html
- Confidence: likely
- Why it matters: The sync-persistence gap is the problem the whole report circles. Emscripten's answer is an explicit `syncfs()` checkpoint — your filesystem is not durable until you call it.

### The sync-persistence gap is now closed by the platform, and this changes the calculus. `FileSystemSyncAccessHandle` is 'Baseline / Widely available... available across browsers since March 2023'. Its methods are genuinely synchronous ('all current browsers that support these methods implement them as synchronous methods'), and it is restricted exactly where you want a kernel anyway: 'only accessible inside dedicated Web Workers (so that its methods do not block execution on the main thread) for files within the origin private file system'.

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle
- Confidence: verified
- Why it matters: Synchronous, durable, widely-available file I/O inside a Worker. A host kernel can serve blocking POSIX read/write from real persistent storage with no IndexedDB checkpoint dance and no Asyncify. Combined with the CallBuffer, this is the complete substrate for a POSIX VFS — and both wanix and browser_wasi_shim already build on OPFS.

## Reusable

- wanix `CallBuffer` — the synchronous-syscall bridge, ~50 lines of TypeScript, MIT. SharedArrayBuffer laid out as [ctrl Int32Array(2), len Int32Array(1), data Uint8Array]; Worker does `postMessage` then `Atomics.wait(ctrl, 0, 0)`; host replies with `Atomics.store(ctrl, 0, 1)` + `Atomics.notify`. This is the kernel boundary. https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/wasi/callbuffer.ts
- wanix `Task` / `TaskDriver` — a process table with per-process fd tables and per-process namespaces, and pluggable drivers so a v86 VM, a WASI binary and a JS worker are all just tasks. MIT. Read this before designing a process model. https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/task.go
- xterm-pty — a real termios line discipline in 649 lines of tested TypeScript, MIT. `openpty()` → {master, slave}, `slave.ioctl('TCGETS'|'TCSETS')` over an actual Termios struct. Fills the biggest hole in the WASI syscall list (no ioctl/termios/raw mode) and already ships both the Asyncify and the SAB+Atomics integration paths. https://github.com/mame/xterm-pty/blob/05ed1ad11003254bdea32e37032402b068fffca5/src/lineDiscipline.ts
- @wasmer/sdk — depend on it. Modified MIT (attribution only above 1M MAU / $1M MRR), engine ships in the package, self-hostable, and `packages.create({modules: {app: wasmBytes}})` runs your own wasm with no registry dependency. Verified: real pipes, background jobs, signal traps, ~11ms/exec. https://github.com/wasmerio/wasmer-js/blob/ddbd6cda7ae1ddc7f744ae42225137c859e9b981/LICENSE
- uutils coreutils — MIT, and a prebuilt WASIX multi-call binary (`coreutils 0.13.0`) with ~75 utilities already exists and starts cold in 20ms. Vendor the artifact; do not depend on the registry at runtime. https://github.com/uutils/coreutils/blob/main/LICENSE
- v86 — BSD-2-Clause, vendorable, 476 KB gzipped engine. Use it as one task driver for genuinely-legacy x86 workloads, not as the system runtime. Its `filesystem: {handle9p}` hook lets a host-owned VFS back the guest's root, which is the only way a VM and a JS kernel can share one source of truth for files. https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/docs/filesystem.md
- browser_wasi_shim — MIT OR Apache-2.0, ~100KB, the clearest small reference for the shape of a WASI host, plus an OPFS backend (`src/fs_opfs.ts`). Read it to learn the interface; do not expect its `threads/` directory to be production-ready (its own README says Firefox fails). https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/wasi.ts
- `FileSystemSyncAccessHandle` over OPFS — platform-native, Baseline since March 2023, genuinely synchronous, Worker-only. The durable backing store for a POSIX VFS with no IndexedDB checkpoint dance and no Asyncify. Prefer this to ZenFS and sidestep the LGPL-3.0 question entirely. https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle
- `coi-serviceworker.js` — synthesizes COOP/COEP via a service worker where you cannot set response headers (GitHub Pages and similar). Removes the most common practical blocker to the SharedArrayBuffer approach on static hosting; used by container2wasm's own demo.
- container2wasm — Apache-2.0. Worth keeping for the `docker build` → bootable-image pipeline, not for its browser runtime.

## Gotchas

- CheerpX looks like a library and is a hosted service. `npm i @leaningtech/cheerpx` installs a 581-byte file whose entire body is `dynImport('https://cxrtnc.leaningtech.com/1.4.0/cx.esm.js')`. There is no engine artifact anywhere in the package. You cannot vendor it, pin it, audit it, run it offline, or serve it from your own origin without a commercial licence. If that CDN goes away or the Community terms change, your OS does not boot.
- The WebVM repo's Apache-2.0 badge is about the Svelte UI, not the engine. Reading the repo licence as the engine licence is the single easiest mistake to make here, and the README says so explicitly: 'Downloading a CheerpX build for the purpose of hosting it elsewhere is not permitted without a commercial license.'
- CheerpX clause 1.5 scopes a licensed application to 'a single designated origin domain'. A second origin — a staging host, a custom domain, a preview deploy — is arguably outside the grant. And clause 2.1(f) forbids reverse-engineering, which also forecloses writing your own block server compatible with their `wss://disks.webvm.io` CloudDevice protocol.
- 'Just wait for WASI preview 2 / 0.3 to add processes.' There is no process, spawn, fork, or signals proposal at ANY phase of the WASI pipeline — not Phase 1, not even Phase 0. Nothing in WASI is above Phase 3. The `wasi-cli` terminal interface still cannot report a terminal size, and says so in a comment.
- Three of the five packages named in @wasmer/sdk's own documentation fail today. `python/python@=3.13.20` — the exact pinned version in their README — dies with `compile error: Validate("Unknown validation error")`. `sharrattj/bash`, the namespace in nearly every WASIX tutorial online, dies with `null function or function signature mismatch`. `sharrattj/coreutils` is still a tar.gz and fails the WEBC magic-bytes check. Use `wasmer/*`, vendor via `packages.create({modules: {...}})`, and put a smoke test in CI.
- I nearly reported that WASIX fork/exec costs ~10x native, on the reasonable assumption that forking a wasm instance must be expensive. Measured, it is ~1.3x (1,090 ms vs 844 ms for 100 execs). Do not reject WASIX on an assumed fork cost — and note the corollary that macOS native exec is itself slow, so the honest claim is 'parity with native macOS', not 'fast'.
- v86's `create_file`/`read_file` silently do nothing unless a 9p filesystem is configured. Boot from an ISO or raw disk — the normal case — and host file I/O is simply absent, with no error to tell you why. Taking the `handle9p` route to fix it costs you `create_file`/`read_file` entirely, plus all caching, plus keeping 9p state consistent with `save_state` by hand.
- COOP/COEP is not one header on one response. `Cross-Origin-Embedder-Policy: require-corp` means every cross-origin subresource — fonts, images, CDN scripts, embedded iframes, third-party web content in a window — must opt in with CORP or CORS headers or it fails to load. For a desktop whose whole point is hosting embedded content, this is the most expensive constraint in the report and the one least visible at design time.
- `Atomics.wait` throws `TypeError` on the main thread rather than degrading. There is no main-thread path to synchronous syscalls, so the Worker-per-process design is forced, not chosen. Any prototype that works on the main thread is using Asyncify and will not survive the move.
- Asyncify's documented ~50% slowdown is the advertised cost; the unadvertised one is xterm-pty's note that in Asyncify mode output is not flushed until the program yields, so a chatty program shows nothing until it calls `emscripten_sleep(0)`. A terminal that renders in bursts while every test passes is the exact failure this produces.
- v86 cannot run a 64-bit kernel, and the Readme says so flatly. Debian/Ubuntu i386 ends at 16.04/18.04. The Buildroot image I booted runs kernel 2.6.34.14. Choosing v86 is choosing a permanently shrinking 32-bit package universe.
- container2wasm's browser story reads as 'OCI containers in a tab' and is Bochs interpreting x86 inside wasm, single-threaded, no JIT — slower than v86 by its own documentation. The faster path swaps in QEMU-TCG-via-emscripten, a far heavier dependency than v86 for the same result. The project labels itself 'This is an experimental software.'
- ZenFS core is LGPL-3.0. Bundling it into a browser app is static linking, which triggers LGPL §4's relinking obligations, and there is no settled practice for satisfying those with a minified JS bundle. A VFS is not a dependency you swap out late — decide this first.
- JSLinux is the most impressive demo here and the least usable: no licence stated for the x86 build, source available only for the RISC-V version, no documented host API, and networking via a shared public VPN capped at 40 kB/s with two connections per IP.
- `wasmer/bash`'s /bin is uutils coreutils and nothing else — no grep, sed, awk, find, ps, kill, chmod, mkfifo, stty, or mount, and no /proc at all (`cat /proc/self/status` → No such file or directory). `uname` reports 'wasi localhost 0.0.0 wasm32 WASI', not Linux, so anything that sniffs uname takes its non-Linux branch.
- When `mkfifo`, `ps` and `stty` exited 79 in my probes I first read it as 'syscall unsupported'. It is not — `type mkfifo` returns 1 and the binaries are simply absent from /bin. I could not determine from this whether WASIX supports named pipes or TIOCGWINSZ. Beware the same inference.

## Could not determine

- CheerpX's total engine download size. `cx_esm.js` is 386,274 bytes (measured) but the wasm/data chunk filenames are computed at runtime inside the minified bundle, so I could not enumerate or size them. Direct guesses (`cx.wasm`, `cx_esm.wasm`) both return HTTP 204.
- CheerpX performance relative to v86, quantitatively. CheerpX is browser-only and requires COOP/COEP, so I could not run the same dd/shell-loop benchmarks I ran against v86 in Node. 'JIT, therefore faster than v86's JIT' is architecturally plausible and I found no first-party published figure to cite. Treat any specific multiplier you see elsewhere as unsourced.
- CheerpX/WebVM cold boot time to a bash prompt. Same reason — not measurable from this host without a COOP/COEP-serving browser harness.
- container2wasm's browser image size for a real container. The demo loads chunked assets under a path I could not resolve (every candidate returned the 9,379-byte 404 page), and building one locally needs Docker plus a long conversion. The only sizes I could measure are from the release assets: `c2w-net-proxy.wasm` at 21,596,090 bytes and the CLI tarballs at ~6 MB.
- Whether WASIX actually supports named pipes (`mkfifo`) and terminal-size ioctls (TIOCGWINSZ). My probes exited 79, but `type mkfifo` returns 1 — the binaries are simply not in `wasmer/bash`'s /bin, so the exits say nothing about syscall support. The SDK does expose `resizeTerminal(cols, rows)` and `terminal: {columns, rows}`, which suggests sizing is handled out-of-band rather than via ioctl, but I did not confirm this.
- Whether `wasmer/bash`'s pipeline result holds in a browser as well as in Node. All my WASIX measurements are @wasmer/sdk/node on Node 20.19.0. The SDK documents the browser path as Worker-backed and cross-origin-isolated, and the README treats them as one API, but I did not verify browser behaviour or browser-side timings.
- WASIX's long-term governance. wasix.org lists the syscalls but states no standardisation status, and I found no second independent implementation. The one-vendor risk is real but I could not size it.
- Whether v86's measured ~20x slowdown holds in a browser rather than in Node. Both run V8 with the same wasm engine so I expect it to be close, but all my v86 numbers are Node 18.20.2 on macOS/arm64 and browser figures may differ.
- Emscripten's exact Asyncify size cost. The docs say output 'can be much larger' and ~50% slower without giving numbers, and I did not compile a test binary both ways to measure it.
- JSLinux's licence for the x86 build, and whether its source is available at all. bellard.org/jslinux/tech.html states source availability only for the RISC-V version (via TinyEMU) and states no licence terms anywhere.
- JSPI's 2026 browser support status. The MDN page I fetched for `WebAssembly.promising` returned 404 and the JavaScript-builtins page does not mention JSPI in its body. Emscripten documents JSPI as an Asyncify alternative with no code-size cost, but I could not verify which browsers ship it or at what versions — so treat 'use JSPI instead of Asyncify' as unverified.

