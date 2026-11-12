# OS.js (v3) architecture, read from source at pinned revisions: OS.js 0aa8744 (v3.1.12), @osjs/client 12717e2 (v3.10.0), @osjs/server f77358e (v3.4.3), @osjs/common 45d60ea, @osjs/cli 87bc49a, @osjs/panels da3e669

## Summary

OS.js has no kernel. It has a dependency-injection container (`CoreBase` + `providerHandler`) and a strong naming discipline: everything is reached by string service name through `core.make('osjs/vfs')`, never by import. That single convention is what makes it feel OS-shaped, and it is the one thing worth copying outright.

Everything below that is cooperative. Apps are `<script>` tags injected into the host document; they receive the real `Core` instance as argument 1 of their register callback, so the `providers.globalBlacklist` on `window.OSjs` is decorative. `Application` hard-imports `Window`, so the window primitive cannot be swapped through the registry even though the panel/taskbar shell can. Auth is a door gate: the Express session is checked once per HTTP route, the VFS router re-checks group ACLs per call, but app code and the whole package catalogue are served by `express.static` to anonymous clients, and the WebSocket `verifyClient` always returns true.

The server is load-bearing. `standalone: true` hard-rejects every `core.request`, which kills the only shipped read/write VFS adapter. Licence: BSD-2-Clause.

## Findings

### There is no kernel. The 'kernel' is a ~160-line DI container: `CoreBase` (boot/start/destroy/config/register/make/has) plus `providerHandler`, which holds `providers` (registered classes) and `registry` (named factories, singleton or per-call). `make(name)` throws `Provider '<name>' not found` on a miss. Boot is two passes over an `async-dependency-graph`: `init` for all, then `start` for all.

- Evidence: https://github.com/os-js/osjs-common/blob/45d60ea1fdd8dba765a1e74bc861e1ff741c8d33/src/utils.js#L54-L160
- Confidence: verified
- Why it matters: The entire 'OS feeling' of OS.js comes from one rule: no module imports another module's capability, it asks the container for a string name. That is cheap to implement and it is exactly the boundary webxp lacked. You do not need processes to get isolation of *reference*; you need a registry and a ban on direct imports.

### The provider lifecycle contract is exactly four methods, all optional, all duck-typed: `provides(): string[]`, `depends(): string[]`, `init()`, `start()`, `destroy()`. `register(Class, {before, args, depends})` constructs immediately; `{before: true}` puts the provider in an earlier of two boot waves. Nothing enforces that a provider actually registers what `provides()` claims.

- Evidence: https://github.com/os-js/osjs-common/blob/45d60ea1fdd8dba765a1e74bc861e1ff741c8d33/src/service-provider.js#L38-L85
- Confidence: verified
- Why it matters: A duck-typed contract means a third party can write a provider with no dependency on your base class (`@osjs/panels` does exactly this). Cheap extensibility. The cost is that `provides()` is an unchecked declaration — see the window-behavior typo finding.

### The dependency graph adds at most ONE edge per provider. `dependsOnIndex` uses `findIndex`, so a provider declaring `depends() => ['a','b','c']` is ordered only after the first provider that supplies any one of them; the other two are unordered. Both graph traversals and provider `destroy()` swallow errors into `console.warn`.

- Evidence: https://github.com/os-js/osjs-common/blob/45d60ea1fdd8dba765a1e74bc861e1ff741c8d33/src/utils.js#L59-L99
- Confidence: verified
- Why it matters: A boot ordering bug in a web OS presents as a random `Provider 'osjs/x' not found` on a cold load and nothing in the log but a warn. If you build a provider graph, emit one edge per declared dependency and let boot failures reject, not warn.

### A client app NEVER calls the Node server directly — it calls `core.make('osjs/vfs')`, which is a proxy over every exported method of `src/vfs.js`. `Filesystem._requestAction` resolves the `name:` prefix of the path to a mountpoint and dispatches to that mountpoint's adapter. Whether a call crosses to Node is an adapter property, not an app property.

- Evidence: https://github.com/os-js/osjs-client/blob/12717e22f2a6c8ea2021afc302a91dd2c66f25cb/src/filesystem.js#L146-L155
- Confidence: verified
- Why it matters: This is the second thing worth copying. Path prefix -> mountpoint -> adapter means the transport is swappable per mount without touching a single app. It is how you get a static deploy later without rewriting apps.

