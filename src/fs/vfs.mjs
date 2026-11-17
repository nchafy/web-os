// The metadata filesystem: inodes, path resolution, symlinks, permissions, and nothing else.
//
// Two properties run through every method:
//
//   1. FILE DATA IS BYTES AND IT IS NOT HERE. Bytes live in a flat OPFS blob named by inode
//      (constraint 26); an inode carries `size` in BYTES plus `gen`, the blob generation its data
//      is in. That is what keeps this module pure, and scripts/fsfuzz.py stops running the moment
//      a parse path reaches for storage.
//   2. THE CREDENTIAL IS THE FIRST ARGUMENT OF EVERY CALL, never instance state (constraint 29).
//      There is no `this.uid`; `cred` is `{uid, gid}` and a method cannot be invoked without one.
//      One stored identity would make the mode bits decoration.
//
// MUTATION IS TWO HALVES, and the split is what makes crash consistency possible: a mutating
// method decides (resolve, check permissions, allocate an inode number) and returns an OP RECORD;
// `applyOp` executes it. Replay calls `applyOp` with the recorded op, so the journal replays
// through the same code that wrote it rather than through a second implementation.

import { NAME_MAX } from "../abi.mjs";

export const DIR = "dir";
export const FILE = "file";
export const LINK = "link";

/** Fixed, so a serialized image does not have to say which inode is the root. */
export const ROOT_INO = 1;

/** Linux's own `MAXSYMLINKS`. A cycle is indistinguishable from a very long chain, so the only
 *  honest answer is a limit. */
export const MAX_LINKS = 40;

export const PERM = Object.freeze({ R: 4, W: 2, X: 1 });
const R = PERM.R;
const W = PERM.W;
const X = PERM.X;

/** Declared in src/abi.mjs and re-exported, because it crosses the kernel/process boundary: a
 *  program refused with -ENAMETOOLONG has to know what length it was refused for. src/abi.mjs is
 *  pure integers and importable from Node, so taking it from there costs no purity. */
export { NAME_MAX } from "../abi.mjs";

/** Bumped when the serialized shape changes. A mismatch is a REFUSAL, never a migration and never
 *  a reseed (constraint 28); the superblock's major/minor carries the same rule one level up. */
export const FORMAT_VERSION = 1;

const MESSAGES = {
  ENOENT: "No such file or directory",
  EEXIST: "File exists",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  ENOTEMPTY: "Directory not empty",
  ELOOP: "Too many levels of symbolic links",
  EINVAL: "Invalid argument",
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  ENOSPC: "No space left on device",
  ENAMETOOLONG: "File name too long",
  EBUSY: "Device or resource busy",
  // Without these two rows the code would reach a process as -EIO, saying "the disk failed" about
  // a typo in a mount row or an operation on a description whose inode is gone.
  ENODEV: "No such device",
  ESTALE: "Stale file handle",
  EFBIG: "File too large",
  EMLINK: "Too many links",
  EROFS: "Read-only file system",
  EIO: "Input/output error",
};

/** The kernel maps `code` through src/abi.mjs's `E` table, the one place a name becomes an errno. */
export class FsError extends Error {
  constructor(code, path = "", detail = "") {
    const reason = detail || MESSAGES[code] || code;
    super(path ? `${path}: ${reason}` : reason);
    this.name = "FsError";
    this.code = code;
    this.path = path;
  }
}

/** Asserted against src/abi.mjs's errno table by the host test: a code with no errno would reach a
 *  process as -EIO and lose the reason. */
export const FS_CODES = Object.freeze(Object.keys(MESSAGES));

/* ---------------------------------------------------------------------------
   Paths. Lexical only — nothing here touches the filesystem, so these are safe
   on a path whose components do not exist yet.
   --------------------------------------------------------------------------- */

export function isAbsolute(path) {
  return path.startsWith("/");
}

/** The components of a path, with empties and `.` dropped. `..` survives. */
export function splitPath(path) {
  return path.split("/").filter((part) => part !== "" && part !== ".");
}

export function joinPath(...parts) {
  let out = "";
  for (const part of parts) {
    if (part === undefined || part === null || part === "") continue;
    if (isAbsolute(part)) out = part;
    else out = out ? `${out.replace(/\/+$/, "")}/${part}` : part;
  }
  return out;
}

/**
 * Collapse `.`, `..` and repeated slashes WITHOUT consulting the filesystem.
 *
 * The `-L` rule a shell uses for its own working directory, deliberately not what resolution does:
 * `..` here cancels the previous name in the string, where resolution follows the real parent of
 * whatever that name pointed at. They disagree exactly when a symlink is involved.
 */
export function normalize(path) {
  const absolute = isAbsolute(path);
  const out = [];
  for (const part of splitPath(path)) {
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
    } else {
      out.push(part);
    }
  }
  const joined = out.join("/");
  if (absolute) return `/${joined}`;
  return joined || ".";
}

export function basename(path) {
  const parts = splitPath(path);
  if (parts.length) return parts[parts.length - 1];
  return isAbsolute(path) ? "/" : ".";
}

export function dirname(path) {
  const normalized = normalize(path);
  const cut = normalized.lastIndexOf("/");
  if (cut < 0) return ".";
  if (cut === 0) return "/";
  return normalized.slice(0, cut);
}

/** `rwxr-xr-x`, the way `ls -l` writes a mode. */
export function modeString(type, mode) {
  const kind = type === DIR ? "d" : type === LINK ? "l" : "-";
  let out = kind;
  for (const shift of [6, 3, 0]) {
    const bits = (mode >> shift) & 7;
    out += bits & R ? "r" : "-";
    out += bits & W ? "w" : "-";
    out += bits & X ? "x" : "-";
  }
  return out;
}

