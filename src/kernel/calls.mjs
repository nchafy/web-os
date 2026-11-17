// The syscall table: one HANDLERS entry per SYS_NAME, so the dispatch table is DERIVED from
// src/abi.mjs at boot. A handler returns a value or PENDING, and MUST NOT touch SEQ, STATUS, RLEN,
// the notify or G_INFLIGHT — reply() in kernel.mjs is the only writer of those.

import {
  A0, A1, A2, A3, LEN_I32, DATA_OFF, MAX_INLINE, NSYS, SYS_NAME,
  EBADF, EINVAL, ENOSYS, EIO, EAGAIN, EPERM, EINTR, ECHILD, ESRCH,
  ENOENT, ENOTDIR, EISDIR, EACCES, ENAMETOOLONG, EROFS, ESPIPE, EOVERFLOW, EMFILE,
  ELIMIT_ERRNO, FD_INFLIGHT_CAP, OPEN_MAX, STAT_EXITED, STAT_KILLED, WNOHANG,
  SIGKILL, SIGSTOP, SIG_DFL, SIG_IGN, SIG_HANDLE, SIG_BIT,
  O_ACCMODE, O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_APPEND,
  O_DIRECTORY, O_NOFOLLOW, SEEK_SET, SEEK_CUR, SEEK_END,
  S_IFREG, S_IFDIR, S_IFLNK, FILESTAT_BYTES, DIRENT_HEADER, DT_DIR, DT_REG, DT_LNK, DT_UNKNOWN,
  F_FILE, F_SYNTH, F_TMP, F_PIPE_R, F_PIPE_W, F_TTY, F_PTY_M, F_WIN, EXDEV, ENOTTY,
  TERMIOS_BYTES, WINSIZE_BYTES, POLLFD_BYTES, PFD_FD, PFD_EVENTS, PFD_REVENTS,
  POLLIN, POLLOUT, POLLERR, POLLHUP, POLLNVAL, TIOCGPGRP, TIOCSPGRP, ST_RETURN,
  encodeTermios, decodeTermios, encodeWinsize,
  encodeFilestat, encodeStatfs, direntSize, DE_INO, DE_TYPE, DE_NLEN, STATFS_BYTES,
  unpackI64, packI64,
} from "../abi.mjs";
import { KIND_OPS } from "./files.mjs";
import { Pipe } from "./pipe.mjs";
import { Pty } from "./pty.mjs";
import { errnoOfFsError } from "./store.mjs";
import {
  DIR, FILE, LINK, NAME_MAX, isAbsolute, joinPath, normalize,
} from "../fs/vfs.mjs";
import { ZOMBIE, RUNNING, dropCaps } from "./table.mjs";

/** A handler that will reply later, by calling k.reply() itself. */
export const PENDING = Symbol("PENDING");

/** An ops method MAY return a promise; the call then becomes PENDING and later() answers it. */
function settle(k, p, r) {
  if (r && typeof r.then === "function") {
    k.later(p, () => r);
    return PENDING;
  }
  return r;
}

/** The per-fd in-flight budget, charged BEFORE the handler runs and discharged at reply. It lives
 *  on the DESCRIPTION, not on the FileTable row, so one fd at ELIMIT does not stop the other handle
 *  of the same description. */
function chargeFd(d) {
  if ((d.inflight | 0) >= (d.cap | 0 || FD_INFLIGHT_CAP)) return -ELIMIT_ERRNO;
  d.inflight = (d.inflight | 0) + 1;
  return 0;
}

function dischargeFd(d) {
  if (!d) return;
  d.inflight = Math.max(0, (d.inflight | 0) - 1);
}

/** The one path-argument reader; returns the path, or -errno. `TextDecoder.decode` REFUSES a view
 *  backed by a SharedArrayBuffer, so the copy into a fresh buffer makes the decode legal. */
const DECODER = new TextDecoder("utf-8", { fatal: false });

function readPath(p) {
  const length = Atomics.load(p.ctl, LEN_I32);
  if (length <= 0 || length > MAX_INLINE) return -EINVAL;
  const bytes = new Uint8Array(p.bytes.subarray(DATA_OFF, DATA_OFF + length));
  const text = DECODER.decode(bytes);
  if (text.includes("\0")) return -EINVAL;
  if (text.length > 4096) return -ENAMETOOLONG;
  return text;
}

/** Two paths, NUL-joined, as docs/ABI.md's `rename` specifies. */
function readTwoPaths(p) {
  const length = Atomics.load(p.ctl, LEN_I32);
  if (length <= 0 || length > MAX_INLINE) return -EINVAL;
  const bytes = new Uint8Array(p.bytes.subarray(DATA_OFF, DATA_OFF + length));
  const text = DECODER.decode(bytes);
  const cut = text.indexOf("\0");
  if (cut <= 0 || cut === text.length - 1) return -EINVAL;
  const first = text.slice(0, cut);
  const second = text.slice(cut + 1);
  if (second.includes("\0")) return -EINVAL;
  return [first, second];
}

/** The credential, built per call and handed to the VFS as an argument (constraint 29). */
export function credOf(p) {
  return { uid: p.uid, gid: p.gid };
}

function replyBytes(p, bytes) {
  if (bytes.length > MAX_INLINE) return -EOVERFLOW;
  p.bytes.set(bytes, DATA_OFF);
  p.rlen = bytes.length;
  return bytes.length;
}

const TYPE_BITS = { [FILE]: S_IFREG, [DIR]: S_IFDIR, [LINK]: S_IFLNK };
const DIRENT_TYPE = { [FILE]: DT_REG, [DIR]: DT_DIR, [LINK]: DT_LNK };

/** A VFS stat object as a 64-byte Filestat in the caller's byte region. */
function writeStat(p, info, dev = 0) {
  const record = new Uint8Array(FILESTAT_BYTES);
  encodeFilestat(new DataView(record.buffer), 0, {
    // src/fs/mounts.mjs numbers devices from 1, so a zero here means nobody set it.
    dev: info.dev !== undefined ? info.dev : dev,
    ino: info.ino,
    mode: (TYPE_BITS[info.type] ?? 0) | (info.mode & 0o7777),
    nlink: info.nlink,
    uid: info.uid,
    gid: info.gid,
    size: info.size,
    atimeNs: BigInt(Math.trunc(info.atime)) * 1000000n,
    mtimeNs: BigInt(Math.trunc(info.mtime)) * 1000000n,
    ctimeNs: BigInt(Math.trunc(info.ctime)) * 1000000n,
  });
  return replyBytes(p, record);
}

/**
 * A metadata mutation: decide in the VFS, then journal. The append is NOT flushed — constraint 23's
 * flush points are fsync, snapshot and idle. `freed`, the inode whose last link went, is reclaimed
 * AFTER the op is journalled: a blob deleted ahead of the record that unlinks it reappears after
 * replay with nothing behind it.
 */
