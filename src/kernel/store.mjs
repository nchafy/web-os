// The storage edge. src/fs/ is pure; every byte that reaches a disk goes through here, and this is
// the only place in the filesystem that knows an OPFS exists. Flush points are fsync, snapshot and
// idle (constraint 23).
//
// Constraint 60 is the contract: blob -> flush -> validate -> apply in memory -> journal -> flush.
// A write below the committed size stages a new generation; a write at or beyond it appends into
// the current one.
//
// A description caches no durable state: it is read at the point of use through `resolve()`, and
// every durable read-then-mutate runs under the per-inode mutex, whose rule is on `withInode`.
//
// STAGED BASE VERSUS LIVE BASE. A staged generation is private; the base it was copied from is not.
// The description records that base — `baseMut`, the inode's mutation counter as the copy was
// taken, and `baseEnd`, how far it reached — plus the ordered log of its own modifications, and
// `stagedEnd()` replays the log onto a base. A size derived from the copy and published later
// reverts bytes `pwrite` and `fsync` both acknowledged, with fsck reporting the volume clean.
//
// THE PUBLISHED SIZE IS THE ONLY AUTHORITY ON WHAT A FILE CONTAINS. An uncommitted append lives in
// the generation the inode already points at, so "is there an append to publish" is the per-inode
// handle row's `end` and never the blob's physical length: a crash leaves bytes above the published
// size that nothing on disk distinguishes from committed data. The row's `end` starts at the
// published size, so a crash takes the slack with it, and fsck reports those bytes as slack.

import {
  IO_BLOB_OPEN, IO_WRITE, IO_READ, IO_FSYNC, IO_CLOSE, IO_TRUNCATE, IO_FREE, IO_LIST,
  IO_READ_ALL, IO_WRITE_ALL, IO_LOCK, IO_JOURNAL, IO_COPY, IO_SIZE, IO_STATS,
  BLOB_DIR, JOURNAL_NAME, SUPER_SLOTS, BOOT_LOCK_BUDGET_MS, BOOT_LOCK_FIRST_MS,
  JOURNAL_IDLE_MS, O_APPEND,
  E, EBUSY, EIO, EROFS, ESTALE,
} from "../abi.mjs";
import { VFS, FsError, encodeOp, blobName } from "../fs/vfs.mjs";
import { encodeRecord } from "../fs/journal.mjs";
import { encodeSuperblock } from "../fs/superblock.mjs";
import { encodeImage } from "../fs/image.mjs";
import { fsck, MOUNT_RW, MOUNT_RO, MOUNT_FRESH, MOUNT_REFUSE, jsonSafe } from "../fs/fsck.mjs";

export { MOUNT_RW, MOUNT_RO, MOUNT_FRESH, MOUNT_REFUSE };

/** How many times one `commit` re-stages before answering -EBUSY rather than reverting silently. */
const COMMIT_ATTEMPTS = 4;

/** `commitOnce`'s third answer: validation refused and the caller must re-stage. A sentinel, so it
 *  cannot reach userland as an errno. */
const REBASE = Symbol("rebase");

/**
 * The reserved lock key for the volume's own state: the journal's sequence counter, the journal
 * file, and the superblock slot a snapshot writes. The journal sequence belongs to no inode, so
 * there is no inode a snapshot could hold that would exclude an append.
 *
 * THE LOCK ORDER IS INODE THEN VOLUME, never the reverse; fsfuzz.py's `order` rule lints it.
 */
const VOLUME = Symbol("volume");

/**
 * The compare-and-swap's comparison: the inode's mutation counter, off the per-inode handle row.
 * Not a tuple such as `(gen, end)` — an in-place write inside the slack, above the published size
 * and below the row's `end`, changes the bytes and moves neither, so a CAS over those passes and a
 * staged commit reverts bytes another description had fsynced, with fsck reporting clean. Bumped by
 * `writeFd`'s append arm and `commitOnce`'s publish; a private staged generation bumps nothing.
 */
function moved(base, now) {
  return base.mut !== now.mut;
}

/** An FsError's code becomes an errno in one place. A code with no entry is -EIO. */
export function errnoOfFsError(error) {
  if (error instanceof FsError) return -(E[error.code] ?? EIO);
  return -EIO;
}

export class Store {
  /** `cfg.noCowOrder` and `cfg.noCrc` are the two negative-control stages; kernel.mjs gates both on
   *  a bench boot. `io` is the dispatch kernel's I/O worker surface. */
  constructor(io, cfg = {}, note = null) {
    this.io = io;
    this.cfg = cfg;
    /** How a refusal nobody is awaiting reaches the page: a commit inside a teardown, or a blob the
     *  metadata names that is not on disk. */
    this.note = note || (() => {});
    this.vfs = null;
    this.mode = MOUNT_REFUSE;
    this.report = null;
    this.lock = null;
    /** The journal record sequence. Monotonic from the snapshot's base, so replay can see a gap. */
    this.seq = 0n;
    this.journalFirstSeq = 0n;
    this.generation = 0n;
    this.slot = -1;
    /** ino -> the highest generation this kernel has STAGED, committed or not. Never handed out
     *  twice: a staged-and-lost blob is on disk until a sweep reclaims it, so reusing its name
     * would  write into bytes fsck is about to report. */
    this.highestGen = new Map();
    /**
     * ino -> { gen, id, users, end, mut }. The sync access handle for an inode's CURRENT committed
     * generation, and the only place a handle id survives between two calls.
     *
     * Keyed by inode and not held on the description, because two descriptions share one inode
     * (constraint 47); `resolve()` re-points the row at the point of use. The handle is pooled
     * because `createSyncAccessHandle` is 495 us (constraint 22) against 27 ns for a generation
     * number (constraint 25). `users` counts DESCRIPTIONS, which together hold exactly one
     * I/O-level reference on the blob. `end` and `mut` live here because every description on the
     * inode must read the same number and none may own it; `mut` is not durable, since a crash
     * takes the row and the slack it stamps with it.
     */
    this.held = new Map();
    /** key -> the promise the next operation under that key waits on; the mutex's whole state, see
     *  `withKey`. Inode numbers and `VOLUME` are two keyspaces in one map. */
    this.lockTail = new Map();
    this.dirty = false;
    this.idleTimer = null;
    this.stats = { blobWrites: 0, blobFlushes: 0, journalAppends: 0, journalFlushes: 0,
      snapshots: 0, copyUps: 0, swings: 0, deferredFrees: 0, immediateFrees: 0,
      discardedByControl: 0, refusedCommits: 0, discardedStagings: 0,
      // `casRefusals`: validations that failed. `restages`: re-copies onto a moved base, with
      // `readRebases` the reader's share. `casExhausted`: commits out of attempts. `journalBurns`:
      // sequences an append failure burned.
      casRefusals: 0, restages: 0, casExhausted: 0,
      readRebases: 0, journalBurns: 0 };
  }

