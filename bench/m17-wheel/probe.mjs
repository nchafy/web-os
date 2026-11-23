// M17's CLIP RESET, and the wheel's coalescing arithmetic, under plain Node.
//
// WHAT THIS IS FOR, in `docs/PLAN-SHELL.md` §5's own words: "`DL_CLIP` left set by batch N makes
// batch N+1 draw nothing — a window that goes blank on its next repaint with no error anywhere."
// Two batches, the second carrying no clip op, and the assertion is that the second DREW. The fix
// is that `replay` resets the clip at the top of every batch; this file is what proves the reset
// exists.
//
// AND IT PROVES IT BY REMOVING IT. A probe that passes whether or not the reset is there is worth
// nothing, so §2 below runs the SAME two batches against a context whose `restore()` cannot pop —
// and the reset is a `restore()` and nothing else (`src/wm/surface.mjs`'s `#resetClip`), so that
// context is exactly the world with no reset. The clause flips. `#resetClip` is private and cannot
// be monkey-patched, which is why the mutation is made at the only joint that is reachable.
//
// THE CANVAS STUB IS NOT GENTLER THAN A REAL ONE (constraint 98). It rasterises, it intersects a
// clip, and it THROWS on a `restore()` with no `save()` outstanding — a stub that ignored `clip()`
// would report the defect above as a pass, so §0 asserts the stub can show a clip at all before
// anything else is asked of it.
//
// What this CANNOT cover is a font, a real `backdrop-filter`, the host's wheel route, or CDP's
// delta unit: those need a browser, and `www/m17.html`, `bench/m17-wheel/probe.py` and
// `scripts/check.py` carry them.
import {
  Surface, setSurfaceControls, surfaceControlsInForce,
} from "../../src/wm/surface.mjs";
import {
  WinMgr, installWindowKernel, setWheelCoalesce,
} from "../../src/kernel/wins.mjs";
import {
  DLOP_BYTES, DL_CLEAR, DL_FILL_RECT, DL_LINE, DL_CLIP, DLC_RESET,
  WEV_BYTES, WEV_WHEEL, WEV_KEY, WIN_EVENT_CAP, WWHEEL_PAGE, WWHEEL_COALESCED, WMOD_CTRL,
  MAX_INLINE,
  encodeDrawOp, encodeTextRun, decodeWinEvents, wheelAt, packWheelPoint, pixelColor,
} from "../../src/abi.mjs";

const results = [];
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  results.push({ name: n, ok, got: ok ? undefined : g, want: ok ? undefined : w });
};
const checkThat = (n, c, d) => results.push({ name: n, ok: !!c, detail: c ? undefined : d });

// ---- the canvas stub ------------------------------------------------------------------------
//
// A rect raster and a rect clip, which is all `DL_CLIP` can ask for. `fillStyle` arrives as
// `cssColor`'s `rgba(r,g,b,a)` with a 0-1 alpha and `Surface.pixel` reads back a 0-255 one, so the
// two ends of the comparison are `cssColor` and `pixelColor` and neither is written out here.

const intersect = (a, b) => {
  if (!a) return b;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const t = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, r - x), h: Math.max(0, t - y) };
};

const inside = (clip, x, y) => !clip
  || (x >= clip.x && y >= clip.y && x < clip.x + clip.w && y < clip.y + clip.h);

