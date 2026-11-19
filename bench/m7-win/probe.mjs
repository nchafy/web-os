// M7's window table and one window, under plain Node, against hand-built slots.
//
// What this CAN cover: the event queue and its bounded overflow, the park/wake bookkeeping, the
// record floor, the destroy cascade across processes, the owner refusals, the per-process cap and
// the not-responding detector's two edges. All of it is kernel objects over a ByteRing with an
// injected surface, so the fast loop costs milliseconds.
//
// What it CANNOT cover is the syscall path into it, the `F_WIN` ops row, the `pollOne` row, or a
// real frame: those need a kernel and a DOM, and `www/m7.html` drives them.
//
// THE FAKE KERNEL IS NOT GENTLER THAN THE REAL ONE (constraint 98): `reply` bumps `slot.seq`, which
// is what makes a record stale, and `pollWake` is counted — a window's whole wake path is one call
// that nothing else makes, so a probe that let it be absent would be checking the opposite of the
// point.
//
// It inherits M4a's console probe, which it replaces along with the device. Two of its sections are
// kept verbatim in substance because they are REGRESSIONS, not features: "a destroyed window is not
// a slow one", and "overflow is counted, never silent". The third, "starting is not wedged", is
// GONE ON PURPOSE — a window is created by the process that will read it, so there is no window
// waiting for a first opener and no caption for that state (constraint 210).
import {
  Window, WinMgr, installWindowKernel, WIN_EVENT_BYTES, NOT_RESPONDING_MS, END_PROCESS_MS,
} from "../../src/kernel/wins.mjs";
import {
  EHOSTGONE, EINVAL, ENOENT, EMFILE, MAX_INLINE, ST_RETURN,
  WEV_BYTES, WEV_KEY, WEV_RESIZE, WEV_CLOSE, WEV_DESTROYED, WIN_EVENT_CAP, WIN_CAP,
  decodeWinEvents, packKeyBytes, keyBytesOf,
} from "../../src/abi.mjs";

const results = [];
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  results.push({ name: n, ok, got: ok ? undefined : g, want: ok ? undefined : w });
};
const checkThat = (n, c, d) => results.push({ name: n, ok: !!c, detail: c ? undefined : d });

let nextPid = 1;
const makeSlot = () => ({ pid: nextPid++, ctl: {}, seq: 1, bytes: new Uint8Array(MAX_INLINE) });

const replies = [];
const posts = [];
let wakes = 0;
let clock = 1000;
installWindowKernel({
  reply: (slot, r0, r1, status, rlen) => {
    replies.push({ pid: slot.pid, r0, r1, status, rlen });
    slot.seq += 1;            // what the real reply() does, and what makes a record stale
  },
  post: (m) => { posts.push(m); },
  now: () => clock,
  pollWake: () => { wakes += 1; },
});
const reset = () => { replies.length = 0; posts.length = 0; wakes = 0; };
// SAFE ACCESSORS, for the reason bench/m4-pipe/probe.mjs records: indexing `replies[0]` directly
// throws when the mutation under test made no reply, and a harness that dies on the failure it is
// testing for reports nothing instead of the failure.
const reply = (i = 0) => replies[i]
  || { pid: null, r0: "<no reply>", r1: null, status: null, rlen: null };
const post = (i = 0) => posts[i] || { t: "<no post>" };
const postsOf = (t) => posts.filter((m) => m.t === t);
const DEC = new TextDecoder();

/** Decode what a read returned. A NEGATIVE OR TORN COUNT YIELDS NO RECORDS rather than throwing:
 *  a probe that dies on the failure it is testing for reports nothing instead of the failure. */
const decode = (bytes, n) => {
  if (typeof n !== "number" || n <= 0 || n % WEV_BYTES !== 0) return [];
  return decodeWinEvents(bytes.subarray(0, n), n);
};
/** The first record of a read, or a shape that fails an assertion readably. */
const first = (bytes, n) => decode(bytes, n)[0] || { type: -1, mods: -1, a: -1, b: -1, c: -1 };
/** A key event's text, or "<none>". */
const keyText = (ev) => {
  const bytes = keyBytesOf(ev);
  return bytes.length ? DEC.decode(bytes) : "<none>";
};

