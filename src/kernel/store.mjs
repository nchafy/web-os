// The storage edge. Everything in src/fs/ is pure; every byte that reaches a disk goes through
// here, and here is the only place in the filesystem that knows an OPFS exists.
//
// THE WRITE ORDERING, which is the whole of the milestone's data-consistency decision:
//
//     blob -> flush -> validate -> journal -> flush
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
// A FILE DESCRIPTION CACHES NO DURABLE STATE. It holds exactly three things:
//
//   1. `ino`      — which inode it refers to. Stable for the description's life. `type` rides with
//                   it because an inode's type never changes either.
//   2. `pos`      — the caller's offset. Per-description by POSIX, not durable state.
//   3. `dirtyGen`, `stagingId`, `baseMut`, `baseEnd` and `log` — its own STAGED generation, when it
//                   has one, and WHAT THAT GENERATION WAS DERIVED FROM.
//
// THE STAGED GENERATION IS PRIVATE AND ITS BASE IS NOT, which is the distinction a whole round of
// attacks turned on. Nobody else can write this description's staged blob — so `dirtyGen` and
// `stagingId` really are private — but its CONTENTS were copied out of a generation another
// description can move afterwards. A size derived from that copy is therefore a cached read of
// durable state wearing a private field's clothes, and publishing it later publishes a snapshot:
// measured as four bytes that `pwrite` AND `fsync` both acknowledged, reverted by another
// description's commit, with every call returning 0 and fsck reporting the volume clean.
//
// So the description records the base — `baseMut`, the inode's mutation counter as the copy was
// taken, and `baseEnd`, how far the copy reached — and the ORDERED LOG of its own modifications,
// and there is no staged SIZE field at all: `stagedEnd()` replays the log onto a base, and
// `extentFd()` is the one renderer of the number a READER is told, for `read`, `fstat` and
// `SEEK_END` alike, always onto the LIVE base. The commit is then a compare-and-swap (see
// `commitOnce` and `moved`), and a failed validation re-copies from the new base and replays the
// log, which keeps both writers' bytes instead of silently choosing one.
//
// EVERYTHING ELSE — the current generation, the size the metadata publishes, how far the file's
// bytes reach — IS READ AT THE POINT OF USE. `resolve()` is that read and there is no second way
// to get the same numbers: no field recorded at open, no predicate deciding whether a refresh is
// due, no helper some paths remember to call.
//
// READING AT THE POINT OF USE IS NECESSARY AND IT IS NOT SUFFICIENT, which is what six rounds of
// attacks established one address at a time. This kernel yields at every `await`, so a sequence
// that READS durable state and then MUTATES it is interleavable at every point in between, and the
// read is stale by the time the mutation lands however late it was taken. Six fixes in a row were
// each a correct local repair of one such sequence and each left the others standing: the
// generation moved at `applyOp` while the stamp that records it landed three awaits later; a
// handle id was closed by one operation while another still held it across an await; an extent and
// the blob behind it were read from two different states.
//
// SO EVERY DURABLE READ-THEN-MUTATE RUNS UNDER A PER-INODE MUTEX — `withInode` below, which is the
// only primitive that makes the sequence atomic rather than making one more of its windows
// narrower. Per inode and not global, so unrelated files stay concurrent and the I/O worker keeps
// the parallelism constraint 58 bought.
//
// THE COMPARE-AND-SWAP STAYS, AND THE TWO ARE NOT THE SAME MECHANISM. The lock orders operations
// WITHIN one mount, which is a property of this kernel's own scheduling and dies with the agent.
// The CAS validates a RECORD against the inode it lands on, which is what replay does after a
// remount with no kernel and no lock in sight. Serialization makes read-modify-write atomic; the
// CAS makes replay safe. The CAS was failing at the first job in a new place every round because
// it was being asked to do it at all.
//
// THAT IS A FIX FOR ONE DEFECT WITH SEVEN ADDRESSES, each found by the round of attacks after the
// one that patched the previous: `writeFd` and `truncateFd` reading an open-time `d.size`;
// `commit` publishing a size from a stale base; `copyUp` taking its length from the COPYING
// description while the shared blob was physically longer; `readFd` clamping to `d.size` and
// reading `d.blobId` and never resyncing at all, so one fd reported `fstat` 40 and `pread` 8;
// `closeFd` committing and discarding the errno, so `close()` returned 0 after losing
// acknowledged bytes; and `open(O_TRUNC)` staging a truncation it never committed. Seven sites,
// one cause: a description caching state another description can change. The predicate that
// gated the resync is gone with the cache, and so is the question of which one it should have
// been.
//
// IT COSTS A LOOKUP PER OPERATION AND THE MEASUREMENTS SAY THAT IS AFFORDABLE: constraint 25
// prices `stat` at 27 ns over the in-memory inode tree against a 14-16 us syscall and a 260 us
// flush. Constraint 22's "open is rare, fd I/O is common" is about `createSyncAccessHandle` at
// 495 us, which is why the HANDLE is pooled per inode (`held` below) while every NUMBER is not.
//
// AN UNCOMMITTED APPEND IS NOT PRIVATE STATE, which is the part that looks like it should be. Its
// bytes are in the generation the inode already points at, physically above the size the metadata
// publishes — so "is there an append to publish" must be answered identically for every
// description on the inode. The flag that used to record it per description was a private copy of
// a shared fact, and a description that closed without the flag published nothing and lost bytes
// `pwrite` had already acknowledged.
//
// IT IS ANSWERED BY THE PER-INODE HANDLE ROW'S `end`, AND DELIBERATELY NOT BY THE BLOB'S PHYSICAL
// LENGTH. The blob was the authority and a crash falsifies it: bytes above the published size are
// uncommitted by definition, and after a restart nothing on disk distinguishes them from committed
// data — so `max(published size, blob length)` resurrected them, and the next `close()` made them
// durable. Measured by growing `blobs/22.1` from 8 bytes to 40 page-side: the remount reported no
// problems, `stat` answered 40, a read returned 32 bytes nobody wrote, and the close published it.
//
// THE PUBLISHED SIZE IS THE ONLY AUTHORITY ON WHAT A FILE CONTAINS. The row's `end` starts at it
// every time the row is pointed at a generation, and only this kernel's own appends raise it; a
// crash takes the row with it, so the slack is unreachable on the next boot. The bytes themselves
// stay on disk and fsck REPORTS them as slack (src/fs/fsck.mjs `long`) rather than reclaiming them
// under a mount, because a mount must not write.
//
// THE FLUSH POINTS ARE FSYNC, SNAPSHOT AND IDLE (constraint 23), and nothing else. `flush()` is
// 260 us against a 5 us 4 KiB write; flushing per write makes the VFS 50x slower for durability
// nobody asked for, and buffering is POSIX's own contract rather than a shortcut.

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

/**
 * How many times one `commit` will re-stage before it refuses.
 *
 * THE BOUND EXISTS BECAUSE THE RETRY IS NOT GUARANTEED TO CONVERGE: every attempt re-reads the
 * base, and a description that keeps losing the race would loop forever against a writer that
 * keeps winning it. Four is one initial attempt and three re-stages. The cost of exhausting it is
 * four copy-ups and four flushes — about 1 ms at constraint 23's 260 us — and the answer at the
 * end is -EBUSY, never a silent revert.
 */
const COMMIT_ATTEMPTS = 4;

/**
 * WHAT THE BOUND IS WORTH NOW THAT THE INODE IS LOCKED, stated because the arithmetic changed and
 * the comment above would otherwise describe a state nobody can reach.
 *
 * `commit` holds the inode across its re-stage, so the base it re-reads cannot move before the
 * retry validates against it: one re-stage is always enough and a commit can lose its base at most
 * ONCE. Exhaustion needs four in a row, so -EBUSY is unreachable within a mount — measured at 200
 * rounds per writer against two contending writers, 83 refusals and `casExhausted` 0, where the
 * same workload exhausted 13 of 200 before. The bound stays because a loop that retries I/O must
 * terminate on its own terms rather than on an argument about its callers.
 */

/**
 * `commitOnce`'s third answer, which is neither success nor an errno: the compare-and-swap's
 * validation refused, so the caller must re-stage and try again. A sentinel rather than an errno
 * because it must be impossible to return to userland by accident.
 */
const REBASE = Symbol("rebase");

/**
 * THE RESERVED LOCK KEY FOR THE VOLUME'S OWN STATE: the journal's sequence counter, the journal
 * file, and the superblock slot a snapshot writes.
 *
 * WHY THE PER-INODE LOCK CANNOT COVER IT. A snapshot serialises the whole tree and the sequence
 * counter together and then truncates the journal, and that sequence belongs to no inode — so
 * there is no inode a snapshot could hold that would exclude an append. Measured as a loss with
 * nothing but a snapshot and one `mkdir`: the image records `journalFirstSeq = seq`, a record
 * allocated after the serialize and before the truncate lands at exactly that sequence, the
 * truncate destroys it, and replay then reads an EMPTY journal starting at the sequence it
 * expects — no gap, no discarded tail, no problem reported, and an op that returned success to
 * userland gone.
 *
 * A SYMBOL AND NOT A SENTINEL NUMBER, because -1 and 0 are integers an inode number could become
 * after an arithmetic slip, and the collision would be a snapshot serialising against one file's
 * writes.
 *
 * THE LOCK ORDER IS INODE THEN VOLUME, never the reverse: `commitOnce` holds an inode and reaches
 * the journal, and nothing holding the volume takes an inode. scripts/fsfuzz.py's `order` rule is
 * that sentence as a lint, because a cycle here is a syscall that never settles.
 */
