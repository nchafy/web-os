# The ABI

68 calls in six groups. This is the interface of the operating system — everything else is built
on it, and a change here is a change to the system's contract.

Derived in `research/gap-03.md`, which carries the citation for every borrowed shape. This file is
the normative statement; the research file is the evidence. Where they disagree, this one is wrong
and should be corrected here.

Option A does not implement all 68 in v1 — see `../MILESTONES.md` for the subset per milestone,
and note that A's realised surface is **~40 calls**, not the 34 of the original candidate design.

---

## The transport

Per process, handed over at spawn: **one 64 KiB `SharedArrayBuffer`** and **one `MessagePort`** to
the kernel worker.

```
i32[0]  SEQ       the only futex word. Only the kernel ever notifies it.
i32[1]  STATUS
i32[2]  RLEN
i32[3]  SIGPEND   pending-signal bits, checked at syscall entry
i32[4]  CALLID    per-call unique, monotonic per process, wrapping at 2^31
i32[5]  UID       so getuid() costs no syscall
i32[6]  NR        the syscall number
i32[8..15]        a0..a7. A 64-bit argument takes a (lo, hi) register pair.
i32[16],[17]      r0, r1, together an i64 return
byte 128          one variable-length argument: [u32 len][bytes]
                  so the length word is AT byte 128 and the bytes start at 132
                  MAX_INLINE = 65404 B
```

**`CALLID` is a per-call identity, not the syscall number.** The two readings of the original table
produced two incompatible kernels, so this is stated once here and derived nowhere else. Its job is
the one §1 gives it — letting the kernel drop a late reply after a cancellation — and a syscall
number cannot do that job, because it cannot distinguish two consecutive calls of the same number.
That is precisely the case cancellation creates: interrupt a `read`, the caller retries `read`, and
a late reply to the first must not be mistaken for the second. The number therefore lives in its
own word, `NR`, and the two must not be packed into one i32 — a 16-bit sequence wraps about once a
second under saturation and an aliased stale reply is the bug this separation exists to prevent.
`port.postMessage(callid)` still carries the callid as a bare number, which gives the kernel a free
integrity check: compare the posted value against the `CALLID` word and reply `-EINVAL` if they
disagree.

**The handshake.** The process does:

```js
const s = Atomics.load(ctl, SEQ)
port.postMessage(callid)
Atomics.wait(ctl, SEQ, s)
```

The kernel does the work, then `Atomics.store(ctl, SEQ, s+1)` and `Atomics.notify`.

Measured: **14–16 µs** mean, p50 10–15 µs, p95 25–30 µs. *Faster* than an async `postMessage`
round trip (17.3 µs), so there is no latency argument for an async API.

Those figures are **one caller against an idle kernel**. M0 reproduced the mean — 15.8–16.0 µs at
N=1, on a later Chrome build — and then measured what they never covered: **p99 is 200–255 µs at 16
concurrent callers and 3.06 ms at 128**, because one thread serialises every syscall in the system.
`CONSTRAINTS.md` constraint 51 carries the curve. The p50 and p95 above also sit at or below the
clock's 5 µs quantum (constraint 52), so a 14 µs figure can only ever be a batch mean and never a
percentile.

**The race is closed by spec, not by luck.** If the kernel replies before the process parks,
`Atomics.wait` returns `"not-equal"` immediately. About 0.2% of calls. It is a fast path and must
be handled explicitly — see constraint 7.

Shape borrowed from wanix's `CallBuffer.call`. Its CBOR body is rejected: encode/decode per
`read()` is not payable.

## Errors

**Linux single-register convention.** Error iff `r0 < 0 && r1 == -1`, and the value is `-errno`.
Not WASI's errno-plus-outparam.

**errno numbers are WASI preview1's, verbatim, 0–76.** Dense and contiguous, so they index a JS
array, and a wasi-libc binary needs no translation. One extension: **`EHOSTGONE = 100`** — the DOM
object behind a host fd was destroyed. 77–99 are reserved for WASI.

## No `*at` variants, no capability sandbox

Every path call takes its path in the byte region: UTF-8, no NUL, absolute or CWD-relative. WASI's
`path_open(dirfd, …)` shape is **dropped**.

The consequence is deliberate and load-bearing: **all path resolution and all permission
enforcement happen in the kernel**, and there is no preopen-capability fallback. `ERRNO_NOTCAPABLE`
is permanently unreachable, and the kernel's own check is the only gate.

