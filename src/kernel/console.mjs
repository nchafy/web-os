// `/dev/console`: the window, as a file description.
//
// ======================================================================================
// THIS IS M4a's SPECIAL CASE AND IT HAS AN EXPIRY DATE.
//
// `MILESTONES.md` M4a: "This window is special-cased, not an ABI. M7 generalises it and deletes
// the special case. Say so in the code or it becomes the architecture by accident." This file is
// where it is said.
//
// WHAT IS SPECIAL. There is exactly ONE console, it is created by the kernel at boot rather than
// by a syscall, and `/dev/console` is the only name for it. M7's `win_create` is the general
// form: a process asks for a window, gets an fd back, and may have several. Nothing here is a
// step towards that except the ONE decision below, which M7 keeps.
//
// WHAT IS NOT SPECIAL, AND MUST NOT BE UNDONE: a window is a FILE DESCRIPTION, so `poll()` is
// the single wait primitive over it. `docs/designs/REVIEW-FINDINGS.md` finding 1 is the whole
// reason, and its *corrected* scenario is the one M4a walks into: a terminal process parked in
// `read(master)` at idle with no output has its keystrokes pile up unread and the keys are dead
// indefinitely. A `winid` that was not an fd would need a busy-poll loop to service a window and
// a pty together. Constraint 42 states the rule; this file obeys it by being a kind in
// `files.mjs`'s ops table and a row in `pollOne`.
//
// WHY THE PAGE AND NOT A PROCESS OWNS THE PIXELS. A process cannot touch the DOM: it is a Worker,
// and constraint 15 keeps everything releasable kernel-side anyway. The page is the supervisor
// (`docs/DECISIONS.md` D18), so the DOM half of the terminal lives there and reaches the device
// through the kernel's own message port — `t: "console-in"` for keystrokes, `t: "console-out"`
// for cells. A PROCESS CANNOT POST EITHER: the port the page holds is the kernel's, and
// `src/kernel/kernel.mjs` serves these two kinds only from it.
// ======================================================================================

import { EHOSTGONE, ST_RETURN } from "../abi.mjs";
import { ByteRing } from "../fs/ring.mjs";

/** The kernel surface a console needs. Injected once at boot, never imported: `kernel.mjs`
 *  imports this file and the reverse would be a cycle. The same shape `pipe.mjs` and `pty.mjs`
 *  take, for the same reason. */
let K = null;

export function installConsoleKernel(surface) {
  K = surface;
}

/**
 * The keystroke queue, in bytes.
 *
 * ONE LINE OF TYPING, which is `PTY_INPUT_BYTES`'s reasoning and the same number: a keyboard is
 * not a bulk transport, and the pty behind this device holds 4,096 bytes of input itself. A queue
 * larger than the thing it feeds would only move where the overflow happens.
 *
 * AN OVERFLOW IS COUNTED, NOT HIDDEN. `dropped` is in the stats and in `/dev/console`'s report,
 * for the reason `/dev/trace`'s dropped-record counter is in its header (`src/kernel/devfs.mjs`):
 * a reader who obtains the keystrokes without obtaining the number of keystrokes they are missing
 * cannot tell a working terminal from a lossy one.
 */
export const CONSOLE_INPUT_BYTES = 4096;

/**
 * THE "NOT RESPONDING" THRESHOLDS, in milliseconds of keystrokes queued and unread.
 *
 * Deferred from M1 because there was no UI to hook; `docs/handoff/CONTINUE-HERE.md` records it as
 * landing here. The two numbers are `docs/designs/fidelity-first.md`'s: the caption greys at
 * 1,000 ms and the End Process affordance appears at 5,000 ms. Windows 7's own detector is the
 * precedent and the one being imitated.
 *
 * WHAT IS MEASURED, because the alternative is a detector that fires on a healthy program. NOT
 * "has the process made a syscall" — a process in `sleep 60` is perfectly well and makes none.
 * What is measured is the AGE OF THE OLDEST KEYSTROKE NOBODY HAS TAKEN: the window has work
 * waiting for it and is not collecting it. That is the condition a user calls "not responding",
 * and it is the condition this device can observe without asking the process anything.
 *
 * HYSTERESIS IS THE DRAIN, NOT A SECOND TIME. Entering needs the queue to be stale for 1,000 ms;
 * leaving needs it EMPTY. So the state cannot chatter at the boundary — a process that reads one
 * byte of a stale queue has not recovered and is still not collecting its input. Both edges are
 * checked (`CLAUDE.md` §Verification), and they are checked on the DOM caption, which is what a
 * reader would actually hit.
 */
export const NOT_RESPONDING_MS = 1000;
export const END_PROCESS_MS = 5000;

