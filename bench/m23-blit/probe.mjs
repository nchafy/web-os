// M23's `DL_BLIT`: the op, the kernel's five refusals, and the renderer's drawing call, under
// plain Node.
//
// WHY THIS EXISTS SEPARATELY FROM `program.mjs`. That file answers whether a PROCESS can decode a
// PNG at all; this one answers what happens to the bitmap afterwards. Neither needs the other and
// both precede M23's code, as `bench/m16-resize/probe.py` did for M16.
//
// THE THREE SIDES OF ONE OP, which is why they are in one file: `src/abi.mjs` says what a blit IS,
// `src/kernel/calls.mjs` says which blits are refused and with which errno, and
// `src/wm/surface.mjs` says what a blit DRAWS. A probe over any one of them would pass while
// another side disagreed about the fd slot.
//
// THE DOUBLES ARE NOT GENTLER THAN THE THINGS THEY STAND FOR (constraint 98):
//   - the DataMgr is the REAL one, so the format errnos are the real ones. A fake `fetch` would
//     have let this file invent ENOTSUP/ENOENT and agree with itself.
//   - the syscall table is the REAL one, built through `buildCalls`, so `win_draw`'s region bound,
//     op count and text/clip validation all still run around the blit path.
//   - the canvas stub RASTERISES, so §1's pixels are read back out of a buffer a `drawImage`
//     actually wrote, and it RECORDS its calls, so §1 can assert the surface never saw a
//     `putImageData` — which is the whole reason `#stage` exists.
//
// WHAT THIS CANNOT COVER is whether a real `putImageData` would have escaped a real clip. That is
// a property of the platform, cited at `#stage` and owed to a browser — `www/m23.html`'s own
// proof, when M23 lands one.
//
// THE MUTATIONS, each run against a copy of `src/` and each moving a NAMED subset (`CLAUDE.md`: a
// control satisfied by any failure verifies nothing). The right-hand side is what each run
// ACTUALLY reported, not what it was expected to:
//
//   1. `src/abi.mjs`  `blitFdOf` returns `op.a2 >>> 0`
//        -> `src/abi.mjs` REFUSES TO LOAD: "abi.mjs selfTest: a blit's fd came back unsigned".
//           `selfTest()` runs at module evaluation, so a mutation to either half of the codec pair
//           never reaches this probe's clauses at all. §0 repeats the assertion anyway, because
//           every clause below reads the fd through `blitFdOf`.
//   2. `src/abi.mjs`  `encodeBlit` writes the fd into a3
//        -> the same, with "blitFdOf gave 0 for fd 7".
//   3. `src/kernel/calls.mjs`  `-EBADMSG` becomes `-EINVAL`
//        -> 4 clauses: §1's short-payload and five-distinct clauses, §4's refused-whole, §7's
//           control-is-off. Every clause about a fd or a format stays green.
//   4. `src/kernel/calls.mjs`  the `blits.has(fd)` line removed
//        -> 1 clause: §6's "resolved once, not three times", alone.
//   5. `src/kernel/dataobj.mjs`  `set` writes in place when the length matches
//        -> 1 clause: §3's "the forwarded bytes did not follow a later rewrite", alone.
//   6. `src/wm/surface.mjs`  `drawImage` is given the scratch's extent instead of the bitmap's
//        -> 2 clauses: §12's source rect and its stale-scratch pixel.
//   7. `src/wm/surface.mjs`  the blit becomes a `putImageData` onto the surface
//        -> 8 clauses: every clause that reads a drawn PIXEL or a source rect — §9's three pixels,
//           its drawImage/putImageData clause and its source rect, §12's source rect, and §13's
//           two. The kernel's §1-§8 and the unbacked §10-§11 stay green, which is what makes this
//           a control about the drawing call and not about the op.
import {
  A0, A1, LEN_I32, DATA_OFF, SAB_BYTES, SYS_win_draw,
  DLOP_BYTES, DL_CLEAR, DL_CLIP, DL_BLIT, F_WIN, F_DATA, F_FILE, O_RDWR,
  DOBJ_BITMAP, DOBJ_TEXT, DOBJ_PNG, DOBJ_FMT_ALL, DOBJ_MAX_BYTES, DOBJ_BUDGET_BYTES, DOBJ_CAP,
  BITMAP_HEADER,
  fmtBit, encodeDrawOp, decodeDrawOp, encodeBlit, blitFdOf, encodeBitmap, errName,
} from "../../src/abi.mjs";

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ name, ok, got: ok ? undefined : got, want: ok ? undefined : want });
};
const errOf = (r) => (r < 0 ? errName(-r) : r);

