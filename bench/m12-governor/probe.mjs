// M12's governor, under node: the accounting, both edges of the hysteresis, and the degrade order.
//
//     node bench/m12-governor/probe.mjs
//
// WHY A HOST PROBE AT ALL, when `scripts/check.py --only m12` drives the real thing in a browser:
// the browser cannot reach the arithmetic. `BLUR_OFF_AT` is 413 windows of 640×440 away under the
// shipped ring geometry, and `WIN_CAP` is 32 per process — so the suite exercises the degrade
// branch through a LOWERED budget, which is the right thing for a check and the wrong thing for
// proving the real numbers. Here the manager is a plain object: 500 windows cost nothing, so the
// thresholds can be crossed at their real values, in both directions, and the order the governor
// degrades in can be read off a list.
//
// It is the same split `bench/m8-surface/probe.mjs` makes for the surface budget, and for the same
// reason M8's notes give: a budget whose refusal nothing has reached is a budget nobody believes.

import {
  Window, WinMgr, installWindowKernel,
} from "../../src/kernel/wins.mjs";
import {
  BLUR_OFF_AT, BLUR_ON_AT, WIN_CAP_H, WIN_INSET, blurRingArea, blurBoxArea,
} from "../../src/abi.mjs";

const posts = [];
installWindowKernel({
  reply: () => {},
  post: (m) => { posts.push(m); },
  now: () => 1000,
  pollWake: () => {},
});

const checks = [];
const ok = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  if (!pass) console.error("FAIL  %s  %s", name, JSON.stringify(detail));
};
const near = (a, b, slack = 1) => Math.abs(a - b) <= slack;

/** A manager with `n` windows of `w`×`h`, attached and stacked in creation order. */
function desktop(n, { w = 640, h = 440, budget = 0, dpr = 2 } = {}) {
  const mgr = new WinMgr();
  mgr.dprSq = dpr * dpr;
  mgr.blurBudgetPx = budget;
  for (let i = 0; i < n; i += 1) {
    const win = mgr.create(7, { title: `w${i}`, x: 0, y: 0, w, h });
    // `create` returns the Window; a refusal is a negative number and would break the sweep
    // silently, so it is asserted rather than assumed.
    if (typeof win === "number") throw new Error(`create ${i} refused ${win}`);
    win.attached = true;
  }
  /* `Window`'s constructor already sets `attached`, so `create`'s own `governBlur` saw the full
   * cost and the assignment above is a no-op kept for the reader. This extra run is here for a
   * different reason: it is the fixed point. `create` governs once per window as the desktop is
   * built, and asserting on the state after the LAST one is asserting on a partially-built
   * desktop's history; one more run makes every case below read a settled desktop. */
  mgr.governBlur("probe-setup");
  return mgr;
}

const flatOf = (mgr) => mgr.live().filter((w) => w.flat).map((w) => w.id);

/* ---- 1. the accounting, against the ABI's own formula ------------------------------------- */
{
  const mgr = desktop(1);
  const win = mgr.live()[0];
  const want = blurRingArea(640, 440) * 4;
  ok("one window costs its ring area in device px", mgr.blurCost(win) === want,
    { got: mgr.blurCost(win), want, ring: blurRingArea(640, 440) });
  ok("which is 27,260 CSS px^2, as the browser measured", blurRingArea(640, 440) === 27260,
    { got: blurRingArea(640, 440) });
  // THE COMPARISON D13 RESTS ON, asserted rather than quoted.
  const ratio = blurBoxArea(640, 440) / blurRingArea(640, 440);
  ok("and the ring is 10.33x cheaper than the same window as one node", near(ratio, 10.33, 0.01),
    { ratio: Number(ratio.toFixed(2)) });
  // A SURFACED WINDOW COSTS THE SAME, because the surface replaces an already-opaque client area.
  mgr.surface(win, 100, 100);
  ok("a surfaced window costs the same, because the ring is unchanged",
    mgr.blurCost(win) === want, { got: mgr.blurCost(win), want });
  // AND A DETACHED ONE COSTS NOTHING: a frame the page has not built filters no pixels.
  win.attached = false;
  ok("a window with no frame costs nothing", mgr.blurCost(win) === 0,
    { got: mgr.blurCost(win) });
}