export class Console {
  constructor() {
    /** Keystrokes from the page, waiting for whoever holds the fd. */
    this.keys = new ByteRing(CONSOLE_INPUT_BYTES);
    /**
     * Whether the DOM object behind this device still exists.
     *
     * `false` is what `EHOSTGONE` was reserved for (`docs/ABI.md` §Errors: "the DOM object behind
     * a host fd was destroyed", errno 100). A closed window must not leave a process parked for
     * ever, and it must not answer 0 either — 0 on a read means end of input, which a shell
     * treats as a clean logout. The two are different events and a terminal that confuses them
     * reports a crashed window as a user who typed Ctrl-D.
     */
    this.attached = true;
    /** Open descriptions, so `poll` can report POLLHUP once the last one goes. */
    this.opens = 0;
    /** Parked readers: {slot, seq, into, off, want}. Same record shape the pipe parks. */
    this.waitingReaders = [];
    /**
     * When the oldest unread keystroke was queued, or 0 for "nothing is waiting".
     *
     * Set only when a keystroke lands in the ring with nobody parked to take it, and cleared when
     * the ring empties. A keystroke handed straight to a parked reader never sets it: that one was
     * collected, which is the whole condition being measured. See NOT_RESPONDING_MS.
     */
    this.unreadSince = 0;
    /** The level this device last reported to the page: 0 responding, 1 greyed, 2 End Process.
     *  Edge-triggered, so the kernel posts on a CHANGE and not once per heartbeat. */
    this.level = 0;
    this.stats = {
      keyBytes: 0, cellBytes: 0, reads: 0, writes: 0, posts: 0, dropped: 0,
      readerParks: 0, stale: 0, detachedReads: 0, detachedWrites: 0,
    };
  }

  /* ---- liveness, the same sequence guard the pipe and the pty use ----------------------- */

