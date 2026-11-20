// M10's data objects, under plain Node. THE LIFETIME ARITHMETIC, THE FORMAT REFUSALS, AND THE DRAG
// SESSION'S EDGES.
//
// WHY THIS FILE EXISTS, in one sentence: everything that can go wrong here is a COUNT. A reference
// taken twice leaks the payload for the life of the kernel; a reference released twice frees an
// object another process is reading; a drop retained for an event that was never queued holds the
// budget until its window dies. None of that is visible on a screen, and all of it is a function of
// the table — so it is asserted here in milliseconds rather than inferred from a browser.
//
// What this CAN cover: the format table and every refusal by errno, the budget at both ceilings,
// seal-on-publish, the clipboard outliving its creator, the drag session's enter/leave edges, who
// may be a target, what a full queue does to a drop, and the idle bound at both edges. What it
// CANNOT cover is a gesture: `www/m10.html` drives a real mouse across two real windows.
//
// THE FAKE KERNEL IS NOT GENTLER THAN THE REAL ONE (constraint 98): `post` is recorded, so a
// session the kernel changed without telling the page shows up as a missing message, and the clock
// is advanced by hand so the idle bound is measured rather than waited for.
import {
  WinMgr, installWindowKernel,
} from "../../src/kernel/wins.mjs";
import {
  DataMgr, installDataKernel, DATA_ERRNOS, setTypedFormats, setDropReaches,
} from "../../src/kernel/dataobj.mjs";
import {
  DOBJ_TEXT, DOBJ_PATHS, DOBJ_PNG, DOBJ_BITMAP, DOBJ_FMT_ALL, DOBJ_CAP,
  DOBJ_MAX_BYTES, DOBJ_BUDGET_BYTES, DOBJ_F_APPEND, DRAG_IDLE_MS,
  DOBJ_WHERE_CLIPBOARD, DOBJ_WHERE_DRAG, DOBJ_WHERE_DROP,
  DOBJ_EFFECT_COPY, DOBJ_EFFECT_MOVE,
  WEV_KEY, WEV_POINTER, WEV_DRAG_ENTER, WEV_DRAG_LEAVE, WEV_DROP, WEV_DRAG_DONE,
  WPTR_DOWN, WPTR_UP, WIN_EVENT_CAP, WEV_BYTES,
  WMODAL_WINDOW, WMODE_BLOCKING,
  decodeWinEvents, encodeBitmap, fmtBit, fmtsOf, packKeyBytes,
} from "../../src/abi.mjs";

const results = [];
/** A failure's evidence, CAPPED, for `bench/m9-modal/probe.mjs`'s reason: a mutation that moves
 *  twenty checks produced 64 KiB of JSON and the pipe truncated it, so the control could not parse
 *  the report it had asked for. */
const brief = (v) => {
  const text = JSON.stringify(v === undefined ? null : v);
  return text.length > 200 ? `${text.slice(0, 200)}…(${text.length} chars)` : v;
};
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  results.push({ name: n, ok, got: ok ? undefined : brief(g), want: ok ? undefined : brief(w) });
};
const checkThat = (n, c, d) => results.push({ name: n, ok: !!c, detail: c ? undefined : brief(d) });

/** An errno NAME for a negative return, so a failure says `ENOTSUP` rather than `-58`: a check that
 *  compares numbers reports a wrong refusal as a wrong number (CLAUDE.md §Verification). */
const NAMES = Object.fromEntries(Object.entries(DATA_ERRNOS).map(([k, v]) => [v, k]));
const err = (r) => (typeof r === "number" && r < 0 ? (NAMES[-r] || `E?${-r}`) : r);

const posts = [];
let clock = 1000;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** ONE FAKE SURFACE FOR BOTH MANAGERS, which is also how the real kernel wires them: the window
 *  table is handed to `installDataKernel` as a getter, and the window manager calls back through
 *  `windowGone` so an uncollected drop is released where a window's other resources are. */
let WINS = null;
let DATA = null;
installWindowKernel({
  reply: () => {},
  post: (m) => { posts.push(m); },
  now: () => clock,
  pollWake: () => {},
  windowGone: (id) => (DATA ? DATA.windowGone(id) : 0),
});
installDataKernel({
  post: (m) => { posts.push(m); },
  now: () => clock,
  wins: () => WINS,
});

const reset = () => { posts.length = 0; };
const postsOf = (t) => posts.filter((m) => m.t === t);
/** A SAFE ACCESSOR: indexing `postsOf(t)[0]` throws when the mutation under test made no post, and
 *  a probe that dies on the failure it is testing for reports nothing (m9's lesson). */
const postAt = (t, i = 0) => postsOf(t).at(i)
  || { t: "<no post>", win: null, obj: null, effect: null, target: null, why: null };

/** A fresh pair of managers, so one section's budget cannot colour the next. */
const fresh = () => {
  WINS = new WinMgr();
  DATA = new DataMgr();
  reset();
  return { wins: WINS, data: DATA };
};

