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

    **CLOSED BY M6, and the "advisory" clause above no longer holds.** `src/libos/lockdown.mjs`
    deletes `Worker`, `SharedWorker` and `URL.createObjectURL` from a process realm, so a process
    cannot construct a worker the table never sees and the cap counts the renderer's real worker
    count. Constraints 190 and 206 carry the measurement. The finding is kept in its original
    tense above rather than rewritten, because it is what was true when it was taken and the
    correction is the more useful record.
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

## What M4's prerequisite experiment measured

Chrome 157.0.8103.52 / macOS 26.7.2 / Apple M2 Pro. `bench/m4-intr/probe.py`. This is the
measurement `MILESTONES.md` §"Open experiments" owed before M4 and called the weakest point in the
cancellation design.

86. **`Atomics.notify` CANNOT interrupt a thread inside a synchronous OPFS read.** Measured: the
    notify woke **0 workers** while the target was inside a chunked `read()` loop, against a
    baseline where the same notify woke 1 worker parked in `Atomics.wait` with a 0.15 ms wake
    latency. The mechanism is not a limitation to work around — a thread inside a synchronous call
    is not in `Atomics.wait`, so there is nothing to wake. The flag is latched and observed only at
    the next point the thread chooses to look, which in the chunked loop was the next chunk
    boundary.
87. **`read()` is nevertheless INTR-capable as `docs/ABI.md` documents, because of where the
    handles live.** Since M0b the sync access handles are in the kernel's I/O worker (constraints
    58–59), so the CALLING PROCESS parks in `Atomics.wait` and is fully interruptible: the kernel
    replies `ST_INTR` and drops the late answer by CALLID. The I/O worker's read runs to completion
    and its result is discarded. **The delay a signal waits for is the chunk in flight, measured at
    10 µs p99** for the ABI's 64 KiB `MAX_INLINE` cap (0.005 ms median). So the ABI is honest and
    the cost of Ctrl-C during a file read is bounded by one chunk.
    **This is the constraint that retires the experiment, and it is a stronger result than the
    question expected:** the design was already right, for a reason the question did not consider.
88. **A blocking call MUST park in `Atomics.wait`, never inside a synchronous call.** The direct
    consequence of 86 for M4: a pipe read with no data cannot be served by anything that blocks the
    thread, because such a call cannot be interrupted at all and Ctrl-C on `sleep 100 | cat` is one
    of M4's own proofs. It must park on the process's SEQ word like every other blocking call and be
    woken by the kernel.
89. **The I/O worker MUST keep its reads chunked at `MAX_INLINE`.** One unchunked 16 MiB read blocks
    it for **2.67 ms p99** (1.7 ms median), and every other process's signal waits for it — the same
    head-of-line argument as constraint 58's `fsync`, at a different scale. Measured per size:
    64 KiB 0.005 ms median / 0.010 p99; 1 MiB 0.040 / 0.140; 16 MiB 1.725 / 2.910.

## What M4 found in the code it built on

90. **DEFECT (fixed) — `spawn` assigned `ppid` nowhere, so three mechanisms were unreachable.**
    `src/kernel/table.mjs` initialised it to 0 and nothing ever wrote it, so `waitpid` could only
    ever return `-ECHILD`, `parkParent` and teardown's parent-wake had no live caller, and
    `setpgid`'s "or your child" clause could never be true. Nothing inherited `pgid` or `sid`
    either, so every process was its own group and `kill(-pgid)` could not reach a pipeline — which
    M4's own Ctrl-C proof requires. A child now inherits ppid, pgid, sid, cwd and credentials from
    its parent; a page-spawned process still has none, which is right for a process the supervisor
    started.
91. **DEFECT (fixed) — teardown's parent-wake replied without removing the child from the live
    set.** The `reapForParent` path removed it; teardown's did not. So a parent waiting on two
    children was answered with the FIRST child's pid twice and never saw the second. Both paths now
    go through one `detachChild`. The defect was unreachable until constraint 90 was fixed, which
    is why it was wrong: newly-live code is where the bugs are.
92. **DEFECT (fixed) — a pipe's open-end counts were raised per HOLDER and dropped per
    DESCRIPTION.** `KIND_OPS.close` fires once, when the last reference to a description goes, but
    the counts were incremented once per process that inherited it. A pipeline therefore left
    `writers` at 1 after its only writer had exited, and the reader parked on an EOF that could
    never arrive — with no error anywhere, because a parked reader is a legitimate state. POSIX's
    rule is about file DESCRIPTIONS: a pipe has exactly one read description and one write
    description, and `dup`, `dup2` and spawn-inheritance only add references, so each end is 0 or 1.
93. **DEFECT (fixed) — a file description must not carry the slot of the process that created
    it.** The pipe descriptions recorded their creator so the pipe could reply to a parked call.
    But a description is SHARED — `dup` aliases it and a spawned child inherits it — so the child's
    read parked a record against its parent and replied to the parent. The ops rows are handed the
    calling process on every call, which is the only correct answer.
94. **A process starts with fd 0 free, so `pipe2` can return fd 0 as the read end.** `spawn`
    installs the sink on 1 and 2 and deliberately leaves 0 unopened so a `read(0)` is EBADF rather
    than a silent zero, and `fds.add` hands out the lowest free fd. A caller that then treats 0 as
    stdin wires its pipeline backwards: measured, a stage dup'd fd 0 onto fd 0 and then closed it
    as "the pipe fd". **A process building a pipeline MUST open its own stdin first.** M5's shell
    has to do this or inherit the bug.
95. **The per-fd in-flight budget is RELEASED when a call parks, not held for its duration.** The
    budget bounds outstanding kernel I/O per description, and `chargeFd`'s own comment names "a
    kernel that never settles would hold a slot forever" as its hazard — a parked pipe read is
    exactly that, by design and indefinitely. What bounds parked records instead is the process
    table: a process has one futex word and one outstanding call, so a pipe holds at most one
    record per process and processes are capped by constraint 17. Holding the charge would instead
    make the 65th blocking reader on a shared pipe get ENOBUFS, which is a different and
    undocumented contract.
96. **A parked call is signalled by returning `null` from an ops row, and `null` MUST be tested
    before any numeric use.** `null >= 0` is true and `null | 0` is 0, so a parked read left to
    fall through answered the caller 0 — which on a pipe means EOF. A reader that was supposed to
    wait would have seen end-of-file.
97. **DEFECT (fixed) — `detachChild` before `scheduleFree` made a process slot unreclaimable.**
    `scheduleFree`'s timer freed the slot only `if (table.byPid.get(slot.pid) === slot)`, and
    `detachChild` had just removed that entry — so `table.free` never ran, `slots[index]` stayed
    non-null forever and the SAB, ctl and worker were never released. After `PROC_CAP` such
    children every `spawn` returns `-EAGAIN` permanently. The headline path reaches it: a parent
    parked in `waitpid` while its child exits. The free is now keyed on slot identity in the
    allocation array. `reapForParent` had the same ordering and became reachable with constraint 90.
98. **DEFECT (fixed) — a fatal SIGPIPE answered the call, and the pipe then answered it again.**
    `#epipe` raised the signal and returned `-EPIPE`; a SIG_DFL SIGPIPE reaps the slot, so
    teardown's `answerInflight` had already replied. The handler's return produced a SECOND
    `reply()` for one call. `reply` is the single writer of `G_INFLIGHT`, so the depth gauge drifted
    negative and `depthAll[bucket]` was indexed with a negative bucket; `replies` and `errors` were
    double-counted, breaking the issued == replied identity the `syscall` check asserts. The parked
    path had the same bug with a weaker guard — it tested `ctl`, which `table.free` nulls two
    seconds later, instead of the sequence. Both now return the file's "already answered" signal.
    **The host probe could not see either, because its fake `raise` did not reap.** A fake that is
    gentler than the real thing tests a world that does not exist.
99. **DEFECT (fixed) — `getpgid` ignored its argument and returned the caller's group.** So a shell
    could not ask which group it had just put a pipeline into. Latent until constraint 90: with no
    pgid inheritance every process was its own group, which made the caller's answer
    indistinguishable from the target's for every pid that existed.
100. **An fd ceiling is load-bearing, not tidiness.** `OPEN_MAX` is 1024. The fd table is a plain
    array indexed by fd, so a `dup2` or a `spawn` file action naming fd 2^30 grew it to a billion
    entries — and `spawn`'s inheritance loop and `teardown`'s fd sweep both walk `fds.length` ON
    THE KERNEL THREAD. One process could therefore wedge the kernel for everyone, which constraint
    56 gives it 200 ms to do before every parked process declares the kernel dead. Enforced in
    `FileTable.add` and `.set`, in `dup2`, and in `decodeSpawnRequest`. `pipe2`'s own `if (rfd < 0)`
    guards were dead branches until this existed: there was no EMFILE path at all.
101. **DEFECT (fixed) — a faulting process became a ZOMBIE without `recordExit` or teardown.** The
    fault arm assigned the state directly, so `exitKind` stayed -1 and `packStatus(-1, 0)` gave a
    parent's `waitpid` a status meaning neither exited nor killed. Worse, teardown never ran, so the
    faulted process kept its fds open and a pipeline peer parked on an EOF that could never arrive —
    constraint 92's symptom, reachable by any child whose program throws. It now goes through
    `reap` with SIGABRT.
102. **DEFECT (fixed) — an interrupted `spawn` left an orphan child running.** `later`'s seq guard
    drops the answer when the caller has moved on, so the child was created, armed to run, and its
    pid returned to nobody. The comment claimed a reap that did not exist. It is now reaped where
    it is still the kernel's to undo.

## What M4b built, and what it found

103. **DEFECT (fixed) — teardown decremented an fd refcount ONCE PER DESCRIPTION, not per fd.**
    The sweep deduplicated by description, on the reasoning that "a dup'd description is closed
    once" — which the refcount already guarantees, since `--d.refs <= 0` fires exactly once. What
    the dedup actually did was LEAK a reference: `FileTable.add`, `.set` and `dup2` all raise
    `refs` once per fd and `FileTable.close` lowers it once per fd, so a process holding one
    description on two fds left `refs` at 1 forever. **Harmless until M4b**, because the only
    shared description was the sink and its close is a no-op. With a pty slave on fd 0 and fd 1 —
    which is what a terminal stage holds — the slave end never closed, `slaves` never reached 0,
    and the master's reader parked on an EOF that could never arrive. No error anywhere: the
    symptom was a process stuck in `read`, and the kernel's park dump is what located it.
104. **A pty's two ends are two description kinds, because the directions are not symmetric.**
    `write(master)` is INPUT and runs the line discipline; `write(slave)` is OUTPUT and goes
    straight to the master's queue. `read(slave)` takes processed input, in canonical mode only
    whole lines; `read(master)` takes the program's output plus the echo. One kind with a direction
    flag would make every op branch on it.
105. **The line discipline's ORDER is load-bearing: signals, then editing, then echo, then
    buffering.** A signal character echoed before it was recognised leaves a stray `^C` in the
    output; one buffered first is delivered to the program as data. Neither shows up as an error —
    both show up as a terminal that behaves oddly. `bench/m4b-pty/probe.mjs` demonstrates both
    mutations failing.
106. **`ICANON` and `ECHO` semantics are specified in NO authored document.** `MILESTONES.md` M4
    specifies exactly one behaviour of the discipline: ISIG with VINTR must raise SIGINT on the
    foreground group even when the UI is wedged. Everything else — line buffering, ERASE, KILL,
    VEOF, CR LF echo, the destructive backspace-space-backspace — is **POSIX's default taken as an
    assumption**, and `src/kernel/pty.mjs` says so where it is implemented rather than presenting
    it as design. `docs/ABI.md` additionally requires `VMIN` and `VTIME` in the struct; they are
    carried and **no behaviour reads them**, which is stated at the declaration.
107. **A pty with no foreground group DROPS a signal rather than broadcasting it.** `fgPgid` 0
    means "nobody". The alternative — delivering Ctrl-C to every process when the terminal has no
    foreground group — is a keystroke killing the system.
