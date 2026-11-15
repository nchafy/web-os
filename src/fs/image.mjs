// The snapshot image container. PURE over byte arrays, for the same reason as the journal codec.
//
// A snapshot slot on disk is [superblock, SUPER_BYTES][image, this format]. The superblock answers
// "which slot is newest and valid"; this answers "and are its bytes whole". Two containers rather
// than one because they have different lifetimes and different sizes: the superblock is 40 fixed
// bytes read from three slots at every boot, and the image is megabytes read from exactly one.
//
// Layout, little-endian:
//   u32 MAGIC 'WI1\0' · u32 length · u32 crc (over [MAGIC .. body end) with this field zero)
//   u32 reserved (zero, CRC-covered) · u8[length] body
//
// The CRC covers the header for the journal's reason: a flipped length is the field a parser is
// most dangerous about trusting, and covering only the body would let a corrupt one through.

import { crc32 } from "./crc32.mjs";

export const IMAGE_MAGIC = 0x314957;          // 'WI1'
export const IMAGE_HEADER = 16;
/** 64 MiB. A length past this is refused BEFORE it is used for arithmetic or allocation; the
 *  measured boot at 10k inodes reads a ~1.5 MB image, so this is two orders of headroom and not a
 *  limit anyone will meet. */
export const MAX_IMAGE = 64 << 20;

const OFF_MAGIC = 0;
const OFF_LEN = 4;
const OFF_CRC = 8;
const OFF_RESERVED = 12;

export const IMAGE_REFUSE = Object.freeze({
  SHORT_HEADER: "short-header",
  BAD_MAGIC: "bad-magic",
  BAD_LENGTH: "bad-length",
  SHORT_BODY: "short-body",
  BAD_CRC: "bad-crc",
  BAD_RESERVED: "bad-reserved",
  BAD_JSON: "bad-json",
});

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** Encode an arbitrary JSON-able snapshot object. */
export function encodeImage(object) {
  const body = ENC.encode(JSON.stringify(object));
  if (body.length > MAX_IMAGE) {
    throw new RangeError(`snapshot image ${body.length} B exceeds MAX_IMAGE ${MAX_IMAGE}`);
  }
  const out = new Uint8Array(IMAGE_HEADER + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(OFF_MAGIC, IMAGE_MAGIC, true);
  dv.setUint32(OFF_LEN, body.length, true);
  dv.setUint32(OFF_CRC, 0, true);
  dv.setUint32(OFF_RESERVED, 0, true);
  out.set(body, IMAGE_HEADER);
  dv.setUint32(OFF_CRC, crc32(out), true);
  return out;
}

/**
 * Decode one. Never throws, and never allocates on the strength of an unvalidated length.
 *
 * @returns {{ok: true, object: any, size: number}} | {{ok: false, why: string}}
 */
export function decodeImage(bytes, off = 0, opts = {}) {
  const checkCrc = opts.checkCrc !== false;
  if (off + IMAGE_HEADER > bytes.length) return { ok: false, why: IMAGE_REFUSE.SHORT_HEADER };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(off + OFF_MAGIC, true) !== IMAGE_MAGIC) {
    return { ok: false, why: IMAGE_REFUSE.BAD_MAGIC };
  }
  const len = dv.getUint32(off + OFF_LEN, true);
  if (len > MAX_IMAGE) return { ok: false, why: IMAGE_REFUSE.BAD_LENGTH, length: len };
  const size = IMAGE_HEADER + len;
  if (off + size > bytes.length) {
    return { ok: false, why: IMAGE_REFUSE.SHORT_BODY, want: size, have: bytes.length - off };
  }
  if (dv.getUint32(off + OFF_RESERVED, true) !== 0) {
    return { ok: false, why: IMAGE_REFUSE.BAD_RESERVED };
  }
  if (checkCrc) {
    const want = dv.getUint32(off + OFF_CRC, true);
    const span = bytes.slice(off, off + size);
    new DataView(span.buffer).setUint32(OFF_CRC, 0, true);
    if (crc32(span) !== want) return { ok: false, why: IMAGE_REFUSE.BAD_CRC };
  }
  try {
    // A slice, not a subarray: TextDecoder refuses a view backed by a SharedArrayBuffer outright
    // ("must not be shared"), and a decoder that threw inside a parse path would turn a torn
    // image into a stack trace instead of a named refusal.
    const body = bytes.slice(off + IMAGE_HEADER, off + size);
    return { ok: true, object: JSON.parse(DEC.decode(body)), size };
  } catch (e) {
    return { ok: false, why: IMAGE_REFUSE.BAD_JSON, detail: String(e && e.message) };
  }
}
