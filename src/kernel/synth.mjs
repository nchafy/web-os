// A generated filesystem: content computed on read, nothing stored.
//
// ONE adapter, so `/proc` and `/dev` are each a pair of pure functions over a relative path rather
// than two implementations of fourteen VFS methods. Adding the next generated filesystem is adding
// data; adding the next generated FILE is adding a row to a table. That is the shape the
// code-design rule asks for, and the reason this file exists instead of a procfs that answers
// `chmod` and a devfs that forgot to.
//
// WHY THIS IS NOT IN src/fs/. A generated filesystem reads live kernel state — the process table,
// the trace ring — so it cannot be a total function over its input, and `fsfuzz.py`'s purity lint
// would reject it. The MOUNT TABLE is pure and lives there; the drivers are here.
//
// THE ONE INVARIANT: a generated filesystem is read-only, and it refuses every mutation with a
// single configured errno. `/proc` refuses with EROFS because it IS a filesystem that cannot be
// written; a generated file that accepted a `chmod` and then forgot it would be worse than one
// that refuses, because the caller would believe it.

import { fnv1aString, NAME_MAX } from "../abi.mjs";
import { DIR, FILE, LINK, FsError, splitPath } from "../fs/vfs.mjs";

/**
 * Inode numbers for generated files are a HASH OF THE PATH, not an allocation.
 *
 * There is no inode table to allocate from, and the number has to be stable across reads so that
 * two `stat`s of `/proc/7/status` agree. A hash gives that for free. What it does not give is
 * uniqueness: two generated paths can collide, and then two files report one inode number.
 *
 * Nothing in the system depends on a generated inode being unique — `/proc` has no hard links, no
 * rename and no inode-keyed cache, and the kernel's per-inode lock is only taken by the OPFS
 * store. Said plainly rather than left for a reader to assume: if a future caller starts using an
 * inode number from a generated filesystem as an identity, this becomes a real defect and the
 * number has to become an allocation.
 *
 * The device number is mixed in so two generated mounts cannot collide with each other, and the
 * top bit is forced clear so the value stays a positive safe integer through the u64 field.
 */
export function synthIno(dev, rel) {
  const h = fnv1aString(`${dev}:${rel}`);
  // Never 0: inode 0 means "no inode" in too many places to be worth the ambiguity, and ROOT_INO
  // is 1 on the OPFS volume so starting above it keeps a generated number visibly different.
  return (h % 0x7ffffffe) + 2;
}

/** The node shape a generator returns. Normalized here so a generator may omit the boring parts. */
function node(raw) {
  const type = raw.type || FILE;
  return {
    type,
    mode: raw.mode === undefined ? (type === DIR ? 0o555 : 0o444) : raw.mode,
    uid: raw.uid || 0,
    gid: raw.gid || 0,
    nlink: raw.nlink || (type === DIR ? 2 : 1),
    content: raw.content,
    target: raw.target,
    size: raw.size,
    // A character device's name: the kernel object `open` must resolve this to, instead of bytes.
    // `src/kernel/devfs.mjs` CHARDEVS is the only producer and `openDecision` the only consumer.
    chardev: raw.chardev,
    // Whether this file's content changes between one read and the next. See `#info`.
    volatile: raw.volatile === true,
  };
}

const ENCODER = new TextEncoder();

/** A node's content length without re-generating it. A string is measured as UTF-8 bytes, which is
 *  what `bytesAt` will encode it to — `text.length` would be wrong for any non-ASCII content and
 *  would make `stat` and `read` disagree about the size of the same file. */
function contentLength(content) {
  if (content === undefined) return 0;
  if (typeof content === "string") return ENCODER.encode(content).length;
  return content.length;
}

/**
 * A read-only generated filesystem, presenting the subset of the VFS surface the kernel's path
 * calls reach.
 *
 * `lookup(rel)` returns a node or null (null is ENOENT). `list(rel)` returns an array of child
 * names, or null when `rel` is not a directory. Both take a path RELATIVE to the mountpoint and
 * beginning with "/", because the mount table hands them that and a generator that knew where it
 * was mounted could depend on it.
 */
export class SynthFS {
  /**
   * @param {object} spec
   * @param {string} spec.name        the filesystem type, for messages
   * @param {Function} spec.lookup    (rel) => node | null
   * @param {Function} spec.list      (rel) => string[] | null
   * @param {string} [spec.mutErrno]  the code every mutation is refused with
   * @param {string[]} [spec.chardevs] single-component names that are character devices
   */
  constructor({ name, lookup, list, mutErrno = "EROFS", chardevs = [] }) {
    this.name = name;
    this.dev = 0;
    this.#lookup = lookup;
    this.#list = list;
    this.#mutErrno = mutErrno;
    this.#chardevs = new Set(chardevs);
  }

  #lookup;
  #list;
  #mutErrno;
  #chardevs;

