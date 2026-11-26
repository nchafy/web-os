// M19a's measurement, part 1: WHAT IS THE FRESH-VOLUME SIGNAL, and what does the base weigh?
//
// D40 copies the read-only base into the writable volume ONCE. Constraint 28 forbids the second
// copy: "a bad superblock mounts read-only and reports. It never reseeds." So the whole row rests
// on one expression — the one a seed step gates on — and getting it wrong is silent data loss over
// a reader's edited tree. This file is that expression, run against every world it must tell
// apart, in plain Node in milliseconds.
//
// THE WORLDS, and three of them are not reachable from a browser without breaking something:
//
//   fresh            no slot, no journal, no blob. The one world that may seed.
//   populated        a volume with a snapshot. MUST NOT seed: the copy would land over a tree the
//                    reader has edited, which is constraint 28's defect through a new door.
//   refused          every superblock slot present and none decoding. MUST NOT seed.
//   floor-unknown    FRESH BYTES, blob directory unreadable. `fsck` answers MOUNT_FRESH and
//                    `Store.mount` then OVERWRITES `report.mountable` to MOUNT_RO
//                    (src/kernel/store.mjs:221). The one world where the two fields disagree.
//   sb-write-failed  fresh, and the initial superblock write refuses (store.mjs:246). Same
//                    overwrite, different cause.
//   no-boot-lock     another agent holds the journal. No VFS at all (store.mjs:184).
//
// `src/kernel/store.mjs` is IMPORTED, not ported: its only impure dependency is the `io` surface
// (`request(t, body)`), so the subject below is the module the kernel loads with OPFS replaced by
// a Map. Only the requests a MOUNT makes are implemented — `bench/fs-core/edge.mjs` carries a
// fuller scripted worker for the fd-level paths, and the overlap is the five request kinds here.
//
//     node bench/m19a-seed/probe.mjs              the measurement
//     node bench/m19a-seed/probe.mjs --control    the NAIVE gate put in, which must seed twice
//
// `--control` is the negative control, and it is a gate rather than a mutation of the subject:
// `!store.readOnly` is the expression a reader reaches for first, it is true in four of the six
// worlds, and the run must then report a seed over a populated volume. A clause that stayed green
// under it would be asserting over a constant.

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  IO_LIST, IO_READ_ALL, IO_WRITE_ALL, IO_LOCK, IO_JOURNAL,
  BLOB_DIR, JOURNAL_NAME, SUPER_SLOTS, EIO, EACCES,
} from "../../src/abi.mjs";
import { decodeRecord, encodeRecord, replay } from "../../src/fs/journal.mjs";
import { VFS, encodeOp, decodeOp } from "../../src/fs/vfs.mjs";
import { Store, MOUNT_RW, MOUNT_RO, MOUNT_FRESH, MOUNT_REFUSE } from "../../src/kernel/store.mjs";
import { USR_ENTRIES } from "../../src/kernel/providerfs.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT_CRED = { uid: 0, gid: 0 };
const CONTROL = process.argv.includes("--control");

/* --------------------------------------------------------------------------------------------
   THE GATE UNDER TEST. One expression, in one place, so the clauses below and the report cite
   the same thing a seed step would.

   Three conjuncts, and each answers a world above:

     report.mountable === MOUNT_FRESH   the volume had NO bytes. `Store.mount` overwrites this
                                        field on both paths where a fresh volume still failed to
                                        come up read-write, so it is the one field that means
                                        "fresh AND it worked".
     mode === MOUNT_RW                  the initial superblock landed. Without it a seed journals
                                        against a base no slot on disk names.
     vfs                                there is a tree to copy into. The boot-lock arm returns a
                                        report with no VFS at all.
   -------------------------------------------------------------------------------------------- */
function maySeed(store) {
  if (CONTROL) return !store.readOnly;
  return store.report !== null
    && store.report.mountable === MOUNT_FRESH
    && store.mode === MOUNT_RW
    && !!store.vfs;
}

/** The source text of the gate, printed beside the verdict so the report carries the expression
 *  and not a description of it. */
const GATE_SOURCE = CONTROL
  ? "!store.readOnly"
  : 'store.report.mountable === MOUNT_FRESH && store.mode === MOUNT_RW && !!store.vfs';

/* --------------------------------------------------------------------------------------------
   A volume, and the mount-only I/O surface over it.
   -------------------------------------------------------------------------------------------- */

