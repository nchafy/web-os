# Constraints

What the browser permits, measured. Every architecture for web-os must satisfy this list,
whichever one is chosen.

This file is the normative distillation. The evidence is in `research/`, and each constraint
names the file that carries it. Where a number appears here it was measured on this machine —
Chrome 157.0.8103.38 headless, macOS 26.7.2, Apple M2 Pro, 120 Hz display, dpr 2 — by the
harness named beside it. A number with no harness named is someone else's published figure and
says so.

## The kernel

1. The kernel MUST be a dedicated Worker. `Atomics.wait` throws `TypeError` in a window agent,
   because window agents are created with `[[CanBlock]]` false, and `createSyncAccessHandle` is
   only available in dedicated workers. `research/gap-01.md`, `research/gap-03.md`.
2. The kernel MUST NOT block. A process blocks; the kernel replies asynchronously. The asymmetry
   is forced by (1), not chosen.
3. A main-thread kernel MUST NOT be used even though its median is identical. With the main
   thread 60% busy, 52 of 20,000 syscalls exceeded 10 ms, max 400 ms during a deliberate 400 ms
   synchronous task; a worker kernel had 0 of 20,000 past 0.52 ms. Window dragging, layout and
   raster all live on the main thread, so this is the normal case. `research/gap-04.md`.
4. A thin main-thread relay MAY own the DOM-only calls — window operations, clipboard,
   notifications — and report back to the kernel worker, which then notifies the caller.
   `navigator.storage.persist()` is Window-only, so requesting durability is the shell's job and
   cannot be the kernel's. `research/gap-06.md`.

## The syscall channel

5. The channel is `postMessage` out, `Atomics.wait` on a SharedArrayBuffer for the reply, woken
   by `Atomics.store` + `Atomics.notify`. Measured 14–16 µs mean, p50 10–15 µs, p95 25–30 µs,
   p99 40 µs. About 550 fit in one 8.3 ms frame. `research/gap-04.md`.
   **These figures are one caller against an idle kernel.** M0 reproduced the mean on a different
   build and measured what this constraint never did — the same channel with 4, 16, 64 and 128
   concurrent callers against a kernel that serialises all of them. See constraint 51; the p50 and
   p95 quoted here are also below the clock's resolution floor, per constraint 52.
6. Blocking is cheaper than not blocking: async `postMessage` round trip measured 17.3 µs against
   the channel's 14.0 µs. There is therefore no latency argument for an async syscall API, and the
   synchronous one MUST be built. `research/gap-04.md`.
7. The reply-beats-the-park race MUST be handled explicitly. About 0.2% of round trips returned
   `"not-equal"` from `Atomics.wait` because the kernel replied before the process parked.
   `research/gap-01.md`.
8. Arguments MUST travel in a per-process bounce buffer, with offsets in the `postMessage`. The
   alternative — mapping the process's own heap as the SAB — is the one transport already measured
   dead: it was Browsix's design and it did not survive a WebAssembly target. Its replacement
   measured 0.2% average and 1.2% maximum overhead on SPEC. `research/gap-02.md`.
9. The buffer size MUST be chosen deliberately and overflow MUST be defined. wanix uses 16 KB with
   an unhandled overflow that silently truncates replies over 16,360 bytes; an oversized call MUST
   split or fail loudly, and that MUST be a check. `research/gap-02.md`.

## Agent clusters

10. Every dedicated worker joins the agent cluster of whatever created it. Sibling workers and
    nested workers of one window are all in one cluster, all share a SharedArrayBuffer, and all
    have `[[CanBlock]]` true. This is normative, and was confirmed by test.
    `research/gap-01.md`.
11. A cross-origin iframe CAN be `crossOriginIsolated` — but only with `allow="cross-origin-isolated"`
    on the iframe and its own COEP header — and it is still a different agent cluster. A SAB sent
    from the top page arrives as `messageerror`. Measured across seven iframe configurations.
    `research/gap-01.md`.
12. Therefore per-app-origin isolation and a shared blocking syscall channel are mutually
    exclusive. A per-origin app needs its own SAB plus a broker worker making an async hop to the
    host kernel: two hops, not one. `research/gap-01.md`, `research/gap-05.md`.
13. An opaque-origin sandboxed iframe (`sandbox="allow-scripts"`, no `allow-same-origin`) cannot
    construct a Worker from an `http:` URL — `SecurityError` — but can from a `blob:` URL.
    `research/gap-01.md`.

## Processes

14. A process MUST be killable, and the process table MUST NOT assume `terminate()` reclaims
    anything. `terminate()` returns to the caller in ~10 µs but the worker keeps running: a
    spinning worker advanced a shared counter until 2004, 2051, 2003, 2048 and 2009 ms (n=5). A
    spawn immediately after a mass kill took 22.7 ms. The UI MUST NOT claim a process has ended
    before it has. `research/gap-01.md`, `research/gap-04.md`.
15. No releasable resource may live in a process worker. `terminate()` offers no chance to finish,
    so OPFS sync access handles, pipe buffers, window handles and locks are all kernel-side. A
    process holds only integers. `research/gap-03.md`.
16. A process parked in `Atomics.wait` CANNOT service `postMessage`, so a signal cannot be
    delivered that way. Signal delivery MUST use a reserved control word in the SAB, or a second
    coordinator worker per process. Ctrl-C depends on this. `research/gap-02.md`,
    `research/gap-03.md`.
17. The process table MUST carry a hard cap. The renderer survived 3,200 live workers and died
    between 3,200 and 4,800; every process shares one renderer, so exceeding the ceiling kills the
    whole OS. 1,000 is the design limit. Budget ~600 KiB resident, 271 KiB JS-attributed, per live
    process. `research/gap-04.md`. The JS-attributed figure reproduced at 272–274 KiB per worker on
    M0's build; the ~600 KiB resident claim remains untested here, because nothing in M0 reads RSS.
    **The cap is advisory until M6**, because a process can spawn a worker the table never sees —
    constraint 53.
18. Signals, broadcasts and any per-frame sweep MUST be O(interested), never O(N). Round-tripping
    all live workers cost 378 µs each; at 1,600 workers that is 502 ms. `research/gap-04.md`.