function metaOp(p, k, path, decide) {
  if (!k.store || !k.store.vfs) return -EIO;
  const at = resolveMount(p, k, path);
  if (typeof at === "number") return at;
  if (mountReadOnly(k, at.mount)) return -EROFS;
  let op;
  try {
    op = decide(at.mount.fs, at.rel, credOf(p));
  } catch (error) {
    return errnoOfFsError(error);
  }
  // A mount with no durable state has nothing to journal: journaling a tmpfs mkdir would append a
  // record describing the OPFS volume, and replay would invent the directory there.
  if (!at.mount.durable) return 0;
  // `null` is a legal no-op: rename of a name onto itself. POSIX says that succeeds.
  if (op === null) return 0;
  const { freed, ...record } = op;
  k.later(p, async () => {
    const r = await k.store.journal(record);
    if (r < 0) return r;
    if (freed) await k.store.freeInode(freed);
    return 0;
  });
  return PENDING;
}

/** A metadata read: no journal, no await, so it answers on the dispatch thread. */
function metaRead(p, k, path, read) {
  if (!k.store || !k.store.vfs) return -EIO;
  const at = resolveMount(p, k, path);
  if (typeof at === "number") return at;
  try {
    return read(at.mount.fs, at.rel, credOf(p), at.mount);
  } catch (error) {
    return errnoOfFsError(error);
  }
}

/**
 * A process-supplied path to the filesystem that owns it; the one place the mount table is read.
 * The path is made absolute against the cwd FIRST, then the mount is resolved: the other order asks
 * which filesystem owns `../x`. A symlink is resolved INSIDE the filesystem holding it, so one on
 * the OPFS volume pointing into `/proc` reaches ENOENT — cross-mount traversal is not implemented.
 */
export function resolveMount(p, k, path) {
  const table = k.mounts;
  if (!table) return -EIO;
  const abs = absoluteOf(p, path);
  let at;
  try {
    at = table.resolve(abs);
  } catch (error) {
    return errnoOfFsError(error);
  }
  // THE ROOT MOUNT GETS THE PATH AS GIVEN, with `..` intact, because it is the only filesystem that
  // resolves `..` against the real parent and follows symlinks first — which is what makes
  // `stat("/missing/../x")` an ENOENT. `MountTable.resolve` must normalize LEXICALLY to pick the
  // mount, and handing that string on pops `..` textually and loses both. The other mounts have no
  // symlinks, so for them the lexical answer IS the answer.
  if (at.mount.path === "/") return { mount: at.mount, rel: abs };
  return at;
}

/** Absolute against the caller's cwd. NOT normalized: see `resolveMount`. */
function absoluteOf(p, path) {
  return isAbsolute(path) ? path : joinPath(p.cwd || "/", path);
}

/** Whether a mount refuses a write RIGHT NOW. The row's flag is a boot-time fact and WRONG for the
 *  OPFS volume, which `src/kernel/store.mjs` demotes at runtime after a failed snapshot
 *  (constraint 28), so a durable mount asks the store instead. */
function mountReadOnly(k, mount) {
  if (mount.durable) return !!(k.store && k.store.readOnly);
  return mount.readOnly;
}

/**
 * A PARKED call: `null` from an ops row means the kind holds a record and will reply when an event
 * unblocks it. It MUST be tested before the thenable check and before any numeric use, because
 * `null >= 0` is true and `null | 0` is 0 — a parked read would answer 0, which on a pipe is EOF.
 *
 * The per-fd budget is RELEASED at the park: a park is indefinite, and holding the charge would
 * refuse the 65th blocking reader on a shared pipe. Parked records are bounded instead by one
 * outstanding call per process, and processes by constraint 17.
 */
function isParked(r) {
  return r === null;
}

/** `metaRead`'s sibling for an fd: `readdir` never sees a path, so there is no mount to resolve. */
function dirRead(p, k, d, read) {
  if (!k.store || !k.store.vfs) return -EIO;
  try {
    return read();
  } catch (error) {
    return errnoOfFsError(error);
  }
}

/** `rename` and `link`: two paths that must land on ONE mount, else EXDEV. The VFS's rename is a
 *  metadata edit and could not express a cross-mount copy-plus-unlink. */
function twoPathOp(p, k, paths, decide) {
  if (!k.store || !k.store.vfs) return -EIO;
  const a = resolveMount(p, k, paths[0]);
  if (typeof a === "number") return a;
  const b = resolveMount(p, k, paths[1]);
  if (typeof b === "number") return b;
  if (a.mount !== b.mount) return -EXDEV;
  return metaOp(p, k, paths[1], (fs, rel, cred) => decide(fs, a.rel, b.rel, cred));
}

const HANDLERS = {};

HANDLERS.getpid = (p) => p.pid;
HANDLERS.getppid = (p) => p.ppid;
/** getpgid(pid) — THE TARGET's group, not the caller's. 0 means self. */
HANDLERS.getpgid = (p, k) => {
  const pid = p.ctl[A0] | 0;
  if (pid === 0 || pid === p.pid) return p.pgid;
  if (pid < 0) return -EINVAL;
  const target = k.table.get(pid);
  if (!target) return -ESRCH;
  return target.pgid;
};

HANDLERS.write = (p, k) => {
  const fd = p.ctl[A0];
  const length = Atomics.load(p.ctl, LEN_I32);
  if (length < 0 || length > MAX_INLINE) return -EINVAL;
  const d = p.fds.get(fd);
  if (!d) return -EBADF;
  const ops = KIND_OPS[d.kind];
  if (!ops || !ops.write) return -ENOSYS;
  const charged = chargeFd(d);
  if (charged < 0) return charged;
  const r = ops.write(d, p.bytes, DATA_OFF, length, p);
  if (isParked(r)) {
    dischargeFd(d);
    return PENDING;
  }
  if (r && typeof r.then === "function") {
    k.later(p, () => r.finally(() => dischargeFd(d)));
    return PENDING;
  }
  dischargeFd(d);
  return r;
};

/** open(flags, mode), with the path in the byte region. Constraint 24 is satisfied here and nowhere
 *  else: the path is resolved to an inode ONCE, in the kernel, and the process gets back an fd. */
