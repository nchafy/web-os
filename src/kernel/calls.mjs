// The dense syscall table. Adding a call is adding one entry in HANDLERS keyed by SYS_NAME, so
// the dispatch table is DERIVED from src/abi.mjs at boot (MILESTONES.md M1 item (f)): no second
// declaration of a syscall number, no generator, no build step.
//
// A handler receives the slot, and returns either a value or PENDING. It MUST NOT touch SEQ,
// STATUS, RLEN, the notify or G_INFLIGHT: reply() in kernel.mjs is the only writer of those, and
// that single invariant is what makes M1/M2/M4 additive — a new handler cannot get the wake
// protocol wrong because it cannot reach it.

import {
  A0, A1, A2, A3, LEN_I32, DATA_OFF, MAX_INLINE, NSYS, SYS_NAME,
  EBADF, EINVAL, ENOSYS, EIO, EAGAIN, EPERM, EINTR, ECHILD, ESRCH,
  ENOENT, ENOTDIR, EISDIR, EACCES, ENAMETOOLONG, EROFS, ESPIPE, EOVERFLOW, EMFILE,
  ELIMIT_ERRNO, FD_INFLIGHT_CAP, STAT_EXITED, STAT_KILLED, WNOHANG,
  SIGKILL, SIGSTOP, SIG_DFL, SIG_IGN, SIG_HANDLE, SIG_BIT,
  O_ACCMODE, O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_APPEND,
  O_DIRECTORY, O_NOFOLLOW, SEEK_SET, SEEK_CUR, SEEK_END,
  S_IFREG, S_IFDIR, S_IFLNK, FILESTAT_BYTES, DIRENT_HEADER, DT_DIR, DT_REG, DT_LNK, DT_UNKNOWN,
  F_FILE, F_SYNTH, F_TMP, F_PIPE_R, F_PIPE_W, EXDEV,
  encodeFilestat, unpackI64, packI64,
} from "../abi.mjs";
import { KIND_OPS } from "./files.mjs";
import { Pipe } from "./pipe.mjs";
import { errnoOfFsError } from "./store.mjs";
import {
  DIR, FILE, LINK, NAME_MAX, isAbsolute, joinPath,
} from "../fs/vfs.mjs";
import { ZOMBIE, RUNNING, dropCaps } from "./table.mjs";

/** A handler that will reply later, by calling k.reply() itself. */
export const PENDING = Symbol("PENDING");

/**
 * An ops method MAY return a promise, and then the call becomes PENDING and the kernel answers it
 * through later(). This one rule is what lets a file description be served by the I/O worker
 * without any syscall handler knowing where the bytes went: F_SINK answers synchronously, F_FILE
 * answers from another agent, and SYS_write is the same four lines either way.
 */
function settle(k, p, r) {
  if (r && typeof r.then === "function") {
    k.later(p, () => r);
    return PENDING;
  }
  return r;
}

/**
 * The per-fd in-flight budget (item (e)). Charge at async entry, discharge at reply. The budget
 * lives on the description, not on the FileTable row, so dup/dup2 and close(fd) interact with it
 * the way an fd is supposed to — one fd at ELIMIT does not prevent writing on the other handle of
 * the same description, which would be the wrong shape.
 *
 * CONFIRMED against the dispatch code (task asked explicitly): calls.mjs resolves fd -> d, the
 * only place write/fsync can know which fd was invoked. We charge BEFORE the handler runs and
 * discharge in the settlement path via k.later's completion. This matches the task's definition
 * of per-fd: the 65th outstanding call on one fd returns ELIMIT without touching the handler.
 *
 * The one case that wants attention is a kernel that never settles — an open() that never resolves
 * would hold a slot forever. The current code paths all settle through k.later, which runs the
 * finally branch on every outcome. If a future call forgets to settle it will leak the budget;
 * that is a defect that would also leak G_INFLIGHT, so it is a dispatch bug long before it is a
 * budget bug. Documented so it is not discovered twice.
 */
function chargeFd(d) {
  // FD_INFLIGHT_CAP, imported. This read `d.cap | 0 || 64` with the 64 written here as a
  // literal — a second copy of an ABI constant on the kernel side of the boundary, which is
  // the exact defect CLAUDE.md's one-source-of-truth rule names. Nothing sets `d.cap`, so a
  // per-description override is kept as the hook it was meant to be and the fallback is now
  // the declaration.
  if ((d.inflight | 0) >= (d.cap | 0 || FD_INFLIGHT_CAP)) return -ELIMIT_ERRNO;
  d.inflight = (d.inflight | 0) + 1;
  return 0;
}

function dischargeFd(d) {
  if (!d) return;
  d.inflight = Math.max(0, (d.inflight | 0) - 1);
}

