// M9's modality rules, under plain Node. THE STACK, THE OWNER CHAIN AND THE BLOCKER WALK.
//
// WHY THIS FILE EXISTS, in one sentence: the blocker walk is a nest of "who is not affected by
// whom", and the first version of it was WRITTEN BACKWARDS — it excluded the raising window's own
// subtree instead of the modal's, so a save dialog could not block the editor that owns it. The
// browser found that (the editor's keys arrived and `suppressed` stayed at 0), and it would have
// been found here in milliseconds.
//
// What this CAN cover: every rule that is a function of the table — the stack's order, the owner
// chain across processes, who blocks whom at each scope, which windows ride up with an owner, and
// what input suppression does. What it CANNOT cover is a click: `www/m9.html` sends a real one.
//
// THE FAKE KERNEL IS NOT GENTLER THAN THE REAL ONE (constraint 98): `post` is recorded, so a
// stack the kernel changed without telling the page would show up as a missing message.
import { Window, WinMgr, installWindowKernel } from "../../src/kernel/wins.mjs";
import {
  MAX_INLINE, WEV_BYTES, WEV_KEY, WEV_POINTER, WEV_RESIZE, WEV_CLOSE, WEV_DESTROYED,
  WMODAL_NONE, WMODAL_WINDOW, WMODAL_APP, WMODAL_SYSTEM,
  WMODE_MODELESS, WMODE_PASSIVE, WMODE_RENDER_ABOVE, WMODE_BLOCKING,
  packKeyBytes,
} from "../../src/abi.mjs";

const results = [];
/** A failure's evidence, CAPPED. Under a mutation that moves eighteen checks the full objects
 *  came to 64 KiB and the pipe truncated the JSON — so `bench/m9-modal/controls.py` could not
 *  parse the report it had asked for, which is a harness that cannot report its own result. 200
 *  characters is enough to see what a value was and short enough that a whole mutation's failures
 *  fit. */
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
let clock = 1000;
installWindowKernel({
  reply: () => {},
  post: (m) => { posts.push(m); },
  now: () => clock,
  pollWake: () => {},
});
const reset = () => { posts.length = 0; };
const postsOf = (t) => posts.filter((m) => m.t === t);
/** A SAFE ACCESSOR, and it is not optional: indexing `postsOf(t)[0]` directly THROWS when the
 *  mutation under test made no post, and a harness that dies on the failure it is testing for
 *  reports nothing instead of the failure. `bench/m9-modal/controls.py --only backwards-subtree`
 *  is exactly that case, and it killed this probe until this existed. */
const postAt = (t, i = 0) => {
  const all = postsOf(t);
  // A negative index counts from the end, because "the LATEST order" is what most of these ask
  // about and `at(-1)` on an empty list must reach the fallback rather than throw.
  return all.at(i) || { t: "<no post>", win: null, by: null, ids: null, blocked: null };
};
/** A blocker's id, or null. Same reason: `blockingFor(...)` may answer null under a mutation and
 *  `.id` on null is a dead probe. */
const blockerOf = (mgr, win) => {
  const b = mgr.blockingFor(win);
  return b ? b.id : null;
};
const key = (text) => ({ type: WEV_KEY, ...packKeyBytes(new TextEncoder().encode(text)) });

/** A window and its modality in one call, the way a program sets them: create names the owner,
 *  then the two axes are set. */
const modal = (mgr, pid, spec, scope, mode) => {
  const w = mgr.create(pid, spec);
  w.scope = scope;
  w.mode = mode;
  return w;
};

// ---- the stack: order, and who is on top ---------------------------------------------------
{
  const mgr = new WinMgr();
  reset();
  const a = mgr.create(1, { title: "a" });
  const b = mgr.create(1, { title: "b" });
  const c = mgr.create(2, { title: "c" });
  check("a new window goes on top", mgr.stack, [a.id, b.id, c.id]);
  check("and the depth of each is its place from the bottom",
    [mgr.depthOf(a.id), mgr.depthOf(c.id)], [0, 2]);
  reset();
  check("raising the bottom one answers 0", mgr.raise(a), 0);
  check("and it is on top", mgr.stack, [b.id, c.id, a.id]);
  // THE WHOLE ORDER IS POSTED, not a "raise this one" instruction: the page renders the list, so
  // the two sides cannot disagree about what is on top.
  check("the page is told the whole order", postsOf("win-stack").length, 1);
  check("bottom first", postAt("win-stack").ids, [b.id, c.id, a.id]);
  mgr.destroyTree(c.id);
  check("a destroyed window leaves the stack", mgr.stack, [b.id, a.id]);
  check("and the page is told again", postsOf("win-stack").length, 2);
  check("a raise of a destroyed window answers null, not 0", mgr.raise(c), null);
}

