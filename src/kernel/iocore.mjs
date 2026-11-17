// THE STORAGE EDGE'S ONE IMPLEMENTATION. Every OPFS sync access handle this kernel holds lives in
// here, and both I/O surfaces are this object: `src/kernel/io-worker.mjs` runs it in a dedicated
// worker (the headline path) and `src/kernel/io-inline.mjs` on the dispatch thread (M0b's negative
// control). They differ in ONE property, which agent the synchronous `write`/`flush` happen on.
//
// WHY THE WORKER EXISTS, measured: with the handles on the dispatch thread, one process calling
// `fsync` in a loop took every other process's p99 from 275 us to 850 at N=16 and 2,657 us at
// N=64, past M0's 2 ms kill bar. docs/CONSTRAINTS.md 58 and 59 carry the tables. Constraint 15
// holds either way: no process receives a handle, a port to here, or a reference to one.
//
// THE PER-NAME REFCOUNT LIVES HERE, beneath the fd table, because a sync access handle is an
// exclusive lock per file and must be arbitrated where it is held: a second
// `createSyncAccessHandle` on one file throws NoModificationAllowedError, so `cat f | wc -l` would
// fail while an editor held `f`. A second open of one NAME is a reference (constraint 47).
//
// Constraint 47's DESCRIPTION count is not here and cannot be: this module has never heard of a
// file description, so only src/kernel/store.mjs can answer "is anybody still resting on this
// inode's current generation", from one reference per inode taken here.
//
// THIS IS ALSO WHAT ARBITRATES THE COPY-ON-WRITE SWING: during a commit two blobs briefly exist for
// one logical file, so the old generation's directory entry is removed by the close that drops its
// last reference, never by the commit.

import {
  IO_OPEN, IO_WRITE, IO_FSYNC, IO_CLOSE, IO_READ, IO_BLOB_OPEN, IO_TRUNCATE, IO_FREE,
  IO_LIST, IO_READ_ALL, IO_WRITE_ALL, IO_LOCK, IO_JOURNAL, IO_COPY, IO_SIZE, IO_STATS,
  BLOB_DIR, JOURNAL_NAME, IO_TRACE_KEEP,
  EIO, EBADF, EINVAL, EBUSY, EACCES,
} from "../abi.mjs";
import { blobName } from "../fs/vfs.mjs";
import { decodeRecord } from "../fs/journal.mjs";

/** 1 MiB per copy pass: a megabyte file is one read and one write, and the allocation is not the
 *  measurement. */
const COPY_CHUNK = 1 << 20;

function errnoOf(e) {
  const name = String((e && e.name) || e);
  if (name === "NotFoundError") return -EINVAL;
  // The exclusive lock, refused. Reached only when the refcount table was bypassed, which is a
  // kernel defect and not a generic I/O error.
  if (name === "NoModificationAllowedError") return -EBUSY;
  if (name === "NotAllowedError" || name === "SecurityError") return -EACCES;
  if (name === "QuotaExceededError") return -EIO;
  return -EIO;
}

