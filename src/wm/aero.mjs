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
.aero-desktop .window-body canvas { display: block; background: #fff }

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
