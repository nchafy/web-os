# Web-OS field survey: process models, isolation, VFS and app APIs across Puter, anuraOS, daedalOS, win32.run, RipenOS

## Summary

Four projects solve disjoint halves of the problem and only one solves both. Puter is the only system with a real kernel boundary: each app is a separate ORIGIN (`https://<app>.<app_domain>/index.html`), gets its own minted per-(user,app) token rather than the desktop's session, and reaches the filesystem over HTTP against a server that authorizes a derived "app-under-user" actor. The window is a host-side object the app never touches. anuraOS is the opposite trade: a genuinely Unix-shaped process model (PID, WHATWG-stream stdio, kill, shebang-dispatched exec, longest-prefix-mount VFS) built on same-origin iframes with the whole kernel object assigned into each frame — processes without protection. daedalOS contributes the best storage idea: a read-only HTTP-served root image overlaid with a writable IndexedDB layer, i.e. copy-on-write `/usr`. win32.run and RipenOS are the failure mode webxp already hit, documented in source. The lesson: the process table, the window, and the app's code must be three separate things, and isolation has to come from origin, not discipline.

## Findings

### Puter isolates each app by giving it its own ORIGIN, not by sandbox flags: `appLaunchUrl` builds the app's URL as `https://${name}.${appDomain}/index.html`, so every app runs on a distinct subdomain of the configured app domain and is cross-origin to the desktop.

- Evidence: https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/src/gui/src/helpers/appLaunchUrl.js#L55
- Confidence: verified
- Why it matters: This is the single structural decision webxp was missing. It is enforced by the browser, not by code review: an app physically cannot reach `window.parent`'s DOM, globals, or filesystem library. It costs a wildcard DNS entry and a wildcard certificate, and it makes every syscall asynchronous forever.

### Puter's built-in apps are exempted from the subdomain rule via a sentinel prefix: an `index_url` starting with `https://builtins.namespaces.puter.com/` is rewritten to `${guiOrigin}/builtin/...`, i.e. served same-origin from the desktop itself.

- Evidence: https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/src/gui/src/helpers/appLaunchUrl.js#L26
- Confidence: verified
- Why it matters: A two-tier trust model: trusted first-party apps run in the kernel's origin, third-party apps do not. Worth copying as an explicit, named tier rather than an accident — the sentinel URL is deliberately a domain that can never be a real app.

### Puter processes are host-side objects decoupled from windows. `Process` carries uuid/parent/name/status and a lazily-resolved `references.iframe`; `PortalProcess` (type `app`) implements `_signal` so END_SOFT closes the window cooperatively and END_HARD closes it with `bypass_iframe_messaging`, and `PseudoProcess` (type `ui`) represents a window with no app behind it.

- Evidence: https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/src/gui/src/definitions.js#L153
- Confidence: verified
- Why it matters: The kill path is the thing webxp could not have: a soft signal the app may handle and a hard signal that tears the frame down regardless. Two signal levels, not one `close()`. Also note `InitProcess` is PID-1-shaped — it broadcasts signals to all other processes and only END_HARD terminates it, via `window.location.reload()`.

### Puter authenticates postMessage by frame identity, not by payload: the listener rejects any message whose `event.source` is not the `contentWindow` of the iframe owning the claimed `appInstanceID`, with the comment that instance IDs are disclosed to other apps so knowing one must not be enough to act as that app.

- Evidence: https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/src/gui/src/IPC.js#L140
- Confidence: verified
- Why it matters: The correct shape for a syscall entry point. An id in the message body is a bearer token that leaks; `event.source` is unforgeable. This is the exact check win32.run omits.

### Puter's IPC surface is a ~70-branch message table that is almost entirely UI and window syscalls — ALERT, PROMPT, createWindow, setWindowTitle/Size/Position, setMenubar, contextMenu, showOpenFilePicker, showSaveFilePicker, showDirectoryPicker, showColorPicker, showFontPicker, messageToApp, closeApp, exit, requestPermission — plus an extension registry (`window.ipc_handlers` / `register_ipc_handler`) for new calls.

