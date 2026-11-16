# Decisions

Every choice that shaped the project, what it rejected, and what settled it. The point of this
file is that a new reader does not re-open a closed question — and can tell the difference between
a decision backed by a measurement and one backed by judgement.

**Evidence column:** *measured* = a number from a harness in this project. *spec* = normative
specification text. *source* = read from someone else's code. *judgement* = a call made on the
reasoning given, with no measurement behind it. Treat the last category as the one most worth
challenging.

---

## D1 · A new repository, not a refactor of webxp

**Decided:** new repo. **Rejected:** evolving webxp in place.

webxp's app contract is `mount(root)` — the app *is* its window — and its apps import
`../webxp/shared/fs/fs.mjs` directly. Both are load-bearing for all 42 apps, and "apps may not import the
kernel" is precisely the thing being removed. Refactoring means fighting 40 call sites to arrive
somewhere you could have started.

What is carried across: `../webxp/shared/fs/vfs.mjs` (1,301 lines of inode logic), `../webxp/src/window.mjs` (836),
the terminal's parser (453), and the CDP harness. What is not: the app contract, and the assumption
that file data is a JavaScript string.

*Evidence: source. See `../CONTEXT.md` §4.*

## D2 · The kernel is a dedicated Worker, never the main thread

**Decided:** kernel in a Worker. **Rejected:** kernel on the main thread (which is what Browsix
did).

`Atomics.wait` throws `TypeError` in a window agent — window agents are created with
`[[CanBlock]]` false — so the kernel must be the non-blocking side regardless. But the deciding
number is latency under load: with the main thread 60% busy, **52 of 20,000 syscalls exceeded
10 ms**, max 400 ms during a deliberate 400 ms synchronous task. A worker kernel had **0 of 20,000
past 0.52 ms**.

Window dragging, layout and raster all live on the main thread. That is the normal case, not the
pathological one. Browsix's main-thread kernel was forced by nested workers being unavailable in
2017; that constraint is gone.

*Evidence: measured + spec. Constraints 1–3.*

## D3 · Synchronous syscalls over a SharedArrayBuffer, not an async API

**Decided:** blocking. **Rejected:** async/promise-based syscalls.

The blocking channel measured **14.0 µs** mean against async `postMessage`'s **17.3 µs**. Blocking
is *faster*, so the usual argument for async — that blocking costs something — is simply false
here. And a synchronous ABI is what lets a process be written as ordinary straight-line code that
calls `read()` and waits, which is the whole point of a POSIX-shaped runtime.

*Evidence: measured. Constraints 5–6.*

## D4 · Per-process bounce buffer, not the process heap mapped as the SAB

**Decided:** a separate per-process SAB carrying arguments, with offsets in the message.
**Rejected:** mapping the process's own memory as the shared buffer.

This is the one transport already measured dead. Browsix mapped the heap and it did not survive a
WebAssembly target. Its replacement — a bounce buffer — measured **0.2% average, 1.2% maximum**
overhead on SPEC. The copy is noise; the `postMessage` is the cost.

*Evidence: source + published measurement. Constraint 8.*

## D5 · `spawn` only. No `fork`

**Decided:** `posix_spawn`. **Rejected:** emulating fork. **Re-examined at the user's request, and
the original justification was wrong.**

The first version of this decision said Browsix concluded fork is fundamentally incompatible with a
blocking syscall channel. It did not. Browsix's `_sync-syscalls` branch runs `read` over the
blocking channel and aborts only on `fork`, gated on `#if EMTERPRETIFY_ASYNC`; the later branch
says `TODO:`, not *impossible*. Its §6 Discussion states that a `setcontext` equivalent plus
SharedArrayBuffers "would let BROWSIX support fork … as a synchronous system call" — and that
ingredient shipped in 2019 as Emscripten Asyncify.

Fork then got **demonstrated working in Chrome 157**, twice: `sharrattj/dash` doing command
substitution and a subshell through real `__wasi_proc_fork` under `@wasmer/sdk` 0.19.1 (2–5 ms
small heap, ~20 ms at 32 MiB), and a from-scratch `wasm-opt --asyncify` build forking across a
Worker boundary through the `Atomics.wait` channel — child returned 0, parent the pid, locals
restored, 10 ms at 16 MiB.

