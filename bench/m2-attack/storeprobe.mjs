// A stub I/O surface under src/kernel/store.mjs, to get a STACK for a failure the browser
// reports only as an errno. Debug tool, scratch only.
import {
  IO_BLOB_OPEN, IO_WRITE, IO_READ, IO_FSYNC, IO_CLOSE, IO_TRUNCATE, IO_FREE, IO_LIST,
  IO_READ_ALL, IO_WRITE_ALL, IO_LOCK, IO_JOURNAL, IO_COPY, IO_STATS,
} from "/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl/src/abi.mjs";
import { Store } from "/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl/src/kernel/store.mjs";

let nextId = 1;
const sizes = new Map();
const names = new Map();
const io = {
  async request(kind, m) {
    switch (kind) {
      case IO_LOCK: return { ok: true, why: "" };
      case IO_READ_ALL: return { bytes: null, size: -1, absent: true };
      case IO_LIST: return [...names.keys()].map((name) => ({ name, size: sizes.get(name) || 0 }));
      case IO_BLOB_OPEN: {
        const name = `${m.ino}.${m.gen}`;
        if (!names.has(name)) { names.set(name, nextId++); sizes.set(name, 0); }
        return { id: names.get(name), refs: 1, size: sizes.get(name) };
      }
      case IO_WRITE: return m.length;
      case IO_READ: return m.length;
      case IO_COPY: return m.length;
      case IO_FSYNC: return 0;
      case IO_TRUNCATE: return 0;
      case IO_CLOSE: return 0;
      case IO_FREE: return { freed: true, deferred: false };
      case IO_JOURNAL: return 0;
      case IO_WRITE_ALL: return 0;
      case IO_STATS: return { counts: {} };
      default: throw new Error("unknown io kind " + kind);
    }
  },
};

const store = new Store(io, {});
const report = await store.mount();
console.log("mount", report.mountable, "mode", store.mode);

const cred = { uid: 0, gid: 0 };
const decision = store.vfs.openDecision(cred, "/f", { create: true, wantW: true, wantR: true });
console.log("created", !!decision.created, decision);
const d = await store.openFd(decision);
d.type = "file";
console.log("fd", d);
console.log("write", await store.writeFd(d, 1, 0, 1, undefined));
try {
  console.log("fsync", await store.fsyncFd(d));
} catch (e) {
  console.log("fsync THREW", e && e.stack);
}
console.log("fd after", d);
