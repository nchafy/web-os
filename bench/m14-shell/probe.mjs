// M14's SHOW STATE, ROLE AND ITEM LIST, under plain Node — every rule that is a function of the
// window table, asserted in milliseconds without a browser.
//
// WHY THIS FILE EXISTS. The state machine has three places where the obvious implementation is
// wrong in a way a screenshot cannot show: restoring a MINIMIZED window must give back what it
// WAS (Win32's `SW_RESTORE`, and a taskbar button is unusable without it); the restore box must be
// taken on the way out of a FLOATING state and not on every change, or a window dragged from a
// snap to a maximize loses where it came from; and a minimized window must be charged NO blurred
// area, because constraint 49's admission controller sums what every window would cost on glass.
//
// What this CAN cover: the state transitions, the role rules and their refusals, the item codec's
// round trip through `WinMgr`, the index validation, and the blur accounting. What it CANNOT cover
// is a gesture — `www/m14.html` drives a real pointer, and `bench/m14-shell/shell.py` uses the
// desktop.
//
// THE FAKE KERNEL IS NOT GENTLER THAN THE REAL ONE (constraint 98): `post` is recorded, so a state
// the kernel changed without telling the page shows up here as a missing message.
import { WinMgr, installWindowKernel } from "../../src/kernel/wins.mjs";
import {
  WST_NORMAL, WST_MIN, WST_MAX, WST_SNAP_L, WST_SNAP_R, WST_LIMIT,
  WROLE_NORMAL, WROLE_DESKTOP,
  WITEM_DESKTOP, WITEM_MENU, WITEM_JUMP, WITEM_SEPARATOR, WITEM_DISABLED, WIN_ITEM_CAP,
  WICON_FOLDER, WICON_TERMINAL,
  WEV_STATE, WEV_ITEM, WEV_BYTES, decodeWinEvents,
  EBUSY, EINVAL, EHOSTGONE, blurRingArea,
} from "../../src/abi.mjs";

const results = [];
const brief = (v) => {
  const text = JSON.stringify(v === undefined ? null : v);
  return text.length > 200 ? `${text.slice(0, 200)}…(${text.length} chars)` : v;
};
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  results.push({ name: n, ok, got: ok ? undefined : brief(g), want: ok ? undefined : brief(w) });
};
const checkThat = (n, c, d) => results.push({ name: n, ok: !!c, detail: c ? undefined : brief(d) });

const posts = [];
installWindowKernel({
  reply: () => {},
  post: (m) => { posts.push(m); },
  now: () => 1000,
  pollWake: () => {},
  // The kernel injects this so `win-create` can carry the program a Superbar groups by.
  progOf: (pid) => `/usr/bin/p${pid}`,
});
const postsOf = (t) => posts.filter((m) => m.t === t);
/** A SAFE ACCESSOR, and `bench/m9-modal/probe.mjs` records why it is not optional: indexing a
 *  post that was never made THROWS, and a probe that dies on the failure it is testing for
 *  reports nothing instead of the failure. Measured here too, on the first run. */
const lastPost = (t) => postsOf(t).at(-1) || { t: "<no post>" };
const postAt = (t, i = 0) => postsOf(t).at(i) || { t: "<no post>" };

/** Read a window's queued events, decoded. The process's own route, so an event the kernel says it
 *  queued is one a program could really have read. */
const drain = (win) => {
  const into = new Uint8Array(WEV_BYTES * 64);
  const n = win.readEvents({ ctl: [1], seq: 1 }, 1, into, 0, into.length);
  if (n === null) {
    /* A READ WITH NOTHING QUEUED PARKS, which is the ABI's own contract (`readEvents` returns
     * null rather than 0, because 0 is end of input and would log a session out every time a user
     * paused). A PARKED READER IS THEN HANDED THE NEXT EVENT DIRECTLY and it never reaches the
     * ring — so a probe that drained speculatively ate the very event it was about to assert on.
     * Measured: four checks came back with empty arrays and the defect was in the fixture.
     *
     * The park is undone rather than left, because this fake reader is not a process and nothing
     * is ever going to answer it. */
    win.waitingReaders.length = 0;
    return [];
  }
  return n > 0 ? decodeWinEvents(into.subarray(0, n), n) : [];
};

