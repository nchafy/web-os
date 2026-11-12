# GLASSWINE — a Linux-compatibility-first web OS

> The bet: `web-os` is only interesting if an **unmodified `wasm32-wasip1` binary**, exactly the
> bytes `cargo` emitted, runs in a window. Everything else — the window manager, Aero, the
> desktop — is chrome over a userland. Build the userland first and the chrome second.

---

## 1. Thesis

The 68-call ABI in [`gap-03.md`](../research/gap-03.md) is a Linux-shaped syscall table. WASI
preview1 is a 46-function import list. These are not competitors: **preview1 is the client of the
ABI, not an alternative to it.** A process worker runs a wasm module that imports
`wasi_snapshot_preview1`; the worker's JS glue translates each import into one ABI call over the
SharedArrayBuffer bounce buffer. The wasm never sees the SAB.

That translation is mechanical for 45 of the 46 imports. The entire Linux-compatibility bet reduces
to three questions, and this document answers all three concretely:

1. **Does `wasm32-wasip1`'s preopen/dirfd path model fit an ABI with no `*at` calls?** No. The 68-call
   table dropped `*at`, and that was a mistake. §4.2 amends it: a `dirfd` register in `a0`, with
   `AT_FDCWD = -100`. One register, 17 calls, and every `path_*` import becomes a 1:1 map.
2. **What does `fork`'s absence actually cost?** Not pipelines, not job control, not `$(...)`. It
   costs stock `bash`/`ash`/`dash`, `make -j`, `git`, and `xargs -P` — permanently. §6 is specific.
3. **Is WASI's errno/rights/filetype model close enough that `isatty` tells the truth?** Only if the
   synthesized `fdstat` is exactly right. §4.5 gives the table and §9/M4 makes it a check.

What this design believes that the others do not: **the shell must itself be a wasm binary, not
JavaScript.** If the most important process in the system is privileged JS calling kernel internals
directly, webxp's failure mode — the app *is* the window, nothing isolated, nothing killable — has
been rebuilt at the worst possible place, and the ABI will never be exercised hard enough to find
out whether it is sufficient. `wsh` is the ABI's acceptance test.

---

## 2. Runtime: preview1, and why not the alternatives

### 2.1 Committing to preview1

**Decision: `wasm32-wasip1`, core modules, flat imports. v1 and probably forever.**

| | preview1 (`wasm32-wasip1`) | preview2 (`wasm32-wasip2`) |
|---|---|---|
| artifact | a core wasm module | a **component** |
| browser can instantiate | yes, `WebAssembly.instantiate` | **no** — needs `jco transpile` first |
| import shape | 46 flat functions in one namespace | WIT interfaces, resource handles, canonical ABI |
| errno space | dense 0–76, indexes a JS array | same values, wrapped in `result<_, error-code>` |
| process/spawn/signals | absent | **absent**, and at no phase of the proposal pipeline |

