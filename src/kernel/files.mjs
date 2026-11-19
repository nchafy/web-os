// The fd table and the per-kind ops table. Constraint 47's per-inode refcounted sync handles go
// UNDER it, in the I/O worker; nothing here knows a handle exists.

import {
  F_SINK, F_FILE, F_SYNTH, F_TMP, F_PIPE_R, F_PIPE_W, F_TTY, F_PTY_M, F_WIN,
  EBADF, EINVAL, ESPIPE, EMFILE, O_APPEND, OPEN_MAX, MAX_INLINE, fnv1a, FNV1A_BASIS,
} from "../abi.mjs";
// store.mjs imports nothing from this file, so this is not a cycle.
import { errnoOfFsError } from "./store.mjs";

/** Indexed by kind. A kind with no entry is -ENOSYS, never a silent zero. */
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

  /** Lowest free fd. The in-flight budget lives on the DESCRIPTION, not the row: `dup` and `dup2`
   *  share one description, so it is one budget per underlying resource (constraint 42). */
  add(description, atLeast = 0) {
    let fd = atLeast;
    while (fd < this.fds.length && this.fds[fd]) fd += 1;
    if (fd >= OPEN_MAX) return -EMFILE;
    if (description && description.inflight === undefined) description.inflight = 0;
    this.fds[fd] = description;
    return fd;
  }

  /** Install a description at an EXPLICIT fd: `dup2` and `spawn`'s file actions. The OPEN_MAX
   *  ceiling is load-bearing — see src/abi.mjs. -EMFILE, not a throw: the callers are handlers. */
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

export function makeSink() {
  return { kind: F_SINK, refs: 1, bytes: 0, sum: FNV1A_BASIS, writes: 0 };
}

// F_SINK does NOT call console.log — that would benchmark DevTools. The checksum is not
// decoration: a sink that ignored the buffer would pass a latency test transferring nothing.
registerKind(F_SINK, {
  write(d, u8, offset, length) {
    d.sum = fnv1a(u8, offset, length, d.sum);
    d.bytes += length;
    d.writes += 1;
    return length;
  },
  read() {
    // 0 would mean EOF. -EBADF is the honest answer for an fd opened for the other direction.
    return -EBADF;
  },
  close() {
    return 0;
  },
});

/** F_FILE: a real file, served by the Store. EVERY METHOD RETURNS A PROMISE — the handle lives in
 *  the I/O worker — and calls.mjs's settle() turns that into PENDING, so SYS_write is identical
 *  for F_SINK and F_FILE. */
let STORE = null;

export function installStore(store) {
  STORE = store;
}

