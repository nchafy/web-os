// The fd table and the per-kind ops table.
//
// The shape is the point: `write` is "resolve fd -> description, dispatch to KIND_OPS[kind]", so
// M2 adds F_FILE as a row and M4 adds F_PIPE_R/F_PIPE_W as rows, and dup/dup2/close stay three
// lines each. Constraint 47's per-inode refcounted sync handles go UNDER this table — in the I/O
// worker, where the handles are — and nothing here knows a handle exists.

import {
  F_SINK, F_FILE, EBADF, MAX_INLINE, fnv1a, FNV1A_BASIS,
} from "../abi.mjs";

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
    if (description && description.inflight === undefined) description.inflight = 0;
    this.fds[fd] = description;
    return fd;
  }

  set(fd, description) {
    if (description && description.inflight === undefined) description.inflight = 0;
    this.fds[fd] = description;
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
