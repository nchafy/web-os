// The window's clamp under plain Node, with no DOM.
//
// `clampBox` is a PURE function over a box and a surface, which is what makes it checkable here —
// and it is the one part of `src/wm/window.mjs` whose failure is invisible on screen. Every other
// property of a window is a gesture and needs a real browser; `www/m4a.html`'s geometry proof
// drives those with real pointer and key events and reads the result out of the DOM, because an
// inert frame and a working one are the same picture (constraint 40).
//
// WHAT THIS EXISTS FOR. The port dropped two guards webxp had, and both are about a surface
// SMALLER than the window's own minimum — a `Win` built before its desktop is laid out, or inside
// a hidden container, measures `{w: 0, h: 0}`. Without them the window came out 0x0 at x = -72:
// off the left edge with NONE of the title bar on screen, which is the exact invariant
// `MIN_VISIBLE` encodes, inverted. It then stayed there until some gesture re-ran `apply()`.
import { clampBox, MIN_W, MIN_H } from "../../src/wm/window.mjs";

const results = [];
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  results.push({ name: n, ok, got: ok ? undefined : g, want: ok ? undefined : w });
};
const checkThat = (n, c, d) => results.push({ name: n, ok: !!c, detail: c ? undefined : d });
//: FIELD BY FIELD, because `JSON.stringify` is key-ORDER sensitive and `clampBox` builds its
//: result as {w, h, x, y} while a caller writes a box as {x, y, w, h}. Comparing the strings
//: reported two identical boxes as different, which is the harness being wrong about the code.
const checkBox = (n, g, w) => {
  const same = ["x", "y", "w", "h"].every((k) => g[k] === w[k]);
  results.push({ name: n, ok: same, got: same ? undefined : g, want: same ? undefined : w });
};

//: `MIN_VISIBLE` is private to window.mjs on purpose — it is not a number a caller should set — so
//: it is derived here from the clamp's own behaviour rather than copied. A copy would be a second
//: place one fact is recorded, and it would still pass if window.mjs changed the number.
const DESKTOP = { w: 800, h: 500 };
const MIN_VISIBLE = DESKTOP.w - clampBox({ x: 1e6, y: 0, w: 300, h: 200 }, DESKTOP).x;
checkThat("the clamp keeps a sane sliver visible", MIN_VISIBLE > 0 && MIN_VISIBLE < 300,
  MIN_VISIBLE);

// ---- an ordinary surface -----------------------------------------------------------------
{
  const box = { x: 100, y: 50, w: 300, h: 200 };
  checkBox("a box that fits is untouched", clampBox(box, DESKTOP), box);
  checkThat("and the result is a NEW object", clampBox(box, DESKTOP) !== box, "same reference");
  check("pushed right, the title bar stays reachable",
    clampBox({ ...box, x: 1e6 }, DESKTOP).x, DESKTOP.w - MIN_VISIBLE);
  // The LEFT edge may go off-screen down to a sliver: that is deliberate, and asymmetric with the
  // right, because a window pushed left is still grabbable by its right-hand end.
  check("pushed left, a sliver is kept", clampBox({ ...box, x: -1e6 }, DESKTOP).x,
    MIN_VISIBLE - box.w);
  check("pushed up, the top is the limit", clampBox({ ...box, y: -1e6 }, DESKTOP).y, 0);
  check("pushed down, the title bar stays reachable",
    clampBox({ ...box, y: 1e6 }, DESKTOP).y, DESKTOP.h - MIN_VISIBLE);
  check("a box smaller than the minimum is grown", clampBox({ ...box, w: 1, h: 1 }, DESKTOP).w,
    MIN_W);
  check("in both axes", clampBox({ ...box, w: 1, h: 1 }, DESKTOP).h, MIN_H);
  // SIZE ONLY. A window as wide as the desktop has a WIDER legal x range, not a pinned one —
  // the bounds are [MIN_VISIBLE - w, surface.w - MIN_VISIBLE], so x = 100 is inside it. An earlier
  // draft of this probe asserted x === 0 and was simply wrong about the clamp it was checking.
  checkBox("a box larger than the surface is held to its size",
    clampBox({ ...box, w: 1e6, h: 1e6 }, DESKTOP),
    { w: DESKTOP.w, h: DESKTOP.h, x: box.x, y: box.y });
}

// ---- THE REGRESSION: a surface smaller than the window's own minimum ---------------------
//
// A desktop that has not been laid out measures zero. Both dropped guards fire here, and before
// they were restored this produced `{w: 0, h: 0, x: -72, y: 0}`.
for (const surface of [{ w: 0, h: 0 }, { w: 10, h: 10 }, { w: MIN_W - 1, h: MIN_H - 1 }]) {
  const got = clampBox({ x: 40, y: 32, w: 560, h: 360 }, surface);
  const where = JSON.stringify(surface);
  checkThat(`a ${where} surface never yields a zero-width window`, got.w >= MIN_W, got);
  checkThat(`a ${where} surface never yields a zero-height window`, got.h >= MIN_H, got);
  // THE ONE THAT WAS WRONG. With no `Math.max(surface.w - MIN_VISIBLE, 0)` the upper bound went
  // NEGATIVE and won, so the clamp itself invented a coordinate with nothing on screen.
  checkThat(`a ${where} surface never places the window at a negative y`, got.y >= 0, got);
  checkThat(`a ${where} surface keeps the window's right edge on screen`,
    got.x + got.w >= MIN_VISIBLE, got);
  checkThat(`a ${where} surface does not push the window off the left`,
    got.x >= MIN_VISIBLE - got.w, got);
}

// ---- idempotence, which is what makes `apply()` safe to call twice -----------------------
//
// `apply()` writes `placed` from `box` and never writes `box`, so the clamp is re-run on every
// resize of the desktop. A clamp that moved its own output would drift the window a little every
// time the window was re-laid-out.
for (const [box, surface] of [
  [{ x: 100, y: 50, w: 300, h: 200 }, DESKTOP],
  [{ x: -1e6, y: 1e6, w: 300, h: 200 }, DESKTOP],
  [{ x: 40, y: 32, w: 560, h: 360 }, { w: 0, h: 0 }],
  [{ x: 40, y: 32, w: 560, h: 360 }, { w: 120, h: 90 }],
]) {
  const once = clampBox(box, surface);
  checkBox(`clamping ${JSON.stringify(surface)} twice changes nothing`,
    clampBox(once, surface), once);
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  ok: failed.length === 0, total: results.length, failed: failed.length, failures: failed,
}, null, 2));
process.exit(failed.length ? 1 : 0);