/* A 2x2 bitmap, ASYMMETRIC IN BOTH AXES: red, green over blue, grey. A square of one colour would
   let a transposed, mirrored or offset blit pass. */
const PX = new Uint8Array([
  255, 0, 0, 255, 0, 255, 0, 255,
  0, 0, 255, 255, 9, 9, 9, 255,
]);
const BMP = encodeBitmap(2, 2, PX);

/* ---- §0 the op, through the wire -------------------------------------------------------------
   `src/abi.mjs`'s selfTest asserts this too. It is repeated here because every clause below reads
   the fd through `blitFdOf`, so a probe that did not first establish the slot would be asserting
   against its own misreading. */
{
  const dv = new DataView(new ArrayBuffer(DLOP_BYTES));
  encodeDrawOp(dv, 0, encodeBlit(7, -3, -120));
  const back = decodeDrawOp(dv, 0);
  check("a blit survives the wire as a blit", back.op, DL_BLIT);
  check("its fd is in the slot blitFdOf reads", blitFdOf(back), 7);
  /* SURFACE PX, AND SIGNED. A thumbnail in a list scrolled down has a negative y, and an unsigned
     read would put it 4 billion px below the surface — drawn nowhere, with no error anywhere. */
  check("its destination is a signed surface-px pair", [back.a0, back.a1], [-3, -120]);
  encodeDrawOp(dv, 0, encodeBlit(-1, 0, 0));
  check("a negative fd stays negative, so the kernel can answer EBADF",
    blitFdOf(decodeDrawOp(dv, 0)), -1);
}

/* ---- the kernel, with the real syscall table and the real DataMgr --------------------------- */

const { buildCalls, setBlitValidated } = await import("../../src/kernel/calls.mjs");
const { DataMgr, installDataKernel } = await import("../../src/kernel/dataobj.mjs");

installDataKernel({ reply: () => {}, post: () => {}, now: () => 1000, pollWake: () => {} });
const data = new DataMgr();

/** What `WinMgr.draw` was handed. The window manager is the one part stubbed, because what is
 *  being asserted is the ARGUMENTS it receives — a real one would post them onward and this file
 *  has no page to receive them. */
let captured = null;
const table = buildCalls({
  wins: { draw: (win, region, blits) => { captured = { region, blits }; return 0; } },
  data,
});
const call = table[SYS_win_draw];

const sab = new ArrayBuffer(SAB_BYTES);
const ctl = new Int32Array(sab);
const FDS = new Map();
const p = { pid: 7, ctl, bytes: new Uint8Array(sab), fds: { get: (fd) => FDS.get(fd | 0) || null } };
const WINFD = 3;
FDS.set(WINFD, {
  kind: F_WIN, refs: 1, win: { destroyed: false, attached: true, surface: { w: 64, h: 64 } },
});

/** Seat a data object at `fd`, offering `offer`, with `payload` written as `format`. */
function seat(fd, offer, format, payload) {
  const obj = data.create(p.pid, offer);
  if (typeof obj === "number") throw new Error(`create: ${errName(-obj)}`);
  if (payload) {
    const r = data.set(obj, format, payload, 0);
    if (r < 0) throw new Error(`set: ${errName(-r)}`);
  }
  FDS.set(fd, { kind: F_DATA, refs: 1, flags: O_RDWR, obj, inflight: 0 });
  return obj;
}