/**
 * THE ONE PATH-ARGUMENT READER, and it exists because of a measured refusal rather than a style
 * preference.
 *
 * `TextDecoder.decode` REFUSES a view backed by a SharedArrayBuffer — "The provided ArrayBufferView
 * value must not be shared" — and every path argument arrives in the calling process's SAB. M2 hits
 * this on every path call, so the copy into a private buffer is written once here instead of being
 * rediscovered per call site. `new Uint8Array(view)` allocates a fresh non-shared buffer and copies,
 * which is what makes the decode legal.
 *
 * It also enforces the three things docs/ABI.md says about a path argument — UTF-8, no NUL,
 * absolute or CWD-relative — and the component ceiling, because a 300-character component must be
 * ENAMETOOLONG rather than a name the VFS stores and no `readdir` consumer can handle.
 *
 * @returns {string|number} the path, or -errno.
 */
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

/**
 * THE CREDENTIAL, BUILT PER CALL (constraint 29).
 *
 * It is not state on the VFS and it is not state here: it is read off the calling slot at the
 * moment of the call and handed to the VFS as an argument. Hold it anywhere and every process
 * shares one identity and the mode bits are decoration — which is exactly what the predecessor's
 * single `this.uid` did.
 */
function credOf(p) {
  return { uid: p.uid, gid: p.gid };
}

/** Write `bytes` into the caller's byte region and record the reply length. */
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
    // THE MOUNT'S DEVICE NUMBER, which until M3 was a literal zero. It is what makes the mount
    // table observable from userland: two files on two mounts report two devices, and `st_dev`
    // plus `st_ino` is how POSIX says to tell two files apart. src/fs/mounts.mjs numbers from 1
    // so a zero here means nobody set it rather than "the root volume".
    dev: info.dev !== undefined ? info.dev : dev,
    ino: info.ino,
    // The type bits go in with the permission bits, which is POSIX's own packing and the reason
    // the 10k-file proof can assert "every mode bit intact" against one word.
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
 * A metadata mutation: decide in the VFS, then journal.
 *
 * ORDERING, and why it differs from the data path. A metadata op is applied in memory by the VFS
 * method and appended to the journal immediately after. There is no data to order it against, and
 * a crash between the two loses the op AND the in-memory table it was applied to — the renderer
 * dies as one thing. The append is NOT flushed: constraint 23's flush points are fsync, snapshot
 * and idle, and a flush per `mkdir` would make the filesystem 50x slower for durability nobody
 * asked for.
 *
 * `freed` is the inode whose last link went. Its blobs are reclaimed after the op is on the
 * journal, never before: a blob deleted ahead of the record that unlinks it is a file that
 * reappears after replay with nothing behind it.
 */
