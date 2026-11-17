// The journal record codec. PURE over byte arrays: no OPFS, no SAB, no Worker, nothing async.
// Replay is a parser over bytes that may be torn mid-write, and it is a fuzz target only while it
// runs in plain Node in milliseconds. All I/O stays at the edges, in src/kernel/.
//
// Record layout, little-endian:
//
//   u32  MAGIC      'WJ1\0' — a torn tail usually fails here first, and cheaply
//   u32  len        payload length in bytes, 0 .. MAX_PAYLOAD
//   u64  seq        monotonic record sequence (lo, hi) — replay stops at the first gap
//   u32  crc        CRC-32 over [MAGIC .. payload end), with this field read as zero
//   u8[] payload
//
// The CRC covers the HEADER as well as the payload, so a flipped length or seq is caught. Covering
// only the payload lets a corrupt length through — the field a parser is most dangerous trusting.

import { crc32 } from "./crc32.mjs";

export const JOURNAL_MAGIC = 0x314a57;        // 'WJ1'
export const HEADER_BYTES = 24;
/** A record larger than this is refused rather than allocated. A length field is attacker-shaped
 *  input even when the only attacker is a half-finished write. */
export const MAX_PAYLOAD = 1 << 20;

const OFF_MAGIC = 0;
const OFF_LEN = 4;
const OFF_SEQ_LO = 8;
const OFF_SEQ_HI = 12;
const OFF_CRC = 16;
// 20..23 reserved, written zero, covered by the CRC so a future field cannot be silently ignored.
const OFF_RESERVED = 20;

/** A reason, never a bare false: replay reports which tear it found. */
export const REFUSE = Object.freeze({
  SHORT_HEADER: "short-header",
  BAD_MAGIC: "bad-magic",
  BAD_LENGTH: "bad-length",
  SHORT_PAYLOAD: "short-payload",
  BAD_CRC: "bad-crc",
  BAD_RESERVED: "bad-reserved",
});

export function encodeRecord(seq, payload) {
  if (payload.length > MAX_PAYLOAD) {
    throw new RangeError(`journal payload ${payload.length} exceeds MAX_PAYLOAD ${MAX_PAYLOAD}`);
  }
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(OFF_MAGIC, JOURNAL_MAGIC, true);
  dv.setUint32(OFF_LEN, payload.length, true);
  dv.setUint32(OFF_SEQ_LO, Number(BigInt(seq) & 0xffffffffn), true);
  dv.setUint32(OFF_SEQ_HI, Number((BigInt(seq) >> 32n) & 0xffffffffn), true);
  dv.setUint32(OFF_CRC, 0, true);
  dv.setUint32(OFF_RESERVED, 0, true);
  out.set(payload, HEADER_BYTES);
  dv.setUint32(OFF_CRC, crc32(out), true);
  return out;
}

/**
 * @returns {{ok: true, seq: bigint, payload: Uint8Array, size: number}}
 *        | {{ok: false, why: string, at: number}}
 *
 * Never throws on malformed input, and never allocates on the strength of an unvalidated length.
 */
export function decodeRecord(bytes, off = 0, opts = {}) {
  const checkCrc = opts.checkCrc !== false;
  if (off + HEADER_BYTES > bytes.length) return { ok: false, why: REFUSE.SHORT_HEADER, at: off };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(off + OFF_MAGIC, true) !== JOURNAL_MAGIC) {
    return { ok: false, why: REFUSE.BAD_MAGIC, at: off };
  }
  const len = dv.getUint32(off + OFF_LEN, true);
  // Checked BEFORE it is used for anything, including arithmetic that could overflow a length.
  if (len > MAX_PAYLOAD) return { ok: false, why: REFUSE.BAD_LENGTH, at: off };
  const size = HEADER_BYTES + len;
  if (off + size > bytes.length) return { ok: false, why: REFUSE.SHORT_PAYLOAD, at: off };
  if (dv.getUint32(off + OFF_RESERVED, true) !== 0) {
    return { ok: false, why: REFUSE.BAD_RESERVED, at: off };
  }
  if (checkCrc) {
    const want = dv.getUint32(off + OFF_CRC, true);
    // Recompute over a copy with the CRC field zeroed, which is how it was computed.
    const span = bytes.slice(off, off + size);
    new DataView(span.buffer).setUint32(OFF_CRC, 0, true);
    if (crc32(span) !== want) return { ok: false, why: REFUSE.BAD_CRC, at: off };
  }
  const seq = (BigInt(dv.getUint32(off + OFF_SEQ_HI, true)) << 32n)
    | BigInt(dv.getUint32(off + OFF_SEQ_LO, true));
  return { ok: true, seq, payload: bytes.subarray(off + HEADER_BYTES, off + size), size };
}

/** Stops at the first record it will not accept and reports the discarded tail rather than
 *  reseeding (constraint 28). A sequence GAP also stops it: applying records whose predecessor is
 *  missing would build state nobody wrote. */
export function replay(bytes, opts = {}) {
  const records = [];
  let off = 0;
  let expect = opts.firstSeq === undefined ? null : BigInt(opts.firstSeq);
  while (off < bytes.length) {
    const r = decodeRecord(bytes, off, opts);
    if (!r.ok) {
      return { records, consumed: off, discardedBytes: bytes.length - off, stopped: r.why,
               stoppedAt: off };
    }
    if (expect !== null && r.seq !== expect) {
      return { records, consumed: off, discardedBytes: bytes.length - off,
               stopped: "seq-gap", stoppedAt: off, wantSeq: String(expect), gotSeq: String(r.seq) };
    }
    records.push({ seq: r.seq, payload: r.payload });
    expect = r.seq + 1n;
    off += r.size;
  }
  return { records, consumed: off, discardedBytes: 0, stopped: null, stoppedAt: off };
}