// ---- the owner chain, across processes ------------------------------------------------------
{
  const mgr = new WinMgr();
  const app = mgr.create(10, { title: "app" });
  // A BROKER'S DIALOG: owned by the app's window, running in the broker's process. That is the
  // whole point of cross-process ownership (M7) and it is what `appOf` has to get right.
  const dialog = mgr.create(99, { title: "picker", owner: app.id });
  const tip = mgr.create(99, { title: "tip", owner: dialog.id });
  check("ancestors walk from the nearest owner upwards",
    mgr.ancestors(tip).map((w) => w.id), [dialog.id, app.id]);
  check("a window with no owner has none", mgr.ancestors(app), []);
  check("a subtree is the window and everything it owns",
    mgr.subtree(app).map((w) => w.id), [app.id, dialog.id, tip.id]);
  // THE APP A MODALITY IS ABOUT IS THE OWNER'S, NOT THE DIALOG'S. A picker's dialog must block the
  // app that asked for it, which is a different process from the picker.
  check("the app of an owned window is its OWNER's process", mgr.appOf(dialog), 10);
  check("and of an unowned one, its own", mgr.appOf(app), 10);
  /* THE OWNER'S AND NOT THE ROOT'S, and depth 1 cannot tell those apart — which is why this read
   * the root for a while and every fixture agreed with it. The tooltip's owner is the PICKER's
   * dialog, so a modality on the tooltip is about the PICKER (99). Answering 10 freezes the app
   * that does not own the window the modal is attached to, and leaves the window that does own it
   * working (constraint 229). */
  check("two levels down it is the OWNER's process, not the root's", mgr.appOf(tip), 99);
  // A CYCLE CANNOT HANG THE WALK. Two processes build the chain and neither sees the whole of it,
  // so the guard is not optional.
  app.owner = tip.id;
  checkThat("a cycle in the chain terminates", mgr.ancestors(tip).length <= 3,
    mgr.ancestors(tip).map((w) => w.id));
  app.owner = 0;
}

// ---- the blocker walk, at each scope --------------------------------------------------------
//
// THE RULE, STATED ONCE: a BLOCKING window blocks nobody in its own subtree — itself and anything
// it owns must keep working — and beyond that, its SCOPE says who. The first version of this
// excluded the raising window's subtree instead, which is the same sentence backwards: a save
// dialog is its editor's child, so the editor was excluded from being blocked by its own dialog.
{
  const mgr = new WinMgr();
  const editor = mgr.create(1, { title: "editor" });
  const scratch = mgr.create(1, { title: "scratch" });
  const stranger = mgr.create(2, { title: "stranger" });
  const save = modal(mgr, 1, { title: "save", owner: editor.id },
    WMODAL_WINDOW, WMODE_BLOCKING);
  const tip = mgr.create(1, { title: "tip", owner: save.id });

  check("a window-modal dialog blocks the window that owns it", blockerOf(mgr, editor), save.id);
  check("and does NOT block itself", mgr.blockingFor(save), null);
  check("nor anything it owns", mgr.blockingFor(tip), null);
  check("nor a sibling window of the same process", mgr.blockingFor(scratch), null);
  check("nor another process's window", mgr.blockingFor(stranger), null);

  // APP SCOPE: every window of the OWNER's process, which is what a picker broker needs.
  save.scope = WMODAL_APP;
  check("an app-modal dialog blocks the owner", mgr.blockingFor(editor) !== null, true);
  check("and the owner's sibling", blockerOf(mgr, scratch), save.id);
  check("and still not another process's window", mgr.blockingFor(stranger), null);
  check("and still not its own child", mgr.blockingFor(tip), null);

  // SYSTEM SCOPE: everything but its own subtree.
  save.scope = WMODAL_SYSTEM;
  check("a system-modal dialog blocks another process's window too",
    blockerOf(mgr, stranger), save.id);
  check("and its own child is still free", mgr.blockingFor(tip), null);

  // THE MODE IS THE OTHER AXIS, and only one value of it blocks.
  for (const mode of [WMODE_MODELESS, WMODE_PASSIVE, WMODE_RENDER_ABOVE]) {
    save.mode = mode;
    check(`mode ${mode} blocks nothing even at system scope`, mgr.blockingFor(stranger), null);
  }
  save.mode = WMODE_BLOCKING;
  save.scope = WMODAL_NONE;
  check("and a blocking window with no scope blocks nothing", mgr.blockingFor(editor), null);
}

