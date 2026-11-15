// THE STORAGE EDGE'S ONE IMPLEMENTATION. Every OPFS sync access handle this kernel holds lives in
// here, and both I/O surfaces are this object: `src/kernel/io-worker.mjs` runs it in a dedicated
// worker (the headline path) and `src/kernel/io-inline.mjs` runs it on the dispatch thread (M0b's
// negative control). The two therefore differ in ONE property — which agent the synchronous
// `write`/`flush` happen on — and in nothing else.
//
// WHY THE TWO ARE NOT TWO COPIES. They were, and the refcount and deferred-free logic was
// hand-synced across them: constraint 47's arbitration appeared twice, so a mutation of it had to
// be applied twice to be caught twice, and the control and the thing it controls could disagree
// about what a reference count means. One definition, two hosts.
//
// WHY THE WORKER EXISTS AT ALL, measured: with the handles on the dispatch thread, one process
// calling `fsync` in a loop took every other process's p99 from 275 us to 850 at N=16, and to
// 2,657 us at N=64 — past M0's own 2 ms kill bar. `FileSystemSyncAccessHandle.write` and `.flush`
// are SYNCHRONOUS, so every microsecond of constraint 23's 260 us flush was kernel thread no other
// process could use. docs/CONSTRAINTS.md 58 and 59 carry the tables.
//
// CONSTRAINT 15 is satisfied because this is kernel-side either way: a releasable resource may not
// live in a PROCESS worker, and no process ever receives a handle, a port to here, or a reference
// to one.
//
// THE PER-NAME REFCOUNT LIVES HERE, beneath the fd table, because this is where the handles are
// and an exclusive lock must be arbitrated where the thing it locks is held. A sync access handle
// is an exclusive lock per file: a second `createSyncAccessHandle` on one file throws
// NoModificationAllowedError, so `cat notes.txt | wc -l` would fail while an editor held the file.
// The table makes a second open of one NAME a refcount rather than a second handle.
//
// CONSTRAINT 47'S DESCRIPTION COUNT IS NOT HERE, and it cannot be: it counts file descriptions,
// and this module has never heard of one. A description holds no handle — it holds an inode
// number and an offset — so "is anybody still resting on this inode's current generation" is a
// question only src/kernel/store.mjs can answer, and its `held` map answers it with one reference
// per inode taken here. What this refcount still arbitrates is the thing it names: whether a
// NAME has a holder, which is what defers a removal (`pendingFree`) when a generation is freed
// while the Store is still reading it. Measured consequence of the split: `reusedOpens` stays 0
// across two SEQUENTIAL opens of one file, because the second description finds the Store's row
// already pointing at the generation it wants and makes no request here at all. Two OVERLAPPING
// opens do reach here — the row is not pointing anywhere yet when the second one looks — and that
// is the case `opening` below arbitrates.
//
// IT IS ALSO WHAT ARBITRATES THE COPY-ON-WRITE SWING. During a commit two blobs briefly exist for
// one logical file. The DIRECTORY cannot decide which is live, because a reader holding the old
// generation must keep reading it until it closes while a new opener must get the new one. So the
// old generation's directory entry is removed by the close that drops its last reference, not by
// the commit: `free` either removes it now or records it in `pendingFree`.

import {
  IO_OPEN, IO_WRITE, IO_FSYNC, IO_CLOSE, IO_READ, IO_BLOB_OPEN, IO_TRUNCATE, IO_FREE,
  IO_LIST, IO_READ_ALL, IO_WRITE_ALL, IO_LOCK, IO_JOURNAL, IO_COPY, IO_SIZE, IO_STATS,
  BLOB_DIR, JOURNAL_NAME, IO_TRACE_KEEP,
  EIO, EBADF, EINVAL, EBUSY, EACCES,
} from "../abi.mjs";
import { blobName } from "../fs/vfs.mjs";
import { decodeRecord } from "../fs/journal.mjs";

/**
 * 1 MiB per copy pass. Large enough that a megabyte file is one read and one write; small enough
 * that the allocation is not the measurement.
 */
const COPY_CHUNK = 1 << 20;

function errnoOf(e) {
  const name = String((e && e.name) || e);
  if (name === "NotFoundError") return -EINVAL;
  // The exclusive lock, refused. It reaches here only when the refcount table was bypassed, which
  // is a kernel defect — so it must not be reported as a generic I/O error.
  if (name === "NoModificationAllowedError") return -EBUSY;
  if (name === "NotAllowedError" || name === "SecurityError") return -EACCES;
  if (name === "QuotaExceededError") return -EIO;
  return -EIO;
}

