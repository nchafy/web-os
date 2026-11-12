# Glossary

Terms used throughout this repository, in the sense this project uses them. `../CONTEXT.md` is the
narrative version; this is the lookup.

## Operating system terms

**ABI** — Application Binary Interface. The enumerated list of syscalls, their arguments, their
returns and their errors. The real interface of an operating system. Here: `ABI.md`, 68 calls.

**agent cluster** — a browser concept, not a Unix one, but load-bearing here. A set of threads that
may share memory. Every dedicated Worker joins the cluster of whatever created it, so all workers
descended from one window can share a `SharedArrayBuffer`. A cross-origin iframe is in a *different*
cluster, which is why per-app-origin isolation and a shared blocking syscall channel are mutually
exclusive. Constraints 10–13.

**credential** — `{uid, gid, caps}`, passed as an argument on every kernel path call. Permissions
without a caller identity are decoration, which is what they were in webxp. Constraint 29.

**errno** — the numeric error code a syscall returns. This project reuses WASI preview1's numbers
0–76 verbatim, plus `EHOSTGONE = 100`. Returned Linux-style as `-errno` in one register.

**fd / file descriptor** — a small integer naming an open file, pipe, socket, pty or window. Held
by a process; the thing it *refers* to is held by the kernel. In this design a process holds only
integers, so an fd is the only handle it ever has.

**fsck** — filesystem check. The repair pass run when something is inconsistent. Here it never
reseeds: a bad superblock mounts read-only and reports. Constraint 28.

**fsync** — the call that forces buffered writes to durable storage. Separate from `write` because
`flush()` is 260 µs against a 5 µs write. Constraint 23.

**futex** — fast userspace mutex. A memory location a thread parks on until someone changes it. In
a browser: `Atomics.wait` on a `SharedArrayBuffer`. One word per process (`SEQ`), and the kernel is
its only waker — which is what makes every blocking call cancellable.

**inode** — the record describing a file: mode, owner, times, size, link count, and where the data
is. Distinct from the *name*, which lives in a directory. Two names for one inode is a hard link;
delete the last name and the inode survives until the last fd closes.

**journal** — an append-only log of "here is what I am about to change", written before the change.
Replayed at boot to catch up. Damage is almost always at the tail, so replay stops at the first bad
CRC and reports what it discarded.

**kernel** — the one privileged program. Owns the process table, every fd table, every pipe buffer,
every OPFS handle, the inode table and the line discipline. Here it is a dedicated Worker, and it
never blocks. Constraints 1–4.

**line discipline** — the layer turning raw keystrokes into lines: `ICANON` (buffer until Enter),
`ECHO`, `ISIG` (Ctrl-C becomes a signal). **In the kernel, not the terminal widget**, so Ctrl-C
works when the UI is wedged — which is exactly when you need it.

**mount** — making a second store appear inside the one tree. Resolution is longest-prefix. Here:
`/` OPFS, `/usr` a read-only HTTP image, `/tmp` tmpfs, `/proc` and `/dev` generated on read.

**pid** — process identifier. The handle everything else uses to refer to a process. Monotonic and
never reused here, so a stale pid is an error rather than a different process.

**pipe** — a one-way channel where one process's output is another's input. Every byte crosses the
kernel, deliberately: a direct worker-to-worker ring would be faster but then nothing could wake a
blocked reader when the writer is killed.

**preemption** — the kernel interrupting a running program to give someone else a turn. **Not
possible in a browser.** A JS function that loops forever runs until it stops. You can still
*kill* (`Worker.terminate()`), which is why "End Process" works even though scheduling is
cooperative. Constraint 21.

**process** — a running program, with a pid. Exists independently of any window: it may have none,
one, or several, and may outlive them. webxp could not express any of those.

**pty** — pseudo-terminal. A pair of fds: a master the terminal emulator holds and a slave the shell
holds. `pty_open()` returns both.

**signal** — an asynchronous notification to a process. `SIGINT` from Ctrl-C, `SIGKILL` which cannot
be refused. Delivered here through a reserved `SharedArrayBuffer` word, because a process parked in
`Atomics.wait` cannot service `postMessage`. Constraint 16.

**spawn** — create a new process from a program. Used instead of `fork`, which is not implementable
here. Nothing is inherited; fds pass through an explicit action list. `ABI.md` §2–3.