// ---- A NEW WINDOW IS ON TOP, AND THE PAGE IS TOLD -------------------------------------------
//
// `create` pushed the new id onto the stack and posted nothing. The kernel's order was right and
// the page never heard it — and since the page assigns a `z-index` ONLY when it renders an order, a
// window that had been clicked carried one and a window created afterwards carried none, so the new
// window painted BEHIND it (constraint 230).
//
// THE OLD PROBE COULD NOT SEE THIS: it called `reset()` after its creates, so the posts that were
// missing had already been thrown away. The order of the two posts is asserted too, because the
// page resolves an order into frames it must already know about.
{
  const mgr = new WinMgr();
  reset();
  const first = mgr.create(1, { title: "first" });
  check("creating a window posts the order", postsOf("win-stack").length, 1);
  check("and the window first", postAt("win-create").win, first.id);
  checkThat("in that order",
    posts.findIndex((p) => p.t === "win-create") < posts.findIndex((p) => p.t === "win-stack"),
    posts.map((p) => p.t));
  const second = mgr.create(1, { title: "second" });
  check("a second create posts the order again", postsOf("win-stack").length, 2);
  check("with the new window on top", postAt("win-stack", -1).ids, [first.id, second.id]);
  check("and nothing is blocked", postAt("win-stack", -1).blocked, []);
}

// ---- A PASSIVE WINDOW NEVER TAKES THE STACK -------------------------------------------------
//
// `src/abi.mjs` defines PASSIVE as "raised WITH its owner and never above a sibling", and only the
// rider half of that was implemented. A click lands on a tooltip's frame like any other and the
// page posts `win-raise` for it, so a passive window raised directly went to the top of the GLOBAL
// stack — above its owner's siblings and above other processes' windows (constraint 232).
{
  const mgr = new WinMgr();
  const owner = mgr.create(1, { title: "owner" });
  const sibling = mgr.create(1, { title: "sibling" });
  const stranger = mgr.create(2, { title: "stranger" });
  const tip = modal(mgr, 1, { title: "tip", owner: owner.id }, WMODAL_NONE, WMODE_PASSIVE);
  mgr.raise(sibling);
  mgr.raise(stranger);
  check("a sibling and a stranger are above the owner",
    mgr.stack.slice(-2), [sibling.id, stranger.id]);
  reset();
  check("raising a PASSIVE window answers 0", mgr.raise(tip), 0);
  // ITS OWNER CAME UP AND IT RODE ALONG, which is the whole definition: the pair moves, and the
  // tooltip is directly above the window it belongs to and nowhere else.
  check("its owner came up with it", mgr.stack.slice(-2), [owner.id, tip.id]);
  checkThat("so it is not above a stranger on its own",
    mgr.stack.indexOf(tip.id) === mgr.stack.indexOf(owner.id) + 1, mgr.stack);
  // AND A MODELESS CHILD IS NOT REDIRECTED, so the rule is about the mode and not about having an
  // owner at all.
  const pane = modal(mgr, 1, { title: "pane", owner: owner.id }, WMODAL_NONE, WMODE_MODELESS);
  mgr.raise(stranger);
  check("a MODELESS owned window raises itself", mgr.raise(pane), 0);
  check("and goes on top alone", mgr.stack[mgr.stack.length - 1], pane.id);
}