### Three client VFS adapters ship: `system` (HTTP to Node), `apps` (read-only, client-local, lists installed packages from `osjs/packages`), and `null` (resolves everything empty/false, used as the method floor under every adapter). `system` GETs `capabilities|exists|stat|readdir|readfile` and POSTs the mutators; `writefile` is `multipart/form-data` with fields `upload`, `path`, `options`.

- Evidence: https://github.com/os-js/osjs-client/blob/12717e22f2a6c8ea2021afc302a91dd2c66f25cb/src/adapters/vfs/system.js#L31-L113
- Confidence: verified
- Why it matters: `null` as a spread base is a neat trick: every adapter is automatically total, so a partial adapter (like `apps`, which implements only `readdir`) never throws `undefined is not a function`. Copy that.

### Mountpoints are declared TWICE, in two separate config files, and hand-matched by name. Client `vfs.mountpoints` declares `apps`/`osjs`/`home` with `adapter` names; server `vfs.mountpoints` declares `osjs`/`home` with `attributes.root` path templates (`{root}/dist`, `{vfs}/{username}`). The server resolves `{username}` from `req.session.user.username` at call time.

- Evidence: https://github.com/os-js/osjs-server/blob/f77358e6a3bef87c49483ba9260649e2f49ca77a/src/config.js#L116-L131
- Confidence: verified
- Why it matters: Two sources of truth for the mount table. Add a mount and forget the other file and you get a client-side `ERR_VFS_MOUNT_NOT_FOUND_FOR` or a server-side 403 `Mountpoint not found`. If you build this, declare the table once and derive.

### The server VFS router does check per call, twice over. `router.use(isAuthenticated(vfsGroups))` gates the whole `/vfs` router on `req.session.user`, then every single request runs `checkMountpointPermission(req, res, method, readOnly, strict)` against `mountpoint.attributes.groups`, which supports both flat group lists and per-method maps (`{readfile: ['users'], writefile: ['admin']}`), with `every`/`some` selected by `strictGroups`. Cross-mount copy/rename checks source as `readfile` and destination as `writefile` separately.

- Evidence: https://github.com/os-js/osjs-server/blob/f77358e6a3bef87c49483ba9260649e2f49ca77a/src/utils/vfs.js#L105-L144
- Confidence: verified
- Why it matters: This is the one genuinely per-call authorization in OS.js, and it is modelled correctly: the check is keyed on (user groups, VFS method, mountpoint), evaluated at the server, after path sanitization. Verified live: GET https://demo.os-js.org/vfs/readdir?path=home:/ returns 403 unauthenticated (probed 2026-11-11).

### A package is a directory with `package.json` containing `{"osjs": {"type": "package"}}` plus a sibling `metadata.json`. `osjs-cli package:discover` globs `**/package.json` (depth 3) across the configured discovery roots, filters on that marker, reads each `metadata.json`, symlinks (or copies) each package's `dist/` into `dist/apps/<Name>`, and writes two files: `packages.json` (paths, server-side) and `dist/metadata.json` (the manifest, client-side).

- Evidence: https://github.com/os-js/osjs-cli/blob/87bc49a476c5569a6801661eebbaa9f00bf2a658/src/utils.js#L37-L57
- Confidence: verified
- Why it matters: Discovery is a build step producing a static manifest, not a runtime scan. That is why a static deploy is even partly possible, and it is the right split: the catalogue is data, the loader is code.

### Apps get NO realm. `Packages._launch` resolves `metadata.files` to URLs and hands them to `Preloader`, which creates `document.createElement('script')` and appends to `core.$resourceRoot` (defaults to `document.head`). The app bundle declares webpack `externals: {osjs: 'OSjs'}` and calls `osjs.register(name, registerFn)` on the shared global. The 'iframe application' example is not isolation — the app code runs in the host realm and merely appends an `<iframe>` into its window's content div.

