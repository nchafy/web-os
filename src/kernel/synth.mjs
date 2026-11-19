// A generated filesystem: content computed on read, nothing stored. ONE adapter, so a new one is a
// pair of pure functions over a relative path, `lookup` and `list`, and a new generated FILE is a
// row in a table.
//
// THE ONE INVARIANT: a generated filesystem is read-only, and refuses every mutation with a single
// configured errno. Not in `src/fs/` because it reads live kernel state, so it is not a total
// function over its input and `fsfuzz.py`'s purity lint would reject it.

import { fnv1aString, NAME_MAX } from "../abi.mjs";
import { DIR, FILE, LINK, FsError, splitPath } from "../fs/vfs.mjs";

/**
 * A HASH OF THE PATH, not an allocation: there is no inode table, and the number must be stable
 * across reads so two `stat`s of `/proc/7/status` agree. IT IS NOT AN IDENTITY — a hash is not
 * unique, and nothing here has hard links, rename or an inode-keyed cache. The device is mixed in
 * so two generated mounts cannot collide, and the top bit is clear so the value stays a positive
 * safe integer through the u64 field.
 */
export function synthIno(dev, rel) {
  const h = fnv1aString(`${dev}:${rel}`);
  // Never 0 (which means "no inode") and never 1 (ROOT_INO on the OPFS volume).
  return (h % 0x7ffffffe) + 2;
}

/** Normalized here so a generator may omit the boring parts. */
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
    // Content changes between one read and the next. See `#info`.
    volatile: raw.volatile === true,
  };
}

const ENCODER = new TextEncoder();

/** UTF-8 bytes, which is what `bytesAt` encodes a string to: `text.length` would make `stat` and
 *  `read` disagree about the size of any non-ASCII file. */
function contentLength(content) {
  if (content === undefined) return 0;
  if (typeof content === "string") return ENCODER.encode(content).length;
  return content.length;
}

/**
 * `lookup(rel)` returns a node or null (null is ENOENT); `list(rel)` returns child names, or null
 * when `rel` is not a directory. Both take a path RELATIVE to the mountpoint and beginning with
 * "/", so a generator cannot depend on where it was mounted.
 */
export class SynthFS {
  /** `mutErrno` is the code every mutation is refused with. */
  constructor({ name, lookup, list, mutErrno = "EROFS" }) {
    this.name = name;
    this.dev = 0;
    this.#lookup = lookup;
    this.#list = list;
    this.#mutErrno = mutErrno;
  }

  #lookup;
  #list;
  #mutErrno;

  setDev(dev) {
    this.dev = dev | 0;
  }

  /** The one place a miss becomes an error. */
  #need(rel) {
    const raw = this.#lookup(rel);
    if (!raw) throw new FsError("ENOENT", rel);
    return node(raw);
  }

  /** Computed on every call: a cached answer is what makes a killed process linger in `/proc`. */
  bytesAt(rel) {
    const n = this.#need(rel);
    if (n.type === DIR) throw new FsError("EISDIR", rel);
    if (n.content === undefined) return new Uint8Array(0);
    if (typeof n.content === "string") return ENCODER.encode(n.content);
    return n.content;
  }

  /** The VFS's `#info` shape. The size comes FROM THE NODE ALREADY IN HAND: routing it through
   *  `bytesAt` would run `/dev/trace`'s whole render twice for one `stat`. */
  #info(rel, n) {
    // A VOLATILE FILE PUBLISHES NO SIZE and reports 0, as Linux's own `/proc` does: reading
    // `/proc/<pid>/status` changes it, so a `stat` then a `read` publish 147 bytes and return 145,
    // the syscall counters having grown a digit in between (measured 2026-11-15, www/m3.html proof
    // `proc_files`). `fstat` on an OPEN description instead reports the exact length of the
    // snapshot taken at `open`. The two calls answer differently on purpose.
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

  /** Nothing generated here has symlinks, so `lstat` and `stat` agree. A generator that added a
   *  LINK node would get a `stat` that does not follow it; the throw below catches that. */
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
   * A description-shaped object the kernel installs directly: no Store round trip and no OPFS
   * handle, because there is no blob. THE BYTES ARE SNAPSHOTTED HERE, at open, so a process
   * reading `/proc/<pid>/status` in two `read()` calls cannot see two different moments.
   */
  openDecision(cred, rel, opts = {}) {
    // EVERY GENERATED FILE IS READ-ONLY, and the refusal stays AHEAD OF THE LOOKUP:
    // `open("/proc/nope", O_WRONLY)` is EROFS before it and ENOENT after, and
    // `bench/m3-synth/probe.mjs` holds the former so a reorder is not silent.
    //
    // M7 deleted the one exception. `/dev/console` was a CHARACTER DEVICE — a name that opened to a
    // kernel object rather than to bytes, writable on a read-only mount — and it was the only row
    // this mechanism ever had. A window is created by `win_create` now, so the mechanism had no
    // caller and went with its row (constraint 211).
    if (opts.create || opts.wantW) throw new FsError(this.#mutErrno, rel);
    const n = this.#need(rel);
    if (n.type === DIR && !opts.dirOk) throw new FsError("EISDIR", rel);
    if (opts.dirOk && n.type !== DIR) throw new FsError("ENOTDIR", rel);
    // ANY execute bit, not the one belonging to `cred`'s shift: these nodes are generated and
    // `node()` defaults uid and gid to 0, so a shift checked against ownership nothing maintains
    // would read as enforcement without being it. Read and write are not checked here at all.
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

  /** A generated filesystem has no blocks, so it reports none rather than making `df` lie. */
  statfs() {
    return { blocks: 0, bfree: 0, bavail: 0, files: 0, ffree: 0, bsize: 4096, namemax: NAME_MAX };
  }
}

/** Re-exported so a generator does not import the VFS for one helper. */
export function relParts(rel) {
  return splitPath(rel);
}