/** One window, outside a manager: every test that is about a window and not about the table. */
const lone = (spec = {}) => new Window(1, 7, spec);
const key = (text) => ({ type: WEV_KEY, ...packKeyBytes(new TextEncoder().encode(text)) });

// ---- the event queue ---------------------------------------------------------------------
{
  const w = lone({ title: "t" });
  const r = makeSlot();
  const into = new Uint8Array(WEV_BYTES * 4);
  reset();
  check("a fresh window is attached", w.attached, true);
  check("and has nothing pending", w.report().pending, 0);
  check("pushing an event takes it", w.push(key("a")), true);
  check("and queues it, because nobody was parked", w.report().pending, 1);
  // THE WAKE IS THE POINT. An event arrives by postMessage and so passes through no `reply`, which
  // is where `pollWake` is hooked (constraint 109/160) — so the window must call it itself or a
  // relay parked in `poll` sleeps until its timeout.
  check("and wakes any parked poll, which nothing else would", wakes, 1);
  const n = w.readEvents(r, r.seq, into, 0, into.length);
  check("a read takes one whole record", n, WEV_BYTES);
  check("which decodes as the key that was pushed", keyText(first(into, n)), "a");
  check("the queue is empty again", w.report().pending, 0);
}

// ---- the record floor: whole records only ------------------------------------------------
//
// A fixed-width record exists so that nobody has to re-assemble one across two readiness edges, so
// a buffer that could not hold one is an ERROR and not a short read.
{
  const w = lone();
  const r = makeSlot();
  const into = new Uint8Array(WEV_BYTES * 8);
  reset();
  w.push(key("a"));
  w.push(key("b"));
  w.push(key("c"));
  check("a read smaller than one record is refused", w.readEvents(r, r.seq, into, 0, WEV_BYTES - 1),
    -EINVAL);
  check("and the refusal is counted", w.report().shortReads, 1);
  check("nothing was consumed by the refusal", w.report().pending, 3);
  const n = w.readEvents(r, r.seq, into, 0, WEV_BYTES * 2 + 5);
  check("a read is floored to whole records", n, WEV_BYTES * 2);
  check("so the third is still queued", w.report().pending, 1);
  check("and the two that came out are whole", decode(into, n).length, 2);
}

// ---- parking, and the direct hand-off ----------------------------------------------------
{
  const w = lone();
  const r = makeSlot();
  reset();
  check("a read with nothing queued PARKS", w.readEvents(r, r.seq, r.bytes, 0, WEV_BYTES), null);
  // NOT 0. Zero means end of input, and an idle window is the normal state — a window that
  // answered 0 at idle would end a session every time the user stopped typing.
  check("and is recorded as a park", w.report().readerParks, 1);
  check("no reply yet", replies.length, 0);
  check("pushing hands the record straight to the parked reader", w.push(key("x")), true);
  check("the parked call was answered with the byte count", reply().r0, WEV_BYTES);
  check("with the record length as rlen", reply().rlen, WEV_BYTES);
  check("and the normal return status", reply().status, ST_RETURN);
  check("the record landed in the caller's own region",
    keyText(first(r.bytes, WEV_BYTES)), "x");
  check("and nothing was queued", w.report().pending, 0);
  check("the hand-off woke parked polls too", wakes, 1);
}

// ---- a stale record is skipped, never answered twice -------------------------------------
{
  const w = lone();
  const r = makeSlot();
  reset();
  w.readEvents(r, r.seq, r.bytes, 0, WEV_BYTES);
  r.seq += 1;                 // the call was answered by something else: an interrupt, a teardown
  check("pushing does not answer a call whose seq has moved", w.push(key("q")), true);
  check("no reply was made", replies.length, 0);
  check("the stale record was counted", w.report().stale, 1);
  check("and the event was queued instead of lost", w.report().pending, 1);
}