- Evidence: https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/src/gui/src/IPC.js#L221
- Confidence: verified
- Why it matters: The division of labour is the lesson: postMessage carries only what needs the desktop's DOM or the user's consent. Bulk data operations do not go through the parent frame at all. A single 2000-line if/else chain is also visibly the wrong container for it — Puter is migrating to the registry, and a from-scratch build should start there.

### Puter's filesystem is NOT proxied through the desktop. `puter.fs` operations issue XHRs straight from the app's frame to `APIOrigin` with the app's own `authToken` in an Authorization header.

- Evidence: https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/src/puter-js/src/modules/FileSystem/operations/scaffold.js#L139
- Confidence: verified
- Why it matters: Resolves the obvious objection to cross-origin apps ('every read becomes a postMessage round trip'). It does not: the kernel brokers identity, then gets out of the data path. Authorization lives on the server, so the client-side desktop is not a security boundary that can be bypassed by a rogue frame.

### Puter jails each app to its own subtree by path rewriting in the SDK: a relative path is resolved against `~/AppData/<appID>/`, while an absolute (`/`) or home-relative (`~`) path is passed through.

- Evidence: https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/src/puter-js/src/modules/FileSystem/utils/getAbsolutePathForApp.js#L29
- Confidence: verified
- Why it matters: Gives apps a private writable home for free, with no API difference — `fs.write('config.json')` is automatically scoped. But it is a client-side convenience, not the boundary: an app can still name `/` and the server-side permission check is what refuses it. Do not mistake the rewrite for the jail.

### Each Puter app launch mints a token scoped to that app rather than handing over the desktop session: the normal path calls `fetchUserAppTokenForLaunch({ appUid })`, and the privileged path (`app_info.godmode`) mints a separate full-access token renewed while the window is open — commented as 'never the desktop's session'. A launch with no token obtainable is aborted.

- Evidence: https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/src/gui/src/helpers/launchApp.js#L482
- Confidence: verified
- Why it matters: The real isolation primitive, and the part a from-scratch builder will skip. The origin split stops DOM access; the per-app token stops API access. Without it, every app holds the user's whole account. Note the token travels in the iframe URL query string, and Puter deliberately does NOT do that for a new tab because it would land in browser history.

### Puter's server-side authorization is an actor model, not a user model. An `Actor` distinguishes `app` (an app-under-user token) from `effectiveApp` (the app it ultimately acts as, including via an access token's issuer); `makeActor` resolves `effectiveApp` once and `assertResolvedActor` rejects at the request edge any actor that skipped resolution, so gates never read `undefined` as 'no app'.

- Evidence: https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/doc/architecture.md
- Confidence: verified
- Why it matters: The transferable idea: the unit of authorization is (user x app x token-scope), not the user. 'Who is asking' and 'on whose behalf' are separate fields, and the fail-closed assertion at the edge is what stops the classic 'gate reads the wrong field and falls open' bug.

### Puter permissions are colon-delimited capability strings (`driver:puter-kvstore:get`, `fs:<uid>:see`, `notifications:push`, `events:background`) with escaping for literal colons, a `manage:` prefix for delegation, and a `scan()` traversal that enumerates every path by which an actor might hold one — direct grant, group, issuer, or an implicit default floor.

- Evidence: https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/src/backend/services/permission/PermissionService.ts
- Confidence: verified
- Why it matters: A single string namespace covers filesystem paths, RPC endpoints and OS features uniformly, which keeps the consent dialog and the server gate reading the same vocabulary. The `manage:` prefix for 'can grant this to others' is the piece most hand-rolled permission systems omit and then cannot add.

### App-initiated consent is a GUI dialog that the app cannot forge or read around: `requestPermission` gates on auth, caps the request at 16 permissions to match the server's grant endpoint, validates the shape, shows `UIPermissionDialog`, and posts back only a boolean. The handler always responds even on failure, because a throw would hang the app's promise forever.

- Evidence: https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/src/gui/src/IPC.js#L1335
- Confidence: verified
- Why it matters: Two details worth stealing outright: cap the request to what the server can actually grant (otherwise the user consents to something ungrantable and the grant 400s after they click Allow), and make every syscall path reply unconditionally — a cross-origin caller has no timeout to fall back on.

