# Narrowgate: the smallest thing that is defensibly an operating system

> **Superseded in one respect.** This document states that Browsix found `fork` incompatible with a
> blocking syscall channel. That is wrong — Browsix found no way to spill a call stack except
> Emterpreter, and its §6 says SharedArrayBuffers plus a `setcontext` equivalent would have made
> fork a *synchronous* syscall. `fork` was later demonstrated working in Chrome 157 for this
> project. The conclusion (no fork) survives for different reasons: see `../CONSTRAINTS.md`
> constraint 20 and `../research/gap-07-fork.md`. The rest of this document stands as written.

**Angle: risk-first.** The bet is that the kernel boundary is the entire product and
everything else is decoration. A desktop-metaphor website is distinguishable from an
operating system by exactly four observable properties, none of which webxp had:

1. A program has a **pid** that something other than itself can name.
2. A program can be **killed** against its will.
3. Two programs can be **composed** without either knowing about the other (`a | b`).
4. A program's access to the filesystem is **mediated** — it can be refused.

Narrowgate is the minimum machinery that makes all four true, and nothing else. v1 has
no WASM, no Linux, no emulation, no window syscalls, no third-party app tier, and 34
syscalls.

---

## 1. The architecture in one paragraph

One window (main thread) is the **host**: DOM, input, the window manager, and nothing
privileged beyond a single async control port. One dedicated worker is the **kernel**:
it owns the inode table, the fd table, every pipe buffer, every OPFS sync access handle,
the pty line discipline, the process table, and every `SharedArrayBuffer` in the system.
Each **process** is a dedicated worker *spawned by the kernel worker*, handed one 64 KiB
SAB and one `MessagePort` at birth. A process makes a syscall by writing registers into
its SAB, posting a call id, and parking in `Atomics.wait`. The kernel does the work and
replies with `Atomics.store` + `Atomics.notify`. The host is never in the syscall path.

The measurements force almost all of this:

- The kernel cannot be the main thread: with the main thread 60% busy, a main-thread
  kernel stalled 52 of 20 000 syscalls past 10 ms (max 10.23 ms); a worker kernel stalled
  0 past 0.52 ms (`../research/gap-04.md` §1).
