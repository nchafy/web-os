// `/dev/console`: the one console window, as a file description, so `poll()` is the single wait
// primitive over it (constraint 42). The page drives it over the kernel's own message port —
// `t: "console-in"` for keystrokes, `t: "console-out"` for cells. A PROCESS CANNOT POST EITHER:
// that port is the kernel's, and `src/kernel/kernel.mjs` serves these two kinds only from it.

import { EHOSTGONE, ST_RETURN, PTY_INPUT_BYTES } from "../abi.mjs";
import { ByteRing } from "../fs/ring.mjs";

/** Injected at boot, never imported: `kernel.mjs` imports this file and the reverse is a cycle.
 *  The shape `pipe.mjs` and `pty.mjs` take. */
let K = null;

export function installConsoleKernel(surface) {
  K = surface;
}

/** The keystroke queue, in bytes: the same 4,096 as the pty this device feeds, so a larger queue
 *  would only move where the overflow happens. */
export const CONSOLE_INPUT_BYTES = PTY_INPUT_BYTES;

/**
 * THE "NOT RESPONDING" THRESHOLDS, in ms of keystrokes queued and unread
 * (`docs/designs/fidelity-first.md`). What is measured is the AGE OF THE OLDEST KEYSTROKE NOBODY
 * HAS TAKEN, not "has the process made a syscall" — a process in `sleep 60` makes none.
 *
 * HYSTERESIS IS THE DRAIN, NOT A SECOND TIME: entering needs the queue stale for 1,000 ms, leaving
 * needs it EMPTY, so one byte read out of a stale queue is still not collecting the input.
 */
export const NOT_RESPONDING_MS = 1000;
export const END_PROCESS_MS = 5000;

export class Console {
  constructor() {
    this.keys = new ByteRing(CONSOLE_INPUT_BYTES);
    /** Whether the DOM object behind this device still exists. `false` answers -EHOSTGONE and
     *  NEVER 0: 0 on a read is end of input, which a shell treats as a clean logout, so the two
     *  confused would report a crashed window as a user who typed Ctrl-D. */
    this.attached = true;
    /** Open descriptions, so `poll` can report POLLHUP once the last one goes. */
    this.opens = 0;
    /** STARTING IS NOT WEDGED: keystrokes typed while a relay is still spawning sit in a queue
     *  nobody has promised to read, so the stale clock must not run. Once true this STAYS true, so
     *  a relay that opened the device and then died has the clock governing and the caption greys. */
    this.openedEver = false;
    /** Parked readers: {slot, seq, into, off, want}. Same record shape the pipe parks. */
    this.waitingReaders = [];
    /** When the oldest unread keystroke was queued, or 0 for "nothing is waiting". A keystroke
     *  handed straight to a parked reader never sets it: that one was collected. */
    this.unreadSince = 0;
    /** 0 responding, 1 greyed, 2 End Process. Edge-triggered: the kernel posts on a CHANGE. */
    this.level = 0;
    /** What `starting()` was when the level was last reported. The LEVEL does not change when a
     *  relay opens the device, so without this the page's "(Starting…)" never comes off. */
    this.reportedStarting = true;
    this.stats = {
      keyBytes: 0, cellBytes: 0, reads: 0, writes: 0, posts: 0, dropped: 0,
      readerParks: 0, stale: 0, detachedReads: 0, detachedWrites: 0,
    };
  }

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

  /**
   * Keystrokes from the page. THE ONE READINESS IN THE SYSTEM WITH NO SYSCALL REPLY BEHIND IT, so
   * it calls `pollWake` itself: `calls.mjs` hooks `pollWake` on `reply`, and without the explicit
   * wake a process parked in `poll` sleeps to its timeout — the lost wake of constraint 109.
   */
  feed(bytes) {
    if (!this.attached || bytes.length === 0) return 0;
    this.#prune();
    // Straight to a parked reader, for the pipe's reason: a reader parked on a 1-byte read must be
    // woken by a 1-byte keystroke whatever the queue holds.
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
      this.stats.dropped += (bytes.length - at - n);
      at += n;
      // The FIRST unread byte starts the clock; later ones must not restart it.
      if (n > 0 && this.unreadSince === 0) this.unreadSince = K.now();
    }
    if (K.pollWake) K.pollWake();
    return at;
  }

  /** Parked readers are answered -EHOSTGONE now: a process parked in `read` makes no next call. */
  detach() {
    if (!this.attached) return 0;
    this.attached = false;
    this.#prune();
    const answered = this.waitingReaders.length;
    for (const r of this.waitingReaders) K.reply(r.slot, -EHOSTGONE, -1, ST_RETURN, 0);
    this.waitingReaders = [];
    this.keys.clear();
    // A closed window is not a slow one: `staleMs` growing here would caption a frame that is gone.
    this.unreadSince = 0;
    if (K.pollWake) K.pollWake();
    return answered;
  }

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
      // HYSTERESIS: cleared by an EMPTY queue, never by a partial read. See NOT_RESPONDING_MS.
      if (this.keys.length === 0) this.unreadSince = 0;
      return n;
    }
    // Parking, not 0: 0 is end of input and would log the user out every time they stopped typing.
    this.waitingReaders.push({ slot, seq, into, off, want });
    this.stats.readerParks += 1;
    return null;
  }

  /**
   * A count or -EHOSTGONE; never parks. A DISPLAY DOES NOT BLOCK ITS WRITER, so there is no output
   * ring here and no POLLOUT to compute: the pty's own 16 KiB `PTY_OUTPUT_BYTES` bounds a program
   * that outruns the screen. The copy is NOT optional — the source is the caller's SAB, which the
   * caller may overwrite the instant its call is answered.
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

  /** Readable: a keystroke is queued, or the window is gone and the read would answer at once. */
  readable() {
    return !this.attached || this.keys.length > 0;
  }

  /** Detached is NOT writable: a poller told it could write would write and get -EHOSTGONE. */
  writable() {
    return this.attached;
  }

  hungUp() {
    return !this.attached;
  }

  staleMs() {
    return this.unreadSince === 0 ? 0 : Math.max(0, K.now() - this.unreadSince);
  }

  /** The level if it CHANGED, else -1. Driven by the kernel's existing heartbeat: a message per
   *  heartbeat per window is the O(N) fan-out constraint 18 forbids. */
  sample() {
    // NOT RESPONDING REQUIRES SOMEBODY WHO WAS SUPPOSED TO RESPOND. See `openedEver`.
    const ms = this.openedEver ? this.staleMs() : 0;
    const next = ms >= END_PROCESS_MS ? 2 : (ms >= NOT_RESPONDING_MS ? 1 : 0);
    // Either axis moving is a transition. See `reportedStarting`.
    if (next === this.level && this.starting() === this.reportedStarting) return -1;
    this.level = next;
    this.reportedStarting = this.starting();
    return next;
  }

  /** Waiting for a first opener. The page shows "(Starting…)", not "(Not Responding)". */
  starting() {
    return !this.openedEver;
  }

  close() {
    this.opens = Math.max(0, this.opens - 1);
    return 0;
  }

  /** A stopped terminal raises no error — a parked reader is a legitimate state — so this is the
   *  only way to tell a working relay from a wedged one. */
  report() {
    return {
      attached: this.attached,
      opens: this.opens,
      queued: this.keys.length,
      parked: this.waitingReaders.length,
      level: this.level,
      staleMs: Math.round(this.staleMs()),
      openedEver: this.openedEver,
      starting: this.starting(),
      ...this.stats,
    };
  }
}