seat(10, DOBJ_FMT_ALL, DOBJ_BITMAP, BMP);                        // a whole bitmap
seat(11, DOBJ_FMT_ALL, DOBJ_BITMAP, BMP.subarray(0, 9));         // a payload one byte past its header
seat(12, DOBJ_FMT_ALL, null, null);                              // bitmap offered, never written
seat(13, fmtBit(DOBJ_TEXT) | fmtBit(DOBJ_PNG), DOBJ_TEXT, new Uint8Array([65]));  // no bitmap offered
FDS.set(14, { kind: F_FILE, refs: 1 });                          // an fd that is not a data object

/** Put a batch in the byte region and make the real `win_draw` call. */
function draw(ops) {
  captured = null;
  const dv = new DataView(sab, DATA_OFF);
  ops.forEach((op, i) => encodeDrawOp(dv, i * DLOP_BYTES, op));
  ctl[A0] = WINFD;
  ctl[A1] = ops.length;
  ctl[LEN_I32] = ops.length * DLOP_BYTES;
  return call(p);
}

/* ---- §1 EVERY REFUSAL ITS OWN ERRNO ----------------------------------------------------------
   One "it refused" would pass for all five, and the five have five different fixes: a wrong fd is
   a program bug, an unoffered format is a protocol bug, an unwritten one is a race, and corrupt
   bytes are a decoder bug. M3's `truncate` answering ENOENT where it owed EROFS is the precedent. */
check("a blit on no fd at all", errOf(draw([encodeBlit(99, 0, 0)])), "EBADF");
check("a blit on a negative fd", errOf(draw([encodeBlit(-1, 0, 0)])), "EBADF");
check("a blit on a FILE fd", errOf(draw([encodeBlit(14, 0, 0)])), "EINVAL");
check("a blit on an object offering no bitmap", errOf(draw([encodeBlit(13, 0, 0)])), "ENOTSUP");
check("a blit on a bitmap offered and never written", errOf(draw([encodeBlit(12, 0, 0)])), "ENOENT");
check("a blit on a short payload", errOf(draw([encodeBlit(11, 0, 0)])), "EBADMSG");
check("and the five are five distinct errnos", new Set([
  draw([encodeBlit(99, 0, 0)]), draw([encodeBlit(14, 0, 0)]), draw([encodeBlit(13, 0, 0)]),
  draw([encodeBlit(12, 0, 0)]), draw([encodeBlit(11, 0, 0)]),
]).size, 5);

/* ---- §2 a whole bitmap is accepted and its payload reaches the renderer, keyed by fd --------- */
{
  check("a well-formed blit is accepted", draw([{ op: DL_CLEAR, a0: 0xff }, encodeBlit(10, 5, 3)]), 0);
  check("the payload map carries that fd and nothing else", [...captured.blits.keys()], [10]);
  check("and it carries the whole payload", captured.blits.get(10).length, BMP.length);
}

/* ---- §3 the invariant the no-copy forward rests on -------------------------------------------
   `src/kernel/calls.mjs` hands the renderer a VIEW of the payload rather than a copy, because
   `DataMgr.set` allocates a fresh array and replaces the map entry. If `set` ever came to write in
   place, a program could change a bitmap the page had already been promised. This is that clause. */
{
  draw([encodeBlit(10, 0, 0)]);
  const forwarded = captured.blits.get(10);
  const obj = FDS.get(10).obj;
  /* THE SAME LENGTH, which is the only case an in-place `set` could take: a different length has
     to reallocate whatever the implementation does, so a longer probe would pass for free. */
  const rewritten = encodeBitmap(2, 2, new Uint8Array(16).fill(7));
  check("the rewrite is the same length as the original", rewritten.length, BMP.length);
  data.set(obj, DOBJ_BITMAP, rewritten, 0);
  check("the forwarded bytes did not follow a later rewrite", forwarded[BITMAP_HEADER], 255);
  check("and the object really was rewritten",
    data.fetch(obj, DOBJ_BITMAP).bytes[BITMAP_HEADER], 7);
  data.set(obj, DOBJ_BITMAP, BMP, 0);
}

/* ---- §4 the whole batch is validated before anything is drawn -------------------------------- */
{
  check("a batch with one bad blit is refused whole",
    errOf(draw([encodeBlit(10, 0, 0), encodeBlit(11, 0, 0)])), "EBADMSG");
  check("and nothing reached the renderer", captured, null);
}

