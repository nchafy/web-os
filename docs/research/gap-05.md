# GAP 5: deployability (can COOP/COEP actually be set on the hosts a solo builder would use, and what breaks) and the unstated threat model - the two constraints that pick web-os's architecture.

## Verdict

COOP/COEP are settable on every surveyed host except GitHub Pages and bare S3, so the blocking-syscall design is deployable on static hosting. But `require-corp` is the only Safari-portable value, which forces self-hosting every asset and kills third-party iframe embeds. The architecture-deciding fact nobody has stated: a SharedArrayBuffer is restricted to one agent cluster and cross-origin isolation makes agent clusters origin-keyed, so per-app-origin isolation and a shared blocking channel are mutually exclusive - each app origin needs its own SAB plus an async broker hop to the host kernel. Pick threat model (i), first-party only, for v1.

## Detail

## A1 - can you set the headers?

| Host | COOP/COEP | Mechanism |
|---|---|---|
| GitHub Pages | **No** | No header config exists. GitHub staff: a permissive CORS header is "the current (sensitive) behavior in place until we can support custom headers" |
| Cloudflare Pages | Yes | `_headers` in asset dir; <=100 rules, <=2000 chars/line; not applied to Functions output |
| Netlify | Yes | `_headers` or `[[headers]]` in `netlify.toml`; static files only, not functions/proxies |
| Vercel | Yes | `vercel.json` `headers` key |
| Firebase Hosting | Yes | `hosting.headers[].{source, headers:[{key,value}]}` |
| S3 alone | **No** | Settable response metadata is a closed list (Cache-Control, Content-*, Expires...); custom keys must be `x-amz-meta-*` |
| S3 + CloudFront | Yes | Response headers policy -> **Custom headers** section (COOP/COEP are not in the managed "security headers" set, so use Custom headers) |
| nginx | Yes | `add_header Name Value always;` - and note a child `location` with any `add_header` drops the inherited set unless `add_header_inherit merge` (nginx 1.29.3+) |

## A2 - what breaks under require-corp

Rule: a cross-origin **no-cors** subresource needs `Cross-Origin-Resource-Policy`; a **cors**-mode request is not blocked by COEP and only needs CORS.

Measured 2026-11-11 with `curl -s -o /dev/null -D - -A "Mozilla/5.0" <url>`, curl 8.7.1, Darwin 25.6.0 arm64:

| Resource | CORP | ACAO | Verdict under require-corp |
|---|---|---|---|
| `fonts.googleapis.com/css2` | `cross-origin` | `*` | loads |
| `fonts.gstatic.com/.../*.woff2` | `cross-origin` | `*` | loads |
| `cdn.jsdelivr.net`, `unpkg.com` | `cross-origin` | `*` | loads |
| `tile.openstreetmap.org/0/0/0.png` | **absent** | `*` | **blocked** as `<img src>`; fixed by `crossorigin="anonymous"` |
| `upload.wikimedia.org/...svg` | **absent** | `*` | same |
| `youtube.com/embed/...` | `cross-origin` | - | **blocked**: it sends `cross-origin-embedder-policy-report-only: require-corp`, i.e. COEP is not enforced, and a nested document needs COEP require-corp/credentialless **plus** CORP cross-origin |

So: CDNs for fonts/JS are already fine; map tiles and arbitrary images need `crossorigin`; third-party iframes are the real casualty. Blocked scripts and styles fail silently; blocked images are visible.

**COEP credentialless** drops the CORP requirement for no-cors subresources (fetched without credentials) and still counts as compatible with cross-origin isolation. Support: Chrome 96, Firefox 119, **Safari: no**. It does *not* rescue iframes. The `credentialless` *iframe attribute* does, but it is Chrome 110 only. Net: credentialless rescues nothing you can rely on cross-browser, and iframes are unrescuable. An embedded document that itself wants isolation also needs `allow="cross-origin-isolated"` (a policy-controlled feature, experimental in Chrome 85).

## A3 - service worker

