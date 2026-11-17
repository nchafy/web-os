// The superblock codec. PURE over byte arrays, for the same reason as the journal codec.
//
// `generation` and `major`/`minor` are written though nothing reads them yet: adding a version
// field to a format already holding user data is the change that cannot be made compatibly, and
// without a generation "which slot is newer" has no answer.
//
// Layout, little-endian:
//   u32 MAGIC 'WS1\0' · u16 major · u16 minor · u64 generation · u64 inodeCount
//   u64 nextIno · u32 crc (read as zero while computing) · u32 reserved (zero, CRC-covered)

import { crc32 } from "./crc32.mjs";

export const SUPER_MAGIC = 0x315357;          // 'WS1'
export const SUPER_BYTES = 40;
export const SUPER_MAJOR = 1;
export const SUPER_MINOR = 0;

const OFF_MAGIC = 0;
const OFF_MAJOR = 4;
const OFF_MINOR = 6;
const OFF_GEN_LO = 8;
const OFF_GEN_HI = 12;
const OFF_COUNT_LO = 16;
const OFF_COUNT_HI = 20;
const OFF_NEXT_LO = 24;
const OFF_NEXT_HI = 28;
const OFF_CRC = 32;
const OFF_RESERVED = 36;

export const SUPER_REFUSE = Object.freeze({
  SHORT: "short",
  BAD_MAGIC: "bad-magic",
  BAD_CRC: "bad-crc",
  FUTURE_MAJOR: "future-major",
  BAD_RESERVED: "bad-reserved",
});

const lo = (v) => Number(BigInt(v) & 0xffffffffn);
const hi = (v) => Number((BigInt(v) >> 32n) & 0xffffffffn);
const join = (dv, a, b) => (BigInt(dv.getUint32(b, true)) << 32n) | BigInt(dv.getUint32(a, true));

export function encodeSuperblock({ generation, inodeCount, nextIno }) {
  const out = new Uint8Array(SUPER_BYTES);
  const dv = new DataView(out.buffer);
  dv.setUint32(OFF_MAGIC, SUPER_MAGIC, true);
  dv.setUint16(OFF_MAJOR, SUPER_MAJOR, true);
  dv.setUint16(OFF_MINOR, SUPER_MINOR, true);
  dv.setUint32(OFF_GEN_LO, lo(generation), true);
  dv.setUint32(OFF_GEN_HI, hi(generation), true);
  dv.setUint32(OFF_COUNT_LO, lo(inodeCount), true);
  dv.setUint32(OFF_COUNT_HI, hi(inodeCount), true);
  dv.setUint32(OFF_NEXT_LO, lo(nextIno), true);
  dv.setUint32(OFF_NEXT_HI, hi(nextIno), true);
  dv.setUint32(OFF_CRC, 0, true);
  dv.setUint32(OFF_RESERVED, 0, true);
  dv.setUint32(OFF_CRC, crc32(out), true);
  return out;
}

/**
 * Never throws; a bad image is a reason. Constraint 28 requires a failed validation to mount
 * read-only and surface the failure rather than reseed, which is silent data loss presented as
 * success.
 */
export function decodeSuperblock(bytes, off = 0) {
  if (off + SUPER_BYTES > bytes.length) return { ok: false, why: SUPER_REFUSE.SHORT };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(off + OFF_MAGIC, true) !== SUPER_MAGIC) {
    return { ok: false, why: SUPER_REFUSE.BAD_MAGIC };
  }
  if (dv.getUint32(off + OFF_RESERVED, true) !== 0) {
    return { ok: false, why: SUPER_REFUSE.BAD_RESERVED };
  }
  const want = dv.getUint32(off + OFF_CRC, true);
  const span = bytes.slice(off, off + SUPER_BYTES);
  new DataView(span.buffer).setUint32(OFF_CRC, 0, true);
  if (crc32(span) !== want) return { ok: false, why: SUPER_REFUSE.BAD_CRC };
  const major = dv.getUint16(off + OFF_MAJOR, true);
  // A reader one step behind refuses rather than guessing at fields it does not know. Checked
  // after the CRC, so "this image is from the future" is never reported about corrupt bytes.
  if (major > SUPER_MAJOR) {
    return { ok: false, why: SUPER_REFUSE.FUTURE_MAJOR, major, supports: SUPER_MAJOR };
  }
  return {
    ok: true,
    major,
    minor: dv.getUint16(off + OFF_MINOR, true),
    generation: join(dv, off + OFF_GEN_LO, off + OFF_GEN_HI),
    inodeCount: join(dv, off + OFF_COUNT_LO, off + OFF_COUNT_HI),
    nextIno: join(dv, off + OFF_NEXT_LO, off + OFF_NEXT_HI),
  };
}

/**
 * Picks the newest valid slot, and reports why each rejected slot was rejected so a degraded mount
 * can say what it found rather than only that it failed.
 *
 * Three slots, not two: against two alternating slots, a bad write to the older slot while
 * committing the newer one can leave zero valid copies.
 */
export function chooseSuperblock(slots) {
  const read = slots.map((s, i) => ({ i, ...decodeSuperblock(s) }));
  const valid = read.filter((r) => r.ok);
  if (valid.length === 0) {
    return { ok: false, why: "no-valid-slot", slots: read.map((r) => ({ i: r.i, why: r.why })) };
  }
  let best = valid[0];
  for (const r of valid) if (r.generation > best.generation) best = r;
  return {
    ok: true, chose: best.i, generation: best.generation, super: best,
    validSlots: valid.length, of: slots.length,
    rejected: read.filter((r) => !r.ok).map((r) => ({ i: r.i, why: r.why })),
  };
}
