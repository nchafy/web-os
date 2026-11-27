// M11: the Aero skin. Every number Windows 7's glass is made of, once, and the stylesheet derived
// from them.
//
// THERE IS NO SYSCALL IN THIS FILE, and no DOM structure either: `src/wm/window.mjs` builds the
// frame and this file says what it looks like. The split is deliberate — the frame is behaviour a
// check drives, the skin is pixels a check samples, and a milestone that mixed them would have no
// way to run M7's geometry checks against an unskinned window.
//
// ## Why the frame is FOUR glass strips and not one glass node
//
// `backdrop-filter` filters the element's BORDER BOX
// (https://drafts.csswg.org/filter-effects-2/#BackdropFilterProperty), so one glass node with an
// opaque client child painted over its middle hides the blur without saving any of it. Measured at
// 640x440, `bench/m11-glass/probe.py`:
//
//     geometry          filtered CSS px^2   glass nodes   windows to gap-04's 58 M wall
//     one box node             281,600            1                    51
//     four strips               27,260            4                   531
//
// The box figure reproduces gap-04's own measured "~51 windows of 640x440" exactly, which is what
// makes the ring figure trustworthy: the same accounting, applied to a different geometry. So
// `docs/DECISIONS.md` D13's "~11x cheaper" is true of the ring and false of the box — 10.33x
// measured — and the ring is the only geometry in which frame-only glass is frame-only in the unit
// that costs (constraint 49, `docs/designs/REVIEW-FINDINGS.md` §3).
//
// The bill for it is FOUR offscreen buffers and four filter passes per window instead of one
// (`docs/research/05-platform-primitives.md`). gap-04 measured area as the predictor and layer
// count as free up to 60 layers; four strips at 52 windows is 208, which is past anything measured.
// M12 owns that, and `MILESTONES.md` records it as owed rather than assumed here.

import { WIN_CAP_H, WIN_INSET, blurRingArea, blurBoxArea } from "../abi.mjs";

/* ---- The recipe ---------------------------------------------------------------------------
 *
 * Aero is an ADDITIVE composite, not a translucent panel (constraint 34): blurred RGB scaled by
 * blurBalance, plus a Rec.709 luminance copy tinted by the afterglow colour, plus a flat
 * colorization tint, summed with PLUS so the result can clip above 1.0. Alpha-stacked rgba() is a
 * multiplicative darkening and always reads as a grey film.
 *
 * Sources, all pinned:
 *   the shader   https://github.com/ALTaleX531/OpenGlass/blob/46e3f13cabdc4c38f43df984e278359207d37285/OpenGlass/AeroColorizationEffect.hlsl
 *   the balances https://github.com/Abdelrhman-AK/WinPaletter/blob/9a2c8c3bd4037ed578b38c4438bfa4c51e59f8fd/WinPaletter/Theme/Default/Windows7.cs
 *   the blur     https://github.com/ALTaleX531/OpenGlass/blob/46e3f13cabdc4c38f43df984e278359207d37285/Common/BlurSettings.hpp
 */

/** Windows 7's shipped ColorizationColor, RGB(116,184,252) — the "Sky" default. */
export const COLORIZATION = Object.freeze({ r: 116, g: 184, b: 252 });

/** The three shipped balances, as fractions. ColorBalance 8, AfterglowBalance 43,
 *  BlurBalance 49 (percent). */
export const BLUR_BALANCE = 0.49;
export const AFTERGLOW_BALANCE = 0.43;
export const COLOR_BALANCE = 0.08;

/** The Gaussian standard deviation, in CSS px. BlurDeviation 30 (tenths) decodes to 9.0 compositor
 *  units, and CSS `blur()` takes a standard deviation rather than a radius
 *  (https://drafts.csswg.org/filter-effects-1/#funcdef-filter-blur), so the DWM figure ports with
 *  no conversion factor. DWMBlurGlass's 20 is that application's taste, not Windows 7's. */
export const BLUR_SIGMA = 9;

/**
 * INACTIVE GLASS IS BRIGHTER AND LESS TINTED, not dimmer. Focus drives two numbers: the
 * colorization is multiplied by 0.4 and the blur balance is remapped to `0.4*b + 0.6`, so 0.49
 * becomes 0.796 — MORE of the backdrop passes through, not less. A single opacity value cannot
 * express that, which is why this is a pair.
 */
export const INACTIVE_COLOR_SCALE = 0.4;
export const inactiveBlurBalance = (b = BLUR_BALANCE) => 0.4 * b + 0.6;

/**
 * THE ONE DEPARTURE FROM THE SHADER, stated where a reader meets it.
 *
 * The afterglow term is `luminance709(blurredRGB) * afterglowRGB` — it depends on the blurred
 * backdrop's own luminance, and no CSS layer can read that: `backdrop-filter` produces one filtered
 * copy of the backdrop and a `plus-lighter` sibling layer sees a colour, never the pixels beneath
 * it. A second backdrop-filtered node would give a desaturated copy, but its backdrop would be the
 * FIRST node's output rather than the desktop, so the layering is wrong and the cost doubles.
 *
 * So the afterglow is approximated as a FLAT additive term. Under that approximation — and because
 * Windows 7 uses the same Sky colour for the afterglow and the colorization — the afterglow and
 * colorization terms sum to one additive layer, and collapsing them is exact rather than a second
 * simplification. The two balances stay named because they are the cited numbers; the alpha the
 * stylesheet uses is DERIVED from them and is never written down.
 *
 * What is lost: glass over a bright backdrop should afterglow more than glass over a dark one. It
 * does not. The blur, which is what constraint 50's check is about, is unaffected.
 */
export const ADDITIVE_ALPHA = AFTERGLOW_BALANCE + COLOR_BALANCE;

/* ---- The metrics -------------------------------------------------------------------------
 *
 * Windows 7's own Aero frame metrics are NOT knowable from any primary source: they live in
 * aero.msstyles and are only readable from GetSystemMetrics / DWMWA_CAPTION_BUTTON_BOUNDS on a
 * running Windows 7 (`docs/research/06-aero-spec.md` §Could not determine). These come from 7.css,
 * a reimplementation validated against screenshots, which is the only sourced set that exists:
 * https://github.com/khang-nd/7.css/blob/7d3958e707ba97a0718638c273ffeef27ebed73c/gui/_window.scss
 */

/* THE CAPTION HEIGHT AND THE INSET COME FROM `src/abi.mjs` NOW, and they moved there in M12 for
 * the reason everything in that file is there: they became a fact both sides must agree on. The
 * blur governor is the kernel's — only the kernel owns the z-order it degrades by and sees every
 * area-changing call — and constraint 49 requires it to account each glass element's BORDER BOX.
 * So the ring's geometry is no longer the skin's private business. Re-exported under the names
 * this stylesheet has always used, because every rule below reads them. */