function newVolume() {
  return {
    /** name -> Uint8Array, for the three superblock slots. */
    files: new Map(),
    /** The journal file's bytes. A mount reads them through the handle the boot lock holds, so an
     *  unflushed record is visible here exactly as it is in src/kernel/iocore.mjs `readAll`. */
    journal: new Uint8Array(0),
    journalSeq: null,
    journalAt: 0,
    /** name -> size. The blob DIRECTORY, which is all a mount reads (constraint 33). */
    blobs: new Map(),
  };
}

/**
 * The five request kinds a `Store.mount` makes, plus the journal appends a snapshot needs.
 *
 * `faults` is keyed by request kind and consulted first: a value other than `undefined` answers in
 * its place. That is how `floor-unknown` and `sb-write-failed` are built — one errno on one call,
 * which is not schedulable against a real OPFS.
 */
function mountIo(volume, faults = {}) {
  const answer = (t, m) => {
    if (Object.prototype.hasOwnProperty.call(faults, t)) {
      const hit = faults[t](m);
      if (hit !== undefined) return hit;
    }
    switch (t) {
      case IO_LOCK:
        return { ok: true, why: "", waitedMs: 0, attempts: 1, size: volume.journal.length };
      case IO_READ_ALL: {
        if (m.name === JOURNAL_NAME) {
          return { bytes: volume.journal.slice().buffer, size: volume.journal.length };
        }
        const bytes = volume.files.get(m.name);
        // ABSENT IS NOT CORRUPT (constraint 28): the shape iocore answers for NotFoundError.
        if (!bytes) return { bytes: null, size: -1, absent: true };
        return { bytes: bytes.slice().buffer, size: bytes.length };
      }
      case IO_WRITE_ALL:
        volume.files.set(m.name, new Uint8Array(m.bytes));
        return 0;
      case IO_LIST: {
        const out = [];
        if ((m.dir || "") !== BLOB_DIR) return out;
        for (const [name, size] of volume.blobs) {
          out.push(m.namesOnly ? { name } : { name, size });
        }
        return out;
      }
      case IO_JOURNAL:
        switch (m.op) {
          case "resume":
            volume.journalSeq = BigInt(m.nextSeq);
            return 0;
          case "append": {
            const bytes = new Uint8Array(m.bytes);
            const r = decodeRecord(bytes, 0, { checkCrc: false });
            if (!r.ok) return -EIO;
            if (volume.journalSeq === null || r.seq !== volume.journalSeq) return -EIO;
            const grown = new Uint8Array(volume.journalAt + bytes.length);
            grown.set(volume.journal.subarray(0, volume.journalAt), 0);
            grown.set(bytes, volume.journalAt);
            volume.journal = grown;
            volume.journalAt = grown.length;
            volume.journalSeq = r.seq + 1n;
            return bytes.length;
          }
          case "burn":
            volume.journalSeq = BigInt(m.burnedSeq) + 1n;
            return 0;
          case "flush":
            return 0;
          case "truncate":
            volume.journal = new Uint8Array(0);
            volume.journalAt = 0;
            return 0;
          case "size":
            return volume.journalAt;
          default:
            return -EIO;
        }
      default:
        return -EIO;
    }
  };
  return { request: async (t, m) => answer(t, m) };
}

async function mountOn(volume, faults = {}, cfg = {}) {
  const store = new Store(mountIo(volume, faults), cfg, () => {});
  await store.mount();
  return store;
}

/* --------------------------------------------------------------------------------------------
   Clause A: the six worlds, told apart.
   -------------------------------------------------------------------------------------------- */

const rows = [];
function record(clause, name, ok, detail) {
  rows.push({ clause, name, ok, detail });
}

/** A volume that has been through a boot and holds a snapshot: what a reader's second visit is. */
async function populatedVolume() {
  const volume = newVolume();
  const store = await mountOn(volume);
  if (store.mode !== MOUNT_RW) throw new Error(`the fresh mount did not come up rw: ${store.mode}`);
  // One real metadata op, journalled, then snapshotted — the shortest path to a volume whose
  // superblock names a tree that is not the empty one.
  const op = store.vfs.mkdir(ROOT_CRED, "/home");
  const r = await store.journal(op);
  if (r < 0) throw new Error(`the journal refused the mkdir: errno ${-r}`);
  const snap = await store.writeSnapshot();
  if (snap < 0) throw new Error(`the snapshot refused: errno ${-snap}`);
  return volume;
}