/* ---- the show state ------------------------------------------------------------------------- */
{
  const m = new WinMgr();
  const w = m.create(7, { title: "a", w: 420, h: 260, x: 30, y: 40 });
  posts.length = 0;

  check("maximize is reached", m.setState(w, WST_MAX), WST_MAX);
  check("and the restore box is the box it had", w.restore, { x: 30, y: 40, w: 420, h: 260 });
  check("the page is told, with the restore box",
    { t: lastPost("win-show").t, state: lastPost("win-show").state,
      restore: lastPost("win-show").restore },
    { t: "win-show", state: WST_MAX, restore: { x: 30, y: 40, w: 420, h: 260 } });
  check("and the PROCESS is told, with where it came from",
    drain(w).map((e) => ({ type: e.type, a: e.a, b: e.b })),
    [{ type: WEV_STATE, a: WST_MAX, b: WST_NORMAL }]);

  // THE CASE A TASKBAR BUTTON LIVES ON: minimize a maximized window, ask for it back, and get a
  // MAXIMIZED window. Asking for `WST_NORMAL` and being given `WST_MAX` is Win32's `SW_RESTORE`,
  // and it is why `setState` answers the state it SETTLED ON.
  check("minimize remembers what it was", m.setState(w, WST_MIN), WST_MIN);
  check("and restoring gives that back, not NORMAL", m.setState(w, WST_NORMAL), WST_MAX);
  check("a second minimize does not forget it either",
    [m.setState(w, WST_MIN), m.setState(w, WST_NORMAL)], [WST_MIN, WST_MAX]);

  // THE RESTORE BOX IS TAKEN ON THE WAY OUT OF A FLOATING STATE AND ONLY THEN. A window dragged
  // from a snap into a maximize must still go back to the box it had when it was last floating.
  m.setState(w, WST_NORMAL);
  w.setBox({ x: 11, y: 12, w: 300, h: 200 });
  m.setState(w, WST_SNAP_L);
  m.setState(w, WST_MAX);
  check("a snap-then-maximize keeps the FLOATING box as its restore point",
    w.restore, { x: 11, y: 12, w: 300, h: 200 });

  check("an out-of-range state is refused", m.setState(w, WST_LIMIT + 1), -EINVAL);
  check("and so is a negative one", m.setState(w, -1), -EINVAL);
  check("the same state twice is a no-op that answers the state",
    [m.setState(w, WST_MAX), w.state], [WST_MAX, WST_MAX]);

  /* THE BLUR ACCOUNTING, which is M12's own open item closed: a window with no frame on screen
   * filters nothing, so the governor's input must drop by exactly its ring. */
  m.setState(w, WST_NORMAL);
  w.setBox({ x: 0, y: 0, w: 640, h: 440 });
  const costNormal = m.blurCost(w);
  check("a floating window costs its ring, times dpr squared",
    costNormal, blurRingArea(640, 440) * m.dprSq);
  m.setState(w, WST_MIN);
  check("and a MINIMIZED one costs nothing", m.blurCost(w), 0);
  checkThat("so the governor's input dropped by exactly that ring",
    m.stats.blurPxIfAllGlass === 0, { ifAllGlass: m.stats.blurPxIfAllGlass, costNormal });

  /* FINDING 1, AS A CHECK, and it is the one a user would hit: maximize, restore, MOVE, minimize,
   * restore. The restore point used to survive its own use, so the last step moved the window back
   * to where it was before the maximize — two gestures stale — and because the page reports the box
   * it settled on, the kernel then recorded the wrong place too. */
  m.setState(w, WST_NORMAL);
  w.setBox({ x: 40, y: 50, w: 420, h: 260 });
  m.setState(w, WST_MAX);
  check("a maximize remembers where it came from", w.restore, { x: 40, y: 50, w: 420, h: 260 });
  m.setState(w, WST_NORMAL);
  check("and the return consumes it", w.restore, null);
  check("the post that carries it is the one that uses it",
    lastPost("win-show").restore, { x: 40, y: 50, w: 420, h: 260 });
  w.setBox({ x: 500, y: 300, w: 420, h: 260 });
  posts.length = 0;
  m.setState(w, WST_MIN);
  check("a minimize from a MOVED box offers no restore point",
    lastPost("win-show").restore, null);
  check("and coming back offers none either, so the page leaves the box alone",
    [m.setState(w, WST_NORMAL), lastPost("win-show").restore], [WST_NORMAL, null]);
  check("the window is still where it was moved to",
    { x: w.box.x, y: w.box.y }, { x: 500, y: 300 });

  const gone = m.destroyTree(w.id);
  check("a destroyed window refuses a state change", m.setState(w, WST_MAX), -EHOSTGONE);
  check("and it really went", gone, [w.id]);
}

