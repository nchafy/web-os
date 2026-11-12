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
    process. `research/gap-04.md`.
18. Signals, broadcasts and any per-frame sweep MUST be O(interested), never O(N). Round-tripping
    all live workers cost 378 µs each; at 1,600 workers that is 502 ms. `research/gap-04.md`.
19. Spawn from a Blob URL built from VFS bytes (1.86 ms), not an HTTP URL (3.45 ms). Add 5–6 ms for
    a WASM instantiation, so budget ~8 ms for a real process — under one frame, which means `exec`
    can be synchronous from the user's point of view. `research/gap-04.md`.
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