### anuraOS implements a Unix-shaped process model: `Processes.create()` spawns a hidden iframe with the script inlined, `Process` is abstract with `pid`, `title`, `kill(code)`, `alive`, and real `stdin`/`stdout`/`stderr` as WHATWG `WritableStream`/`ReadableStream` wired over postMessage; `kill()` posts a `kill` message, waits for acknowledgement, then removes the frame.

- Evidence: https://github.com/MercuryWorkshop/anuraOS/blob/cc18239e5bf78e580265f09180cd079f9bc92f20/src/api/Processes.tsx#L90
- Confidence: verified
- Why it matters: The clearest demonstration that a browser process need not have a window at all — these frames are `display:none` in a `#processes` div. Streams as the stdio type means `proc.stdout.pipeTo(...)` gives you pipelines for free. This is the model a shell needs and the one webxp's app-is-its-window design forecloses.

### anuraOS dispatches execution from a shebang read out of the file itself: `execute()` reads bytes up to the first newline, and if it starts with `#!` parses the second whitespace-separated token as JSON options (`{"lang":"module"|"common"}`), then runs the remaining payload as that script type, throwing 'Invalid shebang' otherwise.

- Evidence: https://github.com/MercuryWorkshop/anuraOS/blob/cc18239e5bf78e580265f09180cd079f9bc92f20/src/api/Processes.tsx#L49
- Confidence: verified
- Why it matters: Makes `exec(path)` a filesystem operation rather than a registry lookup, so a user-written file in the VFS is executable with no installation step. Contrast daedalOS and win32.run, where the set of runnable programs is a hardcoded table in the bundle.

### anuraOS's VFS is a mount table with longest-prefix resolution: `AFSProvider` declares a `domain` (e.g. `/` or `/tmp`), documented as 'the provider with the most specific domain will be used', and `processPath` walks path components from longest to shortest, caching the result and falling back to the `/` provider. It exposes a Node-shaped async API (open/read/write/stat/lstat/symlink/readlink/chmod/chown/mkdtemp/ftruncate/fsync) plus an `AFSShell` with cat/ls/exec/find/mkdirp/rm/touch/cd/pwd.

- Evidence: https://github.com/MercuryWorkshop/anuraOS/blob/cc18239e5bf78e580265f09180cd079f9bc92f20/src/api/filesystem/Filesystem.ts#L725
- Confidence: verified
- Why it matters: This is the POSIX-ish VFS shape, in ~1200 lines of readable TypeScript, with only two providers shipped in-tree (`FilerFS` over IndexedDB, `LocalFS` over the File System Access API). Mountpoints are what let `/proc`, `/dev`, a remote share and a zip file all be paths later without touching callers.

### anuraOS has processes but NO isolation: `IframeProcess` and `ExternalApp` both `Object.assign` the live kernel object (`anura`, `AliceWM`, `ExternalApp`, `LocalFS`) into the child frame's `contentWindow`, and app iframes carry no `sandbox` attribute. Its per-app IndexedDB namespacing is a `Proxy` over the frame's `indexedDB` that prefixes database names with the package id.

- Evidence: https://github.com/MercuryWorkshop/anuraOS/blob/cc18239e5bf78e580265f09180cd079f9bc92f20/src/coreapps/ExternalApp.tsx#L154
- Confidence: verified
- Why it matters: The decisive warning for this project: anuraOS gets the process model right and the boundary wrong, so copying its Processes.tsx wholesale reproduces webxp's defect with better ergonomics. Take the PID/stream/kill shape, reject the same-origin injection. The IndexedDB Proxy is namespacing, not confinement — an app can build its own iframe and get the unproxied object.

### anuraOS distinguishes `.app` packages (manifest with `type`, `index`, `wininfo` for title/width/height) from `.lib` packages (manifest with a `versions` map, `currentVersion`, optional `cache` and `installHook`), so shared libraries are installed system-wide and versioned independently of the apps importing them.