/* ---- §5 a batch with no blit allocates no map, and one fd is resolved once -------------------- */
{
  draw([{ op: DL_CLEAR, a0: 0xff }, { op: DL_CLIP, a0: 0, a1: 0, a2: 8, a3: 8 }]);
  check("no blit, no payload map", captured.blits, null);
}

/* ---- §6 one fd blitted three times is one map entry and ONE read ----------------------------- */
{
  const before = FDS.get(10).obj.stats.gets;
  draw([encodeBlit(10, 0, 0), encodeBlit(10, 9, 9), encodeBlit(10, 1, 1)]);
  check("the same fd three times is one map entry", [...captured.blits.keys()], [10]);
  /* A SPRITE DRAWN 2,000 TIMES IS NOT 2,000 READS. `DataMgr.fetch` charges each resolution to the
     object's `gets`, and a count that said 2,000 would be a count nobody could use. */
  check("and it is resolved once, not three times", FDS.get(10).obj.stats.gets - before, 1);
  seat(15, DOBJ_FMT_ALL, DOBJ_BITMAP, encodeBitmap(1, 1, new Uint8Array(4)));
  draw([encodeBlit(10, 0, 0), encodeBlit(15, 9, 9)]);
  check("two fds are two entries", [...captured.blits.keys()].sort((a, b) => a - b), [10, 15]);
}

/* ---- §7 the `blit-unvalidated` control, scoped to the BYTES ---------------------------------- */
setBlitValidated(false);
check("control: the short payload is forwarded instead of refused",
  errOf(draw([encodeBlit(11, 0, 0)])), 0);
check("control: and the corrupt bytes reached the renderer", captured.blits.get(11).length, 9);
check("control: EBADF is unmoved", errOf(draw([encodeBlit(99, 0, 0)])), "EBADF");
check("control: EINVAL is unmoved", errOf(draw([encodeBlit(14, 0, 0)])), "EINVAL");
check("control: ENOTSUP is unmoved", errOf(draw([encodeBlit(13, 0, 0)])), "ENOTSUP");
check("control: ENOENT is unmoved", errOf(draw([encodeBlit(12, 0, 0)])), "ENOENT");
check("control: a well-formed blit still draws", errOf(draw([encodeBlit(10, 0, 0)])), 0);
setBlitValidated(true);
check("and the control is off again", errOf(draw([encodeBlit(11, 0, 0)])), "EBADMSG");

/* ---- §8 THE CEILING, derived and not asserted as a figure ------------------------------------
   The payload map is the one thing on this path NOT bounded by `MAX_INLINE`, so what bounds it is
   worth stating. Two ceilings, and the SYSTEM-WIDE one is the tighter: a process may hold
   `DOBJ_CAP` objects of `DOBJ_MAX_BYTES` each, which is 32 MiB of arithmetic, but every live
   payload together is capped at `DOBJ_BUDGET_BYTES` — 8 MiB — so that is the most a single
   `win_draw`'s map can carry however many blits it names (constraint 246). */
check("the per-process arithmetic", DOBJ_CAP * DOBJ_MAX_BYTES, 32 * 1024 * 1024);
check("but the live-payload budget is four times tighter, and it is the real bound",
  DOBJ_BUDGET_BYTES < DOBJ_CAP * DOBJ_MAX_BYTES, true);

/* ---- the renderer --------------------------------------------------------------------------- */

/** A 2D context that RASTERISES and records its calls. `drawImage` is honoured; `putImageData`
 *  stages and is recorded but does NOT reach the pixel buffer — which is not a shortcut, it is the
 *  only shape in which §9's "never putImageData on the surface" clause can fail. */