/**
 * @param {object} host
 * @param {(why: string) => void} host.note  How this host reports a failure nobody is awaiting.
 *        A worker posts `io-note`; the inline surface hands it to the kernel. Passed in because it
 *        is the only thing the two hosts do differently, and a swallowed failure is a defect.
 */
export function makeIoCore({ note }) {
  let root = null;
  let blobs = null;

  /** Open handles by the id the dispatch kernel knows them by. */
  const handles = new Map();
  let nextId = 1;

  /**
   * name -> entry. The exclusive-lock arbitration (constraint 47): one handle per name, however
   * many openers. `refs` is the number of file descriptions resting on it.
   */
  const byName = new Map();

  /**
   * ino -> Set of live blob names. The COW swing reads this: at a commit the kernel frees the
   * previous generation, and this is how "is anybody still reading it" is answered.
   */
  const byIno = new Map();

  /** Names whose directory entry is to be removed once their last reader closes. */
  const pendingFree = new Set();

  /**
   * key -> the promise of an open that has not finished yet. CONSTRAINT 47'S OTHER HALF, and
   * without it the refcount table arbitrates nothing for two opens that OVERLAP.
   *
   * `byName` only records a handle that exists, and `createSyncAccessHandle` is awaited: two opens
   * of one name issued before the first finished both missed the table, both called
   * `createSyncAccessHandle`, and the second threw NoModificationAllowedError — which `errnoOf`
   * below correctly calls a kernel defect. Measured with two processes opening one file in the same
   * dispatch turn: `open` returned -EBUSY and the process died, while the sequential case this
   * table was tested with passed. The second caller now AWAITS the first and takes a reference on
   * what it produced.
   */
  const opening = new Map();

  /** The journal's handle. Taking it IS the boot lock (constraint 48), because a second kernel in
   *  a second tab cannot hold it at the same time — and because the file whose handle is the mutex
   *  should be the file whose consistency the mutex protects. */
  let journal = null;
  let journalAt = 0;
  /**
   * THE SEQUENCE THE NEXT RECORD MUST CARRY, and the writer-side half of replay's gap rule.
   *
   * `src/fs/journal.mjs`'s replay stops at the first record that is not its predecessor's plus one
   * and discards the tail, so a journal whose sequences are not strictly consecutive is a corrupt
   * journal — and it was being written by a kernel that allocated the number across an `await`
   * (src/kernel/store.mjs `journal`). That failed at the NEXT MOUNT, 443 records and 37 KB of
   * discarded tail later, instead of at the append that broke it.
   *
   * It lives here because this is the single appender: the invariant is about the ORDER bytes reach
   * the file in, and nowhere else can see that. `null` means no base has been set and an append is
   * refused — a resume that did not happen must not read as an invariant that holds.
   */
  let journalSeq = null;

  /**
   * The bytes a write sends come from the CALLING PROCESS'S OWN SAB, read here while that process
   * is parked in Atomics.wait. That is what makes this zero-copy rather than a copy per write: the
   * process cannot touch the buffer until the dispatch kernel bumps its SEQ, and the dispatch
   * kernel does not do that until this surface has answered.
   */
  const views = new Map();

  let copyBuffer = null;

  /**
   * THE DIRECTORY-HANDLE BUDGET, counted rather than asserted (constraint 24).
   *
   * `getDirectoryHandle` is 85 us per component, so a path that costs one per component is 340 us
   * for a four-component walk — 23 syscalls. The property this kernel holds is stronger than
   * "few": ONE per directory for the life of the module, taken at boot, because path resolution
   * runs over the in-memory inode tree and a blob is named `<ino>.<gen>` in one flat directory.
   * Structurally sound is not the same as checked, and a regression here would be silent.
   */
  const counts = { getDirectoryHandle: 0, getFileHandle: 0, opens: 0, reusedOpens: 0 };

  /**
   * The two directory handles, WRAPPED so the count is a property of the capability rather than of
   * a call site.
   *
   * A counter incremented beside each call would count the calls somebody remembered to count:
   * code that reached for `root.getDirectoryHandle` directly would resolve a directory per open
   * and the number would not move. There are exactly two directory references in this module and
   * both are wrapped, so any resolution through either of them is counted, and a nested directory
   * comes back wrapped too.
   */
  function counted(handle) {
    return new Proxy(handle, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        return (...args) => {
          if (prop === "getDirectoryHandle") {
            counts.getDirectoryHandle += 1;
            return Promise.resolve(value.apply(target, args)).then(counted);
          }
          if (prop === "getFileHandle") counts.getFileHandle += 1;
          return value.apply(target, args);
        };
      },
    });
  }

  /**
   * THE OPERATION TRACE, which is how the write ordering is MEASURED rather than read.
   *
   * Constraint 23's ordering — blob, flush, journal, flush — cannot be observed from inside one
   * session by its effects: an unflushed FileSystemSyncAccessHandle write is still visible to a
   * later read in the same agent, because `flush()` buys durability past a process death and not
   * visibility. So the sequence itself is the measurement. Every storage operation this surface
   * performs appends one entry, and a commit's entries must read `write… flush journal-append
   * journal-flush` in that order.
   *
   * A ring of the last IO_TRACE_KEEP entries with a monotonic counter, so "precedes" is a
   * comparison of sequence numbers and a 10,000-file run does not accumulate 60,000 rows. `n`
   * survives the ring; `dropped` says how many rows are gone.
   *
   * IT IS NOT GATED ON A BENCH BOOT, unlike the negative controls, because it changes no
   * behaviour — one small object per storage operation, inside the agent that is already waiting
   * on a 495 us open or a 260 us flush. Priced rather than assumed: `scripts/check.py --only m2`
   * over 10,000 files reads 61.8 s with it armed against 63.4 s without, which is inside the
   * run-to-run spread.
   */
  const trace = [];
  let traceN = 0;
  let dropped = 0;

  function mark(op, name) {
    traceN += 1;
    trace.push({ n: traceN, op, name: name === undefined ? "" : String(name) });
    if (trace.length > IO_TRACE_KEEP) {
      trace.shift();
      dropped += 1;
    }
  }

  const dirOf = (which) => (which === BLOB_DIR ? blobs : root);

  /**
   * One handle per name, refcounted. The id is what the dispatch kernel holds.
   *
   * `create` IS NOT A DEFAULT, and that is the fix for a whole class of silence. Opened with
   * `{ create: true }`, a generation the metadata NAMES but which is not on disk came back as a
   * fresh empty file: the read that followed returned 0 bytes with no error, so `cat` printed
   * nothing and exited 0 over a file whose `stat` said 8 bytes. A caller that means "the
   * generation I already committed" passes `create: false` and absence is -EIO with the name of
   * the missing blob — corruption, reported, rather than an empty file invented to satisfy a read.
   * Only a caller STAGING a brand-new generation may create.
   */
  async function openNamed(dir, name, ino, gen, create) {
    const key = `${dir}/${name}`;
    // THE WAIT AND THE RE-CHECK ARE ONE LOOP, because waiting on an open that FAILED must leave
    // this caller doing its own open rather than returning the failure: the first caller may have
    // asked for `create: false` on a name this one is staging.
    for (;;) {
      const existing = byName.get(key);
      if (existing) {
        existing.refs += 1;
        counts.reusedOpens += 1;
        mark("open-reused", key);
        return { id: existing.id, refs: existing.refs, size: existing.handle.getSize(),
          reused: true };
      }
      const pending = opening.get(key);
      if (!pending) break;
      await pending.catch(() => {});
    }
    const task = openOne(dir, name, ino, gen, create);
    opening.set(key, task);
    try {
      return await task;
    } finally {
      opening.delete(key);
    }
  }

  /** The open itself. Reached by exactly one caller per name at a time, which is what `opening`
   *  above is for. */
  async function openOne(dir, name, ino, gen, create) {
    const key = `${dir}/${name}`;
    const where = dirOf(dir);
    if (!where) return -EIO;
    let fh;
    try {
      fh = await where.getFileHandle(name, { create: create === true });
    } catch (e) {
      if (String(e && e.name) === "NotFoundError") {
        note(`${dir}/${name} is named by the metadata and is not in the blob directory`);
        return -EIO;
      }
      throw e;
    }
    const handle = await fh.createSyncAccessHandle();
    const id = nextId++;
    const entry = { id, handle, dir, name, key, ino, gen, refs: 1, writes: 0, flushes: 0 };
    handles.set(id, entry);
    byName.set(key, entry);
    if (ino !== undefined && ino !== null) {
      if (!byIno.has(ino)) byIno.set(ino, new Set());
      byIno.get(ino).add(name);
    }
    counts.opens += 1;
    mark("open", key);
    return { id, refs: 1, size: handle.getSize(), reused: false };
  }

  function write(m) {
    const h = handles.get(m.id);
    if (!h) return -EBADF;
    const view = views.get(m.pid);
    if (!view) return -EBADF;
    // Synchronous, and that is the point: in the worker it is synchronous on a thread whose only
    // job is waiting for storage, instead of on the thread every other process needs. The file
    // offset is the CALLER'S, never a cursor on the handle: two file descriptions can share one
    // handle (constraint 47), and a shared cursor would make one reader's seek the other's.
    const n = h.handle.write(view.subarray(m.srcOff, m.srcOff + m.length), { at: m.at });
    h.writes += 1;
    mark("write", h.name);
    return n;
  }

  function read(m) {
    const h = handles.get(m.id);
    if (!h) return -EBADF;
    const view = views.get(m.pid);
    if (!view) return -EBADF;
    // Zero-copy in the other direction: straight into the parked process's own SAB.
    return h.handle.read(view.subarray(m.dstOff, m.dstOff + m.length), { at: m.at });
  }

  /**
   * Handle to handle, inside this agent. The copy-up a copy-on-write overwrite needs: the bytes
   * never cross an agent boundary and no process is parked behind it, which is why the buffer here
   * is private rather than a view on somebody's SAB.
   *
   * THE LENGTH COMES FROM THE SOURCE BLOB, and it is computed HERE because this is the only agent
   * that can read it. A caller asking for `limit` is capping the copy, never describing the
   * source: the caller that asked for `heldEnd(its own description)` dropped another
   * description's appended bytes, because the shared blob was physically longer than the
   * description doing the copying had ever seen. `limit === undefined` means the whole source.
   *
   * `want` travels back beside `copied` so the caller can tell a SHORT copy from a complete one
   * without having to know the source's length. Constraint 9's rule cuts the other way here than
   * it does for `write`: `write` may short-count because the caller loops, and an internal copy
   * has no caller to loop.
   *
   * A RANGE, with `at` and `length`, is the same copy at an offset, and it is what a re-staged
   * commit replays one modification with. Both ends use the same offset: the destination is a copy
   * of a base, so a range of the file is at the same place in both.
   */
  function copy(m) {
    const from = handles.get(m.from);
    const to = handles.get(m.to);
    if (!from || !to) return -EBADF;
    const source = from.handle.getSize();
    const at = m.at === undefined ? 0 : m.at;
    const want = m.length !== undefined
      ? m.length
      : (m.limit === undefined ? source : Math.min(m.limit, source));
    if (!copyBuffer) copyBuffer = new Uint8Array(COPY_CHUNK);
    let done = 0;
    while (done < want) {
      const chunk = Math.min(COPY_CHUNK, want - done);
      const got = from.handle.read(copyBuffer.subarray(0, chunk), { at: at + done });
      if (got <= 0) break;
      const put = to.handle.write(copyBuffer.subarray(0, got), { at: at + done });
      if (put <= 0) break;
      done += put;
    }
    mark("copy", `${from.name}->${to.name}`);
    return { source, want, copied: done };
  }

  /** One blob's physical length. The only place "how far do this generation's bytes reach" can be
   *  answered, and an uncommitted append is exactly the bytes that live above the published size
   *  with nothing in the metadata naming them. */
  function size(m) {
    const h = handles.get(m.id);
    if (!h) return -EBADF;
    return h.handle.getSize();
  }

  function fsync(m) {
    const h = handles.get(m.id);
    if (!h) return -EBADF;
    h.handle.flush();
    h.flushes += 1;
    mark("flush", h.name);
    return 0;
  }

  function truncate(m) {
    const h = handles.get(m.id);
    if (!h) return -EBADF;
    h.handle.truncate(m.size);
    mark("truncate", h.name);
    return 0;
  }

  /** Fire-and-forget: a directory removal nobody is waiting on. A failure is recorded as a note
   *  rather than swallowed — a blob that would not delete is a leak, not a corruption. */
  function remove(dir, name) {
    const where = dirOf(dir);
    if (!where) return;
    mark("remove", `${dir}/${name}`);
    where.removeEntry(name).catch((e) => {
      note(`could not remove ${dir}/${name}: ${e && e.name}`);
    });
  }

  /**
   * Drop one reference. The last one closes the handle AND, if the commit that superseded this
   * generation asked for it, removes the directory entry.
   *
   * This is the swing's other half. `free` below cannot remove a blob somebody is still reading, so
   * it leaves the removal here — which means the refcount table arbitrates, and the directory only
   * ever records the outcome.
   */
  function close(m) {
    const h = handles.get(m.id);
    if (!h) return -EBADF;
    if (--h.refs > 0) return h.refs;
    handles.delete(m.id);
    byName.delete(h.key);
    try { h.handle.close(); } catch (e) { /* a closed handle is the desired end state */ }
    mark("close", h.key);
    if (pendingFree.has(h.key)) {
      pendingFree.delete(h.key);
      remove(h.dir, h.name);
    }
    const set = byIno.get(h.ino);
    if (set) {
      set.delete(h.name);
      if (!set.size) byIno.delete(h.ino);
    }
    return 0;
  }

  /**
   * Free a superseded blob generation after a commit.
   *
   * @returns {{freed: boolean, deferred: boolean, refs: number}} — `deferred` is the constraint-47
   *          case: somebody is still reading the generation the swing replaced, so the directory
   *          entry survives until their close. Reported rather than inferred, because "the old blob
   *          is gone" and "the old blob is gone once the reader lets go" are different states and
   *          the proof has to be able to tell them apart.
   */
  function free(m) {
    const key = `${BLOB_DIR}/${blobName(m.ino, m.gen)}`;
    const entry = byName.get(key);
    if (entry && entry.refs > 0) {
      pendingFree.add(key);
      mark("free-deferred", key);
      return { freed: false, deferred: true, refs: entry.refs };
    }
    remove(BLOB_DIR, blobName(m.ino, m.gen));
    return { freed: true, deferred: false, refs: 0 };
  }

  /**
   * A directory's file entries.
   *
   * `namesOnly` skips the per-name `getFile()`, and that call is the cost: constraint 33 prices
   * directory enumeration at 0.60 ms per name on Safari because of it. A caller that only needs
   * to know WHICH names exist — the kernel's staging floor at boot — must not pay for sizes it
   * will not read, and a caller that reconciles sizes against the metadata must.
   */
  async function list(m) {
    const where = dirOf(m.dir || "");
    if (!where) return -EIO;
    const out = [];
    for await (const [name, handle] of where.entries()) {
      if (handle.kind !== "file") continue;
      if (m.namesOnly) {
        out.push({ name });
        continue;
      }
      const file = await handle.getFile();
      out.push({ name, size: file.size });
    }
    return out;
  }

  /**
   * The whole of one metadata file. Used at boot for the superblock slots and the journal, which is
   * the one place a full read is the right shape: fsck is a parser over the whole image.
   *
   * The journal is read THROUGH ITS OWN HANDLE when we hold it, because the handle is the boot lock
   * and a second handle on the same file would be refused by the same exclusive lock.
   */
  async function readAll(m) {
    if (m.name === JOURNAL_NAME && journal) {
      const size = journal.getSize();
      const bytes = new Uint8Array(size);
      if (size) journal.read(bytes, { at: 0 });
      return { bytes: bytes.buffer, size };
    }
    const where = dirOf(m.dir || "");
    if (!where) return -EIO;
    try {
      const fh = await where.getFileHandle(m.name, { create: false });
      const file = await fh.getFile();
      const buf = await file.arrayBuffer();
      return { bytes: buf, size: buf.byteLength };
    } catch (e) {
      // ABSENT IS NOT CORRUPT, and keeping them apart is the whole of constraint 28: a volume with
      // no superblock slots is a first boot, one whose slots do not decode is damaged, and a reader
      // that conflated them would reseed over a damaged volume.
      if (String(e && e.name) === "NotFoundError") return { bytes: null, size: -1, absent: true };
      return errnoOf(e);
    }
  }

  /** Replace one metadata file's whole contents. Not a hot path: three superblock slots and a
   *  journal truncation are the only callers, and both are deliberate durability points. */
  async function writeAll(m) {
    if (!root) return -EIO;
    const fh = await root.getFileHandle(m.name, { create: true });
    const handle = await fh.createSyncAccessHandle();
    try {
      const bytes = new Uint8Array(m.bytes);
      handle.truncate(0);
      handle.write(bytes, { at: 0 });
      // Flushed unconditionally: every caller of this is a durability point by construction
      // (a superblock commit, or the journal reset that follows one), so a deferred flush here
      // would be a snapshot that is not on disk.
      handle.flush();
      mark("write-all", m.name);
    } finally {
      handle.close();
    }
    return 0;
  }

  /**
   * THE BOOT LOCK (constraint 48). Taking the journal's sync handle as the mutex is correct — the
   * handle IS an exclusive lock, and it is a lock on the file whose consistency it protects — but a
   * plain reload RACES THE PREVIOUS KERNEL'S HANDLE: a terminated worker's handle is released when
   * the agent actually goes away, and constraint 55 measured that at about 2.0 s (2004-2051 ms over
   * five runs). Taking the lock once and giving up would therefore bring a normal reboot up
   * read-only at random, which is the exact defect this constraint exists to name.
   *
   * So: retry with exponential backoff for longer than that grace. The budget and the first interval
   * are in src/abi.mjs; the loop is here because it is I/O.
   */
  async function lock(m) {
    if (!root) return { ok: false, why: "no OPFS root", waitedMs: 0, attempts: 0 };
    const t0 = Date.now();
    let waitMs = m.firstMs;
    let attempts = 0;
    let lastWhy = "";
    for (;;) {
      attempts += 1;
      try {
        const fh = await root.getFileHandle(JOURNAL_NAME, { create: true });
        journal = await fh.createSyncAccessHandle();
        journalAt = journal.getSize();
        mark("lock", JOURNAL_NAME);
        return { ok: true, why: "", waitedMs: Date.now() - t0, attempts, size: journalAt };
      } catch (e) {
        lastWhy = String((e && e.name) || e);
        if (lastWhy !== "NoModificationAllowedError") {
          return { ok: false, why: lastWhy, waitedMs: Date.now() - t0, attempts };
        }
        if (Date.now() - t0 + waitMs > m.budgetMs) break;
        await new Promise((r) => setTimeout(r, waitMs));
        waitMs = Math.min(waitMs * 2, 400);
      }
    }
    return {
      ok: false,
      why: `the journal's handle was held for the whole ${m.budgetMs} ms budget (${lastWhy}). `
        + "Another tab holds this filesystem; mounting read-only",
      waitedMs: Date.now() - t0,
      attempts,
    };
  }

  /**
   * The journal, through the handle the boot lock holds.
   *
   * `append` does NOT flush. Constraint 23: `flush()` is 260 us against a 5 us write, so flushing
   * per record makes the filesystem 50x slower for durability nobody asked for. The flush points are
   * fsync, snapshot and idle, and they come through `flush` below.
   */
  function journalOp(m) {
    if (!journal) return -EACCES;
    switch (m.op) {
      case "append": {
        const bytes = new Uint8Array(m.bytes);
        // THE INVARIANT, CHECKED BEFORE THE BYTES LAND: exactly one more than the last record
        // appended. The CRC is NOT re-checked — the record was encoded by this kernel moments ago
        // and the replay path checks it — so this costs a header read, not a second pass over the
        // payload.
        const r = decodeRecord(bytes, 0, { checkCrc: false });
        if (!r.ok) {
          note(`a journal record this kernel encoded does not decode: ${r.why}`);
          return -EIO;
        }
        if (journalSeq === null) {
          note(`journal record ${r.seq} was appended before the expected sequence was set`);
          return -EIO;
        }
        if (r.seq !== journalSeq) {
          note(`journal record ${r.seq} was appended where ${journalSeq} was expected: a `
            + "sequence that is not strictly consecutive makes replay discard the tail");
          return -EIO;
        }
        const n = journal.write(bytes, { at: journalAt });
        journalAt += n;
        journalSeq = r.seq + 1n;
        mark("journal-append", journalAt);
        return n;
      }
      /**
       * A SEQUENCE NUMBER THE KERNEL ALLOCATED AND COULD NOT USE, declared so the invariant above
       * can stay strict without wedging the appender.
       *
       * The expectation only advances on a successful append, which is right — a record that did
       * not land must leave a gap replay can see — but it made the FIRST failed append refuse
       * every record after it for the life of the mount. One transient error, and every later
       * metadata op answers -EIO over a volume that is otherwise healthy: the journal is
       * effectively read-only until reboot, which is a far larger loss than the record that failed.
       *
       * `src/kernel/store.mjs`'s `journal` is the only caller, and it calls this exactly when its
       * own append answered an errno — so the number really is burned rather than merely late.
       * IDEMPOTENT and never backwards: the cascade case burns several numbers out of order, and a
       * burn of a number the appender is already past must not rewind it onto a record that landed.
       */
      case "burn": {
        // `burnedSeq`, because `seq` belongs to the transport: the dispatch kernel's envelope
        // overwrites a body field of that name with its own correlation id (`makeIo` in
        // src/kernel/kernel.mjs). `resume` carries `nextSeq` for the same reason.
        if (journalSeq === null) {
          note(`journal sequence ${m.burnedSeq} was burned before the expected sequence was set`);
          return -EIO;
        }
        const seq = BigInt(m.burnedSeq);
        if (seq + 1n > journalSeq) {
          journalSeq = seq + 1n;
          mark("journal-burn", String(seq));
        }
        return 0;
      }
      // A SNAPSHOT DOES NOT RESET THE SEQUENCE. `writeSnapshot` records the current `seq` as the
      // image's `journalFirstSeq` and keeps counting, so the record after a truncation is the one
      // this already expects.
      case "resume": {
        journalSeq = BigInt(m.nextSeq);
        return 0;
      }
      case "flush":
        journal.flush();
        mark("journal-flush", journalAt);
        return 0;
      case "truncate":
        journal.truncate(0);
        journal.flush();
        journalAt = 0;
        mark("journal-truncate", 0);
        return 0;
      case "size":
        return journalAt;
      default:
        return -EINVAL;
    }
  }

  return {
    /**
     * The OPFS root, and the one `getDirectoryHandle` of the whole module's life.
     *
     * The blob directory is FLAT and its names are `<ino>.<gen>` (constraint 26). It is a
     * subdirectory of the root so the metadata files are not in the blob namespace and a sweep can
     * enumerate blobs without filtering names it must not touch.
     */
    async start(opfsRoot) {
      root = opfsRoot ? counted(opfsRoot) : null;
      if (!root) return false;
      blobs = await root.getDirectoryHandle(BLOB_DIR, { create: true });
      mark("boot", BLOB_DIR);
      return blobs !== null;
    },
    register(pid, sab) { views.set(pid, new Uint8Array(sab)); },
    unregister(pid) { views.delete(pid); },

    /**
     * One request. Every error path returns an errno rather than throwing: a caller is parked on
     * the answer, and a rejected promise would be a syscall that never settles.
     */
    async request(t, m = {}) {
      try {
        switch (t) {
          case IO_OPEN: return await openNamed(m.dir || "", m.name, null, null, m.create !== false);
          case IO_BLOB_OPEN:
            return await openNamed(BLOB_DIR, blobName(m.ino, m.gen), m.ino, m.gen,
              m.create === true);
          case IO_WRITE: return write(m);
          case IO_READ: return read(m);
          case IO_FSYNC: return fsync(m);
          case IO_TRUNCATE: return truncate(m);
          case IO_COPY: return copy(m);
          case IO_SIZE: return size(m);
          case IO_CLOSE: return close(m);
          case IO_FREE: return free(m);
          case IO_LIST: return await list(m);
          case IO_READ_ALL: return await readAll(m);
          case IO_WRITE_ALL: return await writeAll(m);
          case IO_LOCK: return await lock(m);
          case IO_JOURNAL: return journalOp(m);
          case IO_STATS:
            // A measurement, not a hot path: the trace is copied so a reader cannot be handed the
            // live ring and watch it move underneath.
            return {
              counts: { ...counts },
              handles: handles.size, names: byName.size, pendingFree: pendingFree.size,
              trace: trace.map((e) => ({ ...e })), traced: traceN, dropped,
            };
          default:
            // Named AND answered. A caller parked on an unknown request must get an errno, and a
            // request kind nobody implemented is a kernel defect worth reporting under its name.
            note(`unknown io request ${t}`);
            return -EINVAL;
        }
      } catch (e) {
        // NAMED, never swallowed. The caller is parked on an answer, so the answer has to be an
        // errno — and the reason goes out of band through `note` rather than being dropped, which
        // is the difference between a reported I/O failure and a kernel that returned -EIO for
        // reasons nobody can recover.
        note(`${t} failed: ${(e && e.stack) || e}`);
        return errnoOf(e);
      }
    },
  };
}
