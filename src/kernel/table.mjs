// The process table: slots, monotonic never-reused pids, and the hard cap.

import { PROC_CAP, EAGAIN } from "../abi.mjs";
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
    this.uid = 0;
    this.gid = 0;
    this.state = SPAWNING;
    this.seq = 0;
    this.mask = 0;
    this.calls = 0;
    this.replies = 0;
    this.errors = 0;
    this.exitCode = -1;

    // Kernel-held host objects.
    this.sab = null;
    this.ctl = null;
    this.bytes = null;
    this.port = null;
    this.worker = null;

    this.inflight = null;
    this.fds = new FileTable();
    this.waiters = [];        // M1. Empty now, and it costs nothing empty.
  }
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

  /** Drop every reference the kernel holds. Teardown is M1's; this is only the table half. */
  free(slot) {
    slot.state = DEAD;
    this.slots[slot.index] = null;
    this.byPid.delete(slot.pid);
    this.live.delete(slot);
    slot.sab = slot.ctl = slot.bytes = slot.port = slot.worker = null;
  }
}
