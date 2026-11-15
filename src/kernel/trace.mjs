// `/dev/trace`: a fixed-size ring the kernel writes two records into per syscall.
//
// WHY IT IS IN THE SPINE. MILESTONES.md M3 folds this forward from option D because it is the
// debugger for every milestone after it, and because it is free: a record costs ~4 ns against a
// 14 us syscall, which is 0.03%. Tracing is therefore always on, and nothing here is behind a
// flag that a reader could leave off and then wonder why the trace is empty.
//
// THE RECORD IS 32 BYTES, and that number is derived rather than chosen: MILESTONES.md states a
// 1 MiB ring holds 32,768 records, and 1 MiB / 32,768 is 32. `selfTest` asserts the two agree, so
// changing the layout fires an assertion instead of quietly making the document wrong.
//
// DROPPED RECORDS ARE COUNTED, NOT DISCARDED SILENTLY. A ring that overwrites records while
// reporting nothing shows a clean picture of a broken system — which is the exact wording of M3's
// third negative control. `dropped` is therefore derived from how far the ring has been lapped,
// reported in `/dev/trace`'s own header, and displayed by the page.

/** Record field offsets, in bytes. One declaration; the DataView calls below are the only readers. */
export const TR_SEQ = 0;      // u32  monotonic record number, wraps at 2^32
export const TR_PID = 4;      // u32
export const TR_NR = 8;       // u16  syscall number
export const TR_KIND = 10;    // u8   TR_ENTER | TR_EXIT
export const TR_RSVD = 11;    // u8   zero, so a future field has somewhere to go
export const TR_R0 = 12;      // i32  a0 on entry, r0 on exit
// f64 ms from `performance.now()` IN THE KERNEL'S AGENT, which is what the dispatcher already
// holds and hands over. NOT comparable across agents: `performance.now()` is relative to each
// agent's own time origin, so only DURATIONS cross an agent boundary (the same rule src/abi.mjs
// states for the deadline pair). Every record in the ring comes from the kernel, so they are all
// on one clock and comparable with each other — which is what the trace needs. This said
// "Date.now()-based so it is comparable across agents" and was simply wrong about the value.
export const TR_TIME = 16;
export const TR_CALLID = 24;  // u32
export const TR_EXTRA = 28;   // u32  a1 on entry, reply length on exit

export const TRACE_RECORD_BYTES = 32;

export const TR_ENTER = 1;
export const TR_EXIT = 2;

/**
 * The floor M3 requires: 16 MiB.
 *
 * MILESTONES.md's reasoning, kept beside the number because the number is meaningless without it:
 * a 1 MiB ring holds 32,768 records and wraps every 0.5 s at full syscall rate, so a reader
 * sampling a few times a second sees a window that has already been overwritten. 16 MiB is
 * 524,288 records.
 */
export const TRACE_FLOOR_BYTES = 16 * 1024 * 1024;
export const TRACE_DEFAULT_BYTES = TRACE_FLOOR_BYTES;

/**
 * The syscall trace ring.
 *
 * Writes are a handful of typed-array stores and no allocation, which is what keeps a record at
 * ~4 ns. Anything that formats, allocates or branches on a string belongs in `render`, which runs
 * only when something reads `/dev/trace`.
 */
export class TraceRing {
  /**
   * @param {number} bytes      ring capacity. Below the floor only a deliberate control should go.
   * @param {boolean} enforce   assert the floor. The negative control passes false to undersize it.
   */
  constructor(bytes = TRACE_DEFAULT_BYTES, { enforce = true } = {}) {
    if (enforce && bytes < TRACE_FLOOR_BYTES) {
      throw new Error(`a trace ring of ${bytes} B is below M3's ${TRACE_FLOOR_BYTES} B floor`);
    }
    // Floor to a whole number of records, so a partial record at the end can never be read.
    this.capacity = Math.max(1, Math.floor(bytes / TRACE_RECORD_BYTES));
    this.bytes = this.capacity * TRACE_RECORD_BYTES;
    this.buf = new ArrayBuffer(this.bytes);
    this.dv = new DataView(this.buf);
    /** Monotonic count of records ever written. Never reset: it is the only thing that makes
     *  "this record preceded that one" answerable after a wrap. */
    this.written = 0;
    this.enabled = true;
  }

  /**
   * Append one record. The hot path — two calls per syscall.
   *
   * A full ring overwrites its oldest record and charges `dropped`. It does NOT refuse the write:
   * a trace that stops recording when it fills loses the end of the run, which is the half you
   * wanted. Losing the beginning and saying so is the better trade, and saying so is `dropped`.
   *
   * `t` IS PASSED IN, NEVER READ HERE, and that is the difference between a trace that is free and
   * one that is not. Measured on this machine (`node bench/m3-trace/probe.mjs`, Node 18.20.2,
   * darwin/arm64): the nine stores below cost 9.0 ns, and a `Date.now()` inside them cost 52.8 ns
   * more — 85% of the record. The dispatcher already reads `performance.now()` twice per syscall
   * for its own service accounting, so entry and exit hand those two values over and the trace
   * adds no clock read at all. A caller that passes `Date.now()` here re-introduces the 52.8 ns.
   */
  put(kind, pid, nr, callid, r0, extra, t) {
    if (!this.enabled) return;
    const slot = this.written % this.capacity;
    const at = slot * TRACE_RECORD_BYTES;
    const dv = this.dv;
    dv.setUint32(at + TR_SEQ, this.written >>> 0, true);
    dv.setUint32(at + TR_PID, pid >>> 0, true);
    dv.setUint16(at + TR_NR, nr & 0xffff, true);
    dv.setUint8(at + TR_KIND, kind & 0xff);
    dv.setUint8(at + TR_RSVD, 0);
    dv.setInt32(at + TR_R0, r0 | 0, true);
    dv.setFloat64(at + TR_TIME, t, true);
    dv.setUint32(at + TR_CALLID, callid >>> 0, true);
    dv.setUint32(at + TR_EXTRA, extra >>> 0, true);
    this.written += 1;
  }