- Evidence: https://github.com/os-js/osjs-client/blob/12717e22f2a6c8ea2021afc302a91dd2c66f25cb/src/utils/preloader.js#L88-L97
- Confidence: verified
- Why it matters: OS.js solved reference isolation (no direct imports) but not execution isolation. Any app can read any other app's DOM, patch any prototype, and hold the main thread. If you want killable and backgroundable for real, the realm decision (iframe or Worker per process) is yours to make and OS.js gives you no precedent for it.

### The capability denylist on the global is bypassable in one line. `window.OSjs` is `Object.freeze`d and its `make` enforces `providers.globalBlacklist` (default `['osjs/websocket','osjs/clipboard','osjs/gapi']`) / `globalWhitelist`. But `Packages._launch` invokes the app's register callback as `found.callback(this.core, args, options, found.metadata)` — argument 1 is the raw `Core`. `core.make('osjs/websocket')` from inside any app is unfiltered.

- Evidence: https://github.com/os-js/osjs-client/blob/12717e22f2a6c8ea2021afc302a91dd2c66f25cb/src/packages.js#L318
- Confidence: verified
- Why it matters: A capability gate that hands the ungated object to every caller is theatre. If you want per-app capabilities, the app must receive a *per-app facade* built from its manifest, never the container. This is the single clearest 'learn it here, not the hard way' lesson in the codebase.

### A 'process' is an `Application` instance with a monotonic `pid` from a module-level counter, a `started` Date, and arrays of `windows`, `sockets`, `workers`. `destroy()` is genuinely a kill: it destroys every window, closes every socket, and calls `worker.terminate()` on every worker created via `proc.worker(filename)`. Nothing reclaims listeners the app registered on `core` — apps must pair `core.on(...)` with `proc.on('destroy', () => core.off(...))` by hand.

- Evidence: https://github.com/os-js/osjs-client/blob/12717e22f2a6c8ea2021afc302a91dd2c66f25cb/src/application.js#L192-L222
- Confidence: verified
- Why it matters: `proc.worker()` is the real find: OS.js already tracks Web Workers per process and terminates them on kill. That is a working, shipped backgroundable-and-killable primitive. The leak (untracked core listeners) is the cost of not giving each app a scoped event bus — give apps a per-process emitter facade instead.

### Session restore is relaunch-by-name, not state capture. `Session.save()` stores `[{name, args, windows:[{id, position, dimension, minimized, maximized}]}]` into the `osjs/session` settings key; `load()` calls `core.run(name, args, {restore: {windows}})` for each.

- Evidence: https://github.com/os-js/osjs-client/blob/12717e22f2a6c8ea2021afc302a91dd2c66f25cb/src/session.js#L53-L100
- Confidence: verified
- Why it matters: Honest scoping: process identity is a counter, persistence is 'launch args + window geometry'. Do not promise suspend/resume of live process state. Promise deterministic relaunch, and make apps responsible for serializing their own document into the VFS.

### The shell is userland; the window primitive is not. `@osjs/panels` is a separate BSD-2-Clause package whose provider does not even extend `ServiceProvider`, registers `osjs/panels` with `{register, create, remove, removeAll, save, get}`, and is replaceable by not registering it. But `Application.createWindow` does `new Window(this.core, ...)` against a hard `import Window from './window'`, so the `osjs/window` service name cannot be substituted. Only the chrome markup (`options.template`, `config('windows.template')`) and the drag/resize/focus logic (`CoreServiceProvider` `{windowBehavior}` option) are pluggable.

- Evidence: https://github.com/os-js/osjs-client/blob/12717e22f2a6c8ea2021afc302a91dd2c66f25cb/src/application.js#L339
- Confidence: verified
- Why it matters: This is the exact seam to get right for a Windows 7 / Aero target. Aero needs its own window chrome, snap, shadow and stacking model. In OS.js you can replace the HTML template and the drag behaviour but not the window state machine or z-index ownership. Make `Window` reachable only through the registry from day one.

### `Desktop.applySettings` hard-codes the service names `osjs/panels` and `osjs/widgets` and drives them with `instance.removeAll()` then `instance.create(item)` per saved item. A replacement shell must register under those exact names to be configurable from the settings tree. It also truncates to one panel: `(newSettings.panels || []).slice(-1)` with a `// TODO: Multiple panels` comment.

