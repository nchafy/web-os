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
  DL_CLEAR, DL_FILL_RECT, DL_STROKE_RECT, DL_LINE, DL_TEXT, DL_TEXT_DATA, DL_CLIP, DL_BLIT,
  DLT_BOLD, DLT_MONO, DLT_RIGHT, DLT_CENTER, DLC_RESET,
  decodeDrawOps, cssColor, textOfOps, blitFdOf, decodeBitmap,
} from "../abi.mjs";

/* THE TWO FAMILIES A DISPLAY LIST CAN ASK FOR, and the only typography in this file. A process
   names a FAMILY and not a font: it cannot measure one, has no access to what is installed, and a
   surface that honoured an arbitrary family would let a program's text reflow under it. These
   match `src/wm/aero.mjs`'s stacks so a surfaced window's text and the chrome around it are the
   same typeface. */
const UI_FAMILY = '"Segoe UI", system-ui, -apple-system, sans-serif';
const MONO_FAMILY = 'ui-monospace, Menlo, Consolas, monospace';

/** The pointer flags M8 sends, kept here so the host and this file agree on one spelling. */
export { WPTR_DOWN, WPTR_UP, WPTR_MOVE } from "../abi.mjs";

/**
 * M16's FIRST NEGATIVE CONTROL. The canvas is appended with no CSS box of its own, so it renders
 * at its intrinsic size — the backing store's — and stops being its client area.
 *
 * WHAT IT IS ABOUT: the extent contract below. With it on, a program that re-surfaces to the box
 * the kernel reported still draws into a canvas of the wrong size, so the geometry clause fails
 * while the re-surface, the row count and the pixel extent all hold. A control satisfied by any
 * of M16's four causes would verify none of them.
 *
 * MODULE-LEVEL, which is `src/wm/window.mjs`'s shape for `geometryControls` and its reason: the
 * headline path reads a plain boolean, and nothing here is reachable from a process.
 *
 * `noClip` is M17's: the `DL_CLIP` op is COUNTED and not applied, so a scrolled row paints over
 * the header a program drew. Counted rather than dropped on purpose — the op did reach the
 * renderer, and a control that also zeroed the counter would move the clauses that assert the op
 * arrived as well as the pixel clause it is about (`CLAUDE.md`: a control moves a NAMED subset).
 */
let surfaceControls = { noFill: false, noClip: false };

export function setSurfaceControls(opts = {}) {
  surfaceControls = { noFill: opts.noFill === true, noClip: opts.noClip === true };
  return { ...surfaceControls };
}

/** What is in force, read back out of the module that owns it rather than out of a page's own
 *  query parsing. A control a check believed was on and was not is a green run over an
 *  unmodified world. */
export function surfaceControlsInForce() {
  return { ...surfaceControls };
}

export class Surface {
  /** Whether a baseline snapshot of the 2D state is outstanding on the canvas's stack. One is,
   *  at all times once a batch has run — see `#resetClip`. */
  #clipScope = false;

  /** M23's scratch surface a blit's pixels are staged on, and its context. Lazy, so a page that
   *  never blits never allocates one, and GROWN AND NEVER SHRUNK, because a list of thumbnails
   *  blits the same size on every repaint. */
  #blitEl = null;