  /**
   * Serialize one inode's durable read-then-mutate sequences. Every entrant swaps its own release
   * promise in as the tail and awaits the tail it displaced; the swap is synchronous, so the queue
   * is FIFO.
   *
   * WHO TAKES IT, and this list is the whole of it: `openFd`, `writeFd`, `readFd`, `fsyncFd`,
   * `truncateFd`, `statFd`, `endFd`, `closeFd`, `sizeOf`'s slow path, and `freeInode`. Each is a
   * taker and nothing else, with its work in a `…Held` method or an inline closure, and a `…Held`
   * method must not be called from anywhere but its taker. scripts/fsfuzz.py lints both halves.
   *
   * WHAT RUNS UNDER IT AND MUST NEVER TAKE IT: `resolve`, `copyUp`, `discard`, `dropStaging`,
   * `restage`, `commit`, `commitOnce`, `extentFd`, `acquire`, `release`. A second acquisition would
   * wait on a tail only the body itself can release.
   *
   * Per inode and not global, so unrelated files stay concurrent and the I/O worker keeps the
   * parallelism constraint 58 bought. ONE LOCK, ONE INODE, NEVER HELD ACROSS ANOTHER `withInode`;
   * two at once MUST be acquired in ascending inode order. An inode holder may take the volume
   * (`withVolume`); a volume holder may never take an inode. Metadata ops (`calls.mjs` metaOp) take
   * no inode lock: the VFS mutates the tree synchronously, changing no generation, size or row.
   */
  async withInode(ino, body) {
    return this.withKey(ino, body);
  }

  /** The volume's lock. WHO TAKES IT, and this is the whole of it: `journal`, `flushJournal` and
   *  `writeSnapshot`, each with its work in a `…Held` method so `writeSnapshot` can flush the
   *  journal it is about to truncate. See `VOLUME` for what it covers. */
  async withVolume(body) {
    return this.withKey(VOLUME, body);
  }

  /** The queue itself, over either keyspace. `withInode` and `withVolume` are its only callers. */
  async withKey(key, body) {
    const prior = this.lockTail.get(key);
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    this.lockTail.set(key, mine);
    if (prior) await prior;
    try {
      return await body();
    } finally {
      // Only the LAST holder clears the entry: a waiter that has already swapped itself in is the
      // tail now, and deleting its promise would let the operation after it skip the queue.
      if (this.lockTail.get(key) === mine) this.lockTail.delete(key);
      release();
    }
  }

  get readOnly() {
    return this.mode !== MOUNT_RW && this.mode !== MOUNT_FRESH;
  }

  /* --------------------------- mount --------------------------- */

  /** Take the boot lock, read the volume, run fsck, and decide how to mount. Nothing is written on
   *  any path but MOUNT_FRESH, where there is no slot, no journal and no blob to lose. A volume
   *  whose bytes are present and do not decode mounts read-only and reports (constraint 28). */
  async mount() {
    const lock = await this.io.request(IO_LOCK, {
      budgetMs: BOOT_LOCK_BUDGET_MS, firstMs: BOOT_LOCK_FIRST_MS,
    });
    this.lock = lock;
    if (!lock || !lock.ok) {
      this.mode = MOUNT_RO;
      this.report = {
        mountable: MOUNT_RO,
        problems: [{ what: "boot-lock", why: (lock && lock.why) || "the boot lock was not taken" }],
        lock,
      };
      // No VFS: a tree built from a snapshot with an unread journal is missing every op since it.
      return this.report;
    }

    const slots = [];
    for (const name of SUPER_SLOTS) slots.push(await this.readWhole(name));
    const journal = await this.readWhole(JOURNAL_NAME);
    // The blob sweep does not run at mount (constraint 33); `sweepBlobs` is a bench hook and
    // `check()` is the explicit fsck that sweeps. A mount cannot name a blob the metadata points at
    // and the directory lacks (constraint 62); the first read of one refuses -EIO naming it.
    const blobs = this.cfg.sweepBlobs ? await this.blobListing() : null;

    const report = fsck({ slots, journal, blobs, checkCrc: !this.cfg.noCrc, now: Date.now });
    this.report = jsonSafe({ ...report, vfs: undefined, lock });
    this.report.lock = lock;

    // The staging floor, from the blob DIRECTORY and not from the generations the metadata names:
    // a crash between a copy-up and its commit leaves a staged blob `vfs.blobNames()` cannot see,
    // and the next write would hand that generation out again and publish the orphan's bytes. Names
    // only (constraint 33). A refused listing mounts read-only, as an empty list is a floor of 0.
    const floor = await this.blobNameListing();
    if (typeof floor === "number") {
      this.report.problems.push({
        what: "blobs",
        why: `the blob directory could not be enumerated (errno ${-floor}), so the staging floor `
          + "is unknown. Mounting READ-ONLY: a write would hand out a generation number an "
          + "orphaned staged blob may already hold, and publish its bytes as the file's",
      });
      // A volume fsck already refuses stays refused: read-only would promise reads of an unparsed
      // tree.
      const verdict = report.mountable === MOUNT_REFUSE ? MOUNT_REFUSE : MOUNT_RO;
      this.report.mountable = verdict;
      this.mode = verdict;
      if (verdict === MOUNT_RO) {
        this.vfs = report.mountable === MOUNT_FRESH
          ? new VFS({ owner: { uid: 0, gid: 0 }, now: Date.now }) : report.vfs;
      }
      return this.report;
    }
    for (const entry of floor) {
      const parsed = /^(\d+)\.(\d+)$/.exec(entry.name);
      if (!parsed) continue;
      const ino = Number(parsed[1]);
      const gen = Number(parsed[2]);
      if (gen > (this.highestGen.get(ino) || 0)) this.highestGen.set(ino, gen);
    }

    if (report.mountable === MOUNT_FRESH) {
      // The clock is passed in, not defaulted inside src/fs/; scripts/fsfuzz.py lints for that.
      this.vfs = new VFS({ owner: { uid: 0, gid: 0 }, now: Date.now });
      this.mode = MOUNT_FRESH;
      await this.io.request(IO_JOURNAL, { op: "resume", nextSeq: String(this.seq) });
      // The initial superblock, legal only because `fresh` means no slot, no journal and no blob.
      // Its errno is load-bearing: mounting read-write with no slot naming the volume would journal
      // every later op against a base the next mount cannot find.
      const seeded = await this.writeSnapshot();
      if (seeded < 0) {
        this.report.problems.push({
          what: "superblock",
          why: `the initial superblock could not be written (errno ${-seeded}), so this volume `
            + "has no snapshot to mount from. READ-ONLY: a write would journal against a base no "
            + "slot on disk names",
        });
        this.report.mountable = MOUNT_RO;
        this.mode = MOUNT_RO;
        return this.report;
      }
      this.mode = MOUNT_RW;
      return this.report;
    }
    if (report.mountable === MOUNT_REFUSE) {
      this.mode = MOUNT_REFUSE;
      return this.report;
    }

    this.vfs = report.vfs;
    const chosen = report.superblock;
    this.generation = BigInt(chosen.generation);
    this.slot = chosen.chose;
    this.journalFirstSeq = BigInt(report.journal.firstSeq ?? 0);
    // The next record follows the last one replay ACCEPTED: resuming from the journal's byte length
    // would write over a discarded tail, and from zero would collide with records already there.
    this.seq = this.journalFirstSeq + BigInt(report.journal.records);
    // The same number to the one agent that sees the order records land in (iocore `journalOp`).
    await this.io.request(IO_JOURNAL, { op: "resume", nextSeq: String(this.seq) });
    this.mode = report.mountable === MOUNT_RW ? MOUNT_RW : MOUNT_RO;
    // A discarded tail stays on disk: truncating it makes the one recoverable thing unrecoverable.
    return this.report;
  }

