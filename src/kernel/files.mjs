// The fd table and the per-kind ops table.
//
// The shape is the point: `write` is "resolve fd -> description, dispatch to KIND_OPS[kind]", so
// M2 adds F_FILE as a row and M4 adds F_PIPE_R/F_PIPE_W as rows, and dup/dup2/close stay three
// lines each. Constraint 47's per-inode refcounted sync handles go UNDER this table — in the I/O
// worker, where the handles are — and nothing here knows a handle exists.

import {
  F_SINK, F_FILE, F_SYNTH, F_TMP, F_PIPE_R, F_PIPE_W, F_TTY, F_PTY_M,
  EBADF, EINVAL, ESPIPE, EMFILE, O_APPEND, OPEN_MAX, MAX_INLINE, fnv1a, FNV1A_BASIS,
} from "../abi.mjs";
// For the tmpfs row below. store.mjs imports nothing from this file, so this is not a cycle.
import { errnoOfFsError } from "./store.mjs";

/** Indexed by kind. A kind with no entry is -ENOSYS, which is the honest state of a call the
 *  kernel has not implemented — never a silent zero. */
export const KIND_OPS = [];

export function registerKind(kind, ops) {
  KIND_OPS[kind] = ops;
}

export class FileTable {
  constructor() {
    this.fds = [];
  }

  get(fd) {
    return (fd >= 0 && fd < this.fds.length ? this.fds[fd] : null) ?? null;
  }

  /** Lowest free fd, POSIX-style. Initialises the per-fd in-flight count (M1 item (e)): the
   *  budget is charged per fd because the fd is already the unit poll() waits on (constraint 42)
   *  and `close()` releases, so a floods-one-queue process gets ELIMIT on THAT fd and keeps
   *  servicing its pipe. A description can be shared across fds (dup, dup2), so the counter lives
   *  on the description — one budget per underlying resource, not per handle. */
  add(description, atLeast = 0) {
    let fd = atLeast;
    while (fd < this.fds.length && this.fds[fd]) fd += 1;
    // EMFILE, which until M4 was unreachable: `pipe2`'s own `if (rfd < 0)` guard was a dead
    // branch because nothing here had a ceiling. See OPEN_MAX.
    if (fd >= OPEN_MAX) return -EMFILE;
    if (description && description.inflight === undefined) description.inflight = 0;
    this.fds[fd] = description;
    return fd;
  }

  /**
   * Install a description at an EXPLICIT fd. `dup2` and `spawn`'s file actions.
   *
   * THE CEILING IS LOAD-BEARING HERE. This writes into a plain array indexed by fd, so a `dup2` to
   * fd 2^30 grew the array to a billion entries — and `spawn`'s inheritance loop and `teardown`'s
   * fd sweep both walk `fds.length` on the kernel thread, so one process could wedge the kernel
   * for everyone. Returns -EMFILE rather than throwing, because the callers are syscall handlers.
   */
  set(fd, description) {
    if (fd < 0 || fd >= OPEN_MAX) return -EMFILE;
    if (description && description.inflight === undefined) description.inflight = 0;
    this.fds[fd] = description;
    return fd;
  }

  close(fd) {
    const d = this.get(fd);
    if (!d) return -EBADF;
    this.fds[fd] = null;
    if (--d.refs <= 0) return KIND_OPS[d.kind]?.close?.(d) ?? 0;
    return 0;
  }
}

/** The sink's proof that bytes actually crossed. The hash and its seed come from src/abi.mjs —
 *  the one copy both sides of the boundary import, pinned there against a published vector. */
export function makeSink() {
  return { kind: F_SINK, refs: 1, bytes: 0, sum: FNV1A_BASIS, writes: 0 };
}

/**
 * F_SINK does NOT call console.log — that would benchmark DevTools. It accumulates a byte count
 * and a rolling FNV-1a in the hot path and discards the bytes. The checksum is not decoration: a
 * sink that ignored the buffer would pass a latency test while transferring nothing. Its cost sits
 * inside the measured kernel service region and is reported as the kernel's in-handler mean.
 */