// ---- APP SCOPE DOWN A THREE-PROCESS CHAIN ---------------------------------------------------
//
// THE CHECK THAT WOULD HAVE CAUGHT IT. Every other fixture here owns at depth 1, where "the owner's
// process" and "the root's process" are the same number, so `appOf` could read the chain from the
// wrong end and all 58 assertions agreed with it. Three processes, two levels:
//
//   pane (pid 10) ── owns ──▶ doc (pid 20) ── owns ──▶ ask (pid 30, APP + BLOCKING)
//
// `ask` is attached to `doc`, so the app it is about is pid 20. Reading the root instead freezes
// pid 10 — a process that owns none of the windows in question — and leaves `doc`, which `ask` is
// modal OVER, typable and raisable above it (constraint 229).
{
  const mgr = new WinMgr();
  const pane = mgr.create(10, { title: "pane" });
  const paneTwo = mgr.create(10, { title: "pane two" });
  const doc = mgr.create(20, { title: "doc", owner: pane.id });
  const docTwo = mgr.create(20, { title: "doc two" });
  const ask = modal(mgr, 30, { title: "ask", owner: doc.id }, WMODAL_APP, WMODE_BLOCKING);

  check("an app-modal dialog blocks the window it is attached to",
    blockerOf(mgr, doc), ask.id);
  check("and that window's process sibling", blockerOf(mgr, docTwo), ask.id);
  // AND NOT THE ROOT'S PROCESS. This is the half that was wrong: pid 10 was frozen instead.
  check("and NOT the root owner's window", mgr.blockingFor(pane), null);
  check("nor the root owner's sibling", mgr.blockingFor(paneTwo), null);
  check("the app it is about is its owner's", mgr.appOf(ask), 20);
  /* AND THE BLOCKED SET TRAVELS WITH THE ORDER. The page needs it because a drag and an arrow-key
   * move are page-side from end to end, so suppression that lives only in `feed` covers the client
   * area and not the frame — a blocked window could still be dragged around under its modal
   * (constraint 233). It is computed kernel-side so the page decides nothing. */
  reset();
  mgr.postStack();
  check("the order carries who is blocked",
    [...postAt("win-stack").blocked].sort((x, y) => x - y), [doc.id, docTwo.id]);
  checkThat("and the modal itself is not in it",
    !postAt("win-stack").blocked.includes(ask.id), postAt("win-stack").blocked);
  // AND THE REFUSAL FOLLOWS, because a blocker that names the wrong process refuses the wrong
  // raise — which is what a user would actually hit.
  check("a raise of the attached window is refused", mgr.raise(doc) && mgr.raise(doc).id, ask.id);
  check("and a raise of the root owner's window is granted", mgr.raise(pane), 0);
}

// ---- the topmost blocker is the one reported ------------------------------------------------
{
  const mgr = new WinMgr();
  const app = mgr.create(1, { title: "app" });
  const first = modal(mgr, 1, { title: "first", owner: app.id }, WMODAL_WINDOW, WMODE_BLOCKING);
  const second = modal(mgr, 1, { title: "second", owner: app.id }, WMODAL_WINDOW, WMODE_BLOCKING);
  // TWO MODALS OVER ONE WINDOW is a real state — a dialog raised while another is up — and the
  // user has to be sent to the one on TOP, not to whichever the walk happened to see first.
  check("the topmost blocker is the one reported", blockerOf(mgr, app), second.id);
  mgr.raise(first);
  check("and it follows the stack", blockerOf(mgr, app), first.id);
}

// ---- a raise, and what rides with it --------------------------------------------------------
{
  const mgr = new WinMgr();
  const other = mgr.create(2, { title: "other" });
  const app = mgr.create(1, { title: "app" });
  const palette = modal(mgr, 1, { title: "palette", owner: app.id },
    WMODAL_NONE, WMODE_RENDER_ABOVE);
  const tip = modal(mgr, 1, { title: "tip", owner: app.id }, WMODAL_NONE, WMODE_PASSIVE);
  const plain = mgr.create(1, { title: "plain", owner: app.id });
  mgr.raise(other);
  check("the unrelated window is on top", mgr.stack[mgr.stack.length - 1], other.id);
  reset();
  check("raising the owner is granted", mgr.raise(app), 0);
  // CONSTRAINT 44'S DEFECT IN ONE LINE: "without an owner chain a dialog sits behind the window
  // that owns it". A palette and a tooltip ride up WITH their owner; an ordinary owned window
  // does not, because it is just a window that happens to have an owner.
  check("and its palette and tooltip ride above it",
    mgr.stack.slice(-3), [app.id, palette.id, tip.id]);
  checkThat("while a MODELESS owned window stays where it was",
    mgr.stack.indexOf(plain.id) < mgr.stack.indexOf(app.id),
    { stack: mgr.stack, plain: plain.id, app: app.id });
  check("the page is told the new order", postsOf("win-stack").length, 1);
}