/* ---------------------------------------------------------------------------
   The op vocabulary. One journal record is one of these, JSON-encoded.
   --------------------------------------------------------------------------- */

/**
 * Strings rather than integers because the journal payload is JSON and fsck prints these: a reader
 * holding a corrupt image is better served by a name than by a number.
 *
 * COMMIT is the COW swing and the only op that touches file data, moving an inode's reference from
 * one blob generation to the next. Every other op is pure metadata.
 */
export const OP = Object.freeze({
  MKDIR: "mkdir",
  RMDIR: "rmdir",
  CREATE: "create",
  UNLINK: "unlink",
  LINK: "link",
  SYMLINK: "symlink",
  RENAME: "rename",
  CHMOD: "chmod",
  CHOWN: "chown",
  UTIMES: "utimes",
  COMMIT: "commit",
});

const ENC = new TextEncoder();
const DEC = new TextDecoder();

export function encodeOp(op) {
  return ENC.encode(JSON.stringify(op));
}

/**
 * Never throws. A journal record whose CRC checked out can still hold bytes this version does not
 * understand, and the caller that decides what a bad op means is fsck, not a JSON parser.
 *
 * `slice()` unconditionally, because TextDecoder refuses a view backed by a SharedArrayBuffer
 * ("must not be shared"), which would turn a torn record into a stack trace instead of a named
 * refusal. Sniffing the buffer's type instead would name `SharedArrayBuffer` in a module whose
 * whole value is that it names no capability at all.
 */
export function decodeOp(bytes) {
  try {
    const op = JSON.parse(DEC.decode(bytes.slice()));
    if (!op || typeof op !== "object" || typeof op.k !== "string") return null;
    if (!Object.values(OP).includes(op.k)) return null;
    return op;
  } catch (e) {
    return null;
  }
}

/* ---------------------------------------------------------------------------
   The filesystem.
   --------------------------------------------------------------------------- */

export class VFS {
  /**
   * @param {object} [options]
   * @param {{uid: number, gid: number}} [options.owner] The root directory's owner and nothing
   *        else. Not a stored identity: constraint 29 makes a credential a per-call argument.
   * @param {() => number} [options.now] Milliseconds. Injectable so replay is exact and a host
   *        test is deterministic: every op carries the timestamp it was written with.
   *
   *        There is NO DEFAULT. A parse path that reads the wall clock is not a function of its
   *        input and so is not fuzzable, which is the premise `scripts/fsfuzz.py` rests on.
   *        Omitting it yields a clock that refuses, so a replayed op with no timestamp is a named
   *        error instead of a silently invented one, and the capability lives at the edges.
   * @param {boolean} [options.empty] Build with NO root inode, for `parse` to fill.
   */
  constructor({ owner = { uid: 0, gid: 0 }, now = undefined, empty = false } = {}) {
    this.now = now ?? (() => {
      throw new FsError("EIO", "<clock>",
        "an op carries no timestamp and this VFS was built without a clock");
    });
    this.inodes = new Map();
    this.nextIno = ROOT_INO;
    this.rootIno = ROOT_INO;
    /** Monotonic, bumped by every op this VFS applies. The journal's record sequence is derived
     *  from it, so "which ops are already in the snapshot" has one answer. */
    this.opSeq = 0;
    if (!empty) {
      const root = this.#alloc(DIR, { mode: 0o755, uid: owner.uid, gid: owner.gid });
      root.parent = root.ino;
      this.rootIno = root.ino;
    }
  }

  /* --------------------------- inode plumbing --------------------------- */

