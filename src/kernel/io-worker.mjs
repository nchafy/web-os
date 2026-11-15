// The kernel's I/O worker: the storage edge's HEADLINE HOST. It owns every OPFS sync access handle
// and nothing else.
//
// WHY IT EXISTS, measured: with the handles on the dispatch thread, one process calling `fsync` in
// a loop took every other process's p99 from 275 us to 850 at N=16, and to 2,657 us at N=64 — past
// M0's own 2 ms kill bar. `FileSystemSyncAccessHandle.write` and `.flush` are SYNCHRONOUS, so every
// microsecond of constraint 23's 260 us flush was kernel thread no other process could use.
// docs/CONSTRAINTS.md 58 carries the table.
//
// THE STORAGE ITSELF IS src/kernel/iocore.mjs, which this file hosts in a dedicated worker and
// src/kernel/io-inline.mjs hosts on the dispatch thread. This file is therefore a MESSAGE PUMP and
// nothing more: the refcount table, the deferred free, the boot lock and the write ordering have
// one definition, and the control cannot disagree with the headline path about what any of them
// means. Constraint 15 holds either way — no process ever receives a handle, a port to here, or a
// reference to one.

import { IO_READ_ALL } from "../abi.mjs";
import { makeIoCore } from "./iocore.mjs";

let rootWhy = "";

const core = makeIoCore({
  // A fact the worker could not return to a caller — a blob that would not delete, or an
  // unexpected failure inside a request. Surfaced under its own name rather than swallowed.
  note: (why) => self.postMessage({ t: "io-note", why }),
});

/**
 * THE DRAIN ORDER, stated here because a kernel that replies out of order can livelock without
 * one: notifications first, then in-flight answers, then new requests. HelenOS's order and the
 * standard defence (docs/CONSTRAINTS.md 57).
 *
 * This worker reaches it structurally rather than by scheduling: `register` and `unregister` are
 * notifications handled inline with no await; the awaiting requests answer through the same queue
 * they arrived on; and every synchronous request cannot overtake anything. There is no second
 * queue to invert against the first.
 */
self.onmessage = async (ev) => {
  const m = ev.data;
  switch (m.t) {
    // Notifications. No reply, no await, so they can never sit behind a request.
    case "boot": {
      let root = null;
      try {
        root = await navigator.storage.getDirectory();
      } catch (e) {
        root = null;
        rootWhy = String((e && e.name) || e);
      }
      let ok = false;
      try {
        ok = await core.start(root);
      } catch (e) {
        rootWhy = String((e && e.name) || e);
      }
      self.postMessage({ t: "booted", ok, why: rootWhy });
      return;
    }
    case "register":
      // The process's SAB, for zero-copy reads and writes. Kernel-side only; a process never gets
      // a port here.
      core.register(m.pid, m.sab);
      return;
    case "unregister":
      core.unregister(m.pid);
      return;
    default:
      break;
  }

  // Requests. Each answers with the sequence the dispatch kernel is waiting on.
  let r;
  try {
    r = await core.request(m.t, m);
  } catch (e) {
    // An error path names what failed. A swallowed failure here would read as a kernel that
    // answered nothing, and the caller's promise would never settle.
    self.postMessage({ t: "io-error", seq: m.seq, why: `${m.t}: ${(e && e.stack) || e}` });
    return;
  }
  // A full read hands back an ArrayBuffer, which is transferred rather than copied. Everything
  // else is an integer or a small plain object.
  if (m.t === IO_READ_ALL && r && r.bytes instanceof ArrayBuffer) {
    self.postMessage({ t: "done", seq: m.seq, r }, [r.bytes]);
    return;
  }
  self.postMessage({ t: "done", seq: m.seq, r });
};
