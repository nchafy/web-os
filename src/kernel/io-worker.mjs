// The kernel's I/O worker. It owns every OPFS sync access handle and nothing else: `write` and
// `flush` on one are SYNCHRONOUS, so handles on the dispatch thread take every other process's p99
// from 275 us to 2,657 at N=64, past M0's 2 ms kill bar (constraints 23, 58).
//
// The storage itself is src/kernel/iocore.mjs, hosted here and by src/kernel/io-inline.mjs on the
// dispatch thread; this file is a message pump. No process ever receives a handle or a port to
// here (constraint 15).

import { IO_READ_ALL } from "../abi.mjs";
import { makeIoCore } from "./iocore.mjs";

let rootWhy = "";

const core = makeIoCore({
  // A failure nobody is awaiting, surfaced under its own name rather than swallowed.
  note: (why) => self.postMessage({ t: "io-note", why }),
});

/** The drain order, without which a kernel replying out of order can livelock: notifications
 *  first, then in-flight answers, then new requests (docs/CONSTRAINTS.md 57). Reached
 *  structurally — the notifications below never await, and there is no second queue. */
self.onmessage = async (ev) => {
  const m = ev.data;
  switch (m.t) {
    // Notifications: no reply, no await, so they can never sit behind a request.
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
      core.register(m.pid, m.sab);
      return;
    case "unregister":
      core.unregister(m.pid);
      return;
    default:
      break;
  }

  let r;
  try {
    r = await core.request(m.t, m);
  } catch (e) {
    // Swallowing this would leave the caller's promise unsettled forever.
    self.postMessage({ t: "io-error", seq: m.seq, why: `${m.t}: ${(e && e.stack) || e}` });
    return;
  }
  // A full read's buffer is TRANSFERRED, not copied. Every other reply is small and plain.
  if (m.t === IO_READ_ALL && r && r.bytes instanceof ArrayBuffer) {
    self.postMessage({ t: "done", seq: m.seq, r }, [r.bytes]);
    return;
  }
  self.postMessage({ t: "done", seq: m.seq, r });
};