- Evidence: https://github.com/os-js/osjs-client/blob/12717e22f2a6c8ea2021afc302a91dd2c66f25cb/src/desktop.js#L527-L548
- Confidence: verified
- Why it matters: The extension point exists but the contract is implicit — a string name and two method names, documented nowhere but this call site. If you do replaceable shell surfaces, make the contract an interface the registry validates at register time.

### Identity is a gate at the door, and the door is only on the HTTP routes. `isAuthenticated` checks `req.session.user` plus optional groups, and is applied via `routeAuthenticated`/`routerAuthenticated` and `router.use(isAuthenticated(vfsGroups))`. It is NOT applied to the WebSocket: `createWebsocket`'s `verifyClient` parses the session then unconditionally calls `done(true)`, and `app.ws('/')` has no guard. Server package handlers are then addressed by a client-supplied string: `handleMessage` destructures `{pid, name, args}` from the message and dispatches to the package whose `metadata.name` matches, with no check that the caller is authenticated or is actually running that app.

- Evidence: https://github.com/os-js/osjs-server/blob/f77358e6a3bef87c49483ba9260649e2f49ca77a/src/utils/core.js#L63-L74
- Confidence: verified
- Why it matters: Two lessons. First: every transport needs the same gate, and a WebSocket is a transport. Second: never let the client name the callee. `pid` and `name` arriving from the wire and being trusted is the same class of bug as webxp's direct imports — the boundary exists but carries no identity.

### App code and the full app catalogue are public regardless of `metadata.groups`. `app.use('/', express.static(configuration.public))` serves `dist/` (which contains `dist/apps/<Name>/main.js` and `dist/metadata.json`) with no auth middleware. The `groups`/`strictGroups`/`blacklist` filtering in `createPackageAvailabilityCheck` runs in the browser only. Probed live 2026-11-11: GET https://demo.os-js.org/metadata.json -> 200 (22 packages listed) and GET https://demo.os-js.org/apps/FileManager/main.js -> 200, both unauthenticated.

- Evidence: https://github.com/os-js/osjs-client/blob/12717e22f2a6c8ea2021afc302a91dd2c66f25cb/src/utils/packages.js#L31-L60
- Confidence: verified
- Why it matters: Per-app permissions in OS.js hide launcher entries; they do not withhold code. Treat the app manifest and bundle as public and put every real authorization at the VFS/API boundary — which, to its credit, is where OS.js put the one check that works.

### Out of the box, anyone can log in as anyone. The default server auth adapter is `null.js`: `login: async (req, res) => ({id: 0, username: req.body.username})` — any password. Combined with `vfs.mountpoints` `home` rooted at `{vfs}/{username}`, `Auth.login` then calls `createHomeDirectory` and provisions a directory for whatever name was typed. Real adapters are separate packages (`@osjs/pam-auth`, `@osjs/database-auth`, `@osjs/sqlite-auth`, `@osjs/auth0-auth`).

- Evidence: https://github.com/os-js/osjs-server/blob/f77358e6a3bef87c49483ba9260649e2f49ca77a/src/adapters/auth/null.js#L30-L36
- Confidence: verified
- Why it matters: The adapter seam is right — identity is one swappable function and the group list it returns is what the VFS ACL consumes. The default being accept-all is a deployment trap, not a design flaw, but it means every OS.js demo you look at has no security model at all.

### Settings default to localStorage, not the server. `createAdapter` picks `defaultAdapters[options.adapter || 'localStorage']`; the server adapter (`POST/GET /settings`) is opt-in. So the desktop, panels, wallpaper, keybindings and session are per-browser by default even when auth is per-user.

- Evidence: https://github.com/os-js/osjs-client/blob/12717e22f2a6c8ea2021afc302a91dd2c66f25cb/src/settings.js#L37-L57
- Confidence: verified
- Why it matters: Desirable for a static build, surprising for a multi-user one: log in as the same user in a second browser and get a different desktop. Decide which of your state is per-identity and which is per-device, and say so in the config shape.

### `standalone: true` exists and is documented, but it disables the VFS rather than replacing it. `Core.request(url, options, type, force=false)` rejects with `ERR_REQUEST_STANDALONE` unless `force` is true. Only the packages manifest fetch passes `force: true`. The `system` VFS adapter calls `core.request` without `force`, so every readdir/readfile/writefile on `home:/` and `osjs:/` rejects. `standalone` also forces the localStorage auth adapter (`login: values => Promise.resolve(values)`, accepts anything) and skips the WebSocket entirely.

