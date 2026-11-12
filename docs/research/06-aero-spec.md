# Windows 7 Aero: exact composition, metrics, behaviour, and what the web can reproduce

## Summary

Aero glass is not a translucent panel. It is an additive composite of three layers over a Gaussian-blurred backdrop: blurred RGB scaled by blurBalance, a Rec.709 luminance copy tinted by the afterglow colour, and a flat colorization tint — summed with a PLUS operator, so it can clip above 1.0. Win7's shipped constants are blur 0.49 / afterglow 0.43 / colour 0.08 over RGB(116,184,252). The highlight streak is a bitmap anchored to the monitor, not the window, parallaxed at 0.1. That ordering dictates architecture: a web OS needs a compositor layer that owns the backdrop, not per-window CSS.
Three fidelity options the evidence supports: (1) DOM-only — all windows siblings inside one backdrop root, backdrop-filter: blur(9px) plus a plus-lighter tint layer and a position:fixed highlight; real behind-window blur works, thumbnails are DOM rasterisation. (2) DOM + capture — add Element Capture/Region Capture for true live previews; Chromium-only, needs a permission prompt, and its backdrop-root requirement fights option 1. (3) Canvas/WebGL compositor — windows render to textures, the real shader runs per frame; exact glass and free thumbnails, but you abandon native DOM windows.

## Findings

### Aero glass colorization is additive, not alpha blending. The shader is: result = blurBalance*blurredRGB + luminance709(blurredRGB)*afterglowRGB + coverage*colorRGB, where luminance709 = dot(rgb, (0.2126,0.7152,0.0722)), and the stages are composited with D2D1_COMPOSITE_MODE_PLUS.

- Evidence: https://github.com/ALTaleX531/OpenGlass/blob/46e3f13cabdc4c38f43df984e278359207d37285/OpenGlass/AeroColorizationEffect.hlsl
- Confidence: verified
- Why it matters: The CSS equivalent is an additive layer (mix-blend-mode: plus-lighter) over a backdrop-filter, not a white/blue rgba() overlay. Alpha-stacking tints can never reproduce the clipped highlights that make Aero look lit rather than painted.

### The same recipe appears as a Direct2D effect graph: GaussianBlur(backdrop) -> OpacityEffect(blurBalance) -> CompositeStep(PLUS) with a Saturation(0) copy tinted by afterglowColor*afterglowBalance, then PLUS a flat ColorSource at colorBalance opacity.

- Evidence: https://github.com/Maplespe/DWMBlurGlass/blob/8c69c9c4de8994c5cc45fdc7ccde9848ec0997dd/DWMBlurGlassExt/Backdrops/AeroBackdrop.hpp
- Confidence: verified
- Why it matters: Two independent reimplementations agree on layer order and operator, so the pipeline (blur -> desaturate+tint -> flat tint, all additive) can be treated as settled rather than guessed.

### Windows 7's shipped colorization defaults are ColorizationColor = RGB(116,184,252), ColorBalance = 8, AfterglowBalance = 43, BlurBalance = 49 (percent).

- Evidence: https://github.com/Abdelrhman-AK/WinPaletter/blob/9a2c8c3bd4037ed578b38c4438bfa4c51e59f8fd/WinPaletter/Theme/Default/Windows7.cs
- Confidence: verified
- Why it matters: These are the only numeric constants needed to match stock Aero's colour; everything else in the glass is derived from them.

### DWMBlurGlass carries the same three numbers as floats (0.08 / 0.43 / 0.49) with the source comment 'these settings are optimal for the default Sky color from Windows 7'.

- Evidence: https://github.com/Maplespe/DWMBlurGlass/blob/8c69c9c4de8994c5cc45fdc7ccde9848ec0997dd/Common/Common.h
- Confidence: verified
- Why it matters: Independent corroboration of the three balances from a separate codebase, which removes the risk of copying one project's taste as if it were Microsoft's default.

### Inactive windows do not merely dim: colorBalance is multiplied by 0.4 and blurBalance is remapped to 0.4*b + 0.6 (0.49 -> 0.796), so inactive glass is brighter and less tinted than active glass.

- Evidence: https://github.com/Maplespe/DWMBlurGlass/blob/8c69c9c4de8994c5cc45fdc7ccde9848ec0997dd/DWMBlurGlassExt/Backdrops/BackdropFactory.cpp
- Confidence: verified
- Why it matters: Focus state in a web OS must drive two separate numbers (tint strength down, backdrop pass-through up), not a single opacity value.

