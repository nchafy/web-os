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

## D30 — a window is destroyed by its last fd, and an owner may be in another process

**Decided at M7, with the alternatives measured rather than argued.** Three questions had to be
answered together, because each one's cheap answer makes another expensive.

**Who destroys a window?** The last description on it, through `close(2)`. The alternative — a
window that outlives its fds until something calls `win_destroy` — leaves a frame on screen with
nothing behind it, which is constraint 179's defect reached by omission rather than by a page bug.
So `close` on the last fd destroys, and `win_destroy` exists only to make the CASCADE reportable.

**What does `win_destroy` return?** The LIST of winids it destroyed, oldest ancestor first.
Destroying a parent destroys its children, so one call closes several windows, and a caller told
only "ok" keeps fds for windows the kernel has forgotten. SerenityOS's `destroy_window` returns the
same list. The rejected answer is to leave the caller to infer it from the owner chain it set up,
which requires the caller to model the kernel's table — and the chain may include windows it does
not own.

**May an owner be in another process?** Yes, and this is the one with teeth. A picker broker
parents its dialog onto the REQUESTING app's window; that is the whole point of a broker, and
`MILESTONES.md`'s ordering correction names it as something M7 owes M9 and M10. The authority it
grants is real: destroying your window may destroy a window belonging to another process. It is
accepted BY THE CHILD when it names a parent, it travels in one direction only — a child's
destruction never reaches its parent — and the child is told on its own fd, through the one
`WEV_DESTROYED` record a destroyed window keeps.

**What was NOT decided here.** Whether a close can be REFUSED. `WEV_CLOSE` is delivered and the
frame still goes; M9 owns the refusal, and a relay that pretended to refuse would be lying to the
user. Said in `src/bin/term.mjs` where a reader meets it.

*Evidence: judgement, with two references. SerenityOS's returned id list and Haiku's owner chain
are in `docs/research/09-hobbyist-os-actions.md` §4. Constraints 213 and 216; the cascade's two
directions are `bench/m7-win/probe.mjs`'s own section and `--negative no-cascade` is the browser's.*

**D25 is now spent.** It recorded `/dev/console` as a special case with an expiry, and M7 is the
expiry: the device, the chardev mechanism under it and the ENXIO it answered are all deleted
(constraint 211).

## D31 — the window surface is kernel-owned, and a process draws by sending commands

**Decided at M8, on a measurement taken first.** `MILESTONES.md`'s ordering correction said this
choice had to be made before M12's blur governor, because "the governor cannot account what it did
not allocate", and that the two mature systems chose opposite sides: Haiku's server allocates the
bitmap and maps it to the client, SerenityOS has the client allocate and hand over an fd. The
project's own documents said the surface would be a transferred `OffscreenCanvas`.

**What was measured.** `bench/m8-surface/probe.py`, against a worker shaped like a process: a
transferred canvas does NOT arrive while the worker spins, and does NOT arrive while it is parked
in `Atomics.wait` — it arrives only after the worker awaits a macrotask, 594 ms after it was
posted, which is exactly the length of the park it sat through. Constraint 219 has the table.

**What that rules out.** A surface cannot be the reply to the syscall that asked for it: the
process is parked in that call, and parked is precisely when a transfer cannot land. It could be
made to work — a program written to `await` after `win_surface`, and a libos that correlates a port
message with a syscall reply — but then every drawing program is async by obligation, the kernel has
given away something it cannot revoke or account, and a releasable resource lives in a process
worker (constraint 15).

**What was chosen.** The kernel owns the surface. A process draws by writing a DISPLAY LIST into
the byte region it already has and calling `win_draw`, which is one syscall per batch rather than
one per operation. The page holds the canvas, replays the batch, and that is the frame.

- **Accounting and revocation come free**, which is the whole reason the ordering correction said
  to decide this early: the kernel knows every surface's size because it allocated it, so M12's
  admission controller has something to admit against and constraint 17's cap has something to
  count.
- **A process still holds only integers** (constraint 15). The display list is bytes in its own
  frame, which it already has.
- **The cost is the vocabulary.** Every operation a program can perform has to exist in the ABI,
  and M8 ships four — clear, fill, stroke and line — plus the pointer events that make them worth
  having. A program cannot reach for an arbitrary Canvas2D call, which is a real loss and the
  reason this is a decision rather than an obvious choice.
- **The rejected alternative is not gone**, and it is worth re-reading before M12: a transferred
  canvas is strictly faster for a program that draws thousands of operations per frame, because
  the ops never cross an agent boundary. If a workload like that appears, the honest answer is a
  second mechanism for it, declared as such, and not a quiet change of this one.

*Evidence: measured. `bench/m8-surface/probe.py`, Chrome 157. Constraint 219, and the correction it
makes to `CLAUDE.md` and `PLAN.md` §5.*

## D32 — the kernel owns the z-order, and a close is advisory

**Decided at M9, and the first half is structural.** Modality is a rule about which window may be
on top and which may receive input. Both of those are the page's natural business — it has the DOM
— and neither can be left there: a page asked to raise a window above the modal that blocks it has
no way to know better, and would. So the kernel keeps the stack, `win_raise` is a syscall, and the
page renders an order it is handed.