  #blitG = null;

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
    /** How many text RUNS were drawn, which a check reads back. */
    this.text = 0;
    /* HOW MANY CLIPS THE RENDERER WAS ASKED FOR, counted the way `text` is: a page cannot read a
       canvas's clip back, so this is the only evidence the op arrived. The two are separate
       because "never clipped" and "clipped and then reset" are different states and a reader
       telling them apart is the whole of M17's header clause. */
    this.clips = 0;
    this.clipResets = 0;
    /* M23. A BLIT DRAWN, and one ASKED FOR WITH NO PIXELS BEHIND IT. Two counters and not one for
       the reason `clips` and `clipResets` are two: the states differ and a reader has to tell them
       apart. An unbacked blit is the shape of every way the payload side-channel can fail —
       `k.wins.draw` dropped the map, the message lost it in transit, or the bytes are corrupt under
       the `blit-unvalidated` control — and all of those look exactly like "the program drew
       nothing" in a screenshot. NOT folded into `unknown`, which means an op this renderer does not
       know: a blit it does know and cannot honour is a different fact. */
    this.blits = 0;
    this.blitsUnbacked = 0;
    const canvas = document.createElement("canvas");
    canvas.className = "surface";
    canvas.width = this.w;
    canvas.height = this.h;
    // Focusable, for the same reason the terminal widget is: a surface that cannot take the
    // keyboard is a picture of an application.
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", spec.label || "Window surface");
    /* THE CANVAS FILLS ITS CLIENT AREA, AND THIS IS NOT A SKIN CHOICE. The kernel accounts the
     * area it granted (`docs/DECISIONS.md` D31) and the governor accounts the ring around it
     * (constraint 49), so a canvas whose CSS box is not its client area makes both accounts
     * describe a rectangle nobody renders. Set INLINE rather than in a stylesheet because five
     * hosts render a surface — `src/wm/aero.mjs` and four unskinned proof pages — and a fact with
     * five renderers has none. Recorded as proposed D40, because `src/wm/window.mjs`'s standing
     * rule is that the frame names nothing about how it looks: an extent is not a look.
     *
     * BOTH AXES, AND THE HORIZONTAL ONE IS A DIFFERENT MECHANISM. `.window-body` is a flex row, so
     * a canvas in it is a flex item whose `min-width: auto` resolves to its INTRINSIC width — the
     * backing store's. Without `minWidth: 0` the item refuses to shrink below it and the client
     * area clips the right-hand side instead of scaling it, which a `width: 100%` alone cannot
     * fix. `flex` and `minHeight` are the vertical half of the same statement. */
    if (!surfaceControls.noFill) {
      Object.assign(canvas.style, {
        display: "block", flex: "1 1 auto", minWidth: "0", minHeight: "0",
        width: "100%", height: "100%",
      });
    }
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
   *
   * `blits` is the batch's image payloads, `Map<fd, Uint8Array>`, resolved kernel-side because an
   * fd is meaningless here: this file holds no file table and must not acquire one. A `DL_BLIT`
   * whose fd is absent from the map is COUNTED and not drawn — see `blitsUnbacked`. Omitted means
   * an empty map, which is every batch a program sent before M23.
   */
  replay(bytes, blits = null) {
    /* THE WHOLE LENGTH, SO THE REFUSAL ABOVE IS REACHABLE. This rounded down to a whole number of
     * ops, which made `decodeDrawOps`'s "not a whole number of ops" throw unreachable from the
     * only caller that matters — and the docstring three lines up promised the opposite. A torn
     * batch is a kernel defect and must fail loudly here rather than be replayed as partial
     * garbage (`CLAUDE.md`, harness honesty). */
    const ops = decodeDrawOps(bytes, bytes.length);
    this.batches += 1;
    /* THE CLIP IS DROPPED HERE, AT THE TOP OF EVERY BATCH, AND THIS CALL IS LOAD-BEARING. A clip
     * left set by batch N makes batch N+1 draw NOTHING — a window that goes blank on its next
     * repaint, with no error anywhere to say why. A canvas `clip()` only ever intersects, so
     * `restore()` is the only way back out of one and a batch boundary is the only place the
     * renderer knows a program is done with it.
     *
     * AT THE TOP RATHER THAN AT THE END, so a batch that throws part-way through the loop below
     * cannot leave a clip armed either. The cost is that the baseline snapshot stays outstanding
     * between batches, which nothing else can observe: this is the only writer of this canvas. */
    this.#resetClip();
    /* INDEXED, because a text run is a header plus continuation records and the header has to
     * skip past its own data (`textOfOps` says how many). A `for..of` could not. */
    for (let i = 0; i < ops.length; i += 1) {
      const op = ops[i];
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
        case DL_TEXT: {
          /* THE ONE PLACE A STRING BECOMES PIXELS. `textOfOps` is the declared inverse of the
           * program's `encodeTextRun`, and it returns null for a run whose data records are
           * missing — in which case NOTHING is drawn and the batch is counted as unknown, because
           * half a filename reads as a filename. The kernel refuses such a batch before it gets
           * here (constraint 293); this is the second line of that same argument. */
          const got = textOfOps(ops, i);
          if (!got) {
            this.unknown += 1;
            break;
          }
          const size = Math.max(1, op.a2 | 0);
          const weight = op.flags & DLT_BOLD ? "bold " : "";
          const family = op.flags & DLT_MONO ? MONO_FAMILY : UI_FAMILY;
          this.g.font = `${weight}${size}px ${family}`;
          this.g.fillStyle = cssColor(op.a4);
          // TOP-LEFT AND NOT A BASELINE. A list row's y is the top of the row — that is what a
          // program computing `row * ROW_H` has — and asking it to know a font's ascent would put
          // the one piece of typography a process cannot measure into every caller.
          this.g.textBaseline = "top";
          this.g.textAlign = op.flags & DLT_RIGHT ? "right"
            : op.flags & DLT_CENTER ? "center" : "left";
          this.g.fillText(got.text, op.a0, op.a1);
          this.text += 1;
          // SKIP THE DATA RECORDS. They are part of this op, not ops of their own, so the loop
          // must not fall through to the `default` below and count each as unknown.
          i += got.records - 1;
          break;
        }
        case DL_CLIP:
          if (op.flags & DLC_RESET) {
            this.clipResets += 1;
            // a0..a3 ARE IGNORED. A reset is not "clip to the whole surface" — the surface is the
            // clip's default and a program that does not know its own extent could not name it.
            this.#resetClip();
            break;
          }
          /* COUNTED BEFORE THE CONTROL IS CONSULTED: the op reached the renderer either way, and
             the `noClip` world is about what the pixels then do. */
          this.clips += 1;
          if (!surfaceControls.noClip) {
            /* `beginPath` IS NOT OPTIONAL. `DL_LINE` leaves its segment in the current path, and a
               clip built on top of it would be the region of that path plus this rectangle. A
               SECOND clip in one batch intersects, which is the canvas's own rule and the reason
               `DLC_RESET` exists: two viewports in one window need a reset between them. */
            this.g.beginPath();
            this.g.rect(op.a0, op.a1, op.a2, op.a3);
            this.g.clip();
          }
          break;
        case DL_BLIT: {
          /* THE ONE PLACE A BITMAP BECOMES PIXELS. The op names a data-object fd and the kernel
           * resolved it into `blits`; this file decodes the header with the SAME `decodeBitmap` the
           * kernel validated with, so the two are not forming separate opinions about the layout
           * (constraint 293's rule, as it already applies to a text run).
           *
           * A MISSING OR CORRUPT PAYLOAD DRAWS NOTHING AND IS COUNTED. The kernel refuses corrupt
           * bytes before they get here; reaching this branch means either the payload channel
           * dropped the map or the `blit-unvalidated` control is in force, and both are states a
           * reader must be able to name rather than see as a blank window. */
          const payload = blits ? blits.get(blitFdOf(op)) : null;
          const bmp = payload ? decodeBitmap(payload) : null;
          if (!bmp) {
            this.blitsUnbacked += 1;
            break;
          }
          this.g.drawImage(this.#stage(bmp), 0, 0, bmp.w, bmp.h, op.a0, op.a1, bmp.w, bmp.h);
          this.blits += 1;
          break;
        }
        case DL_TEXT_DATA:
          /* REACHED ONLY WHEN A DATA RECORD HAD NO HEADER, because a well-formed run is skipped
           * past above. That is a malformed batch, and it is counted rather than drawn. */
          this.unknown += 1;
          break;
        default:
          this.unknown += 1;
          break;
      }
    }
    return ops.length;
  }