Your belief is correct. COOP and COEP are obtained *from a response's header list* (HTML spec "obtain an opener policy" / "obtain an embedder policy"), so a SW-synthesized response works. But a SW cannot control the navigation that registers it: "pages won't use it until they next load." `coi-serviceworker` (MIT) therefore reloads once on first load. First load is **not** isolated: no SAB, no `crossOriginIsolated`. Cost: HTTPS only, a separate unbundled same-origin script, one visible reload, and nothing for users with SWs disabled.

## A4 - fallback tier

Blocking does **not** require SAB. `sync-message` (MIT) falls back to a SW channel implemented with synchronous XHR from a worker - `request.open("POST", url, false)` - and MDN states "Synchronous requests are permitted in Workers." So the degraded tier still has blocking syscalls, at HTTP-roundtrip-to-SW latency, 128 KiB default message cap, JSON-only payloads, one in-flight message per channel.

Only if *both* SAB and SW are unavailable do you lose blocking. Then `Atomics.wait` is unavailable and on the main thread it throws `TypeError` anyway. A shell cannot then implement `read(0)` as a blocking call: every syscall becomes a promise, so the shell must be written async-first (await every builtin), pipelines cannot be a pull loop, and any guest code compiled to expect blocking I/O (or Asyncify-free wasm) is out. OPFS `createSyncAccessHandle` is unaffected - it needs a dedicated worker, not isolation - so storage stays synchronous in every tier.

## B - threat model

| | Enforcement | Rules out | Cost |
|---|---|---|---|
| (i) first-party | Worker boundary + syscall ABI only | nothing hostile; gives kill/background/namespaces | lowest; the boundary you already designed |
| (ii) third-party, static, no server | **Per-app origin** is the only real boundary. Needs: one subdomain per app + wildcard DNS + a wildcard TLS cert (DNS-01). No dynamic server needed: one Cloudflare Pages project allows 100 custom domains on Free and one `_headers` file covers them all; or one CloudFront distribution with `*.apps.example.com` as a wildcard alternate domain name. Serve the *same* bundle on every subdomain and pick the app from `location.hostname`. | cross-app storage reads, direct kernel calls | DNS + cert ops, plus the SAB redesign below |
| (iii) multi-user + server | Puter-style. Its self-hosting doc is explicit: "you need a wildcard record (`*.your-domain.com` -> server IP). Puter routes by subdomain", serving "a subdomain it invents at runtime (`<name>.site.<domain>`, `<name>.app.<domain>`)", with a per-launch token passed as `puter.auth.token` | cross-user reads; enables revocation, quotas, audit | a server, a DB, auth, token minting, abuse handling |

**Pick (i) for v1.** (ii) costs you a domain, a wildcard cert, and a two-hop syscall path, and still cannot stop a hostile app from burning CPU or spamming the kernel - so it buys origin-level storage separation and nothing else. Ship (i); keep the syscall ABI origin-agnostic (postMessage-shaped, no shared globals) so (ii) is a deployment change, not a rewrite.

## C - fonts and assets

Segoe UI: naming it in a CSS stack is **explicitly permitted** - "you don't even need to be a Windows licensee to include a Windows font name in a CSS font stack." Self-hosting or WOFF-converting it is **not**. Segoe UI can be licensed from Monotype; Segoe UI Variable cannot be licensed outside Microsoft products.

Selawik: licence confirmed **OFL-1.1**, `LICENSE.txt`, "Reserved Font Name Selawik" (so a modified fork must be renamed). Two cautions the repo makes plain: metric compatibility is **not claimed** - Microsoft says only "an open source replacement for Segoe UI," and the README lists "Selawik is missing kerning to match Segoe UI" as an open issue; and the repo ships **no built fonts** (0 `.ttf`/`.woff` files in the tree at `89362e8`; only `.glyphs` and five `.ufo` sources), so you must build with fontmake. Coverage is Latin only (`dlng:'Latn'`, codepages 1252/1250/1254/1257) - no Cyrillic, Greek or CJK. Metrics from `Selawik-Regular.ufo/fontinfo.plist`: unitsPerEm 2048, ascender 1491, descender -431, capHeight 1434, xHeight 974.

Fallback stack: `font-family: "Segoe UI", Selawik, system-ui, "Helvetica Neue", Arial, sans-serif` - Segoe UI first so Windows users get the real thing for free, Selawik self-hosted for everyone else.

