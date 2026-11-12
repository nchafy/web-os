# The browser as kernel substrate: isolation, blocking syscalls, storage, preemption, compositing, capabilities

## Summary

The platform forces one choice: a process can have a DOM, or it can share memory with the kernel, but not both. The HTML spec's agent-cluster table is the whole design constraint — SharedArrayBuffer reaches a dedicated worker you created and a same-origin-domain iframe you created, and nothing else. Same-origin iframes share one event loop, so they are neither a security nor a liveness boundary. Cross-origin iframes are real processes (out-of-process on Chrome desktop, Firefox 95+) but can never share memory with the kernel. Three viable process models: (A) process = dedicated worker, kernel owns all DOM and apps send UI ops — full blocking syscalls, no app-authored DOM; (B) split process — worker for logic (SAB syscalls, terminate()) plus a cross-origin iframe for DOM, joined only through the kernel; (C) process = cross-origin iframe with an in-frame stub that owns the app's worker and relays to the kernel by postMessage — blocking syscalls restored, one extra hop, and COEP headers required on both origins, which rules out GitHub Pages. OPFS sync access handles in dedicated workers are the only synchronous storage on the web, and the only credible basis for a POSIX VFS.

## Findings

### SharedArrayBuffer can only be shared between: a Window and a dedicated worker it created; a worker and a dedicated worker it created; a Window and a same-origin-domain iframe it created; a Window and a worklet it created. It explicitly CANNOT be shared with a shared worker, a service worker, a cross-origin iframe, or any two Windows with no opener/ancestor relationship (even same-origin).

- Evidence: https://html.spec.whatwg.org/multipage/webappapis.html#integration-with-the-javascript-agent-cluster-formalism
- Confidence: verified
- Why it matters: This single table decides the process model. A blocking syscall channel can only exist between the kernel and a dedicated worker it spawned, or between an iframe's own main thread and that iframe's own worker. A SharedWorker 'kernel' is impossible if you want Atomics-based syscalls.

### "Only shared and dedicated worker agents allow the use of JavaScript Atomics APIs to potentially block." Worklet agents and service worker agents are created with [[CanBlock]] false.

- Evidence: https://html.spec.whatwg.org/multipage/webappapis.html#integration-with-the-javascript-agent-formalism
- Confidence: verified
- Why it matters: Worklets and service workers are disqualified as process hosts for anything needing synchronous syscalls. Combined with the agent-cluster rule, the dedicated worker is the only blockable, memory-sharing process candidate.

### Atomics.wait() "only works with an Int32Array or BigInt64Array that views a SharedArrayBuffer. It is blocking and cannot be used in the main thread" — it throws TypeError "if the current thread cannot be blocked".

- Evidence: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait
- Confidence: verified
- Why it matters: The kernel side of a synchronous syscall must never call wait(). The kernel services the request asynchronously and uses Atomics.store + Atomics.notify; only the calling worker blocks.

### Atomics.waitAsync() is available in Chrome 90+, Safari 16.4+, Firefox 145+ — it returns a promise instead of blocking, and is usable on the main thread.

- Evidence: https://cdn.jsdelivr.net/npm/@mdn/browser-compat-data@8.1.8/data.json
- Confidence: verified
- Why it matters: Gives the kernel a main-thread-safe way to park on a futex word, so the same SAB ring buffer can be used for both directions without polling. Firefox support is very recent (145), so a polling fallback is still needed.

### Worker.terminate() "immediately terminates the Worker. This does not offer the worker an opportunity to finish its operations; it is stopped at once." There is no terminate() on SharedWorker; its lifetime is reference-counted ("alive as long as any open page holds a reference"), with an extendedLifetime option.

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate
- Confidence: verified
- Why it matters: terminate() is the only forcible kill primitive the platform offers. It is the entire basis of 'End Process'. A SharedWorker-based process cannot be killed on demand, only abandoned.

### A Window and a same-origin-domain iframe it created are in the same similar-origin window agent, and "Each agent has an associated event loop, which is unique to that agent" — so there is exactly one window event loop shared by the desktop and all its same-origin iframes.