// ---- the write side ----------------------------------------------------------------------
{
  const w = lone();
  reset();
  const ENC = new TextEncoder();
  check("writing cells reports the count", w.writeCells(ENC.encode("hello")), 5);
  check("and posts them to the page", post().t, "win-out");
  check("tagged with the winid, because there is more than one window now", post().win, 1);
  check("as bytes", DEC.decode(post().bytes), "hello");
  // A COPY, NOT THE CALLER'S BUFFER. The source is the caller's SAB, which the caller may
  // overwrite the instant its call is answered.
  const src = ENC.encode("ab");
  reset();
  w.writeCells(src);
  src[0] = 90;
  check("the posted bytes are a copy of the caller's region", DEC.decode(post().bytes), "ab");
  check("an empty write posts nothing", w.writeCells(new Uint8Array(0)), 0);
  check("and really posts nothing", posts.length, 1);
}

// ---- destroy: the last record says why ---------------------------------------------------
{
  const w = lone();
  const r = makeSlot();
  const into = new Uint8Array(WEV_BYTES * 4);
  reset();
  w.push(key("a"));
  w.destroy();
  const n = w.readEvents(r, r.seq, into, 0, into.length);
  // THE QUEUE IS DISCARDED AND ONE RECORD REPLACES IT. A keystroke typed into a window that is
  // gone is not worth delivering; the reason the window went is.
  check("a destroyed window has exactly one record left", n, WEV_BYTES);
  const ev = first(into, n);
  check("and it is WEV_DESTROYED", ev.type, WEV_DESTROYED);
  check("naming the window that went", ev.a, 1);
  check("the next read is -EHOSTGONE", w.readEvents(r, r.seq, into, 0, into.length), -EHOSTGONE);
  check("and it is counted", w.report().goneReads, 1);
  check("a write refuses too", w.writeCells(new Uint8Array([65])), -EHOSTGONE);
  check("and that is counted", w.report().goneWrites, 1);
  // POLL MUST LEARN ABOUT IT WITHOUT READING FIRST.
  check("a destroyed window is readable, so a poller is not left asleep", w.readable(), true);
  check("is NOT writable, so a poller is not told to write into nothing", w.writable(), false);
  check("and reports a hangup", w.hungUp(), true);
  check("destroying twice answers nobody the second time", w.destroy(), 0);
}

// ---- a parked reader gets the notice, not a bare errno -----------------------------------
{
  const w = lone();
  const a = makeSlot();
  const b = makeSlot();
  reset();
  w.readEvents(a, a.seq, a.bytes, 0, WEV_BYTES);
  w.readEvents(b, b.seq, b.bytes, 0, WEV_BYTES);
  check("two readers are parked", w.report().parked, 2);
  w.destroy();
  check("the first is answered with a record", reply(0).r0, WEV_BYTES);
  check("and the record is the destroy notice", first(a.bytes, WEV_BYTES).type, WEV_DESTROYED);
  // The second has no record to be given, so it is answered the errno — IMMEDIATELY, and not on
  // its next call: a process parked in `read` will not make one.
  check("the second is answered -EHOSTGONE", reply(1).r0, -EHOSTGONE);
  check("in the error convention r1 === -1", reply(1).r1, -1);
}

// ---- overflow is bounded and counted, never silent ---------------------------------------
{
  const w = lone();
  reset();
  clock = 1000;
  check("the queue holds WIN_EVENT_CAP records", WIN_EVENT_BYTES / WEV_BYTES, WIN_EVENT_CAP);
  // THE FIRST EVENT IS DISTINGUISHABLE FROM THE REST, so "the oldest came out" is an assertion
  // and not a coincidence: with every record identical it held even under a mutation that dropped
  // the oldest to make room.
  w.push(key("1"));
  for (let i = 1; i < WIN_EVENT_CAP; i += 1) w.push(key("x"));
  check("and takes every one of them", w.report().pending, WIN_EVENT_CAP);
  check("the next is refused", w.push(key("y")), false);
  // A READER CANNOT GET THE EVENTS WITHOUT GETTING THE COUNT OF THE ONES IT IS MISSING. Same rule
  // as /dev/trace's dropped-record counter (src/kernel/devfs.mjs).
  check("and counted", w.report().dropped, 1);
  check("the counter is in the report whether or not it is zero", "dropped" in lone().report(),
    true);
  // THE OVERFLOW DROPS THE NEWEST, which is deliberate: the OLDEST event is the one whose age the
  // not-responding detector is measuring, so dropping it would hide the wedge it is detecting.
  const r = makeSlot();
  const into = new Uint8Array(WEV_BYTES);
  const got = w.readEvents(r, r.seq, into, 0, WEV_BYTES);
  check("the record that comes out is the oldest, not the newest",
    keyText(first(into, got)), "1");
}

