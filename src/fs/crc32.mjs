// CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320), pure over byte arrays.
//
// WHY A CRC AND NOT THE FNV-1a ALREADY IN src/abi.mjs: fnv1a is a hash for comparing two byte
// streams that should be identical. A journal record needs the other property — detecting the
// torn tail and the flipped bit of a write that did not finish — and CRC-32 is what filesystems
// use for it because its error-detection behaviour over short runs is a known quantity.
//
// Pinned against the published check value, because a hash nobody has verified against an
// external constant is a hash that agrees with itself. CRC-32 of the nine ASCII bytes "123456789"
// is 0xCBF43926 — the standard check value quoted in the CRC catalogue for CRC-32/ISO-HDLC.

const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c >>> 0;
}

/** @returns the CRC-32 of `bytes[off, off+len)`, as an unsigned 32-bit number. */
export function crc32(bytes, off = 0, len = bytes.length - off, seed = 0) {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = off; i < off + len; i += 1) {
    c = (TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** The known-answer test. Exported so a check can assert it rather than trusting the table. */
export function crc32SelfTest() {
  const v = new TextEncoder().encode("123456789");
  const got = crc32(v);
  const want = 0xcbf43926;
  // A second vector with a different length, so a table that happened to be right for nine bytes
  // is not mistaken for a correct one. CRC-32 of the empty input is 0 by definition.
  const empty = crc32(new Uint8Array(0));
  return {
    ok: got === want && empty === 0,
    got, want, empty,
    why: got === want && empty === 0
      ? ""
      : `crc32("123456789") = 0x${got.toString(16)}, want 0xcbf43926; crc32("") = ${empty}, want 0`,
  };
}
