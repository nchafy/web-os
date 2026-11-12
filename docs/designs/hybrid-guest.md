# NINEGATE — real Linux as a citizen, not a black box

> **Superseded in one respect.** This document states that Browsix found `fork` incompatible with a
> blocking syscall channel. That is wrong — Browsix found no way to spill a call stack except
> Emterpreter, and its §6 says SharedArrayBuffers plus a `setcontext` equivalent would have made
> fork a *synchronous* syscall. `fork` was later demonstrated working in Chrome 157 for this
> project. The conclusion (no fork) survives for different reasons: see `../CONSTRAINTS.md`
> constraint 20 and `../research/gap-07-fork.md`. The rest of this document stands as written.

**One liner.** Write the host kernel the measured facts already force, then admit a real
Linux guest as one typed row in its process table, joined to the host by a 9P2000.L server
that the host kernel implements over its own VFS — so both see one tree, and guest commands
become host processes with host PIDs and host windows.

---

## 1. Thesis, and the position I am committing to

The host-kernel-versus-real-Linux framing is a false dichotomy, but only in one direction.

Running real Linux does not buy a kernel boundary. That is settled: every full-system
emulator is a black box behind a serial cable, and the research says so in its summary
([04-browser-linux-runtimes.md](../research/04-browser-linux-runtimes.md), VERDICT ROW on v86).
But the converse is not true. **A kernel boundary makes real Linux a citizen** — because the
one thing a host kernel owns that an emulator needs is a filesystem, and v86 hands you the
hook to supply it:

```js
new V86({ filesystem: { handle9p: async (reqBuf, reply) => { /* host JS is the 9p server */ } } })
```

That hook is the whole attack on the objection. It is documented
([v86 docs/filesystem.md @315b2b0](https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/docs/filesystem.md)),
and it means the guest's root filesystem is *my in-memory inode table*. Not a copy of it. Not
an import/export hatch. The same table, serviced per-request.

Three claims follow, and they are the design:

1. **The guest's `ls -l` is correct because the host owns the metadata.** OPFS has no mode
   bits, no uid/gid, no symlinks and no settable mtime
   ([gap-06](../research/gap-06.md); [fs.spec.whatwg.org](https://fs.spec.whatwg.org/#api-filesystemfilehandle-getfile)).
   My kernel stores all four in RAM and journals them, because webxp's VFS already does
   ([webxp/shared/fs/vfs.mjs](/Users/chafyni/claude/webxp/shared/fs/vfs.mjs), 1,301 lines:
   inodes, symlinks, hard links, mode bits). A 9p `Tgetattr` reply carries exactly
   `mode, uid, gid, nlink, size, atime, mtime, ctime` — fields the browser cannot store and
   the host kernel can. In a pure-emulator design the guest owns an ext2 image and the host
   sees nothing. Here the host is authoritative and the guest is a reader.
2. **Writing the 9p server forces the refactor the host design needs anyway.** gap-06's own
   design consequence is that `this.uid`/`this.gid` must stop being instance state and become
   a per-call credential, "or processes cannot have different identities". A 9p server has
   N concurrent fids with different identities by construction. The guest requirement and the
   correct host design coincide; that is not a coincidence I am exploiting, it is the reason I
   believe the hybrid is cheap.
3. **The guest is the only tier in v1 that holds against a hostile binary.** Threat model (i)
   — first-party only — has no boundary against untrusted code; gap-05 says per-app origins
   and the blocking channel are mutually exclusive. But a wasm module's reach is its imports,
   and v86's imports are my 9p handler, a canvas, and a serial port. That is a narrower
   surface than an iframe. The compatibility story and the sandbox story are the same story.

**What the other angles believe that I do not.** A pure-host-kernel design believes the
emulator is dead weight, and pays for that belief by owning `grep`, `sed`, `awk`, `find`,
`gcc`, `git`, `vim`, `fork`, `mmap`, `ptrace`, named pipes and working `SIGTSTP` forever. A
pure-emulator design believes Linux is the OS, and pays by having no process table, no
killable windows and no host-visible anything. I believe the host kernel is non-negotiable
(the measurements leave no choice) and the guest is a 1,500-LoC addition *if and only if*
three hooks are designed in on day one. Retrofitted, it is a rewrite of every VFS method.

**And the honest answer to the question I was set.** Delete the guest and the OS still boots,
still has processes, windows, a shell and a VFS. By that test the guest is *a very good app*.
But the kernel is not the same kernel if it was never meant to host one. So:

> **The guest is a very good app that only works if the kernel was designed for it. Build the
> three hooks first; ship the guest sixth.**

The three hooks, named, because "designed for it" is not a design:

| Hook | What it is concretely | Retrofit cost if skipped |
|---|---|---|
| **Credential as an argument** | `Cred {uid: u16, gid: u16, caps: u32}` is the first parameter of every VFS path-resolution and permission call. Never instance state. | Every method of a 1,301-line VFS, plus every call site. |
| **Driver-shaped process table** | A process row holds a `kind` and a `driver`, not an implicit `Worker`. `kill`/`signal`/`reap` are driver methods. | The process table, `/proc` genfs, `ps`, the taskbar, and `waitpid`. |
| **Byte-ranged, fid-shaped VFS core** | `lookup(cred, parentIno, name)` returns one component; `pread/pwrite(cred, ino, off, len)` are the only data primitives. No whole-file string reads. | The VFS core, and the OPFS blob layer underneath it. |

Each of those is also independently justified by the host design (per-process identity;
heterogeneous process kinds for a future wasm driver; OPFS `createSyncAccessHandle` being
495 µs so I/O must be fd- and offset-based). So the hybrid costs nothing in architecture and
~1,500 LoC in implementation. That is the bet.

---

## 2. Attacking the black-box objection properly

The objection is: *an emulator is a black box behind a serial cable — the host cannot see
guest processes or route a window to a guest PID.* Taken literally it is true of a stock v86
embed. Taken as a claim about what is *plumbable*, it is wrong in two places and right in one.
I will take the three in order and label each.

### 2.1 Shared filesystem — REAL ENGINEERING

`handle9p` is a documented, first-class hook. The host JS implements 9P2000.L (the dialect
Linux's `v9fs` speaks with `version=9p2000.L`) and the guest mounts it over virtio.

- The fid table is a second fd table over the same inode numbers. `Map<u32 fid,
  {ino, cred, off, iounit, qidvers}>`.
- `Twalk` is webxp's `#lookup` with a credential argument — symlink chasing, `MAX_LINKS=40`,
  dangling-final-link create semantics, all already written.
- `Tgetattr`/`Tsetattr` map onto the inode table 1:1, including the fields OPFS lacks.
- `Tread`/`Twrite` map onto the kernel's descriptor table of OPFS sync access handles, which
  must be held open for the kernel's lifetime anyway (`createSyncAccessHandle` is 495 µs, 100×
  a syscall; gap-04 table 2).
- `msize` is negotiated at `Tversion`. Set **131072**, so max data per `Tread`/`Twrite` is
  `131072 − IOHDRSZ(24) = 131048` bytes. Overflow is a **short count**, which is POSIX-legal
  ([write(3p)](https://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html)) and is
  the same rule gap-03 already adopted for `MAX_INLINE`. This is deliberate: wanix's
  `CallBuffer` silently truncates replies over 16,360 bytes with an unhandled `// TODO`
  ([callbuffer.ts](https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/wasi/callbuffer.ts)),
  and silent truncation of a filesystem read is the worst defect class available here.

**The documented price, which I accept explicitly.** v86's own docs state that with
`handle9p`: the filesystem "will not be cached (unless cached in the guest OS)",
`create_file`/`read_file` "will not be available", and "you will be responsible for keeping
its state in sync with any machine save states"
([docs/filesystem.md @315b2b0](https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/docs/filesystem.md)).
I lose convenient host file I/O (I do not need it — I have the VFS), and I own
snapshot/filesystem consistency (§6).

**Precedent.** daedalOS already proves one index can serve host and guest: `useV86` hands the
guest `filesystem = { basefs: blob(JSON.stringify(fs9pV4ToV3())), baseurl: origin }` — the
same build-time 9p index that backs the host VFS
([useV86.ts @ed9c7a5](https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/components/apps/V86/useV86.ts)).
daedalOS does it **read-only and statically**: a baked JSON tree, no live server. I take the
idea and make it dynamic and writable, which is the whole difference between a shared image
and a shared filesystem.

**I keep daedalOS's build-time index too**, for a different job: a copy-on-write `/usr`. The
`fs2json.js` v4 format is `[name, size, mtime, target]` where `target` is a symlink string or
a child array
([fs2json.js @ed9c7a5](https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/scripts/fs2json.js))
— it already carries the mtime and symlink targets OPFS cannot store, which is exactly why it
is the right lower layer for an overlay mount (`/usr` = overlay{lower: httpimg ro, upper:
`opfs:/.rw/usr`}, per gap-06 §5).

**Unverified, and it gates M0.** I am naming the 9P2000.L message subset from memory, not from
a source I read in this pass: Tversion, Tattach, Twalk, Tlopen, Tlcreate, Tread, Twrite,
Tclunk, Tremove, Tgetattr, Tsetattr, Treaddir, Tfsync, Tsymlink, Tlink, Tmkdir, Trenameat,
Tunlinkat, Tstatfs, Treadlink, Tmknod, Tlock, Tgetlock, Txattrwalk, Tflush — roughly 24
message types. **The authoritative list must be read out of v86's own 9p implementation at the
pinned sha before a line of M0 is written**, and the set Linux actually issues for a plain
`-o trans=virtio,version=9p2000.L,cache=none` mount must be observed, not assumed. If Linux
insists on something outside the subset for a plain mount, that is a kill criterion, not a
surprise.

### 2.2 Guest process list into host `/proc` — REAL ENGINEERING, WITH A HONEST ASTERISK

Yes. And the right transport is **not** virtio/serial — it is the 9p mount I already have.

A ~250-line statically-linked C agent, `guestd`, lives in the base image (Buildroot ships the
toolchain; ~40 KB stripped). It is `init`'s first child. It does five things:

1. Mounts the host: `mount -t 9p -o trans=virtio,version=9p2000.L,msize=131072,cache=none
   host /mnt/host`.
2. Opens `/mnt/host/.ctl/req` and `read()`s it. **The host 9p server parks that `Tread` until
   it has a command.** No polling. 9p has no protocol-level timeout; the server replies when
   it chooses.
3. Executes: `SPAWN <ptyid> <cwd> <argv…>`, `KILL <gpid> <sig>`, `PSPOLL`,
   `WINCH <gpid> <rows> <cols>`. Tab-separated, newline-framed, sequence-numbered.
4. Replies by writing `<seq> OK <gpid>` or `<seq> ERR <errno>` to `/mnt/host/.ctl/resp`.
5. Writes a monotonic generation counter to `/mnt/host/.ctl/gen` at 1 Hz, and on `PSPOLL`
   walks `/proc/[0-9]*/{stat,cmdline}` and writes the table to `/mnt/host/.ctl/procs`.

The host kernel parses those writes **inside its own `Twrite` handler** — the bytes never
leave the kernel worker — and projects them into genfs at `/proc/guest/<gpid>/{stat,cmdline,ctl}`.
`echo 9 > /proc/guest/431/ctl` becomes a `KILL` command on the parked `req` fid.

**The honest asterisk, stated plainly.** This is a **federated, proxied view**, not ownership.

- Enumeration latency is one `PSPOLL` round trip plus the agent's `/proc` walk at 20× native:
  budget ~200–600 ms, so `/proc/guest` is eventually consistent, not live.
- The host does **not** own guest process lifetimes. `guestd` does. If `guestd` dies, the view
  freezes.
- Therefore: the `gen` counter is load-bearing. If `gen` has not advanced in 3 s, the kernel
  marks the whole `/proc/guest` subtree **stale** — `ls` shows it, and `kill` on a guest pid
  returns **`EHOSTGONE` (100)**, the errno gap-03 already reserved for "the object behind this
  fd is gone". A control call that silently succeeds against a dead agent is the defect this
  prevents, and M4's negative control is exactly that scenario.

**The riskiest assumption in the whole design lives here**, and it is not the agent. It is step
2: *can a host-implemented 9p server park a `Tread` indefinitely and have Linux's v9fs client
tolerate it?* I need: no client-side timeout, no `-EIO`, the blocked task interruptible by a
signal, and `umount` still possible afterwards. I have no measurement of this. It is milestone
zero, and §7 prices both fallbacks.

### 2.3 Guest X/Wayland client to a host window — FANTASY at this budget

I was asked to be rigorous about which parts are hand-waving. This is the hand-waving part,
and here is why, constructively.

To make one guest GUI client become one host window you need all three of:

1. **A transport.** The client connects to `unix:/tmp/.X11-unix/X0`. 9p cannot carry a socket.
   v86 offers virtio-9p, virtio-net and serial — there is no virtio-vsock. So you need a
   guest-side socket proxy forwarding to either (a) the serial line, measured at **10–13 ms
   per round trip** and shared with the console
   ([04-browser-linux-runtimes.md](../research/04-browser-linux-runtimes.md), measured v86
   section), or (b) virtio-net, which "always needs an out-of-tab relay" — every documented
   backend (`inbrowser`, `wsproxy`, `wisp`, `fetch`) needs a proxy you run
   ([v86 docs/networking.md @315b2b0](https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/docs/networking.md)).
   For a protocol that does a synchronous round trip per `XGetGeometry`, 10–13 ms is fatal.
2. **An X11 server in JavaScript.** The core protocol is ~120 requests before any extension.
   Nobody has shipped a complete one in JS. It is larger, on its own, than the entire 68-call
   syscall table this project is built around.
3. **Drawing that lands somewhere.** Core X11 (`PolyFillRectangle`, `PutImage`) you would
   rasterise; anything modern uses XRender, MIT-SHM or GLX, and MIT-SHM across a VM boundary
   means copying a framebuffer through 9p or serial *per frame*.

Wayland is strictly worse: `wl_shm` is shared memory, and shared memory across the virtio
boundary is a per-frame copy over the same transports.

**Verdict: out of scope, permanently, and I am not pretending otherwise.**

**What is real instead, and it is good:** per-guest-*command* terminal windows. The guest runs
one display (v86's VGA canvas) which gets exactly one host window. Every other guest process
the host launches gets its **own guest PTY**, relayed through 9p into a host terminal window
backed by xterm-pty's termios line discipline
([lineDiscipline.ts @05ed1ad](https://github.com/mame/xterm-pty/blob/05ed1ad11003254bdea32e37032402b068fffca5/src/lineDiscipline.ts),
649 lines of tested MIT TypeScript). So `vim`, `gcc`, `apt`, `python`, `mc`, `man` each get a
real Aero window, with a host PID in the taskbar, killable from the host.

**Name the fidelity tier: guest integration is terminal-grade, not surface-grade.** That is
the honest ceiling, it covers most of what anyone actually wants Linux for, and it is
achievable in the 24 days M4 budgets.

---

## 3. Process model

A **process** is a row in the kernel worker's process table plus a **driver**. The row is the
same for every kind; the driver is what differs.

```
Proc {
  pid: u32, ppid: u32, pgid: u32, sid: u32,
  kind: 'jsworker' | 'guest' | 'guestexec',
  state: RUN | BLOCKED | DYING | ZOMBIE,
  cred: Cred,                       // {uid: u16, gid: u16, caps: u32}
  cwd: u32,                         // inode number, never a path
  fds: Map<i32, OpenFile>,          // kernel-side; a process holds only integers
  sab: SharedArrayBuffer | null,    // 64 KiB, null for guestexec
  port: MessagePort | null,
  sigmask: u32, sigpend: u32, sigact: Uint8Array(32),
  driver: ProcDriver,
  exit: {code: u8, sig: u8} | null,
  guest: {vmid: u32, gpid: u32, ptyid: u32} | null,   // kind === 'guestexec'
}

ProcDriver {
  start(p: Proc): void
  signal(p: Proc, sig: u8): boolean   // true iff delivered
  kill(p: Proc): void                 // SIGKILL path, must be unconditional
  reap(p: Proc): void
}
```

### 3.1 Three drivers, and the one I decline

| kind | What it is | Syscall path |
|---|---|---|
| `jsworker` | A dedicated `Worker` from a **Blob URL built from VFS bytes** — 1.86 ms to first message vs 3.45 ms from HTTP (gap-04 table 3). The normal process. | Blocking SAB, one hop. |
| `guest` | One row per VM. The v86 instance lives in its own dedicated worker. "Exit" is guest poweroff or a wasm trap. | Blocking SAB for `guest_ctl`/`win_*`; **async postMessage for 9p**. |
| `guestexec` | One row per guest command the host launched. **Not a Worker.** `start` writes `SPAWN` to the parked `req` fid; `signal` writes `KILL`; stdio is a 9p-relayed PTY pair. | None — it makes no syscalls. The kernel acts on its behalf. |

**I decline a WASIX driver, and that is a commitment, not an omission.** `@wasmer/sdk` is its
own process manager with its own fd tables, its own filesystem and its own kernel; adopting it
means two process tables and two VFSes in one OS, which violates the one-source-of-truth rule
the rest of this design is built on. It is also measurably rotten at the edges: three of the
five packages named in its own README fail today — `sharrattj/bash`, `sharrattj/coreutils` and
the exact pinned `python/python@=3.13.20`
([04-browser-linux-runtimes.md](../research/04-browser-linux-runtimes.md), verified-by-execution
registry section). So: **two runtimes, not three.** JS workers run native apps against my ABI;
real Linux runs real binaries. The thing WASIX was for — `grep`, `sed`, `awk`, `find`, a real
`fork` — the guest already does, correctly, at 20× instead of 1.3×. I pay 20× and keep one
kernel.

### 3.2 The process table is a filesystem

wanix's `#task/<tid>/` is the only surveyed design where the host can enumerate, inspect and
address a process with no bespoke API
([task.go @dd17950](https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/task.go)).
I take it, and I add the two things it lacks — `kill` and real signals (wanix's `ctl` accepts
only `bind`, `unbind`, `start`).

```
/proc/<pid>/stat      kind, state, ppid, pgid, cred, driver, start_ns
/proc/<pid>/cmdline   NUL-separated argv
/proc/<pid>/environ
/proc/<pid>/fd/<n>    symlink to the open file's path, or "pipe:[id]", "pty:[id]"
/proc/<pid>/ctl       write: "kill <sig>", "setpgid <n>", "fg", "bg"
/proc/<pid>/guestpid  present iff kind === 'guestexec'
/proc/guest/<gpid>/   federated, from guestd; carries a 'stale' flag
/proc/vm/<vmid>/      state, boot_ms, agent_gen, agent_age_ms, pending_9p, snapshot_bytes
```

`kind` is the field that makes a guest process addressable without a new API. The taskbar reads
`/proc`, not a bespoke event bus. `ps` is `readdir`.

### 3.3 Ceilings and the kill grace

- **Hard cap 1,000 processes** in the table. The renderer survives 3,200 live workers and dies
  between 3,200 and 4,800 (gap-04 table 4); every process shares one renderer, so exceeding it
  kills the OS, not the process. 1,000 is the design limit with margin.
- A `guestexec` row costs **zero workers**. A guest with 40 running commands is 1 worker and
  41 rows. This is the cheapest process kind in the system.
- **`terminate()` is not synchronous.** It returns in ~10 µs but a spinning worker kept
  advancing a shared counter and stopped at 2004/2051/2003/2048/2009 ms (n=5, gap-01 §e). So
  `state = DYING` is a real state with a visible 2 s timer, the window is torn down before the
  worker is gone, and the spawn-after-mass-kill path budgets the measured 22.7 ms.
- **Signals never fan out.** Round-tripping all live workers costs 378 µs each — 502 ms at
  1,600 (gap-04 table 4). Signal delivery is O(interested): the kernel indexes
  `pgid → Set<pid>` and touches only those rows' `SIGPEND` words.
- A worker parked in `Atomics.wait` cannot service `postMessage`, so a signal arrives as the
  `SIGPEND` bit in the SAB control word plus a `SEQ` bump — never as a message.

---

## 4. Runtime and the syscall subset

### 4.1 The channel, unchanged from gap-03

Per process: one 64 KiB `SharedArrayBuffer` + one `MessagePort` to the kernel worker, both
handed over at spawn. Control words `i32[0]=SEQ` (**the only futex word**), `[1]=STATUS`,
`[2]=RLEN`, `[3]=SIGPEND`, `[4]=CALLID`. Args `i32[8..15]`. One variable-length arg at byte 128
as `[u32 len][bytes]`, `MAX_INLINE = 65404`. Return `i32[16],[17]` as i64; error iff
`r0 < 0 && r1 == -1`, value `-errno`. Errnos are WASI preview1's dense 0–76 verbatim
([wasi_defs.ts @b068ec2](https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/wasi_defs.ts#L12-L88))
plus `EHOSTGONE = 100`.

Entry sequence, with the race handled explicitly because 0.2% of round trips hit it:

```js
const s = Atomics.load(ctl, SEQ);
port.postMessage(callid);
const r = Atomics.wait(ctl, SEQ, s, TIMEOUT_MS);   // never Infinity
// r === "ok"        : kernel notified us
// r === "not-equal" : reply beat the park. Measured ~0.2% (gap-01: 4 of 2000). Fall through.
// r === "timed-out" : kernel is wedged. Retry once, then fault the process.
```

`Infinity` is forbidden: a worker parked forever on a dead kernel is a zombie that
`terminate()` reaps only on the engine's own schedule (gap-01 design consequences).

Blocking is not a tax. The SAB ring is **faster** than async postMessage — 14.0 µs vs 17.3 µs
mean, kernel in a worker (gap-04 table 1) — because `Atomics.wait` skips a task-queue turn.
And the kernel must be a dedicated worker, not the main thread: same median either way, but
with the main thread 60% busy a main-thread kernel stalled 52 of 20,000 syscalls past 10 ms
(max 400 ms during a deliberate 400 ms sync task) while a worker kernel stalled 0 past 0.52 ms.

### 4.2 The table: 68 calls from gap-03, plus exactly three

I adopt gap-03's table verbatim — process (`spawn`, `exec`, `waitpid`, `kill`, `getpid`,
`getppid`, `getpgid`, `setpgid`, `exit`, `sigaction`, `sigprocmask`, `sched_yield`), fd
(`close`, `read`, `write`, `pread`, `pwrite`, `seek`, `fstat`, `fsync`, `ftruncate`, `dup`,
`dup2`, `fcntl`, `ioctl`, `poll`), path (`open`, `mkdir`, `rmdir`, `unlink`, `rename`,
`readdir`, `symlink`, `readlink`, `link`, `stat`, `lstat`, `chmod`, `chown`, `utimes`,
`truncate`, `statfs`, `realpath`, `mount`, `umount`), IPC (`pipe2`, `socketpair`, `send`,
`recv`, `shutdown`, `shm_create`, `shm_attach`), host (`clock_gettime`, `clock_nanosleep`,
`random`, `env_get`, `env_set`, `win_create`, `win_set`, `win_destroy`, `win_poll`,
`clipboard_read`, `clipboard_write`, `notify`, `tty_get`, `tty_set`, `tty_winsize_get`,
`tty_winsize_set`, `pty_open`).

No `fork`. Browsix states fork is incompatible with a blocking syscall channel, and its only
fork path required Emscripten's Emterpreter, deleted in 1.39.18
([gap-02](../research/gap-02.md)). Browsix, wanix and WebContainer all converge on spawn. I do
not relitigate it. **The guest is where fork works**, and that is a feature of this design
rather than an excuse.

The three additions, and nothing more:

| call | args | → | errno |
|---|---|---|---|
| `guest_ctl` | `a0=vmid`, `a1=op ∈ {BOOT, SNAPSHOT, RESTORE, POWEROFF, ATTACH_FB}`, byte region = args | 0 or snapshot ino | `SRCH BUSY NOMEM INVAL HOSTGONE` |
| `guest_spawn` | byte region = `GuestSpawnSpec` | host pid | `SRCH HOSTGONE NOENT AGAIN INVAL` |
| `vm_stat` | `a0=vmid` | 48-byte `VmStat` in byte region | `SRCH` |

```
GuestSpawnSpec = [u32 vmid][u32 argc][u32 envc][u32 flags]
                 [argv NUL-sep][env NUL-sep][cwd NUL]
  flags: WANT_PTY (allocate a guest PTY and a host terminal window)
         WANT_PIPES (DUP2 host pipes instead; for `gcc | head`)

VmStat = [u32 state][u32 boot_ms][u32 agent_gen][u32 agent_age_ms]
         [u32 pending_9p][u32 nguestproc][u64 snapshot_bytes][u64 reserved]
```

71 calls total. Keeping it near gap-03's number is deliberate: the cost anchor is a 27-syscall
browser kernel at 2,249 LoC and 8,126 LoC with all runtime integrations (gap-02), and every
call I add is LoC I have to verify.

### 4.3 Which calls a `guestexec` process answers

`guestexec` makes no syscalls, but the host's 71-call ABI must answer *about* it. The kernel
implements, on its behalf: `waitpid` (the agent's exit reply resolves it), `kill` (translated
to a `KILL` command), `read`/`write` on its stdio fds (the 9p PTY relay), `tty_winsize_set`
(translated to `WINCH`), and `fstat`/`poll` on those fds. A host process cannot tell a
`guestexec` child from a `jsworker` child through the ABI. That is the point: `yes | head -3`
and `gcc -E x.c | head -3` take the same code path in the shell.

### 4.4 The shell

Reuse webxp's: `apps/terminal/shell.mjs` (453 lines), `commands.mjs` (1,488), `glob.mjs` (160),
`app.mjs` (306) — 2,407 lines total. It becomes a `jsworker` process whose stdio is a
`pty_open` pair, not a DOM-coupled app. The rewrite is the I/O boundary, not the grammar:
commands stop calling the VFS directly and start calling the 71-call ABI.

Three new builtins carry the guest, and they are thin:

- `gexec <argv…>` → `guest_spawn` with `WANT_PTY`, returns a host pid.
- `gps` → `readdir /proc/guest`, with the stale flag rendered.
- `gkill` → `write /proc/guest/<gpid>/ctl`.

And one file association: `.c` opens with `gexec cc`, `.deb` with `gexec dpkg`. The guest is
reachable from the GUI, not just the prompt.

---

## 5. VFS

gap-06's design, taken whole, with the credential refactor done up front because the 9p server
needs it.

```
Inode {
  ino: u32, mode: u16, uid: u16, gid: u16, nlink: u16,
  size: u64, atime_ns: u64, mtime_ns: u64, ctime_ns: u64,
  kind: REG | DIR | LNK | FIFO | CHR,
  target: string | null,       // LNK
  entries: Map<string,u32> | null,   // DIR
  gen: u32,                    // qid.version for 9p
}
```

- **Authoritative in RAM in the kernel worker.** `stat` is 27 ns, a depth-5 path walk 370 ns
  (gap-06 table). Syscall latency is independent of the store.
- **Persisted** as an OPFS superblock snapshot (`sb.0`/`sb.1` alternating, `sb.ptr` carrying
  `{generation, slot, journalSeq, crc32}`) plus an append-only journal `j.log`. Boot is 7.2 ms
  at 10k inodes vs 23.4 ms for IndexedDB.
- **File data in a FLAT OPFS directory `b/<ino>`.** Flat is forced: Chrome 157 has no
  `FileSystemDirectoryHandle.move()` and Safari 27.2 rejects the one-argument rename, so
  `fileHandle.move(dirHandle, name)` is the only portable primitive.
- **Ordering per mutation:** write/extend `b/<ino>` → `flush()` → append journal record →
  `flush()` → apply in memory. Data before metadata, because an orphan blob is garbage and a
  record pointing at absent data is corruption. Snapshot every 512 records.
- **`fsync` is a separate syscall from `write`.** `flush()` is 260 µs against a 5 µs 4 KiB
  write; flushing per write is a 50× slowdown for durability nobody asked for.
- **`open()` is rare, fd I/O is common.** `createSyncAccessHandle` is 495 µs — 100× a syscall.
  Handles live in a kernel descriptor table for the kernel's lifetime. Paths resolve to an
  inode once; processes get fds, never paths.
- **fsck never silently reseeds.** A snapshot that fails validation mounts read-only and says
  so. webxp's reset-on-bad-image behaviour is removed before any user data lands in it.
- **IndexedDB does exactly one job:** storing `FileSystemDirectoryHandle`s for host mounts.
- **Blob-orphan collection is an idle task, not boot.** Safari enumerates at 0.60 ms/name —
  10k names is ~6 s.

Mount table, longest prefix wins:

```
/              opfs        rw
/usr           overlay     lower = httpimg (daedalOS v4 index, ro), upper = opfs:/.rw/usr, COW + whiteouts
/proc /dev /sys genfs      synthesized on read, no stored inodes
/proc/guest    guestfs     federated from guestd, carries a staleness generation
/mnt/host/<l>  hostfs      showDirectoryPicker; Chromium only — Safari has no picker
/tmp           tmpfs
```

**Known limits, stated:** the table does not page lazily and needs rework past ~100k inodes;
`navigator.storage.persist()` is Window-only so the *shell*, not the kernel, must request
durability and show `persisted()`; and the filesystem is deletable — a best-effort bucket
"should" be cleared under storage pressure
([storage.spec.whatwg.org](https://storage.spec.whatwg.org/#storage-pressure)), so export is a
first-class feature, not a nicety.

### 5.1 Credential enforcement, and where the guest's boundary actually is

Every path-resolution and permission call takes `Cred` first:

```js
vfs.lookup(cred, parentIno, name)
vfs.open(cred, ino, flags, mode)
vfs.pread(cred, ino, off, len)
```

The 9p server supplies the **guest VM's own process-row credential**, never the uid the guest
claims in `Tattach{uname, n_uname}`. A root shell in Buildroot is uid 0 *inside the guest* and
`cred.uid = <the host user>` *at the host VFS*. The guest cannot escalate by being root.

Mount point, not guest uid, is the boundary. **Default: the guest's `/mnt/host` is bound to
`$HOME/guest`, not `/`.** Mounting host `/` into the guest is an explicit opt-in behind a
dialog. The residual hole is honest: within its mount subtree, a guest running as host-uid *U*
can do anything *U* can do, including `chmod 777`. That is correct — it is the same authority a
host `jsworker` process owned by *U* has. The guest is not a privilege boundary downward; it is
a *containment* boundary for the binary's reach into the browser.

---

## 6. The guest, priced

### 6.1 Cost

| | Figure | Source |
|---|---|---|
| Boot to login | **3,529–3,540 ms** | measured, 3 runs, v86 0.5.473 + Buildroot `linux.iso` |
| Boot to root shell | **3,562–3,572 ms** | same |
| Engine over the wire | **476 KB gzipped** (2,007,347 B wasm + 359,819 B JS) | `npm pack v86@0.5.473` + gzip |
| Image | **5,666,816 B** | copy/images Buildroot `linux.iso` |
| `save_state()` | **32,032,352 B in 38–59 ms** (128 MB RAM VM) | measured |
| Serial round trip | **10–13 ms** | measured |
| Compute | **~18–20× native** (shell loop 1.68 s vs 0.084 s; `dd` 0.08 s vs 0.0045 s) | measured, two independent benchmarks |
| Kernel | **2.6.34.14, i386 only** — "64-bit kernels are not supported" | v86 Readme @315b2b0 |

Total lazy download when the guest first launches: **~6.1 MB**. Zero at OS boot — the guest is
launched on demand, and `restore_state` from a VFS-resident snapshot hides the 3.5 s.

### 6.2 Licence: v86, and CheerpX is disqualified twice over

**v86 is BSD-2-Clause**
([LICENSE @315b2b0](https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/LICENSE)):
vendorable, pinnable, auditable, offline-capable, self-hostable. For a project whose entire
deployment story is a static bundle under `COOP: same-origin` + `COEP: require-corp`, those are
not conveniences — they are requirements.

**CheerpX fails on deployment before anyone reaches the licence.** `@leaningtech/cheerpx@1.4.0`
is a **581-byte** `index.js` whose entire body is
`dynImport('https://cxrtnc.leaningtech.com/1.4.0/cx.esm.js')`, which fetches runtime-computed
`.wasm`/`.data` chunks from the same CDN. There is no artifact to vendor, pin, or audit, and no
offline path. Then the licence: clause 1.4(b) limits a Business to "technical evaluation and
testing"; 1.5 scopes an application to "a single designated origin domain"; 2.1(e) forbids
modification and 2.1(f) forbids reverse-engineering — which also forecloses writing your own
block server; and 1.4(b) closes with "Our determination… will be final"
([LICENSE.txt](https://github.com/leaningtech/cheerpx-meta/blob/main/LICENSE.txt);
[licensing docs](https://github.com/leaningtech/labs/blob/main/sites/cheerpx/src/content/docs/23-licensing.md)).
WebVM's Apache-2.0 badge covers the Svelte UI, not the engine, and its README says so.

Two more nails specific to this design: CheerpX's only output capture is
`setCustomConsole(writeFunc)` — **one global console callback for the whole machine, not
per-process stdout**
([input-output.md](https://github.com/leaningtech/labs/blob/main/sites/cheerpx/src/content/docs/11-guides/input-output.md))
— which makes §2.3's per-command terminal windows impossible; and it has no `handle9p`
equivalent, so there is no shared filesystem, which is the entire thesis.

**One thing I could not determine and would have to measure if anyone argued for CheerpX:**
whether `cxrtnc.leaningtech.com` sends `Cross-Origin-Resource-Policy` on its runtime-fetched
chunks. A cross-origin ESM `import()` is a cors-mode request and so is not blocked by COEP, but
no-cors subresources under `require-corp` need CORP. The research could not enumerate those
chunk URLs. It does not change the decision — the licence already does — but I will not assert
a header I did not read.

**container2wasm: rejected.** Its own docs say the WASI-on-browser route "runs containers on
emulators with interpreter approach with a single thread so the execution can be slower than
the emscripten example" — Bochs interpreting x86 inside wasm. The faster route is QEMU-TCG via
emscripten, far heavier than v86 for the same outcome. And the project self-labels "This is an
experimental software." Keep its `docker build` → image pipeline as a tool; not the runtime.

### 6.3 Checkpoint/restore — the one thing a pure host kernel cannot do

A host `jsworker` cannot be suspended to disk. There is no Worker checkpoint primitive, and
reloading the kernel's window reaps every process worker it owns (gap-01: 0 waiters after the
owner document was detached). The guest **can** be checkpointed: 32 MB in 38–59 ms.

So `guest_ctl(vmid, SNAPSHOT)` gives the guest `SIGSTOP`-to-disk semantics the rest of the OS
does not have. The consistency rule, because `handle9p` makes it my problem:

1. Quiesce: refuse new 9p requests, drain in-flight ones.
2. Barrier: `flush()` the journal, record `journalSeq` in the snapshot header.
3. `save_state()` → write 32 MB into the VFS as `b/<ino>` → `flush()`.
4. Journal the snapshot inode. Resume 9p.

On `RESTORE`, the guest's page cache may hold data the host has since changed. **Mount with
`cache=none`** so v9fs does direct I/O and the problem mostly vanishes, at an I/O cost I accept
because the guest is a compatibility container, not a throughput engine. M6's negative control
is exactly this: mount with `cache=loose` and require the stale-content assertion to fail.

### 6.4 What the user gains that a pure host kernel cannot give

1. **Binaries that exist.** `wasmer/bash`'s entire `/bin` is uutils coreutils — **no grep, sed,
   awk, find, ps, kill, chmod, mkfifo, stty or mount, and no `/proc` at all**, and `uname`
   reports `wasi`, not Linux, so anything sniffing uname takes its non-Linux branch
   ([04-browser-linux-runtimes.md](../research/04-browser-linux-runtimes.md)). The guest has all
   of it, plus gcc, perl, python, git, man and `apt` (with a relay).
2. **Semantics my ABI cannot have.** Real `fork`, `mmap`, named pipes, `ptrace`, real uid/gid
   enforcement, `SIGTSTP` that actually suspends, and preemption. gap-03 is explicit that a
   compute loop issuing no syscalls is **uninterruptible** under my ABI and that SIGTSTP is
   "not resolved". The guest preempts because Linux preempts.
3. **Checkpoint/restore**, per §6.3.
4. **A credible answer to "it is not a real OS."** One row in the process table is a real
   Linux, and it writes to the same files the host shell reads.

---

## 7. Risk, and the fallbacks priced

**Riskiest assumption:** *a host-implemented 9P2000.L server can park a `Tread` indefinitely
and Linux's v9fs client tolerates it* — no timeout, no `-EIO`, signal-interruptible, `umount`
still possible after. The control plane (§2.2) and every PTY relay (§2.3) rest on it. I have no
measurement. **Milestone 0 is nothing but this measurement.**

If it is false, both fallbacks are survivable and both are much worse:

| Fallback | Mechanism | Cost |
|---|---|---|
| **Polling** | `guestd` polls `.ctl/req` at 10 Hz; the host 9p server returns 0 bytes when idle. | +~100 ms control latency, and a guest CPU burn at 20× native that shows up as a hot tab. A PTY at 10 Hz is unusable, so guest terminals would go to serial. |
| **Serial** | Frame a multiplexed protocol over `serial0_send` / `serial0-output-byte`. | One stream, 10–13 ms per round trip, framing I write, and it competes with the console. One guest terminal at a time; the multi-window guest story dies. |

In the worst case the design degrades to: **shared writable filesystem (the thesis survives) +
one framebuffer window + no process federation.** That loses M4's 24 days of value and keeps
M3's. It is a bad outcome, not a fatal one — which is why it is milestone zero rather than
milestone four.

Second-order risks, each with its measurement:

- **9p round-trip latency through the async hop.** A plain async postMessage round trip is
  17.3 µs (gap-04 table 1), and the 9p handler is `async (reqBuf, reply)` so async is the
  natural fit. But `ls` of a 200-entry host directory from the guest is ~200 `Treaddir`-driven
  `Tgetattr`s; at 2 ms each that is 400 ms and the shared tree feels broken. M3 measures it.
- **Aero and the guest canvas together.** The glass benchmark ran with **no workers alive**
  (gap-04 "could not determine"). A guest repainting a VGA canvas at 20× slow while 30 glass
  windows composite is unmeasured. M5's proof runs the frame check with a booted guest.
- **The 2 s `terminate()` grace applies to the guest worker too**, and the guest worker holds a
  2 MB wasm instance. A killed guest may keep running for ~2 s. The window must go first.

---

## 8. Milestones

Ordered riskiest-first. Each proof names the check and the negative control that shows the
check can fail. `scripts/check.py` from webxp is the harness — 11,789 lines of Chrome DevTools
Protocol checks that drive real input and read geometry back, with `--prove-failure` inverting
every assertion and an in-check negative control (a drag in the window body must move nothing).
It ports almost unchanged and is the most valuable artifact in the predecessor.

| # | Title | Days | New/modified LoC |
|---|---|---|---|
| 0 | 9p parked-read spike | 8 | ~900 |
| 1 | Host kernel, 71-call ABI, process table as a filesystem | 22 | ~3,400 |
| 2 | VFS on OPFS with the credential refactor | 20 | ~2,300 |
| 3 | 9p server over the real VFS; guest as a process row | 18 | ~1,500 |
| 4 | `guestd`, federated `/proc`, `guestexec` driver, guest terminals | 24 | ~2,100 |
| 5 | Aero shell on the reskinned webxp WM | 26 | ~2,600 |
| 6 | Checkpoint/restore, guest lifecycle, shell integration | 15 | ~1,100 |
| | **Total** | **133** | **~13,900** |

**Against the cost anchor.** Browsix was 2,249 LoC for a 27-call kernel and 8,126 LoC with all
runtime integrations (gap-02, Fig. 2). My kernel core plus drivers plus the 9p server is
~5,800 LoC, which is 2.6× Browsix's kernel for 2.6× the calls plus a protocol server — the
right order. The remaining ~8,100 is VFS, WM reskin, Aero and harness, most of it modification
of 20,000+ reused lines rather than new code. At ~105 LoC/day of *finished, harnessed* code
(not typed code — the verification habit is the cost), 13,900 LoC is ~132 days. The totals
agree, which is the only reason I trust either.

### M0 — 9p parked-read spike (8 days)

Vendor v86 at pinned sha `315b2b0`. Boot the Buildroot image in a dedicated Worker. Implement
the minimal 9P2000.L subset (Tversion, Tattach, Twalk, Tlopen, Tgetattr, Tread, Twrite, Tclunk,
Treaddir) against a 20-line in-memory tree. Mount it in the guest. **First: read the
authoritative message list out of v86's own 9p implementation.**

**Proof.** Guest runs `dd if=/mnt/host/.ctl/req bs=1 count=5`, which must block. The host
writes 5 bytes after 3,000 ms. Assertions: `dd` returns exactly those 5 bytes; guest-side wall
time ≥ 2,900 ms; exit status 0; `dmesg | grep -i 9p` shows no error; `Ctrl-C` during a second
park yields `EINTR`; `umount /mnt/host` after the park succeeds.

**Negative control.** Reply to that `Tread` with `Rlerror{EIO}` instead of parking. `dd` must
fail and the check must report failure. **Second negative control:** park and never reply, then
assert the guest *does* wedge — proving the harness can observe the bad outcome rather than
timing out silently.

### M1 — Host kernel, 71-call ABI, process table as a filesystem (22 days)

The SAB channel per gap-03 verbatim, kernel in a dedicated worker, `jsworker` driver, spawn from
Blob URL, `pipe2`, `waitpid`, `kill`, signals via `SIGPEND`, `/proc` genfs, `pty_open` with
xterm-pty's line discipline, the webxp shell as process 1.

**Proof.** `check.py` drives a real terminal window: `yes | head -3` emits exactly 3 lines and
`/proc/<pid>` for both children disappears within 2.5 s. `sleep 100` then `Ctrl-C` returns to a
prompt in under 200 ms. Instrument `atomics_wait_outcomes` over 20,000 syscalls and require
**both** `"ok"` and `"not-equal"` to appear — the 0.2% fast path must be exercised, not assumed.
Assert mean round trip ≤ 25 µs.

**Negative control.** Remove the `SIGPEND` check at syscall entry; the Ctrl-C check must fail.
Second: make the kernel never reply to one `CALLID`; the finite-timeout retry must fault the
process and the check must observe a `DYING` row, not a hang.

### M2 — VFS on OPFS with the credential refactor (20 days)

Port `webxp/shared/fs/vfs.mjs`: data becomes bytes in `b/<ino>`, `Cred` becomes the first
argument everywhere, add the fd layer (open/read/write/lseek/dup, O_APPEND/O_TRUNC — absent from
the 1,301 lines), superblock + journal, mount table with longest-prefix matching, real
mount-crossing in `#lookup`.

**Proof.** 10,000-inode boot measured in-browser under 15 ms. Crash test: SIGKILL the kernel
worker mid-journal-append, then require fsck to replay to the last good record, **report** the
torn tail, and preserve every record before it. Two processes with different `Cred` get
different answers for the same `open()` on a 0700 directory.

**Negative control.** Corrupt record N's crc32; fsck must stop at N−1 and mount read-only with a
visible message. Second: assert fsck can never produce an empty root — the webxp reseed path
must be provably gone, not merely unused.

### M3 — 9p server over the real VFS; guest as a process row (18 days)

The full ~24-message subset over the real inode table. `guest` driver with v86 in its own
worker. `handle9p` wired to the kernel over async postMessage. Credential pinning from the
guest's process row. `msize` 131072. `/proc/vm/<vmid>/`.

**Proof.** Host writes `/home/u/x` with content C; guest `cat /mnt/host/x` returns exactly C
byte-for-byte. Guest writes `y`; host `stat` shows mode 0644 and `uid` equal to the **guest
process row's** credential, not 0. A symlink the host created reads as a symlink in the guest's
`ls -l`. All of mode/uid/nlink survive a kernel restart, because they live in the host journal
rather than OPFS. Measure `ls -la` of a 200-entry host directory from the guest; assert under
400 ms.

**Negative control.** Pin the credential to uid 0; the "guest cannot write to a 0700 directory
owned by another uid" check must fail. Second: remove the `Treadlink` handler; the symlink check
must fail rather than silently reporting a regular file.

### M4 — `guestd`, federated `/proc`, `guestexec`, guest terminals (24 days)

The C agent, the `req`/`resp`/`procs`/`gen` protocol, `/proc/guest/<gpid>/`, `guest_spawn`, the
PTY relay through 9p, host terminal windows bound to guest pids, `gexec`/`gps`/`gkill`.

**Proof.** From the host shell, `gexec vim /mnt/host/notes.txt` opens a host Aero window. Host
`ps` lists it with a host pid and `/proc/<pid>/guestpid` present. Typing `:q!` in that window
exits it and the host pid is reaped carrying the guest's exit status. `kill -9 <hostpid>` on a
guest `sleep 300` makes the guest's own `ps` lose it within 1,500 ms. Measured: keystroke-to-echo
p50 in a guest terminal window **under 80 ms**.

**Negative control.** SIGSTOP `guestd` from inside the guest; `/proc/guest` must report the
subtree stale within 3 s and `gkill` must return `EHOSTGONE`, not silently succeed. Second: drop
the `gen` heartbeat entirely and require the staleness check to fail — a staleness detector that
cannot report staleness is the exact harness dishonesty this project exists to avoid.

### M5 — Aero shell on the reskinned webxp WM (26 days)

Port `src/window.mjs` (836), `desktop.mjs` (878), `dialogs.mjs` (1,155), `widgets.mjs` (1,162),
`contextmenu.mjs` (590). Reskin `theme.css`/`window.css` from XP Luna to Aero. Implement the
measured recipe: additive (`plus-lighter`) composite over a Gaussian-blurred backdrop — blurred
RGB × `blurBalance 0.49`, a Rec.709 luminance copy tinted by `afterglow 0.43`, a flat
colorization tint `0.08`, over `RGB(116,184,252)`, clipping above 1.0. Highlight streak as a
**monitor-anchored** bitmap parallaxed at 0.1. Redraw the icon set; build Selawik from source
with fontmake. Font stack `"Segoe UI", Selawik, system-ui, "Helvetica Neue", Arial, sans-serif`
— naming Segoe UI in a stack is permitted; self-hosting it is not, and Selawik is **not**
documented as metric-compatible, so layouts are tested against both.

Budget: cap total blurred device px at **56 M**, below the measured 58–63 M knee, and degrade
the oldest glass window to a flat fill when a drag would cross it.

**Proof.** `check.py` drives a real drag of the *bottom* window (so all N re-blur) with 30 glass
windows at 51 M device px and asserts rAF p50 ≤ 9.0 ms. Then at 70 M asserts the degradation
fired (glass count dropped) and p50 is still ≤ 9.0 ms. Run both **with a booted guest**, closing
gap-04's unmeasured interaction. Pixel proof: screenshot a known backdrop under a known glass
rect and assert the sampled RGB is within 2/255 of the recipe recomputed in Python from the same
backdrop. Layout checked at the narrow and wide extremes, in both fonts.

**Negative control.** Set `blurBalance` to 0.0; the pixel check must fail. Second: disable the
area cap; the 70 M frame check must fail. Third (webxp's own, ported unchanged): a drag inside
the window body must move nothing.

### M6 — Checkpoint/restore, guest lifecycle, shell integration (15 days)

`guest_ctl` SNAPSHOT/RESTORE with the journal barrier, snapshot blobs in the VFS, suspend/resume
across a page reload, `.c` → `gexec cc` file association, the taskbar rendering guest rows.

**Proof.** Boot the guest, create a file through 9p, snapshot (assert ≤ 60 ms and ≤ 40 MB),
reload the page, restore, and assert the guest's shell history and the file are both intact
**and** that `cat` of a host-modified file shows the NEW content — proving `cache=none` rather
than a stale page cache.

**Negative control.** Mount with `cache=loose`; the stale-content assertion must fail. Second:
skip the journal barrier in step 2 of §6.3 and require a check that restores a snapshot whose
`journalSeq` is ahead of the superblock to report inconsistency rather than mount.

---

## 9. Deployment

`COOP: same-origin` + `COEP: require-corp`. `require-corp` is the only Safari-portable value;
`credentialless` is Chrome 96 / Firefox 119 / Safari none, and it does not rescue iframes
anyway. Settable on Cloudflare Pages, Netlify, Vercel, Firebase Hosting, S3+CloudFront (Custom
headers — COOP/COEP are not in the managed security-headers set) and nginx. **Not** on GitHub
Pages or bare S3; the only path there is `coi-serviceworker`, which costs an unconditional
reload and leaves first paint un-isolated.

Consequences I accept:

- Self-host every font, icon and asset. Every remote image needs `crossorigin="anonymous"`,
  routed through one helper so it cannot be forgotten.
- **No third-party iframe embeds anywhere.** Measured: YouTube sends CORP `cross-origin` but only
  `COEP-Report-Only`, so the embed is blocked in a `require-corp` document. No YouTube window, no
  maps window, no OAuth widget. If such content is wanted it opens in a separate non-isolated
  top-level window.
- v86's 2 MB wasm and the 5.7 MB image are same-origin assets, so `require-corp` costs nothing
  there. This is a quiet argument for v86 over CheerpX that is independent of the licence.
- Threat model **(i), first-party only.** The ABI stays postMessage-shaped with no shared
  globals, so per-app origins remain a v2 *deployment* change rather than a rewrite — knowing
  that each app origin would then need its own SAB plus a broker worker doing an async hop, two
  hops not one.

---

## 10. What this design gives up

- **No `fork` in host processes, ever.** Only the guest forks.
- **No guest GUI windows.** Terminal-grade guest integration only. An X11 server in JS is out of
  scope permanently, and §2.3 says why rather than deferring it.
- **No 64-bit guest.** Kernel 2.6.34.14, i386, a permanently shrinking package universe.
- **Guest compute at ~18–20× native.** Nothing in the guest can hold a frame budget.
- **No WASIX driver.** I decline near-native wasm binaries and the prebuilt uutils artifact to
  keep one process table and one VFS.
- **Host-visible guest processes are a proxy**, ~200–600 ms stale, owned by `guestd`, not by the
  kernel.
- **No third-party app tier**, and no untrusted-code boundary in v1 except the guest itself.
- **No GitHub Pages**, and no third-party iframe embeds.
- **~6.1 MB of lazy download** on first guest launch; 32–40 MB per snapshot against the OPFS
  quota, which `estimate()` reports only as "an implementation-defined rough estimate".
- **The VFS does not page metadata lazily**; it needs rework past ~100k inodes.
- **Compute-bound host processes are killable but not interruptible**, and the window manager's
  cancel affordance must show that distinction rather than hide it.
- **Safari gets a full OS minus host-directory mounts** (no `showDirectoryPicker`), and its OPFS
  enumeration at 0.60 ms/name forbids any boot-time directory scan.

---

## 11. Reuse from webxp

| Artifact | Lines | Disposition |
|---|---|---|
| `scripts/check.py` | 11,789 | Ports almost unchanged. `--prove-failure` and the in-check negative controls are the harness contract for every milestone above. |
| `shared/fs/vfs.mjs` | 1,301 | Upper layer reused: `#lookup` (symlinks, `MAX_LINKS=40`), `#may`/`#need`, hard links and nlink accounting, `FsError` POSIX codes, `serialize`/`parse` as snapshot writer/loader and half of fsck, `batch`/`watch`. Three changes touch every method: bytes not strings, `Cred` per call, no localStorage ceilings. |
| `src/window.mjs` | 836 | 8-edge resize, drag, minimise, maximise, focus. Reskinned to Aero. |
| `src/desktop.mjs` | 878 | Reskinned. |
| `src/dialogs.mjs` | 1,155 | Reskinned. |
| `src/widgets.mjs` | 1,162 | Reskinned. |
| `src/contextmenu.mjs` | 590 | Reskinned. |
| `apps/terminal/*` | 2,407 | Grammar and builtins kept; the I/O boundary is rewritten onto the 71-call ABI. |
| `docs/review.md` | 571 | Read before M1. It records a case where the fix for finding 1 re-introduced the same defect one call later — the exact failure mode a 9p fid table invites. |

**And the lesson, which is the reason for the whole architecture:** webxp failed because apps
were ES modules importing `shared/fs/fs.mjs` directly, and each app *was* its window
(`mount(root)`). Nothing was isolated, killable or backgroundable. Here an app is a Worker that
holds only integers, every releasable resource lives in the kernel because `terminate()` offers
no cleanup, and a window is something the kernel hands a process through `win_create` — never
something the process owns.

---

## 12. Citations

Measured facts without a public URL come from this project's own harnesses and are cited by path
so they can be re-run:
`/Users/chafyni/.claude/jobs/e856c39e/tmp/harness/` (`run.py {core|ceiling|frames|aero}`,
`negative.py`, `out/*.json`) and `/Users/chafyni/claude/tmp-vfsbench/{index.html,worker.js,serve.py}`.
Everything else is linked inline at the point of the claim, pinned to a sha where one exists:

- v86 `handle9p`, caching price, `create_file` unavailability —
  [docs/filesystem.md @315b2b0](https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/docs/filesystem.md)
- v86 networking needs a relay —
  [docs/networking.md @315b2b0](https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/docs/networking.md)
- v86 no 64-bit kernel —
  [Readme.md @315b2b0](https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/Readme.md)
- v86 licence —
  [LICENSE @315b2b0](https://github.com/copy/v86/blob/315b2b0b758703ef0e6cc7b4088d6068f83f3c20/LICENSE)
- daedalOS hands v86 the host 9p index —
  [useV86.ts @ed9c7a5](https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/components/apps/V86/useV86.ts)
- daedalOS build-time index format —
  [fs2json.js @ed9c7a5](https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/scripts/fs2json.js)
- CheerpX licence —
  [LICENSE.txt](https://github.com/leaningtech/cheerpx-meta/blob/main/LICENSE.txt),
  [licensing docs](https://github.com/leaningtech/labs/blob/main/sites/cheerpx/src/content/docs/23-licensing.md)
- CheerpX single global console —
  [input-output.md](https://github.com/leaningtech/labs/blob/main/sites/cheerpx/src/content/docs/11-guides/input-output.md)
- WebVM engine not self-hostable —
  [README @667a02d](https://github.com/leaningtech/webvm/blob/667a02d79a3b91a48ed7bee8dca3693c33ef95a2/README.md)
- container2wasm browser path is an interpreter —
  [wasi-browser README @3f0f9be](https://github.com/container2wasm/container2wasm/blob/3f0f9be4d5ee201ea1a12f9700e6e3ef52c8b345/examples/wasi-browser/README.md)
- wanix `CallBuffer`, silent truncation —
  [callbuffer.ts @dd17950](https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/wasi/callbuffer.ts)
- wanix process-as-filesystem, no `kill` —
  [task.go @dd17950](https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/task.go)
- Browsix fork incompatible with blocking syscalls; 2,249 / 8,126 LoC —
  [arXiv:1611.07862](https://arxiv.org/abs/1611.07862)
- Browsix-Wasm bounce buffer, 0.2% avg / 1.2% max —
  [arXiv:1901.09056](https://arxiv.org/abs/1901.09056)
- WASI preview1 errnos 0–76 —
  [wasi_defs.ts @b068ec2](https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/wasi_defs.ts#L12-L88)
- xterm-pty termios line discipline —
  [lineDiscipline.ts @05ed1ad](https://github.com/mame/xterm-pty/blob/05ed1ad11003254bdea32e37032402b068fffca5/src/lineDiscipline.ts)
- `Atomics.wait` throws on a thread that cannot block; `"not-equal"` fast path —
  [MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait),
  [ECMA-262](https://tc39.es/ecma262/multipage/structured-data.html#sec-atomics.wait)
- A dedicated worker joins its creator's agent cluster; `[[CanBlock]]` true —
  [HTML](https://html.spec.whatwg.org/multipage/webappapis.html#integration-with-the-javascript-agent-cluster-formalism)
- A SAB can only be received in the cluster it came from; otherwise `messageerror` —
  [HTML](https://html.spec.whatwg.org/multipage/structured-data.html#restricting-to-the-same-agent-cluster)
- `terminate()` offers no cleanup opportunity —
  [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate)
- `createSyncAccessHandle` is `[Exposed=DedicatedWorker]`, exclusive-locking —
  [fs spec](https://fs.spec.whatwg.org/#api-filesystemfilehandle-createsyncaccesshandle)
- `flush()` is the only durability primitive; `close()` guarantees nothing —
  [fs spec](https://fs.spec.whatwg.org/#dom-filesystemsyncaccesshandle-flush)
- `move()` is not in the standard —
  [whatwg/fs#10](https://github.com/whatwg/fs/pull/10)
- Best-effort buckets may be cleared under pressure —
  [storage spec](https://storage.spec.whatwg.org/#storage-pressure)
- Short writes are POSIX-legal —
  [write(3p)](https://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html)
- `posix_spawn` file actions are the `SpawnSpec` shape —
  [posix_spawn(3p)](https://pubs.opengroup.org/onlinepubs/9699919799/functions/posix_spawn.html)
- COEP `require-corp` blocks no-cors subresources without CORP —
  [MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy)
- `backdrop-filter` is clipped to the border box, so cost scales with area —
  [filter-effects-2](https://drafts.csswg.org/filter-effects-2/#BackdropFilterProperty)
- Selawik is OFL-1.1, ships no built binaries, and metric compatibility is not claimed —
  [LICENSE @89362e8](https://github.com/microsoft/Selawik/blob/89362e84731d1f5777fa078fd4d5ebbd339e4378/LICENSE.txt),
  [README @89362e8](https://github.com/microsoft/Selawik/blob/89362e84731d1f5777fa078fd4d5ebbd339e4378/README.md)
- No legally clean source for Windows 7 icons or glass bitmaps —
  [Microsoft permissions](https://www.microsoft.com/en-us/legal/intellectualproperty/permissions)

**Labelled unsourced in this pass:** the 9P2000.L message list in §2.1 is from memory. It is the
first thing M0 verifies against v86's own implementation at the pinned sha, and a mismatch is a
kill criterion rather than a correction.
