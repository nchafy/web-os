// The storage edge's failure paths, under plain Node, against a scripted I/O worker.
//
// It sits beside bench/fs-core/probe.py rather than inside it because the browser proofs are the
// wrong instrument for an error path: there is no way to make a real `createSyncAccessHandle`
// refuse on the fourth call, or to put an append inside the window a snapshot holds open. A failure
// nobody can schedule is a path nobody has run.
//
// `src/kernel/store.mjs` is imported, not ported. Its only non-pure dependency is the `io`
// surface — `request(t, m)` — so the subject is the same module the kernel loads, with the OPFS
// replaced by a Map and a per-request hook that can return any errno at any point. The volume is
// bytes, so a "crash" is a second `Store` mounted over the journal's flushed prefix: what the next
// boot would read.
//
// Nothing here exercises a syscall, a process, a SAB or a real flush, and the cases say nothing
// about latency. scripts/fsfuzz.py runs it as a gate; scripts/check.py owns the proofs.
//
//     node bench/fs-core/edge.mjs                 the gate
//     node bench/fs-core/edge.mjs --control       every fix put back the way it was found
//
// `--control` is the negative control. Each case's `unfix` reconstructs the defect at the one line
// it lives on — an `O_APPEND` seek taken once at open, a refused listing converted to an empty
// array, a revert that does nothing, a dirty flag cleared after the await, a volume lock that lets
// anything through. The run must then report a failure in every family, which is what says these
// assertions are coupled to their subjects rather than to a constant.

import {
  IO_BLOB_OPEN, IO_WRITE, IO_READ, IO_FSYNC, IO_CLOSE, IO_TRUNCATE, IO_FREE, IO_LIST,
  IO_READ_ALL, IO_WRITE_ALL, IO_LOCK, IO_JOURNAL, IO_COPY, IO_SIZE, IO_STATS,
  BLOB_DIR, JOURNAL_NAME, JOURNAL_IDLE_MS, SUPER_SLOTS,
  O_WRONLY, O_APPEND, EIO, EBADF, EINVAL,
} from "../../src/abi.mjs";
import { decodeRecord } from "../../src/fs/journal.mjs";
import { blobName } from "../../src/fs/vfs.mjs";
import { MOUNT_FRESH, MOUNT_REFUSE } from "../../src/fs/fsck.mjs";
import { Store, MOUNT_RW, MOUNT_RO } from "../../src/kernel/store.mjs";

const ROOT_CRED = { uid: 0, gid: 0 };
/** The one "process" whose byte region the scripted worker reads and writes. */
const PID = 1;
const REGION = 4096;

/**
 * A volume. `journal` is the file's bytes and `journalFlushed` is how many of them a flush has made
 * durable, which is what lets a case assert that an unflushed record is lost rather than merely
 * late. A real handle's unflushed write is still readable in the same agent, so a harness that read
 * `journal` back would see every record whether or not it was ever flushed.
 */
function newVolume() {
  return {
    files: new Map(),
    blobs: new Map(),
    journal: new Uint8Array(0),
    journalFlushed: 0,
  };
}

/** What the next boot would read: the journal's flushed prefix, and every blob. */
function afterCrash(volume) {
  return {
    files: new Map(volume.files),
    blobs: new Map([...volume.blobs].map(([k, v]) => [k, { bytes: v.bytes.slice() }])),
    journal: volume.journal.slice(0, volume.journalFlushed),
    journalFlushed: volume.journalFlushed,
  };
}

function concatAt(head, at, tail) {
  const out = new Uint8Array(at + tail.length);
  out.set(head.subarray(0, Math.min(at, head.length)), 0);
  out.set(tail, at);
  return out;
}

function putBytes(blob, src, at) {
  if (at + src.length > blob.bytes.length) {
    const grown = new Uint8Array(at + src.length);
    grown.set(blob.bytes, 0);
    blob.bytes = grown;
  }
  blob.bytes.set(src, at);
  return src.length;
}

/**
 * The I/O worker's surface over a `newVolume()`, faithful to src/kernel/iocore.mjs in the parts the
 * cases below depend on: one refcounted handle per NAME, a free deferred while a handle is open, a
 * strictly consecutive journal sequence with a burn, and `copy` reporting `want` beside `copied`.
 *
 * `hooks` is keyed by request kind and runs before the worker: a hook returning anything but
 * `undefined` answers in its place, which is how an errno lands on exactly one call. `after` runs
 * once the worker has done the work and before the answer is returned — the reply's trip back — and
 * that distinction is load-bearing. A flush held before it runs still flushes whatever was appended
 * while it waited, so a hook on the way in cannot reproduce "the bytes were flushed and then
 * something was appended"; only one on the way out can.
 */