// ---- the not-responding detector, both edges ---------------------------------------------
{
  const w = lone();
  const r = makeSlot();
  reset();
  clock = 10000;
  check("an idle window is not stale", w.staleMs(), 0);
  check("and reports no transition", w.sample(), -1);
  w.push(key("a"));
  w.push(key("b"));
  check("an event nobody took starts the clock", w.staleMs(), 0);
  clock = 10000 + NOT_RESPONDING_MS - 1;
  check("just under the threshold is still responding", w.sample(), -1);
  clock = 10000 + NOT_RESPONDING_MS;
  check("at the threshold the level goes to 1", w.sample(), 1);
  check("and the transition is reported ONCE, not per tick", w.sample(), -1);
  clock = 10000 + END_PROCESS_MS;
  check("at the second threshold the level goes to 2", w.sample(), 2);
  check("again only once", w.sample(), -1);

  // HYSTERESIS IS THE DRAIN AND NOT A SECOND TIME. A partial read of a stale queue is not a
  // recovery: a process taking one event of a hundred it has sat on is still not collecting.
  w.readEvents(r, r.seq, new Uint8Array(WEV_BYTES), 0, WEV_BYTES);
  checkThat("a partial read does not clear the stale clock", w.staleMs() > 0, w.staleMs());
  check("so the level does not drop", w.sample(), -1);
  w.readEvents(r, r.seq, new Uint8Array(WEV_BYTES), 0, WEV_BYTES);
  check("draining the queue clears the clock", w.staleMs(), 0);
  check("and the level drops back to 0", w.sample(), 0);
  // AN EVENT HANDED TO A PARKED READER NEVER STARTS THE CLOCK, because it was collected.
  w.readEvents(r, r.seq, r.bytes, 0, WEV_BYTES);
  w.push(key("c"));
  check("a collected event leaves the window responding", w.staleMs(), 0);
}

// ---- a destroyed window is not a slow one ------------------------------------------------
//
// THE REGRESSION THIS EXISTS FOR, inherited from M4a's console. `detach` cleared the queue and left
// `unreadSince` set, so `staleMs` kept growing against a window that no longer existed and `sample`
// reported level 2 for it — a "(Not Responding)" caption on a frame that is gone.
{
  const w = lone();
  reset();
  clock = 50000;
  w.push(key("a"));
  clock = 50000 + END_PROCESS_MS + 1;
  check("the wedged window reports level 2", w.sample(), 2);
  w.destroy();
  check("after destroy nothing is stale", w.staleMs(), 0);
  // A destroyed window reports NO transition at all, because the page has already been told the
  // frame is gone: a level change for it would be a caption on nothing.
  check("and no further level is reported", w.sample(), -1);
  clock = 50000 + END_PROCESS_MS * 10;
  check("however long it has been gone", w.sample(), -1);
}

// ---- close cannot drive the open count negative ------------------------------------------
{
  const w = lone();
  w.close(); w.close(); w.close();
  check("opens never goes negative", w.report().opens, 0);
}

