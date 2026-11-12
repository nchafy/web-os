# Fidelity First

> **Superseded in one respect.** This document states that Browsix found `fork` incompatible with a
> blocking syscall channel. That is wrong — Browsix found no way to spill a call stack except
> Emterpreter, and its §6 says SharedArrayBuffers plus a `setcontext` equivalent would have made
> fork a *synchronous* syscall. `fork` was later demonstrated working in Chrome 157 for this
> project. The conclusion (no fork) survives for different reasons: see `../CONSTRAINTS.md`
> constraint 20 and `../research/gap-07-fork.md`. The rest of this document stands as written.

**An experience-first architecture for web-os.** One developer, ~155 days.

The bet: a correct kernel nobody can see is worth less than Aero Snap that feels exactly
right. The runtime must still have a real boundary — webxp proved discipline alone fails —
but every boundary in this design is chosen for what it buys the surface.

---

## 0. The position, in one page

Three claims, in order of how much they cost to be wrong.

**1. The real Aero composite is one SVG `feColorMatrix` inside a `backdrop-filter` chain.**
Not a stack of translucent overlays, not an approximation. The DWM recipe is affine in the
blurred backdrop, so it collapses to a single 4x5 matrix. This is derived in §2 and it is
the reason this design picks DOM glass over a WebGL compositor. It is also unmeasured, so
it is milestone 1.

