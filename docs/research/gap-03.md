# GAP 3: web-os had a syscall transport (postMessage out, Atomics.wait on a SharedArrayBuffer for the reply) but no ABI — no enumerated call list, no argument encoding, no errno space, no fd-inheritance rule, no cancellation mechanism, no fork decision. This closes that gap with the actual table.

## Verdict

The table is 68 calls across six groups, returning Linux-style negative-errno in one register using WASI preview1's dense 0-76 errno numbers verbatim. Three decisions carry the design: every blocking call is cancellable because a process blocks on exactly one futex word that only the kernel worker ever notifies; fd inheritance is explicit-only via a posix_spawn_file_actions-shaped action list, so nothing is inherited and O_CLOEXEC does not exist; and there is no fork, which costs third-party fork()-without-exec binaries but costs the shell nothing (pipelines, background jobs, job control and command substitution all survive on spawn+pipe+pgrp).

## Detail

**ABI, not transport.** Per process: one 64 KiB `SharedArrayBuffer` + one `MessagePort` to the kernel worker, handed over at spawn. Control words `i32[0]=SEQ` (the only futex word), `[1]=STATUS`, `[2]=RLEN`, `[3]=SIGPEND`, `[4]=CALLID`. Args: `i32[8..15]` = `a0..a7`; 64-bit args take a (lo,hi) register pair. One variable-length arg at byte 128 as `[u32 len][bytes]`; **MAX_INLINE = 65404 B**. Return: `i32[16],[17]` as i64; error iff `r0<0 && r1==-1`, value `-errno` (Linux single-register convention, not WASI's errno-plus-outparam, [preview1 docs](https://github.com/WebAssembly/WASI/blob/v0.2.3/legacy/preview1/docs.md)). Futex handshake borrowed from wanix [`CallBuffer.call`](https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/wasi/callbuffer.ts#L42-L48); its CBOR body is rejected — per-`read()` encode/decode is not payable.

### Process
| call | args | → | errno |
|---|---|---|---|
|`spawn`|byte region = SpawnSpec|pid|NOENT NOEXEC ACCES NOMEM MFILE INVAL|
|`exec`|same; worker torn down, respawned|—|NOENT NOEXEC ACCES|
|`waitpid`|a0 pid(-1=any), a1 flags(WNOHANG)|pid, status in r1|CHILD INTR INVAL|
|`kill`|a0 pid/-pgid, a1 sig|0|SRCH PERM INVAL|
|`getpid`/`getppid`/`getpgid`/`setpgid`|a0,a1|pid/pgid/0|SRCH PERM|
|`exit`|a0 code|never|—|
|`sigaction`|a0 sig, a1 disp(DFL/IGN/HANDLE)|old disp|INVAL|
|`sigprocmask`|a0 how, a1 mask|old mask|INVAL|
|`sched_yield`|—|0 (drains SIGPEND)|INTR|

### fd
`close(a0)`→0 BADF · `read(a0,a1 n)`→count BADF INTR PIPE ISDIR IO AGAIN · `write(a0,byteregion)`→count BADF INTR PIPE NOSPC FBIG · `pread`/`pwrite` add (lo,hi) offset, +SPIPE · `seek(a0,offlo,offhi,whence)`→newoff BADF SPIPE INVAL OVERFLOW · `fstat(a0)`→64 B Filestat in byte region, BADF · `fsync(a0)`→0 BADF IO · `ftruncate(a0,lo,hi)`→0 BADF INVAL IO · `dup(a0)`/`dup2(a0,a1)`→fd BADF MFILE · `fcntl(a0,cmd,arg)` GETFL/SETFL only (O_NONBLOCK, O_APPEND) →val BADF INVAL · `ioctl(a0,req,byteregion)`→0 BADF NOTTY INVAL · `poll(nfds, byteregion = nfds×{i32 fd,u16 events,u16 revents}, timeout_ms)`→nready BADF INTR INVAL.

### path
All take the path in the byte region (UTF-8, no NUL, absolute or CWD-relative; **no `*at` dirfd variants, no capability sandbox** — WASI's `path_open(dirfd,…)` shape at [wasi.ts#L669](https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/wasi.ts#L669) is dropped; `ERRNO_NOTCAPABLE` is therefore unreachable).
`open(flags,mode)`→fd · `mkdir(mode)` · `rmdir` · `unlink` · `rename`(two paths, NUL-joined) · `readdir(fd,cookie)`→packed `{u64 ino,u8 type,u8 nlen,char[]}` records, cookie in r1 (shape from [wasi.ts#L437](https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/wasi.ts#L437)) · `symlink`(two paths) · `readlink`→len · `link` · `stat`/`lstat`→Filestat · `chmod(mode)` · `chown(uid,gid)` · `utimes(atime_ns,mtime_ns)` · `truncate(lo,hi)` · `statfs` · `realpath` · `mount(src,type,dst,optsB)` / `umount(dst)` — longest-prefix table, anuraOS-style, root `/` always mounted OPFS.
errno set: NOENT NOTDIR ISDIR EXIST NOTEMPTY ACCES PERM NAMETOOLONG LOOP XDEV ROFS NOSPC INVAL MFILE IO BUSY NODEV.

### IPC
`pipe2(flags)`→rfd in r0, wfd in r1; NFILE MFILE INVAL · `socketpair(flags)`→same, bidirectional, datagram-framed · `send(fd,byteregion,flags)`→count PIPE BADF NOTSOCK MSGSIZE INTR · `recv(fd,n,flags)`→count BADF NOTSOCK INTR AGAIN · `shutdown(fd,how)`→0 · `shm_create(bytes)`→shmid (separate growable SAB, `maxByteLength`) · `shm_attach(shmid)`→0 NOMEM INVAL SRCH.

### host
`clock_gettime(clkid)`→ns i64 INVAL · `clock_nanosleep(ns,flags)`→0 **INTR** · `random(n≤65536)`→bytes, >65536 returns INVAL (`crypto.getRandomValues` throws `QuotaExceededError` above 65536 B, [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues)) · `env_get`/`env_set`→bytes/0 · `win_create(specB)`→winid NOMEM INVAL · `win_set(winid,propB)` / `win_destroy(winid)` / `win_poll(winid,timeout)`→event records; **EHOSTGONE** INTR · `clipboard_read`/`clipboard_write`→bytes/0 ACCES NOTSUP (gesture-gated, [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText)) · `notify(specB)`→id ACCES · `tty_get(fd)`/`tty_set(fd,termiosB)` — ICANON ECHO ISIG, VMIN VTIME VINTR VQUIT VSUSP ([tcsetattr](https://pubs.opengroup.org/onlinepubs/9699919799/functions/tcsetattr.html)) NOTTY BADF INVAL; with ISIG set the kernel's line discipline turns those bytes into SIGINT/SIGQUIT/SIGTSTP on the foreground pgrp · `tty_winsize_get`/`tty_winsize_set(fd,rows,cols)` — POSIX Issue 8 [`tcgetwinsize`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/tcgetwinsize.html); a set on the master raises **SIGWINCH** on the slave's foreground pgrp · `pty_open()`→master in r0, slave in r1.

**2. errno.** Reuse WASI preview1's numbers verbatim, 0–76 ([wasi_defs.ts#L12-L88](https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/wasi_defs.ts#L12-L88)) — dense and contiguous, so it indexes a JS array, and a wasi-libc binary needs no translation. One extension: `EHOSTGONE = 100`, the DOM object behind a host fd was destroyed; 77–99 reserved for WASI.

**3. fd inheritance.** Nothing is inherited. `SpawnSpec` = `[u32 argc][u32 envc][u32 nact][argv NUL-sep][env NUL-sep][nact × {u32 op, i32 childfd, i32 parentfd, u32 flags}]`, op ∈ {DUP2, CLOSE, OPEN}. Shape from [`posix_spawn_file_actions`](https://pubs.opengroup.org/onlinepubs/9699919799/functions/posix_spawn.html). O_CLOEXEC is thus unnecessary and absent. The shell's children get `DUP2(0←slave, 1←slave, 2←slave)` from `pty_open`; a pipeline gets `DUP2(1←wfd)` / `DUP2(0←rfd)` instead. Fds are kernel-table integers; nothing is transferred.

**4. Cancellation.** Every blocking call is cancellable, by construction: the process blocks only on `SEQ`, and the kernel worker is its only waker. Entry: `s=Atomics.load(c,SEQ); port.postMessage(callid); Atomics.wait(c,SEQ,s)`. The race is closed by spec — `wait` returns `"not-equal"` immediately if SEQ already moved ([MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait)). To interrupt: kernel sets the SIGPEND bit, `STATUS=2`, bumps SEQ, `Atomics.notify`, aborts the in-flight host work via `AbortController`, and drops the late reply by CALLID. The process returns `-EINTR` and runs the handler. A process in user code checks SIGPEND at the next syscall entry or `sched_yield`. **Degradation: a compute loop issuing no syscalls is uninterruptible.** SIGKILL is then `Worker.terminate()`, which is immediate and runs no cleanup ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate)) — so all releasable state (fds, pipes, locks, windows) lives in the kernel, never in the worker.

**5. No fork.** `posix_spawn` only. Browsix forked by cloning the whole linear heap into a new Task ([kernel.ts#L1871-L1898](https://github.com/plasma-umass/browsix/blob/04f0830088560f27d480cde3e37c28269375f59f/src/kernel/kernel.ts#L1871-L1898)) — a full `ArrayBuffer` memcpy, only possible because asm.js holds all state in one buffer; a JS worker has no such buffer. Cost: pipelines, background jobs, job control and command substitution survive (spawn + pipe + pgrp bookkeeping). Lost: `fork()` without `exec` in third-party binaries, and `( subshell )` as a real process — the shell snapshots its own variable table in-process. `$(…)` is `pipe2` + `spawn` + `read`.

**6. Overflow.** Above MAX_INLINE a `write` returns a **short count**; libc loops. POSIX permits this ([write](https://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html)). For bulk, `shm_create` + the `A_SHM` flag bit in `a7` passes `(shmid,off,len)` in registers and bypasses the inline region.

**7. Dead peer.** No worker ever waits on another worker's futex; the kernel owns every pipe. On reap it closes the dead process's fds and decrements refcounts. A blocked reader whose last writer died completes with **0 = EOF, not an errno** ([read](https://pubs.opengroup.org/onlinepubs/9699919799/functions/read.html)); Browsix's `releaseReader()` does exactly this ([pipe.ts#L127](https://github.com/plasma-umass/browsix/blob/04f0830088560f27d480cde3e37c28269375f59f/src/kernel/pipe.ts#L127)). A blocked writer whose last reader died gets **`-EPIPE` + SIGPIPE** ([write](https://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html)).

## Claims

- [documented] WASI preview1 errno values are a dense contiguous 0-76 range (ERRNO_SUCCESS=0 through ERRNO_NOTCAPABLE=76), which is why they can index a flat JS array where Linux's sparse numbers cannot.
  - https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/wasi_defs.ts#L12-L88
- [documented] browser_wasi_shim's WASI preview1 surface is 46 imports; sock_recv, sock_send, sock_shutdown and sock_accept all throw 'sockets not supported', and proc_raise throws a string rather than delivering a signal. There is no spawn, wait, kill, pipe, dup or ioctl anywhere in preview1 - the whole process and IPC half of my table has no WASI counterpart to borrow.
  - https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/wasi.ts#L882-L912
- [documented] browser_wasi_shim's poll_oneoff supports only a single clock subscription, returns ERRNO_NOTSUP for anything else, and busy-waits in an empty while loop until the deadline. A WASI shim therefore cannot provide the blocking primitive an interactive shell needs; the poll() in my table has to be kernel-implemented.
  - https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/wasi.ts#L827-L878
- [documented] wanix's CallBuffer is the transport shape I borrow: ctrl[0]=0, postMessage(params), Atomics.wait(ctrl,0,0) on the caller side; len[0]=buf.length, Atomics.store(ctrl,0,1), Atomics.notify(ctrl,0) on the responder side. It carries a 'TODO: check if it exceeds the buffer size' comment and silently truncates a Uint8Array response to maxData - the overflow case my MAX_INLINE short-count rule is designed to make explicit.
  - https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/wasi/callbuffer.ts#L26-L48
- [spec-normative] Atomics.wait returns 'not-equal' immediately if the value at the index does not equal the expected value, which closes the signal-before-wait race in my cancellation design without a lock.
  - https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait
- [spec-normative] Atomics.wait returns 'ok' when woken by Atomics.notify regardless of whether the expected value changed, so the kernel can wake a blocked process for a signal without having to encode the reply in the futex word itself.
  - https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait
- [spec-normative] Atomics.wait throws TypeError if the current thread cannot be blocked, for example because it is the main thread. The kernel must therefore run in a Worker if it ever needs to block, and process workers can never be the main thread.
  - https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait
- [spec-normative] Worker.terminate() 'immediately terminates the Worker. This does not offer the worker an opportunity to finish its operations; it is stopped at once.' SIGKILL is therefore exact and unblockable, but no in-worker cleanup can run, forcing all releasable state into the kernel.
  - https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate
- [spec-normative] createSyncAccessHandle is only available in dedicated Web Workers and takes an exclusive lock on the file in the default 'readwrite' mode, throwing NoModificationAllowedError on a second handle. Two processes opening the same file for writing cannot each hold their own sync handle; the kernel must own the handle and multiplex.
  - https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle
- [spec-normative] crypto.getRandomValues throws QuotaExceededError when byteLength exceeds 65536, so random() must cap at 65536 and the caller must loop; browser_wasi_shim's random_get chunks at 65536 for this reason.
  - https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues
- [spec-normative] POSIX read() on a pipe with no data and no writers returns 0, not an error, which is why a blocked reader whose last writer was terminated wakes with EOF rather than an errno.
  - https://pubs.opengroup.org/onlinepubs/9699919799/functions/read.html
- [spec-normative] POSIX write() to a pipe with no reader generates SIGPIPE and fails with EPIPE, and write() is permitted to transfer fewer than nbyte bytes - which makes the MAX_INLINE short-count rule POSIX-legal rather than a deviation.
  - https://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html
- [spec-normative] posix_spawn file actions are an ordered list of dup2/close/open operations applied in the child, which is the shape SpawnSpec's action array copies; it is the standard mechanism for passing descriptors to a child without fork.
  - https://pubs.opengroup.org/onlinepubs/9699919799/functions/posix_spawn.html
- [spec-normative] Window size is a POSIX Issue 8 interface (tcgetwinsize/tcsetwinsize), not a Linux-only TIOCGWINSZ ioctl, so tty_winsize_get/set can be spelled as named calls rather than ioctl request numbers.
  - https://pubs.opengroup.org/onlinepubs/9799919799/functions/tcgetwinsize.html
- [spec-normative] ISIG, ICANON, ECHO and the VINTR/VQUIT/VSUSP control characters are the termios fields a line discipline needs to generate SIGINT/SIGQUIT/SIGTSTP; raw mode is ISIG and ICANON cleared with VMIN/VTIME set.
  - https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/termios.h.html
- [documented] Browsix implemented fork by shallow-cloning the parent's fd table, ref()ing each file, and handing the parent's whole heap ArrayBuffer to a new Task. This is a full linear-memory memcpy per fork and depends on asm.js keeping all program state in one buffer - a property a plain JS worker does not have, which is the concrete reason web-os is posix_spawn-only.
  - https://github.com/plasma-umass/browsix/blob/04f0830088560f27d480cde3e37c28269375f59f/src/kernel/kernel.ts#L1871-L1898
- [documented] Browsix's pipe keeps a readWaiter continuation and calls releaseReader() on both write and close, so a blocked reader is resumed by the kernel rather than by the peer - precedent for the kernel-owns-every-pipe rule in item 7.
  - https://github.com/plasma-umass/browsix/blob/04f0830088560f27d480cde3e37c28269375f59f/src/kernel/pipe.ts#L127-L132
- [documented] anuraOS kill is cooperative and cannot be relied on: it postMessages {type:'kill'} into the process iframe and only removes the frame after the iframe answers, and it warns 'Exit codes are not implemented yet, ignoring'. A process that ignores the message is unkillable. web-os must back SIGKILL with Worker.terminate() for exactly this reason.
  - https://github.com/MercuryWorkshop/anuraOS/blob/cc18239e5bf78e580265f09180cd079f9bc92f20/src/api/Processes.tsx#L280-L296
- [documented] anuraOS process stdio is WHATWG streams (stdout: ReadableStream<Uint8Array>, stdin: WritableStream<Uint8Array>) carried over iframe postMessage, not file descriptors. There is no fd table, so there is nothing in anuraOS corresponding to dup2 or to fd inheritance at spawn - the exec path instead reads a shebang and JSON options from the file's first line.
  - https://github.com/MercuryWorkshop/anuraOS/blob/cc18239e5bf78e580265f09180cd079f9bc92f20/src/api/Processes.tsx#L47-L100
- [inferred] The design choice to return -errno in a single register (Linux convention) rather than WASI's separate errno return plus out-pointer is mine, justified by it needing one register pair and by -1..-76 never colliding with a valid fd or byte count.
  - https://github.com/WebAssembly/WASI/blob/v0.2.3/legacy/preview1/docs.md
- [inferred] MAX_INLINE = 65404 bytes follows arithmetically from the chosen layout: 65536-byte SAB, 128-byte control/register header, 4-byte length word. It is a derived constant, not a measured one.
  - https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer/grow
- [inferred] A process that issues no syscalls cannot be interrupted by a signal under this design, because SIGPEND is only observed at syscall entry or sched_yield. This is a real degradation from POSIX, not an implementation gap, and its only remedy is SIGKILL via Worker.terminate().
  - https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate

## Design consequences

- The kernel MUST be a dedicated Worker, not the main thread. Atomics.wait throws TypeError on a thread that cannot block (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait), and createSyncAccessHandle is 'only available in Dedicated Web Workers' (https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle). A thin main-thread relay owns the DOM-only group (win_*, clipboard_*, notify) and reports back to the kernel worker, which then notifies the caller's futex.
- Process workers MUST be handed a MessagePort at spawn rather than relying on the implicit Worker.postMessage channel, which delivers to the creator (https://developer.mozilla.org/en-US/docs/Web/API/MessagePort). Otherwise every syscall lands on the main thread and is re-forwarded, doubling latency and coupling syscall service to UI jank.
- No releasable resource may live in a process worker. Worker.terminate() 'does not offer the worker an opportunity to finish its operations' (https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate), so OPFS sync access handles, pipe buffers, window handles and locks are all kernel-side; a process holds only integers.
- SharedArrayBuffer requires cross-origin isolation (https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated), so this ABI forbids Puter's one-origin-per-app model for syscall-making processes. Syscall processes are same-origin cross-origin-isolated workers; untrusted third-party apps must be a separate tier with no syscall channel at all.
- Dropping the dirfd/*at shape (WASI path_open takes a fd, https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/wasi.ts#L669) moves all path resolution and all permission enforcement into the kernel. There is no preopen-capability fallback; ERRNO_NOTCAPABLE (76) is permanently unreachable and the kernel's own check is the only gate.
- Single-futex-word blocking forbids any worker-to-worker fast path. A pipe between two processes cannot be a shared ring buffer they poll directly, because then the kernel could not wake a blocked reader when the writer is terminated. Every byte of IPC goes through the kernel worker.
- posix_spawn-only means the shell must be an interpreter the kernel hosts, not a fork()-using binary. Any wasm program that calls fork() without exec cannot run; wasi-libc has no fork, so this is only a cost for ported native code.
- A compute-bound process is killable but not interruptible, so the window manager's cancel affordance MUST degrade to SIGKILL and the UI MUST show that distinction. A cooperative yield requirement has to be documented for app authors, because there is no preemption.

## Could not determine

- No syscall round-trip latency figure. No prototype of this ABI exists, so there is no measured number for postMessage + Atomics.wait + notify, and none is given here.
- MAX_INLINE = 65404 B is derived arithmetic from a chosen 64 KiB SAB (65536 - 128 header - 4 length word), not a measured optimum. No benchmark of SAB size against write throughput was run, so the 64 KiB choice is unjustified by measurement.
- wanix has no numbered syscall table to borrow. I found wasi/callbuffer.ts (https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/wasi/callbuffer.ts) and wasi/poll-oneoff.ts, and its dispatch is string-named methods over postMessage with CBOR bodies ('params["method"] = method'), not an enumerated ABI. The transport was borrowable; a call list was not.
- anuraOS has no kernel syscall API file. Its process surface is a TypeScript class at src/api/Processes.tsx (https://github.com/MercuryWorkshop/anuraOS/blob/cc18239e5bf78e580265f09180cd079f9bc92f20/src/api/Processes.tsx) with WHATWG streams for stdio and a cooperative kill that postMessages {type:'kill'} into the iframe and waits for a reply. There is no errno, no fd table, and no numbered call list to compare against. The 'longest-prefix mount' claim in the brief was not re-verified against a file in this pass.
- Whether Atomics.notify can interrupt a worker that is inside a synchronous OPFS call rather than inside Atomics.wait. It cannot, by inspection of the two APIs, but I did not test it. Consequence: a read against a slow OPFS-backed file is probably NOT interruptible even though the table marks read as INTR-capable. This is the weakest point in the cancellation design and needs a measurement before any code.
- The Browsix ASPLOS 2017 DOI could not be confirmed. dl.acm.org and doi.org both returned HTTP 403 to curl, so I cite the repository at pinned sha 04f0830088560f27d480cde3e37c28269375f59f instead of the paper.
- Whether SIGTSTP/job-control suspension is implementable at all. A Worker has no suspend primitive; a stopped process would have to be a kernel-side refusal to service its syscalls, which only stops it at the next syscall. Not resolved here.