/* ---- the role ------------------------------------------------------------------------------- */
{
  const m = new WinMgr();
  const a = m.create(1, { title: "app", w: 420, h: 260 });
  const d = m.create(2, { title: "desk", w: 800, h: 600 });
  posts.length = 0;

  check("the desktop role is granted", m.setRole(d, WROLE_DESKTOP), 0);
  check("and it goes to the BOTTOM of the stack", m.stack, [d.id, a.id]);
  check("the page is told", { t: lastPost("win-role").t, role: lastPost("win-role").role },
    { t: "win-role", role: WROLE_DESKTOP });
  check("a SECOND desktop is -EBUSY", m.setRole(a, WROLE_DESKTOP), -EBUSY);
  check("and the one that holds it is the one that asked first", m.desktop().id, d.id);

  // A RAISE ON THE DESKTOP IS A NO-OP AND NOT A REFUSAL: the page posts `win-raise` for every
  // frame a pointer lands on, so without this a click on the wallpaper buries every window.
  check("raising the desktop answers 0", m.raise(d), 0);
  check("and leaves the order alone", m.stack, [d.id, a.id]);
  check("while raising the app still works", [m.raise(a), m.stack], [0, [d.id, a.id]]);

  check("the desktop has no show state", m.setState(d, WST_MIN), -EINVAL);
  check("and it is charged no blurred area either", m.blurCost(d), 0);

  // AN OWNED WINDOW CANNOT BE THE DESKTOP: the owner chain exists so a dialog rides above its
  // owner, and the desktop is the one window nothing may ride above.
  const owned = m.create(1, { title: "dialog", w: 200, h: 120, owner: a.id });
  check("an owned window is refused the role", m.setRole(owned, WROLE_DESKTOP), -EINVAL);
  check("a window that OWNS something is refused it too", m.setRole(a, WROLE_DESKTOP), -EINVAL);
  /* THE ROLE IS ONE-WAY, which is `win_surface`'s rule rather than a new one: taking it replaces
   * the window's text widget with an icon view and nothing can put a terminal back, so a window
   * that gave the role up would have a desktop's insides, no keyboard and a place at the bottom of
   * the stack. A critic found exactly that, and found the lowering running for every role change. */
  check("giving the role back is REFUSED", m.setRole(d, WROLE_NORMAL), -EINVAL);
  check("and the desktop is still the desktop", m.desktop().id, d.id);
  const plain = m.create(4, { title: "plain", w: 300, h: 200 });
  check("so a second window still cannot take it", m.setRole(plain, WROLE_DESKTOP), -EBUSY);
  check("and it is still an ordinary window", plain.role, WROLE_NORMAL);
  check("a role outside the table is refused", m.setRole(plain, 99), -EINVAL);

  /* FINDING 2, AS A CHECK: a MINIMIZED window that takes the role must be told it became normal.
   * The page writes `Win.state` only from a `win-show`, so without the post the frame kept
   * `hidden` set for ever — and `setState` refuses a desktop, so there was no way back. */
  const dm = m.create(5, { title: "late", w: 300, h: 200 });
  m.setState(dm, WST_MIN);
  m.setRole(d, WROLE_NORMAL);              // refused, so the role is still held: use a free slot
  const held2 = m.destroyTree(d.id);
  check("the desktop can be destroyed", held2, [d.id]);
  posts.length = 0;
  drain(dm);
  check("a minimized window may take the role", m.setRole(dm, WROLE_DESKTOP), 0);
  check("and it is normal afterwards", dm.state, WST_NORMAL);
  check("the PAGE is told, or the frame stays hidden for ever",
    { t: lastPost("win-show").t, state: lastPost("win-show").state,
      from: lastPost("win-show").from },
    { t: "win-show", state: WST_NORMAL, from: WST_MIN });
  check("and so is the process", drain(dm).map((e) => ({ type: e.type, a: e.a, b: e.b })),
    [{ type: WEV_STATE, a: WST_NORMAL, b: WST_MIN }]);
}

