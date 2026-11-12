# GAP 1 — whether a SharedArrayBuffer blocking syscall channel requires the kernel to live on the main thread (and therefore whether one single worker must own all sync access handles), and whether a cross-origin or opaque-origin sandboxed iframe can be crossOriginIsolated and hold a SAB.

## Verdict

The critic is right and the earlier pass was wrong. A dedicated worker joins the agent cluster of whatever created it, so every worker descended from one window is in one cluster: sibling workers and nested workers can share a SAB and all of them have [[CanBlock]] true. A worker-resident kernel therefore serves blocking syscalls to sibling process workers with the main thread never touched — measured p50 15 us per round trip over 2000 syscalls. The cluster, however, is the hard wall: a cross-origin iframe can be crossOriginIsolated and construct a SAB (only with allow="cross-origin-isolated" plus its own COEP), but it is in a different cluster, so the top page's SAB arrives as messageerror. "Process = cross-origin iframe" and "blocking syscalls to one central kernel" are mutually exclusive.

## Detail

## a) Normative text

`obtain a dedicated/shared worker agent(outside settings, isShared)` returns `obtain a worker/worklet agent(outside settings, isShared, true)` — so for a dedicated worker `isTopLevel` is false and `canBlock` is **true**. The non-top-level branch reads: "Assert: outside settings is not null. Let ownerAgent be outside settings's realm's agent. Set agentCluster to **the agent cluster which contains ownerAgent**." The spec then lists, as same-cluster pairs that "can use SharedArrayBuffer instances to share memory with each other": "A Window object and a dedicated worker that it created. **A worker (of any type) and a dedicated worker it created.**"

- Window spawns A and B → both join the window's cluster → **A and B are in the same cluster.**
- A can get a SAB to B via the window, or via a MessageChannel the window hands them — the cluster is the only gate, not the route. B's `[[CanBlock]]` is true, so B can `Atomics.wait`.
- A worker can spawn a nested worker, and it is in the same cluster.

Measured (Chrome 157.0.8103.38 headless, macOS 26.7.2, M2 Pro; `www/top.html` via `run.py`): sibling wait/notify woken via window relay `"ok"` at 150.98 ms, via worker-minted SAB over MessageChannel `"ok"` at 150.92 ms, `Atomics.notify` returned 1 in both. Nested worker: `"ok"` at 144.55 ms, `crossOriginIsolated: true`.

## b) Worker-resident kernel — YES

Mechanism: kernel is a dedicated worker the window spawns; each process is another dedicated worker; window hands each process a `MessagePort` to the kernel plus a control SAB. Process: `Atomics.store(ctl,0,0)` → `port.postMessage(req)` → `Atomics.wait(ctl,0,0,timeout)`. Kernel (never blocks): `await` the real async work → `Atomics.store(ctl,0,1)` → `Atomics.notify(ctl,0)`.

Measured, 2000 round trips: min 0.00 ms, **p50 0.015 ms**, p99 0.040 ms, max 0.080 ms, 31.1 ms wall; 1996 returned `"ok"`, 4 returned `"not-equal"` (reply beat the park — the fast path must be handled). The main thread rendered rAF frames throughout. `createSyncAccessHandle` works in any dedicated worker, so the kernel worker qualifies — nothing forces one worker to own all handles beyond your own locking choice.

## c) Main thread as kernel — possible but wrong

`Atomics.wait` in a window agent threw `TypeError: Atomics.wait cannot be called in this context`, because window agents are created with `canBlock` false and DoWait says "If mode is sync and AgentCanSuspend() is false, throw a TypeError exception." `Atomics.notify` from the window worked (returned 1 against a parked worker). So the asymmetry holds: worker blocks, window replies async.

**Failure mode, measured:** window-as-kernel, 500 syscalls idle gave p50 0.020 ms. Repeating during a deliberate 400 ms synchronous window task: p50 still 0.020 ms but **max 400.30 ms**. A blocking syscall's worst-case latency equals the kernel's longest task. Every layout storm becomes an fs stall.

## d) The iframe matrix (measured, same run)

