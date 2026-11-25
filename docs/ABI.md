# The ABI

**71 calls in six groups**, and the number changed with M10: the two untyped `clipboard_*` calls
are DELETED and five typed `dataobj_*` calls replace them (constraint 240). This is the interface of
the operating system — everything else is built on it, and a change here is a change to the
system's contract.

Derived in `research/gap-03.md`, which carries the citation for every borrowed shape. This file is
the normative statement; the research file is the evidence. Where they disagree, this one is wrong
and should be corrected here.

Option A does not implement all 71 in v1 — see `../MILESTONES.md` for the subset per milestone,
and note that A's realised surface is **59 calls** as of M10, not the 34 of the original candidate
design and not the ~40 `PLAN.md` §5 costed. `SYS_NAME` in `src/abi.mjs` is the list; the number here
is derived from it and `selfTest()` asserts the two agree.

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
`win_create(w, h, owner, flags, x, y, titleB)` → **fd** in r0, **winid** in r1 · MFILE ENOENT
INVAL NAMETOOLONG
`win_destroy(fd)` → the number destroyed in r0, their winids as u32 in the byte region · BADF INVAL
`win_set(fd, what, …)` → 0 · BADF INVAL **EHOSTGONE**
`win_surface(fd, w, h)` → 0 · BADF INVAL **ENOMEM** **EHOSTGONE** — `w` × `h` DEVICE pixels, and
the kernel allocates it
`win_draw(fd, nops, byteregion = nops × 32 B)` → 0 · BADF INVAL **EHOSTGONE**
`win_raise(fd)` → 0 · BADF INVAL **EPERM** (a modal blocks it) **EHOSTGONE**
`win_poll` DOES NOT EXIST, and that is the design: the fd `win_create` returns is read with
`read(2)` and waited on with `poll(2)`
`dataobj_create(offerMask)` → **fd** in r0, the offer the kernel SETTLED ON in r1 · INVAL EMFILE
`dataobj_set(fd, format, flags)` → bytes written, payload in the byte region · BADF INVAL **NOTSUP**
(never offered) **PERM** (published, therefore sealed) **FBIG** **NOMEM**
`dataobj_get(fd, format, offset)` → this chunk's count in r0, the format's TOTAL length in r1 ·
BADF INVAL **NOTSUP** **ENOENT** (offered, not yet written)
`dataobj_offer(fd, where, winfd, effects)` → 0 · BADF INVAL **PERM** (no button down) **BUSY** (one
drag at a time) **EHOSTGONE**
`dataobj_open(where, winfd)` → **fd** in r0, the object's offer in r1 · INVAL **ENOENT** (empty
clipboard, or no uncollected drop) EMFILE
`clipboard_read` / `clipboard_write` **DO NOT EXIST**: they took bytes with no format tag, which is
the ABI defect `docs/designs/REVIEW-FINDINGS.md` §2 named (constraint 240)
`notify(specB)` → id · ACCES
`tty_get(fd)` / `tty_set(fd, termiosB)` — ICANON ECHO ISIG, VMIN VTIME VINTR VQUIT VSUSP ·
NOTTY BADF INVAL
`tty_winsize_get` / `tty_winsize_set(fd, rows, cols)` — a set on the master raises **SIGWINCH** on
the slave's foreground pgrp
`pty_open()` → master in r0, slave in r1

### The window group, as M7 built it

**Three calls, numbers 48, 49 and 50**, appended and never renumbered. Everything a window SAYS
comes back through `read(2)` on the fd, and everything it SHOWS goes out through `write(2)`, so
there is no `win_read`, no `win_poll` and no `win_write`.

**`win_create` returns BOTH an fd and a winid, and it needs both.** The fd is what the process
waits on — a process has one futex word and one outstanding call, so a bare winid would leave a
process holding two windows unable to be woken by either (constraint 42). The winid is what
ANOTHER process names to parent a window onto this one, and a process holding an fd for a window
it did not create is not expressible. `owner` MAY name a window in another process; it must name a
live one, and ENOENT says so.