- The kernel cannot block on anything a window owns, because a window agent has
  `[[CanBlock]] = false` and `Atomics.wait` throws `TypeError` there
  ([HTML spec, agent formalism](https://html.spec.whatwg.org/multipage/webappapis.html#integration-with-the-javascript-agent-formalism),
  measured in `../research/gap-01.md` §c). The asymmetry — worker blocks, window replies —
  is a platform constraint, not a design choice.
- Blocking is *faster* than async: 14.0 µs vs 17.3 µs mean round trip
  (`../research/gap-04.md` §1). There is no latency argument for an async ABI.
- Processes must be nested workers of the kernel, not siblings minted by the window,
  because a dedicated worker joins the agent cluster of its creator and the cluster is
  the only gate on SAB sharing (`../research/gap-01.md` §a). Spawning from the kernel keeps
  the window out of the spawn path entirely.

### 1.1 Two surfaces, not one

This is the structural decision that lets the syscall table be small.

| Surface | Who uses it | Shape | Contents |
|---|---|---|---|
| **Process ABI** | any program | synchronous, SAB + futex | the 34 calls in §2 |
| **Host control port** | the trusted shell on the main thread | asynchronous `MessagePort` | `boot`, `pty_open`, `winsize_set`, `proc_list`, `kill`, `snapshot`, `wm_event` |

gap-03's table puts `win_create`, `win_set`, `win_destroy`, `win_poll`, `clipboard_*`,
`notify`, and `pty_open` in the process ABI, which forces a main-thread relay hop into
the kernel for DOM work and adds a bespoke `EHOSTGONE` errno. Narrowgate deletes all
nine. Window creation is not a syscall; it is a **write to `/dev/wm`** (§6). The pty is
opened by the host, not by a process. The result is that the kernel has no DOM
dependency at all and can be unit-tested in Node.

---

## 2. The syscall subset: 34 calls

gap-03 specifies 68. Narrowgate v1 ships **34**: 32 drawn from gap-03's table, plus
`chdir` and `getcwd`, which gap-03 omits even though it specifies "absolute or
CWD-relative" paths (`../research/gap-03.md` §path). That is a real hole in the ABI as
written — there is no way for a process to move or report its cwd.

ABI shape is gap-03's, unchanged where it is right: one 64 KiB SAB per process,
`-errno` in a single register using WASI preview1's dense 0–76 numbers
([wasi_defs.ts#L12-L88](https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/wasi_defs.ts#L12-L88)),
error iff `r0 < 0 && r1 == -1`, one inline byte region at offset 128 with
`MAX_INLINE = 65404`, short counts on overflow.

### Process (8)

| call | args | → |
|---|---|---|
| `spawn` | SpawnSpec (JSON, inline region) | pid |
| `waitpid` | a0 pid (−1 = any), a1 flags (WNOHANG) | pid, status in r1 |
| `exit` | a0 code | never returns |
| `kill` | a0 pid or −pgid, a1 sig | 0 |
| `getpid` | — | pid |
| `setpgid` | a0 pid, a1 pgid | 0 |
| `sigaction` | a0 sig, a1 disp ∈ {DFL, IGN, HANDLE} | old disp |
| `sched_yield` | — | 0 (drains SIGPEND) |

### Descriptors (6)

`close(fd)` · `read(fd, n)` → count · `write(fd, bytes)` → count ·
`seek(fd, off, whence)` → newoff · `fstat(fd)` → Filestat · `fsync(fd)`

### Paths (13)

`open(cred, path, flags, mode)` → fd · `stat` · `lstat` · `mkdir(mode)` · `unlink` ·
`rmdir` · `rename(from, to)` · `readdir(fd, cookie)` → packed records ·
`chdir(path)` · `getcwd()` → path · `symlink(target, path)` · `readlink(path)` → len ·
`chmod(path, mode)`

### IPC (1)

`pipe2(flags)` → rfd in r0, wfd in r1

### Host (6)

`clock_gettime(clkid)` → ns · `clock_nanosleep(ns)` → 0 / −EINTR ·
`random(n ≤ 65536)` · `tty_get(fd)` → termios · `tty_set(fd, termios)` ·
`tty_winsize_get(fd)` → rows, cols

### 2.1 What is cut, and what each cut costs

| Cut | Count | What it costs | Why it is affordable |
|---|---|---|---|
| `exec` | 1 | a program cannot replace itself | the shell spawns; nothing else needs it. Shebang dispatch happens inside `spawn` |
| `fork` | — | fork-without-exec | already settled: Browsix declares fork incompatible with a blocking channel and cloned the whole linear heap to get it ([kernel.ts#L1871-L1898](https://github.com/plasma-umass/browsix/blob/04f0830088560f27d480cde3e37c28269375f59f/src/kernel/kernel.ts#L1871-L1898)); a JS worker has no such buffer |
| `getppid`, `getpgid` | 2 | — | `/proc/self/status` carries both. The shell knows the pgids it created |
| `sigprocmask` | 1 | critical sections against signals | **signals are only delivered at syscall entry** (`../research/gap-03.md` §4). A JS region containing no syscall is already atomic w.r.t. signals. The call would be a no-op |
| `poll` | 1 | no program can wait on two fds | the shell does blocking `read(0)` and gets `−EINTR` when SIGCHLD lands, reaps, re-reads — which is how real shells work. **This is the first call to add in v2** |
| `dup`, `dup2`, `fcntl`, `ioctl` | 4 | `exec > file` in the shell; `O_NONBLOCK` | redirection is a spawn file action (`DUP2` in SpawnSpec), which covers every case the shell generates |
| `pread`, `pwrite`, `ftruncate`, `truncate` | 4 | — | `seek`+`read`; `O_TRUNC` |
| `socketpair`, `send`, `recv`, `shutdown` | 4 | datagram IPC | pipes cover v1 |
| `shm_create`, `shm_attach` | 2 | zero-copy bulk | `MAX_INLINE` short counts; a 1 MiB read is 16 syscalls = ~240 µs of channel against 55 µs of OPFS, acceptable |
| `env_get`, `env_set` | 2 | — | envp is handed over in SpawnSpec and lives in the process's own JS. `getenv` is a library call, as in POSIX |
| `link` | 1 | hard links | `nlink > 1` is the one thing that makes fsck's reachability sweep expensive. Directories still carry nlink |
| `chown`, `utimes`, `statfs`, `realpath` | 4 | — | threat model (i) has two uids, both assigned at seed/spawn time. `df` is a shell builtin over `navigator.storage.estimate()` on the host side |
| `mount`, `umount` | 2 | runtime mounts, host directories | the mount table is static, configured at boot. Also makes v1 Safari-identical: `showDirectoryPicker` is undefined there (`../research/gap-06.md` §6) |
| `win_create/set/destroy/poll`, `clipboard_read/write`, `notify` | 7 | a syscall-level window API | replaced by `/dev/wm` at zero new calls (§6) |
| `pty_open` | 1 | a process cannot allocate a pty | the host does, through the control port. A process only ever inherits fd 0/1/2 |
| `tty_winsize_set` | 1 | a process cannot resize its own terminal | the host sets it and the kernel raises SIGWINCH |

That is 38 removals against 68, plus 2 insertions and 2 restored (`lstat` alongside
`stat`): 34.

### 2.2 The three calls that cannot be cut, and why

- **`spawn`.** Without it there is no second process and no property 1, 2 or 3. This is
  the single irreducible call.
- **`pipe2`.** Composition is property 3. Without pipes, programs communicate only
  through the filesystem, which is what webxp already had.
- **`kill` + `sigaction`.** Property 2. `kill` alone is not enough: a process that cannot
  install a SIGINT handler cannot clean up, and the whole point of SIGKILL being
  distinct is that it is the one signal that runs no cleanup.

### 2.3 Signals in v1

`SIGINT 2`, `SIGQUIT 3`, `SIGKILL 9`, `SIGPIPE 13`, `SIGTERM 15`, `SIGCHLD 17`,
`SIGTSTP 20`, `SIGCONT 18`, `SIGWINCH 28`. Nine, not 32.

Delivery: the kernel sets a bit in the SAB's `SIGPEND` word, bumps `SEQ`, notifies, and
drops the late reply by CALLID. The process's syscall stub checks `SIGPEND` on entry and
on `sched_yield`. A parked process cannot service `postMessage` at all
(`../research/gap-01.md` §e), so the reserved control word is the only possible channel —
this is forced, not chosen.

`SIGKILL` is `worker.terminate()`. gap-03 leaves `SIGTSTP` unresolved ("a Worker has no
suspend primitive"). Narrowgate resolves it: a **STOPPED** process is one whose next
syscall the kernel simply declines to answer. The process is already parked in
`Atomics.wait`; the kernel holds the reply until SIGCONT. This is free, and it degrades
exactly like interruption does — a compute loop issuing no syscalls cannot be stopped.
M5 proves both halves.

---

## 3. Data structures

Named concretely, because "a process table" is not a design.

### 3.1 The credential

```js
// Cred — first argument of every kernel path-resolution call. Never read from
// process-controlled memory; the kernel reads it from proc.cred.
{ uid: u16, gid: u16, caps: u32 }
// caps bits: CAP_KILL_ANY = 1<<0, CAP_OVERRIDE_PERM = 1<<1
```

v1 has exactly two identities: **uid 0** (the host, `/sbin/init`, the login shell) and
**uid 1000** (everything the user launches). `/usr` is mode 0755 owned by root, so a
uid-1000 process writing `/usr/bin/ls` gets `−EACCES` from webxp's existing `#may`/`#need`.
Two uids is the minimum that makes the permission check a test that can *fail*; one uid
makes it a check that always passes, which is worse than no check.

Privilege only ever drops: `spawn` may set `cred.uid` to a value ≠ the caller's only if
the caller holds `CAP_OVERRIDE_PERM`. There is no `setuid` call.

### 3.2 The SAB, 64 KiB per process

```
i32[0]  SEQ        the only futex word; only the kernel ever notifies it
i32[1]  STATUS     0 idle, 1 reply-ready, 2 interrupted
i32[2]  RLEN       length of the reply in the inline region
i32[3]  SIGPEND    bitmask, kernel-written
i32[4]  CALLID     monotonic; late replies are dropped by mismatch
i32[5]  UID        kernel-written, read-only: getuid() with no syscall
i32[8..15]  a0..a7 (64-bit args take a lo/hi pair)
i32[16..17] r0, r1
byte 128    [u32 len][bytes]   MAX_INLINE = 65404
```

~0.2% of round trips return `"not-equal"` because the reply beat the park
(`../research/gap-04.md` §1, `../research/gap-01.md` §b). The stub handles that as the fast
path explicitly, not as an error.

### 3.3 The process table

```js
Proc = {
  pid, ppid, pgid,
  cred,                        // §3.1
  state,                       // RUNNING STOPPED ZOMBIE DRAINING
  worker, sab: Int32Array, port,
  fds: Map<int, FileRef>,
  cwdIno: int,
  sigdisp: Uint8Array(32),     // DFL | IGN | HANDLE
  exit: {code, sig} | null,
  waiters: pid[],
  quarantineUntil: ms          // see below
}
```

**Hard cap 128.** The renderer dies between 3200 and 4800 live workers and every process
shares that one renderer (`../research/gap-04.md` §4). gap-04's own recommendation is a
design limit of 1000; v1 picks 128 because a cap you can exhaust in a test is a cap you
can prove. The 129th `spawn` returns `−EAGAIN`.

**pids are never reused.** A monotonic counter. This plus `quarantineUntil` closes the
one race the measurements expose: `terminate()` does not stop a worker promptly — a
spinning worker kept advancing a shared counter for 2004–2051 ms, n=5
(`../research/gap-01.md` §e). So after SIGKILL the pid goes to `DRAINING` for **2 200 ms**
and its SAB is never recycled. A late write from a dead worker lands in memory nobody
reads.

**Fan-out is forbidden.** Round-tripping all live workers costs 378 µs each; 502 ms at
1600 (`../research/gap-04.md` §4). The kernel keeps `pgrps: Map<pgid, Set<pid>>` and
per-pipe `readWaiters` / `writeWaiters` arrays, so every signal and every wakeup is
O(interested).

### 3.4 Descriptors

Offset lives on the open-file description, not the fd, because a spawn `DUP2` action
creates a second fd onto the same description and `cmd1 > f; cmd2 > f` must not rewind.

```js
FileRef = { desc: OpenFile, flags }            // per-fd
OpenFile = { refs, kind, ino, pos, handle }    // kind: FILE PIPE PTYM PTYS DEV DIR PROC WM
Pipe = { buf: Uint8Array(65536), head, tail, readers, writers,
         readWaiters: pid[], writeWaiters: pid[] }
```

Every OPFS sync access handle lives in `OpenFile.handle`, in the kernel, and nowhere
else. This is mandatory: `createSyncAccessHandle` costs 495 µs — 100× a syscall —
and takes an exclusive lock, so a second handle on the same file is refused
([fs spec](https://fs.spec.whatwg.org/#api-filesystemfilehandle-createsyncaccesshandle)).
`open()` must be rare and fd I/O common, which is exactly POSIX's shape. It is also
mandatory because `terminate()` runs no cleanup
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate)): a process
holds integers, never resources.

### 3.5 SpawnSpec

JSON in the inline region, not gap-03's packed binary:

```js
{ path, argv: [], envp: [], cred: {uid, gid}, pgid,
  actions: [ {op:"DUP2", childfd, parentfd}, {op:"CLOSE", childfd},
             {op:"OPEN", childfd, path, flags, mode} ] }
```

Shape from [`posix_spawn_file_actions`](https://pubs.opengroup.org/onlinepubs/9699919799/functions/posix_spawn.html).
Nothing is inherited; `O_CLOEXEC` does not exist. **Deviation from gap-03, declared:** it
specifies a packed `[u32 argc][u32 envc]…` layout. JSON encode/decode is ~1–2 µs against
a 1.86 ms spawn (`../research/gap-04.md` §3) — 0.1%. Packing it is premature optimisation of
the one call that is already three orders of magnitude more expensive than the channel.

### 3.6 Spawn path

The kernel reads the program bytes from the VFS, wraps them in a `Blob`, and constructs
the worker from the blob URL: 1.86 ms p50, versus 3.45 ms from HTTP
(`../research/gap-04.md` §3). The worker's first job is the fixed `libos.mjs` bootstrap,
which installs the 34 sync stubs and then evaluates the program. Budget ~4 ms per spawn —
under half a frame, so the shell's `exec` feels synchronous.

A shebang (`#!/bin/sh`) is read and resolved inside `spawn`, so `spawn` of a script works
without an `exec` call.

---

## 4. The VFS

gap-06's design, trimmed. Authoritative inode table in memory in the kernel worker,
persisted as an alternating OPFS superblock snapshot plus an append-only journal, file
data in a **flat** OPFS directory named by inode.

```
sb.0, sb.1     alternating snapshots
sb.ptr         {generation, slot, journalSeq, crc32}
j.log          append-only; [u32 len][u32 crc32][JSON record]
b/<ino>        file data, flat
t/<ino>        staging
```

Flat is not a preference. Chrome 157 has no `FileSystemDirectoryHandle.move()` and
Safari 27.2 rejects the one-argument rename; `fileHandle.move(dirHandle, name)` is the
only portable primitive (`../research/gap-06.md` §2, measured).

**Ordering per mutation:** write/extend `b/<ino>` → `flush()` → append the journal record
→ `flush()` → apply in memory. Data before metadata: an orphan blob is garbage, a
metadata record pointing at absent data is corruption. Snapshot every 512 records. The
`j.log` and `sb` handles are opened once at boot and never closed — reopening per record
costs 2.5× in Chrome and 12× in Safari (`../research/gap-06.md` §2).

**`fsync` is a separate syscall from `write`.** `flush()` is 260 µs against a 5 µs 4 KiB
write (`../research/gap-04.md` §2). Flushing per write makes the VFS 50× slower for
durability nobody asked for.

**fsck never reseeds.** A superblock failing its crc mounts **read-only and says so**.
webxp's `reset()` reseeds on a bad image, which is correct for a demo and wrong the moment
the data is the user's. The journal is replayed from `journalSeq` and stops at the first
bad crc or truncated length prefix — that is the crash point; the tail is discarded and
*reported*. Blob-orphan collection is an idle task, never boot: 0.60 ms per name in
Safari means 10k names is ~6 s (`../research/gap-06.md` §6).

**The boot lock is free.** The kernel takes the `j.log` sync access handle at boot. A
second tab's kernel gets `NoModificationAllowedError` (Chrome) /
`InvalidStateError` (Safari) and boots read-only with a banner. No arbitration protocol
is needed; the platform's exclusive lock *is* the mutex.

### 4.1 Mount table, v1 (longest prefix wins)

| mount | driver | notes |
|---|---|---|
| `/` | opfs rw | the journalled store above |
| `/usr` | httpimg **ro** | build-time index, daedalOS `fs2json.js` shape `[name, size, mtime, target]` — it already carries the mtime and symlink targets OPFS cannot store ([fs2json.js](https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/scripts/fs2json.js)) |
| `/tmp` | tmpfs | in RAM, lost on reload |
| `/proc` | genfs | synthesized, no stored inodes |
| `/dev` | genfs | `null`, `zero`, `random`, `wm`, `pts/<n>` |

**Cut from gap-06's table:** the `/usr` COW overlay with whiteouts, `hostfs`, and `/sys`.
The overlay is a week of work for the ability to shadow a shipped binary; v1 ships `/usr`
read-only and puts user programs in `/home/user/bin`. `hostfs` is Chromium-only, so
cutting it makes v1 behave identically in Safari.

### 4.2 webxp reuse, with the two changes that touch every method

`/Users/chafyni/claude/webxp/shared/fs/vfs.mjs` (1301 lines) is the layer above the store.
Reusable unchanged: `#lookup` (symlink chasing, `MAX_LINKS=40`), `#may`/`#need`, `FsError`
POSIX codes, `serialize`/`parse` as snapshot writer/loader and half of fsck, `batch`,
`watch`, the nlink recomputation and the reachability sweep.

Two assumptions must change, and they touch everything:

1. **`inode.data` is a JS string.** `readFile`/`writeFile`/`appendFile`/`copyFile`/
   `usedBytes` all measure `.length`. Data becomes bytes in `b/<ino>`.
2. **`this.uid`/`this.gid` is one global identity.** It must become `cred` as the first
   argument (§3.1), or processes cannot have different identities — which would delete
   property 4.

Absent and to be written: the fd layer (`open`/`read`/`write`/`seek`/`dup`, `O_APPEND`,
`O_TRUNC`), and a real mount-crossing branch in `#lookup` (webxp has an ad-hoc
`inode.source`/`mounted` flag on one table).

### 4.3 `/proc` is the demo

wanix models the process table as a filesystem, and it is the only surveyed design where
the host can enumerate and address a process with no bespoke API (`../research/gap-02.md`).
Narrowgate copies it: `/proc/<pid>/{status,cmdline,cwd,fd/<n>}` and `/proc/self`.

This costs ~120 lines of genfs and buys three things: `ps` is a shell script over
`readdir`, the CDP harness can assert on kernel state by reading files instead of calling
into internals, and the clearest possible demonstration that a process is a first-class
object. `cat /proc/7/status` is the whole thesis in one command.

---

## 5. Shell and the pty

`/bin/sh` is webxp's `apps/terminal/shell.mjs` (453 lines: `tokenize`, `parse`,
`expandTilde`, `complete`) with the executor rewritten. In webxp the executor called into
`commands.mjs` — 1488 lines of builtins in the same realm as the window. In Narrowgate
those become separate files in `/usr/bin`, each a process: `ls`, `cat`, `echo`, `wc`,
`head`, `grep`, `sleep`, `kill`, `ps`, `true`, `false`.

A pipeline is `pipe2` + two `spawn`s with `DUP2(1←wfd)` / `DUP2(0←rfd)` actions. `$(…)`
is `pipe2` + `spawn` + `read`. Background jobs are `setpgid` + `waitpid(WNOHANG)`. A
`( subshell )` is *not* a process — the shell snapshots its own variable table in-process,
which is the documented cost of having no `fork` (`../research/gap-03.md` §5).

**The line discipline lives in the kernel.** `pty_open` (host control port) returns a
master/slave pair. The host's terminal widget is a DOM surface bound to the master: it
posts keystrokes in and renders bytes out. ICANON, ECHO, ISIG and
VINTR/VQUIT/VSUSP are implemented in the kernel
([termios](https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/termios.h.html)),
so Ctrl-C becomes SIGINT on the foreground pgrp **even if the terminal UI is wedged**.
That is a property no same-realm web terminal can have, and it is directly testable.

`SIGWINCH` is raised when the host sets the winsize through the control port.

---

## 6. Windows without window syscalls

A GUI process opens `/dev/wm` and speaks NDJSON over the fd:

```
→ {"op":"create","w":640,"h":440,"title":"Notepad"}
← {"win":3}
→ {"op":"paint","win":3,"html":"…"} | {"op":"set","win":3,"title":"…"}
← {"ev":"key","win":3,"key":"a"} | {"ev":"close","win":3}
```

The kernel routes those bytes to the host control port as `wm_event` messages. `read()`
on `/dev/wm` blocks exactly like a pipe, using machinery that already exists.

This is worth the trade for three reasons. It adds **zero syscalls**. The window is owned
by an fd in the *kernel's* table, so when a process is SIGKILLed the kernel closes the fd
on reap and the host tears the window down — no `EHOSTGONE` errno, no `win_poll`, and the
"no releasable resource in a process worker" invariant holds without a special case. And
it makes the window a *file*, consistent with `/proc`, which keeps one idea where gap-03
had two.

What it gives up: no widget toolkit, no fast path for pixels, and a canvas-heavy app will
want real bitmap transport in v2 (the natural answer is `shm_create`, which is already
cut for v1).

---

## 7. Aero: the cheap tier, with an accountant

DOM + `backdrop-filter: blur(9px)` + a `mix-blend-mode: plus-lighter` tint layer + a
`position: fixed` highlight bitmap anchored to the monitor and parallaxed at 0.1.
Fidelity option (1) from `../research/06-aero-spec.md`. No Element Capture — its
`restrictTo()` demands the target be a backdrop root, and a backdrop root is exactly what
stops `backdrop-filter` from seeing the desktop behind it. Taskbar peek is a static icon.

The budget is measured: **58–63 M blurred device px per frame**, past which the frame rate
halves exactly, and the predictor is *area*, not layer count — 60 windows at 35 M is free,
30 at 63 M is not (`../research/gap-04.md` §6). So the WM carries a **blur-area accountant**:
sum of each glass element's `getBoundingClientRect()` area × dpr², capped at **55 M**.
A drag that would cross the cap swaps the dragged window's backdrop for a flat fill for
the duration of the gesture.

Two constraints that will otherwise silently break the glass: any ancestor with
`opacity < 1`, a `filter`, a `mask`, a `clip-path` or a `mix-blend-mode` becomes a
backdrop root and cuts the chain
([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter)) — so the usual
"fade the window wrapper on open" kills glass for every descendant; fade an inner child
instead. And Segoe UI is not redistributable while Selawik's own README lists missing
kerning as open, so **metric compatibility must not be assumed**: every layout gets
measured, not transplanted, and the Win7 icons and glass bitmaps are redrawn.

---

## 8. Threat model: (i) first-party only

Enforcement is the worker boundary plus the syscall ABI, plus the two-uid credential
inside it. There is no third-party app tier.

This is forced as much as chosen. A SAB is restricted to one agent cluster, and a
cross-origin iframe — even one that is `crossOriginIsolated` via
`allow="cross-origin-isolated"` plus its own COEP header — is a *different* cluster: a
SAB sent from the top page arrives as `messageerror`, measured across 7 configurations
(`../research/gap-01.md` §d). **Per-app-origin isolation and a shared blocking syscall
channel are mutually exclusive.** A per-origin app needs its own SAB and a broker worker
doing an async hop — two hops — and still cannot be stopped from burning CPU or spamming
the kernel. Model (ii) buys origin-level storage separation and nothing else, for the
price of a domain, wildcard DNS, a wildcard cert, and a second transport.

The ABI stays origin-agnostic (`postMessage`-shaped, no shared globals) so (ii) is a
deployment change later rather than a rewrite.

**Deployment, decided:** `COOP: same-origin` + `COEP: require-corp` — `require-corp` is
the only Safari-portable value. Host must be Cloudflare Pages, Netlify, Vercel, Firebase,
CloudFront or nginx; **not GitHub Pages, not bare S3** (`../research/gap-05.md` §A1).
Consequence: self-host every font, icon and asset, `crossorigin="anonymous"` on every
remote image, and **no third-party iframe embeds at all** — YouTube sends CORP
cross-origin but only `COEP-Report-Only`, so it is blocked (measured, `../research/gap-05.md`
§A2). No YouTube app, no maps app, no OAuth widget. That is a real product cut and it is
cheaper to accept than to work around.

---

## 9. Milestones

Order is risk-first: the riskiest assumption is milestone 1. Every proof is a script added
to one harness that grows from day 1; M7 is specifically the port of webxp's
input-driving CDP harness.

| # | Milestone | d | cum | Proof | Negative control |
|---|---|---|---|---|---|
| 1 | Contended syscall channel. Kernel worker, N nested process workers, SAB ABI, 3 calls (`getpid`, `clock_gettime`, `nop_stall(µs)`) | 2 | 2 | N ∈ {1,4,16,64} at fixed offered rate, 20 000 calls each, with a 500 µs kernel-side sync stall on 1-in-50. Accept p99 < 2 ms at N=16 | Set the injected stall to 20 ms; the harness MUST report p99 > 20 ms. Plus serve without COOP/COEP and assert preflight aborts with `crossOriginIsolated === false` |
| 2 | Process lifecycle, signals, SIGKILL, cap | 3 | 5 | A `for(;;){}` process ignores SIGTERM (shared counter keeps advancing 500 ms), dies on SIGKILL (counter flat 500 ms, `waitpid` → signalled 9). A `sched_yield` loop dies on SIGTERM < 5 ms. 129th spawn → `−EAGAIN`, kernel still answers `getpid` | Remove the SIGPEND check from the stub's syscall entry: the SIGTERM-on-yield test must fail. And assert the counter test fails when pointed at a *live* process |
| 3 | VFS core in RAM: ported `vfs.mjs` (bytes + cred), fd layer, `/usr` httpimg, `/tmp`, `/proc`, `/dev` | 4 | 9 | 34-call conformance suite; `cat /proc/<pid>/status` matches the kernel's own table for ppid/pgid/state; uid 1000 `open("/usr/bin/ls", O_WRONLY)` → `−EACCES`, uid 0 → fd | Re-run the EACCES case as uid 0 and assert it succeeds — proving the test exercises the credential, not a missing file |
| 4 | **`pipe2` + spawn file actions + `/bin/sh` + 7 programs.** stdio to a dumb host console | 5 | **14** | `ls /usr/bin \| wc -l` prints the number a kernel-side readdir independently counts; three distinct pids appear in `/proc` during the run; `yes \| head -1` makes `yes` die of EPIPE and the pipeline exits 0 | Point the readdir comparison at a different directory: the `wc -l` test must fail. And run the pipeline with the `DUP2` actions omitted and assert stage 2 reads EOF immediately |
| 5 | pty + kernel line discipline + Ctrl-C + job control + the Terminal window | 4 | 18 | `sleep 30`, Ctrl-C → prompt within 50 ms, `waitpid` reports SIGINT. `sleep 30 &` then `fg`. Ctrl-Z stops a yielding process (`/proc` state T), `fg` resumes it | Clear ISIG in the pty termios: Ctrl-C must stop killing and the test must fail. Also wedge the terminal widget with a 3 s main-thread stall and assert Ctrl-C *still* kills — proving the discipline is kernel-side |
| 6 | OPFS persistence: journal, superblock, fsck, read-only-on-corrupt | 4 | 22 | Write 200 files as uid 1000, reload, compare size+mode+mtime+content hash on all 200. Truncate `j.log` mid-record with a raw sync handle; reboot must replay to the last good record and *report* the discarded tail | Corrupt the superblock crc and assert the boot mounts READ-ONLY and surfaces it; run webxp's reseed-on-bad-image behaviour and assert this check catches it |
| 7 | Port `scripts/check.py` + `cdp.py`: real keystrokes, geometry read back, `--prove-failure` | 4 | 26 | `check.py --all` green; `check.py --prove-failure` reports exactly `len(INVERTIBLE)` failures | Serve an empty directory and assert the boot check *errors* rather than passing — a harness that reports clean against a stale tree is the worst available outcome |
| 8 | Aero cheap tier, WM, taskbar, blur-area accountant | 7 | 33 | rAF cadence ≥ 110 fps with 8 glass terminals at 640×440; the accountant's figure matches a recomputation from `getBoundingClientRect` × dpr² within 2% | Raise the cap to 90 M, open 30 full-screen glass windows, assert the fps check FAILS (measured 61.7 fps at 70 M) |
| 9 | `/dev/wm` + one GUI process (notepad, uid 1000) | 5 | 38 | `kill -9` the notepad from the shell: the DOM window node is gone within 2.3 s, the window count drops by exactly 1, the kernel's fd table shows the `/dev/wm` fd closed, `/proc/<pid>` is gone | SIGKILL a process holding no `/dev/wm` fd and assert the window count is unchanged — so the test is about *this* process's window, not about any teardown |

**Total: 38 days.**

### 9.1 LoC sanity check against the anchor

Browsix: 2,249 LoC for a 27-call kernel, 8,126 with all runtime integrations
(`../research/gap-02.md`).

| component | new or edited |
|---|---|
| kernel (34 calls, proc table, pipes, pty discipline, signals) | ~2,800 |
| VFS (webxp 1301 ported + fd layer + journal + fsck + genfs) | ~2,200 |
| `libos.mjs` stubs | ~400 |
| `/usr/bin` programs | ~1,200 |
| `/bin/sh` executor rewrite | ~700 |
| host: control port, WM reskin from `window.mjs` 836 + desktop | ~1,600 |
| harness additions over the ported 11,075 | ~2,000 |
| **total** | **~10,900** |

~287 LoC/day of new-or-edited code over 38 days, against a 34-call kernel versus
Browsix's 27-at-2,249. The ratio holds. The number is credible only because of the reuse
in §9.2; without it, add two weeks.

---

## 10. Day 14

At the end of M4 the user can do four things that webxp could not do at all, because
webxp had no process:

1. **`ls /usr/bin | wc -l`** — two programs, two pids, neither aware of the other,
   composed by the kernel.
2. **`ps`** and **`cat /proc/7/status`** — the process table is enumerable and
   addressable from the shell.
3. **`kill -9 7`** — a runaway program dies against its will, with no cooperation. anuraOS
   cannot do this: its kill postMessages `{type:'kill'}` into the process iframe and waits
   for a reply, so a process that ignores the message is unkillable
   ([Processes.tsx#L280-L296](https://github.com/MercuryWorkshop/anuraOS/blob/cc18239e5bf78e580265f09180cd079f9bc92f20/src/api/Processes.tsx#L280-L296)).
4. **A refusal.** A program running as uid 1000 gets `−EACCES` writing `/usr/bin`. webxp
   had one global uid and apps imported `shared/fs/fs.mjs` directly, so there was nothing
   to refuse and nobody to refuse it to.

webxp's failure mode is the exact inverse of all four: apps were ES modules that imported
the filesystem directly, and each app *was* its window under a `mount(root)` contract.
Nothing was isolated, killable, or backgroundable. Day 14 is the day that is no longer
true.

---

## 11. Honesty: facts I depend on that are not yet measured

Nothing here requires a measured fact to be false. Five things it requires are *unmeasured*:

1. **Syscall latency under contention.** gap-04's 14 µs is one caller against an idle
   kernel. A single-threaded kernel worker serializes every syscall, and a 495 µs OPFS
   `open` or a 260 µs `flush` is head-of-line blocking for every other process. This is
   the riskiest assumption in the design and M1 exists to price it in two days.
2. **The kernel minting a SAB for a nested worker it spawned.** gap-01 measured the
   sibling case and measured a nested worker as `crossOriginIsolated: true` in the same
   cluster. Kernel-mints-SAB-for-nested-child follows from the cluster algorithm but was
   not run. M1 confirms it in the first hour; if it fails, processes become siblings minted
   by the window and the window re-enters the spawn path (3.45 ms, and a `postMessage`
   relay per spawn).
3. **Whether an OPFS journal append + `flush()` is durable across a kill.** gap-06 flags
   this explicitly: the spec says "attempt to transfer", with an explicit no-op case
   ([fs spec](https://fs.spec.whatwg.org/#dom-filesystemsyncaccesshandle-flush)), and no
   power-loss experiment was run. M6's torn-tail test exercises a *truncated* journal, not
   a *lost acknowledged* record. The measurement needed: write N records with flush,
   SIGKILL the tab via CDP `Browser.crash`, reboot, and count how many acknowledged
   records survived. If the answer is < N, `fsync` is a lie and the commit protocol needs
   a second write.
4. **The 2 s abort grace.** n=5, Chrome only (`../research/gap-01.md` §e). Safari and Firefox
   unmeasured. The 2 200 ms quarantine is derived from those five samples plus 10%.
5. **The blur budget on other GPUs.** One machine, one 120 Hz panel, dpr 2. A 60 Hz panel
   has twice the per-frame budget; an integrated GPU far less. M8's accountant makes the
   cap a constant, so a bad result is a config change rather than a redesign.

Two places where I deviate from gap-03 deliberately, restated so the synthesis can argue:
SpawnSpec is JSON rather than packed (§3.5), and the entire `win_*`/`clipboard_*`/`notify`
group is replaced by a device file (§6). Two places where gap-03 is incomplete: no
`chdir`/`getcwd` despite specifying CWD-relative paths, and `SIGTSTP` left unresolved —
§2.3 resolves it as a kernel-side withheld reply.

---

## 12. Kill criteria

Abandon or redesign if:

- **M1:** p99 syscall latency at 16 concurrent processes with the 500 µs injector exceeds
  5 ms, or mean exceeds 140 µs (10× the single-caller figure). The single-threaded kernel
  worker is then wrong, and the alternative is a sharded kernel or an async fd layer — a
  different architecture, not a tuning pass.
- **M1:** resident cost per idle process exceeds 1.5 MiB, making a 128-process cap cost
  > 190 MiB.
- **M2:** `terminate()` fails to stop a spinning worker on any target browser, or the abort
  grace exceeds 5 s. "Killable" is then false and property 2 cannot ship as designed; the
  fallback is cooperative kill plus an honest UI, which is anuraOS's position and much
  weaker.
- **M2:** pid-never-reuse plus the 2 200 ms SAB quarantine does not prevent a dead worker's
  late write from being observed. The channel design is then unsound.
- **M3:** porting `vfs.mjs` to bytes + cred touches more than ~60% of its 1301 lines. It is
  a rewrite in disguise; either budget the rewrite or drop symlinks and mode bits, which
  costs property 4.
- **M4:** a plain-JS program cannot be written against a blocking stub without a build step
  (top-level await, bundler, or module-resolution constraints force async). Every
  `/usr/bin` program becomes a compilation target and the "JS in a worker" runtime premise
  needs replacing.
- **M6:** acknowledged journal records are lost across a crash (§11.3). `fsync` cannot be
  implemented over OPFS as designed.
- **M8:** the blur budget on a mid-range integrated GPU falls below ~15 M device px — four
  windows. The cheap tier cannot be the default and Aero becomes opt-in.

---

## 13. What this gives up

- **No WASM, no Linux, no emulation, no native binaries.** Programs are JS. Full-system
  emulators give a real Linux kernel but as a black box behind a serial cable — the host
  JS cannot see guest processes or route a window to a guest pid (`../research/gap-02.md`), so
  running real Linux does not buy a kernel boundary. It is not a v1 cut that costs the
  thesis anything.
- **No GUI apps until day 38**, and then only through a line protocol on an fd with no
  widget toolkit and no bitmap transport.
- **No `fork`, no `exec`, no `poll`, no `dup`/`dup2`, no sockets, no shm, no mmap.** No
  `exec > file` in the shell. No program can wait on two descriptors.
- **No third-party or untrusted code tier.** An app can burn CPU and spam the kernel.
- **No preemption.** A compute loop is killable but neither interruptible nor stoppable,
  and the WM must *show* that distinction rather than pretend.
- **No host-directory mounts, no `/usr` COW overlay, no hard links, no `chown`, no
  `utimes`, no runtime `mount`, no `df` from inside the kernel** (`persist()` is
  Window-only — the shell asks for durability, not the kernel).
- **No third-party iframe embeds, ever, under `require-corp`.** No YouTube, maps or OAuth
  app.
- **One kernel per tab, no arbitration.** The second tab boots read-only.
- **No live window thumbnails.** Element Capture's backdrop-root requirement is
  incompatible with the glass on the same node.
- **No Segoe UI and no metric-compatible substitute**, so every layout must be measured
  rather than transplanted from screenshots.
- **~550 syscalls per 8.3 ms frame**, of which one OPFS `open` consumes 35.

---

## 14. Reuse from webxp

- `/Users/chafyni/claude/webxp/scripts/check.py` (11,075 lines) and `scripts/cdp.py` —
  CDP checks driving real input and reading geometry back, plus `--prove-failure`, which
  inverts every assertion in `INVERTIBLE` and requires the harness to report failures, and
  the existing negative control (a drag in the window body must move nothing). The most
  valuable artifact in the predecessor; ports almost unchanged.
- `/Users/chafyni/claude/webxp/shared/fs/vfs.mjs` — `#lookup` with `MAX_LINKS=40`,
  `#may`/`#need`, `FsError` POSIX codes, `serialize`/`parse` as snapshot + half of fsck,
  the nlink recomputation and reachability sweep.
- `/Users/chafyni/claude/webxp/apps/terminal/shell.mjs` — `tokenize`, `parse`,
  `expandTilde`, `complete` (453 lines) and `glob.mjs` (160).
- `/Users/chafyni/claude/webxp/apps/terminal/commands.mjs` — 1488 lines of builtin bodies,
  harvested into separate `/usr/bin` programs.
- `/Users/chafyni/claude/webxp/src/window.mjs` (836) — 8-edge resize, drag, minimise,
  maximise, focus; reskinned from XP Luna to Aero.
- `/Users/chafyni/claude/webxp/src/{dialogs,widgets,contextmenu}.mjs` (1155 / 1162 / 590).
- `/Users/chafyni/claude/webxp/docs/review.md` — 571 lines of second-agent findings,
  including the case where the fix for finding 1 re-introduced the same defect one call
  later. Read before M7; that pattern is the reason every milestone here carries a
  negative control rather than only a proof.
