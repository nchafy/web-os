// The Pipe under plain Node, against hand-built slots.
//
// What this CAN cover: the ring, the park/wake bookkeeping, and the EOF-vs-EPIPE asymmetry that
// docs/ABI.md decision 5 says is worth restating because getting it backwards makes
// `yes | head -1` either hang or report a spurious error. What it CANNOT cover is the syscall path
// into it — that needs the kernel, and www/m4.html drives it.
import { Pipe, installPipeKernel } from "../../src/kernel/pipe.mjs";
import { PIPE_CAPACITY, MAX_INLINE, EPIPE, SIGPIPE, ST_RETURN } from "../../src/abi.mjs";

const results = [];
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  results.push({ name: n, ok, got: ok ? undefined : g, want: ok ? undefined : w });
};
const checkThat = (n, c, d) => results.push({ name: n, ok: !!c, detail: c ? undefined : d });

// A fake slot: the three fields a Pipe touches. `ctl` truthy means "alive"; `seq` is what the
// staleness guard compares. Nothing else of a process is reachable from a pipe, which is the
// point worth checking as much as the behaviour.
let nextPid = 1;
const makeSlot = () => ({ pid: nextPid++, ctl: {}, seq: 1, bytes: new Uint8Array(MAX_INLINE * 2) });

const replies = [];
const signals = [];
installPipeKernel({
  reply: (slot, r0, r1, status, rlen) => {
    replies.push({ pid: slot.pid, r0, r1, status, rlen });
    slot.seq += 1;            // what the real reply() does, and what makes a record stale
  },
  raise: (slot, sig) => { signals.push({ pid: slot.pid, sig }); },
});
const reset = () => { replies.length = 0; signals.length = 0; };
// SAFE ACCESSORS. Indexing `replies[0]` directly threw a TypeError under the mutation that
// reverses the EOF/EPIPE asymmetry — no reply was made, so `reply(0).r0` crashed the probe and
// it reported NOTHING instead of the failures it exists to report. A harness that dies on the
// failure it is testing for is worse than no harness.
const reply = (i = 0) => replies[i] || { pid: null, r0: "<no reply>", r1: null, status: null, rlen: null };
const signal = (i = 0) => signals[i] || { pid: null, sig: "<no signal>" };
const ENC = new TextEncoder(), DEC = new TextDecoder();

// ---- the ring ---------------------------------------------------------------------------
{
  const pipe = new Pipe(16);
  pipe.readers = 1; pipe.writers = 1;
  const w = makeSlot(), r = makeSlot();
  check("capacity is what it was built with", pipe.capacity, 16);
  check("a write inside the buffer takes it all", pipe.write(w, w.seq, ENC.encode("hello")), 5);
  check("and the pipe holds it", pipe.report().buffered, 5);
  const into = new Uint8Array(32);
  check("a read takes what is there", pipe.read(r, r.seq, into, 0, 32), 5);
  check("and the bytes are right", DEC.decode(into.subarray(0, 5)), "hello");
  check("the pipe is empty again", pipe.report().buffered, 0);

  // Wrapping: fill, drain part, write across the end of the ring.
  check("fill to capacity", pipe.write(w, w.seq, new Uint8Array(16).fill(65)), 16);
  check("a full pipe has no free space", pipe.report().free, 0);
  check("drain 10", pipe.read(r, r.seq, into, 0, 10), 10);
  check("a write wraps the ring", pipe.write(w, w.seq, ENC.encode("0123456789")), 10);
  check("and the pipe is full again", pipe.report().buffered, 16);
  const all = new Uint8Array(32);
  check("read everything back", pipe.read(r, r.seq, all, 0, 32), 16);
  checkThat("the wrapped bytes are in order",
    DEC.decode(all.subarray(0, 16)) === "AAAAAA0123456789", DEC.decode(all.subarray(0, 16)));
}

// ---- a short write when the pipe is nearly full ------------------------------------------
{
  const pipe = new Pipe(8);
  pipe.readers = 1; pipe.writers = 1;
  const w = makeSlot(), r = makeSlot();
  check("fill 6 of 8", pipe.write(w, w.seq, new Uint8Array(6)), 6);
  // A SHORT COUNT, not an error and not a park: there is room for some of it.
  check("a write that does not fit is short, not refused", pipe.write(w, w.seq, new Uint8Array(5)), 2);
  check("the pipe is full", pipe.report().free, 0);
}