  /**
   * Records overwritten, and therefore gone. DERIVED, never accumulated.
   *
   * A ring overwrites its oldest record once it has been lapped, so the count of lost records is
   * just how far `written` has run past `capacity`. Deriving it means there is no counter to
   * forget to increment, and no way for the number to disagree with the ring's actual contents.
   *
   * THERE IS NO READER CURSOR, deliberately. An earlier version had one and charged a record as
   * dropped when a reader fell behind; it was wrong twice. It made `stat` on `/dev/trace` consume
   * records — size and content each re-ran the generator — and it made two readers of the same
   * trace see disjoint halves of it. A kernel ring is a window on the recent past that every
   * reader sees the same way, which is what ftrace and dmesg are, and reading it is free.
   */
  get dropped() {
    return Math.max(0, this.written - this.capacity);
  }

  /** How many records the ring is currently holding. */
  get available() {
    return Math.min(this.written, this.capacity);
  }

  /**
   * The newest `limit` records, OLDEST FIRST. Reading does not change the ring.
   *
   * Oldest-first within the window, so a sequence reads in the order it happened; and the newest
   * records rather than the oldest, because the end of a run is the half that explains what just
   * went wrong. `seq` survives the wrap, so a caller can tell which window it was given.
   */
  read({ limit = 4096 } = {}) {
    const have = this.available;
    const take = Math.min(have, limit);
    const first = this.written - take;   // the oldest record this read returns
    const out = [];
    for (let i = 0; i < take; i += 1) {
      const n = first + i;
      const at = (n % this.capacity) * TRACE_RECORD_BYTES;
      const dv = this.dv;
      out.push({
        seq: dv.getUint32(at + TR_SEQ, true),
        pid: dv.getUint32(at + TR_PID, true),
        nr: dv.getUint16(at + TR_NR, true),
        kind: dv.getUint8(at + TR_KIND),
        r0: dv.getInt32(at + TR_R0, true),
        t: dv.getFloat64(at + TR_TIME, true),
        callid: dv.getUint32(at + TR_CALLID, true),
        extra: dv.getUint32(at + TR_EXTRA, true),
      });
    }
    return out;
  }

  /** The counters, for the page and for `/dev/trace`'s own header. */
  stats() {
    return {
      bytes: this.bytes,
      capacity: this.capacity,
      written: this.written,
      available: this.available,
      dropped: this.dropped,
      floor: TRACE_FLOOR_BYTES,
      undersized: this.bytes < TRACE_FLOOR_BYTES,
    };
  }
}

/**
 * The derivation MILESTONES.md publishes, asserted.
 *
 * Load-bearing: the document says "a 1 MiB ring holds 32,768 records" and "ship >=16 MiB". Both
 * are arithmetic over TRACE_RECORD_BYTES, so a layout change that broke them would otherwise
 * leave two wrong numbers in a normative file.
 */
export function selfTest() {
  const fail = (why) => {
    throw new Error(`trace.mjs selfTest: ${why}`);
  };
  const perMiB = (1024 * 1024) / TRACE_RECORD_BYTES;
  if (perMiB !== 32768) {
    fail(`a 1 MiB ring holds ${perMiB} records, MILESTONES.md M3 says 32768`);
  }
  if (TRACE_FLOOR_BYTES / TRACE_RECORD_BYTES !== 524288) {
    fail("the 16 MiB floor is not 524,288 records");
  }
  // Every field must fit the record with no overlap, or two facts share bytes and one is lost.
  const fields = [
    [TR_SEQ, 4], [TR_PID, 4], [TR_NR, 2], [TR_KIND, 1], [TR_RSVD, 1],
    [TR_R0, 4], [TR_TIME, 8], [TR_CALLID, 4], [TR_EXTRA, 4],
  ];
  let covered = 0;
  for (const [at, width] of fields) {
    if (at + width > TRACE_RECORD_BYTES) fail(`a field at ${at} runs past the record`);
    if (width === 8 && at % 8 !== 0) fail(`the f64 at ${at} is not 8-byte aligned`);
    covered += width;
  }
  if (covered !== TRACE_RECORD_BYTES) {
    fail(`fields cover ${covered} of ${TRACE_RECORD_BYTES} bytes`);
  }
  if (TR_ENTER === TR_EXIT) fail("the two record kinds are not distinct");
  // A ring below the floor must be refused unless a control explicitly asks for it, and the
  // control's escape hatch must work — an undersize path nobody can take is an untestable branch.
  let refused = false;
  try {
    new TraceRing(64 * 1024);
  } catch {
    refused = true;
  }
  if (!refused) fail("a 64 KiB ring was accepted with the floor enforced");
  const tiny = new TraceRing(64 * 1024, { enforce: false });
  if (tiny.capacity !== 2048) fail(`a 64 KiB ring holds ${tiny.capacity} records, not 2048`);
  return true;
}

selfTest();