108. **`ioctl` implements exactly two requests**, `TIOCGPGRP` and `TIOCSPGRP`, and answers -EINVAL
    for the rest. POSIX carries `tcgetpgrp`/`tcsetpgrp` through `ioctl`, so inventing a syscall for
    a fact `ioctl` already names would be new ABI surface for nothing. A `TIOCSPGRP` naming a group
    that does not exist is ESRCH, and one in another session is EPERM — otherwise a process could
    aim a terminal's Ctrl-C across a session boundary.
109. **`poll` is required by constraint 42 and is absent from `MILESTONES.md` M4's build list.**
    The constraint is normative — "`poll()` MUST be the single wait primitive over fds" — because a
    process has one futex word and one outstanding call, so one terminal plus a pipe cannot
    otherwise wake it. M4b implements it for that reason. Parked polls live in ONE list,
    re-evaluated from `reply` because that is the single funnel every state change passes through;
    a new pollable kind therefore cannot forget to notify. The list holds at most one entry per
    process, so the sweep is O(processes polling) — constraint 18's O(interested), not O(N).
110. **A `poll` that times out must publish its `revents` before answering**, which is why it has
    its own timer rather than `setTimer`'s. `setTimer` replies 0 itself, and only the poll handler
    knows the record layout.
111. **`SIGWINCH` is raised only when the size actually CHANGED.** A program re-asserting the size
    it already has has not been resized, and a spurious SIGWINCH makes every full-screen program
    redraw.
112. **One ring implementation, `src/fs/ring.mjs`.** It was inline in the pipe until the pty needed
    three more queues, and four hand-written rings is four places for the wrap to be wrong — a push
    that straddles the end of the buffer is two copies, and the second is the one a hand-written
    ring forgets. Pure, so `fsfuzz.py` lints it.
113. **A resource and its accounting are acquired in the order that cannot leak.** `dup` raised the
    description's refcount and THEN asked for an fd, so a table at `OPEN_MAX` answered -EMFILE with
    the count permanently one high — and a kind's `close` op fires only when the last reference
    goes, so it never fired. A pipe whose writer count never drops leaves its reader parked on an
    EOF that cannot arrive, which is constraint 92's deadlock reached by a different route. The
    same shape in `open`'s async arm leaked an OPFS **sync access handle**, which is an exclusive
    lock per file: a retryable errno made one file unopenable by any process for the lifetime of
    the page. Take the slot first, then the reference; release the host resource on every arm that
    can still fail.
114. **A handler's own side effect may answer its call, and the second reply must be dropped at the
    funnel.** A pty operation signals the foreground group, and a fresh pty's foreground group is
    its OPENER's — so a resize issued before a shell has moved it raises SIGWINCH on the process
    making the call. `raiseOne` interrupts the in-flight call, and `finish` then replied to the
    handler's return as well: two SEQ bumps and two `G_INFLIGHT` decrements for one call, which
    drives the depth gauge negative and breaks the issued == replied identity `check_syscall`
    asserts. The guard is in `finish`, which all three dispatchers and `later` return through, so
    a handler added later cannot forget it. The drop is COUNTED (`answeredDuringCall`) rather than
    silent, because a guard that hides the class it prevents is the next defect.
115. **Readiness that changes without a `reply` must wake parked polls explicitly.** Constraint 109
    hooks the wake on `reply` so no pollable kind can forget it, and teardown is the one path that
    moves readiness and does not reply — its only `reply` runs BEFORE the fd sweep that drops a
    pipe's `writers` or a pty's `slaves` to 0. A peer parked in `poll` over a dying process's pipe
    waited out its own timeout, or waited forever where it had asked to block, for an event that
    had already happened. The sweep now wakes polls after `pollForget`.
116. **A negative `poll` timeout is INFINITE.** `poll(NULL, 0, -1)` was answered 0 immediately,
    which is a busy-wait where the caller asked to block — the one shape where a program spins the
    kernel by doing exactly what POSIX says. It parks with an empty set instead, which no fd can
    make ready, so only a signal or teardown ends it.
117. **"Parked" is not a state name.** `/proc/<pid>/status`'s `state` is `running` for every process
    that is not a zombie, so two checks asserting a process was blocked in `read` and in `poll`
    were asserting only that it had not exited — and sampled it immediately after the write that
    was meant to park it, so they raced it too. Parked is TWO facts: a call outstanding (`calls`
    one ahead of `replies`) and WHICH call. The syscall number is published in `status` for that
    reason, and the checks wait for it rather than sampling once.
118. **An iteration cap is not a wait.** The stage behind the milestone's headline behaviour —
    Ctrl-C reaching a process spinning in a compute loop — spun for 200,000 iterations and then
    exited normally, which on this machine beat the orchestrator's keystroke about 1 run in 4. The
    proof then failed with `killed: false, code: 0`. A process that must be alive when an event
    arrives is bounded by WALL CLOCK, and the ceiling is the error path: returning at all is the
    failure, so it names itself in the exit code.
119. **A fix in a module is unverified until the path a user reaches calls it.** `Pty.writable`
    answered POLLOUT correctly from the day it was written and `pollOne` still carried an
    unconditional `revents |= POLLOUT`, so the kernel's `poll` kept telling a slave with a full
    16 KiB output ring that it could write. A unit probe calling the new method directly passed,
    and the one caller that mattered had not been changed. This is constraint 100's rule — a
    mechanism with no live caller is unverified — in the harder form: a mechanism with a TEST
    caller and no production caller looks verified.
120. **`d.get(a) == d.get(b)` passes when both are absent**, because `None == None`. Two clauses in
    `check_m4b` compared a measured errno to the constant it should equal, with both travelling in
    the same evidence object — so one typo in the page would have removed both halves together and
    left the clause green. A comparison between two fields read out of a reported object asserts
    presence first.
121. **A bench page that boots a kernel per proof should SHUT EACH ONE DOWN, not just terminate
    it** — and doing so did NOT fix the flake it was reached for, which is the more useful half of
    this entry. `worker.terminate()` on the kernel orphans every process worker the kernel
    created: a terminated worker's nested workers are collected eventually, not promptly, and
    `www/m4b.html` boots thirteen kernels. So the kernel answers a `shutdown` message by reaping
    every live slot through the path `end-process` already uses, and the page waits for the
    acknowledgement before it terminates. That is right on its own terms.
    **It is not the cause of the flake.** `www/m4b.html` reports BROKEN with a page-level
    `timed out waiting for spawned` about 1 run in 12, and the rate was unchanged by the sweep:
    11 of 12 with it, 11 of 12 without it, and **11 of 12 on the committed tree at 11 proofs
    rather than 13** — so it is not the proof count either. Measured with
    `scripts/check.py --only m4b` in loops of 12, Chrome killed and 1 s given to exit between
    runs. THE CAUSE IS NOT IDENTIFIED. It fails closed: the harness reports a run it could not
    measure, never a pass.
122. **A proof whose failure mode is a HANG reports nothing.** The fd-table proof asks through
    `poll` with a deadline and not through `read`, because a leaked description reference leaves
    the reader with no EOF to see — a `read` would park forever, ending the check as BROKEN with
    no expectations, indistinguishable from a harness fault. Where an infinite park is the only
    way to assert the thing (teardown's wake, which a finite timeout's own rescan would answer),
    the ORCHESTRATOR owns the deadline: it waits a bounded number of rounds, kills the stage, and
    reports `wokenByTeardown: false`. A check has to be able to fail, not wedge.

## M5 — the shell and ten programs

123. **A process-supplied path reached `fetch`.** Until M5, `SYS_spawn` resolved its caller's path
    with `new URL(path, self.location.href)` and fetched it — and `new URL` IGNORES the base for a
    string carrying a scheme, so `spawn("https://elsewhere/x.mjs")` from any unprivileged process
    made the kernel issue a request from the browser's network position and then EVALUATE the reply
    as a program. That is both the SSRF primitive `src/kernel/providers.mjs` is written to deny —
    "there is no path by which a process-supplied string becomes a request origin" — and arbitrary
    remote code load, in the one call that creates processes. Closed by `src/kernel/exec.mjs`: a
    program path is resolved through the mount table and the bytes come from the mount. The page's
    own `t: "spawn"` keeps its URL, because the page is the supervisor and already holds the
    kernel's whole surface. Asserted by `www/m5.html`'s `no_url` section over six spellings,
    including `/src/bin/true.mjs` — a real file on the server that is NOT in this system's
    filesystem, so a kernel that still reached the network would spawn that one and nothing else.
124. **`/usr/bin` is rows in a manifest, not a special case.** `src/kernel/providerfs.mjs`'s
    committed table gained eleven rows and nothing else changed: the mount name has no extension
    and the provider path does, so `/usr/bin/ls` is a program and `src/bin/ls.mjs` is the file this
    repository keeps it in. M3's own comment predicted this shape ("M5 puts ten programs in
    `/usr/bin` by adding rows here, not by changing anything below") and it held.
125. **A program's only linkable import is an ABSOLUTE specifier.** A program image is a Blob URL
    with an opaque path, so a RELATIVE specifier inside it has no base to resolve against.
    `bench/m4-fs/program.mjs` imported `"../../src/abi.mjs"`, which the page's URL-based loader
    resolves and the filesystem loader cannot: left verbatim, the blob's import failed INSIDE the
    child, so every stage of M4's pipelines faulted with SIGABRT, `/proc` said `never issued a
    syscall`, and 23 expectations in an already-proved milestone went red with nothing anywhere
    naming a specifier. `linkProgram` now REFUSES such a program with -ENOEXEC and a note carrying
    the specifier. An absolute `/src/abi.mjs` works under both loaders and costs no fetch: it
    resolves to the URL `src/libos/process.mjs` already has in its module map.
126. **The exec loader's buffer is shared, so its reads are serialized.** A durable-volume program
    is read through `Store.readFd` into ONE kernel-owned SAB registered with the I/O worker under a
    negative view id. Two processes calling `SYS_spawn` in the same tick are two `later()` bodies
    that interleave at every await, and both would read into offset 0: each would assemble a
    mixture of the two programs and fail as a syntax error naming a line in neither file. A promise
    chain in `makeExec` is the whole fix; the view id is negative so it cannot collide with a pid.
127. **The image cache is content-addressed.** Keyed on FNV-1a of the bytes plus the length, never
    on the path: a path key serves a stale image after the file behind it changes, which is exactly
    what a shell writing a program and then running it does. Two programs with identical text share
    one Blob and a rewritten program gets a new one, with no invalidation logic to get wrong.
128. **`cd` needed a syscall; `getcwd` did not.** `slot.cwd` has existed since M2, was inherited at
    spawn and was otherwise immovable, so `cd` was not expressible — and a shell whose working
    directory cannot change is not a shell. `SYS_chdir` is 47, appended. There is deliberately no
    `getcwd`: `/proc/<pid>/cwd` already publishes the answer through calls that exist, and
    `src/bin/sh.mjs` reads it that way. The stored value is LEXICALLY normalized (`cd -L`), which
    is what every shell does for its own working directory.
129. **The exec check runs inside the filesystem that owns the file.** `openDecision` gained
    `wantX` rather than the loader reading `mode & 0o111` itself, because `src/fs/vfs.mjs`'s `#may`
    is the only thing that knows root ignores read and write but still needs an execute bit. A
    check in the loader would have been a second permission model, and the two would have disagreed
    about group ownership on the first file that had any. The generated filesystems check ANY
    execute bit, and that is stated where it happens: their nodes own no uid or gid worth
    consulting.