**The decision stands, on three replacement grounds.** A JS process cannot be snapshotted at any
price, and v1 runs JS. A stock `wasm32-wasip1` binary cannot fork either — it needs wasix-libc,
`wasm-opt --asyncify` and `shared` memory, which contradicts Option B's "unmodified binaries"
premise. And the cost is a whole-heap memcpy that must run on the kernel worker's own thread
(a `WebAssembly.Memory` buffer is neither detachable nor cloneable): 16.6 ms at 64 MiB, 85.7 ms at
256 MiB, with the kernel servicing nobody meanwhile, plus Asyncify's ~50% build-wide tax.

**The casualty was also misidentified.** `( subshell )` costs almost nothing. The real loss is
concurrency between two shell-internal commands in one pipeline, which deadlocks when the pipe
buffer fills and which every fork-free shell solves with a thread or a state-carrying re-exec.
Budget a second shell worker. Constraint 20a.

*Evidence: measured + source + spec. Constraints 20 and 20a, `ABI.md` §3,
`research/gap-07-fork.md`.*

## D6 · First-party-only threat model for v1

**Decided:** all apps are written by the project author; isolation is for robustness and namespace
hygiene, not security. **Rejected:** a third-party app tier in v1.

The forcing constraint is not effort, it is physics: a cross-origin iframe is in a different
**agent cluster**, so the kernel's SharedArrayBuffer arrives there as `messageerror`. Measured
across seven iframe configurations. **Per-app-origin isolation and a shared blocking syscall
channel are mutually exclusive.** Puter has the first; this project takes the second.

Secondary: per-origin costs 68–80 MiB and ~80 ms cold start, 40× a Worker — though those figures
are n=1 and the conclusion does not depend on them.

Consequence: M6's realm lockdown is **hardening, not a security boundary**, and must be labelled
that way everywhere it appears. Same-origin is not a security boundary.

*Evidence: measured + spec. Constraints 10–13, 41.*

## D7 · The window ABI is `win_*` calls, not a `/dev/wm` device file

**Decided:** `win_*`. **Rejected:** windows as a device file, which is how the minimal-kernel
candidate kept its syscall count at 34.

A window surface is a transferred `OffscreenCanvas`, and a file write cannot transfer a handle.
Picking one and saying so matters because the first draft of the plan mixed both.

The honest cost: option A's ABI is **~40 calls, not 34**, once `poll`, `dup2`, a window surface and
the data objects are restored.

*Evidence: judgement, forced by spec on transferables. `PLAN.md` §5.*

## D8 · A window is a file descriptor

**Decided:** `win_create` returns an fd; `poll()` is the single wait primitive for every event
source. **Rejected:** a bare winid with its own `win_poll`.

A process has exactly one futex word, so it can be parked on exactly one thing. With a separate
per-window poll, a process with two windows cannot wait on both, and a process with one window plus
a pipe cannot wait on either without ignoring the other. That breaks a stated acceptance criterion
outright.

*Evidence: judgement, forced by the one-futex-word design. Constraint 42.*

## D9 · POSIX metadata in RAM, journalled; file data flat in OPFS by inode

**Decided:** authoritative in-memory inode table, persisted as alternating OPFS superblock
snapshots plus an append-only journal, with blobs in a flat directory named by inode number.
**Rejected:** an IndexedDB side index; a sidecar metadata file per inode.

OPFS has no mode bits, no uid/gid, no symlinks, and no settable mtime, so metadata has to live
elsewhere. In RAM it costs nothing to read: `stat` 27 ns, path walk 370 ns, boot 7.2 ms at 10k
inodes — so the store choice does not affect syscall latency at all.

Flat is forced: Chrome 157 has no `FileSystemDirectoryHandle.move()` and Safari 27.2 rejects the
one-argument rename, so the only portable primitive is `fileHandle.move(dirHandle, name)`.

It is also the better design independently — it is how ext4, APFS and ZFS work. Rename becomes a
metadata edit, renaming a directory of 10,000 files is O(1), hard links are expressible, and
open-but-deleted files work.

**Known ceiling:** the whole table loads at boot, so this does not support paging metadata lazily
and needs rework past ~100k files.

*Evidence: measured + spec. Constraints 25–27, `../CONTEXT.md` §1.*

