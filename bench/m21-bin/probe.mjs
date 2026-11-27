// M21's gate BEFORE M21 designs the Bin: can a sidecar survive a torn journal?
//
// docs/PLAN-SHELL.md:587-590 states M21's assumption — "a reserved directory plus a sidecar is
// enough, no new filesystem concept" — and names this measurement as the thing that decides it: if
// a sidecar cannot survive a tear, the Bin becomes a real inode flag, a week and a constraint
// rather than two days. So the question is measured here rather than reasoned about.
//
// WHAT A DELETE-TO-BIN ACTUALLY IS, and why there is anything to measure: it is at least two
// durable operations — move the bytes, write the record of where they came from — and
// src/kernel/store.mjs journals ONE VFS op per journal record (`journalHeld`, :338). A crash
// between the two records is therefore reachable, in both orders.
//
// THE PROPERTY THE JOURNAL ALREADY GIVES, measured here rather than assumed: `replay`
// (src/fs/journal.mjs:95) stops at the first record it will not accept and discards the tail, and
// `fsck` (src/fs/fsck.mjs:222-244) applies the surviving records in order and stops at the first op
// that will not apply. So what a mount sees is a PREFIX of the ops that were appended — never an
// interleaving, never a later record without its predecessor. That is what makes the half-state
// space small enough to enumerate, and enumerating it is this file's job.
//
// FOUR CANDIDATE DESIGNS, each measured in both orders:
//
//   symlink   the origin is a SYMLINK whose target is the original path. ONE journal record
//             (OP.SYMLINK carries `target` verbatim, src/fs/vfs.mjs:621), so a delete is two
//             records total.
//   file      the origin is a regular file holding ./sidecar.mjs's record. CREATE + COMMIT, so a
//             delete is three records.
//   index     one shared index file, read-modify-write. COMMIT only (the inode pre-exists), so a
//             delete is two records.
//   name      NO sidecar: the origin percent-escaped into the Bin entry's own filename. ONE
//             record, so no half-state exists at all — and NAME_MAX is the figure that decides
//             whether it can represent what the filesystem accepts.
//
// Run exhaustively, not randomly: every truncation offset and every single-bit flip of every
// journal this sequence can produce. A delete's journal is a few hundred bytes, so the whole
// half-state space is reachable by enumeration and a seed is not needed to reproduce a finding.
//
// PURE: imports src/fs/ and ./sidecar.mjs only, names no storage API, reads no clock and no random
// source. It runs in plain node in milliseconds for the same standing reason src/fs/ does.

import { VFS, FsError, encodeOp, decodeOp, NAME_MAX } from "../../src/fs/vfs.mjs";
import { encodeRecord, replay } from "../../src/fs/journal.mjs";
import { crc32SelfTest } from "../../src/fs/crc32.mjs";
import {
  encodeOrigin, decodeOrigin, SIDECAR_REFUSE, SIDECAR_MAGIC, encodeInName, decodeFromName,
} from "./sidecar.mjs";

/** Constraint 29: a credential is an argument on every path call, never instance state. */
const CRED = { uid: 0, gid: 0 };

// `std.sessionDir`'s HOME_DIR (src/libos/std.mjs:386). Restated here because this file may not
// import src/libos/ — that is in-process code and this is a host measurement — and because what is
// under test is the SHAPE of a delete, not the location of the Bin.
const HOME = "/Users/Default";
const BIN = `${HOME}/.Bin`;
const ORIGIN_DIR = `${BIN}/.origin`;
const INDEX = `${BIN}/.index`;
const VICTIM = `${HOME}/doc.txt`;
const VICTIM_SIZE = 1234;
/** The Bin's key for this delete. A monotonic integer in the real thing; one is enough here. */
const KEY = "1";

const args = process.argv.slice(2);
const CONTROL = args.includes("--control");

/* ---------------------------------------------------------------------------
   The base: what the snapshot holds before the delete is journaled.
   --------------------------------------------------------------------------- */

/** A deterministic clock. `VFS` has NO default on purpose — a parse path that reads the wall clock
 *  is not a function of its input, so it is not fuzzable (src/fs/vfs.mjs:220). */
function base() {
  let t = 1000;
  const vfs = new VFS({ now: () => (t += 1) });
  for (const d of ["/Users", HOME, BIN, ORIGIN_DIR]) vfs.mkdir(CRED, d);
  const victim = vfs.openDecision(CRED, VICTIM, { create: true });
  vfs.commit(victim.ino, 1, VICTIM_SIZE);
  // Design `index`'s shared file pre-exists, with one generation already committed: its update is
  // a swing from gen 1 to gen 2 and so is a COMMIT and nothing else.
  const idx = vfs.openDecision(CRED, INDEX, { create: true });
  vfs.commit(idx.ino, 1, 64);
  return vfs;
}

