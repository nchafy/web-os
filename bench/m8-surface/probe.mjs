// M8's surface accounting and its display-list codec, under plain Node.
//
// What this CAN cover: the budget — what it grants, what it refuses, by which errno, and what it
// gives back — and the record a display list is made of. All of it is the kernel's bookkeeping
// over integers, so the fast loop costs milliseconds.
//
// What it CANNOT cover is a pixel. A surface's canvas lives in the page, so `src/wm/surface.mjs`
// needs a DOM and `www/m8.html` drives it: the pattern proof reads pixels back out of the canvas
// the browser painted, which is the only thing that can tell an inert canvas from a working one
// (constraint 40).
//
// THE FAKE KERNEL IS NOT GENTLER THAN THE REAL ONE (constraint 98): `post` is recorded, so a
// surface that was granted without telling the page would show up as a missing message rather
// than as a pass.
import {
  Window, WinMgr, installWindowKernel,
} from "../../src/kernel/wins.mjs";
import {
  EINVAL, ENOMEM, EHOSTGONE, MAX_INLINE, SURFACE_BUDGET_PX, SURFACE_MAX_PX,
  DLOP_BYTES, DL_MAX_OPS, DL_CLEAR, DL_FILL_RECT, DL_LINE, DL_RESERVED,
  encodeDrawOp, decodeDrawOps, cssColor, pixelColor, unpackColor,
} from "../../src/abi.mjs";

const results = [];
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  results.push({ name: n, ok, got: ok ? undefined : g, want: ok ? undefined : w });
};
const checkThat = (n, c, d) => results.push({ name: n, ok: !!c, detail: c ? undefined : d });

const posts = [];
let clock = 1000;
installWindowKernel({
  reply: () => {},
  post: (m) => { posts.push(m); },
  now: () => clock,
  pollWake: () => {},
});
const reset = () => { posts.length = 0; };
const postsOf = (t) => posts.filter((m) => m.t === t);

/** A window-sized surface: a maximized window at dpr 2 is 3.69 M device px (constraint 49), so
 *  this is about one of those — the unit the budget is meant to count. */
const W = 1920;
const H = 1920;
const ONE = W * H;

// ---- a surface is granted, posted, and accounted ------------------------------------------
{
  const mgr = new WinMgr();
  reset();
  const w = mgr.create(1, { title: "a" });
  check("a fresh window has no surface", w.surface, null);
  check("granting one answers 0", mgr.surface(w, 320, 200), 0);
  check("and records it on the window", w.surface, { w: 320, h: 200 });
  check("and tells the page, which owns the canvas", postsOf("win-surface").length, 1);
  check("with the size the process asked for",
    [postsOf("win-surface")[0].w, postsOf("win-surface")[0].h], [320, 200]);
  check("and charges it to the budget", mgr.report().surfacePx, 320 * 200);
  check("counting one surface", mgr.report().surfaces, 1);
  // A WINDOW'S OWN REPORT CARRIES IT, because `/proc/<pid>/win/<winid>` is where a reader looks.
  check("the window's report publishes the surface", w.report().surface, { w: 320, h: 200 });
}

// ---- a resize replaces rather than adds ----------------------------------------------------
//
// THE DEFECT THIS EXISTS FOR: charging the new area without releasing the old one would exhaust a
// budget a program never exceeded — fifty resizes of one window and the system is full.
{
  const mgr = new WinMgr();
  const w = mgr.create(1, {});
  mgr.surface(w, 400, 400);
  check("a first surface is charged once", mgr.report().surfacePx, 160000);
  check("a resize is granted", mgr.surface(w, 800, 800), 0);
  check("and charges the difference, not the sum", mgr.report().surfacePx, 640000);
  check("and the window still counts as ONE surface", mgr.report().surfaces, 1);
  check("a smaller one is granted", mgr.surface(w, 100, 100), 0);
  // THE AREA IS THIS CLAUSE'S SUBJECT and the return value is the one above: they are different
  // facts, and naming the first after the second is how `bench/m8-surface/controls.py` came to
  // declare a mutation against a clause the mutation does not touch.
  check("and the budget shrinks to the smaller area", mgr.report().surfacePx, 10000);
}