- Evidence: https://github.com/MercuryWorkshop/anuraOS/blob/cc18239e5bf78e580265f09180cd079f9bc92f20/apps/libhterm.lib/manifest.json
- Confidence: verified
- Why it matters: A package format that separates applications from shared code, with the window geometry declared as manifest data rather than code. `installHook` gives libraries a registration step (e.g. libfilepicker registering itself as the picker handler), which is how you get a pluggable system service without a hardcoded import.

### daedalOS gives its root filesystem copy-on-write semantics: BrowserFS `MountableFileSystem` mounts `/` as an `OverlayFS` whose readable layer is `HTTPRequest` driven by a prebuilt index and whose writable layer is IndexedDB (or InMemory). The index is v86's 9p filesystem JSON (`public/.index/fs.9p.json`), converted to a BrowserFS tree by `fs9pToBfs`, with `fs9pV4ToV3` handling both index versions.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/contexts/fileSystem/FileSystemConfig.ts
- Confidence: verified
- Why it matters: The answer to 'how do I ship a populated /usr, /Program Files and wallpapers without stuffing them into IndexedDB on first boot'. Files are fetched lazily over HTTP and CDN-cached; only writes consume local quota; a reset is dropping the writable layer. Reusing v86's 9p index format means one image can feed both the VFS and an emulator.

### daedalOS keeps the program registry as data: `contexts/process/directory.ts` is a single `Processes` record of ~429 lines mapping a program id to `{ Component, defaultSize, icon, title, singleton, libs, dependantLibs, allowResizing, lockAspectRatio, ... }`, with `Component` a `next/dynamic` lazy import and `libs` a declarative list of scripts/wasm to load from the VFS before the app runs.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/contexts/process/directory.ts
- Confidence: verified
- Why it matters: Window chrome is rendered by the shell from the process table, so adding a program is adding a row, not editing the window manager — the inverse of win32.run. `libs`/`dependantLibs` is a per-app dependency manifest resolved from the filesystem, which is how it hosts BoxedWine, v86 and Ruffle without bundling them. The apps are still same-bundle React components with no isolation.

### win32.run (public source: ducbao414/win32.run, MIT, SvelteKit + Svelte 3 + Vite 3 + Tailwind + jQuery UI) has no process abstraction. `work_space.svelte` is a 315-line `launch()` function that is a hand-written if/else chain over 24 literal component paths, each branch dynamically importing a `.svelte` file, calling `new Program({ target: node_ref, props })`, setting `program.self = program`, and pushing the component instance itself into a `runningPrograms` store. Termination is the component calling `self.$destroy()` on itself.

- Evidence: https://github.com/ducbao414/win32.run/blob/9ca31a7ff42e69b31cd64a6ff26d1c22d0bdb840/src/routes/xp/work_space.svelte#L33
- Confidence: verified
- Why it matters: This is webxp's architecture in someone else's repository, at 540 stars, confirming the diagnosis independently: the component IS the window IS the process entry, so there is nothing to background, nothing to kill from outside, and adding a program means editing the dispatcher. The `runningPrograms` store holds UI component instances, so the task bar is the process table.

### win32.run's filesystem is a flat `{id: node}` object in a Svelte writable store (`hardDrive`), persisted via `idb-keyval`, with parent pointers and a separate `finder` module for path rendering; its API is bespoke (`new_fs_item`, `save_file_as`, `get_file`, `clone_fs`, `del_fs`), not POSIX-shaped.

- Evidence: https://github.com/ducbao414/win32.run/blob/9ca31a7ff42e69b31cd64a6ff26d1c22d0bdb840/src/lib/fs.js
- Confidence: verified
- Why it matters: Shows the cost of skipping the VFS layer: paths are derived from the node graph rather than being the addressing scheme, so there is no mountpoint, no fd, no stat, and nothing a shell could be written against. The user's stated target (POSIX-ish VFS + shell) rules this shape out from the start.

### win32.run's one real idea is brokered file access for untrusted third-party apps: a `Win32` class served at `/js/api/0.js` reads `program_id` and `parent_origin` from its own query string and exposes `is_it()`, `pick_files(desc, exts, multiple)`, `save_file`, `save_file_as` and `get_file` over postMessage; the host component injects those two params into the app's iframe URL and replies with host-native file objects after the user picks in an XP-styled dialog.