19. Spawn from a Blob URL built from VFS bytes (1.86 ms), not an HTTP URL (3.45 ms). Add 5–6 ms for
    a WASM instantiation, so budget ~8 ms for a real process — under one frame, which means `exec`
    can be synchronous from the user's point of view. `research/gap-04.md`.
    M0 reproduced the *ordering* but measured both 1.3–1.6× higher on its build, and could not
    isolate why: `Blob` + `createObjectURL` is only 0.135–0.150 ms of the timed region and
    classic-vs-module makes no difference, which leaves the patch build, M0's 5–6 KB process script
    against gap-04's trivial one, and n=20 against n=1000. Re-running gap-04's own spawn harness on
    this build would settle it and has not been done. `tmp/m0-probe-nested/probe.py`.
20. `spawn` is the only way to create a process. **`fork` MUST NOT be relied on** — but the reason
    matters, because the original version of this constraint got it wrong and the corrected reason
    is narrower.

    *What was wrong:* Browsix never concluded fork is incompatible with blocking syscalls. Its
    `_sync-syscalls` branch has `read` on the blocking channel and `fork` as
    `abort('fork not supported in sync Browsix')` gated on `#if EMTERPRETIFY_ASYNC` — the later
    branch says *`TODO:` not currently supported*. Its §6 says outright that a `setcontext`
    equivalent plus SharedArrayBuffers "would let BROWSIX support fork … as a synchronous system
    call". That ingredient shipped in 2019 as Emscripten Asyncify. Fork was **demonstrated working
    in Chrome 157** for this project, twice: `sharrattj/dash` doing command substitution through
    real `__wasi_proc_fork` under `@wasmer/sdk`, and a from-scratch `wasm-opt --asyncify` build
    forking across a Worker boundary through the `Atomics.wait` channel — child returned 0, parent
    the pid, locals restored.

    *Why the constraint stands anyway*, per case:
    - **A JS process cannot fork, at any price.** Closures, generators and Promises are
      un-cloneable (measured `DataCloneError`), and no realm-snapshot API exists — 1,269 globals
      enumerated, `ShadowRealm` undefined. Browsix said the same in §3.5; its fork was only ever
      for C/C++. **v1 runs JS, so v1 has no fork.**
    - **A stock `wasm32-wasip1` binary cannot fork.** Nothing in Chrome 157's `WebAssembly`
      namespace reads or writes a call stack. It needs a rebuild with `wasm-opt --asyncify`,
      wasix-libc, the `wasix_32v1` import namespace, and `shared` memory. Option B's "unmodified
      binaries" premise and fork are mutually exclusive.
    - **Neither future proposal rescues it.** Stack-switching continuations are single-shot by
      design and the Explainer explicitly declines process duplication. Adopting JSPI for the
      syscall channel would *destroy* the Asyncify path, because a JSPI stack has no JS-visible
      handle to copy.
    - **The cost is a frame.** Fork is a whole-heap memcpy: 16 MiB 3.3 ms, 64 MiB 16.6 ms,
      256 MiB 85.7 ms — and it must run on the kernel worker's own thread, because a
      `WebAssembly.Memory` buffer is neither detachable nor `structuredClone`-able. The kernel
      stalls for the duration. Asyncify also taxes every function ~50% in size and speed, and
      excludes wasm exception handling in WASIX's shipping config.

    `research/gap-07-fork.md`, `research/gap-02.md`, `research/gap-03.md`.
20a. The shell's real casualty is not `( subshell )`. Pipelines, `&`, `$(…)`, `&&`,
    `while read … < file`, `<(cmd)`, `coproc`, `trap`, `exec`, `wait` and `jobs` all reach the user
    on `spawn` + `pipe` + `setpgid`, and an in-process subshell is *more* POSIX-conformant for
    `$$`, `$!` and `PPID` than a spawned one. What cannot work is **concurrency between two
    shell-internal commands in one pipeline** — `f | g` where both are functions — because one
    Worker cannot run both, and serialising deadlocks once the kernel pipe buffer fills. Every
    fork-free shell buys this back with a thread (mvdan/sh uses a goroutine) or a re-exec carrying
    serialised state (hush's `re_execute_shell`; busybox-w32's `spawn_forkshell`, ~730 lines).
    A second shell worker MUST be budgeted, or the deadlock accepted and documented.
    Two further consequences: an in-process pipeline tail puts `last=$x` in the zsh/ksh camp rather
    than the bash/dash one (POSIX permits either), and `fg`/`bg`/`^Z` are limited by constraint 21
    and `Worker.terminate()` — not by fork. `research/gap-07-fork.md`.
21. There is no preemption. A compute-bound process is killable but not interruptible, so a cancel
    affordance MUST degrade to SIGKILL and the UI MUST show that distinction.
    `research/gap-03.md`.

## The filesystem

22. `open()` MUST be rare and fd-based I/O common — which is POSIX's shape, arrived at from the
    measurements rather than from imitation. `createSyncAccessHandle` costs 495 µs: 100× a syscall
    and 100× a 4 KiB write. Handles live in a kernel-side descriptor table.
    `research/gap-04.md`.
23. `fsync` MUST be a separate syscall from `write`. `flush()` is 260 µs against a 5 µs 4 KiB
    write; flushing per write makes the VFS 50× slower for durability nobody asked for.
    `research/gap-04.md`.
24. A path MUST NOT cost a syscall per component. `getDirectoryHandle` is 85 µs, so a 4-component
    walk is 340 µs — 23 syscalls. Resolve to an inode once in the kernel, cache it, and hand the
    process an fd. `research/gap-04.md`.
25. POSIX metadata MUST live outside OPFS, which has no mode bits, no uid/gid, no symlinks, and no
    settable `lastModified`. The design is an authoritative in-memory inode table in the kernel
    worker, persisted as an OPFS superblock snapshot plus an append-only OPFS journal, with file
    data in a flat OPFS directory named by inode number. `stat` 27 ns, path walk 370 ns, boot
    7.2 ms at 10k inodes. `research/gap-06.md`.
    **Corrected at M2: a blob is named `<ino>.<gen>`, not `<ino>`.** The directory is still flat and
    still keyed by inode — the suffix says which *generation* of that inode's bytes it holds, which
    is what copy-on-write needs (constraint 60). Exactly one generation at a time is the one the
    metadata points at.
