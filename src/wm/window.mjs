// A window: a frame, a title bar you can drag, eight resize grips, and a client area.
//
// THE FRAME IS FOUR GLASS STRIPS AND A CLIENT AREA (M11). `backdrop-filter` filters an element's
// border box, so a ring is only a ring if it is four separately filtered boxes — measured at
// 10.33x cheaper than one glass node over the same window (`src/wm/aero.mjs`, which carries the
// numbers and the stylesheet). This file builds the structure and names nothing about how it looks;
// a page that does not install the skin gets four zero-sized strips and the frame it had before,
// which is what lets M7's geometry checks keep running against an unskinned window.
//
// THERE IS NO SYSCALL IN THIS FILE: a window agent cannot `Atomics.wait` (constraint 1), so this
// module draws and listens while `www/m4a.html` holds the one route to the kernel. Every gesture
// below has a keyboard spelling, so a check can drive it as real input.

import {
  WIN_CAP_H, WIN_INSET, WST_NORMAL, WST_MIN, WST_MAX, WST_SNAP_L, WST_SNAP_R,
  WROLE_NORMAL, WROLE_DESKTOP,
} from "../abi.mjs";

/* ---- M14: Aero Snap's thresholds, in CSS px -------------------------------------------------
 *
 * THREE NUMBERS AND NOT ONE, and `PLAN.md` §5 names all three: snap ARMS at a pointer within 1 px
 * of an edge, a snapped window RELEASES after 20 px of drag-out, and a maximized one releases
 * after a 50 px SIDE-move.
 *
 * THE ARM AND THE RELEASE ARE A HYSTERESIS PAIR, which is constraint 39's rule applied to a
 * continuous input: with one threshold a window snapped at the edge would un-snap on the next
 * motion sample, re-snap on the one after, and flicker for as long as the button was held. Both
 * edges get checked, which is what `--negative no-snap-hysteresis` is for.
 *
 * MAXIMIZED RELEASES ON HORIZONTAL MOVEMENT ALONE, and that is not a stricter version of the same
 * rule. A maximized window's caption is at the top of the work area, so a user reaching for it
 * drags slightly downward constantly; measuring total distance would un-maximize the window every
 * time somebody nudged it. Windows 7 takes the same view.
 */
export const SNAP_ARM_PX = 1;
export const SNAP_RELEASE_PX = 20;
export const MAX_RELEASE_PX = 50;

/** Smallest a window may be dragged or resized to. webxp's numbers, kept. */
export const MIN_W = 220;
export const MIN_H = 120;
const DEFAULT_W = 560;
const DEFAULT_H = 360;

/** How much of the title bar must stay on screen, so a window cannot be dragged out of reach.
 *
 *  EXPORTED SINCE M13, because the geometry harness asserts the clamp lands exactly here. A check
 *  carrying its own 72 would be the same number in a second place, and the clamp is the subject. */
export const MIN_VISIBLE = 72;

/** One arrow press, in CSS pixels. The keyboard equivalent of a drag. Exported for `MIN_VISIBLE`'s
 *  reason: M13 asserts both ends of the step, and Shift is the fine one. */
export const KEY_STEP = 10;

/**
 * M13's FIRST NEGATIVE CONTROL. `apply()` writes the requested box straight onto the element, so
 * nothing holds a window inside the desktop: a drag can put a title bar past the edge and leave it
 * unreachable, which is what `clampBox` exists to prevent.
 *
 * MODULE-LEVEL AND NOT PER-WINDOW, which is `src/kernel/wins.mjs`'s shape for its controls and for
 * its reason: the headline path reads a plain boolean and carries no control branch of its own.
 *
 * IT IS NOT GATED ON A BENCH BOOT, and the difference is worth stating: the kernel's hooks are
 * gated because a PROCESS could otherwise ask for them, and nothing here is reachable from a
 * process. The page is the supervisor (`docs/DECISIONS.md` D18), so a page-side control is the
 * supervisor disabling its own clamp — `www/m13.html` is the only caller and reads `?no_clamp=1`.
 */
/**
 * And M14's: the snap RELEASE collapses onto the ARM, so there is one threshold instead of two.
 * `PLAN.md` §5's own control for M14 — "remove the hysteresis band; the 19 px case must start
 * failing" — and what a reader sees is a window that will not stay snapped.
 */
let geometryControls = { noClamp: false, noSnapHysteresis: false, noWorkArea: false };

export function setGeometryControls(opts = {}) {
  geometryControls = {
    noClamp: opts.noClamp === true,
    noSnapHysteresis: opts.noSnapHysteresis === true,
    /** And the third: a maximized window fills the DESKTOP rather than the work area, so it covers
     *  the taskbar — which is a window a user cannot get out from under. */
    noWorkArea: opts.noWorkArea === true,
  };
  return { ...geometryControls };
}

/** How far a drag must travel before a docked window lets go. One definition, because the control
 *  above has to be able to collapse it onto the arm threshold. */
function releaseDistance(state) {
  if (geometryControls.noSnapHysteresis) return SNAP_ARM_PX;
  return state === WST_MAX ? MAX_RELEASE_PX : SNAP_RELEASE_PX;
}

/** What is in force, so a check reads the world it is measuring out of the module that owns it
 *  rather than out of the page's own query parsing. A control a check believed was on and was not
 *  is a green run over an unmodified world. */
export function geometryControlsInForce() {
  return { ...geometryControls };
}