/** Press a button inside a window, the way the page does: a `WEV_POINTER` with `WPTR_DOWN`, fed
 *  through `WinMgr.feed`. The kernel's record of the pointer is written THERE and nowhere else,
 *  which is what `beginDrag` asks (constraint 244). */
const press = (wins, win) => wins.feed(win.id, { type: WEV_POINTER, mods: WPTR_DOWN, a: 1, b: 2 });
const release = (wins, win) => wins.feed(win.id, { type: WEV_POINTER, mods: WPTR_UP, a: 1, b: 2 });

/** Every event record a window is holding, decoded. The ring is the only place a delivered event
 *  can be read back, and a count alone cannot say WHICH event arrived. */
const eventsOf = (win) => {
  const into = new Uint8Array(WIN_EVENT_CAP * WEV_BYTES);
  const n = win.events.length;
  if (n === 0) return [];
  win.events.shift(into, 0, n);
  return decodeWinEvents(into.subarray(0, n), n);
};

// ---- the format table and the offer ---------------------------------------------------------
{
  const { data } = fresh();
  const obj = data.create(7, fmtBit(DOBJ_TEXT) | fmtBit(DOBJ_PNG));
  check("an object offers what it asked for", fmtsOf(obj.offer), [DOBJ_TEXT, DOBJ_PNG]);
  check("and it is not sealed yet", obj.sealed, false);
  check("its first reference is the caller's", obj.refs, 1);
  // A BIT NOBODY DEFINES IS DROPPED, not carried: an offer a target would then ask for and be
  // refused is worse than an offer that never claimed it.
  const wide = data.create(7, 0xffff);
  check("a mask outside the table is narrowed to it", wide.offer, DOBJ_FMT_ALL);
  // AN EMPTY OFFER IS -EINVAL. `fmtBit` renders an unknown format id as 0, so a program that got
  // its ids wrong would otherwise create a payload with no readers.
  check("an offer of nothing is refused", err(data.create(7, 0)), "EINVAL");
  check("and an offer of only unknown formats is too", err(data.create(7, 1 << 20)), "EINVAL");
  check("the refusal is counted", data.report().refusedFormat, 2);
}

// ---- set and get, and every refusal by its own errno -----------------------------------------
{
  const { data } = fresh();
  const obj = data.create(1, fmtBit(DOBJ_TEXT) | fmtBit(DOBJ_BITMAP));
  check("a write returns the byte count", data.set(obj, DOBJ_TEXT, enc.encode("hello")), 5);
  const got = data.fetch(obj, DOBJ_TEXT);
  check("and reads back whole", dec.decode(got.bytes), "hello");
  check("with its total beside it", got.total, 5);
  // REPLACE IS THE DEFAULT AND APPEND IS A FLAG, which is how a payload larger than one byte
  // region is written (docs/ABI.md decision 4).
  data.set(obj, DOBJ_TEXT, enc.encode("ab"));
  check("a second write REPLACES", dec.decode(data.fetch(obj, DOBJ_TEXT).bytes), "ab");
  data.set(obj, DOBJ_TEXT, enc.encode("cd"), DOBJ_F_APPEND);
  check("and an append appends", dec.decode(data.fetch(obj, DOBJ_TEXT).bytes), "abcd");
  check("the budget counts what is held", data.bytes, 4);
  // A WINDOW INTO A LONGER PAYLOAD, which is what the libos loops on.
  check("a get from an offset is the tail",
    dec.decode(data.fetch(obj, DOBJ_TEXT, 2).bytes), "cd");
  check("and the total is still the whole", data.fetch(obj, DOBJ_TEXT, 2).total, 4);
  check("an offset past the end is refused", err(data.fetch(obj, DOBJ_TEXT, 9)), "EINVAL");
  check("an offset AT the end is an empty read",
    data.fetch(obj, DOBJ_TEXT, 4).bytes.length, 0);
  /* FOUR REFUSALS, FOUR ERRNOS, and they are four facts. A single "it refused" passes for a kernel
   * that refused for the wrong reason, which is what caught M3's truncate answering ENOENT where
   * it owed EROFS. */
  check("a format outside the table is EINVAL", err(data.set(obj, 99, enc.encode("x"))), "EINVAL");
  check("a format this object never offered is ENOTSUP",
    err(data.set(obj, DOBJ_PNG, enc.encode("x"))), "ENOTSUP");
  check("and a GET of one is ENOTSUP too", err(data.fetch(obj, DOBJ_PNG)), "ENOTSUP");
  // OFFERED AND NOT WRITTEN IS -ENOENT, which is a different fact: this one may become readable
  // and ENOTSUP never will.
  check("a format offered and not yet written is ENOENT", err(data.fetch(obj, DOBJ_BITMAP)), "ENOENT");
  check("an EMPTY payload is not the same as an absent one",
    data.set(obj, DOBJ_BITMAP, new Uint8Array(0)), 0);
  check("so it reads back as zero bytes rather than ENOENT",
    data.fetch(obj, DOBJ_BITMAP).bytes.length, 0);
}

