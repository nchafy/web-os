// `/tmp`: a writable filesystem that lives in memory and does not survive a reload.
//
// IT REUSES THE VFS. A tmpfs needs mkdir, rmdir, unlink, rename, link, symlink, chmod, chown,
// stat, lstat, readdir and open with O_CREAT/O_TRUNC/O_APPEND — which is the whole POSIX surface
// `src/fs/vfs.mjs` already implements, correctly, over an in-memory inode table. Writing a second
// one would be two renderers of one fact, and the second would be the one with the permission bug.
//
// What the VFS does NOT have is anywhere to put bytes: `openDecision` hands back a decision that
// the OPFS store turns into a blob handle. So that is the whole of this file — a `Map` from inode
// to bytes, and the generation bookkeeping to keep the VFS's own `size` honest.
//
// WHY THERE IS NO JOURNAL. A tmpfs has no durable state, so there is nothing to recover and no
// record to write. The mount table carries `durable: false` for it and `calls.mjs`'s `metaOp`
// returns 0 without journalling — appending a record would describe the OPFS volume, where the op
// did not happen, and replay would then invent a directory on the wrong filesystem.
//
// THE SIZE GOES THROUGH OP.COMMIT, not through a poke at `inode.size`. That op is the VFS's own
// data operation and it carries the generation forward; reaching past it would put a second writer
// on a field the VFS maintains.

import { VFS, FILE, DIR, OP, FsError } from "../fs/vfs.mjs";

/**
 * A tmpfs. One VFS for the metadata, one Map for the bytes.
 *
 * `limit` is a byte ceiling, and it is here rather than left to the browser because a tmpfs with
 * no limit is a way for one process to exhaust the renderer's heap and take every other process
 * with it — the same reason constraint 17 caps the process table. ENOSPC is the POSIX answer.
 */
export class TmpFS {
  constructor({ limit = 64 * 1024 * 1024, now = Date.now } = {}) {
    this.vfs = new VFS({ owner: { uid: 0, gid: 0 }, now });
    // Mode 1777 with the sticky bit, which is what /tmp is everywhere: world-writable, and only
    // the owner of a file may remove it. THE STICKY BIT IS STORED AND NOT ENFORCED — the VFS has
    // no sticky rule — so it is honest about the mode and not about the protection. Said here
    // because a reader who sees 1777 will assume the enforcement.
    this.vfs.chmod({ uid: 0, gid: 0 }, "/", 0o1777);
    this.blobs = new Map();
    this.limit = limit;
    this.bytes = 0;
    this.dev = 0;
  }

  setDev(dev) {
    this.dev = dev | 0;
  }

  /* ---- the read surface, delegated whole ------------------------------------------------ */

  stat(cred, rel) {
    return { ...this.vfs.stat(cred, rel), dev: this.dev };
  }

  lstat(cred, rel) {
    return { ...this.vfs.lstat(cred, rel), dev: this.dev };
  }

  readlink(cred, rel) {
    return this.vfs.readlink(cred, rel);
  }

  listRel(rel) {
    // By PATH, not by inode: the kernel's readdir resolves a synthetic description through
    // `d.fs.listRel(d.rel)`, and a tmpfs description records its path for the same reason.
    const info = this.vfs.stat({ uid: 0, gid: 0 }, rel);
    if (info.type !== DIR) throw new FsError("ENOTDIR", rel);
    return this.vfs.listIno(info.ino);
  }

  statfs() {
    const counted = this.vfs.stats();
    return {
      blocks: this.limit,
      bfree: Math.max(0, this.limit - this.bytes),
      bavail: Math.max(0, this.limit - this.bytes),
      files: counted.inodes,
      // Inodes are bounded by BYTES here, not by a separate table, so "free inodes" is however
      // many an empty inode could still be allocated from the remaining space. Reporting 0 made
      // `df -i` read as full on a filesystem that creates files freely.
      ffree: Math.max(0, this.limit - this.bytes),
      bsize: 1,
      namemax: 255,
    };
  }

  /* ---- the write surface, delegated whole ----------------------------------------------- */
  //
  // Each returns the VFS's op record, which `metaOp` would journal on a durable mount and discards
  // on this one. They are listed rather than generated because a `for` loop over method names is
  // harder to read than nine lines and would hide which calls a tmpfs actually serves.

  mkdir(cred, rel, opts) {
    return this.vfs.mkdir(cred, rel, opts);
  }

  rmdir(cred, rel) {
    return this.vfs.rmdir(cred, rel);
  }

  unlink(cred, rel) {
    const op = this.vfs.unlink(cred, rel);
    // The bytes go when the last link does. `unlink` reports the freed inode in `op.freed`, which
    // is the same field the OPFS store uses to reclaim blobs.
    if (op && op.freed) this.#drop(op.freed);
    return op;
  }

  rename(cred, from, to) {
    const op = this.vfs.rename(cred, from, to);
    if (op && op.freed) this.#drop(op.freed);
    return op;
  }

