// The storage edge. Everything in src/fs/ is pure; every byte that reaches a disk goes through
// here, and here is the only place in the filesystem that knows an OPFS exists.
//
// THE WRITE ORDERING, which is the whole of the milestone's data-consistency decision:
//
//     blob -> flush -> journal -> flush -> apply in memory
//
// and an overwrite allocates a NEW blob rather than mutating the one the metadata points at.
// That is COPY-ON-WRITE, and it was chosen over "declare the guarantee metadata-only" because the
// blob name is just an integer, so writing a new one and swinging the reference at commit is close
// to free — and because a metadata-only guarantee is exactly ext4's `data=writeback`, which is not
// ext4's default precisely to avoid leaving intact metadata pointing at torn data.
//
// THE COW RULE AS BUILT, stated precisely because the loose version is both slower and weaker:
//
//   * A write that would modify bytes BELOW the committed size copies up — a new generation is
//     staged, the committed bytes are copied into it, and the write lands there. The committed
//     generation is untouched until the swing.
//   * A write entirely AT OR BEYOND the committed size appends into the current generation. The
//     committed `size` does not name those bytes, so a torn append cannot damage committed data:
//     a crash leaves the metadata pointing at the intact prefix it always pointed at.
//
// Without that split a sequential appender copies its whole file per fsync and the cost is
// quadratic. With it, `fsync` in a loop costs one flush, which is what constraint 23 prices.
//
// "THE COMMITTED SIZE" IS THE INODE'S, never the description's. Constraint 47 makes two opens of
// one file two descriptions over one inode, and POSIX has them sharing the file — so the rule's
// input is read from the VFS per write (`syncToInode`). A description's own snapshot of a size
// another description can change is a stale read by construction, and against it a write below a
// published size takes the append branch and overwrites committed bytes in place.
//
// THE FLUSH POINTS ARE FSYNC, SNAPSHOT AND IDLE (constraint 23), and nothing else. `flush()` is
// 260 us against a 5 us 4 KiB write; flushing per write makes the VFS 50x slower for durability
// nobody asked for, and buffering is POSIX's own contract rather than a shortcut.

import {
  IO_BLOB_OPEN, IO_WRITE, IO_READ, IO_FSYNC, IO_CLOSE, IO_TRUNCATE, IO_FREE, IO_LIST,
  IO_READ_ALL, IO_WRITE_ALL, IO_LOCK, IO_JOURNAL, IO_COPY, IO_STATS,
  BLOB_DIR, JOURNAL_NAME, SUPER_SLOTS, BOOT_LOCK_BUDGET_MS, BOOT_LOCK_FIRST_MS,
  JOURNAL_IDLE_MS,
  E, EIO, EROFS,
} from "../abi.mjs";
import { VFS, FsError, encodeOp, blobName } from "../fs/vfs.mjs";
import { encodeRecord } from "../fs/journal.mjs";
import { encodeSuperblock } from "../fs/superblock.mjs";
import { encodeImage } from "../fs/image.mjs";
import { fsck, MOUNT_RW, MOUNT_RO, MOUNT_FRESH, MOUNT_REFUSE, jsonSafe } from "../fs/fsck.mjs";

export { MOUNT_RW, MOUNT_RO, MOUNT_FRESH, MOUNT_REFUSE };

/** An FsError's code becomes an errno in ONE place. A code with no entry is -EIO, which is the
 *  honest answer for a refusal this table does not know how to name. */
export function errnoOfFsError(error) {
  if (error instanceof FsError) return -(E[error.code] ?? EIO);
  return -EIO;
}

export class Store {
  /**
   * @param {object} io   The dispatch kernel's I/O worker surface (request/boot/register).
   * @param {object} cfg  Boot config. `noCowOrder` and `noCrc` are the two negative-control
   *        stages and both refuse without a bench boot — the gate is in kernel.mjs, beside every
   *        other control hook, so the headline path has no control branch.
   */
  constructor(io, cfg = {}) {
    this.io = io;
    this.cfg = cfg;
    this.vfs = null;
    this.mode = MOUNT_REFUSE;
    this.report = null;
    this.lock = null;
    /** The journal record sequence. Monotonic from the snapshot's base, so replay can see a gap. */
    this.seq = 0n;
    this.journalFirstSeq = 0n;
    this.generation = 0n;
    this.slot = -1;
    /** ino -> the highest generation this kernel has STAGED, committed or not. A staged-and-lost
     *  generation must never be handed out twice: the stale blob is still on disk until a sweep
     *  reclaims it, and reusing its name would write into bytes fsck is about to report. */
    this.highestGen = new Map();
    this.dirty = false;
    this.idleTimer = null;
    this.stats = { blobWrites: 0, blobFlushes: 0, journalAppends: 0, journalFlushes: 0,
      snapshots: 0, copyUps: 0, swings: 0, deferredFrees: 0, immediateFrees: 0,
      discardedByControl: 0 };
  }