  /**
   * The character device at `rel`, or null. A SET LOOKUP AND NEVER A GENERATOR CALL.
   *
   * `open` has to ask this BEFORE it decides a write is refused by the mount, and it asks on every
   * open of every generated mount — so it cannot be `#lookup(rel).chardev`. `/dev/trace`'s
   * generator renders the whole trace, and routing this question through it would run that for
   * every `open("/proc/<pid>/status")`. The names are declared once in `src/kernel/devfs.mjs`'s
   * CHARDEVS table and handed to the constructor from the same object the node lookup reads.
   *
   * `/proc`'s set is empty, so its answer is a constant false.
   */
  chardevAt(rel) {
    if (this.#chardevs.size === 0) return null;
    const parts = splitPath(rel);
    return parts.length === 1 && this.#chardevs.has(parts[0]) ? parts[0] : null;
  }

  /** Set once by the kernel when the filesystem is mounted, so `stat` can report the device. */
  setDev(dev) {
    this.dev = dev | 0;
  }

  /** The node at `rel`, or a thrown ENOENT. The one place a miss becomes an error. */
  #need(rel) {
    const raw = this.#lookup(rel);
    if (!raw) throw new FsError("ENOENT", rel);
    return node(raw);
  }

  /**
   * A generated file's bytes. Computed on every call, which is the whole point: a cached answer is
   * what makes a killed process linger in `/proc`.
   */
  bytesAt(rel) {
    const n = this.#need(rel);
    if (n.type === DIR) throw new FsError("EISDIR", rel);
    if (n.content === undefined) return new Uint8Array(0);
    if (typeof n.content === "string") return ENCODER.encode(n.content);
    return n.content;
  }

  /**
   * The VFS's `#info` shape, which is what `writeStat` and `statRecord` consume.
   *
   * The size is computed FROM THE NODE ALREADY IN HAND, never by looking the path up again. One
   * operation is one `lookup`, and that is load-bearing rather than an optimisation: a generator
   * may do real work per call, and `/dev/trace`'s did. When this routed the size through
   * `bytesAt`, a single `stat` ran the generator twice.
   */
  #info(rel, n) {
    // A VOLATILE FILE DOES NOT PUBLISH A SIZE, and reports 0 — which is what Linux's own `/proc`
    // does, for the reason measured here rather than taken on faith.
    //
    // `/proc/<pid>/status` contains the process's syscall counters, so READING IT CHANGES IT. A
    // `stat` then a `read` ran the generator twice and disagreed: 147 bytes published, 145 bytes
    // returned, because the counters had grown a digit in between (measured 2026-11-15,
    // www/m3.html proof `proc_files`). Any number this call published would already be stale, so
    // it publishes none and a caller reads to EOF.
    //
    // `fstat` on an OPEN description is the opposite case and reports an exact size: the bytes
    // were snapshotted at `open`, so that length is both knowable and stable for the life of the
    // fd. The two calls answer differently on purpose.
    const size = n.volatile
      ? 0
      : (n.size !== undefined
        ? n.size
        : (n.type === DIR
          ? (this.#list(rel) || []).length
          : (n.type === LINK
            ? ENCODER.encode(n.target || "").length
            : contentLength(n.content))));
    return {
      ino: synthIno(this.dev, rel),
      dev: this.dev,
      type: n.type,
      mode: n.mode,
      nlink: n.nlink,
      uid: n.uid,
      gid: n.gid,
      size,
      atime: 0,
      mtime: 0,
      ctime: 0,
      target: n.target,
    };
  }

  stat(cred, rel) {
    return this.#info(rel, this.#need(rel));
  }

  /** No generated filesystem here has symlinks, so `lstat` and `stat` agree. Stated, not implied:
   *  a generator that adds a LINK node gets a correct `lstat` for free and a `stat` that does not
   *  follow it, which is wrong — and the assertion below is what would catch that. */
  lstat(cred, rel) {
    const n = this.#need(rel);
    if (n.type === LINK) {
      throw new FsError("EIO", rel,
        "a generated filesystem grew a symlink but resolution was never taught to follow one");
    }
    return this.#info(rel, n);
  }

  readlink(cred, rel) {
    const n = this.#need(rel);
    if (n.type !== LINK) throw new FsError("EINVAL", rel);
    return n.target;
  }

  /** `readdir`'s rows, in the VFS's `{name, ino, type}` shape. */
  listRel(rel) {
    const n = this.#need(rel);
    if (n.type !== DIR) throw new FsError("ENOTDIR", rel);
    const names = this.#list(rel) || [];
    const base = rel === "/" ? "" : rel;
    return names.map((name) => {
      const childRel = `${base}/${name}`;
      const child = this.#lookup(childRel);
      return {
        name,
        ino: synthIno(this.dev, childRel),
        type: child ? (child.type || FILE) : FILE,
      };
    });
  }