Icons and bitmaps: **redraw, or use an openly licensed set.** Microsoft's permissions page allows product icons only "in training manuals or documentation about a Microsoft product," forbids them "as a graphical or design element," forbids use "in software applications," and forbids screenshots of boot-up/opening/splash screens and including screenshots "in your product's user interface." There is no legally clean source for Windows 7 Aero icon or bitmap files. `microsoft/fluentui-system-icons` is MIT and is the closest first-party legal substitute, but it is Fluent, not Aero - the Aero glass, gradients and glyphs must be authored from scratch.

## Claims

- [documented] GitHub Pages cannot set custom HTTP response headers; GitHub staff describe the permissive CORS header as in place 'until we can support custom headers'.
  - https://github.com/orgs/community/discussions/22399
- [documented] Cloudflare Pages supports a plain-text `_headers` file in the static asset directory, limited to 100 header rules and 2,000 characters per line; it does not apply to Pages Functions responses.
  - https://developers.cloudflare.com/pages/configuration/headers/
- [documented] Netlify supports a `_headers` file in the publish directory or `[[headers]]` tables in netlify.toml; headers apply only to statically served files, not to functions, edge functions, proxied content or SSR.
  - https://docs.netlify.com/manage/routing/headers/
- [documented] Vercel exposes a `headers` property in vercel.json to 'Add custom HTTP headers to responses'.
  - https://vercel.com/docs/project-configuration
- [documented] Firebase Hosting sets arbitrary response headers via a `headers` array under `hosting` in firebase.json, each entry a `source` plus `key`/`value` pairs; the only documented override is Strict-Transport-Security on default subdomains.
  - https://firebase.google.com/docs/hosting/full-config
- [documented] S3 alone cannot return COOP/COEP: user-controllable response metadata is a closed list (Cache-Control, Content-Disposition, Content-Encoding, Content-Type, Expires, x-amz-*), and user-defined metadata names must begin with `x-amz-meta-`.
  - https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingMetadata.html
- [documented] A CloudFront response headers policy has a 'Custom headers' section that adds arbitrary headers to every response; COOP and COEP are not among the built-in 'Security headers' options, so they must go in Custom headers. The disallowed list applies only to header *removal*.
  - https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/understanding-response-headers-policies.html
- [spec-normative] nginx `add_header name value [always]` works in http/server/location; without `always` the header is only added for codes 200, 201, 204, 206, 301, 302, 303, 304, 307, 308, and a child level defining any add_header drops the inherited set unless `add_header_inherit merge` (1.29.3+) is used.
  - https://nginx.org/en/docs/http/ngx_http_headers_module.html
- [spec-normative] Under COEP require-corp, a cross-origin no-cors resource loads only if it sends a permitting CORP header; requests in cors mode are not blocked by COEP and need only satisfy CORS.
  - https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy
- [documented] COEP support: Chrome 83, Firefox 79, Safari 15.2. COEP `credentialless`: Chrome 96, Firefox 119, Safari not supported. `crossOriginIsolated`: Chrome 87, Firefox 72, Safari 15.2. The `credentialless` iframe attribute: Chrome 110 only; Firefox and Safari no.
  - https://github.com/mdn/browser-compat-data/tree/f0ac50c21ebcebf37f2b4468a0c07de5fcc47577/http/headers
- [measured] Measured 2026-11-11 (curl 8.7.1, Darwin 25.6.0 arm64, `curl -s -o /dev/null -D - -A "Mozilla/5.0" <url>`): fonts.googleapis.com/css2, fonts.gstatic.com woff2, cdn.jsdelivr.net and unpkg.com all return `cross-origin-resource-policy: cross-origin` and `access-control-allow-origin: *`, so they load under require-corp unchanged.
  - https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Resource-Policy
- [measured] Measured same run: tile.openstreetmap.org/0/0/0.png and upload.wikimedia.org SVGs return `access-control-allow-origin: *` but NO CORP header, so they are blocked as plain `<img src>` under require-corp and must be requested with `crossorigin="anonymous"`.
  - https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy
