// `/dev/console` under plain Node, against hand-built slots.
//
// What this CAN cover: the keystroke queue, the park/wake bookkeeping, the detach semantics, and
// the not-responding detector's two edges. All of it is a kernel object over a ByteRing with an
// injected surface, so the whole device is host-testable and the fast loop costs milliseconds.
//
// What it CANNOT cover is the syscall path into it, the `F_WIN` ops row, the `pollOne` row, or the
// window: those need a kernel and a DOM, and `www/m4a.html` drives them.
//
// THE FAKE KERNEL IS NOT GENTLER THAN THE REAL ONE (constraint 98): `reply` bumps `slot.seq`, which
// is what makes a record stale, and `pollWake` is counted — M4a's whole wake path is one call that
// nothing else makes, so a probe that let it be absent would be checking the opposite of the point.
import {
  Console, installConsoleKernel, CONSOLE_INPUT_BYTES, NOT_RESPONDING_MS, END_PROCESS_MS,
} from "../../src/kernel/console.mjs";
import { EHOSTGONE, MAX_INLINE, ST_RETURN } from "../../src/abi.mjs";

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
installConsoleKernel({
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
const ENC = new TextEncoder(), DEC = new TextDecoder();

// ---- the queue --------------------------------------------------------------------------
{
  const con = new Console();
  const r = makeSlot();
  const into = new Uint8Array(64);
  reset();
  check("a fresh console is attached", con.attached, true);
  check("and has nothing queued", con.report().queued, 0);
  check("feeding takes every byte", con.feed(ENC.encode("abc")), 3);
  check("and queues them, because nobody was parked", con.report().queued, 3);
  // THE WAKE IS THE POINT. A keystroke arrives by postMessage and so passes through no `reply`,
  // which is where `pollWake` is hooked (constraint 109/160) — so the device must call it itself or
  // a relay parked in `poll` sleeps until its timeout.
  check("and wakes any parked poll, which nothing else would", wakes, 1);
  check("a read takes what is there", con.readKeys(r, r.seq, into, 0, 64), 3);
  check("and the bytes are right", DEC.decode(into.subarray(0, 3)), "abc");
  check("the queue is empty again", con.report().queued, 0);
}

// ---- parking, and the direct hand-off ---------------------------------------------------
{
  const con = new Console();
  const r = makeSlot();
  reset();
  check("a read with nothing queued PARKS", con.readKeys(r, r.seq, r.bytes, 0, 8), null);
  // NOT 0. Zero means end of input, and an idle terminal is the normal state — a console that
  // answered 0 at idle would log the user out every time they stopped typing.
  check("and is recorded as a park", con.report().readerParks, 1);
  check("no reply yet", replies.length, 0);
  check("feeding hands the bytes straight to the parked reader", con.feed(ENC.encode("hi")), 2);
  check("the parked call was answered with the count", reply().r0, 2);
  check("with the byte length as rlen", reply().rlen, 2);
  check("and the normal return status", reply().status, ST_RETURN);
  check("the bytes landed in the caller's own region", DEC.decode(r.bytes.subarray(0, 2)), "hi");
  check("and nothing was queued", con.report().queued, 0);
  // A reader parked on a SHORT want must still be woken, and the remainder queued.
  const r2 = makeSlot();
  reset();
  check("a short read parks", con.readKeys(r2, r2.seq, r2.bytes, 0, 2), null);
  check("a longer feed satisfies it and queues the rest", con.feed(ENC.encode("abcde")), 5);
  check("the parked reader got its two", reply().r0, 2);
  check("and three are left queued", con.report().queued, 3);
}

// ---- a stale record is skipped, never answered twice ------------------------------------
{
  const con = new Console();
  const r = makeSlot();
  reset();
  con.readKeys(r, r.seq, r.bytes, 0, 8);
  r.seq += 1;                 // the call was answered by something else: an interrupt, a teardown
  check("feeding does not answer a call whose seq has moved", con.feed(ENC.encode("x")), 1);
  check("no reply was made", replies.length, 0);
  check("the stale record was counted", con.report().stale, 1);
  check("and the byte was queued instead of lost", con.report().queued, 1);
}

// ---- the write side ----------------------------------------------------------------------
{
  const con = new Console();
  reset();
  check("writing cells reports the count", con.writeCells(ENC.encode("hello")), 5);
  check("and posts them to the page", post().t, "console-out");
  check("as bytes", DEC.decode(post().bytes), "hello");
  // A COPY, NOT THE CALLER'S BUFFER. The source is the caller's SAB, which the caller may
  // overwrite the instant its call is answered.
  const src = ENC.encode("ab");
  reset();
  con.writeCells(src);
  src[0] = 90;
  check("the posted bytes are a copy of the caller's region", DEC.decode(post().bytes), "ab");
  check("an empty write posts nothing", con.writeCells(new Uint8Array(0)), 0);
  check("and really posts nothing", posts.length, 1);
}

// ---- detach: EHOSTGONE, and the parked reader is answered NOW ---------------------------
{
  const con = new Console();
  const a = makeSlot(), b = makeSlot();
  reset();
  con.readKeys(a, a.seq, a.bytes, 0, 8);
  con.readKeys(b, b.seq, b.bytes, 0, 8);
  check("two readers are parked", con.report().parked, 2);
  check("detach answers both", con.detach(), 2);
  // IMMEDIATELY, and not on their next call: a process parked in `read` will not make one.
  check("with -EHOSTGONE", reply(0).r0, -EHOSTGONE);
  check("in the error convention r1 === -1", reply(0).r1, -1);
  check("and the second one too", reply(1).r0, -EHOSTGONE);
  check("a later read refuses rather than parking", con.readKeys(a, a.seq, a.bytes, 0, 8),
    -EHOSTGONE);
  check("a later write refuses too", con.writeCells(ENC.encode("x")), -EHOSTGONE);
  check("and both refusals are counted",
    [con.report().detachedReads, con.report().detachedWrites], [1, 1]);
  check("feeding a detached console takes nothing", con.feed(ENC.encode("x")), 0);
  // POLL MUST LEARN ABOUT IT WITHOUT READING FIRST.
  check("a detached console is readable, so a poller is not left asleep", con.readable(), true);
  check("and is NOT writable, so a poller is not told to write into nothing", con.writable(),
    false);
  check("and reports a hangup", con.hungUp(), true);
  check("detaching twice answers nobody the second time", con.detach(), 0);
}

// ---- the not-responding detector, both edges --------------------------------------------
{
  const con = new Console();
  const r = makeSlot();
  reset();
  clock = 10000;
  // A PROCESS HAS OPENED THIS DEVICE, which is what makes the question "is it responding" mean
  // anything at all. Without it the device is STARTING and the detector correctly stays quiet —
  // see the starting-is-not-wedged section below, which is the defect this line encodes.
  con.openedEver = true;
  check("an idle console is not stale", con.staleMs(), 0);
  // ACQUIRING AN OPENER IS A TRANSITION, and the page needs it: the level does not move when a
  // relay finally opens the device, so a page told only about levels would leave "(Starting…)" on
  // a working terminal for ever. Both axes are reported.
  check("acquiring an opener is itself a transition", con.sample(), 0);
  check("and then it is quiet", con.sample(), -1);
  con.feed(ENC.encode("xyz"));
  check("a keystroke nobody took starts the clock", con.staleMs(), 0);
  clock = 10000 + NOT_RESPONDING_MS - 1;
  check("just under the threshold is still responding", con.sample(), -1);
  clock = 10000 + NOT_RESPONDING_MS;
  check("at the threshold the level goes to 1", con.sample(), 1);
  check("and the transition is reported ONCE, not per tick", con.sample(), -1);
  clock = 10000 + END_PROCESS_MS;
  check("at the second threshold the level goes to 2", con.sample(), 2);
  check("again only once", con.sample(), -1);

  // HYSTERESIS IS THE DRAIN AND NOT A SECOND TIME. A partial read of a stale queue is not a
  // recovery: a process taking one byte of a thousand it has sat on is still not collecting.
  const one = new Uint8Array(1);
  con.readKeys(r, r.seq, one, 0, 1);
  checkThat("a partial read does not clear the stale clock", con.staleMs() > 0, con.staleMs());
  check("so the level does not drop", con.sample(), -1);
  con.readKeys(r, r.seq, new Uint8Array(8), 0, 8);
  check("draining the queue clears the clock", con.staleMs(), 0);
  check("and the level drops back to 0", con.sample(), 0);
  // A KEYSTROKE HANDED TO A PARKED READER NEVER STARTS THE CLOCK, because it was collected.
  con.readKeys(r, r.seq, r.bytes, 0, 8);
  con.feed(ENC.encode("q"));
  check("a collected keystroke leaves the console responding", con.staleMs(), 0);
}

// ---- STARTING IS NOT WEDGED -------------------------------------------------------------
//
// THE REGRESSION THIS EXISTS FOR, reported from a real browser as a terminal that said
// "(Not Responding)" while it was still coming up. The detector measured the age of the oldest
// uncollected keystroke and nothing more, so a relay that had not opened the device YET — spawn,
// program load, open, all of which take a moment — looked exactly like one that had died. A person
// who typed in that window got the wrong diagnosis about a working terminal.
{
  const con = new Console();
  const r = makeSlot();
  reset();
  clock = 100000;
  check("a device nobody has opened reports itself STARTING", con.starting(), true);
  con.feed(ENC.encode("typed-too-early"));
  clock = 100000 + END_PROCESS_MS * 3;
  // THE CLAUSE THAT WAS FALSE. Keystrokes queued, the clock long past both thresholds, and the
  // honest answer is still level 0: nothing is ignoring the input, nothing has claimed it yet.
  check("and never reports not-responding, however long the queue waits", con.sample(), -1);
  check("its level stays 0", con.level, 0);
  checkThat("while the queue is genuinely waiting", con.report().queued > 0, con.report());

  // THE FIRST OPEN IS WHAT ARMS THE DETECTOR. `openedEver` is set by the kernel's chardev arm; the
  // probe sets it directly because `open` is a syscall and this file has no kernel.
  con.openedEver = true;
  check("the transition out of starting is itself reported", con.sample(), 2);
  check("and starting is now false", con.starting(), false);

  // AND A DEVICE THAT WAS OPENED AND THEN CLOSED IS STILL ARMED, which is the real case: a relay
  // that died. `opens` falls back to 0 and `openedEver` does not.
  con.opens = 1;
  con.close();
  check("a closed device has no openers", con.report().opens, 0);
  check("but it is still armed, because its process DID open it", con.starting(), false);
  checkThat("so a dead emulator is still detected", con.staleMs() > END_PROCESS_MS,
    con.staleMs());
  // Draining clears it, as before.
  con.readKeys(r, r.seq, new Uint8Array(64), 0, 64);
  check("draining clears the clock", con.staleMs(), 0);
  check("and the level drops", con.sample(), 0);
}

// ---- a destroyed window is not a slow one -----------------------------------------------
//
// THE REGRESSION THIS EXISTS FOR. `detach` cleared the queue and left `unreadSince` set, so
// `staleMs` kept growing against a window that no longer existed and `sample` reported level 2 for
// it — a "(Not Responding)" caption on a frame that is gone, and a transition the page would have
// had to learn to ignore. Found by reading the code, not by a failing proof, which is why it is a
// check now.
{
  const con = new Console();
  reset();
  clock = 50000;
  con.openedEver = true;        // a relay had it; see above
  con.feed(ENC.encode("abc"));
  clock = 50000 + END_PROCESS_MS + 1;
  check("the wedged window reports level 2", con.sample(), 2);
  con.detach();
  check("after detach nothing is stale", con.staleMs(), 0);
  check("and the level drops rather than latching at 2", con.sample(), 0);
  clock = 50000 + END_PROCESS_MS * 10;
  check("and it stays dropped however long the window has been gone", con.sample(), -1);
}

// ---- overflow is counted, never silent --------------------------------------------------
{
  const con = new Console();
  reset();
  clock = 1000;
  const big = new Uint8Array(CONSOLE_INPUT_BYTES + 100).fill(65);
  check("a feed past the queue takes what fits", con.feed(big), CONSOLE_INPUT_BYTES);
  // A READER CANNOT GET THE KEYSTROKES WITHOUT GETTING THE COUNT OF THE ONES IT IS MISSING. Same
  // rule as /dev/trace's dropped-record counter (src/kernel/devfs.mjs).
  check("and counts the ones it dropped", con.report().dropped, 100);
  check("the counter is in the report whether or not it is zero",
    "dropped" in new Console().report(), true);
}

// ---- close cannot drive the open count negative -----------------------------------------
{
  const con = new Console();
  con.opens = 1;
  con.close(); con.close(); con.close();
  check("opens never goes negative", con.report().opens, 0);
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  ok: failed.length === 0, total: results.length, failed: failed.length, failures: failed,
}, null, 2));
process.exit(failed.length ? 1 : 0);