/* ---- 2. the real threshold is unreachable, which is the milestone's finding --------------- */
{
  const per = blurRingArea(640, 440) * 4;
  const toWall = Math.ceil(BLUR_OFF_AT / per);
  ok("the real budget is 413 windows away under ring glass", toWall === 413,
    { windowsToBudget: toWall, perWindowDevicePx: per, budget: BLUR_OFF_AT });
  // The same desktop as ONE glass node per window, which is what the budget was sized against.
  const perBox = blurBoxArea(640, 440) * 4;
  ok("and 40 away as one glass node per window", Math.ceil(BLUR_OFF_AT / perBox) === 40,
    { windowsToBudget: Math.ceil(BLUR_OFF_AT / perBox), perWindowDevicePx: perBox });
  // So at any desktop a person could build, nothing is flat. ASSERTED, because it is the claim.
  const mgr = desktop(24);
  ok("so a 24-window desktop is entirely glass", flatOf(mgr).length === 0,
    { flat: flatOf(mgr), blurPx: mgr.stats.blurPx, budget: mgr.blurBudget() });
}

/* ---- 3. the degrade branch, at a lowered budget ------------------------------------------- */
{
  const per = blurRingArea(640, 440) * 4;
  // A budget that fits exactly four windows, so the fifth must cost one of them its glass.
  const mgr = desktop(6, { budget: per * 4 });
  const flat = flatOf(mgr);
  ok("over the budget, some windows go flat", flat.length > 0,
    { flat, blurPx: mgr.stats.blurPx, budget: mgr.blurBudget() });
  ok("and the total comes back under the budget", mgr.stats.blurPx <= mgr.blurBudget(),
    { blurPx: mgr.stats.blurPx, budget: mgr.blurBudget() });
  /* FROM THE BOTTOM OF THE STACK, which constraint 49 requires: the window the user is looking at
   * is on top and the cost is the same wherever it sits, so the cheapest thing to take is the
   * thing least likely to be seen. */
  const bottom = mgr.stack.slice(0, flat.length);
  ok("taken from the BOTTOM of the stack, in order",
    JSON.stringify(flat.slice().sort((a, b) => a - b))
      === JSON.stringify(bottom.slice().sort((a, b) => a - b)),
    { flat, bottomOfStack: bottom, stack: mgr.stack });
  // The governor announced it, once, with the arithmetic attached.
  const blurPosts = posts.filter((m) => m.t === "win-blur");
  ok("and the page was told, with the budget it was decided against",
    blurPosts.length > 0 && blurPosts[blurPosts.length - 1].budget === mgr.blurBudget(),
    { posts: blurPosts.length, last: blurPosts[blurPosts.length - 1] });
}

/* ---- 4. hysteresis: BOTH edges, which is what a single threshold cannot have -------------- */
{
  const per = blurRingArea(640, 440) * 4;
  const budget = per * 4;
  const mgr = desktop(6, { budget });
  const degraded = flatOf(mgr).length;
  ok("six windows at a four-window budget leaves some flat", degraded > 0, { flat: flatOf(mgr) });

  /* THE RESTORE EDGE IS LOWER THAN THE DEGRADE EDGE, and it has to be: with one threshold,
   * flattening a window lowers the total, which re-admits it, which raises the total again — an
   * oscillation for any desktop resting on the line. */
  ok("the restore edge is below the degrade edge", mgr.blurRestore() < mgr.blurBudget(),
    { restore: mgr.blurRestore(), budget: mgr.blurBudget() });
  ok("and it keeps the sourced 36:45 proportion",
    near(mgr.blurRestore() / mgr.blurBudget(), BLUR_ON_AT / BLUR_OFF_AT, 0.001),
    { got: mgr.blurRestore() / mgr.blurBudget(), want: BLUR_ON_AT / BLUR_OFF_AT });

  /* AND THE DESKTOP MUST NOT OSCILLATE. Re-running the governor with nothing changed must change
   * nothing — if the restore edge were the same as the degrade edge, each run would flip the
   * bottom window and `blurDegrades` would climb for ever. */
  const before = flatOf(mgr).join(",");
  const degradesBefore = mgr.stats.blurDegrades;
  for (let i = 0; i < 10; i += 1) mgr.governBlur("settle");
  ok("re-running the governor changes nothing, so it does not oscillate",
    flatOf(mgr).join(",") === before && mgr.stats.blurDegrades === degradesBefore,
    { before, after: flatOf(mgr).join(","),
      degrades: [degradesBefore, mgr.stats.blurDegrades] });

  /* THE OTHER EDGE: destroy enough that the rest fits under the RESTORE edge, and the glass must
   * come back. A governor with no restore path leaves a desktop degraded for ever after one busy
   * moment, which is the defect this asserts against. */
  const live = mgr.live().map((w) => w.id);
  // `destroyTree`, which is the kernel's own entry point — it cascades to children and is where
  // the governor's restore hook hangs.
  mgr.destroyTree(live[live.length - 1]);
  mgr.destroyTree(live[live.length - 2]);
  mgr.destroyTree(live[live.length - 3]);
  ok("and destroying windows gives the glass back", flatOf(mgr).length === 0,
    { flat: flatOf(mgr), blurPx: mgr.stats.blurPx, restore: mgr.blurRestore() });
}