- Evidence: https://html.spec.whatwg.org/multipage/webappapis.html#event-loops
- Confidence: verified
- Why it matters: A same-origin iframe is neither an isolation boundary nor a liveness boundary: a `while(true)` in one app freezes the whole desktop, including the kernel's watchdog. It is unusable as a process.

### The HTML sandboxed origin browsing context flag "forces content into an opaque origin, thus preventing it from accessing other content from the same origin"; it is set unless the sandbox token list includes allow-same-origin.

- Evidence: https://html.spec.whatwg.org/multipage/browsers.html#sandboxed-origin-browsing-context-flag
- Confidence: verified
- Why it matters: This is the real capability-enforcement mechanism available in the browser: an opaque-origin iframe cannot name your origin's data at all. Capability gating happens by what you proxy over postMessage, not by a policy header.

### "To obtain a storage key... If key's origin is an opaque origin, then return failure." Storage keys gate every storage endpoint (localStorage, sessionStorage, IndexedDB, Cache API, service worker registrations, and the File System API's OPFS).

- Evidence: https://storage.spec.whatwg.org/#obtain-a-storage-key
- Confidence: verified
- Why it matters: A sandboxed iframe without allow-same-origin has no storage of any kind — no IndexedDB, no OPFS, no localStorage. An app running there physically cannot reach the filesystem except through the kernel's postMessage API. That is the enforcement webxp lacked.

### MDN strongly discourages sandbox="allow-scripts allow-same-origin" on same-origin content: "Doing so lets the embedded document remove the sandbox attribute, making it no more secure than having no sandbox attribute at all." It also notes a same-origin parent can access the iframe's DOM even without allow-scripts.

- Evidence: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe
- Confidence: verified
- Why it matters: The tempting 'sandboxed but same-origin so it can use my storage' configuration is a no-op. Sandboxing and storage access are mutually exclusive by design.

### Chromium Site Isolation locks each renderer process to one site, defined as "scheme plus eTLD+1". Full Site Isolation with out-of-process iframes is the default on Windows, Mac, Linux and ChromeOS. Android with 2+ GB RAM gets only partial (heuristic) isolation; low-memory Android (<2 GB), Android WebView and Chrome for iOS get none.

- Evidence: https://chromium.googlesource.com/chromium/src/+/main/docs/process_model_and_site_isolation.md
- Confidence: verified
- Why it matters: A cross-site iframe is a genuine OS process on desktop — separate thread, separate memory, cannot freeze the kernel, dies when the element is removed. On Android WebView and iOS the same code gives you no liveness isolation at all, so the watchdog must still exist.

### Site isolation (Project Fission) "was released to desktop Firefox in version 95", executing frames "in processes dedicated to their origin".

- Evidence: https://wiki.mozilla.org/Project_Fission
- Confidence: verified
- Why it matters: Confirms cross-origin-iframe-as-process is not a Chrome-only bet on desktop.

### A document is cross-origin isolated only if served with Cross-Origin-Opener-Policy: same-origin AND Cross-Origin-Embedder-Policy: require-corp or credentialless, AND the Permissions-Policy cross-origin-isolated directive allows it. Without it SharedArrayBuffer cannot be created or postMessage'd.

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated
- Confidence: verified
- Why it matters: Blocking syscalls are gated behind response headers, which means the hosting decision and the kernel design are the same decision.

### Even with COOP: same-origin-plus-COEP, the spec lets the UA pick cross-origin isolation mode "logical" or "concrete": "It is difficult on some platforms to provide the security properties required by the cross-origin isolated capability. 'concrete' grants access to it and 'logical' does not." The choice is implementation-defined.

- Evidence: https://html.spec.whatwg.org/multipage/browsers.html#obtain-a-cross-origin-isolation-mode
- Confidence: verified
- Why it matters: Correct headers do not guarantee crossOriginIsolated === true. The kernel must feature-detect at boot and fall back to an async-only syscall ABI, not assume SAB.