export const CAP_H = WIN_CAP_H;
export const INSET = WIN_INSET;
/** 7.css's window radius, on the top corners only — a Win7 frame's bottom corners are square. */
export const RADIUS = 6;
/** Caption buttons: minimize and maximize at 29x19, close wider at 48x19. */
export const BTN_W = 29;
export const BTN_H = 19;
export const CLOSE_W = 48;

/** 9 pt at 96 DPI. The UX Guide's CaptionFont and BodyText size, and "for Segoe UI, use a 9 point
 *  font size or larger". */
export const FONT_PX = 12;

/* ---- M14: the shell's own metrics ---------------------------------------------------------
 *
 * THEY LIVE HERE FOR `CAP_H`'s REASON. The taskbar's height is not a look: it is the strip the
 * shell reserves, so `WinHost.reserve` subtracts it from the desktop and every maximized window is
 * laid out against what is left. A second copy is how a window comes to cover the taskbar.
 *
 * Windows 7's own figures where they are knowable: a 40 px taskbar with large icons, and a 48 px
 * desktop icon grid at 75 px of label pitch. The rest are 7.css's or are stated as choices.
 */

/** The taskbar's height, in CSS px. Windows 7's large-icon default. */
export const TASKBAR_H = 40;

/** A Superbar button: Windows 7 sizes these to fit the bar's height less a 2 px gutter. */
export const TASK_BTN_H = TASKBAR_H - 6;
export const TASK_BTN_W = 160;

/**
 * THE SHRINK FLOOR, in CSS px: how narrow a Superbar button is allowed to get before the band stops
 * shrinking and starts scrolling.
 *
 * Windows 7 narrows its buttons and then groups them, and narrowing to nothing is how a label
 * becomes unreadable — so this is a floor and not a minimum-nice-size. It is exported because the
 * floor and the overflow mechanism are one decision: `Taskbar` reads it to say how many buttons the
 * band can hold at its current width, which is what makes "past the floor" a measured state rather
 * than a guess. 42 px is the icon plus its gutters, which is a button with no label at all.
 */
export const TASK_BTN_MIN_W = 42;

/** A band scroll chevron, in CSS px. Windows 7 puts a two-arrow pane at the end of an overflowing
 *  bar; this is one pane per direction, sized to the bar the way `show-desktop` is. */
export const BAND_CHEV_W = 15;

/** The start orb: round, and wider than it is tall because it carries the bar's full height. */
export const ORB = TASKBAR_H - 4;

/** A desktop icon's drawing, and the cell it sits in. Windows 7's own 48 px icon on a 75 px
 *  pitch, which is what makes two rows of labels fit without touching. */
export const ICON_PX = 48;
export const ICON_CELL_W = 86;
export const ICON_CELL_H = 88;

/** A hover thumbnail, as Windows 7 sizes an Aero Peek preview: wide enough to read a caption. */
export const THUMB_W = 196;
export const THUMB_H = 120;

/** How many thumbnails sit in one row of a preview panel before it wraps. The panel's own width
 *  is DERIVED from this and `THUMB_W`; a cap written as a pixel number is how a strip comes to be
 *  wider than the glass it is drawn on. */
export const THUMBS_PER_ROW = 4;

/**
 * Segoe UI MUST NOT be shipped — it is not redistributable, and Microsoft routes distribution
 * licensing through Monotype (constraint 37). So the family is REFERENCED and never served: a
 * reader who has it gets it, everyone else falls through. Selawik is the only free substitute
 * Microsoft itself publishes (SIL OFL 1.1) and is named for the same reason — referenced, not
 * bundled.
 *
 * Selawik is NOT documented as metric-compatible and its own repository lists missing kerning as an
 * open issue, so constraint 37 requires every layout to be measured against both. THAT CANNOT BE
 * DONE HERE: Segoe UI cannot legally be obtained for the comparison, which is why nothing in this
 * file depends on a glyph advance. The caption is a flex row that truncates, the buttons are fixed
 * boxes, and `src/wm/winhost.mjs` measures the terminal cell from a real rendered glyph rather than
 * assuming 8x16.
 */
export const UI_FONT =
  '"Segoe UI", Selawik, system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

/**
 * The filtered area of one window's frame, in CSS px^2 — the sum of each glass strip's own border
 * box, which is the unit `backdrop-filter` charges in and the unit constraint 49 requires a
 * governor to account.
 *
 * THIS IS THE ONE DEFINITION. M12's admission controller must call it rather than restate it: a
 * second copy is how a governor comes to believe a geometry the stylesheet does not render, which
 * is the ~17x under-read constraint 49 exists to forbid.
 */
export const ringArea = blurRingArea;

/** The same window as ONE glass node, for the comparison D13 rests on. Kept beside `ringArea` so
 *  the two are read together and the ratio is never quoted without both. */
export const boxArea = blurBoxArea;

const additive = (alpha) =>
  `rgba(${COLORIZATION.r}, ${COLORIZATION.g}, ${COLORIZATION.b}, ${alpha.toFixed(3)})`;

/**
 * The skin, as one stylesheet.
 *
 * Generated from the constants above rather than written as a `.css` file, for the reason
 * `CLAUDE.md`'s single-source table gives: `CAP_H` and `INSET` are the terms of `ringArea`, and a
 * stylesheet carrying 29 and 6 as literals is the drift that makes a governor account a frame
 * nobody renders. There is no build step here, so deriving at runtime is the only way the two can
 * be one definition.
 */