function metaOp(p, k, path, decide) {
  if (!k.store || !k.store.vfs) return -EIO;
  const at = resolveMount(p, k, path);
  if (typeof at === "number") return at;
  // THE READ-ONLY TEST IS THE MOUNT'S, not the volume's, and this is the one place it is made for
  // the eight metadata mutations. The volume's own verdict (constraint 28) reaches here as the
  // root mount's MNT_RO flag, so a read-only volume and a read-only `/usr` refuse identically
  // instead of through two different tests that could disagree.
  if (mountReadOnly(k, at.mount)) return -EROFS;
  // A generated filesystem journals nothing: there is no durable state to record an op against.
  // Its own mutation methods throw, so this returns the errno and never reaches `k.store.journal`
  // with a record the store has no volume for.
  let op;
  try {
    op = decide(at.mount.fs, at.rel, credOf(p));
  } catch (error) {
    return errnoOfFsError(error);
  }
  // A MOUNT WITH NO DURABLE STATE HAS NOTHING TO JOURNAL. The op was applied in memory by the
  // filesystem's own method and that is the whole of it — a tmpfs mkdir is complete when it
  // returns. Journaling it would append a record describing the OPFS volume, where it did not
  // happen, and replay would then invent a directory on the wrong filesystem.
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
 * A PROCESS-SUPPLIED PATH TO THE FILESYSTEM THAT OWNS IT. The one place the mount table is read.
 *
 * Two steps, in this order and not the other: the path is made absolute against the process's cwd
 * FIRST, then the mount is resolved. Resolving the mount against a relative path would ask which
 * filesystem owns `../x`, a question with no answer.
 *
 * The cwd join is lexical (`normalize`, not resolution), which is `cd -L` and what every shell
 * does for its own working directory. It differs from resolution exactly when a symlink is
 * involved — see src/fs/vfs.mjs `normalize`.
 *
 * WHAT THIS DOES NOT DO, stated because the gap is invisible otherwise: a symlink is resolved
 * INSIDE the filesystem that holds it, so a symlink on the OPFS volume pointing into `/proc`
 * resolves against the OPFS volume and reaches ENOENT. Cross-mount symlink traversal needs the
 * walk itself to consult the mount table at every component, which this does not. Nothing in M3
 * crosses a mount by symlink; a milestone that needs it has to move the join into the walk.
 */
function resolveMount(p, k, path) {
  const table = k.mounts;
  if (!table) return -EIO;
  const abs = absoluteOf(p, path);
  let at;
  try {
    at = table.resolve(abs);
  } catch (error) {
    return errnoOfFsError(error);
  }
  // THE ROOT MOUNT GETS THE PATH AS GIVEN, with `..` intact, because it is the only filesystem
  // that resolves `..` properly: `src/fs/vfs.mjs`'s walk takes each `..` against the real parent
  // and follows symlinks first, which is what makes `/a/link-to-b/../c` land in b's parent and
  // `stat("/missing/../x")` an ENOENT.
  //
  // `MountTable.resolve` normalizes LEXICALLY to pick the mount, and it has to: without walking
  // the tree there is no other way to know which subtree a `..` lands in. Handing that normalized
  // string on to the VFS was a regression — it popped `..` textually, so a `..` through a
  // nonexistent or non-directory component stopped failing and a `..` through a symlink resolved
  // against the name instead of the target. The generated mounts and the tmpfs have no symlinks,
  // so for them the lexical answer IS the answer.
  if (at.mount.path === "/") return { mount: at.mount, rel: abs };
  return at;
}

/** A process-supplied path, made absolute against the caller's cwd. NOT normalized: see
 *  `resolveMount` for why the root mount must see `..` as the caller wrote it. */
function absoluteOf(p, path) {
  return isAbsolute(path) ? path : joinPath(p.cwd || "/", path);
}

/**
 * Whether a mount refuses a write RIGHT NOW.
 *
 * The mount row's flag is set once, at boot, from the volume's mount verdict. That is right for
 * every mount whose read-only-ness cannot change — a generated filesystem, a provider — and WRONG
 * for the OPFS volume, which `src/kernel/store.mjs` demotes to read-only at runtime after a failed
 * snapshot (constraint 28: it reports and refuses rather than reseeding).
 *
 * The bug that produced: after a demotion the frozen flag still read false, so `metaOp` ran
 * `decide()`, the VFS APPLIED the op to the in-memory inode table, and only then did the journal
 * refuse with -EROFS. The caller was told its `mkdir` failed while `stat` showed the directory for
 * the rest of the session, and it was gone after a reload. The flag is a boot-time fact; the
 * store's verdict is the live one, so the durable mount asks the store.
 */
function mountReadOnly(k, mount) {
  if (mount.durable) return !!(k.store && k.store.readOnly);
  return mount.readOnly;
}

/**
 * A PARKED call. `null` from an ops row means "not answered now; the kind holds a record and will
 * reply to it when an event unblocks it" — a pipe read with no data, a pipe write with no space.
 *
 * `null` MUST be tested before the thenable check and before any numeric use, because `null >= 0`
 * is true and `null | 0` is 0: left to fall through, a parked read answered the caller with 0,
 * which on a pipe means EOF. A reader that was supposed to wait would have seen end-of-file.
 *
 * THE PER-FD BUDGET IS RELEASED AT THE PARK, and that is a decision rather than an oversight. The
 * budget (FD_INFLIGHT_CAP) bounds outstanding kernel I/O per description, and `chargeFd`'s own
 * comment names "a kernel that never settles would hold a slot forever" as its hazard — a parked
 * pipe read is exactly that, by design and indefinitely. What bounds parked records instead is
 * the process table: a process has one futex word and one outstanding call, so a pipe can hold at
 * most one record per process and processes are capped by constraint 17. Holding the charge would
 * instead make the 65th blocking reader on a shared pipe get ENOBUFS, which is a different and
 * undocumented contract.
 */
function isParked(r) {
  return r === null;
}

/**
 * A directory read, dispatched from an fd rather than a path.
 *
 * `metaRead`'s sibling: same error translation, same dispatch-thread answer, but the filesystem
 * comes from the description because `readdir` never sees a path. Separate rather than a flag on
 * `metaRead`, which would be an abstraction needing a parameter to tell its callers apart.
 */
function dirRead(p, k, d, read) {
  if (!k.store || !k.store.vfs) return -EIO;
  try {
    return read();
  } catch (error) {
    return errnoOfFsError(error);
  }
}

/**
 * `rename` and `link`: two paths that must land on ONE mount.
 *
 * EXDEV is POSIX's own answer and the honest one. A rename across mounts is a copy plus an unlink,
 * which is a different operation with different failure modes and no atomicity — and the VFS's
 * rename is a metadata edit that could not express it anyway. Refusing it is what `mv` expects;
 * `mv` falls back to copy-and-delete when it sees EXDEV.
 */
function twoPathOp(p, k, paths, decide) {
  if (!k.store || !k.store.vfs) return -EIO;
  const a = resolveMount(p, k, paths[0]);
  if (typeof a === "number") return a;
  const b = resolveMount(p, k, paths[1]);
  if (typeof b === "number") return b;
  if (a.mount !== b.mount) return -EXDEV;
  return metaOp(p, k, paths[1], (fs, rel, cred) => decide(fs, a.rel, b.rel, cred));
}

/**
 * The HANDLERS map, keyed by syscall NAME (not by number). The dispatch table is derived from
 * this plus SYS_NAME at boot; a missing name is a panic at boot, not a syscall that silently
 * returns -ENOSYS at runtime. That is what makes item (f)'s "every declared call has a handler"
 * assertion both cheap and load-bearing.
 */
const HANDLERS = {};

HANDLERS.getpid = (p) => p.pid;
HANDLERS.getppid = (p) => p.ppid;
HANDLERS.getpgid = (p) => p.pgid;

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

/**
 * open(flags, mode), with the path in the byte region. docs/ABI.md's own signature.
 *
 * M0a's `open` was this call with the VFS missing underneath it: a flat OPFS name, no flags, no
 * resolution, no permission check. It keeps its syscall number — a second "open" would be two
 * renderers of one fact — and the bench that measured raw handle cost through it now measures the
 * same handle cost through the real path, which is a more representative mix rather than a
 * different one.
 *
 * CONSTRAINT 24 IS SATISFIED HERE AND NOWHERE ELSE: the path is resolved to an inode ONCE, in the
 * kernel, and what the process gets back is an fd. `getDirectoryHandle` is 85 us per component, so
 * a four-component walk per call would be 340 us — 23 syscalls — and the whole fd-based shape of
 * the ABI exists to pay it once.
 */
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
  // The MOUNT's read-only flag, not the volume's. Same rule as metaOp: one test, so a read-only
  // volume and a read-only mount refuse identically.
  if ((wantW || (flags & O_CREAT)) && mountReadOnly(k, at.mount)) return -EROFS;
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
  // A GENERATED FILE IS INSTALLED HERE AND ANSWERS ON THE DISPATCH THREAD. There is no journal to
  // append, no blob to open and no I/O worker to wait for, so routing it through `k.later` would
  // buy a round trip and nothing else. The bytes were produced by `openDecision` and are the
  // snapshot this fd will keep reading — see src/kernel/synth.mjs for why open-time and not
  // read-time.
  // A TMPFS DESCRIPTION. Like the generated case it answers on the dispatch thread — no journal,
  // no blob, nothing to await — but it is WRITABLE and it does NOT snapshot: two descriptions on
  // one tmpfs inode must see each other's writes, as two on one real file do.
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
    // O_APPEND IS NOT A SEEK AT OPEN. This set `d.pos` to the size here and was the exact defect
    // recorded ~60 lines below for the OPFS path: two `>>` descriptions on one file both start at
    // the same end, both write there, and both are told they wrote — measured there as eight bytes
    // acknowledged, the file 12 bytes long, and the first writer's four gone. The offset has to be
    // resolved PER WRITE, which `files.mjs`'s F_TMP `write` now does from `d.flags`.
    return p.fds.add(d);
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
      // The filesystem this description came from, so `readdir` can ask the right one. F_FILE
      // descriptions leave it undefined and readdir falls back to the OPFS VFS.
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
      // POSIX TRUNCATES AS PART OF `open`, so the commit belongs here. Staged and left
      // uncommitted, the truncation was invisible to every other description until the truncating
      // fd synced or closed: a concurrent `stat` reported the old size and a concurrent read
      // returned the old bytes, both from a file the caller had already been told was empty.
      // `truncateFd` answers 0 without staging anything when the file is already that length, so
      // the common `> file` idiom costs no generation and no record.
      const t = await k.store.truncateFd(d, 0);
      if (t < 0) {
        await k.store.closeFd(d);
        return t;
      }
      const c = await k.store.fsyncFd(d);
      if (c < 0) {
        // THE STAGED TRUNCATION GOES WITH THE FAILED OPEN, and it has to be discarded EXPLICITLY.
        // A refused commit keeps its staged generation now, so that a caller retrying -EBUSY can
        // still publish bytes `pwrite` acknowledged — but this caller is about to be told its
        // `open` failed, and `closeFd` commits whatever is staged. Without this the file would be
        // truncated by the cleanup of an `open` that returned an errno.
        await k.store.dropStaging(d);
        await k.store.closeFd(d);
        return c;
      }
    }
    // O_APPEND IS NOT A SEEK HERE, and this is where it used to be one: `d.pos = endFd(d)`, once,
    // at open. POSIX sets the offset to the end of the file atomically BEFORE EACH WRITE, and the
    // flag is recorded on the description above so `writeFd` can do exactly that under the inode's
    // lock (src/kernel/store.mjs `writeHeld`). Seeking here instead cost the first of two `>>`
    // writers its bytes, with every call returning success. The initial offset of an O_APPEND
    // description is 0, which is also POSIX and is what a read through an O_RDWR|O_APPEND fd needs.
    return p.fds.add(d);
  });
  return PENDING;
};