### The blur is a separable two-pass Gaussian parameterised by standard deviation. The registry contract inherited from Glass8 defaults to BlurDeviation = 30 (tenths), decoded as deviation/10*3 = 9.0 compositor units; the Direct3D path uses a standard deviation constant of 3.0.

- Evidence: https://github.com/ALTaleX531/OpenGlass/blob/46e3f13cabdc4c38f43df984e278359207d37285/Common/BlurSettings.hpp
- Confidence: likely
- Why it matters: Gives a defensible blur number instead of a guess: sigma 3 at the historical parameterisation, ~9 in compositor units. DWMBlurGlass's 20 is that app's own default, not Windows 7's.

### CSS blur() takes a standard deviation, not a radius: 'The passed parameter defines the value of the standard deviation to the Gaussian function', and it differs from box-shadow's blur radius.

- Evidence: https://drafts.csswg.org/filter-effects-1/#funcdef-filter-blur
- Confidence: verified
- Why it matters: Makes the DWM number directly portable: backdrop-filter: blur(9px) is the like-for-like translation of the Aero deviation, with no conversion factor.

### The Aero specular highlight is a static bitmap (data/aeropeek.png), drawn with CompositionStretch::None, aligned to 0,0, anchored in monitor space and offset by the window's position times (1 - parallaxIntensity) with parallaxIntensity defaulting to 0.1.

- Evidence: https://github.com/Maplespe/DWMBlurGlass/blob/8c69c9c4de8994c5cc45fdc7ccde9848ec0997dd/DWMBlurGlassExt/Backdrops/GlassReflectionBackdrop.hpp
- Confidence: verified
- Why it matters: The glass streak is screen-anchored, so in a web OS it belongs on a shared, fixed-position layer clipped per window — not as a per-window gradient that slides with the window.

### 7.css arrives at the same model independently: its --w7-w-glass token is a multi-stop gradient stack painted with `left center/100vw 100vh no-repeat fixed`, i.e. a viewport-anchored layer, over a 1px #000000b3 border and an inset 1px #fffa highlight with a 6px radius and 6px frame inset.

- Evidence: https://github.com/khang-nd/7.css/blob/7d3958e707ba97a0718638c273ffeef27ebed73c/gui/_window.scss
- Confidence: verified
- Why it matters: A working CSS proof that the screen-anchored highlight plus a double 1px border (dark outer, white inner) is the whole of the glass edge; no new primitive is needed.

### Caption button geometry is theme data with no published pixel values; the documented runtime route is DwmGetWindowAttribute(DWMWA_CAPTION_BUTTON_BOUNDS), which returns the caption button area in window-relative space.

- Evidence: https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute
- Confidence: verified
- Why it matters: Stops a search for a Microsoft metrics table that does not exist; the numbers must come from measurement or from a reimplementation.

### 7.css's measured caption chrome: minimize/maximize buttons min 29x19 px, close button 48x19 px, control group radius 5px with a 1px #0000004d border and 1px #fffa outer glow; window radius 6px.

- Evidence: https://github.com/khang-nd/7.css/blob/7d3958e707ba97a0718638c273ffeef27ebed73c/gui/_window.scss
- Confidence: verified
- Why it matters: These are the only concrete caption metrics I could source, and they come from a reimplementation that is visually validated against screenshots.

### The Windows UX Guide's only taskbar-related layout number is a reserve: 'reserving 48 vertical relative pixels for windows displayed with the taskbar'. It also fixes the minimum interactive target at 16x16 relative pixels and control spacing at 3 DLUs (5 relative pixels).

- Evidence: https://github.com/MicrosoftDocs/win32/blob/51c9b7cc54ef393b6406c8320a7840fdd88209d5/desktop-src/uxguide/vis-layout.md
- Confidence: verified
- Why it matters: 48 is a layout reserve, not the taskbar height. Treating it as the taskbar height would make the shell 8px too tall.

### Windows Vista/7 default type: CaptionFont 9pt #000000 Segoe UI; MainInstruction 12pt #003399; Instruction and BodyText 9pt #000000; Disabled 9pt #323232; HyperLinkText 9pt #0066CC; hover 9pt #3399FF; group header 11pt #003399; document text Calibri 9pt and headings Calibri 17pt. 'For Segoe UI, use a 9 point font size or larger.'

