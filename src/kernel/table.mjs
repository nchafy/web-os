// The process table: slots, monotonic never-reused pids, and the hard cap (constraint 17).

import { PROC_CAP, EAGAIN, EPERM, CAP_ALL, STAT_EXITED, STAT_KILLED } from "../abi.mjs";
import { FileTable } from "./files.mjs";

export const SPAWNING = 0;
export const RUNNING = 1;
export const ZOMBIE = 2;
export const DEAD = 3;

/** A slot carries the process's integers, and the host objects the kernel holds on its behalf:
 *  nothing whose correctness depends on the process running shutdown code (constraint 15). */
class Slot {
  constructor(pid, index) {
    this.pid = pid;
    this.index = index;
    this.ppid = 0;
    this.pgid = pid;
    // setsid() sets sid = pgid = pid and records this slot as the leader. The leader link keeps a
    // session-wide sweep O(interested) rather than O(N) (constraint 18).
    this.sid = pid;
    this.sidLeader = false;
    this.uid = 0;
    this.gid = 0;
    this.cwd = "/";
    // For `/proc/<pid>/cmdline`. Recorded by `spawn`: a process reporting its own could say
    // anything.
    this.cmdline = "";
    // A `go` armed by SYS_spawn and fired when this process reports ready.
    this.pendingGo = null;
    // The two reply scratch words a handler may set; cleared at every dispatch. See kernel.mjs's
    // finish(), and docs/ABI.md's fstat, readdir, statfs and seek.
    this.rlen = 0;
    this.r1 = 0;
    // CAP_ALL at spawn; the invariant is monotonicity, asserted at every write — see dropCaps.
    this.caps = CAP_ALL | 0;
    this.state = SPAWNING;
    this.seq = 0;
    this.mask = 0;
    this.calls = 0;
    this.replies = 0;
    this.errors = 0;
    /* WHAT A TASK MANAGER CAN HONESTLY SHOW, and it is not a CPU percentage.
     *
     * There is no scheduler here: a process is a Worker and the browser decides when it runs, so
     * "% CPU" is a number this kernel does not have and would have to invent. What it DOES have is
     * the time it spent servicing this process's syscalls — measured at dispatch, the same clock
     * `kServiceMs` already accumulated globally — and the bytes that crossed `read` and `write`.
     * Those are real, attributable, and what `src/bin/taskmgr.mjs` shows under names that say what
     * they are: KRNLms and the two byte counts, never "CPU%".
     *
     * `serviceMs` is kernel time and NOT this process's own compute: a process spinning in a tight
     * JS loop makes no syscalls and so accrues none of it. The task manager says so on its face,
     * because a number whose meaning a reader guesses at is worse than one they are told. */
    this.serviceMs = 0;
    this.readBytes = 0;
    this.writeBytes = 0;

    // The exit reason, written once at teardown; waitpid packs it into r1. Two fields and not one
    // int, so a clean exit of 0 stays distinguishable from a kill.
    this.exitKind = -1;    // -1 means "still running or nothing recorded yet"
    this.exitValue = 0;

    // signum -> disposition (SIG_DFL | SIG_IGN | SIG_HANDLE), consulted at delivery.
    this.sigDisp = new Map();

    this.sab = null;
    this.ctl = null;
    this.bytes = null;
    this.port = null;
    this.worker = null;

    this.inflight = null;
    this.fds = new FileTable();
    this.waiters = [];
  }
}

/** The one reducer of `caps`. A widening throws rather than becoming a silent bit flip. */
export function dropCaps(slot, mask) {
  const before = slot.caps | 0;
  const after = (before & (mask | 0)) | 0;
  // `(after | before) === before` means every bit of `after` was already set: no widening.
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
    // Never reused, so a stale pid cannot name a different process than the sender meant.
    this.nextPid = 1;
    this.spawned = 0;
    this.refused = 0;
    this.reaped = 0;
  }

  /** A free slot, or -EAGAIN when the cap is reached (constraint 17). The cap counts kernel-spawned
   *  processes, and that IS the renderer's worker count: the realm strip leaves a process no way to
   *  construct a worker this table never sees (constraints 53, 190, 206). */
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

  /** Every live process in a pgid. O(live), not O(cap). */
  pgidMembers(pgid) {
    const out = [];
    for (const slot of this.live) if (slot.pgid === pgid) out.push(slot);
    return out;
  }

  sidMembers(sid) {
    const out = [];
    for (const slot of this.live) if (slot.sid === sid) out.push(slot);
    return out;
  }

  /** Mark a slot ZOMBIE and record the reason. The slot is NOT removed: waitpid reads it to produce
   *  its r1, and the pid is the parent's handle until then. */
  recordExit(slot, kind, value) {
    if (kind !== STAT_EXITED && kind !== STAT_KILLED) {
      throw new Error(`exit kind must be STAT_EXITED or STAT_KILLED, not ${kind}`);
    }
    slot.exitKind = kind | 0;
    slot.exitValue = (value & 0xff) | 0;
    slot.state = ZOMBIE;
  }

  /** Drop every reference the kernel holds. Called only by `scheduleFree`'s quarantine timer. */
  free(slot) {
    slot.state = DEAD;
    this.slots[slot.index] = null;
    this.byPid.delete(slot.pid);
    this.live.delete(slot);
    slot.sab = slot.ctl = slot.bytes = slot.port = slot.worker = null;
    this.reaped += 1;
  }
}