function state(store) {
  return {
    mountable: store.report ? store.report.mountable : null,
    mode: store.mode,
    readOnly: store.readOnly,
    vfs: !!store.vfs,
    seeds: maySeed(store),
  };
}

async function clauseA() {
  const worlds = [];

  // 1. FRESH. The one world that may seed.
  {
    const store = await mountOn(newVolume());
    const s = state(store);
    worlds.push({ world: "fresh", ...s });
    record("A", "a fresh volume reports MOUNT_FRESH and mounts rw",
      s.mountable === MOUNT_FRESH && s.mode === MOUNT_RW && s.vfs === true, s);
    record("A", "a fresh volume is the world the gate admits", s.seeds === true, s);
  }

  // 2. POPULATED. The world constraint 28 is about.
  {
    const volume = await populatedVolume();
    const store = await mountOn(volume);
    const s = state(store);
    const names = store.vfs ? store.vfs.readdir(ROOT_CRED, "/") : [];
    worlds.push({ world: "populated", ...s, root: names });
    record("A", "a populated volume reports MOUNT_RW, not MOUNT_FRESH",
      s.mountable === MOUNT_RW && s.mode === MOUNT_RW, s);
    record("A", "the tree the first boot wrote is still there", names.includes("home"), names);
    record("A", "a populated volume is REFUSED by the gate", s.seeds === false, s);
  }

  // 3. REFUSED. Every slot present, none decoding.
  {
    const volume = await populatedVolume();
    for (const name of SUPER_SLOTS) {
      const bytes = volume.files.get(name);
      if (!bytes || !bytes.length) continue;
      // One byte inside the superblock's own header, which is what the CRC covers.
      bytes[12] ^= 0xff;
    }
    const store = await mountOn(volume);
    const s = state(store);
    worlds.push({ world: "refused", ...s, problems: (store.report.problems || []).length });
    record("A", "a volume whose slots do not decode mounts REFUSE",
      s.mountable === MOUNT_REFUSE && s.mode === MOUNT_REFUSE, s);
    record("A", "a failed mount is REFUSED by the gate", s.seeds === false, s);
  }

  // 4. FLOOR-UNKNOWN: fresh bytes, unreadable blob directory. `fsck` says FRESH and the Store
  //    overwrites the field. The world that kills a gate written on `fsck`'s answer alone.
  {
    const store = await mountOn(newVolume(), { [IO_LIST]: () => -EIO });
    const s = state(store);
    worlds.push({ world: "floor-unknown", ...s });
    record("A", "a fresh volume with an unreadable blob directory mounts RO",
      s.mountable === MOUNT_RO && s.mode === MOUNT_RO, s);
    record("A", "...and it is REFUSED by the gate", s.seeds === false, s);
  }

  // 5. SB-WRITE-FAILED: fresh, and the initial superblock cannot be written.
  {
    const store = await mountOn(newVolume(), { [IO_WRITE_ALL]: () => -EIO });
    const s = state(store);
    worlds.push({ world: "sb-write-failed", ...s });
    record("A", "a fresh volume whose initial superblock refuses mounts RO",
      s.mountable === MOUNT_RO && s.mode === MOUNT_RO, s);
    record("A", "...and it is REFUSED by the gate", s.seeds === false, s);
  }

  // 6. NO-BOOT-LOCK: another agent holds the journal (constraint 48). No VFS at all.
  {
    const store = await mountOn(newVolume(), {
      [IO_LOCK]: () => ({ ok: false, why: "held by another tab", waitedMs: 0, attempts: 7 }),
    });
    const s = state(store);
    worlds.push({ world: "no-boot-lock", ...s });
    record("A", "a mount that could not take the boot lock has no VFS",
      s.mountable === MOUNT_RO && s.vfs === false, s);
    record("A", "...and it is REFUSED by the gate", s.seeds === false, s);
  }

  const admitted = worlds.filter((w) => w.seeds).map((w) => w.world);
  record("A", "EXACTLY ONE world admits a seed, and it is `fresh`",
    admitted.length === 1 && admitted[0] === "fresh", { admitted, gate: GATE_SOURCE });
  return worlds;
}

/* --------------------------------------------------------------------------------------------
   Clause B: how big is the base?

   The byte sizes come from the repository, because that is where a provider serves them from
   (`urlFor` in src/kernel/providers.mjs maps a row's `path` to a request against this tree). The
   FILE COUNT is `USR_ENTRIES.length` and not a number written here.
   -------------------------------------------------------------------------------------------- */