class Ctx {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 4);
    this.calls = [];
    this.fillStyle = "";
  }

  save() {}

  restore() {}

  beginPath() {}

  rect() {}

  clip() {}

  fillRect(x, y, w, h) {
    const n = /rgba?\(([^)]*)\)/.exec(String(this.fillStyle))[1].split(",").map(Number);
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j += 1) {
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i += 1) {
        const o = (j * this.w + i) * 4;
        this.px[o] = n[0]; this.px[o + 1] = n[1]; this.px[o + 2] = n[2];
        this.px[o + 3] = Math.round((n[3] === undefined ? 1 : n[3]) * 255);
      }
    }
  }

  createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }

  putImageData(img, dx, dy) {
    this.calls.push("putImageData");
    this.staged = { img, dx, dy };
  }

  drawImage(src, sx, sy, sw, sh, dx, dy) {
    this.calls.push("drawImage");
    this.lastDraw = { sx, sy, sw, sh, dx, dy };
    const img = src.ctx.staged.img;
    for (let j = 0; j < sh; j += 1) {
      for (let i = 0; i < sw; i += 1) {
        const tx = dx + i;
        const ty = dy + j;
        if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) continue;
        const s = ((sy + j) * img.width + (sx + i)) * 4;
        const o = (ty * this.w + tx) * 4;
        this.px[o] = img.data[s]; this.px[o + 1] = img.data[s + 1];
        this.px[o + 2] = img.data[s + 2]; this.px[o + 3] = img.data[s + 3];
      }
    }
  }

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

const PARENT = { append() {}, clientWidth: 0, clientHeight: 0 };
globalThis.document = {
  createElement() {
    const el = {
      style: {}, className: "", tabIndex: 0, width: 1, height: 1, parentElement: PARENT,
      setAttribute() {}, remove() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: el.width, height: el.height }),
      getContext() { el.ctx = new Ctx(el.width, el.height); return el.ctx; },
    };
    return el;
  },
};
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h; }

  getContext() { this.ctx = new Ctx(this.width, this.height); return this.ctx; }
};

const { Surface } = await import("../../src/wm/surface.mjs");

const SW = 40;
const SH = 20;
const batch = (ops) => {
  const bytes = new Uint8Array(ops.length * DLOP_BYTES);
  const dv = new DataView(bytes.buffer);
  ops.forEach((op, i) => encodeDrawOp(dv, i * DLOP_BYTES, op));
  return bytes;
};
const surfaceOf = () => new Surface({ w: SW, h: SH, into: PARENT, label: "probe" });
const BLACK = 0x000000ff;

/* ---- §9 a blit with its payload draws the bitmap, at the destination, in surface px ----------- */
{
  const s = surfaceOf();
  s.replay(batch([{ op: DL_CLEAR, a0: BLACK }, encodeBlit(7, 5, 3)]), new Map([[7, BMP]]));
  check("one blit drawn, none unbacked, nothing unknown",
    [s.blits, s.blitsUnbacked, s.unknown], [1, 0, 0]);
  check("the bitmap's top-left landed at the destination", s.pixel(5, 3), "rgba(255,0,0,255)");
  check("its top-right one px to the right", s.pixel(6, 3), "rgba(0,255,0,255)");
  check("its bottom-left one px down", s.pixel(5, 4), "rgba(0,0,255,255)");
  check("and the pixel before the destination is untouched", s.pixel(4, 3), "rgba(0,0,0,255)");
  /* THE CLAUSE `#stage` EXISTS FOR. `putImageData` is defined to ignore the clipping region, so a
     thumbnail in a scrolled list would paint over the header `DL_CLIP` exists to protect — M17's
     defect through a second door. This file cannot rasterise a real clip; what it CAN assert is
     that the surface's own context never sees a `putImageData` at all. */
  check("the surface saw a drawImage and never a putImageData",
    [s.el.ctx.calls.includes("drawImage"), s.el.ctx.calls.includes("putImageData")], [true, false]);
  /* READ THROUGH A DEFAULT, so a world where `drawImage` was never called REPORTS rather than
     throwing a TypeError out of the probe. A harness that dies cannot say which clause moved. */
  const d9 = s.el.ctx.lastDraw || {};
  check("and the source rect is the bitmap's own extent", [d9.sx, d9.sy, d9.sw, d9.sh], [0, 0, 2, 2]);
}