  #alloc(type, { ino, mode, uid, gid, t }) {
    const stamp = t === undefined ? this.now() : t;
    const number = ino === undefined ? this.nextIno : ino;
    const inode = {
      ino: number,
      type,
      mode: mode & 0o7777,
      uid,
      gid,
      // A new directory already has two names: its own, and the `..` inside it.
      nlink: type === DIR ? 2 : 1,
      atime: stamp,
      mtime: stamp,
      ctime: stamp,
    };
    if (type === DIR) {
      inode.entries = new Map();
      inode.parent = null;
    } else if (type === LINK) {
      inode.target = "";
    } else {
      // `size` is a byte count; `gen` names which blob in the flat directory holds those bytes.
      // gen 0 means "no blob has ever been committed", distinct from "a blob of length zero" —
      // the first has nothing on disk to read and the second has a file.
      inode.size = 0;
      inode.gen = 0;
    }
    this.inodes.set(inode.ino, inode);
    if (inode.ino >= this.nextIno) this.nextIno = inode.ino + 1;
    return inode;
  }

  #inode(ino) {
    const inode = this.inodes.get(ino);
    // A missing inode is a corrupt image, not a missing file: the only way to hold an inode
    // number is to have read it out of a directory.
    if (inode === undefined) throw new FsError("EIO", `inode ${ino}`, "Dangling inode reference");
    return inode;
  }

  /** EVERY requested bit, not any. Constraint 29: cred, never this.uid. */
  #may(cred, inode, bits) {
    if (cred.uid === 0) {
      // Root ignores read and write bits, and still needs one execute bit to run a file — which
      // is what stops `chmod 000 file && ./file` working as root.
      return (bits & X) === 0 || inode.type === DIR || (inode.mode & 0o111) !== 0;
    }
    const shift = inode.uid === cred.uid ? 6 : inode.gid === cred.gid ? 3 : 0;
    const granted = (inode.mode >> shift) & 7;
    return (granted & bits) === bits;
  }

  #need(cred, inode, bits, path) {
    if (!this.#may(cred, inode, bits)) throw new FsError("EACCES", path);
  }

  /* --------------------------- resolution --------------------------- */

  /**
   * `ino` is `null` when the final name is free, which is what the create operations need.
   *
   * @returns {{dirIno: number, name: string, ino: number|null}}
   */
  #lookup(cred, parts, startIno, { depth = 0, followFinal = true, shown = "" } = {}) {
    if (depth > MAX_LINKS) throw new FsError("ELOOP", shown);

    let dirIno = startIno;
    if (!parts.length) {
      return { dirIno: this.#inode(startIno).parent, name: "", ino: startIno };
    }

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part.length > NAME_MAX) throw new FsError("ENAMETOOLONG", shown);
      const last = i === parts.length - 1;
      const dir = this.#inode(dirIno);
      if (dir.type !== DIR) throw new FsError("ENOTDIR", shown);
      // The execute bit on a directory is the right to look inside it. Checked at EVERY level,
      // because that is the only thing that makes `chmod 000 dir` mean anything.
      this.#need(cred, dir, X, shown);

      let childIno;
      if (part === "..") childIno = dir.parent;
      else if (part === ".") childIno = dirIno;
      else childIno = dir.entries.get(part);

      if (childIno === undefined) {
        if (last) return { dirIno, name: part, ino: null };
        throw new FsError("ENOENT", shown);
      }

      const child = this.#inode(childIno);
      if (child.type === LINK && (!last || followFinal)) {
        const target = child.target;
        const base = isAbsolute(target) ? this.rootIno : dirIno;
        const hit = this.#lookup(cred, splitPath(target), base, {
          depth: depth + 1, followFinal: true, shown: shown || target,
        });
        if (hit.ino === null) {
          // A dangling symlink is still a usable answer for a create as the final component:
          // writing through a broken link creates its target, which is why this returns the
          // target's parent rather than the link's.
          if (last) return hit;
          throw new FsError("ENOENT", shown);
        }
        if (last) return { dirIno: hit.dirIno, name: hit.name, ino: hit.ino };
        dirIno = hit.ino;
        continue;
      }

      if (last) return { dirIno, name: part, ino: childIno };
      dirIno = childIno;
    }
    // Unreachable: the loop returns on its last iteration.
    throw new FsError("EINVAL", shown);
  }

  #resolve(cred, path, { cwd = "/", followFinal = true } = {}) {
    if (typeof path !== "string" || path === "") throw new FsError("ENOENT", String(path));
    if (path.includes("\0")) throw new FsError("EINVAL", path, "A path may not contain NUL");
    const absolute = isAbsolute(path) ? path : joinPath(cwd, path);
    const hit = this.#lookup(cred, splitPath(absolute), this.rootIno, { followFinal, shown: path });
    return { ...hit, shown: path };
  }

  #existing(cred, path, options = {}) {
    const hit = this.#resolve(cred, path, options);
    if (hit.ino === null) throw new FsError("ENOENT", path);
    return { ...hit, inode: this.#inode(hit.ino) };
  }

  /** The directory a create writes into, with the name it writes. Never follows the final link. */
  #slot(cred, path, options = {}) {
    const hit = this.#resolve(cred, path, { ...options, followFinal: false });
    if (hit.dirIno === null || hit.name === "") throw new FsError("EEXIST", path);
    const dir = this.#inode(hit.dirIno);
    if (dir.type !== DIR) throw new FsError("ENOTDIR", path);
    return { ...hit, dir };
  }

  /* --------------------------- reading --------------------------- */

  stat(cred, path, options = {}) {
    return this.#info(this.#existing(cred, path, options).inode);
  }

  lstat(cred, path, options = {}) {
    return this.#info(this.#existing(cred, path, { ...options, followFinal: false }).inode);
  }

  /** No path, so no permission walk. */
  fstat(ino) {
    return this.#info(this.#inode(ino));
  }

  /**
   * The kernel's only way to tell an UNLINKED file from a corrupt image. `#inode` throws EIO for
   * both — correctly, because the VFS does not know file descriptions exist — so the one caller
   * that does hold a description asks this first and reports the two states apart.
   */
  holds(ino) {
    return this.inodes.has(ino);
  }

  /**
   * The input to the copy-on-write decision, separate from `fstat` because the append-vs-copy-up
   * test runs on every write and `#info` renders a mode string and a type-dependent size
   * (constraint 22's "open is rare, fd I/O is common"). Two file descriptions on one inode share
   * the file, so this — never a snapshot taken at open — is what a write is measured against.
   */
  committed(ino) {
    const inode = this.#inode(ino);
    if (inode.type !== FILE) throw new FsError("EINVAL", `inode ${ino}`, "Not a regular file");
    return { gen: inode.gen, size: inode.size };
  }

  /**
   * A broken symlink does not resolve. Only absence answers `false`: a name inside a directory
   * this credential may not look into is not absent, and reporting it as absent is how `mkdir -p`
   * ends up reporting EEXIST for a path it was refused.
   */
  exists(cred, path, options = {}) {
    try {
      this.stat(cred, path, options);
      return true;
    } catch (error) {
      if (error instanceof FsError && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        return false;
      }
      throw error;
    }
  }

  /**
   * The right to enter a directory and the right to list it are different bits, and `cd` wants the
   * first. Probing with a read would refuse a `--x` directory, which is a legal place to stand.
   */
  access(cred, path, bits, options = {}) {
    const { inode } = this.#existing(cred, path, options);
    this.#need(cred, inode, bits, path);
  }

  #info(inode) {
    return {
      ino: inode.ino,
      type: inode.type,
      mode: inode.mode,
      modeString: modeString(inode.type, inode.mode),
      nlink: inode.nlink,
      uid: inode.uid,
      gid: inode.gid,
      mtime: inode.mtime,
      ctime: inode.ctime,
      atime: inode.atime,
      // A file's size is the BYTE count of the blob generation the metadata points at.
      size: inode.type === DIR
        ? inode.entries.size
        : inode.type === LINK
          ? ENC.encode(inode.target).length
          : inode.size,
      gen: inode.type === FILE ? inode.gen : 0,
      target: inode.type === LINK ? inode.target : undefined,
    };
  }

  /** Insertion order. Sorting is the caller's business. */
  readdir(cred, path, options = {}) {
    const { inode } = this.#existing(cred, path, options);
    if (inode.type !== DIR) throw new FsError("ENOTDIR", path);
    this.#need(cred, inode, R, path);
    return [...inode.entries.keys()];
  }

  /** A directory's children by `lstat`, so a symlink in a listing reads as a symlink. */
  list(cred, path, options = {}) {
    const { inode } = this.#existing(cred, path, options);
    if (inode.type !== DIR) throw new FsError("ENOTDIR", path);
    this.#need(cred, inode, R, path);
    return [...inode.entries.entries()].map(([name, ino]) => ({
      name, ...this.#info(this.#inode(ino)),
    }));
  }

  /** For a readdir(fd, cookie) that has no path to re-walk. */
  listIno(ino) {
    const inode = this.#inode(ino);
    if (inode.type !== DIR) throw new FsError("ENOTDIR", `inode ${ino}`);
    return [...inode.entries.entries()].map(([name, child]) => ({
      name, ino: child, type: this.#inode(child).type,
    }));
  }

  readlink(cred, path, options = {}) {
    const { inode } = this.#existing(cred, path, { ...options, followFinal: false });
    if (inode.type !== LINK) throw new FsError("EINVAL", path);
    return inode.target;
  }

  /**
   * Every symlink resolved away, component by component, splicing a link's target back into the
   * queue: a link in the middle of a path changes what a later `..` means.
   */
  realpath(cred, path, { cwd = "/" } = {}) {
    let pending = splitPath(isAbsolute(path) ? path : joinPath(cwd, path));
    const out = [];
    let hops = 0;
    while (pending.length) {
      if (hops > MAX_LINKS) throw new FsError("ELOOP", path);
      const part = pending.shift();
      if (part === "..") {
        out.pop();
        continue;
      }
      const here = `/${[...out, part].join("/")}`;
      const { inode } = this.#existing(cred, here, { followFinal: false });
      if (inode.type === LINK) {
        hops += 1;
        const target = splitPath(inode.target);
        if (isAbsolute(inode.target)) out.length = 0;
        pending = [...target, ...pending];
        continue;
      }
      out.push(part);
    }
    return out.length ? `/${out.join("/")}` : "/";
  }

  /**
   * O_CREAT/O_EXCL/O_TRUNC's permission rules and NOTHING else: no blob, no handle, no I/O. The
   * decision the kernel then executes, which is what lets this stay pure while
   * `createSyncAccessHandle` lives in the I/O worker.
   *
   * @returns {{ino, type, created: op|null, needR: boolean, needW: boolean, gen, size}}
   */
  openDecision(cred, path, { cwd = "/", create = false, excl = false, wantR = false,
    wantW = false, wantX = false, dirOk = false, followFinal = true, mode = 0o644 } = {}) {
    const hit = this.#resolve(cred, path, { cwd, followFinal });
    if (hit.ino !== null) {
      if (create && excl) throw new FsError("EEXIST", path);
      const inode = this.#inode(hit.ino);
      if (inode.type === DIR && !dirOk) throw new FsError("EISDIR", path);
      if (inode.type === DIR && wantW) throw new FsError("EISDIR", path);
      if (wantR) this.#need(cred, inode, R, path);
      if (wantW) this.#need(cred, inode, W, path);
      // The exec check is here rather than in the loader so the mode bits have one interpreter
      // (`#may`, the only thing that knows root ignores read and write but still needs an execute
      // bit). `wantX` never creates: a caller asking to execute a file that is not there wants
      // ENOENT, not an empty file it then cannot run.
      if (wantX) this.#need(cred, inode, X, path);
      return {
        ino: inode.ino, type: inode.type, created: null,
        gen: inode.type === FILE ? inode.gen : 0, size: inode.type === FILE ? inode.size : 0,
      };
    }
    if (!create) throw new FsError("ENOENT", path);
    if (wantX) throw new FsError("ENOENT", path);
    const dir = this.#inode(hit.dirIno);
    if (dir.type !== DIR) throw new FsError("ENOTDIR", path);
    if (hit.name.length > NAME_MAX) throw new FsError("ENAMETOOLONG", path);
    this.#need(cred, dir, W, path);
    const op = {
      k: OP.CREATE, ino: this.nextIno, dir: dir.ino, name: hit.name,
      mode: mode & 0o7777, uid: cred.uid, gid: cred.gid, t: this.now(),
    };
    this.applyOp(op);
    return { ino: op.ino, type: FILE, created: op, gen: 0, size: 0 };
  }

  /* --------------------------- mutation: decide, then applyOp --------------------------- */

  mkdir(cred, path, { cwd = "/", mode = 0o755 } = {}) {
    const slot = this.#slot(cred, path, { cwd });
    if (slot.ino !== null) throw new FsError("EEXIST", path);
    if (slot.name.length > NAME_MAX) throw new FsError("ENAMETOOLONG", path);
    this.#need(cred, slot.dir, W, path);
    const op = {
      k: OP.MKDIR, ino: this.nextIno, dir: slot.dir.ino, name: slot.name,
      mode: mode & 0o7777, uid: cred.uid, gid: cred.gid, t: this.now(),
    };
    this.applyOp(op);
    return op;
  }

  rmdir(cred, path, { cwd = "/" } = {}) {
    const hit = this.#existing(cred, path, { cwd, followFinal: false });
    if (hit.inode.type !== DIR) throw new FsError("ENOTDIR", path);
    if (hit.inode.ino === this.rootIno) throw new FsError("EBUSY", path);
    if (hit.inode.entries.size) throw new FsError("ENOTEMPTY", path);
    const dir = this.#inode(hit.dirIno);
    this.#need(cred, dir, W, path);
    const op = { k: OP.RMDIR, dir: dir.ino, name: hit.name, ino: hit.inode.ino, t: this.now() };
    this.applyOp(op);
    return op;
  }

  /** The inode survives while another name still holds it — the whole of what a hard link is. The
   *  op records whether the last link went, because that is what tells the kernel a blob is free. */
  unlink(cred, path, { cwd = "/" } = {}) {
    const hit = this.#existing(cred, path, { cwd, followFinal: false });
    if (hit.inode.type === DIR) throw new FsError("EISDIR", path);
    const dir = this.#inode(hit.dirIno);
    this.#need(cred, dir, W, path);
    const op = { k: OP.UNLINK, dir: dir.ino, name: hit.name, ino: hit.inode.ino, t: this.now() };
    const freed = this.applyOp(op);
    return { ...op, freed: freed.freed };
  }

  symlink(cred, target, path, { cwd = "/" } = {}) {
    if (typeof target !== "string" || target === "") throw new FsError("EINVAL", path);
    const slot = this.#slot(cred, path, { cwd });
    if (slot.ino !== null) throw new FsError("EEXIST", path);
    this.#need(cred, slot.dir, W, path);
    // Stored verbatim, never resolved here: a symlink to a path that does not exist yet is legal
    // and useful, and resolving at creation would quietly turn a relative link into an absolute.
    const op = {
      k: OP.SYMLINK, ino: this.nextIno, dir: slot.dir.ino, name: slot.name, target,
      uid: cred.uid, gid: cred.gid, t: this.now(),
    };
    this.applyOp(op);
    return op;
  }

  /** A second name for one inode. Directories are refused, as on Linux. */
  link(cred, existing, path, { cwd = "/" } = {}) {
    const source = this.#existing(cred, existing, { cwd });
    if (source.inode.type === DIR) throw new FsError("EPERM", existing);
    const slot = this.#slot(cred, path, { cwd });
    if (slot.ino !== null) throw new FsError("EEXIST", path);
    this.#need(cred, slot.dir, W, path);
    const op = {
      k: OP.LINK, ino: source.inode.ino, dir: slot.dir.ino, name: slot.name, t: this.now(),
    };
    this.applyOp(op);
    return op;
  }

  rename(cred, from, to, { cwd = "/" } = {}) {
    const source = this.#existing(cred, from, { cwd, followFinal: false });
    const slot = this.#slot(cred, to, { cwd });
    const fromDir = this.#inode(source.dirIno);
    this.#need(cred, fromDir, W, from);
    this.#need(cred, slot.dir, W, to);

    if (source.inode.type === DIR) {
      // Moving a directory into its own subtree would detach it from the root and leave a ring:
      // reachable from itself, reachable from nothing else.
      for (let walk = slot.dir; ; walk = this.#inode(walk.parent)) {
        if (walk.ino === source.inode.ino) throw new FsError("EINVAL", to);
        if (walk.ino === this.rootIno) break;
      }
    }
    if (slot.ino !== null) {
      const target = this.#inode(slot.ino);
      if (target.ino === source.inode.ino) return null;
      if (target.type === DIR) {
        if (source.inode.type !== DIR) throw new FsError("EISDIR", to);
        if (target.entries.size) throw new FsError("ENOTEMPTY", to);
      } else if (source.inode.type === DIR) {
        throw new FsError("ENOTDIR", to);
      }
    }
    const op = {
      k: OP.RENAME, fromDir: fromDir.ino, fromName: source.name,
      toDir: slot.dir.ino, toName: slot.name, ino: source.inode.ino,
      replaced: slot.ino, t: this.now(),
    };
    const applied = this.applyOp(op);
    return { ...op, freed: applied.freed };
  }

  chmod(cred, path, mode, { cwd = "/" } = {}) {
    const { inode } = this.#existing(cred, path, { cwd });
    // Only the owner, as on Linux: a mode anyone may change is not a permission.
    if (cred.uid !== 0 && inode.uid !== cred.uid) throw new FsError("EPERM", path);
    const op = { k: OP.CHMOD, ino: inode.ino, mode: mode & 0o7777, t: this.now() };
    this.applyOp(op);
    return op;
  }

  chown(cred, path, uid, gid, { cwd = "/" } = {}) {
    const { inode } = this.#existing(cred, path, { cwd });
    // Only root may give a file away. A non-root chown that could change uid would let any
    // process hand its files to another identity and walk around the mode bits.
    if (cred.uid !== 0) {
      if (uid >= 0 && uid !== inode.uid) throw new FsError("EPERM", path);
      if (inode.uid !== cred.uid) throw new FsError("EPERM", path);
    }
    const op = {
      k: OP.CHOWN, ino: inode.ino,
      uid: uid < 0 ? inode.uid : uid, gid: gid < 0 ? inode.gid : gid, t: this.now(),
    };
    this.applyOp(op);
    return op;
  }

  utimes(cred, path, atime, mtime, { cwd = "/" } = {}) {
    const { inode } = this.#existing(cred, path, { cwd });
    this.#need(cred, inode, W, path);
    const op = { k: OP.UTIMES, ino: inode.ino, atime, mtime, t: this.now() };
    this.applyOp(op);
    return op;
  }

  /**
   * The COW swing, as metadata: move an inode's reference to `gen` and publish `size`.
   *
   * Called only after the new blob is written AND flushed (constraint 23's ordering: blob ->
   * flush -> journal -> flush -> apply in memory). This is the "apply in memory" step and the op
   * it returns is the journal record; it knows nothing about either blob, which keeps it pure.
   *
   * `prevGen` is recorded so the kernel knows which blob the swing freed without re-reading the
   * inode, and so fsck can say what an interrupted swing left behind.
   */
  commit(ino, gen, size, t) {
    const inode = this.#inode(ino);
    if (inode.type !== FILE) throw new FsError("EINVAL", `inode ${ino}`, "Not a regular file");
    const op = {
      k: OP.COMMIT, ino, gen, size, prevGen: inode.gen,
      t: t === undefined ? this.now() : t,
    };
    this.applyOp(op);
    return op;
  }

  /**
   * Every field a commit moves, so a caller can put them back. The pair with `revertCommit`.
   *
   * The kernel applies a commit in memory as its validation — `applyOp` refuses an op that cannot
   * be applied to this state, and a record must not reach the disk before that refusal
   * (src/kernel/store.mjs `commitOnce`). The apply therefore precedes the journal append, and an
   * append that fails leaves the tree holding a generation no record names: the running kernel
   * publishes it and the next mount does not.
   *
   * It lives here and not in the kernel because `inode.gen` has one writer; a copy in the storage
   * edge would drift the first time `applyOp`'s COMMIT arm moved a field this does not.
   *
   * Not journalled: the record it undoes never landed, so there is nothing for replay to be told.
   * It is also not reachable through `applyOp`, where a generation moving BACKWARDS is corruption
   * — exactly the shape of a legitimate undo.
   */
  commitState(ino) {
    const inode = this.#inode(ino);
    if (inode.type !== FILE) throw new FsError("EINVAL", `inode ${ino}`, "Not a regular file");
    // `opSeq` is part of the state a commit moves: `applyOp` bumps it on every op and it is
    // serialized into the image. Left advanced by the undo, the image claims more ops were applied
    // than the journal and the tree between them can name.
    return { gen: inode.gen, size: inode.size, mtime: inode.mtime, ctime: inode.ctime,
      opSeq: this.opSeq };
  }

  /** The one undo in this module. */
  revertCommit(ino, state) {
    const inode = this.#inode(ino);
    if (inode.type !== FILE) throw new FsError("EINVAL", `inode ${ino}`, "Not a regular file");
    // A state with no `opSeq` is refused rather than written: assigning `undefined` would put the
    // image's op count back as 0 on the next parse, which is a worse answer than the one this undo
    // was asked to restore.
    if (!Number.isInteger(state.opSeq)) {
      throw new FsError("EINVAL", `inode ${ino}`,
        "a commitState with no opSeq cannot be put back exactly");
    }
    inode.gen = state.gen;
    inode.size = state.size;
    inode.mtime = state.mtime;
    inode.ctime = state.ctime;
    this.opSeq = state.opSeq;
  }

  /**
   * The ONE executor: a mutating method above calls this, and journal replay calls it with the op
   * it decoded. A replay implemented beside the writer would drift from it.
   *
   * Refuses rather than guesses. An op naming a missing inode, a missing name or a colliding name
   * cannot be applied to this state, and reporting that instead of building a tree nobody wrote is
   * fsck's whole job (constraint 28).
   *
   * @returns {{freed: number|null}} the inode whose last link went, for the caller that frees its
   *          blob. `null` when nothing was freed.
   */
  applyOp(op) {
    const stamp = (inode) => {
      inode.mtime = op.t;
      inode.ctime = op.t;
    };
    const dirOf = (ino, what) => {
      const dir = this.inodes.get(ino);
      if (!dir) throw new FsError("EIO", `${op.k}`, `names directory inode ${ino}, which is absent`);
      if (dir.type !== DIR) throw new FsError("EIO", `${op.k}`, `inode ${ino} is not a directory`);
      return dir;
    };
    let freed = null;

    switch (op.k) {
      case OP.MKDIR: {
        const dir = dirOf(op.dir);
        if (dir.entries.has(op.name)) {
          throw new FsError("EEXIST", op.name, `${op.k} onto a name that already exists`);
        }
        const inode = this.#alloc(DIR, op);
        inode.parent = dir.ino;
        dir.entries.set(op.name, inode.ino);
        // The child's `..` is a reference to its parent, which is what the link count counts.
        dir.nlink += 1;
        stamp(dir);
        break;
      }
      case OP.CREATE: {
        const dir = dirOf(op.dir);
        if (dir.entries.has(op.name)) {
          throw new FsError("EEXIST", op.name, `${op.k} onto a name that already exists`);
        }
        const inode = this.#alloc(FILE, op);
        dir.entries.set(op.name, inode.ino);
        stamp(dir);
        break;
      }
      case OP.SYMLINK: {
        const dir = dirOf(op.dir);
        if (dir.entries.has(op.name)) {
          throw new FsError("EEXIST", op.name, `${op.k} onto a name that already exists`);
        }
        const inode = this.#alloc(LINK, { ...op, mode: 0o777 });
        inode.target = String(op.target);
        dir.entries.set(op.name, inode.ino);
        stamp(dir);
        break;
      }
      case OP.LINK: {
        const dir = dirOf(op.dir);
        const inode = this.#inode(op.ino);
        if (dir.entries.has(op.name)) {
          throw new FsError("EEXIST", op.name, `${op.k} onto a name that already exists`);
        }
        dir.entries.set(op.name, inode.ino);
        inode.nlink += 1;
        inode.ctime = op.t;
        stamp(dir);
        break;
      }
      case OP.RMDIR: {
        const dir = dirOf(op.dir);
        const child = dir.entries.get(op.name);
        if (child === undefined) throw new FsError("ENOENT", op.name, `${op.k} of a missing name`);
        const inode = this.#inode(child);
        if (inode.type !== DIR) throw new FsError("ENOTDIR", op.name);
        if (inode.entries.size) throw new FsError("ENOTEMPTY", op.name);
        dir.entries.delete(op.name);
        dir.nlink -= 1;
        this.inodes.delete(inode.ino);
        stamp(dir);
        break;
      }
      case OP.UNLINK: {
        const dir = dirOf(op.dir);
        const child = dir.entries.get(op.name);
        if (child === undefined) throw new FsError("ENOENT", op.name, `${op.k} of a missing name`);
        const inode = this.#inode(child);
        dir.entries.delete(op.name);
        inode.nlink -= 1;
        if (inode.nlink <= 0) {
          this.inodes.delete(inode.ino);
          freed = inode.ino;
        }
        stamp(dir);
        break;
      }
      case OP.RENAME: {
        const fromDir = dirOf(op.fromDir);
        const toDir = dirOf(op.toDir);
        const moving = fromDir.entries.get(op.fromName);
        if (moving === undefined) {
          throw new FsError("ENOENT", op.fromName, `${op.k} of a missing name`);
        }
        const inode = this.#inode(moving);
        const standing = toDir.entries.get(op.toName);
        if (standing !== undefined) {
          const target = this.#inode(standing);
          toDir.entries.delete(op.toName);
          if (target.type === DIR) {
            toDir.nlink -= 1;
            this.inodes.delete(target.ino);
          } else {
            target.nlink -= 1;
            if (target.nlink <= 0) {
              this.inodes.delete(target.ino);
              freed = target.ino;
            }
          }
        }
        fromDir.entries.delete(op.fromName);
        toDir.entries.set(op.toName, inode.ino);
        if (inode.type === DIR) {
          inode.parent = toDir.ino;
          if (fromDir.ino !== toDir.ino) {
            fromDir.nlink -= 1;
            toDir.nlink += 1;
          }
        }
        inode.ctime = op.t;
        stamp(fromDir);
        if (toDir !== fromDir) stamp(toDir);
        break;
      }
      case OP.CHMOD: {
        const inode = this.#inode(op.ino);
        inode.mode = op.mode & 0o7777;
        inode.ctime = op.t;
        break;
      }
      case OP.CHOWN: {
        const inode = this.#inode(op.ino);
        inode.uid = op.uid;
        inode.gid = op.gid;
        inode.ctime = op.t;
        break;
      }
      case OP.UTIMES: {
        const inode = this.#inode(op.ino);
        inode.atime = op.atime;
        inode.mtime = op.mtime;
        inode.ctime = op.t;
        break;
      }
      case OP.COMMIT: {
        const inode = this.#inode(op.ino);
        if (inode.type !== FILE) throw new FsError("EINVAL", `inode ${op.ino}`, "Not a file");
        // Replay's sequence rule already excludes a record arriving after a newer snapshot, so a
        // generation moving BACKWARDS means the journal and the snapshot disagree: corruption,
        // not an update.
        if (op.gen < inode.gen) {
          throw new FsError("EIO", `inode ${op.ino}`,
            `commit moves generation ${inode.gen} back to ${op.gen}`);
        }
        inode.gen = op.gen;
        inode.size = op.size;
        stamp(inode);
        break;
      }
      default:
        throw new FsError("EINVAL", String(op.k), "Unknown op");
    }
    this.opSeq += 1;
    return { freed };
  }

  /* --------------------------- accounting --------------------------- */

  /** What `statfs` reports, minus the ceiling: byte totals are the committed blob sizes, and only
   *  the kernel can ask the storage quota, so it adds that. */
  stats() {
    let files = 0;
    let dirs = 0;
    let links = 0;
    let bytes = 0;
    for (const inode of this.inodes.values()) {
      if (inode.type === DIR) dirs += 1;
      else if (inode.type === LINK) links += 1;
      else {
        files += 1;
        bytes += inode.size;
      }
    }
    return { files, dirs, links, inodes: this.inodes.size, bytes, nextIno: this.nextIno };
  }

  /** Every blob name a healthy volume should hold. fsck compares it against what the directory
   *  actually has, which is how a lost blob is found. */
  blobNames() {
    const out = [];
    for (const inode of this.inodes.values()) {
      if (inode.type === FILE && inode.gen > 0) {
        out.push({ name: blobName(inode.ino, inode.gen), ino: inode.ino, size: inode.size });
      }
    }
    return out;
  }

  /* --------------------------- persistence --------------------------- */

  /**
   * A plain object `JSON.stringify` can take. Inode numbers are the whole structure.
   *
   * REACHABILITY is the invariant: an inode no path can reach is reported rather than written, so
   * it cannot count against a quota or be tallied by `df` with no way to reach it.
   */
  serialize() {
    const reachable = new Set([this.rootIno]);
    const queue = [this.rootIno];
    while (queue.length) {
      const dir = this.inodes.get(queue.shift());
      if (!dir || dir.type !== DIR) continue;
      for (const ino of dir.entries.values()) {
        if (reachable.has(ino)) continue;
        reachable.add(ino);
        queue.push(ino);
      }
    }
    const orphans = [...this.inodes.keys()].filter((ino) => !reachable.has(ino));
    return {
      version: FORMAT_VERSION,
      nextIno: this.nextIno,
      rootIno: this.rootIno,
      opSeq: this.opSeq,
      // Reported, never silently dropped: an orphan is a leak the kernel can collect on an idle
      // task (constraint 33 forbids an orphan sweep at boot).
      orphans,
      inodes: [...this.inodes.values()].map((inode) => {
        const row = {
          ino: inode.ino, type: inode.type, mode: inode.mode, uid: inode.uid, gid: inode.gid,
          nlink: inode.nlink, mtime: inode.mtime, ctime: inode.ctime, atime: inode.atime,
        };
        if (inode.type === DIR) {
          row.parent = inode.parent;
          row.entries = [...inode.entries.entries()];
        } else if (inode.type === LINK) {
          row.target = inode.target;
        } else {
          row.size = inode.size;
          row.gen = inode.gen;
        }
        return row;
      }),
    };
  }

  /**
   * Rebuild from `serialize`'s output, refusing anything that would not hold together.
   *
   * Validated rather than trusted: the input is bytes off a disk a half-finished write may have
   * torn, and an inode number pointing at nothing would otherwise surface much later as a
   * directory that cannot be listed. It NEVER reseeds (constraint 28); the caller mounts
   * read-only.
   */
  static parse(data, options = {}) {
    const bad = (why) => {
      throw new FsError("EIO", "filesystem image", why);
    };
    if (!data || typeof data !== "object") bad("not an object");
    if (data.version !== FORMAT_VERSION) {
      bad(`version ${JSON.stringify(data.version)}, this code reads ${FORMAT_VERSION}`);
    }
    if (!Array.isArray(data.inodes) || !data.inodes.length) bad("no inodes");

    const fs = new VFS({ ...options, empty: true });
    for (const row of data.inodes) {
      if (!Number.isInteger(row.ino) || row.ino < 1) bad(`inode number ${JSON.stringify(row.ino)}`);
      if (![DIR, FILE, LINK].includes(row.type)) bad(`inode ${row.ino} has type ${row.type}`);
      if (fs.inodes.has(row.ino)) bad(`inode ${row.ino} appears twice`);
      const inode = {
        ino: row.ino,
        type: row.type,
        // Strict, not defaulted: an image whose mode column was lost would come back as a tree of
        // plausible files, and the 10k-file proof would compare two copies of one default and pass.
        mode: Number.isInteger(row.mode) ? row.mode : bad(`inode ${row.ino} has no mode`),
        uid: Number.isInteger(row.uid) ? row.uid : bad(`inode ${row.ino} has no uid`),
        gid: Number.isInteger(row.gid) ? row.gid : bad(`inode ${row.ino} has no gid`),
        nlink: Number.isInteger(row.nlink) ? row.nlink : bad(`inode ${row.ino} has no nlink`),
        mtime: Number.isFinite(row.mtime) ? row.mtime : bad(`inode ${row.ino} has no mtime`),
        ctime: Number.isFinite(row.ctime) ? row.ctime : bad(`inode ${row.ino} has no ctime`),
        atime: Number.isFinite(row.atime) ? row.atime : bad(`inode ${row.ino} has no atime`),
      };
      if (row.type === DIR) {
        // Not defaulted to empty: a directory whose entry list is the wrong shape would restore a
        // tree with every file silently missing.
        if (!Array.isArray(row.entries)) bad(`inode ${row.ino} has no entry list`);
        inode.entries = new Map();
        for (const entry of row.entries) {
          if (!Array.isArray(entry) || entry.length !== 2
              || typeof entry[0] !== "string" || !entry[0]
              || !Number.isInteger(entry[1])) {
            bad(`inode ${row.ino} has an entry that is not [name, ino]`);
          }
          if (inode.entries.has(entry[0])) bad(`inode ${row.ino} has ${entry[0]} twice`);
          inode.entries.set(entry[0], entry[1]);
        }
        inode.parent = Number.isInteger(row.parent) ? row.parent : bad(`inode ${row.ino} parent`);
      } else if (row.type === LINK) {
        // An empty target is a link to nothing, and a target defaulted to '' is a link whose
        // destination was quietly dropped.
        if (typeof row.target !== "string" || row.target === "") {
          bad(`inode ${row.ino} has no symlink target`);
        }
        inode.target = row.target;
      } else {
        if (!Number.isInteger(row.size) || row.size < 0) bad(`inode ${row.ino} has no size`);
        if (!Number.isInteger(row.gen) || row.gen < 0) bad(`inode ${row.ino} has no generation`);
        // A file with bytes and no blob to hold them is the one inconsistency this format can
        // state in a single row, so it is caught here rather than left to the blob sweep.
        if (row.size > 0 && row.gen === 0) {
          bad(`inode ${row.ino} claims ${row.size} B and generation 0, which names no blob`);
        }
        inode.size = row.size;
        inode.gen = row.gen;
      }
      fs.inodes.set(inode.ino, inode);
    }

    const rootIno = Number.isInteger(data.rootIno) ? data.rootIno : ROOT_INO;
    const root = fs.inodes.get(rootIno);
    if (!root || root.type !== DIR) bad("no root directory");
    fs.rootIno = rootIno;
    for (const inode of fs.inodes.values()) {
      if (inode.type !== DIR) continue;
      if (!fs.inodes.has(inode.parent)) {
        bad(`inode ${inode.ino} has parent ${inode.parent}, which is absent`);
      }
      for (const [name, ino] of inode.entries) {
        if (!fs.inodes.has(ino)) bad(`${name} points at missing inode ${ino}`);
      }
    }
    // Walked rather than spread into Math.max: an image with more inodes than the argument limit
    // would throw a RangeError here, which is a stack trace instead of a filesystem.
    let highest = rootIno;
    for (const ino of fs.inodes.keys()) if (ino > highest) highest = ino;
    fs.nextIno = Math.max(Number.isInteger(data.nextIno) ? data.nextIno : 0, highest + 1);
    fs.opSeq = Number.isInteger(data.opSeq) ? data.opSeq : 0;
    return fs;
  }
}

/**
 * The ONE place a blob name is formed.
 *
 * Constraint 26 keeps the directory flat and named by inode — not a workaround: it is what makes
 * rename O(1) and hard links expressible. A copy-on-write overwrite needs a name that is not yet
 * the inode's, so the suffix says which generation, and exactly one of them at a time is the one
 * the metadata points at.
 */
export function blobName(ino, gen) {
  return `${ino}.${gen}`;
}

/** The inverse, for the blob sweep. Null for a name that is not a blob. */
export function parseBlobName(name) {
  const m = /^(\d+)\.(\d+)$/.exec(name);
  if (!m) return null;
  return { ino: Number(m[1]), gen: Number(m[2]) };
}