// ---- the two ceilings, which are two errnos --------------------------------------------------
{
  const { data } = fresh();
  const obj = data.create(1, fmtBit(DOBJ_PNG));
  check("a payload at the object's ceiling fits",
    data.set(obj, DOBJ_PNG, new Uint8Array(DOBJ_MAX_BYTES)), DOBJ_MAX_BYTES);
  check("one byte past it is EFBIG",
    err(data.set(obj, DOBJ_PNG, new Uint8Array(1), DOBJ_F_APPEND)), "EFBIG");
  check("and the payload is unchanged", data.fetch(obj, DOBJ_PNG).total, DOBJ_MAX_BYTES);
  // THE SYSTEM'S CEILING IS A DIFFERENT NUMBER AND A DIFFERENT ERRNO: a program that asked for
  // something impossible must not be told the system is full.
  const many = [];
  for (let i = 0; i < DOBJ_BUDGET_BYTES / DOBJ_MAX_BYTES; i += 1) {
    const o = data.create(2, fmtBit(DOBJ_PNG));
    if (typeof o === "number") break;
    many.push({ o, r: data.set(o, DOBJ_PNG, new Uint8Array(DOBJ_MAX_BYTES)) });
  }
  const refused = many.filter((x) => x.r < 0).map((x) => err(x.r));
  checkThat("the global budget refuses with ENOMEM", refused.includes("ENOMEM"), refused);
  checkThat("and never with EFBIG, which is the object's own ceiling",
    !refused.includes("EFBIG"), refused);
  check("the two refusals are counted apart",
    [data.report().refusedBig >= 1, data.report().refusedBudget >= 1], [true, true]);
  checkThat("the budget never went past itself", data.bytes <= DOBJ_BUDGET_BYTES, data.bytes);
  // AND IT COMES BACK. A budget that only ever went up would refuse everything after one big copy.
  for (const x of many) data.release(x.o);
  data.release(obj);
  check("releasing every object gives the budget back", data.bytes, 0);
  check("and the table is empty", data.report().rows, 0);
}

// ---- the per-process cap ---------------------------------------------------------------------
{
  const { data } = fresh();
  const mine = [];
  for (let i = 0; i < DOBJ_CAP; i += 1) mine.push(data.create(5, fmtBit(DOBJ_TEXT)));
  checkThat("a process may hold the cap", mine.every((o) => typeof o !== "number"), mine.length);
  check("and the next one is EMFILE", err(data.create(5, fmtBit(DOBJ_TEXT))), "EMFILE");
  // PER PROCESS AND NOT GLOBAL, which is `WIN_CAP`'s shape: one program's leak must not refuse
  // every other program's copy.
  checkThat("while ANOTHER process is unaffected",
    typeof data.create(6, fmtBit(DOBJ_TEXT)) !== "number", null);
  check("the refusal is counted", data.report().refusedCap, 1);
}

// ---- the clipboard: sealed, displacing, and outliving its creator -----------------------------
{
  const { data } = fresh();
  const obj = data.create(1, fmtBit(DOBJ_TEXT));
  data.set(obj, DOBJ_TEXT, enc.encode("copied"));
  reset();
  check("publishing to the clipboard answers 0", data.toClipboard(obj), 0);
  check("and the page is told", postAt("clipboard").obj, obj.id);
  /* SEALED ON PUBLISH. Two processes reading one object must not be shown different bytes, so the
   * source cannot rewrite it afterwards — and -EPERM rather than a silent no-op, because a program
   * that believed its write landed would publish one thing and mean another (constraint 242). */
  check("a published object is sealed", obj.sealed, true);
  check("so a write to it is EPERM", err(data.set(obj, DOBJ_TEXT, enc.encode("x"))), "EPERM");
  check("and the bytes did not change", dec.decode(data.fetch(obj, DOBJ_TEXT).bytes), "copied");
  check("the slot holds its own reference", obj.refs, 2);
  /* THE CREATOR'S FD GOES AND THE OBJECT STAYS, which is the whole of "copy, quit the program,
   * paste": the clipboard's reference is not the creator's (constraint 241). */
  data.release(obj);
  check("closing the creator's fd leaves it alive", obj.refs, 1);
  check("and it is still in the table", data.fetch(obj, DOBJ_TEXT).total, 6);
  const opened = data.openFrom(DOBJ_WHERE_CLIPBOARD);
  check("a paste opens the same object", opened.id, obj.id);
  check("taking a reference for the fd", obj.refs, 2);
  check("and the formats came with it", fmtsOf(opened.offer), [DOBJ_TEXT]);
  // A SECOND COPY DISPLACES THE FIRST, and the first one's reference goes with it.
  const second = data.create(2, fmtBit(DOBJ_PNG));
  data.set(second, DOBJ_PNG, enc.encode("\x89PNG"));
  data.toClipboard(second);
  check("a second copy displaces the first", data.report().clipboard.obj, second.id);
  check("and the first loses the slot's reference", obj.refs, 1);
  check("the displacement is counted", data.report().displaced, 1);
  data.release(obj);
  check("so the last fd frees it", data.get(second.id) === null, false);
  check("an empty clipboard is ENOENT", err(new DataMgr().openFrom(DOBJ_WHERE_CLIPBOARD)), "ENOENT");
  // A DESTINATION IS NOT A SOURCE. One enum serves both directions and each call refuses the
  // other's value BY NAME, so a caller that confused them is told rather than answered 0.
  check("DRAG is not a place to open from", err(data.openFrom(DOBJ_WHERE_DRAG)), "EINVAL");
}

