// M2a's host test: the fs codecs under plain Node, no Worker, no SAB, no OPFS.
//
// These are not test doubles. They are the codecs M2 uses, imported from src/fs/, which is the
// scope condition the milestone turns on: the host-runnable path must be the SAME CODE, not a
// port. If a codec ever reaches for storage inside its parse path this file stops running and
// that is the intended alarm.

import { crc32, crc32SelfTest } from "../../src/fs/crc32.mjs";
import {
  encodeRecord, decodeRecord, replay, REFUSE, HEADER_BYTES, MAX_PAYLOAD,
} from "../../src/fs/journal.mjs";
import {
  encodeSuperblock, decodeSuperblock, chooseSuperblock, SUPER_REFUSE, SUPER_BYTES, SUPER_MAJOR,
} from "../../src/fs/superblock.mjs";

const results = [];
const bytes = (...v) => new Uint8Array(v);

const asJson = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x));
function check(name, got, want) {
  const ok = asJson(got) === asJson(want);
  results.push({ name, ok, got: ok ? undefined : got, want: ok ? undefined : want });
}
function checkThat(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: ok ? undefined : detail });
}

// ---- crc32 -------------------------------------------------------------------------------
const self = crc32SelfTest();
checkThat("crc32 matches the published check value", self.ok, self.why);
checkThat("crc32 is order-sensitive", crc32(bytes(1, 2)) !== crc32(bytes(2, 1)),
  "a checksum that ignores order would not detect a swapped pair");

// ---- journal round-trip ------------------------------------------------------------------
const payload = bytes(1, 2, 3, 4, 5);
const rec = encodeRecord(7, payload);
check("record size is header + payload", rec.length, HEADER_BYTES + payload.length);
const back = decodeRecord(rec);
checkThat("record round-trips", back.ok && back.seq === 7n
  && [...back.payload].join() === [...payload].join(), back);

const empty = decodeRecord(encodeRecord(0, bytes()));
checkThat("a zero-length payload round-trips", empty.ok && empty.payload.length === 0, empty);

// ---- journal refusals, each named --------------------------------------------------------
check("a short header is refused", decodeRecord(rec.subarray(0, HEADER_BYTES - 1)).why,
  REFUSE.SHORT_HEADER);
const badMagic = rec.slice(); badMagic[0] ^= 0xff;
check("a bad magic is refused", decodeRecord(badMagic).why, REFUSE.BAD_MAGIC);
const badCrc = rec.slice(); badCrc[HEADER_BYTES] ^= 1;
check("a flipped payload byte is refused", decodeRecord(badCrc).why, REFUSE.BAD_CRC);
const badLen = rec.slice();
new DataView(badLen.buffer).setUint32(4, MAX_PAYLOAD + 1, true);
check("an impossible length is refused before it is used", decodeRecord(badLen).why,
  REFUSE.BAD_LENGTH);
const badReserved = rec.slice();
new DataView(badReserved.buffer).setUint32(20, 1, true);
check("a non-zero reserved word is refused", decodeRecord(badReserved).why, REFUSE.BAD_RESERVED);
check("a truncated payload is refused", decodeRecord(rec.subarray(0, rec.length - 1)).why,
  REFUSE.SHORT_PAYLOAD);

// A flipped LENGTH field must be caught by the CRC, because the CRC covers the header. This is
// the case that justifies covering the header: a parser trusting a corrupt length is the most
// dangerous thing in a replay path.
const flippedLen = rec.slice();
new DataView(flippedLen.buffer).setUint32(4, 4, true);
check("a flipped length is caught by the CRC", decodeRecord(flippedLen).why, REFUSE.BAD_CRC);

// ---- replay semantics --------------------------------------------------------------------
const three = new Uint8Array([
  ...encodeRecord(0, bytes(10)), ...encodeRecord(1, bytes(20)), ...encodeRecord(2, bytes(30)),
]);
const full = replay(three, { firstSeq: 0 });
checkThat("replay accepts a whole journal", full.records.length === 3 && full.stopped === null,
  full);
check("replay discards nothing from a whole journal", full.discardedBytes, 0);