/* ---- 5. a window that GROWS is an area-changing event ------------------------------------- */
{
  const per = blurRingArea(640, 440) * 4;
  const mgr = desktop(3, { budget: per * 3 });
  ok("three windows at a three-window budget are all glass", flatOf(mgr).length === 0,
    { flat: flatOf(mgr) });
  /* MAXIMIZE, SNAP AND A DRAG-RESIZE ALL ARRIVE AS THIS, which is why the governor hangs off the
   * reported box and not off a gesture (constraint 49 forbids a drag hook). 1000×700 costs about
   * 1.58 windows, so the desktop goes over the budget while the grown window alone still fits
   * inside it — which is the case where "degrade from the bottom" has a choice to make. */
  const top = mgr.get(mgr.stack[mgr.stack.length - 1]);
  top.setBox({ x: 0, y: 0, w: 1000, h: 700 });
  mgr.governBlur("geom");
  ok("growing one window past the budget flattens from the bottom", flatOf(mgr).length > 0,
    { flat: flatOf(mgr), stack: mgr.stack, blurPx: mgr.stats.blurPx,
      budget: mgr.blurBudget() });
  ok("and the grown window, being on top, keeps its glass", !top.flat,
    { top: top.id, flat: flatOf(mgr), topCost: mgr.blurCost(top), budget: mgr.blurBudget() });
}

/* ---- 5b. and the top is the LAST to lose it, not exempt from the budget ------------------- */
{
  const per = blurRingArea(640, 440) * 4;
  const mgr = desktop(3, { budget: per * 3 });
  /* A WINDOW WHOSE OWN COST EXCEEDS THE WHOLE BUDGET GOES FLAT TOO, and the first version of this
   * probe asserted the opposite — that the top window always keeps its glass. It does not, and it
   * must not: the alternative is holding the budget open for one window, which is a budget that
   * does not bind on the only window big enough to matter. "Degrade from the bottom" is an ORDER,
   * not an exemption for the top. */
  const top = mgr.get(mgr.stack[mgr.stack.length - 1]);
  top.setBox({ x: 0, y: 0, w: 2560, h: 1440 });
  mgr.governBlur("geom");
  ok("a window larger than the whole budget is flattened as well",
    top.flat && flatOf(mgr).length === 3,
    { flat: flatOf(mgr), topCost: mgr.blurCost(top), budget: mgr.blurBudget() });
  ok("and the total is reported as zero once nothing is on glass", mgr.stats.blurPx === 0,
    { blurPx: mgr.stats.blurPx });
}