HANDLERS.open = (p, k) => {
  if (!k.store || !k.store.vfs) return -EIO;
  const path = readPath(p);
  if (typeof path === "number") return path;
  const flags = p.ctl[A0] | 0;
  const mode = p.ctl[A1] | 0;
  const access = flags & O_ACCMODE;
  if (access === 3) return -EINVAL;
  const wantW = access === O_WRONLY || access === O_RDWR;
  const wantR = access === O_RDONLY || access === O_RDWR;
  const at = resolveMount(p, k, path);
  if (typeof at === "number") return at;
  // A CHARACTER DEVICE IS THE ONE EXCEPTION to the mount's read-only flag: `/dev` is MNT_RO because
  // its TREE cannot change, and writing to `/dev/console` changes no tree. O_CREAT is still denied.
  const chardev = at.mount.fs.chardevAt ? at.mount.fs.chardevAt(at.rel) : null;
  if (((flags & O_CREAT) || (wantW && !chardev)) && mountReadOnly(k, at.mount)) return -EROFS;
  let decision;
  try {
    decision = at.mount.fs.openDecision(credOf(p), at.rel, {
      create: (flags & O_CREAT) !== 0,
      excl: (flags & O_EXCL) !== 0,
      wantR, wantW,
      dirOk: (flags & O_DIRECTORY) !== 0,
      followFinal: (flags & O_NOFOLLOW) === 0,
      mode,
    });
  } catch (error) {
    return errnoOfFsError(error);
  }
  // A tmpfs description is answered on the dispatch thread: no journal, no blob, nothing to await.
  if (decision.tmpfs) {
    const d = {
      kind: F_TMP,
      refs: 1,
      flags,
      type: decision.type,
      ino: decision.ino,
      dev: decision.dev,
      pos: 0,
      fs: at.mount.fs,
      rel: decision.rel,
      info: decision.info,
      inflight: 0,
    };
    if ((flags & O_TRUNC) && wantW && d.type === FILE) {
      try {
        at.mount.fs.truncate(d.ino, 0);
      } catch (error) {
        return errnoOfFsError(error);
      }
    }
    // O_APPEND IS NOT A SEEK AT OPEN: the offset is resolved per write from `d.flags`. Setting
    // `d.pos` to the size here makes two `>>` descriptions share an end offset and both overwrite.
    return p.fds.add(d);
  }
  // A character device: the description is a kernel OBJECT, not bytes. The node exists in `/dev`
  // whether or not a window was attached, because the mount table is static at boot
  // (constraint 78), so a name with no device behind it is -ENXIO and not ENOENT.
  if (decision.chardev) {
    const d = k.chardev(decision.chardev, flags, decision);
    if (typeof d === "number") return d;
    const fd = p.fds.add(d);
    // Undone on failure, or the device counts an open the caller was never told about.
    if (fd < 0) KIND_OPS[d.kind].close(d);
    return fd;
  }
  if (decision.synth) {
    const d = {
      kind: F_SYNTH,
      refs: 1,
      flags,
      type: decision.type,
      ino: decision.ino,
      dev: decision.dev,
      pos: 0,
      bytes: decision.bytes,
      info: decision.info,
      // So `readdir` can ask the right one; F_FILE leaves it undefined and falls back to the VFS.
      fs: at.mount.fs,
      rel: decision.rel,
      inflight: 0,
    };
    return p.fds.add(d);
  }
  k.later(p, async () => {
    if (decision.created) {
      const r = await k.store.journal(decision.created);
      if (r < 0) return r;
    }
    const d = await k.store.openFd(decision);
    if (typeof d === "number") return d;
    d.kind = F_FILE;
    d.refs = 1;
    d.flags = flags;
    if ((flags & O_TRUNC) && wantW && d.type === FILE) {
      // POSIX truncates as part of `open`, so the commit belongs here: left uncommitted, a
      // concurrent `stat` reports the old size of a file the caller was told was empty.
      const t = await k.store.truncateFd(d, 0);
      if (t < 0) {
        await k.store.closeFd(d);
        return t;
      }
      const c = await k.store.fsyncFd(d);
      if (c < 0) {
        // The staged truncation goes with the failed open and must be discarded EXPLICITLY:
        // `closeFd` commits whatever is staged.
        await k.store.dropStaging(d);
        await k.store.closeFd(d);
        return c;
      }
    }
    // O_APPEND is resolved per write (src/kernel/store.mjs `writeHeld`), so the offset here is 0.
    const fd = p.fds.add(d);
    if (fd < 0) {
      // The sync access handle goes with the failed open. `createSyncAccessHandle` is AN EXCLUSIVE
      // LOCK PER FILE, so not closing it leaves the file unopenable for the lifetime of the page.
      await k.store.closeFd(d);
      return fd;
    }
    return fd;
  });
  return PENDING;
};

/** fsync, a separate syscall from write (constraint 23), and the one the I/O worker exists for:
 *  `flush()` is SYNCHRONOUS, so inline it holds the kernel thread (constraint 58). */
HANDLERS.fsync = (p, k) => {
  const d = p.fds.get(p.ctl[A0]);
  if (!d) return -EBADF;
  const ops = KIND_OPS[d.kind];
  if (!ops || !ops.fsync) return -ENOSYS;
  const charged = chargeFd(d);
  if (charged < 0) return charged;
  const r = ops.fsync(d, p);
  if (r && typeof r.then === "function") {
    k.later(p, () => r.finally(() => dischargeFd(d)));
    return PENDING;
  }
  dischargeFd(d);
  return r;
};

/** close(fd). The last reference runs the kind's close op, which for F_FILE returns a promise. */
HANDLERS.close = (p, k) => {
  const fd = p.ctl[A0] | 0;
  if (!p.fds.get(fd)) return -EBADF;
  return settle(k, p, p.fds.close(fd));
};

HANDLERS.read = (p, k) => {
  const length = p.ctl[A1] | 0;
  if (length < 0 || length > MAX_INLINE) return -EINVAL;
  const d = p.fds.get(p.ctl[A0]);
  if (!d) return -EBADF;
  if (d.type === DIR) return -EISDIR;
  const ops = KIND_OPS[d.kind];
  if (!ops || !ops.read) return -ENOSYS;
  const charged = chargeFd(d);
  if (charged < 0) return charged;
  const r = ops.read(d, p, DATA_OFF, length);
  if (isParked(r)) {
    dischargeFd(d);
    return PENDING;
  }
  if (r && typeof r.then === "function") {
    k.later(p, () => r.then((n) => {
      dischargeFd(d);
      // The I/O worker read straight into the caller's SAB; RLEN is the count.
      if (n >= 0) p.rlen = n;
      return n;
    }, (e) => {
      dischargeFd(d);
      throw e;
    }));
    return PENDING;
  }
  dischargeFd(d);
  if (r >= 0) p.rlen = r;
  return r;
};

/** pread/pwrite: the same two ops at an explicit (lo, hi) offset, which the description's cursor
 *  never sees. The offset travels as an ARGUMENT all the way down, because every op here awaits and
 *  a saved-and-restored cursor would be interleaved by a concurrent call on the same fd. */