**superblock** — the small record at a known location describing the whole filesystem. Cannot be
read, cannot find anything. Stored twice, alternating, with a CRC.

**syscall** — how a process asks the kernel for something, and the only way it can. Here:
`postMessage` out, park on a futex, kernel replies. 14–16 µs measured.

**VFS** — virtual filesystem. The layer presenting many backing stores as one namespace with one
set of operations.

## Browser primitives

**`Atomics.wait`** — parks the calling thread on a `SharedArrayBuffer` location until notified.
**Throws `TypeError` on the main thread**, because window agents are created with `[[CanBlock]]`
false. That asymmetry is why the kernel must be a Worker and must never block.

**`backdrop-filter`** — CSS blur of what is *behind* an element. How Aero glass is done without a
compositor. Filters the element's **border box**, not its visible area — the trap that caused a
4× accounting error. Constraint 49.

**COOP / COEP** — `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`. Two response
headers required for `crossOriginIsolated`, which is required for `SharedArrayBuffer`. Without
them there is no kernel. `require-corp` is the only Safari-portable value. Constraints 30–33.

**CORP / CORS** — `Cross-Origin-Resource-Policy`, and Cross-Origin Resource Sharing. Under
`require-corp`, a cross-origin resource loads if it sends CORP **or** is fetched in CORS mode and
passes. The second clause is why map tiles work.

**`crossOriginIsolated`** — the boolean that says whether `SharedArrayBuffer` exists. Every harness
in this repo asserts it and aborts rather than report a number from a non-isolated context.

**dedicated Worker** — a separate thread with its own realm, reachable only by messages, and
terminable. A process is one. So is the kernel.

**OPFS** — Origin Private File System. Real browser file storage, and uniquely offers *synchronous*
access via `createSyncAccessHandle` — but only inside a dedicated Worker, and that call costs
495 µs, 100× a syscall. Has no mode bits, no uid/gid, no symlinks, and no settable mtime.

**`OffscreenCanvas`** — a canvas transferable to a Worker. A process's window surface. The reason
the window ABI is calls rather than a device file: a file write cannot transfer a handle.

**realm** — one JavaScript global environment. All scripts in one realm see each other's globals.
The page is one realm; each Worker is another. webxp's failure was that every app shared the page's.

**`SharedArrayBuffer`** — memory two threads both see. The syscall channel is one. Restricted to a
single agent cluster, which is the hard wall in this design.

**`structuredClone`** — the algorithm by which values cross a message boundary. Relevant because
functions and class identity do not survive it, so nothing clever can be passed to a process.

**transferable** — an object whose ownership moves across a message boundary rather than being
copied. `OffscreenCanvas` and `MessagePort` are transferable; that is what makes the surface
design work.

## Project terms

**admission controller** — the blur governor's shape: it decides *before* an area-changing event
whether the frame budget allows it, rather than reacting during a drag. Constraint 49.

**bounce buffer** — a per-process `SharedArrayBuffer` carrying syscall arguments, with offsets in
the message. Chosen because the alternative — mapping the process's own heap — is the one transport
already measured dead. Constraint 8.

**libos** — `src/libos/`, the code that runs *inside* a process: the synchronous syscall stubs and
the realm lockdown. The trust boundary in file form.

**negative control** — a deliberate break that must make a check fail. A check that reports success
without one has not been shown capable of failing. The rule that governs every harness here.

**`--prove-failure`** — the harness mode that inverts the assertion of every check in an
`INVERTIBLE` tuple, so the run *must* report failures. Carried over from webxp.

**realm lockdown / "neutering"** — M6. Deleting `navigator.storage`, `fetch`, `importScripts`,
`indexedDB`, `caches`, `WebSocket` and `Worker` from a process realm before its program runs,
because a same-origin Worker otherwise has ambient OPFS access and can write the kernel's own blob
store. **Hardening, not security** — same-origin is not a security boundary. Constraint 41.

**the spine** — M0 to M6, the 30 working days identical in all three options. Ends with a kernel, a
filesystem, `/proc`, pipes, a pty, a shell, and one window.

