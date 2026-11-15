// M0b's negative control: the storage edge, hosted on the DISPATCH THREAD.
//
// A fix that cannot be switched off has not been shown to be the thing that worked. M0b moved the
// OPFS handles to a second kernel-side worker and measured cheap-call p99 at N=16 going from
// 2,657 us to 185 (docs/CONSTRAINTS.md 59); this surface routes the same storage back onto the
// dispatch thread and must reproduce the inline column.
//
// IT IS THE SAME CODE, which is the whole of the control's claim. `src/kernel/iocore.mjs` holds the
// handles, the per-inode refcount, the deferred free, the boot lock and the write ordering; this
// file and `src/kernel/io-worker.mjs` are its two hosts and differ in ONE property — which agent
// the synchronous `write` and `flush` run on. Before, the refcount and deferred-free logic was
// written out twice and hand-synced, so a defect in it had to be introduced twice to be caught
// twice, and the control could disagree with the headline path about what a reference count means.
//
// IT IS THE SAME INTERFACE the dispatch kernel uses for the real I/O worker — `request(t, body)`
// returning a value or a promise — so src/kernel/store.mjs and src/kernel/files.mjs contain no
// inline branch at all. That matters for the objection a control invites: the headline path cannot
// have been perturbed by the control, because the headline path does not mention it.
//
// THE ASYMMETRY IS PRESERVED EXACTLY, and it is the reverse of how the two raw costs read.
// `createSyncAccessHandle` is 495 us (constraint 22) and returns a PROMISE, so an open leaves the
// dispatch thread free while it settles. `write`, `flush` and `truncate` are SYNCHRONOUS, so here
// every microsecond of constraint 23's 260 us flush is kernel thread no other process can use.
// `fsync` is the call to get off the dispatch thread; `open` already was.

import { makeIoCore } from "./iocore.mjs";

/**
 * @param {() => FileSystemDirectoryHandle|null} rootOf  the kernel's OPFS root, acquired at boot.
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