**`win_destroy` returns the LIST of winids it destroyed**, oldest ancestor first, and closes the
caller's fd. Destroying a parent destroys its children, so ONE call closes SEVERAL windows — a
caller told only "ok" would keep fds for windows the kernel has forgotten. SerenityOS's
`destroy_window` returns the same list for the same reason.

**A window event is a 16-byte record**, `WEV_*` in `src/abi.mjs` with one codec used by the kernel
that writes it and the libos that reads it. Fixed width, because a read that could split a record
would make one key press two readiness edges: the kernel floors every window read to a whole
number of records and answers **EINVAL** — never a short read — for a buffer that cannot hold one.

| type | carries |
| --- | --- |
| `WEV_KEY` | TWO KINDS, told apart by `a`. A key that is BYTES carries its UTF-8 INLINE: `a` is the length 1–4 and `b` the bytes, little-endian. A key that is a KEYSYM carries `a == 0` and a `WKEY_*` in `c` (M18, below). `mods` carries SHIFT/CTRL/ALT/META for a reader that wants them, never for deriving the byte |
| `WEV_RESIZE` | `a` = columns, `b` = rows. CELLS and not pixels, because a terminal needs it for `tty_winsize_set`; the pixel box is published in `/proc/<pid>/win/<winid>` |
| `WEV_CLOSE` | the X button was pressed. M7 DELIVERS it and the frame still goes; M9 is what lets the process refuse |
| `WEV_FOCUS` | `a` = 1 entering, 0 leaving |
| `WEV_DESTROYED` | `a` = the winid that went. The last record a destroyed window holds, so a process whose window was destroyed by ANOTHER process's call learns why rather than reading a bare errno |
| `WEV_DRAG_ENTER` / `WEV_DROP` | M10. `a`, `b` = the position in the window's own unit — surface pixels for a surfaced window, CELLS for a text one (constraint 248) — and **`c` = the OFFER MASK**, so a target can decide whether it can accept before any bytes exist |
| `WEV_DRAG_LEAVE` | the pointer left. No payload: a target that got an ENTER must get this, or its highlight never goes away |
| `WEV_DRAG_DONE` | to the SOURCE's window: `a` = the effect that took place (0 for nothing), `b` = the target winid or 0. A MOVE source cannot know whether to delete the original without it |
| `WEV_CLIENT` | M16. `a`, `b` = the client CONTENT box in DEVICE pixels — the unit `win_surface` takes — and `c` = the device-pixel ratio in `DPR_FIXED_ONE` units, because a process has no other route to it. NOT `WEV_RESIZE`: that one carries cells, and a reinterpretation would resize a terminal's grid to 640×440 columns |
| `WEV_WHEEL` | M17. `a` = the x delta, `b` = the y delta, both SIGNED, `c` = the aim point packed by `packWheelPoint`. **Deltas and point are in the window's own unit** — surface pixels for a surfaced window, CELLS for a text one (constraint 248) — and never device px. **A positive `b` scrolls toward the END of a list**, the DOM's sign; `wheelAt` restores it with `\| 0`, because a scroll up read with `>>> 0` is four billion (constraint 225). `mods` carries `WWHEEL_PAGE` when the delta is in PAGES instead, and `WWHEEL_COALESCED` when the record is the SUM of more than one notch |

**The queue is bounded and the overflow is defined**: `WIN_EVENT_CAP` records per window, the
NEWEST dropped and counted, published as `dropped` in `/proc/<pid>/win/<winid>`. That is M1's
per-fd event budget (constraint 42), charged against the fd that caused it, so a window nobody is
reading does not starve the same process's pipe.

**TWO EVENT TYPES COALESCE INTO THE TAIL RECORD RATHER THAN LAP THE QUEUE**, and the merge is
counted as `coalesced` beside `dropped`. `WEV_CLIENT` REPLACES the tail — a stale client box has no
history worth keeping — and `WEV_WHEEL` SUMS into it, which is why a program MUST read a
`WWHEEL_COALESCED` record as a sum: scrolling one notch's worth per record loses the rest of the
gesture. The kernel is the only thing that may claim it coalesced, so `WinMgr.feed` masks
`WWHEEL_COALESCED` out of anything the page posts. `queued` still counts events OFFERED, so a
merged notch does not raise it and a host MUST NOT read `offered - queued` as notches lost.