- Evidence: https://github.com/MicrosoftDocs/win32/blob/51c9b7cc54ef393b6406c8320a7840fdd88209d5/desktop-src/uxguide/vis-fonts.md
- Confidence: verified
- Why it matters: A complete, citable type and colour scale: 9pt = 12px at 96 DPI, 12pt = 16px, 11pt = ~14.7px. 7.css uses exactly these values, so the two agree.

### Segoe UI is not redistributable: the UX Guide instructs 'To license Segoe UI and other Microsoft fonts for distribution with a Windows-based program, contact Monotype.'

- Evidence: https://github.com/MicrosoftDocs/win32/blob/51c9b7cc54ef393b6406c8320a7840fdd88209d5/desktop-src/uxguide/vis-fonts.md
- Confidence: verified
- Why it matters: Shipping a Segoe UI webfont in a hosted web OS is a licensing violation; the font must be a local-family reference with a free fallback.

### Selawik is licensed under the SIL Open Font License 1.1 (Reserved Font Name Selawik). Microsoft describes it as 'a text font as a fallback to Microsoft's Segoe UI typeface'; the repository's own open issues are 'Selawik is missing kerning to match Segoe UI' and 'Selawik needs improved hinting'. Microsoft does not use the words 'metric-compatible' anywhere in the repo.

- Evidence: https://github.com/microsoft/Selawik/blob/89362e84731d1f5777fa078fd4d5ebbd339e4378/LICENSE.txt
- Confidence: verified
- Why it matters: Selawik is the correct free substitute and is safely redistributable, but the common claim of metric compatibility is folklore from Microsoft's own wording; the kerning gap is admitted.

### Aero Snap's thresholds are documented with defaults, and all of them are marked unsupported on Vista/XP (i.e. they are the Windows 7 feature): SPI_GETMOUSEDOCKTHRESHOLD default 1 px (dock when dragged to a monitor edge), SPI_GETMOUSEDRAGOUTTHRESHOLD default 20 px (undock when dragged toward centre), SPI_GETMOUSESIDEMOVETHRESHOLD default 50 px from the top (restore a vertically maximized window), pen equivalents 30/30/50, SPI_GETSNAPSIZING (vertically maximize when sized to the top or bottom edge), SPI_GETDOCKMOVING (dock at top, left, right), SPI_GETDRAGFROMMAXIMIZE (restore a maximized window when its caption is dragged), all gated by SPI_GETWINARRANGING.

- Evidence: https://github.com/MicrosoftDocs/sdk-api/blob/656e9656bfaef34dd29cd7ee9e1146aec17e924c/sdk-api-src/content/winuser/nf-winuser-systemparametersinfoa.md
- Confidence: verified
- Why it matters: This is implementable verbatim: snap arms at 1 px from the edge (pointer, not window), unsnap needs 20 px of travel, and a top-snapped window only restores once the drag is 50 px below the top. Hysteresis is built in, with different arm and release thresholds.

### Wine implements the documented system defaults as MouseHoverTime = 400 ms and MenuShowDelay = 400 ms (both via DWORD registry entries).

- Evidence: https://github.com/wine-mirror/wine/blob/3374e6b4580bf49ed0ba351923f4a687045e3d29/dlls/win32u/sysparams.c
- Confidence: likely
- Why it matters: Gives a sourced 400 ms for generic hover-intent delay, which is also the number daedalOS independently chose for taskbar peek.

### Aero Peek is defined in the DWM docs as 'a full-sized preview of the window when the mouse hovers over the window's thumbnail in the taskbar', during which other windows 'fade to a glass sheet' (DWMWA_EXCLUDED_FROM_PEEK opts out). A window may also declare DWMWA_HAS_ICONIC_BITMAP / DWMWA_FORCE_ICONIC_REPRESENTATION and supply a static bitmap for its thumbnail and peek instead of being captured live, and DWMWA_FREEZE_REPRESENTATION stops live thumbnail updates.

- Evidence: https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute
- Confidence: verified
- Why it matters: Windows itself does not insist on live capture: the kernel-side contract is 'window provides a thumbnail, or DWM captures one'. A web OS can make the app-supplied bitmap the primary path and capture the fallback, which sidesteps the whole element-capture problem.

### daedalOS implements taskbar peek with a 400 ms hover delay and a 200 px max width, over a three-tier capture strategy: a process-declared static peekImage or icon; else, for live elements (canvas/video), drawImage into a 2D canvas every requestAnimationFrame; else html-to-image's toCanvas, throttled to one capture per 250 ms, re-armed by a MutationObserver plus capture-phase scroll listeners, with live sub-elements re-composited on top each frame. Cross-origin iframes cannot be captured, so it falls back to the window element.

