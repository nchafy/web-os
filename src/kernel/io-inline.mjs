// M0b's negative control: the storage edge, hosted on the dispatch thread.
//
// Moving the OPFS handles to a second kernel-side worker took cheap-call p99 at N=16 from 2,657 us
// to 185 (docs/CONSTRAINTS.md 59); this surface routes the same storage back onto the dispatch
// thread and must reproduce the inline column.
//
// src/kernel/iocore.mjs holds the storage; this file and src/kernel/io-worker.mjs are its two hosts
// and differ in one property — which agent the synchronous `write` and `flush` run on. Both expose
// the same `request(t, body)`, so store.mjs and files.mjs carry no inline branch.
//
// `createSyncAccessHandle` is 495 us (constraint 22) but returns a promise, so an open leaves the
// dispatch thread free. `write`, `flush` and `truncate` are synchronous, so here every microsecond
// of constraint 23's 260 us flush is kernel thread no other process can use.

import { makeIoCore } from "./iocore.mjs";

/**
 * @param {() => FileSystemDirectoryHandle|null} rootOf  the kernel's OPFS root.
 * @param {(why: string) => void} note  how a failure nobody is awaiting reaches the page.
 */
export function makeInlineIo(rootOf, note) {
  const core = makeIoCore({ note: note || (() => {}) });
  return {
    inline: true,
    boot() {},
    start() { return core.start(rootOf()); },
    register(pid, sab) { core.register(pid, sab); },
    unregister(pid) { core.unregister(pid); },
    outstanding() { return 0; },
    request(t, m) { return core.request(t, m); },
  };
}