// ---- the resize event, and the move that is not one --------------------------------------
{
  const w = lone();
  reset();
  w.setBox({ x: 10, y: 20, w: 300, h: 200, cols: 40, rows: 12 });
  check("the box is recorded", [w.box.x, w.box.y, w.box.w, w.box.h], [10, 20, 300, 200]);
  check("a first geometry raises a resize", w.report().pending, 1);
  const r = makeSlot();
  const into = new Uint8Array(WEV_BYTES);
  w.readEvents(r, r.seq, into, 0, WEV_BYTES);
  const ev = first(into, WEV_BYTES);
  check("carrying the CELL count, which is what a pty needs", [ev.type, ev.a, ev.b],
    [WEV_RESIZE, 40, 12]);
  // A MOVE IS NOT A RESIZE. An event per pointermove would exhaust the queue this window is
  // budgeted, and nothing in the system acts on a window's position.
  w.setBox({ x: 99, y: 99, w: 300, h: 200, cols: 40, rows: 12 });
  check("moving the window raises nothing", w.report().pending, 0);
  check("but the new position is recorded", [w.box.x, w.box.y], [99, 99]);
  w.setBox({ x: 99, y: 99, w: 320, h: 200, cols: 42, rows: 12 });
  check("a changed cell count raises one", w.report().pending, 1);
}

// ---- the table: create, the cap, and the owner refusals ----------------------------------
{
  const mgr = new WinMgr();
  reset();
  const a = mgr.create(10, { title: "a" });
  check("a create returns a window", a.id, 1);
  check("and tells the page to build a frame", post().t, "win-create");
  check("with the winid, the pid and the owner", [post().win, post().pid, post().owner],
    [1, 10, 0]);
  check("winids start at 1, so 0 can mean no owner", mgr.get(1).id, 1);
  const b = mgr.create(10, { title: "b", owner: 1 });
  check("a second window may name the first as its owner", b.owner, 1);
  check("and the owner records the child", mgr.get(1).children, [2]);
  // CROSS-PROCESS OWNERSHIP IS THE POINT, not an accident: a picker broker parents its dialog onto
  // the requesting app's window, and that window belongs to the app.
  const c = mgr.create(99, { title: "c", owner: 1 });
  check("a DIFFERENT process may own onto it too", [c.pid, c.owner], [99, 1]);
  check("and the owner records both children", mgr.get(1).children, [2, 3]);
  check("a window of pid 10 is listed under pid 10", mgr.ofPid(10).map((w) => w.id), [1, 2]);
  check("and not under pid 99", mgr.ofPid(99).map((w) => w.id), [3]);
  // An owner that does not exist, and one that is gone. ENOENT and not EINVAL: the argument is
  // well-formed and the window is absent.
  check("an owner that never existed is -ENOENT", mgr.create(10, { owner: 404 }), -ENOENT);
  mgr.destroyTree(3);
  check("an owner that has been destroyed is -ENOENT too", mgr.create(10, { owner: 3 }), -ENOENT);
  check("and both refusals are counted", mgr.report().refusedOwner, 2);
}

// ---- the per-process cap -----------------------------------------------------------------
{
  const mgr = new WinMgr();
  reset();
  for (let i = 0; i < WIN_CAP; i += 1) {
    checkThat(i === 0 ? "the first window of a process is created" : "", true, null);
    results.pop();            // only the shape matters here; the refusal below is the assertion
    mgr.create(5, {});
  }
  check("a process at the cap is refused -EMFILE", mgr.create(5, {}), -EMFILE);
  check("and it is counted", mgr.report().refusedCap, 1);
  check("ANOTHER process is unaffected: the cap is per process", typeof mgr.create(6, {}), "object");
  // A DESTROYED WINDOW DOES NOT COUNT AGAINST THE CAP, or a long-lived process would run out of
  // windows it no longer has.
  mgr.destroyTree(1);
  check("destroying one makes room again", typeof mgr.create(5, {}), "object");
}

