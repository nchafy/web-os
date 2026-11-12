# Completeness critique of the exploration round

1. **No syscall table anywhere.** The pool has a transport (wanix `CallBuffer`) and mistakes it for an ABI. Nothing names a single call, its argument encoding, its errno space, fd inheritance across spawn, which calls are cancellable, or what happens to a worker blocked in `Atomics.wait` when the kernel terminates its peer. Go read wanix's syscall dispatch and `browser_wasi_shim/src/wasi.ts`, then write the table — names, args, errors — before any code. Gates every option.

2. **Probably wrong: the agent-cluster table is read as exhaustive.** Two findings conclude a blocking channel can only exist "between the kernel and a dedicated worker it spawned," and that therefore one worker must own all sync handles while others go through a non-blocking path. The normative algorithm says otherwise: a non-top-level worker agent joins "the agent cluster which contains ownerAgent," so sibling workers spawned by the same window share memory (https://html.spec.whatwg.org/multipage/webappapis.html#integration-with-the-javascript-agent-cluster-formalism). A worker-resident filesystem server can serve blocking syscalls to other process workers, with the main thread free. Re-derive all three options against the algorithm, not the examples list.

3. **The hot path has zero numbers.** Nowhere: OPFS `createSyncAccessHandle` read/write latency and throughput, syscall round-trip time through a SAB ring, `new Worker()` time (= process creation cost), RSS per worker and per cross-origin iframe, or any ceiling on concurrent workers. Measure 4 KB/64 KB/1 MB sync reads and writes, a null-syscall round trip, and spawn+memory at 1/10/50 workers. "Process = worker" is currently unpriced.

4. **VFS metadata and crash consistency undecided.** OPFS has no mode bits, uid/gid, symlinks, or settable mtime; "needs a side index" appears twice with no design. IndexedDB and OPFS are not one transaction. Find what `FileSystemDirectoryHandle.move()` guarantees and whether a journal + `flush()` in OPFS alone is durable.

5. **The WASIX exec figure is mis-framed.** 11 ms/exec was called "parity" against an unusually slow macOS baseline, and measured in Node, not a cross-origin-isolated browser worker. Re-run the 100-exec loop in Chrome under COOP/COEP and compare against Linux fork+exec (~1 ms) — the expectation a shell actually sets.

6. **Aero unmeasured, capture conflict unresolved.** No frame-time data for N overlapping `backdrop-filter` + `plus-lighter` windows; the Element Capture backdrop-root requirement contradicts the blur chain with no resolution. Also untested, and it alone gates the iframe-process option: can an opaque-origin iframe be `crossOriginIsolated` and construct a SAB?

7. **Angles not run.** Browsix (USENIX ATC 2017) built a JS kernel with real fork/exec/pipes and published syscall latencies; StackBlitz WebContainer is the only shipped commercial browser kernel. Both absent. Also absent: keyboard focus, hotkey and IME routing across cross-origin app frames; two-tab kernel arbitration; any POSIX `sh` grammar or job-control implementation.

8. **No threat model is stated**, so the origin split cannot be priced. First-party-only apps versus user-installed third-party code is the decision that picks among the three architectures — and it is nowhere in the pool.