// ---- PARKING: a reader with no data ------------------------------------------------------
{
  reset();
  const pipe = new Pipe(64);
  pipe.readers = 1; pipe.writers = 1;
  const r = makeSlot(), w = makeSlot();
  const into = new Uint8Array(64);
  check("a reader with no data parks", pipe.read(r, r.seq, into, 0, 8), null);
  check("and is recorded", pipe.report().waitingReaders, 1);
  check("nothing was replied yet", replies.length, 0);
  // The write hands bytes STRAIGHT to the parked reader.
  check("a write wakes it and reports its own count", pipe.write(w, w.seq, ENC.encode("abc")), 3);
  check("one reply went out", replies.length, 1);
  check("the reader got the byte count", reply(0).r0, 3);
  check("and RLEN so the libos knows how much", reply(0).rlen, 3);
  check("the bytes landed in the reader's buffer", DEC.decode(into.subarray(0, 3)), "abc");
  check("the pipe did not buffer them", pipe.report().buffered, 0);
  check("and no reader is waiting", pipe.report().waitingReaders, 0);
}

// ---- PARKING: a writer with no space -----------------------------------------------------
{
  reset();
  const pipe = new Pipe(4);
  pipe.readers = 1; pipe.writers = 1;
  const w = makeSlot(), r = makeSlot();
  check("fill it", pipe.write(w, w.seq, new Uint8Array(4).fill(1)), 4);
  check("a writer with no space parks", pipe.write(w, w.seq, new Uint8Array(3).fill(2)), null);
  check("and is recorded", pipe.report().waitingWriters, 1);
  check("nothing replied", replies.length, 0);
  const into = new Uint8Array(8);
  check("a read drains and wakes the writer", pipe.read(r, r.seq, into, 0, 4), 4);
  check("the writer was replied to", replies.length, 1);
  check("with its full count", reply(0).r0, 3);
  check("and its bytes are in the pipe", pipe.report().buffered, 3);
  const rest = new Uint8Array(8);
  pipe.read(r, r.seq, rest, 0, 8);
  check("which read back correctly", [...rest.subarray(0, 3)], [2, 2, 2]);
}

// ---- A WRITE LARGER THAN THE WHOLE PIPE makes progress in pieces, never deadlocks --------
{
  reset();
  const pipe = new Pipe(4);
  pipe.readers = 1; pipe.writers = 1;
  const w = makeSlot(), r = makeSlot();
  // 10 bytes into a 4-byte pipe: 4 land, the writer parks with the rest.
  check("an over-large write takes what fits", pipe.write(w, w.seq, new Uint8Array(10).fill(7)), 4);
  const into = new Uint8Array(16);
  let got = 0;
  for (let i = 0; i < 4; i += 1) {
    const n = pipe.read(r, r.seq, into, got, 16 - got);
    if (n === null) break;
    got += n;
  }
  checkThat("and the rest is readable, so it did not deadlock", got === 4, got);
}

// ---- THE ASYMMETRY: a reader whose last writer closed sees EOF, not an errno -------------
{
  reset();
  const pipe = new Pipe(64);
  pipe.readers = 1; pipe.writers = 1;
  const r = makeSlot();
  const into = new Uint8Array(8);
  check("the reader parks", pipe.read(r, r.seq, into, 0, 8), null);
  pipe.close(false);                       // the last writer goes
  check("it is replied to", replies.length, 1);
  check("with 0, meaning EOF", reply(0).r0, 0);
  check("and NOT an errno", reply(0).r1, 0);
  check("the reply is a normal return", reply(0).status, ST_RETURN);
  check("no signal was raised at a reader", signals.length, 0);
  // And a read AFTER the writers are gone is EOF immediately, without parking.
  const r2 = makeSlot();
  check("a later read is EOF with no park", pipe.read(r2, r2.seq, into, 0, 8), 0);
}