- Evidence: https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/components/system/Taskbar/TaskbarEntry/Peek/useWindowPeek.ts
- Confidence: verified
- Why it matters: A working answer to 'live window previews without element capture', with the exact throttle and invalidation strategy, from an MIT-licensed codebase.

### Element Capture's restrictTo() requires a live video track from tab (browser) capture whose target belongs to the captured tab's top-level browsing context, and the target element must form a stacking context, be flattened in 3D, form a backdrop root, have exactly one box fragment, and be rendered.

- Evidence: https://screen-share.github.io/element-capture/
- Confidence: verified
- Why it matters: The backdrop-root requirement directly conflicts with glass: an element that is a backdrop root cuts off backdrop-filter for its descendants, so a window cannot both be element-capturable and blur the desktop behind it through the same node.

### Region Capture's cropTo() crops a getDisplayMedia track to a CropTarget's bounding box, frames stop while the target is empty or scrolled out of view, and cloned tracks start uncropped.

- Evidence: https://www.w3.org/TR/mediacapture-region/
- Confidence: likely
- Why it matters: One permission prompt plus N cloned tracks, each cropped to one window, is the documented route to N simultaneous live previews.

### restrictTo() is flagged on MDN as experimental, not Baseline ('doesn't work in some widely used browsers'), and requires a secure context.

- Evidence: https://developer.mozilla.org/en-US/docs/Web/API/BrowserCaptureMediaStreamTrack/restrictTo
- Confidence: verified
- Why it matters: Element Capture cannot be the only thumbnail path; it is a Chromium-only enhancement over a DOM-rasterisation fallback.

### backdrop-filter filters the pixels behind the element only up to the nearest backdrop root, and backdrop roots include html plus any element with a non-default filter, opacity below 1, mask, clip-path, backdrop-filter, mix-blend-mode, or will-change on one of those.

- Evidence: https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter
- Confidence: verified
- Why it matters: Real blur of other windows IS possible in the DOM: keep every window a sibling under one backdrop root. It breaks the moment a window wrapper animates opacity for a fade, which is exactly what a window manager wants to do.

### mix-blend-mode: plus-lighter is a standard value that blends with the plus-lighter compositing operator.

- Evidence: https://developer.mozilla.org/en-US/docs/Web/CSS/mix-blend-mode
- Confidence: verified
- Why it matters: This is the CSS primitive that matches DWM's D2D1_COMPOSITE_MODE_PLUS, so the additive tint and afterglow terms can be done in the DOM rather than approximated with alpha.

### Superbar rules from the Windows 7 UX Guide: Quick Launch was removed and programs must not add shortcuts to it; each program perceived as separate gets a single taskbar button, with secondary windows, workspace tabs, project windows and MDI children grouped under it as thumbnails; thumbnail toolbars allow at most seven commands (five preferred), must be immediate, single-click, icon-only with a tooltip per command, and disabled rather than hidden when inapplicable; overlay icons are 16x16, drawn bottom-right, must not animate or flash; Jump Lists carry one to three groups, with Tasks as the Windows-assigned command group name, and must work when the program is not running.

- Evidence: https://github.com/MicrosoftDocs/win32/blob/51c9b7cc54ef393b6406c8320a7840fdd88209d5/desktop-src/uxguide/winenv-taskbar.md
- Confidence: verified
- Why it matters: Defines the Win7-vs-XP taskbar precisely enough to implement, including the per-program (not per-window) button identity that a process model must expose.

### Windows 7 notification area: most icons are hidden in the overflow by default, only the user can promote an icon to the visible area, and 'there is no way for your program to perform this promotion automatically'; Windows temporarily promotes a hidden icon when it raises a notification.

- Evidence: https://github.com/MicrosoftDocs/win32/blob/51c9b7cc54ef393b6406c8320a7840fdd88209d5/desktop-src/uxguide/winenv-notification.md
- Confidence: verified
- Why it matters: The tray is a user-owned allowlist with temporary promotion on notification, not an app-controlled surface; that is a policy decision the shell must own, not the app.

### A Windows 7 library is a *.library-ms XML file (namespace http://schemas.microsoft.com/windows/2009/library) holding general info, custom properties, and a searchConnectorDescriptionList of locations, with isDefaultSaveLocation / isDefaultNonOwnerSaveLocation marking the write target and templateInfo/folderType selecting the Explorer view; library files live in FOLDERID_Libraries (%USERPROFILE%\AppData\Roaming\Microsoft\Windows\Libraries).