| case | crossOriginIsolated | `SharedArrayBuffer` | worker from http URL | blob: worker | SAB sent from top |
|---|---|---|---|---|---|
| same-origin | true | function | ok | ok, COI true | **message** |
| sandbox `allow-scripts allow-same-origin` | true | function | ok | ok | **message** |
| cross-origin, no `allow` | false | undefined | ok (not COI) | ok (not COI) | **messageerror** |
| cross-origin + `allow="cross-origin-isolated"` | **true** | function | ok | ok, COI true | **messageerror** |
| sandbox `allow-scripts` (opaque) | false | undefined | **SecurityError** | ok (not COI) | messageerror |
| sandbox `allow-scripts` + `allow="cross-origin-isolated"` | **true** | function | **SecurityError** | **ok, COI true** | **messageerror** |
| cross-origin without COEP header | — | — | — | — | **frame never loaded** |

Why: `crossOriginIsolated` is the settings object's cross-origin isolated capability, which for a window is "agent cluster's cross-origin-isolation mode is `concrete` **and** the Document is allowed to use the `cross-origin-isolated` feature". That feature's default allowlist is `'self'`, so a cross-origin or opaque-origin frame needs explicit delegation. The last row failed with CDP `Network.loadingFailed`, `blockedReason: "coep-frame-resource-needs-coep-header"`. The `messageerror` rows are the §2.7.3 rule: a SAB "can only be deserialized or received in the agent cluster they were serialized or transferred from"; the send succeeded (`"serialized"`), the receive did not.

Opaque-origin worker refusal, verbatim: `DOMException: Failed to construct 'Worker': Script at 'http://localhost:8731/proc.js' cannot be accessed from origin 'null'.`

## e) A blocked worker

- **Kernel never replies:** worker's promise never settled; main thread ran 32 rAF frames in 500 ms. Parked forever, main thread unaffected.
- **`terminate()`:** not instant. `Atomics.notify` 303 ms after `terminate()` still woke **1**; a single clean probe 5000 ms after `terminate()` woke **0**, while an untouched parked worker probed at 5500 ms woke **1** (negative control). Separately, a worker spinning in `for(;;) Atomics.add(...)` kept advancing its shared counter after `terminate()` and stopped at **2004, 2051, 2003, 2048, 2009 ms** (n=5) — a ~2 s abort grace. Spec: terminate sets the closing flag, discards queued tasks, aborts the running script, and empties the port queue; the terminated worker never replied.
- **Owner document destroyed:** a process worker owned by an iframe, parked on a SAB the top page held — after `iframe.remove()` plus 5 s, notify woke **0**. A worker is only "actively needed" while an owner Document is fully active.

## f) `Atomics.waitAsync`

Non-blocking counterpart; returns `{async, value}` where `value` is a never-rejected promise fulfilling `"ok"` or `"timed-out"`. Measured in the window agent: `{async: true, valueIsPromise: true}`, resolved to `"ok"` on a worker's notify. Support: Chrome 90, Firefox 145, Safari 16.4, Node 16.0.0. It changes nothing above — it cannot give POSIX-shaped code a synchronous return, so it is the kernel-side and window-side tool, not the syscall ABI.

Harness: `/Users/chafyni/.claude/jobs/e856c39e/tmp/` (`server.py`, `run.py`–`run4.py`, `www/`, `results*.json`).

## Claims

- [spec-normative] A dedicated worker's agent is added to the agent cluster that already contains its creator's agent: "Let ownerAgent be outside settings's realm's agent. Set agentCluster to the agent cluster which contains ownerAgent." Two workers spawned by the same window are therefore in the same cluster.
  - https://html.spec.whatwg.org/multipage/webappapis.html#obtaining-a-worker/worklet-agent
- [spec-normative] Dedicated workers are created with canBlock true: "To obtain a dedicated/shared worker agent, given an environment settings object outside settings and a boolean isShared, return the result of obtaining a worker/worklet agent given outside settings, isShared, and true."
  - https://html.spec.whatwg.org/multipage/webappapis.html#obtain-a-dedicated/shared-worker-agent
- [spec-normative] The spec lists "A worker (of any type) and a dedicated worker it created" among pairs that are in the same agent cluster "and thus can use SharedArrayBuffer instances to share memory with each other" — so a nested worker shares the cluster.
  - https://html.spec.whatwg.org/multipage/webappapis.html#integration-with-the-javascript-agent-cluster-formalism
- [spec-normative] Window agents are created with canBlock false: obtain a similar-origin window agent does "Add the result of creating an agent, given false, to agentCluster."
  - https://html.spec.whatwg.org/multipage/webappapis.html#obtain-similar-origin-window-agent