// ---- the drag session: the gesture gate, and one at a time ------------------------------------
{
  const { wins, data } = fresh();
  const src = wins.create(1, { title: "source" });
  const obj = data.create(1, fmtBit(DOBJ_PATHS));
  data.set(obj, DOBJ_PATHS, enc.encode("/usr/share/x.png"));
  /* THE GATE. A program that could start a drag with no button down would hold the one session
   * until a pointerup that is never coming, and refuse every other drag with -EBUSY until then
   * (constraint 244). */
  check("a drag with no button down is EPERM",
    err(data.beginDrag(obj, src, DOBJ_EFFECT_COPY)), "EPERM");
  press(wins, src);
  check("the kernel recorded the press", [wins.pointer.win, wins.pointer.down], [src.id, true]);
  const other = wins.create(2, { title: "other" });
  check("a press in ONE window does not arm a drag from another",
    err(data.beginDrag(obj, other, DOBJ_EFFECT_COPY)), "EPERM");
  check("an effect mask of nothing is EINVAL", err(data.beginDrag(obj, src, 0)), "EINVAL");
  reset();
  check("with a button down the drag begins", data.beginDrag(obj, src, DOBJ_EFFECT_COPY), 0);
  check("and the page is told, with the formats", postAt("win-drag").obj, obj.id);
  check("the session holds a reference of its own", obj.refs, 2);
  check("and the payload is sealed", obj.sealed, true);
  // ONE POINTER, ONE SESSION.
  const two = data.create(1, fmtBit(DOBJ_TEXT));
  check("a second drag is EBUSY", err(data.beginDrag(two, src, DOBJ_EFFECT_COPY)), "EBUSY");
  check("and it is counted", data.report().refusedDrag, 4);
}

// ---- enter and leave are EDGES, and there is no OVER ------------------------------------------
{
  const { wins, data } = fresh();
  const src = wins.create(1, {});
  const target = wins.create(2, {});
  const obj = data.create(1, fmtBit(DOBJ_BITMAP));
  data.set(obj, DOBJ_BITMAP, encodeBitmap(1, 1, new Uint8Array([1, 2, 3, 4])));
  press(wins, src);
  data.beginDrag(obj, src, DOBJ_EFFECT_COPY);
  eventsOf(src);
  reset();
  check("the first sample over a window enters it", data.dragAt(target.id, 4, 5), target.id);
  check("and the page is told which window", postAt("win-drag-target").win, target.id);
  const entered = eventsOf(target);
  check("one ENTER record arrived", entered.map((e) => e.type), [WEV_DRAG_ENTER]);
  check("carrying the position", [entered[0].a, entered[0].b], [4, 5]);
  /* AND THE OFFER, which is what a target needs to decide whether it can accept BEFORE any bytes
   * exist — the whole point of a typed clipboard (constraint 243). */
  check("and the OFFER, so the target can refuse early", entered[0].c, obj.offer);
  // TEN MORE SAMPLES OVER THE SAME WINDOW ARE TEN NOTHINGS. An event per sample would stream 256
  // records — one WIN_EVENT_CAP — in about a second, and `push` drops the NEWEST, which would be
  // the DROP itself (constraint 243).
  for (let i = 0; i < 10; i += 1) data.dragAt(target.id, 6 + i, 7);
  check("ten more samples over the same window queue nothing", eventsOf(target).length, 0);
  check("and post nothing", postsOf("win-drag-target").length, 1);
  check("the enter was counted once", data.report().enters, 1);
  // LEAVING IS THE OTHER EDGE, and the kernel posts target 0 so the page drops its highlight.
  check("a sample over nothing leaves", data.dragAt(0), 0);
  check("the LEAVE arrived", eventsOf(target).map((e) => e.type), [WEV_DRAG_LEAVE]);
  check("and the page was told the target is gone", postAt("win-drag-target", -1).win, 0);
  check("entering a second window leaves the first", data.dragAt(src.id, 1, 1), src.id);
  check("the first got no second leave", eventsOf(target).length, 0);
  check("and the second entered", eventsOf(src).map((e) => e.type), [WEV_DRAG_ENTER]);
}