const VOLUME = Symbol("volume");

/**
 * THE COMPARE-AND-SWAP'S COMPARISON, in one place because it is asked twice — once as an early-out
 * before a flush nobody needs, and once immediately before the publish, where it is load-bearing.
 *
 * ONE INTEGER: THE INODE'S MUTATION COUNTER, read off the per-inode handle row at both points.
 *
 * It was `(gen, end)`, and that stamp was the wrong SHAPE rather than too short. It summarised the
 * inode's state by two of its observable effects, and an in-place write INSIDE THE SLACK — above
 * the published size, below the row's `end` — moves neither: the bytes change, the generation does
 * not, the extent does not. So the CAS passed and a staged commit reverted bytes another
 * description had already fsynced, with fsck reporting the volume clean because the blob's length
 * still matched the published size. Measured, two descriptions, one process, no crash:
 * `pwrite(fd1, 4B, 8)` opens the slack, `pwrite(fd2, 8B, 0)` copies up with base `(gen 1, end 12)`,
 * `pwrite(fd1, 4B, 8)` lands in the slack in place, `fsync(fd1)` publishes size 12 on generation 1,
 * and fd2's commit then read `(gen 1, end 12)` unchanged and reverted the patch.
 *
 * A COUNTER CANNOT BE BLIND TO A MUTATION THAT LEAVES A DERIVED NUMBER UNCHANGED, which is why the
 * answer is a counter and not a longer tuple: two different states can share any summary, and the
 * next shape of the same bug would be the next pair of states that happen to agree. Every operation
 * that changes the bytes or the length of the CURRENT generation bumps it — `writeFd`'s append arm,
 * which is where an append and an in-place slack write both land, and `commitOnce`'s publish, which
 * is the only thing that moves a generation or a size. A staged generation is private, so writes
 * into one bump nothing.
 */