/* ---- §10 a blit with no payload behind it draws nothing and SAYS SO --------------------------
   This is the shape of every way the payload side-channel can fail, and all of them look exactly
   like "the program drew nothing" in a screenshot. */
{
  const s = surfaceOf();
  s.replay(batch([{ op: DL_CLEAR, a0: BLACK }, encodeBlit(7, 5, 3)]));
  check("no map at all: unbacked, nothing drawn", [s.blits, s.blitsUnbacked], [0, 1]);
  check("the destination still shows the clear colour", s.pixel(5, 3), "rgba(0,0,0,255)");
  check("and drawImage was never reached", s.el.ctx.calls.includes("drawImage"), false);
  /* NOT `unknown`, which means an op this renderer does not know. A blit it does know and cannot
     honour is a different fact, and a reader has to be able to tell them apart. */
  check("it is not counted as an unknown op", s.unknown, 0);
}

/* ---- §11 a payload the kernel would have refused is unbacked, not blitted short --------------
   The `blit-unvalidated` world as the renderer sees it: the second line of the same argument. */
{
  const s = surfaceOf();
  s.replay(batch([encodeBlit(7, 0, 0)]), new Map([[7, BMP.subarray(0, BMP.length - 1)]]));
  check("a payload one byte short is unbacked", [s.blits, s.blitsUnbacked], [0, 1]);
}

/* ---- §12 the scratch is reused and never draws its stale tail -------------------------------- */
{
  const big = encodeBitmap(4, 4, new Uint8Array(4 * 4 * 4).fill(200));
  const s = surfaceOf();
  s.replay(batch([{ op: DL_CLEAR, a0: BLACK }, encodeBlit(1, 0, 0)]), new Map([[1, big]]));
  s.replay(batch([encodeBlit(2, 20, 0)]), new Map([[2, BMP]]));
  check("both blits drew", [s.blits, s.blitsUnbacked], [2, 0]);
  check("the small blit's source rect is 2x2 and not the 4x4 scratch",
    [(s.el.ctx.lastDraw || {}).sw, (s.el.ctx.lastDraw || {}).sh], [2, 2]);
  // The stale tail would read rgba(200,200,200,200) — the 4x4 fill still sitting in the scratch.
  check("so the px past the small bitmap shows no stale scratch", s.pixel(22, 0), "rgba(0,0,0,255)");
}

/* ---- §13 a negative destination, which is a list scrolled down ------------------------------- */
{
  const s = surfaceOf();
  s.replay(batch([{ op: DL_CLEAR, a0: BLACK }, encodeBlit(7, 0, -1)]), new Map([[7, BMP]]));
  check("a negative y still draws", [s.blits, s.blitsUnbacked], [1, 0]);
  check("it reached the renderer as -1 and not as 4294967295",
    (s.el.ctx.lastDraw || {}).dy, -1);
  check("so row 0 shows the bitmap's SECOND row", s.pixel(0, 0), "rgba(0,0,255,255)");
}

/* ---- §14 report() carries both counters, and an unknown op is still unknown ------------------- */
{
  const s = surfaceOf();
  s.replay(batch([encodeBlit(7, 0, 0), encodeBlit(9, 0, 0)]), new Map([[7, BMP]]));
  check("report names one drawn and one unbacked",
    [s.report().blits, s.report().blitsUnbacked], [1, 1]);
  const t = surfaceOf();
  t.replay(batch([{ op: 99, a0: 0 }, encodeBlit(7, 0, 0)]), new Map([[7, BMP]]));
  check("an op this renderer does not know is still the only unknown", [t.unknown, t.blits], [1, 1]);
}

const failed = results.filter((r) => !r.ok);
/* THE VERDICT GOES FIRST and the JSON last, because a controls script reads from the first `{` to
   the end of stdout (`bench/m8-surface/controls.py:124-128`). */
console.log(failed.length
  ? `FAIL  ${failed.length}/${results.length} clauses: ${failed.map((r) => r.name).join("; ")}`
  : `PASS  ${results.length} clauses: a blit names an fd, the kernel refuses five ways with five `
    + "errnos, and the renderer draws through drawImage (see the mutation list above)");
console.log(JSON.stringify({
  ok: failed.length === 0, total: results.length, failed: failed.length, failures: failed,
}, null, 2));
process.exit(failed.length ? 1 : 0);