  /** The storage edge's counters and operation trace: the measurement path that makes constraint
   *  23's write ordering and constraint 24's one-`getDirectoryHandle` budget assertable. */
  async ioStats() {
    const r = await this.io.request(IO_STATS, {});
    return typeof r === "number" ? { errno: r } : r;
  }

  /** The blob directory with a size per name: fsck's sweep input. A refusal is `{errno}` and not an
   *  empty array — `fsck` tests for truthiness, so `[]` reads as "listed, holds nothing" and
   *  reports every committed blob as ABSENT. */
  async blobListing() {
    const r = await this.io.request(IO_LIST, { dir: BLOB_DIR });
    return typeof r === "number" ? { errno: -r } : r;
  }

  /** One metadata file's contents, keeping ABSENT, UNREADABLE and PRESENT apart: `null` for both a
   *  refusal and a missing slot makes an unreadable volume reach fsck as "no bytes anywhere", come
   *  back MOUNT_FRESH and get reseeded — constraint 28's defect through an error path. `{errno}` is
   *  positive, as in `blobListing`. */
  async readWhole(name) {
    const r = await this.io.request(IO_READ_ALL, { dir: "", name });
    if (typeof r === "number") return { errno: -r };
    if (r.absent || !r.bytes) return null;
    return new Uint8Array(r.bytes);
  }

  /** Every name in the blob directory, without a size per name: the staging floor's input. A
   *  refusal is the ERRNO — an empty floor and an unknown floor are different volumes. */
  async blobNameListing() {
    return this.io.request(IO_LIST, { dir: BLOB_DIR, namesOnly: true });
  }

  /** An explicit fsck over the live volume, blob sweep included. It never writes: `fsck()` holds
   *  no handle and no root, so there is no object there a reseed could go through. */
  async check() {
    const slots = [];
    for (const name of SUPER_SLOTS) slots.push(await this.readWhole(name));
    const journal = await this.readWhole(JOURNAL_NAME);
    const blobs = await this.blobListing();
    const report = fsck({ slots, journal, blobs, checkCrc: !this.cfg.noCrc, now: Date.now });
    const out = jsonSafe({ ...report, vfs: undefined });
    out.inodes = report.vfs ? report.vfs.stats() : null;
    return out;
  }

  /* --------------------------- the journal --------------------------- */

  /** Append one op, NOT flushed (constraint 23). The idle timer is armed here and nowhere else, so
   *  "idle" means "no metadata op for JOURNAL_IDLE_MS" and never a tick that could fall between a
   *  blob write and its commit record. */
  async journal(op) {
    if (this.readOnly) return -EROFS;
    return this.withVolume(() => this.journalHeld(op));
  }

  /** `journal`'s body, under the VOLUME's lock. The sequence it allocates and the snapshot's
   *  `journalFirstSeq` are one number — see `VOLUME`. */
  async journalHeld(op) {
    const payload = encodeOp(op);
    // THE SEQUENCE IS ALLOCATED BEFORE ANY `await`, and the encode with it. Three callers in
    // calls.mjs reach this concurrently, so an allocation after the append's await hands two
    // records the same number, and replay stops at the first seq that is not its predecessor's plus
    // one and DISCARDS the tail. A failed append burns its number: a later caller may hold seq+1.
    const seq = this.seq;
    this.seq = seq + 1n;
    const record = encodeRecord(seq, payload);
    const n = await this.io.request(IO_JOURNAL, { op: "append", bytes: copyOut(record) });
    if (n < 0) {
      // The appender's expectation only advances on a successful append, so without the burn one
      // failed append makes every later one refuse for the life of the mount. The burn leaves a
      // GAP, which stops replay there rather than applying records written around a hole.
      this.stats.journalBurns += 1;
      // `burnedSeq` and not `seq`: the transport owns `t` and `seq` on every message to the I/O
      // worker and the envelope overwrites the body.
      const burned = await this.io.request(IO_JOURNAL,
        { op: "burn", burnedSeq: String(seq) });
      if (burned < 0) {
        this.note(`journal record ${seq} could not be appended (errno ${-n}) and the appender `
          + `would not accept the burn either (errno ${-burned}); no further record can be `
          + "written to this journal");
      }
      return n;
    }
    this.stats.journalAppends += 1;
    this.dirty = true;
    this.armIdle();
    return 0;
  }