- Evidence: https://learn.microsoft.com/en-us/windows/win32/shell/library-schema-entry
- Confidence: verified
- Why it matters: A library maps cleanly onto a VFS union mount: N source paths, exactly one designated write target, plus a view template. It is a filesystem feature, not an Explorer feature, so it belongs below the window layer.

### The UX Guide's glass rule is that standard frames get glass automatically and apps may extend glass only into 'small regions touching the window frame without text', and explicitly not where 'a plain window background would be more attractive or easier to use'.

- Evidence: https://github.com/MicrosoftDocs/win32/blob/51c9b7cc54ef393b6406c8320a7840fdd88209d5/desktop-src/uxguide/win-window-frames.md
- Confidence: verified
- Why it matters: Aero's own guidance confines glass to the frame plus small frame-touching strips; a web OS that glasses whole client areas is not more Aero, it is less.

### Documented hover/click animation budget: play an animation within 50 ms of entering or leaving hover and keep hover and click animations under 50 ms; brief transitions are 200 ms or less; attention-getting animations run 1 to 3 seconds; anything under 50 ms long is too brief to be comprehended.

- Evidence: https://github.com/MicrosoftDocs/win32/blob/51c9b7cc54ef393b6406c8320a7840fdd88209d5/desktop-src/uxguide/vis-animations.md
- Confidence: verified
- Why it matters: Gives sourced durations for hover glows and button states instead of invented ones; DWMBlurGlass's own glass crossfade default of 160 ms sits inside the 200 ms transition band.

## Reusable

- 7.css v0.21.0, MIT (khang-nd). Copy gui/_variables.scss and gui/_window.scss wholesale: the element gradient tokens, the --w7-w-glass viewport-anchored highlight stack, the caption-button gradients (--w7-wct-bg, --w7-wct-bg-h with its radial cyan glow, --w7-wct_close-bg), and the double 1px border. Pinned at https://github.com/khang-nd/7.css/blob/7d3958e707ba97a0718638c273ffeef27ebed73c/gui/_window.scss
- daedalOS, MIT (DustinBrett). The peek pipeline is the most complete answer to live window previews on the web: Peek/useWindowPeek.ts (three-tier capture, 250 ms throttle, MutationObserver invalidation) and Peek/functions.ts (captureElement). Also useful as a reference for TASKBAR_HEIGHT / PEEK_MAX_WIDTH / PEEK_DELAY_MS being explicit constants rather than CSS magic numbers.
- html-to-image, MIT (bubkoo). The DOM-to-canvas rasteriser daedalOS depends on; note it needs a patch to skip media content if you intend to composite live video/canvas on top.
- Selawik, SIL OFL 1.1 (microsoft/Selawik). The only free Segoe UI substitute Microsoft itself publishes. Redistributable, including bundled and sold with software, under OFL reserved-font-name rules.
- The Windows UX Guide markdown sources in MicrosoftDocs/win32 under desktop-src/uxguide/ are the citable primary text for Aero's type scale, taskbar rules, glass policy and animation budget. Grep the .md files at a pinned commit rather than fetching the rendered Learn pages, which are far larger.
- MicrosoftDocs/sdk-api at desktop-src equivalent sdk-api-src/content/winuser/nf-winuser-systemparametersinfoa.md is where every Aero Snap threshold and its default lives. It is the single best primary source for Win7 window-arranging behaviour.
- OpenGlass, GPL-3.0 (ALTaleX531). Read OpenGlass/AeroColorizationEffect.hlsl for the exact colorization math and Common/BlurSettings.hpp for the blur-deviation contract. Reimplement from the formula; do not copy the file into a permissive project.
- DWMBlurGlass, LGPL-3.0 (Maplespe). Read DWMBlurGlassExt/Backdrops/AeroBackdrop.hpp for the effect-graph ordering and GlassReflectionBackdrop.hpp for the monitor-anchored, 0.1-parallax reflection model.

## Gotchas