## D10 · Buffered writes; `fsync` is a separate call

**Decided:** write-behind, flushing on `fsync`, on snapshot, and when idle. **Rejected:** flush per
mutation.

`flush()` is 260 µs against a 5 µs 4 KiB write. Flushing per write makes the filesystem 50× slower
for durability nobody asked for. This is POSIX's own contract — `write()` returns when the data is
buffered, `fsync()` forces it.

Write ordering is **blob → flush → journal record → flush → apply in memory**: data before
metadata, because an orphaned blob is collectable garbage while a metadata record pointing at
absent data is corruption.

*Evidence: measured + spec. Constraint 23.*

## D11 · A bad filesystem image mounts read-only and reports. It never reseeds

**Decided:** refuse to proceed. **Rejected:** webxp's behaviour, which writes a fresh image.

Reseeding is silent data destruction presented as success: one bad byte in the superblock, 10,000
intact files, and the boot path overwrites the evidence and comes up clean. Fine for a fixture,
catastrophic the moment a user saves anything.

Journal replay stops at the first bad CRC or torn length prefix and **reports the discarded tail**.
This is standard write-ahead-log recovery — Postgres, SQLite, Kafka and ext4's jbd2 all do it.

Secondary benefit: it protects against your own bugs. Ship a malformed superblock and you get a bug
report with the error in it, rather than a user who lost everything and reports "works fine".

*Evidence: judgement, with precedent. Constraint 28.*

## D12 · A credential is an argument on every path call, not instance state

**Decided:** `{uid, gid, caps}` passed per call, read only from the process table and never from
process-controlled memory. **Rejected:** webxp's single global uid/gid.

Mode bits mean nothing without a caller identity. This is the change that makes webxp's permission
code actually enforce something, and it touches nearly every method in `vfs.mjs` — which is why
the port is 4 days and not 1.

*Evidence: judgement. Constraint 29.*

## D13 · Frame-only glass, DOM `backdrop-filter`, not a canvas compositor

**Decided:** glass on the caption and border ring, opaque client area, via CSS. **Rejected:** a
Canvas/WebGL compositor rendering the true additive composite (that is option C).

Frame-only is *more* faithful, not less: Windows 7's own rule allows glass only in "small regions
touching the window frame without text". It is also ~11× cheaper, which matters against a measured
budget of 58–63 M blurred device px per frame.

The case for the compositor is real — the authentic highlight is a bitmap anchored to the *monitor*,
parallaxed at 0.1, which wants a compositor — and it buys live thumbnails and genuine Aero Peek.
But it discards all of webxp's window code and its central assumption (that the Aero composite is
reachable from CSS via a referenced SVG `feColorMatrix`) is **the least verified claim in the
research set**. One day of spike work before committing.

*Evidence: measured + source. Constraints 34–36, 49; `PLAN.md` §6.*

## D14 · `COEP: require-corp`, and no third-party iframes, ever

**Decided:** `require-corp`. **Rejected:** `credentialless`, which is Chrome 96 / Firefox 119 /
Safari never — a relaxation, not a plan.

Consequences accepted deliberately: every font, icon and asset self-hosted; every remote image
carries `crossorigin="anonymous"`; GitHub Pages and bare S3 cannot host this.

**What this does *not* cost, measured rather than assumed:** data and tile services work fine.
`bench/coep-tiles/` loads OpenFreeMap vector tiles plus OSM, OpenTopoMap and Esri raster tiles
under full isolation with zero blocked requests, because `require-corp` accepts a resource fetched
in CORS mode and they all send `Access-Control-Allow-Origin: *`.

An in-OS web browser remains impossible — but mostly because of the embedded sites' own
`X-Frame-Options`, which is not this project's doing.

*Evidence: measured + documented. Constraints 30–33, `bench/coep-tiles/README.md`.*

## D15 · The real-Linux guest is an app, not part of the OS

**Decided:** demote it. **Rejected:** a v86 Linux guest as a load-bearing process with a shared 9P
filesystem (designed in full at `designs/hybrid-guest.md`, 133 days).

A full-system emulator is a black box behind a serial cable: the host cannot see guest processes or
route a window to a guest pid. Running real Linux does not buy a kernel boundary; writing the
syscall channel does.