export function styleSheet() {
  /* THE CSS BELOW IS A TEMPLATE LITERAL, SO A BACKTICK IN A COMMENT ENDS IT. Every reference in
   * these comments uses 'single quotes' for that reason, and it has broken the module twice —
   * `node --check src/wm/aero.mjs` names the line at once, and the m11 check comes out BROKEN
   * rather than failing, because nothing that imports this file loads. */
  return `
/* ---- the desktop ---------------------------------------------------------------------- */
/* The one BACKDROP ROOT every strip blurs. Every window is a SIBLING under it: a wrapper per
 * window carrying opacity, a filter, a mask, a clip-path or a mix-blend-mode would become a
 * backdrop root and silently cut the blur chain for everything inside it — measured, and the
 * failure has no symptom except flat glass (docs/designs/REVIEW-FINDINGS.md §8). That is why
 * nothing below animates opacity, and why the sheen layers are DESCENDANTS of their strip. */
.aero-desktop {
  position: relative;
  overflow: hidden;
  font: ${FONT_PX}px/1.4 ${UI_FONT};
  background:
    radial-gradient(120% 90% at 78% 18%, rgba(104,170,222,.55) 0%, transparent 62%),
    radial-gradient(100% 80% at 8% 96%, rgba(6,22,42,.65) 0%, transparent 70%),
    linear-gradient(168deg, #3a74ab 0%, #1b4a78 52%, #0d2944 100%);
}

/* ---- the frame ------------------------------------------------------------------------ */
/* NO backdrop-filter, no opacity, no transform-with-filter: the frame is a transparent box that
 * positions four strips and a client area. Its own border box is never filtered, which is the
 * whole of why the ring is 10.33x cheaper than the box. */
.aero-desktop .window {
  /* POSITIONED, and this is load-bearing rather than tidy. 'src/wm/window.mjs' writes left, top,
   * width and height inline and never 'position', so a sheet that omitted it left the frame
   * 'static': the four strips then resolved their own 'bottom: 0' against the DESKTOP instead of
   * the frame, and the ring measured 41,100 CSS px^2 against a formula of 26,780 while every
   * window sat stacked at the top left. Measured, and the ring proof is what caught it. */
  position: absolute;
  /* Likewise: the strips are inset by the frame's own edges, so a content box would put the right
   * and bottom strips outside the box 'apply()' sized. */
  box-sizing: border-box;
  background: transparent;
  border: 0;
  border-radius: ${RADIUS}px ${RADIUS}px 2px 2px;
  /* The outer ring and the drop shadow. box-shadow does not establish a backdrop root, so the
   * shadow is free of the blur chain. The 1 px dark outer and 1 px light inner line are the whole
   * of the Aero edge; 7.css arrives at the same pair independently. */
  box-shadow:
    0 0 0 1px rgba(0,0,0,.70),
    inset 0 0 0 1px rgba(255,255,255,.28),
    0 12px 30px rgba(0,0,0,.45);
  color: #fff;
  font: ${FONT_PX}px/1.4 ${UI_FONT};
  /* The frame positions its strips. 'display:flex' is what the unskinned pages use and it is
   * overridden here, because the strips are absolute and the client area is inset on four sides. */
  display: block;
}

/* ---- the four glass strips ------------------------------------------------------------ */
/* Each strip's own border box IS part of the ring, which is the point. The filter chain carries
 * brightness(${BLUR_BALANCE}) because Aero scales the blurred backdrop by blurBalance before
 * adding the other two terms; the additive layers add them back. */
.aero-desktop .aero-strip {
  position: absolute;
  backdrop-filter: blur(${BLUR_SIGMA}px) brightness(${BLUR_BALANCE}) saturate(1.25);
  background: transparent;
  box-sizing: border-box;
}
.aero-desktop .aero-cap {
  left: 0; right: 0; top: 0; height: ${CAP_H}px;
  border-radius: ${RADIUS}px ${RADIUS}px 0 0;
  display: flex; align-items: center; gap: 6px;
  padding: 0 4px 0 ${INSET + 2}px;
}
.aero-desktop .aero-left { left: 0; top: ${CAP_H}px; bottom: 0; width: ${INSET}px }
.aero-desktop .aero-right { right: 0; top: ${CAP_H}px; bottom: 0; width: ${INSET}px }
.aero-desktop .aero-bottom {
  left: ${INSET}px; right: ${INSET}px; bottom: 0; height: ${INSET}px;
  border-radius: 0 0 2px 2px;
}

/* The additive term: the afterglow and colorization, summed (see ADDITIVE_ALPHA). plus-lighter is
 * the CSS operator matching DWM's D2D1_COMPOSITE_MODE_PLUS, so the result can clip above 1.0 and
 * reads as lit rather than painted. A DESCENDANT of its strip, never an ancestor. */
.aero-desktop .aero-sheen {
  position: absolute; inset: 0; pointer-events: none;
  background: ${additive(ADDITIVE_ALPHA)};
  mix-blend-mode: plus-lighter;
}

/* The specular highlight. ANCHORED TO THE VIEWPORT, not to the window: Aero's streak is a bitmap
 * in monitor space, so 'background-attachment: fixed' is the right primitive and a per-window
 * gradient that slid with the window would be the wrong one. 7.css reaches the same conclusion.
 *
 * DEPARTURE: Aero parallaxes the streak at 0.1 — it moves 10% of the window's own motion. 'fixed'
 * is parallax 0.0. Closing that needs the window's position in the gradient's offset, which is a
 * style write per drag frame; it is not worth a main-thread write per frame for 10% of a highlight
 * and is recorded rather than silently approximated. */
.aero-desktop .aero-light {
  position: absolute; inset: 0; pointer-events: none;
  mix-blend-mode: plus-lighter;
  background:
    linear-gradient(103deg,
      rgba(255,255,255,0) 0%,
      rgba(255,255,255,.16) 18%,
      rgba(255,255,255,.04) 34%,
      rgba(255,255,255,0) 52%,
      rgba(255,255,255,.10) 74%,
      rgba(255,255,255,0) 100%)
    left center / 100vw 100vh no-repeat fixed;
}

/* INACTIVE GLASS: more backdrop through, less tint. Two numbers, not one opacity. ':focus-within'
 * is the honest page-side reading of "this window holds the keyboard" — it needs no new state and
 * cannot disagree with where the keystrokes are actually going. */
.aero-desktop .window:not(:focus-within) .aero-strip {
  backdrop-filter: blur(${BLUR_SIGMA}px) brightness(${inactiveBlurBalance().toFixed(3)}) saturate(1.1);
}
.aero-desktop .window:not(:focus-within) .aero-sheen {
  background: ${additive(ADDITIVE_ALPHA * INACTIVE_COLOR_SCALE)};
}

/* ---- the caption --------------------------------------------------------------------- */
/* The GLOW is load-bearing, not decoration. Caption text sits over a blurred backdrop whose
 * luminance is unknown — the same caption crosses black and white in one drag — so no single text
 * colour has a contrast ratio. Windows 7 solves it with DrawThemeTextEx and a glow size; here that
 * is a halo of the opposite luminance, which gives the glyph LOCAL contrast wherever it lands.
 * 'scripts/check.py''s m11 check asserts exactly that, at both ends of a black/white seam. */
/* THE CAPTION'S ICON. 16 px is Windows 7's own caption icon, and it sits before the title with
   the same 6 px gap the caption's flex row uses. It is EMPTY on a window whose program the shell
   does not recognise, so the rule must not reserve space for nothing. */
.aero-desktop .window-icon {
  flex: 0 0 auto;
  display: flex; align-items: center;
  position: relative; z-index: 2;
  filter: drop-shadow(0 1px 1px rgba(0,16,38,.75));
}
.aero-desktop .window-icon:empty { display: none }
.aero-desktop .window-title h2 {
  font: 600 ${FONT_PX}px/1 ${UI_FONT};
  margin: 0; flex: 1 1 auto; min-width: 0;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  position: relative; z-index: 2;
  color: #fff;
  text-shadow:
    0 0 3px rgba(0,16,38,.95), 0 0 6px rgba(0,16,38,.85),
    0 0 10px rgba(0,16,38,.60), 0 1px 1px rgba(0,16,38,.90);
}
.aero-desktop .title-buttons {
  display: flex; align-items: center; gap: 2px;
  position: relative; z-index: 2;
}
.aero-desktop .title-box {
  font: ${FONT_PX}px/1 ${UI_FONT};
  width: ${BTN_W}px; height: ${BTN_H}px;
  display: grid; place-items: center;
  color: #0b1b2b;
  border: 1px solid rgba(0,0,0,.30);
  border-radius: 3px;
  background: linear-gradient(rgba(255,255,255,.80), rgba(255,255,255,.42) 48%, rgba(255,255,255,.60));
  box-shadow: 0 0 0 1px rgba(255,255,255,.55);
  cursor: pointer;
  padding: 0;
}
/* 7.css's radial cyan hover glow. Within the UX Guide's 50 ms hover budget. */
.aero-desktop .title-box:hover:not([disabled]) {
  background:
    radial-gradient(120% 160% at 50% 120%, rgba(120,225,255,.95) 0%, rgba(255,255,255,.55) 70%),
    linear-gradient(rgba(255,255,255,.85), rgba(255,255,255,.50));
  transition: background 50ms linear;
}
.aero-desktop .window-close { width: ${CLOSE_W}px }
.aero-desktop .window-close:hover {
  background:
    radial-gradient(120% 160% at 50% 120%, rgba(255,140,120,.95) 0%, rgba(255,235,230,.6) 70%),
    linear-gradient(rgba(255,210,200,.9), rgba(230,120,100,.75));
}
/* DISABLED AND VISIBLE, which is Windows 7's own rule for an inapplicable caption command. There
 * is no taskbar to minimize into and no snap state to maximize to until M14, so these two are
 * drawn and inert — and a check asserts they are inert, because a button that looks live and does
 * nothing is worse than one that says it cannot. */
.aero-desktop .title-box[disabled] {
  cursor: default;
  color: rgba(11,27,43,.40);
  background: linear-gradient(rgba(255,255,255,.42), rgba(255,255,255,.22));
  box-shadow: 0 0 0 1px rgba(255,255,255,.28);
}
/* The End Process affordance the not-responding detector reveals. Red, because it kills. */
.aero-desktop .window-end {
  width: auto; padding: 0 7px;
  background: linear-gradient(rgba(255,196,186,.92), rgba(206,72,52,.86));
  color: #fff;
}
/* AND 'hidden' MUST STILL HIDE IT. The rule above gives .title-box 'display: grid', and an AUTHOR
 * declaration of 'display' beats the UA stylesheet's '[hidden] { display: none }' — so the moment
 * this skin existed, End Process was offered on every healthy window, which is M7's
 * not-responding affordance permanently on and the escape hatch for a wedged process indistinguish-
 * able from an idle one.
 *
 * Found by LOOKING AT IT: 'bench/m11-glass/shell.py''s screenshot, on the real desktop. No check
 * caught it, because 'src/wm/window.mjs' sets the attribute correctly and M7's page is unskinned —
 * so M7 asserts on a frame this rule never touched. 'scripts/check.py''s m11 check asserts it now. */
.aero-desktop .title-box[hidden] { display: none }

/* ---- the client area ------------------------------------------------------------------ */
/* OPAQUE, and inset on four sides so the strips surround it without overlapping — the ring area
 * is a sum of disjoint boxes or it is not the ring. Windows 7's own rule allows glass only in
 * "small regions touching the window frame without text", so an opaque client area is more
 * faithful rather than a concession. */
.aero-desktop .window-body {
  position: absolute;
  left: ${INSET}px; right: ${INSET}px; top: ${CAP_H}px; bottom: ${INSET}px;
  display: flex; min-height: 0;
  background: #f4f7fb;
  border-top: 1px solid rgba(255,255,255,.65);
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.18);
  color: #10212f;
  overflow: hidden;
}
.aero-desktop .terminal {
  margin: 0; flex: 1 1 auto; min-width: 0;
  padding: 6px 8px;
  font: ${FONT_PX}px/1.45 ui-monospace, Menlo, Consolas, monospace;
  background: #fbfdff; color: #17242f;
  white-space: pre-wrap; overflow: auto;
  outline-offset: -2px;
}
/* THE BACKGROUND IS THE SKIN'S AND THE EXTENT IS NOT, which is M16's proposed D40. A surface's
 * CSS box is its contract with the kernel — the accounted area has to be the visible area or
 * constraint 49's governor charges for a rectangle nobody renders — so 'src/wm/surface.mjs' sets
 * width, height, flex and both min-* floors inline, on every host. This file carried no sizing at
 * all while four proof pages each carried their own, so the shipped desktop was the one place a
 * surface did NOT fill its client area and no proof could see it. A copy here would make five
 * statements of a fact with one owner. */
.aero-desktop .window-body canvas { background: #fff }

/* ---- the states the kernel reports --------------------------------------------------- */
/* Each is a frame a reader can tell apart, and each is already published as a dataset flag by
 * src/wm/window.mjs — the class is the look and the dataset is the fact. */
.aero-desktop .is-not-responding .window-title h2 { color: #d8dde2 }
.aero-desktop .is-not-responding .aero-sheen { background: rgba(190,190,190,.28) }
.aero-desktop .is-blocked { box-shadow: 0 0 0 1px rgba(0,0,0,.55), 0 8px 18px rgba(0,0,0,.35) }
.aero-desktop .is-blocked .aero-sheen { background: ${additive(ADDITIVE_ALPHA * 0.25)} }
/* The one-frame flash that marks a REFUSED raise. A click that did nothing reads as a broken
 * window, and the modal is where the user has to go. */
.aero-desktop .is-blocking .aero-cap {
  background: rgba(255,236,150,.55);
}
.aero-desktop .window[data-window-mode="3"] {
  box-shadow: 0 0 0 1px rgba(216,209,74,.95), 0 12px 30px rgba(0,0,0,.45);
}
.aero-desktop .window[data-drop-target="1"] .aero-strip {
  backdrop-filter: blur(${BLUR_SIGMA}px) brightness(${BLUR_BALANCE}) saturate(1.8);
}
.aero-desktop .window[data-drop-target="1"] .window-body {
  box-shadow: inset 0 0 0 2px rgba(120,205,255,.95);
}
/* ---- M12: a window the governor took the glass from ---------------------------------- */
/* THE FILTER GOES AND A FLAT FILL TAKES ITS PLACE. The whole point is to stop paying for the blur,
 * so this must REMOVE 'backdrop-filter' rather than change it: 'blur(0px)' still costs an offscreen
 * buffer and a filter pass, which is the cost being shed.
 *
 * The fill is the colorization colour at the same additive weight the glass carries, so a degraded
 * window reads as the same window rather than as a different theme — Windows 7's own basic theme
 * does the same thing with the same colour. */
.aero-desktop .window.is-flat .aero-strip {
  backdrop-filter: none;
  background: ${additive(ADDITIVE_ALPHA)};
}
/* And its additive layers go with it: a 'plus-lighter' layer over a flat fill is a second
 * compositing pass bought for nothing once there is no backdrop showing through. */
.aero-desktop .window.is-flat .aero-sheen,
.aero-desktop .window.is-flat .aero-light { display: none }
/* A FLAT WINDOW STILL SHOWS WHETHER IT HAS THE KEYBOARD. The inactive look was carried by the
 * strip's brightness and the sheen, and this rule removes both — so a degraded unfocused caption
 * was pixel-identical to a degraded focused one, and a desktop under the governor lost the one cue
 * that says which window you are typing into. The fill carries it instead, on the same 0.4 scale
 * the glass uses. */
.aero-desktop .window.is-flat:not(:focus-within) .aero-strip {
  background: ${additive(ADDITIVE_ALPHA * INACTIVE_COLOR_SCALE)};
}

.aero-desktop .drag-image {
  font: ${FONT_PX}px/1.3 ${UI_FONT};
  padding: 3px 7px; border-radius: 3px;
  background: rgba(16,38,62,.82); color: #eaf4ff;
  box-shadow: 0 0 0 1px rgba(255,255,255,.45), 0 4px 12px rgba(0,0,0,.5);
}

/* ---- M14: Aero Snap's ghost ----------------------------------------------------------- */
/* WHERE THE WINDOW WOULD LAND, drawn while the pointer holds an edge. Windows 7 shows a
   translucent pane with a bright border, and the border is the load-bearing half: over a dark
   desktop a translucent fill alone is nearly invisible.

   NO TRANSITION AND NO OPACITY ANIMATION. An animated opacity on a child of the backdrop root
   would establish one and sever the blur chain for a frame at a time, which is the failure with no
   symptom (docs/designs/REVIEW-FINDINGS.md section 8). */
/* TWO TONES, DARK OUTSIDE LIGHT, because one tone only has contrast against one backdrop. A
   near-white 2 px border is crisp over a dark desktop and INVISIBLE over a light one — reported
   from a page whose right half is white, and true of any pale wallpaper. Pairing the light ring
   with a dark one outside it means whichever tone the backdrop swallows, the other is the one that
   shows: the edge carries its own contrast rather than borrowing the desktop's. Windows 7's own
   preview pane is drawn the same way. */
.aero-desktop .snap-preview {
  z-index: 2147483000;
  border-radius: 3px;
  background: rgba(146,200,245,.22);
  box-shadow:
    inset 0 0 0 2px rgba(220,240,255,.9),
    inset 0 0 0 3px rgba(10,30,52,.75),
    0 0 0 1px rgba(10,30,52,.55),
    0 0 18px rgba(120,190,245,.45);
}
.aero-desktop .snap-preview[hidden] { display: none }

/* ---- M14: a window the shell has docked ----------------------------------------------- */
/* A MAXIMIZED FRAME LOSES ITS ROUNDED TOP CORNERS, which is Windows 7's own behaviour and is not
   decoration: a rounded corner against the top of the work area shows a wedge of desktop through
   a window that is supposed to be filling it. */
.aero-desktop .window.is-maximized { border-radius: 0 }
.aero-desktop .window.is-maximized .aero-cap { border-radius: 0 }
/* The grips go with the geometry: a docked window's size is the state's, so a resize would be
   undone by the next layout. 'src/wm/window.mjs' refuses the gesture; this stops the cursor
   promising it. */
.aero-desktop .window.is-maximized .window-grip,
.aero-desktop .window.is-snapped .window-grip,
.aero-desktop .window.is-desktop .window-grip { display: none }

/* ---- M14: the desktop window ---------------------------------------------------------- */
/* NO FRAME AT ALL. The desktop is a window — it has an fd, a process and a place in the stack —
   and it is the one window that must look like none: no caption, no glass ring, no shadow, and a
   transparent client area so the wallpaper underneath is what a reader sees. */
.aero-desktop .window.is-desktop {
  box-shadow: none;
  border-radius: 0;
}
.aero-desktop .window.is-desktop .window-title,
.aero-desktop .window.is-desktop .aero-strip { display: none }
.aero-desktop .window.is-desktop .window-body {
  position: absolute; inset: 0;
  background: transparent;
  border-top: 0;
  box-shadow: none;
  overflow: hidden;
}

/* ---- M14: the Superbar ----------------------------------------------------------------- */
/* THE TASKBAR IS A GLASS STRIP, and it carries the same '.aero-strip' class the frame's four
   strips do — one definition of what glass is, so the bar cannot drift from the windows above it.
   What is added here is only its geometry and the things that sit in it. */
.aero-desktop .taskbar {
  left: 0; right: 0; bottom: 0; height: ${TASKBAR_H}px;
  display: flex; align-items: center; gap: 4px;
  padding: 0 4px;
  /* ABOVE EVERY WINDOW. The window stack's z-indexes start at 1 and grow with the window count,
     so this is a number no stack can reach rather than a number one window above the current top.
     A taskbar a maximized window could cover is a taskbar a user cannot get back to. */
  z-index: 2147482000;
  border-top: 1px solid rgba(255,255,255,.35);
  box-shadow: 0 -1px 0 rgba(0,0,0,.45), 0 -8px 20px rgba(0,0,0,.28);
  font: ${FONT_PX}px/1.2 ${UI_FONT};
  color: #eaf4ff;
}

/* The start orb. ROUND, GLOSSY, AND NOT A WINDOWS FLAG: the four-pane flag is Microsoft's mark,
   so the glyph here is the same little window this project draws for a program icon
   (src/wm/icons.mjs). The orb's own look — a radial sheen with a bright rim — is the Aero grammar
   and is what makes it read as a button. */
.aero-desktop .taskbar-start {
  flex: 0 0 auto;
  width: ${ORB}px; height: ${ORB}px;
  border-radius: 50%;
  border: 1px solid rgba(255,255,255,.55);
  background:
    radial-gradient(120% 120% at 35% 22%, rgba(255,255,255,.85) 0%, rgba(255,255,255,.12) 42%,
      rgba(255,255,255,0) 60%),
    radial-gradient(90% 90% at 50% 120%, rgba(120,225,255,.85) 0%, rgba(26,98,160,.95) 70%),
    linear-gradient(#2b85c8, #10436f);
  box-shadow: 0 0 0 1px rgba(0,0,0,.5), inset 0 1px 1px rgba(255,255,255,.6),
    0 2px 6px rgba(0,0,0,.45);
  display: grid; place-items: center;
  cursor: pointer; padding: 0;
}
.aero-desktop .taskbar-start:hover {
  background:
    radial-gradient(120% 120% at 35% 22%, rgba(255,255,255,.95) 0%, rgba(255,255,255,.22) 42%,
      rgba(255,255,255,0) 60%),
    radial-gradient(90% 90% at 50% 120%, rgba(170,240,255,.95) 0%, rgba(40,130,200,.95) 70%),
    linear-gradient(#3c9ade, #15568c);
}
.aero-desktop .taskbar-start .wicon { filter: drop-shadow(0 1px 1px rgba(0,0,0,.5)) }

/* The band of program buttons, and the two chevrons that reach past it.

   IT SHRINKS FIRST AND THEN SCROLLS: Windows 7 narrows its buttons to a floor and then gives the
   bar a scroll pane, and narrowing to nothing is how a label becomes unreadable. TASK_BTN_MIN_W
   is that floor, and overflow-x: auto is what makes the overflow past it REACHABLE rather than
   clipped — which it was, under an overflow: hidden whose own comment claimed it scrolled.

   THE SCROLLBAR IS HIDDEN AND THE CHEVRONS ARE THE AFFORDANCE. A horizontal scrollbar inside a
   40 px bar takes its height from the buttons, and on macOS it is an overlay a reader cannot see
   until they are already scrolling. Measured in Chrome 157: a mouseWheel with deltaX: 120 over
   this element moves scrollLeft to 120 and the same event with deltaY: 120 moves it to 0, so a
   plain vertical-wheel mouse has no native route at all and the chevrons are not decoration.

   .is-clipped IS M22's band-clips CONTROL — the world this element used to be in. */
.aero-desktop .taskbar-bandwrap {
  flex: 1 1 auto; min-width: 0;
  display: flex; align-items: center; gap: 2px;
}
.aero-desktop .taskbar-band {
  flex: 1 1 auto; min-width: 0;
  display: flex; align-items: center; gap: 3px;
  overflow-x: auto; overflow-y: hidden;
  /* A SWIPE PAST THE END MUST NOT SCROLL THE DESKTOP BEHIND IT. */
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}
.aero-desktop .taskbar-band::-webkit-scrollbar { height: 0; width: 0 }
.aero-desktop .taskbar-band.is-clipped { overflow: hidden }

/* A chevron pane: the same thin glass the Show desktop button is, because it does the same kind of
   job — a bar-level control that is not a window. */
.aero-desktop .band-chev {
  flex: 0 0 auto;
  width: ${BAND_CHEV_W}px; height: ${TASK_BTN_H}px;
  border-radius: 2px;
  border: 1px solid rgba(255,255,255,.3);
  background: linear-gradient(rgba(255,255,255,.18), rgba(255,255,255,.05));
  color: #eaf4ff;
  font: ${FONT_PX + 2}px/1 ${UI_FONT};
  text-shadow: 0 1px 1px rgba(0,16,38,.85);
  display: grid; place-items: center;
  cursor: pointer; padding: 0;
}
.aero-desktop .band-chev:hover:not(:disabled) {
  background: linear-gradient(rgba(190,235,255,.5), rgba(255,255,255,.12));
  border-color: rgba(190,235,255,.6);
}
/* AT AN END, THE CHEVRON IS DRAWN AND DISABLED — this project's standing rule for an inapplicable
   command (the caption's Minimize before M14 had a taskbar), and the alternative is a button that
   moves nothing and says nothing. */
.aero-desktop .band-chev:disabled { opacity: .35; cursor: default }
.aero-desktop .band-chev[hidden] { display: none }

/* A PINNED PROGRAM WITH NO WINDOW: the same button, drawn as an outline rather than a pane, so
   "installed and here" reads differently from "running". Windows 7's own distinction. */
.aero-desktop .task-btn.is-pinned {
  background: none;
  border-color: rgba(255,255,255,.14);
  color: #d7e6f4;
}
.aero-desktop .task-btn.is-pinned:hover {
  background: linear-gradient(rgba(255,255,255,.18), rgba(255,255,255,.06));
  border-color: rgba(190,235,255,.5);
}

/* A Superbar button: a glass pane with a lit left edge, the icon, the label, and a stack edge when
   it stands for more than one window. */
.aero-desktop .task-btn {
  flex: 0 1 ${TASK_BTN_W}px;
  height: ${TASK_BTN_H}px;
  min-width: ${TASK_BTN_MIN_W}px;
  display: flex; align-items: center; gap: 6px;
  padding: 0 8px;
  border-radius: 3px;
  border: 1px solid rgba(255,255,255,.18);
  background: linear-gradient(rgba(255,255,255,.14), rgba(255,255,255,.04) 48%,
    rgba(255,255,255,.10));
  color: #eaf4ff;
  font: ${FONT_PX}px/1.2 ${UI_FONT};
  text-shadow: 0 1px 1px rgba(0,16,38,.85);
  cursor: pointer; overflow: hidden;
}
.aero-desktop .task-btn .task-label {
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: left;
}
.aero-desktop .task-btn:hover {
  background:
    radial-gradient(120% 180% at 50% 120%, rgba(120,225,255,.45) 0%, rgba(255,255,255,.10) 70%),
    linear-gradient(rgba(255,255,255,.22), rgba(255,255,255,.08));
  border-color: rgba(190,235,255,.6);
  transition: background 50ms linear;
}
/* THE ACTIVE WINDOW'S BUTTON IS LIT, and the cue is a border plus a brighter fill rather than a
   colour: the bar is glass over an unknown backdrop, so a hue alone has no contrast to rely on. */
.aero-desktop .task-btn.is-active {
  background: linear-gradient(rgba(255,255,255,.34), rgba(255,255,255,.14) 48%,
    rgba(255,255,255,.26));
  border-color: rgba(220,245,255,.85);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.35), 0 0 8px rgba(130,205,255,.45);
}
/* A MINIMIZED WINDOW STILL HAS A BUTTON, and it has to read as "here but not on screen" — so it
   is dimmer and flatter rather than absent. A button that disappeared on minimize would leave no
   way back. */
.aero-desktop .task-btn.is-minimized {
  background: linear-gradient(rgba(255,255,255,.07), rgba(255,255,255,.02));
  border-color: rgba(255,255,255,.12);
  color: #c9d8e6;
}
/* The group edge: Windows 7 draws a stacked-pane hint on a button standing for several windows. */
.aero-desktop .task-btn.is-group {
  box-shadow: inset -3px 0 0 rgba(255,255,255,.18), inset -6px 0 0 rgba(255,255,255,.10);
}
.aero-desktop .task-count {
  flex: 0 0 auto;
  font: 600 10px/1 ${UI_FONT};
  padding: 1px 4px; border-radius: 6px;
  background: rgba(10,30,52,.55); border: 1px solid rgba(255,255,255,.35);
}

/* ---- M14: the tray --------------------------------------------------------------------- */
.aero-desktop .tray {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 6px;
  padding: 0 2px 0 8px;
  border-left: 1px solid rgba(255,255,255,.18);
}
/* M22: THE NOTIFICATION AREA. A strip of 16 px icons between the band and the clock, which is
   where Windows 7 puts it. It takes no width when no process has published one, so a desktop with
   an empty tray looks exactly like the one that had no tray at all. */
.aero-desktop .tray-icons {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 3px;
}
.aero-desktop .tray-icon {
  flex: 0 0 auto;
  width: 20px; height: 20px;
  border-radius: 2px;
  border: 1px solid transparent;
  background: none;
  display: grid; place-items: center;
  cursor: pointer; padding: 0;
}
.aero-desktop .tray-icon:hover:not(:disabled) {
  border-color: rgba(190,235,255,.55);
  background: linear-gradient(rgba(255,255,255,.2), rgba(255,255,255,.06));
}
.aero-desktop .tray-icon:disabled { opacity: .45; cursor: default }
.aero-desktop .clock {
  font: ${FONT_PX}px/1.15 ${UI_FONT};
  text-align: center; color: #f2f8ff;
  text-shadow: 0 1px 1px rgba(0,16,38,.9);
  padding: 0 4px;
  display: grid; gap: 1px;
  cursor: default;
}
.aero-desktop .clock .clock-date { font-size: 10px; opacity: .85 }
/* Show desktop: Windows 7's thin pane at the very end of the bar. */
.aero-desktop .show-desktop {
  width: 14px; height: ${TASKBAR_H - 8}px;
  border-radius: 2px;
  border: 1px solid rgba(255,255,255,.35);
  background: linear-gradient(rgba(255,255,255,.22), rgba(255,255,255,.06));
  cursor: pointer; padding: 0;
}
.aero-desktop .show-desktop:hover {
  background: linear-gradient(rgba(190,235,255,.55), rgba(255,255,255,.12));
}

/* AERO PEEK: every window becomes an outline while the pointer rests on Show desktop.
   THE STRIPS AND THE CLIENT AREA GO, NOT THE FRAME — so the window keeps its place and its
   shadow-free outline shows where it is. An opacity on the frame itself would establish a backdrop
   root and sever the blur chain of everything inside it, which is the failure with no symptom. */
.aero-desktop.is-peeking .window:not(.is-desktop) .aero-strip,
.aero-desktop.is-peeking .window:not(.is-desktop) .window-body { opacity: 0 }
.aero-desktop.is-peeking .window:not(.is-desktop) {
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.8);
}

/* ---- M14: the popups — jump lists, the window list, the start menu --------------------- */
/* ONE PANEL LOOK FOR ALL THREE, because they are one thing in Windows 7 too: a dark glass sheet
   with a bright rim, rows that light on hover, and a separator that is a line and not a gap. */
.aero-desktop .shell-popup {
  position: absolute;
  z-index: 2147482500;
  min-width: 180px; max-width: 320px;
  padding: 4px;
  border-radius: 4px;
  border: 1px solid rgba(255,255,255,.45);
  /* GLASS, LIKE THE BAR IT RISES FROM — Windows 7's own start menu is a blurred panel, and this
     one has to be for a reason a screenshot made obvious: the fill is translucent, so without a
     blur the DESKTOP'S ICON LABELS read straight through the rows and both became unreadable.
     Blurring the backdrop is what makes a translucent panel legible, which is the whole argument
     of constraint 34 applied to a menu rather than to a frame.

     It is a filtered box the blur governor does not account, exactly like the taskbar — recorded
     in MILESTONES M14 under what is not done, and bounded: at most one popup exists at a time. */
  backdrop-filter: blur(${BLUR_SIGMA}px) brightness(.55) saturate(1.2);
  background: linear-gradient(rgba(22,52,84,.78), rgba(12,32,56,.86));
  box-shadow: 0 0 0 1px rgba(0,0,0,.55), 0 10px 28px rgba(0,0,0,.55);
  color: #eaf4ff;
  font: ${FONT_PX}px/1.3 ${UI_FONT};
}
.aero-desktop .shell-popup[hidden] { display: none }
.aero-desktop .shell-row {
  display: flex; align-items: center; gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border: 0; border-radius: 3px;
  background: transparent; color: inherit;
  font: inherit; text-align: left;
  cursor: pointer;
}
.aero-desktop .shell-row:hover:not([disabled]) {
  background: linear-gradient(rgba(140,215,255,.35), rgba(80,165,230,.30));
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.35);
}
.aero-desktop .shell-row[disabled] { color: rgba(234,244,255,.45); cursor: default }
.aero-desktop .shell-row .shell-label {
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
/* M22: A14's ACCELERATOR, right of the label. DIMMER AND NOT GREY-AS-DISABLED — it names a live
   binding, and this project draws an inapplicable command greyed, so the two must not look alike.
   flex: 0 0 auto because the LABEL is what truncates: a chord cut to "Alt+Shi…" advertises a
   gesture nothing listens for. */
.aero-desktop .shell-row .shell-accel {
  flex: 0 0 auto;
  margin-left: 12px;
  font: ${FONT_PX - 1}px/1.2 ${UI_FONT};
  color: rgba(226,241,255,.72);
  white-space: nowrap;
}
.aero-desktop .shell-sep {
  height: 1px; margin: 3px 6px;
  background: rgba(255,255,255,.22);
}
.aero-desktop .shell-title {
  padding: 2px 8px 6px;
  font: 600 ${FONT_PX}px/1.2 ${UI_FONT};
  color: #cfe6fb;
}

/* The start menu is the same panel, taller, with a search box at its foot — Windows 7's own
   arrangement, where the search field is where the cursor already is. */
.aero-desktop .startmenu { min-width: 420px; max-width: 460px; max-height: 440px;
  display: grid; gap: 2px }
/* TWO COLUMNS, which is Windows 7's own menu: the programs on the left and the places on the
   right, with a rule between them. The right column is narrower and does not scroll — it is a
   handful of places, and a scrollbar on four rows reads as a mistake. */
.aero-desktop .startmenu .start-columns {
  display: grid; grid-template-columns: 1fr 150px; gap: 6px;
}
.aero-desktop .startmenu .start-left { min-width: 0; display: grid; gap: 2px; align-content: start }
.aero-desktop .startmenu .start-places {
  min-width: 0; display: grid; gap: 1px; align-content: start;
  padding-left: 6px;
  border-left: 1px solid rgba(255,255,255,.22);
}
.aero-desktop .startmenu .start-list { overflow: auto; max-height: 300px; display: grid; gap: 1px }
.aero-desktop .startmenu .start-search {
  width: 100%;
  margin-top: 4px;
  padding: 5px 7px;
  border-radius: 3px;
  border: 1px solid rgba(255,255,255,.45);
  background: rgba(255,255,255,.92);
  color: #10212f;
  font: ${FONT_PX}px/1.2 ${UI_FONT};
}
.aero-desktop .startmenu .start-foot {
  display: flex; justify-content: flex-end; padding-top: 4px;
}

/* A hover thumbnail: the panel, a canvas, and the window's title above it — which is the order
   Windows 7 uses, because the title is what tells two identical terminals apart.

   THE STRIP WRAPS, AND THE PANEL IS NOT CAPPED AT A MENU'S WIDTH. It was, and the result was the
   defect a reader photographed: the shell-popup max-width of 320px is right for a menu and wrong
   for two 208 px thumbnails, so a group of two laid out 422 px of content inside a 218 px panel
   and an overflow of visible painted the second one OUTSIDE the glass — a bare white canvas on
   the desktop with no panel behind it. Measured at 1320x900: cell 2 at x=434 in a panel spanning
   220..438. The cap is now derived from the thumbnail, and beyond ${THUMBS_PER_ROW} the strip
   wraps to a second row instead of leaving the panel. */
.aero-desktop .shell-popup[data-popup="thumbs"] {
  max-width: ${THUMBS_PER_ROW * (THUMB_W + 16) + 16}px;
}
.aero-desktop .task-thumbs { display: flex; flex-wrap: wrap; gap: 6px }
.aero-desktop .task-thumb {
  display: grid; gap: 4px;
  padding: 4px;
  border: 1px solid rgba(255,255,255,.28);
  border-radius: 3px;
  background: rgba(255,255,255,.06);
  cursor: pointer;
}
.aero-desktop .task-thumb:hover {
  background: rgba(140,215,255,.28);
  border-color: rgba(220,245,255,.8);
}
.aero-desktop .task-thumb canvas {
  display: block;
  width: ${THUMB_W}px; height: ${THUMB_H}px;
  background: #0d1c2c;
  border: 1px solid rgba(0,0,0,.45);
}
.aero-desktop .task-thumb .thumb-title {
  font: ${FONT_PX}px/1.2 ${UI_FONT};
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  max-width: ${THUMB_W}px;
}

/* ---- M14: the desktop's icons ---------------------------------------------------------- */
/* ABSOLUTELY POSITIONED IN A GRID, not laid out by flow: an icon is a thing a user can DRAG to a
   place and have it stay there, and a flow layout would put it back. */
.aero-desktop .icon-view { position: absolute; inset: 0; overflow: hidden }
.aero-desktop .desk-icon {
  position: absolute;
  width: ${ICON_CELL_W}px;
  display: grid; justify-items: center; gap: 2px;
  padding: 4px 2px 6px;
  border: 1px solid transparent; border-radius: 3px;
  background: transparent;
  color: #fff;
  font: ${FONT_PX}px/1.25 ${UI_FONT};
  cursor: default;
  /* THE LABEL NEEDS THE SAME HALO THE CAPTION NEEDS, and for the same reason: it sits over a
     wallpaper whose luminance is unknown, so no single text colour has a contrast ratio
     (constraint 39's neighbourhood). Two rows and then an ellipsis, which is Windows 7's own. */
  text-shadow: 0 0 3px rgba(0,16,38,.95), 0 1px 2px rgba(0,16,38,.9);
}
.aero-desktop .desk-icon .desk-label {
  max-width: ${ICON_CELL_W - 8}px;
  text-align: center;
  overflow: hidden;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  overflow-wrap: anywhere;
}
.aero-desktop .desk-icon:hover {
  border-color: rgba(180,225,255,.55);
  background: linear-gradient(rgba(140,215,255,.22), rgba(80,165,230,.18));
}
/* SELECTED IS A FILL AND A RIM, which is what Windows 7 draws, and it must be legible over any
   wallpaper — so the rim carries the contrast and the fill only tints. */
.aero-desktop .desk-icon.is-selected {
  border-color: rgba(220,245,255,.9);
  background: linear-gradient(rgba(150,220,255,.38), rgba(70,160,230,.34));
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.35);
}
.aero-desktop .desk-icon[data-disabled="1"] { color: rgba(255,255,255,.55) }
/* The rubber band: a marquee, drawn while a drag crosses the bare desktop. */
/* The rubber band carries its own contrast for the snap ghost's reason: a selection marquee over a
   pale wallpaper is the same invisible edge. */
.aero-desktop .rubber {
  position: absolute;
  border: 1px solid rgba(220,245,255,.9);
  outline: 1px solid rgba(10,30,52,.6);
  background: rgba(140,205,250,.22);
  pointer-events: none;
}
.aero-desktop .rubber[hidden] { display: none }
`;
}

/** The id the sheet is installed under, so a second `install` replaces rather than stacks. */
const STYLE_ID = "aero-skin";

/**
 * Put the skin on a document, and mark `desktop` as the one backdrop root.
 *
 * Returns the `<style>` element, so a check can read the sheet back from the DOM rather than
 * trusting that this ran.
 */
export function install(desktop, doc = desktop?.ownerDocument || document) {
  let style = doc.getElementById(STYLE_ID);
  if (!style) {
    style = doc.createElement("style");
    style.id = STYLE_ID;
    doc.head.append(style);
  }
  style.textContent = styleSheet();
  if (desktop) desktop.classList.add("aero-desktop");
  return style;
}