**A KERNEL-AUTHORED EVENT TYPE POSTED BY THE PAGE IS REFUSED AND COUNTED** (`forgedKernelEvents`):
`WEV_STATE`, `WEV_ITEM` and `WEV_CLIENT` are facts the kernel establishes, so the page's input port
is not a route to them. A wheel is NOT on that list — a wheel is a browser event and the page is its
only honest source — which is exactly why the bit the kernel owns there is masked instead.

**`/proc/<pid>/win/<winid>` is a file**, named by winid and not by fd — a window may be held on
several fds through `dup`, and an owner in another process has no fd for it at all. Each file
publishes the fds that DO reach it, so the two namespaces can be read against each other.

**`EHOSTGONE` is the window's hangup** (constraint 159): a read after the destroy notice, and
every write, answer it. **ENXIO is gone with `/dev/console`** — it answered "this name exists and
its device does not", and a window is no longer a name.

### The surface, as M8 built it

**THE KERNEL OWNS IT AND A PROCESS DRAWS BY SENDING COMMANDS.** `win_surface` asks for `w` × `h`
device pixels; the kernel allocates, accounts and may revoke them, and the process is handed
NOTHING — it holds only integers (constraint 15). `win_draw` carries a DISPLAY LIST in the byte
region it already has, which is one syscall per batch rather than one per operation.

**The transferred `OffscreenCanvas` this document used to specify was measured and rejected.** It
does not arrive at a process that is spinning, and does not arrive at one parked in
`Atomics.wait` — which is the state a process is in during the very syscall that would carry it.
`bench/m8-surface/probe.py` is the measurement, constraint 219 the record and
`docs/DECISIONS.md` D31 the choice.

**A display-list op is 32 bytes**, `DL_*` in `src/abi.mjs` with one codec used by the process that
writes it, the kernel that counts it and the page that replays it. A u16 op, a u16 flags, six i32
arguments and a reserved word. `DL_MAX_OPS` — how many fit in one call — is DERIVED from
`MAX_INLINE`, and the libos splits a longer list rather than refusing it.

| op | arguments |
| --- | --- |
| `DL_CLEAR` | `a0` = rgba. The whole surface, FILLED and not cleared, so a process that asked for opaque white does not get transparency |
| `DL_FILL_RECT` | `a0..a3` = x, y, w, h; `a4` = rgba |
| `DL_STROKE_RECT` | `a0..a3` = x, y, w, h; `a4` = rgba; `a5` = line width |
| `DL_LINE` | `a0..a3` = x0, y0, x1, y1; `a4` = rgba; `a5` = line width |
| `DL_TEXT` + `DL_TEXT_DATA` | M15. The header is `a0`, `a1` = x, y (TOP-left), `a2` = px size, `a3` = the byte length, `a4` = rgba, with `DLT_BOLD` / `DLT_MONO` / `DLT_RIGHT` / `DLT_CENTER` in flags; then `ceil(len / 24)` `DL_TEXT_DATA` records carrying the UTF-8 in `a0..a5` as little-endian words. A record is 32 bytes and a string is not, so the run is a header plus continuations — and a header whose data is missing is refused WHOLE by the kernel, because half a filename reads as a filename (constraint 293) |
| `DL_CLIP` | M17. `a0..a3` = x, y, w, h in SURFACE px, like every other display-list coordinate. It INTERSECTS, as a canvas clip does, so two viewports in one batch need a `DLC_RESET` between them; `flags & DLC_RESET` drops the clip instead and `a0..a3` are then ignored. **It is the first op that outlives itself**, so `replay` resets the clip at the top of every batch — a clip left set by batch N would make batch N+1 draw nothing, which a reader sees as a window gone blank with no error anywhere |

