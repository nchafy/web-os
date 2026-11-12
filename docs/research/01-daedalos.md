# daedalOS (DustinBrett/daedalOS) — process model, VFS, emulator integration, OS-feel mechanisms, and what is absent. Source read at pinned commit ed9c7a54cc50a6e9125333743164830ad56779a5 (2026-10-21), local clone at /tmp/daedalos-research/repo.

## Summary

daedalOS is a very high-fidelity desktop shell with no kernel. A "process" is a record holding a React component reference; `AppsLoader` maps the process map to JSX, so every app is a component in the host realm, sharing one `window`, one event loop, and ambient access to the filesystem hook. The second attempt's failure mode (apps importing the FS library, app == window) is only half-fixed here: the window is separated from the app (`Window` wraps the component, geometry lives in session state keyed by pid), but the FS is still an ambient React context any component can call, and program loading is `<script src>` injection into `document.head` with a deduping cache. The cost is visible in the code: `shareGlobal` patches `window.define` with a getter that parses `new Error().stack` to decide which app gets the value, and `cleanUpGlobals` hand-deletes global names after certain apps close. The genuinely transferable ideas are elsewhere: a build-time 9p JSON index as a read-only base layer under an IndexedDB overlay (BrowserFS `MountableFileSystem`/`OverlayFS`); mounting a guest emulator's Emscripten FS back into the host VFS as a directory; handing v86's Linux the same 9p index so host and guest see one tree; and a same-origin iframe used purely as a fresh realm for apps that fight over globals. Treat the iframe as namespace hygiene, not a security boundary.

## Findings

### A daedalOS "process" is a plain record whose identity is a React component: `Process` is `ProcessArguments & ProcessElements & { Component: React.ComponentType<ComponentProcessProps>; icon; title; minimized?; maximized?; closing?; singleton?; hasWindow?; ... }`, and `Processes = Record<string, Process>`. There is no worker, no realm, no message port in the type.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/contexts/process/types.ts
- Confidence: verified
- Why it matters: Confirms the reference implementation does NOT solve the kernel-boundary problem. If you copy daedalOS's process model you inherit webxp's failure: nothing is isolated, and "kill" means unmounting a React subtree.

### All processes render into one React tree in one realm: `AppsLoader` subscribes to the whole process map and renders `<RenderComponent Component={Component} id={id}/>` for each non-closing entry; `RenderComponent` wraps it in an `ErrorBoundary` and optionally a `Window`. The error boundary is the entire fault-isolation story — a crash shows `ComponentError` instead of taking the desktop down, but a runaway loop or memory leak is not contained.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/components/system/Apps/AppsLoader.tsx
- Confidence: verified
- Why it matters: An error boundary per app is cheap and worth copying, but it is not isolation. Anything stronger (worker, iframe, origin) has to be designed in at the registry level, not retrofitted per app.

### The process registry is a single static object literal, `contexts/process/directory.ts`: 33 entries (BoxedWine, Browser, Chess, ClassiCube, DevTools, DXBall, Emulator, FileExplorer, IRC, JSDOS, Marked, Messenger, MonacoEditor, OpenType, OpenWith, Paint, PDF, Photos, Properties, Quake3, Ruffle, Run, ScreenSaver, SpaceCadet, StableDiffusion, Terminal, Tic80, TinyMCE, Transfer, V86, VideoPlayer, Vim, Webamp). Each entry declares `Component: dynamic(() => import(...))` plus declarative metadata: `defaultSize`, `backgroundColor`, `singleton`, `lockAspectRatio`, `libs` (script/CSS URLs under /Program Files), `dependantLibs` (wasm/data to preload).

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/contexts/process/directory.ts
- Confidence: verified
- Why it matters: This is the piece worth stealing wholesale: a declarative app manifest separated from the app's code, with code-splitting as the only link. It is the right shape for a registry even if the thing it points at should be a worker/iframe entrypoint instead of a component.