// ---- buffered bytes are delivered before EOF --------------------------------------------
{
  reset();
  const pipe = new Pipe(64);
  pipe.readers = 1; pipe.writers = 1;
  const w = makeSlot(), r = makeSlot();
  pipe.write(w, w.seq, ENC.encode("last words"));
  pipe.close(false);                       // writer wrote, then closed
  const into = new Uint8Array(32);
  check("a writer that wrote then closed does not lose the write",
    pipe.read(r, r.seq, into, 0, 32), 10);
  check("the bytes survived the close", DEC.decode(into.subarray(0, 10)), "last words");
  check("and only then is it EOF", pipe.read(r, r.seq, into, 0, 32), 0);
}

// ---- THE ASYMMETRY: a writer whose last reader closed gets -EPIPE AND SIGPIPE ------------
{
  reset();
  const pipe = new Pipe(4);
  pipe.readers = 1; pipe.writers = 1;
  const w = makeSlot();
  pipe.close(true);                        // the last reader goes
  check("a write with no reader is -EPIPE", pipe.write(w, w.seq, ENC.encode("x")), -EPIPE);
  check("and SIGPIPE was raised", signals.length, 1);
  check("at the writer", signal(0).pid, w.pid);
  check("with the right signal", signal(0).sig, SIGPIPE);
}

// ---- a PARKED writer whose reader then closes gets both too -------------------------------
{
  reset();
  const pipe = new Pipe(4);
  pipe.readers = 1; pipe.writers = 1;
  const w = makeSlot();
  pipe.write(w, w.seq, new Uint8Array(4));
  check("the writer parks", pipe.write(w, w.seq, new Uint8Array(2)), null);
  pipe.close(true);                        // the reader dies while a writer waits
  check("the parked writer was replied to", replies.length, 1);
  check("with -EPIPE", reply(0).r0, -EPIPE);
  check("and the error sentinel in r1", reply(0).r1, -1);
  check("and SIGPIPE was raised", signals.filter((s) => s.sig === SIGPIPE).length, 1);
  check("no writer is left waiting", pipe.report().waitingWriters, 0);
}

// ---- STALE RECORDS are skipped by sequence, never replied into --------------------------
{
  reset();
  const pipe = new Pipe(64);
  pipe.readers = 1; pipe.writers = 1;
  const r = makeSlot(), w = makeSlot();
  const into = new Uint8Array(8);
  pipe.read(r, r.seq, into, 0, 8);
  check("a reader is parked", pipe.report().waitingReaders, 1);
  // The call was answered by something else -- an intr, a teardown, a panic. All bump seq.
  r.seq += 1;
  check("a write does not reply into the answered call", pipe.write(w, w.seq, ENC.encode("zz")), 2);
  check("nobody was replied to", replies.length, 0);
  check("the record was dropped", pipe.report().waitingReaders, 0);
  check("and counted as stale", pipe.report().stale >= 1, true);
  check("the bytes stayed in the pipe for the next reader", pipe.report().buffered, 2);

  // A dead slot (ctl nulled by table.free) is also skipped.
  reset();
  const dead = makeSlot();
  pipe.read(dead, dead.seq, into, 0, 8);
  pipe.read(dead, dead.seq, into, 0, 8);   // drain the 2 buffered bytes first
  dead.ctl = null;
  pipe.write(w, w.seq, ENC.encode("q"));
  checkThat("a reply never goes to a freed slot", replies.every((x) => x.pid !== dead.pid),
    replies);
}