The third row is the whole argument. A component cannot be handed to
`WebAssembly.instantiate`; adopting preview2 buys a transpiler in the build and a canonical-ABI
lifting layer in the shim, and the thing it would buy — standardised processes — does not exist.
[`WASI/docs/Proposals.md`](https://github.com/WebAssembly/WASI/blob/463701e0f6c575a5d24ae31c2ec1e0ebf09d28e1/docs/Proposals.md)
has nothing at Phase 4 or 5, nothing in WASI above Phase 3, and **no process/spawn/signals proposal
at any phase, including Phase 0** ([`04-browser-linux-runtimes.md`](../research/04-browser-linux-runtimes.md)).
`wasi-cli`'s `terminal.wit` still cannot report a terminal size and says so in a comment.

preview1's errno numbering is already the ABI's errno space — dense and contiguous 0–76, so it
indexes a flat JS array where Linux's sparse numbers cannot
([`wasi_defs.ts#L12-L88`](https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/wasi_defs.ts#L12-L88)).
Committing to preview2 would mean re-deriving that mapping for no gain.

**Escape hatch.** Nothing in the 68-call ABI is preview1-specific. If `jco`-transpiled preview2 glue
ever becomes the only way to get a binary, it is a second shim module against the same ABI. The ABI
does not move. That is the point of having an ABI rather than a runtime.

### 2.2 What wasi-libc gives, and what it withholds

wasi-libc is musl's top half over a WASI bottom half. What it **gives**, free, with no work from us:

- `malloc`/`free` on `memory.grow`, the whole of stdio with its buffering, `printf`, `qsort`, math,
  `pthread`-free locale and time, `getopt`, `dirent`, `glob` (userspace), `fnmatch`, `regex`.
- `open`/`openat`/`stat`/`lstat`/`readdir`/`rename`/`link`/`symlink`/`readlink`/`unlink`/`mkdir`
  — all of it, routed through `path_*` with a preopen lookup.
- `read`/`write`/`pread`/`pwrite`/`lseek`/`fsync`/`ftruncate`/`dup2` (as `fd_renumber`).
- `isatty`, which is why §4.5 matters.

What it **withholds**, and each absence is load-bearing:

| absent | what breaks | our answer |
|---|---|---|
| `fork`, `vfork`, `clone` | stock `bash`, `ash`, `dash`, `make`, `git`, `xargs -P` | none. Permanent. §6 |
| `execve` | re-exec, shebang dispatch from inside a program | `webos_unix.proc_spawn` + `proc_exec` |
| `pipe`, `pipe2` | `\|` from inside a program | `webos_unix.fd_pipe` |
| `wait`, `waitpid` | `$?` for a child | `webos_unix.proc_join` |
| `kill`, `sigaction`, signal handlers | Ctrl-C, any supervisor | `webos_unix.proc_signal` + `sigaction` |
| `tcgetattr`, `tcsetattr`, `TIOCGWINSZ` | raw mode, `vi`, `less`, `top`, ncurses | `webos_unix.tty_get`/`tty_set` |
| `chmod`, `chown` | `chmod +x` | ABI has both; add the libc stubs |
| `mmap(MAP_SHARED)`, `shm_open` | shared-memory IPC in ported code | `shm_create`/`shm_attach`, not POSIX-shaped |
| `socket`, `bind`, `listen`, `connect` | real networking | out of scope in v1 |
| `getpid`, `getppid`, `getpgid` | any process-aware program | `webos_unix`, 1:1 |

So: a binary that only reads stdin, writes stdout, takes argv, and touches files runs **unmodified**.
A binary that wants processes needs an extra import module — which means it needs to be compiled
against our libc additions, which means it is not unmodified. That line is the architecture.

### 2.3 The three tiers of binary

**Tier A — filters. Unmodified, no patch, no recompile beyond `--target wasm32-wasip1`.**
Pure preview1: argv, env, stdin/stdout/stderr, file I/O, `exit`. This is where almost everything
useful lives: `uutils coreutils` (~75 utilities, MIT,
[LICENSE](https://github.com/uutils/coreutils/blob/main/LICENSE)), `ripgrep` as `grep`, `sqlite3`,
`lua`, `jq`, `gzip`, `python` (minus `subprocess`), `cmark`, `sha256sum`. Tier A is the 80% and it
is nearly free.

**Tier B — process users. Need `webos_unix`, must be built against our libc shim.**
Shells, supervisors, `tee`-like fan-out, test runners. `wsh` is here. Stock `bash` is **not** —
it forks, and wasi-libc has no `fork`, so it does not even link against wasi-sdk.

**Tier C — terminal users. Need `webos_unix` termios plus a pty.**
`vi`, `less`, `top`, anything ncurses. Deferred past v1, but the ABI calls
(`tty_get`/`tty_set`/`tty_winsize_*`/`pty_open`) land in M4 so Tier C is additive, not a redesign.

### 2.4 Why not WASIX

WASIX adds exactly the calls preview1 lacks — `proc_fork`, `proc_exec`, `proc_spawn`, `proc_join`,
`proc_signal`, `fd_pipe`, `fd_dup`, `tty_get`, `tty_set`, `chdir`, `getcwd`, `thread_spawn`,
`futex_wait`, `stack_checkpoint`/`stack_restore` ([wasix.org](https://wasix.org/docs/api-reference))
— and the project measured it **working**: a four-stage `bash` pipeline, background jobs, `trap`
handlers, ~11 ms/exec ([`04-browser-linux-runtimes.md`](../research/04-browser-linux-runtimes.md)).
That is the strongest single result in the research pool. Rejecting it needs a reason.

The reason: **adopting `@wasmer/sdk` means adopting a second kernel.** Wasmer brings its own process
table, its own fd table, its own VFS. Then there are two sources of truth for processes and two for
files, and the window manager cannot address a WASIX process by *our* PID — which is precisely the
failure gap-02 names for WebContainer ("exposes NO PID, no process table"). The research pool's own
design consequence is "model the process table as a filesystem" so the host can enumerate and
address a process; a nested opaque runtime forecloses that.

Reimplementing the WASIX ABI on our kernel instead has a hard stop at `proc_fork`, which is built on
`stack_checkpoint`/`stack_restore` — guest-side stack capture, one vendor, no specification, no
second implementation.

**But there is a cheap middle, and we take it.** The WASIX subset that is just "preview1 plus the
obvious missing calls" — `fd_pipe`, `fd_dup`, `proc_spawn`, `proc_join`, `proc_signal`, `tty_get`,
`tty_set`, `chdir`, `getcwd`, `getpid` — maps 1:1 onto the 68-call ABI with no stack-capture magic.
So `webos_unix` **uses WASIX's names and signatures wherever WASIX has one**, and explicitly refuses
`proc_fork`, `stack_checkpoint` and `stack_restore` with `ENOTSUP`. That buys source compatibility
with any `wasm32-wasmer-wasi` code that does not fork, for about a day of shim work, with no vendor
dependency and no second process table.

Registry rot is a separate and settled reason not to depend on Wasmer at runtime: three of the five
packages named in the SDK's own README fail today, including the exact pinned `python/python@=3.13.20`
([`04-browser-linux-runtimes.md`](../research/04-browser-linux-runtimes.md)). §7 replaces the registry
with a build-time packer.

### 2.5 Not v86, not CheerpX, not container2wasm

Settled by the research and not reopened. A full-system emulator is "a black box at the far end of a
serial cable": the host JS sees a serial byte stream and cannot route a window to a guest PID
([`04-browser-linux-runtimes.md`](../research/04-browser-linux-runtimes.md)). v86 is ~20x native
measured, 32-bit-only. CheerpX is a 581-byte npm shim that `dynImport`s a closed engine from
`cxrtnc.leaningtech.com` — unvendorable, unauditable, and a single point of failure in the kernel
position. Running real Linux does not buy a kernel boundary; writing the syscall channel does.

v86 stays on the roadmap as **one task driver** for genuinely legacy x86, behind
`filesystem: {handle9p}` so a host-owned VFS backs the guest root. Not in v1, not in the estimate.

---

## 3. Process model

### 3.1 A process is exactly one dedicated Worker

```
window (main thread)                 kernel worker              process workers (nested)
├ WM, compositor, xterm.js           ├ process table            ├ proc.worker.js + wasm
├ DOM relay for win_*/clipboard_*    ├ fd tables                ├ preview1 shim
└ [[CanBlock]] = false               ├ inode table (authoritative)│ webos_unix shim
   (Atomics.wait THROWS here)        ├ OPFS sync handles        └ [[CanBlock]] = true
                                     ├ pipe buffers                 blocks in Atomics.wait
                                     └ [[CanBlock]] = true
```

The kernel worker is a **top-level dedicated worker** created by the window. Process workers are
**nested** workers created by the kernel worker. Measured: a nested worker has
`crossOriginIsolated === true` and blocks and wakes on its parent's `Atomics.notify`
([`gap-01.md`](../research/gap-01.md), `tests.nestedWorker`, 144.55 ms). The spec lists "a worker (of
any type) and a dedicated worker it created" as one agent cluster
([HTML §agent clusters](https://html.spec.whatwg.org/multipage/webappapis.html#integration-with-the-javascript-agent-cluster-formalism)),
so the SAB crosses freely.

**No iframes. Zero.** Per-app origins and a shared blocking channel are mutually exclusive — a SAB
sent to a cross-origin frame arrives as `messageerror`, measured across 7 configurations
([`gap-01.md`](../research/gap-01.md)). The only reason for an iframe is a third-party tier, and v1
does not have one.

### 3.2 One worker per process, not two

[`gap-02.md`](../research/gap-02.md) says "budget two Workers per process", because a worker parked
in `Atomics.wait` cannot service `postMessage`, so it cannot receive a signal. **This design
disagrees, and has the mechanism.**

Signals arrive through the `SIGPEND` control word in the process's own SAB. The kernel is the only
notifier of that futex. To interrupt: set the `SIGPEND` bit, set `STATUS = 2`, bump `SEQ`,
`Atomics.notify`, abort the in-flight host work via `AbortController`, drop the late reply by
`CALLID`. The process returns `-EINTR` and runs the handler. There is nothing a coordinator worker
could do that the futex word does not already do, and the coordinator would double the per-process
cost from 271 KiB to 542 KiB against a measured renderer ceiling of 3200 live workers
([`gap-04.md`](../research/gap-04.md)). wanix pays for a coordinator because its CallBuffer has no
signal word; that is a consequence of its design, not a platform constraint.

`SIGKILL` is `Worker.terminate()`, called by the kernel worker on its own child. It returns in ~10 µs
but the worker keeps running for ~2.0 s (measured 2004/2051/2003/2048/2009 ms, n=5), so the process
table holds a `ZOMBIE_TERMINATING` state for 2.1 s and the next spawn is not assumed free (22.7 ms
measured after a mass kill).

**Consequence, enforced:** no releasable resource lives in a process worker. `terminate()` runs no
cleanup, so fds, pipe buffers, OPFS sync handles, window handles, pgrp membership and shm segments
are all kernel-side. A process holds integers and its own linear memory.

### 3.3 The syscall path, exactly

A `write(1, buf, 4096)` from a wasm program:

```
1. wasm calls import wasi_snapshot_preview1.fd_write(fd=1, iovs=ptr, iovs_len=2, nwritten=outptr)
2. shim reads the 2 iovecs out of instance.exports.memory.buffer  (plain ArrayBuffer, NOT shared)
3. shim gathers both iovec payloads into sab bytes [132 .. 132+n)   <- the bounce buffer
4. shim writes i32[8]=1 (a0=fd), i32[2]=n (RLEN), i32[4]=SYS_write (CALLID)
5. s = Atomics.load(ctrl, SEQ); port.postMessage(SYS_write); Atomics.wait(ctrl, SEQ, s)
     - "not-equal" (~0.2% of round trips) is the fast path and is handled explicitly
6. kernel port handler: dispatch[SYS_write], resolve fd 1 in this pid's fd table,
   append to the pipe buffer or write through the OPFS sync handle
7. kernel writes i32[16],[17] = count, Atomics.store(ctrl, SEQ, s+1), Atomics.notify(ctrl, SEQ)
8. shim reads r0, writes count into memory at outptr, returns ERRNO_SUCCESS (0)
```

Cost: 14–16 µs mean for the round trip (measured, kernel in a worker) plus two memcpys. Browsix-Wasm
measured exactly this shape — separate SAB, args copied in, offsets in the message — at **0.2%
average / 1.2% max overhead on SPEC CPU**, and stated the copy cost "is dwarfed by the overall cost
of the system call invocation" ([arXiv:1901.09056](https://arxiv.org/abs/1901.09056)). **Build the
bounce buffer, not a mapped heap.** Browsix's mapped-heap transport is the one thing in this space
measured dead: `WebAssembly.Memory` was not shareable and had no Atomics.

Blocking is not a tax. The SAB channel is *faster* than async `postMessage` on the same pair — 14.0
vs 17.3 µs mean over 20,000 iterations each — because `Atomics.wait` skips a task-queue turn
([`gap-04.md`](../research/gap-04.md)).

### 3.4 The bounce buffer is growable — an amendment to gap-03

[`gap-03.md`](../research/gap-03.md) fixes `MAX_INLINE = 65404 B` from a 64 KiB SAB, and notes the
figure is "derived arithmetic ... not a measured optimum". For a WASI userland a fixed 64 KiB is
wrong: a `fd_write` of 1 MiB becomes 17 round trips, and while POSIX permits a short `write`
([write](https://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html)), not every program
loops.

**Amendment.** Per process:

```js
new SharedArrayBuffer(64 * 1024, { maxByteLength: 8 * 1024 * 1024 })
```

`MAX_INLINE = sab.byteLength - 132`. When a call needs more, the shim calls `sab.grow(nextPow2(need))`
and sets the `GROW` control word; the kernel re-derives its `Uint8Array` view whenever
`sab.byteLength` differs from its cached length. A growable SAB grows in place and never shrinks
([MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer/grow)),
so reserving 8 MiB of address space costs no committed memory until used. Above 8 MiB the ABI
returns a short count and the shim loops — the explicit, loud version of wanix's `// TODO: check if
it exceeds the buffer size`, which silently `slice(0, 16360)`s any reply over 16360 bytes.

Browsix-Wasm used a flat 64 MB per process. 8 MiB × 1000 processes of *reserved* address space is
affordable; 64 MB × 1000 is not, and no WASI program's single call needs it.

---

## 4. The preview1 → 68-call mapping, complete

46 imports. Where each one goes.

### 4.1 Served entirely in the worker, zero syscalls

`args_get`, `args_sizes_get`, `environ_get`, `environ_sizes_get` — argv and environ arrive in the
`init` message at spawn (Browsix's trick: a Worker takes no startup data, so `_start` is delayed
until `init` lands). Writing them into the module's memory is a memcpy, never a round trip.

`fd_prestat_get(3)` → `{ pr_type: PREOPENTYPE_DIR, u.dir.pr_name_len: 1 }`.
`fd_prestat_dir_name(3)` → `"/"`. **Exactly one preopen, fd 3, named `/`.**

This is the single most load-bearing detail in the whole shim. wasi-libc's
`libc-bottom-half/sources/preopens.c` registers preopens at startup, and
`__wasilibc_find_relpath()` maps an absolute path to a `(dirfd, relative-path)` pair by longest
prefix. With one preopen named `/`, `open("/etc/passwd")` becomes
`path_open(dirfd=3, "etc/passwd")`. Get the name wrong and every absolute path fails with `ENOENT`
inside libc before a syscall is ever issued. M1's first negative control is exactly this.

`fd_advise`, `fd_allocate` → `ERRNO_SUCCESS`, no-op. Some programs treat a `posix_fadvise` error as
fatal; a no-op success is correct for a VFS with no readahead to advise.

`fd_fdstat_set_rights` → `ERRNO_SUCCESS`. The ABI has no capability model and grants all rights, so
every narrowing request succeeds. `ERRNO_NOTCAPABLE` (76) stays permanently unreachable.

`clock_res_get` → a shim constant: 5 µs for `REALTIME`/`MONOTONIC`, matching the measured and
documented cross-origin-isolated `performance.now()` resolution
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now)). No round trip for a
constant.

`proc_raise(sig)` → `kill(getpid(), sig)`. browser_wasi_shim does `throw 'raised signal ' + sig`
([wasi.ts#L882-L912](https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/wasi.ts#L882-L912));
we deliver a real signal.

`sock_accept`, `sock_shutdown` → `ERRNO_NOTSUP` in v1. `sock_recv`/`sock_send` → ABI `recv`/`send`,
which **do** work on `socketpair` fds; they fail `ENOTSOCK` on anything else.

### 4.2 Direct 1:1 on the fd group

| preview1 | ABI | note |
|---|---|---|
| `fd_close` | `close` | |
| `fd_read` | `read` | shim scatters the returned bytes across the iovecs |
| `fd_write` | `write` | shim gathers all iovecs into one bounce-buffer region — **one** call, not N |
| `fd_pread` / `fd_pwrite` | `pread` / `pwrite` | 64-bit offset as an `(lo,hi)` register pair |
| `fd_seek` | `seek` | |
| `fd_tell` | `seek(fd, 0, SEEK_CUR)` | |
| `fd_sync`, `fd_datasync` | `fsync` | separate from `write` — `flush()` is 260 µs vs a 5 µs 4 KiB write |
| `fd_filestat_get` | `fstat` | 64-byte `Filestat` in the byte region |
| `fd_filestat_set_size` | `ftruncate` | |
| `fd_filestat_set_times` | — | via `fd`→path in the kernel; `utimes` semantics |
| `fd_fdstat_get` | `fstat` + `fcntl(GETFL)` | shim synthesizes `fdstat` — see §4.5 |
| `fd_fdstat_set_flags` | `fcntl(SETFL)` | `O_NONBLOCK`, `O_APPEND` only |
| `fd_readdir` | `readdir` | packed `{u64 ino, u8 type, u8 nlen, char[]}`, cookie in `r1` |
| `fd_renumber` | `dup2` | |
| `proc_exit` | `exit` | |
| `sched_yield` | `sched_yield` | drains `SIGPEND` |
| `random_get` | `random` | shim chunks at 65536 — `getRandomValues` throws `QuotaExceededError` above it |
| `clock_time_get` | `clock_gettime` | ns as i64 |

### 4.3 The path group — and the `dirfd` amendment

[`gap-03.md`](../research/gap-03.md) states: "**no `*at` dirfd variants, no capability sandbox** —
WASI's `path_open(dirfd,…)` shape is dropped". For a Linux-compatibility-first design **this is the
one decision in the table that has to be reversed**, because every single `path_*` import carries a
dirfd and wasi-libc *always* sends a relative path.

The alternatives, and why they lose:

- *Keep a per-fd path string in the worker and concatenate.* Wrong under `rename` and symlink races,
  and it is a TOCTOU hole even in a first-party model. It also moves path resolution back into the
  untrusted side, which the research's own design consequence forbids.
- *Resolve the dirfd to a path in the kernel, then re-resolve the joined path.* Two walks, and the
  same race.

**Amendment: the 17 path calls take a `dirfd` in `a0`, with `AT_FDCWD = -100`.** Path arguments move
to `a1…`. The kernel already resolves paths from the root inode; it now starts from
`fdtable[pid][dirfd].inode` instead. Cost: one register and a one-line change to the resolver. Gain:
every `path_*` import is a direct map, `openat`/`fstatat`/`unlinkat`/`renameat`/`linkat`/
`symlinkat`/`readlinkat`/`mkdirat`/`utimensat` all work from libc unchanged, and the shim has no
path arithmetic in it at all.

| preview1 | ABI |
|---|---|
| `path_open(dirfd, path, oflags, rights_base, rights_inh, fdflags)` | `open(dirfd, flags, mode)` |
| `path_create_directory` | `mkdir(dirfd, …)` |
| `path_remove_directory` | `rmdir(dirfd, …)` |
| `path_unlink_file` | `unlink(dirfd, …)` |
| `path_rename(old_dirfd, old, new_dirfd, new)` | `rename(a0, a1, …)` — two dirfds |
| `path_symlink` | `symlink(dirfd, …)` |
| `path_readlink` | `readlink(dirfd, …)` |
| `path_link` | `link(a0, a1, …)` |
| `path_filestat_get(dirfd, flags, path)` | `stat` / `lstat` by the `LOOKUP_SYMLINK_FOLLOW` bit |
| `path_filestat_set_times` | `utimes(dirfd, …)` |

`oflags`/`rights`/`fdflags` → `O_*` translation is a static table in the shim:
`OFLAGS_CREAT → O_CREAT`, `OFLAGS_DIRECTORY → O_DIRECTORY`, `OFLAGS_EXCL → O_EXCL`,
`OFLAGS_TRUNC → O_TRUNC`; `FDFLAGS_APPEND → O_APPEND`, `FDFLAGS_NONBLOCK → O_NONBLOCK`,
`FDFLAGS_DSYNC|RSYNC|SYNC → O_SYNC`; and the read/write mode is derived from
`rights_base & (RIGHT_FD_READ | RIGHT_FD_WRITE)` — the only place `rights` is load-bearing on the way
in.

### 4.4 `poll_oneoff` — the one import that is real work

browser_wasi_shim's `poll_oneoff` supports **a single clock subscription**, returns `ERRNO_NOTSUP`
for anything else, and busy-waits in an empty `while` loop until the deadline
([wasi.ts#L827-L878](https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/wasi.ts#L827-L878)).
Every interactive binary — anything that waits on stdin with a timeout — hits this.

Mapping onto the ABI's `poll(nfds, pollfd[], timeout_ms)`:

```
for each subscription s in subs[0..nsubs):
    EVENTTYPE_CLOCK      -> timeout_ms = min(timeout_ms, deadline(s) - now)
    EVENTTYPE_FD_READ    -> pollfd{ fd: s.fd, events |= POLLIN  }
    EVENTTYPE_FD_WRITE   -> pollfd{ fd: s.fd, events |= POLLOUT }
userdata[] is a shim-side array indexed by subscription order; the ABI never sees it
one syscall. on return, walk revents and emit one `event` record per ready fd,
plus one FD_READ event with nbytes_avail for a readable pipe, plus one CLOCK event on timeout.
```

Kernel side, `poll` must multiplex: N processes blocked on `poll` means N entries in a wait-set
keyed by fd, with the kernel's own async event loop free. **The kernel must never block.** It is a
single-threaded worker servicing a `MessagePort`; if it ever `Atomics.wait`s on behalf of a caller,
every other process stalls. `poll` registers interest and returns to the message loop; the waker is
whatever makes the fd ready (a `write` into a pipe, a pty byte from the main-thread relay, a timer).
This is Browsix's design — "the syscall-response continuation is queued on the read side when empty"
([arXiv:1611.07862](https://arxiv.org/abs/1611.07862)) — and it is the correctness condition for the
whole system. M3's proof includes a check that it holds.

### 4.5 `fd_fdstat_get` and the `isatty` trap

wasi-libc's `isatty` is not a syscall. It calls `fd_fdstat_get` and returns true **iff**
`fs_filetype == FILETYPE_CHARACTER_DEVICE` **and** the rights set lacks `RIGHT_FD_SEEK` and
`RIGHT_FD_TELL`. Get this wrong and the program picks the wrong stdio buffering mode and the wrong
colour behaviour, and nothing errors.

| ABI fd kind | `fs_filetype` | rights | `isatty` |
|---|---|---|---|
| regular file | `REGULAR_FILE` | all, incl. SEEK/TELL | false |
| directory | `DIRECTORY` | all | false |
| pipe (`pipe2`) | `UNKNOWN` | SEEK/TELL **cleared** | **false** |
| socketpair | `SOCKET_STREAM` | SEEK/TELL cleared | false |
| pty slave / master | `CHARACTER_DEVICE` | SEEK/TELL **cleared** | **true** |
| `/dev/null`, `/dev/zero` | `CHARACTER_DEVICE` | SEEK/TELL **set** | false |

The pipe row is the subtle one: `CHARACTER_DEVICE` with SEEK cleared would make `isatty` true for a
pipe, so `ls | cat` would colourise and `ls` would line-buffer. `UNKNOWN` is what browser_wasi_shim
uses and it is correct. The `/dev/null` row inverts it: a character device that *is* seekable in our
model is not a tty. M4's check asserts both directions.

---

## 5. `webos_unix` — the second import module

One wasm module, two import namespaces. `wasi_snapshot_preview1` is complete and authoritative;
`webos_unix` is the 22 calls preview1 does not have, using WASIX's names and signatures where WASIX
has one so that `wasm32-wasmer-wasi` source ports with a header swap.

```
proc_spawn(spec_ptr, spec_len) -> pid         # SpawnSpec: argv, env, posix_spawn file actions
proc_exec(spec_ptr, spec_len)  -> !           # same spec; this worker is torn down and respawned
proc_join(pid, flags)          -> pid, status # waitpid; WNOHANG
proc_signal(pid_or_negpgid, sig)-> 0          # kill
proc_sigaction(sig, disposition)-> old
proc_sigprocmask(how, mask)    -> old
getpid / getppid / getpgid / setpgid
chdir(path) / getcwd(buf, len)
fd_pipe(flags)                 -> rfd, wfd
fd_dup(fd) / fd_dup2(fd, newfd)
fd_ioctl(fd, req, buf)
socketpair(flags)              -> fd0, fd1
tty_get(fd, termios_out) / tty_set(fd, termios_in)
tty_winsize_get(fd) / tty_winsize_set(fd, rows, cols)
pty_open()                     -> master, slave
shm_create(bytes) -> shmid / shm_attach(shmid)
win_create(spec) -> winid / win_set / win_destroy / win_poll
clipboard_read / clipboard_write / notify
mount(src, type, dst, opts) / umount(dst)
proc_fork / stack_checkpoint / stack_restore  -> ERRNO_NOTSUP, always, documented
```

`proc_fork` returning `ENOTSUP` is a design statement, not a stub. It is in the module so a WASIX
build links and fails at the right place with the right errno, instead of failing at
instantiation with a missing import and no explanation.

**libc side.** A small static archive, `libwebos.a` (~600 LoC C), provides `fork`-free POSIX
spellings over `webos_unix`: `posix_spawn`, `waitpid`, `kill`, `sigaction`, `pipe`, `dup`, `dup2`,
`tcgetattr`, `tcsetattr`, `ioctl(TIOCGWINSZ)`, `chmod`, `chown`, `getpid`, `chdir`, `getcwd`. Link
it after `-lc` with `-Wl,--allow-undefined` off, so a missing symbol is a link error at build time
rather than a trap at run time. That is the whole Tier B / Tier C toolchain.

---

## 6. What `fork`'s absence costs, concretely

Browsix states it outright: "fork is not compatible with synchronous system calls, as there is no way
to re-wind or jump to a particular call stack in the child Web Worker"
([arXiv:1611.07862](https://arxiv.org/abs/1611.07862)). Its only fork path copied the entire linear
heap plus an Emterpreter program counter; the Emterpreter was deleted in Emscripten 1.39.18. Browsix,
wanix and WebContainer all converge on spawn. **Do not design around fork.**

**What survives, on `posix_spawn` + `pipe2` + pgrp bookkeeping:**

| shell feature | mechanism |
|---|---|
| `a \| b \| c` | `pipe2` × 2, `spawn` × 3 with `DUP2` file actions |
| `a > f`, `a >> f`, `a < f` | `open` then `DUP2(1←fd)` in the SpawnSpec |
| `a && b`, `a \|\| b`, `a; b` | `proc_join` and branch on status |
| `a &` | `spawn`, do not join, record in the job table |
| `$?` | the status from `proc_join` |
| `$(cmd)` | `pipe2` + `spawn` + `read` to EOF |
| `fg` / `bg` / `jobs` | pgrp + `setpgid` + `tty_set` foreground pgrp |
| Ctrl-C | line discipline raises `SIGINT` on the foreground pgrp |
| `exec 3< file` | fds are kernel integers; `open` + `dup2`, no fork needed |

**What is lost, permanently:**

- **Stock `bash`, `ash`, `dash`, `zsh`.** They call `fork()`. wasi-libc has no `fork`, so they do not
  link against wasi-sdk at all. This is why §1 insists the shell be ours.
- **`( subshell )` as a real process.** `wsh` snapshots its own variable table in-process. Observable
  difference: a variable assignment inside `( )` does not leak out (correct), but `( )` shares the
  shell's PID, so `echo $$` inside it is wrong and `kill` on it kills the shell.
- **`make`.** GNU make calls `fork` + `exec` and has no `posix_spawn` backend. No `make` in v1.
  (`ninja` uses `posix_spawn` on some platforms and is a candidate for a port; unverified.)
- **`git`.** Forks for hooks, pager, editor, and `git-*` subcommand dispatch.
- **`xargs -P`, `parallel`, `timeout`** — anything that supervises by forking.
- Any third-party binary that calls `fork()` without `exec()`.

The honest framing: **we do not run a stock Linux userland. We run stock Linux *filters*, under our
own shell.** That is a smaller claim than "Linux in a browser" and a much larger one than any JS web
OS has made.

---

## 7. How a binary gets in: `wpk`, build-time only

No runtime registry. Three of five packages in `@wasmer/sdk`'s own README are broken today; a
runtime registry means someone else's rot becomes our boot failure.

**`/usr` is a copy-on-write overlay**, which is daedalOS's best idea
([`scripts/fs2json.js`](https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/scripts/fs2json.js)):

```
/usr   overlay( lower = httpimg(dist/usr.index.json, read-only, HTTP)
                upper = opfs:/.rw/usr  (COW, whiteouts for deletes) )
```

`dist/usr.index.json` is the daedalOS `fs2json` shape — `{fsroot, size, version: 4}`, each node
`[name, size, mtime, target]`, where `target` is a symlink string or a child array. It already
carries `mtime` and symlink targets, exactly the two things OPFS cannot store. Blobs are
content-addressed at `dist/usr/blobs/<sha256>`.

**`wpk.json`**, one per package, emitted by the packer, never read at runtime by the kernel:

```json
{ "name": "uutils-coreutils", "version": "0.13.0", "license": "MIT",
  "source": "https://github.com/uutils/coreutils@0e8f9a1...",
  "abi": "wasip1", "tier": "A",
  "build": "cargo build --release -p uu_wc --target wasm32-wasip1",
  "files": [ { "path": "/usr/bin/wc", "sha256": "9f2c…", "size": 1184320, "mode": "0755" } ],
  "provides": ["wc"] }
```

`scripts/pack.py` reads `packages/*.toml`, runs each build in a container, verifies the emitted
module's import list against the declared `abi` and `tier` (**a Tier A package that imports
`webos_unix` is a build failure**), writes the blobs, and regenerates `usr.index.json`. Licences are
collected into `dist/LICENSES` at pack time.

**exec dispatch**, kernel side:

1. Read the first 4 bytes of the target. `\0asm` → wasm driver. `#!` → read the first line, re-exec
   the interpreter with the script as `argv[1]` (anuraOS's shape, minus its JSON options blob).
   Anything else → `ENOEXEC`.
2. `sha256` is in the inode (computed at pack time for `/usr`, at write time elsewhere). Look it up
   in the kernel's `Map<sha256, WebAssembly.Module>` LRU.
3. Hit → `postMessage` the `Module` to the fresh process worker. `WebAssembly.Module` is
   structured-serializable within one agent cluster, so no recompilation.
4. Miss → read the bytes, `WebAssembly.compile`, cache, send.
5. The process worker itself is one cached Blob URL for `proc.worker.js` (1.86 ms from a Blob vs
   3.45 ms from HTTP, measured), plus ~5–6 ms to instantiate. Budget ~8 ms warm — under one frame.

**First-party shipping list** (all built from pinned source, all permissive):
`uutils coreutils` 0.13.0 (~75 utils, MIT), `ripgrep` as `grep` (MIT/Unlicense), `sqlite3` (public
domain), `lua` (MIT), `jq` (MIT), `cmark` (BSD-2), `wsh` (ours).

**A real compiler** is the angle's headline claim and it is the one I cannot yet support. I did not
verify a WASI-hosted `clang` artifact exists. `jprendes/emception` runs clang in wasm but via
Emscripten with its own memfs, not WASI. `tcc` targets x86/ARM, not wasm. This is M7's job and it has
a kill criterion: if no `wasm32-wasip1`-hosted compiler can be built in ~10 days, say so publicly and
ship `lua` as the scripting story, rather than quietly redefining "compiler".

---

## 8. VFS, in one paragraph of consequence

Taken wholesale from [`gap-06.md`](../research/gap-06.md), with two changes that this angle forces.
The authoritative inode table lives **in memory in the kernel worker** (stat 27 ns, depth-5 walk
370 ns, measured) and is persisted as alternating OPFS superblock snapshots (`sb.0`/`sb.1`/`sb.ptr`)
plus an append-only crc32'd journal (`j.log`), with file data in a **flat** OPFS directory `b/<ino>`
— flat because Chrome 157 has no `FileSystemDirectoryHandle.move()` and Safari 27.2 rejects the
one-argument rename, so `fileHandle.move(dirHandle, name)` is the only portable primitive. Ordering
per mutation: write the blob and `flush()`, append the journal record and `flush()`, then apply in
memory — data before metadata, because an orphan blob is garbage while a record pointing at absent
data is corruption. Snapshot every 512 records. IndexedDB holds exactly one thing:
`FileSystemDirectoryHandle`s for host mounts. Mounts are longest-prefix: `/` opfs, `/usr` the overlay
above, `/proc` `/dev` `/sys` genfs synthesized on read, `/tmp` tmpfs, `/mnt/host/<label>` hostfs
(Chromium only — `showDirectoryPicker` is `undefined` in Safari 27.2).

**Change 1: the credential.** webxp's `vfs.mjs` has one instance-wide `this.uid`/`this.gid` — "the
identity every call is made as. One process." Every kernel path-resolution and signal-delivery
function takes `cred = {uid: u32, gid: u32, caps: u32}` as its **first argument**, sourced from the
process table by PID, never from instance state. `kill` checks
`cred.uid === target.cred.uid || (cred.caps & CAP_KILL)`. This is what makes a second user a change
rather than a rewrite.

**Change 2: bytes.** `inode.data` is a JS string throughout webxp; `readFile`/`writeFile`/
`appendFile`/`copyFile`/`usedBytes` all measure `.length`. Data becomes `Uint8Array` in `b/<ino>`
before any wasm binary can be stored, because a wasm module is not valid UTF-16.

**`/proc` is a real filesystem**, wanix-shaped — `#task/<tid>/` is the only surveyed design where the
host can enumerate, inspect and address a process with no bespoke API, which is exactly what routing
a window to a PID needs. `/proc/<pid>/{cmdline,status,cwd,fd/N,ctl}`, where `ctl` accepts `signal`
and `setpgid`. WebContainer's opaque handle with `kill()` and no PID is the failure mode to avoid.

**fsck never silently reseeds.** A snapshot that fails validation mounts read-only and surfaces it.
webxp reseeds on a bad image, which is correct for a demo and data loss once the files are the user's.

---

## 9. Shell and window manager

**`wsh`** — Rust, `wasm32-wasip1`, Tier B, ~1,800 LoC. Words, quotes, backslash escapes, globs
(`*`, `?`, `[…]`), `|`, `<`, `>`, `>>`, `&&`, `||`, `;`, `&`, `$?`, `$VAR`, `$(…)`, `~`, `#`
comments, `cd`/`export`/`jobs`/`fg`/`bg`/`kill` builtins, job control over pgrp + `tty_set`.

The grammar is **ported from webxp's `apps/terminal/shell.mjs`** (453 lines) as a specification, not
as code: quoting tracked per character span rather than per word, and the per-word `magic` flag that
makes `ls '*'` look for a file named `*` while `ls "no"*` still expands. That rule is a solved edge
case and re-deriving it in Rust from the JS is cheaper than rediscovering it.
`apps/terminal/glob.mjs` (160 lines) ports the same way.

**pty and line discipline.** `pty_open()` → `(master, slave)`. The line discipline is ported from
xterm-pty's `lineDiscipline.ts` (493 lines, MIT) into the **kernel worker**, driving a real `Termios`
struct with `iflag`/`oflag`/`lflag`/`cflag`. With `ISIG` set, `VINTR`/`VQUIT`/`VSUSP` bytes become
`SIGINT`/`SIGQUIT`/`SIGTSTP` on the foreground pgrp; `tty_winsize_set` on the master raises
`SIGWINCH` on the slave's foreground pgrp. xterm.js lives on the main thread and relays bytes to the
master fd through the kernel's DOM relay. "No ptys in a browser" is answerable with 649 lines of
tested MIT TypeScript somebody already wrote.

**Aero: fidelity Tier 2 — recipe-faithful, asset-redrawn.** Tier 1 (pixel-identical with Microsoft's
bitmaps) is legally impossible: Microsoft permits product icons only in documentation, forbids them
"as a graphical or design element" and "in software applications", and forbids shipping screenshots
in a product UI. Tier 3 is "Aero-ish". We ship Tier 2:

- The composite is the documented recipe: additive (`plus-lighter`) over a Gaussian-blurred backdrop
  — blurred RGB scaled by `blurBalance` 0.49, a Rec.709 luminance copy tinted by `afterglow` 0.43,
  and a flat colorization tint 0.08, over `rgb(116,184,252)`. It can clip above 1.0 and is allowed to.
- The highlight streak is a bitmap anchored to the **monitor**, not the window, parallaxed at 0.1.
- Every icon and glass bitmap authored from scratch. Selawik built from source with `fontmake` (the
  repo ships zero `.ttf`), stack `"Segoe UI", Selawik, system-ui, …` — naming Segoe UI in CSS is
  explicitly permitted, self-hosting it is not, and Selawik is **not** documented as
  metric-compatible, so layouts are checked against both faces.
- **An area governor, because the budget is area not count.** Measured: 120 fps holds to ~58 M
  blurred device px per frame and halves to 62.2 fps at 63 M. At dpr 2 that is ~51 windows of
  640×440 but only ~13 full-screen. The governor sums each glass element's border-box area every
  frame and drops to a flat fill above 55 M.

**WM**, from webxp: `src/window.mjs` (836 lines — 8-edge resize, drag, minimise, maximise, focus) and
`src/desktop.mjs` (878) port with the chrome restyled Luna → Aero. The contract change is the whole
point: **a window is no longer the app.** A window is a kernel object (`win_create` → `winid`) owned
by a PID; the main thread holds only the DOM node. Close sends `SIGTERM` to the owning pgrp and
escalates to `SIGKILL` after 2 s (terminate takes ~2.0 s to actually stop a spinning worker). A PID
with no window is a background process. A window whose PID died shows the dead affordance and
`win_poll` returns `EHOSTGONE`. The UI must distinguish "interrupted" from "killed", because a
compute loop issuing no syscalls is killable but not interruptible.

---

## 10. Threat model: (i) first-party only

Enforcement is the Worker boundary plus the syscall ABI, and it is honest about what that is: **a
resource-ownership boundary, not a security boundary against hostile code.**

What it genuinely enforces: every releasable resource — fds, pipe buffers, OPFS sync handles, window
handles, pgrp membership, shm segments — lives in the kernel worker's tables keyed by PID, so
`SIGKILL` via `Worker.terminate()` always reclaims even though it runs no cleanup. The `cred` struct
is the first argument of every path-resolution and signal-delivery call. A hard cap of 1000 live
processes sits in the process table, because the renderer dies between 3200 and 4800 workers and
every process shares one renderer.

What it does **not** stop: a first-party app burning CPU, spamming the kernel, filling the quota, or
reading any file its uid can read.

Third-party code gets **no syscall channel at all.** Per-app-origin isolation and a shared blocking
channel are mutually exclusive — measured, 7 iframe configurations, the SAB arrives as
`messageerror`. If a third-party tier ever ships it is a separate tier: a cross-origin-isolated
iframe with `allow="cross-origin-isolated"` plus its own COEP header, its own SAB, and a broker
worker doing an async hop to the host kernel. **Two hops, not one.** Keeping the ABI
`postMessage`-shaped with no shared globals is what makes that a deployment change rather than a
rewrite.

Deployment: `COOP: same-origin` + `COEP: require-corp` on every response. `require-corp` is the only
Safari-portable value, so every font, icon and asset is self-hosted and every remote image goes
through one helper that sets `crossorigin="anonymous"`. Third-party iframe embeds cannot run in the
isolated document — measured, YouTube sends CORP `cross-origin` but only `COEP-Report-Only`. Not
GitHub Pages, not bare S3.

---

## 11. Milestones

Each proof is a `scripts/check.py` target, ported from webxp's 11,075-line CDP harness, which drives
real input and reads geometry and text back. Each has a **negative control that breaks the thing the
proof is about** — and `--prove-failure` inverts every invertible assertion so the harness must
report failures, which is what makes a green run mean something.

### M1 — Bounce buffer, preview1 shim, a stock binary. 12 days.

The riskiest assumption is tested first.

**Deliverable.** `kernel.worker.js` with 14 of 68 calls (`open close read write seek fstat stat
lstat readdir mkdir unlink fsync exit clock_gettime`), the `dirfd` amendment in the resolver,
`proc.worker.js` with all 46 preview1 imports, the growable 64 KiB→8 MiB SAB bounce buffer, the
`"not-equal"` fast path. Three stock binaries built from pinned source and recorded by sha256:
`uu_wc`, `uu_cat`, `uu_ls` — `cargo build --release --target wasm32-wasip1`, no patches.

**Proof.** `check.py --only wasi-stock`:
- `wc -l /etc/motd` on a 3-line file returns stdout exactly `3 /etc/motd\n` and status 0.
- Before running, it reads `WebAssembly.Module.imports(mod)` and **fails if any declared import is
  unimplemented** — a missing import is a build-time failure, not a trap at call time.
- p50 over 20,000 `fd_write(1, …)` calls is under 40 µs (14–16 µs measured ABI plus translation
  headroom).

**Negative controls, two.**
1. Flip `fd_prestat_dir_name(3)` to return `"/x"`. The same `wc` run must fail with errno 44
   (`ENOENT`) and non-zero status — not a silent empty read. This proves the preopen is the mechanism.
2. Shrink the bounce buffer to 4 KiB and write 64 KiB. The run must either produce the full correct
   byte count via a looped short write, or fail loudly. **A silently truncated 4 KiB output is a
   check failure** — this is wanix's `// TODO` defect, turned into a check.

### M2 — The path group, the inode VFS, the journal, fsck. 17 days.

**Deliverable.** All 17 path calls with the `dirfd` register and `AT_FDCWD = -100`; `cred` as the
first argument of every resolution; webxp's `vfs.mjs` reworked to bytes with a real fd layer
(`O_APPEND`, `O_TRUNC`, `dup`, `lseek`); OPFS superblock + `j.log` + flat `b/<ino>`; boot-time fsck.

**Proof.** `check.py --only vfs-crash`: a wasm process writes 500 files through real syscalls;
the kernel worker is `terminate()`d at a random journal-record boundary (20 seeds); reboot asserts
(a) no inode points at an absent blob, (b) every write that got an acknowledged `fsync` is present
with the right bytes, (c) boot is under 50 ms at 10k inodes (7.2 ms measured for load alone).

**Negative control.** Corrupt one journal record's crc32: fsck must stop at that record, discard the
tail, and **report the discard count**. Then corrupt the superblock crc: the mount must come up
read-only with a surfaced error. **A silent reseed is a check failure** — that is webxp's current
behaviour, turned into a check.

### M3 — Processes: spawn, waitpid, kill, signals, pipes, poll. 16 days.

**Deliverable.** `SpawnSpec` with `posix_spawn`-shaped file actions (`DUP2`/`CLOSE`/`OPEN`, nothing
inherited, no `O_CLOEXEC`); the process table, exposed as `/proc/<pid>/{cmdline,status,cwd,fd/N,ctl}`;
`waitpid`, `kill`, `sigaction`, `sigprocmask`, the `SIGPEND` word; `pipe2`, `dup2`, kernel-owned pipe
buffers with the EOF/EPIPE rules (a blocked reader whose last writer died gets **0, not an errno**; a
blocked writer whose last reader died gets `-EPIPE` + `SIGPIPE`); the `poll` wait-set; the
`ZOMBIE_TERMINATING` 2.1 s grace; the 1000-process cap; the whole `webos_unix` module and
`libwebos.a`.

**Proof.** `check.py --only proc`:
- A four-stage pipeline of four **stock** binaries, assembled by a 60-line test driver with no shell:
  `uu_cat /etc/words | uu_tr ' ' '\n' | uu_sort | uu_head -2`, asserting exact stdout.
- A stock binary looping on `clock_nanosleep`: `kill -TERM` → the handler ran, status is the signal.
- A compute-only loop with no syscalls: `kill -TERM` does **not** kill it; `SIGKILL` does, within
  2.1 s. The distinction is asserted, not assumed.
- `/proc/<pid>/fd/1` lists the pipe. `cat /proc/<pid>/status` from inside a wasm process works.
- While one process is blocked in `poll` with a 10 s timeout, another completes 1000 syscalls at the
  normal p50 — **the kernel never blocks on behalf of a caller.**

**Negative controls, two.**
1. Remove the `DUP2` action from stage 2's `SpawnSpec`. The pipeline must produce **nothing** and the
   check must fail — proving the pipeline is carried by the fd table, not by an accidental shared
   stdout.
2. Make `kill` cooperative (`postMessage` only, anuraOS's shape). The compute-loop `SIGKILL` test
   must then fail. anuraOS's unkillable process, turned into a check.

### M4 — pty, termios, `poll_oneoff`, `wsh`, and the first real terminal. 19 days.

**Deliverable.** `pty_open`, the xterm-pty line discipline in the kernel, `tty_get`/`tty_set`/
`tty_winsize_*`, `ISIG` → `SIGINT`/`SIGQUIT`/`SIGTSTP` on the foreground pgrp, `SIGWINCH`,
`poll_oneoff` over `poll`, the synthesized `fdstat` table from §4.5; `wsh` in Rust; xterm.js on the
main thread over the DOM relay.

**Proof.** `check.py --only shell` drives real keystrokes through CDP into the xterm canvas and reads
characters back:
- Type `ls /usr/bin | wc -l`; assert the printed number equals the real directory count.
- Type `sleep 30`, then Ctrl-C; assert the prompt returns within 200 ms and `echo $?` prints 130.
- Type `sleep 30 &` then `jobs`; assert one entry, then `fg` and Ctrl-C.
- Resize the window; assert the program observed the new column count.
- `isatty` both ways: `ls` on the pty emits colour escapes; `ls | cat` emits none.

**Negative control.** Clear `ISIG` in the termios struct. Ctrl-C must then **not** interrupt — byte
0x03 reaches the program as data. This proves the line discipline is the mechanism rather than a key
handler in JS. Second control: force `fd_fdstat_get` to report `CHARACTER_DEVICE` for a pipe; the
`ls | cat` colour assertion must then fail.

### M5 — Aero, the WM, and the binary in a window. 21 days.

**Deliverable.** webxp's `window.mjs`/`desktop.mjs`/`dialogs.mjs`/`widgets.mjs`/`contextmenu.mjs`
reskinned to the Aero recipe; the monitor-anchored streak at 0.1 parallax; the blurred-area governor;
redrawn icons; Selawik built from source; a taskbar; a window bound to a PID whose close button sends
`SIGTERM` and escalates to `SIGKILL` after 2 s; `win_create`/`win_set`/`win_poll`/`win_destroy`
through the main-thread relay.

**Proof.** `check.py --only aero`:
- Drag the **bottom** window of a stack so all N re-blur; assert ≥ 110 fps up to 51 M device px.
- At 60 M, assert the governor engaged (the flat-fill class is present on the chrome).
- Click a terminal window's close button; assert `/proc/<pid>/status` shows `SIGTERM` delivered, then
  that the PID is gone.
- The terminal window runs `wc -l` on a real file and the output is read back off the canvas.

**Negative controls, two.** Disable the governor and assert the 60 M case drops below 70 fps (62.2 fps
measured) — so the budget check is known to be able to fail. And webxp's existing control: a drag in
the window **body** must move nothing.

### M6 — `wpk`, the `/usr` overlay, and the userland. 15 days.

**Deliverable.** `wpk.json`, `scripts/pack.py` (containerised cargo/wasi-sdk builds, import-list
verification against the declared tier, blob emission, `usr.index.json` regeneration, `dist/LICENSES`
collection); the `httpimg` read-only driver; the COW overlay with whiteouts; the
`Map<sha256, WebAssembly.Module>` LRU; magic-byte + `#!` exec dispatch. Shipping: uutils coreutils,
ripgrep as `grep`, sqlite3, lua, jq, cmark.

**Proof.** `check.py --only pkg`:
- Every blob's sha256 matches its manifest entry.
- Cold `exec` of a 2 MB binary under 25 ms; warm (Module cache hit) under 10 ms.
- Writing to `/usr/bin/wc` creates an upper-layer copy and leaves the HTTP lower layer byte-identical.
- `rm /usr/bin/wc` then gives `ENOENT` while the lower file still exists — the whiteout works.
- A Tier A package declaring `webos_unix` imports fails the pack.

**Negative controls, two.** Flip one byte of one blob: the integrity check must fail the whole package
rather than running the binary. Remove the whiteout handling: the `rm` test must then show the lower
file reappearing.

### M7 — Honesty pass: Safari, the no-isolation tier, the compiler. 16 days.

**Deliverable.** The full `--prove-failure` sweep green; a Safari 27.2 run with hostfs feature-gated
and the gates **enumerated** so a silently-skipped check is itself a failure; the `sync-message`
SW + synchronous-XHR transport as a second implementation of the same `SyscallChannel` interface
(blocking without a SAB, at HTTP-to-SW latency, 128 KiB cap, one in flight); and the compiler attempt.

**Proof.**
- `check.py --prove-failure` reports every invertible check as failed and names any that did not fire.
- The Safari run passes every check not gated on `showDirectoryPicker`, and the gate list is asserted
  against a checked-in expected set.
- The SW transport passes the entire M1 and M3 suite with `crossOriginIsolated === false`.

**Negative control.** Serve the tree without COOP/COEP (gap-04's `negative.py` already does this):
the SAB transport's preflight must abort with `crossOriginIsolated false`, `SharedArrayBuffer`
absent, and the clock coarsened 5 µs → 100 µs, **while the SW transport still passes** — proving the
two implementations are genuinely independent rather than one code path with a flag.

**Total: 116 days.**

Against the cost anchor: Browsix was 2,249 LoC for a 27-call kernel and 8,126 with all runtime
integrations. This design is ~4,500 LoC kernel (68 calls, journal, pipes, poll wait-set, line
discipline), ~1,200 preview1 shim, ~400 `webos_unix` shim, ~600 C for `libwebos.a`, ~2,000 VFS
(webxp's 1,301 reworked), ~1,800 Rust for `wsh`, ~3,500 WM/Aero (mostly webxp reskinned), ~3,000
new `check.py` — about **17,000 LoC written or substantially changed**. At ~145 LoC/day of finished,
checked code for one developer, that is ~117 days. The two estimates agree, which is the only
evidence either of them is worth anything.

---

## 12. The honest answer

**When does the user see a real binary print to a terminal?**

- **Day 12.** A real stock binary — `uu_wc`, built by `cargo`, pinned by sha256, not patched — prints
  the correct answer. **Not to a terminal.** To a `<pre>` driven by `check.py`, out of a VFS with 14
  syscalls. No process table, no `spawn`, no `waitpid`, no `kill`, no signals, no pipes, no pty, no
  termios, no `poll`, no shell, no window, no WM, no Aero, no journal, no fsck, no mounts, no package
  format. One process, one binary, 14 of 68 calls.

- **Day 64.** A real stock binary prints into a real xterm.js pty behind `wsh`, with Ctrl-C working
  and `ls /usr/bin | wc -l` returning the right number. **Not in a window.** The terminal is a
  full-page xterm. Not built by then: Aero, the window manager, any window at all, the package format
  and `/usr` overlay (binaries are seeded by a script at boot), host mounts, the non-isolated
  fallback tier, any Safari verification, any compiler, any networking, any second user, and the
  entire third-party tier.

- **Day 85.** It is in an Aero window whose close button sends `SIGTERM` and escalates.

- **Day 116.** It came from a package, `/usr` is copy-on-write, it runs in Safari, and the harness
  has proved every check can fail.

**And what the project will never do:** run stock `bash`. Run `make`. Run `git`. Preempt a compute
loop. Sandbox a third-party app while it makes syscalls. Embed YouTube. That is what the bet costs.

---

## 13. Citations

Measured facts of this project, with the harness that produced them:

- Syscall round trip, Worker spawn and kill, worker ceiling, cross-origin iframe cost, Aero area
  budget — [`../research/gap-04.md`](../research/gap-04.md), harness
  `/Users/chafyni/.claude/jobs/e856c39e/tmp/harness/run.py {core|ceiling|frames|aero}`,
  Chrome 157.0.8103.38, macOS 26.7.2, Apple M2 Pro.
- Agent clusters, nested and sibling worker SAB sharing, the 7 iframe configurations —
  [`../research/gap-01.md`](../research/gap-01.md).
- The 68-call table, errno space, `SpawnSpec`, cancellation, the no-fork decision —
  [`../research/gap-03.md`](../research/gap-03.md).
- Browsix, Browsix-Wasm, WebContainer, wanix prior art — [`../research/gap-02.md`](../research/gap-02.md).
- VFS layout, OPFS move/remove portability, Safari 27.2 results, journal vs IndexedDB —
  [`../research/gap-06.md`](../research/gap-06.md), harness `/Users/chafyni/claude/tmp-vfsbench/`.
- Deployability, COEP consequences, threat-model tiers, font and icon licensing —
  [`../research/gap-05.md`](../research/gap-05.md).
- WASI/WASIX/v86/CheerpX survey, xterm-pty, `FileSystemSyncAccessHandle` —
  [`../research/04-browser-linux-runtimes.md`](../research/04-browser-linux-runtimes.md).
- Aero composite recipe — [`../research/06-aero-spec.md`](../research/06-aero-spec.md).

External, pinned:

- WASI preview1 docs — https://github.com/WebAssembly/WASI/blob/v0.2.3/legacy/preview1/docs.md
- WASI proposal phases — https://github.com/WebAssembly/WASI/blob/463701e0f6c575a5d24ae31c2ec1e0ebf09d28e1/docs/Proposals.md
- `browser_wasi_shim` — https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/wasi.ts
- Browsix (ASPLOS '17) — https://arxiv.org/abs/1611.07862 · https://doi.org/10.1145/3037697.3037727
- Browsix-Wasm (ATC '19) — https://arxiv.org/abs/1901.09056
- Browsix fork — https://github.com/plasma-umass/browsix/blob/04f0830088560f27d480cde3e37c28269375f59f/src/kernel/kernel.ts#L1871
- wanix `CallBuffer` — https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/wasi/callbuffer.ts
- wanix `task.go` — https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/task.go
- xterm-pty line discipline — https://github.com/mame/xterm-pty/blob/05ed1ad11003254bdea32e37032402b068fffca5/src/lineDiscipline.ts
- uutils coreutils licence — https://github.com/uutils/coreutils/blob/main/LICENSE
- daedalOS `fs2json` — https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/scripts/fs2json.js
- WASIX API reference — https://wasix.org/docs/api-reference
- `Atomics.wait` — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait
- Growable `SharedArrayBuffer` — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer/grow
- `Worker.terminate` — https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate
- `createSyncAccessHandle` — https://fs.spec.whatwg.org/#api-filesystemfilehandle-createsyncaccesshandle
- `flush()` — https://fs.spec.whatwg.org/#dom-filesystemsyncaccesshandle-flush
- HTML agent clusters — https://html.spec.whatwg.org/multipage/webappapis.html#integration-with-the-javascript-agent-cluster-formalism
- POSIX `posix_spawn` — https://pubs.opengroup.org/onlinepubs/9699919799/functions/posix_spawn.html
- POSIX `write` — https://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html
- POSIX `termios` — https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/termios.h.html
- Selawik — https://github.com/microsoft/Selawik/blob/89362e84731d1f5777fa078fd4d5ebbd339e4378/README.md
- Microsoft permissions — https://www.microsoft.com/en-us/legal/intellectualproperty/permissions

Unsourced and labelled as such:

- **No WASI-hosted `clang` artifact was verified to exist.** `jprendes/emception` is Emscripten-based,
  not WASI. M7 must either produce one or retract the "a real compiler runs in a window" claim.
- **Whether `ninja` has a `posix_spawn` backend usable without `fork`** — not checked. If it does, it
  is the build-tool story; if not, there is none.
- **Whether `Atomics.notify` can interrupt a worker inside a synchronous OPFS call** rather than inside
  `Atomics.wait`. It cannot, by inspection of the two APIs, but gap-03 did not test it. Consequence: a
  `read` against a slow OPFS file is probably **not** interruptible even though the table marks `read`
  as `INTR`-capable. This is the weakest point in the cancellation design and M2 must measure it.
- **Whether `createSyncAccessHandle` behaves identically in a nested worker** — untested (gap-01).
  Irrelevant here only because the kernel is a top-level worker and owns every handle; if that ever
  changes, it becomes load-bearing.
