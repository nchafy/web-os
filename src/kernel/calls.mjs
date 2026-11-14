// The dense syscall table. Adding a call is adding one entry in HANDLERS keyed by SYS_NAME, so
// the dispatch table is DERIVED from src/abi.mjs at boot (MILESTONES.md M1 item (f)): no second
// declaration of a syscall number, no generator, no build step.
//
// A handler receives the slot, and returns either a value or PENDING. It MUST NOT touch SEQ,
// STATUS, RLEN, the notify or G_INFLIGHT: reply() in kernel.mjs is the only writer of those, and
// that single invariant is what makes M1/M2/M4 additive — a new handler cannot get the wake
// protocol wrong because it cannot reach it.

import {
  A0, A1, A2, LEN_I32, DATA_OFF, MAX_INLINE, NSYS, SYS_NAME,
  EBADF, EINVAL, ENOSYS, EIO, EAGAIN, EPERM, EINTR, ECHILD, ESRCH,
  ELIMIT_ERRNO, STAT_EXITED, STAT_KILLED, WNOHANG,
  SIGKILL, SIGSTOP, SIG_DFL, SIG_IGN, SIG_HANDLE, SIG_BIT,
  unpackI64,
} from "../abi.mjs";
import { KIND_OPS, openFile } from "./files.mjs";
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
  if ((d.inflight | 0) >= (d.cap | 0 || 64)) return -ELIMIT_ERRNO;
  d.inflight = (d.inflight | 0) + 1;
  return 0;
}

function dischargeFd(d) {
  if (!d) return;
  d.inflight = Math.max(0, (d.inflight | 0) - 1);
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
  if (r && typeof r.then === "function") {
    k.later(p, () => r.finally(() => dischargeFd(d)));
    return PENDING;
  }
  dischargeFd(d);
  return r;
};

HANDLERS.open = (p, k) => {
  const root = k.opfsRoot();
  if (!root) return -EIO;
  const length = Atomics.load(p.ctl, LEN_I32);
  if (length < 0 || length > MAX_INLINE) return -EINVAL;
  const name = new TextDecoder().decode(
    new Uint8Array(p.bytes.subarray(DATA_OFF, DATA_OFF + length)));
  if (!name || name.includes("/") || name.includes("\0")) return -EINVAL;
  k.later(p, async () => {
    const d = await openFile(k, name);
    if (typeof d === "number") return d;
    return p.fds.add(d);
  });
  return PENDING;
};

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
