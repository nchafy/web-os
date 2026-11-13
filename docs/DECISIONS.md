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