// ---- the LEAVE a critic found missing, twice ------------------------------------------------
{
  const { wins, data } = fresh();
  const src = wins.create(1, {});
  const target = wins.create(2, {});
  const dialog = wins.create(2, { owner: target.id });
  const obj = data.create(1, fmtBit(DOBJ_TEXT));
  data.set(obj, DOBJ_TEXT, enc.encode("hover"));
  press(wins, src);
  data.beginDrag(obj, src, DOBJ_EFFECT_COPY);
  data.dragAt(target.id, 1, 1);
  check("the target was entered", eventsOf(target).map((e) => e.type), [WEV_DRAG_ENTER]);
  /* AND THEN A MODAL BLOCKS IT MID-GESTURE. The window may no longer be a TARGET — an ENTER
   * offers something, and that is input — but it was already told the pointer was over it, so it
   * must be told the pointer left. Without this its hover frame stays on screen for the rest of
   * its life and its own enter/leave counts never balance. */
  wins.setModal(dialog, WMODAL_WINDOW, WMODE_BLOCKING);
  check("a sample elsewhere leaves it, even though it is now BLOCKED", data.dragAt(0), 0);
  check("the LEAVE arrived", eventsOf(target).map((e) => e.type), [WEV_DRAG_LEAVE]);
  check("and it is counted", data.report().leaves, 1);
}
{
  const { wins, data } = fresh();
  const src = wins.create(1, {});
  const target = wins.create(2, {});
  const obj = data.create(1, fmtBit(DOBJ_TEXT));
  data.set(obj, DOBJ_TEXT, enc.encode("cancelled"));
  press(wins, src);
  data.beginDrag(obj, src, DOBJ_EFFECT_COPY);
  data.dragAt(target.id, 1, 1);
  eventsOf(target);
  // A CANCELLATION IS THE SECOND INSTANCE. The pointer stopped reporting, so nothing will ever
  // arrive at the window the user was hovering over — including the drop it was expecting.
  clock += DRAG_IDLE_MS + 1;
  data.tick();
  check("a cancelled drag leaves the window it was over",
    eventsOf(target).map((e) => e.type), [WEV_DRAG_LEAVE]);
}
{
  const { wins, data } = fresh();
  const src = wins.create(1, {});
  const target = wins.create(2, {});
  const obj = data.create(1, fmtBit(DOBJ_TEXT));
  data.set(obj, DOBJ_TEXT, enc.encode("full"));
  for (let i = 0; i < WIN_EVENT_CAP + 2; i += 1) {
    wins.feed(target.id, { type: WEV_KEY, ...packKeyBytes(enc.encode("k")) });
  }
  press(wins, src);
  data.beginDrag(obj, src, DOBJ_EFFECT_COPY);
  data.dragAt(target.id, 1, 1);
  // AND SO IS A DROP THAT COULD NOT QUEUE: effect 0 means nothing was delivered, so the window is
  // still hovering over a gesture that is over.
  check("a drop that was lost still ends the hover", data.dragDrop(target.id, 1, 1), 0);
  /* THE COUNTER AND NOT THE RECORD, and the reason is the fixture: this window's queue is FULL,
   * which is why the drop was lost — so the LEAVE cannot be delivered either. What is assertable
   * is that the kernel TRIED, which is the difference between a session that ended the hover and
   * one that forgot to. */
  check("the LEAVE was attempted", data.report().leaves, 1);
  // A DROP THAT LANDED IS ITSELF TERMINAL, so there is no LEAVE beside it.
  const two = fresh();
  const s2 = two.wins.create(1, {});
  const t2 = two.wins.create(2, {});
  const o2 = two.data.create(1, fmtBit(DOBJ_TEXT));
  two.data.set(o2, DOBJ_TEXT, enc.encode("landed"));
  press(two.wins, s2);
  two.data.beginDrag(o2, s2, DOBJ_EFFECT_COPY);
  two.data.dragAt(t2.id, 1, 1);
  eventsOf(t2);
  two.data.dragDrop(t2.id, 1, 1);
  check("a drop that landed is the last record, with no LEAVE after it",
    eventsOf(t2).map((e) => e.type), [WEV_DROP]);
}

// ---- the drop, the one-shot collection, and the source's receipt -----------------------------
{
  const { wins, data } = fresh();
  const src = wins.create(1, {});
  const target = wins.create(2, {});
  const obj = data.create(1, fmtBit(DOBJ_PNG) | fmtBit(DOBJ_PATHS));
  data.set(obj, DOBJ_PNG, enc.encode("\x89PNG\r\n\x1a\n"));
  press(wins, src);
  data.beginDrag(obj, src, DOBJ_EFFECT_COPY | DOBJ_EFFECT_MOVE);
  data.dragAt(target.id, 3, 4);
  eventsOf(target); eventsOf(src);
  reset();
  check("a release over the target drops", data.dragDrop(target.id, 8, 9), DOBJ_EFFECT_COPY);
  const dropped = eventsOf(target);
  check("a DROP record arrived", dropped.map((e) => e.type), [WEV_DROP]);
  check("at the position the page reported", [dropped[0].a, dropped[0].b], [8, 9]);
  check("with the offer", fmtsOf(dropped[0].c), [DOBJ_PATHS, DOBJ_PNG]);
  // THE SOURCE IS TOLD WHAT HAPPENED, which a MOVE source cannot do without: it has to know
  // whether to delete what it moved.
  const done = eventsOf(src);
  check("and the source got its receipt", done.map((e) => e.type), [WEV_DRAG_DONE]);
  check("naming the effect and the target", [done[0].a, done[0].b],
    [DOBJ_EFFECT_COPY, target.id]);
  check("the session is over", data.report().drag, null);
  check("the page was told it ended", postAt("win-drag-end").effect, DOBJ_EFFECT_COPY);
  // THE PENDING DROP IS A REFERENCE, so the payload survives the end of the gesture.
  check("the payload is held for the target", data.report().pending,
    [{ win: target.id, obj: obj.id }]);
  const opened = data.openFrom(DOBJ_WHERE_DROP, target);
  check("the target opens it", opened.id, obj.id);
  check("and gets the bytes under the format it was offered",
    dec.decode(data.fetch(opened, DOBJ_PNG).bytes), "\x89PNG\r\n\x1a\n");
  /* ONE SHOT. A target that could re-open a drop it has already collected would make the kernel's
   * map grow for as long as that window lived. */
  check("a second open is ENOENT", err(data.openFrom(DOBJ_WHERE_DROP, target)), "ENOENT");
  check("and a window nothing was dropped on is ENOENT too",
    err(data.openFrom(DOBJ_WHERE_DROP, src)), "ENOENT");
}