- Evidence: https://github.com/os-js/osjs-client/blob/12717e22f2a6c8ea2021afc302a91dd2c66f25cb/src/core.js#L483-L507
- Confidence: verified
- Why it matters: This is the price of the design, stated precisely. A static OS.js boots, shows a desktop, and launches apps — and has no filesystem. Every OS.js package that touches files (FileManager, Textpad, Preview, Settings-wallpaper) is dead. If you want static-first, your DEFAULT VFS adapter must be browser-local (OPFS/IndexedDB) and the HTTP adapter must be the opt-in mount, i.e. the exact inverse of OS.js's choice.

### No browser-local VFS adapter exists in the OS.js organisation. The three official non-system adapters — `@osjs/webdav-adapter` (MIT), `@osjs/ftp-adapter`, `@osjs/gdrive-adapter` — are all SERVER adapters; the WebDAV one `require`s `node-fetch` and `xmldom`. Nothing in the 77 public org repos implements IndexedDB, OPFS, or localStorage storage for the VFS.

- Evidence: https://github.com/os-js/osjs-webdav-adapter/blob/f838e72b2cfc4631700002593329297f9f98326b/index.js#L30-L31
- Confidence: verified
- Why it matters: There is nothing to copy for the static path. The `FilesystemAdapterMethods` shape (16 methods, documented as a typedef) is reusable as an interface, but the implementation is yours. Budget for it as a first-class component, not an afterthought.

### A server-side package is `metadata.json`'s `server` field, resolved relative to the package dir and loaded with a bare `require(this.script)` at boot; the module's default export is called as `handler(core, pkg)` and may expose `init`, `start`, `destroy`, `onmessage`. Every handler method call is wrapped in `try/catch` that logs a warn and returns false.

- Evidence: https://github.com/os-js/osjs-server/blob/f77358e6a3bef87c49483ba9260649e2f49ca77a/src/package.js#L124-L148
- Confidence: verified
- Why it matters: Server-side app code runs in the main Node process with full `core` access and no sandbox — one package's uncaught throw in `init` is swallowed and the app silently has no backend. A 'web OS' with a real process model should not mirror this: an in-process plugin that cannot fail loudly is worse than no plugin system.

### `provides()` in `CoreServiceProvider` advertises `'osjs/window-behaviour'` (British spelling) while the singleton is actually registered as `'osjs/window-behavior'` (American), which is also the name `Window._initBehavior` resolves. No service named `osjs/window-behaviour` is ever created.

- Evidence: https://github.com/os-js/osjs-client/blob/12717e22f2a6c8ea2021afc302a91dd2c66f25cb/src/providers/core.js#L215
- Confidence: verified
- Why it matters: Concrete proof that an unvalidated `provides()` declaration rots. A third-party provider declaring `depends: ['osjs/window-behavior']` gets no ordering edge and may `init` before `CoreServiceProvider`. Validate provides/depends against the registry at boot, or make the names constants exported from one module.

### Licence: BSD 2-Clause. `LICENSE` in os-js/OS.js is a BSD 2-Clause License text, and `"license": "BSD-2-Clause"` appears in the package.json of @osjs/osjs, @osjs/client, @osjs/server, @osjs/common, @osjs/panels and @osjs/gui. GitHub's licence detector reports NOASSERTION for these repos (the per-file headers are customised), but the declared licence is unambiguous. `@osjs/webdav-adapter` is MIT.

- Evidence: https://github.com/os-js/OS.js/blob/0aa874455e1ca5a31e7be193b3be14080300c2c1/LICENSE
- Confidence: verified
- Why it matters: BSD-2-Clause: copy code freely, keep the copyright notice and disclaimer. Vendoring `providerHandler`, the `null`-adapter pattern, or the `Filesystem` mount resolver is legally cheap. Keep the notice file beside whatever you lift.

### There is no `@osjs/core` npm package and no `osjs-core` repo. `https://registry.npmjs.org/@osjs/core` returns `{"error":"Not found"}`; `api.github.com/repos/os-js/osjs-core` 301s to the repo whose `full_name` is `os-js/osjs-client`. The shared client/server base class lives in `@osjs/common` (npm latest 3.0.12).