**What that costs.** A click now makes a round trip before anything moves — the page asks, the
kernel decides, the page applies the order it is sent. M0 measured a round trip at ~100 µs against
a 500 µs accept bar, so the cost is invisible beside the frame it lands in; and the alternative is
not cheaper, it is wrong.

**What it buys, beyond the rule being true.** The whole order is posted on every change rather than
a "raise this one" instruction, so the two sides cannot drift: there is no state in the page that
the kernel does not know about. A check reads the kernel's order AND the DOM's `z-index` and
compares them, which is how an inert frame is told from a working one (constraint 40).

**The second half is the close, and it is advisory.** The X button posts an event and does nothing
else. The rejected answer is the one every browser gives — the frame goes and the program is told
afterwards — and it is exactly the defect constraint 44 names: unsaved work discarded silently. The
cost of advisory is a window a program can refuse to close for ever, and that cost is already paid
for by M7's not-responding detector: an ignored close request is an uncollected event, so the
caption greys and End Process appears without anything new being built.

**What was NOT decided here.** Who may raise another process's window. The page asks on a user's
click, and a process may raise its own; a management interface that could raise anybody's is the
second, separately-gated interface `CLAUDE.md` describes for the taskbar, and M14 owns it.

*Evidence: judgement, with one reference and one measurement. SerenityOS's server owns the stack
and computes the blocker by walking the owner chain
(`docs/research/08-hobbyist-os-survey.md`); the round-trip figure is M0's constraint 51.
Constraints 226–228.*

## D33 — the clipboard's untyped calls are deleted, and a data object is a file description

**Decided at M10.** `docs/ABI.md`'s host group carried `clipboard_read` / `clipboard_write` →
bytes / 0 with no format argument, inherited from `docs/research/gap-03.md`. The review that asked
for drag-and-drop named that as the real defect in the same breath: a receiver is "structurally
unable to distinguish a pasted PNG from pasted UTF-8". **Rejected:** keeping the untyped pair beside
a typed one, which would have left two ways to put bytes on the clipboard and one of them wrong.
The pair is deleted; the ABI is 71 calls and says so.

**The clipboard and a drag are ONE OBJECT published to two destinations.** That is why there are
five calls and not eight: `offer(fd, where, …)` and `open(where, …)` differ by an argument, and a
second pair of near-identical calls would be one fact with two renderers. The rejected shape is
`clipboard_write(did)` plus `drag_begin(winid, did, effects)` — the review's own sketch — which is
two spellings of "publish this".

**A data object is an FD, which is the decision that carries the lifetimes.** The payload must
outlive its creator in both gestures: a clipboard whose bytes lived in the copying process is empty
the moment that process exits, and a drag must survive its source dying mid-gesture. **Rejected:** a
bare `did` integer with a per-process table beside the fd table, which is a second fd table with its
own teardown path to get wrong. With `F_DATA`, `close(2)`, `dup`, spawn inheritance and reap
teardown already release it, and a process still holds only integers (constraint 15).

**What that costs:** `read(2)` and `write(2)` on the fd have to be refused, and -EINVAL on an fd
that is otherwise ordinary is a surprise. It is the right surprise: an untyped read of a typed
object is the defect being removed, and the kind refuses rather than choosing a format for the
caller.

**What was NOT decided here.** A registerable format table. The review asked for one; the offer is
a bitmask in a single register because a drop target must decide whether it can accept DURING the
gesture, before any bytes exist, and a registry needs a call to enumerate that nothing yet has a use
for. Four formats, closed, dense from 1 — and the departure is recorded rather than quiet.