  link(cred, from, to) {
    return this.vfs.link(cred, from, to);
  }

  symlink(cred, target, rel) {
    return this.vfs.symlink(cred, target, rel);
  }

  chmod(cred, rel, mode) {
    return this.vfs.chmod(cred, rel, mode);
  }

  chown(cred, rel, uid, gid) {
    return this.vfs.chown(cred, rel, uid, gid);
  }

  utimes(cred, rel, atime, mtime) {
    return this.vfs.utimes(cred, rel, atime, mtime);
  }

  /* ---- open, and the bytes -------------------------------------------------------------- */

  /**
   * A tmpfs open. Returns a description-shaped object the kernel installs directly: there is no
   * blob store to go through and nothing to await, so a `/tmp` read answers on the dispatch thread
   * exactly as a generated file does.
   */
  openDecision(cred, rel, opts = {}) {
    const decision = this.vfs.openDecision(cred, rel, opts);
    if (decision.type === FILE && !this.blobs.has(decision.ino)) {
      this.blobs.set(decision.ino, new Uint8Array(0));
    }
    return {
      tmpfs: true,
      rel,
      type: decision.type,
      ino: decision.ino,
      dev: this.dev,
      created: decision.created,
      info: { ...this.vfs.fstat(decision.ino), dev: this.dev },
    };
  }

  /**
   * The bytes behind one inode, or ESTALE once its last link is gone.
   *
   * REACHABLE FROM USERLAND IN THREE SYSCALLS: open a `/tmp` file, write it, unlink it, then read
   * the fd you still hold. An earlier comment here claimed this state meant a kernel bug and that
   * was simply wrong — `unlink` frees the bytes as soon as the VFS reports the last link gone, and
   * the VFS does not know file descriptions exist.
   *
   * ESTALE, and the same answer the OPFS store gives (`src/abi.mjs` ESTALE, `store.mjs` `resolve`).
   * POSIX would keep the file alive until the last descriptor closed; M2 decided not to and to
   * refuse CONSISTENTLY under one name instead, so a tmpfs that chose differently would make the
   * behaviour of an unlinked open file depend on which mount it was on. Recorded as constraint 83
   * rather than left as a surprise.
   */
  #bytesOf(ino) {
    const have = this.blobs.get(ino);
    if (!have) {
      throw new FsError("ESTALE", `inode ${ino}`,
        "the last link to this tmpfs file is gone; its bytes went with it");
    }
    return have;
  }

  #drop(ino) {
    const had = this.blobs.get(ino);
    if (had) {
      this.bytes -= had.length;
      this.blobs.delete(ino);
    }
  }

  /** Publish a new length through the VFS's own data op, so `size` has one writer. */
  #commit(ino, next) {
    const before = this.blobs.get(ino);
    const inode = this.vfs.inodes.get(ino);
    if (!inode) throw new FsError("EIO", `inode ${ino}`, "no such tmpfs inode");
    this.bytes += next.length - (before ? before.length : 0);
    this.blobs.set(ino, next);
    this.vfs.applyOp({
      k: OP.COMMIT, ino, gen: inode.gen + 1, size: next.length, t: this.vfs.now(),
    });
  }

  size(ino) {
    return this.#bytesOf(ino).length;
  }

  read(ino, from, length, into, atOffset) {
    const have = this.#bytesOf(ino);
    if (from >= have.length) return 0;
    const n = Math.min(length, have.length - from);
    into.set(have.subarray(from, from + n), atOffset);
    return n;
  }

  write(ino, at, src) {
    const have = this.#bytesOf(ino);
    const end = at + src.length;
    // The ceiling is charged on the GROWTH, not on the write: overwriting bytes in place costs
    // nothing, which is what makes a bounded tmpfs usable for a log that is rewritten in place.
    const growth = Math.max(0, end - have.length);
    if (this.bytes + growth > this.limit) {
      throw new FsError("ENOSPC", `inode ${ino}`,
        `${this.bytes + growth} B would pass this tmpfs's ${this.limit} B limit`);
    }
    const next = end > have.length ? new Uint8Array(end) : new Uint8Array(have.length);
    next.set(have, 0);
    // A write past the end leaves a hole, and POSIX says a hole reads as zeroes — which a fresh
    // Uint8Array already is, so the gap needs no filling and must not be left as whatever the
    // allocator had.
    next.set(src, at);
    this.#commit(ino, next);
    return src.length;
  }

  truncate(ino, size) {
    const have = this.#bytesOf(ino);
    if (size === have.length) return 0;
    const growth = Math.max(0, size - have.length);
    if (this.bytes + growth > this.limit) {
      throw new FsError("ENOSPC", `inode ${ino}`,
        `${this.bytes + growth} B would pass this tmpfs's ${this.limit} B limit`);
    }
    const next = new Uint8Array(size);
    next.set(have.subarray(0, Math.min(size, have.length)), 0);
    this.#commit(ino, next);
    return 0;
  }
}