- [measured] Measured same run: https://www.youtube.com/embed/dQw4w9WgXcQ returns `cross-origin-resource-policy: cross-origin` but only `cross-origin-embedder-policy-report-only: require-corp` - COEP is not enforced - so the embed is blocked in a require-corp document, which requires nested documents to send COEP require-corp/credentialless AND CORP cross-origin.
  - https://developer.chrome.com/blog/coep-credentialless-origin-trial
- [documented] COEP credentialless does not rescue iframes: loading cross-origin iframes under credentialless 'still requires the same conditions as require-corp'. Only the `credentialless` iframe attribute drops the COEP requirement for that frame.
  - https://developer.mozilla.org/en-US/docs/Web/Security/IFrame_credentialless
- [spec-normative] An embedder policy value is compatible with cross-origin isolation if it is 'credentialless' or 'require-corp' - so credentialless still yields crossOriginIsolated and SharedArrayBuffer.
  - https://html.spec.whatwg.org/multipage/browsers.html#coep
- [spec-normative] COOP and COEP are obtained from a *response's* header list ('obtain an opener policy given a response response', 'obtain an embedder policy from a response response'), which is why a service-worker-synthesized response can supply them.
  - https://html.spec.whatwg.org/multipage/browsers.html#obtain-an-embedder-policy
- [documented] A service worker cannot affect the navigation that registers it: 'When a service worker is initially registered, pages won't use it until they next load.' coi-serviceworker (MIT) therefore reloads the page on the user's first load; the first load is not cross-origin isolated.
  - https://github.com/gzuidhof/coi-serviceworker
- [measured] The Service Worker specification contains zero occurrences of 'embedder' - verified by `curl -sL https://w3c.github.io/ServiceWorker/ | grep -c -i embedder` returning 0 on 2026-11-11 - so there is no spec-level rule requiring a service worker's COEP to match its client's.
  - https://w3c.github.io/ServiceWorker/
- [documented] Synchronous XMLHttpRequest is permitted in Workers ('Synchronous requests are permitted in Workers'), and sync-message (MIT) uses exactly that - `request.open("POST", url, false)` - as its service-worker fallback channel when SharedArrayBuffer is unavailable. Caveats: 128 KiB default buffer, JSON-only payloads, one message in flight, and the SW must already control the page.
  - https://github.com/alexmojaki/sync-message/blob/071e699508228d324cd62d40e401b4018b14b2bb/lib/index.ts
- [spec-normative] Atomics.wait 'is blocking and cannot be used in the main thread' and throws TypeError if the current thread cannot be blocked.
  - https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait
- [spec-normative] SharedArrayBuffer objects are restricted to the same agent cluster: 'they can only be deserialized or received in the agent cluster they were serialized or transferred from... when postMessage() is used to send one to a cross-site iframe, a shared worker, or a service worker, a messageerror event is fired instead of a message event.'
  - https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializewithtransfer
- [spec-normative] Documents whose agent cluster has a cross-origin isolation mode other than 'none' are automatically origin-keyed - so under cross-origin isolation two different origins are in different agent clusters and cannot share a SharedArrayBuffer.
  - https://html.spec.whatwg.org/multipage/browsers.html#coop
- [documented] A nested document that itself wants cross-origin isolation needs the `cross-origin-isolated` policy-controlled feature granted, e.g. `allow="cross-origin-isolated"`; the feature is registered as HTML-defined and 'Experimental in Chrome 85'.
  - https://github.com/w3c/webappsec-permissions-policy/blob/229db48df209993f436f677cb99b282596bc67ee/features.md
- [documented] Per-app origin on static hosting needs wildcard DNS and a wildcard certificate, not a dynamic server: a CloudFront distribution can take `*.example.com` as a wildcard alternate domain name, provided the attached certificate's SAN covers it.
  - https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html
- [documented] One Cloudflare Pages project allows 100 custom domains on the Free plan (250 Pro, 500 Business/Enterprise), with 100 projects per account - enough to give ~100 apps their own origin from a single static deployment and a single `_headers` file.
  - https://developers.cloudflare.com/pages/platform/limits/
- [documented] Puter's per-app origin requires wildcard DNS and a wildcard cert: 'you need a wildcard record (*.your-domain.com -> server IP). Puter routes by subdomain (api.<domain>, site.<domain>, app.<domain>)', and it 'serves every user's site and app on a subdomain it invents at runtime (<name>.site.<domain>, <name>.app.<domain>), which needs a wildcard cert - and wildcards require DNS-01'.
  - https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/doc/self-hosting.md
