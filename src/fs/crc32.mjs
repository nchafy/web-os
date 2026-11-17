// CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320), pure over byte arrays.
//
// A CRC and not the FNV-1a in src/abi.mjs: a journal record needs detection of the torn tail and
// the flipped bit of a write that did not finish, and CRC-32's error-detection behaviour over
// short runs is a known quantity. 0xCBF43926 is the published check value for CRC-32/ISO-HDLC
// over the nine ASCII bytes "123456789"; a table verified only against itself proves nothing.

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
  // A second vector of a different length, so a table right only for nine bytes is caught.
  const empty = crc32(new Uint8Array(0));
  return {
    ok: got === want && empty === 0,
    got, want, empty,
    why: got === want && empty === 0
      ? ""
      : `crc32("123456789") = 0x${got.toString(16)}, want 0xcbf43926; crc32("") = ${empty}, want 0`,
  };
}