registerKind(F_SINK, {
  write(d, u8, offset, length) {
    d.sum = fnv1a(u8, offset, length, d.sum);
    d.bytes += length;
    d.writes += 1;
    return length;
  },
  read() {
    // A sink has nothing to read, and 0 would mean EOF — which a caller would act on. -EBADF is
    // the honest answer for an fd opened for the other direction.
    return -EBADF;
  },
  close() {
    return 0;
  },
});

/**
 * F_FILE: a real file, resolved to an inode by the VFS and served by the Store.
 *
 * EVERY METHOD RETURNS A PROMISE, which is the whole of M0b's fix: the handle lives in the I/O
 * worker, so the synchronous `write`/`flush` happen on a thread whose only job is waiting for
 * storage. calls.mjs's settle() turns a promise into PENDING, so SYS_write is identical for F_SINK
 * and F_FILE and no syscall handler knows where the bytes went.
 *
 * The store is handed in at boot as `STORE`, once, rather than reached for per call: a kind's ops
 * are registered before any process exists, and a closure over a kernel-global would be a second
 * way to find the store.
 */
let STORE = null;

export function installStore(store) {
  STORE = store;
}

registerKind(F_FILE, {
  // `at` is the explicit file offset for pread/pwrite and undefined for the cursor path. Passed
  // through rather than written into the description: every call here awaits, so a positional
  // call that moved the cursor and moved it back would be interleaved by any concurrent call on
  // the same fd.
  write(d, u8, offset, length, p, at) {
    return STORE.writeFd(d, p.pid, offset, length, at);
  },
  read(d, p, dstOff, length, at) {
    return STORE.readFd(d, p.pid, dstOff, length, at);
  },
  fsync(d) {
    return STORE.fsyncFd(d);
  },
  truncate(d, size) {
    return STORE.truncateFd(d, size);
  },
  close(d) {
    return STORE.closeFd(d);
  },
});

/**
 * F_SYNTH: a generated file. Its bytes were produced at `open` and are held on the description.
 *
 * SYNCHRONOUS, and that is the one thing that makes it different from F_FILE: there is no handle,
 * no blob and no I/O worker, so `read` returns a count rather than a promise and `calls.mjs`'s
 * settle() path is never entered. Reading `/proc/<pid>/status` therefore costs one syscall and no
 * round trip.
 *
 * `write` is absent rather than present-and-refusing, because the table's own contract is that a
 * missing op is -ENOSYS (see the head of this file) — and a kind that declared a write only to
 * refuse it would be a second place the read-only rule is written. The mount's MNT_RO flag is the
 * first and `metaOp` is where it is read.
 */
registerKind(F_SYNTH, {
  read(d, p, dstOff, length, at) {
    const from = at === undefined ? d.pos : at;
    if (from < 0) return -EINVAL;
    if (from >= d.bytes.length) return 0;        // EOF, which for a generated file is the real end
    const n = Math.min(length, d.bytes.length - from);
    p.bytes.set(d.bytes.subarray(from, from + n), dstOff);
    // Only the cursor path advances it. A pread must not move the cursor — the same rule F_FILE
    // follows, and the reason `at` travels as an argument.
    if (at === undefined) d.pos = from + n;
    return n;
  },
  close() {
    // Nothing to release: the bytes are a plain Uint8Array the garbage collector owns. This exists
    // so `FileTable.close` has an op to call rather than reaching the `?.` and silently doing
    // nothing, which would hide a kind that genuinely needed a release.
    return 0;
  },
});