/* ---------------------------------------------------------------------------
   The ops each design journals, in each order.
   --------------------------------------------------------------------------- */

const DESIGNS = ["symlink", "file", "index", "name"];
const ORDERS = ["origin-first", "payload-first"];

function binName(design) {
  return design === "name" ? encodeInName(VICTIM) : KEY;
}

/** The ops a design's delete appends, produced by running the REAL VFS methods against a scratch
 *  base — so they are the records src/kernel/store.mjs would journal, not a hand-written guess. */
function opsFor(design, order) {
  const vfs = base();
  const to = `${BIN}/${binName(design)}`;
  const writeOrigin = () => {
    if (design === "symlink") return [vfs.symlink(CRED, VICTIM, `${ORIGIN_DIR}/${KEY}`)];
    if (design === "file") {
      const d = vfs.openDecision(CRED, `${ORIGIN_DIR}/${KEY}`, { create: true });
      const bytes = encodeOrigin(VICTIM, 1234567);
      return [d.created, vfs.commit(d.ino, 1, bytes.length)];
    }
    if (design === "index") {
      const st = vfs.lstat(CRED, INDEX);
      return [vfs.commit(st.ino, st.gen + 1, st.size + 48)];
    }
    return [];                                   // `name` carries the origin in the rename itself
  };
  const movePayload = () => [vfs.rename(CRED, VICTIM, to)];
  return order === "origin-first"
    ? [...writeOrigin(), ...movePayload()]
    : [...movePayload(), ...writeOrigin()];
}

function journalFor(ops) {
  const parts = ops.map((op, i) => encodeRecord(i, encodeOp(op)));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  // The per-record lengths are published because they are what makes the sweep's counts
  // reproducible by arithmetic rather than by re-running it: for an N-record journal, the number of
  // cases that stop after record k is 9× record k+1's length — one truncation offset plus eight
  // single-bit flips per byte. A flip and a cut are THE SAME CASE here because the CRC covers the
  // header as well as the payload (src/fs/journal.mjs:13), so a flipped byte anywhere in record k
  // discards record k and every record after it, exactly as a cut at its first byte would.
  return { bytes: out, recordBytes: parts.map((p) => p.length) };
}

/* ---------------------------------------------------------------------------
   The mount: replay a torn journal onto a fresh base, fsck's own rule.
   --------------------------------------------------------------------------- */

function mount(bytes) {
  const vfs = base();
  const played = replay(bytes, { firstSeq: 0 });
  let applied = 0;
  let rejected = null;
  for (const record of played.records) {
    const op = decodeOp(record.payload);
    if (!op) { rejected = "payload is not an op"; break; }
    try {
      vfs.applyOp(op);
      applied += 1;
    } catch (error) {
      // fsck's rule: stopped, not skipped. Every later op describes a state this volume is not in.
      rejected = error instanceof FsError ? error.code : String(error && error.message);
      break;
    }
  }
  return { vfs, applied, rejected, stopped: played.stopped };
}

/* ---------------------------------------------------------------------------
   What a reader sees. THIS is the subject: a Bin that lies, or bytes it cannot
   see, is a defect whether or not the filesystem is consistent.
   --------------------------------------------------------------------------- */

/**
 * @param indexDriven When true the Bin's listing enumerates ORIGIN RECORDS and looks up payloads,
 *        rather than enumerating the Bin directory and looking up origins. It is a control: it is
 *        the one lister under which orphaned bytes are INVISIBLE, so a reader can neither see them
 *        nor reclaim them.
 */