### "To check a navigation response's adherence to its embedder policy": if the parent document's COEP is compatible with cross-origin isolation and the child navigable's response COEP is not, the algorithm returns false and the iframe navigation is blocked (replaced with an error document).

- Evidence: https://html.spec.whatwg.org/multipage/browsers.html#check-a-navigation-response's-adherence-to-its-embedder-policy
- Confidence: verified
- Why it matters: A cross-origin-isolated desktop cannot embed any iframe whose server does not also send COEP. Your app-sandbox origin must be header-controlled too. Chrome's iframe credentialless attribute is the only escape and it is Chrome 110+ only.

### Netlify supports arbitrary response headers via a _headers file or [[headers]] in netlify.toml (only Connection, Content-Length, Date, Server, Transfer-Encoding, Location and Set-Cookie are reserved). Cloudflare Pages supports a _headers file that "override[s] what Cloudflare ordinarily sends", with no documented name restrictions (limits: 100 rules, 2000 chars/line).

- Evidence: https://docs.netlify.com/manage/routing/headers/
- Confidence: verified
- Why it matters: COOP/COEP, and therefore SharedArrayBuffer syscalls, are deployable on Netlify and Cloudflare Pages with no server. Cloudflare Pages additionally lets you serve a second, cross-origin app-sandbox host with its own COEP header.

### Cloudflare Pages _headers rules do not apply to Pages Functions responses, and Netlify headers do not apply to proxied URLs, functions or edge functions.

- Evidence: https://developers.cloudflare.com/pages/configuration/headers/
- Confidence: verified
- Why it matters: If any part of the OS is served by a function rather than static storage, it silently loses COEP and breaks cross-origin isolation for the whole document.

### GitHub Pages' documented limits cover repo size, site size, deploy time, bandwidth, builds and rate limiting. Nothing in the Pages documentation provides a mechanism for custom response headers; coi-serviceworker exists specifically for "situations in which you can't control the headers (e.g. GH pages)".

- Evidence: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- Confidence: likely
- Why it matters: GitHub Pages cannot serve COOP/COEP. A GitHub-Pages-hosted web OS gets blocking syscalls only through the service-worker trick, and then cannot embed cross-origin app iframes at all.

### coi-serviceworker (MIT) installs a service worker that rewrites same-origin responses to add Cross-Origin-Embedder-Policy (require-corp or credentialless), Cross-Origin-Resource-Policy: cross-origin and Cross-Origin-Opener-Policy: same-origin, then reloads the page once on first visit (tracked in sessionStorage) so the SW controls the navigation. It must be a separate file served from your own origin, not bundled, not CDN-hosted.

- Evidence: https://github.com/gzuidhof/coi-serviceworker/blob/7b1d2a092d0d2dd2b7270b6f12f13605de26f214/coi-serviceworker.js
- Confidence: verified
- Why it matters: Buys crossOriginIsolated on header-less hosts at the cost of one forced reload at boot and a dependency on service workers. Because a service worker only intercepts same-origin, in-scope requests, it cannot supply COEP to a cross-origin app iframe — so this workaround and cross-origin-iframe processes are mutually exclusive.

### createSyncAccessHandle() is "only available in Dedicated Web Workers", only for files in the origin private file system, only in secure contexts, and taking a handle "takes an exclusive lock on the file" (NoModificationAllowedError on a second handle). Support: Chrome 102, Firefox 111, Safari 15.2, Safari iOS 15.2.

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle
- Confidence: verified
- Why it matters: This is the only synchronous read/write/seek/truncate/flush on the web platform, and it exists exactly where a POSIX process lives (a dedicated worker). It is the correct primary store for a web OS filesystem, and it is cross-browser including Safari.

### The mode option on createSyncAccessHandle ("read-only", "readwrite-unsafe") is Chrome 121+ only, and is marked experimental and not on the standard track — not in Firefox, not in Safari.