/* ---- 5c. A RAISE RE-ADMITS, which was a shipped defect ------------------------------------ */
{
  const per = blurRingArea(640, 440) * 4;
  const mgr = desktop(6, { budget: per * 4 });
  const flatBefore = flatOf(mgr);
  ok("six windows at a four-window budget leaves the bottom two flat",
    flatBefore.length === 2 && flatBefore.join(",") === mgr.stack.slice(0, 2).join(","),
    { flat: flatBefore, stack: mgr.stack });

  /* RAISE ONE OF THE FLAT ONES, which is what clicking a buried window does. The first version of
   * `governBlur` walked the existing flags rather than recomputing the keep-set, so the raised
   * window stayed flat while a window now BELOW it kept its glass — the outcome
   * `--negative top-first` exists to detect, reachable in the shipped path. */
  const raised = mgr.get(flatBefore[0]);
  mgr.raise(raised);
  const flatAfter = flatOf(mgr);
  ok("raising a flat window gives it glass", !raised.flat,
    { raised: raised.id, flatBefore, flatAfter, stack: mgr.stack });
  ok("and the flat set is still the BOTTOM of the new order",
    flatAfter.join(",") === mgr.stack.slice(0, flatAfter.length).join(","),
    { flat: flatAfter, stack: mgr.stack });
  ok("and the same number of windows are flat, so the budget still holds",
    flatAfter.length === flatBefore.length && mgr.stats.blurPx <= mgr.blurBudget(),
    { before: flatBefore.length, after: flatAfter.length,
      blurPx: mgr.stats.blurPx, budget: mgr.blurBudget() });
}

/* ---- 5d. and the governor is IDEMPOTENT, which the hysteresis no longer has to buy --------- */
{
  const per = blurRingArea(640, 440) * 4;
  const mgr = desktop(7, { budget: per * 3 });
  const first = flatOf(mgr).join(",");
  const degrades = mgr.stats.blurDegrades;
  for (let i = 0; i < 20; i += 1) mgr.governBlur("settle");
  ok("twenty runs over an unchanged desktop change nothing",
    flatOf(mgr).join(",") === first && mgr.stats.blurDegrades === degrades,
    { first, now: flatOf(mgr).join(","),
      degrades: [degrades, mgr.stats.blurDegrades] });
  /* AND THAT IS BECAUSE THE INPUT DOES NOT RESPOND TO THE ACTION. `blurPxIfAllGlass` is what
   * admission reads, and it is the same before and after a degrade — which is the whole reason
   * this governor needs no hysteresis to settle. */
  const full = mgr.stats.blurPxIfAllGlass;
  mgr.governBlur("again");
  ok("because the admission input is the ALL-GLASS cost, unchanged by degrading",
    mgr.stats.blurPxIfAllGlass === full && mgr.stats.blurPx < full,
    { ifAllGlass: mgr.stats.blurPxIfAllGlass, onGlass: mgr.stats.blurPx });
}

/* ---- 6. the bench hook can only TIGHTEN the budget ---------------------------------------- */
{
  const mgr = desktop(1, { budget: BLUR_OFF_AT * 100 });
  ok("a hook asking for a LARGER budget gets the real one",
    mgr.blurBudget() === BLUR_OFF_AT,
    { budget: mgr.blurBudget(), asked: BLUR_OFF_AT * 100, real: BLUR_OFF_AT });
}

/* ---- 7. the chrome metrics are the ABI's, and the skin agrees ----------------------------- */
{
  const aero = await import("../../src/wm/aero.mjs");
  ok("the skin's caption height IS the ABI's", aero.CAP_H === WIN_CAP_H,
    { skin: aero.CAP_H, abi: WIN_CAP_H });
  ok("and its inset is too", aero.INSET === WIN_INSET, { skin: aero.INSET, abi: WIN_INSET });
  ok("and its ringArea is the ABI's function",
    aero.ringArea(640, 440) === blurRingArea(640, 440),
    { skin: aero.ringArea(640, 440), abi: blurRingArea(640, 440) });
}

const failures = checks.filter((c) => !c.pass);
console.log(JSON.stringify({
  ok: failures.length === 0,
  checks: checks.length,
  failures: failures.map((c) => ({ name: c.name, detail: c.detail })),
  figures: {
    ringAreaCssPx: blurRingArea(640, 440),
    boxAreaCssPx: blurBoxArea(640, 440),
    perWindowDevicePx: blurRingArea(640, 440) * 4,
    budgetDevicePx: BLUR_OFF_AT,
    restoreDevicePx: BLUR_ON_AT,
    windowsToBudgetAsRing: Math.ceil(BLUR_OFF_AT / (blurRingArea(640, 440) * 4)),
    windowsToBudgetAsBox: Math.ceil(BLUR_OFF_AT / (blurBoxArea(640, 440) * 4)),
  },
}, null, 2));
process.exit(failures.length ? 1 : 0);