// ---- the destroy cascade -----------------------------------------------------------------
{
  const mgr = new WinMgr();
  reset();
  const root = mgr.create(1, { title: "root" });
  const mid = mgr.create(1, { title: "mid", owner: root.id });
  const leaf = mgr.create(2, { title: "leaf", owner: mid.id });
  const other = mgr.create(1, { title: "other" });
  reset();
  const ids = mgr.destroyTree(root.id);
  // OLDEST ANCESTOR FIRST, so a caller that walks the list in order sees the parent before the
  // child it belonged to.
  check("destroying the root reports every id, ancestor first", ids, [root.id, mid.id, leaf.id]);
  check("and every one of them is destroyed",
    [mgr.get(root.id).destroyed, mgr.get(mid.id).destroyed, mgr.get(leaf.id).destroyed],
    [true, true, true]);
  // THE CASCADE CROSSES PROCESSES. `leaf` belongs to pid 2 and went with pid 1's window, which is
  // the authority a child accepts by naming a parent.
  check("including the one belonging to another process", mgr.get(leaf.id).pid, 2);
  check("an unrelated window is untouched", mgr.get(other.id).destroyed, false);
  check("the page is told once, with the whole list", postsOf("win-destroy").length, 1);
  // AGAINST THE EXPECTED LIST AND NOT AGAINST `ids`: both travel out of the same call, so a
  // mutation that shortened both would leave this clause green (constraint 120).
  check("and the list it is told is the same one the caller got",
    postsOf("win-destroy")[0].ids, [1, 2, 3]);
  check("the cascade is counted as the EXTRA windows it took", mgr.report().cascaded, 2);
  // IT TRAVELS IN ONE DIRECTION ONLY: a child's destruction never reaches its parent.
  const p = mgr.create(3, { title: "parent" });
  const kid = mgr.create(3, { title: "kid", owner: p.id });
  check("destroying a child reports only the child", mgr.destroyTree(kid.id), [kid.id]);
  check("and its parent survives", mgr.get(p.id).destroyed, false);
  check("destroying an already-destroyed window reports nothing", mgr.destroyTree(kid.id), []);
}

// ---- the health sweep is edge-triggered and over the interested set ----------------------
{
  const mgr = new WinMgr();
  reset();
  clock = 1000;
  const a = mgr.create(1, {});
  const b = mgr.create(1, {});
  check("a quiet table reports no transitions", mgr.sample(), []);
  a.push(key("a"));
  clock = 1000 + NOT_RESPONDING_MS;
  const moved = mgr.sample();
  check("only the window that went stale is reported", moved.map((m) => m.win), [a.id]);
  check("with its level and its age", [moved[0].level, moved[0].staleMs],
    [1, NOT_RESPONDING_MS]);
  check("and the quiet one is not mentioned at all", mgr.sample(), []);
  check("the other window's level never moved", b.level, 0);
}

// ---- the table drops rows nobody can reach ----------------------------------------------
{
  const mgr = new WinMgr();
  reset();
  const a = mgr.create(1, {});
  mgr.destroyTree(a.id);
  check("a destroyed window is KEPT while a description holds it", mgr.sweep(), 0);
  checkThat("so its fd can still answer -EHOSTGONE rather than -EBADF",
    mgr.get(a.id) !== null, mgr.report());
  a.close();
  check("once nothing holds it, the row goes", mgr.sweep(), 1);
  check("and it is no longer in the table", mgr.get(a.id), null);
  // AND THE ID IS NOT REUSED, for the reason a pid is not: an owner winid held by another process
  // must not come to name a different window.
  const b = mgr.create(1, {});
  checkThat("the next window gets a fresh id", b.id > a.id, { next: b.id, gone: a.id });
}

// ---- an unknown event type is refused, not queued ---------------------------------------
{
  const mgr = new WinMgr();
  const w = mgr.create(1, {});
  reset();
  check("a type of 0 is refused", mgr.feed(w.id, { type: 0 }), false);
  check("a type past the last one is refused", mgr.feed(w.id, { type: 99 }), false);
  check("nothing was queued", w.report().pending, 0);
  check("a known type is taken", mgr.feed(w.id, { type: WEV_CLOSE }), true);
  check("feeding an unknown window is refused rather than throwing",
    mgr.feed(12345, { type: WEV_CLOSE }), false);
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  ok: failed.length === 0, total: results.length, failed: failed.length, failures: failed,
}, null, 2));
process.exit(failed.length ? 1 : 0);