---

## Process

| call | args | → | errno |
|---|---|---|---|
| `spawn` | byte region = SpawnSpec | pid | NOENT NOEXEC ACCES NOMEM MFILE INVAL |
| `exec` | same; worker torn down, respawned | — | NOENT NOEXEC ACCES |
| `waitpid` | a0 pid (−1 = any), a1 flags (WNOHANG) | pid, status in r1 | CHILD INTR INVAL |
| `kill` | a0 pid/−pgid, a1 sig | 0 | SRCH PERM INVAL |
| `getpid` `getppid` `getpgid` `setpgid` | a0, a1 | pid/pgid/0 | SRCH PERM |
| `exit` | a0 code | never returns | — |
| `sigaction` | a0 sig, a1 disp (DFL/IGN/HANDLE) | old disp | INVAL |
| `sigprocmask` | a0 how, a1 mask | old mask | INVAL |
| `sched_yield` | — | 0 (drains SIGPEND) | INTR |

## fd

`close(a0)` → 0 · BADF
`read(a0, n)` → count · BADF INTR ISDIR IO AGAIN
`write(a0, byteregion)` → count · BADF INTR PIPE NOSPC FBIG
`pread` / `pwrite` — add a (lo, hi) offset, add SPIPE
`seek(a0, offlo, offhi, whence)` → newoff · BADF SPIPE INVAL OVERFLOW
`fstat(a0)` → 64-byte Filestat in the byte region · BADF
`fsync(a0)` → 0 · BADF IO
`ftruncate(a0, lo, hi)` → 0 · BADF INVAL IO
`dup(a0)` / `dup2(a0, a1)` → fd · BADF MFILE
`fcntl(a0, cmd, arg)` — GETFL/SETFL only (O_NONBLOCK, O_APPEND) → val · BADF INVAL
`ioctl(a0, req, arg)` → 0 or a value · BADF NOTTY INVAL PERM SRCH — **two requests**: `TIOCGPGRP` returns the foreground pgid, `TIOCSPGRP` takes it in `arg`. Every other request answers INVAL, which is the honest state of a call this kernel does not serve. `arg` is a REGISTER and not a byte region: both requests carry one integer, and `tty_winsize_set` takes its arguments the same way for the same reason. A request needing a record is what the byte region is there for, and none exists yet.
`poll(nfds, byteregion = nfds × {i32 fd, u16 events, u16 revents}, timeout_ms)` → nready · BADF INTR INVAL

## path

`open(flags, mode)` → fd · `mkdir(mode)` · `rmdir` · `unlink` ·
`rename` (two paths, NUL-joined) ·
`readdir(fd, cookie)` → packed `{u64 ino, u8 type, u8 nlen, char[]}` records, cookie in r1 ·
`symlink` (two paths) · `readlink` → len · `link` ·
`stat` / `lstat` → Filestat · `chmod(mode)` · `chown(uid, gid)` ·
`utimes(atime_ns, mtime_ns)` · `truncate(lo, hi)` · `statfs` · `realpath` ·
`mount(src, type, dst, optsB)` / `umount(dst)` — longest-prefix table, `/` always OPFS

**M3: neither call is implemented, and that is the design rather than a gap.** The table is static
at boot, so a process cannot mount at all — which is the narrowest possible form of the rule that
`mount` must never accept a caller-supplied URL (`docs/LEARNING-MODE.md` §6). When these do land,
`src` is a **provider id** resolved against the committed table in `src/kernel/providers.mjs`, never
a URL: otherwise every process holds an SSRF primitive aimed at the browser's network position, and
M6 deletes `fetch` from the process realm precisely to prevent that.

`statfs`'s path is **optional**. An empty byte region means the root mount, which is what the libos
stub has always sent and means "this filesystem"; a path names the mount that owns it. Making it
mandatory would break every existing caller, and ignoring it would make `statfs("/proc")` report the
OPFS volume's numbers — the one thing a mount table exists to stop.

Longest prefix is taken on **component boundaries, not on the string**. `/usrlocal` is not inside
the `/usr` mount.

errno set: NOENT NOTDIR ISDIR EXIST NOTEMPTY ACCES PERM NAMETOOLONG LOOP XDEV ROFS NOSPC INVAL
MFILE IO BUSY NODEV

## IPC