**2. The measured 58-63 M blurred-device-px budget does not bind, because Windows 7 never
had full-bleed glass.** Aero glass is the *frame*. The UX Guide says so: glass extends only
into "small regions touching the window frame without text"
([uxguide/win-window-frames.md](https://github.com/MicrosoftDocs/win32/blob/51c9b7cc54ef393b6406c8320a7840fdd88209d5/desktop-src/uxguide/win-window-frames.md)).
Frame-only glass is 10.1x cheaper than full-bleed at 640x440 and 17.0x cheaper full-screen
(§3). The budget moves from ~51 windows to ~519. A web OS that glasses whole client areas
is not more Aero, it is less — and it is also the only version that hits the wall.

**3. Processes must not own DOM — not for security, but for fidelity.** webxp failed because
each app *was* its window (`mount(root)`), so nothing was killable, backgroundable or
isolated. The fix that also buys the most surface quality is the strongest one: a process
owns a *surface*, the shell owns all chrome and all DOM. That gives one uniform frame for
every window (so Aero is consistent, not per-app), it gives the shell the window's widget
tree *as data* (so a taskbar thumbnail is a second live mount at `scale(0.25)`, not a
rasterisation), and it gives a kill that tears the window down before the worker is gone.

What this design does **not** believe: that Element Capture is the route to live thumbnails.
It needs a `getDisplayMedia` permission prompt every session
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/BrowserCaptureMediaStreamTrack/restrictTo)),
and its `restrictTo()` eligibility rules require the target to form a backdrop root
([element-capture](https://screen-share.github.io/element-capture/)) — which is exactly what
stops `backdrop-filter` from seeing the desktop
([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter)). Asking the user
to share their own tab before the desktop can show a thumbnail is an experience-first
design's worst possible first 60 seconds. Declined, with a replacement (§5.4).

---

## 1. The compositor question, priced

### 1.1 The three tiers

06-aero-spec.md names three. Here is what each costs against the measured budget and against
the surface.

| | Tier 1: DOM + `backdrop-filter` | Tier 2: + Element/Region Capture | Tier 3: Canvas/WebGL compositor |
|---|---|---|---|
| Glass fidelity | exact, if `url()` works in the filter chain (§2) | same as T1 | exact, unconditionally |
| Blurred px/frame | 0.112 M per 640x440 window (frame-only) | same | 0 — one full-screen pass |
| Budget headroom at 58 M | 519 windows | 519 | n/a |
| Thumbnails | process-supplied bitmap + widget re-mount | true live capture | free (`transferToImageBitmap`) |
| First-paint cost | none | **a tab-share permission prompt, every session** | none |
| Portability | `-webkit-backdrop-filter` needed < Safari 18; Firefox < 123 drops it on unknown GPU vendors | Chromium only, not Baseline | WebGL2 portable; WebGPU is not (no Linux Chrome < 144, no Firefox Android) |
| Native text input | yes | yes | **no** |
| IME | yes | yes | **no** |
| Accessibility tree | yes | yes | **no** |
| Text selection, native scrollbars, find-in-page | yes | yes | **no** |
| Conflict | a window animating `opacity` severs the blur chain | backdrop-root requirement fights glass on the same node | — |

### 1.2 The pick: Tier 1, frame-only glass, shell-owned chrome

Named fidelity tier: **"DOM glass, shell-owned chrome, process-supplied thumbnails."**

Reasoning, in the order that decides it.

**Tier 2 is eliminated by its prompt.** One `getDisplayMedia` grant per session, before the
taskbar can show anything. An experience-first design cannot spend its first interaction on
a browser security dialog. Its eligibility rules also force the capturable node and the glass
node to be different elements, which doubles the frame's DOM for a Chromium-only feature.

**Tier 3 is eliminated by what it takes from the client area.** A canvas compositor gives
exact glass unconditionally and free thumbnails, and if apps already painted their own
pixels it would be the right answer. But then there is no native text input, no IME, no
accessibility tree, no text selection and no native scrollbar anywhere in the OS — every
widget is re-implemented, including a text editor with bidi and composition. For a solo
developer that is not a compositor decision, it is a second OS. And a canvas compositor that
hosts DOM apps must rasterise them, which lands on html-to-image: it cannot capture
cross-origin iframes, does not paint `<video>`/`<canvas>` the way the compositor does, and
daedalOS patches it with a `skipMediaContent` flag and re-composites live media per frame
([useWindowPeek.ts](https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/components/system/Taskbar/TaskbarEntry/Peek/useWindowPeek.ts)).
Tier 3's advantage evaporates the moment a DOM app exists.

**Tier 1's two known problems both have answers.**

*The budget.* Resolved by frame-only glass (§3). 519 windows of headroom, against a process
table capped at 512.

*The animation conflict.* `backdrop-filter` is cut off at the nearest backdrop root, and
backdrop roots include any ancestor with `filter`, `opacity < 1`, `mask`, `clip-path`,
`backdrop-filter`, `mix-blend-mode`, or `will-change` naming one of those
([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter)). So the usual
"animate the window wrapper's opacity on open" kills glass for every descendant. `transform`
is **not** on that list. Therefore: **no window wrapper ever animates opacity, filter, mask,
clip-path or mix-blend-mode. Open, close, minimise and restore are `transform` only.** This
is an invariant, not a preference, and M1 checks it by sampling a pixel inside the glass band
mid-animation. The minimise animation becomes a `transform` toward the taskbar button's rect,
which is what Win7's genie effect looks like anyway.

### 1.3 What "a compositor owning the backdrop" means concretely

One module, `src/compositor.mjs`, on the main thread, owning a fixed five-layer stack:

```
#root                     the ONLY backdrop root in the document
├─ #wallpaper             background-image or a worker-driven <canvas> (OffscreenCanvas transfer)
├─ #highlight             position: fixed, the aeropeek streak bitmap, MONITOR-anchored
├─ #windows               every window frame is a DIRECT child. flat. no wrappers.
│  └─ .frame[data-winid]  stacking by z-index only
│     ├─ .glass           backdrop-filter: blur(9px) url(#aero-glass-active)
│     ├─ .caption         title, icon, 3 buttons
│     └─ .client          widget subtree, or a <canvas>
├─ #taskbar               its own .glass, same matrix
└─ #overlay               menus, peek flyouts, snap ghost, dialogs — above everything
```

Invariants the harness asserts (M1, M4):

- `#root` is the only element in the document with `backdrop-filter` set on an ancestor path
  to a window. Every `.frame` is a direct child of `#windows`, which has no backdrop-root
  property.
- No `.frame` and no ancestor of one ever carries `opacity`, `filter`, `mask`, `clip-path`,
  `mix-blend-mode`, or `will-change` naming them — checked by reading computed style on every
  live frame on every check, not by convention.
- The highlight layer is `position: fixed` and its transform is
  `translate(calc(var(--wx) * -0.1), calc(var(--wy) * -0.1))` relative to the focused
  window's position, reproducing DWM's `parallaxIntensity = 0.1`
  ([GlassReflectionBackdrop.hpp](https://github.com/Maplespe/DWMBlurGlass/blob/8c69c9c4de8994c5cc45fdc7ccde9848ec0997dd/DWMBlurGlassExt/Backdrops/GlassReflectionBackdrop.hpp)).
  A window sliding under a stationary streak is the single most recognisable Aero tell, and
  no surveyed web OS has it: 7.css gets the viewport-anchored gradient
  ([_window.scss](https://github.com/khang-nd/7.css/blob/7d3958e707ba97a0718638c273ffeef27ebed73c/gui/_window.scss))
  but has no window manager to move anything under it.

---

## 2. The exact Aero shader, as one matrix

### 2.1 The derivation

The DWM colorization effect is
`result = blurBalance*B + luminance709(B)*afterglowRGB + colorBalance*colorRGB`, composited
`PLUS`, where `luminance709 = dot(rgb, (0.2126, 0.7152, 0.0722))`
([AeroColorizationEffect.hlsl](https://github.com/ALTaleX531/OpenGlass/blob/46e3f13cabdc4c38f43df984e278359207d37285/OpenGlass/AeroColorizationEffect.hlsl),
corroborated by
[AeroBackdrop.hpp](https://github.com/Maplespe/DWMBlurGlass/blob/8c69c9c4de8994c5cc45fdc7ccde9848ec0997dd/DWMBlurGlassExt/Backdrops/AeroBackdrop.hpp)).
Windows 7's shipped constants are `ColorizationColor = RGB(116,184,252)`, `ColorBalance = 8`,
`AfterglowBalance = 43`, `BlurBalance = 49`
([Windows7.cs](https://github.com/Abdelrhman-AK/WinPaletter/blob/9a2c8c3bd4037ed578b38c4438bfa4c51e59f8fd/WinPaletter/Theme/Default/Windows7.cs),
as floats 0.08/0.43/0.49 in
[Common.h](https://github.com/Maplespe/DWMBlurGlass/blob/8c69c9c4de8994c5cc45fdc7ccde9848ec0997dd/Common/Common.h)).

Every term is linear in `B` except the constant `colorBalance*colorRGB`. So with
`C = (116,184,252)/255 = (0.454902, 0.721569, 0.988235)`, `b = 0.49`, `a = 0.43`, `k = 0.08`:

```
result_i = b*B_i + a*C_i*(0.2126*B_r + 0.7152*B_g + 0.0722*B_b) + k*C_i
```

That is an affine map — exactly one `feColorMatrix type="matrix"`, with the constant in the
fifth column. Generated by `src/aero/matrix.mjs` from the four named constants, never
hand-typed:

```
<!-- active -->
0.531586 0.139899 0.014123 0 0.036392
0.065964 0.711908 0.022402 0 0.057725
0.090342 0.303918 0.520681 0 0.079059
0        0        0        1 0
```

Inactive glass is not a dim: `colorBalance` is multiplied by 0.4 and `blurBalance` is
remapped to `0.4*b + 0.6 = 0.796`
([BackdropFactory.cpp](https://github.com/Maplespe/DWMBlurGlass/blob/8c69c9c4de8994c5cc45fdc7ccde9848ec0997dd/DWMBlurGlassExt/Backdrops/BackdropFactory.cpp)),
so inactive glass is *brighter and less tinted*:

```
<!-- inactive -->
0.837586 0.139899 0.014123 0 0.014557
0.065964 1.017908 0.022402 0 0.023090
0.090342 0.303918 0.826681 0 0.031624
0        0        0        1 0
```

Note row G sums to 1.106. It clips. That is the point: Aero's terms are summed with PLUS and
go above 1.0, which is why stacked `rgba()` overlays always read as a grey film. Spot values
from `src/aero/matrix.mjs`:

| backdrop | active glass | inactive glass |
|---|---|---|
| `rgb(128,128,128)` | `rgb(97,117,137)` | `rgb(130,147,164)` |
| `rgb(255,255,255)` | `rgb(184,219,253)` | `rgb(255,255,255)` — clipped |
| `rgb(0,0,0)` | `rgb(9,15,20)` | `rgb(4,6,8)` |

### 2.2 The blur

`BlurDeviation = 30` tenths decodes to 9.0 compositor units; the D3D path uses a standard
deviation of 3.0
([BlurSettings.hpp](https://github.com/ALTaleX531/OpenGlass/blob/46e3f13cabdc4c38f43df984e278359207d37285/Common/BlurSettings.hpp)).
CSS `blur()` takes a standard deviation, not a radius
([filter-effects-1](https://drafts.csswg.org/filter-effects-1/#funcdef-filter-blur)), so
`blur(9px)` is the like-for-like translation with no conversion factor. DWMBlurGlass's
default of 20 is that app's taste and produces a Windows-11 look; it is not used.

### 2.3 The CSS, and the risk

```css
.frame .glass {
  background: transparent;
  -webkit-backdrop-filter: blur(9px) url(#aero-glass-inactive);
          backdrop-filter: blur(9px) url(#aero-glass-inactive);
}
.frame[data-active] .glass {
  -webkit-backdrop-filter: blur(9px) url(#aero-glass-active);
          backdrop-filter: blur(9px) url(#aero-glass-active);
}
```

**This is the riskiest assumption in the design.** `backdrop-filter` takes a
`<filter-value-list>`, which includes `url()`, but I have no measurement that Chrome 157
applies a referenced SVG filter in a `backdrop-filter` chain, nor which colour space it uses.
The SVG filter declares `color-interpolation-filters="sRGB"` because D2D's PLUS composite is
not in linear light; if the engine ignores it, every coefficient is wrong by a gamma.

**What I would measure, first, before anything else is built (M1):** render a known synthetic
backdrop (a 16-step grey ramp plus three saturated patches), apply the chain, read the pixels
back with CDP `Page.captureScreenshot`, and compare against a JS transcription of the HLSL
formula. Pass is ±2/255 per channel. If `url()` is dropped, the fallback is the
three-layer `plus-lighter` stack from 06-aero-spec: a `.glass` with
`backdrop-filter: blur(9px) brightness(0.49)` and two **sibling** tint layers using
`mix-blend-mode: plus-lighter`
([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/mix-blend-mode)) — siblings, because
`mix-blend-mode` on an *ancestor* would make it a backdrop root and sever the chain. Whether
a plus-lighter sibling blends against the glass's filtered output inside the frame's stacking
context is itself unmeasured, and M1 measures it in the same run. If neither works, see
kill criterion 1.

### 2.4 Calibration without a Microsoft asset

There is no legally clean source for Windows 7 Aero bitmaps, and Microsoft forbids including
product screenshots "in your product's user interface"
([permissions](https://www.microsoft.com/en-us/legal/intellectualproperty/permissions)). So
fidelity is *not* checked against a screenshot. It is checked against a numeric transcription
of the published formula, which is a stronger check: it can fail on a single coefficient, it
needs no asset, and it runs in CI. The highlight streak bitmap and the icon set are redrawn
from scratch — an authoring cost, budgeted in M9, not an acquisition problem.

---

## 3. The area budget, and why it stops binding

gap-04 measured the wall at **58-63 M blurred device px per frame** (120 Hz, dpr 2, M2 Pro),
with the predictor being blurred *area*, not layer count — 60 windows at 35 M is free, 30 at
63 M halves the frame rate.

Frame-only glass. Metrics: caption band 30 CSS px, frame inset 6 CSS px
([7.css _window.scss](https://github.com/khang-nd/7.css/blob/7d3958e707ba97a0718638c273ffeef27ebed73c/gui/_window.scss);
the 30 px caption is declared by this project, because Aero's own `SM_CYCAPTION` at 96 DPI is
not available from any primary source — 06-aero-spec could not determine it).

```
glass_area(w,h) = w*caption + 2*inset*(h-caption) + w*inset     [CSS px²]
device_px       = glass_area * dpr²
```

| window | full-bleed glass | windows at 58 M | frame-only glass | windows at 58 M | ratio |
|---|---|---|---|---|---|
| 640x440 | 1.126 M | **51.5** | 0.112 M | **519** | 10.1x |
| 1280x720 | 3.686 M | 15.7 | 0.217 M | **267** | 17.0x |

The full-bleed column reproduces gap-04's own figure ("~51 fully-visible 640x440 glass
windows at dpr 2") from the area model alone, which is the check that the model is the same
one that was measured. Shell chrome adds 0.205 M for a 1280x40 taskbar and 0.762 M for an
open Start menu — both constant, both negligible.

So the budget does not bind at any realistic window count. It is still governed, for two
reasons gap-04 flagged as undetermined: the budget on other GPUs is unmeasured, and glass
under real process load is unmeasured.

**The area governor** (`src/compositor/governor.mjs`), with hysteresis on both edges:

- The compositor keeps `sumGlassDeviceArea`, updated on every create/resize/close/minimise.
- `GLASS_OFF_AT = 45e6` (77% of the measured 58 M floor). Above it, newly-raised windows
  mount with `--glass-mode: flat` — a static gradient, no `backdrop-filter`.
- `GLASS_ON_AT = 36e6` (80% of the off threshold). Below it, flat windows return to glass.
- Between 36 M and 45 M, nothing changes state. Both edges are checked, and the no-flap
  band is checked by oscillating area inside it (M4).
- During a caption drag, if the dragged window's own glass would push the sum past
  `GLASS_OFF_AT`, that window alone goes flat for the duration of the drag and glasses again
  on release. Windows 7 drops to Basic under load; this is the local version.

---

## 4. Process model, runtime, and the syscall subset

### 4.1 What a process is

**A process is one dedicated Worker, same-origin, spawned from a Blob URL minted from VFS
bytes.** 1.86 ms to first message from a Blob URL versus 3.45 ms from HTTP; +5-6 ms if it
instantiates WASM; budget ~8 ms, under one frame, so `exec` is synchronous from the user's
point of view.

Per process, handed over at spawn: one 64 KiB `SharedArrayBuffer` and one `MessagePort` to
the kernel worker. The port matters — relying on the implicit `Worker.postMessage` channel
would land every syscall on the main thread and re-forward it.

Syscall path, from gap-03's ABI:

```
process:  s = Atomics.load(ctl, SEQ)
          port.postMessage(callid)
          r = Atomics.wait(ctl, SEQ, s, TIMEOUT_MS)      // "ok" | "not-equal" | "timed-out"
kernel:   await the real work
          Atomics.store(ctl, SEQ, s+1); Atomics.notify(ctl, SEQ)
```

14-16 us mean, p95 25-30 us, ~550 syscalls per 8.3 ms frame. Blocking is *faster* than async
postMessage (14.0 vs 17.3 us). ~0.2% of waits return `"not-equal"` because the reply beat the
park, and that fast path is handled explicitly — not as an error. Waits use a finite timeout
with a retry loop, never `Infinity`: a worker parked on `Infinity` with a dead kernel is a
zombie the engine reaps on its own schedule.

**The kernel is a dedicated worker.** Not a choice: `Atomics.wait` throws `TypeError` in a
window agent ([[CanBlock]] false), and a main-thread kernel inherits every long main-thread
task as syscall latency — 52 of 20000 syscalls past 10 ms with the main thread 60% busy,
versus 0 past 0.52 ms with a worker kernel. Window dragging and raster live on the main
thread, so that is the normal case.

**A thin main-thread relay** (the compositor) owns the DOM-only syscall group — `win_*`,
`clipboard_*`, `notify` — and answers the kernel over `postMessage`; the kernel then notifies
the caller's futex. Two hops for a window call, one for everything else. A window call is not
on a hot path: `win_create` happens once, `win_set` at most once per frame.

**A process owns no DOM and no releasable resource.** `Worker.terminate()` runs no cleanup,
so OPFS sync handles, pipe buffers, window handles and locks are all kernel-side. A process
holds integers.

### 4.2 Surfaces: the thing that replaces `mount(root)`

webxp's apps were ES modules that imported `shared/fs/fs.mjs` directly and whose `mount(root)`
*was* the window. Nothing was isolated, killable or backgroundable. The replacement:

```
win_create(spec) -> winid        spec = { class, x, y, w, h, minw, minh, resize,
                                          title, icon_ino, flags }
                                 class ∈ { WIN_WIDGET, WIN_CANVAS }
                                 flags: WIN_NO_PEEK (DWMWA_EXCLUDED_FROM_PEEK),
                                        WIN_FREEZE_THUMB (DWMWA_FREEZE_REPRESENTATION),
                                        WIN_TOOL, WIN_NO_TASKBAR
win_set(winid, prop, bytes)      prop ∈ { TITLE, ICON, RECT, STATE, WIDGET_TREE,
                                          PROGRESS, OVERLAY_ICON, THUMB_TOOLBAR }
win_surface(winid)               WIN_CANVAS only: transfers an OffscreenCanvas to the process
win_thumb(winid, bitmap)         push an ImageBitmap for the taskbar thumbnail
win_poll(winid, timeout_ms)      -> packed event records; EHOSTGONE if the window is gone
win_destroy(winid)
```

**WIN_WIDGET** — the process sends a widget tree as a flat node array; the compositor builds
real DOM from a closed vocabulary (§5.6). Native text input, IME, accessibility tree, text
selection, native scrollbars. The process never touches an element.

**WIN_CANVAS** — the process gets a transferred `OffscreenCanvas` and paints. For the
terminal, a v86 window, an image viewer, a game. `OffscreenCanvas` is transferable, so this
costs nothing per frame.

Three things fall out of this that no other surveyed web OS gets:

1. **One frame for every window, authored once.** Aero does not vary per app, because no app
   can author chrome.
2. **The shell has the widget tree as data.** A taskbar thumbnail is a second mount of the
   same tree at `scale(0.25)` — not a rasterisation. daedalOS must rasterise because its apps
   own their DOM, and it stores live closures and DOM nodes in the process table
   ([daedalOS process record](https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/components/system/Taskbar/TaskbarEntry/Peek/useWindowPeek.ts)),
   which is why that table can never be serialised.
3. **Kill is honest.** `terminate()` returns in ~10 us but does not stop the worker: a
   spinning worker kept advancing a shared counter and stopped at 2004/2051/2003/2048/2009 ms
   (n=5). So the process table has a **DYING** state with a 2,500 ms timer, the window is torn
   down *immediately* on kill, and the Task Manager shows the pid as DYING until reaped. The
   user never sees a dead window. A spawn right after a mass kill took 22.7 ms, so a
   respawn-after-kill path waits.

### 4.3 Caps and fan-out

- Process table hard cap **512**. The renderer survives 3200 live workers and dies between
  3200 and 4800; every process shares one renderer, so exceeding it kills the OS. 512 is
  below gap-04's 1000 design limit because each process here also costs DOM in the
  compositor. 512 x ~600 KiB resident ≈ 300 MiB, plus the renderer floor.
- **Signals and broadcasts are O(interested), never O(N).** Round-tripping all live workers
  costs 378 us each — 502 ms at 1600. The kernel keeps a per-signal subscriber set and a
  per-event interest set. The same rule governs thumbnails: a process only receives
  `WIN_THUMB_WANTED` while its thumbnail is actually on screen (§5.4).
- A process parked in `Atomics.wait` cannot service `postMessage`, so signals arrive via the
  reserved `SIGPEND` control word in the SAB, read at syscall entry or `sched_yield`. A
  compute loop issuing no syscalls is uninterruptible — killable, not interruptible — and the
  UI must show that distinction (§5.7).

### 4.4 The v1 syscall subset

gap-03's table is 68 calls. v1 ships **46**, Linux-style negative errno in one register,
WASI preview1's dense 0-76 errno numbers verbatim
([wasi_defs.ts](https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/wasi_defs.ts#L12-L88))
plus `EHOSTGONE = 100`.

| group | v1 calls |
|---|---|
| process (11) | `spawn` `exec` `waitpid` `kill` `exit` `getpid` `getpgid` `setpgid` `sigaction` `sigprocmask` `sched_yield` |
| fd (12) | `close` `read` `write` `pread` `pwrite` `seek` `fstat` `fsync` `ftruncate` `dup2` `fcntl` `poll` |
| path (13) | `open` `mkdir` `rmdir` `unlink` `rename` `readdir` `stat` `lstat` `symlink` `readlink` `chmod` `realpath` `mount` |
| ipc (1) | `pipe2` |
| host (9+) | `clock_gettime` `random` `env_get` `env_set` `pty_open` `tty_get` `tty_set` `tty_winsize_get` `tty_winsize_set` |
| window (7) | `win_create` `win_set` `win_surface` `win_thumb` `win_poll` `win_destroy` `notify` `clipboard_read` `clipboard_write` |

**Deferred from the 68:** `socketpair` `send` `recv` `shutdown` (nothing in v1 needs
datagrams), `shm_create` `shm_attach` (the 65404 B inline region plus POSIX-legal short
counts is enough; `write` returning a short count and libc looping is explicitly permitted
([POSIX write](https://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html))),
`link` `chown` `utimes` `statfs` `truncate` `umount` `getppid` `clock_nanosleep` `ioctl`
(replaced by named `tty_*` calls), `win_poll`'s raw-input extensions.

**No fork.** Browsix forked by handing the parent's whole heap `ArrayBuffer` to a new Task
([kernel.ts](https://github.com/plasma-umass/browsix/blob/04f0830088560f27d480cde3e37c28269375f59f/src/kernel/kernel.ts#L1871-L1898)),
which only works because asm.js keeps all state in one buffer. A JS worker has no such
buffer, and Browsix itself states fork is incompatible with a blocking syscall channel.
Browsix, wanix and WebContainer all converge on spawn. Pipelines, background jobs, job
control and `$(...)` all survive on `spawn` + `pipe2` + pgrp bookkeeping; `( subshell )` as a
real process does not.

**fd inheritance is explicit-only.** `SpawnSpec` carries a `posix_spawn_file_actions`-shaped
ordered list of `{op, childfd, parentfd, flags}` with `op ∈ {DUP2, CLOSE, OPEN}`
([posix_spawn](https://pubs.opengroup.org/onlinepubs/9699919799/functions/posix_spawn.html)).
Nothing is inherited; `O_CLOEXEC` does not exist. A shell child gets
`DUP2(0←slave) DUP2(1←slave) DUP2(2←slave)`; a pipeline gets `DUP2(1←wfd)` / `DUP2(0←rfd)`.

**Bounce buffer, not a mapped heap.** Browsix-Wasm replaced the mapped heap with a
per-process 64 MB bounce buffer carrying offsets in the message, at 0.2% average / 1.2% max
overhead on SPEC. This design's bounce buffer is the 64 KiB SAB's byte region at offset 128,
`MAX_INLINE = 65404 B`. wanix's `CallBuffer` carries a "TODO: check if it exceeds the buffer
size" and silently truncates replies over 16360 bytes
([callbuffer.ts](https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/wasi/callbuffer.ts#L26-L48));
here, overflow is a short count, which libc loops on.

### 4.5 Runtime

**JS first.** A program is an ES module in a worker. Its entry point receives a `sys` object —
a thin libc-shaped wrapper over the ABI with the POSIX names and POSIX errors. No app ever
imports the VFS; the only import is `sys`.

**WASM/WASI second-class.** Because the errno numbers are WASI preview1's verbatim, a
wasi-libc binary needs no translation on the fd and path groups. A
`wasi_snapshot_preview1` shim maps the 46-import surface onto the table. It will not be
complete: preview1 has no spawn, wait, kill, pipe, dup or ioctl anywhere, and
browser_wasi_shim's `poll_oneoff` supports only a single clock subscription and busy-waits
([wasi.ts](https://github.com/bjorn3/browser_wasi_shim/blob/b068ec2c22d68581c48f2592f8cca1681bf71a98/src/wasi.ts#L827-L878)),
so `poll` is kernel-implemented. A WASM program that calls `fork()` without `exec` cannot run.

**No Linux guest as the runtime.** Full-system emulators give a real kernel but as a black box
behind a serial cable: the host JS cannot see guest processes or route a window to a guest
pid. Running real Linux does not buy a kernel boundary. v86 is therefore an *app* — a
`WIN_CANVAS` process — and it is handed the same build-time `/usr` index the host mounts, so
host and guest see one tree (daedalOS's best idea).

**The shell** is a process. webxp's `apps/terminal/` (shell.mjs 453, commands.mjs 1488,
glob.mjs 160) ports into a worker with its direct `fs.mjs` imports replaced by syscalls. It
gets a pty from `pty_open`, a `WIN_CANVAS` surface, and a terminal grid renderer. The line
discipline lives in the kernel: with `ISIG` set, `VINTR`/`VQUIT`/`VSUSP` bytes become
SIGINT/SIGQUIT/SIGTSTP on the foreground pgrp
([termios](https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/termios.h.html)).
`tty_winsize_set` on the master raises SIGWINCH on the slave's foreground pgrp
([tcgetwinsize](https://pubs.opengroup.org/onlinepubs/9799919799/functions/tcgetwinsize.html)),
which is how resizing a terminal window reflows it.

---

## 5. The Win7-defining behaviours, specified to implement and to check

Every threshold below is a named constant in exactly one file, `src/shell/metrics.mjs`,
sourced or declared. A declared number says so.

### 5.1 Aero Snap

All five thresholds are documented defaults, all marked unsupported on Vista/XP — i.e. they
are the Windows 7 feature
([SystemParametersInfo](https://github.com/MicrosoftDocs/sdk-api/blob/656e9656bfaef34dd29cd7ee9e1146aec17e924c/sdk-api-src/content/winuser/nf-winuser-systemparametersinfoa.md)).

| constant | value | source | meaning |
|---|---|---|---|
| `DOCK_THRESHOLD` | 1 px | SPI_GETMOUSEDOCKTHRESHOLD | arm a dock when the **pointer** is this close to a monitor edge |
| `DRAGOUT_THRESHOLD` | 20 px | SPI_GETMOUSEDRAGOUTTHRESHOLD | travel toward centre required to undock |
| `SIDEMOVE_THRESHOLD` | 50 px | SPI_GETMOUSESIDEMOVETHRESHOLD | drag depth below the top needed to restore a vertically maximized window |
| `PEN_THRESHOLDS` | 30 / 30 / 50 | same page | coarse-pointer equivalents |
| `SNAP_SIZING` | true | SPI_GETSNAPSIZING | sizing a window to the top or bottom edge vertically maximizes it |
| `DOCK_MOVING` | true | SPI_GETDOCKMOVING | dock at top, left, right |
| `DRAG_FROM_MAXIMIZE` | true | SPI_GETDRAGFROMMAXIMIZE | dragging a maximized window's caption restores it |
| `WIN_ARRANGING` | true | SPI_GETWINARRANGING | one master gate for all of the above |

Behaviour:

- During a caption drag, when the pointer is within `DOCK_THRESHOLD` of a monitor edge, the
  snap ghost appears in `#overlay` within 50 ms (the UX Guide's hover/click budget
  ([vis-animations.md](https://github.com/MicrosoftDocs/win32/blob/51c9b7cc54ef393b6406c8320a7840fdd88209d5/desktop-src/uxguide/vis-animations.md))).
  Left/right → half-screen; top → maximize. Release commits.
- The pre-snap rect is stored on the window record, not derived.
- Undocking requires `DRAGOUT_THRESHOLD` px of travel toward centre. Below that, geometry is
  **unchanged** — not interpolated, not nudged.
- A top-snapped window restores only once the drag is `SIDEMOVE_THRESHOLD` px below the top.
- **The hysteresis is the asymmetry: arm at 1, release at 20.** They are different numbers in
  Microsoft's own defaults, and that is what makes real snap feel solid rather than twitchy.
  Every surveyed web OS with snap uses one threshold for both directions.
- With a coarse pointer (`matchMedia('(pointer: coarse)')`), substitute `PEN_THRESHOLDS`.

### 5.2 Aero Shake

06-aero-spec could not determine the exact gesture rule from any primary source — only the
Group Policy knob that disables it. **So this is declared, and recorded as declared:**

```
SHAKE_REVERSALS = 3        direction reversals on the X axis
SHAKE_LEG_MIN   = 40 px    minimum travel per leg
SHAKE_WINDOW_MS = 1000     sliding window containing all reversals
```

Implemented on the pointer-move history ring the caption drag already keeps. Three qualifying
reversals minimise every other window; a second shake restores them. No source exists for
these three numbers and the file says so.

### 5.3 Superbar

Rules are verbatim from the UX Guide
([winenv-taskbar.md](https://github.com/MicrosoftDocs/win32/blob/51c9b7cc54ef393b6406c8320a7840fdd88209d5/desktop-src/uxguide/winenv-taskbar.md)).

- **One button per program, not per window.** Button identity is the program's VFS path
  (`/usr/bin/notepad`), read from the process record. Secondary windows, project windows and
  MDI children group under it as thumbnails. This is a requirement on the process model, and
  it is why `spawn` records the program inode on the process.
- Button states: pinned-not-running (no frame), running-one (single frame), running-many
  (stacked frame, 2 px offsets, max 3 drawn).
- **Taskbar progress:** `win_set(winid, PROGRESS, {state, value})`, `state ∈ {none, normal,
  paused, error, indeterminate}`, drawn as a fill behind the button. Aggregated across a
  program's windows by taking the max.
- **Overlay icon:** 16x16, bottom-right, must not animate or flash.
- **Thumbnail toolbar:** at most 7 commands, 5 preferred, icon-only with a tooltip each,
  immediate, single-click, **disabled rather than hidden** when inapplicable.
- Quick Launch does not exist and programs must not add shortcuts to it.
- Taskbar height is a declared 40 CSS px. The UX Guide's only number is a 48 relative-pixel
  *layout reserve*, not a height; treating 48 as the height would make the shell 8 px too
  tall. daedalOS's 30 px is a Windows 10 figure.

### 5.4 Live thumbnails and Aero Peek

The DWM contract is "the window provides a thumbnail, or DWM captures one"
([DWMWINDOWATTRIBUTE](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute)):
`DWMWA_HAS_ICONIC_BITMAP` / `DWMWA_FORCE_ICONIC_REPRESENTATION` let a window supply a static
bitmap instead of being captured, and `DWMWA_FREEZE_REPRESENTATION` stops live updates.
**Windows itself does not insist on capture.** So make the app-supplied bitmap the primary
path, which sidesteps Element Capture entirely.

Three tiers, in order:

1. **Process-supplied bitmap.** `win_thumb(winid, bitmap)` takes a transferred `ImageBitmap`.
   For a `WIN_CANVAS` process this is `canvas.transferToImageBitmap()` of a 200 px-wide
   downscale it already drew — effectively free. **The process only pushes while asked:**
   the compositor raises `WIN_THUMB_WANTED` / `WIN_THUMB_IDLE` events through `win_poll` when
   a thumbnail becomes visible or hidden, at `THUMB_HZ = 4`. A backgrounded window costs zero.
   This is the O(interested) rule applied to the surface.
2. **Widget re-mount.** For a `WIN_WIDGET` window, the compositor mounts a second instance of
   the declared widget tree inside the flyout at `transform: scale(0.25)` and freezes it.
   Re-rendered on a tree version bump, at most 4 Hz. Not a rasterisation — the same data,
   mounted twice.
3. **Icon card.** 32 px icon over a flat glass card. What Win7 shows for a window that
   supplies neither.

Constants: `PEEK_DELAY_MS = 400` (Wine's `MouseHoverTime` default
([sysparams.c](https://github.com/wine-mirror/wine/blob/3374e6b4580bf49ed0ba351923f4a687045e3d29/dlls/win32u/sysparams.c));
the real `ExtendedUIHoverTime` default is undocumented — 06 could not determine it, and
daedalOS independently chose 400), `PEEK_MAX_WIDTH = 200` (daedalOS).

**Aero Peek on hover:** the hovered window renders at full size; every other window drops to
a glass sheet — `visibility: hidden` on `.client`, a 1 px `#fff` outline on `.frame`, glass
to flat fill. `WIN_NO_PEEK` opts a window out. Dropping the glass *removes* blurred area, so
peek is strictly cheaper than the normal case.

**Show desktop:** the sliver at the taskbar's right end. Hover 400 ms → everything ghosts.
Click → minimise all.

### 5.5 Notification area

The tray is a user-owned allowlist, not an app surface: most icons are hidden by default,
only the user can promote one, and "there is no way for your program to perform this
promotion automatically"
([winenv-notification.md](https://github.com/MicrosoftDocs/win32/blob/51c9b7cc54ef393b6406c8320a7840fdd88209d5/desktop-src/uxguide/winenv-notification.md)).
Windows temporarily promotes a hidden icon when it raises a notification.

So: `/home/<user>/.tray` is a file listing promoted program paths; it is written by the shell
only. A process that asks to promote itself gets `-EPERM`. `notify(spec)` promotes for the
notification's lifetime plus 3 s, then demotes.

### 5.6 Jump lists

One to three groups; `Tasks` is the Windows-assigned group name; **a jump list must work when
the program is not running.** Therefore the shell reads it from the filesystem, never from the
process: `/home/<user>/.jump/<program-basename>.json`, with `{groups: [{name, items:[{label,
icon, exec, args}]}], recent: [...], pinned: [...]}`. Opened by right-click on the taskbar
button or by dragging up from it. Recent-document entries are appended by the shell's own
file-open path, not by the app.

### 5.7 The widget vocabulary, and Not Responding

Closed vocabulary, 18 node types, versioned: `window panel groupbox label button checkbox
radio textbox combobox listview treeview menubar toolbar statusbar scrollpane tabs progress
splitter`. Ported from webxp's `widgets.mjs` (1162 lines) and `dialogs.mjs` (1155) as the
renderer side. Type scale from the UX Guide
([vis-fonts.md](https://github.com/MicrosoftDocs/win32/blob/51c9b7cc54ef393b6406c8320a7840fdd88209d5/desktop-src/uxguide/vis-fonts.md)):
caption and body 9 pt = 12 px, main instruction 12 pt = 16 px `#003399`, group header 11 pt,
disabled `#323232`, link `#0066CC` / hover `#3399FF`. Font stack
`"Segoe UI", Selawik, system-ui, "Helvetica Neue", Arial, sans-serif` — naming Segoe UI in a
stack is explicitly permitted without a licence, self-hosting it is not
([font FAQ](https://learn.microsoft.com/en-us/typography/fonts/font-faq)). Selawik is
OFL-1.1, ships no built binaries, and must be built from source with fontmake
([LICENSE.txt](https://github.com/microsoft/Selawik/blob/89362e84731d1f5777fa078fd4d5ebbd339e4378/LICENSE.txt)).
It is **not** documented as metric-compatible, so layouts are checked against both faces.

**Not Responding** is a two-threshold state machine driven by the kernel's per-process
sequence-numbered heartbeat (identity, not timing): at 1,000 ms without a reply the caption
greys and the title gains " (Not Responding)"; at 5,000 ms a dialog offers End Process. The
dialog states which of the two kills applies — a process blocked in a syscall is interrupted
with SIGINT and EINTR; a compute-bound process has no interruption path and gets
`terminate()`. The UI says so rather than pretending.

---

## 6. VFS

gap-06's design, taken whole, with the credential change.

**Authoritative inode table in memory in the kernel worker.** `stat` is a `Map.get` at 27 ns;
a depth-5 path walk is 370 ns. Persisted as an OPFS superblock snapshot plus an append-only
journal. Boot at 10k inodes: 7.2 ms (Chrome) / 7.4 ms (Safari), versus 23.4 / 28.1 ms via
IndexedDB. Per-inode sidecars are dead: 1,742 ms for 2,000 files.

```
<origin bucket root>
  sb.0, sb.1          alternating snapshots
  sb.ptr              { generation, slot, journalSeq, crc32 }
  j.log               append-only, each record [u32 len][JSON][u32 crc32]
  b/<ino>             file data, FLAT
  t/<ino>             staging
```

Flat, because Chrome 157 has no `FileSystemDirectoryHandle.move()` and Safari 27.2 rejects the
one-argument rename; the only portable primitive is `fileHandle.move(dirHandle, name)`.

**Durability ordering, per mutation:** write/extend `b/<ino>` → `flush()` → append the journal
record → `flush()` → apply in memory. Data before metadata: an orphan blob is garbage, a
record pointing at absent data is corruption. Snapshot every 512 records. `j.log` and `sb`
handles are opened once at kernel start and never closed — reopening per record costs 2.5x
(Chrome) to 12x (Safari). `flush()` is the only durability primitive
([fs spec](https://fs.spec.whatwg.org/#dom-filesystemsyncaccesshandle-flush)), and `fsync` is
a separate syscall from `write` because `flush()` is 260 us against a 5 us 4 KiB write.

**fd and handle discipline.** `createSyncAccessHandle` is 495 us — 100x a syscall. Kernel-side
descriptor table with an LRU cache of 64 open sync handles. `getDirectoryHandle` is 85 us per
component, so a 4-component walk is 340 us = 23 syscalls: paths resolve to an inode **once**
and are cached. **Processes are handed an fd, never a path.**

**fsck at boot** validates `sb.ptr`'s crc, else picks the higher valid generation; replays
`j.log` from `journalSeq`, stopping at the first bad crc or truncated length prefix — that is
the crash point, and the tail is discarded. Repairs are reported, never silent: missing blob
with size>0 → size 0 and a report; blob size ≠ inode size → trust the blob; `nlink` recomputed
from surviving entries; unreachable inodes dropped; `t/*` deleted. **A snapshot that fails
validation mounts read-only and says so.** webxp reseeds instead, which is correct for a demo
and wrong once the data is the user's. Blob-orphan collection is an idle task, not a boot
task: Safari enumerates at 0.60 ms per name, so 10k names is ~6 s.

**webxp reuse.** `shared/fs/vfs.mjs` (1301 lines) is the layer above the store and ports with
two surgeries that touch every method:

1. `inode.data` is a JS string; `readFile`/`writeFile`/`appendFile`/`copyFile`/`usedBytes` all
   measure `.length`. Data becomes bytes in `b/<ino>`.
2. `this.uid` / `this.gid` is one global identity. It becomes
   **`cred = {uid, gid, caps}` as the first argument of every path-resolution call** —
   `#lookup(cred, path, opts)`, `#may(cred, ino, mode)`, `#need(cred, ...)`, and every public
   method. Without this, processes cannot have different identities.

Reusable unchanged: symlink chasing with `MAX_LINKS = 40`, dangling-final-link create
semantics, hard links and `nlink` accounting, `FsError` POSIX codes, `serialize`/`parse` as
the snapshot writer and half of fsck, `batch`/`watch`. Absent and to be written: the fd layer
(open/read/write/lseek/dup, O_APPEND/O_TRUNC) and a real mount-crossing branch in `#lookup`.

**Mounts, longest prefix wins:**

| mount | driver |
|---|---|
| `/` | opfs, rw |
| `/usr` | overlay(lower = httpimg ro, upper = `opfs:/.rw/usr`), copy-on-write with whiteouts |
| `/proc` `/dev` `/sys` | genfs, synthesised on read, no stored inodes |
| `/mnt/host/<label>` | hostfs — **Chromium only**; `showDirectoryPicker` is undefined in Safari 27.2 |
| `/tmp` | tmpfs |

`httpimg` is a build-time index in daedalOS's `fs2json` shape:
`{fsroot, size, version:4}` with each node `[name, size, mtime, target]`, where `target` is a
symlink string or a child array
([fs2json.js](https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/scripts/fs2json.js)).
It already carries mtime and symlink targets — exactly the metadata OPFS lacks. OPFS has no
mode bits, no uid/gid, no symlinks, and `lastModified` has no setter, so all four live in the
inode table.

**Shell-owned, not kernel-owned:** `navigator.storage.persist()` is `[Exposed=Window]`, so the
kernel worker cannot ask for durability. The compositor requests it early in boot, displays
`persisted()`, and offers export. Without it the whole filesystem is a cache: buckets start
best-effort and the UA "should clear" them under pressure
([storage spec](https://storage.spec.whatwg.org/#storage-pressure)).

**Experience-specific additions.** The shell reads its own state from the filesystem, which is
what makes the OS inspectable:

```
/proc/<pid>/{cmdline,status,cwd,fd/,win/<winid>/{rect,state,title,thumb}}
/home/<user>/.session.json     window rects, icon positions, wallpaper, theme  (daedalOS's idea)
/home/<user>/.taskbar          pinned program paths, in order
/home/<user>/.jump/<prog>.json jump list, readable with the program not running
/home/<user>/.tray             user-promoted tray icons
/home/<user>/Libraries/*.library-ms
```

A library is a union mount: N source paths, exactly one `isDefaultSaveLocation` write target,
plus a view template
([library-schema-entry](https://learn.microsoft.com/en-us/windows/win32/shell/library-schema-entry)).
It is a filesystem feature, not an Explorer feature, so it belongs below the window layer.
The process table as a filesystem is wanix's idea — the only surveyed design where the host
can enumerate, inspect and address a process with no bespoke API.

---

## 7. Threat model

**Tier (i): first-party only.** Enforcement is the Worker boundary plus the syscall ABI, and
the credential `{uid, gid, caps}` checked in the kernel's own path resolution. Dropping the
`*at`/dirfd shape means all path resolution and all permission enforcement is in the kernel;
there is no preopen-capability fallback and `ERRNO_NOTCAPABLE` is permanently unreachable.

**Be precise about what that does and does not buy.** A same-origin process worker can open
OPFS itself and bypass the VFS entirely, and can `importScripts` anything same-origin. Tier
(i) is not confinement of hostile code. What it genuinely buys, and what webxp did not have:

- **Killability.** `terminate()` is the only forcible kill the platform offers, and it only
  exists for a worker.
- **Backgroundability.** A process with no window still runs; a window with no process is torn
  down.
- **No DOM access.** No app can touch another app's chrome or the shell's — the exact webxp
  failure. daedalOS pays for having no kernel in `utils/globals.ts`, patching `window.define`
  with a getter that parses `new Error().stack` to decide which app gets the value, and
  hand-deleting global names after certain apps close.
- **Different identities.** A buggy app gets `-EACCES` instead of corrupting `/etc`.

**Why not tier (ii).** Per-app-origin needs a domain, wildcard DNS and a wildcard cert, and
**cannot have a blocking syscall channel at all**: a SAB is restricted to one agent cluster,
an isolated document's cluster is origin-keyed, and a SAB sent to a cross-origin iframe
arrives as `messageerror` — measured across 7 iframe configurations. Each app origin would
need its own SAB plus a broker worker doing an async hop to the host kernel: two hops, not
one. It still cannot stop a hostile app burning CPU or spamming the kernel. It buys
origin-level storage separation and nothing else.

**The upgrade path is kept open deliberately.** Every syscall is postMessage-shaped with no
shared globals, so tier (ii) is a deployment change plus a second channel implementation, not
a rewrite. The `Channel` interface has two implementations from day one (§8, M10): SAB+Atomics,
and service-worker + synchronous XHR
([sync-message](https://github.com/alexmojaki/sync-message/blob/071e699508228d324cd62d40e401b4018b14b2bb/lib/index.ts)),
so the shell never needs an async-only code path.

---

## 8. Deployment

COOP `same-origin` + COEP `require-corp`, which are settable on Cloudflare Pages, Netlify,
Vercel, Firebase Hosting, CloudFront and nginx, and **not** on GitHub Pages or bare S3.
`require-corp` is the only Safari-portable value — `credentialless` is Chrome 96 / Firefox 119
/ Safari none — so:

- **Self-host every font, icon and bitmap.** One helper sets `crossorigin="anonymous"` on
  every remote image; nothing else may emit an `<img src>`.
- **Third-party iframe embeds cannot exist inside the document.** YouTube sends CORP
  cross-origin but only `COEP-Report-Only`, so it is blocked. No maps widget, no OAuth popup
  iframe. Such content opens in a separate non-isolated top-level window or does not exist.
- Header rules do not apply to function responses on Cloudflare Pages or Netlify, so **no part
  of the OS may be served by a function** — one such route silently drops COEP and breaks
  isolation for the whole document.
- Correct headers do not guarantee `crossOriginIsolated`: the UA may pick a "logical"
  isolation mode. Feature-detect at boot and fall back to the SW+sync-XHR channel, which keeps
  blocking semantics. Fully-async is the third tier and is a visibly degraded UI, not a second
  shell.

---

## 9. How `check.py` is used

webxp's `scripts/check.py` is 11,075 lines of Chrome DevTools Protocol checks that drive real
input and read geometry back. It is the most valuable artifact in the predecessor and it ports
almost unchanged, because the pieces this design needs are exactly the pieces it already has:

- `drag(page, x0, y0, dx, dy, steps)`, `mouse(page, type, x, y, buttons, ...)`,
  `hover_at`, `click_at`, `right_click`, `press_key` — real `Input.dispatch*Event`, not
  synthetic JS events.
- `rect_of(page, selector)`, `centre(page, selector)`, `probe(page)` — geometry read back out
  of the live document.
- `shoot_clip(page, rect, path)` — a clipped screenshot, which is the pixel-comparison path
  for the glass matrix.
- `near(got, want, slack=2.0)` — the tolerance helper.
- `INVERTIBLE` plus `--prove-failure`, which inverts every listed assertion and **fails the
  run if an inverted check did not fail**, including "inverted nothing: the filter excluded
  every invertible check".
- The convention that a negative control lives *inside* the check, not beside it —
  `check_drag_is_title_bar_only` performs the identical drag from the window body and asserts
  nothing moved.

Three things it needs added:

1. **A pixel oracle.** `aero_sample(page, rect, expect_fn)`: screenshot-clip a region, decode
   with the stdlib, and compare each sampled pixel against a JS/Python transcription of the
   HLSL formula within ±2/255. Used for the glass matrix, the active/inactive difference, the
   ghost sheet and the flat-fill fallback.
2. **A frame-cadence probe.** gap-04's rAF-delta harness, lifted in, with its two known-good
   negative controls: a 20 ms/frame main-thread stall drops cadence to 49.3 fps, and 30
   full-viewport glass windows drop it to 61.7 fps. The metric is already proven capable of
   failing on both GPU and main-thread overload.
3. **A syscall counter.** The kernel increments per-call counters in a debug SAB word; checks
   assert exact counts (e.g. "a second resolve of the same 4-component path issues zero
   `getDirectoryHandle` calls"), which is how the inode cache is proven rather than assumed.

### The snap hysteresis checks, concretely

Both edges of every threshold, driven through `drag()` and read back through `rect_of()`:

```python
def check_snap_arm_band(page):                       # DOCK_THRESHOLD = 1
    # (a) pointer lands at monitor_x + 1 -> ghost appears, release gives exact half-screen
    # (b) pointer lands at monitor_x + 2 -> no ghost, release leaves the rect unchanged
    #     The 1 px band is a BAND, not a half-plane. (b) is what makes (a) meaningful.

def check_snap_release_hysteresis(page):              # DRAGOUT_THRESHOLD = 20
    # from a left-snapped window:
    #   drag caption 19 px toward centre -> rect UNCHANGED, still snapped
    #   drag caption 21 px toward centre -> rect == the stored pre-snap rect
    # Both edges. 19 is the edge that catches a >= / > mistake.

def check_top_snap_sidemove(page):                    # SIDEMOVE_THRESHOLD = 50
    # from a top-snapped (maximized) window:
    #   drag 49 px down -> still maximized
    #   drag 51 px down -> restored to the pre-snap rect

def check_snap_sizing(page):                          # SNAP_SIZING
    # drag the NORTH resize edge to y = 0 -> vertically maximized, width unchanged
    # the negative control is inside: the same drag to y = 3 must only resize
```

The negative control for the whole family: set `WIN_ARRANGING = false` and assert **every**
snap assertion fails. That breaks the thing the checks are about — the gate every threshold
hangs off — rather than something adjacent. `check_snap_arm_band` and
`check_snap_release_hysteresis` go in `INVERTIBLE`, so `--prove-failure` exercises them on
every run.

The same both-edges discipline applies to every continuous threshold in the design:
`PEEK_DELAY_MS` (no flyout at 350 ms, flyout at 450 ms), the shake legs (35 px must not fire,
45 px must), the shake window (1,400 ms must not fire, 800 ms must), and the area governor
(flat above 45 M, glass below 36 M, **no flap** when area oscillates inside the band).

---

## 10. Milestones

| # | title | days | new/ported LoC |
|---|---|---|---|
| 1 | Glass truth table | 7 | 900 |
| 2 | Kernel worker, ABI, 12 calls | 18 | 2,600 |
| 3 | VFS on OPFS: journal, fsck, credential | 16 | 2,200 |
| 4 | Compositor, WM, Aero Snap with both edges | 20 | 2,800 |
| 5 | Superbar, jump lists, thumbnails, progress, tray | 14 | 1,900 |
| 6 | Peek, Shake, show-desktop, glass under load | 10 | 1,200 |
| 7 | Widget protocol and the client area | 22 | 3,000 |
| 8 | Shell as a process: pty, job control | 18 | 2,400 |
| 9 | The first-60-seconds build | 16 | 2,000 |
| 10 | Deploy and the degraded tiers | 14 | 1,500 |
| | **total** | **155** | **20,500** |

**Against the cost anchor.** A 27-syscall Unix kernel in the browser was 2,249 LoC, 8,126 with
all runtime integrations. The kernel-shaped part of this plan — M2 + M3 + M8 — is 7,200 LoC
for 46 calls plus a journalled VFS plus a pty and job control. That is within 1x of the anchor
with a larger call table, which is the right order. The remaining 13,300 LoC is compositor,
chrome, widget protocol and apps, which the anchor does not cover and which is where an
experience-first design is supposed to spend. 155 days at ~132 LoC/day including the harness
is slower than a typical estimate on purpose: webxp shipped 11,075 lines of checks against
~10,000 lines of product, so roughly half of every day is the harness.

Per-milestone proofs and negative controls are in the schema. Two notes on ordering:

- **M1 is first because it is the riskiest assumption**, and because its answer changes the
  rest of the plan. If `url()` in `backdrop-filter` and transform-only animation both work,
  Tier 1 stands and M4 is straightforward. If neither works, the design is dead as written
  (kill criterion 1 and 2) and seven days is the right price to learn it.
- **M6 deliberately sits after M5** so that "glass under real process load" is measured with
  real windows and real thumbnails alive, which is the thing gap-04 explicitly could not
  determine ("the glass benchmark ran with no workers alive").

---

## 11. What a user sees in the first 60 seconds that no other web OS does

1. **The glass is right, not frosted.** Over a bright wallpaper the frame goes *brighter* and
   clips toward white, because the three terms are summed with PLUS, not alpha-stacked. Every
   other web OS reads as a grey film over the desktop, because that is what stacked `rgba()`
   does. Within a second of the wallpaper loading, this looks like 2009.
2. **The highlight streak stays on the monitor while the window slides under it.** Parallax
   0.1, monitor-anchored, per the DWM reflection model. 7.css has the viewport-anchored
   gradient but no window manager; daedalOS has a window manager but no streak. Nobody has
   both, and this is the single most recognisable Aero tell.
3. **Inactive windows get *brighter*, not dimmer.** `blurBalance` remaps 0.49 → 0.796 and the
   tint drops to 0.4x. Focus reads instantly and correctly, and it is wrong in every
   reimplementation that treats focus as one opacity value.
4. **Snap arms at 1 px and releases at 20.** Drag to the edge and it docks instantly; nudge a
   docked window and *nothing happens* until 20 px. That asymmetry is the whole feel of real
   snap, and every web OS with snap uses one threshold for both directions, which is why
   theirs feels twitchy.
5. **Hover the taskbar for 400 ms and the thumbnail is the app's own pixels**, updating at
   4 Hz, while every other window fades to a glass sheet with a 1 px outline. No permission
   prompt, no "share this tab" dialog, no rasterisation artifacts.
6. **Shake a window and the rest minimise.**
7. **And it is one process boundary deep.** The Task Manager shows pids. End Process on an app
   stuck in a `while(true)` actually ends it — the window is gone within a frame and the pid
   sits in DYING with a visible timer until the engine reaps the worker ~2 s later. The OS
   does not lie about the difference between "interrupted" and "killed".

---

## 12. Facts this design needs that are not yet measured

Honoured, not hidden. None of the measured facts need to be false; three unmeasured things
need to be true.

1. **`backdrop-filter: blur(9px) url(#m)` applies a referenced `feColorMatrix`, in sRGB.**
   Measured by M1 against a JS transcription, on Chrome 157 and Safari 27.2. If false, the
   exact-shader claim dies and the tier drops to an approximation.
2. **`transform` on a window wrapper does not sever the backdrop chain.** It is not on the
   MDN backdrop-root list, but that list was read, not tested. M1 samples a pixel inside the
   glass band mid-animation. If false, DOM glass and animated windows are incompatible and the
   canvas compositor becomes mandatory.
3. **A keystroke through the widget protocol reaches the glyph in under 16 ms at p95.** The
   syscall is 14-16 us, so the budget is all layout, but no measurement exists. M7 measures
   500 keystrokes with `Input.dispatchKeyEvent` plus a `MutationObserver` timestamp. If false,
   the client area must become a canvas and the OS loses IME and the accessibility tree.

Two measured facts are load-bearing in a way worth restating. The 58-63 M blur budget is one
machine, one 120 Hz display, dpr 2 — a 60 Hz panel has twice the per-frame budget and an
integrated GPU far less, which is why the area governor exists even though frame-only glass
has 10x headroom. And glass was measured with no workers alive, which is why M6 exists.