- [documented] Puter hands a launched app a token on its iframe URL as `puter.auth.token`, with a separate 'godmode' full-access token path for privileged apps.
  - https://github.com/HeyPuter/puter/blob/711ece5800e7ac527f9e84c397d671e110a75476/src/gui/src/helpers/launchApp.js
- [documented] Puter apps are storage-sandboxed per app: each gets `~/AppData/<app-id>/` and 'will not be able to access any files or data outside of this directory by default', plus a per-app key-value store no other app can read.
  - https://docs.puter.com/security/
- [documented] Selawik is licensed under SIL Open Font License 1.1 with Reserved Font Name 'Selawik' (so a modified fork must be renamed), copyright 2015 Microsoft Corporation.
  - https://github.com/microsoft/Selawik/blob/89362e84731d1f5777fa078fd4d5ebbd339e4378/LICENSE.txt
- [documented] Microsoft does not claim Selawik is metric-compatible with Segoe UI - only 'an open source replacement for Segoe UI' - and lists 'Selawik is missing kerning to match Segoe UI' as a known open issue.
  - https://github.com/microsoft/Selawik/blob/89362e84731d1f5777fa078fd4d5ebbd339e4378/README.md
- [measured] The microsoft/Selawik repository ships no built font binaries: the full tree at 89362e8 contains 0 files matching .ttf/.otf/.woff/.woff2 (counted from the recursive git-tree listing), only selawik.glyphs and five .ufo source directories. Built TTFs (selawk.ttf, selawkb, selawkl, selawksb, selawksl) are listed by Microsoft but must be produced from source.
  - https://api.github.com/repos/microsoft/Selawik/git/trees/89362e84731d1f5777fa078fd4d5ebbd339e4378?recursive=1
- [documented] Selawik ships five styles (Regular, Bold, Light, Semibold, Semilight) and covers Latin only: dlng 'Latn', code pages 1252, 1250, 1254, 1257. No Cyrillic, Greek or CJK.
  - https://learn.microsoft.com/en-us/typography/font-list/selawik
- [measured] Selawik-Regular metrics read from the pinned UFO source: unitsPerEm 2048, ascender 1491, descender -431, capHeight 1434, xHeight 974.
  - https://github.com/microsoft/Selawik/blob/89362e84731d1f5777fa078fd4d5ebbd339e4378/Source%20files/UFO/Selawik-Regular.ufo/fontinfo.plist
- [documented] Naming Segoe UI in a CSS font stack is explicitly permitted without a Windows licence: 'Web content publishers are free to specify Windows supplied fonts in their font stacks... you don't even need to be a Windows licensee'. Self-hosting or WOFF/WOFF2-converting Windows fonts is explicitly not permitted, and 'converting Windows fonts to other formats does not change the rules'.
  - https://learn.microsoft.com/en-us/typography/fonts/font-faq
- [documented] Segoe UI can be licensed from Monotype for non-Windows apps; Segoe UI Variable 'is not available for licensing or use outside of Microsoft products or on non-Windows platforms'.
  - https://learn.microsoft.com/en-us/typography/fonts/font-faq
- [documented] There is no legally clean source for Windows 7 Aero icons or bitmaps. Microsoft permits product icons only 'in training manuals or documentation about a Microsoft product', forbids using an icon 'as a graphical or design element' and forbids icon use 'in software applications'; it also forbids screenshots of boot-up, opening or splash screens and forbids including screenshots 'in your product's user interface'.
  - https://www.microsoft.com/en-us/legal/intellectualproperty/permissions
- [measured] microsoft/fluentui-system-icons is MIT-licensed (GitHub licence API reports spdx_id MIT) and is the closest first-party legally clean icon source - but it is Fluent, not Aero.
  - https://github.com/microsoft/fluentui-system-icons/blob/main/LICENSE
- [measured] github.io, pages.dev, netlify.app, vercel.app, web.app, firebaseapp.com, workers.dev and puter.site are all on the Public Suffix List (each matched exactly once in the 16,609-line list fetched 2026-11-11), so sibling subdomains on those hosts are separate sites, not just separate origins.
  - https://publicsuffix.org/list/public_suffix_list.dat