function atOffset(p, k, which) {
  const d = p.fds.get(p.ctl[A0]);
  if (!d) return -EBADF;
  // LOAD-BEARING: unlike `HANDLERS.write` this never tests `ops.write` before calling it, so
  // without the kind guard `pwrite` on a /proc fd is a TypeError escaping the dispatcher.
  if (d.kind !== F_FILE && d.kind !== F_SYNTH && d.kind !== F_TMP) return -ESPIPE;
  if (d.kind === F_SYNTH && which === "write") return -EROFS;
  const length = p.ctl[A1] | 0;
  if (length < 0 || length > MAX_INLINE) return -EINVAL;
  const offset = Number(unpackI64(p.ctl[A2], p.ctl[A3]));
  if (!Number.isSafeInteger(offset) || offset < 0) return -EINVAL;
  const ops = KIND_OPS[d.kind];
  const charged = chargeFd(d);
  if (charged < 0) return charged;
  const r = which === "read"
    ? ops.read(d, p, DATA_OFF, length, offset)
    : ops.write(d, p.bytes, DATA_OFF, length, p, offset);
  if (isParked(r)) {
    // No kind parks on a positional call; named rather than left to fall through (see isParked).
    dischargeFd(d);
    return -EINVAL;
  }
  if (r && typeof r.then === "function") {
    k.later(p, () => r.then((n) => {
      dischargeFd(d);
      if (which === "read" && n >= 0) p.rlen = n;
      return n;
    }, (e) => {
      dischargeFd(d);
      throw e;
    }));
    return PENDING;
  }
  dischargeFd(d);
  if (which === "read" && r >= 0) p.rlen = r;
  return r;
}

HANDLERS.pread = (p, k) => atOffset(p, k, "read");
HANDLERS.pwrite = (p, k) => atOffset(p, k, "write");

/** seek. SEEK_SET and SEEK_CUR answer on the dispatch thread; SEEK_END needs the file's current
 *  extent, which a description does not hold. */
const seekTo = (p, d, next) => {
  if (!Number.isSafeInteger(next) || next < 0) return -EINVAL;
  d.pos = next;
  // r0 and r1 together are an i64 return; the error sentinel is r1 === -1 (docs/ABI.md).
  const [lo, hi] = packI64(next);
  p.r1 = hi;
  return lo;
};

HANDLERS.seek = (p, k) => {
  const d = p.fds.get(p.ctl[A0]);
  if (!d) return -EBADF;
  if (d.kind !== F_FILE && d.kind !== F_SYNTH && d.kind !== F_TMP) return -ESPIPE;
  const offset = Number(unpackI64(p.ctl[A1], p.ctl[A2]));
  const whence = p.ctl[A3] | 0;
  if (whence === SEEK_SET) return seekTo(p, d, offset);
  if (whence === SEEK_CUR) return seekTo(p, d, d.pos + offset);
  if (whence !== SEEK_END) return -EINVAL;
  // A generated file's extent is the snapshot it already holds, so SEEK_END needs no round trip.
  if (d.kind === F_SYNTH) return seekTo(p, d, d.bytes.length + offset);
  // A tmpfs extent is known synchronously, but ONLY for a file: a directory has no blob entry and
  // asking its size throws FsError out of a handler the dispatcher does not wrap.
  if (d.kind === F_TMP) {
    if (d.type !== FILE) return -EISDIR;
    try {
      return seekTo(p, d, d.fs.size(d.ino) + offset);
    } catch (error) {
      return errnoOfFsError(error);
    }
  }
  // `d` is captured, not re-resolved: the cursor belongs to the description, which dup/dup2 alias.
  k.later(p, async () => {
    const end = await k.store.endFd(d);
    if (end < 0) return end;
    return seekTo(p, d, end + offset);
  });
  return PENDING;
};

/** fstat on an fd. It reads the blob, so it answers through later(): the committed size alone — all
 *  a synchronous fstat could answer — reports 8 for a file a successful 4-byte `pwrite` at offset 8
 *  just made 12 bytes long. */
HANDLERS.fstat = (p, k) => {
  const d = p.fds.get(p.ctl[A0]);
  if (!d) return -EBADF;
  // A generated file's size is the snapshot's length, which is final.
  if (d.kind === F_SYNTH) return writeStat(p, { ...d.info, size: d.bytes.length }, d.dev);
  // A tmpfs answers from its own table; the CURRENT size, not the one recorded at open.
  if (d.kind === F_TMP) {
    try {
      return writeStat(p, { ...d.fs.vfs.fstat(d.ino), dev: d.dev }, d.dev);
    } catch (error) {
      return errnoOfFsError(error);
    }
  }
  if (d.kind !== F_FILE) return -EINVAL;
  if (!k.store || !k.store.vfs) return -EIO;
  k.later(p, async () => {
    const info = await k.store.statFd(d);
    if (typeof info === "number") return info;
    return writeStat(p, info);
  });
  return PENDING;
};

HANDLERS.ftruncate = (p, k) => {
  const d = p.fds.get(p.ctl[A0]);
  if (!d) return -EBADF;
  // The size is parsed BEFORE any kind branch, so a bad argument is EINVAL for every kind.
  const size = Number(unpackI64(p.ctl[A1], p.ctl[A2]));
  if (!Number.isSafeInteger(size) || size < 0) return -EINVAL;
  if (d.kind === F_TMP) {
    if (d.type !== FILE) return -EINVAL;
    // Synchronous, and the ops row has already turned any FsError into an errno.
    return KIND_OPS[F_TMP].truncate(d, size);
  }
  if (d.kind !== F_FILE || d.type !== FILE) return -EINVAL;
  const ops = KIND_OPS[d.kind];
  if (!ops.truncate) return -ENOSYS;
  return settle(k, p, ops.truncate(d, size));
};

HANDLERS.dup = (p) => {
  const d = p.fds.get(p.ctl[A0]);
  if (!d) return -EBADF;
  // THE REFERENCE IS TAKEN ONLY IF AN FD IS. Raised before `add`, a table at OPEN_MAX answers
  // -EMFILE with the count permanently one high, so the kind's `close` never fires and a pipe whose
  // writer count never drops leaves its reader parked on an EOF that cannot arrive (constraint 92).
  const fd = p.fds.add(d);
  if (fd < 0) return fd;
  d.refs += 1;
  return fd;
};

HANDLERS.dup2 = (p, k) => {
  const d = p.fds.get(p.ctl[A0]);
  const to = p.ctl[A1] | 0;
  if (!d) return -EBADF;
  if (to < 0) return -EBADF;
  // THE CEILING, CHECKED BEFORE THE CLOSE, so a rejected dup2 does not close the caller's existing
  // fd on the way out. See OPEN_MAX.
  if (to >= OPEN_MAX) return -EMFILE;
  if (to === (p.ctl[A0] | 0)) return to;
  // The close of the fd being replaced may commit a staged generation, so dup2 must WAIT for it:
  // returning first would let the caller write through the new fd while that commit was in flight.
  const closing = p.fds.close(to);
  const install = () => {
    d.refs += 1;
    p.fds.set(to, d);
    return to;
  };
  if (closing && typeof closing.then === "function") {
    k.later(p, () => closing.then(install));
    return PENDING;
  }
  return install();
};

HANDLERS.mkdir = (p, k) => {
  const path = readPath(p);
  if (typeof path === "number") return path;
  return metaOp(p, k, path, (fs, rel, cred) => fs.mkdir(cred, rel, { mode: p.ctl[A0] | 0 }));
};