The design also had two concrete protocol defects — Linux 2.6.34, the kernel in the measured v86
image, has **no 9P2000.L operations at all**, so the whole `.L` server was a dialect the guest
cannot speak; and `Tflush` was absent though virtio-9p sends it on every interrupted request, so
Ctrl-C wedges the guest. *A newer image fixes the first; the defect is the method, not the
approach.*

As an app it costs weeks rather than months, because it needs no protocol work at all.

*Evidence: source + judgement. `PLAN.md` §7.*

## D16 · Risk order, not visibility order — with one exception

**Decided:** the riskiest assumption is tested first. M0 is one day and precedes everything.
**Exception:** M4a puts a real window on screen at day ~22.

**The rationale I first gave for that exception does not survive the evidence.** I wrote "30 days
with nothing visible is how solo projects die." The release record says otherwise: **SkyOS** had by
far the most visible cadence in this family — numbered builds to 6947, a paying beta from 2003,
compositing demos in 2006 — and stopped in 2009. **Haiku** went five years and eleven months with
no release at all, in its own words, and still ships. The reading is `inferred`, n=4, across
projects differing on many axes at once, and no source was found that tests it.

The better-evidenced ground is the **AtheOS** record, where the author's own farewell names
tiredness, a theory course, flying lessons, a plane and a dead PC, with a fork as what finished it.
So the defensible claim is narrower and more useful: **a solo author's motivation is a load-bearing
component with no redundancy.** M4a is therefore a promise to the *author*, not to an audience —
and the same evidence is the argument for `MILESTONES.md`, this file and `PLAN.md` §10 existing at
all, because the plan has to survive a multi-week gap.

The decision stands unchanged: M4a is two days and it deletes its own special case.
`research/09-hobbyist-os-actions.md`, D16.

M4a's window is explicitly special-cased rather than an ABI, and M7 deletes the special case. That
has to be said in the code or it becomes the architecture by accident.

*Evidence: judgement. `PLAN.md` §8.*

---

## D17 · File data is copy-on-write, not metadata-only durability

**Rejected: declaring the durability guarantee metadata-only.** That is the cheaper answer and it
is what the journal plus alternating superblocks already give for free. It is also exactly ext4's
`data=writeback`, which is not ext4's default precisely because it leaves **intact metadata
pointing at torn data** — a file whose mode, size and name are all correct and whose contents are
half of two different writes.

**Chosen: copy-on-write the blob.** An overwrite stages a new generation, writes it, flushes it,
and only then swings the inode's reference in the journal. This is cheap here in a way it is not in
a real filesystem: a blob is named `<ino>.<gen>`, so the swing is a reference change rather than a
copy, and freeing the old generation is removing one directory entry.

**Why the choice had to be made at M2 and not later.** The spec's own framing is the argument:
discovering this after a user has files is the bad outcome. Metadata-only durability is not a
guarantee users read — it is one they violate by accident, once, with a file they wanted.

**One exception, and it is load-bearing rather than a loophole.** A write entirely at or beyond the
committed size appends in place, because the committed size does not name those bytes and a torn
append can therefore only damage bytes nobody committed. Without it a sequential appender copies
its whole file on every `fsync`, which is quadratic; with it, 10,000 files cost 0 copy-ups.

**The exception's test is the trap.** It must read the inode's *current* committed size. Written
first against a per-description snapshot, it let a second fd overwrite committed data in place:
fd1 appends past the size and fsyncs, publishing a larger one, and fd2 still believes the size it
saw at open, so its write below the new size looks like an append. A per-description cache of a
value another description can change is a stale read by construction. This was found by attacking
the built code with two real file descriptions — not by review, and not by a mutation.

*Evidence: measurement and precedent. `docs/CONSTRAINTS.md` 60, `research/09-hobbyist-os-actions.md`
§5 (Phantom's three blocks per page, ext4's defaults), and the two-fd attack recorded in
`MILESTONES.md` §M2.*

---

## D18 · A generated filesystem is read-only, and there is one adapter for all of them

**Decided:** `/proc` and `/dev` are each a pair of pure functions — `lookup(rel)` and `list(rel)` —
behind one `SynthFS` adapter that renders every read method and refuses every mutation with one
configured errno. **Rejected:** a procfs and a devfs each implementing the VFS surface; a writable
`/proc`.

