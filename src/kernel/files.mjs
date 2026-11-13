// The fd table and the per-kind ops table. M0 registers one kind.
//
// The shape is the point: `write` is "resolve fd -> description, dispatch to KIND_OPS[kind]", so
// M2 adds F_FILE as a row and M4 adds F_PIPE_R/F_PIPE_W as rows, and dup/dup2/close stay three
// lines each. Constraint 47's per-inode refcounted sync handles go UNDER this table, not inside it.

import { F_SINK, EBADF, MAX_INLINE, fnv1a, FNV1A_BASIS } from "../abi.mjs";

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

  /** Lowest free fd, POSIX-style. */
  add(description, atLeast = 0) {
    let fd = atLeast;
    while (fd < this.fds.length && this.fds[fd]) fd += 1;
    this.fds[fd] = description;
    return fd;
  }

  set(fd, description) {
    this.fds[fd] = description;
  }

  close(fd) {
    const d = this.get(fd);
    if (!d) return -EBADF;
    this.fds[fd] = null;
    if (--d.refs <= 0) KIND_OPS[d.kind]?.close?.(d);
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
 * sink that ignored the buffer would pass a latency test while transferring nothing. Its cost
 * sits inside the measured kernel service region and is reported as the kernel's in-handler mean.
 */
registerKind(F_SINK, {
  write(d, u8, offset, length) {
    d.sum = fnv1a(u8, offset, length, d.sum);
    d.bytes += length;
    d.writes += 1;
    return length;
  },
  close() {},
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