`pipe2(flags)` → rfd in r0, wfd in r1 · NFILE MFILE INVAL
`socketpair(flags)` → same, bidirectional, datagram-framed
`send(fd, byteregion, flags)` → count · PIPE BADF NOTSOCK MSGSIZE INTR
`recv(fd, n, flags)` → count · BADF NOTSOCK INTR AGAIN
`shutdown(fd, how)` → 0
`shm_create(bytes)` → shmid (a separate growable SAB, via `maxByteLength`)
`shm_attach(shmid)` → 0 · NOMEM INVAL SRCH

**A pipe holds 65536 B**, declared once as `PIPE_CAPACITY` in `src/abi.mjs`. The number is just
above `MAX_INLINE` (65404), so one maximal single write fits in an empty pipe and a caller never has
to split a write it was allowed to make.

**No write is atomic, at any size.** POSIX guarantees that a write under `PIPE_BUF` is indivisible;
this implementation does not, and a caller that needs atomicity must not rely on it. A write that
would exceed the remaining space blocks until a reader drains it, and a write larger than the
capacity makes progress in pieces — it does not deadlock.

## host

`clock_gettime(clkid)` → ns i64 · INVAL
`clock_nanosleep(ns, flags)` → 0 · **INTR**
`random(n ≤ 65536)` → bytes; above 65536 returns INVAL, because `crypto.getRandomValues` throws
`QuotaExceededError` past that
`env_get` / `env_set` → bytes / 0
`win_create(specB)` → winid · NOMEM INVAL
`win_set(winid, propB)` / `win_destroy(winid)` / `win_poll(winid, timeout)` → event records ·
**EHOSTGONE** INTR
`clipboard_read` / `clipboard_write` → bytes / 0 · ACCES NOTSUP (gesture-gated)
`notify(specB)` → id · ACCES
`tty_get(fd)` / `tty_set(fd, termiosB)` — ICANON ECHO ISIG, VMIN VTIME VINTR VQUIT VSUSP ·
NOTTY BADF INVAL
`tty_winsize_get` / `tty_winsize_set(fd, rows, cols)` — a set on the master raises **SIGWINCH** on
the slave's foreground pgrp
`pty_open()` → master in r0, slave in r1

**Option A amends the window group** — see `../PLAN.md` §5. `win_create` returns an **fd** (not a
bare winid) so `poll()` is the single wait primitive, and it also returns a transferred
`OffscreenCanvas` as the window's surface. It gains `owner` and `modal`, and a
`WIN_CLOSE_REQUEST` event. Three `dataobj_*` calls are added for a typed clipboard and
drag-and-drop. Constraints 42–45.

**M4a added NO CALL.** The whole window group is still M7's and M8's, and none of it is
implemented. What M4a built is `/dev/console`: a character device whose description is kind `F_WIN`
and which is therefore reached through `open`, `read`, `write`, `poll` and `close` — calls that
already existed. The window is a FILE DESCRIPTION from the first day there is a window, which is
the half of constraint 42 that cannot be retrofitted; `win_create` replaces the one producer of
that description and nothing else changes. `src/kernel/console.mjs` carries the special-case
notice and `docs/DECISIONS.md` D25 the alternatives it rejected.

Two errnos answer for it, and they are not interchangeable (constraint 159): **ENXIO** for a name
with no device behind it — `/dev/console` exists on every kernel and a window does not — and
**EHOSTGONE** for a window that existed and was destroyed, which is a hangup and raises SIGHUP on
the foreground group.

---

## The five decisions that carry the design

**1. Everything blocking is cancellable, by construction.** A process blocks only on `SEQ`, and the
kernel worker is its only waker. To interrupt: the kernel sets the SIGPEND bit, sets `STATUS=2`,
bumps `SEQ`, notifies, aborts the in-flight host work via `AbortController`, and drops the late
reply by CALLID. The process returns `-EINTR` and runs its handler.

**The degradation, stated plainly: a compute loop issuing no syscalls is uninterruptible.** SIGKILL
is then `Worker.terminate()`, which runs no cleanup — which is *why* every releasable resource
lives in the kernel and a process holds only integers.

**2. The fd table is inherited across `spawn`, then the action list rearranges it.** That is
`posix_spawn`'s own order, and it is what lets a shell say "dup the pipe onto 1, then close the
pipe fd". A child of a process with a redirected stdout gets the redirection.