class FakeCtx {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Uint8ClampedArray(w * h * 4);
    /** null means the surface's full extent, which is a canvas's own default for no clip. */
    this.clip_ = null;
    this.stack = [];
    this.pending = null;
    this.texts = [];
    this.strokes = 0;
    this.restores = 0;
    /**
     * THE NEGATIVE HALF, and the only mutation this file makes. `Surface#resetClip` drops a clip by
     * `restore()`ing to a baseline snapshot — there is no other mechanism — so a context that
     * cannot pop IS the world where `replay` does not reset between batches.
     */
    this.pinClip = false;
    this.ignoredPops = 0;
  }

  save() {
    if (this.pinClip) return;
    this.stack.push(this.clip_);
  }

  restore() {
    if (this.pinClip) { this.ignoredPops += 1; return; }
    // THE STUB POLICES THE INVARIANT RATHER THAN TRUSTING IT: exactly one unbalanced `save()` is
    // outstanding on a Surface's context, so a `restore` here popping past the constructor's state
    // is a renderer defect and must be loud rather than silently un-clipping everything.
    if (!this.stack.length) throw new Error("restore() with no save() outstanding");
    this.clip_ = this.stack.pop();
    this.restores += 1;
  }

  beginPath() { this.pending = null; }

  rect(x, y, w, h) { this.pending = { x, y, w, h }; }

  clip() {
    // A canvas `clip()` INTERSECTS (`src/abi.mjs`'s `DLC_RESET` docstring), and a stub that
    // replaced instead would make the two-viewport clause below pass for the wrong reason.
    this.clip_ = intersect(this.clip_, this.pending || { x: 0, y: 0, w: 0, h: 0 });
  }

  fillRect(x, y, w, h) {
    const [r, g, b, a] = parseRgba(this.fillStyle);
    for (let py = Math.max(0, y | 0); py < Math.min(this.h, (y + h) | 0); py += 1) {
      for (let pxx = Math.max(0, x | 0); pxx < Math.min(this.w, (x + w) | 0); pxx += 1) {
        if (!inside(this.clip_, pxx, py)) continue;
        const o = (py * this.w + pxx) * 4;
        this.px[o] = r; this.px[o + 1] = g; this.px[o + 2] = b; this.px[o + 3] = a;
      }
    }
  }

  // No glyph rasteriser here, so a run is RECORDED with whether its anchor was clipped away. A
  // probe must not assert a pixel it cannot draw; `www/m17.html` reads the real glyphs.
  fillText(text, x, y) { this.texts.push({ text, x, y, clipped: !inside(this.clip_, x, y) }); }

  moveTo() {}

  lineTo() {}

  stroke() { this.strokes += 1; }

  strokeRect() { this.strokes += 1; }

  getImageData(x, y, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let j = 0; j < h; j += 1) {
      for (let i = 0; i < w; i += 1) {
        const s = ((y + j) * this.w + (x + i)) * 4;
        const d = (j * w + i) * 4;
        out[d] = this.px[s]; out[d + 1] = this.px[s + 1];
        out[d + 2] = this.px[s + 2]; out[d + 3] = this.px[s + 3];
      }
    }
    return { data: out };
  }
}

function parseRgba(style) {
  const m = /rgba?\(([^)]*)\)/.exec(String(style));
  if (!m) throw new Error(`a fill style this stub cannot read: ${style}`);
  const n = m[1].split(",").map((s) => Number(s.trim()));
  // The fourth term is a 0-1 alpha, which is what `cssColor` produces.
  return [n[0], n[1], n[2], Math.round((n[3] === undefined ? 1 : n[3]) * 255)];
}

const PARENT = {
  append() {},
  clientWidth: 0,
  clientHeight: 0,
};

globalThis.document = {
  createElement() {
    const el = {
      style: {},
      className: "",
      tabIndex: 0,
      width: 1,
      height: 1,
      parentElement: PARENT,
      setAttribute() {},
      remove() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: el.width, height: el.height }),
      getContext() {
        el.ctx = new FakeCtx(el.width, el.height);
        return el.ctx;
      },
    };
    return el;
  },
};

// ---- the display lists ---------------------------------------------------------------------

const batch = (ops) => {
  const bytes = new Uint8Array(ops.length * DLOP_BYTES);
  const dv = new DataView(bytes.buffer);
  ops.forEach((op, i) => encodeDrawOp(dv, i * DLOP_BYTES, op));
  return bytes;
};

const SW = 200;
const SH = 120;
/** A header band and the viewport under it, in SURFACE px — `files`'s shape, as geometry only. */
const HEADER = { x: 0, y: 0, w: SW, h: 20 };
const VIEW = { x: 0, y: 20, w: SW, h: SH - 20 };
const WHITE = 0xffffffff;
const HEADER_C = 0x1050a0ff;
const ROW_C = 0xc02020ff;
const SECOND_C = 0x20a040ff;