// ---- A FATAL SIGPIPE ANSWERS THE CALL, so the pipe must NOT answer it again -------------
//
// The earlier fake `raise` did not reap, so this whole class was invisible: a fatal SIGPIPE reaps
// the slot, teardown's `answerInflight` replies, and a pipe that then returned an errno produced
// TWO replies for one call. `reply` is the single writer of G_INFLIGHT, so the depth gauge drifts
// negative and the issued == replied identity the syscall check asserts breaks.
{
  // A raise that behaves like a FATAL one: nulls `inflight` and bumps `seq`, which is exactly what
  // `reap` -> `teardown` -> `answerInflight` -> `reply` does to a slot.
  const reaped = [];
  installPipeKernel({
    reply: (slot, r0, r1, status, rlen) => {
      replies.push({ pid: slot.pid, r0, r1, status, rlen });
      slot.seq += 1;
    },
    raise: (slot, sig) => {
      signals.push({ pid: slot.pid, sig });
      if (sig === SIGPIPE) {
        reaped.push(slot.pid);
        slot.inflight = null;      // answerInflight replied
        slot.seq += 1;             // and that reply bumped the sequence
      }
    },
  });

  // (a) the SYNCHRONOUS path: a write with no reader at all.
  reset();
  const pipe = new Pipe(8);
  pipe.readers = 1; pipe.writers = 1;
  const w = makeSlot();
  w.inflight = { nr: 1 };          // a call is in flight, as it is during a real write
  pipe.close(true);                // the reader goes
  const r = pipe.write(w, w.seq, ENC.encode("x"));
  check("a write whose fatal SIGPIPE killed the writer returns null, not an errno", r, null);
  check("and the pipe did not reply", replies.length, 0);
  check("the signal was raised", signals.length, 1);
  check("and it is counted as a kill rather than an errno", pipe.report().killedByEpipe, 1);

  // (b) the PARKED path: a writer already blocked when its reader goes.
  reset();
  const pipe2 = new Pipe(4);
  pipe2.readers = 1; pipe2.writers = 1;
  const w2 = makeSlot();
  w2.inflight = { nr: 1 };
  pipe2.write(w2, w2.seq, new Uint8Array(4));
  w2.seq += 1;                     // that write was answered
  w2.inflight = { nr: 1 };         // a second write is now in flight
  check("the writer parks", pipe2.write(w2, w2.seq, new Uint8Array(2)), null);
  reset();
  pipe2.close(true);               // the reader dies while the writer waits
  check("a parked writer killed by its own SIGPIPE is not replied to twice", replies.length, 0);
  check("the signal reached it", signals.filter((s) => s.sig === SIGPIPE).length, 1);
  check("and it is counted", pipe2.report().killedByEpipe, 1);
  check("no writer is left waiting", pipe2.report().waitingWriters, 0);

  // (c) a SURVIVING writer — SIGPIPE ignored or handled — still gets its errno.
  reset();
  installPipeKernel({
    reply: (slot, r0, r1, status, rlen) => {
      replies.push({ pid: slot.pid, r0, r1, status, rlen }); slot.seq += 1;
    },
    raise: (slot, sig) => { signals.push({ pid: slot.pid, sig }); },   // non-fatal: nothing reaped
  });
  const pipe3 = new Pipe(8);
  pipe3.readers = 1; pipe3.writers = 1;
  const w3 = makeSlot();
  w3.inflight = { nr: 1 };
  pipe3.close(true);
  check("a writer that SURVIVES its SIGPIPE gets -EPIPE", pipe3.write(w3, w3.seq, ENC.encode("x")),
    -EPIPE);
  check("and nothing was counted as a kill", pipe3.report().killedByEpipe, 0);
}

// Restore the plain kernel for the remaining cases.
reset();
installPipeKernel({
  reply: (slot, r0, r1, status, rlen) => {
    replies.push({ pid: slot.pid, r0, r1, status, rlen }); slot.seq += 1;
  },
  raise: (slot, sig) => { signals.push({ pid: slot.pid, sig }); },
});

// ---- the default capacity holds one maximal write ---------------------------------------
{
  const pipe = new Pipe();
  pipe.readers = 1; pipe.writers = 1;
  const w = makeSlot();
  check("the default is PIPE_CAPACITY", pipe.capacity, PIPE_CAPACITY);
  check("one maximal ABI write fits in an empty pipe",
    pipe.write(w, w.seq, new Uint8Array(MAX_INLINE)), MAX_INLINE);
}

// ---- close is idempotent and cannot drive a count negative ------------------------------
{
  const pipe = new Pipe(8);
  pipe.readers = 1; pipe.writers = 1;
  pipe.close(true); pipe.close(true); pipe.close(true);
  pipe.close(false); pipe.close(false);
  check("readers never goes negative", pipe.report().readers, 0);
  check("writers never goes negative", pipe.report().writers, 0);
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  ok: failed.length === 0, total: results.length, failed: failed.length, failures: failed,
}, null, 2));
process.exit(failed.length ? 1 : 0);