> **Corrected.** This section read "Nothing is inherited across `spawn`. Explicit-only" until it
> was checked against the code: `src/kernel/kernel.mjs`'s `spawnChild` walks the caller's whole fd
> table and raises a refcount per description before applying any action, and
> `docs/CONSTRAINTS.md` constraint 47 already described "a spawned child inherits it". The
> implementation and the constraints agreed with POSIX; this document did not. A reader who
> believed it would have leaked every open fd into every child and never closed it.

The action list is `posix_spawn_file_actions`-shaped:

```
SpawnSpec = [u32 argc][u32 envc][u32 nact]
            [argv NUL-separated][env NUL-separated]
            [nact × {u32 op, i32 childfd, i32 parentfd, u32 flags}]   op ∈ {DUP2, CLOSE, OPEN}
```

`O_CLOEXEC` is therefore unnecessary and absent. The shell's children get
`DUP2(0←slave, 1←slave, 2←slave)` from `pty_open`; a pipeline gets `DUP2(1←wfd)` / `DUP2(0←rfd)`.
Fds are kernel-table integers — nothing is transferred.

**3. No `fork`. `posix_spawn` only — for narrower reasons than first stated.**

Fork was demonstrated *working* in Chrome 157 for this project, so "impossible" is the wrong word.
It is unavailable here because:

- a **JS** process cannot be snapshotted at all (closures, generators and Promises are
  un-cloneable; no realm-snapshot API exists), and v1 runs JS;
- a **stock `wasm32-wasip1`** binary cannot either — it needs rebuilding with `wasm-opt --asyncify`
  plus wasix-libc and `shared` memory;
- and where it does work the cost is a whole-heap memcpy on the kernel's own thread — 16.6 ms at
  64 MiB, 85.7 ms at 256 MiB — during which the kernel services nobody.

Browsix's own §6 says a `setcontext` equivalent plus SharedArrayBuffers would have let it support
fork *as a synchronous system call*, so the blocking channel was never the obstacle. Full account:
`research/gap-07-fork.md`, constraint 20.

*Survives:* pipelines, background jobs, job control, `$(…)` (which is `pipe2` + `spawn` + `read`),
and `( subshell )` — which in-process is *more* POSIX-conformant for `$$`, `$!` and `PPID`.
*Lost:* `fork()` without `exec` in third-party binaries, and **concurrency between two
shell-internal commands in one pipeline** (`f | g` with both functions). That last one is the real
casualty and needs a second shell worker; see constraint 20a.

**4. Overflow is a short count, not an error.** Above `MAX_INLINE`, `write` returns a short count
and libc loops; POSIX permits this. For bulk transfer, `shm_create` plus the `A_SHM` flag bit in
`a7` passes `(shmid, off, len)` in registers and bypasses the inline region entirely.

**5. A dead peer wakes its partner correctly, and the two directions differ.** No worker ever waits
on another worker's futex — the kernel owns every pipe. On reap it closes the dead process's fds
and decrements refcounts.

- A blocked **reader** whose last writer died completes with **0, meaning EOF**. Not an errno.
- A blocked **writer** whose last reader died gets **`-EPIPE` plus `SIGPIPE`**.

Getting this backwards makes `yes | head -1` either hang or report a spurious error, so it is worth
restating: readers see EOF, writers see EPIPE.

The fd group listed `PIPE` in `read`'s errno set, and that was wrong: `read` never returns
`-EPIPE`. `write` keeps it, because that is the direction EPIPE belongs to.

---

## The weakest point in the cancellation design, measured

**`Atomics.notify` cannot interrupt a thread inside a synchronous OPFS read.** It woke **0
workers**, against a baseline where the same notify woke 1 worker parked in `Atomics.wait` with a
0.15 ms wake latency. A thread inside a synchronous call is not in `Atomics.wait`, so there is
nothing to wake.

**`read()` is INTR-capable as this document claims anyway, because of where the handles live.**
Since M0b the sync access handles are in the kernel's I/O worker, so the *calling* process parks in
`Atomics.wait` and is fully interruptible: the kernel replies `ST_INTR` and drops the late answer by
CALLID. The I/O worker's read runs to completion and its result is discarded. What a signal waits
for is the chunk in flight — **10 µs p99** at the 64 KiB `MAX_INLINE` cap, 0.005 ms median.

The design was already right, for a reason the original question did not consider. Harness
`bench/m4-intr/probe.py`; recorded as `docs/CONSTRAINTS.md` constraints 86–89.