const clipTo = (r) => ({ op: DL_CLIP, a0: r.x, a1: r.y, a2: r.w, a3: r.h });
const resetClip = () => ({ op: DL_CLIP, flags: DLC_RESET, a0: 0, a1: 0, a2: 0, a3: 0 });
const fill = (r, c) => ({
  op: DL_FILL_RECT, a0: r.x, a1: r.y, a2: r.w, a3: r.h, a4: c,
});
const WHOLE = { x: 0, y: 0, w: SW, h: SH };

/** Batch ONE: the header, then a viewport, then a row list that OVERFLOWS it — a row drawn at the
 *  header's y is what an unclipped scroll offset produces, so the clip is what keeps the header. */
const FIRST = batch([
  { op: DL_CLEAR, a0: WHITE },
  fill(HEADER, HEADER_C),
  clipTo(VIEW),
  fill(WHOLE, ROW_C),
]);

/** Batch TWO: NO CLIP OP AT ALL, repainting the header. This is the batch the defect eats. */
const SECOND = batch([fill(HEADER, SECOND_C)]);

const surfaceOf = () => new Surface({ w: SW, h: SH, into: PARENT, label: "probe" });

// ---- §0 the stub can show a clip, so the clause below can fail -----------------------------
{
  const s = surfaceOf();
  s.replay(FIRST);
  check("a clipped fill does not reach the header", s.pixel(5, 5), pixelColor(HEADER_C));
  check("and does reach inside the viewport", s.pixel(5, 60), pixelColor(ROW_C));
  check("the renderer counted the clip op", s.report().clips, 1);
  check("and counted no reset op, because the batch sent none", s.report().clipResets, 0);
}

// ---- §1 THE CLAUSE: a second batch with no clip op still draws ------------------------------
//
// `secondDrew` is one boolean read off the canvas, so §2 can run the same arithmetic in the other
// world and compare. The pixel is in the HEADER — outside batch one's clip — which is the only
// place the two worlds differ.
function twoBatches({ pinClip = false } = {}) {
  const s = surfaceOf();
  if (pinClip) s.el.ctx.pinClip = true;
  s.replay(FIRST);
  const before = s.pixel(5, 5);
  s.replay(SECOND);
  const after = s.pixel(5, 5);
  return {
    before, after, secondDrew: after === pixelColor(SECOND_C), surface: s,
  };
}

{
  const got = twoBatches();
  check("batch two repaints the header batch one clipped away", got.secondDrew, true);
  check("the pixel is the colour batch two asked for", got.after, pixelColor(SECOND_C));
  check("and it was batch one's colour before", got.before, pixelColor(HEADER_C));
  check("batch two carried no clip op", got.surface.report().clips, 1);
  check("and both batches were replayed", got.surface.report().batches, 2);
}

// ---- §2 and with the reset removed, that clause FAILS --------------------------------------
//
// THE POINT OF THIS FILE. Without it, every assertion above is satisfied by a renderer that never
// resets and a canvas that never clips.
{
  const got = twoBatches({ pinClip: true });
  check("with no reset, batch two draws NOTHING where batch one clipped", got.secondDrew, false);
  check("the header still carries batch one's colour — the window went blank on its repaint",
    got.after, pixelColor(HEADER_C));
  checkThat("and the reset was attempted, so the mutation removed it rather than skipping it",
    got.surface.el.ctx.ignoredPops >= 1, got.surface.el.ctx.ignoredPops);
  // THE DEFECT IS SILENT, which is why a pixel is the instrument: nothing above refused.
  check("the batch still returned its op count, so no error says why",
    got.surface.report().batches, 2);
}