### PIDs are structured strings, not numbers: `createPid` builds `${processId}__${url}` and appends `__${instance}` on collision (`PROCESS_DELIMITER = "__"`). `singleton: true` makes `open()` find any pid starting with `Name__` and just swap its `url` instead of spawning.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/contexts/process/functions.ts
- Confidence: verified
- Why it matters: Pid-encodes-argv means a pid is a cache key, so session geometry, singleton routing and dedupe all fall out for free — but it also means a pid is not opaque and cannot be reassigned, and two instances of the same file are impossible to distinguish without the instance suffix.

### The only isolation primitive in the codebase is `hooks/useIsolatedContentWindow.ts`: it creates an `<iframe>` with no `sandbox` attribute, writes `<!DOCTYPE html><head/><body/>` into it with `document.write`, and returns the same-origin `contentWindow`. Used by exactly 5 apps: Emulator (EmulatorJS), ClassiCube, Quake3, SpaceCadet, Tic80. It forwards click/focus/blur to `setForegroundId` and dragover/drop to the host file-drop handler.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/hooks/useIsolatedContentWindow.ts
- Confidence: verified
- Why it matters: A same-origin, un-sandboxed iframe is a fresh global namespace, not a security or resource boundary — the child can reach `parent.*` freely. Copy it for Emscripten apps that fight over `window.Module`; do not describe it to yourself as a sandbox.

### The price of no isolation is paid explicitly in `utils/globals.ts`. `shareGlobal(key, callees, timeout)` replaces `window[key]` with a getter that calls `new Error()` and regex-matches the resulting `.stack` against registered callee names to decide which app's value to return; `MonacoEditor` uses it for the AMD `define` global with a 2.5 s window (`shareGlobal("define", "MonacoEditor", 2.5 * MILLISECONDS_IN_SECOND)`). `cleanUpGlobals(globals)` `delete`s a hand-maintained list of global names after JSDOS (`["__core-js_shared__", "compiled", "core", "emulatorsUi", "exports", "WDOSBOX", "worker"]`) and DX-Ball close.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/utils/globals.ts
- Confidence: verified
- Why it matters: This is the most decision-relevant artifact in the repo: stack-sniffing to route a global is what "no process boundary" actually costs once you have 30 third-party runtimes. One realm per foreign runtime removes this entire file.

### Program loading is script-tag injection, not a loader: `loadFiles(libs)` sequentially calls `loadScript`/`loadStyle`, which create `<script src>` / `<link rel=stylesheet>` in `contentWindow.document.head` (defaulting to the top window), dedupe by matching an existing `document.scripts` src, and resolve on `load`. Nothing is removed when the process closes.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/utils/functions.ts
- Confidence: verified
- Why it matters: "Launching" an app leaks its code and globals into the document for the lifetime of the page. Any teardown story (close, kill, restart) has to live somewhere other than the DOM, which is exactly what a realm or worker gives you.

### The filesystem is BrowserFS, configured once as `MountableFileSystem` with `"/"` = `OverlayFS{ readable: HTTPRequest(index: fs9pToBfs()), writable: IndexedDB }`, falling back to `InMemory` as the writable layer when IndexedDB is unavailable (`FileSystemConfig(writeToMemory)`); `supportsIndexedDB()` decides.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/contexts/fileSystem/FileSystemConfig.ts
- Confidence: verified
- Why it matters: Read-only HTTP base tree + copy-on-write IndexedDB overlay is the cheapest credible POSIX-ish VFS on the web: shipping content costs nothing at runtime, user writes are small deltas, and reset = drop one IndexedDB database.

### The read-only base tree is a build artifact, not a runtime crawl: `yarn build:fs:public` runs `scripts/fs2json.js` to emit `public/.index/fs.9p.json`, which `contexts/fileSystem/core.ts` imports as a static JSON module (`import index from "public/.index/fs.9p.json"`). The v4 format is `[name, mtime, size, children|target]`; `fs9pToBfs()` flattens it for BrowserFS's HTTPRequest backend, and `get9pSize`/`get9pModifiedTime` serve `stat()` from it with a memo cache when the backend returns size -1.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/contexts/fileSystem/core.ts
- Confidence: verified
- Why it matters: stat metadata for the whole shipped tree is compiled into the bundle, so directory listings and file sizes need zero round-trips — but the index is bundle weight and the tree is immutable per deploy.