130. **A shell must not die of the keystroke it forwards.** The line discipline raises SIGINT on the
    terminal's foreground group; while the shell waits for a line that group is the shell's own, so
    Ctrl-C at a prompt is delivered to it and at SIG_DFL it is fatal — measured, the shell was
    reaped with `killed: true, code: 2` and the session ended on the first Ctrl-C. `SYS_sigaction`
    had existed since M1 WITH NO CALLER ANYWHERE, so its three dispositions had never been
    exercised from a process (constraint 100's rule). The shell sets SIGINT to SIG_HANDLE and
    SIGQUIT/SIGTSTP to SIG_IGN. Dispositions are per process and are not inherited through `spawn`,
    so a foreground pipeline still dies of Ctrl-C.
131. **One signal costs TWO `-EINTR`s on this ABI.** `docs/ABI.md` decision 1 has the kernel do
    both halves of delivery: it sets the SIGPEND bit AND interrupts the call in flight. So a Ctrl-C
    at a prompt interrupts the parked `read` — the one the shell wants — and leaves the bit
    pending, so the libos's entry check interrupts the NEXT call too before the exchange clears the
    bits. Measured: without a retry, Ctrl-C printed no new prompt at all while the shell was
    demonstrably alive and still read the next line. `src/bin/sh.mjs` retries the prompt write once,
    and ONE retry is exactly enough because the entry check clears the bits it reports.
    **THE KERNEL WAS NOT CHANGED INSTEAD, and that is a judgement rather than a conclusion.**
    Clearing the bit when the kernel interrupts an in-flight call is arguably the right fix — the
    interruption IS the delivery — but it moves a delivery rule that 332 existing expectations rest
    on, and `drainSignals`'s `onsignal(bits)` hook would stop seeing a signal that reached a parked
    process. A milestone that changes it owes M1's and M4b's signal proofs a re-run.
132. **A shell prompts only when somebody is there to read it.** A shell whose stdin is a pipe or a
    file is running a SCRIPT, and a prompt printed into its output stream becomes part of that
    output: measured, `cd /usr/bin` then `pwd` down a pipe answered `~$ /usr/bin\n/usr/bin$ ` and
    every proof that compared output failed on the decoration rather than on the result. `isatty(0)`
    is `tty_get` answering ENOTTY, asked once at startup.
133. **A pipeline missing its last stage used to RUN as its first.** `../webxp`'s parser carried a
    comment claiming `ls |` was caught — it was not: the trailing empty stage is dropped before the
    sweep that looks for one, so `stages` held only `ls` and the line ran. Caught by the host probe
    (`bench/m5-sh/probe.mjs`, "an empty stage is refused") on its first run, and fixed with an
    `awaitingStage` flag. A comment asserting a check exists is not evidence that it does —
    constraint 104's rule, found again in ported code.
134. **A filter must stream, or a pipeline with no end hangs.** `grep` was written with
    `slurpText`, which waits for EOF — so `yes | grep y | head -1` would never print, because the
    middle stage holds every byte until an end its writer will never send. `src/libos/std.mjs`
    `eachLine` carries the buffering and `grep` stops reading on `-l`'s first hit, which is also
    what lets the writer upstream see EPIPE. `cat` and `head` copy in pieces for the same reason;
    `head`'s stopping is what makes M4's `yes | head -1` terminate through a real shell.
135. **`f | g` with a builtin on either side is REFUSED, not deadlocked.** Constraint 20a's
    casualty, named where a reader meets it: with no `fork` one Worker cannot be two stages, and
    running them in sequence hangs the moment the first fills the 64 KiB pipe buffer. The refusal
    names the stage and the reason. A second shell worker is the fix a later milestone can buy.
136. **A negative control must subvert the SUBJECT, not the harness.** `spawn_self` returning the
    caller's pid made EVERY section red — 7 of 8 — because the page's orchestrator spawns the shell
    through the same call, so no shell ran at all and the control was satisfied by any failure. It
    is now gated on `caller.ppid` being non-zero: the orchestrator has no parent and still starts
    the shell, the shell has one, so only the shell's own stages go missing. And it is placed AFTER
    the program loader, so every refusal still refuses — which is why `exec`'s four refusal rows are
    in the HELD set while its two rows that need a child are not. Measured: 16 red, 18 intact.
137. **A section written with a program in it cannot be in a control's HELD set.** The builtins
    proof is deliberately program-free — `$$` is observed by `cd /proc/$$` and `$?` by the shell's
    own exit status — because a `$$` proved with `echo $$` would have gone red under `spawn_self`
    along with the pipelines and taken the control's specificity with it. The shape of a proof is
    chosen for what the control must leave standing.
138. **RECORDED LIMITATIONS of M5, sorted.**
    *Permitted by decision:* no `&&`, `||`, `;`, subshells, functions, command substitution or
    arithmetic — one pipeline per line, and `&&` and `;` are REFUSED rather than read as words
    because `mkdir d && echo x` made four directories in the predecessor and reported success.
    `grep`'s pattern is a FIXED STRING unless `-E`, because POSIX BRE is not JavaScript's syntax
    and accepting JS regexes under a name that promises BRE is worse than refusing to pretend.
    `ps` shows every process rather than POSIX's same-controlling-terminal set: there is one
    session today, so the filter would be a no-op that reads as a feature.
    *Structural:* `$VAR` holding `a b` is ONE argument — there is no `IFS` and no word splitting,
    so quoting a variable changes nothing, which is the whole class of shell bug the convention
    exists to prevent. `ls -l` prints no timestamp: the VFS keeps nanosecond times and there is no
    `strftime` here, so the field is omitted rather than rendered in a format nothing else uses.
    A program on the durable volume larger than 1 MiB is -EFBIG (`PROGRAM_MAX`).
    *Defect, unfixed:* none known at the close of M5.

## M5's adversarial review — what two critics found, and what it cost

Each entry is a finding verified against the code before it was acted on. Two were given the
artifact and the acceptance criteria and never the author's conclusion, as
`~/.claude/rules/adversarial-review.md` requires; both found things the author was certain were
fine, and the two worst defeated M5's own central claim.

139. **THE FIX HAD MOVED THE HOLE, NOT CLOSED IT.** Constraint 123 says `SYS_spawn` no longer hands
    a process-supplied path to `fetch`. It was true and it was not enough: the loader rewrote any
    `/…`-shaped *import specifier* through `new URL(specifier, base)`, and `new URL` RESOLVES A
    SCHEME-RELATIVE SPECIFIER OFF-ORIGIN. Measured against `http://localhost:8000/www/m5.html`:
    `"//evil.example/p.mjs"` → `http://evil.example/p.mjs`, `"/\evil.example/p.mjs"` → the same (a
    backslash is a slash to the URL parser), `"///x"` → `http://x/`, and `"/admin/whatever"` → an
    arbitrary GET on the page's own origin. A bare `https://elsewhere/q.mjs` was not matched at all
    and travelled into the Blob verbatim. Four syscalls from any process — write a program to
    `/tmp` whose text says `import "//elsewhere/p.mjs"`, chmod it, spawn it — and the CHILD's module
    loader fetched and evaluated remote code while **the kernel's own accounting stayed at zero
    loads**, which is the worst property a security fix can have. COEP does not stop it: a module
    script is fetched in CORS mode, so `Access-Control-Allow-Origin: *` satisfies CORP. Deleting
    `fetch` in M6 will not stop it either — static `import` is the module loader, not `fetch`.
    **Closed by an ALLOWLIST of exact literal specifiers** (`PROGRAM_IMPORTS`), compared by
    equality, so no process-controlled string reaches `new URL` at all. `www/m5.html`'s `no_url`
    section now asserts both halves over seven programs, with `/src/abi.mjs` as the positive
    control so "everything was refused" cannot pass for a working allowlist.
    **WHAT REMAINS OPEN:** a dynamic `import(expr)` whose argument is computed at run time cannot
    be caught by reading the text, and no scanner can. The literal form is caught. The answer is a
    Content-Security-Policy on the document, which bounds what the renderer will fetch whatever the
    text says — M6 owns it, and it is the second half of constraint 41.
140. **A four-line program panicked the whole kernel.** `src/libos/process.mjs`'s `self.onerror`
    reported the fault and did not CANCEL the event, so the runtime re-fired it at the `Worker`
    object in the parent — where the kernel's `worker.onerror` called `panic`, which stores K_PANIC
    and tells every live process through its own SAB that the kernel is dead. A program containing
    `setTimeout(() => { throw 0 })` therefore stopped the system. The wiring predates M5; what M5
    changed is that a process now chooses its own program text, so it needed no cooperation from
    the page. Fixed in both halves: the libos returns true to cancel, and a process worker's error
    is reported as THAT PROCESS's fault and reaped as one. It earned itself immediately — the next
    run named `ReferenceError: ensureStdin is not defined` in the shell instead of panicking.
141. **The image cache was unbounded and collidable, and the two needed different fixes.**
    *Unbounded:* `PROGRAM_MAX` caps one image and nothing capped their number, so a process
    looping over "write a 1 MiB program with one byte varied, spawn it" retained a Blob and a blob
    URL per turn — ~1 GiB after a thousand, and the renderer dies and takes every process with it.
    Now bounded at `IMAGE_CACHE_BYTES` (8 MiB, ~47x all of `/usr/bin`) with eviction oldest-first
    and `revokeObjectURL`, never evicting the entry the current load just made.
    *Collidable:* FNV-1a-32 collides on demand — a meet-in-the-middle over four tail bytes, and the
    critic produced a 38-byte file matching a real program's hash and length. The dangerous
    direction is POISONING, not reuse: an unprivileged process execs its forgery once and a LATER
    `spawn` of the real program, from any process including a root shell, runs the attacker's
    bytes, with the mount, the permission check and the read all behaving correctly. Now a hit is
    confirmed by COMPARING THE BYTES; the hash is reduced to an index.
    `bench/m5-exec/controls.py` carries both halves as a two-stage control in M2's shape:
    collapsing the key to a constant must move NOTHING (the comparison absorbs it), and collapsing
    it *and* removing the comparison must move 17 — measured. If stage 1 passed either way the
    comparison was testing nothing.
142. **`exec` could splice two generations, and closing its description could publish another
    process's un-fsynced bytes.** `readFd` takes the inode's lock PER CALL, so a two-chunk program
    read interleaved by another process's `fsync` of the same file produced chunk 0 from generation
    *n* and chunk 1 from *n+1* — a module that exists in no file, then hashed, cached and run.
    Linux cannot reach this: the image is pinned and a write to a running executable is ETXTBSY.
    Now the whole read runs inside one `withInode`, through `readHeld`.
    And `closeFd` runs `commit(d)` on any non-read-only file description, where `commitOnce` with
    nothing staged publishes the blob's PHYSICAL extent whenever it exceeds the metadata's size —
    which is exactly where another description's outstanding append lives. So `spawn`, a read,
    could publish a generation and append a journal record for a writer that never called `fsync`.
    exec now gives back only what `openFd` took: `release(ino)` under the inode's lock, never
    `closeFd`.
143. **A quoted redirection target was still expanded, and `> '*'` truncated an unrelated file.**
    `parse` kept only the target token's TEXT, so the shell rebuilt it as an unquoted word: `echo
    hi > '*'` globbed, matched `notes.txt`, and opened it `O_TRUNC`. The user quoted `*` precisely
    to mean a file called `*`. `> '$x'` and `> '%1'` were the same mistake in two other spellings.
    `parse` now keeps the whole token.
144. **Quoting was tracked per WORD, so `echo "$HOME"` printed `$HOME`.** One quoted character
    suppressed every expansion across the word — measured: `ls "no"*` did not glob either — while
    this file and `shlex.mjs`'s own header both claimed the opposite. A word is now a LIST OF SPANS,
    each recording `bare` / `single` / `double`, which is what makes the three rules expressible at
    all: variables expand in bare and double spans, globs are live only in bare ones, and nothing
    expands in single ones. It also fixed 143's root cause and made `magic` honest — a `*` that
    arrived from a variable's value is not re-read as a pattern.
145. **A throw out of the redirection path left a stage parked in `write` forever.** An ambiguous
    redirect, an unknown job spec or a bad substitution threw past BOTH the pipe-close loop and the
    wait: `cat big | cat > '*'` left the shell holding the pipe's read end, so the first stage
    filled 64 KiB, parked, and never got EPIPE — with no job row, so nothing could ever reap it and
    no job spec could kill it. Every opened fd leaked with it, 1,021 occurrences exhausting
    `OPEN_MAX`. Now the cleanup is a function that runs in a `finally`, the spawn loop is its own
    function so no `break` can step past it, and expansion failures are error RETURNS.
146. **A 4,096-byte line was split in half and both halves ran.** The read loop split one read on
    newlines, justified by the terminal's canonical mode — but the same loop reads a SCRIPT, where
    fd 0 is a pipe and there is no line discipline. Measured: a 4,090-byte first line made
    `echo hello` into `echo h` plus `sh: ello: command not found`, and with a multi-byte character
    at the seam the word `echo` itself was torn and both halves ran. Silent wrong execution. The
    loop now carries the partial tail between reads with a streaming decoder, and runs an
    unterminated final line at end of input.
147. **`%1` had no unambiguous spelling until it expanded to TWO words.** A job spec expanding to
    the positive leader pid signalled one stage, so `sleep 60 | sleep 60 &` then `kill %1` left the
    second stage running for its full minute with nothing able to reach it. Expanding to `-pgid`
    instead made `kill %1` into `kill -3`, and `kill` reads a leading `-<digits>` as a signal —
    POSIX's obsolescent form — so the call answered `usage:` with signal 3 consumed and no target.
    **Pids here start at 1, so a job's group is routinely a number that is also a signal:** the
    ambiguity is the common case, not a corner. A job spec now expands to `--` and the negative
    group, which is the one spelling `kill` cannot misread, and `kill` needed nothing added for it
    beyond POSIX's own end-of-options. A spec is also a WHOLE WORD or it is literal, so
    `cat /tmp/a%20b` is a path again.
148. **`/dev/zero` is 256 bytes, so a `-c` shell with no stdin fed 256 NULs to every reader.**
    `ensureStdin` opened it to hold fd 0 — which it does — but `sh -c "wc -c"` then printed 256
    where it must print 0. `/dev/null` is in the same directory, is 0 bytes, and means what the
    function needed.
149. **The kernel advertised nine signals it could not honour.** `signalOf` accepts STOP, TSTP,
    TTIN, TTOU, CONT, QUIT, ILL, ABRT and SEGV; `FATAL_DEFAULT` held four rows. So `kill -ABRT
    <pid>` returned 0, the target's blocked `read` answered -EINTR, `drainSignals` discarded the
    bit and the process KEPT RUNNING, where POSIX's default for each is to terminate. Adding `kill`
    made the gap a public surface — `kill -l` prints the whole table. QUIT, ABRT, ILL and SEGV are
    now fatal by default. **STOP, TSTP, TTIN, TTOU and CONT remain accepted and inert**, because
    there is no stopped state in this kernel to put a process into; that is a feature, not a fix,
    and it is recorded here rather than left as a name that is accepted and ignored.
150. **Smaller, each with its own fix:** `wantX` + `create` created a file and skipped the execute
    check, contradicting its own comment (now ENOENT, as promised); `chdir` answered EACCES for a
    non-executable file and ENOTDIR for the same mistake on a generated mount, because the
    permission check ran before the type check (now type first, so the `-ENOTDIR` line is
    reachable); a failed `dup` in a redirected builtin CLOSED the shell's stdout, after which
    `pipe2` handed out fd 1 as a pipe end (now the save is checked and the redirection refused);
    `wait $!` was a silent no-op for a multi-stage job because it matched only pgids (now pid or
    pgid); a backgrounded builtin answered `command not found`, exit 127 (now refused with a
    reason, exit 2); a `UsageError` from EXPANSION was reported as a defect in the shell with a
    stack trace and exit 70 (now a usage error, exit 2); `ls` stripped trailing whitespace off the
    last column, so a file named `"  "` printed as a blank line; `ps` discarded its operands and
    exited 0 for `ps 123`; `head -n` with no argument said "use -n n"; and `sleep 0.0000000001`
    rounded to a zero-nanosecond sleep, the exact value constraint 100's note records as having
    cost two proofs.
151. **`head -1` had to be supported, not refused.** It was refused as an obsolescent form this
    program does not carry — and MILESTONES.md M5's own headline proof is written `yes | head -1`,
    so the first thing anybody typed hit the refusal. A program may not refuse the spelling its
    own acceptance criterion uses.
152. **The property four programs were written around had no spelling in this system.** `cat`,
    `head`, `grep` and `std.eachLine` all stream rather than slurp, and every one cites
    `yes | head -1` as the reason — a case no check could reach, because there was no endless
    source: `/dev/zero` is an honest finite 256-byte file. `yes` is the eleventh program where the
    milestone asked for ten, and it is what makes M4's headline proof sayable in shell. A comment
    citing a case the system cannot express is a comment nobody can check.
153. **M5 shows constraint 121's flake too, and it fails closed.** `--negative spawn-self` reported
    "39 expectation(s) about the control itself unmet" ONCE in the eight runs taken while M5 was
    being closed. The signature is constraint 121's exactly: the page comes out BROKEN with zero
    labels recorded, so every declared label reads as "recorded no expectation by that name" and
    the gate counts one problem per label plus the outcome. Both times it was a full-suite negative
    run started shortly after a previous Chrome; `--only m5` passed 3 of 3 and the full phase
    passed on the next attempt. THE CAUSE IS NOW IDENTIFIED — constraint 155: a per-kernel-boot
    stall, 0 in 360 boots idle against 3 in 540 under contention, which a page booting one kernel
    per proof meets once per kernel. The property that matters was unchanged throughout: **a run that could not be measured is reported as BROKEN,
    never as a pass**. Treat a single red here as unmeasured and re-run it alone, with Chrome given
    time to exit — `pkill` returns before it is gone.
154. **Findings the review returned that were ANSWERED rather than fixed**, each with the reason —
    `~/.claude/rules/adversarial-review.md` requires a confirmed finding to be one or the other,
    never left unaddressed and unmentioned.
    - **`exec` requires READ permission as well as execute**, so a `--x` program is refused where
      Linux would run it. KEPT: this kernel has to read the program text to run it — there is no
      loader that can execute bytes it cannot see — so read permission is genuinely required rather
      than incidentally demanded. For uid 0, `#may` ignores the read bit anyway.
    - **`chdir` puts no ceiling on the stored cwd**, so `mkdir a; cd a` in a loop grows `p.cwd`
      without bound and every later path call of that process pays `joinPath` + `normalize` over it
      ON THE KERNEL THREAD (constraint 56 gives the kernel 200 ms before parked processes declare
      it dead). KEPT: Linux is equally unbounded here, the growth is linear in syscalls the process
      made, and a ceiling would be a number with no source. Named so the next reader of constraint
      56 knows where to look.
    - **The exec gate has no timeout**, so a `store` operation that never settles wedges every
      FUTURE exec in the system rather than only its own. KEPT: nothing in `store` can fail to
      settle — `iocore.request` wraps everything and returns an errno — so a hang there is already
      a kernel defect, and a timeout would answer it by running two program reads into one shared
      buffer, which is the thing the gate exists to prevent.
    - **`SynthFS` checks ANY execute bit** where the VFS checks the triad for the caller's
      credential. KEPT and recorded at the line (constraint 129): generated nodes own no uid or gid
      worth consulting, every one of them is served 0o555 or 0o444, so the two models agree on
      every file that exists. The divergence is latent and it over-grants, which is why it is
      written down rather than left to be discovered.
    - **`env.write` can return a SHORT count and every program tests only `< 0`.** A sink that
      accepted part of a write would drop output and report exit 0. KEPT as a recorded shape: the
      critic could not reach it — a full pipe parks rather than short-counting, and
      `src/libos/syscall.mjs`'s `write` already loops — so there is no caller to fix and no check
      that could fail. The address is `src/libos/std.mjs`'s `out`, and the fix if it ever becomes
      reachable is a loop there rather than in eleven programs.
    - **`ps` joins argv with spaces**, so `sh -c "echo a b"` renders as `sh -c echo a b` and an
      argument containing a space is indistinguishable from two arguments. KEPT: `/proc/<pid>/cmdline`
      is NUL-separated and carries the information, so a reader that needs it has it; quoting in
      `ps` output is a convention this system has no need to pick yet.
## What root-causing m4b's intermittent BROKEN found

These are not M5's. They come from the investigation of the flake constraint 121 recorded and
could not explain, which is answered in 153 above.

155. **A program fetch MUST be bounded, because `spawn` cannot answer until it resolves.** The
    kernel loads a program over HTTP (constraint 41: a process never fetches its own), and the
    caller cannot be answered until that load resolves. An unbounded `fetch` therefore makes
    process creation HANG rather than fail: the caller waits on a reply that never comes, with no
    errno, nothing in the trace, and no way to tell a slow origin from a dead one.
    `programImage` now fetches under a 5 s deadline through `AbortController` — not a racing
    timer, which would leave the original request outstanding — and retries once, because the
    stall it was written for is transient. `programFetchTimeouts` and `programFetchRetries` are
    published so the bound cannot quietly become the normal path.
    MEASURED, and this is the number that made it a defect rather than a theory:
    `bench/kernel-churn/probe.py` boots kernels and does nothing else — no pty, no pipes, no
    signals, one trivial process each. **0 stalls in 360 boots idle; 3 in 540 under threefold
    contention, 0.56% per boot**, two of them on exactly this await. At that rate a page booting
    thirteen kernels fails about 1 run in 14, which is what `www/m4b.html` was doing at 1 in 12.
    M5 CHANGED THE SCOPE OF THIS, and the bound is still right. `SYS_spawn` no longer fetches at
    all: `src/kernel/exec.mjs` resolves a program through the mount table and reads the bytes from
    the mount (constraint 123), so a PROCESS can no longer hang on a stalled fetch. What
    `programImage` still serves is the page's own `t: "spawn"` — the supervisor path every bench
    page and `www/m4b.html` boot through — and that is where the measured stall was. The two changes
    close the same hole from opposite ends: M5 removed the process's access to the network, and this
    bounds what remains.
156. **`www/m4b.html`'s intermittent BROKEN is exposure, not a defect in what it tests.** It is
    the only check that boots one kernel per proof — thirteen per run, where every other check
    boots one — so it meets constraint 155's per-boot risk thirteen times. The stall is in the
    page-to-kernel bootstrap, before any behaviour under test, and it fails CLOSED: the harness
    reports a run it could not measure, never a pass. Ruled out by measurement before this was
    found, each recorded so nobody re-runs them: the proof count (11 vs 13, unchanged), orphaned
    process workers (a `shutdown` sweep, unchanged), the spin stage's CPU burn (1.5 s vs 10 s,
    unchanged), the server's threading (already threaded), the listen backlog (1 vs 5 vs 128
    unchanged, and zero listen-queue overflows in `netstat -s -p tcp`), and truncated modules from
    the byte-range server (`bench/kernel-churn/rangetest.py`: eight range forms byte-exact, four
    malformed forms refused).
    THE LISTEN BACKLOG IS RULED OUT FOR THIS PATH AND NOT IN GENERAL, which matters because the
    comment above `programImage` records the opposite result for a different one: 16 processes
    importing one URL AT THE SAME INSTANT lost 6 of 480 connections to `socketserver`'s backlog of
    5. Both measurements stand. A burst of sixteen simultaneous connections can overflow a backlog
    of five; thirteen kernel boots taken one after another cannot, and `netstat -s -p tcp` recorded
    zero listen-queue overflows throughout. Concurrency profile is the variable, so neither result
    generalises to the other's shape.
    AND "LOAD" MEANS MEMORY. The contention figure was taken with `sysctl vm.swapusage` reading
    10.6 GB of 11.3 GB used and 64 MB of free RAM — the developer's own browsers, not the harness.
    Under that pressure `--only m1` was KILLED mid-run — the shell's own exit line never reached
    the log — while a stray `--only m2` from the same session was still competing with it. No
    jetsam record named the process, so the kill mechanism is NOT established and must not be
    asserted. The 0.56%-per-boot rate is an upper bound taken under that pressure, not a
    clean-machine number.
    AND A SLOW CHECK IS NOT A DEAD ONE: m2 was reported here as "never finishes" on the strength
    of an empty unbuffered log and a `pgrep` reading zero, and it then completed in 105.55 s with
    all 92 expectations passing. Waiting long enough is part of measuring.

