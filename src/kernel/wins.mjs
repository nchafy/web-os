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
  EHOSTGONE, EINVAL, EBADF, ENOENT, EMFILE, EPERM, ENOMEM, ST_RETURN,
  WEV_BYTES, WEV_KEY, WEV_RESIZE, WEV_CLOSE, WEV_FOCUS, WEV_DESTROYED, WEV_POINTER, WEV_MAX,
  WIN_EVENT_CAP, WIN_CAP, SURFACE_BUDGET_PX, SURFACE_MAX_PX, DLOP_BYTES,
  WMODAL_NONE, WMODAL_WINDOW, WMODAL_APP, WMODAL_SYSTEM, WMODAL_MAX,
  WMODE_MODELESS, WMODE_PASSIVE, WMODE_RENDER_ABOVE, WMODE_BLOCKING, WMODE_MAX,
  encodeWinEvent,
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

/** M8's NEGATIVE CONTROL, boot-gated on bench=1: `win_draw` accepts its batch, counts it, and
 *  DISCARDS it. `PLAN.md` §5's control for M8 in its own words — "draw nothing; the pattern
 *  assertion must fail". Everything that CARRIES the ops keeps working, so what disappears is the
 *  pixels and nothing else: it is the only cut that tells a working surface from a page that drew
 *  something of its own. */
let drawReaches = true;

export function setDrawReaches(on) {
  drawReaches = !!on;
}

/** M9's FIRST NEGATIVE CONTROL, in `PLAN.md` §5's words: "remove the owner chain; the dialog must
 *  fall behind and the check must fail". A raise moves the window ALONE and leaves the windows
 *  that ride with it where they were — which is constraint 44's defect exactly: "without an owner
 *  chain a dialog sits behind the window that owns it". */
let ownerChain = true;

export function setOwnerChain(on) {
  ownerChain = !!on;
}

/** M9's SECOND: nothing is ever blocking, so a raise is always granted and no input is suppressed.
 *  It cuts the ENFORCEMENT and leaves the close contract alone, which is how the two halves of M9
 *  are told apart. */
let modalBlocks = true;