// ---- what is refused, and by which errno ---------------------------------------------------
{
  const mgr = new WinMgr();
  const w = mgr.create(1, {});
  check("a zero width is EINVAL", mgr.surface(w, 0, 100), -EINVAL);
  check("a negative height is EINVAL", mgr.surface(w, 100, -1), -EINVAL);
  // EINVAL AND NOT ENOMEM: it is not that the system is full, it is that no surface may be that
  // big. The two answers tell a program whether to ask for less or to give up.
  checkThat("the per-surface cap is below the whole budget",
    SURFACE_MAX_PX < SURFACE_BUDGET_PX, { SURFACE_MAX_PX, SURFACE_BUDGET_PX });
  check("a surface past the per-surface cap is EINVAL", mgr.surface(w, 8192, 8192), -EINVAL);
  check("and nothing was charged for it", mgr.report().surfacePx, 0);
  check("and the refusal is counted", mgr.report().refusedSurface, 3);
}

// ---- the budget is a ceiling, and it says so -----------------------------------------------
{
  const mgr = new WinMgr();
  const wins = [];
  let granted = 0;
  let refusal = 0;
  for (let i = 0; i < 64; i += 1) {
    const w = mgr.create(1, {});
    wins.push(w);
    const r = mgr.surface(w, W, H);
    if (r === 0) { granted += 1; continue; }
    refusal = r;
    break;
  }
  // ENOMEM AND NOT EAGAIN. A caller told to try again would try for ever: the budget is a
  // ceiling, not a transient.
  check("the budget refuses with -ENOMEM", refusal, -ENOMEM);
  check("after granting what fits", granted, Math.floor(SURFACE_BUDGET_PX / ONE));
  checkThat("and the outstanding area is under the budget",
    mgr.report().surfacePx <= SURFACE_BUDGET_PX,
    { surfacePx: mgr.report().surfacePx, budget: SURFACE_BUDGET_PX });
  // REVOCATION IS THE OTHER HALF OF ACCOUNTING, and it is the half a transferred canvas could not
  // have had (constraint 219): destroying the windows must give the area back.
  for (const w of wins) mgr.destroyTree(w.id);
  check("destroying them all releases every pixel", mgr.report().surfacePx, 0);
  check("and the surface count returns to zero", mgr.report().surfaces, 0);
  const fresh = mgr.create(1, {});
  check("so the same size is granted again", mgr.surface(fresh, W, H), 0);
}

// ---- drawing: refused when there is nothing to draw on --------------------------------------
{
  const mgr = new WinMgr();
  const w = mgr.create(1, {});
  reset();
  const ops = new Uint8Array(DLOP_BYTES);
  // -EINVAL and not -ENOSYS: the call exists and the window has no surface, which is a state a
  // program can fix by asking for one.
  check("a draw on a window with no surface is EINVAL", mgr.draw(w, ops), -EINVAL);
  check("and nothing was posted", postsOf("win-draw").length, 0);
  check("and the refusal is counted on the window", w.report().refusedDraws, 1);
  mgr.surface(w, 64, 64);
  reset();
  check("with a surface it is accepted", mgr.draw(w, ops), 0);
  check("and the batch reaches the page", postsOf("win-draw").length, 1);
  check("charged to the window", w.report().batches, 1);
  check("by op count and not byte count", w.report().ops, 1);
  check("and to the table", mgr.report().ops, 1);
  // A COPY, NOT THE CALLER'S BUFFER: the source is the caller's SAB, which it may overwrite the
  // instant its call is answered.
  const src = new Uint8Array(DLOP_BYTES);
  src[0] = DL_CLEAR;
  reset();
  mgr.draw(w, src);
  src[0] = 99;
  check("the posted bytes are a copy of the caller's region", postsOf("win-draw")[0].ops[0],
    DL_CLEAR);
  // A DESTROYED WINDOW REFUSES, because the page has no canvas for it any more.
  mgr.destroyTree(w.id);
  // THE ERRNO AND NOT "SOMETHING NEGATIVE": after `destroyTree` the surface is nulled too, so
  // the next guard's -EINVAL would satisfy a `< 0` clause and the two refusals mean different
  // things (`CLAUDE.md`: assert each refusal's errno separately).
  check("a draw on a destroyed window is -EHOSTGONE", mgr.draw(w, ops), -EHOSTGONE);
}