- Evidence: https://github.com/ducbao414/win32.run/blob/9ca31a7ff42e69b31cd64a6ff26d1c22d0bdb840/static/js/api/0.js
- Confidence: verified
- Why it matters: A minimal, genuinely useful capability pattern: the app never gets the filesystem, only the files the user selected, and the host tells the guest its own identity and the host origin via URL params so the guest can target postMessage precisely. Same shape as Puter's pickers, in 146 lines.

### win32.run's host-side message handler validates only `data.program_id != id` and never checks `event.origin` or `event.source`, while the outbound direction does pin the target origin (`postMessage(data, new URL(webapp_url).origin)`).

- Evidence: https://github.com/ducbao414/win32.run/blob/9ca31a7ff42e69b31cd64a6ff26d1c22d0bdb840/src/routes/xp/programs/webapp.svelte#L174
- Confidence: verified
- Why it matters: Concrete negative example for the syscall entry point: the guard is a non-secret id that is handed to the app in its own URL and appears in every message, so any frame or opener that learns another program's id can drive that program's file dialogs. Asymmetric validation (careful outbound, trusting inbound) is the common form of this bug.

### win32.run runs non-trivial applications by embedding existing third-party web apps rather than implementing them: jspaint as Paint, TinyMCE as Word, Koodo as the epub reader, ffmpeg.wasm, libarchive.js in a Web Worker as WinRAR, and Ruffle as Flash Player. A leftover `java.svelte` demo calls `iframe.contentWindow.say_hello()` directly across a same-origin frame.

- Evidence: https://github.com/ducbao414/win32.run/blob/9ca31a7ff42e69b31cd64a6ff26d1c22d0bdb840/src/routes/xp/programs/java.svelte#L96
- Confidence: verified
- Why it matters: The pragmatic answer to 'where do real apps come from' — adopt mature single-purpose web apps and broker files to them. The `contentWindow.say_hello()` line is the anti-pattern in one statement: once the frame is same-origin, the protocol boundary evaporates and nobody maintains it.

### RipenOS has nothing architectural to teach. The shipped desktop is a single hand-written HTML document (the archived source's Ripenos/desktop1.html is 125,593 bytes) containing 18 hardcoded `<iframe>` elements with fixed element ids (`CalcIframe`, `ClockIframe`, `FileIframe`, `WinEmuframe`, ...) pointing at fixed paths under `../Global/Apps/`, zero occurrences of `postMessage`, and jQuery + jQuery UI as the window layer. Apps are page furniture, not instances.

- Evidence: https://github.com/ripenos-personal/ripenos.github.io.archived/blob/aea0ca98f85b45c2ba2480bd53eb03a1ae6157b0/Ripenos/desktop1.html
- Confidence: verified
- Why it matters: No process model, no app API, no VFS, and no second instance of anything is possible. Reported as such so no time is spent on it. Its only incidental data point is that iframe-per-app is the field's default even when nothing else is in place.

### Puter extends the same actor identity to server-side code: a Worker is deployed from a file path in the user's filesystem and runs as the app's actor, or, when created without naming an app, as its own synthetic `sandbox-<workerName>` app whose KV, AppData and notifications are scoped accordingly.

- Evidence: https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/src/puter-js/src/modules/Workers.js
- Confidence: verified
- Why it matters: Shows the actor model is the right abstraction rather than a frontend workaround: once authorization keys on (user x app), server code is just another principal, and an unnamed worker still gets a distinct app identity rather than inheriting the user's full reach. Relevant only if the project ever grows a backend.

### Puter's backend is layered Controllers -> Drivers -> Services -> Stores -> Clients -> Config with constructor injection from `PuterServer`, a documented rule that each layer depends only on those beneath it, and the explicit invariant that Services assume the caller is already authorized and run no auth gates themselves. Per-request state (`actor`, `req`) is carried by an `AsyncLocalStorage`-backed `Context`.

