// The process table: slots, monotonic never-reused pids, the hard cap, and the four fields M1
// writes once because adding them later would rework a live table. See MILESTONES.md M1 (a)-(c).
//
// Item (a): the `caps` bitmask, now, even though M6 narrows it. Monotonic: a widening after any
// narrowing is a bug and the assertion is on monotonicity, not on any particular bit pattern.
// Item (b): `sid` and the session leader link, enough field and invariant for M4's SIGHUP/SIGTTIN
// path to inherit something true. M1 does NOT claim SIGHUP works — see MILESTONES.md.
// Item (c): the exit reason, kind + value. terminate() leaves the dying worker no exit path, so
// the kernel is the only thing that can record this — written at teardown or lost forever.

import { PROC_CAP, EAGAIN, EPERM, CAP_ALL, STAT_EXITED, STAT_KILLED } from "../abi.mjs";
import { FileTable } from "./files.mjs";

export const SPAWNING = 0;
export const RUNNING = 1;
export const ZOMBIE = 2;
export const DEAD = 3;

/**
 * A slot carries the process's integers, and the host objects THE KERNEL holds on its behalf.
 *
 * Constraint 15, from the first line: a process worker holds exactly three host objects — its
 * own SAB, the globals SAB and its port — all three of which the kernel also holds and can drop,
 * and none of which needs a flush, a close or an unlock. The invariant, phrased to stay checkable
 * as the system grows: A PROCESS HOLDS NOTHING WHOSE CORRECTNESS DEPENDS ON IT RUNNING SHUTDOWN
 * CODE. `terminate()` runs none.
 */
class Slot {
  constructor(pid, index) {
    this.pid = pid;
    this.index = index;
    this.ppid = 0;
    this.pgid = pid;
    // M1 (b). The session id. setsid() sets sid = pgid = pid and records this slot as the leader.
    // The leader link is kept so M4's SIGHUP sweep can find every process in every process group
    // in the session in O(interested) rather than O(N) — field plus invariant, not feature.
    this.sid = pid;
    this.sidLeader = false;
    this.uid = 0;
    this.gid = 0;
    // M2. The working directory a relative path resolves against. A field rather than a syscall:
    // docs/ABI.md's path group lists no `chdir`, and M3's `/proc/<pid>/cwd` is what makes it
    // observable, so the field is here and the call that moves it is M3's.
    this.cwd = "/";
    // M3. The program this process is running, for `/proc/<pid>/cmdline`. Recorded by `spawn`
    // because the kernel is the only thing that knows it: the process is handed an image, not a
    // path, and a process that reported its own cmdline could report any string it liked.
    this.cmdline = "";
    // M4. A `go` armed by SYS_spawn and fired when this process reports ready. A child created by
    // a process runs itself; the page never sends it a go because the page does not know it exists.
    this.pendingGo = null;
    // The two reply scratch words a handler may set; cleared at every dispatch. kernel.mjs's
    // finish() reads them. See docs/ABI.md's fstat, readdir, statfs and seek.
    this.rlen = 0;
    this.r1 = 0;
    // M1 (a). The capability bitmask. CAP_ALL at spawn; M6 narrows and a widening MUST fail. The
    // invariant is monotonicity — asserted at every write, not derived from a symptom.
    this.caps = CAP_ALL | 0;
    this.state = SPAWNING;
    this.seq = 0;
    this.mask = 0;
    this.calls = 0;
    this.replies = 0;
    this.errors = 0;

    // M1 (c). The exit reason, written once at teardown. waitpid reads it and packs it into r1.
    // Two fields and not one int so the kernel cannot accidentally lose the kind bit by storing
    // a bare exit code: a kernel that wrote `exitStatus = 0` to mean "killed by SIGKILL (9) with
    // signum 0" would make waitpid indistinguishable from a clean exit of 0.
    this.exitKind = -1;    // -1 means "still running or nothing recorded yet"
    this.exitValue = 0;

    // The handler table: signum -> disposition (SIG_DFL | SIG_IGN | SIG_HANDLE). SIG_DFL and
    // SIG_IGN are what the kernel does at delivery time; SIG_HANDLE means "set the bit and the
    // process will drain it at syscall entry". M1 only reads this at delivery — kill() consults
    // it before raising a signal bit — so a change here does not need a per-slot per-signal
    // event, just a map update.
    this.sigDisp = new Map();

    // Kernel-held host objects.
    this.sab = null;
    this.ctl = null;
    this.bytes = null;
    this.port = null;
    this.worker = null;

    this.inflight = null;
    this.fds = new FileTable();
    // M1. Any waitpid caller parked on us records its pid in the parent's `waiters` map so the
    // teardown step can wake it synchronously, without needing a per-child map on the child side.
    this.waiters = [];
  }
}