- Evidence: https://cdn.jsdelivr.net/npm/@mdn/browser-compat-data@8.1.8/data.json
- Confidence: verified
- Why it matters: Portably, one file = one exclusive handle, process-wide and tab-wide. A multi-tab web OS needs a single filesystem server owning all sync handles (one worker), with other processes going through it; you cannot hand each app its own handle.

### localStorage and sessionStorage are capped at 5 MiB per origin (5 × 2^20, specified in the Storage standard's storage endpoint table) and throw QuotaExceededError past it. IndexedDB, Cache API and OPFS share the browser-managed quota instead.

- Evidence: https://storage.spec.whatwg.org/#registered-storage-endpoints
- Confidence: verified
- Why it matters: localStorage is only viable for a few kilobytes of boot config. It is also synchronous on the main thread, so it is the one storage API that can stall the compositor.

### Quotas: Chromium ~60% of disk per origin (80% total); Firefox best-effort is min(10% of disk, 10 GiB site group limit) but persistent is up to 50% of disk capped at 8 TiB; Safari ~60% of disk for browser apps but only ~15% for embedded WebViews, and cross-origin frames get "roughly 1/10 of their parents".

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- Confidence: verified
- Why it matters: Cross-origin app iframes get a tenth of the parent's quota in Safari, which is another reason app data must live in the kernel's origin and be proxied, not stored by the app itself.

### Eviction is per-origin and all-or-nothing ("all of its data, not parts of it, is deleted at the same time"), LRU under storage pressure, for best-effort origins only. Safari additionally "proactively evicts data when cross-site tracking prevention is turned on. If an origin has no user interaction... in the last seven days of browser use, its data created from script will be deleted."

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- Confidence: verified
- Why it matters: On Safari, a user's entire web-OS disk disappears after a week of not opening it. navigator.storage.persist() is not optional for this project — and it is auto-decided without a prompt on Safari and Chromium, prompted on Firefox.

### navigator.storage.persist() "requests permission to use persistent storage"; persistent data "is only evicted... if the user chooses to". It is not available in Web Workers (the StorageManager interface is).

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist
- Confidence: verified
- Why it matters: The persist() call must be made from the kernel's window, early in boot, and its boolean result recorded — it is the difference between a durable filesystem and a cache.

### showDirectoryPicker() requires transient user activation and a secure context, and is not supported in Firefox or any Safari (desktop or iOS); Chrome 86 desktop, Chrome Android only from 132.

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker
- Confidence: verified
- Why it matters: The File System Access API cannot be the primary store — it is a Chrome-only /mnt. Mount it as an optional second mountpoint over an OPFS-backed root.

### Scheduler support is uneven: scheduler.postTask is Chrome 94 / Firefox 142 / no Safari; scheduler.yield is Chrome 129 / Firefox 142 / no Safari; navigator.scheduling.isInputPending is Chrome-only and MDN now marks it deprecated ("may incorrectly return false... may be a candidate for removal"); requestIdleCallback is absent from Safari (preview, behind a flag).

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield
- Confidence: verified
- Why it matters: The kernel's cooperative scheduler cannot depend on any of these. The portable floor is await new Promise(r => setTimeout(r, 0)) / MessageChannel ticks, with scheduler.yield used opportunistically when present.

### scheduler.yield() enqueues its continuation "in a boosted task queue compared to a scheduler.postTask() of the same priority level", defaults to "user-visible", and inherits priority from an enclosing postTask.

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield
- Confidence: verified
- Why it matters: Where available, yield() is strictly better than postTask for 'keep going but let input in' — the continuation jumps queued same-priority tasks, so a long kernel job does not starve itself.

### requestIdleCallback without a timeout can be delayed indefinitely: "A timeout option is strongly recommended for required work, as otherwise it's possible multiple seconds will elapse before the callback is fired."

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/Window/requestIdleCallback
- Confidence: verified
- Why it matters: Idle callbacks cannot carry the watchdog. A watchdog must run on a timer in a worker, not on the main thread's idle time, or it will not fire precisely when the main thread is the thing that is wedged.