## M4a — the terminal gets a real window

Measured 2026-11-16 on Chrome 157.0.8103.52 / macOS 26.7.2 / Apple M2 Pro / 120 Hz / dpr 2, by
`scripts/check.py --only m4a` (26 expectations, 6.38 s), `scripts/check.py --negative pty-detach`
(6 red, 20 intact) and `node bench/m3-synth/probe.mjs` (98 host checks).

157. **A window is a FILE DESCRIPTION, and `poll` is how a process waits on it.** M4a's
    `/dev/console` is an `F_WIN` description with a row in `src/kernel/files.mjs`'s ops table and a
    row in `pollOne`, so a terminal process waits on its window and its pty master in ONE call.
    This is constraint 42 and `docs/designs/REVIEW-FINDINGS.md` finding 1 made real, and finding
    1's *corrected* scenario is what it costs to get wrong: parked in `read(master)` at idle with
    nothing flowing, the keystrokes queue unread and the keys are dead indefinitely. MEASURED, as
    the state the kernel reports rather than as a property inferred from the keystroke working:
    with the shell at a prompt and no output moving, `/proc`-equivalent park state reads
    `inflight: "poll"` for the relay, holding fd 3 kind 5 (`F_WIN`) and fd 4 kind 8 (`F_PTY_M`).
    M7 replaces the one producer of that description — `open("/dev/console")` — with `win_create`,
    and the ops row and the poll row survive unchanged. That is the part of M4a that is not a
    special case.