// ---- §3 two viewports in one batch, with DLC_RESET between them -----------------------------
//
// A canvas `clip()` intersects, so a second viewport without a reset would be the INTERSECTION of
// the two — empty for any two disjoint bands, which is the same blank screen one batch later.
{
  const A = { x: 0, y: 20, w: SW, h: 40 };
  const B = { x: 0, y: 60, w: SW, h: 60 };
  const s = surfaceOf();
  s.replay(batch([
    { op: DL_CLEAR, a0: WHITE },
    fill(HEADER, HEADER_C),
    clipTo(A),
    fill(WHOLE, ROW_C),
    resetClip(),
    clipTo(B),
    fill(WHOLE, SECOND_C),
  ]));
  check("the first viewport drew", s.pixel(5, 30), pixelColor(ROW_C));
  check("the second drew OUTSIDE the first, so the reset dropped it rather than intersecting",
    s.pixel(5, 80), pixelColor(SECOND_C));
  check("and neither reached the header", s.pixel(5, 5), pixelColor(HEADER_C));
  check("two clips were counted", s.report().clips, 2);
  check("and one reset, which is the op and not the batch boundary", s.report().clipResets, 1);
}

// ---- §4 the save/restore balance, which the stub would have thrown over ---------------------
{
  const s = surfaceOf();
  for (let i = 0; i < 4; i += 1) s.replay(FIRST);
  check("exactly one baseline snapshot is outstanding between batches",
    s.el.ctx.stack.length, 1);
  // ONE FEWER POP THAN BATCHES: the first batch has no baseline to drop yet.
  check("and a batch boundary pops exactly one", s.el.ctx.restores, 3);
  check("four batches were replayed", s.report().batches, 4);
}

// ---- §5 a clip around the ops that are not fills --------------------------------------------
//
// `DL_LINE` leaves its segment in the current path, so a `clip()` built without `beginPath` would
// be that path PLUS the rectangle — a region no program named. A text run after a clip is the
// shape `files` draws, and the run's own visibility is what a reader would see.
{
  const s = surfaceOf();
  const ops = [
    { op: DL_CLEAR, a0: WHITE },
    { op: DL_LINE, a0: 0, a1: 0, a2: SW, a3: SH, a4: HEADER_C, a5: 1 },
    clipTo(VIEW),
    fill(WHOLE, ROW_C),
  ];
  const bytes = new Uint8Array((ops.length + 2) * DLOP_BYTES);
  const dv = new DataView(bytes.buffer);
  ops.forEach((op, i) => encodeDrawOp(dv, i * DLOP_BYTES, op));
  // A run whose anchor is INSIDE the viewport, and one whose anchor is in the header above it.
  const runs = encodeTextRun("in", { x: 4, y: 40, size: 11, rgba: 0x000000ff });
  runs.forEach((op, i) => encodeDrawOp(dv, (ops.length + i) * DLOP_BYTES, op));
  const n = s.replay(bytes);
  checkThat("the whole batch replayed", n === ops.length + runs.length, { n });
  // THE LINE REACHED THE CANVAS, which is what makes the next clause about the clip rather than
  // about a dropped op: a stub that ignored `DL_LINE` would leave an empty path either way.
  check("the line op was stroked", s.el.ctx.strokes, 1);
  check("the line's path did not widen the clip", s.pixel(5, 5), pixelColor(WHITE));
  check("the clipped fill still landed", s.pixel(5, 60), pixelColor(ROW_C));
  check("the run inside the viewport was drawn", s.el.ctx.texts.map((t) => t.text), ["in"]);
  check("and not clipped away", s.el.ctx.texts[0].clipped, false);
  check("the renderer counted it as a run and not as an unknown op",
    [s.report().text, s.report().unknown], [1, 0]);
}

