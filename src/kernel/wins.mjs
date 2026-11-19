// M7. A WINDOW IS A FILE DESCRIPTION. `win_create` returns an fd; the window's events are that
// fd's readable set; `poll()` is the single wait primitive over it (constraint 42).
//
// This replaces M4a's `/dev/console`, which was ONE window, created by the page, named in a mount
// table static at boot (`docs/DECISIONS.md` D25 recorded the expiry). The reason it had to go is
// arithmetic rather than taste: a process has ONE futex word and ONE outstanding call, so a
// per-window wait leaves a process holding two windows unable to be woken by both, and a device
// file the page creates cannot be created by the process that wants it.
//
// What survived the replacement unchanged is the ONE decision underneath M4a: the ops row in
// `src/kernel/files.mjs` and the row in `pollOne`. A window is still `F_WIN`.
//
//   page  -> win-in   -> event ring -> read(fd)  by the owning process
//   proc  -> write(fd) -> win-out    -> cells on the screen
//
// A PROCESS CANNOT POST `win-in`: that port is the page's, and `src/kernel/kernel.mjs` serves the
// page kinds only from it.

import {
  EHOSTGONE, EINVAL, EBADF, ENOENT, EMFILE, EPERM, ST_RETURN,
  WEV_BYTES, WEV_KEY, WEV_RESIZE, WEV_CLOSE, WEV_FOCUS, WEV_DESTROYED, WEV_MAX,
  WIN_EVENT_CAP, WIN_CAP, encodeWinEvent,
} from "../abi.mjs";
import { ByteRing } from "../fs/ring.mjs";

/** Injected at boot, never imported: `kernel.mjs` imports this file and the reverse is a cycle.
 *  The shape `pipe.mjs`, `pty.mjs` and M4a's console all take. */
let K = null;

export function installWindowKernel(surface) {
  K = surface;
}

/** M7's SECOND NEGATIVE CONTROL, boot-gated on bench=1 (`src/kernel/kernel.mjs`): destroying a
 *  parent destroys ONLY the parent. The obvious implementation, and the one that leaves a dialog on
 *  screen over a window that is gone — and leaves the caller holding fds for windows the kernel has
 *  forgotten, which is the desynchronisation the destroy list exists to prevent. */
let cascade = true;

export function setCascade(on) {
  cascade = !!on;
}

/**
 * THE "NOT RESPONDING" THRESHOLDS, in ms of events queued and uncollected
 * (`docs/designs/fidelity-first.md`). Carried over from M4a's console with ONE state deleted:
 * "(Starting…)" was a window the page had attached that no process had opened yet, and with
 * `win_create` the creating process holds the fd from the window's first instant, so the state is
 * unreachable. A caption nothing can produce is dead code (constraint 210).
 *
 * HYSTERESIS IS THE DRAIN, NOT A SECOND TIME: entering needs the queue stale for 1,000 ms, leaving
 * needs it EMPTY, so one event read out of a stale queue is still not collecting the input.
 */
export const NOT_RESPONDING_MS = 1000;
export const END_PROCESS_MS = 5000;

/** The event queue, in bytes. One ring implementation for every queue in the kernel
 *  (constraint 112), so the straddling push is written once. */
export const WIN_EVENT_BYTES = WIN_EVENT_CAP * WEV_BYTES;

/** The default box a `win_create` with no geometry asks for. The PAGE clamps and reports back what
 *  it did (see `setBox`): the kernel records geometry and never computes it, because the surface it
 *  would have to measure is in the other agent. */
const DEFAULT_W = 560;
const DEFAULT_H = 360;

