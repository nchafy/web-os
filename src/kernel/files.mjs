// The fd table and the per-kind ops table. M0 registers one kind.
//
// The shape is the point: `write` is "resolve fd -> description, dispatch to KIND_OPS[kind]", so
// M2 adds F_FILE as a row and M4 adds F_PIPE_R/F_PIPE_W as rows, and dup/dup2/close stay three
// lines each. Constraint 47's per-inode refcounted sync handles go UNDER this table, not inside it.

import {
  F_SINK, F_FILE, EBADF, EIO, MAX_INLINE, fnv1a, FNV1A_BASIS,
  IO_OPEN, IO_WRITE, IO_FSYNC, IO_CLOSE,
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
   *  servicing its pipe. A description can be shared across fds (dup, dup2), so the counter
   *  lives on the description — one budget per underlying resource, not per handle. */
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
 * F_FILE: a real OPFS file behind a sync access handle, for M0a.
 *
 * THE WHOLE POINT OF THIS KIND IS THE ASYMMETRY, and it is the reverse of how the two raw costs
 * read. `createSyncAccessHandle()` returns a PROMISE, so its 495 us (constraint 22) is awaited and
 * the kernel's dispatch thread stays free to serve everybody else. The handle's own `write` and
 * `flush` are SYNCHRONOUS, so their cost — 5 us and 260 us respectively (constraint 23) — is
 * kernel thread that no other process can use while it elapses.
 *
 * So the expensive call to SERVE is fsync, not open, even though open is the expensive OPERATION.
 * Constraint 23 already required fsync to be its own syscall for throughput; M0a is the latency
 * argument for the same split, and it is the stronger one.
 *
 * Only `open` is async here, which is why it is the only one returning PENDING in calls.mjs.
 */
registerKind(F_FILE, {
  // These return PROMISES, which is the whole fix. The handle lives in the I/O worker, so the
  // synchronous write/flush happen on a thread whose only job is waiting for storage. calls.mjs's
  // settle() turns a promise into PENDING, so SYS_write is identical for F_SINK and F_FILE.
  write(d, u8, offset, length, p) {
    if (d.inline) return inlineWrite(d, u8, offset, length);
    return d.io.request(IO_WRITE, { id: d.ioId, pid: p.pid, offset, length });
  },
  fsync(d) {
    if (d.inline) return inlineFsync(d);
    return d.io.request(IO_FSYNC, { id: d.ioId });
  },
  close(d) {
    if (d.inline) {
      try { d.handle.close(); } catch (e) { /* a closed handle is the desired end state */ }
      return;
    }
    d.io.request(IO_CLOSE, { id: d.ioId });
  },
});

/**
 * The inline path, kept so the fix can be switched OFF. A fix that cannot be switched off has not
 * been shown to be the thing that worked — this is M0b's negative control, and it must reproduce
 * the numbers in constraint 58.
 */
function inlineWrite(d, u8, offset, length) {
  try {
    const n = d.handle.write(u8.subarray(offset, offset + length), { at: d.at });
    d.at += n;
    d.bytes += n;
    d.writes += 1;
    return n;
  } catch (e) {
    return -EIO;
  }
}

function inlineFsync(d) {
  try {
    d.handle.flush();
    d.flushes += 1;
    return 0;
  } catch (e) {
    return -EIO;
  }
}

/**
 * Open, through the I/O worker unless the inline control is armed. Either way it is awaited off
 * the dispatch path, because `createSyncAccessHandle` returns a promise — open was never the call
 * that blocked anybody (constraint 58).
 */
export async function openFile(k, name) {
  if (k.ioInline) {
    const root = k.opfsRoot();
    if (!root) return -EIO;
    try {
      const fh = await root.getFileHandle(name, { create: true });
      const handle = await fh.createSyncAccessHandle();
      return { kind: F_FILE, refs: 1, inline: true, handle, at: 0, bytes: 0, writes: 0, flushes: 0, name };
    } catch (e) {
      return -EIO;
    }
  }
  const io = k.io;
  if (!io) return -EIO;
  const ioId = await io.request(IO_OPEN, { name });
  if (ioId < 0) return ioId;
  return { kind: F_FILE, refs: 1, inline: false, io, ioId, name };
}

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