Fourteen methods implemented twice is fourteen chances for one of them to answer when the other
refuses. The failure that shape produces is specific and bad: a `chmod` on `/proc/<pid>/status` that
returns 0 and forgets, so a caller believes a permission it does not have. One refusal site means
the question "can this be written" has one answer.

Adding a generated FILE is then a row in a table, and adding a generated FILESYSTEM is two
functions. `/usr` is the third user of the same adapter with a different content source, which is
the evidence the abstraction is at the right altitude — the second caller justifies it and the third
means it was overdue.

**Known ceiling:** a `SynthFS` holds its whole content in memory per read, and `/usr` holds its
whole volume. That is the right trade for files measured in hundreds of bytes and the wrong one for
a large read-only volume, which wants the lazy ranged read `providers.mjs` already implements.
Constraint 78.

*Evidence: judgement, with one measurement. Constraints 74, 77–79.*

## D19 · A volatile generated file publishes no size

**Decided:** `stat` on a file whose content is computed per read reports size 0; `fstat` on an open
description reports the snapshot's exact length. **Rejected:** publishing a size from `stat`;
caching the content so the two agree.

Measured: `stat` on `/proc/<pid>/status` reported 147 bytes and the following `read` returned 145.
The file carries the process's syscall counters, so reading it advances them — any size this call
published would be stale before the caller used it. Linux's `/proc` reports 0 for the same reason.

Caching to make them agree was the other way out and is worse: it is exactly what M3's first
negative control breaks, because a cached `/proc` keeps a killed process visible.

The two calls differing is the useful part. `fstat` CAN answer exactly, because `open` snapshotted
the bytes and that length is stable for the life of the fd — which is also why a process reading
`/proc/<pid>/status` in two `read()` calls sees one coherent process rather than half of each.

*Evidence: measured. Constraint 74.*

## D20 · A `poll` timeout rescans, and the wake control widens to match

**Decided:** a parked `poll` rescans its set before answering a timeout, and `--negative
no-poll-wake` removes re-evaluation in BOTH places — the wake hooked on `reply` and the timeout's
rescan. **Rejected:** keeping the timeout's stale publish so the control stays narrow; asserting
the wake's LATENCY instead.

A timeout republished the revents its last scan produced. Those are all zero by construction — a
scan finding anything ready answers instead of parking — so a readiness that arrived without a
`reply` was reported as "nothing became ready", which the caller cannot distinguish from the
truth. Teardown's fd sweep was exactly that case (constraint 115).

Rescanning fixes it and costs the control its subject: measured, `--negative no-poll-wake` went
from 3 red to **0 red in 9.30 s** — the poll was answered correctly, five seconds late, by the
timeout. A control that breaks nothing a check can see is not a control, and the harness refused
it rather than reporting green.

Asserting latency was the other way out and is worse: it is a timing assertion in a suite that has
none, and it would flake on the machine that runs it.

So the flag governs both. The control is named for re-evaluation, re-evaluation happens in two
places, and with neither of them a parked `poll` cannot report truth — which is the claim
constraint 42 actually makes.

*Evidence: measured. Constraints 115, 116.*

## D21 · A program fetch is bounded and retried once; the m4b flake is exposure, not a defect

**Decided:** `programImage` fetches under a 5 s `AbortController` deadline and retries once.
**Rejected:** leaving it unbounded; racing a timer against the fetch; dropping `cache: "no-store"`
so Chrome's HTTP cache would serve twelve of thirteen loads.

`spawn` cannot answer until the program is loaded, so an unbounded fetch makes process creation
hang rather than fail: the caller waits on a reply that never comes, with no errno and nothing in
the trace.

**M5 narrowed what this covers, and the bound is still right.** `SYS_spawn` no longer fetches —
`src/kernel/exec.mjs` resolves a program through the mount table and reads the bytes from the mount
(D22, constraint 123) — so a PROCESS can no longer hang this way. What `programImage` still serves
is the page's own `t: "spawn"`, the supervisor path every bench page boots through, and that is
where the stall was measured. The two changes close one hole from opposite ends: M5 removed the
process's access to the network, and this bounds what remains.