export class Window {
  constructor(id, pid, spec) {
    this.id = id;
    /** The CREATING process. Not an authority — the fd is — but the only way `/proc` can list a
     *  window under the process that made it. */
    this.pid = pid;
    this.title = String(spec.title || "");
    /** Owner winid, or 0. MAY NAME A WINDOW IN ANOTHER PROCESS: a picker broker parents its dialog
     *  onto the requesting app's window, which is the whole point of a broker (MILESTONES, the
     *  ordering correction in the window half). The authority that comes with it is stated at
     *  `WinMgr.destroyTree`. */
    this.owner = spec.owner | 0;
    /** Child winids, in creation order. The destroy cascade walks this. */
    this.children = [];
    /** Where the page put it, as the page reports it — never as this side computed it. */
    this.box = {
      x: spec.x | 0, y: spec.y | 0,
      w: spec.w > 0 ? spec.w | 0 : DEFAULT_W,
      h: spec.h > 0 ? spec.h | 0 : DEFAULT_H,
    };
    /** Character cells, as the host measures them. 0 until the page reports a geometry. */
    this.cols = 0;
    this.rows = 0;
    this.events = new ByteRing(WIN_EVENT_BYTES);
    /** Whether the DOM frame behind this window still exists. `false` answers -EHOSTGONE and NEVER
     *  0: 0 on a read is end of input, which a relay treats as a clean logout, so the two confused
     *  would report a destroyed window as a user who typed Ctrl-D. */
    this.attached = true;
    this.destroyed = false;
    /** Descriptions referencing this window. There is no path that opens a window, so the only
     *  producer is `win_create` — but `dup`, `dup2` and spawn inheritance all share ONE
     *  description, which is why this counts descriptions and not fds (constraint 103). */
    this.opens = 1;
    /** Parked readers: {slot, seq, into, off, want}. The record shape the pipe and the pty park. */
    this.waitingReaders = [];
    /** When the oldest uncollected event was queued, or 0 for "nothing is waiting". An event handed
     *  straight to a parked reader never sets it: that one was collected. */
    this.unreadSince = 0;
    /** 0 responding, 1 greyed, 2 End Process. Edge-triggered: the kernel posts on a CHANGE. */
    this.level = 0;
    this.stats = {
      queued: 0, delivered: 0, dropped: 0, cellBytes: 0, reads: 0, writes: 0,
      readerParks: 0, stale: 0, goneReads: 0, goneWrites: 0, shortReads: 0,
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
   * Queue one event. THE ONE READINESS IN THE SYSTEM WITH NO SYSCALL REPLY BEHIND IT, so it wakes
   * parked polls itself: `calls.mjs` hooks `pollWake` on `reply`, and without the explicit wake a
   * process parked in `poll` sleeps to its timeout — the lost wake of constraint 109.
   *
   * THE QUEUE IS BOUNDED AND THE OVERFLOW IS DEFINED, which is M1's item (e) charged per fd: a
   * window whose process stopped reading drops its newest events and counts them, and the process's
   * OTHER fds keep being serviced. Dropping the newest rather than the oldest is deliberate — the
   * oldest event is the one whose age the not-responding detector is measuring.
   */
  push(ev) {
    if (this.destroyed) return false;
    this.#prune();
    const record = new Uint8Array(WEV_BYTES);
    encodeWinEvent(new DataView(record.buffer), 0, ev);
    this.stats.queued += 1;
    // Straight to a parked reader, for the pipe's reason: a reader parked on a one-record read must
    // be woken by one event whatever the queue holds.
    while (this.waitingReaders.length) {
      const r = this.waitingReaders[0];
      if (!this.#live(r)) { this.waitingReaders.shift(); continue; }
      this.waitingReaders.shift();
      r.into.set(record, r.off);
      this.stats.delivered += 1;
      this.stats.reads += 1;
      K.reply(r.slot, WEV_BYTES, 0, ST_RETURN, WEV_BYTES);
      if (K.pollWake) K.pollWake();
      return true;
    }
    /* A record is pushed WHOLE or not at all. THIS IS THE INVARIANT STATED, NOT A GUARD THAT FIRES:
     * the ring's capacity is a whole number of records and every push and shift moves whole
     * records, so `free` is always a multiple of WEV_BYTES and this test is `free === 0` by
     * arithmetic. `bench/m7-win/controls.py` measured exactly that — the mutation to `free <= 0`
     * moved no check — and the test is kept because it is what stays correct if the capacity ever
     * stops being a multiple, which the probe asserts it is. */
    if (this.events.free < WEV_BYTES) {
      this.stats.dropped += 1;
      return false;
    }
    this.events.push(record);
    // The FIRST uncollected event starts the clock; later ones must not restart it.
    if (this.unreadSince === 0) this.unreadSince = K.now();
    if (K.pollWake) K.pollWake();
    return true;
  }

  /**
   * Read whole event records. A byte count, -EHOSTGONE, -EINVAL, or null meaning parked.
   *
   * THE COUNT IS FLOORED TO A WHOLE NUMBER OF RECORDS and a buffer smaller than one record is
   * -EINVAL rather than a short read: a reader that got half a record would have to re-assemble it
   * across two readiness edges, and the fixed width exists so that nobody has to.
   */
  readEvents(slot, seq, into, off, want) {
    this.#prune();
    if (want < WEV_BYTES) {
      // Counted, because a program looping on a too-small buffer would otherwise spin in silence.
      this.stats.shortReads += 1;
      return -EINVAL;
    }
    const whole = want - (want % WEV_BYTES);
    if (this.events.length > 0) {
      const n = this.events.shift(into, off, Math.min(whole, this.events.length));
      this.stats.reads += 1;
      this.stats.delivered += n / WEV_BYTES;
      // HYSTERESIS: cleared by an EMPTY queue, never by a partial read. See NOT_RESPONDING_MS.
      if (this.events.length === 0) this.unreadSince = 0;
      return n;
    }
    // AFTER the drain, never before: a destroyed window queues ONE last WEV_DESTROYED record (see
    // `destroy`), and answering -EHOSTGONE first would discard the one event that says why.
    if (this.destroyed || !this.attached) {
      this.stats.goneReads += 1;
      return -EHOSTGONE;
    }
    // Parking, not 0: 0 is end of input and would log a session out every time the user paused.
    this.waitingReaders.push({ slot, seq, into, off, want });
    this.stats.readerParks += 1;
    return null;
  }

  /**
   * Cells to the screen. A count or -EHOSTGONE; never parks. A DISPLAY DOES NOT BLOCK ITS WRITER,
   * so there is no output ring here and no POLLOUT to compute. The copy is NOT optional — the
   * source is the caller's SAB, which the caller may overwrite the instant its call is answered.
   */
  writeCells(bytes) {
    if (this.destroyed || !this.attached) {
      this.stats.goneWrites += 1;
      return -EHOSTGONE;
    }
    if (bytes.length === 0) return 0;
    const copy = bytes.slice();
    this.stats.cellBytes += copy.length;
    this.stats.writes += 1;
    K.post({ t: "win-out", win: this.id, bytes: copy });
    return copy.length;
  }

  /** What the page reports after it has clamped. The kernel RECORDS geometry; it never decides it.
   *  A changed cell count raises WEV_RESIZE, which is what a terminal needs for TIOCSWINSZ — the
   *  pixel box is published in `/proc/<pid>/win/<winid>` for a reader that wants it. */
  setBox(box) {
    this.box = { x: box.x | 0, y: box.y | 0, w: box.w | 0, h: box.h | 0 };
    const cols = box.cols | 0;
    const rows = box.rows | 0;
    const moved = cols !== this.cols || rows !== this.rows;
    this.cols = cols;
    this.rows = rows;
    // No event for a move, and none for a resize that did not change the cell grid: an event per
    // pointermove would exhaust the queue this window is budgeted.
    if (moved && (cols > 0 || rows > 0)) this.push({ type: WEV_RESIZE, a: cols, b: rows });
    return 0;
  }

  /** Destroy. The LAST record queued is WEV_DESTROYED, delivered to a parked reader if there is
   *  one, so a process whose window was destroyed under it learns that rather than reading a bare
   *  errno. Every read after the ring empties is -EHOSTGONE. */
  destroy() {
    if (this.destroyed) return 0;
    const notice = { type: WEV_DESTROYED, a: this.id };
    // Order matters: `destroyed` goes up AFTER the notice, or `push` refuses its own last record.
    this.events.clear();
    this.unreadSince = 0;
    this.push(notice);
    this.destroyed = true;
    this.attached = false;
    const answered = this.waitingReaders.length;
    for (const r of this.waitingReaders) K.reply(r.slot, -EHOSTGONE, -1, ST_RETURN, 0);
    this.waitingReaders = [];
    if (K.pollWake) K.pollWake();
    return answered;
  }

  /** Readable: an event is queued, or the window is gone and the read would answer at once. */
  readable() {
    return this.events.length > 0 || this.destroyed || !this.attached;
  }

  /** Destroyed is NOT writable: a poller told it could write would write and get -EHOSTGONE. */
  writable() {
    return !this.destroyed && this.attached;
  }

  hungUp() {
    return this.destroyed || !this.attached;
  }

  staleMs() {
    return this.unreadSince === 0 ? 0 : Math.max(0, K.now() - this.unreadSince);
  }

  /** The level if it CHANGED, else -1. Driven by the kernel's existing heartbeat: a message per
   *  heartbeat per window is the O(N) fan-out constraint 18 forbids. */
  sample() {
    if (this.destroyed) return -1;
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

  /** A stopped window raises no error — a parked reader is a legitimate state — so this is the only
   *  way to tell a working relay from a wedged one. */
  report() {
    return {
      id: this.id,
      pid: this.pid,
      title: this.title,
      owner: this.owner,
      children: [...this.children],
      ...this.box,
      cols: this.cols,
      rows: this.rows,
      attached: this.attached,
      destroyed: this.destroyed,
      opens: this.opens,
      pending: this.events.length / WEV_BYTES,
      parked: this.waitingReaders.length,
      level: this.level,
      staleMs: Math.round(this.staleMs()),
      ...this.stats,
    };
  }
}

/**
 * The window table. One per kernel, held by `kernel.mjs`.
 *
 * Winids are MONOTONIC AND NEVER REUSED, for the reason pids are (constraint 13): an owner winid
 * held by another process must not come to name a different window.
 */
export class WinMgr {
  constructor() {
    this.byId = new Map();
    this.nextId = 1;
    this.stats = { created: 0, destroyed: 0, cascaded: 0, refusedCap: 0, refusedOwner: 0 };
  }

  get(id) {
    return this.byId.get(id | 0) || null;
  }

  /** Live windows, in creation order, which is winid order. */
  live() {
    return [...this.byId.values()].filter((w) => !w.destroyed);
  }

  /** A process's live windows. O(windows), not O(processes): `/proc` asks this per read. */
  ofPid(pid) {
    return this.live().filter((w) => w.pid === pid);
  }

  /**
   * Create a window for `pid`. Returns the Window, or a negative errno.
   *
   * The owner check is the whole of M9's groundwork that M7 owes: an owner winid MAY name another
   * process's window, and it must name a LIVE one — a destroyed owner would give the new window a
   * parent nothing can cascade from, so the child would outlive the chain it was created inside.
   */
  create(pid, spec) {
    if (this.ofPid(pid).length >= WIN_CAP) {
      this.stats.refusedCap += 1;
      return -EMFILE;
    }
    const ownerId = spec.owner | 0;
    if (ownerId !== 0) {
      const owner = this.get(ownerId);
      if (!owner || owner.destroyed) {
        this.stats.refusedOwner += 1;
        return -ENOENT;
      }
    }
    const id = this.nextId;
    this.nextId += 1;
    const win = new Window(id, pid, spec);
    this.byId.set(id, win);
    if (ownerId !== 0) this.get(ownerId).children.push(id);
    this.stats.created += 1;
    K.post({
      t: "win-create",
      win: id,
      pid,
      title: win.title,
      owner: win.owner,
      x: win.box.x, y: win.box.y, w: win.box.w, h: win.box.h,
    });
    return win;
  }

  /**
   * Destroy a window AND ITS CHILDREN, returning every id destroyed, oldest ancestor first.
   *
   * ONE `win_destroy` CLOSES SEVERAL WINDOWS, and the list is the return value rather than a thing
   * the caller is expected to derive: without it a process's fd table silently disagrees with the
   * kernel's about which of its windows still exist (SerenityOS's `destroy_window` returns the same
   * list, for the same reason).
   *
   * THE AUTHORITY THIS GRANTS IS DELIBERATE AND NARROW. A window may be parented onto another
   * process's window, so destroying yours may destroy theirs. That is the contract a child accepts
   * by naming a parent — a dialog outliving the window it belongs to is the defect M9 exists to
   * prevent — and it travels in one direction only: a child's destruction never reaches its parent.
   */
  destroyTree(id) {
    const root = this.get(id);
    if (!root || root.destroyed) return [];
    const ids = [];
    const walk = (w) => {
      ids.push(w.id);
      if (!cascade) return;
      // A copy, because `destroy` does not touch `children` and a future one must not iterate a
      // list it is editing.
      for (const childId of [...w.children]) {
        const child = this.get(childId);
        if (child && !child.destroyed) walk(child);
      }
    };
    walk(root);
    for (const each of ids) {
      const w = this.get(each);
      w.destroy();
      this.stats.destroyed += 1;
    }
    if (ids.length > 1) this.stats.cascaded += ids.length - 1;
    K.post({ t: "win-destroy", ids });
    return ids;
  }

  /** The page's half: a frame the user closed, or a page that went away. Same cascade. */
  detach(id) {
    return this.destroyTree(id);
  }

  /** Feed one event to one window. Returns true if it was queued or delivered. */
  feed(id, ev) {
    const w = this.get(id);
    if (!w || w.destroyed) return false;
    if (!(ev.type >= 1 && ev.type <= WEV_MAX)) return false;
    return w.push(ev);
  }

  /** Per-heartbeat health sweep. Returns ONLY the windows whose level changed, which is what makes
   *  the page's caption edge-triggered rather than one message per window per tick
   *  (constraint 18). */
  sample() {
    const out = [];
    for (const w of this.byId.values()) {
      const level = w.sample();
      if (level >= 0) out.push({ win: w.id, level, staleMs: Math.round(w.staleMs()) });
    }
    return out;
  }

  /** Drop the rows for windows nobody can reach any more, so a long session's map does not grow
   *  without bound. A DESTROYED window is kept while any description still holds it: its fd must
   *  keep answering -EHOSTGONE rather than -EBADF. */
  sweep() {
    let gone = 0;
    for (const [id, w] of [...this.byId]) {
      // NOT "and the ring is empty": a window nothing holds a description on cannot be read by
      // anybody, so an unread WEV_DESTROYED record in it would keep the row for ever.
      if (w.destroyed && w.opens <= 0) {
        this.byId.delete(id);
        gone += 1;
      }
    }
    return gone;
  }

  report() {
    return {
      ...this.stats,
      live: this.live().length,
      rows: this.byId.size,
      nextId: this.nextId,
    };
  }
}

/** The errnos this module answers, named so a reader of `calls.mjs` does not have to re-derive
 *  which refusal means what. Exported for the host probe, which asserts on the names. */
export const WIN_ERRNOS = Object.freeze({
  EHOSTGONE, EINVAL, EBADF, ENOENT, EMFILE, EPERM,
});

/** The event types this module produces, for the same reason. */
export const WIN_EVENTS = Object.freeze({
  WEV_KEY, WEV_RESIZE, WEV_CLOSE, WEV_FOCUS, WEV_DESTROYED,
});