/**
 * fsync, A SEPARATE SYSCALL FROM write (constraint 23), and the one the I/O worker exists for.
 *
 * `flush()` is 260 us against a 5 us 4 KiB write, so flushing per write makes the VFS 50x slower
 * for durability nobody asked for — and it is SYNCHRONOUS, so inline it is 260 us of kernel thread
 * no other process can use. That is the stronger, latency argument for the same split
 * (constraint 58): `fsync` is the call to get off the dispatch thread, `open` already was.
 */
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

/** close(fd). The last reference runs the kind's close op, which for F_FILE commits a staged
 *  generation and releases the handle — so it returns a promise and goes through settle(). */
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
      // The bytes are already in the caller's own SAB — the I/O worker read straight into it, so
      // there is no copy here. RLEN is the count.
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

/**
 * pread/pwrite: the same two ops at an explicit offset, so the description's cursor is NOT touched.
 * The offset is an (lo, hi) pair; a description with no offset is ESPIPE.
 *
 * The offset travels as an ARGUMENT all the way down. Writing it into `d.pos` and restoring it
 * afterwards was the first version and it was wrong: every op here awaits, so a positional call
 * would be interleaved by any concurrent call on the same fd and each would see the other's
 * position. That is the whole reason `pread` exists.
 */
function atOffset(p, k, which) {
  const d = p.fds.get(p.ctl[A0]);
  if (!d) return -EBADF;
  // A generated file is seekable, so `pread` is legal on it and ESPIPE would be the wrong refusal.
  // THE LINE BELOW IS THE REFUSAL and is load-bearing, which an earlier comment here denied: it
  // claimed the ops table would answer -ENOSYS, but unlike `HANDLERS.write` this function never
  // tests `ops.write` before calling it, so deleting the guard on the strength of that comment
  // would turn `pwrite` on a /proc fd into a TypeError escaping the dispatcher.
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
    // No kind parks on a positional call today: a pipe has no position and answers ESPIPE above.
    // Named rather than left to fall through, because `null` here would answer the caller 0.
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

/**
 * seek. SEEK_SET and SEEK_CUR answer on the dispatch thread; SEEK_END does not.
 *
 * SEEK_END needs the file's current EXTENT, and a description holds no size — so for a description
 * with no staged generation that is a read of the blob, in the I/O worker. The split is not a
 * special case: SEEK_END is the only whence whose answer depends on durable state at all.
 */
const seekTo = (p, d, next) => {
  if (!Number.isSafeInteger(next) || next < 0) return -EINVAL;
  d.pos = next;
  // docs/ABI.md: r0 and r1 together are an i64 return. The error sentinel is r1 === -1, which a
  // real offset cannot reach before 2^63.
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
  // A tmpfs extent is known synchronously: the Map holds it — but ONLY for a file. A directory
  // has no blob entry, so asking its size threw FsError out of a handler the dispatcher does not
  // wrap, and `open("/tmp", O_DIRECTORY)` then `seek(fd, 0, SEEK_END)` faulted the kernel. A
  // directory is not seekable to its end; EISDIR is what POSIX says and what `read` already says.
  if (d.kind === F_TMP) {
    if (d.type !== FILE) return -EISDIR;
    try {
      return seekTo(p, d, d.fs.size(d.ino) + offset);
    } catch (error) {
      return errnoOfFsError(error);
    }
  }
  // `d` is captured, not re-resolved from the fd: the description is what the cursor belongs to,
  // and dup/dup2 mean the fd and the description are not the same thing.
  k.later(p, async () => {
    const end = await k.store.endFd(d);
    if (end < 0) return end;
    return seekTo(p, d, end + offset);
  });
  return PENDING;
};

/**
 * fstat on an fd. It reads the blob, so it answers through later() rather than on the dispatch
 * thread.
 *
 * THE COST IS A ROUND TRIP AND IT BUYS THE ONE THING fstat IS FOR. A description holds no size,
 * and the size it must report includes an append written into the committed generation and not
 * yet published — bytes `pwrite` has already returned a count for. Measured against the alternative
 * of reporting the committed size alone, which is what a synchronous fstat could answer: that
 * reports 8 for a file a successful 4-byte `pwrite` at offset 8 just made 12 bytes long.
 */
HANDLERS.fstat = (p, k) => {
  const d = p.fds.get(p.ctl[A0]);
  if (!d) return -EBADF;
  // A generated file answers from the description: its size is the snapshot's length, which is
  // final, so there is nothing to ask storage about.
  if (d.kind === F_SYNTH) return writeStat(p, { ...d.info, size: d.bytes.length }, d.dev);
  // A tmpfs answers from its own table, which is authoritative and synchronous. `fstat` must
  // report the CURRENT size and not the one recorded at open: another description may have
  // written since, and that is the case fstat exists for.
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
  // The size is parsed BEFORE any kind branch, so a bad argument is EINVAL for every kind rather
  // than for whichever ones happen to read it first.
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
  d.refs += 1;
  return p.fds.add(d);
};

HANDLERS.dup2 = (p, k) => {
  const d = p.fds.get(p.ctl[A0]);
  const to = p.ctl[A1] | 0;
  if (!d) return -EBADF;
  if (to < 0) return -EBADF;
  if (to === (p.ctl[A0] | 0)) return to;
  // The close of the fd being replaced may commit a staged generation, so it returns a promise and
  // dup2 must WAIT for it. Returning before it settled would let the caller write through the new
  // fd while the old description's commit was still in flight against the same inode.
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

/* --------------------------- the path group --------------------------- */

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
  // (target, linkpath), which is symlink(2)'s order and the order `ln -s` prints. ONLY THE
  // LINKPATH IS RESOLVED: the target is stored as the bytes the caller gave, never interpreted
  // here, because a symlink's target is resolved when it is followed and may not exist yet.
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
  // THE FOURTH CHOKE POINT, and the one that was missed. `truncate` resolves its own path rather
  // than going through metaOp or metaRead, so it needed the mount lookup adding by hand — and
  // without it a `truncate("/proc/1/status")` resolved against the OPFS volume and came back
  // ENOENT, which says "no such file" about a file the caller had just read. Measured by
  // bench/m3-fs/program.mjs's `readonly` mode, which asserts every mutation's errno separately
  // for exactly this reason: a single "it refused" would have passed.
  const at = resolveMount(p, k, path);
  if (typeof at === "number") return at;
  if (mountReadOnly(k, at.mount)) return -EROFS;
  let decision;
  try {
    decision = at.mount.fs.openDecision(credOf(p), at.rel, { wantW: true });
  } catch (error) {
    return errnoOfFsError(error);
  }
  // A generated filesystem cannot reach here: `openDecision` with wantW throws on every one of
  // them. Asserted rather than assumed, because the three lines below hand the decision to the
  // blob store and a synthetic decision has no blob.
  if (decision.synth) return -EROFS;
  // A path truncate is an open, a truncate and a close. Expressed as those three rather than as a
  // fourth way to reach a blob, so the COW rule has one implementation.
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

/**
 * A stat record, with the file's size rendered by the ONE thing that renders it.
 *
 * `store.sizeOf` answers synchronously for a directory, a symlink, or a file no description holds
 * — which is every `stat` the 10,000-file proof takes — and asks the blob otherwise, because an
 * append written into the committed generation is in the file and the metadata does not name it
 * yet. Answering from the metadata alone here is what let `stat` and `fstat` disagree about one
 * file by four bytes that a `pwrite` had already returned a count for.
 */
function statRecord(p, k, info, mount) {
  const dev = mount ? mount.dev : 0;
  // A GENERATED FILESYSTEM'S SIZE IS ALREADY FINAL. `store.sizeOf` resolves an inode against the
  // blob store's handle rows, and a generated inode is a hash of a path that names no blob — so
  // asking it would either miss and report the metadata size or, worse, collide with a real
  // inode's row and report another file's length.
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
 * in r1. docs/ABI.md's shape with the pad made explicit, and each record padded to a 4-byte
 * boundary so the next u64 is aligned.
 *
 * The cookie is an INDEX into the directory's entry list, which is the honest thing it can be for
 * an insertion-ordered Map: it is stable while the directory is not mutated and a caller that
 * concurrently unlinks gets a shifted iteration, exactly as a real `readdir` does.
 */
HANDLERS.readdir = (p, k) => {
  const d = p.fds.get(p.ctl[A0]);
  if (!d) return -EBADF;
  if (d.type !== DIR) return -ENOTDIR;
  const cookie = p.ctl[A1] | 0;
  // Resolved from the DESCRIPTION, not from a path: readdir takes an fd, so there is no path to
  // resolve a mount against, and the mount it came from is recorded on the description at open.
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
      const size = (DIRENT_HEADER + name.length + 3) & ~3;
      if (used + size > MAX_INLINE) break;
      const record = new Uint8Array(size);
      const dv = new DataView(record.buffer);
      dv.setBigUint64(0, BigInt(entry.ino), true);
      record[8] = DIRENT_TYPE[entry.type] ?? DT_UNKNOWN;
      record[9] = name.length;
      record.set(name, DIRENT_HEADER);
      out.push(record);
      used += size;
    }
    // A single entry too large for the byte region would loop a caller forever on the same
    // cookie. MAX_INLINE is 65,404 B and NAME_MAX is 255, so it cannot happen — asserted rather
    // than assumed, because the consequence is a hang and not an error.
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

/**
 * statfs: [u64 blocks][u64 bfree][u64 files][u64 ffree][u32 bsize][u32 namemax], 40 bytes.
 *
 * The block size is 1 — OPFS has no block device under it, and inventing a 4 KiB one would make
 * `df` print a number that is not a measurement of anything. `blocks` and `bfree` are therefore
 * bytes, and the quota is whatever the browser reported at boot.
 */
/**
 * pipe2(flags) -> read fd in r0, WRITE FD IN r1.
 *
 * Two fds from one call, which is why `r1` carries the second: docs/ABI.md's IPC group specifies
 * exactly this shape. `p.r1` is the reply scratch word, cleared per dispatch, so a handler that
 * sets it and returns a number gets both published by `finish`.
 *
 * The two descriptions share one `Pipe` and each counts itself on it. The SLOT is recorded on each
 * description because the pipe replies to parked calls itself and needs the process to reply to —
 * and `dup2` into another process is impossible, so a description's slot cannot go stale while the
 * description lives.
 */
HANDLERS.pipe2 = (p, k) => {
  const flags = p.ctl[A0] | 0;
  // No flags are implemented. O_NONBLOCK and O_CLOEXEC are the two POSIX defines, and both are
  // real behaviour this does not have: refusing an unknown flag is the honest answer and keeps a
  // caller from assuming non-blocking semantics it will not get.
  if (flags !== 0) return -EINVAL;
  const pipe = new Pipe();
  // NO SLOT ON THE DESCRIPTION. A description is shared — `dup` aliases it and a spawned child
  // inherits it — so there is no one process it belongs to. The ops rows are handed the CALLING
  // process on every call, which is the only correct answer.
  const rd = { kind: F_PIPE_R, refs: 1, flags: O_RDONLY, pipe, inflight: 0 };
  const wr = { kind: F_PIPE_W, refs: 1, flags: O_WRONLY, pipe, inflight: 0 };
  const rfd = p.fds.add(rd);
  if (rfd < 0) return rfd;
  const wfd = p.fds.add(wr);
  if (wfd < 0) {
    // The read end is already installed, so a failure here must undo it or the caller leaks an fd
    // it was never told about.
    p.fds.close(rfd);
    return wfd;
  }
  pipe.readers = 1;
  pipe.writers = 1;
  p.r1 = wfd;
  return rfd;
};

HANDLERS.statfs = (p, k) => {
  if (!k.store || !k.store.vfs) return -EIO;
  // THE PATH IS OPTIONAL, and that is a compatibility decision rather than a loose interface.
  // docs/ABI.md lists `statfs` in the path group, but the libos stub has always called it with an
  // empty byte region and means "this filesystem" — so an absent path is the root mount, and a
  // path names the mount that owns it. Making the path mandatory would break `statfs()` as every
  // existing caller spells it; ignoring the path would make `statfs("/proc")` report the OPFS
  // volume's numbers, which is the whole thing a mount table exists to stop.
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
  const record = new Uint8Array(40);
  const dv = new DataView(record.buffer);
  if (mount.fs !== k.store.vfs) {
    // A generated filesystem has no blocks and no quota. Zeros, because inventing a size would
    // make `df` print a number that measures nothing — the same reason the block size below is 1.
    // EVERY FIELD FROM THE FILESYSTEM, including `bsize` and `namemax`. Hardcoding those two here
    // meant a filesystem that declared a block size could not publish it — one fact with two
    // renderers, and the kernel's copy winning over the only object that knows the answer.
    const s = mount.fs.statfs();
    dv.setBigUint64(0, BigInt(s.blocks), true);
    dv.setBigUint64(8, BigInt(s.bfree), true);
    dv.setBigUint64(16, BigInt(s.files), true);
    dv.setBigUint64(24, BigInt(s.ffree), true);
    dv.setUint32(32, s.bsize >>> 0, true);
    dv.setUint32(36, s.namemax >>> 0, true);
    return replyBytes(p, record);
  }
  const counted = k.store.vfs.stats();
  const quota = k.store.quota || { usage: counted.bytes, quota: 0 };
  dv.setBigUint64(0, BigInt(quota.quota || 0), true);
  dv.setBigUint64(8, BigInt(Math.max(0, (quota.quota || 0) - (quota.usage || 0))), true);
  dv.setBigUint64(16, BigInt(counted.inodes), true);
  dv.setBigUint64(24, 0n, true);
  dv.setUint32(32, 1, true);
  dv.setUint32(36, NAME_MAX, true);
  return replyBytes(p, record);
};

HANDLERS.clock_nanosleep = (p, k) => {
  const ns = unpackI64(p.ctl[A0], p.ctl[A1]);
  if (ns < 0n) return -EINVAL;
  if (p.ctl[A2] !== 0) return -ENOSYS;   // no TIMER_ABSTIME at M0/M1
  k.setTimer(p, Number(ns / 1000000n));
  return PENDING;
};

/**
 * M1 process-lifecycle handlers. They run on the kernel's thread, so they are synchronous and
 * return a value directly — no settle(), no PENDING. The one exception is waitpid, which parks
 * on a child that has not exited yet.
 */
HANDLERS.exit = (p, k) => {
  // The kernel is the only thing that can record WHY a process left (item (c)). A clean exit
  // writes STAT_EXITED with the caller's code; a signal kill writes STAT_KILLED later, from the
  // kill path.
  k.reap(p, STAT_EXITED, p.ctl[A0] & 0xff);
  // Nothing returns from here: the reply is produced by reap() answering any outstanding
  // waitpid parent, not by this handler. The caller is already gone.
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
  // POSIX-shaped: a process may set its own pgid or its child's, and it cannot reach across a
  // session boundary. M1 keeps the rule minimal because M4 is where the line discipline uses it.
  if (target.pid !== p.pid && target.ppid !== p.pid) return -EPERM;
  if (target.sid !== p.sid) return -EPERM;
  target.pgid = pgid;
  return 0;
};

HANDLERS.setsid = (p) => {
  // A session leader cannot become the leader of a second session. Everything else is an
  // identity reshuffle: sid := pgid := pid, and the slot records itself as the leader so a
  // future SIGHUP sweep can find it in O(interested) (item (b)).
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
  // No child is ready. WNOHANG makes that -ECHILD-style but POSIX says 0 for "nothing to wait on
  // yet"; M1 returns -ECHILD when no matching child exists at all, and 0 (with r1=0) under
  // WNOHANG when there are matching children but none has exited. That split is what lets a
  // shell's wait loop distinguish "all my kids are gone" from "give me a sec".
  const hasChild = k.hasChild(p, askedPid);
  if (!hasChild) return -ECHILD;
  if (flags & WNOHANG) return 0;
  // Park. The parent is parked in Atomics.wait and will be woken by reap() answering with the
  // right (pid, status). This reuses the SEQ/RESPONSE machinery via later/reply — no separate
  // queue, which is the point of being able to reply out of order.
  k.parkParent(p, askedPid);
  return PENDING;
};

HANDLERS.spawn = (p, k) => {
  // M1's spawn is in-kernel. The caller supplies the program URL and optional argv/envp via the
  // byte region as a NUL-separated list; M1 keeps it to the shape every M2+ caller will give it,
  // and the concrete argv parsing waits for M2's VFS. For now a spawn with no payload gets no
  // argv, and that is what the four proofs exercise.
  const r = k.spawnChild(p);
  return r;
};

HANDLERS.perform = (p) => {
  // The escape hatch (item (f)). Reserved slot with no implementation yet: any caller gets
  // -ENOSYS, and the slot is held so a future opcode added here does not need a syscall-number
  // churn. A handler that answered 0 would be the wrong shape: a program's `if (r == 0)` would
  // think the call did something.
  return -ENOSYS;
};

/**
 * Derive the dispatch table at boot and assert every declared call has a handler.
 *
 * ONE ASSERTION, LOAD-BEARING: an entry added to SYS_NAME without a handler in HANDLERS panics
 * at boot rather than being discovered when some test program calls it and gets -ENOSYS. The
 * reverse — a handler with no SYS_NAME entry — is a dead branch; we flag it too so additions
 * stay paired. Item (f) requires exactly this.
 */
export function buildCalls(k) {
  const table = new Array(NSYS);
  for (let nr = 0; nr < NSYS; nr += 1) {
    const name = SYS_NAME[nr];
    const h = HANDLERS[name];
    if (!h) throw new Error(`calls.mjs: SYS_NAME[${nr}]=${name} has no handler`);
    table[nr] = (p) => h(p, k);
  }
  // Catch extras. A handler we never dispatch is a defect in file form and the comment above
  // is the only witness to it otherwise.
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

/**
 * The kernel-stall control (M0's negative control). A boot-time wrapper per row, so the headline
 * path contains no control branch at all and "your flag perturbed the measurement" is not
 * available as an objection.
 */
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