function clauseB() {
  let bytes = 0;
  const missing = [];
  const dirs = new Set();
  const perFile = [];
  for (const entry of USR_ENTRIES) {
    const parts = entry.name.split("/");
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
    try {
      const size = statSync(join(REPO, entry.path)).size;
      bytes += size;
      perFile.push({ name: entry.name, bytes: size });
    } catch (e) {
      missing.push(entry.path);
    }
  }
  perFile.sort((a, b) => b.bytes - a.bytes);
  const base = {
    files: USR_ENTRIES.length,
    bytes,
    dirs: [...dirs].sort(),
    largest: perFile.slice(0, 3),
    median: perFile[Math.floor(perFile.length / 2)],
  };
  record("B", "every row in USR_ENTRIES names a file that exists in this tree",
    missing.length === 0, missing);
  record("B", "the base is a counted number of files and bytes, not an estimate",
    base.files > 0 && base.bytes > 0, { files: base.files, bytes: base.bytes });
  return base;
}

/* --------------------------------------------------------------------------------------------
   Clause C: does a journal replay survive the SEEDED TREE?

   `scripts/fsfuzz.py` tears journals of RANDOM payloads. This tears a journal of the seed's own
   ops — the mkdirs, the creates and the commits a copy of `/usr` writes — because the question is
   not whether the codec holds but whether THIS op stream replays. Two failure modes, and they are
   the two `bench/fs-fuzz/fuzz.mjs` names:

     crash              replay or applyOp threw out to the caller.
     silent acceptance  a tree was built that the intact stream does not produce. A prefix is
                        correct and expected — a tear is a crash — but a DIVERGENT tree is the
                        state nobody wrote, which is constraint 28's own words.
   -------------------------------------------------------------------------------------------- */

/** The op stream a seed of `/usr` into `/` writes: a mkdir per implied directory, then a create
 *  and a commit per file. Built with a real VFS, so each op is one `src/fs/vfs.mjs` produced. */
function seedOps(base) {
  const vfs = new VFS({ owner: ROOT_CRED, now: () => 1 });
  const ops = [];
  for (const dir of base.dirs) ops.push(vfs.mkdir(ROOT_CRED, `/${dir}`, { mode: 0o755 }));
  let gen = 0;
  for (const entry of USR_ENTRIES) {
    const size = statSync(join(REPO, entry.path)).size;
    const decision = vfs.openDecision(ROOT_CRED, `/${entry.name}`, {
      create: true, excl: true, wantW: true, mode: entry.mode ?? 0o555,
    });
    ops.push(decision.created);
    gen += 1;
    ops.push(vfs.commit(decision.ino, gen, size, 1));
  }
  return { ops, truth: vfs };
}

/** Every path in a tree, with its type, size, generation and mode: the comparison a divergence
 *  shows up in. `list` is the VFS's own lstat-per-child, so nothing here restates its shape. */
function fingerprint(vfs) {
  const walk = (path) => {
    const out = [];
    for (const e of vfs.list(ROOT_CRED, path)) {
      const full = path === "/" ? `/${e.name}` : `${path}/${e.name}`;
      out.push(`${full}\t${e.type}\t${e.size}\t${e.gen}\t${e.mode.toString(8)}`);
      if (e.type === "dir") out.push(...walk(full));
    }
    return out;
  };
  return walk("/").sort().join("\n");
}

/** Replay a journal into a fresh tree, the way `fsck` does: decode, apply, STOP on the first
 *  refusal. Returns the applied count and the tree, or the throw. */
function applyJournal(bytes) {
  const vfs = new VFS({ owner: ROOT_CRED, now: () => 1 });
  const result = replay(bytes, {});
  let applied = 0;
  let refusedAt = null;
  for (const rec of result.records) {
    const op = decodeOp(rec.payload);
    if (!op) { refusedAt = { seq: String(rec.seq), why: "the payload is not an op" }; break; }
    try {
      vfs.applyOp(op);
      applied += 1;
    } catch (error) {
      refusedAt = { seq: String(rec.seq), k: op.k, why: String(error && error.message) };
      break;
    }
  }
  return { applied, refusedAt, vfs, records: result.records.length, refuse: result.refuse };
}