**Every colour is `0xRRGGBBAA`**, and `src/abi.mjs` renders it for both consumers: `cssColor` for a
canvas (alpha 0–1) and `pixelColor` for a pixel read back with `getImageData` (alpha 0–255). The
two APIs disagree about alpha, and a check that rendered the colour itself reported four correct
pixels as four failures (constraint 224).

**The arguments are signed; the colour slot is read unsigned.** A rectangle may start off the left
edge of a surface, and `0xRRGGBBAA` with alpha set is negative as an i32.

**A `DL_CLIP` THAT NAMES NO REACHABLE PIXEL IS REFUSED, WHOLE BATCH, EINVAL**: `w <= 0`, `h <= 0`,
or a rectangle entirely outside `win_surface`'s extent. The check runs before anything is drawn and
before the batch is charged. A PARTIALLY off-surface clip is ACCEPTED deliberately — a list view MAY
name a viewport that overhangs, and a row drawn at a negative offset MAY be clipped by a rect with a
negative y, so containment is not required and the far edge is exclusive. A reset is not
rect-validated at all, since it takes no rectangle. A window with no surface answers EINVAL for the
older reason: there is nothing to draw on, and the clip rect is never inspected.

**`WEV_POINTER` is how a surface is reached**: `a` and `b` are x and y in SURFACE pixels, `c` is the
button mask, and `mods` carries `WPTR_DOWN` / `WPTR_UP` / `WPTR_MOVE` beside the keyboard
modifiers. A move is sent only while a button is down, because a hover would overflow the window's
256-record queue in about a second (constraint 223). **M18 added `WPTR_CLICK2` and `WPTR_CLICK3` to
the same field, on the DOWN record only** — see below.

**One content mode per window**: `write(2)` on a surfaced window is EINVAL, because the page has
replaced the text widget with a canvas and cells have nowhere to go (constraint 221).

### Modality and the close, as M9 built them

**`win_set(fd, WIN_SET_MODAL, scope, mode)` sets TWO AXES**, because an owned window is two things
at once (constraint 227). `scope` says WHICH windows are affected and `mode` says WHAT happens to
them; a window with no owner may not be window- or app-modal, and `win_set` answers EINVAL rather
than storing a modality no rule covers.

| scope | affects |
| --- | --- |
| `WMODAL_NONE` | nothing |
| `WMODAL_WINDOW` | its owner, and the owner's ancestors |
| `WMODAL_APP` | every window of the OWNER's process — not the dialog's, which is the whole point of a broker |
| `WMODAL_SYSTEM` | everything outside the modal's own subtree |

| mode | behaviour |
| --- | --- |
| `WMODE_MODELESS` | ordinary; an owned window that happens to have an owner |
| `WMODE_PASSIVE` | rides up with its owner, blocks nothing — a tooltip |
| `WMODE_RENDER_ABOVE` | rides up with its owner, blocks nothing — a palette |
| `WMODE_BLOCKING` | rides up AND refuses the raise, and its scope's windows get no input |

**`win_raise(fd)` is a syscall because the kernel owns the stack.** It answers **EPERM** when a
modal blocks the window — a rule and not a transient, so there is nothing to retry — and the page
is told which window refused, by `win-blocked`, so a click that does nothing can be explained. On a
grant the kernel posts `win-stack` with the WHOLE order, bottom first: the page renders it and
never decides it (constraint 226, `docs/DECISIONS.md` D32).

**INPUT TO A BLOCKED WINDOW IS SUPPRESSED** — keys, pointers and (since M17) wheels. A resize, a
focus change, a close request and a destroy notice still arrive, because a window that missed those
would be wrong about the world once the modal went away. `/proc/<pid>/win/<winid>` publishes
`scope`, `mode` and `suppressed`.

**A CLOSE IS ADVISORY.** The X posts `WEV_CLOSE` and nothing else; the frame stands until the
process calls `win_destroy`. A process that ignores it is caught by the not-responding detector it
already has (constraint 228).

### The data group, as M10 built it