function observe(vfs, design, { indexDriven = false, checkCrc = true, checkMagic = true } = {}) {
  const name = binName(design);
  const payload = vfs.exists(CRED, `${BIN}/${name}`, { followFinal: false });
  const stillHome = vfs.exists(CRED, VICTIM, { followFinal: false });

  let origin = false;          // an origin record exists
  let originEmpty = false;     // it exists but holds no bytes
  let originPath = null;       // the path it names, if it can be read

  if (design === "symlink") {
    if (vfs.exists(CRED, `${ORIGIN_DIR}/${KEY}`, { followFinal: false })) {
      origin = true;
      // The target is IN the journal record, so this read is inside the fuzzable layer.
      originPath = vfs.readlink(CRED, `${ORIGIN_DIR}/${KEY}`);
    }
  } else if (design === "file") {
    if (vfs.exists(CRED, `${ORIGIN_DIR}/${KEY}`, { followFinal: false })) {
      origin = true;
      const st = vfs.lstat(CRED, `${ORIGIN_DIR}/${KEY}`);
      // gen 0 means NO BLOB HAS EVER BEEN COMMITTED (src/fs/vfs.mjs:#alloc) — the CREATE landed
      // and the COMMIT did not. The bytes live in OPFS and so are outside this gate; what is
      // inside it is that the swing did not happen, which is what a reader would hit as an
      // unreadable row.
      if (st.gen === 0) originEmpty = true;
      else originPath = VICTIM;
    }
  } else if (design === "index") {
    const st = vfs.lstat(CRED, INDEX);
    origin = st.gen >= 2;                        // the swing to the new generation landed
    if (origin) originPath = VICTIM;
  } else {
    // `name`: the origin IS the entry, so it cannot be present without the payload.
    origin = payload;
    if (payload) {
      const back = decodeFromName(name);
      originPath = back.ok ? back.path : null;
    }
  }

  const visibleRows = indexDriven
    ? (origin ? 1 : 0)                           // the control's lister: origins, then lookups
    : (payload ? 1 : 0);                         // readdir of the Bin, then an origin lookup
  return {
    payload, stillHome, origin, originEmpty, originPath, visibleRows,

    // THE FIVE THINGS A HALF-STATE CAN BE WRONG ABOUT, kept apart on purpose. "The Bin lies" is
    // not one predicate: an entry pointing at bytes that are not there and bytes with no entry are
    // different defects with different costs, and collapsing them is how the cheaper answer gets
    // picked.
    //
    // A row the reader IS SHOWN whose Restore cannot work. The reader asked for the file back and
    // the Bin cannot say where back is.
    shownUnrestorable: payload && (!origin || originEmpty || originPath !== VICTIM),
    // An origin record with no payload attached. Under a readdir-driven lister this shows the
    // reader NOTHING — so it is not a lie, it is a few bytes of garbage, and the same readdir join
    // that lists the Bin is what finds and sweeps it.
    strandedOrigin: origin && !payload,
    // Bytes in the Bin that NO listing this design performs would show: a reader can neither see
    // them nor reclaim them, and the volume never gets the space back. The only unrecoverable
    // half-state, and the one the control below produces on purpose.
    invisible: payload && visibleRows === 0,
    // The file is gone from its home path AND absent from the Bin. Destroyed.
    doubleLoss: !payload && !stillHome,
    // Restore would write the bytes somewhere that is not where they came from — the one failure
    // that damages something which was not already broken.
    wrongPath: payload && origin && !originEmpty && originPath !== null
      && originPath !== VICTIM,

    // Can a readdir JOIN over (the Bin directory × the origin store) name the state this mount is
    // in? That is the whole "no new filesystem concept" claim: if every reachable half-state is
    // nameable by two directory reads, the Bin needs no inode flag.
    reconcilable: design === "index"
      // The index is ONE file whose rows are blob bytes this gate cannot read, so a join against
      // it is not a directory read and this measurement cannot claim it.
      ? null
      : (payload || origin || stillHome),
  };
}

/* ---------------------------------------------------------------------------
   The sweep: every truncation and every single-bit flip.
   --------------------------------------------------------------------------- */

const STATES = ["complete", "nothing", "dangling", "orphan", "empty-origin", "wrong-path",
                "broken"];

function classify(o, rejected) {
  if (rejected !== null) return "broken";
  if (o.doubleLoss) return "broken";
  if (o.originEmpty) return "empty-origin";
  if (o.payload && o.origin) return o.originPath === VICTIM ? "complete" : "wrong-path";
  if (o.payload && !o.origin) return "orphan";
  if (!o.payload && o.origin) return "dangling";
  return "nothing";
}

function sweep(design, order, opts) {
  const ops = opsFor(design, order);
  const { bytes: whole, recordBytes } = journalFor(ops);
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  const tally = {
    shownUnrestorable: 0, strandedOrigin: 0, invisible: 0, doubleLoss: 0, wrongPath: 0,
    unreconcilable: 0, rejected: 0, overApplied: 0, cases: 0, threw: 0,
  };
  const examples = {};

  const score = (input, detail) => {
    tally.cases += 1;
    let m;
    try {
      m = mount(input);
    } catch (error) {
      // A mount that THROWS is a crash, not a refusal: the parser's caller would have to catch.
      tally.threw += 1;
      examples.threw = { detail, error: String(error && error.message) };
      return;
    }
    // PREFIX ATOMICITY, counted rather than assumed: `applied` must be a whole number of leading
    // records and no op may be rejected. An `applied` that skipped a record, or a rejection, is a
    // mount that built state nobody wrote — the thing constraint 28 names.
    if (m.rejected !== null) tally.rejected += 1;
    if (m.applied > ops.length) tally.overApplied += 1;
    const o = observe(m.vfs, design, opts);
    const state = classify(o, m.rejected);
    counts[state] += 1;
    for (const k of ["shownUnrestorable", "strandedOrigin", "invisible", "doubleLoss",
                     "wrongPath"]) {
      if (o[k]) tally[k] += 1;
    }
    if (o.reconcilable === false) tally.unreconcilable += 1;
    if (!examples[state]) {
      examples[state] = {
        detail, applied: m.applied, rejected: m.rejected, stopped: m.stopped,
        payload: o.payload, origin: o.origin, stillHome: o.stillHome,
        originPath: o.originPath, visibleRows: o.visibleRows,
      };
    }
  };

  for (let keep = 0; keep <= whole.length; keep += 1) {
    score(whole.subarray(0, keep), { mode: "truncate", keep, of: whole.length });
  }
  for (let at = 0; at < whole.length; at += 1) {
    for (let b = 0; b < 8; b += 1) {
      const flipped = whole.slice();
      flipped[at] ^= 1 << b;
      score(flipped, { mode: "flip", at, bit: 1 << b, of: whole.length });
    }
  }

  return {
    design, order, records: ops.length, journalBytes: whole.length, recordBytes,
    ops: ops.map((o) => o.k), counts, ...tally, originCovered: ORIGIN_COVERAGE[design], examples,
  };
}