  #live(rec) {
    if (!rec.slot.ctl || rec.slot.seq !== rec.seq) {
      this.stats.stale += 1;
      return false;
    }
    return true;
  }

  #prune() {
    this.waitingReaders = this.waitingReaders.filter((r) => this.#live(r));
  }

  /* ---- the page's half ------------------------------------------------------------------ */

  /**
   * Keystrokes have arrived from the page.
   *
   * THIS IS THE ONE READINESS IN THE SYSTEM THAT ARRIVES WITHOUT A SYSCALL REPLY, and that is why
   * it calls `pollWake` itself. `calls.mjs`'s `pollWake` is hooked on `reply` — "the one funnel
   * every state change that could make an fd ready passes through" — and a keystroke passes
   * through no funnel at all: it is a `postMessage` from the page. Without the explicit wake a
   * process parked in `poll` over the console and the pty master sleeps until its timeout, which
   * is exactly the lost wake constraint 109 is about. Measured as the first defect of this file.
   */
  feed(bytes) {
    if (!this.attached || bytes.length === 0) return 0;
    this.#prune();
    // Straight to a parked reader where one is waiting, for the pipe's reason: a reader parked on
    // a 1-byte read must be woken by a 1-byte keystroke whatever the queue holds.
    let at = 0;
    while (at < bytes.length && this.waitingReaders.length) {
      const r = this.waitingReaders[0];
      if (!this.#live(r)) { this.waitingReaders.shift(); continue; }
      this.waitingReaders.shift();
      const n = Math.min(r.want, bytes.length - at);
      r.into.set(bytes.subarray(at, at + n), r.off);
      at += n;
      this.stats.keyBytes += n;
      this.stats.reads += 1;
      K.reply(r.slot, n, 0, ST_RETURN, n);
    }
    if (at < bytes.length) {
      const n = this.keys.push(bytes, at);
      this.stats.keyBytes += n;
      // The remainder had nowhere to go. A dropped keystroke is a real event and it is counted.
      this.stats.dropped += (bytes.length - at - n);
      at += n;
      // NOBODY TOOK IT. The clock for "not responding" starts at the FIRST such byte and is not
      // restarted by later ones — a window that is ignoring its input must not look healthier the
      // more the user types at it.
      if (n > 0 && this.unreadSince === 0) this.unreadSince = K.now();
    }
    // Readiness with no reply behind it. See the note above.
    if (K.pollWake) K.pollWake();
    return at;
  }

  /**
   * The window is gone.
   *
   * Every parked reader is answered -EHOSTGONE immediately rather than on its next call: a
   * process parked in `read` cannot make a next call. After this, reads and writes refuse with
   * the same errno and `poll` reports POLLHUP, so a relay that polls learns about the closure
   * without having to read first.
   */
  detach() {
    if (!this.attached) return 0;
    this.attached = false;
    this.#prune();
    const answered = this.waitingReaders.length;
    for (const r of this.waitingReaders) K.reply(r.slot, -EHOSTGONE, -1, ST_RETURN, 0);
    this.waitingReaders = [];
    this.keys.clear();
    // AND THE STALE CLOCK STOPS. Without this the queue was cleared and `unreadSince` was left
    // set, so `staleMs` kept growing against a window that no longer exists and the detector
    // reported a DESTROYED window as "not responding" — a caption on a frame that is gone, and a
    // transition the page would have to learn to ignore. A closed window is not a slow one.
    this.unreadSince = 0;
    if (K.pollWake) K.pollWake();
    return answered;
  }

  /* ---- the process's half -------------------------------------------------------------- */

  /** Read keystrokes. A count, -EHOSTGONE, or null meaning parked. */
  readKeys(slot, seq, into, off, want) {
    this.#prune();
    if (!this.attached) {
      this.stats.detachedReads += 1;
      return -EHOSTGONE;
    }
    if (want <= 0) return 0;
    if (this.keys.length > 0) {
      const n = this.keys.shift(into, off, want);
      this.stats.reads += 1;
      // HYSTERESIS: the stale clock is cleared by an EMPTY queue, never by a partial read. A
      // process taking one byte of a thousand it has been sitting on has not started collecting
      // its input. See NOT_RESPONDING_MS.
      if (this.keys.length === 0) this.unreadSince = 0;
      return n;
    }
    // PARK. A terminal at idle is the normal state, so this is not an error and must not be 0:
    // 0 is end of input and would log the user out every time they stopped typing.
    this.waitingReaders.push({ slot, seq, into, off, want });
    this.stats.readerParks += 1;
    return null;
  }

  /**
   * Write cells to the window. A count or -EHOSTGONE; never parks.
   *
   * A DISPLAY DOES NOT BLOCK ITS WRITER, which is why there is no output ring and no POLLOUT
   * condition to compute. The bytes go to the page in the posted message and the page owns what
   * happens next; `structuredClone` of a copy is the cost, and it is paid per write rather than
   * per byte. The pty's own 16 KiB output ring is what bounds a program that outruns the screen
   * (`PTY_OUTPUT_BYTES`), and that bound is already measured — a second queue here would be a
   * second place for the same backpressure to be wrong.
   *
   * The copy is NOT optional: the source is the caller's SAB, which the caller may overwrite the
   * instant its call is answered.
   */
  writeCells(bytes) {
    if (!this.attached) {
      this.stats.detachedWrites += 1;
      return -EHOSTGONE;
    }
    if (bytes.length === 0) return 0;
    const copy = bytes.slice();
    this.stats.cellBytes += copy.length;
    this.stats.writes += 1;
    this.stats.posts += 1;
    K.post({ t: "console-out", bytes: copy });
    return copy.length;
  }

  /* ---- what `poll` asks ---------------------------------------------------------------- */

  /** Readable: a keystroke is queued, or the window is gone and the read would answer at once. */
  readable() {
    return !this.attached || this.keys.length > 0;
  }

  /** Writable: always, while attached. See `writeCells` for why there is no queue to be full of.
   *  Detached is NOT writable: a poller told it could write would write and get -EHOSTGONE, which
   *  is the defect `pollOne`'s unconditional POLLOUT had for the pty slave. */
  writable() {
    return this.attached;
  }

  /** Whether `poll` should report POLLHUP: the window is gone. */
  hungUp() {
    return !this.attached;
  }

  /* ---- the "not responding" detector --------------------------------------------------- */

  /** How long the oldest unread keystroke has been waiting, in ms. 0 when nothing is waiting. */
  staleMs() {
    return this.unreadSince === 0 ? 0 : Math.max(0, K.now() - this.unreadSince);
  }

  /**
   * Re-evaluate the level and return it if it CHANGED, else -1.
   *
   * Called from the kernel's heartbeat, which is already running at HB_PERIOD_MS and is already
   * O(1) — a detector with its own timer would be a second clock to keep in step. Edge-triggered
   * so the page is told about a transition and not about every tick: a message per heartbeat per
   * window is the O(N) fan-out constraint 18 forbids, at the one moment the UI is least able to
   * afford it.
   */
  sample() {
    const ms = this.staleMs();
    const next = ms >= END_PROCESS_MS ? 2 : (ms >= NOT_RESPONDING_MS ? 1 : 0);
    if (next === this.level) return -1;
    this.level = next;
    return next;
  }

  close() {
    this.opens = Math.max(0, this.opens - 1);
    return 0;
  }

  /** State for a page's own timeout to attach, and for the check to assert the mechanism rather
   *  than only the outcome. A stopped terminal raises no error — a parked reader is a legitimate
   *  state — so this is the only way to tell a working relay from a wedged one. */
  report() {
    return {
      attached: this.attached,
      opens: this.opens,
      queued: this.keys.length,
      parked: this.waitingReaders.length,
      level: this.level,
      staleMs: Math.round(this.staleMs()),
      ...this.stats,
    };
  }
}