  armIdle() {
    if (this.idleTimer !== null) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.dirty) this.flushJournal().catch(() => {});
    }, JOURNAL_IDLE_MS);
  }

  async flushJournal() {
    return this.withVolume(() => this.flushJournalHeld());
  }

  /** `flushJournal`'s body, under the VOLUME's lock, and the one `writeSnapshot` calls. THE FLAG IS
   *  CLEARED BEFORE THE AWAIT: cleared after it, this method clears the flag a record appended
   *  inside the await had just set, and the re-armed timer then flushes nothing. */
  async flushJournalHeld() {
    if (!this.dirty) return 0;
    this.dirty = false;
    const r = await this.io.request(IO_JOURNAL, { op: "flush" });
    if (r < 0) {
      this.dirty = true;
      this.armIdle();
      return r;
    }
    this.stats.journalFlushes += 1;
    return r;
  }

  /* --------------------------- blobs and the COW swing --------------------------- */

  /** The next generation for an inode. Never a generation this kernel has already staged. */
  nextGen(ino, committedGen) {
    const highest = Math.max(this.highestGen.get(ino) || 0, committedGen || 0);
    const next = highest + 1;
    this.highestGen.set(ino, next);
    return next;
  }

  /** A file description over a resolved inode. Two opens of one file both succeed because the I/O
   *  worker's per-inode table makes the second a refcount on the first handle (constraint 47). */
  async openFd(decision) {
    // Not `decision.gen` and not `decision.size`: both are durable state another description moves.
    const d = {
      ino: decision.ino, type: decision.type,
      pos: 0, dirtyGen: 0, stagingId: 0, baseMut: 0, baseEnd: 0, log: [],
    };
    if (decision.type !== "file") return d;
    // The reference and the resolve are one step under the lock. Outside it, this `acquire` could
    // land between another operation's resolve and its use of the id that resolve returned.
    return this.withInode(d.ino, async () => {
      this.acquire(d.ino);
      // Resolved once here so `open` pays the 495 us handle open (constraint 22) rather than the
      // first read. The result is deliberately discarded: every later caller asks again.
      const at = await this.resolve(d.ino);
      if (typeof at === "number") {
        await this.release(d.ino);
        return at;
      }
      return d;
    });
  }

  async closeBlob(id) {
    return this.io.request(IO_CLOSE, { id });
  }

  /* --------------------------- reading durable state at the point of use --------------------- */

  acquire(ino) {
    const row = this.held.get(ino);
    if (row) {
      row.users += 1;
      return row;
    }
    // `end` 0 and `gen` 0 is "never pointed at a generation". The first `resolve` sets both, `end`
    // from the PUBLISHED SIZE, which is what makes a crash's slack unreachable.
    const fresh = { gen: 0, id: 0, users: 1, end: 0, mut: 0 };
    this.held.set(ino, fresh);
    return fresh;
  }

  /** Drop one description's reference; the last one releases the handle. */
  async release(ino) {
    const row = this.held.get(ino);
    if (!row) return 0;
    row.users -= 1;
    if (row.users > 0) return 0;
    this.held.delete(ino);
    // This close is what lets a deferred free remove the directory entry (iocore `close`): POSIX
    // keeps an unlinked file's bytes until the last descriptor goes.
    if (row.id) await this.closeBlob(row.id);
    return 0;
  }

  /**
   * THE CURRENT GENERATION OF AN INODE, ITS HANDLE AND ITS EXTENT, READ NOW. Every decision in the
   * fd path begins here and none may begin anywhere else. The published size is a FLOOR on `end`,
   * never a ceiling: another description's append commit raises it against the generation this row
   * already holds.
   *
   * IT RUNS UNDER THE INODE'S LOCK AND MUST NEVER TAKE IT (`withInode`): the generation and the
   * published size are read before the 495 us handle open below and returned after it, and the
   * superseded handle is CLOSED here while another operation may still hold that id across its own
   * await. Answers -errno on refusal, with `id` 0 when no generation exists or none is held.
   */
  async resolve(ino) {
    if (!this.vfs) return -EIO;
    // UNLINKED, NOT CORRUPT. `committed()` throws EIO for both, because the VFS does not know file
    // descriptions exist; only a caller holding one can tell them apart.
    if (!this.vfs.holds(ino)) return -ESTALE;
    let committed;
    try {
      committed = this.vfs.committed(ino);
    } catch (error) {
      return errnoOfFsError(error);
    }
    const row = this.held.get(ino);
    if (!row) {
      // A live description with no row is a kernel defect. Answering from the VFS with no handle
      // would make a release fired on the first close of two read as an empty file.
      this.note(`inode ${ino} has no open handle row, but a description is resting on it`);
      return -EIO;
    }
    if (row.gen === committed.gen) {
      if (committed.size > row.end) row.end = committed.size;
      return { gen: row.gen, size: committed.size, id: row.id, end: row.end, mut: row.mut };
    }
    // Another description swung the inode onto a generation this row has never held. Take the
    // reference on the live generation BEFORE releasing the old one, so a free the swing deferred
    // sees a true count and the superseded blob is not removed between the two steps.
    let opened = null;
    if (committed.gen > 0) {
      opened = await this.io.request(IO_BLOB_OPEN, { ino, gen: committed.gen });
      if (typeof opened === "number") return opened;
    }
    const previous = row.id;
    row.gen = committed.gen;
    row.id = opened ? opened.id : 0;
    // A generation this row never held reaches as far as the metadata says: appends need a row.
    row.end = committed.size;
    // The counter is not reset: the commit that swung the inode already bumped it, and a reset
    // would tell a description holding the number it recorded that nothing had happened.
    if (previous) await this.closeBlob(previous);
    return { gen: row.gen, size: committed.size, id: row.id, end: row.end, mut: row.mut };
  }

  /** A file's size for a caller with no description: `stat` and `lstat` by path. It ends at
   *  `resolve()`'s `end`, as `fstat` does through `extentFd`, because two routes to the number
   *  disagree exactly when one fd has pwritten and not committed. The info object itself when no
   *  I/O is needed, a promise otherwise: calls.mjs's `settle` shape. */
  sizeOf(info) {
    if (info.type !== "file") return info;
    const row = this.held.get(info.ino);
    if (!row || !row.id) return info;
    return this.withInode(info.ino, async () => {
      // The row is re-checked under the lock: the last description may have closed while we waited,
      // which would make `resolve` answer -EIO over a healthy file. With none left the metadata is
      // the whole truth, since a close publishes the extent.
      if (!this.held.has(info.ino)) return info;
      const at = await this.resolve(info.ino);
      if (typeof at === "number") return at;
      info.size = at.end;
      return info;
    });
  }

  /**
   * The staged generation's modification log, in order: what lets a refused commit replay its own
   * bytes onto a new base. The modifications and never the bytes; the bytes are in the staged blob.
   *
   * Contiguous and overlapping writes coalesce. TWO RANGES WITH A GAP MUST NOT MERGE — the gap's
   * bytes belong to the base, and a merged range would copy the OLD base's over the new one's.
   */
  stageMark(d, entry) {
    const last = d.log.length ? d.log[d.log.length - 1] : null;
    if (entry.k === "w" && last && last.k === "w"
      && entry.at <= last.at + last.len && entry.at + entry.len >= last.at) {
      const at = Math.min(last.at, entry.at);
      last.len = Math.max(last.at + last.len, entry.at + entry.len) - at;
      last.at = at;
      return;
    }
    d.log.push(entry);
  }

  /** Where this description's staged generation ends if its log is replayed onto a base of `from`
   *  bytes. Pure arithmetic, and the only place it is done. A reader's base is the LIVE one
   *  (`extentFd`); a commit's is the base the copy came from (`commitOnce`), which the CAS has just
   *  proved is the same state. A size fixed at copy-up time under-reports the file. */
  stagedEnd(d, from) {
    let end = from;
    for (const m of d.log) end = m.k === "t" ? m.size : Math.max(end, m.at + m.len);
    return end;
  }

  /**
   * Stage a new generation for a description about to modify committed bytes, copying the SOURCE
   * GENERATION into it. `limit` caps the copy; `undefined` means the whole of it, and `size` in the
   * answer is what the copy actually put there.
   *
   * THE LENGTH IS THE SOURCE'S EXTENT — `from.end`, the per-inode row's. The blob's physical length
   * would launder a crashed kernel's uncommitted slack into a generation the metadata names; the
   * copying description's own idea of the length drops another description's appended bytes. A
   * short copy is an error and not a count: 0 of 8 bytes accepted publishes a generation claiming 8
   * bytes over a 2-byte blob with `fsync` returning 0. Constraint 9 cuts the other way here than
   * for `write`, because an internal copy has no caller to loop.
   */
  async copyUp(d, from, limit) {
    const gen = this.nextGen(d.ino, from.gen);
    const staged = await this.io.request(IO_BLOB_OPEN, { ino: d.ino, gen, create: true });
    if (typeof staged === "number") return staged;
    const want = limit === undefined ? from.end : Math.min(limit, from.end);
    let copied = 0;
    if (from.gen > 0 && from.id && want > 0) {
      const r = await this.io.request(IO_COPY, { from: from.id, to: staged.id, limit: want });
      if (typeof r === "number") {
        await this.discard(d.ino, gen, staged.id);
        return r;
      }
      // A source shorter than the extent it publishes is refused at the COMMIT and not here, so
      // `check.py --negative no-cow-order` still exercises its copy-up, swing and refcount clauses.
      if (r.copied !== r.want) {
        this.note(`copy-up of inode ${d.ino} to generation ${gen} copied ${r.copied} of `
          + `${r.want} byte(s) out of a ${r.source}-byte blob`);
        await this.discard(d.ino, gen, staged.id);
        return -EIO;
      }
      copied = r.copied;
      this.stats.copyUps += 1;
    }
    return { gen, id: staged.id, size: copied };
  }

  /** Release a STAGED generation nothing will publish: its handle, and its blob. `highestGen` is
   *  monotonic and deliberately not rolled back, so the name is never reused. */
  async discard(ino, gen, id) {
    if (id) await this.closeBlob(id);
    if (gen) {
      const r = await this.io.request(IO_FREE, { ino, gen });
      if (r && r.deferred) this.stats.deferredFrees += 1;
      else this.stats.immediateFrees += 1;
    }
    this.stats.discardedStagings += 1;
  }

  /** Forget this description's staged generation, freeing it. THE ONE STORE METHOD AN OUTSIDE
   *  CALLER MAY RUN WITHOUT THE INODE'S LOCK: it reads no durable state and moves no published
   *  size, no generation and no handle row. `calls.mjs`'s failed `open(O_TRUNC)` is that caller. */
  async dropStaging(d) {
    const gen = d.dirtyGen;
    const id = d.stagingId;
    d.dirtyGen = 0;
    d.stagingId = 0;
    d.baseMut = 0;
    d.baseEnd = 0;
    d.log = [];
    await this.discard(d.ino, gen, id);
  }

  /**
   * Copy up from the base the compare-and-swap found and replay this description's own
   * modifications onto it: what makes a failed validation cost a copy rather than somebody's bytes.
   *
   * RANGE BY RANGE out of the superseded staged generation, in the order the writes were made.
   * Copying the whole staged blob would carry the OLD base's bytes over the new base's everywhere
   * this description did not write. The old stage is discarded only once the new one is complete,
   * leaving one blob for the caller's `dropStaging` to free on failure. UNDER THE INODE'S LOCK,
   * held by `commit` or `extentFd`: the longest read-then-mutate here.
   */
  async restage(d) {
    const live = await this.resolve(d.ino);
    if (typeof live === "number") return live;
    const oldGen = d.dirtyGen;
    const oldId = d.stagingId;
    const staged = await this.copyUp(d, live, undefined);
    if (typeof staged === "number") return staged;
    for (const m of d.log) {
      if (m.k === "t") {
        const t = await this.io.request(IO_TRUNCATE, { id: staged.id, size: m.size });
        if (t < 0) {
          await this.discard(d.ino, staged.gen, staged.id);
          return t;
        }
        continue;
      }
      const r = await this.io.request(IO_COPY,
        { from: oldId, to: staged.id, at: m.at, length: m.len });
      if (typeof r === "number" || r.copied !== m.len) {
        this.note(`re-stage of inode ${d.ino} onto generation ${live.gen} could not replay `
          + `${m.len} byte(s) at ${m.at}: ${typeof r === "number" ? `errno ${-r}` : `copied `
            + `${r.copied}`}`);
        await this.discard(d.ino, staged.gen, staged.id);
        return typeof r === "number" ? r : -EIO;
      }
    }
    d.dirtyGen = staged.gen;
    d.stagingId = staged.id;
    d.baseMut = live.mut;
    d.baseEnd = live.end;
    this.stats.restages += 1;
    await this.discard(d.ino, oldGen, oldId);
    return 0;
  }

  /**
   * The commit, with its retry. `commitOnce` does the work and may answer REBASE; this is the loop
   * that answers it, and the only entry point anybody else may call. Re-stage and retry is the only
   * behaviour that keeps both writers' bytes: `write` and `fsync` returned success to both.
   *
   * -EBUSY KEEPS THE STAGED GENERATION. Freeing it leaves the caller's retry finding `dirtyGen` 0,
   * taking `commitOnce`'s "nothing to publish" arm and answering 0 — a caller doing the right thing
   * told that refused data is durable. Only `close` and `dropStaging` discard a stage. UNDER THE
   * INODE'S LOCK, held by `fsyncFd` or `closeFd`, and it must not take it itself.
   */
  async commit(d) {
    if (this.readOnly) return -EROFS;
    for (let attempt = 1; ; attempt += 1) {
      const r = await this.commitOnce(d);
      if (r !== REBASE) return r;
      this.stats.casRefusals += 1;
      if (attempt >= COMMIT_ATTEMPTS) {
        this.stats.casExhausted += 1;
        this.note(`commit of inode ${d.ino} lost its base ${attempt} time(s) in a row; refusing `
          + "under EBUSY rather than publishing a generation copied from a base that moved. The "
          + "staged generation is kept, so a retry can still publish it");
        return -EBUSY;
      }
      // An append commit has nothing staged: its op is computed from the live state, so recomputing
      // it is the retry. Only a staged generation has to be rebuilt.
      if (!d.dirtyGen) continue;
      const re = await this.restage(d);
      if (re < 0) {
        await this.dropStaging(d);
        return re;
      }
    }
  }

  /**
   * ONE COMMIT ATTEMPT: blob -> flush -> validate -> journal -> flush, then the swing (constraint
   * 60). Answers 0 (nothing to publish), 1 (published), -errno, or REBASE. Nobody else may call it.
   * One function for both shapes, which differ only in which blob is flushed: a copy-up commits a
   * STAGED generation and swings the inode onto it; an append commits the generation the inode is
   * already on and publishes the new size. VALIDATION SITS AHEAD OF THE JOURNAL (constraint 60): a
   * refusal arriving after the record is durable poisons the volume, because replay must refuse it.
   *
   * THE NEGATIVE CONTROL, STAGE 1 (`noCowOrder`) discards the staged bytes rather than only
   * skipping `flush()`, because an unflushed FileSystemSyncAccessHandle write is still visible to a
   * later read IN THE SAME AGENT — so with `blobFlushes: 0` the volume reads back whole.
   */
  async commitOnce(d) {
    const staging = d.dirtyGen > 0;
    // The base is read now, and `prevGen` with it: a commit naming the generation this description
    // last looked at publishes a size over another description's fsynced bytes.
    const at = await this.resolve(d.ino);
    if (typeof at === "number") {
      if (staging) await this.dropStaging(d);
      return at;
    }
    // THE BASE THIS OP IS VALID AGAINST. For a staged generation it is the base the COPY was taken
    // from, which is not the state read a line ago — that gap is what the validation below checks.
    // For an append it is the state read a line ago, because the op is computed from it.
    const base = staging ? { mut: d.baseMut } : { mut: at.mut };
    // The size published: the log replayed onto the base, or for an append the file's extent.
    const op = {
      k: "commit", ino: d.ino,
      gen: staging ? d.dirtyGen : at.gen,
      size: staging ? this.stagedEnd(d, d.baseEnd) : at.end,
      prevGen: at.gen, t: Date.now(),
    };
    if (!staging && op.size === at.size) {
      // A commit record that changes nothing is still a record replay must apply.
      return 0;
    }
    const blobId = staging ? d.stagingId : at.id;
    // The validation's own predicate, asked before paying constraint 23's flush for a stale stage.
    if (staging && moved(base, at)) return REBASE;

    if (staging) {
      // THE SIZE A COMMIT PUBLISHES MUST BE THE STAGED BLOB'S OWN LENGTH, asserted rather than
      // trusted: `op.size` is arithmetic over the log and the blob is what a reader will find, so a
      // disagreement is metadata naming bytes that are not there.
      const bytes = await this.io.request(IO_SIZE, { id: blobId });
      if (bytes < 0) {
        await this.dropStaging(d);
        return bytes;
      }
      if (bytes !== op.size) {
        this.note(`staged generation ${d.ino}.${d.dirtyGen} is ${bytes} byte(s) on disk and its `
          + `commit would publish ${op.size}`);
        await this.dropStaging(d);
        return -EIO;
      }
    }

    // 1. the blob, 2. its flush. Durable BEFORE anything points at it.
    if (!this.cfg.noCowOrder) {
      const flushed = await this.io.request(IO_FSYNC, { id: blobId });
      if (flushed < 0) {
        if (staging) await this.dropStaging(d);
        return flushed;
      }
      this.stats.blobFlushes += 1;
    }

    // 3a. THE COMPARE-AND-SWAP'S VALIDATION STEP: the base this op was computed against is STILL
    // the inode's current state. NOT redundant with `applyOp`'s `op.gen < inode.gen` check, which
    // is monotonicity and not currency. IT IS A SWAP — `resolve` is the last `await` before the
    // synchronous `applyOp`, so an `await` between these two lines breaks the primitive.
    const now = await this.resolve(d.ino);
    if (typeof now === "number") {
      if (staging) await this.dropStaging(d);
      return now;
    }
    if (moved(base, now)) return REBASE;

    // 3b. VALIDATE, by applying in memory: the apply IS the validation, so the journal below only
    // receives a record the VFS accepted. The state it moves is taken first, because the apply is a
    // PUBLISH whose durable record is two awaits away.
    let before;
    try {
      before = this.vfs.commitState(op.ino);
      this.vfs.applyOp(op);
    } catch (error) {
      // The staged blob goes with the refusal: nothing will publish this generation now. The errno
      // goes back to the caller, including to `close()`.
      this.stats.refusedCommits += 1;
      this.note(`commit of inode ${d.ino} generation ${op.gen} over ${at.gen} was refused: `
        + `${(error && error.message) || error}`);
      const errno = errnoOfFsError(error);
      if (staging) await this.dropStaging(d);
      return errno;
    }

    // 4. the journal record, 5. its flush. AN APPEND THAT REFUSED TAKES THE APPLY WITH IT: its
    // sequence is burned, so left applied the tree, the journal and the volume become three
    // different answers. The stage is KEPT, for the retry.
    const appended = await this.journal(op);
    if (appended < 0) {
      // The undo can refuse only if the inode went while the append was in flight — `unlink` takes
      // no inode lock — in which case there is no publish left to undo. Reported, not raised.
      try {
        this.vfs.revertCommit(op.ino, before);
      } catch (error) {
        this.note(`commit of inode ${op.ino} generation ${op.gen} could not be journalled (errno `
          + `${-appended}) and its publish could not be undone: `
          + `${(error && error.message) || error}`);
        return appended;
      }
      this.note(`commit of inode ${op.ino} generation ${op.gen} could not be journalled (errno `
        + `${-appended}); the publish was undone in memory, so nothing reports a size no record `
        + "names");
      return appended;
    }
    // A FAILED FLUSH IS NOT UNDONE, unlike a failed append: the record is in the journal file and
    // only its durability past this agent is in question, which is what POSIX lets `fsync` report.
    // Returning early would leave the inode published while the row still points at the superseded
    // blob and the description holds the new generation as a PRIVATE stage, so its next write would
    // go in place into published bytes. SO THE SWING COMPLETES and the errno follows it.
    const jflush = await this.flushJournal();
    this.stats.swings += 1;

    // The control's second half: the metadata now names bytes that are not there.
    if (this.cfg.noCowOrder && op.size > 0) {
      await this.io.request(IO_TRUNCATE, { id: blobId, size: 0 });
      this.stats.discardedByControl += 1;
    }

    // THE SWING. The inode's pooled reference on the superseded generation is released FIRST, so
    // the free below sees a true reference count (constraint 47). The staged handle is TRANSFERRED
    // into the row rather than closed and re-opened (constraint 22).
    const row = this.held.get(d.ino);
    if (staging) {
      if (row) {
        const previous = row.id;
        row.id = d.stagingId;
        if (previous) await this.closeBlob(previous);
      } else {
        await this.closeBlob(d.stagingId);
      }
      d.stagingId = 0;
      d.dirtyGen = 0;
      d.baseMut = 0;
      d.baseEnd = 0;
      d.log = [];
    }
    if (row) {
      // THE ROW'S EXTENT IS WHAT WAS JUST PUBLISHED, on both arms. Left stale, the next copy-up
      // carries bytes nobody published.
      row.gen = op.gen;
      row.end = op.size;
      // The stamp moves with them, so every description holding an older base loses its CAS. IT
      // LANDS THREE AWAITS AFTER THE GENERATION MOVED — `applyOp`, the journal append and its flush
      // — across which the VFS says N+1 while the stamp still says what N said; that window is
      // unreachable only because the inode lock holds it shut.
      row.mut += 1;
    }
    if (op.prevGen && op.prevGen !== op.gen) {
      const r = await this.io.request(IO_FREE, { ino: op.ino, gen: op.prevGen });
      if (r && r.deferred) this.stats.deferredFrees += 1;
      else this.stats.immediateFrees += 1;
    }
    // The flush's errno, after the swing: tree, row and description are consistent and the caller
    // is still told its `fsync` is not durable. Named too: a teardown reads no return value.
    if (jflush < 0) {
      this.note(`commit of inode ${op.ino} generation ${op.gen} was applied and journalled, but `
        + `the journal's flush refused (errno ${-jflush}); the record is written and not yet `
        + "durable");
      return jflush;
    }
    // One, meaning "a generation was published", which is what `fsyncFd` reads.
    return 1;
  }

  /** Free every generation of an inode whose last link went. The only place the DEFERRED free is
   *  reachable: a reader follows a swing, so a swing's superseded generation has no reader left. */
  async freeInode(ino) {
    // UNDER THE INODE'S LOCK: this reads the staging floor and then frees every name under it, and
    // a write landing in the middle stages a generation this loop has already passed.
    return this.withInode(ino, async () => {
      const highest = this.highestGen.get(ino) || 0;
      for (let gen = 1; gen <= highest; gen += 1) {
        const r = await this.io.request(IO_FREE, { ino, gen });
        if (r && r.deferred) this.stats.deferredFrees += 1;
        else this.stats.immediateFrees += 1;
      }
      this.highestGen.delete(ino);
    });
  }

  /* --------------------------- the snapshot --------------------------- */

  /** Write the in-memory table to the next superblock slot and reset the journal. Round-robin over
   *  three slots so the newest valid one is never the only valid one (src/fs/superblock.mjs).
   * ORDER:  slot written and flushed, THEN the journal truncated — truncating first leaves a window
   * where  neither holds the ops. UNDER THE VOLUME'S LOCK, which is what makes the order hold. */
  async writeSnapshot() {
    if (this.mode === MOUNT_RO || this.mode === MOUNT_REFUSE) return -EROFS;
    return this.withVolume(() => this.snapshotHeld());
  }

  /** `writeSnapshot`'s body, under the volume's lock. */
  async snapshotHeld() {
    await this.flushJournalHeld();
    const generation = this.generation + 1n;
    const slot = Number(generation % BigInt(SUPER_SLOTS.length));
    const counted = this.vfs.stats();
    const image = encodeImage({ ...this.vfs.serialize(), journalFirstSeq: String(this.seq) });
    const sb = encodeSuperblock({
      generation, inodeCount: counted.inodes, nextIno: counted.nextIno,
    });
    const bytes = new Uint8Array(sb.length + image.length);
    bytes.set(sb, 0);
    bytes.set(image, sb.length);
    const r = await this.io.request(IO_WRITE_ALL, {
      name: SUPER_SLOTS[slot], bytes: copyOut(bytes),
    });
    if (r < 0) return r;
    const t = await this.io.request(IO_JOURNAL, { op: "truncate" });
    if (t < 0) {
      // THE SLOT CANNOT BE LEFT: it is flushed, carries generation+1 and says the journal starts at
      // `this.seq`, while the journal still holds records from the old base — so the next mount
      // replays records already folded into the image, `applyOp` refuses one, and the volume mounts
      // REFUSE. The undo is a zero-length write, read by fsck as absent.
      const undo = await this.io.request(IO_WRITE_ALL, {
        name: SUPER_SLOTS[slot], bytes: copyOut(new Uint8Array(0)),
      });
      if (undo < 0) {
        // Both halves refused: the disk is ahead of this kernel and another write would append to a
        // journal the next mount reads against the wrong base. The note is the whole report: the
        // callers include the idle timer, which has nobody to return to.
        this.mode = MOUNT_RO;
        this.note(`snapshot generation ${generation} was written to slot ${slot} and flushed, the `
          + `journal truncate refused (errno ${-t}) and the slot could not be invalidated either `
          + `(errno ${-undo}). The volume on disk is AHEAD of this kernel; mounting read-only for `
          + "the rest of this session");
        return t;
      }
      this.note(`snapshot generation ${generation} was abandoned: the journal truncate refused `
        + `(errno ${-t}), so the slot ${slot} it had already written was invalidated. The volume `
        + `stays at generation ${this.generation} with its journal intact`);
      return t;
    }
    this.generation = generation;
    this.slot = slot;
    this.journalFirstSeq = this.seq;
    this.dirty = false;
    this.stats.snapshots += 1;
    return 0;
  }

  /* --------------------------- fd-level data I/O --------------------------- */

  /** One write through a file description, as a promise calls.mjs's settle() turns into a PENDING
   *  syscall. `at` is the file offset: `undefined` means the description's cursor, and advance it;
   * a  number means `pwrite`, which must NOT touch the cursor — a PARAMETER and not a
   *  saved-and-restored `d.pos`, because every call here awaits. */
  async writeFd(d, pid, srcOff, length, at) {
    if (this.readOnly) return -EROFS;
    return this.withInode(d.ino, () => this.writeHeld(d, pid, srcOff, length, at));
  }

  /** `writeFd`'s body, under the inode's lock: the COW decision reads the live state and the write
   *  lands against it, with a copy-up, a handle open and a blob write in between. */
  async writeHeld(d, pid, srcOff, length, at) {
    const positional = at !== undefined;
    let from;
    if (!positional && (d.flags & O_APPEND)) {
      // O_APPEND IS AN OFFSET PER WRITE, NOT A SEEK AT OPEN: POSIX sets the offset to the end of
      // the file before each write, atomically, which holds here because the inode is held. Read
      // once at open, two `>>` descriptions get the same end and the second's bytes land on the
      // first's. `extentFd`, not `resolve`: a staged description appends at the end of its STAGE.
      const reach = await this.extentFd(d);
      if (typeof reach === "number") return reach;
      from = reach.end;
      d.pos = from;
    } else {
      // `pwrite` honours its offset even under O_APPEND, which is POSIX and is not what Linux does
      // (Linux appends and ignores the offset).
      from = positional ? at : d.pos;
    }
    let target = d.stagingId;
    if (!d.dirtyGen) {
      // The decision's inputs, read now and never remembered from a previous call.
      const live = await this.resolve(d.ino);
      if (typeof live === "number") return live;
      // THE COW DECISION (constraint 60), and the only place it is made. A file with no blob at all
      // takes the copy-up path, which keeps "new file" and "overwrite" one branch.
      if (from < live.size || live.gen === 0) {
        // The whole source generation comes across, not `live.size`: an uncommitted append above
        // the committed size is in the generation being copied out of and has already returned
        // success to somebody. The base is recorded with it, for the commit's compare-and-swap.
        const staged = await this.copyUp(d, live, undefined);
        if (typeof staged === "number") return staged;
        d.dirtyGen = staged.gen;
        d.stagingId = staged.id;
        d.baseMut = live.mut;
        d.baseEnd = live.end;
        d.log = [];
        target = staged.id;
      } else {
        target = live.id;
      }
    }
    const n = await this.io.request(IO_WRITE, { id: target, pid, srcOff, length, at: from });
    if (n < 0) return n;
    this.stats.blobWrites += 1;
    if (!positional) d.pos = from + n;
    // THE ACTUAL COUNT, never the requested length: `write` may short-count, and a log entry
    // claiming bytes the write did not land makes `restage` copy bytes nobody wrote.
    if (d.dirtyGen) {
      this.stageMark(d, { k: "w", at: from, len: n });
    } else {
      // An append into the current generation; its extent is the inode's, on the per-inode row. THE
      // COUNTER IS BUMPED WHETHER OR NOT THE EXTENT MOVED: a write at or above the published size
      // but below the row's `end` — an earlier append's slack — changes bytes every description
      // reads and moves no derived number (`moved`).
      const row = this.held.get(d.ino);
      if (row) {
        if (from + n > row.end) row.end = from + n;
        row.mut += 1;
      }
    }
    return n;
  }

  /**
   * WHERE THIS DESCRIPTION'S FILE ENDS AND WHICH BLOB ITS BYTES ARE IN, read at one time. THE ONE
   * RENDERER FOR `read`, `fstat` AND `SEEK_END` ALIKE, which differ exactly when another
   * description commits. `id` is 0 for a file with no generation yet: a reader answers empty.
   *
   * THE BASE IS THE LIVE EXTENT, not the recorded `d.baseEnd`, because a reader asks where the file
   * ends now; `commitOnce` still publishes against the recorded base, under the CAS's protection.
   *
   * A STALE STAGE IS RE-BASED BEFORE THE PAIR IS ANSWERED, which is the one place a reader mutates:
   * the log replayed onto the LIVE base over a blob copied from an older one names bytes the staged
   * blob does not have, and reporting the staged base instead under-reports the file, so `SEEK_END`
   * lands below the real end and the next append overwrites committed bytes. One copy per OBSERVED
   * publish, not one per read. UNDER THE INODE'S LOCK, held by `readFd`, `statFd` or `endFd`.
   */
  async extentFd(d) {
    let live = await this.resolve(d.ino);
    if (typeof live === "number") return live;
    // A read-only mount cannot re-base — a re-base writes a blob — and does not have to: `writeFd`
    // and `truncateFd` refuse there, so a stage can only predate the mount's mode.
    if (d.dirtyGen && moved({ mut: d.baseMut }, live) && !this.readOnly) {
      const re = await this.restage(d);
      if (re < 0) return re;
      this.stats.readRebases += 1;
      live = await this.resolve(d.ino);
      if (typeof live === "number") return live;
    }
    return {
      end: d.dirtyGen ? this.stagedEnd(d, live.end) : live.end,
      id: d.dirtyGen ? d.stagingId : live.id,
    };
  }

  /** The read half, with the same offset rule. NO CLAMP AGAINST A REMEMBERED SIZE: the clamp is the
   *  file's extent through `extentFd`, so `read`, `fstat` and `SEEK_END` cannot disagree. A sync
   *  access handle returns whatever is physically at the offset, so after a crash an unclamped
   *  `pread` past the end would report a previous kernel's slack as file content. */
  async readFd(d, pid, dstOff, length, at) {
    return this.withInode(d.ino, () => this.readHeld(d, pid, dstOff, length, at));
  }

  /** `readFd`'s body, under the inode's lock. A read is not a pure read here: the extent and the
   *  blob id must come from one state (`extentFd`), and the id must still be OPEN when the read
   *  issues — `resolve` closes a superseded handle, so an id held across this await answers -EBADF
   *  on a valid fd. */
  async readHeld(d, pid, dstOff, length, at) {
    const positional = at !== undefined;
    const from = positional ? at : d.pos;
    const reach = await this.extentFd(d);
    if (typeof reach === "number") return reach;
    // No generation at all: an empty file, which is a legal 0 rather than an error.
    if (!reach.id) return 0;
    const id = reach.id;
    const want = Math.min(length, Math.max(0, reach.end - from));
    if (want <= 0) return 0;
    const n = await this.io.request(IO_READ, { id, pid, dstOff, length: want, at: from });
    if (n < 0) return n;
    if (!positional) d.pos = from + n;
    return n;
  }

  /** fsync: the blob's flush and the metadata swing, in that order. A separate call, so constraint
   *  23's flush is paid when a caller asks for durability. `commit` decides for itself whether
   *  there is anything to publish, by reading the volume. */
  async fsyncFd(d) {
    if (this.readOnly) return -EROFS;
    return this.withInode(d.ino, () => this.fsyncHeld(d));
  }

  /** `fsyncFd`'s body, under the inode's lock: the commit and the flush after it are one sequence,
   *  and the flush's blob id comes from the state the commit left. */
  async fsyncHeld(d) {
    const published = await this.commit(d);
    if (published < 0) return published;
    // A commit already flushed what it published; flushing twice is a second 260 us (constraint 23)
    // for no durability. A caller that published nothing still gets its flush: the blob may hold
    // bytes from a write another description committed.
    if (published > 0) return 0;
    const live = await this.resolve(d.ino);
    if (typeof live === "number") return live;
    if (!live.id) return 0;
    const r = await this.io.request(IO_FSYNC, { id: live.id });
    return r < 0 ? r : 0;
  }

  /** ftruncate. A copy-up to the new length, then the handle truncated to it. `limit` is `size` and
   *  the copy's real length is `min(size, the source blob)`, computed in the I/O worker. Counted
   *  against a remembered size it is `min(size, STALE size)`, which returns another description's
   *  fsynced bytes as zeroes inside a generation whose blob length matches its published size. */
  async truncateFd(d, size) {
    if (this.readOnly) return -EROFS;
    return this.withInode(d.ino, () => this.truncateHeld(d, size));
  }

  /** `truncateFd`'s body, under the inode's lock: the same read-then-mutate as a write. */
  async truncateHeld(d, size) {
    if (!d.dirtyGen) {
      const live = await this.resolve(d.ino);
      if (typeof live === "number") return live;
      // A truncate to the file's current extent changes nothing, and staging for it costs a copy
      // and a journal record. `open(O_TRUNC)` of an already-empty file is the common case.
      if (size === live.end) return 0;
      const staged = await this.copyUp(d, live, size);
      if (typeof staged === "number") return staged;
      d.dirtyGen = staged.gen;
      d.stagingId = staged.id;
      d.baseMut = live.mut;
      d.baseEnd = live.end;
      d.log = [];
    }
    const r = await this.io.request(IO_TRUNCATE, { id: d.stagingId, size });
    if (r < 0) return r;
    this.stageMark(d, { k: "t", size });
    return 0;
  }

  /** What `fstat` reports for one description. One holding a STAGED generation reports that
   *  generation's length, so a caller that just wrote its own fd is not told its bytes are missing;
   *  one holding none reports the file's current EXTENT, which includes an uncommitted append by
   *  any description on the inode. */
  async statFd(d) {
    return this.withInode(d.ino, () => this.statHeld(d));
  }

  /** `statFd`'s body, under the inode's lock: `extentFd` pairs an extent with the blob it is an
   *  extent OF. */
  async statHeld(d) {
    if (!this.vfs) return -EIO;
    if (!this.vfs.holds(d.ino)) return -ESTALE;
    let info;
    try {
      info = this.vfs.fstat(d.ino);
    } catch (error) {
      return errnoOfFsError(error);
    }
    if (d.type !== "file") return info;
    const reach = await this.extentFd(d);
    if (typeof reach === "number") return reach;
    info.size = reach.end;
    return info;
  }

  /** Where `SEEK_END` lands: the same extent `fstat` reports and `read` clamps to. */
  async endFd(d) {
    return this.withInode(d.ino, async () => {
      const reach = await this.extentFd(d);
      return typeof reach === "number" ? reach : reach.end;
    });
  }

  /**
   * Close a description. A STAGED GENERATION IS COMMITTED FIRST AND THE COMMIT'S ERRNO IS RETURNED:
   * returning 0 after a refused commit loses acknowledged bytes on the ordinary path — write, then
   * exit without `fsync` — with success reported and fsck clean, because the blob length matches
   * the published size. POSIX allows `close` to report a deferred write error, and the fd's
   * resources are released either way. NOTED too, because a teardown reads no return value. -ESTALE
   * is the one refusal it swallows: the inode is gone, so there is nothing to publish.
   */
  async closeFd(d) {
    if (d.type !== "file") return 0;
    return this.withInode(d.ino, () => this.closeHeld(d));
  }

  /** `closeFd`'s body, under the inode's lock: the commit, the discard of whatever it could not
   *  publish, and the release of the row are one sequence. The row's reference must not drop while
   *  another operation on this inode is resting on it. */
  async closeHeld(d) {
    let r = 0;
    if (d.type === "file" && !this.readOnly) {
      r = await this.commit(d);
      if (r === -ESTALE) r = 0;
      if (r < 0) {
        this.note(`close of inode ${d.ino} could not publish its write: errno ${-r}`);
      }
    }
    // Whatever happened above, nothing may publish a staged generation after this point.
    if (d.dirtyGen || d.stagingId) await this.dropStaging(d);
    if (d.type === "file") await this.release(d.ino);
    return r < 0 ? r : 0;
  }
}

/** A transferable copy of bytes that may be backed by a SharedArrayBuffer. `postMessage` refuses to
 *  TRANSFER a SAB-backed view's buffer, and a structured clone of a SAB shares it rather than
 *  copying — so a record over shared memory is read at whatever the writer last left there. */
function copyOut(bytes) {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out.buffer;
}

export { copyOut, blobName };
