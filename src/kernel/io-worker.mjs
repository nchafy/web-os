// The kernel's I/O worker. It owns every OPFS sync access handle and nothing else.
//
// WHY IT EXISTS, measured: with the handles on the dispatch thread, one process calling `fsync`
// in a loop took every other process's p99 from 275 us to 850 at N=16, and to 2,657 us at N=64 —
// past M0's own 2 ms kill bar. `FileSystemSyncAccessHandle.write` and `.flush` are SYNCHRONOUS, so
// every microsecond of constraint 23's 260 us flush was kernel thread no other process could use.
// docs/CONSTRAINTS.md 58 carries the table.
//
// Constraint 15 is satisfied because this is kernel-side: a releasable resource may not live in a
// PROCESS worker, and no process ever receives a handle, a port to here, or a reference to one.
// The dispatch kernel is this worker's only correspondent.
//
// Constraint 47's per-inode refcount lives HERE, beneath the fd table, because this is where the
// handles are and an exclusive lock must be arbitrated where the thing it locks is held.

import { IO_OPEN, IO_WRITE, IO_FSYNC, IO_CLOSE, EIO, EBADF, EINVAL } from "../abi.mjs";

let root = null;
let rootWhy = "";

/** Open handles by the id the dispatch kernel knows them by. */
const handles = new Map();
let nextId = 1;

/**
 * Constraint 47: a sync access handle is an EXCLUSIVE lock per file, so a second open of the same
 * file throws NoModificationAllowedError. Refcounting by name means `cat notes.txt | wc -l` does
 * not fail while an editor holds the file — the second opener gets the same handle and a count.
 */
const byName = new Map();

/**
 * The bytes a write sends come from the CALLING PROCESS'S OWN SAB, read here while that process is
 * parked in Atomics.wait. That is what makes this zero-copy rather than a copy per write: the
 * process cannot touch the buffer until the dispatch kernel bumps its SEQ, and the dispatch kernel
 * does not do that until this worker has answered.
 */
const views = new Map();

function errnoOf(e) {
  const name = String((e && e.name) || e);
  if (name === "NotFoundError") return -EINVAL;
  if (name === "NoModificationAllowedError") return -EBADF;
  return -EIO;
}

async function open(name) {
  if (!root) return -EIO;
  const existing = byName.get(name);
  if (existing) {
    existing.refs += 1;
    return existing.id;
  }
  try {
    const fh = await root.getFileHandle(name, { create: true });
    const handle = await fh.createSyncAccessHandle();
    const id = nextId++;
    const entry = { id, handle, name, refs: 1, at: 0, bytes: 0, writes: 0, flushes: 0 };
    handles.set(id, entry);
    byName.set(name, entry);
    return id;
  } catch (e) {
    return errnoOf(e);
  }
}

function write(id, pid, offset, length) {
  const h = handles.get(id);
  if (!h) return -EBADF;
  const view = views.get(pid);
  if (!view) return -EBADF;
  try {
    // Synchronous, and that is the point: it is synchronous HERE, on a thread whose only job is
    // waiting for storage, instead of on the thread every other process needs.
    const n = h.handle.write(view.subarray(offset, offset + length), { at: h.at });
    h.at += n;
    h.bytes += n;
    h.writes += 1;
    return n;
  } catch (e) {
    return errnoOf(e);
  }
}

function fsync(id) {
  const h = handles.get(id);
  if (!h) return -EBADF;
  try {
    h.handle.flush();
    h.flushes += 1;
    return 0;
  } catch (e) {
    return errnoOf(e);
  }
}

function close(id) {
  const h = handles.get(id);
  if (!h) return -EBADF;
  if (--h.refs > 0) return 0;
  handles.delete(id);
  byName.delete(h.name);
  try { h.handle.close(); } catch (e) { /* a closed handle is the desired end state */ }
  return 0;
}

/**
 * THE DRAIN ORDER, and it is stated here because a kernel that replies out of order can livelock
 * without one: notifications first, then in-flight answers, then new requests. HelenOS's order and
 * the standard defence (docs/CONSTRAINTS.md 57).
 *
 * This worker reaches it structurally rather than by scheduling: `register` and `unregister` are
 * notifications and are handled inline with no await; `open` is the only awaiting request and it
 * answers through the same queue it arrived on; `write`, `fsync` and `close` are synchronous and
 * cannot overtake anything. There is no second queue to invert against the first.
 */
self.onmessage = async (ev) => {
  const m = ev.data;
  switch (m.t) {
    // Notifications. No reply, no await, so they can never sit behind a request.
    case "boot":
      try {
        root = await navigator.storage.getDirectory();
      } catch (e) {
        root = null;
        rootWhy = String((e && e.name) || e);
      }
      self.postMessage({ t: "booted", ok: root !== null, why: rootWhy });
      return;
    case "register":
      // The process's SAB, for zero-copy writes. Kernel-side only; a process never gets a port here.
      views.set(m.pid, new Uint8Array(m.sab));
      return;
    case "unregister":
      views.delete(m.pid);
      return;
    default:
      break;
  }

  // Requests. Each answers with the id the dispatch kernel is waiting on.
  let r;
  switch (m.t) {
    case IO_OPEN: r = await open(m.name); break;
    case IO_WRITE: r = write(m.id, m.pid, m.offset, m.length); break;
    case IO_FSYNC: r = fsync(m.id); break;
    case IO_CLOSE: r = close(m.id); break;
    default:
      self.postMessage({ t: "io-error", seq: m.seq, why: `unknown io request ${m.t}` });
      return;
  }
  self.postMessage({ t: "done", seq: m.seq, r });
};