/** `note` is how this host reports a failure nobody is awaiting. */
export function makeIoCore({ note }) {
  let root = null;
  let blobs = null;

  /** Open handles by the id the dispatch kernel knows them by. */
  const handles = new Map();
  let nextId = 1;

  /** name -> entry. The exclusive-lock arbitration (constraint 47): one handle per name, however
   *  many openers. `refs` is the number of file descriptions resting on it. */
  const byName = new Map();

  /** ino -> Set of live blob names, for the COW swing. */
  const byIno = new Map();

  /** Names whose directory entry is to be removed once their last reader closes. */
  const pendingFree = new Set();

  /**
   * key -> the promise of an open that has not finished. CONSTRAINT 47'S OTHER HALF: `byName` only
   * records a handle that EXISTS and `createSyncAccessHandle` is awaited, so two opens of one name
   * issued before the first finishes would both miss the table and the second would throw
   * NoModificationAllowedError. The second caller instead awaits the first and takes a reference.
   */
  const opening = new Map();

  /** Holding the journal's handle IS the boot lock (constraint 48): a second kernel in a second tab
   *  cannot hold it at the same time. */
  let journal = null;
  let journalAt = 0;
  /**
   * THE SEQUENCE THE NEXT RECORD MUST CARRY, and the writer-side half of replay's gap rule.
   * `src/fs/journal.mjs` stops replay at the first record that is not its predecessor's plus one
   * and discards the tail, so a kernel allocating the number across an `await` fails at the NEXT
   * MOUNT rather than at the append that broke it. Here because this is the single appender, and
   * the invariant is about the ORDER bytes reach the file in. `null` refuses an append: a resume
   * that did not happen must not read as an invariant that holds.
   */
  let journalSeq = null;

  /** The bytes a write sends come from the CALLING PROCESS'S OWN SAB, read while that process is
   *  parked in Atomics.wait. Zero-copy, and safe only because the dispatch kernel does not bump
   *  the process's SEQ until this surface has answered. */
  const views = new Map();

  let copyBuffer = null;

  /**
   * THE DIRECTORY-HANDLE BUDGET, counted rather than asserted (constraint 24).
   * `getDirectoryHandle` is 85 us per component — 340 us for a four-component walk, 23 syscalls.
   * The property held here is ONE per directory for the life of the module, taken at boot, and a
   * regression would be silent.
   */
  const counts = { getDirectoryHandle: 0, getFileHandle: 0, opens: 0, reusedOpens: 0 };

  /** WRAPPED so the count is a property of the capability and not of a call site. A nested
   *  directory comes back wrapped too. */
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
   * THE OPERATION TRACE: how constraint 23's write ordering — blob, flush, journal, flush — is
   * MEASURED. Its effects cannot be observed from inside one session, because an unflushed
   * FileSystemSyncAccessHandle write is still visible to a later read in the same agent; `flush()`
   * buys durability past a process death, not visibility. So the sequence itself is the
   * measurement, and a commit must read `write… flush journal-append journal-flush`.
   *
   * A ring of the last IO_TRACE_KEEP entries with a monotonic `n`, so "precedes" is a comparison
   * and a 10,000-file run does not accumulate 60,000 rows. Always armed, unlike the negative
   * controls, because it changes no behaviour: `scripts/check.py --only m2` over 10,000 files reads
   * 61.8 s with it against 63.4 s without, inside the run-to-run spread.
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
   * One handle per name, refcounted. `create` IS NOT A DEFAULT: under `{ create: true }` a
   * generation the metadata NAMES but which is not on disk comes back as a fresh empty file, so
   * `cat` prints nothing and exits 0 over a file whose `stat` says 8 bytes. A caller meaning "the
   * generation I already committed" passes `create: false` and gets -EIO naming the missing blob.
   */
  async function openNamed(dir, name, ino, gen, create) {
    const key = `${dir}/${name}`;
    // THE WAIT AND THE RE-CHECK ARE ONE LOOP: waiting on an open that FAILED must leave this
    // caller doing its own, because the first may have asked `create: false` on a name this one is
    // staging.
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

  /** Reached by exactly one caller per name at a time; see `opening`. */
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
    // The offset is the CALLER'S, never a cursor on the handle: two file descriptions can share
    // one handle (constraint 47), and a shared cursor makes one reader's seek the other's.
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
    // Zero-copy the other way: straight into the parked process's own SAB.
    return h.handle.read(view.subarray(m.dstOff, m.dstOff + m.length), { at: m.at });
  }

  /**
   * Handle to handle, inside this agent — the copy-up a copy-on-write overwrite needs. The buffer
   * is private because no process is parked behind this and the bytes cross no agent boundary.
   *
   * THE LENGTH COMES FROM THE SOURCE BLOB, computed here because this is the only agent that can
   * read it. `limit` CAPS the copy and never describes the source: a caller passing `heldEnd(its
   * own description)` drops another description's appended bytes, the shared blob being physically
   * longer than that description has seen. `undefined` means the whole source, and `want` travels
   * back beside `copied` so a short copy is distinguishable from a complete one.
   *
   * `at` and `length` are the same copy at an offset, the same offset at both ends: the
   * destination is a copy of a base, so a range sits in the same place in both.
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

  /** One blob's PHYSICAL length, which is above the published size when an append has not been
   *  committed. The only place that question can be answered. */
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

  /** Fire-and-forget. A blob that would not delete is a leak, not a corruption, so the failure is
   *  a note rather than an errno. */
  function remove(dir, name) {
    const where = dirOf(dir);
    if (!where) return;
    mark("remove", `${dir}/${name}`);
    where.removeEntry(name).catch((e) => {
      note(`could not remove ${dir}/${name}: ${e && e.name}`);
    });
  }

  /** Drop one reference. The last closes the handle and, if a commit superseded this generation,
   *  removes the directory entry `free` could not: the refcount table arbitrates, and the
   *  directory only records the outcome. */
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

  /** Free a superseded blob generation. `deferred` is the constraint-47 case — somebody is still
   *  reading the generation the swing replaced, so the entry survives until their close — and is
   *  reported rather than inferred, "gone" and "gone once the reader lets go" being different. */
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

  /** `namesOnly` skips the per-name `getFile()`, which is the cost: constraint 33 prices directory
   *  enumeration at 0.60 ms per name on Safari because of it. */
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

  /** The whole of one metadata file: the superblock slots and the journal at boot, where fsck is a
   *  parser over the whole image. The journal is read THROUGH ITS OWN HANDLE when we hold it,
   *  because that handle is the boot lock and a second one would be refused. */
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
      // ABSENT IS NOT CORRUPT (constraint 28): no superblock slots is a first boot, slots that do
      // not decode are damage, and a reader conflating them reseeds over a damaged volume.
      if (String(e && e.name) === "NotFoundError") return { bytes: null, size: -1, absent: true };
      return errnoOf(e);
    }
  }

  /** Not a hot path: three superblock slots and a journal truncation are the only callers. */
  async function writeAll(m) {
    if (!root) return -EIO;
    const fh = await root.getFileHandle(m.name, { create: true });
    const handle = await fh.createSyncAccessHandle();
    try {
      const bytes = new Uint8Array(m.bytes);
      handle.truncate(0);
      handle.write(bytes, { at: 0 });
      // Unconditional: every caller is a durability point, so a deferred flush here would be a
      // snapshot that is not on disk.
      handle.flush();
      mark("write-all", m.name);
    } finally {
      handle.close();
    }
    return 0;
  }

  /**
   * THE BOOT LOCK (constraint 48). A plain reload RACES THE PREVIOUS KERNEL'S HANDLE, which is
   * released only when that agent actually goes away — about 2.0 s, 2004-2051 ms over five runs
   * (constraint 55). So this retries with exponential backoff past that grace rather than bringing
   * a normal reboot up read-only at random. The budget and first interval are in src/abi.mjs.
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

  /** The journal, through the handle the boot lock holds. `append` does NOT flush: `flush()` is
   *  260 us against a 5 us write (constraint 23). The flush points are fsync, snapshot and idle. */
  function journalOp(m) {
    if (!journal) return -EACCES;
    switch (m.op) {
      case "append": {
        const bytes = new Uint8Array(m.bytes);
        // THE INVARIANT, CHECKED BEFORE THE BYTES LAND: exactly one more than the last record
        // appended. The CRC is not re-checked here, so this costs a header read and not a second
        // pass over the payload.
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
       * A SEQUENCE NUMBER THE KERNEL ALLOCATED AND COULD NOT USE. The expectation advances only on
       * a successful append, so without this one transient error leaves every later metadata op
       * answering -EIO over a healthy volume until reboot. IDEMPOTENT AND NEVER BACKWARDS: the
       * cascade case burns several numbers out of order, and a burn of a number the appender is
       * already past must not rewind it onto a record that landed.
       */
      case "burn": {
        // `burnedSeq`, because the dispatch kernel's envelope overwrites a body field named `seq`
        // with its own correlation id (`makeIo` in src/kernel/kernel.mjs). Likewise `nextSeq`.
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
      // A SNAPSHOT DOES NOT RESET THE SEQUENCE: `writeSnapshot` records the current `seq` as the
      // image's `journalFirstSeq` and keeps counting.
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
    /** The one `getDirectoryHandle` of the module's life. The blob directory is FLAT, named by
     *  `<ino>.<gen>` (constraint 26), and a subdirectory of the root so a sweep can enumerate
     *  blobs without filtering out the metadata files. */
    async start(opfsRoot) {
      root = opfsRoot ? counted(opfsRoot) : null;
      if (!root) return false;
      blobs = await root.getDirectoryHandle(BLOB_DIR, { create: true });
      mark("boot", BLOB_DIR);
      return blobs !== null;
    },
    register(pid, sab) { views.set(pid, new Uint8Array(sab)); },
    unregister(pid) { views.delete(pid); },

    /** Every error path returns an errno rather than throwing: a caller is parked on the answer,
     *  and a rejected promise would be a syscall that never settles. */
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
            // The trace is copied so a reader cannot be handed the live ring and watch it move.
            return {
              counts: { ...counts },
              handles: handles.size, names: byName.size, pendingFree: pendingFree.size,
              trace: trace.map((e) => ({ ...e })), traced: traceN, dropped,
            };
          default:
            // Named AND answered: the caller is parked, and an unimplemented request kind is a
            // kernel defect worth reporting under its name.
            note(`unknown io request ${t}`);
            return -EINVAL;
        }
      } catch (e) {
        // NAMED, never swallowed: the parked caller gets an errno, and the reason goes out of band
        // through `note`, without which -EIO is unrecoverable.
        note(`${t} failed: ${(e && e.stack) || e}`);
        return errnoOf(e);
      }
    },
  };
}