  get readOnly() {
    return this.mode !== MOUNT_RW && this.mode !== MOUNT_FRESH;
  }

  /* --------------------------- mount --------------------------- */

  /**
   * Take the boot lock, read the volume, run fsck, and decide how to mount.
   *
   * Nothing is written on any path but MOUNT_FRESH, and MOUNT_FRESH is the one case where there is
   * nothing to lose: no superblock slot, no journal, no blob. Constraint 28 is the distinction
   * between that and MOUNT_REFUSE — a volume whose bytes are present and do not decode mounts
   * read-only and REPORTS. webxp reseeded there, and that is silent data loss presented as
   * success.
   */
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
      // No VFS: there is no image to read without the journal, and a VFS built from a snapshot
      // with an unread journal would be a tree missing every op since the last snapshot.
      return this.report;
    }

    const slots = [];
    for (const name of SUPER_SLOTS) {
      const r = await this.io.request(IO_READ_ALL, { dir: "", name });
      slots.push(typeof r === "number" || !r.bytes ? null : new Uint8Array(r.bytes));
    }
    const journalRead = await this.io.request(IO_READ_ALL, { dir: "", name: JOURNAL_NAME });
    const journal = typeof journalRead === "number" || !journalRead.bytes
      ? new Uint8Array(0) : new Uint8Array(journalRead.bytes);
    // Constraint 33: the blob sweep is 0.60 ms per name on Safari, so 10k names is ~6 s. It runs
    // on an EXPLICIT fsck, never at boot, and a boot that skipped it says so rather than
    // reporting a clean sweep it did not take.
    const blobs = this.cfg.sweepBlobs ? await this.blobListing() : null;

    const report = fsck({ slots, journal, blobs, checkCrc: !this.cfg.noCrc });
    this.report = jsonSafe({ ...report, vfs: undefined, lock });
    this.report.lock = lock;

    if (report.mountable === MOUNT_FRESH) {
      this.vfs = new VFS({ owner: { uid: 0, gid: 0 } });
      this.mode = MOUNT_FRESH;
      // The initial superblock. The ONE write a failed validation may ever lead to, and it is
      // legal because there was no volume: `fresh` means no slot, no journal and no blob.
      await this.writeSnapshot();
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
    // The next record follows the last one replay ACCEPTED. A kernel that resumed from the
    // journal's byte length would write over a discarded tail and make it unrecoverable; a kernel
    // that resumed from zero would collide with records already in the file.
    this.seq = this.journalFirstSeq + BigInt(report.journal.records);
    // The staging floor. Every generation already on disk is spoken for, committed or not.
    for (const entry of this.vfs.blobNames()) {
      const parsed = /^(\d+)\.(\d+)$/.exec(entry.name);
      if (parsed) this.highestGen.set(Number(parsed[1]), Number(parsed[2]));
    }
    this.mode = report.mountable === MOUNT_RW ? MOUNT_RW : MOUNT_RO;
    // A journal with a discarded tail mounts READ-ONLY and the tail stays on disk. Truncating it
    // would make the one thing a user might recover unrecoverable, and it would turn the report
    // into an assertion nobody can check afterwards.
    return this.report;
  }

  /**
   * The storage edge's own counters and operation trace.
   *
   * A MEASUREMENT PATH, used by no filesystem operation. Two properties are otherwise only
   * readable in the code rather than checkable: constraint 23's write ordering — observable as
   * the SEQUENCE of operations the edge performed, because an unflushed handle's bytes are still
   * visible to a later read in the same agent — and constraint 24's budget of one
   * `getDirectoryHandle` for the module's life.
   */
  async ioStats() {
    const r = await this.io.request(IO_STATS, {});
    return typeof r === "number" ? { errno: r } : r;
  }

  async blobListing() {
    const r = await this.io.request(IO_LIST, { dir: BLOB_DIR });
    return typeof r === "number" ? [] : r;
  }

  /** An explicit fsck over the live volume, blob sweep included. It NEVER writes: `fsck()` in
   *  src/fs/ holds no handle and no root, so there is no object there a reseed could go through,
   *  and this wrapper only reads. */
  async check() {
    const slots = [];
    for (const name of SUPER_SLOTS) {
      const r = await this.io.request(IO_READ_ALL, { dir: "", name });
      slots.push(typeof r === "number" || !r.bytes ? null : new Uint8Array(r.bytes));
    }
    const journalRead = await this.io.request(IO_READ_ALL, { dir: "", name: JOURNAL_NAME });
    const journal = typeof journalRead === "number" || !journalRead.bytes
      ? new Uint8Array(0) : new Uint8Array(journalRead.bytes);
    const blobs = await this.blobListing();
    const report = fsck({ slots, journal, blobs, checkCrc: !this.cfg.noCrc });
    const out = jsonSafe({ ...report, vfs: undefined });
    out.inodes = report.vfs ? report.vfs.stats() : null;
    return out;
  }

  /* --------------------------- the journal --------------------------- */

  /**
   * Append one op. NOT flushed: constraint 23's flush points are fsync, snapshot and idle.
   *
   * The idle timer is armed here and nowhere else, so "idle" means "no metadata op for
   * JOURNAL_IDLE_MS" rather than a wall-clock tick that could fire between a blob write and its
   * commit record.
   */
  async journal(op) {
    if (this.readOnly) return -EROFS;
    const payload = encodeOp(op);
    const record = encodeRecord(this.seq, payload);
    const n = await this.io.request(IO_JOURNAL, { op: "append", bytes: copyOut(record) });
    if (n < 0) return n;
    this.seq += 1n;
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
    if (!this.dirty) return 0;
    const r = await this.io.request(IO_JOURNAL, { op: "flush" });
    if (r === 0) {
      this.dirty = false;
      this.stats.journalFlushes += 1;
    }
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

  /**
   * A file description over a resolved inode.
   *
   * CONSTRAINT 47'S HEADLINE CASE IS HERE: two opens of one file both succeed. The handle is an
   * exclusive lock, so a second `createSyncAccessHandle` would throw NoModificationAllowedError
   * and `cat notes.txt | wc -l` would fail while an editor held the file. The I/O worker's
   * per-inode table makes the second open a REFCOUNT on the first handle, which is why this can
   * return a description at all rather than -EBUSY.
   */
  async openFd(decision) {
    const d = {
      ino: decision.ino, type: decision.type, gen: decision.gen, size: decision.size,
      pos: 0, stagedSize: decision.size, dirtyGen: 0, stagingId: 0, blobId: 0,
      appendPending: false,
    };
    if (decision.type === "file" && decision.gen > 0) {
      const opened = await this.io.request(IO_BLOB_OPEN, { ino: d.ino, gen: d.gen });
      if (typeof opened === "number") return opened;
      d.blobId = opened.id;
      d.refs = opened.refs;
      // The size the HANDLE reports, kept beside the size the METADATA publishes. They differ
      // exactly when an append was written and not yet committed, which is the state the COW rule
      // deliberately permits, so the pair is reported rather than reconciled.
      d.blobBytes = opened.size;
    }
    return d;
  }

  async closeBlob(id) {
    return this.io.request(IO_CLOSE, { id });
  }

  /**
   * Re-point a CLEAN file description at the inode's CURRENT committed generation and size.
   *
   * THE INPUT TO THE APPEND-VS-COPY-UP TEST, and it must be the INODE'S rather than this
   * description's. POSIX has two fds on one file sharing the file, so a size another description
   * published is this description's committed size too — and a per-description snapshot of a
   * value another description can change is a stale read by construction.
   *
   * WHAT IT COSTS TO GET WRONG, observed with two fds on a 9-byte file: fd1 pwrites 32 B at
   * offset 9 and fsyncs, publishing size 41. fd2 then pwrites at offset 9, which is 32 B BELOW
   * the committed size, so a correct copy-on-write must stage a new generation. Against the
   * description's own snapshot of 9 that write reads as an append, lands in the committed
   * generation in place, and overwrites bytes the metadata already named — intact metadata
   * pointing at overwritten data, which is the one outcome copy-on-write exists to prevent. The
   * commit that followed then published a size computed from the same stale base and lost fd1's
   * committed bytes outright.
   *
   * ONLY A CLEAN DESCRIPTION IS RE-POINTED, and the boundary is where the guarantee ends. A
   * description holding uncommitted bytes has a `stagedSize` that names them, and moving it would
   * discard a write the caller was told had succeeded. So two descriptions that are both DIRTY at
   * once is the case this does not resolve: each staged a generation from the base it last saw,
   * and whichever commits second publishes a generation the other's uncommitted bytes are not in.
   * POSIX gives no guarantee there without a lock and M2 has no file lock to offer. What IS
   * guaranteed is the line proof (d) checks: bytes that were FSYNCED survive another
   * description's later write.
   */
  async syncToInode(d) {
    if (d.type !== "file") return 0;
    const live = this.vfs.committed(d.ino);
    if (live.gen === d.gen) {
      d.size = live.size;
      d.stagedSize = live.size;
      return 0;
    }
    // Another description swung the inode onto a generation this one has never held. Take a
    // reference on the live generation BEFORE releasing ours, so a free the swing deferred sees a
    // true count and the superseded blob is not removed between the two steps.
    let opened = null;
    if (live.gen > 0) {
      opened = await this.io.request(IO_BLOB_OPEN, { ino: d.ino, gen: live.gen });
      if (typeof opened === "number") return opened;
    }
    const previous = d.blobId;
    d.blobId = opened ? opened.id : 0;
    d.blobBytes = opened ? opened.size : 0;
    if (previous) await this.closeBlob(previous);
    d.gen = live.gen;
    d.size = live.size;
    d.stagedSize = live.size;
    return 0;
  }

  /**
   * Stage a new generation for a description about to modify committed bytes, copying the
   * committed prefix into it. `keep` bytes are copied; the rest is the caller's to write.
   *
   * The copy runs inside the I/O worker, handle to handle, so the bytes never cross an agent
   * boundary. It runs once per DIRTY EPOCH — not once per write — which is what keeps a sequential
   * overwrite linear.
   */
  async copyUp(d, keep) {
    const gen = this.nextGen(d.ino, d.gen);
    const staged = await this.io.request(IO_BLOB_OPEN, { ino: d.ino, gen });
    if (typeof staged === "number") return staged;
    if (keep > 0 && d.gen > 0 && d.blobId) {
      const copied = await this.io.request(IO_COPY, {
        from: d.blobId, to: staged.id, length: keep,
      });
      if (copied < 0) return copied;
    }
    this.stats.copyUps += 1;
    return { gen, id: staged.id };
  }

  /** Whether a description has anything a commit would publish. */
  static dirty(d) {
    return d.dirtyGen > 0 || d.appendPending === true;
  }

  /**
   * THE COMMIT. blob -> flush -> journal -> flush -> apply in memory. Then the swing.
   *
   * One function for both shapes, because they differ only in which blob is flushed: a copy-up
   * commits a STAGED generation and swings the inode onto it; an append commits the generation the
   * inode is already on and only publishes the new size. A second function would be a second place
   * to get the ordering wrong.
   *
   * THE NEGATIVE CONTROL, STAGE 1 (`noCowOrder`): the metadata commit lands and the data does not.
   *
   * It discards the staged bytes rather than only skipping `flush()`, and the reason is a
   * measurement. Skipping the flush alone changed NOTHING observable: with `blobFlushes: 0` the
   * volume still read back whole and fsck came back clean, because an unflushed
   * FileSystemSyncAccessHandle write is still visible to a later read IN THE SAME AGENT —
   * `flush()` buys durability past a process death, not visibility. The only way to observe the
   * ordering from inside one session is to reproduce the state a crash between the two steps
   * leaves: metadata that is durable, data that is not there. fsck must then report corruption.
   *
   * The branch is read from the boot config once and the config refuses without `bench=1`
   * (src/kernel/kernel.mjs), so the headline path carries the ordering and no control `if`.
   */
  async commit(d) {
    if (this.readOnly) return -EROFS;
    const staging = d.dirtyGen > 0;
    const gen = staging ? d.dirtyGen : d.gen;
    const blobId = staging ? d.stagingId : d.blobId;
    const op = {
      k: "commit", ino: d.ino, gen, size: d.stagedSize, prevGen: d.gen, t: Date.now(),
    };

    // 1. the blob, 2. its flush. Durable BEFORE anything points at it.
    if (!this.cfg.noCowOrder) {
      const flushed = await this.io.request(IO_FSYNC, { id: blobId });
      if (flushed < 0) return flushed;
      this.stats.blobFlushes += 1;
    }

    // 3. the journal record, 4. its flush.
    const appended = await this.journal(op);
    if (appended < 0) return appended;
    const jflush = await this.flushJournal();
    if (jflush < 0) return jflush;

    // 5. apply in memory, and only now. The in-memory table is what every subsequent open reads,
    // so publishing it before the journal is on disk would make a crash lose a swing the running
    // system had already acted on.
    this.vfs.applyOp(op);
    this.stats.swings += 1;

    // The control's second half: the metadata now names bytes that are not there.
    if (this.cfg.noCowOrder && op.size > 0) {
      await this.io.request(IO_TRUNCATE, { id: blobId, size: 0 });
      this.stats.discardedByControl += 1;
    }

    // THE SWING ITSELF, and the order of these two steps is constraint 47's interaction with
    // copy-on-write. This description's own reference on the superseded generation is released
    // FIRST, so the free below sees a true reference count: if this was the only reader the blob
    // goes now, and if another process still holds it the removal defers to that process's close.
    // The refcount table arbitrates; the directory only records the outcome.
    if (staging) {
      const previous = d.blobId;
      d.blobId = d.stagingId;
      d.stagingId = 0;
      d.dirtyGen = 0;
      if (previous) await this.closeBlob(previous);
    }
    d.gen = gen;
    d.size = op.size;
    d.appendPending = false;
    if (op.prevGen && op.prevGen !== gen) {
      const r = await this.io.request(IO_FREE, { ino: op.ino, gen: op.prevGen });
      if (r && r.deferred) this.stats.deferredFrees += 1;
      else this.stats.immediateFrees += 1;
    }
    return 0;
  }

  /** Free every generation of an inode whose last link went. */
  async freeInode(ino) {
    const highest = this.highestGen.get(ino) || 0;
    for (let gen = 1; gen <= highest; gen += 1) {
      await this.io.request(IO_FREE, { ino, gen });
    }
    this.highestGen.delete(ino);
  }

  /* --------------------------- the snapshot --------------------------- */

  /**
   * Write the in-memory table to the next superblock slot and reset the journal.
   *
   * Round-robin over three slots so the newest valid one is never the only valid one: against two
   * alternating slots a bad write to the older one during a commit can leave zero valid copies
   * (Phantom's argument, src/fs/superblock.mjs).
   *
   * ORDER: image+superblock into the new slot and flushed, THEN the journal truncated. Truncating
   * first would leave a window where neither the old slot's journal nor the new slot's image holds
   * the ops.
   */
  async writeSnapshot() {
    if (this.mode === MOUNT_RO || this.mode === MOUNT_REFUSE) return -EROFS;
    await this.flushJournal();
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
    // The journal is reset only once the slot that supersedes it is on disk and flushed.
    const t = await this.io.request(IO_JOURNAL, { op: "truncate" });
    if (t < 0) return t;
    this.generation = generation;
    this.slot = slot;
    this.journalFirstSeq = this.seq;
    this.dirty = false;
    this.stats.snapshots += 1;
    return 0;
  }

  /* --------------------------- fd-level data I/O --------------------------- */

  /**
   * One write through a file description. Returns a promise, which calls.mjs's settle() turns into
   * a PENDING syscall answered by later() — so the dispatch thread is never held by storage.
   *
   * `at` is the file offset. `undefined` means "the description's cursor, and advance it";
   * a number means `pwrite`, which must NOT touch the cursor. The offset is a PARAMETER rather
   * than a saved-and-restored `d.pos` because every call here awaits: a `pwrite` that moved the
   * cursor, awaited, and moved it back would be interleaved by any concurrent read or write on the
   * same fd and would corrupt the other call's position.
   */
  async writeFd(d, pid, srcOff, length, at) {
    if (this.readOnly) return -EROFS;
    const positional = at !== undefined;
    const from = positional ? at : d.pos;
    // The decision below is made against the INODE's committed size, not this description's
    // snapshot of it. syncToInode carries the argument and the measurement.
    if (!Store.dirty(d)) {
      const synced = await this.syncToInode(d);
      if (synced < 0) return synced;
    }
    // THE COW DECISION, and the only place it is made. Below the committed size is a copy-up; at
    // or beyond it is an append into the current generation, because the committed `size` does not
    // name those bytes and a torn append cannot damage committed data.
    if (!d.dirtyGen && from < d.size) {
      const staged = await this.copyUp(d, d.size);
      if (typeof staged === "number") return staged;
      d.dirtyGen = staged.gen;
      d.stagingId = staged.id;
      d.stagedSize = d.size;
    } else if (!d.dirtyGen && d.gen === 0) {
      // A file with no blob at all. Its first generation is staged the same way, which keeps one
      // path for "new file" and "overwrite" rather than two.
      const gen = this.nextGen(d.ino, 0);
      const staged = await this.io.request(IO_BLOB_OPEN, { ino: d.ino, gen });
      if (typeof staged === "number") return staged;
      d.dirtyGen = gen;
      d.stagingId = staged.id;
      d.stagedSize = 0;
    }
    const target = d.dirtyGen ? d.stagingId : d.blobId;
    const n = await this.io.request(IO_WRITE, { id: target, pid, srcOff, length, at: from });
    if (n < 0) return n;
    this.stats.blobWrites += 1;
    if (!positional) d.pos = from + n;
    const end = from + n;
    if (end > (d.stagedSize || 0)) d.stagedSize = end;
    if (!d.dirtyGen && end > d.size) {
      // An append into the committed generation. The bytes are there; the size the metadata
      // publishes is not, and it will not be until the next commit — which is the guarantee: a
      // crash here leaves the intact prefix the metadata already named.
      d.appendPending = true;
    }
    return n;
  }

  /** The read half, with the same offset rule. */
  async readFd(d, pid, dstOff, length, at) {
    if (d.gen === 0 && !d.dirtyGen) return 0;
    const positional = at !== undefined;
    const from = positional ? at : d.pos;
    const size = d.dirtyGen || d.appendPending ? d.stagedSize : d.size;
    const want = Math.min(length, Math.max(0, size - from));
    if (want <= 0) return 0;
    const id = d.dirtyGen ? d.stagingId : d.blobId;
    const n = await this.io.request(IO_READ, { id, pid, dstOff, length: want, at: from });
    if (n < 0) return n;
    if (!positional) d.pos = from + n;
    return n;
  }

  /** fsync: the blob's flush and the metadata swing, in that order. Constraint 23's whole point —
   *  a separate call, so the 260 us is paid when a caller asks for durability and not per write. */
  async fsyncFd(d) {
    if (this.readOnly) return -EROFS;
    if (!Store.dirty(d)) {
      // Nothing to publish, and a caller asking for durability still gets a flush: the blob may
      // hold bytes from a write whose commit already landed.
      if (!d.blobId) return 0;
      const r = await this.io.request(IO_FSYNC, { id: d.blobId });
      return r < 0 ? r : 0;
    }
    return this.commit(d);
  }

  async truncateFd(d, size) {
    if (this.readOnly) return -EROFS;
    // Same stale-snapshot argument as writeFd: `keep` is a count of COMMITTED bytes, so it must
    // be counted against the inode's committed size and copied out of the generation the inode
    // currently points at.
    if (!Store.dirty(d)) {
      const synced = await this.syncToInode(d);
      if (synced < 0) return synced;
    }
    if (!d.dirtyGen) {
      const keep = Math.min(size, d.size);
      const staged = await this.copyUp(d, keep);
      if (typeof staged === "number") return staged;
      d.dirtyGen = staged.gen;
      d.stagingId = staged.id;
    }
    const r = await this.io.request(IO_TRUNCATE, { id: d.stagingId, size });
    if (r < 0) return r;
    d.stagedSize = size;
    return 0;
  }

  /** Close a description. A dirty generation is committed first: a close that discarded staged
   *  bytes would lose a write the caller had no reason to think was lost, and POSIX's contract is
   *  that the data is there once the write returned even if the metadata is not yet durable. */
  async closeFd(d) {
    if (Store.dirty(d) && !this.readOnly) await this.commit(d);
    if (d.stagingId) await this.closeBlob(d.stagingId);
    if (d.blobId) await this.closeBlob(d.blobId);
    d.blobId = 0;
    d.stagingId = 0;
    return 0;
  }
}

/**
 * A transferable copy of bytes that may be backed by a SharedArrayBuffer.
 *
 * `postMessage` refuses to TRANSFER a SAB-backed view's buffer, and a plain structured clone of a
 * SAB shares it rather than copying — so a record built over shared memory would be read by the
 * I/O worker at whatever the writer had left there. Every caller here builds its bytes privately,
 * and this makes that a property of the transport rather than of each call site.
 */
function copyOut(bytes) {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out.buffer;
}

export { copyOut, blobName };