- Evidence: https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/doc/architecture.md
- Confidence: verified
- Why it matters: 'Authorization happens at exactly one layer' is the invariant that makes a kernel auditable, and is directly transferable to a client-side kernel: gates at the syscall entry, logic underneath that assumes it was checked. The `/drivers/*` RPC surface is also the extension seam — new capabilities arrive as drivers, not as new routes.

## Reusable

- Puter's per-app-origin launch URL construction — `https://<app>.<appDomain>/index.html` plus a `BUILTIN_PREFIX` sentinel that rewrites trusted first-party apps to a same-origin `/builtin/...` path. The file is deliberately free of desktop globals so several launch surfaces build the same URL. ~100 lines, AGPL-3.0-only: read it for the design, reimplement rather than copy unless the project is AGPL. https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/src/gui/src/helpers/appLaunchUrl.js
- Puter's `event.source`-against-owning-iframe check and its two-level signal model (END_SOFT / END_HARD with `bypass_iframe_messaging`). Both are a dozen lines of idea each and are the two things webxp structurally lacked. AGPL-3.0-only. https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/src/gui/src/definitions.js#L153
- Puter's actor model as a design to reimplement: authorization keyed on (user x app x token scope) with `app` and `effectiveApp` as distinct fields and a fail-closed `assertResolvedActor` at the request edge. Documented in doc/architecture.md, which is short and unusually candid about which field to read and why. AGPL-3.0-only. https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/doc/architecture.md
- anuraOS's `AFSProvider` interface — a four-member abstract class (`domain`, `name`, `version`, plus the Node-shaped operations) with longest-prefix mount resolution in `processPath` and a result cache invalidated on `installProvider`. The cleanest small VFS mount table in the field. AGPL-3.0. https://github.com/MercuryWorkshop/anuraOS/blob/cc18239e5bf78e580265f09180cd079f9bc92f20/src/api/filesystem/Filesystem.ts#L59
- anuraOS's process-as-hidden-iframe with WHATWG-stream stdio and shebang-dispatched `execute(path)`. ~310 lines total, AGPL-3.0. Reusable as a shape; its same-origin kernel injection must be replaced with a postMessage or MessageChannel protocol.
- daedalOS's `FileSystemConfig` — BrowserFS `MountableFileSystem` with `/` as `OverlayFS(readable: HTTPRequest(index), writable: IndexedDB)`, plus `fs9pToBfs`/`fs9pV4ToV3` converting a v86 9p index into a BrowserFS tree. MIT, so this one can be copied outright, and it is the whole copy-on-write root idea in about 20 lines. https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/contexts/fileSystem/FileSystemConfig.ts
- daedalOS's process directory as a static data table (`Processes` record of id -> {Component, defaultSize, icon, title, singleton, libs, dependantLibs, ...}), with `libs` a declarative list of scripts resolved from the VFS before the app starts. MIT. The data-not-code registry is the part worth keeping even if the component-per-app part is not. https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/contexts/process/directory.ts
- win32.run's `Win32` guest SDK — 146 lines, MIT, Copyright (c) 2023 Bao Nguyen. The minimal brokered-file-access protocol: host injects `program_id` and `parent_origin` into the guest's URL, guest posts a typed request, host runs the picker and replies with the chosen files. Copyable as-is given MIT, but fix the host side's missing origin check. https://github.com/ducbao414/win32.run/blob/9ca31a7ff42e69b31cd64a6ff26d1c22d0bdb840/static/js/api/0.js
- zen-fs/core — the maintained successor to the unmaintained jvilk/BrowserFS (last push 2024-07-12, NOASSERTION licence on GitHub). LGPL-3.0, 431 stars, pushed 2026-11-10, 'A filesystem, anywhere', Node fs API with backends and mounts. LGPL-3.0 means dynamic linking is generally fine and modifications to the library itself must be shared; confirm the terms against the repo's own LICENSE before depending on it. https://github.com/zen-fs/core
- filerjs/filer — BSD-2-Clause, 636 stars, 'Node-like file system for browsers'. This is the provider anuraOS actually ships as its root (`FilerAFSProvider`), so it is proven as the IndexedDB layer under a mount table, and the permissive licence makes it the safer default of the two. https://github.com/filerjs/filer
- copy/v86 — BSD-2-Clause, 23,676 stars. The x86 emulator both anuraOS and daedalOS build on, and the source of the 9p filesystem index format that daedalOS reuses for its read-only root layer. Worth depending on for 'run a real Linux' as an app, not as the OS foundation. https://github.com/copy/v86
- MercuryWorkshop/wisp-protocol — CC-BY-4.0 (a documentation/spec licence, not a code licence; check the implementation repos separately). 'A low-overhead, easy to implement protocol for proxying multiple TCP/UDP sockets over a single websocket' — the piece anuraOS uses to give its Linux guest real networking. Only relevant if guest sockets are in scope. https://github.com/MercuryWorkshop/wisp-protocol