  /**
   * BACK TO THE SURFACE'S FULL EXTENT, and a fresh baseline for the next clip to be popped to.
   * Exactly one snapshot is outstanding on the canvas's state stack once a batch has run, so a
   * `restore` here can never pop past the state the constructor left.
   *
   * `restore` also discards the fill, stroke, font and alignment an op set, which is safe only
   * because every drawing op in `replay` sets its own before drawing. An op that came to rely on
   * inherited state would start losing it at a reset.
   */
  #resetClip() {
    if (this.#clipScope) this.g.restore();
    this.g.save();
    this.#clipScope = true;
  }

  /**
   * A decoded bitmap, as something `drawImage` will take, with its pixels at 0,0.
   *
   * `putImageData` STRAIGHT ONTO THE SURFACE WOULD BE WRONG, AND SILENTLY SO — which is the whole
   * reason this staging step exists. It is defined to ignore the clipping region, the transform,
   * the global alpha and the composite operation
   * (<https://html.spec.whatwg.org/multipage/canvas.html#dom-context-2d-putimagedata>), so a
   * thumbnail in a scrolled list would paint straight over the header `DL_CLIP` exists to protect:
   * M17's defect, back through a second door and with no error anywhere. `drawImage` honours all
   * four.
   *
   * SYNCHRONOUS, and that is not an accident either. `createImageBitmap` is async, and a renderer
   * that awaited one could not finish the batch it is in the middle of — constraint 219's shape,
   * and `bench/m23-blit/` is the measurement that the decode belongs in a process's own awaited
   * turn rather than anywhere on this path.
   */
  #stage(bmp) {
    if (!this.#blitEl || this.#blitEl.width < bmp.w || this.#blitEl.height < bmp.h) {
      this.#blitEl = new OffscreenCanvas(
        Math.max(bmp.w, this.#blitEl ? this.#blitEl.width : 0),
        Math.max(bmp.h, this.#blitEl ? this.#blitEl.height : 0),
      );
      this.#blitG = this.#blitEl.getContext("2d");
    }
    const img = this.#blitG.createImageData(bmp.w, bmp.h);
    img.data.set(bmp.pixels);
    this.#blitG.putImageData(img, 0, 0);
    /* THE SOURCE RECTANGLE IS THE CALLER'S TO NAME, and `replay` names it: the scratch may be
       LARGER than this bitmap, and a `drawImage` with no source rect would draw the whole scratch
       — including whatever a previous, bigger blit left in it. */
    return this.#blitEl;
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

  /** THE INVERSE of `pointAt`: where a surface pixel is on the page, in client coordinates.
   *
   *  It exists because a DRAG has to be driven at a point inside a window's own picture, and only
   *  the page knows where that is — the canvas is positioned by the clamp and scaled by CSS. A
   *  driver that computed it from a frame's box would be a second reading of the same scale, and
   *  the two would disagree the first time a surface was not the size of its client area. */
  clientAt(x, y) {
    const r = this.el.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) return null;
    return {
      x: Math.round(r.left + (x + 0.5) * (r.width / this.w)),
      y: Math.round(r.top + (y + 0.5) * (r.height / this.h)),
    };
  }