// ---- a release over nothing, and over a window the kernel refuses ----------------------------
{
  const { wins, data } = fresh();
  const src = wins.create(1, {});
  const obj = data.create(1, fmtBit(DOBJ_TEXT));
  data.set(obj, DOBJ_TEXT, enc.encode("x"));
  press(wins, src);
  data.beginDrag(obj, src, DOBJ_EFFECT_MOVE);
  eventsOf(src);
  check("a release over nothing is effect 0", data.dragDrop(0), 0);
  const done = eventsOf(src);
  check("and the source is told exactly that",
    [done[0].type, done[0].a, done[0].b], [WEV_DRAG_DONE, 0, 0]);
  check("nothing is pending", data.report().pending, []);
  check("and the session's reference went", obj.refs, 1);

  // A BLOCKED WINDOW IS NOT A TARGET. A drop is input, and a window behind a modal that could
  // still be dropped on is the same defect as one that could still be dragged (constraint 233).
  const app = wins.create(3, {});
  const dialog = wins.create(3, { owner: app.id });
  wins.setModal(dialog, WMODAL_WINDOW, WMODE_BLOCKING);
  press(wins, src);
  data.beginDrag(obj, src, DOBJ_EFFECT_COPY);
  check("a sample over a blocked window finds no target", data.dragAt(app.id, 1, 1), 0);
  check("so no ENTER was queued for it", eventsOf(app).length, 0);
  check("and a release over it drops nothing", data.dragDrop(app.id, 1, 1), 0);
  check("while the dialog itself can be dropped on", (() => {
    press(wins, src);
    data.beginDrag(obj, src, DOBJ_EFFECT_COPY);
    return data.dragDrop(dialog.id, 2, 2);
  })(), DOBJ_EFFECT_COPY);
}

// ---- the source dying mid-drag, which is the review's own requirement -------------------------
{
  const { wins, data } = fresh();
  const src = wins.create(1, {});
  const target = wins.create(2, {});
  const obj = data.create(1, fmtBit(DOBJ_TEXT));
  data.set(obj, DOBJ_TEXT, enc.encode("survives"));
  press(wins, src);
  data.beginDrag(obj, src, DOBJ_EFFECT_COPY);
  data.dragAt(target.id, 1, 1);
  // THE SOURCE'S WINDOW GOES, which is what a reaped source process does to it. The payload is the
  // KERNEL's, so the gesture continues and the drop still lands (constraint 241).
  wins.destroyTree(src.id);
  check("the session survives its source's window", data.report().drag !== null, true);
  check("a release still drops", data.dragDrop(target.id, 5, 5), DOBJ_EFFECT_COPY);
  const opened = data.openFrom(DOBJ_WHERE_DROP, target);
  check("and the bytes are intact", dec.decode(data.fetch(opened, DOBJ_TEXT).bytes), "survives");
  // AND THE RECEIPT NOBODY IS LEFT TO READ IS NOT AN ERROR.
  check("the page was still told the gesture ended", postAt("win-drag-end", -1).effect,
    DOBJ_EFFECT_COPY);
}

// ---- a target whose queue is full: the drop is LOST and the payload is not held ---------------
{
  const { wins, data } = fresh();
  const src = wins.create(1, {});
  const target = wins.create(2, {});
  const obj = data.create(1, fmtBit(DOBJ_TEXT));
  data.set(obj, DOBJ_TEXT, enc.encode("lost"));
  // FILL IT. `push` drops the NEWEST, so the drop is the record discarded — which is why
  // retaining the payload for a collection that can never happen would hold the budget until this
  // window died (constraint 245).
  for (let i = 0; i < WIN_EVENT_CAP + 4; i += 1) {
    wins.feed(target.id, { type: WEV_KEY, ...packKeyBytes(enc.encode("k")) });
  }
  check("the target's queue is full", target.events.free < WEV_BYTES, true);
  press(wins, src);
  data.beginDrag(obj, src, DOBJ_EFFECT_COPY);
  check("the drop reports nothing happened", data.dragDrop(target.id, 1, 1), 0);
  check("it is counted as lost", data.report().dropsLost, 1);
  check("no payload is pending", data.report().pending, []);
  check("and the object is back to one reference", obj.refs, 1);
  data.release(obj);
  check("so the budget comes back", data.bytes, 0);
}