// ---- a blocked raise is refused, and the page is told who refused ---------------------------
{
  const mgr = new WinMgr();
  const app = mgr.create(1, { title: "app" });
  const save = modal(mgr, 1, { title: "save", owner: app.id }, WMODAL_WINDOW, WMODE_BLOCKING);
  const before = [...mgr.stack];
  reset();
  const blocker = mgr.raise(app);
  check("the raise is refused with the blocker", blocker ? blocker.id : null, save.id);
  check("the order did not change", mgr.stack, before);
  check("no stack was posted", postsOf("win-stack").length, 0);
  // THE PAGE IS TOLD WHO REFUSED, so a click that does nothing can be explained to the user
  // rather than swallowed.
  check("but the refusal was", postsOf("win-blocked").length, 1);
  check("naming both windows", [postAt("win-blocked").win, postAt("win-blocked").by],
    [app.id, save.id]);
  check("and it is counted", mgr.report().blocked, 1);
  // AND THE DIALOG ITSELF CAN STILL BE RAISED, which is what makes the refusal about the rule
  // rather than about a frozen desktop.
  check("the dialog can still be raised", mgr.raise(save), 0);
}

// ---- input suppression ----------------------------------------------------------------------
{
  const mgr = new WinMgr();
  const app = mgr.create(1, { title: "app" });
  const save = modal(mgr, 1, { title: "save", owner: app.id }, WMODAL_WINDOW, WMODE_BLOCKING);
  check("a key to a blocked window is refused", mgr.feed(app.id, key("x")), false);
  check("and counted on that window", app.report().suppressed, 1);
  check("and in the table", mgr.report().suppressed, 1);
  check("nothing was queued", app.report().pending, 0);
  check("a pointer is suppressed too",
    mgr.feed(app.id, { type: WEV_POINTER, a: 1, b: 1 }), false);
  /* BUT NOT EVERYTHING. A blocked window must still learn that it was resized, that it was asked
   * to close and that it was destroyed: those are not input, and a window that missed them would
   * be wrong about the world once the modal went away. */
  check("a resize still arrives", mgr.feed(app.id, { type: WEV_RESIZE, a: 40, b: 12 }), true);
  check("a close request still arrives", mgr.feed(app.id, { type: WEV_CLOSE }), true);
  check("and the window has them", app.report().pending, 2);
  // THE DIALOG'S OWN INPUT IS NOT SUPPRESSED, or it could never be answered.
  check("the dialog itself takes keys", mgr.feed(save.id, key("y")), true);
  // AND THE SUPPRESSION LIFTS WITH THE MODAL, which is what makes it a state and not a latch.
  mgr.destroyTree(save.id);
  check("once the modal is gone the keys arrive again", mgr.feed(app.id, key("z")), true);
}

// ---- the window's own report carries both axes ----------------------------------------------
{
  const mgr = new WinMgr();
  const app = mgr.create(1, {});
  const save = modal(mgr, 1, { owner: app.id }, WMODAL_APP, WMODE_BLOCKING);
  check("a fresh window is modeless and scopeless",
    [app.report().scope, app.report().mode], [WMODAL_NONE, WMODE_MODELESS]);
  check("and a modal one publishes both axes",
    [save.report().scope, save.report().mode], [WMODAL_APP, WMODE_BLOCKING]);
  check("the table publishes the stack", mgr.report().stack, [app.id, save.id]);
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  ok: failed.length === 0, total: results.length, failed: failed.length, failures: failed,
}, null, 2));
process.exit(failed.length ? 1 : 0);