  /**
   * THE CANVAS'S CSS BOX, AND THE CLIENT AREA IT IS MEANT TO FILL. Both in CSS px, both measured.
   *
   * Two readings of one fact on purpose, which is `WinHost.report`'s rule for the blocked set: the
   * constructor DECLARES that the canvas fills its client area, and a declaration that is in force
   * and one that is overridden look the same in the source. This is the reading that answers it.
   *
   * `clientWidth`/`clientHeight` and not the parent's own rect: the rect is the BORDER box and
   * `.aero-desktop .window-body` carries a `border-top: 1px solid` (`src/wm/aero.mjs`), so the
   * rect is a pixel taller than the box the canvas fills.
   *
   * THE TOLERANCE IS THE CHECK'S AND NOT THIS METHOD'S. A `DOMRect`'s fields are doubles
   * (<https://drafts.fxtf.org/geometry/#dom-domrect>) and `clientWidth` is rounded to an integer
   * (<https://drafts.csswg.org/cssom-view/#dom-element-clientwidth>), so the two differ by up to a
   * pixel on any fractional layout. An exact-equality assertion over them fails where nothing is
   * wrong, and would fail in Firefox at dpr 1 (constraint 264).
   */
  extent() {
    const r = this.el.getBoundingClientRect();
    const into = this.el.parentElement;
    return {
      cssW: r.width,
      cssH: r.height,
      clientW: into ? into.clientWidth : 0,
      clientH: into ? into.clientHeight : 0,
    };
  }

  destroy() {
    this.el.remove();
  }

  report() {
    return {
      w: this.w, h: this.h, ops: this.ops, batches: this.batches, unknown: this.unknown,
      text: this.text, clips: this.clips, clipResets: this.clipResets,
      blits: this.blits, blitsUnbacked: this.blitsUnbacked,
      extent: this.extent(),
    };
  }
}