**FIVE CALLS, AND THE CLIPBOARD AND A DRAG ARE ONE OBJECT PUBLISHED TO TWO PLACES.** `create` and
`set` fill it, `get` reads one format out of it, `offer` publishes it to `DOBJ_WHERE_CLIPBOARD` or
`DOBJ_WHERE_DRAG`, and `open` takes an fd onto whatever is at `DOBJ_WHERE_CLIPBOARD` or waiting at
`DOBJ_WHERE_DROP`. One enum serves both directions and each call refuses the other's value by name,
so a caller that confused them is told rather than answered 0 (constraint 240).

**A DATA OBJECT IS A FILE DESCRIPTION**, `F_DATA`, for the reason a window is one: it is a
kernel-owned thing a process must be able to release, and `terminate()` runs no cleanup — so the fd
table's existing refcount and teardown sweep are what free it, and a process still holds only
integers (constraints 15, 241). **`read(2)` and `write(2)` on one are -EINVAL**, which is the
deleted clipboard call's defect stated as code: an untyped read of a typed object is the thing this
group exists to remove.

| format | carries |
| --- | --- |
| `DOBJ_TEXT` | UTF-8 |
| `DOBJ_PATHS` | Windows' CF_HDROP as this filesystem spells it: ABSOLUTE paths, NUL-separated, no trailing NUL |
| `DOBJ_PNG` | opaque PNG bytes. Nothing here decodes PNG — it is the proof that bytes of a format the system does not understand cross two processes untouched |
| `DOBJ_BITMAP` | `[u32 w][u32 h]` then RGBA8 rows, top row first. The one image format a display list can draw, one `DL_FILL_RECT` per pixel |

**THE OFFER IS A BITMASK, DECLARED AT CREATE AND NEVER WIDENED**, and it travels in a register and
in an event record's `c` field — because a drop target must decide whether it can accept DURING the
gesture, before any bytes exist. `fmtBit` / `fmtsOf` / `fmtName` in `src/abi.mjs` are the one
packing. The table is CLOSED rather than registerable, which is a departure from the review that
asked for this and is recorded as one (constraint 240).

**PUBLISHING SEALS**, so `dataobj_set` afterwards is -EPERM: two processes reading one object must
not be shown different bytes (constraint 242).

**A PAYLOAD LARGER THAN ONE BYTE REGION IS WRITTEN WITH `DOBJ_F_APPEND`** and read back by looping
on an offset against the total in r1 — `write(2)`'s short-count contract, both directions
(decision 4). `DOBJ_MAX_BYTES` is the object's ceiling (-EFBIG) and `DOBJ_BUDGET_BYTES` the
system's (-ENOMEM): two facts, two errnos (constraint 246).

**THE DRAG SESSION IS THE KERNEL'S, AND THE PAGE REPORTS ONLY WHERE THE POINTER IS.** `drag-at` and
`drag-drop` are page messages, not syscalls; the kernel resolves them to a target — refusing a
window a modal blocks — and posts `win-drag`, `win-drag-target` and `win-drag-end` so the page
renders a target it was handed. **There is no `DRAG_OVER`**, on queue arithmetic: 256 records is
about a second of motion samples and `push` drops the newest, which would be the drop itself
(constraint 243). A drag needs a button the kernel saw go down (-EPERM otherwise), there is one at
a time (-EBUSY), and it is bounded by IDLE time rather than by its own age (constraint 244).

**THE PAYLOAD OUTLIVES ITS SOURCE, which is the whole point of putting it in the kernel.** The
clipboard slot holds a reference, so copy-then-quit-then-paste works; a live session holds one, so a
source that dies mid-drag still delivers. A drop is retained ONLY if its event actually queued, and
is collected exactly once (constraints 241, 245).

**`/proc/dataobj`** publishes every live object, the clipboard, the session and the budget. Not
under a pid, because the clipboard outlives the process that filled it — the creator is a column
instead.

### Keys that are not bytes, and the click count, as M18 built them

**NO NEW SYSCALL.** Three additions to records that already exist: a keysym space on `WEV_KEY`, a
fourth modifier bit, and two click-count bits on `WEV_POINTER`.