// ---- an uncollected drop goes with its window ------------------------------------------------
{
  const { wins, data } = fresh();
  const src = wins.create(1, {});
  const target = wins.create(2, {});
  const obj = data.create(1, fmtBit(DOBJ_TEXT));
  data.set(obj, DOBJ_TEXT, enc.encode("uncollected"));
  press(wins, src);
  data.beginDrag(obj, src, DOBJ_EFFECT_COPY);
  data.dragDrop(target.id, 1, 1);
  data.release(obj);
  check("the pending drop is the last reference", obj.refs, 1);
  // THE WINDOW GOES AND THE PAYLOAD GOES WITH IT, through the hook `destroyTree` calls: a window
  // that is gone can never collect what was dropped on it.
  wins.destroyTree(target.id);
  check("destroying the window releases it", obj.refs, 0);
  check("the budget came back", data.bytes, 0);
  check("and it is counted", data.report().pendingDropped, 1);
}

// ---- the idle bound, at BOTH edges ------------------------------------------------------------
{
  const { wins, data } = fresh();
  const src = wins.create(1, {});
  const target = wins.create(2, {});
  const obj = data.create(1, fmtBit(DOBJ_TEXT));
  data.set(obj, DOBJ_TEXT, enc.encode("slow"));
  press(wins, src);
  data.beginDrag(obj, src, DOBJ_EFFECT_COPY);
  // The press itself is a POINTER record on the source's queue, drained so the receipt below is
  // read on its own: a clause that asserted "the last record is a DONE" would also pass for a
  // queue that still held the press.
  eventsOf(src);
  /* IT BOUNDS IDLE TIME AND NOT THE GESTURE, which is constraint 239's correction made before the
   * same mistake happens twice: a slow careful drag across a desktop is a gesture that lasts as
   * long as the user wants, and every motion sample re-arms it. */
  for (let i = 0; i < 6; i += 1) {
    clock += DRAG_IDLE_MS - 1;
    data.dragAt(target.id, i, i);
    check(`a drag used past the bound survives (sample ${i + 1})`, data.tick(), -1);
  }
  /* A SAFE READ OF THE SESSION ROW, and it is not optional: `bench/m10-data/controls.py --only
   * session-age-bound` cancels the session on the first tick, so `report().drag` is null there —
   * and `.idleMs` on null KILLED this probe, which reports nothing instead of reporting the
   * failure it was testing for. The same defect m9's probe shipped and the same fix. */
  const session = () => data.report().drag || { obj: 0, win: 0, target: 0, idleMs: -1 };
  checkThat("so a gesture far longer than the bound is still live",
    session().idleMs >= 0 && clock - session().idleMs > DRAG_IDLE_MS * 5, clock);
  // AND THE OTHER EDGE: a pointer that stopped reporting is a session nothing will ever end.
  clock += DRAG_IDLE_MS + 1;
  const idle = data.tick();
  checkThat("an idle one is cancelled", idle >= DRAG_IDLE_MS, idle);
  check("the source is told nothing happened", eventsOf(src).map((e) => [e.type, e.a]),
    [[WEV_DRAG_DONE, 0]]);
  check("the page was told why", String(postAt("win-drag-end", -1).why).includes("no pointer"),
    true);
  check("the session's reference went", obj.refs, 1);
  check("and it is counted as a cancellation", data.report().cancelled, 1);
  check("a tick with no session does nothing", data.tick(), -1);
  // AND A PAGE REPORT WITH NO SESSION IS A RACE, NOT AN ERROR: the pointerup and the cancellation
  // can cross, and a page cannot avoid that.
  check("a drop reported after the end is counted, not faulted", data.dragDrop(target.id, 1, 1), 0);
  checkThat("as a late report", data.report().lateDrags >= 1, data.report().lateDrags);
}

// ---- a release below zero is a kernel bug, counted rather than applied -----------------------
{
  const { data } = fresh();
  const obj = data.create(1, fmtBit(DOBJ_TEXT));
  data.set(obj, DOBJ_TEXT, enc.encode("twice"));
  check("the first release frees it", data.release(obj), 0);
  check("the budget came back", data.bytes, 0);
  /* AND A SECOND ONE DOES NOT TAKE THE BUDGET NEGATIVE. Five things hold references — an fd, the
   * clipboard slot, a live session, a pending drop, and the creator before it seats its fd — and a
   * payload released twice would charge the NEXT object against a number that is already wrong,
   * with nothing to see. */
  check("a second release is counted, not applied", data.release(obj), 0);
  check("the budget is still zero and not negative", data.bytes, 0);
  check("and the kernel says it happened", data.report().doubleFrees, 1);
  check("one free, not two", data.report().freed, 1);
}

