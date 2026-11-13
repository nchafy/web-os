// The dense syscall table. Adding a call is adding a row.
//
// A handler receives the slot, and returns either a value or PENDING. It MUST NOT touch SEQ,
// STATUS, RLEN, the notify or G_INFLIGHT: reply() in kernel.mjs is the only writer of those, and
// that single invariant is what makes M1/M2/M4 additive — a new handler cannot get the wake
// protocol wrong because it cannot reach it.

import {
  A0, A1, A2, LEN_I32, DATA_OFF, MAX_INLINE, NSYS,
  SYS_getpid, SYS_write, SYS_clock_nanosleep, SYS_open, SYS_fsync,
  EBADF, EINVAL, ENOSYS, EIO, unpackI64,
} from "../abi.mjs";
import { KIND_OPS, openFile } from "./files.mjs";

/** A handler that will reply later, by calling k.reply() itself. */
export const PENDING = Symbol("PENDING");

/**
 * @param k the kernel's reply surface: { reply, fail, setTimer }
 * @returns a dense Array(NSYS) indexed by syscall number
 */
export function buildCalls(k) {
  const table = new Array(NSYS);

  table[SYS_getpid] = (p) => p.pid;

  table[SYS_write] = (p) => {
    const fd = p.ctl[A0];
    // The length word is read with an atomic load BEFORE a byte is touched, and an impossible
    // length is -EINVAL rather than a clamp. Clamping is exactly wanix's defect: silent
    // truncation above 16,360 bytes, presented as success (constraint 9).
    const length = Atomics.load(p.ctl, LEN_I32);
    if (length < 0 || length > MAX_INLINE) return -EINVAL;
    const d = p.fds.get(fd);
    if (!d) return -EBADF;
    const ops = KIND_OPS[d.kind];
    if (!ops || !ops.write) return -ENOSYS;
    return ops.write(d, p.bytes, DATA_OFF, length);
  };

  // M0a. open is SLOW but cheap to serve: createSyncAccessHandle returns a promise, so the 495 us
  // (constraint 22) is awaited off the dispatch path and no other process waits for it. This is
  // constraint 57's rule applied — a syscall that must wait does not hold the kernel thread.
  table[SYS_open] = (p) => {
    const root = k.opfsRoot();
    if (!root) return -EIO;
    const length = Atomics.load(p.ctl, LEN_I32);
    if (length < 0 || length > MAX_INLINE) return -EINVAL;
    // The copy is not avoidable and not incidental: TextDecoder refuses a view backed by a
    // SharedArrayBuffer ("must not be shared"), so the bytes are lifted into a private buffer
    // first. M2's path resolution will hit the same wall on every path argument.
    const name = new TextDecoder().decode(
      new Uint8Array(p.bytes.subarray(DATA_OFF, DATA_OFF + length)));
    if (!name || name.includes("/") || name.includes("\0")) return -EINVAL;
    k.later(p, async () => {
      const d = await openFile(root, name);
      return p.fds.add(d);
    });
    return PENDING;
  };

  // And fsync is the reverse: a cheap-sounding call that is expensive to SERVE, because flush() is
  // synchronous and 260 us of kernel thread nobody else can use (constraint 23). M0a measures what
  // that does to every other process's latency.
  table[SYS_fsync] = (p) => {
    const d = p.fds.get(p.ctl[A0]);
    if (!d) return -EBADF;
    const ops = KIND_OPS[d.kind];
    if (!ops || !ops.fsync) return -ENOSYS;
    return ops.fsync(d);
  };

  // The async path exists at M0 precisely so it exists before M2's OPFS handlers need it.
  table[SYS_clock_nanosleep] = (p) => {
    const ns = unpackI64(p.ctl[A0], p.ctl[A1]);
    if (ns < 0n) return -EINVAL;
    if (p.ctl[A2] !== 0) return -ENOSYS;   // no TIMER_ABSTIME at M0
    k.setTimer(p, Number(ns / 1000000n));
    return PENDING;
  };

  return table;
}

/** performance.now() busy-spin, in microseconds. */
function spinUs(us) {
  const until = performance.now() + us / 1000;
  while (performance.now() < until) { /* occupying the kernel thread is the point */ }
}

/**
 * The kernel-stall control (MILESTONES' M0 negative control). A boot-time wrapper per row, so
 * the headline path contains no control branch at all and "your flag perturbed the measurement"
 * is not available as an objection.
 *
 * The spin sits INSIDE the kernel's service region — after the request is read, before the reply
 * is published — because that is where a real handler's cost sits and that is what serialises
 * every other process.
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