// ---- a surfaced window refuses cells -------------------------------------------------------
//
// ONE CONTENT MODE PER WINDOW. The page replaces the text widget with a canvas, so cells have
// nowhere to go — and accepting bytes nobody renders is the silent loss a user cannot diagnose.
{
  const mgr = new WinMgr();
  const w = mgr.create(1, {});
  reset();
  check("a text window accepts cells", w.writeCells(new Uint8Array([65, 66])), 2);
  mgr.surface(w, 64, 64);
  check("a surfaced window refuses them", w.writeCells(new Uint8Array([65])), -EINVAL);
  check("and the refusal is counted apart from a dead frame's", w.report().refusedCells, 1);
  check("while the dead-frame counter stays at zero", w.report().goneWrites, 0);
  check("while a draw still works", mgr.draw(w, new Uint8Array(DLOP_BYTES)), 0);
}

// ---- the record, and the one colour renderer -------------------------------------------------
{
  const bytes = new Uint8Array(DLOP_BYTES * 3);
  const dv = new DataView(bytes.buffer);
  encodeDrawOp(dv, 0, { op: DL_CLEAR, a0: 0x0b0d11ff });
  encodeDrawOp(dv, DLOP_BYTES, { op: DL_FILL_RECT, a0: 8, a1: 8, a2: 4, a3: 4, a4: 0x4a9bd8ff });
  encodeDrawOp(dv, DLOP_BYTES * 2,
    { op: DL_LINE, a0: -3, a1: 0, a2: 60, a3: 9, a4: 0xd84a7aff, a5: 3 });
  const ops = decodeDrawOps(bytes);
  check("a batch decodes to its ops", ops.map((o) => o.op), [DL_CLEAR, DL_FILL_RECT, DL_LINE]);
  check("with their arguments", [ops[1].a0, ops[1].a2, ops[2].a0, ops[2].a5], [8, 4, -3, 3]);
  check("the colour slot is unsigned", ops[2].a4, 0xd84a7aff);
  check("and every reserved word is zero", dv.getUint32(DL_RESERVED, true), 0);
  // A TORN LENGTH IS A FAULT AND NOT A DROPPED TAIL, the same rule the window event record uses:
  // a program handed half an op must fail loudly.
  let threw = "";
  try {
    decodeDrawOps(bytes, DLOP_BYTES + 7);
  } catch (error) {
    threw = String(error.message);
  }
  checkThat("a torn batch throws rather than dropping its tail",
    threw.includes("not a whole number of ops"), threw);
  // ONE COLOUR, TWO RENDERINGS, AND THEY MUST DIFFER ONLY IN THE ALPHA. A check that rendered it
  // itself reported four correct pixels as four failures.
  check("cssColor is for a canvas", cssColor(0x4a9bd8ff), "rgba(74,155,216,1)");
  check("pixelColor is for a pixel read back", pixelColor(0x4a9bd8ff), "rgba(74,155,216,255)");
  check("and both unpack the same bytes", unpackColor(0x4a9bd8ff),
    { r: 74, g: 155, b: 216, a: 255 });
  // The batch size is DERIVED from the frame, never written twice.
  check("a batch holds as many ops as the frame does", DL_MAX_OPS,
    Math.floor(MAX_INLINE / DLOP_BYTES));
  checkThat("which is enough for a frame of drawing", DL_MAX_OPS > 2000, DL_MAX_OPS);
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  ok: failed.length === 0, total: results.length, failed: failed.length, failures: failed,
}, null, 2));
process.exit(failed.length ? 1 : 0);