**teardown vs reap** — two stages of killing. At `terminate()`: close fds, destroy windows, drop the
taskbar button. The ~2.2 s quarantine afterwards protects only the pid and the SAB, because a
terminated worker keeps running for ~2 s and the UI must not claim otherwise. Constraint 14.

## Other systems referred to

**anuraOS** — web OS with a genuinely Unix-shaped process model (pids, `kill`, stream stdio,
shebang exec, longest-prefix mounts) built on same-origin iframes. Processes with no protection.

**Browsix** — ASPLOS 2017 JS kernel in a browser with real `fork`, pipes and signals. The most
directly relevant prior art; source of several decisions and of the one measured-dead transport.

**CheerpX / WebVM** — x86 JIT to WASM. Real Linux in a tab, with licence terms that need checking.

**daedalOS** — the highest-fidelity reference desktop (`dustinbrett.com`). No kernel. Source of the
copy-on-write `/usr` idea, and of the clearest illustration of what no boundary costs.

**OS.js** — the most deliberately OS-shaped reference. Service registry, mountable VFS, package
format. Needs a Node server; apps still receive the real core object.

**Puter** — the only surveyed web OS with real protection: one origin per app, per-(user, app)
token.

**v86** — x86 emulator in WASM. Real Linux, but a black box behind a serial cable.

**wanix** — models the process table *as a filesystem* (`#task/<tid>/`), the only surveyed design
where the host can address a process without a bespoke API. Source of the futex handshake shape.

**WASI / WASIX** — the WebAssembly System Interface, and Wasmer's POSIX extensions to it. Relevant
to option B, and to the open `fork` question.

**WebContainer** — StackBlitz's browser-resident kernel, the only shipped commercial one. Exposes
no pid, runs its kernel on a separate origin, closed source.

**webxp** — the predecessor, <https://github.com/nchafy/webxp>. A Windows XP desktop that is a very
good window manager and not an operating system. `../CONTEXT.md` §4 says why.

## Fork, and the terms that came out of settling it

**`fork`** — the Unix call that duplicates the calling process: same memory, same open files, same
point of execution, returning 0 in the child and the child's pid in the parent. **Not available
here**, though for narrower reasons than the first version of constraint 20 claimed. A JS process
cannot be snapshotted at all; a stock wasm binary needs rebuilding; and where it works the cost is
a whole-heap copy on the kernel's thread. Constraints 20 and 20a, `research/gap-07-fork.md`.

**Asyncify** — a Binaryen pass that spills a WebAssembly call stack *into linear memory*, so
copying the memory copies the stack. This is the ingredient Browsix lacked in 2016 and the reason
fork is mechanically possible for a recompiled wasm binary today. Costs roughly 50% in size and
speed, build-wide, and excludes wasm exception handling in WASIX's shipping configuration.

**Emterpreter** — Emscripten's old asm.js bytecode interpreter, whose call stack lived in linear
memory. How Browsix's fork worked. Removed in Emscripten 1.39.17 (commit `b43474f5`, 2020-05-18).
Note `research/gap-02.md` says 1.39.18; 1.39.17 is correct, verified by tag.

**JSPI** — JavaScript Promise Integration. Lets wasm suspend across a JS promise. Relevant here as
a trap: adopting it for the syscall channel would *destroy* the Asyncify fork path, because a JSPI
stack lives in engine-managed memory with no JS-visible handle to copy. **Suspending a stack is
not duplicating one** — the conflation worth watching for in this area.

**stack switching / typed continuations** — a WebAssembly proposal. Does not help: continuations
are single-shot by design, and the Explainer explicitly declines process duplication as a use case.

**WASIX `proc_fork`** — Wasmer's real, shipping fork. Verified running in Chrome under
`@wasmer/sdk`. Requires wasix-libc, the `wasix_32v1` import namespace, `wasm-opt --asyncify` and
`shared` memory — so it is not reachable from a stock `wasm32-wasip1` build. Note `@wasmer/sdk` is
not plain MIT above 1 M monthly active users or $1 M monthly revenue.

**`spawn_forkshell` / `re_execute_shell`** — how busybox-w32 (~730 lines) and hush buy back the one
thing fork-free shells genuinely lose: a second shell instance carrying serialised state, so two
shell-internal commands in one pipeline can run concurrently. The thing constraint 20a says to
budget for.