- Evidence: https://github.com/os-js/osjs-common/blob/45d60ea1fdd8dba765a1e74bc861e1ff741c8d33/src/core.js#L41-L182
- Confidence: verified
- Why it matters: If your notes or a prior design doc reference `@osjs/core`, the thing meant is `@osjs/common` (CoreBase + ServiceProvider + providerHandler) or `@osjs/client`. Reading the wrong package wastes a pass.

## Reusable

- The `providerHandler` container itself — register/bind/make/has/destroy with singleton-vs-instance factories and two boot waves, in about 110 lines. BSD-2-Clause, https://github.com/os-js/osjs-common/blob/45d60ea1fdd8dba765a1e74bc861e1ff741c8d33/src/utils.js#L54-L160. Fix the one-edge-per-provider bug and make traversal failures reject rather than warn.
- The `null` VFS adapter spread-as-floor pattern: `{...nullAdapter, ...realAdapter}` makes every adapter total, so a partial adapter never throws. BSD-2-Clause, https://github.com/os-js/osjs-client/blob/12717e22f2a6c8ea2021afc302a91dd2c66f25cb/src/adapters/vfs/null.js
- The `FilesystemAdapterMethods` interface as a contract to implement for an OPFS/IndexedDB adapter: capabilities, readdir, readfile, writefile, copy, move, rename, mkdir, unlink, exists, stat, url, download, search, touch, mount, unmount. Documented as a typedef at https://github.com/os-js/osjs-client/blob/12717e22f2a6c8ea2021afc302a91dd2c66f25cb/src/filesystem.js#L63-L90 (BSD-2-Clause).
- The path-prefix mount resolver — `name:/path` -> mountpoint -> adapter, with cross-adapter copy/move automatically degraded to readfile-then-writefile(-then-unlink). BSD-2-Clause, https://github.com/os-js/osjs-client/blob/12717e22f2a6c8ea2021afc302a91dd2c66f25cb/src/filesystem.js#L329-L366
- The per-call VFS ACL shape: `(userGroups, method, mountpoint, strict)` with support for both flat group lists and per-method group maps, checked server-side after sanitization. BSD-2-Clause, https://github.com/os-js/osjs-server/blob/f77358e6a3bef87c49483ba9260649e2f49ca77a/src/utils/vfs.js#L76-L144. This is the one authorization design in OS.js worth lifting as-is.
- The `{root}` / `{vfs}` / `{username}` path-segment templating for mount roots, with `username` marked `dynamic: true` and resolved per session. BSD-2-Clause, https://github.com/os-js/osjs-server/blob/f77358e6a3bef87c49483ba9260649e2f49ca77a/src/adapters/vfs/system.js#L66-L111
- `Application.worker(filename)` — per-process Web Worker tracking with `terminate()` on kill. The one shipped primitive in OS.js that is genuinely killable and backgroundable. BSD-2-Clause, https://github.com/os-js/osjs-client/blob/12717e22f2a6c8ea2021afc302a91dd2c66f25cb/src/application.js#L306-L321
- The build-time package discovery scheme: `{"osjs":{"type":"package"}}` marker in package.json + sibling `metadata.json` + a generated static manifest. BSD-2-Clause, https://github.com/os-js/osjs-cli/blob/87bc49a476c5569a6801661eebbaa9f00bf2a658/src/tasks/discover.js. The marker-plus-manifest split is what keeps the catalogue servable from a CDN.
- `@osjs/panels` as the worked example of a userland shell surface: a provider that does not extend `ServiceProvider`, registers one named service with a `{register, create, remove, removeAll, save, get}` registry, and is replaced by not registering it. BSD-2-Clause, https://github.com/os-js/osjs-panels/blob/da3e669d11d98ed7fdf503d62527df1ed47470d8/src/provider.js
- `@osjs/windows8-theme` exists in the org as prior art that OS.js window chrome can be re-skinned to a Microsoft aesthetic through the theme/template seam alone: https://github.com/os-js/osjs-windows8-theme (licence declared in-repo; I did not read its package.json, so confirm before depending on it).

## Gotchas