// ---- §6 the `no-clip` world, as arithmetic ---------------------------------------------------
//
// M17's first negative control, which `www/m17.html` turns from a query flag. It is asserted here
// because its CLAIM is a pixel one — "a scrolled row paints over the header" — and that is
// reachable under node. What is NOT reachable is the wiring: this file cannot tell whether the page
// calls `setSurfaceControls`.
{
  check("nothing is in force by default", surfaceControlsInForce(), { noFill: false, noClip: false });
  setSurfaceControls({ noClip: true });
  const s = surfaceOf();
  s.replay(FIRST);
  check("the row paints over the header", s.pixel(5, 5), pixelColor(ROW_C));
  // COUNTED AND NOT DROPPED: the op reached the renderer, so a clause asserting it arrived must
  // still hold under the control (`CLAUDE.md`: a control moves a NAMED subset of expectations).
  check("while the clip op is still counted as having arrived", s.report().clips, 1);
  setSurfaceControls({});
  check("and the control is off again", surfaceControlsInForce(), { noFill: false, noClip: false });
  const clean = surfaceOf();
  clean.replay(FIRST);
  check("so the header survives again", clean.pixel(5, 5), pixelColor(HEADER_C));
}

// ---- the wheel's coalescing arithmetic ------------------------------------------------------
//
// `docs/PLAN-SHELL.md` M17 §"If the assumption is wrong" puts this here: if CDP's wheel does not
// reach a `wheel` listener, the Chrome suite asserts the arithmetic under node and declares the
// delivery clause unmeasurable. It is the kernel's bookkeeping over integers either way, so it
// costs milliseconds and it is the only place the 300-notch stream is checked without a browser.
//
// THE FAKE KERNEL IS NOT GENTLER THAN THE REAL ONE: `reply` bumps `slot.seq` — what makes a record
// stale — and `pollWake` is counted, because a merge must NOT wake a reader (a ring that already
// held a record had nobody parked on it).

let nextPid = 1;
const makeSlot = () => ({ pid: nextPid++, ctl: {}, seq: 1, bytes: new Uint8Array(MAX_INLINE) });
let wakes = 0;
installWindowKernel({
  reply: (slot) => { slot.seq += 1; },
  post: () => {},
  now: () => 1000,
  pollWake: () => { wakes += 1; },
});

/** Drain every queued record and decode it. The buffer holds a full ring, so one read empties it. */
const drain = (w) => {
  const into = new Uint8Array(WEV_BYTES * WIN_EVENT_CAP);
  const n = w.readEvents(makeSlot(), 1, into, 0, into.length);
  return n > 0 ? decodeWinEvents(into, n) : [];
};

const NOTCH = 3;
const STREAM = 300;
const wheel = (extra = {}) => ({
  type: WEV_WHEEL, mods: 0, a: 0, b: NOTCH, c: packWheelPoint(10, 20), ...extra,
});

// ---- §7 a 300-notch stream into a program that is not draining ------------------------------
{
  setWheelCoalesce(true);
  const mgr = new WinMgr();
  const w = mgr.create(1, {});
  wakes = 0;
  let taken = 0;
  for (let i = 0; i < STREAM; i += 1) if (mgr.feed(w.id, wheel())) taken += 1;
  const r = w.report();
  check("every notch was accepted", taken, STREAM);
  check("one record was queued", r.queued, 1);
  check("and the rest were merged into it", r.coalesced, STREAM - 1);
  check("nothing was dropped, so the ring never lapped", r.dropped, 0);
  check("one record is pending", r.pending, 1);
  // ONE WAKE AND NOT 300: a merge enters no new record, so no reader can have been parked on it.
  check("only the first notch woke a parked poll", wakes, 1);
  const evs = drain(w);
  check("the reader gets one event", evs.length, 1);
  const got = wheelAt(evs[0]);
  // THE FULL SUMMED DELTA. A program must read a coalesced record as a SUM: scrolling by one
  // notch's worth per record is how 300 notches become 1 and the list stops following the hand.
  check("carrying the whole gesture's delta", got.dy, NOTCH * STREAM);
  check("and the newest aim point", [got.x, got.y], [10, 20]);
  checkThat("flagged as a sum, which is how a program knows the kernel merged",
    (evs[0].mods & WWHEEL_COALESCED) !== 0, evs[0].mods);
}

