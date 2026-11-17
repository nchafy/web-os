// `/dev/trace`: a fixed-size ring the kernel writes two records into per syscall. Always on, and
// THIS FILE READS NO CLOCK — every timestamp is passed in by the dispatcher. See `put`.
//
// THE RECORD IS 32 BYTES, derived rather than chosen: MILESTONES.md states a 1 MiB ring holds
// 32,768 records, and 1 MiB / 32,768 is 32. `selfTest` asserts the two agree.

/** Record field offsets, in bytes. One declaration; the DataView calls below are the only readers. */
export const TR_SEQ = 0;      // u32  monotonic record number, wraps at 2^32
export const TR_PID = 4;      // u32
export const TR_NR = 8;       // u16  syscall number
export const TR_KIND = 10;    // u8   TR_ENTER | TR_EXIT
export const TR_RSVD = 11;    // u8   zero, so a future field has somewhere to go
export const TR_R0 = 12;      // i32  a0 on entry, r0 on exit
// f64 ms from `performance.now()` IN THE KERNEL'S AGENT. NOT comparable across agents — each agent
// has its own time origin, so only DURATIONS cross the boundary (the rule src/abi.mjs states).
export const TR_TIME = 16;
export const TR_CALLID = 24;  // u32
export const TR_EXTRA = 28;   // u32  a1 on entry, reply length on exit

export const TRACE_RECORD_BYTES = 32;

export const TR_ENTER = 1;
export const TR_EXIT = 2;

/** The floor M3 requires: 16 MiB, which is 524,288 records. A 1 MiB ring holds 32,768 and wraps
 *  every 0.5 s at full syscall rate, inside a reader's sampling interval. */
export const TRACE_FLOOR_BYTES = 16 * 1024 * 1024;
export const TRACE_DEFAULT_BYTES = TRACE_FLOOR_BYTES;

/** Writes are typed-array stores and no allocation; anything that formats or allocates belongs in
 *  `renderTrace`, which runs only when something reads `/dev/trace`. */
export class TraceRing {
  /** `enforce` false undersizes the ring, which only M3's negative control does. */
  constructor(bytes = TRACE_DEFAULT_BYTES, { enforce = true } = {}) {
    if (enforce && bytes < TRACE_FLOOR_BYTES) {
      throw new Error(`a trace ring of ${bytes} B is below M3's ${TRACE_FLOOR_BYTES} B floor`);
    }
    // Floor to a whole number of records, so a partial record at the end can never be read.
    this.capacity = Math.max(1, Math.floor(bytes / TRACE_RECORD_BYTES));
    this.bytes = this.capacity * TRACE_RECORD_BYTES;
    this.buf = new ArrayBuffer(this.bytes);
    this.dv = new DataView(this.buf);
    /** Never reset: the only thing that orders two records after a wrap. */
    this.written = 0;
    this.enabled = true;
  }

  /**
   * Append one record; two calls per syscall. A full ring overwrites its oldest record and charges
   * `dropped`, because a trace that stops recording when it fills loses the end of the run.
   *
   * `t` IS PASSED IN, NEVER READ HERE. Measured (`node bench/m3-trace/probe.mjs`, Node 18.20.2,
   * darwin/arm64): the nine stores cost 9.0 ns, and a `Date.now()` among them cost 52.8 ns more.
   * The dispatcher already reads `performance.now()` twice per syscall for its own accounting.
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
   * Records overwritten, DERIVED from how far the ring has lapped so the number cannot disagree
   * with its contents. THERE IS NO READER CURSOR: one would make `stat` on `/dev/trace` consume
   * records, and two readers would see disjoint halves of one trace.
   */
  get dropped() {
    return Math.max(0, this.written - this.capacity);
  }

  get available() {
    return Math.min(this.written, this.capacity);
  }

  /** The newest `limit` records, OLDEST FIRST. Reading does not change the ring, and `seq`
   *  survives the wrap so a caller can tell which window it was given. */
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

/** The derivation MILESTONES.md publishes, asserted: "a 1 MiB ring holds 32,768 records" and
 *  "ship >=16 MiB" are arithmetic over TRACE_RECORD_BYTES, and a layout change breaks them. */
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
  // Both directions: the floor refuses, and the control's escape hatch still undersizes.
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