### The HTML spec's terminate-a-worker algorithm sets the closing flag and aborts the running script; "User agents may invoke the terminate a worker algorithm when a worker stops being actively needed." There is no spec text about the UA detecting or killing an unresponsive worker.

- Evidence: https://html.spec.whatwg.org/multipage/workers.html#terminate-a-worker
- Confidence: verified
- Why it matters: There is no preemption and no platform-provided 'not responding' signal. A credible Not Responding → End Process is: kernel-side timer + per-process sequence-numbered ping over postMessage (or an Atomics heartbeat counter in SAB), a two-threshold state machine (e.g. 1 s greyed-out, 5 s dialog) with hysteresis, then Worker.terminate() and/or removing the iframe element. Identity must be a sequence number, not timing.

### Every element with backdrop-filter other than none is itself a Backdrop Root, as is any ancestor with filter, opacity < 1, mask/mask-image/mask-border/clip-path, mix-blend-mode other than normal, or will-change naming any of those. Rendering requires copying the Backdrop Root Image into a temporary buffer per element, filtering it, then drawing the element into it and compositing source-over.

- Evidence: https://drafts.csswg.org/filter-effects-2/#BackdropFilterProperty
- Confidence: verified
- Why it matters: Each Aero window with backdrop-filter costs one offscreen buffer the size of its border box plus a filter pass, every frame it changes. Twenty overlapping windows is twenty render surfaces, not one.

### The spec states nesting is deliberately prevented from seeing through: "there would likely be an exponential performance degradation in the case of nested backdrop-filter or mix-blend-mode elements, due to the need to re-paint the content behind each element. Each nesting level will double the number of these required re-paint cycles."

- Evidence: https://drafts.csswg.org/filter-effects-2/#BackdropRoot
- Confidence: verified
- Why it matters: A blurred toolbar inside a blurred window will only blur the window's own content, not the desktop. And a window fade-out animating opacity below 1 silently makes that window a Backdrop Root, killing its children's blur mid-animation. Both are exactly the Aero effects you want.

### backdrop-filter is unprefixed in Safari only from version 18 (prefixed -webkit-backdrop-filter since Safari 9) and in Firefox from 103 (broken before Firefox 123 on systems with an unknown GPU vendor).

- Evidence: https://cdn.jsdelivr.net/npm/@mdn/browser-compat-data@8.1.8/data.json
- Confidence: verified
- Why it matters: Aero glass needs the -webkit- prefix declared alongside the standard property, and needs a non-blur fallback path, not just a feature query on the unprefixed name.

### WebGPU is not a portable compositing target: Chrome shipped it in 113 but only on ChromeOS/macOS/Windows, with Linux (Intel Gen12+ only) arriving in 144; Firefox 141 is partial with no Linux and no Intel macOS; Safari 26; no Firefox Android.

- Evidence: https://cdn.jsdelivr.net/npm/@mdn/browser-compat-data@8.1.8/data.json
- Confidence: verified
- Why it matters: A WebGPU compositor needs a full DOM/CSS compositor as a fallback, which means building the desktop twice. DOM+CSS is the only single-implementation choice.

### A service worker's default scope is its script's directory, broadenable only with the Service-Worker-Allowed header; the fetch event "fires every time any resource controlled by a service worker is fetched, which includes the documents inside the specified scope"; respondWith can return a Response constructed in script; and a newly registered worker does not control already-loaded pages until they reload or it calls clients.claim(). HTTPS (or localhost) required.

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers
- Confidence: verified
- Why it matters: A service worker can serve a virtual filesystem over fetch() — e.g. GET /fs/home/user/a.txt resolved from OPFS — giving you real URLs for <img>, <script>, fetch() and iframe src. Limits: same-origin and in-scope only, asynchronous only, and Service-Worker-Allowed is a response header, so this needs a header-capable host or a root-placed script.

### Web Locks are origin-scoped and coordinate across tabs and workers: "While held, no other script executing in the same origin can acquire the same lock". Modes are exclusive (default) and shared; options are ifAvailable (fail fast, callback gets null), steal (release current holders and preempt the queue) and signal (abort/timeout). Baseline since March 2022 (Safari 15.4).

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API
- Confidence: verified
- Why it matters: This is the kernel's mutex for cross-tab singletons: which tab owns the one sync-access-handle filesystem server. steal is the recovery path when the previous owner tab was killed mid-hold.

