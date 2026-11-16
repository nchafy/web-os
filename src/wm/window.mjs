// A window: a frame, a title bar you can drag, and a client area.
//
// PORTED FROM `../webxp/src/window.mjs` (836 lines) AND UNSTYLED, which is what `MILESTONES.md`
// M4a asks for: "Drop in `../webxp/src/window.mjs` unstyled and point it at the pty." What came
// across is the geometry and the gestures — `box` vs `placed`, the clamp, the pointer drag, the
// keyboard equivalent of the drag — because those are the parts that were right and that a
// re-write would get wrong again. What did NOT come across: the Aero chrome, the icon set, the
// widget vocabulary, the modal layer, the zoom animation, the snap thresholds. M11 does the skin
// and M9 does modality.
//
// WHY THERE IS NO SYSCALL IN THIS FILE. A window agent cannot `Atomics.wait` (constraint 1), so
// the page cannot make a syscall at all. This module draws and listens; `www/m4a.html` carries
// the one route to the kernel, which is the kernel worker's own message port. That split is also
// what keeps the special case honest: M7 moves the window's STATE behind `win_*` calls made by a
// process, and this file stays what it is — the thing that paints.
//
// THE KEYBOARD IS NOT DECORATION HERE. `CLAUDE.md`: "A window manager cannot be checked by
// screenshot. An inert frame and a working one are the same picture. Drive real input, read the
// geometry back." Every gesture below has a keyboard spelling so a check can drive it.

/** Smallest a window may be dragged or resized to. webxp's numbers, kept. */
export const MIN_W = 220;
export const MIN_H = 120;
export const DEFAULT_W = 560;
export const DEFAULT_H = 360;

/** How much of the title bar must stay on screen, so a window cannot be dragged out of reach. */
const MIN_VISIBLE = 72;

/** One arrow press, in CSS pixels. The keyboard equivalent of a drag. */
const KEY_STEP = 10;

let serial = 0;

/**
 * `box` held inside the desktop. Returns a NEW object; never mutates its argument.
 *
 * THE TWO `Math.max(…, 0)` GUARDS AND THE `MIN_W`/`MIN_H` FLOOR ARE WEBXP'S AND WERE DROPPED BY
 * THE PORT. Both are about a surface that is SMALLER than the window's own minimum, which is not a
 * hypothetical: a `Win` built before its desktop has been laid out, or inside a hidden container,
 * measures `{w: 0, h: 0}`. Without the floor the window became 0×0; without the outer `Math.max`
 * the upper bound on `x` went negative and WON, placing it at -72 with none of the title bar on
 * screen — the exact invariant `MIN_VISIBLE` exists to hold, inverted. It then stayed there until
 * some gesture happened to re-run `apply()`.
 *
 * So a window never shrinks below `MIN_W`×`MIN_H` even on a surface that cannot show it, and the
 * clamp never pushes it to a negative coordinate that the clamp itself invented.
 */
export function clampBox(box, surface) {
  const w = Math.max(Math.min(Math.max(box.w, MIN_W), surface.w), MIN_W);
  const h = Math.max(Math.min(Math.max(box.h, MIN_H), surface.h), MIN_H);
  return {
    w,
    h,
    // The LEFT edge may go negative down to a sliver, so a window can be pushed off the left; the
    // RIGHT edge may not pass `surface.w - MIN_VISIBLE`, so the title bar is always grabbable.
    x: Math.min(Math.max(box.x, MIN_VISIBLE - w), Math.max(surface.w - MIN_VISIBLE, 0)),
    y: Math.min(Math.max(box.y, 0), Math.max(surface.h - MIN_VISIBLE, 0)),
  };
}

export class Win {
  /**
   * @param {object} spec
   * @param {string} spec.title
   * @param {HTMLElement} spec.into     the desktop element
   * @param {Function} [spec.onClose]   the close box and Alt+F4. Returning false keeps it open,
   *                                    which is what M9 generalises into a close REQUEST.
   * @param {Function} [spec.onEndProcess] the affordance the not-responding detector reveals
   */
  constructor(spec) {
    this.id = spec.id || `win-${++serial}`;
    this.surfaceEl = spec.into;
    this.onClose = spec.onClose || null;
    this.onEndProcess = spec.onEndProcess || null;
    this.titleText = String(spec.title || "");
    /**
     * Where the window wants to be, and where it is.
     *
     * TWO BOXES AND NOT ONE, carried over from webxp because the reason is not obvious: `apply()`
     * never writes `box`, so a desktop that briefly shrinks and grows back returns the window to
     * where the user put it rather than leaving it where it was squeezed. A gesture writes `box`
     * from `placed` plus its own delta, so a drag that starts while the window is clamped adopts
     * the clamped coordinate — that is the gesture speaking, and seeding it from an off-screen
     * `box` would make the window jump out from under the pointer.
     */
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

  /* ---- markup --------------------------------------------------------------------------- */

  #build() {
    const el = document.createElement("section");
    el.className = "window";
    el.id = this.id;
    // A labelled `section` is a region, which is the closest honest match: a window is not itself
    // a dialog and ARIA has no role for "an application window". webxp's reasoning, kept.
    el.setAttribute("aria-labelledby", `${this.id}-title`);

    const bar = document.createElement("div");
    bar.className = "window-title";
    // The bar IS the move handle, so it has to be reachable without a pointer: focus it and press
    // an arrow (WCAG SC 2.1.1). It is also how a check drives a move.
    bar.tabIndex = 0;
    bar.setAttribute("role", "toolbar");

    const heading = document.createElement("h2");
    heading.id = `${this.id}-title`;
    heading.textContent = this.titleText;
    this.headingEl = heading;

    const boxes = document.createElement("div");
    boxes.className = "title-buttons";
    // THE END PROCESS BUTTON IS BUILT NOW AND HIDDEN, not created when the detector fires. A
    // control that appears by being constructed cannot be found by a check before it is needed,
    // and "the button is absent" and "the button was never written" look identical in the DOM.
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

  /* ---- geometry ------------------------------------------------------------------------- */

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
    // PUBLISHED AS DATA, so a check can read the geometry back without parsing a style string or
    // trusting a screenshot. `CLAUDE.md` §Verification: drive real input, read the geometry back.
    this.el.dataset.x = String(this.placed.x);
    this.el.dataset.y = String(this.placed.y);
    this.el.dataset.w = String(this.placed.w);
    this.el.dataset.h = String(this.placed.h);
  }