let serial = 0;

/** `box` held inside the desktop. Returns a NEW object; never mutates its argument.
 *
 *  The MIN_W/MIN_H floor and the two `Math.max(…, 0)` guards are for a surface smaller than the
 *  window's own minimum, which a `Win` built before its desktop is laid out really is: it measures
 *  `{w: 0, h: 0}`. Without the floor the window becomes 0×0; without the outer `Math.max` the upper
 *  bound on `x` goes negative and wins, placing the window at -72 with no title bar reachable. */
export function clampBox(box, surface) {
  const w = Math.max(Math.min(Math.max(box.w, MIN_W), surface.w), MIN_W);
  const h = Math.max(Math.min(Math.max(box.h, MIN_H), surface.h), MIN_H);
  return {
    w,
    h,
    // Both bounds are on the LEFT edge: as negative as `MIN_VISIBLE - w`, and no further right
    // than `surface.w - MIN_VISIBLE`. Either way MIN_VISIBLE px of title bar stay grabbable.
    x: Math.min(Math.max(box.x, MIN_VISIBLE - w), Math.max(surface.w - MIN_VISIBLE, 0)),
    y: Math.min(Math.max(box.y, 0), Math.max(surface.h - MIN_VISIBLE, 0)),
  };
}

export class Win {
  /** `spec.into` is the desktop element. `spec.onClose` backs the close box and Alt+F4, and
   *  returning false keeps the window open; `spec.onEndProcess` is the affordance the
   *  not-responding detector reveals. */
  constructor(spec) {
    this.id = spec.id || `win-${++serial}`;
    this.surfaceEl = spec.into;
    this.onClose = spec.onClose || null;
    this.onEndProcess = spec.onEndProcess || null;
    this.titleText = String(spec.title || "");
    /** Where the window wants to be, and where it is. Two boxes and not one: `apply()` never writes
     *  `box`, so a desktop that shrinks and grows back returns the window where the user put it,
     *  and a gesture writes `box` from `placed` plus its own delta so a clamped window does not
     *  jump out from under the pointer. */
    this.box = {
      x: Number.isFinite(spec.x) ? spec.x : 40,
      y: Number.isFinite(spec.y) ? spec.y : 32,
      w: Math.max(spec.w || DEFAULT_W, MIN_W),
      h: Math.max(spec.h || DEFAULT_H, MIN_H),
    };
    this.placed = { ...this.box };
    this.drag = null;
    this.closed = false;
    /**
     * M14. THE SHOW STATE, AS THE KERNEL DECIDED IT. Written only by `setState`, which the host
     * calls when the kernel posts `win-show` — never by a gesture here. The caption buttons and
     * the snap gesture ASK (`spec.onState`), the kernel answers, and this file renders the answer.
     * That is `win-stack`'s rule for the z-order applied to the other thing a shell decides
     * (constraints 226, 271): the page draws policy and never makes it.
     */
    this.state = WST_NORMAL;
    /** M14. What this window IS to the shell, as the kernel decided it. A desktop window has no
     *  frame, fills the work area and is not dragged — see `boxForState` and `setRole`. */
    this.role = WROLE_NORMAL;
    /** Where a maximized or snapped window goes back to, as the kernel reported it. */
    this.restore = null;
    this.onState = spec.onState || null;
    /** Where a right-click on the caption goes: the shell, which owns every menu. */
    this.onMenu = spec.onMenu || null;
    /** M16. Where "the box changed under a live gesture" goes: the host, which owns the one route
     *  to the kernel. A callback for `onClose`'s and `onState`'s reason — this file holds no `post`
     *  and no kernel object — and the host coalesces the calls, because a gesture produces one per
     *  pointer sample. */
    this.onGeom = spec.onGeom || null;
    /** The WORK AREA, as a callback rather than a value: the shell may take a strip off the
     *  desktop at any moment (a taskbar appearing) and a window laid out against a stale work area
     *  is a maximized window covering the taskbar. */
    this.workAreaOf = spec.workArea || null;
    /** The snap the pointer is currently over, as a `WST_*` value, and the preview element that
     *  shows where the window would land. 0 for "no edge". */
    this.armed = 0;
    this.snapEl = null;
    this.resize = null;
    /** Whether a live drag has just undocked this window and placed it itself, so the `win-show`
     *  that answers must not move it. See `setState`. */
    this.pendingUndock = false;
    /** 0 responding, 1 greyed caption, 2 End Process offered. Written only by `setHealth`. */
    this.health = 0;
    /** Whether the kernel's last order said something blocks this window, and whether this window
     *  is the one blocking everything. Written only by `setBlocked`. */
    this.blocked = false;
    this.systemModal = false;
    this.#build();
    this.apply();
  }

  #build() {
    const el = document.createElement("section");
    el.className = "window";
    el.id = this.id;
    // A labelled `section` is a region, the closest honest match: a window is not a dialog.
    el.setAttribute("aria-labelledby", `${this.id}-title`);

    /* THE CAPTION IS A GLASS STRIP AND IS STILL `.window-title`. One element with two skins: the
     * skinned pages filter it, the unskinned ones lay it out as the flex row they always did. A
     * second element would have been a second thing to keep in step with every check that reads
     * the caption. */
    const bar = document.createElement("div");
    bar.className = "window-title aero-strip aero-cap";
    // The bar IS the move handle, so it must be reachable without a pointer (WCAG SC 2.1.1).
    bar.tabIndex = 0;
    bar.setAttribute("role", "toolbar");
    this.#glassLayers(bar);