/* ---- the item list ------------------------------------------------------------------------- */
{
  const m = new WinMgr();
  const w = m.create(3, { title: "pub", w: 420, h: 260 });
  posts.length = 0;

  const rows = [
    { icon: WICON_FOLDER, flags: WITEM_DESKTOP | WITEM_MENU, label: "Programs" },
    { icon: 0, flags: WITEM_JUMP | WITEM_SEPARATOR, label: "" },
    { icon: WICON_TERMINAL, flags: WITEM_JUMP, label: "New terminal" },
    { icon: 0, flags: WITEM_MENU | WITEM_DISABLED, label: "Nothing here" },
  ];
  check("a list is accepted and counted", m.items(w, rows), 4);
  check("the page is told the WHOLE list", lastPost("win-items").items.map((r) => r.label),
    ["Programs", "", "New terminal", "Nothing here"]);
  check("a list over the cap is refused",
    m.items(w, new Array(WIN_ITEM_CAP + 1).fill(rows[0])), -EINVAL);
  check("and the window keeps the list it had", w.items.length, 4);

  // THE INDEX IS VALIDATED AGAINST THE LIST THE KERNEL HOLDS, which is what keeps a page from
  // naming a row nothing published.
  check("activating a real row queues an event", m.activateItem(w.id, 2, WITEM_JUMP), true);
  check("with the index, the flags and WHERE it came from",
    drain(w).map((e) => ({ type: e.type, a: e.a, b: e.b, c: e.c })),
    [{ type: WEV_ITEM, a: 2, b: WITEM_JUMP, c: WITEM_JUMP }]);
  check("an index past the end is refused", m.activateItem(w.id, 9, WITEM_DESKTOP), false);
  check("a SEPARATOR is not activatable", m.activateItem(w.id, 1, WITEM_JUMP), false);
  check("a DISABLED row is not activatable", m.activateItem(w.id, 3, WITEM_MENU), false);
  check("and all three are counted as bad", m.stats.badItems, 3);
  check("an empty list withdraws it", [m.items(w, []), w.items.length], [0, 0]);

  // AND THE PAGE CANNOT FORGE EITHER OF M14's EVENTS, which is `feed`'s existing rule extended:
  // a `WEV_STATE` from the page would tell a program it had been minimized when the kernel
  // believes otherwise, and a `WEV_ITEM` would name a row index nothing published.
  check("the page cannot feed a WEV_STATE", m.feed(w.id, { type: WEV_STATE, a: WST_MIN }), false);
  check("nor a WEV_ITEM", m.feed(w.id, { type: WEV_ITEM, a: 0 }), false);
  check("and both are counted", m.stats.forgedKernelEvents, 2);
  check("the window's queue is still empty", drain(w).length, 0);

  // THE PROGRAM TRAVELS WITH THE WINDOW, because a Superbar groups by it and a page cannot learn
  // what a pid is running. A FRESH window, because this block cleared the posts above.
  m.create(9, { title: "named", w: 200, h: 120 });
  check("win-create carries the program", postAt("win-create", -1).prog, "/usr/bin/p9");
}

const failed = results.filter((r) => !r.ok);
const report = {
  ok: failed.length === 0,
  checks: results.length,
  failed: failed.length,
  failures: failed,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