/**
 * The monotonicity assertion for item (a). Named here so both the kernel and any later milestone
 * reduce caps through this single function — a widening falls out as a thrown error rather than
 * as a silent bit flip that gets noticed three capabilities later.
 */
export function dropCaps(slot, mask) {
  const before = slot.caps | 0;
  const after = (before & (mask | 0)) | 0;
  // Bitwise: an OR with the old value equal to the old value means every new bit is already
  // there. Any new bit anywhere is an error, and the check is the one place M6 touches this.
  if ((after | before) !== before) {
    throw new Error(`caps monotonicity violated: before=0x${(before >>> 0).toString(16)} `
      + `requested=0x${((mask | 0) >>> 0).toString(16)}`);
  }
  slot.caps = after;
  return after;
}

export class ProcTable {
  constructor(cap = PROC_CAP) {
    this.cap = cap;
    this.slots = new Array(cap).fill(null);
    this.byPid = new Map();
    this.live = new Set();
    // Monotonic and never reused from M0, so a stale pid in a message can never name a different
    // process than the one the sender meant.
    this.nextPid = 1;
    this.spawned = 0;
    this.refused = 0;
    this.reaped = 0;
  }

  /**
   * A free slot, or -EAGAIN when the cap is reached (constraint 17).
   *
   * THE CAP COUNTS KERNEL-SPAWNED PROCESSES ONLY, and at M0 that is not the same thing as the
   * renderer's worker count. A process worker can construct its own `new Worker` at depth 3,
   * holding the kernel's SAB and able to block (constraint 10 grants [[CanBlock]] to the whole
   * nested cluster) — a worker this table never sees. So constraint 17's cap is defeated by
   * construction until constraint 41's realm lockdown lands at M6, and M6's scope has to include
   * the program-loading path, because this design loads programs with dynamic `import()` and a
   * realm lockdown cannot delete that. M0 does not fix it; M0 must not claim it is fixed.
   */
  alloc() {
    const index = this.slots.indexOf(null);
    if (index < 0) {
      this.refused += 1;
      return -EAGAIN;
    }
    const slot = new Slot(this.nextPid++, index);
    this.slots[index] = slot;
    this.byPid.set(slot.pid, slot);
    this.live.add(slot);
    this.spawned += 1;
    return slot;
  }

  get(pid) {
    return this.byPid.get(pid);
  }

  /** Every live process in a pgid. O(live), not O(cap): a dead pgid returns an empty array in
   *  one pass rather than walking the whole slot array. M1 only has kill(-pgid) as its consumer;
   *  M4 adds pipeline teardown and the line discipline. */
  pgidMembers(pgid) {
    const out = [];
    for (const slot of this.live) if (slot.pgid === pgid) out.push(slot);
    return out;
  }

  /** Session members. Used by M4's SIGHUP sweep; M1 reports it from stats so the record of the
   *  leader link holding is inspectable at every milestone that comes after. */
  sidMembers(sid) {
    const out = [];
    for (const slot of this.live) if (slot.sid === sid) out.push(slot);
    return out;
  }

  /**
   * Mark a slot ZOMBIE and record the reason. Called from the teardown path (kernel.mjs), which
   * is item (d)'s two phases — this is only the row-of-the-table half. The slot is NOT removed:
   * waitpid reads this to produce its r1, and the pid is the parent's handle until then.
   *
   * Kind is STAT_EXITED or STAT_KILLED; `value` is the exit code or the signum. Setting them
   * once is the whole point: a clean exit of 0 is distinguishable from a SIGKILL whose value is
   * 9 by the kind field, not by the value.
   */
  recordExit(slot, kind, value) {
    if (kind !== STAT_EXITED && kind !== STAT_KILLED) {
      throw new Error(`exit kind must be STAT_EXITED or STAT_KILLED, not ${kind}`);
    }
    slot.exitKind = kind | 0;
    slot.exitValue = (value & 0xff) | 0;
    slot.state = ZOMBIE;
  }

  /** Drop every reference the kernel holds. Called by waitpid after the status has been read,
   *  which is what makes the ZOMBIE state visible for exactly one reap. */
  free(slot) {
    slot.state = DEAD;
    this.slots[slot.index] = null;
    this.byPid.delete(slot.pid);
    this.live.delete(slot);
    slot.sab = slot.ctl = slot.bytes = slot.port = slot.worker = null;
    this.reaped += 1;
  }
}