### Apps do not import the FS library; they call `useFileSystemActions()` (26 files under components/apps do). That hook exposes a promise-wrapped POSIX-ish surface — `exists, lstat, stat, readdir, readFile, writeFile, mkdir, rename, rmdir, unlink` plus `createPath, deletePath, mkdirRecursive, mapFs, unMapFs, mountFs, unMountFs, mountEmscriptenFs, mountHttpRequestFs, addFsWatcher, updateFolder, copyEntries/moveEntries` — over BrowserFS. Only `components/apps/Terminal/processGit.ts` and `utils/search.ts` touch browserfs directly. There is no path scoping, no per-app capability, and no permission check anywhere in the surface.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/contexts/fileSystem/useFileSystemContextState.ts
- Confidence: verified
- Why it matters: Indirection without a boundary: the API shape is already syscall-like and could be dropped onto a MessagePort unchanged, which is the cheapest path from "ambient hook" to "real syscall". But as written any component can write any path, so there is nothing to restrict a hostile or buggy app to.

### Five mount sources are wired into the one VFS: `.zip`/`.iso` files mounted as directories via BrowserFS `ZipFS`/`IsoFS` (`mountFs`, `MOUNTABLE_EXTENSIONS`); host directories via the File System Access API (`window.showDirectoryPicker({mode:"readwrite", startIn:"desktop"})`, handles persisted in an `idb` keyval store under `FS_HANDLES` and re-permissioned with `handle.requestPermission()`); OPFS via `navigator.storage.getDirectory()` for the reserved path `/OPFS`; remote 9p indexes via `mountHttpRequestFs(mountPoint, url)`; and a guest emulator's Emscripten FS via `mountEmscriptenFs(FS)`.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/contexts/fileSystem/useFileSystemContextState.ts
- Confidence: verified
- Why it matters: One mount table absorbing archives, host dirs, OPFS, remote trees and guest runtimes is the strongest architectural idea in the project, and it is the thing that makes the shell feel like an OS rather than a file picker.

### Emulator FS bridging is generic and two-way-visible: `useEmscriptenMount` wraps `mountEmscriptenFs`, mounting the guest's Emscripten `FS` at `/<name>` in the host VFS (name defaults to the Emscripten IDB db+store name, else `JSDOS_<bundle>` / `EmulatorJs_<game>`), calls `updateFolder("/", name)` so the UI shows it, and unmounts on unmount via `unMapFs(path, true)`.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/components/system/Files/FileManager/useEmscriptenMount.ts
- Confidence: verified
- Why it matters: This is the closest thing in the reference set to a foreign runtime participating in the host filesystem. It is ~40 lines and reusable for any Emscripten-based guest, which is most of the emulator ecosystem.