registerKind(F_FILE, {
  // `at` is pread/pwrite's explicit offset, undefined for the cursor path. An argument and not
  // description state: every call here awaits, so a cursor moved and restored would interleave.
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

/** F_SYNTH: a generated file, its bytes produced at `open` and held on the description.
 *  SYNCHRONOUS — no handle, so `read` returns a count and settle() is never entered. `write` is
 *  absent, which the table answers -ENOSYS. */
registerKind(F_SYNTH, {
  read(d, p, dstOff, length, at) {
    const from = at === undefined ? d.pos : at;
    if (from < 0) return -EINVAL;
    if (from >= d.bytes.length) return 0;        // EOF
    const n = Math.min(length, d.bytes.length - from);
    p.bytes.set(d.bytes.subarray(from, from + n), dstOff);
    // A pread must not move the cursor, which is why `at` travels as an argument.
    if (at === undefined) d.pos = from + n;
    return n;
  },
  close() {
    return 0;
  },
});

/**
 * F_TMP: a file on a tmpfs, bytes in a kernel-side Map. The description carries `fs` and `ino`,
 * NOT the bytes: two descriptions on one tmpfs inode must see each other's writes.
 */
registerKind(F_TMP, {
  // THE ERRNO BOUNDARY IS HERE. TmpFS throws FsError and the dispatcher has no try/catch around a
  // handler, so a throw escaping this row would panic the kernel instead of returning -ENOSPC.
  write(d, u8, offset, length, p, at) {
    // The append offset is resolved PER WRITE, never cached at open: two O_APPEND descriptions on
    // one file must not both start at the same end and both be told they wrote.
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
    // 0 rather than -ENOSYS, here and on every other kind with nothing to force: `fsync` SUCCEEDS
    // on these files everywhere, and a program checking the return would read a no-op as failure.
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
    // Nothing to release: the bytes go when the last link does, which is `unlink`'s job.
    return 0;
  },
});

/**
 * F_PIPE_R and F_PIPE_W: two rows, so the read end has no `write` and the write end no `read` and
 * the table's own -ENOSYS delivers the refusal. `null` means PARKED (constraint 88).
 */
registerKind(F_PIPE_R, {
  read(d, p, dstOff, length, at) {
    if (at !== undefined) return -ESPIPE;
    // `p`, THE CALLING PROCESS — never a slot on the description, here or on any kind below. A
    // description is SHARED by `dup` and by spawn-inheritance, so a slot here would park the record
    // against the creator and reply to the creator: the reader never returns.
    return d.pipe.read(p, p.seq, p.bytes, dstOff, length);
  },
  close(d) {
    return d.pipe.close(true);
  },
});

registerKind(F_PIPE_W, {
  write(d, u8, offset, length, p, at) {
    if (at !== undefined) return -ESPIPE;
    return d.pipe.write(p, p.seq, u8.subarray(offset, offset + length));
  },
  fsync() {
    return 0;
  },
  close(d) {
    return d.pipe.close(false);
  },
});

/**
 * F_TTY is the pty SLAVE and F_PTY_M the MASTER, as two rows because the two directions are
 * opposite — src/kernel/pty.mjs's header has the table. `null` means PARKED (constraint 88).
 */
registerKind(F_TTY, {
  read(d, p, dstOff, length, at) {
    if (at !== undefined) return -ESPIPE;
    return d.pty.readInput(p, p.seq, p.bytes, dstOff, length);
  },
  write(d, u8, offset, length, p, at) {
    if (at !== undefined) return -ESPIPE;
    return d.pty.writeOutput(p, p.seq, u8.subarray(offset, offset + length));
  },
  fsync() {
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

/** The window manager, injected at boot like the Store above it. */
let WINS = null;

export function installWins(mgr) {
  WINS = mgr;
}

/** F_WIN: a window as a file description (M7, `src/kernel/wins.mjs`). ONE kind, unlike the pipe and
 *  the pty: reading takes EVENT RECORDS and writing paints cells, through one description. `null`
 *  from `readEvents` means PARKED, and an idle window is the normal state (constraint 88).
 *
 *  `close` DESTROYS the window and its children, because a window nothing holds a description on
 *  is a frame on screen with nothing behind it — which is constraint 179's defect, reached by
 *  omission rather than by a page bug. */
registerKind(F_WIN, {
  read(d, p, dstOff, length, at) {
    if (at !== undefined) return -ESPIPE;
    return d.win.readEvents(p, p.seq, p.bytes, dstOff, length);
  },
  write(d, u8, offset, length, p, at) {
    if (at !== undefined) return -ESPIPE;
    return d.win.writeCells(u8.subarray(offset, offset + length));
  },
  fsync() {
    return 0;
  },
  close(d) {
    d.win.close();
    // WINS is injected, not imported: files.mjs is imported by the kernel that owns the manager.
    if (!WINS) return 0;
    if (d.win.opens <= 0) WINS.destroyTree(d.win.id);
    // THE SWEEP IS HERE AS WELL AS IN `destroyTree`, because the two events can arrive in either
    // order: a window destroyed while an fd is still open keeps its row until this close, and a
    // row nobody can reach is one more the heartbeat sweep walks (constraint 18).
    WINS.sweep();
    return 0;
  },
});

/** The truncate-overflow control (constraint 9): consume only MAX_INLINE while reporting the full
 *  requested length, so the checksum check can be shown capable of failing. */
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