/**
 * WHERE EACH DESIGN KEEPS THE ONE DATUM A RESTORE NEEDS, and whether anything checksums it.
 *
 * Measured from the code, not assumed: `src/fs/journal.mjs:10` covers header AND payload with a
 * CRC-32, `src/fs/superblock.mjs:56` and `src/fs/image.mjs:53` each carry their own — and a BLOB
 * does not. `blobName` is `${ino}.${gen}` and nothing else (src/fs/vfs.mjs), there is no `crc` in
 * `src/kernel/store.mjs`, and a blob's bytes are therefore the only durable thing on this volume
 * with no integrity field.
 *
 * That makes the distinction load-bearing twice. A symlink target travels IN the journal record, so
 * it is CRC-covered and it is inside `scripts/fsfuzz.py`'s three-second gate. A sidecar held as
 * file DATA is neither: a bit-rotted origin path is undetectable, and no fuzz case in this file or
 * in `bench/fs-fuzz/fuzz.mjs` can reach it, because the bytes are in OPFS and `src/fs/` is pure.
 */
const ORIGIN_COVERAGE = Object.freeze({
  symlink: { where: "the SYMLINK journal record's `target`", crc: true, insideFsfuzz: true },
  file: { where: "an OPFS blob", crc: false, insideFsfuzz: false },
  index: { where: "an OPFS blob", crc: false, insideFsfuzz: false },
  name: { where: "the RENAME journal record's `toName`", crc: true, insideFsfuzz: true },
});

/* ---------------------------------------------------------------------------
   The sidecar record's own fuzz: a total function over torn bytes?
   --------------------------------------------------------------------------- */

const CODEC_CORPUS = [
  VICTIM,
  "/",
  `${HOME}/a`,
  `${HOME}/${"n".repeat(NAME_MAX)}`,
  // Every byte a name may legally hold. `splitPath` forbids only "/", so a sidecar that cannot
  // carry these cannot carry what the filesystem accepts.
  `${HOME}/we\nird`,
  `${HOME}/pct%20and%2F`,
  `${HOME}/é中文`,
  `/${"d/".repeat(40)}leaf`,
];