/**
 * F_TMP: a file on a tmpfs. Bytes in a kernel-side Map, keyed by inode.
 *
 * SYNCHRONOUS like F_SYNTH and WRITABLE like F_FILE, which is why it is its own row rather than a
 * flag on either: there is no handle to open and nothing to await, so a /tmp write costs one
 * syscall, and a kind that had to branch on "is this one writable" would be the abstraction
 * needing a flag to tell its callers apart.
 *
 * The description carries `fs` (the TmpFS) and `ino`. It does NOT carry the bytes — F_SYNTH's
 * snapshot-at-open is right for a generated file and wrong here, because two descriptions on one
 * tmpfs inode must see each other's writes, exactly as two descriptions on one real file do.
 */
registerKind(F_TMP, {
  // THE ERRNO BOUNDARY IS HERE. TmpFS throws FsError, as the VFS it is built on does; the
  // dispatcher has no try/catch around a handler, so a throw that escaped this row would reach
  // `self.onerror` and panic the kernel instead of returning -ENOSPC to the caller that filled
  // the filesystem. A full tmpfs is a normal condition and must be an errno.
  write(d, u8, offset, length, p, at) {
    // THE APPEND OFFSET IS RESOLVED HERE, PER WRITE, and never cached at open. Two O_APPEND
    // descriptions on one tmpfs file must not both start at the same end — see the comment in
    // calls.mjs's tmpfs open arm for the measurement that rule comes from. A positional `pwrite`
    // honours its explicit offset even under O_APPEND, which is POSIX and what the OPFS path does.
    let from;
    if (at !== undefined) from = at;
    else if (d.flags & O_APPEND) from = d.fs.size(d.ino);
    else from = d.pos;
    if (from < 0) return -EINVAL;
    let n;
    try {
      n = d.fs.write(d.ino, from, u8.subarray(offset, offset + length));
    } catch (error) {
      return errnoOfFsError(error);
    }
    if (at === undefined) d.pos = from + n;
    return n;
  },
  read(d, p, dstOff, length, at) {
    const from = at === undefined ? d.pos : at;
    if (from < 0) return -EINVAL;
    let n;
    try {
      n = d.fs.read(d.ino, from, length, p.bytes, dstOff);
    } catch (error) {
      return errnoOfFsError(error);
    }
    if (at === undefined) d.pos = from + n;
    return n;
  },
  fsync() {
    // A tmpfs has no durable store, so there is nothing to force and 0 is the honest answer
    // rather than -ENOSYS: `fsync` on a tmpfs file SUCCEEDS everywhere, and a program that
    // checked the return would otherwise treat a correct no-op as a failure.
    return 0;
  },
  truncate(d, size) {
    try {
      return d.fs.truncate(d.ino, size);
    } catch (error) {
      return errnoOfFsError(error);
    }
  },
  close() {
    // Nothing to release. The bytes outlive the description and go when the last link does,
    // which is `unlink`'s job — the same contract as a real file.
    return 0;
  },
});

/**
 * F_PIPE_R and F_PIPE_W: the two ends of a pipe, as two rows.
 *
 * TWO KINDS AND NOT ONE WITH A DIRECTION FLAG. The ops table is how `read(2)` and `write(2)` find
 * their behaviour, so a single kind would need every op to branch on the flag — the abstraction
 * needing a parameter to tell its callers apart that CLAUDE.md says to split. As two rows, the
 * read end simply has no `write` and the write end no `read`, and the table's own contract (a
 * missing op is -ENOSYS) delivers the refusal with no code at all.
 *
 * `null` from `Pipe.read`/`Pipe.write` means PARKED: the call is not answered now and the pipe
 * holds a record it will reply to from whichever event unblocks it. `calls.mjs` turns that into
 * PENDING. Constraint 88: a blocking call parks on SEQ and never inside a synchronous call.
 */