// ---- a SUPPRESSED pointer event clears the gate ---------------------------------------------
{
  const { wins, data } = fresh();
  const src = wins.create(1, {});
  const app = wins.create(2, {});
  const dialog = wins.create(2, { owner: app.id });
  const obj = data.create(1, fmtBit(DOBJ_TEXT));
  data.set(obj, DOBJ_TEXT, enc.encode("x"));
  /* THE HOLE THIS CLOSES IS A STALE `down`. Press in `src` — a real press, recorded — then move
   * over a BLOCKED window and release THERE: the release is suppressed too, so without this the
   * kernel would still believe a button was held in `src`, and `src`'s process could begin a drag
   * with nothing pressed (constraint 244). A suppressed pointer event means the kernel no longer
   * knows where the pointer is, which is the fail-closed reading. */
  press(wins, src);
  check("the press was recorded", [wins.pointer.win, wins.pointer.down], [src.id, true]);
  wins.setModal(dialog, WMODAL_WINDOW, WMODE_BLOCKING);
  check("a release over a BLOCKED window is suppressed",
    wins.feed(app.id, { type: WEV_POINTER, mods: WPTR_UP, a: 1, b: 1 }), false);
  check("and it clears the kernel's record of the pointer",
    [wins.pointer.win, wins.pointer.down], [0, false]);
  check("so a drag from the window that WAS pressed is refused",
    err(data.beginDrag(obj, src, DOBJ_EFFECT_COPY)), "EPERM");
  // AND A FRESH PRESS ARMS IT AGAIN, which is what makes this a state and not a latch.
  press(wins, src);
  check("a fresh press arms it again", data.beginDrag(obj, src, DOBJ_EFFECT_COPY), 0);
}

// ---- the page cannot forge a drag event ------------------------------------------------------
{
  const { wins, data } = fresh();
  const w = wins.create(1, {});
  /* THE PAGE'S ROUTE IS `feed`, AND THE FOUR DRAG RECORDS ARE THE KERNEL'S TO PRODUCE. Without
   * this, a page could post a `WEV_DROP` naming an offer no object carries and a target would ask
   * for a drop that does not exist. The page reports WHERE the pointer is; what a drag IS belongs
   * to `src/kernel/dataobj.mjs` (constraint 243). */
  for (const type of [WEV_DRAG_ENTER, WEV_DRAG_LEAVE, WEV_DROP, WEV_DRAG_DONE]) {
    check(`the page cannot feed event type ${type}`, wins.feed(w.id, { type, a: 1 }), false);
  }
  check("nothing was queued", w.events.length, 0);
  check("and the attempts are counted", wins.report().forgedDrags, 4);
  check("while an ordinary key still arrives",
    wins.feed(w.id, { type: WEV_KEY, ...packKeyBytes(enc.encode("a")) }), true);
  checkThat("and the data manager saw none of it", data.report().drops === 0, data.report());
}

// ---- the two negative controls, as the kernel arms them ---------------------------------------
{
  // CONTROL 1: every object offers TEXT and nothing else. `PLAN.md` §5's own words — "offer only
  // the text format; the image paste must fail cleanly, not silently paste a path".
  setTypedFormats(false);
  const { data } = fresh();
  const obj = data.create(1, fmtBit(DOBJ_PNG) | fmtBit(DOBJ_BITMAP) | fmtBit(DOBJ_TEXT));
  check("under the control an object offers only text", fmtsOf(obj.offer), [DOBJ_TEXT]);
  check("so an image write is refused by name",
    err(data.set(obj, DOBJ_BITMAP, new Uint8Array(4))), "ENOTSUP");
  check("and an image READ is refused rather than answered with a path",
    err(data.fetch(obj, DOBJ_PNG)), "ENOTSUP");
  check("while text still works", data.set(obj, DOBJ_TEXT, enc.encode("hi")), 2);
  setTypedFormats(true);
  check("and the control is off again",
    fmtsOf(data.create(1, fmtBit(DOBJ_PNG)).offer), [DOBJ_PNG]);

  // CONTROL 2: a drop is never delivered. The clipboard half must keep working.
  setDropReaches(false);
  const two = fresh();
  const src = two.wins.create(1, {});
  const target = two.wins.create(2, {});
  const payload = two.data.create(1, fmtBit(DOBJ_TEXT));
  two.data.set(payload, DOBJ_TEXT, enc.encode("undelivered"));
  press(two.wins, src);
  two.data.beginDrag(payload, src, DOBJ_EFFECT_COPY);
  check("under the second control a drop delivers nothing",
    two.data.dragDrop(target.id, 1, 1), 0);
  check("no DROP record arrived", eventsOf(target).length, 0);
  check("and nothing is left to collect",
    err(two.data.openFrom(DOBJ_WHERE_DROP, target)), "ENOENT");
  check("while the clipboard still works", two.data.toClipboard(payload), 0);
  check("and a paste still finds it",
    two.data.openFrom(DOBJ_WHERE_CLIPBOARD).id, payload.id);
  setDropReaches(true);
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  ok: failed.length === 0, total: results.length, failed: failed.length, failures: failed,
}, null, 2));
process.exit(failed.length ? 1 : 0);