Measured, which is what turned this from a theory into a defect. `bench/kernel-churn/probe.py`
boots kernels and does nothing else: **0 stalls in 360 boots idle, 3 in 540 under threefold
contention — 0.56% per boot**, two of the three on exactly this await. At 0.56% per boot a page
booting thirteen kernels fails about 1 run in 14, and `www/m4b.html` was failing at 1 in 12. The
arithmetic closing like that is the reason this explanation is believed and the five earlier ones
were not.

A racing timer was the other way to bound it and is worse: the losing fetch stays outstanding, so
the connection the stall is about is still held. `AbortController` ends the request.

Dropping `no-store` would have removed twelve of the thirteen network round trips and most of the
exposure, and it is the wrong trade: the harness's whole discipline is that a check must never
read a stale copy of what it is testing, and a cached program is exactly that.

**The flake itself is not a defect in what m4b tests.** It is the only check that boots one kernel
per proof, so it meets the per-boot risk thirteen times; the stall is in the page-to-kernel
bootstrap, before any behaviour under test, and it fails closed — BROKEN, never a pass. The
fresh-kernel-per-proof design stays, because its reason is sound: a zombie sits in a ~2.2 s
quarantine and sharing one kernel would make each proof depend on how fast the last one finished.

*Evidence: measured. Constraints 123, 124.*

## D22 — a program is loaded from the filesystem, and the page's loader stays

**M5.** `SYS_spawn` resolves its path through the mount table and reads the bytes from the mount;
the page's own `t: "spawn"` keeps fetching a URL.