- `standalone: true` is not a static deploy mode, it is a no-filesystem mode. The manual (https://manual.os-js.org/guide/standalone/) says it runs 'just like normal except the default provided authentication, storage and filesystems' — what that means in code is that `Core.request` rejects unconditionally, so the only shipped read/write VFS adapter is dead and every file-touching app with it. Do not plan on `standalone` as a path to a static build; it is a path to a desktop with no files.
- The 'iframe application' template does NOT isolate the app. `osjs-example-iframe-application/index.js` runs in the host realm, does `core.make('osjs/application')` there, and appends an `<iframe>` to its own window content. If you search OS.js for prior art on sandboxing apps, this is what you will find, and it is not it.
- `providers.globalBlacklist` looks like a capability model. It only filters `window.OSjs.make`. Every app's register callback is handed the raw `Core` as its first argument, so `core.make('osjs/websocket')` works from any app regardless of the denylist.
- `metadata.groups` / `packages.permissions` look like app-level authorization. They only filter launcher entries client-side. The bundle at `/apps/<Name>/main.js` and the whole catalogue at `/metadata.json` are served by `express.static` to anonymous clients — confirmed against the live demo.
- `auth.cookie.enabled: true` writes the raw login form values — password included — into a non-httpOnly JSON cookie via js-cookie, with `secure: false` in the defaults. See src/auth.js#L222-L231 at @osjs/client 12717e2. It reads like a 'remember me' flag.
- Default server session secret is the literal string `'osjs'` and default bind is `0.0.0.0` (src/config.js#L39, #L98 at @osjs/server f77358e). Default auth adapter accepts any password for any username. The shipped defaults are demo defaults.
- The WebSocket `verifyClient` parses the session and then always calls `done(true)`, and `app.ws('/')` carries no `isAuthenticated`. Reading the HTTP side first gives a false impression that the gate is uniform.
- `provides()` is an unvalidated string list. `CoreServiceProvider` already ships a spelling mismatch (`osjs/window-behaviour` advertised, `osjs/window-behavior` registered). A `depends()` naming a service nobody advertises silently gets no ordering edge, and the resulting cold-boot `Provider not found` is logged as a warn, not thrown.
- Mountpoints are declared in two config files (client `vfs.mountpoints` with adapter names, server `vfs.mountpoints` with filesystem roots) and matched by hand on the `name` string. There is no single mount table.
- `Application.createWindow` does `new Window(...)` from a hard import, not `core.make('osjs/window')`. The window state machine and z-index ownership are not replaceable through the registry, however much the rest of the system is.

## Could not determine

- Whether the unauthenticated WebSocket path is actually exploitable end-to-end. `verifyClient` always calls `done(true)` and `handleMessage` trusts the client-supplied package `name`, but reaching a server-side handler also requires a package with a `metadata.server` script to be installed, and every official app I checked (FileManager, iframe example) has none. I did not stand up a server with a server-scripted package to confirm. The missing identity check in the code path is verified; the impact is not.
- Which auth adapter demo.os-js.org actually runs. I probed only read-only endpoints (metadata.json 200, /apps/FileManager/main.js 200, /vfs/readdir 403, all on 2026-11-11) and did not attempt a login, so I cannot say whether the demo uses the accept-all `null` adapter or a configured one.
- The licence of @osjs/windows8-theme, @osjs/widgets, @osjs/dialogs and @osjs/example-provider. I read the org listing (GitHub's detector reports NOASSERTION or null for most os-js repos) but did not open their package.json or LICENSE files.
- Whether any community (non-org) OS.js VFS adapter implements browser-local storage. I enumerated the 77 public repos in the os-js GitHub organisation only; I did not search npm or GitHub at large.
- The exact OS.js version deployed at demo.os-js.org. My source reading is pinned to OS.js 0aa8744 / @osjs/client 3.10.0 / @osjs/server 3.4.3, which are the current HEADs, but I did not confirm the demo matches.
- Whether `Window` is reachable through the registry in any supported way I missed. `osjs/window` IS registered as a `core.instance` factory, so direct `core.make('osjs/window')` honours a replacement — but `Application.createWindow`, the path every app actually uses, bypasses it. I did not audit whether any app calls `core.make('osjs/window')` directly.