### BroadcastChannel delivers "via a message event fired at all BroadcastChannel objects listening to the channel, except the object that sent the message", same-origin only. Safari 15.4+, Firefox 38+, Chrome 54+.

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel
- Confidence: verified
- Why it matters: Correct for kernel-wide notifications (filesystem change events, mount/unmount, theme). The sender not seeing its own message means the kernel must apply its own events locally, not rely on the loopback.

### Transferable types are: ArrayBuffer, AudioData, ImageBitmap, MediaSourceHandle, MediaStreamTrack, MessagePort, MIDIAccess, OffscreenCanvas, ReadableStream, RTCDataChannel, TransformStream, VideoFrame, WebTransportReceiveStream, WebTransportSendStream, WritableStream. Typed arrays are serializable but not transferable. After transfer "the original object is no longer usable... any attempt to read or write the object will throw".

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects
- Confidence: verified
- Why it matters: MessagePort transfer is how the kernel hands a process a capability — a port that reaches exactly one service and nothing else. OffscreenCanvas transfer is how a worker-hosted process can paint without DOM. ReadableStream transfer is a zero-copy file read.

### The Permissions-Policy HTTP header is supported only in Chromium (Chrome/Edge 85+); it is absent from Firefox and Safari. MDN describes its scope strictly as "browser features", and the header sets the superset while an iframe's allow attribute selects a subset.

- Evidence: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy
- Confidence: verified
- Why it matters: Permissions-Policy is useful only for denying browser capabilities (camera, geolocation, usb) to app frames, and only in Chromium. It cannot express 'this app may not read /home'. Application capabilities must be enforced by the kernel refusing the request, with the opaque origin as the backstop.

### PWA integration points are Chrome-desktop-only: manifest file_handlers Chrome 102 (not Chrome Android, not Firefox, not Safari); manifest protocol_handlers Chrome 96 (desktop only); LaunchQueue Chrome 102 (desktop only); navigator.registerProtocolHandler has no Safari support.

- Evidence: https://cdn.jsdelivr.net/npm/@mdn/browser-compat-data@8.1.8/data.json
- Confidence: verified
- Why it matters: 'Open .txt with my web OS' and custom URL schemes are a Chrome-desktop bonus feature, never part of the core design. Budget them as progressive enhancement.

### The Navigation API is now broadly available (Chrome 102, Firefox 147, Safari 26.2) and SharedWorker has become broadly available too (Safari 16, Firefox 29, Chrome 5) — but Chrome for Android only gained SharedWorker in version 148.

- Evidence: https://cdn.jsdelivr.net/npm/@mdn/browser-compat-data@8.1.8/data.json
- Confidence: verified
- Why it matters: SharedWorker is finally viable as a cross-tab coordinator — but not as a syscall kernel, since it cannot share a SharedArrayBuffer, and on Android it is brand new. Navigation API is the right tool for mapping desktop state to history entries.

### Worklets "cannot be used for arbitrary computations like Web Workers", cannot be instantiated directly, and dynamic import() is disallowed by spec. Paint worklets (CSS Painting API) are Chromium-only (PaintWorkletGlobalScope: Chrome 65, no Firefox, no Safari).

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/Worklet
- Confidence: verified
- Why it matters: Worklets are not a process host. AudioWorklet is the only broadly supported one, and it is for audio. Rule them out for app isolation.

### OPFS requires no permission prompt and offers in-place writes: "Permission prompts and security checks are not required to access files in the OPFS", and it is "faster than File System Access API calls" because it skips those checks. Clearing site data deletes it.

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system
- Confidence: verified
- Why it matters: A POSIX-ish VFS can be built on OPFS with no UX friction: directories, byte-range read/write, truncate, flush, and an exclusive lock per file. Its weakness is metadata — no permissions, no ownership, no symlinks — so inodes and mode bits need a side index (IndexedDB or a superblock file).