    /* THE CAPTION'S ICON, which is Windows 7's own arrangement and was missing until a screenshot
     * showed it: a frame draws the program's icon at the left of its caption, and the taskbar
     * draws the same one. It is `innerHTML` of markup from `src/wm/icons.mjs` — never of anything
     * a program supplied — and it is EMPTY until the host says which program this is, so an
     * unskinned page and a window whose program is unknown both get nothing rather than a guess. */
    const icon = document.createElement("span");
    icon.className = "window-icon";
    icon.setAttribute("aria-hidden", "true");
    this.iconEl = icon;

    const heading = document.createElement("h2");
    heading.id = `${this.id}-title`;
    heading.textContent = this.titleText;
    this.headingEl = heading;

    const boxes = document.createElement("div");
    boxes.className = "title-buttons";
    // Built now and hidden: "the button is absent" and "the button was never written" look
    // identical in the DOM, so a check could not tell them apart.
    this.endBtn = this.#titleButton("End Process", "window-end", () => {
      if (this.onEndProcess) this.onEndProcess();
    });
    this.endBtn.hidden = true;
    /* MINIMIZE AND MAXIMIZE ARE LIVE SINCE M14, and until M14 they were drawn and DISABLED — which
     * was Windows 7's own rule for an inapplicable command and was the honest state of the world:
     * there was nothing to minimize into, no snap state to maximize to, and the window ABI carried
     * no state property at all. M14 added `WIN_SET_STATE`, a taskbar to minimize into and a work
     * area to maximize to, so the three reasons are gone and the buttons ASK for a state. They
     * still do not ACT: the kernel decides and posts, and `setState` renders what it said. */
    this.minBtn = this.#titleButton("—", "window-min", () => this.askState(WST_MIN),
      { label: "Minimize" });
    this.maxBtn = this.#titleButton("□", "window-max", () => this.toggleMaximize(),
      { label: "Maximize" });
    this.closeBtn = this.#titleButton("✕", "window-close", () => this.close(), { label: "Close" });
    boxes.append(this.endBtn, this.minBtn, this.maxBtn, this.closeBtn);

    const body = document.createElement("div");
    body.className = "window-body";
    this.bodyEl = body;

    bar.append(icon, heading, boxes);
    /** The three edge strips. Each is its own filtered border box, which is what makes the four of
     *  them sum to the ring rather than to the window. */
    this.edgeEls = ["aero-left", "aero-right", "aero-bottom"].map((side) => {
      const edge = document.createElement("div");
      edge.className = `aero-strip ${side}`;
      edge.dataset.strip = side.replace("aero-", "");
      // Out of flow, so an unskinned page's flex caption and body are laid out exactly as before
      // and these contribute nothing. Positioning is behaviour; the look is the skin's.
      edge.style.position = "absolute";
      edge.setAttribute("aria-hidden", "true");
      this.#glassLayers(edge);
      return edge;
    });
    /* M14's EIGHT RESIZE GRIPS. Transparent, positioned HERE and not by the skin, for the reason
     * the glass strips are positioned here: where a frame can be grabbed is behaviour, and a page
     * that does not install the skin still has to be resizable. The thickness is the frame's own
     * inset, imported rather than restated — a grip wider than the border would swallow clicks
     * meant for the client area.
     *
     * THE TOP GRIP OVERLAPS THE CAPTION'S FIRST FEW PIXELS, which is Windows 7's own geometry: the
     * top edge resizes and the rest of the caption drags. It sits above the caption in z, so the
     * order of the two listeners is not what decides it. */
    this.gripEls = this.#grips();
    el.append(bar, ...this.edgeEls, body, ...this.gripEls);
    bar.addEventListener("pointerdown", (e) => {
      /* A RIGHT PRESS ON THE CAPTION IS THE WINDOW MENU, which is Windows 7's own gesture and the
       * one mouse action on a frame this file did not have. It is handed UP rather than handled
       * here: the menu's rows are state asks, and the shell is what draws a menu
       * (`docs/DECISIONS.md` D39) — a frame that drew its own would be a second popup nobody can
       * close with the first one's rules. `pointerdown` with `button === 2`, for the reason the
       * taskbar uses it: that is the event a driver and a hand both deliver (constraint 279). */
      if (e.button === 2) {
        e.preventDefault();
        if (this.onMenu) this.onMenu({ x: e.clientX, y: e.clientY });
        return;
      }
      this.#startDrag(e);
    });
    // And the browser's own menu is refused, or a right-click would show Chrome's over ours.
    bar.addEventListener("contextmenu", (e) => e.preventDefault());
    bar.addEventListener("keydown", (e) => this.#barKey(e));
    /* A DOUBLE-CLICK ON THE CAPTION MAXIMIZES AND RESTORES, which is the gesture a Windows user
     * tries before they find the button. `dblclick` and not two clicks: the browser already owns
     * the timing, and a hand-rolled one would be a second definition of how fast is fast. */
    bar.addEventListener("dblclick", (e) => {
      if (e.target.closest("button")) return;
      this.toggleMaximize();
    });
    this.el = el;
    this.barEl = bar;
    this.surfaceEl.append(el);
  }

  /** The eight grips, in the order a reader would name them. Each carries its own axes as data, so
   *  the resize gesture reads a vector rather than branching on a name. */
  #grips() {
    const sides = [
      ["n", 0, -1, { left: WIN_INSET, right: WIN_INSET, top: 0, height: 4 }, "ns-resize"],
      ["s", 0, 1, { left: WIN_INSET, right: WIN_INSET, bottom: 0, height: WIN_INSET }, "ns-resize"],
      ["w", -1, 0, { left: 0, top: 4, bottom: WIN_INSET, width: WIN_INSET }, "ew-resize"],
      ["e", 1, 0, { right: 0, top: 4, bottom: WIN_INSET, width: WIN_INSET }, "ew-resize"],
      ["nw", -1, -1, { left: 0, top: 0, width: 10, height: 10 }, "nwse-resize"],
      ["ne", 1, -1, { right: 0, top: 0, width: 10, height: 10 }, "nesw-resize"],
      ["sw", -1, 1, { left: 0, bottom: 0, width: 10, height: 10 }, "nesw-resize"],
      ["se", 1, 1, { right: 0, bottom: 0, width: 10, height: 10 }, "nwse-resize"],
    ];
    return sides.map(([name, ax, ay, at, cursor]) => {
      const grip = document.createElement("div");
      grip.className = `window-grip grip-${name}`;
      grip.dataset.grip = name;
      grip.setAttribute("aria-hidden", "true");
      grip.style.position = "absolute";
      for (const [key, value] of Object.entries(at)) grip.style[key] = `${value}px`;
      grip.style.cursor = cursor;
      // ABOVE THE CAPTION AND THE STRIPS, so the edge of a frame resizes rather than drags. A
      // corner is above an edge for the same reason: the corner's own 10 px must win.
      grip.style.zIndex = name.length === 2 ? "4" : "3";
      grip.addEventListener("pointerdown", (e) => this.#startResize(e, ax, ay));
      return grip;
    });
  }

  /** The two additive layers every strip carries: the summed afterglow-plus-colorization term, and
   *  the viewport-anchored highlight.
   *
   *  THEY ARE DESCENDANTS OF THE STRIP AND NEVER ANCESTORS OF IT. `mix-blend-mode` on an ancestor
   *  establishes a backdrop root and severs the blur chain, which has no symptom except flat glass;
   *  as descendants it is measured to leave the blur fully working
   *  (`docs/designs/REVIEW-FINDINGS.md` §8, `bench/m11-glass/probe.py`'s `severed` specimen). */
  #glassLayers(strip) {
    for (const cls of ["aero-sheen", "aero-light"]) {
      const layer = document.createElement("div");
      layer.className = cls;
      layer.style.position = "absolute";
      layer.setAttribute("aria-hidden", "true");
      strip.append(layer);
    }
  }

  #titleButton(glyph, cls, onClick, { disabled = false, label = "" } = {}) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `title-box ${cls}`;
    b.textContent = glyph;
    b.setAttribute("aria-label", label || glyph);
    if (disabled) {
      b.disabled = true;
      b.dataset.inert = "1";
    }
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  surface() {
    const r = this.surfaceEl.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  }

  /**
   * THE WORK AREA: the part of the desktop a maximized window may have, in desktop coordinates.
   *
   * Defaults to the whole desktop, which is what every page without a shell gets. The taskbar is
   * what narrows it, and it does so through the callback rather than by writing a value here —
   * a window laid out against a work area measured once is a maximized window covering a taskbar
   * that appeared afterwards.
   */
  workArea() {
    const s = this.surface();
    const whole = { x: 0, y: 0, w: s.w, h: s.h };
    // THE CONTROL: a maximized window fills the DESKTOP and covers whatever the shell put on it.
    if (geometryControls.noWorkArea || !this.workAreaOf) return whole;
    const wa = this.workAreaOf();
    if (!wa || !(wa.w > 0) || !(wa.h > 0)) return whole;
    return { x: wa.x | 0, y: wa.y | 0, w: wa.w | 0, h: wa.h | 0 };
  }

  /** The box a docked state puts this window in, or null for a state that uses `box`. The ONE
   *  definition of what maximized and snapped MEAN as geometry; the snap preview and the layout
   *  both read it, so the ghost cannot promise a rectangle the window does not take. */
  boxForState(state = this.state) {
    const wa = this.workArea();
    /* THE DESKTOP IS THE WORK AREA, always, and not a geometry a process asked for: it is the
     * surface every other window sits on, and one that did not fill the space would leave a strip
     * of bare page that no icon could be dropped on. It is the work area and NOT the whole desktop
     * because the shell's own strip is drawn over the backdrop — the wallpaper still shows through
     * the glass there, and an icon under the taskbar would be an icon nobody can click. */
    if (this.role === WROLE_DESKTOP) return { ...wa };
    if (state === WST_MAX) return { ...wa };
    if (state === WST_SNAP_L || state === WST_SNAP_R) {
      // HALF, ROUNDED, AND THE OTHER HALF IS THE REMAINDER: two `floor(w/2)` halves leave a one
      // pixel gap down the middle of an odd-width desktop, which is a seam a reader can see.
      const half = Math.round(wa.w / 2);
      return state === WST_SNAP_L
        ? { x: wa.x, y: wa.y, w: half, h: wa.h }
        : { x: wa.x + half, y: wa.y, w: wa.w - half, h: wa.h };
    }
    return null;
  }

  /** Write `box`, clamped, onto the element. The ONLY writer of `placed` and of the style. */
  apply() {
    /* A DOCKED WINDOW'S GEOMETRY IS THE STATE'S, NOT THE BOX'S, and `box` is left alone — which is
     * the two-box design doing the same job it does for the clamp: a maximized window still
     * remembers what it asked for, so a restore needs no stored geometry of its own. */
    const docked = this.boxForState();
    // THE CONTROL IS HERE AND NOT INSIDE `clampBox`, so the pure function stays pure and a host
    // probe can keep asserting on it under node while this world is running in a browser.
    this.placed = docked || (geometryControls.noClamp
      ? { ...this.box }
      : clampBox(this.box, this.surface()));
    /* A MINIMIZED WINDOW IS NOT ON SCREEN, and `hidden` is the whole of it: the frame keeps its
     * geometry, the window keeps its fd, its events keep queueing, and its process is told by
     * `WEV_STATE` rather than by noticing. Nothing is torn down — a minimize that destroyed
     * anything would be a close. */
    this.el.hidden = this.state === WST_MIN;
    const s = this.el.style;
    s.left = `${this.placed.x}px`;
    s.top = `${this.placed.y}px`;
    s.width = `${this.placed.w}px`;
    s.height = `${this.placed.h}px`;
    // Published as data, so a check reads the geometry back without parsing a style string.
    this.el.dataset.x = String(this.placed.x);
    this.el.dataset.y = String(this.placed.y);
    this.el.dataset.w = String(this.placed.w);
    this.el.dataset.h = String(this.placed.h);
    // THE STATE IS PUBLISHED AS DATA, for the reason every other kernel decision is: the class is
    // the look and the dataset is the fact, and a check reads the fact.
    this.el.dataset.state = String(this.state);
    this.el.classList.toggle("is-maximized", this.state === WST_MAX);
    this.el.classList.toggle("is-snapped",
      this.state === WST_SNAP_L || this.state === WST_SNAP_R);
  }

  /* ---- M14: the show state ------------------------------------------------------------------
   *
   * EVERY ONE OF THESE ASKS. The kernel owns the state, the restore point and the blurred area a
   * state change alters, so a button here posts an intent and the frame changes when the kernel
   * says it did (constraint 271). A page that applied the change itself would be a second
   * authority on what is maximized, and the two would disagree the first time one was refused.
   */

  askState(state) {
    if (this.blocked) return false;
    if (!this.onState) return false;
    this.onState(state | 0);
    return true;
  }

  /** The maximize button and the caption double-click, which are one gesture with two spellings:
   *  maximize what is floating or snapped, restore what is maximized. */
  toggleMaximize() {
    return this.askState(this.state === WST_MAX ? WST_NORMAL : WST_MAX);
  }

  /**
   * What the kernel said this window's state now is. The ONLY writer of `state`.
   *
   * A RESTORE PUTS THE BOX BACK, and the box comes from the KERNEL's record rather than from
   * anything held here: the page is a renderer that may be re-laid-out at any moment, and a window
   * whose restore point lived only in the page would come back to the wrong place after one.
   */
  /** The caption's icon, as MARKUP from `src/wm/icons.mjs`. The host calls this with the id it
   *  derived from the program the kernel named, so the frame and the taskbar button cannot
   *  disagree about what a terminal looks like. */
  setIconMarkup(markup) {
    this.iconEl.innerHTML = String(markup || "");
    return this.iconEl.childElementCount;
  }

  /** What the kernel said this window IS. The ONLY writer of `role`. A desktop window loses its
   *  caption and its grips to the skin and its gestures to the guards in `#startDrag` and
   *  `#startResize` — the backdrop is not a thing a user drags. */
  setRole(role) {
    this.role = role | 0;
    this.el.dataset.role = String(this.role);
    this.el.classList.toggle("is-desktop", this.role === WROLE_DESKTOP);
    this.apply();
    return this.role;
  }

  setState(state, restore = null) {
    this.state = state | 0;
    if (restore && restore.w > 0 && restore.h > 0) this.restore = { ...restore };
    /* THE BOX COMES FROM THE POST AND NOT FROM MEMORY, which a critic's first finding was about:
     * `this.restore` is kept for sizing an undock and outlives its use, so applying it on every
     * return to NORMAL moved a window to a geometry two gestures stale. The kernel sends the box
     * exactly once, on the transition it pays for, and sends null afterwards.
     *
     * AND A DRAG THAT UNDOCKED HAS ALREADY PLACED THE WINDOW — under the pointer, which is the
     * whole point of `#undock` — so the post that follows it must not move the frame out from
     * under the hand that is holding it. The flag is consumed here whether or not it was used. */
    const undocking = this.pendingUndock === true;
    this.pendingUndock = false;
    if (this.state === WST_NORMAL && restore && restore.w > 0 && !undocking) {
      this.box = { ...restore };
    }
    // The glyph says what the button WILL do, which is Windows 7's own behaviour: a maximized
    // window's button restores, and it draws the overlapping-rectangles glyph to say so.
    this.maxBtn.textContent = this.state === WST_MAX ? "❐" : "□";
    this.maxBtn.setAttribute("aria-label", this.state === WST_MAX ? "Restore" : "Maximize");
    this.#clearSnap();
    this.apply();
    return this.state;
  }

  moveBy(dx, dy) {
    // From `placed`, not from `box`. See the note on the two boxes.
    this.box = { ...this.placed, x: this.placed.x + dx, y: this.placed.y + dy };
    this.apply();
  }

  #startDrag(event) {
    if (event.button !== 0) return;
    if (event.target.closest("button")) return;
    // THE DESKTOP IS NOT DRAGGED. Its geometry is the work area's, so a drag would be undone by
    // the next `apply()` — and a backdrop that slid around under the pointer is not a desktop.
    if (this.role === WROLE_DESKTOP) return;
    // A BLOCKED WINDOW DOES NOT MOVE. The drag is page-side from end to end, so without this the
    // kernel's suppression covered the client area and not the frame: a window behind a modal could
    // not be typed into or raised, and could still be dragged around under it (constraint 233).
    if (this.blocked) return;
    // A second pointer re-enters here while a gesture is live, so the one in flight is ended
    // first: each gesture's listeners answer only to their own pointer id, so leaving them
    // attached leaks three per re-entry for the window's lifetime.
    if (this.drag) this.drag.end();
    const gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      from: this.placed,
      /** The state the window was in when the press landed, and whether the drag has already
       *  pulled it out of that state. A FLOATING window is free from the first sample. */
      docked: this.state !== WST_NORMAL,
      state: this.state,
      /** How far the pointer got while the window was still docked, for a reader and a check:
       *  "it held" and "nothing moved the mouse" are different facts. */
      heldFor: 0,
      end: () => {
        if (this.drag === gesture) this.drag = null;
        const target = this.el.ownerDocument;
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
      },
      //: Whatever `setPointerCapture` refused with, or "". Published so a dead drag says why.
      captureError: "",
    };
    const move = (e) => {
      if (this.drag !== gesture || e.pointerId !== gesture.id) return;
      const dx = e.clientX - gesture.x;
      const dy = e.clientY - gesture.y;
      /* A DOCKED WINDOW HOLDS UNTIL THE DRAG IS MEANT. 20 px out of a snap, 50 px SIDEWAYS out of
       * a maximize — see the thresholds at the top of this file. Below that the window does not
       * move at all, which is what "it holds" means: a maximized window that crept downward by
       * three pixels every time somebody brushed its caption would be unusable. */
      if (gesture.docked) {
        const travelled = gesture.state === WST_MAX
          ? Math.abs(dx)
          : Math.sqrt(dx * dx + dy * dy);
        gesture.heldFor = Math.max(gesture.heldFor, Math.round(travelled));
        if (travelled < releaseDistance(gesture.state)) return;
        this.#undock(gesture, e);
        return;
      }
      this.box = { ...gesture.from, x: gesture.from.x + dx, y: gesture.from.y + dy };
      this.apply();
      /* THE KERNEL LEARNS MID-GESTURE. See the resize handler below for why the release-only
       * report was a defect with two faces; a move is the same path and the same reasons, and a
       * window dragged onto a second display changes its device-pixel ratio without changing its
       * box at all. */
      if (this.onGeom) this.onGeom("drag");
      // AND THE EDGES ARM AS THE POINTER REACHES THEM, which is the other half of the gesture.
      this.#armSnap(e);
    };
    const up = (e) => {
      if (e.pointerId !== gesture.id) return;
      /* THE RELEASE IS WHERE A SNAP HAPPENS, and it ASKS: the kernel decides the state and posts
       * it back, so a snap a modal refuses does not half-happen on screen. */
      if (this.armed) {
        const want = this.armed;
        this.#clearSnap();
        this.askState(want);
      }
      gesture.end();
    };
    this.drag = gesture;
    /* The listeners go on the DOCUMENT, and they go on BEFORE the capture. On the document, because
     * a pointer that leaves the title bar delivers its `pointermove` and `pointerup` elsewhere.
     * Before the capture, because `setPointerCapture` MAY THROW for a pointerId no live pointer
     * owns (https://w3c.github.io/pointerevents/#dom-element-setpointercapture) — measured, Chrome
     * 157 does not throw for a synthetic pointerId 1 and Firefox does — and a throw above the
     * listeners would leave the window dead to the mouse and silent. */
    const doc = this.el.ownerDocument;
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", up);
    // A cancel ends the drag too: a pointer the browser takes away would leave `drag` set, and the
    // next unrelated pointermove teleports the window.
    doc.addEventListener("pointercancel", up);
    try {
      this.barEl.setPointerCapture(event.pointerId);
    } catch (error) {
      gesture.captureError = `${error.name}: ${error.message}`;
    }
  }

  /**
   * The drag has earned the right to undock. Put the window back to its restore size UNDER THE
   * POINTER and carry on dragging from there.
   *
   * THE POINTER KEEPS ITS PLACE IN THE CAPTION, which is what makes the gesture feel like one
   * gesture: a maximized window is 1,264 px wide and its restore box may be 420, so re-anchoring
   * at the window's left edge would make the frame jump out from under the hand that is holding
   * it. The fraction along the caption is preserved instead, which is Windows 7's own behaviour.
   */
  #undock(gesture, event) {
    const back = this.restore && this.restore.w > 0 ? this.restore : { ...gesture.from };
    const desk = this.surfaceEl.getBoundingClientRect();
    const grabX = gesture.x - desk.left - gesture.from.x;
    const fraction = gesture.from.w > 0
      ? Math.min(1, Math.max(0, grabX / gesture.from.w))
      : 0;
    // The vertical offset is capped at the caption's own height: a press 300 px down a maximized
    // window's caption does not exist, but a press on its bottom edge does, and the restored
    // window must still be held by its caption.
    const grabY = Math.min(Math.max(gesture.y - desk.top - gesture.from.y, 0), WIN_CAP_H);
    gesture.docked = false;
    gesture.state = WST_NORMAL;
    // The `win-show` that answers `askState` below must leave this geometry alone: see `setState`.
    this.pendingUndock = true;
    gesture.from = {
      x: Math.round(event.clientX - desk.left - fraction * back.w),
      y: Math.round(event.clientY - desk.top - grabY),
      w: back.w,
      h: back.h,
    };
    // RE-ANCHOR THE GESTURE, or the next sample would apply the whole travelled delta twice.
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    this.box = { ...gesture.from };
    /* THE STATE CHANGE IS ASKED FOR AND THE GEOMETRY IS APPLIED NOW, which is the one place this
     * file moves before the kernel has answered — and it has to: the drag is live, and a window
     * that waited a round trip would lag the pointer by one message. The kernel's `win-show` then
     * arrives and `setState` renders the same thing, so the two agree a moment later rather than
     * never. A refusal would put the window back, which is the correct outcome. */
    this.state = WST_NORMAL;
    this.apply();
    this.askState(WST_NORMAL);
  }

  /**
   * Arm or disarm the snap edge the pointer is over, and show the ghost of where the window would
   * land. Called on every motion sample of a title-bar drag.
   *
   * ONE PIXEL, which is `PLAN.md` §5's own figure and is not a tolerance to be widened: the edge
   * of the screen is where a pointer STOPS, so a user who means to snap drags until the pointer
   * cannot go further and lands exactly on it.
   */
  #armSnap(event) {
    const desk = this.surfaceEl.getBoundingClientRect();
    let armed = 0;
    /* ONE CONSTANT FOR ALL THREE EDGES, which a critic found the right one was not: it carried a
     * `+ 1` and so armed over two pixels where the left and the top arm over one, in a function
     * whose own comment says the figure "is not a tolerance to be widened". The furthest right a
     * pointer inside the desktop can be is `right - 1`, so the plain constant already admits it. */
    if (event.clientX - desk.left <= SNAP_ARM_PX) armed = WST_SNAP_L;
    else if (desk.right - event.clientX <= SNAP_ARM_PX) armed = WST_SNAP_R;
    else if (event.clientY - desk.top <= SNAP_ARM_PX) armed = WST_MAX;
    if (armed === this.armed) return;
    this.armed = armed;
    this.#renderSnap();
  }

  /** The ghost. One element per window, built on the first arm and removed with the frame: a
   *  preview is a picture, so it is the page's — and it reads `boxForState`, so it cannot promise
   *  a rectangle the window will not take. */
  #renderSnap() {
    if (!this.armed) {
      if (this.snapEl) this.snapEl.hidden = true;
      this.el.dataset.armed = "0";
      return;
    }
    if (!this.snapEl) {
      const ghost = document.createElement("div");
      ghost.className = "snap-preview";
      ghost.dataset.snapPreview = "1";
      ghost.setAttribute("aria-hidden", "true");
      ghost.style.position = "absolute";
      ghost.style.pointerEvents = "none";
      this.surfaceEl.append(ghost);
      this.snapEl = ghost;
    }
    const box = this.boxForState(this.armed);
    this.snapEl.hidden = false;
    this.snapEl.style.left = `${box.x}px`;
    this.snapEl.style.top = `${box.y}px`;
    this.snapEl.style.width = `${box.w}px`;
    this.snapEl.style.height = `${box.h}px`;
    this.snapEl.dataset.state = String(this.armed);
    this.el.dataset.armed = String(this.armed);
  }

  #clearSnap() {
    this.armed = 0;
    this.#renderSnap();
  }

  /**
   * Resize from one of the eight grips. `ax`/`ay` are the axes that grip moves: -1 the near edge,
   * +1 the far edge, 0 not at all.
   *
   * A DOCKED WINDOW DOES NOT RESIZE. Windows 7 disables the grips on a maximized window, and the
   * reason is this file's own: the geometry of a docked state comes from `boxForState`, so a
   * resize would be overwritten by the next `apply()` and the user would watch their drag undo
   * itself.
   */
  #startResize(event, ax, ay) {
    if (event.button !== 0) return;
    if (this.blocked) return;
    if (this.state !== WST_NORMAL) return;
    if (this.role === WROLE_DESKTOP) return;
    if (this.resize) this.resize.end();
    const from = { ...this.placed };
    const gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      end: () => {
        if (this.resize === gesture) this.resize = null;
        const doc = this.el.ownerDocument;
        doc.removeEventListener("pointermove", move);
        doc.removeEventListener("pointerup", up);
        doc.removeEventListener("pointercancel", up);
      },
      captureError: "",
    };
    const move = (e) => {
      if (this.resize !== gesture || e.pointerId !== gesture.id) return;
      const dx = e.clientX - gesture.x;
      const dy = e.clientY - gesture.y;
      /* THE FLOOR IS APPLIED TO THE EDGE BEING MOVED, which is why this is not simply
       * `clampBox`'s job. Dragging the LEFT edge right past the minimum must stop the edge, not
       * slide the whole window: without the `Math.min` the x would keep moving while the width sat
       * at MIN_W, and the window would crawl across the desktop. */
      const next = { ...from };
      if (ax < 0) {
        const want = Math.min(dx, from.w - MIN_W);
        next.x = from.x + want;
        next.w = from.w - want;
      } else if (ax > 0) {
        next.w = Math.max(MIN_W, from.w + dx);
      }
      if (ay < 0) {
        const want = Math.min(dy, from.h - MIN_H);
        next.y = from.y + want;
        next.h = from.h - want;
      } else if (ay > 0) {
        next.h = Math.max(MIN_H, from.h + dy);
      }
      this.box = next;
      this.apply();
      /* THE KERNEL LEARNS MID-DRAG, and the release-only report was a defect with two faces.
       * `/proc` and `governBlur`'s `blurRingArea(win.box.w, win.box.h)` described the PRE-DRAG
       * rectangle for the whole gesture — constraint 49's under-read in the direction constraint
       * 49 exists to forbid. And when `setPointerCapture` throws (Firefox does, constraint 175)
       * the gesture continues on the document listeners below, so a release outside the frame
       * never reaches the host's own `pointerup` hook and the kernel kept the pre-drag box
       * PERMANENTLY. */
      if (this.onGeom) this.onGeom("resize");
    };
    const up = (e) => {
      if (e.pointerId !== gesture.id) return;
      gesture.end();
    };
    this.resize = gesture;
    const doc = this.el.ownerDocument;
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", up);
    doc.addEventListener("pointercancel", up);
    try {
      // The grip itself takes the capture, so a resize that leaves the frame keeps arriving —
      // and it MAY THROW for a pointerId no live pointer owns (constraint 175).
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch (error) {
      gesture.captureError = `${error.name}: ${error.message}`;
    }
  }

  #barKey(event) {
    // The keyboard route to the same gesture, so it takes the same refusal.
    if (this.blocked) return;
    /* M14's STATES HAVE A KEYBOARD SPELLING, because every gesture in this file does (WCAG SC
     * 2.1.1) and because a check can then drive them as real trusted keys. Windows 7 spells these
     * Win+Arrow; the Win key is not deliverable to a page, so they are CTRL+Arrow here — and the
     * departure is recorded where a reader meets it rather than left to be discovered. */
    if (event.ctrlKey && !event.altKey) {
      const want = {
        ArrowUp: WST_MAX,
        ArrowDown: this.state === WST_NORMAL ? WST_MIN : WST_NORMAL,
        ArrowLeft: WST_SNAP_L,
        ArrowRight: WST_SNAP_R,
      }[event.key];
      if (want === undefined) return;
      event.preventDefault();
      this.askState(want);
      return;
    }
    const step = event.shiftKey ? 1 : KEY_STEP;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step],
      ArrowDown: [0, step] }[event.key];
    if (!d) return;
    event.preventDefault();
    // A DOCKED WINDOW DOES NOT CREEP. Its geometry is `boxForState`'s, so a move would be undone
    // by the next `apply()` — the same reason a resize is refused in that state.
    if (this.state !== WST_NORMAL) return;
    this.moveBy(d[0], d[1]);
  }

  /** The not-responding caption, from the kernel's detector. The TITLE carries the state, because
   *  the title is what a reader actually hits: a class alone would let a check pass against a
   *  window whose caption never changed. */
  setHealth(level) {
    this.health = level | 0;
    /* TWO CAPTIONS, AND THERE WERE THREE. "(Starting…)" was a window the PAGE had attached that no
     * process had opened yet; under `win_create` the creating process holds the fd from the
     * window's first instant, so the state is unreachable and the caption, its class and its
     * dataset flag went with it (constraint 210). */
    const suffix = this.health > 0 ? " (Not Responding)" : "";
    this.headingEl.textContent = this.titleText + suffix;
    this.el.classList.toggle("is-not-responding", this.health > 0);
    this.el.dataset.health = String(this.health);
    // Only at the second threshold: a window quiet for a second is usually just busy.
    this.endBtn.hidden = this.health < 2 && !this.systemModal;
  }

  /**
   * What the kernel's order said about this window: whether something blocks it, and whether IT
   * blocks everything.
   *
   * THE SECOND FLAG IS THE ESCAPE HATCH. A system-modal blocker needs no privilege to set, so any
   * program in `/usr/bin` can freeze every other window; and the documented recovery — End Process
   * at 5,000 ms — is driven by UNCOLLECTED events, so a process that keeps reading its own queue
   * never goes stale and the windows it blocked get nothing queued either. No button appeared
   * anywhere and the only way out was closing the tab. End Process is offered on the blocker's own
   * frame for as long as it holds that scope, so the hatch exists without a capability system
   * (constraint 236).
   */
  setBlocked({ blocked, systemModal }) {
    this.blocked = blocked === true;
    this.systemModal = systemModal === true;
    this.el.dataset.blocked = this.blocked ? "1" : "0";
    this.el.classList.toggle("is-blocked", this.blocked);
    this.setHealth(this.health);
  }

  setTitle(text) {
    this.titleText = String(text);
    this.setHealth(this.health);
  }

  close() {
    // A hook that can refuse, so the page can tear the session down before the frame goes.
    if (this.onClose && this.onClose() === false) return false;
    this.destroy();
    return true;
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    // THE GHOST GOES WITH THE FRAME. It is a sibling of the window under the desktop, so a window
    // destroyed mid-drag would leave a snap preview on screen for the rest of the session.
    if (this.snapEl) {
      this.snapEl.remove();
      this.snapEl = null;
    }
    this.el.remove();
  }
}