function moved(base, now) {
  return base.mut !== now.mut;
}

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
  constructor(io, cfg = {}, note = null) {
    this.io = io;
    this.cfg = cfg;
    /** How a refusal nobody is awaiting reaches the page. An error path must NAME what failed, and
     *  the places that need it are the ones a caller cannot see: a commit refused inside a
     *  process's teardown, and a blob the metadata names that is not on disk. */
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
    /** ino -> the highest generation this kernel has STAGED, committed or not. A staged-and-lost
     *  generation must never be handed out twice: the stale blob is still on disk until a sweep
     *  reclaims it, and reusing its name would write into bytes fsck is about to report. */
    this.highestGen = new Map();
    /**
     * ino -> { gen, id, users }. The sync access handle this Store rests on for an inode's CURRENT
     * committed generation, and the ONLY place a handle id survives between two calls.
     *
     * KEYED BY INODE, which is the whole reason it lives here and not on the description.
     * Constraint 47 makes two opens of one file two descriptions over one inode and POSIX has
     * them sharing the file, so a per-description record of "which generation am I on" is a value
     * another description can change — a stale read by construction, and the thing seven separate
     * bugs were. One row per inode cannot have that defect: there is one of it, every description
     * on the inode sees the same one, and `resolve()` re-points it against the VFS at the point of
     * use rather than when a predicate says a refresh is due.
     *
     * WHY A HANDLE IS POOLED WHEN NO NUMBER IS: `createSyncAccessHandle` is 495 us (constraint
     * 22), so opening and closing one per read would cost 30 syscalls per read. A generation
     * number is 27 ns out of the inode table (constraint 25) and is therefore never kept.
     *
     * `users` counts DESCRIPTIONS resting on the row. The row holds exactly one I/O-level
     * reference on the blob, which is what the per-inode refcount in src/kernel/iocore.mjs
     * arbitrates against.
     *
     * `mut` IS THE COMPARE-AND-SWAP'S STAMP (see `moved`), and it lives here for the same reason
     * `end` does: every description on the inode must read the same number and none of them may own
     * it. It is deliberately NOT durable — a crash takes the row and the slack it stamps together,
     * and the next mount starts from the published size — so there is nothing on disk to keep
     * monotonic. The row outlives every base taken from it, because a description that recorded one
     * holds a `users` reference until it closes.
     */
    this.held = new Map();
    /**
     * key -> the promise the NEXT operation under that key waits on. THE MUTEX'S WHOLE STATE; see
     * `withKey`. An entry exists only while an operation under that key is running or queued, so a
     * 10,000-file workload holds at most as many entries as it has operations in flight.
     *
     * The keys are inode numbers and `VOLUME`. Two keyspaces in one map because they are one
     * primitive: a Symbol cannot collide with a number, so the reserved key needs no reservation
     * beyond its own identity.
     */
    this.lockTail = new Map();
    this.dirty = false;
    this.idleTimer = null;
    this.stats = { blobWrites: 0, blobFlushes: 0, journalAppends: 0, journalFlushes: 0,
      snapshots: 0, copyUps: 0, swings: 0, deferredFrees: 0, immediateFrees: 0,
      discardedByControl: 0, refusedCommits: 0, discardedStagings: 0,
      // The compare-and-swap's own report. `casRefusals` counts validations that failed,
      // `restages` EVERY re-copy onto a moved base — a refused commit's, and a reader's in
      // `extentFd` — and `casExhausted` the commits that ran out of attempts and refused to the
      // caller. A silent revert would show up as all three at zero.
      casRefusals: 0, restages: 0, casExhausted: 0,
      // `readRebases` counts stages re-based by a READER (see `extentFd`) rather than by a commit,
      // and `journalBurns` the sequence numbers an append failure burned (see `journal`). Both are
      // events a reader of the volume cannot otherwise see.
      readRebases: 0, journalBurns: 0 };
  }

  /**
   * SERIALIZE ONE INODE'S DURABLE READ-THEN-MUTATE SEQUENCES. The primitive the rest of this file
   * rests on, and the answer to a defect that had six addresses before it had one cause.
   *
   * HOW IT WORKS: every entrant swaps its own release promise in as the tail and awaits the tail
   * it displaced. The swap is synchronous — there is no `await` between the `get` and the `set` —
   * so the queue is strictly FIFO and two operations issued in the same dispatch turn run in the
   * order they were issued.
   *
   * WHO TAKES IT, and this list is the whole of it: `openFd`, `writeFd`, `readFd`, `fsyncFd`,
   * `truncateFd`, `statFd`, `endFd`, `closeFd`, `sizeOf`'s slow path, and `freeInode`. Every one
   * of them is an entry point a syscall reaches; nothing reachable from inside one takes it. Each
   * one is a taker and nothing else, with its work in a `…Held` method or an inline closure —
   * the suffix is the precondition: the inode is already held, so this must not be called from
   * anywhere but its taker.
   *
   * WHAT RUNS UNDER IT AND MUST NEVER TAKE IT: `resolve`, `copyUp`, `discard`, `dropStaging`,
   * `restage`, `commit`, `commitOnce`, `extentFd`, `acquire`, `release`. A second acquisition from
   * inside the body would wait on a tail only the body itself can release.
   *
   * THE OTHER KEYSPACE IS THE VOLUME'S (`withVolume`), and the two are ordered: an inode holder
   * may take the volume — `commitOnce` does, to append its record — and a volume holder may never
   * take an inode. That is the whole of the deadlock argument between them.
   *
   * THE DEADLOCK RULE: ONE LOCK, ONE INODE, NEVER HELD ACROSS ANOTHER `withInode`. A future
   * operation that must hold two inodes at once — `rename` is the one on the horizon, and it does
   * not take this lock today because it mutates no inode's data — MUST acquire them in ascending
   * inode order, so two renames crossing the same pair cannot each hold what the other wants.
   *
   * WHAT IT DOES NOT PROTECT, stated so the boundary is not mistaken for a guarantee: metadata ops
   * (`calls.mjs` metaOp) take no inode lock. They are correct without one because the VFS method
   * that mutates the tree is synchronous and changes no generation, no published size and no
   * handle row — the three things a data operation reads and re-reads.
   *
   * @param {number} ino
   * @param {() => Promise<any>} body
   */
  async withInode(ino, body) {
    return this.withKey(ino, body);
  }

  /**
   * THE VOLUME'S LOCK: the journal's sequence counter, the journal file and the superblock slot.
   * See `VOLUME` for what it closes and why an inode could not.
   *
   * WHO TAKES IT, and this list is the whole of it: `journal`, `flushJournal` and `writeSnapshot`.
   * Each is a taker and nothing else, with its work in a `…Held` method — so `writeSnapshot` can
   * flush the journal it is about to truncate without waiting on a tail only it can release.
   *
   * @param {() => Promise<any>} body
   */
  async withVolume(body) {
    return this.withKey(VOLUME, body);
  }

  /** The queue itself, over either keyspace. `withInode` and `withVolume` are its only callers:
   *  a key invented at a call site would be a lock nobody else takes. */
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
    for (const name of SUPER_SLOTS) slots.push(await this.readWhole(name));
    const journal = await this.readWhole(JOURNAL_NAME);
    // THE DECISION: THE BLOB SWEEP DOES NOT RUN AT MOUNT, and `sweepBlobs` is a bench hook rather
    // than a mode anybody should turn on at boot.
    //
    // WHY. Constraint 33 measures directory enumeration WITH a size per name at 0.60 ms per name on
    // Safari, because the size is a `getFile()` per entry. A 10,000-file volume is therefore about
    // 6 s of sweep before the first process can run, on every boot, to find a condition that is
    // rare and that the mount cannot act on anyway: the sweep's findings are missing and short
    // blobs, which would mean mounting read-only, and a volume that mounts read-only 6 s late is
    // worse for its owner than one that mounts read-write immediately and is told later.
    //
    // WHAT PAYS FOR IT INSTEAD: `check()` below, the explicit fsck, which sweeps. That is what
    // constraint 33 already recommends, and it is the same code — `fsck()` with `blobs` supplied —
    // so there is no second implementation to drift.
    //
    // WHAT THIS COSTS, stated rather than hidden: a mount cannot report a blob the metadata names
    // and the directory does not have. `blobs: {swept: false, why}` says so in the report, and the
    // first read of that blob refuses with -EIO naming the missing name (src/kernel/iocore.mjs
    // `openOne`) rather than inventing an empty file. An idle-task sweep that closed the gap
    // without paying for it at boot is NOT built here.
    const blobs = this.cfg.sweepBlobs ? await this.blobListing() : null;

    const report = fsck({ slots, journal, blobs, checkCrc: !this.cfg.noCrc });
    this.report = jsonSafe({ ...report, vfs: undefined, lock });
    this.report.lock = lock;

    // THE STAGING FLOOR, and it comes from the blob DIRECTORY rather than from the generations
    // the metadata names. `vfs.blobNames()` lists COMMITTED generations only, so a crash between
    // a copy-up and its commit leaves a staged blob on disk the floor cannot see — and the next
    // write hands that generation number out again, opens the orphan, and publishes its bytes.
    // Measured with a leftover `blobs/22.2` holding 1000 bytes of 0xEE, which is exactly that
    // state: an ftruncate of an 8-byte file to 40 returned 0 zeroed bytes and 32 bytes of 0xEE
    // where POSIX requires zeroes, and the explicit fsck afterwards reported no problems.
    //
    // READ BEFORE THE VERDICT, because it is the same fact on every verdict: a volume fsck calls
    // FRESH because it has no superblock can still hold blobs, and inode numbering starts over
    // there, so that is the one case where the collision is certain rather than possible.
    //
    // NAMES ONLY, which is what keeps this affordable at boot: the per-name `getFile()` is what
    // makes the full sweep 0.60 ms per name (constraint 33), and the floor needs no sizes.
    //
    // A LISTING THAT REFUSED MOUNTS READ-ONLY AND SAYS SO. Converted to an empty list, a refused
    // enumeration is a floor of zero — which is the state this paragraph exists to prevent, built
    // by the error path rather than by a crash: every generation number is handed out again, and
    // the first write opens whatever orphan is wearing that name and publishes its bytes. There is
    // nothing a mount can do about it but refuse to write.
    const floor = await this.blobNameListing();
    if (typeof floor === "number") {
      this.report.problems.push({
        what: "blobs",
        why: `the blob directory could not be enumerated (errno ${-floor}), so the staging floor `
          + "is unknown. Mounting READ-ONLY: a write would hand out a generation number an "
          + "orphaned staged blob may already hold, and publish its bytes as the file's",
      });
      // A volume fsck already refuses stays refused: an unknown floor cannot make it worse, and
      // reporting it as read-only would promise reads of a tree that was never parsed.
      const verdict = report.mountable === MOUNT_REFUSE ? MOUNT_REFUSE : MOUNT_RO;
      this.report.mountable = verdict;
      this.mode = verdict;
      if (verdict === MOUNT_RO) {
        this.vfs = report.mountable === MOUNT_FRESH
          ? new VFS({ owner: { uid: 0, gid: 0 } }) : report.vfs;
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
      this.vfs = new VFS({ owner: { uid: 0, gid: 0 } });
      this.mode = MOUNT_FRESH;
      // The appender's invariant needs its base before the first record can be written. A fresh
      // volume starts at 0; the arm below resumes from what replay accepted.
      await this.io.request(IO_JOURNAL, { op: "resume", nextSeq: String(this.seq) });
      // The initial superblock. The ONE write a failed validation may ever lead to, and it is
      // legal because there was no volume: `fresh` means no slot, no journal and no blob.
      //
      // ITS ERRNO IS READ, which it was not: the result was discarded and `MOUNT_RW` assigned
      // unconditionally, so a volume whose first superblock would not land mounted READ-WRITE with
      // no slot naming it — and every op after that journalled against a base the next mount
      // cannot find. The seeding snapshot is also the one caller that can reach `snapshotHeld`'s
      // own read-only arm, so ignoring the answer would have let this line overwrite it.
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
    // The next record follows the last one replay ACCEPTED. A kernel that resumed from the
    // journal's byte length would write over a discarded tail and make it unrecoverable; a kernel
    // that resumed from zero would collide with records already in the file.
    this.seq = this.journalFirstSeq + BigInt(report.journal.records);
    // THE APPENDER'S BASE, so the writer-side invariant has something to compare the first record
    // against (src/kernel/iocore.mjs `journalOp`). It is the same number, handed to the only agent
    // that can see the order records land in.
    await this.io.request(IO_JOURNAL, { op: "resume", nextSeq: String(this.seq) });
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

  /**
   * The blob directory with a size per name: fsck's sweep input.
   *
   * A REFUSAL IS RETURNED AS `{errno}` AND NOT AS AN EMPTY ARRAY. The conversion to `[]` was a
   * refusal dressed as an answer: `fsck` tests the listing for truthiness, so an empty array reads
   * as "the directory was listed and holds nothing" — and an explicit fsck racing a free then
   * reported every committed blob the metadata names as ABSENT, which is the one verdict that
   * means "intact metadata pointing at data that was never written". The opposite reading is just
   * as wrong on a volume with no files: a listing that failed would report a clean sweep.
   *
   * @returns {{name: string, size: number}[]|{errno: number}}
   */
  async blobListing() {
    const r = await this.io.request(IO_LIST, { dir: BLOB_DIR });
    return typeof r === "number" ? { errno: -r } : r;
  }

  /**
   * One metadata file's whole contents, with ABSENT, UNREADABLE and PRESENT kept APART.
   *
   * THREE OUTCOMES BECAUSE THEY ARE THREE DIFFERENT VOLUMES, and collapsing two of them is the
   * defect this method exists for. `null` for both an errno and a genuinely missing slot made a
   * refused read indistinguishable from a volume that has never been written — so a volume whose
   * superblock slots could not be read, with its journal empty because the last snapshot truncated
   * it, reached fsck as "no bytes anywhere", came back MOUNT_FRESH, and the mount's fresh arm
   * RESEEDED it: a new superblock over live blobs, mounted read-write, with `problems` empty.
   * That is constraint 28's named defect and webxp's exact behaviour, reached through an error path
   * instead of a bad image.
   *
   * The distinction is not invented here. src/kernel/iocore.mjs `readAll` already answers
   * `{absent: true}` for `NotFoundError` ONLY and an errno for everything else; this carries it one
   * layer up rather than discarding it.
   *
   * @returns {Uint8Array|null|{errno: number}} the bytes, `null` when the file is not there, or
   *          `{errno}` when the read was REFUSED. The errno is positive, as in `blobListing`.
   */
  async readWhole(name) {
    const r = await this.io.request(IO_READ_ALL, { dir: "", name });
    if (typeof r === "number") return { errno: -r };
    if (r.absent || !r.bytes) return null;
    return new Uint8Array(r.bytes);
  }

  /** Every name in the blob directory, without a size per name. The staging floor's input; the
   *  sizes are what the explicit sweep pays for and the floor does not need them. A refusal is
   *  the ERRNO, for the same reason: an empty floor and an unknown floor are different volumes,
   *  and `mount` below refuses to write on the second. */
  async blobNameListing() {
    return this.io.request(IO_LIST, { dir: BLOB_DIR, namesOnly: true });
  }

  /** An explicit fsck over the live volume, blob sweep included. It NEVER writes: `fsck()` in
   *  src/fs/ holds no handle and no root, so there is no object there a reseed could go through,
   *  and this wrapper only reads. */
  async check() {
    const slots = [];
    for (const name of SUPER_SLOTS) slots.push(await this.readWhole(name));
    const journal = await this.readWhole(JOURNAL_NAME);
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
    return this.withVolume(() => this.journalHeld(op));
  }

  /** `journal`'s body, under the VOLUME's lock. The sequence it allocates and the snapshot's
   *  `journalFirstSeq` are one number, and a snapshot reading it between this allocation and the
   *  append would record a base the journal does not start at — see `VOLUME`. */
  async journalHeld(op) {
    const payload = encodeOp(op);
    // THE SEQUENCE IS ALLOCATED HERE, BEFORE ANY `await`, AND THAT ORDERING IS THE WHOLE POINT.
    //
    // `this.seq += 1n` used to run AFTER the append's await. Three callers in src/kernel/calls.mjs
    // reach this concurrently — a metadata op, an `open` that created a file, and a commit — so two
    // records took the same number. Replay stops at the first record whose seq is not its
    // predecessor's plus one and DISCARDS the tail, which is correct and worth keeping, so the
    // duplicate threw away every record after it: measured off the disk as 443 records with a
    // duplicated 59 at record 60, a volume that remounted READ-ONLY, and 37,409 bytes of tail
    // discarded including ops that had returned success to userland.
    //
    // The allocation and the encode are one synchronous step, and `io.request` posts to the I/O
    // worker synchronously after it, so records reach the single appender in allocation order.
    //
    // A FAILED APPEND BURNS ITS NUMBER rather than rolling it back. A rollback is not available —
    // a later caller may already hold seq+1 — and a burned number is the honest outcome: the record
    // did not land, so replay SHOULD stop where it is missing. A duplicate stops replay at a record
    // that did land, which is the difference between reporting a loss and causing one.
    const seq = this.seq;
    this.seq = seq + 1n;
    const record = encodeRecord(seq, payload);
    const n = await this.io.request(IO_JOURNAL, { op: "append", bytes: copyOut(record) });
    if (n < 0) {
      // THE BURN IS REPORTED TO THE APPENDER, which is the difference between losing one record
      // and losing the volume. The appender refuses any record whose sequence is not the one it
      // expects — correctly, because a duplicate stops replay at a record that DID land — and its
      // expectation only advances on a successful append. So a single failed append used to make
      // every later append refuse for the life of the mount: one transient error took the volume
      // read-only until the next boot, with every metadata op after it answering -EIO.
      //
      // `burn` moves the expectation past the number this call allocated and did not use. The
      // journal then has a GAP where this record should be, which is the honest state: replay
      // stops there and reports the discarded tail instead of applying records that were written
      // around a hole.
      this.stats.journalBurns += 1;
      // `burnedSeq` AND NOT `seq`: the transport owns `t` and `seq` on every message to the I/O
      // worker and the envelope overwrites the body, so a request naming its own `seq` arrives
      // carrying the correlation id instead. Measured here: the burn advanced the appender past
      // the io request counter and every later record was refused for being 23 behind.
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

  /**
   * `flushJournal`'s body, under the VOLUME's lock, and the one `writeSnapshot` calls — it holds
   * the lock already, and a second acquisition would wait on its own tail.
   *
   * THE FLAG IS CLEARED BEFORE THE AWAIT, which is the whole of the fix here. Read before and
   * cleared after, this lost the last record of a mount with no concurrency to blame: the idle
   * timer fires, nulls itself, sees `dirty`, and awaits the flush; a record appended inside that
   * await sets `dirty` and re-arms a timer; this method then returns and clears the flag the new
   * record had just set; and the re-armed timer finds `dirty` false and flushes nothing. The
   * record sits unflushed with nothing left to flush it.
   *
   * Cleared first, the append inside the window sets the flag AFTER it was claimed, so the record
   * is still owed a flush and the armed timer still owes it one. A FAILED flush puts the flag back
   * and re-arms: the records it did not flush are still dirty, and dropping the arm there would
   * make one transient error the last flush of the mount.
   */
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
    // THE WHOLE DESCRIPTION. Not `decision.gen` and not `decision.size`: both are durable state
    // another description can move, and recording them here is the defect this shape removes.
    const d = {
      ino: decision.ino, type: decision.type,
      pos: 0, dirtyGen: 0, stagingId: 0, baseMut: 0, baseEnd: 0, log: [],
    };
    if (decision.type !== "file") return d;
    // THE REFERENCE AND THE RESOLVE ARE ONE STEP, under the inode's lock. Taking the row and then
    // re-pointing it at the live generation is a read-then-mutate like any other: run outside the
    // lock, this open's `acquire` could land between another operation's resolve and its use of
    // the handle id that resolve returned.
    return this.withInode(d.ino, async () => {
      this.acquire(d.ino);
      // Resolved ONCE HERE so the 495 us handle open (constraint 22) is paid by `open`, which is
      // rare, rather than by the first read, which is not. The result is deliberately discarded:
      // every later caller asks again.
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

  /** Take a reference on an inode's handle row for a new description. */
  acquire(ino) {
    const row = this.held.get(ino);
    if (row) {
      row.users += 1;
      return row;
    }
    // `end` 0 and `gen` 0 is "this row has never been pointed at a generation". The first
    // `resolve` sets both, and `end` starts from the PUBLISHED SIZE — which is what makes a
    // crash's slack unreachable rather than resurrected.
    const fresh = { gen: 0, id: 0, users: 1, end: 0, mut: 0 };
    this.held.set(ino, fresh);
    return fresh;
  }

  /** Drop one description's reference. The last one releases the handle. */
  async release(ino) {
    const row = this.held.get(ino);
    if (!row) return 0;
    row.users -= 1;
    if (row.users > 0) return 0;
    this.held.delete(ino);
    // The close is what lets a free the unlink DEFERRED finally remove the directory entry
    // (src/kernel/iocore.mjs `close`): POSIX keeps an unlinked file's bytes until the last
    // descriptor goes, and this is the moment it goes.
    if (row.id) await this.closeBlob(row.id);
    return 0;
  }

  /**
   * THE CURRENT GENERATION OF AN INODE, ITS HANDLE AND ITS EXTENT, READ NOW.
   *
   * Every decision in the fd path begins here, and none of them may begin anywhere else. The
   * generation and the published size come out of the VFS at this instant; the pooled handle is
   * re-pointed if the VFS disagrees with it, before any caller can use it.
   *
   * `end` IS HOW FAR THE FILE'S BYTES REACH, and it lives on the per-inode row because an
   * uncommitted append is shared state: the bytes are in the generation the inode already points
   * at, so every description on the inode must see them and none of them may own the record. The
   * published size is a FLOOR on it, never a ceiling — another description's append commit raises
   * the published size against the generation this row already holds — and only a write through
   * this kernel raises it above that floor.
   *
   * IT IS NOT THE BLOB'S PHYSICAL LENGTH, which it used to be. See the file header: a crash leaves
   * the blob longer than the published size, nothing on disk tells those bytes from committed ones,
   * and reading the length back resurrected them.
   *
   * `mut` RIDES WITH THEM because it is read at the same instant and for the same reason: it is the
   * compare-and-swap's stamp (see `moved`), and a stamp read anywhere but here would be a second
   * route to a number this function exists to be the only route to.
   *
   * IT RUNS UNDER THE INODE'S LOCK AND MUST NEVER TAKE IT (`withInode`). Two of this function's
   * own steps are read-then-mutate sequences and both were measured as losses: the generation and
   * the published size are read BEFORE the 495 us `createSyncAccessHandle` below and returned
   * after it, so an unserialized caller got numbers from before an await and a handle from after
   * it; and the superseded handle is CLOSED here while another operation may still be holding that
   * id across its own await, which answered -EBADF on a perfectly good fd and turned a re-stage
   * into destroyed data. Neither is fixable inside this function — the fix is that the caller holds
   * the inode.
   *
   * @returns {{gen: number, size: number, id: number, end: number, mut: number}|number} -errno on
   *          refusal. `id` is 0 when the inode has no generation yet, or when no description holds
   *          it.
   */
  async resolve(ino) {
    if (!this.vfs) return -EIO;
    // UNLINKED, NOT CORRUPT. `committed()` throws EIO for both because the VFS does not know file
    // descriptions exist; only a caller holding one can tell them apart, and this is it.
    if (!this.vfs.holds(ino)) return -ESTALE;
    let committed;
    try {
      committed = this.vfs.committed(ino);
    } catch (error) {
      return errnoOfFsError(error);
    }
    const row = this.held.get(ino);
    if (!row) {
      // A LIVE DESCRIPTION WITH NO ROW IS A KERNEL DEFECT, named rather than tolerated. Every
      // caller here holds one, `openFd` takes the row before the first resolve, and only the LAST
      // description's close drops it. Answering from the VFS with no handle instead would make a
      // release that fired on the first close of two read as an empty file.
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
    // A GENERATION THIS ROW HAS NEVER HELD REACHES EXACTLY AS FAR AS THE METADATA SAYS. An append
    // can only be written through a row, and this row has not held this generation, so there is no
    // append of this kernel's outstanding in it.
    row.end = committed.size;
    // THE COUNTER IS NOT RESET HERE. Re-pointing the row is this kernel following a swing its own
    // `commitOnce` performed, and that commit already bumped the counter; a reset would hand a
    // description holding a base the number it recorded and tell it nothing had happened.
    if (previous) await this.closeBlob(previous);
    return { gen: row.gen, size: committed.size, id: row.id, end: row.end, mut: row.mut };
  }

  /**
   * A FILE'S SIZE FOR A CALLER WITH NO DESCRIPTION: `stat` and `lstat` by path.
   *
   * It exists because `stat` and `fstat` used to answer from different places and could disagree:
   * `fstat` reported a description's private number while `stat` over the same file reported the
   * metadata's, so one fd's successful 4-byte `pwrite` was visible through `fstat` and absent from
   * `stat`. Both now end at `resolve()`'s `end` — this for a path, `extentFd` for a description,
   * which additionally has a staged generation's log to replay onto it.
   *
   * Returns the info object itself when no I/O is needed — a directory, a symlink, or a file no
   * description holds — and a promise otherwise. calls.mjs's `settle` shape, so the fast path
   * still answers on the dispatch thread.
   *
   * @returns {object|Promise<object|number>}
   */
  sizeOf(info) {
    if (info.type !== "file") return info;
    const row = this.held.get(info.ino);
    if (!row || !row.id) return info;
    return this.withInode(info.ino, async () => {
      // THE ROW IS RE-CHECKED UNDER THE LOCK, because waiting for the lock is an await and the
      // last description on this inode may have closed while we waited. `resolve` refuses a
      // missing row with -EIO — correctly, since a live description without one is a kernel
      // defect — so a `stat` that reached it after the last close would report an I/O error over
      // a healthy file. With no description left the metadata is the whole truth: a close
      // publishes the extent, so there is no uncommitted append for a row to be remembering.
      if (!this.held.has(info.ino)) return info;
      const at = await this.resolve(info.ino);
      if (typeof at === "number") return at;
      info.size = at.end;
      return info;
    });
  }

  /**
   * THE STAGED GENERATION'S MODIFICATION LOG, in order, and the reason a refused commit can RETRY
   * instead of losing somebody's bytes.
   *
   * A staged generation is a copy of a base with this description's own changes on top, and the two
   * are indistinguishable once copied. So "re-apply my own bytes onto the new base" has no
   * definition without a record of WHICH bytes are this description's — and that record is this
   * log. It is the modifications, in the order they were made, never the bytes: the bytes are in
   * the staged blob, which is where `restage` copies them from.
   *
   * CONTIGUOUS AND OVERLAPPING WRITES COALESCE, which is what bounds the memory: a sequential
   * writer is ONE entry however many calls it makes. Two ranges with a GAP must not merge — the
   * gap's bytes belong to the base, and replaying a merged range would copy the OLD base's bytes
   * over the new one's. A scattered writer therefore pays one entry per disjoint range, which is
   * memory proportional to its own un-fsynced work and is released by the commit.
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

  /**
   * WHERE THIS DESCRIPTION'S STAGED GENERATION ENDS, if its log is replayed onto a base of `from`
   * bytes. Pure arithmetic over the log; it reads no blob.
   *
   * THE ARITHMETIC UNDER A DIRTY DESCRIPTION'S SIZE, and the only place it is done. Every answer a
   * reader gets comes through `extentFd`, which calls this with the LIVE base; the size a commit
   * publishes comes through `commitOnce`, which calls it with the base the copy was taken from and
   * is allowed to because the compare-and-swap has just proved the two are the same state. The
   * field they used to come from could disagree: it was fixed at copy-up time plus this
   * description's writes, so after another description committed a larger size the writer
   * under-reported the file and `SEEK_END` landed below the real end — which turns the next append
   * into an overwrite of committed bytes.
   */
  stagedEnd(d, from) {
    let end = from;
    for (const m of d.log) end = m.k === "t" ? m.size : Math.max(end, m.at + m.len);
    return end;
  }

  /**
   * Stage a new generation for a description about to modify committed bytes, copying the SOURCE
   * GENERATION into it. `limit` caps the copy; `undefined` means the whole of it.
   *
   * THE LENGTH IS THE SOURCE'S EXTENT — `from.end`, the per-inode row's — and NOT the blob's
   * physical length, which is what it used to be. The physical length includes a crashed kernel's
   * uncommitted slack, and copying that would launder bytes nobody published into a generation the
   * metadata names. Asked for the COPYING DESCRIPTION'S own idea of the length instead, the copy
   * dropped another description's appended bytes outright; `from.end` is the inode's number, shared
   * by every description on it, which is what makes it the right one.
   *
   * A SHORT COPY IS AN ERROR AND NOT A COUNT. `iocore.copy()` returns what it managed, and a copy
   * of 0 of 8 bytes used to be accepted — the commit then published a generation claiming 8 bytes
   * over a 2-byte blob with `fsync` returning 0. Constraint 9's rule cuts the other way here than
   * for `write`: `write` may short-count because the caller loops, and an internal copy has no
   * caller to loop.
   *
   * The copy runs handle to handle inside the I/O worker, so the bytes never cross an agent
   * boundary, and it runs once per DIRTY EPOCH rather than once per write — which is what keeps a
   * sequential overwrite linear.
   *
   * @returns {{gen: number, id: number, size: number}|number} `size` is the staged generation's
   *          length, which is what the copy actually put there.
   */
  async copyUp(d, from, limit) {
    const gen = this.nextGen(d.ino, from.gen);
    // `create: true`: this is the one caller that means a generation that does not exist yet.
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
      // A SOURCE SHORTER THAN THE EXTENT IT PUBLISHES IS NOT REFUSED HERE, deliberately. `want` is
      // `min(limit, source)`, so a blob shorter than the metadata's extent copies short and the
      // refusal arrives at the COMMIT, where `commitOnce` compares the size it is about to publish
      // against the staged blob's own length. Refused here instead, the first write to a volume
      // whose data a crash lost would be -EIO — and the volume's bytes were already gone, so the
      // refusal would be reporting the previous failure rather than preventing one. Measured:
      // `check.py --negative no-cow-order` is exactly that state, and refusing here made its
      // copy-up, swing and refcount clauses fail alongside the data clauses, which hid the split
      // the control exists to show.
      if (r.copied !== r.want) {
        this.note(`copy-up of inode ${d.ino} to generation ${gen} copied ${r.copied} of `
          + `${r.want} byte(s) out of a ${r.source}-byte blob`);
        await this.discard(d.ino, gen, staged.id);
        return -EIO;
      }
      copied = r.copied;
      // Counted only when bytes actually moved. A file with no generation yet stages its first one
      // through this same path — one branch for "new file" and "overwrite" rather than two — and
      // calling that a copy-up would make the counter report something its name does not mean.
      this.stats.copyUps += 1;
    }
    return { gen, id: staged.id, size: copied };
  }

  /**
   * Release a STAGED generation nothing is going to publish: its handle, and its blob.
   *
   * A staged blob nobody frees stays on disk forever — a grow another description's swing
   * superseded left a 72-byte `22.2` behind permanently, with `close()` returning 0. `highestGen`
   * is monotonic and is deliberately NOT rolled back, so the name is never handed out again
   * either: the freed entry may still be removable only when its last reader closes.
   */
  async discard(ino, gen, id) {
    if (id) await this.closeBlob(id);
    if (gen) {
      const r = await this.io.request(IO_FREE, { ino, gen });
      if (r && r.deferred) this.stats.deferredFrees += 1;
      else this.stats.immediateFrees += 1;
    }
    this.stats.discardedStagings += 1;
  }

  /**
   * Forget this description's staged generation, freeing it. The commit that would have published
   * it was refused, so nothing will.
   *
   * THE ONE STORE METHOD AN OUTSIDE CALLER MAY RUN WITHOUT THE INODE'S LOCK, and it is safe
   * because it reads no durable state. Every field it clears is the description's own, the
   * generation it frees is one only this description can name — `highestGen` is monotonic and is
   * never rolled back, so the number is not handed out again — and it moves no published size, no
   * generation and no handle row. `calls.mjs`'s failed `open(O_TRUNC)` is that caller; the other
   * callers are `commit` and `closeFd`, both of which hold the lock already.
   */
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
   * RE-STAGE: copy up from the base the compare-and-swap found, and replay this description's own
   * modifications onto it. The second half of the CAS — the half that makes a failed validation
   * cost a copy rather than somebody's bytes.
   *
   * THE BYTES COME OUT OF THE SUPERSEDED STAGED GENERATION, which is the only place this
   * description's own writes exist, and they are copied RANGE BY RANGE in the order they were made.
   * Replaying the log is not an optimisation over copying the whole staged blob: copying the whole
   * of it is exactly the revert being fixed, because it would carry the OLD base's bytes over the
   * new base's everywhere this description did not write.
   *
   * The old staged generation is discarded only once the new one is complete, so a failure here
   * leaves the description on the generation it already had and the caller's `dropStaging` frees
   * exactly one blob.
   *
   * UNDER THE INODE'S LOCK, held by the caller (`commit`, or `extentFd` re-basing for a reader).
   * A re-stage reads the live base and then copies into a new generation against it, so it is the
   * longest read-then-mutate in this file; unserialized, the base it copied from had already
   * moved by the time the copy finished.
   *
   * @returns {0|number} 0, or -errno.
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
   * THE COMMIT, WITH ITS RETRY. `commitOnce` does the work and may answer REBASE; this is the loop
   * that answers it, and the only entry point anybody else may call.
   *
   * RE-STAGE AND RETRY IS THE CHOSEN BEHAVIOUR ON A FAILED VALIDATION, and it is chosen because it
   * is the only one that keeps both writers' bytes: `write` and `fsync` both returned success to
   * both of them, so POSIX has both ranges in the file and an errno to either one would be a loss
   * the caller cannot undo. The refusal is the fallback, not the policy — and it arrives only after
   * COMMIT_ATTEMPTS, under -EBUSY, named in a note.
   *
   * -EBUSY KEEPS THE STAGED GENERATION, which is the difference between a retryable refusal and a
   * discard dressed as one. The exhaustion arm used to free the stage and clear the log, so the
   * caller's retry — the correct response to EBUSY — found `dirtyGen` 0, took `commitOnce`'s
   * "nothing to publish" arm and answered 0: a caller doing the right thing was told the data it
   * had just been refused was durable. Measured at 13 of 200 fsyncs (6.5%) in an ordinary
   * two-writer workload, every retry answering 0 over bytes that were gone. Kept, the retry
   * re-stages against the live base and publishes; nothing but `close` and `dropStaging` ever
   * discards a stage, and `closeFd` returns the errno if its own commit still cannot land.
   *
   * UNDER THE INODE'S LOCK, held by `fsyncFd` or `closeFd`. The loop's whole body — read the base,
   * validate against it, publish, stamp — is one read-modify-write, and the stamp landing three
   * awaits after the generation moved is exactly the window the lock closes. This must NOT take
   * the lock itself: both callers already hold it.
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
      // An APPEND commit has nothing staged: its op is computed from the live state, so recomputing
      // it IS the retry. Only a staged generation has to be rebuilt.
      if (!d.dirtyGen) continue;
      const re = await this.restage(d);
      if (re < 0) {
        await this.dropStaging(d);
        return re;
      }
    }
  }

  /**
   * ONE COMMIT ATTEMPT. blob -> flush -> validate -> journal -> flush. Then the swing.
   *
   * Answers 0 (nothing to publish), 1 (published), -errno, or REBASE — the compare-and-swap
   * refused and `commit` above must re-stage. Nobody else may call this.
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
   *
   * WHY VALIDATION MOVED AHEAD OF THE JOURNAL, because constraint 60 documents the old sequence
   * and this reads like a weakening of it. It is not. What constraint 60 buys is that no record
   * can point at data that is not durable, and that is unchanged: the blob is still written and
   * still FLUSHED before anything references it. What moved is the VFS's refusal, from after the
   * record was durable to before it was written — and a refusal that arrives after the record is
   * on disk poisons the volume. Measured: two fds, no crash, no privilege. fd2's commit named a
   * generation fd1 had superseded, `applyOp` threw EIO with the record already flushed, and the
   * NEXT mount came up READ-ONLY at "record 51 (commit) could not be applied", discarding the
   * three records after it — including a `mkdir` that had already returned success to userland.
   * Every metadata op already decides first (`calls.mjs` metaOp) and `vfs.applyOp` is built to be
   * the decision; this makes the data path agree with them.
   *
   * The residue of the new order is a swing applied in memory whose record did not append. That
   * is the exposure metaOp has carried all along, it loses a swing rather than a volume, and the
   * blob it named is on disk either way.
   */
  async commitOnce(d) {
    const staging = d.dirtyGen > 0;
    // THE BASE IS READ NOW, and `prevGen` with it: a commit that named the generation this
    // description happened to be looking at last published a size over another description's
    // fsynced bytes and lost them.
    const at = await this.resolve(d.ino);
    if (typeof at === "number") {
      if (staging) await this.dropStaging(d);
      return at;
    }
    // THE BASE THIS OP IS VALID AGAINST, named here because the validation below is the whole of
    // the compare-and-swap. For a staged generation it is the base the COPY was taken from, which
    // is not the state read a line ago — that is exactly the gap. For an append it is the state
    // read a line ago, because the op is computed from it.
    const base = staging ? { mut: d.baseMut } : { mut: at.mut };
    // THE SIZE THIS COMMIT PUBLISHES. With a staged generation it is the log replayed onto the base
    // — the same renderer `fstat` and `SEEK_END` use. WITHOUT one, the only thing to publish is the
    // file's current extent, which is where an outstanding append lives.
    const op = {
      k: "commit", ino: d.ino,
      gen: staging ? d.dirtyGen : at.gen,
      size: staging ? this.stagedEnd(d, d.baseEnd) : at.end,
      prevGen: at.gen, t: Date.now(),
    };
    if (!staging && op.size === at.size) {
      // NOTHING TO PUBLISH: no staged generation, and the blob reaches no further than the
      // metadata already says. Answering 0 here is not a shortcut — a commit record that changes
      // nothing is still a record replay must apply and fsck must account for.
      return 0;
    }
    const blobId = staging ? d.stagingId : at.id;
    // THE EARLY-OUT IS THE SAME PREDICATE, asked before paying constraint 23's 260 us flush for a
    // generation already known to be stale. It is not a second validation: the one below is the
    // one that is load-bearing, and removing this one costs a flush, never correctness.
    if (staging && moved(base, at)) return REBASE;

    if (staging) {
      // THE SIZE A COMMIT PUBLISHES MUST BE THE STAGED BLOB'S OWN LENGTH, asserted against the
      // blob rather than trusted. `op.size` is arithmetic over the modification log and the blob is
      // what a reader will actually find; if the two disagree the metadata would name bytes that
      // are not there, which is the one failure copy-on-write exists to prevent. Priced against the
      // 260 us flush on the next line.
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

    // 3a. THE COMPARE-AND-SWAP'S VALIDATION STEP, and it is not redundant with `applyOp`'s
    // generation check below.
    //
    // WHAT THIS ASSERTS: that the base this op was computed against is STILL the inode's current
    // state — the generation the copy-up copied from, and how far that generation's bytes reached
    // when it did. A staged generation is a speculative whole-file copy, and a speculative copy is
    // only valid if nothing moved underneath it.
    //
    // WHAT `applyOp` ASSERTS (`op.gen < inode.gen`): that a generation never moves BACKWARDS.
    // Monotonicity, not currency. It passes happily when the inode is on generation 1, this op
    // names generation 2, and another description published four fsynced bytes into generation 1
    // between the copy-up and here — measured, and the result was those four bytes reverted with
    // `pwrite`, `fsync` and `close` all returning 0 and fsck reporting the volume clean. THE TWO
    // CHECKS ARE DIFFERENT ASSERTIONS AND NEITHER COVERS THE OTHER. Do not delete this one.
    //
    // AND IT IS A SWAP, not a check followed by a swap: `resolve` is the last `await` before
    // `applyOp`, which is synchronous, so no other operation can interleave between the compare
    // and the publish. Putting an `await` between these two lines breaks the primitive.
    const now = await this.resolve(d.ino);
    if (typeof now === "number") {
      if (staging) await this.dropStaging(d);
      return now;
    }
    if (moved(base, now)) return REBASE;

    // 3b. VALIDATE, by applying in memory. The apply IS the validation — `vfs.applyOp` refuses an
    // op that cannot be applied to this state rather than guessing — so the journal below only
    // ever receives a record the VFS accepted.
    //
    // THE STATE THIS APPLY MOVES IS TAKEN FIRST, because the apply is also a PUBLISH and the
    // record that makes it durable is two awaits away. An append that refuses leaves the tree
    // holding a generation and a size no record names, and this is what puts them back.
    let before;
    try {
      before = this.vfs.commitState(op.ino);
      this.vfs.applyOp(op);
    } catch (error) {
      // THE STAGED BLOB GOES WITH THE REFUSAL, and the refusal is NAMED. Nothing will ever
      // publish this generation now, and a staged blob nobody frees is on disk for the life of
      // the volume. The errno goes back to the caller — including to `close()`, which must not
      // report success for a commit that was refused.
      this.stats.refusedCommits += 1;
      this.note(`commit of inode ${d.ino} generation ${op.gen} over ${at.gen} was refused: `
        + `${(error && error.message) || error}`);
      const errno = errnoOfFsError(error);
      if (staging) await this.dropStaging(d);
      return errno;
    }

    // 4. the journal record, 5. its flush.
    //
    // AN APPEND THAT REFUSED TAKES THE APPLY WITH IT. The record is not in the file and its
    // sequence is burned (see `journal`), so nothing will ever name this generation: left applied,
    // the kernel publishes a size `write` and `fsync` were both told had failed, the next mount
    // replays a journal with no record of it, and the in-memory tree, the journal and the volume
    // are three different answers. The staged generation is KEPT, for the same reason -EBUSY keeps
    // it: a caller retrying is the correct response and the retry can still publish.
    const appended = await this.journal(op);
    if (appended < 0) {
      // THE UNDO ITSELF CAN REFUSE, and the one way it does is that the inode WENT while the
      // append was in flight: `unlink` takes no inode lock, because a metadata op changes no
      // generation and no published size. There is then no publish left to undo — the inode and
      // everything it published left the tree together — so this is reported and not raised. An
      // exception here would turn a named I/O failure into a bare -EIO out of `later`.
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
    // THE FLUSH IS DIFFERENT FROM THE APPEND AND IS NOT UNDONE. `append` wrote the record into the
    // journal file; only its durability past this agent is in question, which is precisely what
    // POSIX lets `fsync` report and a caller retry. Reverting here would leave a record on disk
    // that the running kernel's tree denies — the same disagreement pointing the other way — so
    // the swing below COMPLETES and the errno is returned after it.
    //
    // RETURNING EARLY IS THE THIRD OPTION AND IT IS THE WORST, by inspection rather than by
    // measurement: it leaves the inode published while the handle row still points at the
    // superseded blob and the description still holds the new generation as its PRIVATE stage, so
    // that description's next write goes in place into bytes the metadata has already published.
    const jflush = await this.flushJournal();
    this.stats.swings += 1;

    // The control's second half: the metadata now names bytes that are not there.
    if (this.cfg.noCowOrder && op.size > 0) {
      await this.io.request(IO_TRUNCATE, { id: blobId, size: 0 });
      this.stats.discardedByControl += 1;
    }

    // THE SWING ITSELF, and the order of these two steps is constraint 47's interaction with
    // copy-on-write. The INODE'S pooled reference on the superseded generation is released FIRST,
    // so the free below sees a true reference count: if nothing is reading it the blob goes now,
    // and if something is the removal defers to that reader's close. The refcount table
    // arbitrates; the directory only records the outcome.
    //
    // The staged handle is TRANSFERRED into the row rather than closed and re-opened. Dropping it
    // to zero references and opening the same name again would pay constraint 22's 495 us for a
    // handle the kernel is holding anyway.
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
      // THE ROW'S EXTENT IS WHAT WAS JUST PUBLISHED, on both arms. A staged generation's extent is
      // its own length; an append commit published the row's end and the row must not keep a higher
      // number than the metadata. Leaving it stale here would let the next copy-up carry bytes
      // nobody published.
      row.gen = op.gen;
      row.end = op.size;
      // AND THE STAMP MOVES WITH THEM. This is the other half of `moved`: a publish is the only
      // thing that changes an inode's generation or its published size, so every description
      // holding a base taken before this line must lose its compare-and-swap.
      //
      // IT LANDS THREE AWAITS AFTER THE GENERATION ACTUALLY MOVED — `applyOp` above, then the
      // journal append and its 260 us flush — and that window was a loss until the inode lock
      // closed it. For the width of the flush the VFS said generation N+1 and the stamp still
      // said what N said, so a concurrent commit's CAS passed over a base that had moved and
      // published a size computed from it, reverting an append another description had fsynced.
      // Measured as `applyOp` refusing "commit moves generation 534 back to 533" on the arm that
      // is loud, which is the same stale stamp on the arm that is silent. The window is still
      // here; it is now unreachable, because nothing else on this inode can run between those
      // awaits. Do not rely on moving this line instead.
      row.mut += 1;
    }
    if (op.prevGen && op.prevGen !== op.gen) {
      const r = await this.io.request(IO_FREE, { ino: op.ino, gen: op.prevGen });
      if (r && r.deferred) this.stats.deferredFrees += 1;
      else this.stats.immediateFrees += 1;
    }
    // THE FLUSH'S ERRNO, AFTER THE SWING. The record is in the file and the state it names is now
    // consistent everywhere — tree, handle row and description — and the caller is still told its
    // `fsync` did not make it durable. A refusal here is NAMED, because the one caller that cannot
    // read a return value is a process's teardown.
    if (jflush < 0) {
      this.note(`commit of inode ${op.ino} generation ${op.gen} was applied and journalled, but `
        + `the journal's flush refused (errno ${-jflush}); the record is written and not yet `
        + "durable");
      return jflush;
    }
    // ONE, meaning "a generation was published". The count is the action's own report, which is
    // what `fsyncFd` needs instead of the `dirty(d)` predicate it used to ask first — a predicate
    // beside the action is a second place to get the same question wrong.
    return 1;
  }

  /**
   * Free every generation of an inode whose last link went.
   *
   * THE COUNTERS ARE READ HERE TOO, which they were not. A generation whose directory entry
   * survives because a description still holds it is the DEFERRED case, and this is now the only
   * place it is reachable: a reader follows a swing, so a swing's superseded generation has no
   * reader left by the time it is freed. Counting only the swing's frees left the deferred arm
   * reported as zero while it was in fact being taken — a counter blind to the one event it
   * exists to report.
   */
  async freeInode(ino) {
    // UNDER THE INODE'S LOCK, like every other read-then-mutate: this reads the staging floor and
    // then frees every name under it, and a write landing in the middle would stage a generation
    // this loop has already passed — a blob with no owner and no entry in `highestGen` to say it
    // exists. The lock also makes "the last link went" and "a description is still writing"
    // sequential rather than simultaneous, which is what makes the deferred arm below honest.
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
   *
   * UNDER THE VOLUME'S LOCK, and that is what makes the order above worth anything: the image
   * names the sequence the journal must start at, and an append landing between the serialize and
   * the truncate is destroyed by the truncate at exactly the sequence replay expects to find it —
   * so replay reads a short journal rather than a gap and reports nothing. See `VOLUME`.
   */
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
    // The journal is reset only once the slot that supersedes it is on disk and flushed.
    const t = await this.io.request(IO_JOURNAL, { op: "truncate" });
    if (t < 0) {
      // THE PAIR FAILS BY UNDOING THE APPLY, which is the same shape `commitOnce` uses: the
      // durable half is already done, and the half that would have made the kernel agree with it
      // refused.
      //
      // WHY THE SLOT CANNOT JUST BE LEFT. It is flushed, it carries generation+1, and it says the
      // journal starts at `this.seq`. The journal was NOT truncated, so it still holds records from
      // the old base. The next mount picks the highest valid generation — this slot — and replays a
      // journal that starts before the image's base: the records already folded into the image are
      // replayed again, `applyOp` refuses one, and the volume mounts REFUSE. A snapshot that
      // returned an errno would have bricked the next boot.
      //
      // THE UNDO IS A ZERO-LENGTH WRITE to the slot this call wrote, which makes it a slot with no
      // bytes to decode — the state fsck reads as absent, and the state this slot was going to be
      // in anyway: it held generation-2, and that copy was destroyed by the write above and is not
      // recoverable. So the volume goes back to being the one it was, newest-valid-slot and journal
      // agreeing, one fewer spare copy.
      const undo = await this.io.request(IO_WRITE_ALL, {
        name: SUPER_SLOTS[slot], bytes: copyOut(new Uint8Array(0)),
      });
      if (undo < 0) {
        // BOTH HALVES REFUSED, so the disk is ahead of this kernel and nothing here can bring it
        // back. Read-only is the only honest answer: another write would append to a journal the
        // next mount will read against the wrong base, and the note is the whole of the report
        // because `writeSnapshot`'s callers include the idle timer, which has nobody to return to.
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
    return this.withInode(d.ino, () => this.writeHeld(d, pid, srcOff, length, at));
  }

  /** `writeFd`'s body, under the inode's lock. The COW decision reads the live state and the
   *  write then lands against it; between the two sat a copy-up, a 495 us handle open and a blob
   *  write, and every one of those awaits was a point where the decision's inputs could change. */
  async writeHeld(d, pid, srcOff, length, at) {
    const positional = at !== undefined;
    let from;
    if (!positional && (d.flags & O_APPEND)) {
      // O_APPEND IS AN OFFSET PER WRITE, NOT A SEEK AT OPEN, and that is POSIX's own wording: the
      // offset is set to the end of the file atomically BEFORE EACH WRITE. Read once at open it
      // loses bytes with no concurrency to blame — two `>>` descriptions on one file each get the
      // same end, each writes there, and the second's bytes land on top of the first's with
      // `write` returning the full count and `fsync` returning 0 to both. Measured on an 8-byte
      // file: two fds, one 4-byte write and one fsync each, eight bytes acknowledged, the file 12
      // bytes long with the first writer's four gone, and fsck reporting the volume clean.
      //
      // ATOMIC BECAUSE THE INODE IS HELD. `extentFd` reads the end and the write lands against it
      // with no await in between that another operation on this inode can enter, which is the
      // difference between implementing O_APPEND and narrowing its window. It is `extentFd` and
      // not `resolve` because a description with a staged generation appends at the END OF ITS
      // STAGE — the log replayed onto the live base — and that is the same number `fstat` and
      // `SEEK_END` answer.
      const reach = await this.extentFd(d);
      if (typeof reach === "number") return reach;
      from = reach.end;
      // The cursor follows, so a later `SEEK_CUR` or plain `write` on the same description reads
      // where the last append actually went.
      d.pos = from;
    } else {
      // pwrite HONOURS ITS OFFSET EVEN UNDER O_APPEND, which is POSIX and is NOT what Linux does
      // (Linux appends and ignores the offset). The portable program cannot rely on either, and
      // between the two the specified behaviour is the one a caller can reason about: `pwrite`
      // exists to write WHERE IT SAYS.
      from = positional ? at : d.pos;
    }
    let target = d.stagingId;
    if (!d.dirtyGen) {
      // THE DECISION'S INPUTS, READ NOW. The committed size, the current generation and how far the
      // file's bytes reach, none of them remembered from a previous call.
      const live = await this.resolve(d.ino);
      if (typeof live === "number") return live;
      // THE COW DECISION, and the only place it is made. Below the committed size is a copy-up; at
      // or beyond it is an append into the current generation, because the committed `size` does
      // not name those bytes and a torn append cannot damage committed data. A file with no blob
      // at all takes the same path, which keeps "new file" and "overwrite" one branch and not two.
      if (from < live.size || live.gen === 0) {
        // THE WHOLE SOURCE GENERATION comes across, not `live.size`: an uncommitted append above
        // the committed size is in the generation being copied out of, and it has already returned
        // success to somebody. THE BASE IS RECORDED WITH IT, because the commit's compare-and-swap
        // is what makes this copy safe and it has nothing to compare without these two numbers.
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
    // THE ACTUAL COUNT, never the requested length: `write` may short-count, and a log entry that
    // claimed bytes the write did not land would have `restage` copy bytes nobody wrote.
    if (d.dirtyGen) {
      this.stageMark(d, { k: "w", at: from, len: n });
    } else {
      // An append into the current generation. Its extent is the INODE'S, on the per-inode row, so
      // every description on the inode sees it and none of them owns it.
      //
      // THE COUNTER IS BUMPED WHETHER OR NOT THE EXTENT MOVED, and that is the whole of C2: a write
      // at or above the published size but BELOW the row's `end` — the slack an earlier append
      // opened — changes bytes in the generation every description reads and moves no derived
      // number. Bumped only alongside the `row.end` raise, the stamp could not see it and a staged
      // commit reverted it (see `moved`).
      const row = this.held.get(d.ino);
      if (row) {
        if (from + n > row.end) row.end = from + n;
        row.mut += 1;
      }
    }
    return n;
  }

  /**
   * WHERE THIS DESCRIPTION'S FILE ENDS AND WHICH BLOB ITS BYTES ARE IN, read at one time.
   *
   * THE ONE RENDERER FOR `read`, `fstat` AND `SEEK_END` ALIKE, which is the point of it. The three
   * answered from different bases: `read` clamped to `stagedEnd(d, d.baseEnd)` — the base the copy
   * came FROM — while `fstat` and `SEEK_END` used `stagedEnd(d, live.end)`, read now. They differ
   * exactly when another description commits, so one description's `fstat` reported 12 while its
   * own `read` stopped at 8, with no error on either call. That is the same shape as the defect the
   * file header lists as fixed at seven addresses, at an eighth: a size and the bytes behind it
   * coming from two places.
   *
   * THE BASE IS THE LIVE EXTENT, not the recorded one. `d.baseEnd` is what the staged copy was
   * taken from and `commitOnce` still publishes against it under the compare-and-swap's protection,
   * but nothing a READER is told may come from it: a reader asks where the file ends now.
   *
   * A STALE STAGE IS RE-BASED BEFORE THE PAIR IS ANSWERED, and that is the one place a reader
   * mutates. The two halves come from different states otherwise: the number is the log replayed
   * onto the LIVE base and the blob is a copy of the base this description copied FROM, so once
   * another description publishes a longer file the number names bytes the staged blob does not
   * have. Measured as a `read` short-counting with no error while `fstat` on the same fd reported
   * the larger figure — the same "a size and the bytes behind it coming from two places" defect
   * this function was written to end, at a ninth address.
   *
   * Neither of the cheap answers is available. Reporting the staged base instead under-reports the
   * file, so `SEEK_END` lands below the real end and the next append overwrites committed bytes;
   * clamping the read to the staged blob while `fstat` keeps the live number IS the disagreement.
   * So the staged generation is brought onto the live base — the same `restage` a refused commit
   * runs — and then the number and the blob are one state again. It costs one copy per OBSERVED
   * publish, not one per read: `restage` records the new base, so the next reader finds nothing to
   * do.
   *
   * UNDER THE INODE'S LOCK, held by `readFd`, `statFd` or `endFd`, and it must not take it: the
   * re-base reads the live base and writes a generation against it.
   *
   * @returns {{end: number, id: number}|number} -errno on refusal. `id` is 0 for a file with no
   *          generation yet, which a reader must answer as an empty file rather than an error.
   */
  async extentFd(d) {
    let live = await this.resolve(d.ino);
    if (typeof live === "number") return live;
    // A READ-ONLY MOUNT CANNOT RE-BASE, and it does not have to: `writeFd` and `truncateFd` refuse
    // there, so a staged generation can only predate the mount's mode, which this kernel never
    // changes after `mount()`. Named rather than assumed, because a re-base writes a blob.
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

  /**
   * The read half, with the same offset rule.
   *
   * NO CLAMP AGAINST A REMEMBERED SIZE, which is what made one fd report `fstat` 40 and `pread` 8
   * at the same time with no error on either. The clamp is THE FILE'S EXTENT, read now and through
   * `extentFd`, which is the same call `fstat` and `SEEK_END` go through — so the three cannot
   * disagree about where the file ends.
   *
   * THE CLAMP IS NOT OPTIONAL, which is what asking the blob directly got wrong. A sync access
   * handle returns whatever is physically at that offset, and after a crash that includes bytes
   * above the published size which nobody committed — so an unclamped `pread` past the end handed
   * a reader 32 bytes of a previous kernel's uncommitted slack and reported them as file content.
   */
  async readFd(d, pid, dstOff, length, at) {
    return this.withInode(d.ino, () => this.readHeld(d, pid, dstOff, length, at));
  }

  /**
   * `readFd`'s body, under the inode's lock. A read is not a pure read here and it needs the lock
   * for two reasons the attacks found separately: the extent and the blob id must come from one
   * state (`extentFd`), and the id must still be OPEN when the read issues — `resolve` closes a
   * superseded handle, and an id held across this await while another operation re-pointed the row
   * answered -EBADF on a valid fd.
   */
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

  /**
   * fsync: the blob's flush and the metadata swing, in that order. Constraint 23's whole point —
   * a separate call, so the 260 us is paid when a caller asks for durability and not per write.
   *
   * `commit` decides for itself whether there is anything to publish, by reading the volume. There
   * is no `dirty(d)` predicate here any more, and that is deliberate: the predicate was a
   * per-description flag standing in for a shared fact, and every path that forgot to consult it
   * correctly lost bytes.
   */
  async fsyncFd(d) {
    if (this.readOnly) return -EROFS;
    return this.withInode(d.ino, () => this.fsyncHeld(d));
  }

  /** `fsyncFd`'s body, under the inode's lock: the commit and the flush that follows it are one
   *  sequence, and the flush's blob id is read from the state the commit left. */
  async fsyncHeld(d) {
    const published = await this.commit(d);
    if (published < 0) return published;
    // A commit already flushed the generation it published, and flushing it twice would be a
    // second 260 us per `fsync` (constraint 23) for no durability. A caller that published
    // NOTHING still gets its flush: the blob may hold bytes from a write whose commit landed on
    // another description.
    if (published > 0) return 0;
    const live = await this.resolve(d.ino);
    if (typeof live === "number") return live;
    if (!live.id) return 0;
    const r = await this.io.request(IO_FSYNC, { id: live.id });
    return r < 0 ? r : 0;
  }

  /**
   * ftruncate. A copy-up to the new length, then the handle truncated to it.
   *
   * `limit` is `size` and the copy's actual length is `min(size, the source blob)`, computed in
   * the I/O worker. Counted against a remembered size instead, a truncate kept
   * `min(size, STALE size)` and returned 32 fsynced bytes as 32 zeroes inside a newly committed
   * generation whose blob length matched its published size — so fsck reported the volume clean,
   * which is the worst class of defect this project can produce.
   */
  async truncateFd(d, size) {
    if (this.readOnly) return -EROFS;
    return this.withInode(d.ino, () => this.truncateHeld(d, size));
  }

  /** `truncateFd`'s body, under the inode's lock. It reads the live extent, decides against it,
   *  copies up and then truncates the copy — the same read-then-mutate as a write. */
  async truncateHeld(d, size) {
    if (!d.dirtyGen) {
      const live = await this.resolve(d.ino);
      if (typeof live === "number") return live;
      // A truncate to exactly the file's current extent changes nothing. Staging a generation and
      // swinging onto it for that is a copy and a journal record bought for no change, and
      // `open(O_TRUNC)` of an already-empty file — the `> file` idiom — is the common case.
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

  /**
   * What `fstat` reports for one description.
   *
   * It reads the blob, which is why it is here rather than inline in calls.mjs: a description
   * holding a STAGED generation publishes that generation's length, because a caller that just
   * wrote and then fstat'ed its own fd must not be told its bytes are not there — and a
   * description holding none publishes the file's current EXTENT, which includes an append any
   * description on the inode has written and not yet committed. Those bytes are in the file;
   * `pwrite` returned their count.
   */
  async statFd(d) {
    return this.withInode(d.ino, () => this.statHeld(d));
  }

  /** `statFd`'s body, under the inode's lock: the number it reports comes through `extentFd`,
   *  which pairs an extent with the blob it is an extent OF and may re-base to make them agree. */
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
    // THROUGH `extentFd`, which is also what `read` clamps to and what `SEEK_END` lands on. A
    // staged generation's length takes precedence — a caller that just wrote and then fstat'ed its
    // own fd must not be told its bytes are not there — and it is the log replayed onto the CURRENT
    // base, never onto the base the copy was taken from: those differ exactly when another
    // description has published bytes since, and answering from the old base under-reported the
    // file, so `SEEK_END` landed on top of committed bytes.
    const reach = await this.extentFd(d);
    if (typeof reach === "number") return reach;
    info.size = reach.end;
    return info;
  }

  /** Where `SEEK_END` lands: the same extent `fstat` reports and `read` clamps to, by the same
   *  route and read at the same point. */
  async endFd(d) {
    return this.withInode(d.ino, async () => {
      const reach = await this.extentFd(d);
      return typeof reach === "number" ? reach : reach.end;
    });
  }

  /**
   * Close a description.
   *
   * A STAGED GENERATION IS COMMITTED FIRST and the commit's errno is RETURNED. `close()` returning
   * 0 after a refused commit is the worst defect this file has carried: the ordinary path — write,
   * then exit without `fsync` — lost acknowledged bytes with success reported, and fsck came back
   * clean afterwards because the blob length matched the published size. POSIX allows `close` to
   * report a deferred write error and this is one; the fd's resources are released either way,
   * which POSIX also requires. The refusal is additionally NOTED, because the one caller that
   * cannot read a return value is a process's own teardown.
   *
   * -ESTALE IS THE ONE REFUSAL CLOSE SWALLOWS. The inode is gone, so there is nothing to publish
   * and nothing the caller could have saved — the caller's own `unlink` discarded it. Every other
   * operation on that description refuses under the same name; `close` releases and succeeds,
   * which is what every caller's cleanup path needs it to do.
   */
  async closeFd(d) {
    if (d.type !== "file") return 0;
    return this.withInode(d.ino, () => this.closeHeld(d));
  }

  /** `closeFd`'s body, under the inode's lock: the commit, the discard of whatever it could not
   *  publish, and the release of the row are one sequence, and the row's reference must not drop
   *  while another operation on this inode is resting on it. */
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
