// M2a's fuzz target: journal replay over torn and bit-flipped bytes, in plain Node.
//
// M2's negative control tests ONE hand-truncated journal. This tests ten thousand, and the ones it
// finds are the tears a hand-written case does not think of. It runs here rather than in a browser
// because the codec is pure over byte arrays (src/fs/journal.mjs) — which is the property M2a
// exists to establish and to keep.
//
// Two failure modes, and they are not the same thing:
//
//   CRASH            replay threw, or allocated on an unvalidated length, or did not terminate.
//                    A parser whose caller must catch is a parser that has not decided what a
//                    tear means.
//   SILENT ACCEPTANCE  replay returned a record that was NOT one of the records encoded. This is
//                    the dangerous one: a filesystem that accepts a corrupt record has applied
//                    state nobody wrote, and constraint 28 is explicit that the alternative to
//                    reporting a bad image is silent data loss presented as success.
//
// Deterministic: the seed is a CLI argument and the PRNG is here, so a finding is reproducible by
// seed rather than by luck. `Math.random` would make a failure unreportable.

import { encodeRecord, replay, HEADER_BYTES } from "../../src/fs/journal.mjs";
import { crc32SelfTest } from "../../src/fs/crc32.mjs";

/** xorshift32. Small, deterministic, and adequate for picking offsets and bit positions. */
function rng(seed) {
  let s = seed | 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    return (s >>> 0) / 4294967296;
  };
}

function buildJournal(rand, nRecords) {
  const parts = [];
  const truth = [];
  for (let i = 0; i < nRecords; i += 1) {
    const len = Math.floor(rand() * 48);
    const payload = new Uint8Array(len);
    for (let j = 0; j < len; j += 1) payload[j] = Math.floor(rand() * 256);
    parts.push(encodeRecord(i, payload));
    truth.push(payload);
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return { bytes: out, truth };
}

/** Is every record replay returned actually one of the records that was encoded, in order? */
function acceptedOnlyTruth(result, truth) {
  if (result.records.length > truth.length) return false;
  for (let i = 0; i < result.records.length; i += 1) {
    const got = result.records[i].payload;
    const want = truth[i];
    if (result.records[i].seq !== BigInt(i)) return false;
    if (got.length !== want.length) return false;
    for (let j = 0; j < got.length; j += 1) if (got[j] !== want[j]) return false;
  }
  return true;
}

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const SEED = Number(opt("seed", "12345"));
const CASES = Number(opt("cases", "10000"));
const NO_CRC = args.includes("--no-crc");

const self = crc32SelfTest();
const findings = [];
let crashes = 0;
let silent = 0;
let truncations = 0;
let flips = 0;
let accepted = 0;

const rand = rng(SEED);
for (let c = 0; c < CASES; c += 1) {
  const nRecords = 1 + Math.floor(rand() * 6);
  const { bytes, truth } = buildJournal(rand, nRecords);
  const corrupt = bytes.slice();

  // Two corruptions, both of which a half-finished write produces: a tail that stops mid-record,
  // and a byte that landed wrong.
  const mode = rand() < 0.5 ? "truncate" : "flip";
  let detail;
  if (mode === "truncate") {
    truncations += 1;
    const keep = Math.floor(rand() * corrupt.length);
    detail = { mode, keep, of: corrupt.length };
    var input = corrupt.subarray(0, keep);
  } else {
    flips += 1;
    const at = Math.floor(rand() * corrupt.length);
    const bit = 1 << Math.floor(rand() * 8);
    corrupt[at] ^= bit;
    detail = { mode, at, bit, of: corrupt.length };
    var input = corrupt;
  }

  let result;
  try {
    result = replay(input, NO_CRC ? { checkCrc: false } : {});
  } catch (e) {
    crashes += 1;
    if (findings.length < 12) {
      findings.push({ kind: "crash", seed: SEED, case: c, detail, error: String(e && e.message) });
    }
    continue;
  }
  accepted += result.records.length;
  if (!acceptedOnlyTruth(result, truth)) {
    silent += 1;
    if (findings.length < 12) {
      findings.push({
        kind: "silent-acceptance", seed: SEED, case: c, detail,
        got: result.records.length, stopped: result.stopped,
        note: "replay returned a record that was not encoded",
      });
    }
  }
}

const ok = self.ok && crashes === 0 && silent === 0;
console.log(JSON.stringify({
  ok,
  seed: SEED, cases: CASES, noCrc: NO_CRC,
  crc32SelfTest: self,
  crashes, silentAcceptances: silent,
  truncations, bitFlips: flips, recordsAccepted: accepted,
  headerBytes: HEADER_BYTES,
  findings,
}, null, 2));
process.exit(ok ? 0 : 1);