HANDLERS.rmdir = (p, k) => {
  const path = readPath(p);
  if (typeof path === "number") return path;
  return metaOp(p, k, path, (fs, rel, cred) => fs.rmdir(cred, rel));
};

HANDLERS.unlink = (p, k) => {
  const path = readPath(p);
  if (typeof path === "number") return path;
  return metaOp(p, k, path, (fs, rel, cred) => fs.unlink(cred, rel));
};

HANDLERS.rename = (p, k) => {
  const paths = readTwoPaths(p);
  if (typeof paths === "number") return paths;
  return twoPathOp(p, k, paths, (fs, a, b, cred) => fs.rename(cred, a, b));
};

HANDLERS.symlink = (p, k) => {
  const paths = readTwoPaths(p);
  if (typeof paths === "number") return paths;
  // (target, linkpath). ONLY THE LINKPATH IS RESOLVED: a target may not exist yet.
  return metaOp(p, k, paths[1], (fs, rel, cred) => fs.symlink(cred, paths[0], rel));
};

HANDLERS.link = (p, k) => {
  const paths = readTwoPaths(p);
  if (typeof paths === "number") return paths;
  return twoPathOp(p, k, paths, (fs, a, b, cred) => fs.link(cred, a, b));
};

HANDLERS.chmod = (p, k) => {
  const path = readPath(p);
  if (typeof path === "number") return path;
  return metaOp(p, k, path, (fs, rel, cred) => fs.chmod(cred, rel, p.ctl[A0] | 0));
};

HANDLERS.chown = (p, k) => {
  const path = readPath(p);
  if (typeof path === "number") return path;
  return metaOp(p, k, path, (fs, rel, cred) => fs.chown(
    cred, rel, p.ctl[A0] | 0, p.ctl[A1] | 0));
};

HANDLERS.truncate = (p, k) => {
  const path = readPath(p);
  if (typeof path === "number") return path;
  const size = Number(unpackI64(p.ctl[A0], p.ctl[A1]));
  if (!Number.isSafeInteger(size) || size < 0) return -EINVAL;
  if (!k.store || !k.store.vfs) return -EIO;
  // `truncate` resolves its own path rather than going through metaOp, so the mount lookup is made
  // here by hand: without it `truncate("/proc/1/status")` answers ENOENT about a readable file.
  const at = resolveMount(p, k, path);
  if (typeof at === "number") return at;
  if (mountReadOnly(k, at.mount)) return -EROFS;
  let decision;
  try {
    decision = at.mount.fs.openDecision(credOf(p), at.rel, { wantW: true });
  } catch (error) {
    return errnoOfFsError(error);
  }
  // A generated filesystem cannot reach here — `openDecision` with wantW throws on all of them —
  // but the lines below hand the decision to the blob store, and a synthetic decision has no blob.
  if (decision.synth) return -EROFS;
  // A path truncate is an open, a truncate and a close, so the COW rule has one implementation.
  k.later(p, async () => {
    const d = await k.store.openFd(decision);
    if (typeof d === "number") return d;
    const r = await k.store.truncateFd(d, size);
    if (r < 0) {
      await k.store.closeFd(d);
      return r;
    }
    return k.store.closeFd(d);
  });
  return PENDING;
};

/** A stat record, with the size rendered by the ONE thing that renders it. An append in the
 *  committed generation is in the file before the metadata names it, so answering from the metadata
 *  alone makes `stat` and `fstat` disagree by those bytes. */
function statRecord(p, k, info, mount) {
  const dev = mount ? mount.dev : 0;
  // A generated filesystem's size is already final. `store.sizeOf` resolves an inode against the
  // blob store's handle rows, where a generated inode could collide with a real one's row.
  if (mount && mount.fs !== k.store.vfs) return writeStat(p, info, dev);
  const sized = k.store.sizeOf(info);
  if (sized && typeof sized.then === "function") {
    k.later(p, async () => {
      const r = await sized;
      return typeof r === "number" ? r : writeStat(p, r, dev);
    });
    return PENDING;
  }
  return writeStat(p, sized, dev);
}

HANDLERS.stat = (p, k) => {
  const path = readPath(p);
  if (typeof path === "number") return path;
  return metaRead(p, k, path, (fs, rel, cred, mount) =>
    statRecord(p, k, fs.stat(cred, rel), mount));
};

HANDLERS.lstat = (p, k) => {
  const path = readPath(p);
  if (typeof path === "number") return path;
  return metaRead(p, k, path, (fs, rel, cred, mount) =>
    statRecord(p, k, fs.lstat(cred, rel), mount));
};

HANDLERS.readlink = (p, k) => {
  const path = readPath(p);
  if (typeof path === "number") return path;
  return metaRead(p, k, path, (fs, rel, cred) => {
    const target = fs.readlink(cred, rel);
    return replyBytes(p, new TextEncoder().encode(target));
  });
};

/**
 * readdir(fd, cookie) -> packed {u64 ino, u8 type, u8 nlen, u16 pad, char[]} records, next cookie
 * in r1 (docs/ABI.md), each record padded to a 4-byte boundary so the next u64 is aligned.
 *
 * The cookie is an INDEX into the directory's entry list, so a caller that concurrently unlinks
 * gets a shifted iteration.
 */
HANDLERS.readdir = (p, k) => {
  const d = p.fds.get(p.ctl[A0]);
  if (!d) return -EBADF;
  if (d.type !== DIR) return -ENOTDIR;
  const cookie = p.ctl[A1] | 0;
  return dirRead(p, k, d, () => {
    const entries = (d.kind === F_SYNTH || d.kind === F_TMP)
      ? d.fs.listRel(d.rel) : k.store.vfs.listIno(d.ino);
    const encoder = new TextEncoder();
    const out = [];
    let used = 0;
    let index = cookie;
    for (; index < entries.length; index += 1) {
      const entry = entries[index];
      const name = encoder.encode(entry.name);
      if (name.length > NAME_MAX) return -ENAMETOOLONG;
      const size = direntSize(name.length);
      if (used + size > MAX_INLINE) break;
      const record = new Uint8Array(size);
      const dv = new DataView(record.buffer);
      dv.setBigUint64(DE_INO, BigInt(entry.ino), true);
      record[DE_TYPE] = DIRENT_TYPE[entry.type] ?? DT_UNKNOWN;
      record[DE_NLEN] = name.length;
      record.set(name, DIRENT_HEADER);
      out.push(record);
      used += size;
    }
    // A single entry too large for the byte region would loop a caller forever on one cookie.
    // MAX_INLINE against NAME_MAX makes it impossible; asserted because the consequence is a hang.
    if (!out.length && index < entries.length) return -EOVERFLOW;
    const packed = new Uint8Array(used);
    let at = 0;
    for (const record of out) {
      packed.set(record, at);
      at += record.length;
    }
    p.r1 = index;
    return replyBytes(p, packed);
  });
};