function makeIo(volume, hooks = {}, after = {}) {
  const handles = new Map();
  const byName = new Map();
  const pendingFree = new Set();
  const view = new Uint8Array(REGION);
  let nextId = 1;
  let journalAt = volume.journal.length;
  let journalSeq = null;
  const counts = { opens: 0, reusedOpens: 0, writes: 0, flushes: 0, journalAppends: 0 };

  const open = (dir, name, ino, gen, create) => {
    const key = `${dir}/${name}`;
    const existing = byName.get(key);
    if (existing) {
      existing.refs += 1;
      counts.reusedOpens += 1;
      return { id: existing.id, refs: existing.refs, size: existing.blob.bytes.length,
        reused: true };
    }
    let blob = volume.blobs.get(name);
    if (!blob) {
      if (create !== true) return -EIO;
      blob = { bytes: new Uint8Array(0) };
      volume.blobs.set(name, blob);
    }
    const entry = { id: nextId++, dir, name, key, ino, gen, refs: 1, blob };
    handles.set(entry.id, entry);
    byName.set(key, entry);
    counts.opens += 1;
    return { id: entry.id, refs: 1, size: blob.bytes.length, reused: false };
  };

  const io = {
    view,
    counts,
    get journalAt() { return journalAt; },
    async request(t, m) {
      const hook = hooks[t];
      if (hook) {
        const early = await hook(m, io);
        if (early !== undefined) return early;
      }
      const answer = await io.serve(t, m);
      const post = after[t];
      if (post) await post(m, io, answer);
      return answer;
    },
    async serve(t, m) {
      switch (t) {
        case IO_LOCK:
          return { ok: true, why: "", waitedMs: 0, attempts: 1, size: journalAt };
        case IO_READ_ALL: {
          if (m.name === JOURNAL_NAME) {
            return { bytes: volume.journal.slice().buffer, size: volume.journal.length };
          }
          const bytes = volume.files.get(m.name);
          if (!bytes) return { bytes: null, size: -1, absent: true };
          return { bytes: bytes.slice().buffer, size: bytes.length };
        }
        case IO_WRITE_ALL:
          volume.files.set(m.name, new Uint8Array(m.bytes));
          return 0;
        case IO_LIST: {
          if ((m.dir || "") !== BLOB_DIR) return -EINVAL;
          const out = [];
          for (const [name, blob] of volume.blobs) {
            out.push(m.namesOnly ? { name } : { name, size: blob.bytes.length });
          }
          return out;
        }
        case IO_BLOB_OPEN:
          return open(BLOB_DIR, blobName(m.ino, m.gen), m.ino, m.gen, m.create === true);
        case IO_WRITE: {
          const h = handles.get(m.id);
          if (!h) return -EBADF;
          counts.writes += 1;
          return putBytes(h.blob, view.subarray(m.srcOff, m.srcOff + m.length), m.at);
        }
        case IO_READ: {
          const h = handles.get(m.id);
          if (!h) return -EBADF;
          const want = Math.max(0, Math.min(m.length, h.blob.bytes.length - m.at));
          view.set(h.blob.bytes.subarray(m.at, m.at + want), m.dstOff);
          return want;
        }
        case IO_COPY: {
          const from = handles.get(m.from);
          const to = handles.get(m.to);
          if (!from || !to) return -EBADF;
          const source = from.blob.bytes.length;
          const at = m.at === undefined ? 0 : m.at;
          const want = m.length !== undefined
            ? m.length
            : (m.limit === undefined ? source : Math.min(m.limit, source));
          const slice = from.blob.bytes.subarray(at, at + Math.max(0, Math.min(
            want, source - at)));
          const copied = slice.length ? putBytes(to.blob, slice, at) : 0;
          return { source, want, copied };
        }
        case IO_SIZE: {
          const h = handles.get(m.id);
          return h ? h.blob.bytes.length : -EBADF;
        }
        case IO_FSYNC: {
          const h = handles.get(m.id);
          if (!h) return -EBADF;
          counts.flushes += 1;
          return 0;
        }
        case IO_TRUNCATE: {
          const h = handles.get(m.id);
          if (!h) return -EBADF;
          const next = new Uint8Array(m.size);
          next.set(h.blob.bytes.subarray(0, Math.min(m.size, h.blob.bytes.length)), 0);
          h.blob.bytes = next;
          return 0;
        }
        case IO_CLOSE: {
          const h = handles.get(m.id);
          if (!h) return -EBADF;
          if (--h.refs > 0) return h.refs;
          handles.delete(h.id);
          byName.delete(h.key);
          if (pendingFree.has(h.key)) {
            pendingFree.delete(h.key);
            volume.blobs.delete(h.name);
          }
          return 0;
        }
        case IO_FREE: {
          const name = blobName(m.ino, m.gen);
          const key = `${BLOB_DIR}/${name}`;
          const entry = byName.get(key);
          if (entry && entry.refs > 0) {
            pendingFree.add(key);
            return { freed: false, deferred: true, refs: entry.refs };
          }
          volume.blobs.delete(name);
          return { freed: true, deferred: false, refs: 0 };
        }
        case IO_JOURNAL:
          switch (m.op) {
            case "append": {
              const bytes = new Uint8Array(m.bytes);
              const r = decodeRecord(bytes, 0, { checkCrc: false });
              if (!r.ok) return -EIO;
              if (journalSeq === null || r.seq !== journalSeq) return -EIO;
              volume.journal = concatAt(volume.journal, journalAt, bytes);
              journalAt = volume.journal.length;
              journalSeq = r.seq + 1n;
              counts.journalAppends += 1;
              return bytes.length;
            }
            case "burn": {
              if (journalSeq === null) return -EIO;
              const seq = BigInt(m.burnedSeq);
              if (seq + 1n > journalSeq) journalSeq = seq + 1n;
              return 0;
            }
            case "resume":
              journalSeq = BigInt(m.nextSeq);
              return 0;
            case "flush":
              volume.journalFlushed = journalAt;
              return 0;
            case "truncate":
              volume.journal = new Uint8Array(0);
              volume.journalFlushed = 0;
              journalAt = 0;
              return 0;
            case "size":
              return journalAt;
            default:
              return -EINVAL;
          }
        case IO_STATS:
          return { counts: { ...counts }, handles: handles.size, names: byName.size,
            pendingFree: pendingFree.size, trace: [], traced: 0, dropped: 0 };
        default:
          return -EINVAL;
      }
    },
  };
  return io;
}