// ---- §8 ...and the `no-wheel-coalesce` world, where the ring laps ----------------------------
{
  setWheelCoalesce(false);
  const mgr = new WinMgr();
  const w = mgr.create(1, {});
  for (let i = 0; i < STREAM; i += 1) mgr.feed(w.id, wheel());
  const r = w.report();
  check("every notch is its own record", r.queued, STREAM);
  check("nothing was merged", r.coalesced, 0);
  // THE NEWEST ARE THE ONES LOST (`Window.push`), which is why the list moves the wrong way on a
  // direction change rather than merely lagging.
  check("and the ring lapped by the overflow", r.dropped, STREAM - WIN_EVENT_CAP);
  const evs = drain(w);
  check("the reader gets a full ring", evs.length, WIN_EVENT_CAP);
  const total = evs.reduce((sum, e) => sum + wheelAt(e).dy, 0);
  checkThat("and the summed delta falls SHORT of the gesture", total < NOTCH * STREAM,
    { total, whole: NOTCH * STREAM });
  check("by exactly the most recent motion", NOTCH * STREAM - total,
    NOTCH * (STREAM - WIN_EVENT_CAP));
  setWheelCoalesce(true);
}

// ---- §9 what must NOT merge -----------------------------------------------------------------
//
// `mods` is the unit and the meaning of the gesture: `WWHEEL_PAGE` changes the deltas' unit and a
// modifier changes what the gesture IS (a ctrl-wheel is a zoom), so a sum across either is a total
// in no unit the reader produced.
{
  const mgr = new WinMgr();
  const w = mgr.create(1, {});
  mgr.feed(w.id, wheel());
  mgr.feed(w.id, wheel({ mods: WWHEEL_PAGE }));
  mgr.feed(w.id, wheel({ mods: WMOD_CTRL }));
  check("three unlike notches are three records", w.report().queued, 3);
  check("and nothing merged", w.report().coalesced, 0);
  const evs = drain(w);
  check("each keeps its own mods", evs.map((e) => e.mods), [0, WWHEEL_PAGE, WMOD_CTRL]);
  // A LIKE RECORD MERGES INTO THE TAIL AND ONLY THE TAIL, so a wheel behind another event type is
  // a fresh record: the queue is a sequence and reordering it would reorder the gesture.
  const q = mgr.create(1, {});
  mgr.feed(q.id, wheel());
  mgr.feed(q.id, { type: WEV_KEY, mods: 0, a: 0, b: 0, c: 0 });
  mgr.feed(q.id, wheel());
  check("a wheel behind another event is not merged through it", q.report().coalesced, 0);
  check("so three records are queued in order", q.report().queued, 3);
  check("and the order is the one the page posted",
    drain(q).map((e) => e.type), [WEV_WHEEL, WEV_KEY, WEV_WHEEL]);
}

// ---- §10 the forged coalesced bit is masked off the page's route ------------------------------
{
  const mgr = new WinMgr();
  const w = mgr.create(1, {});
  check("a wheel claiming to be a sum is still accepted",
    mgr.feed(w.id, wheel({ mods: WWHEEL_COALESCED })), true);
  const evs = drain(w);
  // THE BIT IS A FACT ABOUT THE KERNEL and the page must not be able to assert it: a program told
  // twenty notches arrived as one would scroll by one notch's delta.
  check("but the bit is masked, so only the kernel can set it", evs[0].mods & WWHEEL_COALESCED, 0);
}

const failed = results.filter((r) => !r.ok);
/* THE VERDICT GOES FIRST and the JSON last, because a `controls.py` reads from the first `{` to
   the end of stdout (`bench/m8-surface/controls.py:124-128`) — a line after the report would be
   parsed as part of it. */
console.log(failed.length
  ? `FAIL  ${failed.length}/${results.length} clauses: ${failed.map((r) => r.name).join("; ")}`
  : `PASS  ${results.length} clauses: the clip resets at every batch boundary, and removing the `
    + "reset flips that clause (see the pinned-context section above)");
console.log(JSON.stringify({
  ok: failed.length === 0, total: results.length, failed: failed.length, failures: failed,
}, null, 2));
process.exit(failed.length ? 1 : 0);