/** pty_open() -> master fd in r0, slave fd in r1. The OPENER'S PROCESS GROUP becomes the pty's
 *  foreground group — where the line discipline sends SIGINT — not its pid, because a shell opens
 *  the pty and then puts each pipeline in its own group with `ioctl(TIOCSPGRP)`. */
HANDLERS.pty_open = (p) => {
  const pty = new Pty();
  const master = { kind: F_PTY_M, refs: 1, flags: O_RDWR, pty, inflight: 0 };
  const slave = { kind: F_TTY, refs: 1, flags: O_RDWR, pty, inflight: 0 };
  const mfd = p.fds.add(master);
  if (mfd < 0) return mfd;
  const sfd = p.fds.add(slave);
  if (sfd < 0) {
    // Undo, or the caller leaks an fd it was never told about.
    p.fds.close(mfd);
    return sfd;
  }
  pty.masters = 1;
  pty.slaves = 1;
  pty.fgPgid = p.pgid;
  p.r1 = sfd;
  return mfd;
};

/** The pty behind an fd, or a negative errno; ENOTTY is what makes `isatty()` expressible. */
function ptyOf(p, fd) {
  const d = p.fds.get(fd);
  if (!d) return -EBADF;
  if (d.kind !== F_TTY && d.kind !== F_PTY_M) return -ENOTTY;
  return d;
}

HANDLERS.tty_get = (p) => {
  const d = ptyOf(p, p.ctl[A0]);
  if (typeof d === "number") return d;
  const record = new Uint8Array(TERMIOS_BYTES);
  encodeTermios(new DataView(record.buffer), 0, d.pty.getTermios());
  return replyBytes(p, record);
};

HANDLERS.tty_set = (p) => {
  const d = ptyOf(p, p.ctl[A0]);
  if (typeof d === "number") return d;
  const length = Atomics.load(p.ctl, LEN_I32);
  // EXACTLY the record size: a short buffer would decode reserved words out of whatever the SAB
  // last held, and silently change flags the caller never set.
  if (length !== TERMIOS_BYTES) return -EINVAL;
  const view = new DataView(
    p.bytes.buffer, p.bytes.byteOffset + DATA_OFF, TERMIOS_BYTES);
  return d.pty.setTermios(decodeTermios(view, 0));
};

HANDLERS.tty_winsize_get = (p) => {
  const d = ptyOf(p, p.ctl[A0]);
  if (typeof d === "number") return d;
  const record = new Uint8Array(WINSIZE_BYTES);
  encodeWinsize(new DataView(record.buffer), 0, d.pty.getWinsize());
  return replyBytes(p, record);
};

/** tty_winsize_set(fd, rows, cols) — docs/ABI.md: a set on the MASTER raises SIGWINCH on the
 *  slave's foreground pgrp. The pixel fields are not in that signature and are preserved. */
HANDLERS.tty_winsize_set = (p) => {
  const d = ptyOf(p, p.ctl[A0]);
  if (typeof d === "number") return d;
  const rows = p.ctl[A1] | 0;
  const cols = p.ctl[A2] | 0;
  if (rows < 0 || cols < 0 || rows > 0xffff || cols > 0xffff) return -EINVAL;
  const had = d.pty.getWinsize();
  return d.pty.setWinsize({ rows, cols, xpixel: had.xpixel, ypixel: had.ypixel });
};

/** ioctl(fd, request, arg) — the two foreground-process-group requests only; docs/ABI.md. */
HANDLERS.ioctl = (p, k) => {
  const d = ptyOf(p, p.ctl[A0]);
  if (typeof d === "number") return d;
  const request = p.ctl[A1] | 0;
  if (request === TIOCGPGRP) return d.pty.fgPgid;
  if (request !== TIOCSPGRP) return -EINVAL;
  const pgid = p.ctl[A2] | 0;
  if (pgid < 0) return -EINVAL;
  // THE GROUP MUST EXIST AND SHARE THIS SESSION, or a process could point a terminal's foreground
  // group at a group in another session and have Ctrl-C delivered across it.
  if (pgid !== 0) {
    const members = k.table.pgidMembers(pgid);
    if (!members.length) return -ESRCH;
    if (members.some((m) => m.sid !== p.sid)) return -EPERM;
  }
  d.pty.fgPgid = pgid;
  return 0;
};

/**
 * The parked `poll` calls. Constraint 42: `poll()` is the single wait primitive over fds, because a
 * process has one futex word and one outstanding call.
 *
 * ONE LIST, re-evaluated when anything replies, rather than a waiter list per pollable object: at
 * most one entry per process, bounded by constraint 17, so a scan is O(interested) (constraint 18).
 */
const pollWaiters = [];
let inPollWake = false;

/** Whether one fd is ready for the events asked about, as a revents mask. */
function pollOne(p, fd, events) {
  const d = p.fds.get(fd);
  if (!d) return POLLNVAL;
  let revents = 0;
  if (d.kind === F_PIPE_R) {
    if (d.pipe.length > 0) revents |= POLLIN;
    // A pipe with no writer left is readable: the read returns 0, and EOF is a readable event.
    if (d.pipe.writers === 0) revents |= POLLIN | POLLHUP;
  } else if (d.kind === F_PIPE_W) {
    if (d.pipe.free > 0) revents |= POLLOUT;
    if (d.pipe.readers === 0) revents |= POLLERR;
  } else if (d.kind === F_TTY || d.kind === F_PTY_M) {
    const isMaster = d.kind === F_PTY_M;
    if (d.pty.readable(isMaster)) revents |= POLLIN;
    // ASK THE PTY: the SLAVE refuses a write once its output ring fills, so an unconditional
    // POLLOUT spins a poll-then-write loop. The master is always writable.
    if (d.pty.writable(isMaster)) revents |= POLLOUT;
    if (isMaster ? d.pty.slaves === 0 : d.pty.masters === 0) revents |= POLLHUP;
  } else if (d.kind === F_WIN) {
    // The row that makes a window waitable alongside a pty (constraint 42).
    if (d.console.readable()) revents |= POLLIN;
    if (d.console.writable()) revents |= POLLOUT;
    if (d.console.hungUp()) revents |= POLLHUP;
  } else {
    // A regular, generated or tmpfs file and the sink never park, so a poller must not sleep here.
    revents |= POLLIN | POLLOUT;
  }
  // POLLERR, POLLHUP and POLLNVAL are reported whether or not they were asked for.
  return revents & (events | POLLERR | POLLHUP | POLLNVAL);
}

/** Evaluate one waiter's whole set. Returns the ready count and fills `revents`. */
function pollScan(p, entries) {
  let ready = 0;
  for (const e of entries) {
    e.revents = pollOne(p, e.fd, e.events);
    if (e.revents !== 0) ready += 1;
  }
  return ready;
}

/** Write the revents back into the caller's byte region, in place. */
function pollPublish(p, entries) {
  const dv = new DataView(p.bytes.buffer, p.bytes.byteOffset + DATA_OFF,
    entries.length * POLLFD_BYTES);
  for (let i = 0; i < entries.length; i += 1) {
    dv.setUint16(i * POLLFD_BYTES + PFD_REVENTS, entries[i].revents & 0xffff, true);
  }
  p.rlen = entries.length * POLLFD_BYTES;
}