registerKind(F_PIPE_R, {
  read(d, p, dstOff, length, at) {
    // A pipe has no position, so an explicit offset is meaningless rather than ignorable. ESPIPE
    // is what POSIX says and `calls.mjs` already refuses pread on a kind without a position; this
    // is the second line of that defence, for a caller that reached the op directly.
    if (at !== undefined) return -ESPIPE;
    // `p`, THE CALLING PROCESS — never a slot recorded on the description. A description is
    // SHARED: `dup` aliases it and a spawned child inherits it, so the process that created the
    // pipe is usually not the one reading it. Recording the creator's slot here parked the record
    // against the parent and replied to the parent, so the child's read never returned and the
    // whole pipeline deadlocked with no error anywhere.
    return d.pipe.read(p, p.seq, p.bytes, dstOff, length);
  },
  close(d) {
    return d.pipe.close(true);
  },
});

registerKind(F_PIPE_W, {
  write(d, u8, offset, length, p, at) {
    if (at !== undefined) return -ESPIPE;
    // `p`, the calling process. See the read op for why a description cannot carry a slot.
    return d.pipe.write(p, p.seq, u8.subarray(offset, offset + length));
  },
  fsync() {
    // A pipe has nothing to force. 0 rather than -ENOSYS, for the reason the tmpfs gives: `fsync`
    // on a pipe succeeds everywhere, and a program that checked the return would otherwise treat
    // a correct no-op as a failure.
    return 0;
  },
  close(d) {
    return d.pipe.close(false);
  },
});

/**
 * F_TTY and F_PTY_M: the two ends of a pty, as two rows.
 *
 * THEY ARE OPPOSITE, which is why they are two kinds and not one with a flag:
 *
 *   write(slave)  is OUTPUT — straight to the master's queue, unprocessed.
 *   write(master) is INPUT  — through the line discipline: signals, echo, canonical buffering.
 *   read(slave)   takes processed input; in canonical mode, only whole lines.
 *   read(master)  takes the program's output, plus whatever the echo produced.
 *
 * `null` means PARKED, as it does for a pipe: the pty holds a record and replies to it when an
 * event unblocks it (constraint 88).
 */
registerKind(F_TTY, {
  read(d, p, dstOff, length, at) {
    if (at !== undefined) return -ESPIPE;   // a terminal has no position
    return d.pty.readInput(p, p.seq, p.bytes, dstOff, length);
  },
  write(d, u8, offset, length, p, at) {
    if (at !== undefined) return -ESPIPE;
    // `p`, the CALLING process: a slave writer parks when the output ring is full, so the pty
    // needs the process to reply to. A description is shared, so it cannot carry one.
    return d.pty.writeOutput(p, p.seq, u8.subarray(offset, offset + length));
  },
  fsync() {
    // Nothing to force. 0 rather than -ENOSYS, as the tmpfs and the pipe answer: `fsync` on a
    // terminal succeeds everywhere, and a program checking the return would read a correct no-op
    // as a failure.
    return 0;
  },
  close(d) {
    return d.pty.close(false);
  },
});

registerKind(F_PTY_M, {
  read(d, p, dstOff, length, at) {
    if (at !== undefined) return -ESPIPE;
    return d.pty.readOutput(p, p.seq, p.bytes, dstOff, length);
  },
  write(d, u8, offset, length, p, at) {
    if (at !== undefined) return -ESPIPE;
    // A terminal does not block the typist: this always accepts everything.
    return d.pty.writeInput(u8.subarray(offset, offset + length));
  },
  fsync() {
    return 0;
  },
  close(d) {
    return d.pty.close(true);
  },
});

/**
 * The truncate-overflow control (constraint 9): consume only MAX_INLINE while reporting the full
 * requested length — wanix's silent truncation, on demand, so the checksum check can be shown
 * capable of failing. Installed once at boot, never a per-call branch.
 */
export function installTruncateOverflow() {
  const real = KIND_OPS[F_SINK];
  registerKind(F_SINK, {
    ...real,
    write(d, u8, offset, length) {
      const kept = Math.min(length, MAX_INLINE);
      real.write(d, u8, offset, Math.min(kept, 16360));
      return length;
    },
  });
}