function codecFuzz({ checkCrc = true } = {}) {
  const out = { cases: 0, threw: 0, wrongPath: 0, accepted: 0, refusals: {}, examples: {} };
  const score = (bytes, want, detail) => {
    out.cases += 1;
    let r;
    try {
      r = decodeOrigin(bytes, { checkCrc });
    } catch (error) {
      out.threw += 1;
      out.examples.threw = { detail, error: String(error && error.message) };
      return;
    }
    if (r.ok) {
      out.accepted += 1;
      if (r.path !== want) {
        out.wrongPath += 1;
        if (!out.examples.wrongPath) out.examples.wrongPath = { detail, got: r.path, want };
      }
    } else {
      out.refusals[r.why] = (out.refusals[r.why] || 0) + 1;
    }
  };

  for (const path of CODEC_CORPUS) {
    const whole = encodeOrigin(path, 1700000000000);
    for (let keep = 0; keep <= whole.length; keep += 1) {
      score(whole.subarray(0, keep), path, { path, mode: "truncate", keep, of: whole.length });
    }
    for (let at = 0; at < whole.length; at += 1) {
      for (let b = 0; b < 8; b += 1) {
        const flipped = whole.slice();
        flipped[at] ^= 1 << b;
        score(flipped, path, { path, mode: "flip", at, bit: 1 << b });
      }
    }
    // The state an UNWRITTEN sidecar is in: an inode created, no blob committed, so a reader that
    // ignored `gen` and read the file would get zeros.
    score(new Uint8Array(whole.length), path, { path, mode: "zeroed", of: whole.length });
    score(new Uint8Array(0), path, { path, mode: "empty" });
    // ...and the round trip, which must survive every byte a name may hold.
    const back = decodeOrigin(whole);
    if (!back.ok || back.path !== path) {
      out.roundTripFailures = out.roundTripFailures || [];
      out.roundTripFailures.push({ path, back });
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
   RESTORE, which is the other half of M21 and has an edge a delete does not.
   --------------------------------------------------------------------------- */

/**
 * `src/fs/vfs.mjs:658-667` refuses a rename over a DIRECTORY and over a non-empty one, and over a
 * type mismatch — and over a plain file standing in the way it refuses NOTHING. `applyOp`'s RENAME
 * arm (`:881-891`) deletes the standing entry, decrements its nlink and FREES the inode.
 *
 * So there is no `RENAME_NOREPLACE` here, and a restore implemented as one `rename` back to the
 * origin path destroys whatever a reader created at that path in the meantime — atomically, in one
 * journal record, with no tear needed and nothing to recover from. M21's row already owes "a
 * restore onto an occupied path refuses by name"; this measures that the refusal cannot be left to
 * the filesystem, because the filesystem does not have one.
 */
function restoreClobber() {
  const vfs = base();
  vfs.rename(CRED, VICTIM, `${BIN}/${KEY}`);
  const replacement = vfs.openDecision(CRED, VICTIM, { create: true });
  vfs.commit(replacement.ino, 1, 7);
  const before = vfs.lstat(CRED, VICTIM);
  let refused = null;
  let freed = null;
  try {
    const op = vfs.rename(CRED, `${BIN}/${KEY}`, VICTIM);
    freed = op.freed;
  } catch (error) {
    refused = error instanceof FsError ? error.code : String(error && error.message);
  }
  const after = vfs.lstat(CRED, VICTIM);
  return {
    // What a reader's own file was, and what sits at its path now.
    occupantInoBefore: before.ino, occupantSizeBefore: before.size,
    inoAfter: after.ino, sizeAfter: after.size,
    renameRefused: refused,
    freedInode: freed,
    clobbered: refused === null && after.ino !== before.ino,
    // Reachable WITHOUT any tear: this is one journal record, applied whole.
    needsATear: false,
  };
}

/** Restore's own half-states, measured the same way a delete's are. Two records again — move the
 *  bytes home, drop the origin record — so the same two orders exist. */
function restoreSweep(order) {
  // The snapshot this sweep replays onto is a Bin in its `complete` state, so every mount must
  // rebuild that and not the empty base.
  const stage = () => {
    const v = base();
    v.symlink(CRED, VICTIM, `${ORIGIN_DIR}/${KEY}`);
    v.rename(CRED, VICTIM, `${BIN}/${KEY}`);
    return v;
  };
  const scratch = stage();
  const home = () => [scratch.rename(CRED, `${BIN}/${KEY}`, VICTIM)];
  const drop = () => [scratch.unlink(CRED, `${ORIGIN_DIR}/${KEY}`)];
  const ops = order === "home-first" ? [...home(), ...drop()] : [...drop(), ...home()];
  const { bytes: whole, recordBytes } = journalFor(ops);

  const counts = { complete: 0, nothing: 0, "bytes-home-origin-stranded": 0,
                   "origin-gone-bytes-stuck": 0, broken: 0 };
  let cases = 0;
  let lost = 0;
  let unrestorable = 0;
  const score = (input) => {
    cases += 1;
    const { vfs: v, rejected } = (() => {
      const fresh = stage();
      const played = replay(input, { firstSeq: 0 });
      let rej = null;
      for (const r of played.records) {
        const op = decodeOp(r.payload);
        if (!op) { rej = "payload is not an op"; break; }
        try { fresh.applyOp(op); } catch (e) {
          rej = e instanceof FsError ? e.code : String(e && e.message); break;
        }
      }
      return { vfs: fresh, rejected: rej };
    })();
    const atHome = v.exists(CRED, VICTIM, { followFinal: false });
    const inBin = v.exists(CRED, `${BIN}/${KEY}`, { followFinal: false });
    const hasOrigin = v.exists(CRED, `${ORIGIN_DIR}/${KEY}`, { followFinal: false });
    if (rejected !== null) { counts.broken += 1; return; }
    if (!atHome && !inBin) { lost += 1; counts.broken += 1; return; }
    if (atHome && !hasOrigin) counts.complete += 1;
    else if (atHome && hasOrigin) counts["bytes-home-origin-stranded"] += 1;
    else if (inBin && hasOrigin) counts.nothing += 1;
    else { counts["origin-gone-bytes-stuck"] += 1; unrestorable += 1; }
  };
  for (let keep = 0; keep <= whole.length; keep += 1) score(whole.subarray(0, keep));
  for (let at = 0; at < whole.length; at += 1) {
    for (let b = 0; b < 8; b += 1) {
      const f = whole.slice(); f[at] ^= 1 << b; score(f);
    }
  }
  return { order, records: ops.length, recordBytes, journalBytes: whole.length, cases, counts,
           bytesLost: lost, unrestorable };
}

/* ---------------------------------------------------------------------------
   Design `name`'s figure: what NAME_MAX permits.
   --------------------------------------------------------------------------- */

function nameBudget() {
  const probes = CODEC_CORPUS.map((path) => {
    const encoded = encodeInName(path);
    const back = decodeFromName(encoded);
    return {
      path, pathBytes: new TextEncoder().encode(path).length,
      encodedBytes: encoded.length, fits: encoded.length <= NAME_MAX,
      roundTrips: back.ok && back.path === path,
    };
  });
  // The worst case, exactly: every byte escaped costs three, so a path of only separators is a
  // third of the budget.
  const allSlashes = Math.floor(NAME_MAX / 3);
  // What is left for a FILENAME under HOME, which is where a reader actually deletes things.
  const prefix = encodeInName(`${HOME}/`).length;
  return {
    nameMax: NAME_MAX,
    worstCasePathBytes: allSlashes,
    homePrefixEncodedBytes: prefix,
    filenameBudgetUnderHome: NAME_MAX - prefix,
    // A name the filesystem accepts today and this design cannot represent.
    legalNameThatDoesNotFit: NAME_MAX,
    probes,
  };
}

/* ---------------------------------------------------------------------------
   Run.
   --------------------------------------------------------------------------- */

const self = crc32SelfTest();
const problems = [];
if (!self.ok) problems.push("crc32 does not match its published check value");

const sweeps = [];
for (const design of DESIGNS) {
  for (const order of ORDERS) {
    // `name` has one record, so the two orders are the same journal. Measured once and said so.
    if (design === "name" && order === "payload-first") continue;
    sweeps.push(sweep(design, order, {}));
  }
}

const codec = codecFuzz();
const budget = nameBudget();
const restores = ["home-first", "origin-first"].map(restoreSweep);
const clobber = restoreClobber();

// RESTORE'S ORDER IS NOT A PREFERENCE, and this is the asymmetry that decides it. A delete's two
// half-states are both recoverable, so its order is a judgement. A restore's are not: dropping the
// origin record before the bytes are home leaves bytes in the Bin that NOTHING names, and no later
// pass can work out where they belong. So the safe order is asserted clean and the unsafe one is
// asserted DIRTY — if both came back clean the ordering claim would be empty, which is the same
// reason a negative control has to turn something.
const byOrder = Object.fromEntries(restores.map((r) => [r.order, r]));
for (const r of restores) {
  if (r.bytesLost) {
    problems.push(`restore/${r.order}: ${r.bytesLost} case(s) left the bytes at NEITHER path`);
  }
  if (r.counts.complete === 0) {
    problems.push(`restore/${r.order}: no case completed, so the success path was not exercised`);
  }
}
if (byOrder["home-first"].unrestorable) {
  problems.push(`restore/home-first: ${byOrder["home-first"].unrestorable} case(s) are `
    + "unrestorable, and this is the order M21 must ship");
}
if (byOrder["origin-first"].unrestorable === 0) {
  problems.push("restore/origin-first left nothing unrestorable, so the measured reason to "
    + "forbid that order is gone and this clause is asserting nothing");
}
// The same shape for the delete: `origin-first` must show the reader nothing wrong, and
// `payload-first` must show it something — otherwise the delete's order does not matter and
// saying it does is an unsourced claim.
const shownIn = (design, order) => sweeps
  .find((s) => s.design === design && s.order === order).shownUnrestorable > 0;
for (const d of DESIGNS.filter((x) => x !== "name")) {
  if (shownIn(d, "origin-first")) {
    problems.push(`${d}/origin-first: shows the reader a row it cannot restore, which the `
      + "origin-first order exists to avoid");
  }
  if (!shownIn(d, "payload-first")) {
    problems.push(`${d}/payload-first: shows no unrestorable row, so the ordering asymmetry this `
      + "run reports does not exist");
  }
}

// The clobber is asserted as a PRESENT behaviour of the filesystem, not as a defect of it: POSIX
// rename replaces, and M21's refusal has to live above it.
if (clobber.renameRefused !== null || !clobber.clobbered) {
  problems.push(`a rename onto an occupied path answered ${clobber.renameRefused ?? "nothing"} `
    + "rather than replacing it. If the VFS has grown a refusal, M21's userland pre-check is no "
    + "longer the only thing standing between a restore and a reader's file — re-derive it");
}

// The clean run's obligations, each asserted separately rather than as one "it held".
for (const s of sweeps) {
  if (s.threw) problems.push(`${s.design}/${s.order}: ${s.threw} mount(s) THREW rather than refusing`);
  if (s.doubleLoss) {
    problems.push(`${s.design}/${s.order}: ${s.doubleLoss} case(s) DESTROYED the file — gone from `
      + "its home path and absent from the Bin");
  }
  if (s.invisible) {
    problems.push(`${s.design}/${s.order}: ${s.invisible} case(s) left bytes in the Bin that its `
      + "own listing does not show, which is a leak a reader can neither see nor reclaim");
  }
  if (s.wrongPath) {
    problems.push(`${s.design}/${s.order}: ${s.wrongPath} case(s) named a path that is not where `
      + "the file came from, so a restore would write the bytes to the wrong place");
  }
  if (s.unreconcilable) {
    problems.push(`${s.design}/${s.order}: ${s.unreconcilable} case(s) are in a state two `
      + "directory reads cannot name, which is the Bin needing a filesystem concept it does not "
      + "have");
  }
  if (s.rejected || s.overApplied) {
    problems.push(`${s.design}/${s.order}: ${s.rejected} case(s) had an op REJECTED and `
      + `${s.overApplied} applied more records than were appended, so replay is not prefix-atomic `
      + "and the half-state space this file enumerates is not the whole space");
  }
  if (s.counts.complete === 0) {
    problems.push(`${s.design}/${s.order}: no case completed the delete, so the sweep never `
      + "exercised the success path");
  }
}
if (codec.threw) problems.push(`the sidecar codec threw on ${codec.threw} torn input(s)`);
if (codec.wrongPath) {
  problems.push(`the sidecar codec accepted ${codec.wrongPath} torn record(s) as a path that was `
    + "not encoded, so a restore would write to the wrong place");
}
if (codec.roundTripFailures) {
  problems.push(`${codec.roundTripFailures.length} path(s) in the corpus do not round-trip`);
}
// Every refusal reason is named separately, because "it refused" passes for a refusal for the
// wrong reason. These three are what the `no-magic` control below moves.
const NAMED_REFUSALS = [
  { input: new Uint8Array(40), want: SIDECAR_REFUSE.BAD_MAGIC, name: "a zeroed sidecar" },
  { input: new Uint8Array(2), want: SIDECAR_REFUSE.SHORT, name: "a 2-byte sidecar" },
  // A 13-DIGIT timestamp, and cut at byte 8, which is inside the digits. A one-digit time was
  // tried first and refuses as `short-crc`, correctly: byte 6 is already past a one-digit field.
  // The clause is kept because it is the one that found that — an expectation about where a cut
  // lands is exactly as capable of being wrong as the codec it is asserting over.
  { input: encodeOrigin(VICTIM, 1700000000000).subarray(0, 8), want: SIDECAR_REFUSE.SHORT_TIME,
    name: "a sidecar cut inside its time field" },
];
for (const c of NAMED_REFUSALS) {
  const got = decodeOrigin(c.input, {});
  if (got.why !== c.want) {
    problems.push(`${c.name} is refused as ${got.why ?? "ACCEPTED"}, not ${c.want}`);
  }
}

/* ---------------------------------------------------------------------------
   The controls. Three families, each of which must turn a NAMED counter: a
   control scored on "something failed" verifies nothing (CLAUDE.md).
   --------------------------------------------------------------------------- */

let controls = null;
if (CONTROL) {
  const families = {};

  // 1. The lister reads the index and looks up payloads, instead of reading the Bin and looking up
  //    origins. Orphaned bytes stop being visible.
  const idx = sweep("symlink", "payload-first", { indexDriven: true });
  families["index-driven"] = {
    turns: "invisible", got: idx.invisible,
    fired: idx.invisible > 0,
    why: "bytes renamed into the Bin with no origin record yet are shown by no row",
  };

  // 2. The sidecar's CRC is not checked. A truncated path decodes as a SHORTER PATH THAT LOOKS
  //    FINE, which is a restore to the wrong place.
  const nocrc = codecFuzz({ checkCrc: false });
  families["no-crc"] = {
    turns: "wrongPath", got: nocrc.wrongPath,
    fired: nocrc.wrongPath > 0,
    why: "a path cut mid-record is accepted verbatim",
    accepted: nocrc.accepted,
  };

  // 3. The magic is not verified.
  //
  //    THIS CONTROL WAS RESCOPED, and the reason is a finding about the codec above rather than
  //    about the control. It was first written to turn `wrongPath` — "a zeroed sidecar is parsed as
  //    if it carried a path" — and it turned NOTHING: 0 of 6,153 cases. Measured cause, not
  //    reasoned: a zeroed buffer with a correct magic spliced in refuses as `short-time`, because
  //    the time field is digits-only and the CRC is over the path, so BOTH of them already reject
  //    it. The magic is therefore not load-bearing for REJECTION.
  //
  //    What it is load-bearing for is the refusal's NAME, which this project treats as a separate
  //    obligation ("assert each refusal's errno separately — a single 'it refused' passes for a
  //    filesystem that refused for the wrong reason"). A Bin that cannot tell "this is not a
  //    sidecar" from "this sidecar is truncated" cannot tell a foreign file dropped in the origin
  //    store from its own torn record, and those want different handling: sweep one, report the
  //    other. So the control turns the reason, and a control satisfied by any failure is not
  //    accepted here either.
  // The SAME three inputs the clean run asserts over, imported from there rather than restated:
  // a control over its own corpus is a control over a different question.
  const reasons = (opts) => NAMED_REFUSALS.map((c) => {
    const spliced = c.input.slice();
    if (opts.checkMagic === false) {
      const magic = new TextEncoder().encode(SIDECAR_MAGIC);
      for (let i = 0; i < Math.min(magic.length, spliced.length); i += 1) spliced[i] = magic[i];
    }
    const got = decodeOrigin(spliced, {});
    return { name: c.name, want: c.want, got: got.why ?? "ACCEPTED", named: got.why === c.want };
  });
  const clean = reasons({});
  const nomagic = reasons({ checkMagic: false });
  const misnamed = nomagic.filter((r, i) => r.got !== clean[i].got);
  families["no-magic"] = {
    turns: "misnamedRefusals", got: misnamed.length, of: nomagic.length,
    fired: misnamed.length > 0,
    why: "a sidecar that is not one is refused for the wrong reason, so a foreign file in the "
      + "origin store cannot be told from the Bin's own torn record",
    clean, control: nomagic,
    rescopedFrom: "wrongPath, which it turned 0 of 6153 — the time field and the CRC already "
      + "reject a zeroed sidecar, so the magic is not load-bearing for rejection",
  };

  const silent = Object.entries(families).filter(([, f]) => !f.fired).map(([k]) => k);
  controls = { families, silentFamilies: silent };
  if (silent.length) {
    problems.push(`control famil(ies) ${silent.join(", ")} turned nothing, so the clean verdict `
      + "above is not evidence");
  }
}

/* ---------------------------------------------------------------------------
   The verdict, stated rather than left to a reader of the counts.
   --------------------------------------------------------------------------- */

const byKey = Object.fromEntries(sweeps.map((s) => [`${s.design}/${s.order}`, s]));
const halfStates = (k) => {
  const c = byKey[k].counts;
  return STATES.filter((s) => s !== "complete" && s !== "nothing" && s !== "broken"
    && c[s] > 0);
};

const verdict = {
  // The question docs/PLAN-SHELL.md:587 asks. A tear is survived when it cannot destroy the bytes,
  // cannot hide them, and cannot misdirect a restore — NOT when it leaves the volume consistent,
  // which every case here does and which says nothing about what a reader sees.
  sidecarSurvivesATear: sweeps.every((s) => !s.threw && !s.doubleLoss && !s.invisible
    && !s.wrongPath && !s.unreconcilable)
    && byOrder["home-first"].unrestorable === 0 && byOrder["home-first"].bytesLost === 0,
  reachableHalfStates: Object.fromEntries(Object.keys(byKey).map((k) => [k, halfStates(k)])),
  // The ordering result, stated as the asymmetry it is rather than left in the counts.
  orderMatters: Object.fromEntries(DESIGNS.filter((d) => d !== "name").map((d) => [d, {
    "origin-first": {
      shownUnrestorable: byKey[`${d}/origin-first`].shownUnrestorable,
      strandedOrigin: byKey[`${d}/origin-first`].strandedOrigin,
    },
    "payload-first": {
      shownUnrestorable: byKey[`${d}/payload-first`].shownUnrestorable,
      strandedOrigin: byKey[`${d}/payload-first`].strandedOrigin,
    },
  }])),
  originCoverage: ORIGIN_COVERAGE,
  // Restore's order is forced, and a delete's is not. The two facts behind that.
  deleteOrderIsAJudgement: "both of a delete's half-states are recoverable: origin-first strands "
    + "an origin record a readdir join sweeps, payload-first shows a row whose Restore must refuse "
    + "by name. Neither destroys bytes and neither hides them",
  restoreOrderIsFORCED: "the bytes MUST go home before the origin record is dropped. The other "
    + `order left ${byOrder["origin-first"].unrestorable} of `
    + `${byOrder["origin-first"].cases} cases with bytes in the Bin that nothing names, which no `
    + "later pass can repair because the one fact needed to repair it is the fact that was lost",
  renameReplacesSilently: clobber,
  // Why the space is this small, and the measured claim behind it.
  prefixAtomicity: "replay returns a PREFIX of the appended records (src/fs/journal.mjs:95) and "
    + "fsck stops at the first op that will not apply (src/fs/fsck.mjs:242), so no case in this "
    + "sweep observed a later record without its predecessor",
  recordsPerDelete: Object.fromEntries(sweeps.map((s) => [`${s.design}/${s.order}`, s.records])),
};

console.log(JSON.stringify({
  ok: problems.length === 0,
  crc32SelfTest: self,
  sweeps, codec, nameBudget: budget, restores, restoreClobber: clobber, verdict, controls,
  problems,
}, null, 2));
process.exit(problems.length === 0 ? 0 : 1);