## Design consequences

- GitHub Pages is eliminated as the deploy target for the header-based design. The only path there is coi-serviceworker, which costs an unconditional reload on first load and leaves the first paint un-isolated.
- `require-corp` is the only value that works in Safari (credentialless: Chrome 96 / Firefox 119 / Safari none). Design for require-corp and treat credentialless as a Chrome/Firefox-only relaxation, not a plan.
- Self-host every font, icon and bitmap. Any remote image or tile must carry `crossorigin="anonymous"`, which means it is in your markup's control - so route all remote media through one helper that sets it.
- Third-party iframe embeds (YouTube, maps, OAuth widgets) cannot run inside the isolated document. Measured: YouTube sends CORP cross-origin but only COEP-Report-Only, so it is blocked. Put such content in a separate non-isolated top-level window, or do not have it.
- SharedArrayBuffer cannot cross an origin boundary: it is restricted to one agent cluster, and an isolated document's agent cluster is origin-keyed. If you ever go per-app-origin, each app origin needs its own SAB, its own isolation headers, `allow="cross-origin-isolated"` on its iframe, and a per-origin broker worker that does the async postMessage to the host kernel and Atomics.notify on reply. Two hops, not one.
- Build the syscall channel behind an interface with two implementations from day one: SAB+Atomics, and SW+synchronous-XHR. The second keeps blocking semantics without crossOriginIsolated, so the shell never needs an async-only code path. Fully-async is the third tier and should be a degraded UI, not a second shell.
- Keep the first load usable without isolation. Under coi-serviceworker the first navigation is not isolated, so boot must either defer process start until after the reload or run the kernel in async mode for one paint.
- Per-app origin on static hosting is achievable without a server, but it requires owning a domain, wildcard DNS and a wildcard cert, and it caps out at enumerated subdomains (100 custom domains per Cloudflare Pages project on Free). Treat it as a v2 deployment mode, keep the ABI postMessage-shaped so nothing in the kernel assumes same-origin.
- Do not plan on Segoe UI metrics. Selawik is not documented as metric-compatible and must be built from source; layouts must be tested against both Segoe UI and Selawik, and must not depend on Latin-only coverage for UI text that may be localized.
- Aero visuals are an authoring cost, not an asset-acquisition cost. Budget for redrawing the icon set and the glass chrome.

## Could not determine

- Whether Selawik is metric-compatible with Segoe UI. Neither the microsoft/Selawik README nor learn.microsoft.com/typography/font-list/selawik claims it, and the README lists missing kerning as an open issue. I could not measure it: Segoe UI is not installed on this machine (Darwin 25.6.0 arm64) and cannot be legally obtained for comparison.
- Whether Cloudflare Pages supports a *wildcard* custom domain on a project. The limits page documents 100 custom domains per project on Free but says nothing about wildcards, so the per-app-origin scheme on Cloudflare may need each subdomain enumerated.
- Whether Chrome desktop's SharedArrayBuffer-without-isolation deprecation trial has ended. developer.chrome.com/blog/enabling-shared-array-buffer says it was extended 'until Chrome 124' and does not state the outcome.
- Safari's behaviour with a service-worker-synthesized COOP/COEP response. The coi-serviceworker README does not mention Safari and I ran no browser test.
- Puter's per-(user,app) token semantics beyond what the source shows. src/gui/src/helpers/launchApp.js passes `puter.auth.token` on the iframe URL and distinguishes 'godmode' tokens from per-app tokens, but I did not read the backend minting or scoping logic.
- Any runtime measurement of crossOriginIsolated, Atomics.wait latency, or sync-XHR syscall latency. No browser was run in this task; all browser-support figures come from mdn/browser-compat-data at commit f0ac50c21ebcebf37f2b4468a0c07de5fcc47577, not from execution.
- Whether service workers are available in private/incognito windows in each engine, which bounds the coi-serviceworker fallback.
- Netlify, Vercel and Firebase per-project subdomain/custom-domain counts, which would decide whether the per-app-origin scheme is portable off Cloudflare and CloudFront.
