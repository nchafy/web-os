// THE ONE RENDERER OF A DISPLAY LIST. A window's surface, as a canvas in the page, and the only
// place a display-list op becomes a drawing call.
//
// THERE IS NO SYSCALL IN THIS FILE, and no kernel object either: it is handed bytes and a size.
// The kernel owns the surface in the sense that matters — it allocated it, it accounts for it and
// it can revoke it (`docs/DECISIONS.md` D31) — and the pixels live here because this is the agent
// with a compositor.
//
// WHY A DISPLAY LIST AND NOT A TRANSFERRED CANVAS. Measured, before any of this was built: a
// transferred `OffscreenCanvas` does not arrive at a process that is spinning, and does not arrive
// at one parked in `Atomics.wait` — which is the state a process is in during the very syscall
// that would carry it (constraint 219). A surface handed over could also be neither accounted nor
// revoked, which M12's blur governor needs.

import {
  DL_CLEAR, DL_FILL_RECT, DL_STROKE_RECT, DL_LINE, decodeDrawOps, cssColor,
} from "../abi.mjs";

/** The pointer flags M8 sends, kept here so the host and this file agree on one spelling. */
export { WPTR_DOWN, WPTR_UP, WPTR_MOVE } from "../abi.mjs";

export class Surface {
  /** `spec.into` is the window's client area. The canvas is sized in DEVICE pixels — the size the
   *  process asked for — and scaled to fill the client area by CSS, so a process that asks for a
   *  surface smaller than its frame gets a scaled one rather than a corner of one. */
  constructor(spec) {
    this.w = Math.max(1, spec.w | 0);
    this.h = Math.max(1, spec.h | 0);
    this.ops = 0;
    this.batches = 0;
    /** Ops this renderer did not know. COUNTED AND NOT IGNORED: a page that silently dropped an
     *  op a newer process sent would make a version mismatch look like a drawing bug. */
    this.unknown = 0;
    const canvas = document.createElement("canvas");
    canvas.className = "surface";
    canvas.width = this.w;
    canvas.height = this.h;
    // Focusable, for the same reason the terminal widget is: a surface that cannot take the
    // keyboard is a picture of an application.
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", spec.label || "Window surface");
    spec.into.append(canvas);
    this.el = canvas;
    // `alpha: false` is NOT used: a surface a process has not cleared should show as transparent
    // rather than as black, because "nothing drawn yet" and "drawn black" are different states and
    // a reader can tell them apart only if they look different.
    this.g = canvas.getContext("2d");
  }

  /**
   * Replay one batch. `bytes` is the kernel's copy of the caller's region, so the length is
   * already a whole number of ops — `decodeDrawOps` refuses anything else rather than dropping a
   * tail, which is the same rule the window event record uses.
   */
  replay(bytes) {
    /* THE WHOLE LENGTH, SO THE REFUSAL ABOVE IS REACHABLE. This rounded down to a whole number of
     * ops, which made `decodeDrawOps`'s "not a whole number of ops" throw unreachable from the
     * only caller that matters — and the docstring three lines up promised the opposite. A torn
     * batch is a kernel defect and must fail loudly here rather than be replayed as partial
     * garbage (`CLAUDE.md`, harness honesty). */
    const ops = decodeDrawOps(bytes, bytes.length);
    this.batches += 1;
    for (const op of ops) {
      this.ops += 1;
      switch (op.op) {
        case DL_CLEAR:
          // CLEAR IS A FILL AND NOT A `clearRect`: a process that asked for opaque white would
          // otherwise get transparency, and the op carries a colour precisely so it can say.
          this.g.fillStyle = cssColor(op.a0);
          this.g.fillRect(0, 0, this.w, this.h);
          break;
        case DL_FILL_RECT:
          this.g.fillStyle = cssColor(op.a4);
          this.g.fillRect(op.a0, op.a1, op.a2, op.a3);
          break;
        case DL_STROKE_RECT:
          this.g.strokeStyle = cssColor(op.a4);
          this.g.lineWidth = Math.max(1, op.a5);
          // HALF-PIXEL OFFSET, because a 1 px stroke on an integer coordinate straddles two rows
          // of pixels and renders as two grey lines. The op's coordinates are the rectangle a
          // process asked for; this is how a canvas draws that rectangle sharply.
          this.g.strokeRect(op.a0 + 0.5, op.a1 + 0.5, op.a2 - 1, op.a3 - 1);
          break;
        case DL_LINE:
          this.g.strokeStyle = cssColor(op.a4);
          this.g.lineWidth = Math.max(1, op.a5);
          this.g.beginPath();
          this.g.moveTo(op.a0 + 0.5, op.a1 + 0.5);
          this.g.lineTo(op.a2 + 0.5, op.a3 + 0.5);
          this.g.stroke();
          break;
        default:
          this.unknown += 1;
          break;
      }
    }
    return ops.length;
  }

  /** One pixel, as `rgba(r,g,b,a)` with a 0–255 alpha — WHAT A READER WOULD SEE, read back out of
   *  the canvas the browser actually painted. A check asserts on this and not on the ops it sent,
   *  because an inert canvas and a working one are the same picture (constraint 40).
   *
   *  `src/abi.mjs`'s `pixelColor` renders the colour a process ASKED FOR into this same shape, so
   *  the two are comparable without either side writing the format out. */
  pixel(x, y) {
    const d = this.g.getImageData(x, y, 1, 1).data;
    return `rgba(${d[0]},${d[1]},${d[2]},${d[3]})`;
  }

  /** Where a browser pointer event landed, in SURFACE pixels. The canvas is scaled by CSS, so the
   *  ratio is the scale — a process knows only its own surface and must not be handed page
   *  coordinates. */
  pointAt(event) {
    const r = this.el.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) return null;
    return {
      x: Math.round((event.clientX - r.left) * (this.w / r.width)),
      y: Math.round((event.clientY - r.top) * (this.h / r.height)),
    };
  }

  destroy() {
    this.el.remove();
  }

  report() {
    return {
      w: this.w, h: this.h, ops: this.ops, batches: this.batches, unknown: this.unknown,
    };
  }
}