function clauseC(base) {
  const { ops, truth } = seedOps(base);
  const parts = ops.map((op, i) => encodeRecord(i, encodeOp(op)));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const whole = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { whole.set(p, off); off += p.length; }

  const full = applyJournal(whole);
  record("C", "the intact journal of a seed replays every op",
    full.applied === ops.length && full.refusedAt === null,
    { ops: ops.length, applied: full.applied, refusedAt: full.refusedAt });

  const want = fingerprint(truth);
  const got = fingerprint(full.vfs);
  record("C", "the replayed tree is byte-for-byte the tree the writer built",
    want === got, want === got ? { paths: want.split("\n").length } : { want, got });

  // EVERY TEAR, not a sample: a journal of 76 records is small enough to cut at every byte, and a
  // sampled sweep cannot say "no offset diverges".
  const prefixes = { crashes: [], divergent: [], ok: 0 };
  for (let cut = 0; cut <= whole.length; cut += 1) {
    let out;
    try {
      out = applyJournal(whole.subarray(0, cut));
    } catch (error) {
      prefixes.crashes.push({ cut, why: String(error && error.message) });
      continue;
    }
    // A prefix must build a PREFIX of the tree: replaying the same number of ops from the intact
    // journal must give the same fingerprint. Anything else is state nobody wrote.
    const head = new Uint8Array(parts.slice(0, out.applied).reduce((a, p) => a + p.length, 0));
    let at = 0;
    for (const p of parts.slice(0, out.applied)) { head.set(p, at); at += p.length; }
    const reference = applyJournal(head);
    if (fingerprint(out.vfs) !== fingerprint(reference.vfs)) {
      prefixes.divergent.push({ cut, applied: out.applied });
      continue;
    }
    prefixes.ok += 1;
  }
  record("C", "no truncation of the seed's journal crashes replay",
    prefixes.crashes.length === 0, prefixes.crashes.slice(0, 4));
  record("C", "every truncation builds a PREFIX of the seeded tree and never a divergent one",
    prefixes.divergent.length === 0, prefixes.divergent.slice(0, 4));

  // A bit flip inside each record's payload: the CRC must refuse it rather than applying an op
  // nobody encoded.
  const flips = { accepted: 0, refused: 0, crashes: [] };
  for (let at = 0; at < whole.length; at += 7) {
    const copy = whole.slice();
    copy[at] ^= 0x01;
    let out;
    try {
      out = applyJournal(copy);
    } catch (error) {
      flips.crashes.push({ at, why: String(error && error.message) });
      continue;
    }
    if (out.records === ops.length && out.applied === ops.length
      && fingerprint(out.vfs) === want) flips.accepted += 1;
    else flips.refused += 1;
  }
  record("C", "no bit flip in the seed's journal crashes replay", flips.crashes.length === 0,
    flips.crashes.slice(0, 4));

  return {
    records: ops.length,
    journalBytes: whole.length,
    prefixes: { cuts: whole.length + 1, ok: prefixes.ok,
      crashes: prefixes.crashes.length, divergent: prefixes.divergent.length },
    flips: { tried: flips.accepted + flips.refused + flips.crashes.length,
      indistinguishable: flips.accepted, refused: flips.refused },
    treePaths: want.split("\n").length,
  };
}

/* -------------------------------------------------------------------------------------------- */

const worlds = await clauseA();
const base = clauseB();
const journal = clauseC(base);

const failed = rows.filter((r) => !r.ok);
const report = {
  mode: CONTROL ? "control" : "gate",
  gate: GATE_SOURCE,
  worlds,
  base: { files: base.files, bytes: base.bytes, dirs: base.dirs,
    largest: base.largest, median: base.median },
  journal,
  rows,
  failed: failed.map((r) => `${r.clause}: ${r.name}`),
  ok: failed.length === 0,
};

console.log(JSON.stringify(report, null, 2));
for (const r of rows) console.error(`${r.ok ? "ok  " : "FAIL"} ${r.clause}  ${r.name}`);
console.error(`${rows.length - failed.length}/${rows.length} clauses`);

if (CONTROL) {
  // The control's whole claim: the naive gate admits the POPULATED world. A control that turned
  // nothing would verify nothing (CLAUDE.md), so this is scored rather than described.
  const reseeds = worlds.filter((w) => w.seeds && w.world !== "fresh").map((w) => w.world);
  console.error(`control: the naive gate seeds ${JSON.stringify(reseeds)} as well as fresh`);
  process.exit(reseeds.length > 0 ? 0 : 1);
}
process.exit(failed.length === 0 ? 0 : 1);