## Gotchas

- `sandbox="... allow-same-origin ..."` on Puter's app iframes is not a hole and not the isolation mechanism. Because `src` is already a different origin (`<app>.<app_domain>`), `allow-same-origin` only means 'keep your real origin instead of an opaque one'. Puter conditionally DROPS it for `srcdoc` frames, where it genuinely would grant parent DOM access — the inline comment says so. If you reason about isolation from the sandbox attribute you will reach the wrong conclusion in both directions. https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/src/gui/src/UI/UIWindow.js#L446
- The `credentialless` iframe attribute looks like free hardening and silently breaks app state. MDN: a credentialless frame 'uses a new context local to the top-level document lifetime', storage is partitioned by a nonce reset on every navigation, so 'reloading the document will load the credentialless <iframe>s in a different context' and prior cookies and localStorage are gone; password managers and autofill are unavailable; and pop-ups get `rel="noopener"`, which 'prevents OAuth pop-up flows from being used in credentialless iframes'. Puter gates it behind a `co_isolation_enabled` flag plus a per-app `iframe_credentialless: false` escape hatch for exactly this reason. https://developer.mozilla.org/en-US/docs/Web/Security/IFrame_credentialless
- Copying anuraOS's Processes.tsx gives you PIDs, stdio streams and kill, and reproduces webxp's actual defect: the frames are same-origin and the whole kernel object is `Object.assign`ed into each one. The process model and the protection model are independent, and anuraOS only built the first. Take the shape, not the wiring. https://github.com/MercuryWorkshop/anuraOS/blob/cc18239e5bf78e580265f09180cd079f9bc92f20/src/api/Processes.tsx#L150
- Per-app subdomains are not free in development. You need wildcard DNS and a wildcard TLS certificate, and Puter's self-host default leans on `*.puter.localhost` (`domain: puter.localhost`, `static_hosting_domain: site.puter.localhost` in config.template.jsonc). Chrome and Firefox resolve arbitrary `*.localhost` to loopback; that behaviour is not universal across browsers and tooling, and `app_domain` otherwise falls back to the GUI origin's own hostname, which silently collapses the origin split. https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/config.template.jsonc
- Namespacing is not confinement. anuraOS's per-app IndexedDB `Proxy` prefixes database names with the package id and defines it `writable: false` on the frame's window — but a same-origin app can create its own iframe or worker and obtain the unproxied `indexedDB`. A client-side rewrite (including Puter's `~/AppData/<appID>` path prefixing) is ergonomics; the boundary has to be enforced where the app cannot reach, i.e. a different origin or a server-side check. https://github.com/MercuryWorkshop/anuraOS/blob/cc18239e5bf78e580265f09180cd079f9bc92f20/src/coreapps/ExternalApp.tsx#L113
- Asymmetric postMessage validation is the field's standard bug. win32.run pins the target origin when sending and validates only a guessable `program_id` when receiving — and that id is handed to the app in its own iframe URL. Puter's comment states the general rule: ids get disclosed between apps, so an id can never authenticate a sender; check `event.source` against the frame you expect. https://github.com/ducbao414/win32.run/blob/9ca31a7ff42e69b31cd64a6ff26d1c22d0bdb840/src/routes/xp/programs/webapp.svelte#L174
- Cross-origin apps make every error path a hang, not an exception. A cross-origin caller has no stack and no timeout to fall back on, so a syscall handler that throws before replying leaves the app's promise pending forever. Puter's `requestPermission` carries three separate comments about this and wraps even the signup window in try/catch purely to guarantee a reply. Design the syscall return contract as 'always exactly one response' before writing the second handler. https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/src/gui/src/IPC.js#L1335
- Puter's IPC.js is 2,070 lines of `else if (event.data.msg === ...)`. The repo is actively migrating off it to a `register_ipc_handler` registry that wraps calls with an `ipc_context` (caller process, origin, app). Reading IPC.js as the intended design copies the thing they are removing; the registry path at the top of the same listener is the current one. https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/src/gui/src/IPC.js#L159
- v86 gives you a real Linux kernel and a separate universe. anuraOS stores its guest root as an ext4 binary blob sliced across IndexedDB keys, boots it with `root=/dev/sda rootfstype=ext4`, and bridges guest networking through a Wisp proxy plus a guest-side daemon over a serial channel. The guest filesystem is not your VFS; joining them is a real project. If the goal is a POSIX-ish VFS plus a shell that your own apps use, emulation is a separate feature, not the foundation. https://github.com/MercuryWorkshop/anuraOS/blob/cc18239e5bf78e580265f09180cd079f9bc92f20/src/api/v86.tsx#L284
- Puter's permission dialog caps requests at 16 because the server's grant endpoint does. The comment records what happens without the cap: the dialog renders every row, the user clicks Allow, the grant 400s — 'consent for something ungrantable'. Any limit duplicated between a consent UI and its enforcement point has to be derived from one declaration, or it drifts into a dialog that lies.
- daedalOS, win32.run and RipenOS all have something named like a process and none of them have one. daedalOS's is a React context record whose `Component` is in the same bundle; win32.run's is a Svelte component instance in a store; RipenOS's is a hardcoded `<iframe>` with a fixed element id. Only Puter and anuraOS have an object whose lifetime is independent of a rendered window — and only Puter's survives the app being hostile.

## Could not determine

- Whether https://ripenos.web.app/Ripenos/ is built from a pinned public revision. The live page is a 261,997-byte single HTML document self-labelled 'Desktop1 - V4.0 update | RGOS v5.0 Bundled Launch'. The repo it links to (ripenos/ripenos.github.io) 404s on the GitHub API; the live-looking fork verrington/ripenos.github.io (MIT, 50 stars, pushed 2026-03-25) now has only a 524-byte Ripenos/index.html; and the matching monolithic file exists in ripenos-personal/ripenos.github.io.archived at an older revision (125,593 bytes). My structural claims about RipenOS come from the deployed artifact I fetched plus that archived file, not from a revision I can prove the live site was built from.
- Puter's production `app_domain` value. In self-host, config.template.jsonc sets `domain: puter.localhost` and `static_hosting_domain: site.puter.localhost`, and the GUI derives `app_domain` from the GUI origin's hostname when not passed explicitly (src/gui/src/index.js:53). What puter.com itself passes at runtime is server-side configuration I did not read, so I did not assert a specific production app domain.
- Whether Puter's backend independently verifies the Origin header of an app's API requests, beyond validating the app token. I confirmed the client-side `isAttestedOrigin` allow-list and its comment that it mirrors a backend check 'in util/validation.js (separate bundles)', but I did not read that backend file, so I cannot state how strictly the server binds a token to the origin it was issued for.
- anuraOS's full provider set as deployed. Only two `AFSProvider` subclasses exist in src/ (FilerFS, LocalFS); the constructor also dynamically imports `/libs/nfsadapter/nfsadapter.js` from a build directory not present in the repo, so additional mounts may be registered at runtime from built artifacts I did not inspect.
- 'Nebula' as a web OS worth studying. GitHub repository search for nebula + web OS/desktop/browser returned only two repositories, both with 0 stars and no licence, one self-described as a simulated desktop. If the name refers to something specific, I did not find it, and I am not guessing at a URL.
- Whether anuraOS's hidden process frames are cross-origin in any configuration. They are created with `src="/display?content=..."` — a same-origin path on the anura server — and the code then writes directly into `frame.contentWindow`, which only works same-origin. I did not check the `/display` route's response headers for any origin- or sandbox-related behaviour.