158. **A character device is not a generated file, and `/dev`'s read-only mount is about its
    TREE.** `/dev` is mounted `MNT_RO` because no file can be created, renamed or unlinked there.
    Writing to `/dev/console` changes no tree: it puts bytes in a kernel object. So `open` carves
    one exception out of the mount's write refusal, asked of `SynthFS.chardevAt` — a lookup over
    names DECLARED in `src/kernel/devfs.mjs`'s CHARDEVS table, never a generator call, because
    `/dev/trace`'s generator renders the whole trace and `open` asks this question on every open of
    every generated mount. `O_CREAT` is still refused: a mount with no `mknod` cannot make a
    device.
    THE ORDER OF THE TWO TESTS IS LOAD-BEARING AND WAS WRONG FIRST. Taking the node before the
    refusal changed what a write to a path that does not exist answers — `open("/proc/nope",
    O_WRONLY)` went from EROFS to ENOENT — and `bench/m3-synth/probe.mjs`'s `/proc refuses open
    with O_CREAT with EROFS` is the check that caught it. A reorder inside a permission test is
    not a refactor.
159. **A device file with no device is ENXIO; a window that existed and was destroyed is
    EHOSTGONE.** The mount table is static at boot (constraint 78) and a window is not, so
    `/dev/console` is a name on every kernel and an object on only some. The two states are
    different events and a relay must be able to tell "there is no terminal here" from "my
    terminal closed" — the first is a configuration, the second is a hangup that must raise SIGHUP
    on the foreground group. `docs/ABI.md` reserved EHOSTGONE for exactly the second
    ("the DOM object behind a host fd was destroyed", errno 100) and M4a is its first caller.
160. **A keystroke is the one readiness in this system that arrives with no syscall reply behind
    it, so the console wakes `poll` itself.** `pollWake` is hooked on `reply`, "the one funnel every
    state change that could make an fd ready passes through" (constraint 109) — and a keystroke
    passes through no funnel: it is a `postMessage` from the page. Without the explicit wake a
    relay parked in `poll` sleeps until its timeout, which is the lost wake teardown's fd sweep
    produced once already. The `pollWakeEnabled` flag governs this wake too, through one
    `pollWakeAll` spelling, because a second copy of the pair is a second place `--negative
    no-poll-wake` can be forgotten.
161. **A terminal widget MUST NOT echo.** The character a user sees is the pty's echo, which
    travelled widget → `/dev/console` → `term` → `write(master)` → the line discipline → back.
    A widget that echoed locally would look identical AND WOULD SATISFY M4a's PROOF WITH NO PTY
    BEHIND IT — which is what `--negative pty-detach` exists to catch and the only thing in the
    suite that can. It is also wrong in substance: `ECHO` is a termios flag the program owns, and
    a password prompt clears it.
    THE CONTROL CUTS AT `Pty.writeInput`, which accepts its bytes and discards them, so every
    other link keeps working — the key event reaches the widget, the widget reaches the device, the
    device wakes the relay, the relay writes the master and is told it succeeded. Measured: exactly
    `echo ok`, the echo clause, the shell-ran-it clause, the Ctrl-C clause, the Ctrl-D clause and
    the verdict go red; the other twenty hold, INCLUDING `the window delivered the keystroke to the
    kernel` at 11 of 11 bytes counted by the device itself.
162. **Enter is LINE FEED, not carriage return.** `src/kernel/pty.mjs` commits a canonical line on
    byte 10 and implements no `ICRNL`, so a terminal sending 13 types a line the shell never
    receives: the discipline echoes the bare CR, the cursor returns to column 0, and `read(slave)`
    stays parked for ever. MEASURED — it was the first defect in `src/wm/terminal.mjs`, and the
    symptom was a prompt that accepted typing and never answered. `bench/m5-sh/program.mjs` writes
    `"\n"` to the master, which was the existing statement of this contract and is now written
    where a terminal author meets it.
163. **"Not responding" is the AGE OF THE OLDEST UNCOLLECTED KEYSTROKE, not the absence of a
    syscall.** Deferred from M1 for want of a UI to hook. A process in `sleep 60` makes no syscall
    and is perfectly well; a window with input waiting that nobody is taking is the condition a
    user means. The kernel's existing heartbeat samples it — O(1), edge-triggered, so the page is
    told about a transition and never once per tick. Thresholds are
    `docs/designs/fidelity-first.md`'s: caption at 1,000 ms, End Process affordance at 5,000 ms.
    MEASURED: 1,020 ms and 4,006 ms after the first transition, from a kernel reporting
    `staleMs: 5026` at level 2.
    HYSTERESIS IS THE DRAIN, NOT A SECOND TIME. Entering needs a stale queue; LEAVING NEEDS AN
    EMPTY ONE, so a process that reads one byte of a thousand it has been sitting on has not
    recovered. Both edges are checked, and they are checked on the DOM caption — what a reader
    would actually hit — rather than on a class or a flag. Measured clearing: 26 ms after a relay
    opened the device.
    THE WEDGE NEEDS NO SCAFFOLDING. The proof attaches a window with NO relay, which is the
    realistic form of the condition (a terminal whose process died) and keeps test-only behaviour
    out of a shipped program.
164. **`bench/m3-provider/probe.mjs`'s `implied directories exist` had been red since M5.** It
    compared the mount's top level against the literal `["include","lib"]`, and M5 added eleven
    `bin/*` rows to `USR_ENTRIES`. Nobody saw it go red because the host probes are not in
    `scripts/check.py`'s registry and are run by hand. Now derived from the manifest. A list that
    is a copy of a table is a list that drifts from it, and this one drifted for a whole milestone.
165. **Two M4a defects were found by reading the code and both became checks.** Recorded because
    the handoff's own rule — "treat any mechanism with no live caller as unverified" — did not
    cover either: both paths HAD a caller and were wrong anyway.
    `Console.detach` cleared the keystroke queue and left `unreadSince` set, so `staleMs` kept
    growing against a window that no longer existed and the detector reported a DESTROYED window as
    not responding — a caption on a frame that is gone. Now two labels in
    M4a's console probe (retired by M7; `bench/m7-win/probe.mjs` carries the
    section), shown capable of failing by removing the single line that fixes
    it: exactly `after detach nothing is stale` and `and the level drops rather than latching at 2`
    move, and the other 63 hold.
    `term` called `waitpid` after its loop unconditionally, so every exit that left a live child
    parked it for ever — and the exit that matters is the CEILING, which is the path that exists to
    report a session that stopped. It would have hung in the act of reporting the hang. It now
    hangs up on its shell with SIGHUP first, which is the signal named for the event, unless the
    shell has already gone.

## M4a's adversarial review — nine findings, eight fixed and one answered

One critic, given the diff and the acceptance criteria and not the author's conclusion
(`~/.claude/rules/adversarial-review.md`). Every finding was verified against the code before it
was acted on; all nine were real. Recorded because five of them are the same KIND of mistake — a
guard present in the code being ported or in a sibling path, dropped by the new one.

166. **A shipped program must not discard a return the shell already checks.** `term` discarded
    `setpgid` and `tcsetpgrp`, and the failure is not local: with `setpgid` refused the shell stays
    in the relay's group, `tcsetpgrp` then finds no such group, and `fgPgid` points at the RELAY —
    so Ctrl-C raises SIGINT on the terminal emulator instead of the shell, which is the constraint
    16 behaviour M4a's proof claims. Worse, teardown then sends SIGHUP to `-pid`, a group that does
    not exist, gets -ESRCH, and PARKS IN `waitpid` on a shell nothing has hung up: the relay hangs
    in the one path that exists to report a hang, with no `why` set because `why` is assigned after
    the wait. `src/bin/sh.mjs` checks this exact pair and says why. **A path with a live caller is
    not thereby verified** — the handoff's rule covers mechanisms with NO caller, and this one had
    one and was wrong anyway.
167. **A count raised before `fds.add` must be undone when `fds.add` fails.** `openChardev` raised
    the device's open count and `fds.add` answers -EMFILE at `OPEN_MAX`, so the count never came
    back down — it only falls through a `close` on an fd the caller was never given. `pipe2` and
    `pty_open` both undo their end counts and carry a comment saying "undo, or the caller leaks an
    fd it was never told about". The chardev arm was the one that did not.
168. **Two guards the window port dropped, both about a surface smaller than the window.** webxp's
    `clampBox` floors the size at `MIN_W`×`MIN_H` and takes `Math.max(surface.w - MIN_VISIBLE, 0)`
    as the upper bound. Without them a `Win` built before its desktop is laid out — measuring
    `{w: 0, h: 0}` — came out 0×0 at x = -72: off the left edge with NONE of the title bar on
    screen, which is the invariant `MIN_VISIBLE` encodes, inverted, and it stayed there until some
    gesture re-ran `apply()`. `bench/m4a-window/probe.mjs` is the check, and both mutations fire on
    named subsets: dropping the floor moves 10 labels, dropping the `Math.max` moves 2, and the
    ordinary-surface and idempotence clauses hold under both.
169. **A pointer gesture needs a re-entrancy guard, and the port dropped webxp's.** A second
    pointer — two fingers, or a mouse and a touch — re-entered `#startDrag` while a gesture was
    live: `drag` was overwritten and a second listener set added, then the first gesture's `up` saw
    a different pointer id and returned WITHOUT removing its own three listeners, and once the
    second gesture cleared `drag` it short-circuited for ever. Three leaked listeners per
    re-entry, for the window's lifetime. The gesture now carries its own `end`.
170. **An unread receipt is not an account.** `console-fed` carries how many bytes the device TOOK
    of the bytes it was OFFERED, and the kernel's own comment says it exists because "a terminal
    that loses input silently is the one failure a user cannot diagnose" — which it was, because
    the page dispatched the message and nothing consumed it. A counter with no reader makes the
    claim about it false. `the window delivered the keystroke to the kernel` now asserts three
    facts: the device counted the bytes, it took every byte offered, and it dropped none.
171. **An edge-triggered state must be published where the state is REPLACED.** `console-attach`
    installs a new device at level 0, and `sample()` reports only transitions — so a re-attach
    after a wedged window produced no transition and the page's caption stayed "(Not Responding)"
    over a brand-new device with an empty queue. Unreachable from `www/m4a.html`, which boots a
    kernel per session; reachable from a page message whose own documentation advertises re-attach.
    The level is now posted unconditionally at attach.
172. **A check must not re-read the state its readiness gate resolved on.** `check_m4a` re-read
    `phase` after `ready_expr` had already settled on it, and the page's self-typing fallback could
    fire in between — the check would type nothing, the page would never finish, and the run would
    end UNMEASURABLE with nothing to say why. The fallback budget is now 60 s, which cannot elapse
    between two adjacent evaluates, and the impossible case is reported by name instead of as a
    confusing absence.
173. **An argument accepted and ignored is worse than one refused.** `--ceiling` used
    `Number(x) || default`, which swallows `0` and every non-numeric value, so `term --ceiling 0`
    ran a thirty-second session and said nothing.
174. **ANSWERED, NOT FIXED: teardown's `pollWake` is ungated and `--negative no-poll-wake`
    under-proves because of it.** The control's claim — "a parked `poll` then only ever answers
    from its own timeout" — holds for the reply path and not for teardown's fd sweep, which calls
    `pollWake` without testing `pollWakeEnabled`. This predates M4a. It is left alone deliberately:
    gating it would change the label set that control declares (3 labels in m4b today), and
    re-scoping a shipped control is not something a window milestone should do as a side effect.
    The comment on `pollWakeAll` records it where a reader meets it. An earlier draft of that
    comment claimed teardown as a caller of the gated helper, which it has never been — the critic
    caught the false comment, and a comment asserting an invariant is still not evidence that the
    invariant holds.

## What two real-browser runs found that nine green checks did not

Reported by the operator from Firefox and from Chrome, against a milestone whose own suite was
green on Chrome 157 at 26 expectations with a working negative control. Every one of these is a
HARNESS defect or a browser assumption, and none was reachable from `scripts/check.py` as written —
which is the point worth keeping.

175. **`setPointerCapture` throws on an untrusted pointerId in Firefox, and it was load-bearing.**
    `DOMException: Element.setPointerCapture: Invalid pointer id`, with the throw at
    `src/wm/window.mjs`'s own line in the reported stack. It ran BEFORE the gesture's listeners
    were attached, so the throw aborted `#startDrag` and the title bar went dead to the mouse while
    the keyboard move kept working. **Chrome 157 does not throw for a synthetic pointerId 1** —
    measured both ways — so the geometry proof was green on the engine it runs on and the window
    was undraggable on another.
    THE FIX IS NOT THE TRY/CATCH. The listeners now go on the OWNER DOCUMENT, which is what
    tracking a pointer outside the element actually requires: a drag of more than a few pixels
    leaves the title bar and delivers its `pointermove` and `pointerup` elsewhere. `setPointerCapture`
    was standing in for that, so the correct structure needs no capture to be right — the capture
    is an optimisation, is attempted last, and its error is recorded on the gesture.
    **A CRITIC RAISED THIS CALL AND THE AUTHOR DISMISSED IT** on the grounds that the label was
    green. A green check on one engine is not evidence about another, and "the check passes" is not
    an answer to "this call can throw".
176. **A geometry assertion must not depend on the operator's window size.** The proof used the
    page's `#desktop`, whose width is whatever the browser gives it. Reported from a 191 px-wide
    desktop: a 300 px window is then wider than its own surface, the clamp pins x at
    `surface.w - MIN_VISIBLE`, and the window CANNOT move horizontally — arrow-right clamps
    straight back. The proof asserted an exact delta of 20, got 0, and was correct about a window
    behaving exactly as the clamp requires. It now builds its own fixed-size `box-sizing:border-box`
    surface and ASSERTS the fixture is the size it asked for; the narrow case moved to
    `bench/m4a-window/probe.mjs`, which drives the clamp over degenerate surfaces directly.
177. **A fixture that can only be satisfied by one driver reports every other run as a product
    failure.** The echo section required `drivenBy === 'cdp'`, so a page that typed for itself —
    which is what happens when nobody drives it — failed BY CONSTRUCTION with `echoed true, ran
    true` in the same line. And a person who types their own line can never produce `echo typed`,
    so a hand-driven session reported FAIL on a working terminal: measured, 62 real keystrokes,
    "echoed false, ran false", verdict FAIL.
    THREE DRIVERS ARE NOW DISTINGUISHED — `check` (declared itself on `globalThis.M4A.driver`),
    `hand`, `page` — and `hand-driven` is its own VERDICT, neither ok nor FAIL: the milestone's
    proof did not run, which is not the same as failing. `scripts/check.py` requires `ok`, so the
    third value cannot weaken the gate.
178. **A conjunction cannot name what failed.** `ok: a && b && c` publishes one bit, so the page
    log said only `FAIL echo` and diagnosing a real browser's failure meant guessing which of six
    conjuncts it was — which is exactly what happened, twice. Each section now scores NAMED
    clauses, prints the failing names, and reports an unmeasured clause as `null` rather than as
    false. The very next run of the geometry proof named its own failure as `the fixture is the
    size it asked for`, at 702x420 against a 700x420 request: `getBoundingClientRect` includes the
    border.
179. **A fixture must not leave a dead window on screen.** Every proof terminated its own kernel
    and left its frame on the desktop, so the page finished showing two windows that still took
    keystrokes and had nothing behind them. Reported as "I am unable to type into the terminals",
    and it is constraint 40's rule applied to the product rather than to a check of it: a dead
    terminal must not be indistinguishable from a working one. Proof windows are destroyed with
    their kernels, and the page now ends by opening ONE live session — which is what
    `MILESTONES.md` M4a means by "exists so there is something on screen before day 30", and the
    page had stopped doing it. Verified by driving real keys into that session after the run:
    32 trusted keystrokes, `echo hello-from-a-real-keyboard` echoed by the pty and run by the
    shell.
180. **One timer could not serve both a driver and a person.** The wait for real keystrokes was
    60 s so that it could not elapse between the check's `settle` and its first `evaluate`; a
    person opening the page then sat in front of an apparently hung terminal for a minute, measured
    at 66 s for the whole run. It is now two waits: a short one on the DRIVER DECLARING ITSELF,
    then a long one on that driver's keys. The page completes in 8.6 s unattended.

## M4a, after the operator used it

181. **"Not responding" requires somebody who was supposed to respond.** The detector measured the
    age of the oldest uncollected keystroke and nothing else, so a relay that had not opened
    `/dev/console` YET — spawn, program load, open, all of which take a moment — was
    indistinguishable from one that had died. Reported from a real browser: a terminal that said
    "(Not Responding)" while it was still coming up. That is the WRONG DIAGNOSIS, not a late one:
    nothing was ignoring the input, nothing had claimed it.
    `Console.openedEver` is the gate. Until a process has opened the device the level stays 0 and
    the device reports `starting`, which the window renders as "(Starting…)" — a different thing to
    say, and the only honest one. Once set it STAYS set, so the real case is still caught: a relay
    that opened the device and then died has `openedEver` true and `opens` back at 0, the clock
    governs, and the caption greys.
    BOTH AXES ARE EDGE-REPORTED. Acquiring a first opener does not change the LEVEL, so a page told
    only about levels left "(Starting…)" on a working terminal for ever.
    The control moved exactly two labels in M4a's console probe — `and never reports
    not-responding, however long the queue waits` and `its level stays 0` — and leaves the other 75.
182. **The detector's own proof was testing the wrong fixture, and the fix exposed it.** `pHealth`
    attached a window with NO relay at all, which constraint 181 now classifies as starting rather
    than wedged — so the proof would have passed against nothing. It is re-based on the honest
    condition: build a WORKING terminal, prove it works, kill its emulator through the kernel's own
    `end-process` path, and only then type. That needs no test-only behaviour in a shipped program
    and it exercises the very button the second threshold reveals.
    THE DOCUMENTED CLAIM WAS ALREADY THIS. The earlier record called the no-relay fixture "the
    realistic form of this (a terminal whose process died)" — it was not: a process that died is
    exactly what `openedEver` distinguishes from one that never came, and the fixture was the
    second case while the prose claimed the first.
183. **`until(async () => …)` passed vacuously, because a Promise is truthy.** The page's poll
    helper tested `what()` rather than `await what()`, so the first asynchronous predicate given to
    it — a check that a killed relay had released the device — returned true IMMEDIATELY and its
    clause measured nothing. Awaiting is correct for a synchronous predicate too, so there is one
    spelling and not two. Found by reading the helper while adding the caller, which is the only
    reason it is not in the suite as a green clause that proves nothing.
184. **`www/m4a.html?live=1` exists because "the terminal is not responding" had four possible
    causes and the page distinguished none of them.** The kernel may not have come up; `/usr` — where
    `sh` and `term` live — may have been refused; the relay may never have been spawned; or the
    relay may be running and not reading. Only the last is a defect in this milestone, and a bare
    greyed caption cannot tell a reader which it is. Live mode boots ONE kernel, reports the mount
    state and the relay's pid, waits for a prompt, and on failure prints what the relay is parked in
    and what the device reports. It is also the only path light enough to debug on a machine where
    the full page's five kernels get the renderer killed.

## M5, after the operator used it

Found by a parallel session working on M5 and merged in here. **These were committed as 155
and 156 and are renumbered 185 and 186**: on that branch those numbers were free, and on this
one they are the program-fetch and m4b-flake constraints above. The numbers are cited by
number in code, so the pair with fewer citations moved. Nothing else about them changed.

185. **A proof that drains a pipe must own every writer on it.** `p_exec` backgrounded `sleep 30 &`
    through a real shell, then drained the shell's output and read `/proc/<pid>/cmdline` after —
    which cannot work: the drain waits for EOF, and EOF waits for the LAST writer, which is the
    backgrounded job holding the stdout it inherited. The proof sat in `read` for the full thirty
    seconds and then killed the process it had never been waiting for. It PASSED throughout, so no
    check could see it; what showed it was timestamping the page's own log lines — 30.9 s of a
    40.3 s page, now 1.0 s of 9.6 s.
    Two fixes were unavailable and are worth knowing: `sleep 30 > /dev/null &` is -EROFS because
    `/dev` is MNT_RO, and shortening the sleep does not help because the drain's duration IS what
    the job has to outlive. The order is the fix — find the job in `/proc` while it lives, kill it,
    then drain — and it is a better proof besides, because the pid comes from the process table
    rather than from a parse of the shell's own announcement.
186. **A progress line must name what is RUNNING, not what finished.** Every `say` in `www/m5.html`
    came after its `await runProof`, so the last line on screen was always the previous proof:
    while `p_exec` ran for 31 seconds the page read as though `p_builtins` had hung, and a reader
    reported it that way. A log that only reports the past cannot distinguish a slow step from a
    stalled one. The page now prints `… <mode>` before each proof.

## M6 — neuter the process realm

Measured on Chrome 157.0.8103.52 / macOS 26.7.2 / Apple M2 Pro unless a row says otherwise. The
two harnesses are `bench/m6-realm/csp-probe.py` (four policy deliveries against a stand-in module
worker, with its own second origin) and `bench/m6-realm/probe.mjs` plus
`bench/m6-realm/controls.py` (the lockdown under Node, and three mutations of it). The product
gate is `scripts/check.py --only m6`, with `--negative no-lockdown` and `--negative no-csp`.

187. **A CONTENT-SECURITY-POLICY ON THE DOCUMENT DOES NOTHING FOR A DEDICATED MODULE WORKER'S
    LOADER.** Four deliveries measured, one page load each, `bench/m6-realm/csp-probe.py`; the
    `document` column is behaviour-identical to `none` and reports ZERO violations.

    | attempted from the worker | none | document | worker | both |
    |---|---|---|---|---|
    | `navigator.storage` → write an OPFS file | reached | reached | **reached** | **reached** |
    | `fetch`, `XMLHttpRequest` | reached | reached | refused (`connect-src`) | refused |
    | `indexedDB`, `caches` | reached | reached | **reached** | **reached** |
    | `new Worker(blob)` | reached | reached | reached † | reached † |

    † `worker-src 'none'` refused it when this was first measured, and that directive had to come out: constraint 206. The realm strip is what closes a nested worker, which is what constraint 53 asked for in the first place.
    | `URL.createObjectURL` | reached | reached | **reached** | **reached** |
    | `eval`, `new Function` | reached | reached | refused (no `'unsafe-eval'`) | refused |
    | computed `import("da"+"ta:…")` | reached | reached | refused (`script-src-elem`) | refused |
    | computed `import("<other origin>/x.mjs")` | reached | reached | refused (`script-src-elem`) | refused |
    | `import("blob:…")` | reached | reached | reached | reached |
    | `import("/src/abi.mjs")` static | reached | reached | reached | reached |
    | violation events in-realm | 0 | 0 | 10 | 10 |

    So the policy is served on the response that CREATES the realm. `scripts/serve.py` sends it
    for every path under `src/libos/` — a prefix and not a filename, because that directory IS the
    process realm in file form and the worker's entry path belongs to
    `src/kernel/kernel.mjs`'s `RUNTIME_URL`.
    The off-origin row needs a cooperating second origin: a module script is fetched in CORS mode,
    so the probe starts a second loopback server sending `Access-Control-Allow-Origin: *`.
    Without it that row would read "refused" for a reason the policy had nothing to do with.
188. **Constraint 139 named the wrong delivery point, and this corrects it.** It says "the answer
    is a Content-Security-Policy on the document". The policy is the answer; the document is not
    the place. 139 is otherwise unchanged and its measurement stands — the correction is where the
    header goes. Recorded here rather than by editing 139, which is the standing rule for a
    finding that turns out wrong.
189. **The policy and the realm strip are DISJOINT, and both are required.** The policy leaves
    ambient OPFS, `indexedDB`, `caches` and `URL.createObjectURL` completely untouched (187), so
    only the strip closes them; `import(expr)` is the module loader and not `fetch`, so only the
    policy closes that. The two negative controls assert the disjointness rather than asserting
    it twice: `--negative no-lockdown` must break every realm clause while every loader clause
    HOLDS, and `--negative no-csp` the reverse. Measured: 14 red / 17 intact and 8 red / 23
    intact.
190. **`blob:` MUST stay in `script-src`, so `URL.createObjectURL` MUST leave the realm.** A
    program image IS a blob URL (`src/kernel/exec.mjs`), so a policy that refused the scheme would
    refuse every program. With the scheme allowed, a process that can mint a blob URL can
    evaluate text no linker ever saw — measured, `import blob` reached under every delivery. The
    deletion of `createObjectURL` is therefore load-bearing and not hygiene, and
    `revokeObjectURL` goes with it so nobody puts half the pair back.
191. **`script-src` without `'unsafe-eval'` refuses `eval` and `new Function`, inside the program
    as well as in the worker.** Measured both ways — `EvalError: … because 'unsafe-eval' is not an
    allowed source of script` from the worker's own code AND from inside a blob module. No
    program in `src/bin/` evaluates text, so this costs the system nothing; a program that needed
    `eval` would make the policy unshippable, which is why it is written down.
192. **A policy delivered on the worker script DOES reach a module imported from `blob:`.** The
    load-bearing case, because a program is never the worker's own script. Measured from inside
    the blob: the computed `data:` import, the off-origin import and `eval` were all refused there
    under the `worker` delivery and all three reached under `none`. CSP is per-realm and a blob
    module shares the worker's realm; this is the measurement rather than the inference.
193. **`SharedWorker` and `importScripts` are not in a Chrome 157 dedicated module worker at
    all**, so the lockdown reports them ABSENT rather than stripped. They stay on the target list
    anyway: "the platform happens not to expose it here" is not a boundary, and an engine that did
    expose them would otherwise look identical in the report. The `credit-absent` mutation in
    `bench/m6-realm/controls.py` is what keeps the distinction honest.
194. **The `WebSocket` constructor does NOT throw under `connect-src 'none'`.** It returns, the
    violation fires, and the connection is refused asynchronously — measured as
    `webSocket REACHED constructed` with a `connect-src ws://…` violation beside it. A check
    asserting "the constructor failed" would therefore pass only because of the realm strip, and
    a reader could not tell which half had done it. The strip is what makes the binding absent;
    the policy is what makes the connection impossible.
195. **A faulted process is a ZOMBIE in `/proc`, not an absence**, so MILESTONES.md M6's "`/proc`
    shows it faulted" is asserted as `state: zombie`, `exitkind: 1` (STAT_KILLED),
    `exitvalue: 6` (SIGABRT) — read out of `/proc/<pid>/status`. The first version of the clause
    asserted the directory was GONE and failed: a reaped process keeps its pid for the ~2 s
    terminate quarantine (constraint 14), so that clause was racing the quarantine and calling
    correct kernel behaviour a defect.
196. **The lockdown MUST fail closed, and nothing in a browser can reach that path.** Every target
    on Chrome 157 is configurable, so `lockdown()` never has to refuse there — and a mechanism
    with no live caller is unverified. It is reached with a double under Node
    (`bench/m6-realm/probe.mjs`, 25 checks) and its coupling is proved by three mutations
    (`bench/m6-realm/controls.py`): a SHALLOW delete, which is the realistic mistake because
    nothing in a worker realm is an own property and `delete obj[name]` therefore returns true and
    removes nothing; REMOVING THE VERIFICATION, which would report "everything stripped" over an
    open realm; and crediting an absent binding as stripped. The mutation harness earned its place
    immediately: it caught a clause in the probe that passed over a report that was never produced
    (`remaining.length === 0` is true of the caught default when `lockdown` throws) and a section
    that moved under a mutation it was not about.
197. **A program's `run` may be async, and `{ ...promise }` spreads to `{}`.** Every capability
    constraint 41 removes is promise-shaped, so the program that demonstrates the hole cannot
    finish in one synchronous turn — and the libos used to post `data: { ...program.run(env, m) }`
    unawaited, which would have sent an EMPTY result with nothing anywhere saying why. The libos
    awaits it (`src/libos/process.mjs`), a rejected promise faults the process exactly as a throw
    does, and every program in `src/bin/` stays synchronous because a syscall blocks in
    `Atomics.wait` and needs no await.
198. **A dynamic root-relative specifier does not resolve inside a program.** `import("/x.mjs")`
    from a blob module answers `Failed to resolve module specifier` before any policy is
    consulted, because a blob URL has an opaque path (constraint 125, now with its dynamic twin).
    The kernel's linker rewrites literal specifiers it can see; a computed one it cannot. M6's
    positive control therefore imports `self.location.origin + "/src/abi.mjs"` — which is also the
    honest statement of what the policy still permits (199).
199. **WHAT M6 DOES NOT CLOSE, recorded rather than implied.** `script-src 'self'` means a program
    can still dynamically import ANY same-origin module, so the loader is bounded by what the
    server serves rather than by what the kernel allows. CSP source expressions cannot name a
    path without an origin, and the origin is a runtime port, so narrowing this further is not
    expressible in the header. It is also why M6 is **hardening and not a security boundary**:
    same-origin is not a security boundary, the threat model for v1 is first-party only, and
    nothing here stops the author of a program from doing what the page can already do. Say so
    wherever M6 is described — `MILESTONES.md`, `src/libos/lockdown.mjs` and the check's own note
    all do.
200. **M6 ships no document policy, deliberately.** It would buy nothing for the subject (187) and
    the document is the supervisor every bench boots through: `www/m4a.html` holds the kernel's own
    `MessagePort`, every page carries inline script, and `scripts/check.py` byte-compares served
    bytes against disk — so a nonce cannot be injected and a document policy would have to carry
    `'unsafe-inline'`. A page-hardening policy is a separate change with its own risk and its own
    control.

## M6's adversarial review — six findings, all six fixed

The critic was given the artifact and the acceptance criteria and not the author's conclusion. It
verified rather than read: it ran the host probe, the mutation harness, `--list`, `--controls` and
`check_links`, scored both new controls' failed/held partitions clause by clause against the page,
and grepped the tree for any in-tree use of the eleven stripped bindings. Five findings were small;
one was the milestone's own subject, in the commit that was supposed to have closed it.

201. **A PERCENT-ENCODED LEADING SLASH SERVED THE PROCESS REALM WITH NO POLICY.** `GET
    /%2fsrc/libos/process.mjs` returned `process.mjs` byte-for-byte — 13,675 bytes, status 200 —
    and NO `Content-Security-Policy`, because `unquote` runs after `urlparse`, `posixpath.normpath`
    preserves the two leading slashes `%2f` produces, and `translate_path` collapses them and
    serves the file anyway. A process worker created from that URL had an unbounded module loader:
    `eval`, `new Function` and a computed `import(expr)` all work. The hole M6 exists to close,
    reachable by one spelling.
    **The commit before it had made this worse by claiming otherwise** — "seven spellings checked,
    including percent-encoded" was true of an encoded slash in the MIDDLE of the path and not of a
    leading one, which is the one that matters.
    **Fixed by asking the resolved FILE, never the spelling**: `_in_process_realm` defers to
    `translate_path`, the same resolution that decides which bytes are sent, so two spellings of
    one file cannot get two policies in either direction. Verified over thirteen spellings either
    side of the boundary, and `_assert_policy` in `scripts/check.py` now asserts the `%2f` form on
    the wire before Chrome starts — with the bug restored, that gate refuses at exit 3 and names
    the two spellings.
    **The lesson is the one this repo keeps relearning:** a guard written against a list of
    spellings is a guard against that list. The question has to be asked of the thing the
    behaviour depends on, which here is the file.
202. **THE `/proc` READ RACED THE TERMINATE QUARANTINE.** The clause proving the bypass program
    faulted reads `/proc/<pid>/status`, and a reaped pid leaves the table when
    `TERM_QUARANTINE_MS = 2,200` expires (constraint 14). The read was being done by a FRESHLY
    SPAWNED process — a worker start, the libos module graph re-fetched because every response is
    `no-store`, and `measureClock(200000)` — with nothing bounding that below 2.2 s on a loaded
    machine. It would have scored correct kernel behaviour as a defect, which is constraint 195's
    mistake in the other direction.
    **Fixed twice over:** the read now runs on an ALREADY-LIVE process through a second `go` with
    new argv (one `postMessage`, no spawn), and an ENOENT answer is reported as `expired` and
    raised as UNMEASURABLE rather than red — an untaken measurement is not a failed proof.
203. **An abandoned waiter's timer deleted a later waiter for the same message.** `www/m6.html`'s
    `expect` keys waiters by message type, so a second `expect('results')` replaces the first —
    and the first's timer still fired and deleted the SECOND one, after which the message landed
    in a pending queue `expect` only reads on entry. The step would then sit out its own timeout
    and report a timeout with nothing wrong. Reachable only here, because the fault race abandons
    a `results` waiter by design. Fixed by having the timer retire only its own entry.
204. **Making a program's `run` awaitable removed a serialization the synchronous version held by
    construction.** A second `go` arriving while an async `run` is suspended would start a
    concurrent run in the same realm and post a second result — and the kernel satisfies
    `results.length >= goCount` at the first, so the page reads one batch and the extra is
    orphaned. Nothing in the suite issues two, which is why the fix is a GUARD and not a queue:
    the invariant is unchanged, and a caller that breaks it now faults naming the invariant
    instead of silently overtaking a result. Constraint 197's twin.
205. **Two documentation defects of the kind this repo treats as defects.** A comment in
    `src/libos/lockdown.mjs` said a failed removal was "recorded by its absence from `where`"
    directly above the line that pushes it INTO `where` — so a reader debugging a refusal would
    have misread an error entry as a successful deletion. And `p_verify` still computed and
    returned a `procGone` field that nothing read and that was always false, with two comments
    describing the abandoned design constraint 195 records. Both removed. A comment asserting an
    invariant is not evidence that the invariant holds, and a field nothing reads is a claim
    nothing checks.

## What a second engine found, in an hour, with M6 already green

206. **`worker-src 'none'` ON A WORKER'S OWN SCRIPT STOPS FIREFOX STARTING THAT WORKER.** Firefox
    applies a worker script's own `worker-src` to THAT WORKER'S creation, so the policy M6 shipped
    told Firefox to refuse the very worker it describes and no process ever ran. Chrome applies the
    directive to workers created BY the realm, which is what it was in the policy for. Bisected on
    Firefox 156.0.1 against Chrome 157.0.8103.52, one headless run per variant:

    | policy on `src/libos/process.mjs` | Firefox |
    |---|---|
    | `…; worker-src 'none'` (as shipped) | the worker never starts |
    | `…; child-src 'none'` | the same — Firefox treats them alike here |
    | `default-src 'none'; script-src 'self' blob:; connect-src 'none'` | starts, runs its graph |
    | no policy | starts |

    **THE FAILURE IS SILENT BY NATURE**, which is most of why it survived a green suite and an
    adversarial review: a worker that will not start fires an error event with an EMPTY message, no
    filename and line 0, so the kernel's `worker.onerror` could only report
    `process 1 runtime: error` — a swallowed failure, in the one place this repository's own rule
    says an error path must name what failed. The operator reported that string; nothing in the
    suite could have.
    **Removed, and nothing is lost:** `src/libos/lockdown.mjs` deletes `Worker`, `SharedWorker` AND
    `URL.createObjectURL`, so a process cannot construct a worker at all. The directive was belt
    and braces over a strip that is the mechanism constraint 53 actually requires, and the artifact
    says so: with it gone, the `nestedWorker` row reads `reached` under every policy delivery and
    `refused  TypeError: URL.createObjectURL is not a function` under the strip.
    **With it out, M6 passes end to end in Firefox** — every binding refused, the kernel's bytes
    intact, the bypass program faulted, `/proc` reading `state: zombie, exitkind: 1, exitvalue: 6`,
    verdict ok in 530 ms. Firefox's messages are better than Chrome's: `EvalError: call to eval()
    blocked by CSP`.
207. **CONSTRAINT 175 WAS RIGHT AND THE PRICE IS NOW MEASURED.** "The suite drives one engine" was
    recorded as a gap after M4a's `setPointerCapture`; M6 is the second time an engine split landed
    in shipped code, and this one disabled the whole system rather than one window's drag. Both
    were found by a human opening the page, not by 394 green expectations.
    **What made the second one cheap to find was a switch that already existed**: `serve.py
    --no-csp` is M6's own negative control, and one run with it told the difference between "the
    policy" and "something else in the realm" in under a minute. A control built for the harness
    paid for itself as a diagnostic.
    **Firefox is reachable for a bench without a CDP driver**, which was not obvious: Firefox
    removed CDP support, but `firefox --headless --screenshot` renders the page, and a page that
    prints its own log as text is therefore readable from a PNG. Holding the load event open with
    a slow subresource is what makes the capture land after the page has finished. That is how
    206's table was taken.

## M6 from a prompt, which is where two more things surfaced

208. **THE EXEC LOADER REFUSES A HALF-COMPUTED SPECIFIER, AND THAT IS WORTH KNOWING BEFORE IT
    LOOKS LIKE A BUG.** `bench/m6-realm/program.mjs` would not run from the shell at all — the
    shell answered `ENOEXEC` — because `linkProgram` extracts EVERY string literal following
    `import(` and compares it to the allowlist, so `import("da" + "ta:…")` is seen as the
    specifier `"da"` and the whole file is refused (constraint 139 says the scanner is
    deliberately broad, and this is that breadth working). The program now assembles the URL away
    from the call site, which is both why it loads and the more faithful form of the case the
    policy exists for: a specifier no scanner can see. **The loader is therefore a third layer the
    page's own spawn does not have** — the page keeps its URL-based loader (D18), so a program
    that loads from the page may still be refused from the filesystem, and the two paths are not
    interchangeable for a program containing a literal-looking dynamic import.
209. **M6 IS OBSERVABLE FROM THE SHELL, and that is now the fastest way to see it.**
    `/bench/m6-realm/program.mjs p_show` prints, from inside a process the SHELL spawned, every
    binding it cannot reach and the one channel it can:

        navigator.storage    refused  TypeError: Cannot read properties of undefined …
        fetch                refused  ReferenceError: fetch is not defined
        indexedDB            refused  ReferenceError: indexedDB is not defined
        URL.createObjectURL  refused  TypeError: URL.createObjectURL is not a function
        import(data:)        refused  TypeError: Failed to fetch dynamically imported module …
        eval                 refused  EvalError: … violates the following Content Security Policy
        syscalls             REACHED  stat(/) answered mode 755 — the channel is the way out
        nothing reached. The realm is stripped and the policy is in force.

    `p_fault` does the same from the other side: the process dies of SIGABRT and the page logs
    `FAULT pid 4: TypeError: … (reading 'getDirectory')` with a stack through
    `src/libos/process.mjs`. **A program a SHELL started is in the same stripped realm as one the
    page started** — that was the question an operator asked, and the only honest way to answer it
    was from inside the realm rather than from the document.
    Two conventions had to meet for this to work: a shell passes POSIX argv where argv[0] is the
    program NAME, while every bench orchestrator uses argv[0] as a mode. The program detects the
    shape instead of taking a flag.


## M7 — a window is a file description

210. **THE "(STARTING…)" CAPTION IS UNREACHABLE AND IS DELETED.** M4a's detector had three states
    because its window existed before any process had opened `/dev/console`, so a terminal still
    coming up had to be told apart from one that had died (constraint 181). With `win_create` the
    window is made BY the process that will read it and the fd exists from the window's first
    instant, so there is no window waiting for a first opener. `openedEver`, `starting()` and the
    third caption are gone, and `Win.setHealth` takes one argument. A caption nothing can produce
    is dead code, and the two labels that asserted it went with it.
211. **`/dev/console` IS GONE, AND SO IS THE CHARACTER-DEVICE MECHANISM UNDER IT.** It was the one
    row `CHARDEVS` ever had — a name whose `open` produced a kernel object rather than bytes, and
    the one thing on a read-only generated filesystem that could be opened for writing. With the
    row removed the mechanism had no caller, so `SynthFS.chardevAt`, the `chardev` field on a
    generated node, the `chardev` branch in `open(2)` and the kernel's `openChardev` are deleted
    with it. **ENXIO is no longer reachable from `open`**: it answered "this name exists and its
    device does not", and a window is not a name any more. `docs/DECISIONS.md` D25 recorded the
    expiry when the special case was created; this is it.
212. **A PROGRAM FETCH THAT FAILS AT THE TRANSPORT MUST BE RETRIED, AND IT WAS NOT — THE KERNEL
    PANICKED.** `programText` bounded the fetch at 5 s and retried ONCE (constraint 155), but the
    retry covered only `AbortController` firing. `fetch` reports every network-level failure as
    `TypeError: Failed to fetch` with no status, and that was rethrown: it escaped `programText`
    through `programImage` and `spawnBatch` to `self.onmessage`, which has no `try`/`catch`, so
    the kernel reported `panic` and the page reported `timed out waiting for spawned`.

    **Measured: three failures in six runs of `scripts/check.py --only m7 --prove-failure`, and
    none in eight after the fix.** `www/m7.html` is where it surfaced because it boots five
    kernels and takes ~75 ranged GETs plus four program fetches through one local server in 17 s.
    The fix is four lines in the one place the retry already lived, split by CAUSE: an abort is
    the deadline, a `TypeError` is the transport and is retried, and an HTTP status — which
    `response.ok` raises as a plain `Error` — is never retried, because a 404 will be a 404 again.

    **It is a check now, both ways.** `bench/kernel-churn/probe.py --drop` closes the first program
    fetch before a single byte and serves the real program on the retry: every kernel must still
    boot and spawn, AND at least one must report a non-zero `transport` retry, which is the only
    direct evidence the retry did anything. With the four lines removed, 1 of 4 kernels stalls at
    `spawned`. **The claim this corrects was written in that probe**: its note said a dropped
    connection "would reject the fetch and `spawn` would already answer -ENOEXEC without any
    deadline, so a control built on a reset would prove nothing". The spawn did not answer
    -ENOEXEC; it took the kernel down.

    **AND THE RETRY ALONE WAS NOT ENOUGH, which took two more measurements.** A run then lost BOTH
    attempts in the same instant, because the retry was immediate and hit the same condition. Two
    things were wrong and both are fixed:

    - **The listen backlog was five**, `socketserver`'s default. One page boots six kernels, a
      `/usr` mount is fifteen ranged GETs, and Chrome opens up to six connections per origin at
      once — so a SYN arriving while five are queued is REFUSED, which is what `fetch` reports as
      `TypeError: Failed to fetch`. `serve.Server` sets it to 128, and `scripts/check.py` and
      `bench/kernel-churn/probe.py` now build their servers from that class instead of from
      `ThreadingHTTPServer` directly, so there is one definition of it.
    - **The retry had no backoff.** 60 ms now — long enough for a listen queue to drain, short
      enough that a spawn still answers well inside the 5 s deadline.
217. **A DESTROYED WINDOW KEEPS ITS QUEUE, AND THE FIRST VERSION DID NOT — WHICH MADE `WEV_CLOSE`
    UNREACHABLE.** `destroy()` cleared the event ring and then queued its own `WEV_DESTROYED`
    notice. The page's X button posts `win-in [WEV_CLOSE]` and then `win-gone` as two messages, and
    the kernel serves them in order — so the close record was queued and wiped two messages later.
    A relay parked in `poll` rather than in `read` never saw it, `src/bin/term.mjs`'s arm for it
    was dead code, and the keystrokes typed just before the window closed went with it. **Found by
    an independent critic; nothing in `www/m7.html` or `scripts/check.py` would have caught it**,
    which is why M7 has a sixth proof that clicks the real close box and asserts the process was
    told. The queue is kept, the notice is appended, and room for the notice is made by dropping
    the OLDEST — the one place constraint 213's rule is inverted, because the record naming the
    window that went is the one a reader cannot do without.
218. **A WORKER THAT NEVER STARTS GETS ONE RETRY FROM THE PAGE, counted and reported.** A Worker
    that will not start fires an error with an empty message (constraint 207), and "the residual
    `up` stall is Chrome's worker startup under load" (constraint 155). `www/m7.html` boots six
    kernels in seventeen seconds — the most of any page but `www/m4b.html` — and it cost about one
    run in seven: `kernel worker: undefined`, a BROKEN check and nothing to fix. The page retries
    ONCE with a fresh worker, increments `globalThis.M7.bootRetries` and says which attempt failed
    and why; five consecutive `--prove-failure` runs are clean. Same shape as `docs/DECISIONS.md`
    D21 and for the same reason: a silent retry turns a measurable platform limit into a page that
    is mysteriously slow sometimes. It covers ONLY a worker that never reached `up`.
213. **A WINDOW'S EVENT QUEUE IS BOUNDED PER FD, THE NEWEST IS DROPPED, AND THE COUNT IS
    PUBLISHED.** `WIN_EVENT_CAP` = 256 records = 4 KiB, the same order as the pty's input queue it
    sits beside. This is M1's item (e) — a fixed budget with a defined overflow, charged against
    the fd rather than the process — so a window nobody is reading does not starve the same
    process's pipe. **The NEWEST is dropped and not the oldest**, deliberately: the oldest event is
    the one whose age the not-responding detector is measuring, so dropping it would hide the wedge
    the detector exists to report. `dropped` is in `/proc/<pid>/win/<winid>` whether or not it is
    zero, for the reason `/dev/trace`'s counter is (constraint 72).
214. **A PROOF'S EXIT CONDITION MUST NOT BE SATISFIABLE BY THE SYSTEM'S OWN SETUP, AND M7's FIRST
    ONE WAS.** `bench/m7-win/poller.mjs` ran until every fd in its poll set had woken it once —
    and the page reports each frame's geometry the instant it builds it, so both windows had a
    `WEV_RESIZE` queued before anything was typed and all three fds were ready on the FIRST poll.
    Measured: `wokeBy {0:1, 3:1}` with `keysSeen {}`, the program exiting before a key was pressed.
    It now runs until each window has delivered a KEY and the pipe has delivered bytes or end of
    input. **Two more of the same class, both found by `bench/m7-win/controls.py` rather than by
    reading**: an overflow clause whose fixture pushed 256 identical events, so "the oldest came
    out" held under a mutation that dropped the oldest; and a cascade clause that compared the
    posted id list against the ids the same call returned, which is constraint 120's `None ==
    None` in a new place. The mutation harness paid for itself three times on its first run.
215. **THE FIRST WINDOW LANDED ON fd 0**, because `spawn` leaves fd 0 free and nothing held it —
    constraint 94's defect reached through a different call. Measured: `fds: [0, 3]` for a process
    whose first window was its stdin. `bench/m7-win/poller.mjs` opens `/dev/zero` first, as
    `src/bin/term.mjs` already did. **And the pipe in the same poll set was `undefined`**, because
    `pipe2` answers `{rfd, wfd}` and the program read `{read, write}`: `poll` reported POLLNVAL for
    fd `undefined`, which is READY, so the pipe's clause passed on an fd that did not exist. Two
    defects in one run, both invisible to a clause that only asked whether something was ready.
216. **A WINDOW IS DESTROYED WHEN THE LAST DESCRIPTION ON IT CLOSES, and `win_destroy` on a parent
    takes its children with it ACROSS PROCESSES.** Those are two halves of one rule: a window with
    no fd is a frame with nothing behind it (constraint 179), and a dialog outliving the window it
    belongs to is what M9 exists to prevent. The authority is deliberate and narrow — a child
    accepts it by naming a parent, and it travels one way only, so a child's destruction never
    reaches its parent. The destroyed window queues ONE last `WEV_DESTROYED` record before
    refusing further reads, so the process that lost a window to another process's call learns why
    rather than reading a bare errno; `bench/m7-win/controls.py --only notice-too-late` puts that
    ordering back the wrong way round and six checks move.