## Reusable

- coi-serviceworker, MIT licence, pinned at commit 7b1d2a092d0d2dd2b7270b6f12f13605de26f214 — https://github.com/gzuidhof/coi-serviceworker/blob/7b1d2a092d0d2dd2b7270b6f12f13605de26f214/coi-serviceworker.js — synthesises COOP/COEP/CORP in a service worker so crossOriginIsolated becomes true on hosts with no header control. ~6 KB, one file, one forced reload at boot. Copy it rather than npm-depending on it; it must be served unbundled from your own origin.
- @mdn/browser-compat-data, CC0-1.0, version 8.1.8 — https://cdn.jsdelivr.net/npm/@mdn/browser-compat-data@8.1.8/data.json — the authoritative per-browser version table. Worth vendoring a filtered subset as the project's own support matrix so 'does Safari have this' is answered by a file, not memory. A 15-line python3 query script over data.json is enough (one was used to produce the compat numbers in these findings).
- The HTML spec's agent-cluster sharing table — https://html.spec.whatwg.org/multipage/webappapis.html#integration-with-the-javascript-agent-cluster-formalism — belongs verbatim in the project's CLAUDE.md as the stated process-model constraint. Every 'why can't app code just call the kernel' question resolves against it.
- Netlify _headers / Cloudflare Pages _headers as the deployment contract — https://developers.cloudflare.com/pages/configuration/headers/ — a 4-line _headers file (COOP: same-origin, COEP: require-corp on the kernel origin, COEP: require-corp + CORP: cross-origin on the app-sandbox origin) is the whole server-side of the design. Cloudflare Pages is the only one of the three hosts that supports both header control and a second origin cheaply.
- The Storage standard's opaque-origin rule — https://storage.spec.whatwg.org/#obtain-a-storage-key — is the capability backstop worth building a test around: assert that an app frame's attempt to open IndexedDB throws, as a negative control proving the sandbox is real.

## Gotchas