  moveBy(dx, dy) {
    // FROM `placed`, not from `box`. See the note on the two boxes.
    this.box = { ...this.placed, x: this.placed.x + dx, y: this.placed.y + dy };
    this.apply();
  }

  #startDrag(event) {
    if (event.button !== 0) return;
    if (event.target.closest("button")) return;
    // A SECOND POINTER — two fingers, or a mouse and a touch — re-enters here while a gesture is
    // live. The one in flight is ENDED FIRST, and webxp's `beginGesture` carries the reason the
    // port had to re-learn: each gesture's listeners only answer to their own pointer id, so
    // leaving them attached leaks three per re-entry for the window's lifetime. The first
    // gesture's `up` then sees a different id and returns without removing them, and once the
    // second gesture clears `drag` it short-circuits for ever.
    if (this.drag) this.drag.end();
    // THE GESTURE CARRIES ITS OWN TEARDOWN, so `end` is one function and both callers — the
    // pointer lifting and a second pointer arriving — detach exactly the listeners they added.
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
      //: Whatever `setPointerCapture` refused with, or "". Published so a drag that does nothing
      //: says why instead of looking like a window that will not move.
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
    /* THE LISTENERS GO ON THE DOCUMENT, AND THEY GO ON BEFORE THE CAPTURE.
     *
     * Both halves are a defect this file had, and the second one was REPORTED FROM A REAL BROWSER
     * as a title bar that would not drag while the keyboard move worked.
     *
     * On the document, because that is what tracking a pointer outside the element actually
     * requires. `setPointerCapture` was doing that job, and a pointer that leaves the title bar —
     * which every drag of more than a few pixels does — delivers its `pointermove` and its
     * `pointerup` elsewhere without it. Listening on the document needs no capture to be correct.
     *
     * Before the capture, because the capture MAY THROW and must not be load-bearing. It is an
     * optimisation over the document listener, not a requirement of it; `NotFoundError` for a
     * pointerId no live pointer owns is the documented behaviour
     * (https://w3c.github.io/pointerevents/#dom-element-setpointercapture), and a throw here
     * aborted this method before a single listener was attached, so the window went dead to the
     * mouse and said nothing.
     *
     * BOTH BEHAVIOURS ARE MEASURED, which is the whole lesson. Chrome 157 does NOT throw for a
     * synthetic pointerId 1 — so the geometry proof was green here. Firefox DOES:
     * `DOMException: Element.setPointerCapture: Invalid pointer id`, reported from a real browser
     * as a title bar that would not drag while the keyboard move worked, with the throw at this
     * line in the stack. A green check on one engine is not evidence about another, and this was
     * a finding a critic raised and the author dismissed on exactly that bad evidence. The error
     * is now recorded on the gesture instead of being thrown away. */
    const doc = this.el.ownerDocument;
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", up);
    // A CANCEL ENDS THE DRAG TOO. Without it a pointer the browser took away (a gesture, a lost
    // capture) left `drag` set, and the next unrelated pointermove teleported the window.
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

  /* ---- caption and health --------------------------------------------------------------- */

  /**
   * The not-responding caption, from the kernel's detector.
   *
   * THE TITLE IS WHAT A READER ACTUALLY HITS, so it is the title that carries the state —
   * `CLAUDE.md`: "What the reader would actually hit MUST be asserted, not a property that implies
   * it." A class alone would let a check pass against a window whose caption never changed.
   */
  setHealth(level, starting = false) {
    this.health = level | 0;
    /* THREE CAPTIONS, BECAUSE THERE ARE THREE STATES AND TWO OF THEM ARE NOT FAILURES.
     *
     * "(Starting…)" is a terminal whose process has not yet opened its device. A page that called
     * that "(Not Responding)" told a reader their working terminal was broken, which is what
     * happened — typing in the first moment of a session greyed the caption of something that was
     * merely still coming up. `src/kernel/console.mjs` `openedEver` carries the distinction. */
    this.starting = !!starting;
    const suffix = this.health > 0
      ? " (Not Responding)"
      : (this.starting ? " (Starting…)" : "");
    this.headingEl.textContent = this.titleText + suffix;
    this.el.classList.toggle("is-not-responding", this.health > 0);
    this.el.classList.toggle("is-starting", this.health === 0 && this.starting);
    this.el.dataset.health = String(this.health);
    this.el.dataset.starting = this.starting ? "1" : "0";
    // The affordance appears only at the SECOND threshold. A window that has been quiet for a
    // second is usually just busy; one that has been quiet for five is the case the button is for.
    this.endBtn.hidden = this.health < 2;
  }

  setTitle(text) {
    this.titleText = String(text);
    this.setHealth(this.health, this.starting);
  }

  close() {
    // A HOOK THAT CAN REFUSE. M9 turns this into a close REQUEST a process may decline; here it
    // exists so the page can tear the session down before the frame goes, and so the one path that
    // destroys the window is this one.
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
