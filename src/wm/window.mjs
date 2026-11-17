// A window: a frame, a title bar you can drag, and a client area. Unstyled; M11 does the skin and
// M9 does modality.
//
// THERE IS NO SYSCALL IN THIS FILE: a window agent cannot `Atomics.wait` (constraint 1), so this
// module draws and listens while `www/m4a.html` holds the one route to the kernel. Every gesture
// below has a keyboard spelling, so a check can drive it as real input.

/** Smallest a window may be dragged or resized to. webxp's numbers, kept. */
export const MIN_W = 220;
export const MIN_H = 120;
const DEFAULT_W = 560;
const DEFAULT_H = 360;

/** How much of the title bar must stay on screen, so a window cannot be dragged out of reach. */
const MIN_VISIBLE = 72;

/** One arrow press, in CSS pixels. The keyboard equivalent of a drag. */
const KEY_STEP = 10;

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
    /** 0 responding, 1 greyed caption, 2 End Process offered. Written only by `setHealth`. */
    this.health = 0;
    /** Whether the window's device is still waiting for its first opener. Also only `setHealth`. */
    this.starting = false;
    this.#build();
    this.apply();
  }

  #build() {
    const el = document.createElement("section");
    el.className = "window";
    el.id = this.id;
    // A labelled `section` is a region, the closest honest match: a window is not a dialog.
    el.setAttribute("aria-labelledby", `${this.id}-title`);

    const bar = document.createElement("div");
    bar.className = "window-title";
    // The bar IS the move handle, so it must be reachable without a pointer (WCAG SC 2.1.1).
    bar.tabIndex = 0;
    bar.setAttribute("role", "toolbar");

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
    this.closeBtn = this.#titleButton("✕", "window-close", () => this.close());
    boxes.append(this.endBtn, this.closeBtn);

    const body = document.createElement("div");
    body.className = "window-body";
    this.bodyEl = body;

    bar.append(heading, boxes);
    el.append(bar, body);
    bar.addEventListener("pointerdown", (e) => this.#startDrag(e));
    bar.addEventListener("keydown", (e) => this.#barKey(e));
    this.el = el;
    this.barEl = bar;
    this.surfaceEl.append(el);
  }

  #titleButton(glyph, cls, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `title-box ${cls}`;
    b.textContent = glyph;
    b.setAttribute("aria-label", glyph);
    b.addEventListener("click", onClick);
    return b;
  }

  surface() {
    const r = this.surfaceEl.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  }

  /** Write `box`, clamped, onto the element. The ONLY writer of `placed` and of the style. */
  apply() {
    this.placed = clampBox(this.box, this.surface());
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
  }

  moveBy(dx, dy) {
    // From `placed`, not from `box`. See the note on the two boxes.
    this.box = { ...this.placed, x: this.placed.x + dx, y: this.placed.y + dy };
    this.apply();
  }

  #startDrag(event) {
    if (event.button !== 0) return;
    if (event.target.closest("button")) return;
    // A second pointer re-enters here while a gesture is live, so the one in flight is ended
    // first: each gesture's listeners answer only to their own pointer id, so leaving them
    // attached leaks three per re-entry for the window's lifetime.
    if (this.drag) this.drag.end();
    const gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      from: this.placed,
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
      this.box = {
        ...gesture.from,
        x: gesture.from.x + (e.clientX - gesture.x),
        y: gesture.from.y + (e.clientY - gesture.y),
      };
      this.apply();
    };
    const up = (e) => {
      if (e.pointerId !== gesture.id) return;
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

  #barKey(event) {
    const step = event.shiftKey ? 1 : KEY_STEP;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step],
      ArrowDown: [0, step] }[event.key];
    if (!d) return;
    event.preventDefault();
    this.moveBy(d[0], d[1]);
  }

  /** The not-responding caption, from the kernel's detector. The TITLE carries the state, because
   *  the title is what a reader actually hits: a class alone would let a check pass against a
   *  window whose caption never changed. */
  setHealth(level, starting = false) {
    this.health = level | 0;
    /* Three captions, because two of the three states are not failures: "(Starting…)" is a terminal
     * whose process has not yet opened its device, and calling that "(Not Responding)" tells a
     * reader their working terminal is broken. */
    this.starting = !!starting;
    const suffix = this.health > 0
      ? " (Not Responding)"
      : (this.starting ? " (Starting…)" : "");
    this.headingEl.textContent = this.titleText + suffix;
    this.el.classList.toggle("is-not-responding", this.health > 0);
    this.el.classList.toggle("is-starting", this.health === 0 && this.starting);
    this.el.dataset.health = String(this.health);
    this.el.dataset.starting = this.starting ? "1" : "0";
    // Only at the second threshold: a window quiet for a second is usually just busy.
    this.endBtn.hidden = this.health < 2;
  }

  setTitle(text) {
    this.titleText = String(text);
    this.setHealth(this.health, this.starting);
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
    this.el.remove();
  }
}