- backdrop-filter and window fade animations are mutually exclusive on the same node. Any ancestor with opacity < 1, a filter, a mask, a clip-path or a mix-blend-mode becomes a backdrop root and silently cuts the blur chain, so the usual 'animate the window wrapper's opacity on open/close' will kill glass for every descendant. Fade an inner child, or cross-fade with plus-lighter.
- Element Capture's eligibility rules fight the glass. restrictTo() demands the target element form a backdrop root; a backdrop root is exactly what stops backdrop-filter from seeing the desktop behind it. One node cannot be both the capturable window and the glass surface — they have to be different elements.
- Element Capture and Region Capture both need a user-granted getDisplayMedia prompt for the tab, every session. There is no silent self-capture. A web OS cannot show taskbar thumbnails on first paint without asking the user to share their own tab.
- DOM rasterisation (html-to-image / html2canvas, SVG foreignObject) cannot capture cross-origin iframes at all, and does not paint <video>/<canvas> content the way the compositor does — daedalOS patches it with a skipMediaContent flag and re-composites live media on top per frame. If apps are iframes from another origin, thumbnails must be app-supplied bitmaps.
- DWMBlurGlass's blurAmount default of 20 is that application's taste, not Windows 7's. The sourced figure is BlurDeviation 3.0 encoded as 30, decoded to ~9 compositor units. Copying 20 gives a visibly softer, more Windows-11 look.
- Aero's three terms are summed, so values clip above 1.0. Reproducing it with stacked rgba() overlays is a multiplicative darkening and will always read as a grey film. plus-lighter is required for the tint and afterglow layers.
- The two reimplementations disagree on the glass reflection default: WinPaletter writes ColorizationGlassReflectionIntensity = 0 as the Windows 7 default while DWMBlurGlass defaults glassIntensity to 1.0. Neither can be taken as Microsoft's shipped value.
- Segoe UI must not be shipped as a webfont. Microsoft's own guidance routes distribution licensing through Monotype. Reference the local family and fall back to Selawik (OFL-1.1).
- 7.css is chrome only: controls, window frame, title bar. It has no taskbar, no Start menu, no window manager, and no process model. It solves the pixels, not the shell.
- OpenGlass is GPL-3.0 and DWMBlurGlass is LGPL-3.0. Read them for the algorithm; copying the shader or effect-graph text into a permissively licensed web OS is a licence problem. WinPaletter's licence resolves to NOASSERTION, so do not vendor anything from it.

## Could not determine

- Windows 7 Aero's own frame metrics at 96 DPI from any primary source: SM_CYCAPTION, SM_CXSIZEFRAME, SM_CXPADDEDBORDER, and the window corner radius. They are supplied by aero.msstyles and are only knowable by reading GetSystemMetrics / SPI_GETNONCLIENTMETRICS / DWMWA_CAPTION_BUTTON_BOUNDS on a running Windows 7. Wine's classic-theme defaults (BorderWidth -15 twips = 1 px, CaptionHeight -270 twips = 18 px, SmCaptionHeight -225 twips = 15 px, PaddedBorderWidth 0) are the classic model, not Aero's.
- Taskbar height, large-icons and small-icons variants. The commonly quoted 40 px / 30 px have no primary source I could find; the UX Guide gives only a 48 relative-pixel layout reserve, and daedalOS's 30 px constant is a Windows 10 figure.
- Start orb dimensions (width, height, and how far it overhangs the taskbar edge). No source found.
- The taskbar thumbnail hover delay and the 'Show desktop' Aero Peek delay. The registry values ExtendedUIHoverTime and DesktopLivePreviewHoverTime appear only in third-party tweak tools (Winhance, talon), never in Microsoft documentation, and I found no stated default. The nearest sourced number is the generic MouseHoverTime default of 400 ms.
- Aero Shake's exact gesture rule: how many direction reversals, over what distance, in what time window. Only the Group Policy knob that disables it (NoWindowMinimizingShortcuts) turned up, and only inside third-party policy repositories.
- Windows 7's own shipped Gaussian standard deviation. The sigma 3 / blur-amount 9 figures come from the Glass8 registry contract preserved by OpenGlass, not from Microsoft.
- The provenance of DWMBlurGlass's data/aeropeek.png reflection texture. It is loaded at runtime from the install directory and is not in the repository, so the actual Aero highlight bitmap was not inspected.
- Explorer's breadcrumb address bar, details pane, and library-view interaction rules. No UX Guide page covers them; the uxguide file list has no Explorer chrome article, and winenv-desktop.md does not address them. Only the library file format itself is documented.
- Whether Selawik is genuinely metric-compatible with Segoe UI at the advance-width level. Microsoft only calls it a 'fallback' and admits missing kerning; I did not have Segoe UI available to compare metrics directly.
- The Chrome version that shipped Element Capture. developer.chrome.com/blog/element-capture returns 404 and web.archive.org is unreachable from this environment; MDN confirms only that the feature is experimental and not Baseline.