/** Re-evaluate every parked `poll`. Called from `reply`, the one funnel every state change that
 *  could make an fd ready passes through. REENTRANCY IS GUARDED: this calls `reply` itself, and a
 *  woken poller would otherwise re-enter the scan from inside its own reply. */
export function pollWake(k) {
  if (inPollWake || pollWaiters.length === 0) return;
  inPollWake = true;
  try {
    for (let i = pollWaiters.length - 1; i >= 0; i -= 1) {
      const w = pollWaiters[i];
      // The sequence guard: a call already answered by an interrupt, a teardown or a panic must
      // not be answered again.
      if (!w.slot.ctl || w.slot.seq !== w.seq) {
        pollWaiters.splice(i, 1);
        continue;
      }
      const ready = pollScan(w.slot, w.entries);
      if (ready > 0) {
        pollWaiters.splice(i, 1);
        pollPublish(w.slot, w.entries);
        k.reply(w.slot, ready, 0, ST_RETURN, w.entries.length * POLLFD_BYTES);
      }
    }
  } finally {
    inPollWake = false;
  }
}

/** Drop any parked poll for a slot that is going away. Called from teardown. */
export function pollForget(slot) {
  for (let i = pollWaiters.length - 1; i >= 0; i -= 1) {
    if (pollWaiters[i].slot === slot) pollWaiters.splice(i, 1);
  }
}

export function pollPending() {
  return pollWaiters.length;
}

HANDLERS.poll = (p, k) => {
  const nfds = p.ctl[A0] | 0;
  const timeout = p.ctl[A1] | 0;
  if (nfds < 0 || nfds > OPEN_MAX) return -EINVAL;
  if (nfds === 0) {
    // A poll over no fds is a sleep. Honoured rather than refused, which is POSIX.
    if (timeout === 0) return 0;
    if (timeout < 0) {
      // INFINITE. Parked with an empty set: no fd can ever make it ready, so only a signal or a
      // teardown ends it.
      pollWaiters.push({ slot: p, seq: p.seq, entries: [] });
      return PENDING;
    }
    k.setTimer(p, timeout);
    return PENDING;
  }
  const length = Atomics.load(p.ctl, LEN_I32);
  if (length !== nfds * POLLFD_BYTES) return -EINVAL;
  const dv = new DataView(p.bytes.buffer, p.bytes.byteOffset + DATA_OFF, length);
  const entries = [];
  for (let i = 0; i < nfds; i += 1) {
    entries.push({
      fd: dv.getInt32(i * POLLFD_BYTES + PFD_FD, true),
      events: dv.getUint16(i * POLLFD_BYTES + PFD_EVENTS, true),
      revents: 0,
    });
  }
  const ready = pollScan(p, entries);
  if (ready > 0) {
    pollPublish(p, entries);
    return ready;
  }
  // Nothing ready. timeout 0 is a poll, not a wait.
  if (timeout === 0) {
    pollPublish(p, entries);
    return 0;
  }
  // PARK. The record carries the whole set, so whichever fd becomes ready first answers the one
  // call (constraint 42).
  const waiter = { slot: p, seq: p.seq, entries };
  pollWaiters.push(waiter);
  if (timeout > 0) {
    // A deadline, as its own timer. On expiry the call answers 0: POSIX's "nothing became ready".
    const seqAtDispatch = p.seq;
    k.setPollTimeout(p, timeout, () => {
      const at = pollWaiters.indexOf(waiter);
      if (at < 0) return;                       // already answered by a wake
      if (!p.ctl || p.seq !== seqAtDispatch) { pollWaiters.splice(at, 1); return; }
      pollWaiters.splice(at, 1);
      // RESCAN BEFORE ANSWERING, rather than republishing the last scan's revents. The wake is
      // hooked on `reply` (constraint 109), so readiness arriving WITHOUT a reply — teardown's fd
      // sweep — is invisible until something rescans. `k.pollReevaluates` is false only under the
      // `no-poll-wake` control (src/kernel/kernel.mjs).
      const ready = k.pollReevaluates ? pollScan(p, entries) : 0;
      pollPublish(p, entries);
      k.reply(p, ready, 0, ST_RETURN, entries.length * POLLFD_BYTES);
    });
  }
  return PENDING;
};

/** pipe2(flags) -> read fd in r0, write fd in r1 (docs/ABI.md). The two descriptions share one
 *  `Pipe` and each counts itself on it. */
HANDLERS.pipe2 = (p, k) => {
  const flags = p.ctl[A0] | 0;
  // No flags are implemented; refusing them keeps a caller from assuming O_NONBLOCK semantics.
  if (flags !== 0) return -EINVAL;
  const pipe = new Pipe();
  // No slot on the description: `dup` aliases it and a child inherits it, so no one process owns
  // it. The ops rows are handed the CALLING process on every call.
  const rd = { kind: F_PIPE_R, refs: 1, flags: O_RDONLY, pipe, inflight: 0 };
  const wr = { kind: F_PIPE_W, refs: 1, flags: O_WRONLY, pipe, inflight: 0 };
  const rfd = p.fds.add(rd);
  if (rfd < 0) return rfd;
  const wfd = p.fds.add(wr);
  if (wfd < 0) {
    // The read end is already installed, so a failure here must undo it.
    p.fds.close(rfd);
    return wfd;
  }
  pipe.readers = 1;
  pipe.writers = 1;
  p.r1 = wfd;
  return rfd;
};

/**
 * statfs: [u64 blocks][u64 bfree][u64 files][u64 ffree][u32 bsize][u32 namemax], 40 bytes.
 *
 * The block size is 1 — OPFS has no block device under it — so `blocks` and `bfree` are BYTES.
 */
HANDLERS.statfs = (p, k) => {
  if (!k.store || !k.store.vfs) return -EIO;
  // THE PATH IS OPTIONAL (docs/ABI.md): an absent one is the root mount, and a path names the
  // mount that owns it.
  const supplied = Atomics.load(p.ctl, LEN_I32) > 0;
  let mount;
  if (supplied) {
    const path = readPath(p);
    if (typeof path === "number") return path;
    const at = resolveMount(p, k, path);
    if (typeof at === "number") return at;
    mount = at.mount;
  } else {
    if (!k.mounts) return -EIO;
    mount = k.mounts.root;
  }
  const record = new Uint8Array(STATFS_BYTES);
  const dv = new DataView(record.buffer);
  if (mount.fs !== k.store.vfs) {
    // EVERY FIELD COMES FROM THE FILESYSTEM, including `bsize` and `namemax`: hardcoding those
    // here means a filesystem that declares a block size cannot publish it.
    encodeStatfs(dv, 0, mount.fs.statfs());
    return replyBytes(p, record);
  }
  const counted = k.store.vfs.stats();
  const quota = k.store.quota || { usage: counted.bytes, quota: 0 };
  // bsize 1, so `blocks` and `bfree` are BYTES on the durable volume.
  encodeStatfs(dv, 0, {
    blocks: quota.quota || 0,
    bfree: Math.max(0, (quota.quota || 0) - (quota.usage || 0)),
    files: counted.inodes,
    ffree: 0,
    bsize: 1,
    namemax: NAME_MAX,
  });
  return replyBytes(p, record);
};