**What it rejected.** One loader for both, which is what existed. It made a process-supplied
string a request origin — `new URL("https://elsewhere/x.mjs", base)` ignores the base — so any
process could have the kernel fetch from the browser's network position and evaluate the reply as
a program. `src/kernel/providers.mjs` is written around the opposite rule for storage ("there is
no path by which a process-supplied string becomes a request origin") and `SYS_spawn` was the hole
in it.

**Also rejected: making the page use the filesystem too.** The page would then have to write every
bench program into a mount before it could run one, which means a filesystem before a kernel. The
distinction kept instead is PRIVILEGE, not convenience: the page is the supervisor, outside the
process boundary, already holding the kernel's whole surface. Two functions rather than one with a
flag, so a reader cannot mistake which side a caller is on.

**What it costs.** A program's only linkable import is an absolute specifier, because a Blob image
has no base for a relative one (constraint 125). Program text on the durable volume is read into
one kernel-owned SAB under a lock (constraint 126). A program may not exceed 1 MiB.

*Evidence: measured — the hole was reproduced from an unprivileged process over six spellings,
and `www/m5.html`'s `no_url` section is that reproduction. Constraints 123, 125, 126, 127.*

## D23 — `cd` is a syscall; `getcwd` is `/proc`

**M5.** `SYS_chdir` is 47. There is no `getcwd`.

**What it rejected.** A `getcwd` call beside it, which would be a second renderer of a fact
`/proc/<pid>/cwd` already publishes — CLAUDE.md's one-source-of-truth rule applied to the ABI
rather than to a module. `src/bin/sh.mjs` reads its own directory out of `/proc` after every `cd`,
which also means the shell cannot disagree with the kernel about where it is: the kernel
normalizes lexically and the shell asks rather than computing.

**Also rejected: a shell-local cwd with no syscall.** Every path call resolves against `p.cwd` in
the kernel (constraint 29's credential rule has the same shape), so a shell that tracked its own
directory would have had to rewrite every relative path before passing it — and `spawn`'s children
would have inherited the wrong one.

*Evidence: judgement, against a measured absence — `slot.cwd` had existed since M2 with nothing
able to move it. Constraint 128.*

## D24 — the two-EINTR delivery rule was left alone

**M5.** A signal interrupts the call in flight AND leaves its SIGPEND bit set, so the next call is
interrupted too. The shell retries past it; the kernel was not changed.

**What it rejected.** Clearing the bit when the kernel interrupts an in-flight call, which is
arguably the correct fix: for a parked process the interruption IS the delivery, and POSIX
delivers once. It was rejected for this milestone on cost, not on merit — it moves a delivery rule
that 332 existing expectations rest on, and `drainSignals`'s `onsignal(bits)` hook would stop
seeing a signal that reached a parked process, which is M1's own mechanism.

**What that leaves.** A documented ABI property a program must tolerate: any call made immediately
after a signal may answer -EINTR. The retry is bounded at one because the entry check clears the
bits it reports. A milestone that changes the kernel instead owes M1's and M4b's signal proofs a
re-run.

*Evidence: measured — Ctrl-C at a prompt printed no new prompt while the shell was alive and still
read the next line. Constraint 131.*

## D25 — the window is a file description, and `/dev/console` is the special case

**M4a.** A terminal process waits on its window and its pty master in ONE `poll`, because the
window is an `F_WIN` file description with a row in the ops table and a row in `pollOne`. The
SPECIAL CASE is narrow and named: there is exactly one console, the kernel creates it when the page
attaches a window, and `open("/dev/console")` is its only producer.

**What it rejected.** Three alternatives, each of which would have been cheaper this week.

- **The page relays keystrokes straight into the pty master through the kernel's message port.**
  ~40 lines, no device, no `F_WIN`. Rejected because it makes the KERNEL the terminal emulator: the
  page would hold a privilege no process can express, and `CLAUDE.md`'s "the shell is a userland
  client of the same ABI" would be fiction at the first window. It also leaves `poll` with nothing
  to wait on, so `docs/designs/REVIEW-FINDINGS.md` finding 1 would be re-opened by the next
  windowed program rather than answered by this one.
- **`win_create` now, returning an fd and an `OffscreenCanvas`.** That is M7 and M8, and M4a's
  budget is two days. Building a third of it here would make the half-built version the thing M7
  has to be compatible with.
- **A `winid` with `win_poll`, as `docs/designs/fidelity-first.md` originally specified.** Refused
  by finding 1 on the evidence: a process has one futex word, so a window that is not an fd needs a
  busy-poll loop to be serviced alongside a pty. Constraint 42 already settled it; this is where it
  is paid for.

**What it costs.** One errno pair to keep straight (ENXIO for a name with no device, EHOSTGONE for
a window that was destroyed, constraint 159) and one explicit `pollWake` the console must perform
itself, because a keystroke arrives by `postMessage` and passes through no reply (constraint 160).

*Evidence: measured — with the shell idle and nothing flowing, the relay's park state reads
`inflight: "poll"` holding kind 5 and kind 8. `scripts/check.py --only m4a`.*

## D26 — the not-responding detector measures uncollected input, not syscall silence

**M4a**, deferred from M1 for want of a UI to hook.

**What it rejected.** "Has this process made a syscall recently", which is the obvious reading of a
heartbeat and is wrong in both directions: a process in `sleep 60` is silent and healthy, and a
process spinning in a syscall loop with a full input queue is busy and unresponsive. What is
measured instead is the age of the oldest keystroke nobody has taken — the condition a user means
by "not responding", and the only one this device can observe without asking the process anything.

**What it rejected second.** A timer of its own. It rides the kernel's existing heartbeat, O(1) and
edge-triggered: a message per window per tick is the fan-out constraint 18 forbids, at the moment
the UI can least afford it.

**What it leaves open.** A process that is wedged with NO input waiting is not detected, and that
is honest rather than overlooked: nothing is being ignored, so there is nothing to report. M7 can
afford a per-window event queue whose age is the same measurement over a wider set of inputs.

*Evidence: measured — caption at 1,020 ms, End Process at 4,006 ms after the first transition,
cleared 26 ms after a relay drained the queue. Constraint 163.*

## D27 — the process realm's policy goes on the worker script, and M6 ships no document policy

Constraint 139 left M6 one job and named the place to do it: "a Content-Security-Policy on the
document". Two candidate deliveries were measured before anything was written
(`bench/m6-realm/csp-probe.py`, four modes, one page load each).

**Chosen: the policy is sent for every response under `src/libos/`.** A prefix rather than the one
filename, because that directory is the process realm in file form and the worker's entry path is
`src/kernel/kernel.mjs`'s `RUNTIME_URL` — a server naming the file would be a second copy of a
constant the kernel owns.

**Rejected: a policy on the document.** Not on judgement: it does nothing. A document policy left
a dedicated module worker's loader completely unbounded — the `document` mode is
behaviour-identical to `none`, with zero violation events — so the computed `data:` import, the
off-origin import and `eval` all still worked. Constraint 187 carries the table and 188 records
the correction to 139.

**Rejected: shipping a document policy anyway, for the page's own sake.** It would buy nothing for
M6's subject and it is not free. `www/m4a.html` holds the kernel's own `MessagePort` and is the
supervisor every bench boots through; every page carries inline script; and `scripts/check.py`
byte-compares served bytes against disk, so a nonce cannot be injected and the policy would have
to carry `'unsafe-inline'`. Page hardening is a separate change with its own control. Constraint
200.

*Evidence: measured. Four deliveries against a stand-in module worker with its own second origin,
Chrome 157.0.8103.52. The off-origin row needs a cooperating origin — a module script is fetched
in CORS mode — so the probe starts a second loopback server sending
`Access-Control-Allow-Origin: *`; without it the row would read "refused" for a reason the policy
had nothing to do with.*

## D28 — `blob:` stays allowed and `URL.createObjectURL` is deleted instead

A program image IS a blob URL (`src/kernel/exec.mjs`), so `script-src` must permit the scheme or no
program runs at all. With the scheme permitted, a process that can mint a blob URL can evaluate
text no linker ever saw — measured, `import("blob:…")` succeeds under every policy delivery.

**Chosen: delete `URL.createObjectURL` from the process realm**, and `revokeObjectURL` with it, so
the realm cannot produce the one scheme the policy has to trust. Constraint 190.

**Rejected: a nonce or hash on the program image.** CSP hashes cover inline script, not a module
fetched from a blob URL, and a nonce cannot be attached to a URL the kernel mints at run time.

**Rejected: evaluating the program some other way than `import(blob:)`.** `importScripts` is not
available in a module worker, and `eval` is refused by the same policy — on purpose (191).

*Evidence: measured. `bench/m6-realm/csp-probe.py` rows `import blob` (reached under all four
deliveries) and `insideBlob` (a program's own computed imports, refused under the worker
delivery).*

## D29 — the lockdown fails closed, and is verified against a double rather than a browser

`lockdown()` throws when a binding it was asked to remove survives, and the caller evaluates
program text on the next line. The alternative — report it and continue — is strictly worse than
no lockdown at all: the check would be green and the realm would still reach the kernel's volume.

**The branch has no caller in a browser.** Every target on Chrome 157 is configurable, so nothing a
page can do makes a deletion fail. By this repo's own rule that makes it unverified, so
`lockdown(scope)` takes the global as an argument and `bench/m6-realm/probe.mjs` reaches the
refusal with a non-configurable double under Node. `bench/m6-realm/controls.py` then proves the
probe is coupled to its subject with three mutations.

**Rejected: trusting `delete`'s return value.** `delete obj[name]` returns true when there was no
OWN property to remove, which is the case for every binding here — `fetch` lives on
`WorkerGlobalScope.prototype`. The shallow version therefore reports success and removes nothing;
it is the `shallow` mutation, and it exists because it is the obvious way to write this.

*Evidence: measured. 25 host checks, three mutations each moving exactly its declared set.
Constraints 196 and 41.*

## Corrections on the record

Two errors were made during planning and caught by critics. They are kept here because the record
is more useful than a clean file, and because both are instructive about *how* the mistake happened.

**A 4× arithmetic error in a normative constraint.** An early draft asserted that five maximized
glass windows are 73.7 M device px and therefore past the blur wall. That applies the
device-pixel-ratio squared *twice*; the real figure is 18.4 M, comfortably under. Worse, the only
Aero kill gate was sized from it — so the gate predicted red, was structurally green, and **could
not have failed**. Corrected in constraint 49; the gate is now 52 glass terminals.

**A claim corrected twice, in opposite directions.** First: webxp's `check.py` "ports almost
unchanged." A critic corrected that to "all 82 checks are geometry assertions, none of which exist
before M7." That was also wrong: **59 of the 82 are not geometry assertions**, and several —
`check_boot`, `check_mount`, `check_filesystem`, `check_fs_persistence`, `check_terminal` — *are*
the spine's own acceptance criteria. Verified by reading the file. The harness is now 2 days of
work scheduled *before* M0.

The lesson both share: a number that is not re-derived from its source is a number nobody checked,
including when it comes from a critic.