- A same-origin iframe is not a process. It shares the window event loop with the desktop, so a busy loop in one app freezes the kernel, the watchdog and the compositor at once. It also shares the agent cluster, meaning it shares memory and can reach parent.document. This is the exact failure mode webxp already had, with extra ceremony.
- You cannot have a SharedArrayBuffer syscall channel with a cross-origin iframe. The spec's agent-cluster list rules it out. Any design that says 'apps are cross-origin iframes and call the kernel synchronously' is impossible without an in-frame relay stub that owns the app's own worker.
- You cannot have a SharedWorker kernel. A SharedWorker is in a different agent cluster from every window, so no shared memory, and it has no terminate().
- Cross-origin isolation and cross-origin app iframes fight each other. Once the top document sends COEP: require-corp, any iframe whose response lacks a COI-compatible COEP is blocked outright. So your app-sandbox origin needs its own COEP header — which the coi-serviceworker trick cannot provide, because a service worker only intercepts same-origin in-scope requests. On GitHub Pages this combination is unreachable. Chrome's iframe credentialless is the only workaround and it is Chrome 110+ only.
- Correct COOP/COEP headers do not guarantee SharedArrayBuffer. The spec lets the UA choose a 'logical' cross-origin isolation mode that does not grant the capability. Feature-detect crossOriginIsolated at boot and ship an async-only syscall ABI as the fallback, or the OS will not boot on some platform.
- Sandbox and storage are mutually exclusive. sandbox without allow-same-origin means an opaque origin, which means obtain-a-storage-key returns failure: no IndexedDB, no OPFS, no Cache, no localStorage. And sandbox="allow-scripts allow-same-origin" on same-origin content lets the frame delete its own sandbox attribute. There is no 'sandboxed but can use storage' configuration.
- The createSyncAccessHandle mode option is Chrome-121-only and not on the standard track. Portably, taking a sync handle is an exclusive per-file lock, so two tabs of the OS cannot both hold the same file — not even for reading. One worker must own all sync handles and serve the rest.
- Safari deletes script-created storage after seven days without user interaction when tracking prevention is on, and eviction is all-or-nothing per origin. Without navigator.storage.persist() succeeding, the whole filesystem is a cache. persist() is not callable from a worker.
- File System Access (showDirectoryPicker) is absent from Safari and Firefox entirely. It is a /mnt, never the root filesystem.
- isInputPending is deprecated by MDN and may return false incorrectly; scheduler.yield and scheduler.postTask are absent from Safari; requestIdleCallback is absent from Safari. None of them can be the basis of the kernel's scheduler.
- requestIdleCallback is the wrong place for a watchdog: with no timeout it can be delayed for seconds, and it runs on the thread you are trying to prove is alive. Heartbeat from a worker timer or an Atomics counter instead, and compare sequence numbers rather than timings.
- An element with backdrop-filter is itself a Backdrop Root, so a nested blurred element (blurred toolbar inside a blurred window) only blurs its parent's content. Worse, animating a window's opacity below 1 — a fade-in, a drag ghost, a minimise — turns that window into a Backdrop Root and silently kills its children's blur for the duration of the animation. will-change: opacity does the same thing permanently.
- Safari only supports unprefixed backdrop-filter from version 18; everything older needs -webkit-backdrop-filter. Firefox before 123 silently drops it on systems with an unrecognised GPU vendor.
- WebGPU is not deployable as the only compositor: no Linux in Chrome before 144, no Linux and no Intel macOS in Firefox, nothing on Firefox Android. Choosing it means building the desktop twice.
- Permissions-Policy is Chromium-only and only governs browser features. It cannot express an application capability. 'Can this process read /home' must be answered by the kernel refusing the message.
- Headers on Netlify and Cloudflare Pages do not apply to function/edge-function responses. One function-served route in the OS silently drops COEP and breaks cross-origin isolation for the whole document.
- PWA file handlers, protocol handlers and LaunchQueue are Chrome desktop only. They do not work on Chrome Android, Firefox or Safari.

## Could not determine

- Whether GitHub Pages explicitly forbids custom response headers. GitHub's own documentation (limits page and Pages overview) never mentions headers at all, so the claim rests on absence plus coi-serviceworker's README naming GH Pages as the motivating case. Not a positive citation. Test it by curling a Pages URL with a _headers file committed.
- The actual cost of backdrop-filter at 20 overlapping windows. No citable measurement was found. The spec establishes the mechanism (one offscreen buffer and one filter pass per backdrop-filtered element, doubling per nesting level) but gives no numbers. This must be measured locally with Chrome DevTools' rendering 'Paint flashing'/'Layer borders' plus a Performance trace at 1, 5, 10 and 20 windows, on both an integrated and a discrete GPU, and at both a narrow and a wide viewport.
- Whether Safari/WebKit places cross-site iframes in separate processes. No WebKit documentation or blog post establishing this was located (webkit.org/blog/16994 returns 404 and the site search surfaced nothing). Treat cross-origin-iframe liveness isolation as a Chrome-and-Firefox-desktop property only, and keep the watchdog unconditional.
- Whether a sandboxed (opaque-origin) iframe can still be crossOriginIsolated and construct a SharedArrayBuffer. The policy container is inherited, which suggests yes, but no spec text confirming it was read. This matters for option C and must be tested before committing to it.
- Whether a FileSystemFileHandle or FileSystemDirectoryHandle can be stored in IndexedDB and reused across sessions. The MDN showDirectoryPicker page does not mention serialization. Check the FS spec's serialization steps before designing persistent mounts.
- Whether a kernel service worker can serve a virtual filesystem to a cross-origin app iframe. Service worker scope is same-origin, so almost certainly not, but the interaction with iframe credentialless and storage partitioning was not verified.
- Exact behaviour of Atomics.wait inside a SharedWorker. The spec permits it ([[CanBlock]] true for shared worker agents), but since no SharedArrayBuffer can reach a SharedWorker from any window, the permission appears unusable in practice. Not tested.