- [spec-normative] [[CanBlock]] is an Agent Record field that "Determines whether the agent can block or not", and AgentCanSuspend() returns it.
  - https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-agentcansuspend
- [spec-normative] DoWait step: "If mode is sync and AgentCanSuspend() is false, throw a TypeError exception." This is why Atomics.wait throws in a window.
  - https://tc39.es/ecma262/multipage/structured-data.html#sec-dowait
- [measured] Measured: Atomics.wait in the top window threw "TypeError: Atomics.wait cannot be called in this context", while Atomics.notify from the same window woke 1 parked worker. Chrome 157.0.8103.38 headless, macOS 26.7.2, Apple M2 Pro; produced by `python run.py` over www/top.html, output results2.json.
  - https://tc39.es/ecma262/multipage/structured-data.html#sec-dowait
- [measured] Measured: sibling worker B woke from Atomics.wait on a SAB minted inside sibling worker A and sent over a MessageChannel the window supplied (result "ok", 150.92 ms; A's notify returned 1). Same run as above; results2.json key tests.siblingViaChannel.
  - https://html.spec.whatwg.org/multipage/webappapis.html#obtaining-a-worker/worklet-agent
- [measured] Measured: a nested worker spawned by a worker blocked and woke on its parent worker's notify ("ok", 144.55 ms, crossOriginIsolated true). results2.json key tests.nestedWorker.
  - https://html.spec.whatwg.org/multipage/webappapis.html#integration-with-the-javascript-agent-cluster-formalism
- [measured] Measured: a worker-resident kernel served 2000 blocking syscalls to a sibling process worker at min 0.00 ms / p50 0.015 ms / p99 0.040 ms / max 0.080 ms, 31.1 ms wall, with the main thread still rendering; 1996 waits returned "ok" and 4 returned "not-equal". results2.json key tests.workerKernelSyscall.
  - https://html.spec.whatwg.org/multipage/webappapis.html#obtaining-a-worker/worklet-agent
- [measured] Measured: with the WINDOW as kernel, syscall latency was p50 0.020 ms idle (n=500) but max 400.30 ms when the window was held in a deliberate 400 ms synchronous task (n=20). www/exp2.html via run2.py, results3.json key mainThreadKernel.
  - https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-forward-progress
- [spec-normative] A window's cross-origin isolated capability is "true if both of the following hold: realm's agent cluster's cross-origin-isolation mode is 'concrete', and window's associated Document is allowed to use the 'cross-origin-isolated' feature."
  - https://html.spec.whatwg.org/multipage/window-object.html#set-up-a-window-environment-settings-object
- [spec-normative] The "cross-origin-isolated" policy-controlled feature "has a default allowlist of 'self'", so a cross-origin or opaque-origin frame needs explicit delegation via the iframe allow attribute.
  - https://html.spec.whatwg.org/multipage/infrastructure.html#policy-controlled-features
- [measured] Measured: a cross-origin iframe (http://127.0.0.1 inside http://localhost) with COEP require-corp plus allow="cross-origin-isolated" reported crossOriginIsolated true, typeof SharedArrayBuffer "function", and constructed an 8-byte SAB; without the allow attribute it reported crossOriginIsolated false and "ReferenceError: SharedArrayBuffer is not defined". results2.json key frames.
  - https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-allow
- [measured] Measured: an opaque-origin sandboxed iframe (sandbox="allow-scripts", no allow-same-origin) with allow="cross-origin-isolated" reported crossOriginIsolated true and constructed a SAB, but refused a network-URL worker with "DOMException: Failed to construct 'Worker': Script at 'http://localhost:8731/proc.js' cannot be accessed from origin 'null'." A blob: worker in it was crossOriginIsolated true with SAB available. results2.json key frames.sandbox-opaque-allow-coi.
  - https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox
- [spec-normative] A SAB "can only be deserialized or received in the agent cluster they were serialized or transferred from... when postMessage() is used to send one to a cross-site iframe, a shared worker, or a service worker, a messageerror event is fired instead of a message event."
  - https://html.spec.whatwg.org/multipage/structured-data.html#restricting-to-the-same-agent-cluster
- [measured] Measured: the top page's postMessage of a SAB serialized successfully for every frame, but arrived as a messageerror event in both cross-origin frames and both opaque-origin frames, and as a normal message event only in the same-origin and allow-same-origin frames. results2.json keys tests.sabToFrame and frames[*].fromParent.
  - https://html.spec.whatwg.org/multipage/structured-data.html#restricting-to-the-same-agent-cluster
- [measured] Measured: an iframe served without a COEP header never loaded inside the require-corp top page. CDP Network.loadingFailed reported errorText "net::ERR_BLOCKED_BY_RESPONSE", blockedReason "coep-frame-resource-needs-coep-header". run2.err from run.py.
  - https://html.spec.whatwg.org/multipage/browsers.html#coep-require-corp
- [measured] Measured: Atomics.notify probed once 5000 ms after terminate() on a worker parked in Atomics.wait(Infinity) woke 0 agents, while the same probe 303 ms after terminate() woke 1, and an untouched parked worker probed at 5500 ms woke 1 (negative control). results3.json keys terminateParkedWorker / parkedWorkerNotTerminated, results2.json key notifyAfterTerminate.
  - https://html.spec.whatwg.org/multipage/workers.html#terminate-a-worker
- [measured] Measured: a worker spinning in `for(;;) Atomics.add(ta,0,1)` kept advancing its shared counter after terminate() and stopped at 2004, 2051, 2003, 2048 and 2009 ms after the call (n=5, 50 ms polling); the same result held with a function call inside the loop. www/exp4.html via run4.py, results5.json.
  - https://html.spec.whatwg.org/multipage/workers.html#dom-worker-terminate
- [spec-normative] terminate a worker "Set the worker's WorkerGlobalScope object's closing flag to true. If there are any tasks queued... discard them without processing them. Abort the script currently running in the worker... empty the port message queue."
  - https://html.spec.whatwg.org/multipage/workers.html#terminate-a-worker
- [spec-normative] A WorkerGlobalScope is "actively needed" only while an owner Document is fully active, and workers are closed as orphans between ceasing to be protected and ceasing to be permissible — so destroying or reloading the owner page terminates its dedicated workers.
  - https://html.spec.whatwg.org/multipage/workers.html#worker-processing-model
- [measured] Measured: a process worker owned by an iframe, parked on a SAB the top page also held, was no longer findable by Atomics.notify 5000 ms after iframe.remove() (woke 0), whereas the same probe before detachment woke 1. results3.json key ownerDocumentDetached.
  - https://html.spec.whatwg.org/multipage/workers.html#worker-processing-model
- [documented] Atomics.waitAsync "is non-blocking and, unlike Atomics.wait(), can be used on the main thread"; it returns {async, value} where an async value is a promise that fulfils with "ok" or "timed-out" and is never rejected.
  - https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/waitAsync
- [documented] Atomics.waitAsync support: Chrome 90, Firefox 145, Safari 16.4, Node 16.0.0 (Chrome 87-89 shipped a partial version that never timed out). From mdn/browser-compat-data javascript/builtins/Atomics.json at commit f0ac50c21ebcebf37f2b4468a0c07de5fcc47577.
  - https://github.com/mdn/browser-compat-data/blob/f0ac50c21ebcebf37f2b4468a0c07de5fcc47577/javascript/builtins/Atomics.json
- [measured] Measured: Atomics.waitAsync in the top window returned {async: true, value: Promise} and the promise resolved to "ok" when a worker called Atomics.notify. results3.json key windowWaitAsync.
  - https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/waitAsync
- [documented] createSyncAccessHandle "is only usable inside dedicated Web Workers for files within the origin private file system" — a kernel that is itself a dedicated worker satisfies this; nothing requires a single owning worker.
  - https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle
- [documented] Nested worker support (creating a Worker from inside a worker): Chrome 69, Firefox 34, Safari 16.4, each marked partial only in that it is unavailable in shared workers. From mdn/browser-compat-data api/Worker.json key worker_support at the same pinned commit.
  - https://github.com/mdn/browser-compat-data/blob/f0ac50c21ebcebf37f2b4468a0c07de5fcc47577/api/Worker.json
- [spec-normative] The HTML spec warns that "Setting both the allow-scripts and allow-same-origin keywords together when the embedded page has the same origin as the page containing the iframe allows the embedded page to simply remove the sandbox attribute and then reload itself, effectively breaking out of the sandbox altogether" — the one iframe flavour that shares the top page's cluster is the one with no real protection.
  - https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox
- [documented] The SharedArrayBuffer constructor "is hidden, unless the two headers mentioned above are set" — matching the observed ReferenceError rather than a DataCloneError in non-isolated frames.
  - https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer

## Design consequences

- The kernel MUST be a dedicated worker, not the window. The window's only jobs are spawning, port brokering, and compositing. This is the whole point of GAP 1 and it is now settled in the affirmative.
- All process workers MUST be same-origin descendants of the kernel's window, because that is what puts them in one agent cluster. A blocking syscall channel cannot cross an origin.
- "Process = cross-origin iframe" FORBIDS a blocking syscall channel to a central kernel. A cross-origin iframe can be crossOriginIsolated and can run its own internal blocking channel to its own workers, but the top page's SAB arrives as messageerror. Choosing Puter-style origin isolation means choosing an async-only (postMessage / waitAsync) FS bridge for those processes.
- A hybrid is available and is probably the right shape: trusted system processes are same-origin workers on the blocking channel; untrusted third-party apps are cross-origin iframes with a per-origin satellite kernel that talks to the real kernel asynchronously. Two FS paths, one of them sync, must then be designed deliberately rather than discovered.
- Every iframe used as a process MUST send Cross-Origin-Embedder-Policy: require-corp, or it will not load at all inside the isolated top page. This forces a server (or service worker) that controls headers per app, not static file hosting.
- Every cross-origin iframe process MUST be given allow="cross-origin-isolated" or it gets no SharedArrayBuffer at all — the constructor is absent, not merely restricted.
- An opaque-origin sandboxed iframe (sandbox without allow-same-origin) CAN be crossOriginIsolated and hold a SAB, but can only load workers from blob: URLs. Any app loader for that tier must fetch app code and wrap it in a Blob, which means the loader, not the browser, enforces the code's provenance.
- kill(9) is not synchronous. A spinning worker took ~2.0 s to stop; a worker parked on a syscall stayed on the wait list for at least 303 ms after terminate(). The process table MUST model a DYING state with a visible timer, and the window manager MUST tear the window down before the worker is gone.
- The kernel MUST answer every syscall, including with an error code, and process-side waits MUST use a finite timeout with a retry loop rather than Infinity. A worker parked on Infinity with a dead kernel is a zombie that terminate() only reaps on the engine's own schedule.
- Reloading or destroying the kernel's window reaps every process worker it owns (measured: 0 waiters after the owner document was detached). There is no process survival across a kernel reload, so the FS, not worker memory, is the only durable state.
- Atomics.waitAsync does not substitute for the blocking channel: POSIX-shaped and WebAssembly-compiled code needs a synchronous return. Use it on the kernel side and for any main-thread wait, and note its Firefox floor is version 145 — recent enough to matter for a support matrix.

## Could not determine

- All empirical results are Chrome 157.0.8103.38 headless on macOS 26.7.2 / Apple M2 Pro only. Firefox and Safari were not available on this machine, so the iframe matrix, the ~2 s terminate() latency, and the syscall round-trip figures are unverified on Gecko and WebKit. The iframe/COI behaviour is spec-derived and should hold; the kill latency is almost certainly engine-specific.
- The exact instant at which terminate() removes a worker parked in Atomics.wait is bracketed but not pinned: a waiter was still present at 303 ms and absent at 5000 ms. I did not bisect it, because each probe is itself a wake and destroys the state being measured; a clean bisection needs one fresh worker per sample point.
- Whether the ~2.0 s abort latency for a spinning worker is a documented Chrome grace period or an artifact of this build. The number is tightly reproducible (2003-2051 ms, n=5) but I found no Chromium source or bug citation for it and will not guess one.
- COEP: credentialless was not tested as an alternative to require-corp for iframe processes. It could relax the per-app header requirement; unmeasured.
- Whether OPFS createSyncAccessHandle and its locking behave identically in a nested worker versus a top-level dedicated worker. MDN says any dedicated worker qualifies, but I did not run a sync access handle in a nested worker, and the multiple-handle/`readwrite-unsafe` locking question that would decide whether the kernel can shard handles across workers is untested.
- The ~15 us syscall figure is for a kernel whose work is a single `await Promise.resolve()`. A kernel doing a real OPFS read per syscall was not measured, so that number is a channel floor, not a filesystem syscall cost.
- Whether a SharedWorker or ServiceWorker could act as the kernel: the spec explicitly places both outside the window's cluster, so no blocking channel is possible, but I did not test them.
- Process-count limits. navigator.hardwareConcurrency reported 12 on this machine; I did not probe how many simultaneously parked workers Chrome will sustain before scheduling degrades, which bounds the practical process table size.