/** A mounted Store over `volume`, with its notes collected: a refusal nobody awaits is evidence.
 *  `before` runs with the store built and not yet mounted, which is the only place a control can
 *  put back a line the mount path takes. */
async function mountStore(volume, { hooks = {}, after = {}, cfg = {}, before = null } = {}) {
  const notes = [];
  const io = makeIo(volume, hooks, after);
  const store = new Store(io, cfg, (why) => notes.push(why));
  if (before) before(store);
  const report = await store.mount();
  return { store, io, notes, report, volume };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Create a file and return its description. The journal record for the create goes with it. */
async function makeFile(h, path, { flags = O_WRONLY } = {}) {
  const decision = h.store.vfs.openDecision(ROOT_CRED, path, {
    create: true, wantW: true, wantR: true, mode: 0o644,
  });
  if (decision.created) {
    const r = await h.store.journal(decision.created);
    if (r < 0) throw new Error(`the create record would not append: errno ${-r}`);
  }
  const d = await h.store.openFd(decision);
  if (typeof d === "number") throw new Error(`openFd refused: errno ${-d}`);
  d.flags = flags;
  return d;
}

async function openAgain(h, path, { flags = O_WRONLY } = {}) {
  const decision = h.store.vfs.openDecision(ROOT_CRED, path, { wantW: true, wantR: true });
  const d = await h.store.openFd(decision);
  if (typeof d === "number") throw new Error(`openFd refused: errno ${-d}`);
  d.flags = flags;
  return d;
}

/** One write through a description, with the bytes staged in the "process" region first. */
async function write(h, d, bytes, at) {
  h.io.view.set(bytes, 0);
  return h.store.writeFd(d, PID, 0, bytes.length, at);
}

async function readWhole(h, d, length) {
  const n = await h.store.readFd(d, PID, 0, length, 0);
  if (n < 0) return n;
  return h.io.view.slice(0, n);
}

const filled = (len, byte) => new Uint8Array(len).fill(byte);
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const results = [];
/** `family` is the finding this case is evidence for. `--control` is scored per family, because a
 *  control scored on a count passes with one rule still working. */
function record(family, name, ok, detail) {
  results.push({ family, name, ok: !!ok, detail: ok ? undefined : detail });
}

const FAMILIES = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"];

/**
 * F1. O_APPEND is an offset per write.
 *
 * One process, no race: an 8-byte file, two descriptions opened for append, one 4-byte write and
 * one fsync on each. POSIX puts both writers' bytes in the file, so the file is 16 bytes and the
 * first writer's four are still there.
 *
 * The control takes the offset once at open (`d.pos = endFd(d)`) and sets no flag on the
 * description, so nothing re-reads the end per write.
 */
async function f1_append(unfix) {
  const h = await mountStore(newVolume());
  const path = "/append";
  const base = filled(8, 0x11);
  const d0 = await makeFile(h, path);
  await write(h, d0, base, undefined);
  await h.store.fsyncFd(d0);
  await h.store.closeFd(d0);

  const flags = unfix ? O_WRONLY : (O_WRONLY | O_APPEND);
  const fds = [];
  for (let i = 0; i < 2; i += 1) {
    const d = await openAgain(h, path, { flags });
    if (unfix) {
      // The seek taken once at open, which nothing re-does per write.
      const end = await h.store.endFd(d);
      d.pos = end;
    }
    fds.push(d);
  }
  const wrote = [];
  const synced = [];
  for (const [i, d] of fds.entries()) {
    wrote.push(await write(h, d, filled(4, 0xa0 + i), undefined));
    synced.push(await h.store.fsyncFd(d));
  }
  for (const d of fds) await h.store.closeFd(d);

  const reader = await openAgain(h, path);
  const got = await readWhole(h, reader, 64);
  await h.store.closeFd(reader);
  const want = new Uint8Array([...base, ...filled(4, 0xa0), ...filled(4, 0xa1)]);

  record("f1", "both O_APPEND writes were acknowledged", wrote.join() === "4,4"
    && synced.join() === "0,0", { wrote, synced });
  record("f1", "two O_APPEND writers both keep their bytes",
    got instanceof Uint8Array && hex(got) === hex(want),
    { got: got instanceof Uint8Array ? hex(got) : got, want: hex(want) });
  record("f1", "the file ends where both appends put it",
    got instanceof Uint8Array && got.length === 16, { bytes: got.length, want: 16 });
  record("f1", "the storage edge raised no note", h.notes.length === 0, h.notes);
}

/**
 * F2. An errno from the blob listing is not an empty directory.
 *
 * Two arms, because the conversion has two callers. The explicit fsck's sweep must report that it
 * could not enumerate, not that every committed blob the metadata names is absent — the one verdict
 * that means data was never written. And the mount's staging floor must refuse to hand out
 * generation numbers it cannot see, which means mounting read-only.
 *
 * The control re-installs the errno-to-empty-array conversion on both methods.
 */
async function f2_listing(unfix) {
  const volume = newVolume();
  const h = await mountStore(volume);
  const d = await makeFile(h, "/listed");
  await write(h, d, filled(8, 0x22), undefined);
  await h.store.fsyncFd(d);
  await h.store.closeFd(d);
  const committed = h.store.vfs.blobNames().length;

  // The listing refuses from here on, which is a free racing an fsck or a quota error.
  const refusing = await mountStore(afterCrash(volume), {
    hooks: { [IO_LIST]: () => -EIO },
    before: (store) => {
      if (!unfix) return;
      store.blobListing = async () => [];
      store.blobNameListing = async () => [];
    },
  });
  const report = await refusing.store.check();
  const blobs = report.blobs || {};
  const absent = (report.problems || []).filter(
    (p) => p.what === "blobs" && /ABSENT/.test(p.why));
  const named = (report.problems || []).filter(
    (p) => p.what === "blobs" && /could not be enumerated/.test(p.why));

  record("f2", "a file with a committed blob was set up", committed === 1, { committed });
  record("f2", "a refused sweep does not read as a swept directory",
    blobs.swept === false && blobs.attempted === true, blobs);
  record("f2", "the refused sweep names the errno", blobs.errno === EIO && named.length === 1,
    { errno: blobs.errno, named });
  record("f2", "a refused sweep does not report committed blobs as absent",
    absent.length === 0, absent);

  // The mount arm. A floor nobody could read is not a floor of zero.
  const mounted = await mountStore(afterCrash(volume), {
    hooks: { [IO_LIST]: () => -EIO },
    // With the errno as an empty listing the mount carries on read-write, ready to hand generation
    // 1 out again.
    before: (store) => { if (unfix) store.blobNameListing = async () => []; },
  });
  record("f2", "a mount that cannot read the staging floor is read-only",
    mounted.store.mode === MOUNT_RO && mounted.store.readOnly === true,
    { mode: mounted.store.mode });
  record("f2", "and says why", (mounted.report.problems || []).some(
    (p) => p.what === "blobs" && /staging floor is unknown/.test(p.why)),
  mounted.report.problems);
}

/**
 * F3. A failed journal append takes the publish with it.
 *
 * The commit applies the op in memory as its validation and appends the record two awaits later.
 * When the append refuses, the record is not in the file and its sequence is burned, so nothing
 * will ever name that generation and a tree that keeps it published disagrees with both the journal
 * and the next mount. The assertion is that disagreement, read as a number on both sides: what the
 * live kernel reports for the file, and what a kernel mounted over the same bytes reports.
 *
 * The control is a revert that does nothing.
 */
async function f3_journal_fails(unfix) {
  const volume = newVolume();
  const h = await mountStore(volume);
  const path = "/unjournalled";
  const d = await makeFile(h, path);
  // The create is folded into the image, so the only thing the journal can carry is the commit.
  await h.store.writeSnapshot();
  if (unfix) h.store.vfs.revertCommit = () => {};

  // The write must succeed and only the commit's record refuse, so what is lost is a publish
  // rather than a write nobody acknowledged.
  const wrote = await write(h, d, filled(4, 0x33), undefined);
  const origin = h.io.request.bind(h.io);
  let appends = 0;
  h.io.request = async (t, m) => {
    if (t === IO_JOURNAL && m.op === "append") {
      appends += 1;
      if (appends === 1) return -EIO;
    }
    return origin(t, m);
  };
  const synced = await h.store.fsyncFd(d);
  h.io.request = origin;

  const live = h.store.vfs.stat(ROOT_CRED, path);
  const next = await mountStore(afterCrash(volume));
  const replayed = next.store.vfs ? next.store.vfs.stat(ROOT_CRED, path) : null;

  record("f3", "the write was acknowledged and the fsync refused",
    wrote === 4 && synced === -EIO, { wrote, synced });
  record("f3", "the live tree publishes no generation the journal does not name",
    live.gen === 0 && live.size === 0, { gen: live.gen, size: live.size });
  record("f3", "the live tree and the next mount agree",
    !!replayed && replayed.gen === live.gen && replayed.size === live.size,
    { live: { gen: live.gen, size: live.size },
      replayed: replayed && { gen: replayed.gen, size: replayed.size } });
  record("f3", "the refusal was named", h.notes.some((n) => /could not be journalled/.test(n)),
    h.notes);
  await h.store.closeFd(d);
}

/**
 * F4. The idle flush cannot lose the record appended inside it.
 *
 * The timer fires, nulls itself, reads `dirty`, and awaits a flush. A record appended inside that
 * await is the case: the flag it set is cleared by the flush that did not include it, and the timer
 * it re-armed then finds nothing to do.
 *
 * The flush is held open by a hook, which is the only way to put an append inside a window that is
 * otherwise a few hundred microseconds wide. The loss is read off the volume: the journal's flushed
 * prefix is what the next boot gets, so a record above it is gone.
 *
 * The control puts back the late clear **and** removes the volume lock, and the pair is deliberate.
 * F5's lock closes this window too, because every read and every write of `dirty` happens under it,
 * so a control that put back only the late clear would stay green on a line that is genuinely
 * wrong. Both fixes are kept: the claim-before-await makes `flushJournal` correct on its own terms
 * rather than correct because something else serialises it.
 */
async function f4_idle_flush(unfix) {
  const volume = newVolume();
  let holding = null;
  const h = await mountStore(volume, {
    // On the way out, so the bytes really are flushed and the append below lands after the flush
    // and before the store sees its answer. That window is the reply's trip back from the worker.
    after: {
      [IO_JOURNAL]: async (m) => {
        if (m.op !== "flush" || !holding) return;
        await holding;
      },
    },
  });
  if (unfix) {
    h.store.withVolume = (body) => body();
    h.store.flushJournalHeld = async function lateClear() {
      if (!this.dirty) return 0;
      const r = await this.io.request(IO_JOURNAL, { op: "flush" });
      if (r === 0) {
        this.dirty = false;
        this.stats.journalFlushes += 1;
      }
      return r;
    }.bind(h.store);
  }

  // One record, then let the idle timer take it.
  const first = h.store.vfs.mkdir(ROOT_CRED, "/early", { mode: 0o755 });
  await h.store.journal(first);
  let release;
  holding = new Promise((r) => { release = r; });
  await sleep(JOURNAL_IDLE_MS + 60);
  // The flush is parked inside its await now. This record is issued into that window and not
  // awaited first: with the volume lock in place it is queued behind the flush, and the flush is
  // waiting on the line below.
  const second = h.store.vfs.mkdir(ROOT_CRED, "/late", { mode: 0o755 });
  const appending = h.store.journal(second);
  await sleep(20);
  release();
  holding = null;
  const appended = await appending;
  // Long enough for the re-armed timer to fire and for any flush it starts to finish.
  await sleep(JOURNAL_IDLE_MS * 3 + 120);

  const next = await mountStore(afterCrash(volume));
  const tree = next.store.vfs;
  const has = (p) => {
    try {
      return !!tree.stat(ROOT_CRED, p);
    } catch {
      return false;
    }
  };
  record("f4", "both records were appended", appended === 0, { appended });
  record("f4", "the record before the idle flush is durable", has("/early"), next.report.problems);
  record("f4", "the record appended inside the idle flush is durable", has("/late"),
    { flushed: volume.journalFlushed, written: volume.journal.length,
      problems: next.report.problems });
  record("f4", "the volume still mounts read-write", next.store.mode === MOUNT_RW,
    { mode: next.store.mode, problems: next.report.problems });
}

/**
 * F5. The snapshot and the journal take the same lock.
 *
 * A snapshot serialises the tree with `journalFirstSeq = seq` and then truncates the journal. A
 * record allocated after the serialize and destroyed by the truncate took exactly the sequence the
 * image says the journal starts at, so replay reads an empty journal that starts where it expects,
 * reports no gap and no discarded tail, and the op is gone with the volume reported clean. That
 * last part is what makes it worth a lock rather than a report.
 *
 * The window is held open by a hook on the superblock write, which is where the real one is 260 us
 * of flush wide.
 *
 * The control is a volume lock that lets anything through, so `journal` and `writeSnapshot`
 * serialise against nothing.
 */
async function f5_snapshot_lock(unfix) {
  const volume = newVolume();
  let holding = null;
  const h = await mountStore(volume, {
    hooks: {
      [IO_WRITE_ALL]: async () => {
        if (!holding) return undefined;
        await holding;
        return undefined;
      },
    },
  });
  if (unfix) h.store.withVolume = (body) => body();

  let release;
  holding = new Promise((r) => { release = r; });
  const snapshot = h.store.writeSnapshot();
  // The snapshot is parked on its superblock write, past the serialize and before the truncate.
  await sleep(10);
  const op = h.store.vfs.mkdir(ROOT_CRED, "/inside", { mode: 0o755 });
  const appended = h.store.journal(op);
  await sleep(10);
  release();
  holding = null;
  const r = await snapshot;
  const appendedR = await appended;
  await h.store.flushJournal();

  const next = await mountStore(afterCrash(volume));
  const has = (p) => {
    try {
      return !!next.store.vfs.stat(ROOT_CRED, p);
    } catch {
      return false;
    }
  };
  record("f5", "the snapshot and the append both succeeded", r === 0 && appendedR === 0,
    { snapshot: r, appended: appendedR });
  record("f5", "an op journalled across a snapshot survives the remount", has("/inside"),
    { journal: volume.journal.length, flushed: volume.journalFlushed,
      problems: next.report.problems });
  record("f5", "and the volume does not report a problem for it",
    next.store.mode === MOUNT_RW && (next.report.problems || []).length === 0,
    { mode: next.store.mode, problems: next.report.problems });
}

/**
 * F6. An errno from a superblock slot is not an absent slot.
 *
 * The same correction as F2, on the reader the mount decides the volume's whole fate from. With an
 * errno and a missing file both collapsing to `null`, a volume whose slots cannot be read is
 * indistinguishable from one nobody ever wrote — and the journal is empty on a healthy volume,
 * because the last snapshot truncates it. All three facts fsck weighs are then absent, the verdict
 * is FRESH, and the fresh arm is the one arm allowed to write: a new superblock over live blobs,
 * read-write, with `problems` empty. Constraint 28's named defect, reached through an error path
 * rather than a bad image.
 *
 * Three arms, because the right answer is a different verdict each time:
 *
 *   every slot refused   there is no image, so REFUSE and keep the bytes. Never FRESH.
 *   one slot refused     the readable slots still carry the volume, so READ-ONLY at that
 *                        generation with the slot and its errno named — and a tree to read.
 *   the explicit fsck    `unreadableSlots` is its own count, so a refused read is not added to
 *                        `absentSlots` and reported as a young filesystem.
 *
 * The control re-installs the collapse on `readWhole`, the one method the mount and the explicit
 * fsck both read slots through. Under it this case reports `mountable: "fresh"`, `mode: "rw"`,
 * `problems: []`, a slot rewritten on disk, and a tree of one inode where the volume had two.
 */
async function f6_slot_errno(unfix) {
  const volume = newVolume();
  const h = await mountStore(volume);
  const d = await makeFile(h, "/kept");
  await write(h, d, filled(8, 0x66), undefined);
  await h.store.fsyncFd(d);
  await h.store.closeFd(d);
  // The snapshot truncates the journal, so the volume's only remaining evidence of itself is the
  // slots this case makes unreadable.
  await h.store.writeSnapshot();
  const inodesBefore = h.store.vfs.stats().inodes;

  // One `null` for an errno and for an absent file alike.
  const collapse = (store) => {
    if (!unfix) return;
    store.readWhole = async function preFix(name) {
      const r = await this.io.request(IO_READ_ALL, { dir: "", name });
      return typeof r === "number" || !r.bytes ? null : new Uint8Array(r.bytes);
    }.bind(store);
  };

  // ---- arm 1: every slot refuses ------------------------------------------------------
  const wrecked = afterCrash(volume);
  const journalBytes = wrecked.journal.length;
  const onDisk = () => [...wrecked.files].map(([k, v]) => `${k}:${hex(v)}`).sort().join("|");
  const diskBefore = onDisk();
  const all = await mountStore(wrecked, {
    hooks: { [IO_READ_ALL]: (m) => (m.name === JOURNAL_NAME ? undefined : -EIO) },
    before: collapse,
  });

  record("f6", "a populated volume with an empty journal was set up",
    inodesBefore === 2 && journalBytes === 0 && diskBefore !== "",
    { inodesBefore, journalBytes, diskBefore: diskBefore.slice(0, 120) });
  record("f6", "a volume whose slots cannot be READ is never a first boot",
    all.report.mountable !== MOUNT_FRESH && all.store.mode !== MOUNT_RW,
    { mountable: all.report.mountable, mode: all.store.mode });
  record("f6", "with no readable slot it REFUSES", all.store.mode === MOUNT_REFUSE,
    { mode: all.store.mode, problems: all.report.problems });
  record("f6", "and nothing was written over the volume", onDisk() === diskBefore,
    { before: diskBefore.slice(0, 200), after: onDisk().slice(0, 200) });
  record("f6", "and the refusal names the slots and the errno",
    (all.report.problems || []).some(
      (p) => p.what === "superblock" && /could not be READ/.test(p.why)
        && new RegExp(`errno ${EIO}`).test(p.why)),
    all.report.problems);
  record("f6", "and no tree was invented", all.store.vfs === null,
    { inodes: all.store.vfs && all.store.vfs.stats() });

  // ---- arm 2: one slot refuses, and it is the oldest -----------------------------------
  //
  // Three snapshots so all three slots hold live copies, then the oldest is made unreadable, so the
  // generation the volume comes up at is the one it was already on and a clause on it cannot pass
  // by falling back.
  await h.store.writeSnapshot();
  await h.store.writeSnapshot();
  const generationBefore = String(h.store.generation);
  const oldest = SUPER_SLOTS[(h.store.slot + 1) % SUPER_SLOTS.length];
  const partial = afterCrash(volume);
  const slotsOnDisk = SUPER_SLOTS.filter((n) => partial.files.has(n)).length;
  const one = await mountStore(partial, {
    hooks: { [IO_READ_ALL]: (m) => (m.name === oldest ? -EIO : undefined) },
    before: collapse,
  });

  record("f6", "all three slots hold a live snapshot", slotsOnDisk === SUPER_SLOTS.length,
    { slotsOnDisk, names: [...partial.files.keys()] });
  record("f6", "one unreadable slot mounts READ-ONLY, not read-write",
    one.store.mode === MOUNT_RO && one.store.readOnly === true,
    { mode: one.store.mode, problems: one.report.problems });
  record("f6", "at the generation the readable slots name",
    String(one.store.generation) === generationBefore,
    { got: String(one.store.generation), want: generationBefore });
  record("f6", "and says which slot could not be read",
    (one.report.problems || []).some(
      (p) => p.what === "superblock" && /could not be READ/.test(p.why)),
    one.report.problems);
  record("f6", "and the tree is still readable", !!one.store.vfs
    && one.store.vfs.stats().inodes === inodesBefore,
  { inodes: one.store.vfs && one.store.vfs.stats() });

  // ---- arm 3: the explicit fsck counts it apart from absent ----------------------------
  const report = await one.store.check();
  record("f6", "the explicit fsck counts an unreadable slot as neither absent nor damaged",
    report.superblock && report.superblock.unreadableSlots === 1
    && report.superblock.damagedSlots === 0 && report.superblock.absentSlots === 0,
    report.superblock);
}

/**
 * F7. The snapshot and its journal truncate fail together.
 *
 * The slot is written and flushed, and only then is the journal truncated. A refused truncate that
 * returns its errno there and leaves the new slot on disk gives the volume a generation the kernel
 * does not believe in, and the next mount finds out: it picks the highest valid slot, reads
 * `journalFirstSeq` off it, and replays a journal that starts before that base. The records already
 * folded into the image come back, the gap rule fires, and the volume mounts read-only on a
 * snapshot that was never completed.
 *
 * The pair fails by undoing the durable half, which is `commitOnce`'s shape: the slot this call
 * wrote is invalidated with a zero-length write, and the volume stays where it was.
 *
 * The control drops the undo's write and nothing else, answering 0 without touching the file, so
 * the real `snapshotHeld` stays the subject.
 */
async function f7_snapshot_truncate(unfix) {
  const volume = newVolume();
  // Armed after the mount, because a fresh volume's mount writes the first superblock and truncates
  // the journal behind it. Refusing that one puts the volume read-only before the case has started,
  // which is the right behaviour and the wrong subject.
  let armed = false;
  const h = await mountStore(volume, {
    hooks: {
      [IO_JOURNAL]: (m) => (armed && m.op === "truncate" ? -EIO : undefined),
      // The undo is the only zero-length superblock write there is.
      [IO_WRITE_ALL]: (m) => (unfix && armed && m.bytes.byteLength === 0 ? 0 : undefined),
    },
  });
  // A record in the journal, flushed, so the truncate has something to destroy and the two halves
  // have a disagreement to make.
  const appended = await h.store.journal(
    h.store.vfs.mkdir(ROOT_CRED, "/before", { mode: 0o755 }));
  await h.store.flushJournal();
  const generationBefore = String(h.store.generation);
  const slotBefore = h.store.slot;
  const journalBefore = volume.journal.length;

  armed = true;
  const r = await h.store.writeSnapshot();

  const next = await mountStore(afterCrash(volume));
  const has = (p) => {
    try {
      return !!(next.store.vfs && next.store.vfs.stat(ROOT_CRED, p));
    } catch {
      return false;
    }
  };

  record("f7", "the record was appended and flushed and the snapshot refused",
    appended === 0 && journalBefore > 0 && r === -EIO,
    { appended, journalBefore, snapshot: r });
  record("f7", "the live kernel did not advance past a snapshot that did not complete",
    String(h.store.generation) === generationBefore && h.store.slot === slotBefore,
    { generation: String(h.store.generation), want: generationBefore,
      slot: h.store.slot, wantSlot: slotBefore });
  record("f7", "the next mount reads the same generation the live kernel holds",
    String(next.store.generation) === generationBefore,
    { next: String(next.store.generation), live: generationBefore,
      problems: next.report.problems });
  record("f7", "and it mounts read-write with nothing to report",
    next.store.mode === MOUNT_RW && (next.report.problems || []).length === 0,
    { mode: next.store.mode, problems: next.report.problems });
  record("f7", "and the op the journal carried is still there", has("/before"),
    { journal: volume.journal.length, flushed: volume.journalFlushed });
  record("f7", "the abandoned snapshot was named", h.notes.some(
    (n) => /journal truncate refused/.test(n)), h.notes);
}

/**
 * F8. The commit's undo puts `opSeq` back.
 *
 * `applyOp` bumps `opSeq` on every op and `serialize` writes it into the image, so an undo that
 * restores the generation, the size and the timestamps but not that counter leaves the image
 * carrying a number no record accounts for. Reached through the same refused append as F3: the
 * commit applies in memory as its validation, the record will not land, and the apply is undone.
 *
 * The control is a revert that puts the current value back, which is what happens when the state
 * object carries no `opSeq` and the field is never assigned.
 */
async function f8_revert_opseq(unfix) {
  const volume = newVolume();
  const h = await mountStore(volume);
  const path = "/counted";
  const d = await makeFile(h, path);
  await h.store.writeSnapshot();
  if (unfix) {
    const real = h.store.vfs.revertCommit.bind(h.store.vfs);
    h.store.vfs.revertCommit = (ino, state) => real(
      ino, { ...state, opSeq: h.store.vfs.opSeq });
  }
  const before = h.store.vfs.opSeq;

  const wrote = await write(h, d, filled(4, 0x88), undefined);
  const origin = h.io.request.bind(h.io);
  let appends = 0;
  h.io.request = async (t, m) => {
    if (t === IO_JOURNAL && m.op === "append") {
      appends += 1;
      if (appends === 1) return -EIO;
    }
    return origin(t, m);
  };
  const synced = await h.store.fsyncFd(d);
  h.io.request = origin;
  // Read before the close. A description whose commit refused is still dirty, so `closeFd` commits
  // it again, and that commit succeeds, applies, and bumps the counter past what is measured here.
  const after = h.store.vfs.opSeq;
  const serialized = h.store.vfs.serialize().opSeq;
  await h.store.closeFd(d);

  record("f8", "the write was acknowledged and the fsync refused",
    wrote === 4 && synced === -EIO, { wrote, synced });
  record("f8", "the undo put opSeq back where it was", after === before, { before, after });
  record("f8", "and the image carries that number and no other", serialized === before,
    { serialized, want: before });
}

const CASES = [
  ["f1", f1_append],
  ["f2", f2_listing],
  ["f3", f3_journal_fails],
  ["f4", f4_idle_flush],
  ["f5", f5_snapshot_lock],
  ["f6", f6_slot_errno],
  ["f7", f7_snapshot_truncate],
  ["f8", f8_revert_opseq],
];

async function main() {
  const control = process.argv.includes("--control");
  const broken = [];
  for (const [family, fn] of CASES) {
    try {
      await fn(control);
    } catch (error) {
      // A case that threw measured nothing and must not be read as a pass.
      broken.push({ family, why: String((error && error.stack) || error) });
      record(family, `${family} ran to completion`, false, String(error && error.message));
    }
  }
  const failed = results.filter((r) => !r.ok);
  const perFamily = {};
  for (const family of FAMILIES) {
    perFamily[family] = {
      total: results.filter((r) => r.family === family).length,
      failed: failed.filter((r) => r.family === family).length,
    };
  }
  const silent = FAMILIES.filter((f) => perFamily[f].failed === 0);
  console.log(JSON.stringify({
    control,
    // In control mode the failures are the product: a family that stays clean means its assertions
    // are not coupled to the line the fix is on.
    ok: control ? silent.length === 0 && broken.length === 0 : failed.length === 0,
    total: results.length,
    failed: failed.length,
    families: perFamily,
    silentFamilies: silent,
    broken,
    failures: failed,
    names: results.map((r) => `${r.family} ${r.name}`),
  }, null, 2));
  process.exit((control ? silent.length === 0 && broken.length === 0 : failed.length === 0)
    ? 0 : 1);
}

main();