*Evidence: judgement, over two sources. `docs/designs/REVIEW-FINDINGS.md` §2 for the defect, and
Windows' own shell clipboard for the shape — a data object with a format tag, and CF_HDROP as a
NUL-separated path list (https://learn.microsoft.com/en-us/windows/win32/shell/clipboard).
Constraints 240–242, 246, 247.*

## D34 — a drag has no `DRAG_OVER`, and the kernel owns the session

**Decided at M10, on arithmetic rather than taste.** Every drag-and-drop API this one borrows from
streams a position event while the pointer moves. A drag IS a pointer with a button down, so an
event per motion sample arrives at full rate — and `WIN_EVENT_CAP` is 256 records, about a second of
moves (constraint 223). `push` drops the NEWEST event, so **the record discarded would be the drop
itself**: the feature would eat the thing it exists to deliver. **Rejected:** a coalescing queue per
window, which is a second queue discipline for one event type; and a lower-rate OVER, which is a
sample rate nobody can name a correct value for. Enter, leave and drop are edges — at most three per
target per gesture.

**The session is the KERNEL's, and the page reports only where the pointer is.** The page has the
DOM, so it is the only side that can hit-test a pointer against a frame; the kernel has the window
table, so it is the only side that knows a window is blocked, what the payload is and who may
receive it. **Rejected:** letting the page name the target outright, which is M9's mistake in a new
place — a page asked to deliver a drop to a window behind a modal has no way to know better, and
would. So `drag-at` and `drag-drop` are reports, the kernel resolves them, and `win-drag-target`
carries the answer back for the page to render.

**And a drag needs a button the kernel saw go down.** There is one pointer and therefore one
session, so an ungated one is expensive: a program that could begin a drag unprompted would hold the
session until a pointerup that is never coming and refuse every other drag with -EBUSY until then.
The gate asks the kernel's own record of the pointer rather than trusting an argument, and the
session is bounded by IDLE time rather than by its own age — which is constraint 239's correction
made before the same mistake happened twice.

*Evidence: measured for the queue (constraint 223's 256 records against a pointer's sample rate),
judgement for the division, and one source: SerenityOS's server owns the equivalent state
(`docs/research/08-hobbyist-os-survey.md`). Constraints 243, 244.*

## D35 — the glass frame is four separately filtered strips, not one node with an opaque child

**Decided:** the caption and the three edges are four elements, each carrying its own
`backdrop-filter`. **Rejected:** one glass node at full window size with an opaque client area
painted over its middle.

The rejected form is what "frame-only glass" reads as in a stylesheet, and it is not frame-only in
the unit that costs. `backdrop-filter` filters the element's **border box**, so an opaque child
hides the blur and saves none of it. Measured at 640×440 before the skin was written
(`bench/m11-glass/probe.py`):

| geometry | filtered CSS px² | nodes | windows to the ~58 M wall |
| --- | --- | --- | --- |
| one box node | 281,600 | 1 | 51 |
| four strips | 27,260 | 4 | 531 |

The box figure reproduces gap-04's own measured "~51 windows of 640×440" exactly, which is what
licenses the ring figure: one accounting applied to two geometries, with the known case as its
control.

**This corrects D13's headline number rather than adding to it.** D13 says frame-only glass is
"~11× cheaper"; that is true of the ring (10.33× measured) and false of the box, and D13 never said
which geometry it meant. Constraint 49's requirement that a governor account the border box is
satisfiable *only* in the ring geometry — in the box geometry the border box is the window, and
there is nothing for frame-only to save.

**What it costs, and what is unmeasured.** Four offscreen buffers and four filter passes per window
instead of one. gap-04 measured *area* as the predictor and layer count as free up to 60 layers;
four strips at 52 windows is 208 layers, past anything measured. M12's gate must look at this
first, because the governor's own arithmetic is a sum over `ringArea` and a per-layer cost it does
not model would be invisible to it.

*Evidence: measured. Constraints 49, 255; `designs/REVIEW-FINDINGS.md` §3; `MILESTONES.md` M11.*

## D36 — a glass check asserts that the transition is SPREAD, not that it is monotonic

**Decided:** the pixel proof asserts *concentration* — the share of a luminance transition falling
between one adjacent pair of samples — plus a span floor. **Rejected:** `PLAN.md` §5's "assert a
monotonic gradient", and its `backdrop-filter: none` negative control.

Both were rejected on measurement, and both would have produced a check that could not fail.

**A hard step is monotonic.** The bare seam, a `blur(0px)` control, a `backdrop-filter: none`
control and a severed blur chain all report a monotonic rise — so every one of the proof's own
negative controls satisfies it. Concentration separates them cleanly: 0.078 for real glass against
1.000 for the bare step, with the threshold at 0.35 and a factor of four of margin either side.

**`backdrop-filter: none` is the weaker control.** Removing the property also removes the isolated
group the `plus-lighter` layers blend into, so it moves the pixel for a reason unrelated to blurring
(`designs/REVIEW-FINDINGS.md` §8 measured (31,46,71)), and it cannot preserve the active/inactive
brightness remap because the remap is a term in the filter. `blur(0px)` cuts only the standard
deviation and moves **one** expectation where `none` moves seven. Both are registered; the
comparison is the finding.

**And the span floor is not redundant with the spread test**, which only running the controls
revealed. Over a flat desktop the spread assertion HELD, because the viewport-anchored specular
highlight is a `background-attachment: fixed` gradient and supplies a ramp of its own across any
band sampled through it. The span is what couples the check to the seam. `--prove-failure` could not
have found that: an assertion over a constant still inverts and still fires.

*Evidence: measured. Constraints 50, 256, 257, 259; `MILESTONES.md` M11.*

## D37 — the chrome metrics are ABI, because the kernel accounts the border box

**Decided:** `WIN_CAP_H`, `WIN_INSET` and `blurRingArea` live in `src/abi.mjs`, imported by the
kernel's governor and by `src/wm/aero.mjs`'s stylesheet. **Rejected:** keeping them in the skin and
having the page report each window's blur cost to the kernel.

Constraint 49 requires the governor to account each glass element's **border box**, and the governor
has to be the kernel's: only the kernel owns the z-order it degrades by (constraint 226) and only
the kernel sees every area-changing call. But the ring's geometry is the skin's. So the area
function became a fact both sides must agree on, which is exactly what `src/abi.mjs` is for.

**What the rejected option would have cost.** The page reporting a cost per window is the same shape
as the terminal cell count in `win-geom` — the page measures what only the page can see — and it was
tempting for that reason. It fails on *admission*: the governor must decide before the frame is
shown, and a cost that arrives with the page's geometry report arrives after. The kernel would be
admitting on last frame's numbers.

**The consequence, stated rather than discovered:** the kernel now knows a caption is 29 px tall. It
draws nothing — `aero.mjs` does, and imports these — but **a second skin with different chrome is a
change to the ABI rather than to a stylesheet.** That is the price of an admission controller that
accounts what the compositor really filters, and constraint 49 leaves no cheaper way to pay it.

*Evidence: judgement, forced by a measurement. Constraints 49, 255, 264; `MILESTONES.md` M12.*

## D38 — M12's frame-rate gate is recorded as unmeasurable, not answered

**Decided:** the suite gates on the accounting, the degrade order, both hysteresis edges, and
whether the blur actually left the pixels. **Rejected:** `PLAN.md` §5's "assert that frame rate
holds ≥ 110 fps".

It cannot be measured in this environment, and the alternative to saying so is printing a number
that reads like an answer. Headless pins to 60.0 fps on SwiftShader with `--disable-gpu`, against
the 120 Hz gap-04 measured; a headed window driven through CDP is throttled to 8.9 fps because
Chrome will not paint a window it believes occluded, and `Page.bringToFront` hangs on a window
nothing can focus.

So `bench/m12-governor/probe.py` exists, takes the measurement when a human runs it `--headed`, and
**refuses to draw a conclusion otherwise** — every row carries its engine and the verdict says "no
row here is a number about Aero" unless it ran headed. That it measures the right thing at all is
shown by its 20 ms main-thread stall control reading 49.2 fps against gap-04's 49.3.

**What this gives up:** the one assertion that would have caught a governor whose thresholds are
wrong for the machine it is running on. The budget is one machine's — 45 M off / 36 M on from a
58–63 M wall on one 120 Hz panel at dpr 2 — and nothing adapts it. Recorded in `MILESTONES.md` M12
under what is not done, because the honest version of this decision names what it costs.

*Evidence: measured. Constraints 36, 267; `PLAN.md` §5.*

## D39 — the shell is page-side chrome, and its contents are a process's published rows

**Decided:** the taskbar, the start menu, a jump list and the desktop's icons are rendered by the
PAGE, and what they SHOW comes from a process through `win_items`. **Rejected:** a taskbar process
holding a second, separately gated management endpoint, which is what
`docs/research/09-hobbyist-os-actions.md` §4 recommends and what SerenityOS does.

**Why the endpoint is not needed here, which is a conclusion and not a shortcut.** A taskbar needs
cross-process window enumeration no ordinary client may have — that is the research's point, and it
stands. But in this architecture the page ALREADY holds every window's frame: `win-create` built
it, `win-stack` ordered it, `win-title` named it. A taskbar rendered by the page reads facts the
page was already told, so it adds no capability to anything and there is nothing to gate. A taskbar
as a PROCESS would need the endpoint, and if one is ever written that is the design to follow.

**And a process could not draw one.** The display list has `DL_CLEAR`, `DL_FILL_RECT`,
`DL_STROKE_RECT` and `DL_LINE` — no text op and no image op — and `WEV_POINTER` is only delivered
while a button is down (`src/wm/winhost.mjs`, constraint 223's arithmetic). So a process-drawn
Superbar could have no labels and no hover, which are two of the three things a Superbar is, and a
rubber band is not expressible as a stream of filled rectangles. Giving the display list text and
images, and hover events a queue could survive, is a larger milestone than M14 and would be the
real prerequisite.

**What keeps the division honest.** A shell that invented its own contents would be a page
pretending to be an operating system, and it would look identical. So the contents are a process's:
`src/bin/desktop.mjs` reads `/usr/bin` and `/desktop` through the filesystem and publishes rows,
each flagged for where it appears, and activation returns as `WEV_ITEM` with an INDEX the kernel
validates against the list it holds. **`--negative no-items` is the run that tells the two apart**:
the kernel accepts a published list and discards it, and thirteen expectations go red — the
desktop's icons, the start menu's programs, every mouse action on an icon, and the jump list.

**What this gives up:** a third-party taskbar. Nothing outside the page can enumerate windows, so a
replacement shell is a change to `src/wm/` rather than a program somebody writes. For a system whose
window manager is already page-side (`src/wm/window.mjs` since M4a) that is the existing boundary
rather than a new one, but it is the cost and it is not small.

*Evidence: judgement, forced by two measurements. Constraints 223, 275; `MILESTONES.md` M14;
`docs/research/09-hobbyist-os-actions.md` §4.*

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

## D40 — the session is a WRITABLE COPY of a read-only base, seeded once

**Evidence class: a product decision, taken by the owner.** It is recorded here rather than argued
from a measurement, because what a reader may modify is not a question a benchmark answers.

**The question it settles.** `docs/PLAN-SHELL.md` §10.1 left one thing to a human: what Delete does
when the volume is read-only. `/usr` is `FS_PROVIDER` with `MNT_RO` and `mutErrno: "EROFS"`
(`src/kernel/providerfs.mjs:180`), and `src/bin/files.mjs` opened `/usr/share` — so every mutating
verb M20 adds was unreachable from the one directory the file manager showed.

**The answer, in the owner's words:** *"i would like all operating systems to be a copy of the read
only base. then each session can be modified freely."*

So the read-only mounts stop being the reader's working tree and become what they already resemble:
install media. The base is copied ONCE into the writable journaled volume, and the session works on
the copy. Delete, rename, New folder and paste then need no read-only case at all, because nothing
a reader can reach is read-only — which is a better answer than the refusal this plan was going to
ship, and it removes the special case rather than handling it.

**What it rejects.** Refusing Delete by name on a read-only mount (correct but a dead end: the file
manager's own default directory stays unmodifiable); hiding the verb (a command absent for a reason
the reader cannot see); and treating Delete as a copy into the Bin while leaving the original, which
reports a deletion that did not happen and is the dishonest-success class this project refuses.

**THE SEED IS ONCE, AND CONSTRAINT 28 IS THE TRAP HERE.** That constraint forbids RESEEDING: a bad
superblock mounts read-only and reports, and never reseeds, because webxp reseeded and that is
silent data loss presented as success. Seeding a FRESH volume is not reseeding — `store.mjs:246`
already writes an initial superblock on one — so the copy MUST be gated on the same fresh-volume
signal and MUST NOT run against a volume that exists, nor against one that failed to mount. A
second copy over a reader's edited tree is exactly the defect constraint 28 names, arriving through
a new door.

**What it costs.** The base and the copy can diverge: a program added to `/usr/bin` after a reader's
volume was seeded is present in the base and absent from their copy. That is the real behaviour of
every installed system and is not a defect, but it IS a thing a check can assert and a reader can be
told, so the seeded set and the base set are both readable rather than assumed equal.

### What was built, in M19a

`src/kernel/seed.mjs` is the whole of it, and it adds **no syscall, no errno and no record** — so
`docs/ABI.md` is unchanged, which is the honest summary of the shape: a seed is a thing the kernel
does to a volume before any process exists, not an interface a process can reach.

**Where it lands: `/Users/Default`** (`SEED_DEST`), with the copy built under
`/Users/.Default.partial` (`SEED_STAGING`, DERIVED from `SEED_DEST` because the two are one fact).
Userland's own constant is `HOME_DIR` in `src/libos/std.mjs` and the two MUST agree;
`www/shell.mjs`'s `seedState` compares them on every boot and publishes `drifted` when they do not,
because a drift means every program opens a directory the seed did not create and the only symptom
is an empty window.

**What is copied: the WHOLE base**, not its data directory. 39 files (`USR_ENTRIES.length`) and
4 base directories — `bin`, `include`, `lib`, `share` — plus `/Users` and the staging root, which is
the 6 `dirs` the report publishes. The argument is content, not fidelity: `/usr/share` is three files
and about a kilobyte, and M20's copy, paste, delete and rename need a tree with real sizes and a real
count. Copying `bin/` gives the shell no second program directory — `/usr` stays mounted and
`src/bin/desktop.mjs`'s start menu is still a listing of `/usr/bin`; the copy is a reader's to rename
and delete, which is the whole of this decision.

**When it runs: once, after the mount, gated on `maySeed`** — three conjuncts, one per failure world,
and constraint 306 carries the arithmetic. `cfg.noSeed` is a declared OPT-OUT so the world D40
removes is re-runnable from a query string without a source edit; there is deliberately **no** kernel
hook for the UNGATED world, because a kernel that could be asked to reseed is a kernel with a reseed
path in it. The staged copy is published by ONE rename, so a reader's tree either is the whole base
or does not exist, and a half-copy from a killed page is reported under `SEED_STAGING` and never
removed.

**The measured cost.** Three harnesses, and they do not measure the same thing, so each is named
beside its number.

| what | harness | figure |
| --- | --- | --- |
| the copy, in userland, per-file `fsync` | `bench/m19a-seed/probe.py`, headless Chrome 158, 3 runs | **208–248 ms** |
| the same copy, no per-file `fsync` | same, 3 runs | **131–164 ms** |
| the kernel's own seed, on a product boot | `bench/m19a-seed-firefox/firefox-session.py`, Firefox 156 at dpr 1 | **442 ms**, self-timed, in `seed.ms` |
| where the per-file cost is | `bench/m19a-seed/probe.py` over 39 files | open **0.21 ms** mean; FIRST write **2.72 ms** mean, 2.38 median, 8.39 max; later chunks **0.14 ms** |

**THE PER-FILE `fsync` WAS MEASURED AND NOT SPENT, AND THAT IS THE ONE COST DECISION HERE.** It is
95 ms of the 247 and constraint 23 does not require it: the flush points are `fsync`, snapshot and
idle, and `closeFd` already publishes the generation. So each file is created `O_EXCL`, written and
closed, the rename is journalled, and the boot's only flush is ONE `writeSnapshot` — which is what
makes the next boot mount the tree from a slot rather than replaying the copy's whole journal. A seed is still
plainly visible at boot and nothing hides it; that is stated rather than smoothed.

**THE PLAIN READING OF CONSTRAINT 22 IS WRONG FOR A COPY, measured.** `openFd` on a file the same
call just created resolves at generation 0, so `resolve` returns without an `IO_BLOB_OPEN` and no
`createSyncAccessHandle` is taken; the handle is created by `copyUp` on the FIRST WRITE. An
implementation that budgets 22's 495 µs to `open` mis-attributes its own slow path.

**`bytes` IS NOT A CONSTANT AND MUST NOT BE ASSERTED AS ONE.** `USR_ENTRIES` maps mount names onto
this repository's own source files, so the base's byte total is the live size of the source tree:
623,827 at the commit the bench measured, 627,911 on the working tree an hour later, the 4,084-byte
gap being M19a's own edits to three files that are rows of the base. `check_m19a` therefore asserts
`files === 39` — a table LENGTH — and derives the byte and chunk totals from two independent
readings, writing neither down.

### Corrections this implementation makes to the decision, and to the plan

**`docs/PLAN-SHELL.md` §7.3's writable default location was `/desktop`, and it is not that.** §7.3
predates D40: with the whole base copied, a home-shaped tree is expressible and a bare `/desktop` is
not one. The surface is Windows 7, so the shape is `C:\Users\<name>`, and the name is `Default`
because there is no account database here — every process runs as uid 0 and `src/abi.mjs` has no user
table, so a directory named after a user would be an account this system cannot name. `Default` is
Windows 7's own name for the profile a fresh install carries. The decision is kept and corrected
rather than edited, the way this file's §Corrections keeps its two.

**The copy adds the OWNER WRITE BIT, which D40 did not anticipate having to say.** The base's modes
are `0o555` for a program and `0o444` for a data file, so a copy that preserved them would be
unmodifiable by its MODE where the base was unmodifiable by its MOUNT — the same refusal through a
different door, and the whole thing this decision removes. The X bit is the source's, so a copied
program is still a program. **The owner's bit is enough only because there is one identity:** the
copy is owned by uid 0 and every process is spawned as uid 0, so the day a process runs as anyone
else this has to chown to the session's uid rather than widen the mode.

**THE STAGING-AND-RENAME DESIGN TURNED OUT TO BE A SECOND GUARD, and the measurement is why
`--negative reseed-always` needs two patches.** Dropping `maySeed`'s freshness conjunct alone loses
no data: `VFS.rename` answers ENOTEMPTY onto a non-empty directory (`src/fs/vfs.mjs:663`), so an
ungated second seed copies 39 files, fails its rename, rolls back and leaves the reader's tree
standing. That is a property nobody designed for and it is recorded here so a later change does not
spend it without knowing it existed.

**THE DIVERGENCE D40 PRICED IS READABLE, AS PROMISED.** `fsState().seed` publishes `base`, `dirs`,
`files`, `bytes` and `chunks`, the boot `up` message carries it, and `www/shell.mjs` republishes it
at `<GLOBALS>.seed`. A reader on a volume seeded before a program was added sees the base's listing
in the start menu and their own in the file manager, and both figures are available rather than
assumed equal.

*Evidence: a product decision for the WHAT; measured for every number above. Constraints 28, 306;
`MILESTONES.md` M19a; `bench/m19a-seed/`, `bench/m19a-seed-firefox/`.*

## D41 — the Alt+Tab substitute is Alt+\`, and the menu publishes the accelerator it listens for

**Evidence class: a product decision, taken by the owner, over a measured candidate set.** The
measurement priced the options and disqualified four of them; which of the fourteen survivors to
take is a question about a reader's hands and not one a benchmark answers.

**The question it settles.** `docs/PRD-SHELL.md` §10.3 left R22 to a human: Alt+Tab is the host's
switcher on every platform, so taking it has a cost, and `docs/PLAN-SHELL.md` §M22 said the choice
among the free candidates "is a human's, not this plan's."

**The owner's rule, which decides the method and not just the chord:** pick whichever candidate the
probe shows free in **both** engines, and **LABEL the real accelerator in the menu.** A menu showing
an accelerator the system cannot receive is the live-looking-button defect, so the label is a
requirement and not a nicety — the same rule that made M11's minimize and maximize drawn and
*disabled* rather than live and inert.

**What the measurement said.** `bench/m22-switch/probe.py` scored 25 candidates on five clauses in
Chrome 158 and Firefox 156. Freedom turned out to be two readings and not one, which is constraint
312: all 25 are *delivered* in both engines, and only a second run with the listener cancelling
nothing separates a free chord from a borrowed one. **14 qualify** — Alt+\`, Ctrl+\`, Ctrl+F6,
Alt+Shift+\`, Ctrl+Shift+\` and Alt+1..9.

**The chord: Alt+\` forward, Alt+Shift+\` backward, with Alt+1..9 as the Superbar's direct-select
set.** Ctrl+\` scores identically on every clause, so the choice between them is the part that is a
judgement, and it is made on three facts about the reader rather than about the browser:

1. **Windows 7's switcher is Alt-based**, so the modifier is the one a reader already associates
   with switching windows.
2. **\` is the key physically next to Tab**, which makes it the nearest gesture to Alt+Tab that the
   host leaves alone — and the hand does not move.
3. **macOS's own "next window within this application" is Cmd+\`**, the exact semantic analogue, so
   on the platform this repository is developed and read on the gesture is already learned.

It is also the only qualifying pair whose **reverse** is measured free without reaching for Ctrl,
and a switcher with no reverse is half a gesture.

**What it rejects.** **Alt+Tab itself**, which is delivered in both engines and would have worked
— and which the host acts on unless the page cancels (`host: "stopped"`), so taking it is borrowing
a binding that belongs to the window manager; it is in `BLOCKED` and MUST NOT be labelled anywhere.
**F6 and Shift+F6**, Windows' own "next pane", on the measurement: F6 moves the browser's focus out
of the page and Shift+F6 does so **even when the page cancels** (`free: false, host: "anyway"`).
**Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+Alt+Tab, Meta+Tab, Alt+Escape, Ctrl+Escape and Alt+Space** on
their documented consumers rather than on a measurement — each is a gesture a reader already uses
for something else, and a shell that answers Ctrl+Escape would be the second thing on screen
claiming to be the Start menu. **And R22's one-engine fallback is not reached**: `docs/PLAN-SHELL.md`
§M22 said that if every candidate were taken in one engine, R22 would ship as a chord that works in
one and is labelled as such. Fourteen are free in both, so that branch was not built — a branch for
a world the measurement ruled out is a branch no check can reach.

### What was built, in M22

**`src/wm/chords.mjs` is the one table**, and it is in `src/wm/` and not in `src/abi.mjs` for a
reason worth stating: a chord is not a fact the kernel and a process must agree on. Both readers are
page-side — the shell draws the label, `src/wm/winhost.mjs` dispatches the key — and
`KeyboardEvent.code` is a browser string, where `src/abi.mjs` holds the integers both sides of the
syscall channel share and nothing else. The **modifier** side *is* an ABI fact and is imported from
there, so the bits the table compares are the bits `WinHost.modifierBits` produces.

**THE BINDING IS ON `code`, WHICH IS CONSTRAINT 313 AND WAS NOT PREDICTED.** Firefox delivers
Shift+Backquote as `key: "~"` and Chrome as ``key: "`"``; both deliver `code: "Backquote"`. A
dispatcher matching `event.key` would have worked in Chrome, missed Alt+Shift+\` in Firefox, and left
every Chrome expectation green — the shape of all five Chrome-only bills `CLAUDE.md` records. The
disagreement was found by the probe and then reproduced through the real shell in Firefox
(`bench/m22-switch/firefox-shell.py` → `keyDisagrees`), which is where it would have bitten.

**`takeChord(event, mods)` MATCHES AND CANCELS IN ONE CALL.** Every chord in the table reads
`host: "never"`, so nothing leaks today — but F6's `stopped` is the demonstration of what a missed
`preventDefault` costs on a chord the host binds, and a matched chord is the page's. The match is on
an **exact** modifier word: a superset match would make Alt+Shift+\` fire the forward chord and the
reverse unreachable.

**`BLOCKED` IS DATA AND IS ASSERTED AT MODULE LOAD.** `selfTest` refuses to load the module if a
bound row collides with a disqualified chord **or wears its label**, the second half being the one
that catches a hand-written string: a row bound to Backquote and labelled "Alt+Tab" passes every
other clause. `labelFor` is the only place a `code` becomes a printable name, so the shell's menus
and the band's buttons publish the accelerator the dispatcher listens for by construction and not by
agreement. The modifier order is Ctrl, Alt, Shift, Meta — Windows' own written order, because a menu
is read against the reader's memory of other menus.

### The correction this implementation makes to the decision

**THE DISPATCHER IS ON THE CAPTURE PHASE, AND THE PHASE — NOT THE CALL — IS WHAT THIS DECISION DID
NOT ANTICIPATE.** The table shipped with no dispatcher at all, and the predicted site was wrong: the
contract was written against `src/wm/winhost.mjs`'s `#keys`, the funnel both window kinds reach, and
by the time `#keys` runs `src/wm/terminal.mjs` has already turned the keystroke into bytes — it
listens on its own `pre`, deeper in the tree and therefore earlier in the bubble. Measured with the
dispatcher first written bubble-phase: `prevented: true`, `switches: 0`, `where: 'terminal'`,
`screenGrew: 1`. The chord was matched, it was cancelled, and the reader got a backtick.
**`preventDefault` STOPS THE BROWSER AND NOT THE PAGE**, so the cancel this decision rested on says
nothing about a widget in the same document. The dispatcher is a capture-phase listener on
`src/wm/taskbar.mjs`'s own container with `stopPropagation` beside the match — capture runs
ancestor-first, so the shell sees the chord before any window can. Constraint **315** carries it,
with the corollary a capture listener owes: an unbound key MUST leave the event untouched, or the
shell has quietly become the system's keyboard.

**AND A TAKEN CHORD CANNOT BE COUNTED BY WHAT REACHED A WINDOW.** `WinHost.keyCounts()` sums the
keys that reached a window's widget and a taken chord reaches none, so the shell counts its own
(`stats.trustedChords` / `syntheticChords`, published in `report()`) and the check asserts the
SPLIT — four bound chords taken by the shell, two unbound ones still reaching a window. A single
total cannot tell a working dispatcher from one that ate everything. `scripts/check.py --only m22`
is **73 expectations, all green**; `bench/m22-switch/firefox-shell.py`'s own five clauses go with
it. **A labelled accelerator that does nothing is the defect this decision exists to prevent**, and
it was reported as exactly that until the call landed rather than being weakened into a pass.

**FORWARD-THEN-BACK DOES NOT RETURN A READER TO WHERE THEY WERE, which the decision did not
anticipate having to say.** A raise re-orders the kernel's stack, so Alt+\` then Alt+Shift+\` walks
`4 → 3 → 2` and not `4 → 3 → 4`. Each direction is asserted against the stack **as it was at that
press**, which is honest about what was built; Windows 7's own held-Alt transient order is a
different design and would live in `src/wm/taskbar.mjs`.

*Evidence: a product decision for the CHOICE; measured for the candidate set and for every
engine-shaped fact above. Constraints 312, 313, 315; `docs/PRD-SHELL.md` R22/§10.3;
`MILESTONES.md` M22; `bench/m22-switch/`.*

---

## D42 — a picture is decoded IN THE PROCESS, and the kernel never learns an image format

**Evidence class: measured, and the measurement ran before `DL_BLIT` had a caller.**
`bench/m23-blit/` is the probe; `docs/PLAN-SHELL.md` §M23 asked the question as "a decode performed
where a decoder exists", listed three candidate sites, and got one of its own premises wrong.

**The question it settles.** R26 makes an image file's icon the image, and **nothing in this system
decodes a PNG** — `src/bin/imgview.mjs` reads the signature and the IHDR and says so in capitals.
The decode has to happen somewhere, and there were three places it could: **(a)** the process,
**(b)** the kernel, **(c)** nowhere, with `.rgba` payloads only and a PNG falling back to its type
icon.

**(a) IS TAKEN, AND IT IS THE ONLY SITE THE EVIDENCE NEEDS.** `createImageBitmap` is **not among the
11 entries in `TARGETS`** in `src/libos/lockdown.mjs`, so a process realm is not stripped of it —
checked by importing the exported data in the measuring page rather than by grepping the file, which
is this repository's own rule for that table. A decode promise settles inside a real program on a
real kernel in the realm M6 ships, under M6's live CSP, and the pixels come back **byte-exact**
against this repo's own `/usr/share/logo.rgba`: maxDelta 0, 256 of 256 opaque pixels identical, in
Chrome and in Firefox.

**BUT ONLY IN AN AWAITED TURN, AND THAT IS A DESIGN CONSTRAINT AND NOT A FOOTNOTE.** A present
binding is not a usable one — constraint 219 is the precedent, and the shape holds for a promise. Not
while parked in `nanosleep` (406.81 ms, nothing settled, and not after one microtask either), not
while spinning (400 ms), and a cold decode needs 7 macrotask turns in Chrome and 5 in Firefox. So a
decode MUST NOT be folded into a syscall reply, a thumbnail loop over a directory MUST be `await`s
between syscalls, and `src/libos/syscall.mjs` needs no change and MUST NOT get one. Constraint
**318**.

**(b) THE KERNEL IS AVAILABLE AND IS THE WRONG PLACE — REJECTED.** The kernel is a Worker that
awaits macrotasks, so it *could* decode. What that hands it is an **image-format parser over
untrusted bytes in the only privileged realm in the system**: the exact direction M6 exists to
reverse, and the direction `src/fs/`'s purity rule exists to keep a fuzz target out of. And
`DL_BLIT` taking a data-object fd makes it **unnecessary** — a payload is already kernel-owned and
refcounted (constraints 240, 241), so the bytes are where the renderer needs them without the kernel
knowing a format. It validates with `decodeBitmap`, which it already has, which is constraint 293's
rule for a text run applied unchanged, and which is a header check and not a decoder.

**(c) SURVIVES AS THE ERROR PATH, NOT AS THE DESIGN.** `createImageBitmap` **rejects** on a format
the platform will not take and on corrupt bytes, recorded as `rejected: <message>` rather than as a
fault. So "a picture falls back to its type icon" is still owed — for an **undecodable file**,
reached through a rejected promise — and R26 MUST NOT ship `.rgba`-only on the strength of the
plan's claim. `files --thumb-no-fallback` is the world where that fallback is absent.

**THE CORRECTION THIS DECISION MAKES TO THE PLAN.** `docs/PLAN-SHELL.md` §M23's "If the assumption
is wrong" states that *"a locked-down realm has no `createImageBitmap` (src/libos/lockdown.mjs)"*.
**That is FALSE, in both engines.** The paragraph's first sentence is true and unaffected:
`src/bin/imgview.mjs` is not a decoder. The row is kept and corrected beneath, per this
repository's rule.

**WHAT THE SECOND ENGINE IS A GATE ON HERE IS AGREEMENT AND NOT THE ANSWER.**
`bench/m23-blit/firefox-decode.py` re-asks the whole thing over WebDriver BiDi at dpr 1 and exits 4
on **engine disagreement** rather than on a verdict, because a decode site that is only available in
Chrome is not a decode site. Both engines: present in the realm, refused `eval`, nothing settled
parked or spinning, settled awaited, pixels exact.

*Evidence: measured. `bench/m23-blit/results-headless.json`, `results-firefox.json`,
`results-control-headless.json`; constraints 317, 318, 319; `docs/PRD-SHELL.md` R26;
`docs/PLAN-SHELL.md` §M23; `MILESTONES.md` M23.*