  /**
   * `open` against a generated file. Returns a description-shaped object the kernel installs
   * directly — there is no Store round trip and no OPFS handle, because there is no blob.
   *
   * The bytes are snapshotted HERE, at open, and that is a decision rather than an accident: a
   * process that reads `/proc/<pid>/status` in two `read()` calls must not see the first half of
   * one process and the second half of another. POSIX's `/proc` does the same thing.
   */
  openDecision(cred, rel, opts = {}) {
    // M4a. A CHARACTER DEVICE IS THE ONE THING HERE THAT MAY BE OPENED FOR WRITING.
    //
    // A generated FILE must refuse a write — one that accepted a write and forgot it would be
    // worse than one that refuses, which is this class's stated invariant. A device is not a
    // generated file: it is a kernel object with two directions, and `/dev/console` opened O_RDWR
    // is its normal case.
    //
    // THE REFUSAL KEEPS ITS PLACE AND THE EXCEPTION IS CARVED OUT OF IT with `chardevAt`, which
    // answers from a declared set of names and never runs a generator. Looking the NODE up first
    // instead would have changed what a write to a path that does not exist answers:
    // `open("/proc/nope", O_WRONLY)` is refused before the lookup and would have become ENOENT
    // after it. Measured — it moved `/proc refuses open with O_CREAT with EROFS` in
    // `bench/m3-synth/probe.mjs`, which is the check that exists so a reorder here is not silent.
    //
    // `create` is refused for a device too: `open("/dev/console", O_CREAT)` must not claim to have
    // made one, and a mount with no `mknod` has no way to.
    const device = this.chardevAt(rel);
    if (opts.create || (opts.wantW && !device)) throw new FsError(this.#mutErrno, rel);
    const n = this.#need(rel);
    if (n.chardev) {
      if (opts.dirOk) throw new FsError("ENOTDIR", rel);
      if (opts.wantX && (n.mode & 0o111) === 0) throw new FsError("EACCES", rel);
      return {
        chardev: n.chardev,
        rel,
        type: n.type,
        ino: synthIno(this.dev, rel),
        dev: this.dev,
        info: this.#info(rel, n),
      };
    }
    // THE SAME RULE THE VFS APPLIES, so this system has one answer to "can I open a directory".
    //
    // `src/fs/vfs.mjs`'s `openDecision` refuses a directory without `O_DIRECTORY` with EISDIR, and
    // this followed POSIX instead until M3 noticed the two disagreeing — `ls /proc` worked without
    // the flag and `ls /tmp` did not. ONE behaviour beats the more correct one here: the VFS's is
    // the established semantics of a shipped milestone with 92 expectations resting on it, and a
    // caller that has to remember which mount it is on has no portable `ls` at all.
    //
    // It diverges from Linux, where `open(dir, O_RDONLY)` succeeds and `read` on the fd is EISDIR.
    // The divergence is the VFS's and predates M3; constraint 82 records it rather than leaving
    // the next reader to rediscover it.
    if (n.type === DIR && !opts.dirOk) throw new FsError("EISDIR", rel);
    if (opts.dirOk && n.type !== DIR) throw new FsError("ENOTDIR", rel);
    // M5's exec check. ANY execute bit, not the one belonging to `cred`'s shift, and that is a
    // deliberate difference from `src/fs/vfs.mjs` rather than an omission: the nodes here are
    // GENERATED and own no uid or gid worth consulting — `node()` above defaults both to 0 for
    // every file a generator returns. Checking a shift against ownership nothing maintains would
    // be a permission model that reads as enforcement and is not. Read and write are not checked
    // at all here, which long predates this line.
    if (opts.wantX && (n.mode & 0o111) === 0) throw new FsError("EACCES", rel);
    const info = this.#info(rel, n);
    return {
      synth: true,
      rel,
      type: n.type,
      ino: info.ino,
      dev: this.dev,
      bytes: n.type === DIR ? new Uint8Array(0) : this.bytesAt(rel),
      info,
    };
  }

  /** Every mutation, refused in one place with one errno. */
  #refuse(rel) {
    throw new FsError(this.#mutErrno, rel, `${this.name} is generated and cannot be written`);
  }

  mkdir(cred, rel) { return this.#refuse(rel); }

  rmdir(cred, rel) { return this.#refuse(rel); }

  unlink(cred, rel) { return this.#refuse(rel); }

  rename(cred, from, to) { return this.#refuse(from); }

  symlink(cred, target, rel) { return this.#refuse(rel); }

  link(cred, from, to) { return this.#refuse(to); }

  chmod(cred, rel) { return this.#refuse(rel); }

  chown(cred, rel) { return this.#refuse(rel); }

  utimes(cred, rel) { return this.#refuse(rel); }

  /** `statfs`. A generated filesystem has no blocks, and reporting a size it does not have would
   *  make `df` lie; zeros are the honest answer and POSIX's own for procfs. */
  statfs() {
    return { blocks: 0, bfree: 0, bavail: 0, files: 0, ffree: 0, bsize: 4096, namemax: NAME_MAX };
  }
}

/** Split a relative mount path into components. Re-exported so a generator does not import the
 *  VFS for one helper and risk reaching for the rest of it. */
export function relParts(rel) {
  return splitPath(rel);
}