**A `WEV_KEY` IS EITHER BYTES OR A KEYSYM, AND `a` SAYS WHICH.** `a` in 1..4 is a byte length;
`a == 0` with `c` in 1..`WKEY_MAX` is a keysym. The two are **disjoint and exhaustive by
construction**, not by convention: `keyBytesOf` answers `[]` for a keysym record and `keysymOf`
answers 0 for a byte record, `selfTest` asserts both directions over the whole table, and
`keyBytesOf(ev).length === 0 && keysymOf(ev) === 0` therefore means a corrupt record rather than a
third kind of key. Constraint 299 carries why `a == 0` was safe to pick, and it was measured before
it was picked.

| keysym | `WKEY_*` |
| --- | --- |
| arrows | `LEFT` 1, `RIGHT` 2, `UP` 3, `DOWN` 4 |
| navigation | `HOME` 5, `END` 6, `PAGE_UP` 7, `PAGE_DOWN` 8 |
| editing | `DELETE` 9, `INSERT` 10 |
| the context-menu key | `MENU` 11 |
| function keys | `F1` 12 … `F12` 23 |

**DENSE AND FROM 1, with `WKEY_MAX` 23.** Dense so a reader may switch on it and a table may be
indexed by it; from 1 because 0 is what `c` holds on a key that IS bytes, and a zeroed record must
not decode as a keysym. **`keysymOf` VALIDATES THE RANGE** rather than returning whatever `c` held:
a sym past `WKEY_MAX` is a record this build cannot name, and 0 is the honest answer — a program
switching on it falls through to its default instead of acting on a number it does not understand.
There is no counterpart to `packKeyBytes`, because a keysym needs no packing.

**ENTER, TAB AND BACKSPACE ARE BYTES, NOT KEYSYMS, AND THAT IS DELIBERATE.** `bytesForKey` already
spells them 10, 9 and 127 (`src/wm/terminal.mjs` is where that mapping lives), so `keysymOf`
answers **0** for all three and every program that reads them today keeps reading bytes. A keysym
row for any of them would take the key away from all of them. Two consequences a caller must plan
for: Windows 7 binds **Backspace to Back** in a file list and that arrives as a byte, while
**Alt+Left** arrives as a keysym with `WMOD_ALT` on the record — the same verb over two different
mechanisms, which is why `www/m18.html` drives both.

**IT IS ALSO WHY ENTER CANNOT PROVE THE KEYSYM PATH.** Enter reaches a process on a tree where the
table does not exist, so an Enter clause is green with M18 unimplemented. The assertable claim is an
arrow MOVING a cursor and Enter then opening the row the arrow reached (constraint 299).

**`WMOD_META: 0x8` is the fourth modifier**, beside `WMOD_SHIFT` 0x1, `WMOD_CTRL` 0x2 and
`WMOD_ALT` 0x4. Named META and not CMD or WIN because `KeyboardEvent.metaKey` is what the page
reads, and which physical key sets it differs by platform while the bit does not. It is the bit
M17's wheel flags were pushed off 0x8 to reserve, and the `mods` namespace is asserted as ONE table
in `src/abi.mjs`'s `selfTest` — `WPTR_*`, `WMOD_*` and `WWHEEL_*` together — because three separate
pairwise assertions let a third sub-table collide with either, unseen.

**`WPTR_CLICK2: 0x80` and `WPTR_CLICK3: 0x100` ride the DOWN record and nothing else.** The count is
the PLATFORM's, from the browser's `event.detail`: a double-click has a threshold the reader
configured, and a program that timed two presses itself would disagree with every other application
on their machine. DOWN only, because `detail` is meaningful on the UP of a double-click too and a
program reading both would open a row twice for one gesture. There is no `WPTR_CLICK4` — a count
past 3 is still a third click, since a quadruple-click is not a gesture Windows 7 has.

**THE COUNT MUST BE READ OFF THE EVENT THAT CARRIES IT.** `pointerdown.detail` is **0 in both
engines** and only `mousedown` carries the platform's count — measured, constraint 300 — so a host
that builds the DOWN record from a pointer event delivers no click count to any program, with
nothing thrown anywhere.

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