### v86 is a bespoke window component, not a process abstraction: `useV86` injects `/Program Files/Virtual x86/*` scripts via `libs`, reads the picked disk image out of the VFS into a blob URL, sizes RAM from `navigator.deviceMemory` (`min(deviceMemory||0.25, 8) * 128MB`, VGA `* 8MB`), news up the global `window.V86Starter`, and crucially hands the guest the host's 9p index as its filesystem: `filesystem = { basefs: blob(JSON.stringify(fs9pV4ToV3())), baseurl: window.location.origin }`. On close it calls `save_state()`, screenshots the canvas (or `html-to-image` in text mode) and writes `<image>.bin.save` into the VFS via `createSnapshot`. Keyboard focus is multiplexed by hand: `keyboard_set_status(foregroundId === id && !minimized)`.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/components/apps/V86/useV86.ts
- Confidence: verified
- Why it matters: The guest Linux and the web OS share one file tree because the same build-time 9p index serves both (v4 is converted to v86's v3 shape by `fs9pV4ToV3`). That is a real integration, and it is also why the index format is load-bearing rather than incidental.

### The three emulator integrations use three different host mechanisms, all hand-written per app. js-dos runs DOSBox in a worker (`dosOptions = { emulatorFunction: "dosWorker" }`) and detects guest exit by string-matching emulator log messages (`eventType.startsWith("[LOG_EXEC]")` then checking the parsed command is `EXIT`) to call `closeWithTransition(id)`. EmulatorJS is configured by assigning `EJS_*` globals onto the iframe's `contentWindow`, with `withWindowConstructor` reassigning each callback's `.constructor` to the iframe's `Function` so cross-realm checks pass. Ruffle is appended straight into the main document (`window.RufflePlayer.newest().createPlayer()`, `allowScriptAccess: false`) with no iframe at all.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/components/apps/JSDOS/useJSDOS.ts
- Confidence: verified
- Why it matters: There is no "foreign runtime" contract to reuse — each guest gets bespoke lifecycle, exit detection and save-state code. A web OS that intends to host several runtimes should define that contract once (spawn, stdin/out, exit code, snapshot) rather than per emulator.

### File association is a static table plus an ordered candidate list: `components/system/Files/FileEntry/extensions.ts` maps each extension to `{ process: string[], icon?, type?, command? }` (e.g. `.iso` -> `["V86"]`, ROM extensions -> `["Emulator"]`, `.swf` -> `["Ruffle"]`, markdown -> Marked + text editors); `getProcessByFileExtension` returns the first entry and the rest populate Open With. Shortcuts are literal Windows `.url` INI files parsed and written with the `ini` package, where `BaseURL` holds the pid, `URL` the target and `IconFile` the icon (`getShortcutInfo` / `createShortcut`).

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/components/system/Files/FileEntry/extensions.ts
- Confidence: verified
- Why it matters: Associations as data (extension -> ordered pid list) and shortcuts as real files in the VFS are both cheap, and both are why the desktop behaves like a shell rather than a launcher. The `.url` choice means shortcuts survive export/import and are user-editable text.

### Host-OS integration rests on four standard APIs, each used directly: drag-in via `dataTransfer.items` + `item.webkitGetAsEntry()` (with an internal `application/json` payload for intra-OS drags); paste-in via a document-level `paste` listener reading `event.clipboardData.files` gated on `foregroundId`; copy-out via `navigator.clipboard.write([new ClipboardItem({...})])`, with `image/jpeg` rewritten to `image/png` because Chromium refuses jpeg writes; and host directory mapping via File System Access handles persisted in IndexedDB.

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/DataTransferItem/webkitGetAsEntry
- Confidence: verified
- Why it matters: The OS feeling comes from host-boundary crossings, not from the Aero chrome. All four are main-thread, document-level APIs, so whatever isolation model you choose must leave a path for the shell to receive a drop/paste and hand the bytes to an isolated app.

### Session state lives in the VFS, not in localStorage: it is written to `/session.json` (`SESSION_FILE`) inside BrowserFS on an idle callback and read back on boot, with `public/session.json` (`{}` in the repo) as the shipped default. `SessionData` persists `windowStates` (per-pid position/size/maximized/columns), `iconPositions`, `sortOrders`, `views`, `themeName`, `wallpaperImage`/`wallpaperFit`, `cursor`, `closeEffect`, `clockSource`, `recentFiles`, `runHistory`, `aiEnabled` — and NOT the set of running processes.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/contexts/session/types.ts
- Confidence: verified
- Why it matters: Window geometry keyed by pid is what makes reopening an app feel like restoring it, and putting session in the VFS means it is exportable/resettable like any file. But there is no session restore of processes: reload gives an empty desktop, so daedalOS has no answer for "my work was open".

### There is no scheduler and no suspension. Minimizing keeps the component mounted and running; `Window` only sets `aria-hidden`/`inert` and runs a motion transition toward the taskbar entry, and `AppsLoader` keeps rendering every non-closing process. Backgrounded apps keep their timers, workers and emulators live, throttled only by the browser.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/components/system/Window/index.tsx
- Confidence: verified
- Why it matters: "Backgroundable" in daedalOS means "still running, just invisible". Real backgrounding (freeze, deprioritize, evict and restore from state) needs the state to be addressable outside the component, which this model forbids.

### IPC is mutation of the shared process record. Apps publish function handles into their own process entry via `argument(id, "play", fn)` / `argument(id, "pause", fn)` and flags like `paused`, `muted`; the taskbar's `PeekWindow` reads `const { minimized, pause, paused, play, title } = useProcess(id)` and calls them. There is no `SharedWorker`, `MessageChannel`, `BroadcastChannel`, `navigator.locks` or signal mechanism anywhere in components/contexts/hooks/utils.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/contexts/process/useProcessContextState.ts
- Confidence: verified
- Why it matters: Storing live closures and DOM elements (`componentWindow`, `peekElement`, `taskbarEntry`) in the process table is why taskbar thumbnails and media controls work — and why the table can never be serialized, moved across a realm, or restored. It is the exact coupling that blocks a kernel boundary later.

### The shell is a 1325-line React hook with one `switch` over ~81 `case` labels (`useCommandInterpreter`), running every builtin in the host realm with direct access to `useFileSystemActions`, `useProcessesActions`, `processDirectory` and `rootFs`. Foreign runtimes are embedded inside that same component: WASI binaries via `wasi-js` (`loadWapm.ts`, browser bindings, `lowerI64Imports`), JavaScript via `quickjs-emscripten` (`js.ts`), plus Python and `isomorphic-git`.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/components/apps/Terminal/useCommandInterpreter.ts
- Confidence: verified
- Why it matters: Commands are not processes: you cannot pipe, background, or kill them, and `ps` cannot see them. If the shell is meant to be the user-facing proof that a runtime exists, it has to spawn through the same mechanism apps do.

### Licence is MIT (`LICENSE`, "Copyright (c) 2025 Dustin Brett"; `"license": "MIT"` in package.json). Framework coupling is deep: React 19.3 + Next 16.3 with `output: "export"` and `reactCompiler: true`, styled-components 6.5 for all chrome, `react-rnd` for window drag/resize, `motion` for transitions, and ~62k lines of TS/TSX across components/contexts/hooks/utils/pages/styles.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/package.json
- Confidence: verified
- Why it matters: MIT means the registry shape, the FS config, the Emscripten mount and the 9p index script can all be lifted with attribution. But the process model is not portable: it is React component identity, so "port daedalOS's kernel" is not a thing you can do — there is nothing under the components to port.

### Initial JS on the deployed site is ~361 KB gzipped / ~1.11 MB uncompressed across 8 deferred scripts; the `pages/_app` chunk alone is 202 KB gz / 625 KB raw, framework 68.8 KB gz, main 39.1 KB gz, index 15.1 KB gz. Measured 2026-11-11 with `curl -w %{size_download}` over the script tags of https://dustinbrett.com/ (build id 8DffDkjdfxdUuU1StcN1x); per-app code and all emulator payloads load lazily afterwards via `dynamic(import)` and the `libs` URLs.

- Evidence: https://dustinbrett.com/_next/static/chunks/pages/_app-435a5960a887a34a.js
- Confidence: verified
- Why it matters: A full desktop shell with 33 apps boots on ~360 KB gz because everything heavy is behind the registry's `libs`/`dynamic`. The lazy-load discipline, not the framework choice, is what keeps it viable.

### Shipped payload in the repo is 306 MB under `public/`, of which 244 MB is `public/Program Files` (emulator cores, BIOSes, wasm, game data) and 62 MB `public/System`; the BrowserFS runtime itself is two checked-in minified bundles, `public/System/BrowserFS/browserfs.min.js` (110 KB) and `extrafs.min.js` (124 KB, containing the FileSystemAccess, Emscripten, IsoFS and ZipFS backends). `vendor/browserfs.tgz` is a 34 KB types-only package (`browserfs` 2.0.0, MIT) carrying just `.d.ts` files.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/public/CREDITS.md
- Confidence: verified
- Why it matters: The OS-ness is mostly content, not code: a static tree of real binaries addressable by path is what makes the file manager worth having. Plan for hosting hundreds of MB of static assets, and for the FS layer being a vendored prebuilt blob you cannot easily patch.

### `next.config.js` declares `headers()` returning `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`, but the project also sets `output: "export"`, and Next.js documents Headers as unsupported for static exports. The live site accordingly sends no COOP/COEP; it sends `document-isolation-policy: isolate-and-credentialless` instead (verified with `curl -sSI https://dustinbrett.com/` on 2026-11-11). Cross-origin isolation is load-bearing: `supportsThreadedStockfish()` gates multi-threaded Stockfish on `typeof SharedArrayBuffer !== "undefined" && window.crossOriginIsolated`.

- Evidence: https://nextjs.org/docs/app/guides/static-exports
- Confidence: verified
- Why it matters: Two lessons: config-as-documentation can be dead config (the COOP/COEP block in the repo does nothing), and cross-origin isolation for a static-exported web OS must be arranged at the edge — here via the newer Document-Isolation-Policy header rather than COOP+COEP.

### There is no PWA integration at all: no web app manifest and no service worker exist in the repo or the deployment (no `manifest.json`/`.webmanifest` under `public/`, no `rel=manifest` in the served HTML, no `serviceWorker` reference in source; `https://dustinbrett.com/manifest.json` and `/sw.js` both return 404, checked 2026-11-11). Consequently there are no PWA file handlers, no `launchQueue`, no protocol handlers, and no offline boot. Opening a file from outside is instead done with query params: `hooks/useUrlLoader.ts` resolves `?app=<name>` against the process directory (case-insensitive, dialog processes excluded) and `?url=<path>` through `stat`/extension association, with special cases for YouTube and http(s) URLs.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/hooks/useUrlLoader.ts
- Confidence: verified
- Why it matters: The most-cited "web OS" demo does not register itself with the host OS at all. If you want double-clicking a file on Windows to open your web OS, that is unexplored ground here and you will be writing the manifest `file_handlers` + `launchQueue` path yourself.

### Wallpapers are the one subsystem that genuinely runs off the main thread: `useWallpaper` checks `hasOffscreenCanvasSupport()`, transfers an `OffscreenCanvas` to a per-wallpaper dedicated worker (`Galaxy/wallpaper.worker.ts`, `hexells`, `vantaWaves`, `ShaderToy/CoastalLandscape`) and posts desktop rects on resize. The same pattern is used for the clock (`Clock/clock.worker.ts`), the AI chat (`AI/ai.worker.ts` with `@mlc-ai/web-llm`) and the Stockfish engine.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/components/system/Desktop/Wallpapers/useWallpaper.ts
- Confidence: verified
- Why it matters: The project already knows how to run work in a worker with a transferred canvas — it just never applies it to apps. That is the proof-of-concept for a worker-hosted app with an OffscreenCanvas surface, which is the obvious route to a real process boundary for graphical apps.

### There is no permissions or accounts model. The only `requestPermission` in the tree is `FileSystemHandle.requestPermission()` for host directory handles; there is no app-level capability, no per-path policy, no notion of a user other than the `/Users/<name>` directory layout, and `resetStorage` (plus `resetStorageAndReload`) wipes the whole writable layer and a hardcoded `KNOWN_IDB_DBS` list of emulator databases.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/contexts/fileSystem/functions.ts
- Confidence: verified
- Why it matters: Every app has root. That is tolerable when all 33 apps are first-party and vendored; it is the first thing that breaks if third parties can ship apps, and it cannot be bolted on without the boundary that does not exist.

## Reusable

- The declarative process registry shape — `contexts/process/directory.ts`: one static object, pid -> `{ Component/entrypoint, defaultSize, singleton, lockAspectRatio, libs, dependantLibs, icon, title, hasWindow, dialogProcess }`. Copy the shape and swap `Component` for a worker/iframe entrypoint. MIT.
- The VFS configuration — `OverlayFS{ readable: HTTPRequest(buildTimeIndex), writable: IndexedDB }` under a `MountableFileSystem`, with `InMemory` as the fallback writable layer. ~20 lines in `contexts/fileSystem/FileSystemConfig.ts`. MIT (BrowserFS itself MIT, jvilk/BrowserFS).
- The 9p index pipeline — `scripts/fs2json.js` -> `public/.index/fs.9p.json` (v4 tuples `[name, mtime, size, children|target]`), plus `fs9pToBfs()` for BrowserFS and `fs9pV4ToV3()` for v86. One artifact serves the host VFS's stat/listing and a guest Linux's 9p root. MIT.
- `useEmscriptenMount` + `mountEmscriptenFs` — mount any Emscripten guest's `FS` into the host VFS at `/<name>` and unmount on teardown, ~40 lines total across `components/system/Files/FileManager/useEmscriptenMount.ts` and `contexts/fileSystem/useFileSystemContextState.ts`. MIT. Works for js-dos, EmulatorJS and anything else Emscripten-based.
- The promise-wrapped `AsyncFS` surface in `contexts/fileSystem/useAsyncFs.ts` — callback BrowserFS normalized to `exists/lstat/stat/readdir/readFile/writeFile/mkdir/rename/rmdir/unlink`, including the pre-init call queue (`mockFsCallQueue`) so early callers do not need to await boot. It is already the right shape to put behind a MessagePort. MIT.
- `contexts/contextActionSelectorFactory.tsx` — a `useSyncExternalStore` selector store with a stable actions context and a non-subscribing `getCurrentState()` for event handlers. This is why a 33-app desktop in one React tree does not re-render on every process mutation. MIT.
- Windows `.url` INI files as shortcuts, with `BaseURL` = pid, `URL` = target, `IconFile` = icon, read/written with the `ini` package (`getShortcutInfo` / `createShortcut` in `components/system/Files/FileEntry/functions.ts`). User-editable, exportable, and it is why right-click > Create shortcut feels native. MIT.
- The association table pattern — extension -> ordered list of candidate pids, first wins, rest become Open With (`components/system/Files/FileEntry/extensions.ts` + `getProcessByFileExtension`). Adding a file type is adding data. MIT.
- `?app=<name>&url=<path>` deep linking resolved against the registry and the association table (`hooks/useUrlLoader.ts`) — the whole external-launch story in ~70 lines, and the fallback worth having whether or not you later add PWA `file_handlers`. MIT.
- The OffscreenCanvas-to-worker pattern already proven in `components/system/Desktop/Wallpapers/useWallpaper.ts` (transfer canvas control, post resize rects). This is the existing in-repo template for hosting a graphical app off the main thread. MIT.
- Per-app `ErrorBoundary` + `ComponentError` fallback in `components/system/Apps/RenderComponent.tsx` — cheap crash containment that keeps the desktop alive. Use it in addition to a real boundary, not instead of one. MIT.
- `Document-Isolation-Policy: isolate-and-credentialless` as the way to get `crossOriginIsolated` (and therefore `SharedArrayBuffer`, threaded wasm) on a static-hosted site without COOP+COEP breaking embeds. Spec: https://wicg.github.io/document-isolation-policy/ .

## Gotchas

- The iframe in `useIsolatedContentWindow` has no `sandbox` attribute and is same-origin, created via `document.write`. It looks like a sandbox in diagrams and is not one: the child can reach `parent` and the host's globals. It buys a clean global namespace for Emscripten/EJS apps, nothing more.
- `useFileSystemActions()` looks like a syscall layer and is not one. It is a React context with no caller identity, no path scoping and no permission check, so "apps go through an API" is true in form and false in effect — any component, including a buggy third-party one, can `writeFile` anywhere.
- The COOP/COEP `headers()` block in next.config.js is dead config: Next.js lists Headers as unsupported under `output: "export"` (https://nextjs.org/docs/app/guides/static-exports). Reading the repo would tell you the site is COOP/COEP isolated; it is actually isolated by an edge-set `document-isolation-policy` header. Do not infer runtime headers from a static-export Next config.
- Minimize is `inert` + a motion transition, not suspension. Ten minimized apps are ten running apps. Any plan that counts on minimized windows being cheap is wrong here.
- Session restore does not restore processes. `SessionData` has `windowStates` keyed by pid but no process list, so reload gives an empty desktop with remembered geometry. The feeling of persistence comes from the VFS and icon positions, not from resuming work.
- The process table stores live closures and DOM nodes (`play`, `pause`, `componentWindow`, `peekElement`, `taskbarEntry`). That is what makes taskbar peek and media controls work, and it permanently prevents serializing, migrating or restoring the table. Decide early whether your process record is data.
- `shareGlobal` resolves global collisions by regex-matching `new Error().stack` with a 2.5 s timeout. It works today and is unfixable in general — it is a direct consequence of one realm, and it is the signal that the single-realm approach has run out.
- js-dos exit is detected by string-matching DOSBox log lines for `[LOG_EXEC]` and `EXIT`. There is no exit-code channel from any guest; every emulator's lifecycle is bespoke screen-scraping or library callbacks.
- The runtime filesystem is a checked-in minified build (`public/System/BrowserFS/*.min.js`) whose source is not in the repo and whose `FileSystemAccess` backend does not exist upstream in jvilk/BrowserFS (v1.4.3 has HTML5FS and Emscripten, no FileSystemAccess). Depending on it means depending on an unversioned binary you cannot rebuild from this repository.
- The read-only base tree is compiled into the bundle as `public/.index/fs.9p.json` at build time. Content is immutable per deploy, and the stat index is bundle weight that grows with the shipped tree.

## Could not determine

- The provenance of the BrowserFS build actually shipped at `public/System/BrowserFS/browserfs.min.js` and `extrafs.min.js`. The source is not in the daedalOS repo, `vendor/browserfs.tgz` contains only `.d.ts` files (browserfs 2.0.0, MIT), upstream jvilk/BrowserFS v1.4.3 has no `FileSystemAccess` backend, and `https://raw.githubusercontent.com/DustinBrett/BrowserFS/master/src/backend/FileSystemAccess.ts` returns 404. I could not locate the fork or confirm the licence terms of the modifications in that build (upstream BrowserFS is MIT; the modifications are unverified).
- Whether the commit I read (ed9c7a54cc50a6e9125333743164830ad56779a5, 2026-10-21) is the commit deployed at dustinbrett.com. The live build id is 8DffDkjdfxdUuU1StcN1x with `last-modified: Thu, 22 Oct 2026`, which is consistent but not proof, so the bundle-size numbers and the header observation describe the deployment, not necessarily this tree.
- Runtime memory and CPU cost per app, and whether any browser-level throttling meaningfully reduces the cost of a minimized app. I read the code and did not run the desktop, so "minimized apps keep running" is verified from source but unmeasured in practice.
- Which of the 33 registry entries actually work on a given browser. `browserslist` targets Chrome/Edge >= 80, Firefox >= 74, Safari >= 13.1, but several mechanisms (File System Access `showDirectoryPicker`, OPFS, `crossOriginIsolated`+SharedArrayBuffer, `navigator.deviceMemory`) are Chromium-only or Chromium-first, and I did not test any browser.
- Exact gzipped weight of the lazily-loaded per-app chunks and of the `/Program Files` payload each emulator pulls at launch. I measured only the 8 eagerly deferred scripts; per-app cost would require launching each app against the live site.
- Whether the `e2e/` Playwright suite or `__tests__/` Jest suite assert anything about process lifecycle or filesystem isolation. I listed the files (accessibility, focus, index, keyboard specs) but did not read or run them.