export function setModalBlocks(on) {
  modalBlocks = !!on;
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
    /**
     * M9's TWO AXES, and they are two because `MILESTONES.md`'s ordering note says an owned window
     * needs both: `scope` is WHICH windows this one affects — none, its owner, its owner's whole
     * app, or everything — and `mode` is WHAT happens to them. A tooltip and a save dialog are
     * both "owned by that window" and nothing else about them is the same.
     *
     * Both default to the quiet value, so a window nobody set up is ordinary.
     */
    this.scope = WMODAL_NONE;
    this.mode = WMODE_MODELESS;
    /** Where the page put it, as the page reports it — never as this side computed it. */
    this.box = {
      x: spec.x | 0, y: spec.y | 0,
      w: spec.w > 0 ? spec.w | 0 : DEFAULT_W,
      h: spec.h > 0 ? spec.h | 0 : DEFAULT_H,
    };
    /** Character cells, as the host measures them. 0 until the page reports a geometry. */
    this.cols = 0;
    this.rows = 0;
    /**
     * M8's SURFACE, which the KERNEL owns: `{w, h}` in device pixels, or null for a window that
     * has not asked for one. The pixels live in the page, the accounting lives here, and the
     * process holds neither — it sends a display list through the channel it already has
     * (`docs/DECISIONS.md` D31, constraint 219).
     *
     * A window without a surface is not broken: it shows what a process `write`s to it as text,
     * which is what every terminal does.
     */
    this.surface = null;
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
      // M8: batches accepted, ops in them, and batches refused. A program that drew nothing and
      // one whose every batch was refused look identical without the third number.
      batches: 0, ops: 0, refusedDraws: 0, refusedCells: 0,
      // M9: input events a modal blocked. See `WinMgr.feed`.
      suppressed: 0,
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
    /* A SURFACED WINDOW HAS NO TEXT WIDGET, so cells have nowhere to go and are REFUSED rather
     * than accepted and dropped — accepting bytes nobody renders is the silent loss a user cannot
     * diagnose. One content mode per window (M8): text until `win_surface` succeeds, pixels
     * after. A program that printed a banner and then asked for a surface is the normal case and
     * is fine; one that goes back is told -EINVAL. */
    if (this.surface) {
      /* ITS OWN COUNTER, because it is a different failure from a write to a window whose frame is
       * gone — and this diff makes that argument itself for `refusedDraws`. A reader of
       * `/proc/<pid>/win/<winid>` must be able to tell "the frame died" from "you are in pixel
       * mode". */
      this.stats.refusedCells += 1;
      return -EINVAL;
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

  /**
   * Destroy. The LAST record queued is WEV_DESTROYED, delivered to a parked reader if there is
   * one, so a process whose window was destroyed under it learns that rather than reading a bare
   * errno. Every read after the ring empties is -EHOSTGONE.
   *
   * THE QUEUE IS KEPT, AND THE FIRST VERSION OF THIS CLEARED IT — which made `WEV_CLOSE`
   * unreachable. The page's X button posts `win-in [WEV_CLOSE]` and then `win-gone`, and the
   * kernel serves them in that order, so a close record was queued and wiped two messages later;
   * a relay parked in `poll` rather than in `read` never saw it, and `src/bin/term.mjs`'s arm for
   * it was dead code. Events already queued were real events, including the keystrokes typed just
   * before the window closed, and a reader drains them before the -EHOSTGONE.
   *
   * ROOM FOR THE NOTICE IS MADE BY DROPPING THE OLDEST, and this is the one place that rule is
   * inverted (`push` drops the newest — see constraint 213). The notice is the record a reader
   * cannot do without: it names the window and it is the difference between "destroyed under me"
   * and "there was never such a window".
   */
  destroy() {
    if (this.destroyed) return 0;
    const notice = { type: WEV_DESTROYED, a: this.id };
    if (this.events.free < WEV_BYTES) {
      this.events.shift(new Uint8Array(WEV_BYTES), 0, WEV_BYTES);
      this.stats.dropped += 1;
    }
    this.push(notice);
    /* THE STALE CLOCK STOPS, EVEN THOUGH THE QUEUE DOES NOT. They answer different questions: the
     * queue holds events a reader is still owed, and the clock asks whether somebody who was
     * supposed to be collecting them has stopped. A destroyed window is not a slow one — M4a's
     * console grew `staleMs` against a window that no longer existed and captioned a frame that
     * was gone, which is the regression `bench/m7-win/probe.mjs` keeps a section for. */
    this.unreadSince = 0;
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

  /** Whether this window is above its owner and stays there: a palette, a tooltip or a modal.
   *  A MODELESS child is an ordinary window that happens to have an owner. */
  ridesWithOwner() {
    return this.mode === WMODE_PASSIVE || this.mode === WMODE_RENDER_ABOVE
      || this.mode === WMODE_BLOCKING;
  }

  /** A stopped window raises no error — a parked reader is a legitimate state — so this is the only
   *  way to tell a working relay from a wedged one. */
  report() {
    return {
      id: this.id,
      surface: this.surface ? { ...this.surface } : null,
      pid: this.pid,
      title: this.title,
      owner: this.owner,
      children: [...this.children],
      ...this.box,
      cols: this.cols,
      rows: this.rows,
      scope: this.scope,
      mode: this.mode,
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
    /**
     * M9's STACK: winids, BOTTOM FIRST, and the kernel's because modality has to be ENFORCED and
     * not drawn. A page that owned the order could be asked to put a window above the modal that
     * blocks it, and would — it has no way to know better. SerenityOS's server owns the same list
     * for the same reason (constraint 226).
     *
     * The page renders it and nothing else: `win-stack` carries the whole order rather than a
     * "raise this one" instruction, so the two sides cannot disagree about what is on top.
     */
    this.stack = [];
    this.nextId = 1;
    this.stats = {
      created: 0, destroyed: 0, cascaded: 0, refusedCap: 0, refusedOwner: 0,
      // M9: raises granted, raises refused by a modal, and how many times the stack was posted.
      raises: 0, blocked: 0, stacks: 0, suppressed: 0,
      // M8's surface accounting. `surfacePx` is what is OUTSTANDING; the refusals are counted
      // apart because a budget nobody can see refuse anything is a budget nobody believes.
      surfaces: 0, surfacePx: 0, refusedSurface: 0, batches: 0, ops: 0,
    };
  }


  /* ---- M9: the stack, the owner chain, and the blocker --------------------------------------
   *
   * EVERY ONE OF THESE IS A PURE FUNCTION OVER THE TABLE except `raise`, which posts. That is
   * deliberate: the modality rules are the part most likely to be got wrong, so they are
   * host-testable without a browser (`bench/m9-modal/probe.mjs`).
   */

  /** This window's ancestors, nearest first. An owner may live in ANOTHER PROCESS (M7), so this
   *  walk crosses processes and the cycle guard is not optional — a chain is built by two
   *  independent processes and neither can see the whole of it. */
  ancestors(win) {
    const out = [];
    const seen = new Set([win.id]);
    let at = win.owner ? this.get(win.owner) : null;
    while (at && !seen.has(at.id)) {
      out.push(at);
      seen.add(at.id);
      at = at.owner ? this.get(at.owner) : null;
    }
    return out;
  }

  /** This window and everything it owns, transitively. The destroy cascade's set, reused here
   *  because "blocked by my own dialog" must not include the dialog itself. */
  subtree(win) {
    const out = [];
    const walk = (w) => {
      out.push(w);
      for (const id of w.children) {
        const child = this.get(id);
        if (child && !child.destroyed && !out.includes(child)) walk(child);
      }
    };
    walk(win);
    return out;
  }

  /** The pid a window's modality is ABOUT: its owner's, or its own if it has no owner.
   *
   *  THE OWNER'S AND NOT ITS OWN, and that is the whole point of a broker: a picker's dialog is
   *  owned by the REQUESTING app's window and runs in the picker's process, and it is the app that
   *  must be blocked. Measured against the plan in `docs/research/08-hobbyist-os-survey.md`.
   *
   *  `ancestors()` IS NEAREST-FIRST, so the owner is `[0]` and the ROOT is the last element. This
   *  read the last one for a while, which is the same mistake as reading the chain backwards: a
   *  dialog three deep blocked the process at the top of the chain and left its own owner typable
   *  and raisable over itself (constraint 229). Depth-1 chains cannot tell the two apart, and every
   *  fixture was depth 1. */
  appOf(win) {
    const chain = this.ancestors(win);
    return chain.length ? chain[0].pid : win.pid;
  }

  /**
   * IS ANYTHING BLOCKING AT ALL? Read from the table on every call.
   *
   * WHY IT EXISTS: `feed` asks `blockingFor` on EVERY key and pointer event, and a pointer drag
   * streams moves while the button is down — so a `paint` stroke on a desktop with no modal in it
   * ran the whole table walk, including `subtree`'s quadratic membership test and two array
   * allocations per candidate, on every motion sample. Constraint 18 requires a sweep to be
   * O(interested), and with nothing blocking the interested set is empty (constraint 231).
   *
   * NO CACHE, AND THE FIRST VERSION HAD ONE. An epoch counter bumped by `create`, `destroyTree`
   * and `setModal` answered stale for every caller that writes `mode` directly — which the host
   * probe does, so twelve assertions about suppression went green against a kernel that was
   * suppressing nothing. A `for` over `byId` with an early return allocates nothing and cannot be
   * stale; the cost this is about was the subtree walk, not the mode test.
   */
  anyBlocking() {
    for (const w of this.byId.values()) {
      if (!w.destroyed && w.mode === WMODE_BLOCKING) return true;
    }
    return false;
  }

  /**
   * The window that BLOCKS `win`, or null. SerenityOS's `blocking_modal_window`, with this
   * project's two axes rather than its one.
   *
   * A window is never blocked by itself or by anything it owns — a dialog does not block its own
   * tooltip — which is what `subtree` is for. Returns the TOPMOST blocker, because that is the one
   * a user should be sent to.
   */
  blockingFor(win) {
    if (!modalBlocks) return null;
    if (!this.anyBlocking()) return null;
    let found = null;
    let foundAt = -1;
    for (const b of this.live()) {
      if (b.mode !== WMODE_BLOCKING) continue;
      /* WHO IS NOT BLOCKED BY `b`: `b` ITSELF AND `b`'s OWN DESCENDANTS. A dialog must keep
       * working, and so must a tooltip it owns.
       *
       * THE FIRST VERSION EXCLUDED `win`'s SUBTREE INSTEAD, which is the same sentence read
       * backwards and it broke the headline case: a save dialog IS its editor's child, so the
       * editor was excluded from being blocked by its own dialog. Measured — the editor's keys
       * arrived, `suppressed` stayed at 0 and the raise was granted — which is why M9's own page
       * types into the blocked window rather than trusting the stack order. */
      if (this.subtree(b).some((w) => w.id === win.id)) continue;
      let blocks = false;
      if (b.scope === WMODAL_SYSTEM) blocks = true;
      else if (b.scope === WMODAL_APP) blocks = this.appOf(b) === win.pid;
      else if (b.scope === WMODAL_WINDOW) {
        // Its OWNER, and the owner's ancestors with it: a dialog over a document blocks the
        // document, and raising the document's own parent above the dialog would bury it just
        // the same.
        blocks = this.ancestors(b).some((a) => a.id === win.id);
      }
      if (!blocks) continue;
      const at = this.stack.indexOf(b.id);
      if (at >= foundAt) {
        found = b;
        foundAt = at;
      }
    }
    return found;
  }

  /**
   * Raise a window to the top, with the windows that ride with it. Returns 0, or the BLOCKER.
   *
   * THE DIALOG COMES UP WITH ITS OWNER, which is constraint 44's defect in one line: "without an
   * owner chain a dialog sits behind the window that owns it". A raise moves the window and then
   * puts every PASSIVE, RENDER_ABOVE or BLOCKING descendant above it, in creation order — so
   * clicking the document brings its save dialog along rather than burying it.
   *
   * A PASSIVE WINDOW IS NEVER THE SUBJECT: `src/abi.mjs` defines it as "never takes the stack from
   * its owner … raised WITH its owner and never above a sibling", and only the RIDER half of that
   * was implemented. A click lands on a tooltip's frame like any other, and the page posts
   * `win-raise` for it — so a passive window raised directly went to the top of the GLOBAL stack,
   * above its owner's siblings and above other processes' windows, which is the one thing its own
   * definition forbids. The raise is redirected to the nearest ancestor that is not passive, and
   * the tooltip comes up as the rider it is (constraint 232). With no such ancestor there is
   * nothing to take the stack from, so it raises itself.
   */
  raise(win) {
    if (win.destroyed) return null;
    if (win.mode === WMODE_PASSIVE) {
      const up = this.ancestors(win).find((a) => a.mode !== WMODE_PASSIVE);
      if (up) return this.raise(up);
    }
    const blocker = this.blockingFor(win);
    if (blocker) {
      this.stats.blocked += 1;
      // The page is told WHICH window refused, so it can send the user there rather than
      // swallowing the click.
      K.post({ t: "win-blocked", win: win.id, by: blocker.id });
      return blocker;
    }
    const riders = ownerChain
      ? this.subtree(win).filter((w) => w !== win && w.ridesWithOwner())
      : [];
    const moving = new Set([win.id, ...riders.map((w) => w.id)]);
    this.stack = this.stack.filter((id) => !moving.has(id));
    this.stack.push(win.id, ...riders.map((w) => w.id));
    this.stats.raises += 1;
    this.postStack();
    return 0;
  }

  /**
   * Set a window's TWO AXES, or a negative errno.
   *
   * THE GUARD LIVES HERE, in the file that names the scopes. `calls.mjs` tested `scope === 1 ||
   * scope === 2` against the two that need an owner, which is the enum's ORDER copied into a second
   * place — and `selfTest` only asserts the scope set is dense from 0, so reordering it would leave
   * that line silently guarding the wrong two: an ownerless window would become APP-modal, blocking
   * by a chain that is not there, and a legitimate SYSTEM-modal would be refused (constraint 234).
   *
   * THE STACK IS RE-EVALUATED, not merely recorded: a window that has just become RENDER_ABOVE or
   * BLOCKING must get above its owner now rather than at the next click.
   */
  setModal(win, scope, mode) {
    if (scope < 0 || scope > WMODAL_MAX || mode < 0 || mode > WMODE_MAX) return -EINVAL;
    /* A WINDOW WITH NO OWNER MAY NOT BE WINDOW- OR APP-MODAL. Both scopes are defined by walking
     * the owner chain, so without an owner there is nothing to block — and a window that claimed to
     * be modal and blocked nothing is worse than a refusal, because the program believes it. */
    if ((scope === WMODAL_WINDOW || scope === WMODAL_APP) && win.owner === 0) return -EINVAL;
    win.scope = scope;
    win.mode = mode;
    this.raise(win);
    return 0;
  }

  /**
   * The order, bottom first, as the page must render it — AND WHICH WINDOWS ARE BLOCKED.
   *
   * THE BLOCKED SET TRAVELS WITH THE ORDER because suppression has to cover the FRAME and not only
   * the client area. A drag and an arrow-key move are handled entirely page-side (`src/wm/window.
   * mjs`), so "input to a blocked window is suppressed" was false for exactly the gesture a user
   * tries first: with a save dialog up, the editor could still be dragged around under it, and its
   * `pointerup` posted a geometry the kernel accepted (constraint 233).
   *
   * It is computed HERE and not asked for per event, so the page never decides it and the two sides
   * cannot disagree — the same reason the whole order is posted rather than a "raise this one".
   * `anyBlocking()` makes it free when nothing is modal, which is the ordinary case.
   */
  postStack() {
    this.stats.stacks += 1;
    const blocked = this.anyBlocking()
      ? this.live().filter((w) => this.blockingFor(w)).map((w) => w.id)
      : [];
    K.post({ t: "win-stack", ids: [...this.stack], blocked });
  }

  /** Where a window sits, from the bottom. -1 for one that is not stacked. */
  depthOf(id) {
    return this.stack.indexOf(id | 0);
  }

  /**
   * Give a window a surface, or refuse. THE KERNEL ALLOCATES AND THEREFORE CAN ACCOUNT AND
   * REVOKE, which is the whole of `docs/DECISIONS.md` D31: M12's blur governor is an admission
   * controller over AREA (constraint 49) and it cannot admit what it did not allocate.
   *
   * A second call RESIZES, which is what a window being dragged bigger needs, and the old area is
   * released before the new one is charged — otherwise a program that resized its surface fifty
   * times would exhaust a budget it never exceeded.
   */
  surface(win, w, h) {
    // COUNTED LIKE EVERY OTHER REFUSAL. It was not, and `bench/m8-surface/probe.mjs` found it:
    // a counter that excludes the most common refusal — a bad argument — reports a program that
    // asked wrongly fifty times as one that never asked.
    if (!(w > 0) || !(h > 0)) {
      this.stats.refusedSurface += 1;
      return -EINVAL;
    }
    const want = w * h;
    if (want > SURFACE_MAX_PX) {
      this.stats.refusedSurface += 1;
      return -EINVAL;
    }
    const held = win.surface ? win.surface.w * win.surface.h : 0;
    if (this.stats.surfacePx - held + want > SURFACE_BUDGET_PX) {
      // -ENOMEM and not -EAGAIN: the budget is a ceiling, not a transient. A caller that retried
      // would retry for ever.
      this.stats.refusedSurface += 1;
      return -ENOMEM;
    }
    this.stats.surfacePx += want - held;
    if (!win.surface) this.stats.surfaces += 1;
    win.surface = { w: w | 0, h: h | 0 };
    K.post({ t: "win-surface", win: win.id, w: w | 0, h: h | 0 });
    return 0;
  }

  /** Release a window's surface area back to the budget. Called from `destroy`, which is where
   *  revocation lives: a window that is gone is area the next one may have. */
  releaseSurface(win) {
    if (!win.surface) return 0;
    this.stats.surfacePx -= win.surface.w * win.surface.h;
    this.stats.surfaces -= 1;
    win.surface = null;
    return 0;
  }

  /** One batch of display-list ops, forwarded to the page that owns the canvas. The ops are NOT
   *  interpreted here: the kernel counts and accounts, and `src/wm/surface.mjs` is the one
   *  renderer. A window with no surface refuses, because there is nothing to draw on. */
  draw(win, ops) {
    if (win.destroyed || !win.attached) {
      win.stats.refusedDraws += 1;
      return -EHOSTGONE;
    }
    if (!win.surface) {
      win.stats.refusedDraws += 1;
      return -EINVAL;
    }
    // `DLOP_BYTES` AND NOT 32, TWICE OVER: the record's size is `src/abi.mjs`'s to declare, and a
    // literal here admitted a fractional op count — a 40-byte batch charged 1.25 ops.
    const count = ops.length / DLOP_BYTES;
    win.stats.batches += 1;
    win.stats.ops += count;
    this.stats.batches += 1;
    this.stats.ops += count;
    // A COPY, for the reason `writeCells` makes one: the source is the caller's SAB and the caller
    // may overwrite it the instant its call is answered.
    if (drawReaches) K.post({ t: "win-draw", win: win.id, ops: ops.slice() });
    return 0;
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
    // A NEW WINDOW IS ON TOP, which is what a dialog appearing means — and the ORDER must go out
    // with it. It did not for a while: the stack grew kernel-side and the page was never told, so
    // the new frame got no `z-index` while an earlier, clicked window had one, and the new window
    // painted BEHIND it (constraint 230). The `win-create` post goes first, because the page
    // resolves an order into frames it already knows about.
    this.stats.created += 1;
    this.stack.push(id);
    K.post({
      t: "win-create",
      win: id,
      pid,
      title: win.title,
      owner: win.owner,
      x: win.box.x, y: win.box.y, w: win.box.w, h: win.box.h,
    });
    this.postStack();
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
      // THE AREA GOES BACK BEFORE THE WINDOW DOES. A surface the budget still counts after its
      // window is gone is a leak the governor would inherit.
      this.releaseSurface(w);
      w.destroy();
      // OUT OF THE STACK, or a destroyed window would hold a place in the order for ever and
      // `blockingFor` would keep finding it.
      this.stack = this.stack.filter((id) => id !== w.id);
      this.stats.destroyed += 1;
    }
    if (ids.length > 1) this.stats.cascaded += ids.length - 1;
    K.post({ t: "win-destroy", ids });
    this.postStack();
    // AND DROP WHAT NOBODY CAN REACH, here rather than on a timer: a destroyed window whose last
    // description has already gone is a row with no reader, and `sample()` walks every row on
    // every heartbeat (constraint 18). `src/kernel/files.mjs`'s `F_WIN.close` sweeps too, which
    // covers the other order — the fd closing after the window was destroyed.
    this.sweep();
    return ids;
  }

  /** The page's half: a frame the user closed, or a page that went away. Same cascade. */
  detach(id) {
    return this.destroyTree(id);
  }

  /**
   * Feed one event to one window. Returns true if it was queued or delivered.
   *
   * INPUT TO A BLOCKED WINDOW IS SUPPRESSED, which is what makes a modal a modal rather than a
   * stacking rule: SerenityOS's server does the same, and without it "modal" would mean only
   * "stays on top" and a user could type into the document behind the save dialog. Suppression is
   * the KERNEL's because the blocker is (constraint 226).
   *
   * ONLY KEYS AND POINTERS. A blocked window must still learn that it was resized, that it lost
   * focus, that it was asked to close and that it was destroyed — those are not input, and a
   * window that missed them would be wrong about the world once the modal went away.
   */
  feed(id, ev) {
    const w = this.get(id);
    if (!w || w.destroyed) return false;
    if (!(ev.type >= 1 && ev.type <= WEV_MAX)) return false;
    if (ev.type === WEV_KEY || ev.type === WEV_POINTER) {
      const blocker = this.blockingFor(w);
      if (blocker) {
        // COUNTED, on the window that did not get it: a program whose keys silently stopped
        // arriving would have no way to tell that from a keyboard that stopped working.
        w.stats.suppressed += 1;
        this.stats.suppressed += 1;
        return false;
      }
    }
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
      stack: [...this.stack],
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
