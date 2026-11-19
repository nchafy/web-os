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
const postAt = (t, i = 0) => postsOf(t)[i] || { t: "<no post>", win: null, by: null, ids: null };
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
  check("the app of an owned window is its ROOT owner's process", mgr.appOf(dialog), 10);
  check("and of an unowned one, its own", mgr.appOf(app), 10);
  check("even two levels down", mgr.appOf(tip), 10);
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