26. The blob directory MUST stay flat. Chrome 157 has no `FileSystemDirectoryHandle.move()`, and
    the one-argument rename does not exist in Safari 27.2; the only portable primitive is
    `fileHandle.move(dirHandle, name)`. `research/gap-06.md`.
27. IndexedDB MUST be used for exactly one job — storing `FileSystemDirectoryHandle`s for host
    mounts — which keeps the two-store crash-consistency problem out of the hot path.
    `research/gap-06.md`.
28. `fsck` MUST NOT silently reseed. A snapshot that fails validation mounts read-only and surfaces
    the failure. webxp resets on a bad image; that behaviour MUST NOT survive into a filesystem
    holding real user data. `research/gap-06.md`.
29. A credential MUST be a per-call argument, not instance state, or every process shares one
    identity and mode bits mean nothing. File data MUST be bytes, not JS strings. Both are changes
    to webxp's `shared/fs/vfs.mjs`, which is otherwise reusable above the store.
    `research/gap-06.md`.

## Deployment

30. `COOP: same-origin` and `COEP: require-corp` are required and are settable on Cloudflare Pages,
    Netlify, Vercel, Firebase Hosting, CloudFront and nginx. They are NOT settable on GitHub Pages
    or bare S3 except via `coi-serviceworker`, which costs an unconditional reload and leaves the
    first paint un-isolated. `research/gap-05.md`.
31. `require-corp` is the only Safari-portable value. COEP `credentialless` is Chrome 96 /
    Firefox 119 / Safari none, so it is a relaxation and never a plan. Consequence: self-host every
    font, icon and asset, and route every remote image through one helper that sets
    `crossorigin="anonymous"`. `research/gap-05.md`.
32. Third-party iframe embeds cannot run inside the isolated document. YouTube sends CORP
    cross-origin but only `COEP-Report-Only`, so it is blocked. Such content needs a separate
    non-isolated top-level window, or it does not exist. `research/gap-05.md`.
33. Safari 27.2 runs everything here except host-directory mounts — `showDirectoryPicker` is absent.
    Safari OPFS directory enumeration is 0.60 ms per name, 55× Chrome, so 10k names is ~6 s: orphan
    collection belongs on an idle task or an explicit fsck, never at boot. The mount table MUST
    treat drivers as optional. `research/gap-06.md`.

## The surface

34. Aero is an additive composite, not a translucent panel: blurred RGB at `blurBalance` 0.49, a
    Rec.709 luminance copy tinted by `afterglow` 0.43, and a flat colorization tint at 0.08, over
    `RGB(116,184,252)`, summed with PLUS so it can clip above 1.0. `research/06-aero-spec.md`.
35. The highlight streak is anchored to the monitor, not the window, and parallaxed at 0.1. That is
    an argument for a compositor layer owning the backdrop rather than per-window CSS.
    `research/06-aero-spec.md`.
36. The blur budget is ~58–63 M blurred device px per frame. At dpr 2 that is about 51 windows of
    640×440 but only about 13 full-screen ones, so the limit binds on window AREA, not window
    count. Cap total blurred area and drop to a cheap fill when a drag would cross the budget.
    Measured on one machine, one 120 Hz panel, dpr 2 — a 60 Hz display has twice the budget per
    frame and an integrated GPU far less. `research/gap-04.md`.
37. Segoe UI MUST NOT be shipped; it is not redistributable. Selawik is NOT documented as
    metric-compatible with it and its README lists missing kerning as an open issue, so metric
    compatibility MUST NOT be assumed — layouts have to be tested against both. Win7 icons and
    glass bitmaps MUST be redrawn. `research/gap-05.md`.

## What the review added

These came out of critique rather than measurement: 24 findings survived an adversarial verifier
whose default was to refute. The three marked *every design* were judged properties of the problem
rather than of the candidate they were raised against. `designs/REVIEW-FINDINGS.md`.

41. A process worker MUST have its realm neutered before program text is evaluated. A same-origin
    dedicated worker holds ambient OPFS access, so a program can open the kernel's own blob store
    by inode and write it, bypassing the credential, the mode bits and the syscall channel
    entirely. Delete the `WorkerNavigator.prototype.storage` getter and `fetch`,
    `XMLHttpRequest`, `importScripts`, `indexedDB`, `caches`, `WebSocket` and `Worker`. This is
    hardening, not a security boundary — same-origin is not a security boundary — and MUST be
    labelled as such wherever it is documented. *Every design.*
    **`SharedWorker` and `URL.createObjectURL` MUST go with them**, and the list is not only about
    the filesystem: an un-stripped `Worker` also defeats the process table's cap, which makes this
    a correctness requirement and not only a hardening one. Constraint 53 carries the measurement.
42. A window MUST be a file description, not a bare handle, and `poll()` MUST be the single wait
    primitive over fds. A process has one futex word and one outstanding call, so a process with
    two windows — or one window plus a pipe — cannot otherwise be woken by both.
43. The ABI MUST carry a content protocol for the inside of a window. `create` / `set` / `destroy`
    / `poll` describe a frame and nothing within it; without a surface call, every app that is not
    a terminal is a frame around nothing, and file associations and "Open With" have nothing to
    open into.
44. `win_create` MUST carry `owner` and `modal`, and a close MUST be a request the owner can
    refuse. Without an owner chain a dialog sits behind the window that owns it; without a
    close-request event, unsaved work is discarded silently. *Every design.*
45. The clipboard MUST be typed and kernel-owned, and drag-and-drop between processes MUST exist in
    the ABI. A single untyped byte blob cannot carry an image between two apps, and these are the
    two gestures that make a set of windows read as one system rather than several websites.
    *Every design.*
46. A blocking syscall MUST park with a finite re-arm interval and check a kernel heartbeat word,
    never an unbounded `Atomics.wait`. Unbounded, a kernel that throws wedges every process
    forever. But the timeout MUST NOT itself fault the process: no fixed timeout can separate a
    dead kernel from `sleep 100` or an idle `waitpid`, so the heartbeat is the liveness signal and
    the timeout is only the re-arm.
47. OPFS sync access handles MUST be refcounted per inode beneath the fd table. They are an
    exclusive lock per file, so a second `open()` of the same file throws
    `NoModificationAllowedError` — `cat notes.txt | wc -l` fails while an editor holds the file.
48. The boot lock MUST retry for longer than the terminate abort grace before declaring another
    tab. Taking the journal's sync handle as the mutex is correct, but a plain reload races the
    previous kernel's handle, so a normal reboot otherwise comes up read-only at random.