// The torn tail: replay must REPORT the discard, never reseed (constraint 28). BOTH tear shapes,
// because they take different branches: a tear inside the header cannot even read a length, while
// a tear after it has a length that over-runs the buffer. The third record here is 24 header
// bytes + 1 payload byte, so dropping 3 leaves 22 — inside the header.
const tornHeader = three.subarray(0, three.length - 3);
const tornHeaderR = replay(tornHeader, { firstSeq: 0 });
checkThat("a tail torn inside a header stops replay and is reported",
  tornHeaderR.records.length === 2 && tornHeaderR.stopped === REFUSE.SHORT_HEADER
  && tornHeaderR.discardedBytes === 22, tornHeaderR);

// And a tear after a complete header, which must be refused on the length instead.
const long = new Uint8Array([
  ...encodeRecord(0, bytes(10)), ...encodeRecord(1, new Uint8Array(30).fill(7)),
]);
const tornPayload = long.subarray(0, long.length - 5);
const tornPayloadR = replay(tornPayload, { firstSeq: 0 });
checkThat("a tail torn inside a payload stops replay and is reported",
  tornPayloadR.records.length === 1 && tornPayloadR.stopped === REFUSE.SHORT_PAYLOAD
  && tornPayloadR.discardedBytes > 0, tornPayloadR);

// A sequence gap stops replay: records after a missing one are not later records, they are
// records whose predecessor is gone.
const gapped = new Uint8Array([...encodeRecord(0, bytes(10)), ...encodeRecord(2, bytes(30))]);
const gapR = replay(gapped, { firstSeq: 0 });
checkThat("a sequence gap stops replay", gapR.records.length === 1 && gapR.stopped === "seq-gap",
  gapR);

// ---- superblock --------------------------------------------------------------------------
const sb = encodeSuperblock({ generation: 5, inodeCount: 12, nextIno: 13 });
check("superblock size", sb.length, SUPER_BYTES);
const sbBack = decodeSuperblock(sb);
checkThat("superblock round-trips",
  sbBack.ok && sbBack.generation === 5n && sbBack.inodeCount === 12n && sbBack.nextIno === 13n,
  sbBack);
const sbBad = sb.slice(); sbBad[8] ^= 1;
check("a flipped superblock byte is refused", decodeSuperblock(sbBad).why, SUPER_REFUSE.BAD_CRC);
const sbFuture = sb.slice();
new DataView(sbFuture.buffer).setUint16(4, SUPER_MAJOR + 1, true);
new DataView(sbFuture.buffer).setUint32(32, 0, true);
new DataView(sbFuture.buffer).setUint32(32, crc32(sbFuture), true);
check("a future major version is refused rather than guessed",
  decodeSuperblock(sbFuture).why, SUPER_REFUSE.FUTURE_MAJOR);

// Three slots, newest valid one wins, and a corrupt slot does not take the mount down.
const slots = [
  encodeSuperblock({ generation: 9, inodeCount: 1, nextIno: 2 }),
  encodeSuperblock({ generation: 11, inodeCount: 1, nextIno: 2 }),
  encodeSuperblock({ generation: 10, inodeCount: 1, nextIno: 2 }),
];
const chosen = chooseSuperblock(slots);
checkThat("the newest valid superblock is chosen",
  chosen.ok && chosen.chose === 1 && chosen.generation === 11n, chosen);
const damaged = slots.map((s) => s.slice());
damaged[1][9] ^= 0xff;                                   // break the newest
const chosen2 = chooseSuperblock(damaged);
checkThat("a corrupt newest slot falls back to the next newest, and says so",
  chosen2.ok && chosen2.chose === 2 && chosen2.generation === 10n
  && chosen2.rejected.length === 1, chosen2);
const allBad = slots.map((s) => { const c = s.slice(); c[0] ^= 0xff; return c; });
checkThat("no valid slot is a refusal, not a reseed",
  chooseSuperblock(allBad).ok === false, chooseSuperblock(allBad));

const failed = results.filter((r) => !r.ok);
// BigInt is not JSON-serialisable, and the codecs return BigInt for every 64-bit field on
// purpose: a u64 inode number or generation counter silently losing precision as a double is the
// defect that would be hardest to find later. Rendered as decimal strings only at the boundary.
const bigs = (_k, v) => (typeof v === "bigint" ? String(v) : v);
console.log(JSON.stringify({
  ok: failed.length === 0, total: results.length, failed: failed.length,
  failures: failed, names: results.map((r) => r.name),
}, bigs, 2));
process.exit(failed.length === 0 ? 0 : 1);