/**
 * chdir(path). THE STORED VALUE IS LEXICALLY NORMALIZED AND ABSOLUTE, which is `cd -L`.
 *
 * NOTHING IS PINNED: a later `rmdir` of the cwd succeeds and the next relative path answers ENOENT,
 * because a held reference would be state outside the process table (constraint 15).
 */
HANDLERS.chdir = (p, k) => {
  if (!k.store || !k.store.vfs) return -EIO;
  const path = readPath(p);
  if (typeof path === "number") return path;
  const at = resolveMount(p, k, path);
  if (typeof at === "number") return at;
  /* THE TYPE FIRST, THEN THE PERMISSION. Asking for `wantX` in one call makes the VFS check the
   * execute bit on whatever is there, so `chdir("/tmp/notes.txt")` answers EACCES and the -ENOTDIR
   * below goes dead — while `/proc/1/status` answers ENOTDIR (constraint 82). */
  try {
    const typed = at.mount.fs.openDecision(credOf(p), at.rel, { dirOk: true });
    if (typed.type !== DIR) return -ENOTDIR;
    // The search permission: second call, same path, so ENOTDIR can answer first.
    at.mount.fs.openDecision(credOf(p), at.rel, { dirOk: true, wantX: true });
  } catch (error) {
    return errnoOfFsError(error);
  }
  p.cwd = normalize(absoluteOf(p, path));
  return 0;
};

HANDLERS.clock_nanosleep = (p, k) => {
  const ns = unpackI64(p.ctl[A0], p.ctl[A1]);
  if (ns < 0n) return -EINVAL;
  if (p.ctl[A2] !== 0) return -ENOSYS;   // no TIMER_ABSTIME
  k.setTimer(p, Number(ns / 1000000n));
  return PENDING;
};

/** The process-lifecycle handlers run on the kernel's thread and return a value directly. The one
 *  exception is waitpid, which parks on a child that has not exited. */
HANDLERS.exit = (p, k) => {
  // Only the kernel records WHY a process left: STAT_EXITED here, STAT_KILLED from the kill path.
  k.reap(p, STAT_EXITED, p.ctl[A0] & 0xff);
  // The reply is produced by reap() answering any outstanding waitpid parent; the caller is gone.
  return PENDING;
};

HANDLERS.kill = (p, k) => {
  const target = p.ctl[A0] | 0;
  const sig = p.ctl[A1] | 0;
  if (sig < 1 || sig > 31) return -EINVAL;
  return k.deliverSignal(p, target, sig);
};

HANDLERS.sigaction = (p) => {
  const sig = p.ctl[A0] | 0;
  const disp = p.ctl[A1] | 0;
  if (sig < 1 || sig > 31 || sig === SIGKILL || sig === SIGSTOP) return -EINVAL;
  if (disp !== SIG_DFL && disp !== SIG_IGN && disp !== SIG_HANDLE) return -EINVAL;
  const old = p.sigDisp.get(sig) ?? SIG_DFL;
  p.sigDisp.set(sig, disp);
  return old;
};

HANDLERS.setpgid = (p, k) => {
  const pid = (p.ctl[A0] | 0) || p.pid;
  const pgid = (p.ctl[A1] | 0) || pid;
  const target = k.table.get(pid);
  if (!target) return -ESRCH;
  if (target.pid !== p.pid && target.ppid !== p.pid) return -EPERM;
  if (target.sid !== p.sid) return -EPERM;
  target.pgid = pgid;
  return 0;
};

HANDLERS.setsid = (p) => {
  // A session leader cannot lead a second session. Everything else is an identity reshuffle, and
  // the slot records itself as the leader so a SIGHUP sweep can find it in O(interested).
  if (p.sidLeader) return -EPERM;
  p.sid = p.pid;
  p.pgid = p.pid;
  p.sidLeader = true;
  return p.sid;
};

HANDLERS.sched_yield = () => 0;

HANDLERS.waitpid = (p, k) => {
  const askedPid = p.ctl[A0] | 0;
  const flags = p.ctl[A1] | 0;
  const found = k.firstZombieChild(p, askedPid);
  if (found) return k.reapForParent(p, found);
  // -ECHILD when no matching child exists at all; 0 under WNOHANG when matching children exist but
  // none has exited. That split lets a shell's wait loop tell the two apart.
  const hasChild = k.hasChild(p, askedPid);
  if (!hasChild) return -ECHILD;
  if (flags & WNOHANG) return 0;
  // Park. reap() wakes the parent with the right (pid, status) through later/reply.
  k.parkParent(p, askedPid);
  return PENDING;
};

HANDLERS.spawn = (p, k) => {
  // The program path resolves through the mount table and the bytes come out of the mount: a
  // process-supplied string never becomes a request origin (constraint 123).
  const r = k.spawnChild(p);
  return r;
};

HANDLERS.perform = (p) => {
  // The reserved escape hatch: -ENOSYS until an opcode is added, so a syscall number does not churn
  // to get one. Answering 0 would make a program's `if (r == 0)` think the call did something.
  return -ENOSYS;
};

/** Derive the dispatch table at boot and assert every declared call has a handler: a SYS_NAME entry
 *  without one panics at boot rather than answering -ENOSYS at runtime, and a handler with no
 *  SYS_NAME entry is a dead branch. */
export function buildCalls(k) {
  const table = new Array(NSYS);
  for (let nr = 0; nr < NSYS; nr += 1) {
    const name = SYS_NAME[nr];
    const h = HANDLERS[name];
    if (!h) throw new Error(`calls.mjs: SYS_NAME[${nr}]=${name} has no handler`);
    table[nr] = (p) => h(p, k);
  }
  for (const name of Object.keys(HANDLERS)) {
    if (!SYS_NAME.includes(name)) {
      throw new Error(`calls.mjs: HANDLERS.${name} has no SYS_NAME entry`);
    }
  }
  return table;
}

/** performance.now() busy-spin, in microseconds. */
function spinUs(us) {
  const until = performance.now() + us / 1000;
  while (performance.now() < until) { /* occupying the kernel thread is the point */ }
}

/** The kernel-stall control (M0's negative control). A boot-time wrapper per row, so the headline
 *  path contains no control branch. */
export function installStall(table, us) {
  for (let nr = 0; nr < table.length; nr += 1) {
    const inner = table[nr];
    if (!inner) continue;
    table[nr] = (p) => {
      spinUs(us);
      return inner(p);
    };
  }
}