49. `backdrop-filter` filters the element's BORDER BOX, so a blur-area governor MUST account the
    border box and not the visible ring. A maximized 1280×720 CSS window at dpr 2 filters
    3.69 M device px; its frame ring — 30 px caption, 6 px borders — is 0.22 M. A ring-based
    governor therefore under-reads by ~17× and would permit about 260 maximized windows against
    the measured ceiling of ~13 (constraint 36). The governor MUST be an admission controller over
    every area-changing event — open, maximize, snap, restore, un-minimize, peek — not a drag
    hook, and MUST degrade by z-order from the bottom.
    Five maximized windows are 18.4 M device px and are comfortably UNDER the wall; a gate sized
    at five cannot fail. An over-cap state needs ~16 maximized windows, or ~52 glass terminals at
    640×440 (53.7 M, derived from gap-04's measured 31.0 M at 30 such windows).
50. An Aero pixel check MUST sample across a high-contrast backdrop edge and assert the gradient.
    Over a flat backdrop `blur(flat) == flat`, so the assertion passes identically with
    `backdrop-filter: none` — the same class of defect as constraint 39.

## What the predecessor established

38. Discipline does not substitute for a boundary. webxp's apps were ES modules importing
    `shared/fs/fs.mjs` directly, and each app WAS its window, so nothing was isolated, killable or
    backgroundable. daedalOS reaches the same place by a different road and pays for it in
    `utils/globals.ts`, which patches `window.define` with a getter that parses `new Error().stack`
    to decide which app receives the value, and hand-deletes global names after certain apps close.
    `research/01-daedalos.md`.
39. A check that reports success MUST be shown capable of failing. webxp shipped a contrast
    assertion that read `color` from the wrong element, compared black against itself, and passed
    on any stylesheet including white-on-white. `scripts/check.py --prove-failure` exists because of
    it. See `../../webxp/docs/review.md`, finding 2.
40. A window manager cannot be checked by screenshot: an inert frame and a working one are the same
    picture. What separates them is whether the numbers changed after a drag.
    `../../webxp/scripts/check.py`.

## What M0 measured

M0 built the channel and measured it under contention, which is what the 14–16 µs figure in
constraint 5 had never been. Every figure in 51–56 was produced on **Chrome 157.0.8103.52**, macOS
Darwin 25.6.0, Apple M2 Pro, `navigator.hardwareConcurrency` 12, headless — a *different patch
build* from the 157.0.8103.38 the rest of this file was measured on, which is stated because it is
a different measurement and not a continuation of the old one.

51. The channel holds under contention to N=16 and degrades predictably past it. Closed-loop
    saturation, every process issuing its next call the instant the last returned, barrier-held
    windows overlapping ≥99.9%, release ramp and ramp-down excluded from the statistics:

    | N | mean | p50 | p95 | p99 | throughput |
    |---|---|---|---|---|---|
    | 1 | 15.8–16.0 µs | — | 25 µs | 35 µs | ~61 k calls/s |
    | 4 | 29.0–30.0 µs | 25–30 µs | 45–50 µs | 65–75 µs | ~131 k/s |
    | 16 | 91.8–98.1 µs | 85–90 µs | 125–140 µs | **200–255 µs** | ~162 k/s |
    | 64 | 393–426 µs | 365–370 µs | 480–625 µs | 1030–1360 µs | ~156 k/s |
    | 128 | 881 µs | 790 µs | 1305 µs | 3062 µs | ~145 k/s |

    **The N=1 mean reproduces constraint 5's 14–16 µs on a different build**, which is the strongest
    cross-check available for that figure. M0's accept bar — p99 under 500 µs at N=16 — is met with
    about 2× margin on the worst of three runs.

    **Re-measured after M0a and M0b changed the kernel** — new syscalls, `settle()`, `later()`, and
    the I/O worker — the same sweep gives **ACCEPT at p99 250 µs**, worst of three runs, 3 of 3
    producing a figure. So the headline survived the work done on the strength of it, which is the
    only reason it can still be quoted. The N=128 cell now reports as **N=127, clamped**, because
    `--hb` adds an observer process and 128 + 1 exceeds the 128-slot table (constraint 17); the
    clamp states itself rather than appearing as a failure. **The 2 ms kill bar is exceeded at N=128 (3.06 ms
    p99), and 99.98% of calls there are past 500 µs.** That is not a kill, because the bar is
    specified at N=16, but it is the honest shape of a single-threaded kernel: past ~16 concurrent
    callers queueing dominates, and the sharded-kernel question M0 deferred becomes live somewhere
    between 16 and 64 rather than never. `bench/syscall-contention/probe.py --n 1,4,16,64,128
    --window-ms 3000 --runs 3`, artifact `bench/syscall-contention/results-sweep.json`.
52. `performance.now()` is clamped to **5.000 µs** in a cross-origin isolated agent and
    **100.000 µs** without isolation, identically on the main thread and in a dedicated worker. The
    clamp is hard, not noisy: 99.8% of 79,866 non-zero deltas were exactly one quantum, across only
    14 distinct values, every one an exact integer multiple. Consequences, both load-bearing: a
    per-call p99 is trustworthy at the 500 µs and 2 ms bars (100 and 400 quanta, agreeing with an
    independent clock to 0.2–1.5%) and **meaningless at 14 µs**, which is 2.8 quanta and where the
    distribution collapses to {5, 10, 15, 20} µs and p50 came out 10–17% wrong. A 14 µs figure must
    therefore be a batch mean, never a percentile. A spinning-`Atomics` counter is ~470× finer at
    idle (7.8–10.8 ns/tick) but loses 7–55× of that under 128 busy workers and has no reference
    independent of `performance.now()`, so it was rejected. `tmp/m0-probe-timer/probe.py`, reported
    in full in `MILESTONES.md` §M0.
53. **A process worker can construct its own worker, so the cap in constraint 17 is not enforced
    until the realm is stripped.** Confirmed at depth 3: a process built a worker that held the
    kernel's SAB, was `crossOriginIsolated`, and could block. That worker is invisible to the
    process table while still consuming a renderer-wide worker slot, so the kernel enforces its cap
    over a number that is not the real one. This widens constraint 41 past "hardening": the realm
    lockdown must also delete `SharedWorker` and `URL.createObjectURL`, or make `Worker` a stub that
    becomes a `spawn` syscall, and **until M6 lands, the cap is advisory.** M0's process table says
    so where it checks the cap. `tmp/m0-probe-nested/probe.py`.
54. **For handlers of a few microseconds**, the kernel's per-message cost dominates its handler
    work. At N=128 the in-handler mean is 3.03 µs against a serving rate of ~145 k calls/s, i.e.
    ρ ≈ 0.44 — the kernel is busy inside its handlers only 44% of the time it is saturated, and the
    remaining 56% is `postMessage` dispatch and wake overhead. A handler made twice as fast would
    move the headline by far less than half. `bench/syscall-contention/results-sweep.json`.

    **The scope of that sentence is load-bearing and an earlier draft of this constraint omitted
    it.** M0's three calls were `getpid`, `write(1, …)` to an in-memory sink, and `clock_nanosleep`
    — none of which touches storage, so the measured handler cost is 2–3 µs. A real `open()` is
    **495 µs** (constraint 22) and a `flush()` is **260 µs** (23), which is 85–250× the handler
    M0 measured. The kernel is one thread serving every process, so a single slow `open` is
    head-of-line blocking for all of them: a `getpid` queued behind someone else's `open` cannot
    return in 15 µs no matter how cheap `getpid` is. **M0's p99 of 255 µs at N=16 is therefore a
    true figure about a mix containing no I/O, and the generalisation "handlers are not the thing to
    optimise" does NOT survive the first OPFS call entering the mix.** Constraint 57 is the
    measurement that settles it; until that is taken, no conclusion about the kernel under a
    realistic mix is available from M0.
57. **A syscall that must wait MUST NOT hold the kernel thread.** Three independent hobbyist
    kernels converge on this rule and none of them services a slow request inline: HelenOS holds a
    per-fd lock across a downstream call, SerenityOS splits a slow request into a ticket plus an
    async completion, and Orbital parks on the resource and replies out of order.
    `research/09-hobbyist-os-actions.md` §1 — **not yet in this branch**: it is on
    `worktree-learning-mode`, written by a parallel session, and this citation resolves only
    once that branch merges. Flagged rather than dropped, per the rule that an unsourced claim
    says so.

    The consequence for this project is that the kernel's dispatch must be able to reply out of
    order, which M0's design already permits — the reply is addressed by `CALLID` and the process
    parks on `SEQ` — but which M0 never exercised, because every call it measured completed inline.
    **If the measurement in 54 shows cheap calls inheriting an `open`'s latency, the first fallback
    is a second kernel-side I/O worker owning the OPFS handles, not a sharded kernel.** That is a
    far smaller change: constraint 15 forbids a releasable resource living in a *process*, and an
    I/O worker is kernel-side, so the handles stay where they are required to be while the dispatch
    thread stops blocking on them. Sharding the kernel per process group remains the larger and
    later option.

    A kernel that replies out of order MUST also specify its queue drain order, or it can livelock:
    drain notifications first, then in-flight answers, then new requests. That is HelenOS's order
    and the standard defence. Same source, same caveat.
58. **A second kernel-side I/O worker is REQUIRED before M2, not a fallback.** M0a measured it:
    one process calling `fsync` in a loop destroys every other process's latency, and the damage
    is not marginal.

    | I/O procs of 16 | cheap p50 | cheap p99 | I/O p99 |
    |---|---|---|---|
    | 0 | **105 µs** | 275 µs | — |
    | 1 | 280 µs | 850 µs | 860 µs |
    | 2 | 545 µs | 1,820 µs | 1,815 µs |
    | 4 | 840 µs | **2,000 µs** | 2,000 µs |

    With a **single** I/O process: cheap p99 is 815 µs at N=4, 850 µs at N=16, and **2,657 µs at
    N=64 — past M0's own 2 ms kill bar.** At every level the cheap p99 and the I/O p99 are within
    1.3×, which is the signature of head-of-line blocking: a `getpid` is not a cheap call any more,
    it is whatever the call in front of it was.

    **The asymmetry is the actionable part, and it is the reverse of how the two raw costs read.**
    `createSyncAccessHandle` is the expensive OPERATION at 495 µs (constraint 22) but it returns a
    promise, so it is awaited off the dispatch path and costs other processes nothing.
    `FileSystemSyncAccessHandle.flush()` is the cheap-sounding one at 260 µs (constraint 23) but it
    is SYNCHRONOUS, so every microsecond is kernel thread no other process can use. **`fsync` is
    the call to get off the dispatch thread; `open` already is.** Constraint 23 required the split
    for throughput and this is the stronger, latency argument for the same split.

    So M0's ACCEPT (constraint 51) stands for a mix with no I/O in it and does not survive a
    realistic one. The remedy is named in constraint 57 and is now scheduled rather than
    contingent: the OPFS handles move to a second kernel-side worker, which constraint 15 permits
    because an I/O worker is kernel-side. Sharding the kernel per process group is still not
    required. `bench/syscall-contention/probe.py --n 16 --call io --io-procs 1` and its control,
    `--call getpid`, which returns cheap p50 to 105 µs and so couples the effect to the I/O rather
    than to the mix machinery.
59. **The I/O worker fixes it, and the trade is 30% of uncontended throughput.** M0b moved the
    handles to `src/kernel/io-worker.mjs`. Cheap-call latency with K processes doing file I/O,
    against the inline design it replaces:

    | | worker | inline |
    |---|---|---|
    | N=16, K=1 | 105 / **185 µs** | 360 / 2,657 µs |
    | N=16, K=2 | 100 / **290 µs** | 420 / 1,275 µs |
    | N=16, K=4 | 85 / **225 µs** | — |
    | N=64, K=1 | 450 / **795 µs** | 685 / 2,000 µs |

    (cheap p50 / cheap p99.) Every cheap p99 at N=16 is under the 500 µs accept bar, and cheap p50
    returns to the 85–105 µs no-I/O baseline. The cheap-to-I/O p99 ratio goes from 1.3× — calls
    indistinguishable from each other — to 7.4×, which is what a kernel that is not head-of-line
    blocked looks like.

    **The cost, stated because a fix measured only where it helps is a fix nobody can price.** A
    write is now a message to another agent, so a single process doing nothing but `write` +
    `fsync` gets **30% fewer operations through** (2,631 against 3,765 in the same window) and its
    mean rises 43% (378 µs against 264 µs). Its p50 barely moves, 280 µs against 270 µs. The
    threshold set before measuring was "if uncontended write latency more than doubles, the trade
    needs restating" — it did not, so the trade stands: 30% of single-process throughput to remove
    blocking that reached the kill bar at N=64.

    **The write is zero-copy**, which is why the cost is a message and not a message plus a copy:
    the I/O worker reads the payload directly out of the calling process's SAB, which is safe
    because that process is parked until the dispatch kernel bumps its `SEQ`, and the dispatch
    kernel does not bump it until the I/O worker has answered.

    The negative control is `--io-inline`, which routes storage back onto the dispatch thread and
    reproduces the inline column above. A fix that cannot be switched off has not been shown to be
    the thing that worked.
60. **File data MUST be copy-on-write. Durability is NOT metadata-only.** An overwrite stages a new
    blob generation, writes it, flushes it, and only then swings the inode's reference in the
    journal; the superseded generation is freed after the commit. Write ordering is
    blob → flush → **validate** → apply in memory → journal → flush.

    **Corrected during M2.** The ordering above originally ended "journal → flush → apply in
    memory", and that order is what made an unprivileged write sequence able to brick a volume:
    `applyOp` can refuse a commit, and a refusal arriving *after* the record is durable means replay
    must refuse it too — measured as a mount coming up read-only having applied 51 of 54 records and
    discarded the rest, including a `mkdir` that had already returned success. Every metadata op
    already decided before journalling; the data path now agrees with them.

    What constraint 60 buys is unchanged and is the thing to preserve: **no record may point at
    data that is not durable.** The blob is still written and flushed before anything references it.
    What moved is the *validation*, from after durability to before it, which is strictly safer. The
    residue is named where it is taken: an apply whose journal append then fails is undone in memory
    (`vfs.revertCommit`), because a published size that no record accounts for is worse than a lost
    swing.

    M2's spec offered two answers and required one to be chosen there rather than discovered later.
    The rejected one — declaring the guarantee metadata-only — is exactly ext4's `data=writeback`,
    which is **not ext4's default precisely because it leaves intact metadata pointing at torn
    data**. Copy-on-write is nearly free here because a blob name is an integer plus a generation,
    so "write a new one and swing the reference" costs a rename of a reference rather than a copy
    of a file. `research/09-hobbyist-os-actions.md` §5, `designs/` and `DECISIONS.md` D17.

    **The append exception, and the reason it is not a loophole.** A write landing entirely at or
    beyond the committed size appends into the current generation. The committed `size` does not
    name those bytes, so a torn append can only damage bytes nobody had committed, and a crash
    leaves the metadata pointing at the intact prefix it already pointed at. Without this split a
    sequential appender copies its whole file on every `fsync` and the cost is quadratic — measured
    at 10,000 files: 0 copy-ups, 10,000 swings.

    **The test for the exception MUST read the inode's CURRENT committed size, never a
    per-description snapshot.** This was wrong first and it is the sharpest trap in the design:
    with two file descriptions open on one inode, fd1 appending past the committed size and
    fsyncing publishes a larger size, after which fd2 — still holding the size it saw at open —
    computes that *its* write is an append when it is now 32 bytes below the committed size, and
    overwrites committed data in place. A per-description cache of a value another description can
    change is a stale read by construction. Found by attacking the built code with two real fds,
    not by a mutation.

    **Constraint 47 arbitrates the swing, not the directory.** Two generations exist briefly for
    one logical file, so a reader holding the old one must keep reading it while a new opener gets
    the new one. The per-inode refcount under the fd table defers the directory removal until the
    last reference closes. Measured: blobs `[19.1, 20.1, 21.1, 22.1]` → `[19.1, 20.1, 20.2, 21.1,
    22.1]`, one deferred free, zero immediate frees — the superseded blob outlived its reader
    because the refcount said so.
55. A terminated kernel's nested process workers keep running for about **2.0 s**, which reproduces
    constraint 14 one level down the worker tree: `terminate()` on the kernel does not reap what the
    kernel spawned. Measured twice by renderer CPU time, 3.27 → 5.30 s over the 2.3 s after
    `terminate()`, then flat. A bench that starts its next cell inside that window measures its own
    orphans, which is why M0 runs one fresh browser per cell and asserts quiescence before taking a
    figure. `tmp/orphan.py`.
56. The kernel's own timer starves under saturation, and this is the input that sets the heartbeat
    threshold. Kernel tick gap, nominal 10 ms: p999 15.5 ms at N=1, 19.0 ms at N=4, 33.0 ms at
    N=16, 41.5 ms at N=64, 58.5 ms at N=128 — against a death threshold of
    `REARM_MS × (HB_MISS_LIMIT + 1)` = 200 ms. So the margin at N=128 is about 3.4×, and the
    threshold must not be set from the nominal period. The reverse consequence binds M2:
    **a kernel that is alive but synchronously busy for longer than the threshold is declared dead
    by every parked process**, which puts a hard ceiling on any synchronous kernel work — M2's
    `flush()` is 260 µs and its snapshot is not yet measured. Constraint 46 leaves no way around
    this, because no fixed timeout can separate a dead kernel from `sleep 100`.
    `bench/syscall-contention/results-sweep.json`, heartbeat-gap rows.

## What M2 left open, on the record

M2 was verified in eight rounds. Each round's attacks found defects the previous round's fix had not
covered, and the record of *how* that converged is in `MILESTONES.md` §M2 because it is the useful
part. These are what remain. Every one has an address and a reproduction, because the alternative —
a limitation nobody wrote down — is the outcome M2's own spec names as the bad one: *discovering a
data-consistency property after a user has files*.

Three kinds, filed differently. A **defect** is wrong and unfixed. A **permitted** behaviour is a
recorded decision with a cost. A **structural** item needs a mechanism M2 does not own.

61. **STRUCTURAL — the in-memory apply is not under the volume lock.** A metadata op applied inside
    a snapshot's window lands in both the image and the journal, and the next mount refuses the
    duplicate. `src/kernel/calls.mjs:171-190` applies synchronously in `decide()` and journals
    after; the volume lock covers the record and not the apply. Closing it means `metaOp` taking the
    volume lock, which crosses the `calls`/`store` boundary. Reachable without a crash only while a
    snapshot is in flight. **Surfaced:** the next mount reports it.
62. **PERMITTED — the boot mount cannot report a blob the metadata names and the directory lacks.**
    `BOOT_CFG` does not set `sweepBlobs`, so `store.mjs` passes `blobs: null` to fsck at boot. The
    reason is constraint 33: Safari enumerates OPFS directory names at 0.60 ms each, so 10k names
    is ~6 s, and constraint 33 already requires orphan collection to live on an idle task or an
    explicit fsck rather than at boot. **Surfaced:** an explicit fsck reports it; the mount does not.
63. **PERMITTED — slack is reported and never reclaimed.** A blob longer than its published size is
    listed in `fsck`'s `long` arm with its reclaimable bytes, and the mount is not refused: the
    bytes above the published size are not data, and a mount must not write. **Surfaced:** yes, by
    `fsck`; it persists until that generation is superseded.
64. **STRUCTURAL — the lock lint proves taker membership, not coverage.** `scripts/fsfuzz.py`'s
    rules catch a `withInode` call outside the declared takers and a taker called from inside the
    module, which is what makes the deadlock rule enforceable. They cannot see a durable
    read-then-mutate that simply never calls `withInode` at all. The defence against that is the
    mechanical await enumeration recorded in `MILESTONES.md` §M2, which is a measurement rather than
    a gate.
65. **STRUCTURAL — the harness cannot force an interleave inside one syscall's own `await`, and no
    in-session check can produce a true mid-operation crash.** Every crash-shaped state in the
    proofs is injected page-side, because a kernel's own fd teardown commits a dirty description and
    so cannot leave one. The per-inode lock removes the hazard *within* a mount; the CAS is what
    defends a replayed record after one.
66. **PERMITTED — a burned journal sequence stops replay at the hole until the next snapshot.** A
    failed append burns its number rather than rolling back, because a later caller may already hold
    `seq + 1`. The trade is deliberate: without the burn, the first failed append refuses every
    record for the life of the mount. A snapshot clears it. **Surfaced:** the mount reports the
    discarded tail.
67. **PERMITTED — a write whose syscall teardown refused can still become durable.**
    `src/kernel/kernel.mjs` answers the in-flight call with the teardown errno and then closes the
    fds *without* awaiting, because constraint 14 forbids awaiting there — `terminate()` offers no
    chance to finish. The ~2 s quarantine is what makes it survivable. This is the tension between
    constraints 14 and 23, not a defect with a local fix.
68. **STRUCTURAL — `restage` re-copies the whole base per attempt**, so a commit that loses its base
    *n* times costs *n+1* full-file copies for one `fsync`. Unpriced above small files; the
    per-inode lock makes a loss happen at most once within a mount, which is why it has not been
    measured. `readRebases` and `restages` are counted in the storage stats.
69. **STRUCTURAL — the staged generation's modification log grows with the number of disjoint dirty
    ranges** a description writes between its copy-up and its commit. Contiguous and overlapping
    writes coalesce, so a sequential writer is one entry however many calls it makes; a scattered
    writer is not bounded and nothing checks it.
70. **STRUCTURAL — no registered check exercises `O_APPEND` from two processes**, and `pwrite` under
    `O_APPEND` is unchecked. The registered check is one process with two descriptions, serial.
    POSIX and Linux disagree about whether `pwrite` appends under `O_APPEND`; this implementation
    honours the explicit offset, which is POSIX, and says so where it is decided.
71. **STRUCTURAL — the explicit `fsck` takes no volume lock**, so it can read the journal while an
    append is in flight and report a torn record on a healthy volume. Low: the figure it produces is
    conservative in the safe direction — it reports a problem that is not there, rather than missing
    one that is.

## What M3 measured

Chrome 157.0.8103.52 / macOS 26.7.2 / Apple M2 Pro unless a row names a different harness. The two
trace figures were taken under **Node 18.20.2 on darwin/arm64**, not in Chrome, and say so — the
numbers are of one typed-array write loop, which is the same shape of work in both agents, but the
figure has not been retaken in the browser.

72. **A trace record costs 19.4 ns when the timestamp is passed in, and 56.0 ns when the record
    reads its own clock.** `Date.now()` is 52.9 ns and `performance.now()` is 69.0 ns, against nine
    typed-array stores at 9.0 ns — so the clock read is 85% of a self-timing record. The dispatcher
    already reads `performance.now()` twice per syscall for its own service accounting, so entry
    and exit hand those two values to the ring and the trace adds **no clock read at all**.
    `node bench/m3-trace/probe.mjs`.
    **This corrects `MILESTONES.md` M3's 4 ns figure, which is ~5× low.** The conclusion it
    supported survives and the arithmetic changes: two records per syscall is 38.8 ns against a
    14 µs syscall, so tracing costs **0.28%** rather than 0.03%, and is still cheap enough to be
    always on with no flag.
73. **A record is 32 bytes, and that is derived rather than chosen.** `MILESTONES.md` M3 states a
    1 MiB ring holds 32,768 records, and 1 MiB / 32,768 is 32. `src/kernel/trace.mjs`'s `selfTest`
    asserts the two agree, so a layout change fires an assertion instead of leaving a normative
    document wrong. The 16 MiB floor is 524,288 records.
74. **A generated file whose content is computed per read cannot publish a size.** `stat` on
    `/proc/<pid>/status` reported 147 bytes and the following `read` returned 145: the file carries
    the process's syscall counters, so reading it advances them and the generator ran twice with
    different answers. Such a file therefore reports **size 0**, which is what Linux's own `/proc`
    does. `fstat` on an open description reports an exact size, because the bytes were snapshotted
    at `open` and that length is stable for the life of the fd — the two calls answer differently
    on purpose. `www/m3.html` proof `proc_files`; `src/kernel/synth.mjs` `#info`.
75. **The kernel's account of a process must be stamped after the program's data, never before.**
    The result row spread a program's return over `pid`, `calls`, `replies` and `errors`, so a
    program returning a field called `pid` relabelled its own row — a `go` dispatched to pid 1 came
    back as pid 2. Beyond the confusion, it is a forgery surface: those four fields are the
    kernel's statement about a process and a process must not be able to write them.
    `src/kernel/kernel.mjs`, the `result` arm.
76. **The harness is a storage provider, so `scripts/serve.py` must serve byte ranges.**
    `src/kernel/providers.mjs`'s `local` row points at the page's own origin, and before this the
    server answered a ranged request with 200 and the whole file — the `unpkg.com` failure of
    constraint-adjacent note in `docs/LEARNING-MODE.md` §5, reproduced locally. The capability probe
    correctly refused to mount `/usr` over it. Single ranges only; multipart and unsatisfiable
    ranges are 416. `scripts/check.py`'s recording handler subclasses that one, so both gained it,
    and the witness counts 206 as served — a 206 body is a fragment and is deliberately not
    byte-compared against disk.

## What M3 left open, on the record

Same three kinds as M2's list above: a **defect** is wrong and unfixed, a **permitted** behaviour is
a recorded decision with a cost, a **structural** item needs a mechanism M3 does not own.

77. **STRUCTURAL — a symlink cannot cross a mount.** A symlink is resolved inside the filesystem
    that holds it, so one on the OPFS volume pointing into `/proc` resolves against the OPFS volume
    and reaches ENOENT. Closing it means the walk itself consulting the mount table at every
    component, which `src/kernel/calls.mjs`'s `resolveMount` does once, at the edge, before the
    walk. Nothing in M3 crosses a mount by symlink. `SynthFS.lstat` throws EIO rather than return a
    LINK node, so a generated filesystem that grew a symlink would fail loudly instead of
    half-working.
78. **PERMITTED — `/usr` costs its whole size in memory, and the mount is atomic.** Every object in
    the manifest is read at boot and held; a refusal anywhere refuses the whole mount. That is what
    makes the second negative control possible — "the mount must fail loudly, never silently serve
    an empty `/usr`" — and it is **not** a design for a large read-only volume. A real one wants the
    lazy ranged read `providers.mjs` already implements, a cache, and a description kind that can
    block on it. `src/kernel/providerfs.mjs` says so where the policy is set.
79. **PERMITTED — `/proc/<pid>/cwd` and `/proc/<pid>/fd/<n>` are files, not symlinks.** Linux makes
    both symlinks. They are files holding the facts here because constraint 77 means a generated
    symlink could not be followed, and because an fd on a pipe or a window has no path to point at
    in the first place.
80. **PERMITTED — `/tmp` reuses the VFS, so POSIX semantics have one implementation.**
    `src/kernel/tmpfs.mjs` is a `VFS` instance for the metadata plus a `Map` from inode to bytes,
    and `F_TMP` is a writable synchronous description kind. Writing a second filesystem would have
    been two renderers of one fact, and the second would be the one with the permission bug. The
    size goes through the VFS's own `OP.COMMIT` rather than a poke at `inode.size`, so that field
    keeps one writer. It is bounded (64 MiB by default, ENOSPC past it) because a tmpfs with no
    limit lets one process exhaust the renderer's heap and take every other process with it — the
    same argument as constraint 17's process cap. **The sticky bit is stored and not enforced:**
    the root is 0o1777 as `/tmp` is everywhere, and the VFS has no sticky rule, so the mode is
    honest and the protection is not.
81. **STRUCTURAL — there is no `chdir`, so every process's cwd is `/`.** `src/kernel/table.mjs`
    records that the `cwd` field is M2's and the call that moves it is M3's; M3 made the field
    OBSERVABLE through `/proc/<pid>/cwd` and did not add the call. The field is read live, so a
    `chdir` would be a handler and nothing else — `absoluteOf` in `calls.mjs` already resolves every
    relative path against `p.cwd`.
82. **PERMITTED — a directory cannot be opened without `O_DIRECTORY`, which diverges from Linux.**
    `src/fs/vfs.mjs`'s `openDecision` refuses a directory with EISDIR unless `dirOk` is set, and M3
    made `src/kernel/synth.mjs` match it so this system has ONE answer to "can I open a directory".
    On Linux `open(dir, O_RDONLY)` succeeds and `read` on the fd is EISDIR; here the refusal moves
    to `open`. The divergence is the VFS's and predates M3 — the generated filesystems followed
    POSIX until M3 noticed the two disagreeing, with `ls /proc` working without the flag and
    `ls /tmp` not. The stricter rule won because it is the established semantics of a shipped
    milestone, and because a caller that has to remember which mount it is on has no portable `ls`
    at all. Reconciling it with POSIX means changing the VFS and re-verifying M2.
83. **PERMITTED — unlinking an open `/tmp` file frees its bytes, and the description then
    answers ESTALE.** POSIX keeps an unlinked file alive until the last descriptor closes. M2
    decided not to for the OPFS volume and to refuse consistently under one name instead
    (`src/abi.mjs` ESTALE), and the tmpfs matches it — a filesystem that chose differently would
    make the behaviour of an unlinked open file depend on which mount it was on. Reachable in three
    syscalls: open, write, unlink, read. `bench/m3-tmpfs/probe.mjs` asserts all three refusals.
    An earlier comment in `#bytesOf` claimed this state meant a kernel bug, which was wrong, and
    the review that caught it is why the assertion exists.
84. **STRUCTURAL — a `..` whose lexically-normalized form lands in another mount is resolved
    lexically.** The mount lookup must normalize to pick a mount — without walking the tree there
    is no way to know which subtree a `..` lands in — so `stat("/nonexistent/../tmp")` SUCCEEDS,
    while `stat("/nonexistent/../")` correctly answers ENOENT because it stays on the root volume
    and the VFS walks it per component. The root mount is handed the path with `..` intact for
    exactly that reason (`src/kernel/calls.mjs` `resolveMount`); every other mount has no symlinks,
    so the lexical answer is the right one there. Same family as constraint 77: the walk does not
    consult the mount table. `bench/m3-fs/program.mjs` `regress` asserts both halves.
85. **DEFECT — the mountpoints have no backing directory, so `ls /` does not show them.**
    `/proc`, `/dev`, `/tmp` and `/usr` exist in the mount table and not in the root volume's
    directory, so a `readdir` of `/` lists neither. Every path INTO them resolves, because the
    mount table is consulted before the walk. Fixing it means either creating the directories on
    the volume at boot — which a read-only mount cannot do — or having `readdir` splice in the
    mountpoints rooted one level below the directory being read. The second is right and is not
    done.
