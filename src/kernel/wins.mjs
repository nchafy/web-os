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
  EHOSTGONE, EINVAL, EBADF, ENOENT, EMFILE, EPERM, ENOMEM, EBUSY, ST_RETURN,
  WEV_BYTES, WEV_KEY, WEV_RESIZE, WEV_CLOSE, WEV_FOCUS, WEV_DESTROYED, WEV_POINTER, WEV_MAX,
  WIN_EVENT_CAP, WIN_CAP, SURFACE_BUDGET_PX, SURFACE_MAX_PX, DLOP_BYTES,
  BLUR_OFF_AT, BLUR_ON_AT, blurRingArea,
  WMODAL_NONE, WMODAL_WINDOW, WMODAL_APP, WMODAL_SYSTEM, WMODAL_MAX,
  WMODE_MODELESS, WMODE_PASSIVE, WMODE_RENDER_ABOVE, WMODE_BLOCKING, WMODE_MAX,
  WEV_DRAG_ENTER, WEV_DRAG_LEAVE, WEV_DROP, WEV_DRAG_DONE, WPTR_DOWN, WPTR_UP,
  WEV_STATE, WEV_ITEM, WEV_CLIENT,
  WST_NORMAL, WST_MIN, WST_MAX, WST_SNAP_L, WST_SNAP_R, WST_LIMIT,
  WROLE_NORMAL, WROLE_DESKTOP, WROLE_LIMIT,
  WIN_ITEM_CAP, WITEM_SEPARATOR, WITEM_DISABLED,
  encodeWinEvent, decodeWinEvent, dprFixed,
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

/** How far a new window steps when its top-left corner lands exactly on a live one's. Windows 7
 *  offsets a cascaded window by about a caption's height, which is what makes the one underneath
 *  recognisable as a separate window rather than a shadow. See `WinMgr.#cascade`. */
const CASCADE_STEP = 24;

export function setCascade(on) {
  cascade = !!on;
}

/**
 * M12's three negative controls, boot-gated on bench=1 (`src/kernel/kernel.mjs`). Module-level and
 * not per-manager, which is `cascade`'s shape above and for its reason: the headline path reads a
 * plain boolean either way and carries no control branch of its own.
 *
 *   off          the governor never flattens anything. `PLAN.md` §5's own control for M12 —
 *                "disable the governor at the same geometry".
 *   topFirst     degrade from the TOP of the stack instead of the bottom. The plausible
 *                implementation, and the one that takes the glass from the window being used.
 *   staleCosts   admission reads the CURRENT blurred total rather than the all-glass one, which is
 *                the first version of this governor and restores the feedback loop it was built to
 *                remove: flattening lowers the input, the next run re-admits, the one after
 *                flattens again. It replaced a `noHysteresis` control that broke nothing once the
 *                accounting was corrected — see `governBlur`.
 */
let governor = { off: false, topFirst: false, staleCosts: false };

export function setGovernor(opts) {
  governor = {
    off: opts.off === true,
    topFirst: opts.topFirst === true,
    staleCosts: opts.staleCosts === true,
  };
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

/**
 * M14's FOURTH NEGATIVE CONTROL, boot-gated on bench=1: `win_items` accepts a list, counts it and
 * DISCARDS it. `setDrawReaches`'s shape, and for its reason: everything that CARRIES the rows keeps
 * working — the program encodes them, the call succeeds, the page is told a list arrived — so what
 * disappears is the rows themselves, which is the only cut that tells a shell drawing a process's
 * data from a shell drawing a list of its own.
 */
let itemsReach = true;

export function setItemsReach(on) {
  itemsReach = !!on;
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

/** The largest display ratio the kernel will record. The bound exists to keep a reported ratio
 *  inside the 16.16 field `WEV_CLIENT` carries it in, which is what makes `dprFixed` unable to
 *  throw on the geometry path. 16 is eight times the reference display's 2 and above any
 *  panel-times-zoom product this project has measured; a page reporting more has a defect, and
 *  recording it would hand a program a scale factor nothing on screen uses. See `WinMgr.setDpr`. */
const MAX_DPR = 16;

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
    /** M12. Whether the GOVERNOR has taken this window's glass away. Written only by
     *  `WinMgr.governBlur`, and read by nothing else here: the page is told the whole flat set and
     *  draws a cheap fill for it. Not a property a process can set — a program that could ask for
     *  glass would be asking to be exempt from a budget. */
    this.flat = false;
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
    /**
     * M14's THIRD AND FOURTH AXES, and they are axes rather than more of the same: `scope` and
     * `mode` say what this window does to OTHER windows, and these two say what the SHELL does
     * with this one.
     *
     * `state` is Win32's show state — normal, minimized, maximized, snapped left or right. `role`
     * is what the window IS: an ordinary window, or the desktop.
     *
     * THE KERNEL OWNS BOTH AND COMPUTES NEITHER'S GEOMETRY. A maximized window fills the WORK
     * AREA, which is the desktop minus whatever the shell has taken off it — a fact only the page
     * has. So the page lays the frame out and reports the box through `win-geom` like any other
     * box, and this side records the state, the order and the restore point (constraint 271).
     */
    this.state = WST_NORMAL;
    this.role = WROLE_NORMAL;
    /** Where a maximized or snapped window goes back to, as the page last reported it, or null.
     *  THE KERNEL'S because the state is: a window that lost where it came from is a window a user
     *  cannot put back, and the page is a renderer that may be re-laid-out at any moment. */
    this.restore = null;
    /** The state a MINIMIZED window came from, so restoring a minimized maximized window gives
     *  back a maximized one — Win32's `SW_RESTORE`, and what a taskbar button has to do. */
    this.beforeMin = WST_NORMAL;
    /** The rows this window has published for the shell to draw: `{icon, flags, label}`, capped at
     *  `WIN_ITEM_CAP`. The kernel carries them and bounds them; what a row MEANS is the
     *  publisher's, which is why `WEV_ITEM` reports an INDEX. */
    this.items = [];
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
     * M16. THE CLIENT CONTENT BOX THE PAGE MEASURED, in DEVICE pixels — the unit `win_surface`
     * takes and the unit `SURFACE_MAX_PX` bounds. `-1` until a positive measurement arrives, so
     * the first one raises an event: a program needs its box before its first paint, and A2c's
     * `/proc` line is a pull route and not a substitute.
     *
     * MEASURED, NEVER MODELLED. `WIN_CAP_H` and `WIN_INSET` are the aero skin's, and
     * `.window-body` carries a 1 px border-top outside the content box a canvas fills — and four
     * proof pages load no stylesheet at all. A geometry derived from a measured rect survives a
     * second engine; one derived from a constant does not (constraint 264).
     */
    this.clientW = -1;
    this.clientH = -1;
    /** The table this window is in, set by `WinMgr.create`, or null for one built outside a table —
     *  which only a host probe does. Held for ONE fact, the display's ratio, and that fact is the
     *  table's because it is the display's: a per-window copy is how two windows come to disagree
     *  about one display. */
    this.mgr = null;
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
      // M16: client events REPLACED at the tail rather than appended. `dropped` cannot see one —
      // it moves only on a full ring, and a ring this replacement keeps drained never fills — so
      // without this counter a control that broke the replacement would move no number anywhere.
      coalesced: 0,
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
   * Remove the tail record and return its bytes, or null for a ring holding none.
   *
   * BYTE AT A TIME because `ByteRing` offers `popLast` and no record-wise tail accessor, and
   * `src/fs/ring.mjs` is the ONE ring every kernel queue uses (constraint 112) — a tail-overwrite
   * method there would be reachable by the pipe and the pty for this one caller's benefit, and the
   * file is pure code `scripts/fsfuzz.py` drives without a browser.
   *
   * A WHOLE RECORD COMES OUT because a whole one went in: this queue's capacity is a whole number
   * of records and every push and shift on it moves `WEV_BYTES`, which is the invariant `push`
   * states.
   */
  #popTail() {
    if (this.events.length < WEV_BYTES) return null;
    const rec = new Uint8Array(WEV_BYTES);
    for (let i = WEV_BYTES - 1; i >= 0; i -= 1) rec[i] = this.events.popLast();
    return rec;
  }

  /**
   * Queue a CLIENT event, REPLACING a tail one instead of appending.
   *
   * A STALE SIZE HAS NO HISTORY WORTH KEEPING, and the arithmetic forces the point. The page
   * reports a geometry once per animation frame, so an appending client event is ~240 records in a
   * two-second drag against a `WIN_EVENT_CAP` of 256 — and `push` drops the NEWEST on a full ring,
   * so the record discarded would be the final size. Constraint 243 makes this argument against a
   * `DRAG_OVER` and A5 makes it for hover.
   *
   * THE TAIL IS READ BACK, NOT REMEMBERED. A flag saying "the tail is a client record" is a second
   * copy of the ring's own state, and the two desynchronise on the first path that pushes without
   * updating it.
   *
   * THE STALE CLOCK IS NOT RESTARTED, which falls out of replacing a tail: `unreadSince` dates the
   * oldest uncollected event, and a program that is not draining is not draining however many
   * times the size it has not read gets revised.
   */
  pushClient(w, h) {
    /* THE INVARIANT STATED, NOT A GUARD THAT FIRES — `push`'s `free === 0` test is written for the
     * same reason. `push` refuses a destroyed window, so without this line a pop whose tail was a
     * client record would delete it and count a replacement for a push that was refused: silent
     * loss. It is unreachable today, because `destroy` queues the `WEV_DESTROYED` notice as the
     * last record or hands it to a parked reader, and a parked reader means an empty ring — so the
     * tail of a destroyed window's queue is never a client record. A scratch control that removed
     * this line moved no clause, which is that argument measured. */
    if (this.destroyed) return false;
    const tail = this.#popTail();
    if (tail) {
      if (decodeWinEvent(new DataView(tail.buffer), 0).type === WEV_CLIENT) {
        this.stats.coalesced += 1;
      } else {
        // The bytes go back where they came from: the pop freed exactly one record's room.
        this.events.push(tail);
      }
    }
    /* THE RATIO IS THE TABLE'S ONE FACT, read here rather than stored per window. A window outside
     * a table has no display behind it, and 1 is the ratio under which its unscaled figures mean
     * something — a host probe is the only thing that can build one. `dprFixed` cannot throw on
     * either value, because `WinMgr.setDpr` refuses a ratio the 16.16 field cannot carry. */
    const dpr = this.mgr ? this.mgr.dpr : 1;
    return this.push({ type: WEV_CLIENT, a: w, b: h, c: dprFixed(dpr) });
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
   *  pixel box is published in `/proc/<pid>/win/<winid>` for a reader that wants it.
   *
   *  TWO UNITS ARRIVE IN ONE MESSAGE: `x`/`y`/`w`/`h` are the frame's CSS px, and
   *  `clientW`/`clientH` are the measured content box in DEVICE px. Naming them is the point —
   *  two unlabelled integers in two units is the defect M16 is about. */
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
    /* M16. AND THE CLIENT CONTENT BOX, in DEVICE pixels, which `WEV_RESIZE` cannot carry: that
     * record is CELLS — `src/bin/term.mjs` feeds them to `winsizeSet` — and it is suppressed for a
     * resize that changed no cell count, which is a resize that changed every pixel of a surface.
     *
     * ON A CHANGE ONLY, which is `moved`'s rule above and for its reason: the page reports once
     * per animation frame during a drag.
     *
     * THE `> 0` GUARD IS NOT DEFENSIVE DRESSING. A frame measured inside a `display: none` subtree
     * reports zero, and `win_surface` answers -EINVAL for a zero side — so a program told zero
     * would be handed a refusal it cannot act on. A dropped measurement leaves `clientW` at -1, so
     * the next positive one still raises.
     */
    const cw = box.clientW | 0;
    const ch = box.clientH | 0;
    if (cw > 0 && ch > 0 && (cw !== this.clientW || ch !== this.clientH)) {
      this.clientW = cw;
      this.clientH = ch;
      this.pushClient(cw, ch);
    }
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
      // M16. The measured content box in DEVICE px, beside the frame's box in CSS px and the cell
      // count in cells. `-1` means no positive measurement has arrived.
      clientW: this.clientW,
      clientH: this.clientH,
      scope: this.scope,
      mode: this.mode,
      // M14. The two shell axes, the restore point, and how many rows this window published.
      // The ROWS THEMSELVES ARE NOT HERE: `/proc/<pid>/win/<winid>` is a status file and a list of
      // 64 labels in it would make every read of it a page of text.
      state: this.state,
      role: this.role,
      restore: this.restore ? { ...this.restore } : null,
      beforeMin: this.beforeMin,
      items: this.items.length,
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
    /**
     * M10. WHERE THE POINTER IS AND WHETHER A BUTTON IS DOWN, as the kernel's own record of the
     * events the page fed it. `{win, down}`.
     *
     * IT LIVES HERE BECAUSE `feed` IS HERE: this is the one place a pointer event enters the
     * kernel, so a second tracker in `dataobj.mjs` would be the same fact with two writers. What
     * reads it is `DataMgr.beginDrag`, which refuses a drag no button started — a program that
     * could begin one unprompted would hold the single session until a pointerup that is never
     * coming (constraint 244).
     *
     * A SUPPRESSED PRESS DOES NOT COUNT, which is why the update is below the blocker test: a
     * press a modal refused never reached a program, so it cannot be the gesture a program claims.
     */
    this.pointer = { win: 0, down: false };
    /**
     * M12, M16. THE PAGE'S DEVICE-PIXEL RATIO, and the kernel's one copy of it. Reported by the
     * page — it is the side with the display — and 2 until it says otherwise, which is the ratio
     * every figure in `docs/CONSTRAINTS.md` was measured at. A kernel that assumed 1 would
     * under-read every blur budget by 4×.
     *
     * THE RATIO AND NOT ITS SQUARE IS WHAT IS STORED. M12 needed only the square, because a blur
     * cost is an area; M16's client event carries the ratio itself to a process, which has no
     * other route to it. Two independently assigned fields is how a governor comes to square a
     * ratio nobody reported, so `dprSq` is derived and `setDpr` is the one writer.
     */
    this.dpr = 2;
    /** A lowered blur budget, for a bench boot only. 0 means the real one. `blurBudget()` takes
     *  the MINIMUM of this and `BLUR_OFF_AT`, so this hook can only ever tighten the governor —
     *  a hook that could loosen it would be a way to disable the thing it exists to exercise. */
    this.blurBudgetPx = 0;
    /** Whether the governor is currently holding glass back. It is the hysteresis's state: the
     *  admission limit is the budget while this is false and the RESTORE edge while it is true. */
    this.blurDegraded = false;
    this.stats = {
      created: 0, destroyed: 0, cascaded: 0, cascadedPlacements: 0,
      refusedCap: 0, refusedOwner: 0,
      // M10: pointer presses recorded, and drag-event records the PAGE tried to feed (see `feed`).
      presses: 0, forgedDrags: 0,
      // M9: raises granted, raises refused by a modal, and how many times the stack was posted.
      raises: 0, blocked: 0, stacks: 0, suppressed: 0,
      // M8's surface accounting. `surfacePx` is what is OUTSTANDING; the refusals are counted
      // apart because a budget nobody can see refuse anything is a budget nobody believes.
      surfaces: 0, surfacePx: 0, refusedSurface: 0, batches: 0, ops: 0,
      // M12's governor. `blurPx` is what is OUTSTANDING after degrading, `blurPxIfAllGlass` is
      // what the same desktop would cost with every window on glass — two numbers, because the
      // difference between them is the only evidence the governor did anything.
      blurPx: 0, blurPxIfAllGlass: 0, flattened: 0, blurDegrades: 0,
      // M14's shell axes. Every refusal counted apart from the others, for `refusedSurface`'s
      // reason: a budget — or a rule — nobody can see refuse anything is one nobody believes.
      stateChanges: 0, roleChanges: 0, refusedState: 0, refusedRole: 0,
      desktopRaises: 0,
      itemPublishes: 0, itemActivations: 0, refusedItems: 0, badItems: 0,
      droppedItems: 0,
      // Window events the PAGE tried to post that only the kernel may produce. See `feed`.
      forgedKernelEvents: 0,
      // M16: device-pixel ratios refused. See `setDpr` — a refusal nobody can count is a display
      // the kernel is wrong about with nothing saying so.
      refusedDpr: 0,
    };
  }

  /**
   * The ratio SQUARED, which is what a blur cost is: an area (constraint 49). DERIVED, never
   * stored.
   *
   * THE SETTER IS ITS DECLARED INVERSE, and it exists for the two callers that predate `setDpr` —
   * `src/kernel/kernel.mjs`'s `win-dpr` handler and `bench/m12-governor/probe.mjs`. A square is a
   * LOSSY spelling of a ratio (`Math.sqrt(1.21)` is 1.0999999999999999), so a new caller MUST take
   * `setDpr`. What the pair buys is that the square cannot be assigned apart from the ratio.
   */
  get dprSq() {
    return this.dpr * this.dpr;
  }

  set dprSq(sq) {
    this.setDpr(Math.sqrt(sq));
  }

  /**
   * Record the display's ratio. True if it was taken.
   *
   * REFUSED RATHER THAN CLAMPED, AND COUNTED. A 0 makes every blur cost 0 and silently disarms the
   * governor; a NaN does the same through every comparison it reaches. `MAX_DPR` keeps the value
   * inside the 16.16 field `WEV_CLIENT` carries it in, which is what makes `dprFixed` unable to
   * throw on the geometry path — a page's bad number must not fault the kernel.
   */
  setDpr(dpr) {
    if (!Number.isFinite(dpr) || dpr <= 0 || dpr > MAX_DPR) {
      this.stats.refusedDpr += 1;
      return false;
    }
    this.dpr = dpr;
    return true;
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
    /* M14. THE DESKTOP IS NEVER RAISED. A click on the backdrop is a click on a window — the
     * desktop IS one — and the page posts `win-raise` for it like any other frame, so without this
     * clicking the wallpaper would bury every window on screen behind it. It stays where
     * `setRole` put it, and 0 is the honest answer: nothing refused the raise, there was simply
     * nothing to move. */
    if (win.role === WROLE_DESKTOP) {
      this.stats.desktopRaises += 1;
      return 0;
    }
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
    /* M12: AND RE-ADMIT, because a raise changes the ORDER and the flat set follows the order.
     * Without this a window the user had just clicked to the top stayed flat while a window now
     * below it kept its glass — `governBlur` recomputes the keep-set from the top of the stack, so
     * the correction needs no special case, only this call. */
    this.governBlur("raise");
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

  /* ---- M14: the show state, the role, and the published items -------------------------------
   *
   * THE DIVISION IS THE ONE `WIN_SET_BOX` ALREADY MAKES. A maximized window fills the WORK AREA —
   * the desktop minus whatever the shell has taken off it — and that is a fact only the page has.
   * So this side records WHAT state a window is in, which window is the desktop, and where a
   * maximized window came from; the page lays the frame out for it and reports the box through
   * `win-geom` like every other box (constraint 271).
   *
   * WHY THE KERNEL AT ALL, since the page could track a flag: because minimizing changes the
   * BLURRED AREA and the blur governor is an admission controller over it (constraint 49), because
   * a desktop window's place at the bottom of the stack is the z-order and the z-order is the
   * kernel's (constraint 226), and because "there is one desktop" is a uniqueness two processes
   * that cannot see each other have no way to agree on.
   */

  /** Whether any live window already holds the desktop role. */
  desktop() {
    return this.live().find((w) => w.role === WROLE_DESKTOP) || null;
  }

  /**
   * Set a window's SHOW STATE, or a negative errno. Returns the state it SETTLED ON, which is not
   * always the one asked for.
   *
   * RESTORING A MINIMIZED WINDOW GIVES BACK WHAT IT WAS, which is Win32's `SW_RESTORE` and what a
   * taskbar button has to do: minimize a maximized window, click it again, and a maximized window
   * must come back. So a request for `WST_NORMAL` while minimized settles on `beforeMin`, and the
   * state that was really reached is what is returned and posted — a caller that assumed its own
   * argument would be wrong exactly once, on the case a user hits every day.
   *
   * THE DESKTOP HAS NO SHOW STATE. Minimizing the thing every other window sits on is not a
   * gesture with a meaning, and maximizing it is what it already is.
   */
  setState(win, want) {
    if (!(want >= 0 && want <= WST_LIMIT)) return -EINVAL;
    if (win.destroyed || !win.attached) return -EHOSTGONE;
    if (win.role === WROLE_DESKTOP) {
      this.stats.refusedState += 1;
      return -EINVAL;
    }
    const from = win.state;
    let state = want | 0;
    if (from === WST_MIN && state === WST_NORMAL) state = win.beforeMin;
    if (state === from) return state;
    /* THE RESTORE POINT IS TAKEN ON THE WAY OUT OF A FLOATING STATE, and only then: a window
     * dragged from a snap to a maximize must still go back to the box it had when it was last
     * floating, not to the half-screen it was snapped to. */
    if (from === WST_NORMAL && state !== WST_MIN) win.restore = { ...win.box };
    if (state === WST_MIN) win.beforeMin = from === WST_MIN ? win.beforeMin : from;
    /**
     * AND IT IS CONSUMED BY THE RETURN IT PAYS FOR, which a critic found it was not.
     *
     * `restore` used to survive every transition, so the page — which applies whatever box the
     * post carries — moved a window back to a geometry that was two gestures stale. Reproduced:
     * maximize a window at (30,40), restore it, DRAG IT to (500,300), minimize it, then click its
     * taskbar button. The post carried (30,40) and the window teleported there, and because the
     * page reports the box it settled on, the kernel then recorded the wrong place too.
     *
     * A restore point answers one question — "where was this window before it was docked" — and
     * once the window is floating again the answer is its own box. So the box travels with the
     * post that uses it and is cleared behind it.
     */
    const give = state === WST_NORMAL && win.restore ? { ...win.restore } : null;
    if (state === WST_NORMAL) win.restore = null;
    win.state = state;
    this.stats.stateChanges += 1;
    /* THE PROCESS IS TOLD. An EVENT and not a query, for `WEV_FOCUS`'s reason — the process that
     * wants to know is parked in `poll` — and it matters: a program drawing into a surface nobody
     * is showing is paying for pixels no reader sees. */
    win.push({ type: WEV_STATE, a: state, b: from });
    /* AND THE PAGE IS TOLD, with the restore box, because the page is what has to lay the frame
     * out: going back to NORMAL means going back to a geometry the page no longer holds. */
    K.post({
      t: "win-show",
      win: win.id,
      state,
      from,
      /* THE BOX TO GO BACK TO on a return to NORMAL, and the box to come back to LATER on the way
       * into a docked state — the page needs the second one to size an undock. Null once it has
       * been used, which is what stops a stale one being applied. */
      restore: give || (win.restore ? { ...win.restore } : null),
    });
    /* M12's OWN GAP, CLOSED. Constraint 49 lists "open, maximize, snap, restore, un-minimize,
     * peek" as the events an admission controller must see, and M12 recorded that nothing had ever
     * driven a minimize through it because none of those gestures existed. They do now, and this
     * is the call that makes the claim a run rather than a shape: `blurCost` charges a minimized
     * window nothing. */
    this.governBlur("state");
    return state;
  }

  /**
   * Set a window's ROLE, or a negative errno.
   *
   * THE DESKTOP IS UNIQUE AND IT LIVES AT THE BOTTOM. A second one is -EBUSY rather than a second
   * surface nobody can reach, and an OWNED window cannot be the desktop — the owner chain exists
   * so a dialog rides above its owner, and the desktop is the one window nothing may ride above.
   */
  setRole(win, role) {
    if (!(role >= 0 && role <= WROLE_LIMIT)) return -EINVAL;
    if (win.destroyed || !win.attached) return -EHOSTGONE;
    if (role === win.role) return 0;
    /**
     * THE DESKTOP ROLE IS ONE-WAY, and this is `win_surface`'s own rule rather than a new one: a
     * window's content mode changes once (`src/wm/winhost.mjs` `#surface`, `#role`), because two
     * renderers for one window's inside is two places the same pixel can come from. Taking the
     * role replaces the text widget with an icon view, and nothing can put a terminal back — so a
     * window that gave the role up would be a window with a desktop's insides, no keyboard and a
     * place at the bottom of the stack. A critic found exactly that.
     *
     * -EINVAL and not -EPERM: it is not a privilege, it is a transition that does not exist.
     */
    if (win.role === WROLE_DESKTOP) {
      this.stats.refusedRole += 1;
      return -EINVAL;
    }
    if (role === WROLE_DESKTOP) {
      /* THE WINDOW'S OWN DISQUALIFICATION FIRST, and the order is the point: an OWNED window can
       * never be the desktop, and -EBUSY would tell it to try again later. A permanent refusal
       * outranks a transient one, which is the same reason `surface` answers -ENOMEM rather than
       * -EAGAIN for a budget. */
      if (win.owner !== 0 || win.children.length > 0) {
        this.stats.refusedRole += 1;
        return -EINVAL;
      }
      const held = this.desktop();
      if (held && held.id !== win.id) {
        this.stats.refusedRole += 1;
        return -EBUSY;
      }
      /* A DESKTOP IS NEVER MINIMIZED OR MAXIMIZED, so a window that was either becomes normal as
       * it takes the role — AND BOTH SIDES ARE TOLD, which a critic found they were not. The page
       * writes `Win.state` only from a `win-show`, so a MINIMIZED window that took the role kept
       * `hidden` set for ever: the kernel believed the desktop was normal and at the bottom of the
       * stack, the frame was not on screen, and `setState` refuses a desktop — so there was no way
       * back. That is exactly the state this comment used to claim it was preventing. */
      if (win.state !== WST_NORMAL) {
        const was = win.state;
        win.state = WST_NORMAL;
        win.push({ type: WEV_STATE, a: WST_NORMAL, b: was });
        K.post({ t: "win-show", win: win.id, state: WST_NORMAL, from: was, restore: null });
      }
      win.restore = null;
    }
    win.role = role;
    this.stats.roleChanges += 1;
    /* TO THE BOTTOM, and the whole order goes out: the page renders the order it is sent and
     * decides nothing (constraint 226). ONLY FOR THE DESKTOP — a critic found this running for
     * every role change, which would send an ordinary window to the back of the stack for having
     * said it was ordinary. The role is one-way now, so the other branch is unreachable; the guard
     * stays because the reachability is an argument and this is an invariant. */
    if (role === WROLE_DESKTOP) this.lowerToBottom(win);
    K.post({ t: "win-role", win: win.id, role });
    this.governBlur("role");
    return 0;
  }

  /** Put a window at the bottom of the stack and post the order. The desktop's own move. */
  lowerToBottom(win) {
    this.stack = [win.id, ...this.stack.filter((id) => id !== win.id)];
    this.postStack();
    return 0;
  }

  /**
   * Replace a window's published rows. Returns how many it holds, or a negative errno.
   *
   * THE LIST IS REPLACED WHOLE, never appended to, for the reason the blur governor posts its whole
   * flat set and the stack posts its whole order (constraint 226): a shell applying a delta can
   * come to disagree with the publisher about what the list is, and nothing would say so.
   */
  items(win, rows) {
    if (win.destroyed || !win.attached) return -EHOSTGONE;
    if (!Array.isArray(rows)) return -EINVAL;
    if (rows.length > WIN_ITEM_CAP) {
      this.stats.refusedItems += 1;
      return -EINVAL;
    }
    win.items = itemsReach
      ? rows.map((r) => ({ icon: r.icon | 0, flags: r.flags | 0, label: String(r.label) }))
      : [];
    this.stats.itemPublishes += 1;
    if (!itemsReach) this.stats.droppedItems += rows.length;
    K.post({ t: "win-items", win: win.id, items: win.items.map((r) => ({ ...r })) });
    return win.items.length;
  }

  /**
   * The shell says one of a window's rows was activated. Returns true if the event queued.
   *
   * THE INDEX IS VALIDATED AGAINST THE LIST THE KERNEL IS HOLDING, which is the same division as
   * every other page report: the page says WHERE the pointer went and the kernel decides what that
   * means. Without it a page could name a row that does not exist and a program would act on an
   * index into its own array that nothing published.
   *
   * A SEPARATOR AND A DISABLED ROW ARE NOT ACTIVATABLE, and they are refused here rather than
   * trusted not to be drawn as buttons: the flags are the publisher's statement about its own rows,
   * and the one place they can be enforced is the side that holds them.
   */
  activateItem(id, index, where) {
    const win = this.get(id);
    if (!win || win.destroyed) return false;
    const row = win.items[index | 0];
    if (!row) {
      this.stats.badItems += 1;
      return false;
    }
    if ((row.flags & WITEM_SEPARATOR) || (row.flags & WITEM_DISABLED)) {
      this.stats.badItems += 1;
      return false;
    }
    this.stats.itemActivations += 1;
    return win.push({ type: WEV_ITEM, a: index | 0, b: row.flags, c: where | 0 });
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

  /* ---- M12: the blur governor ---------------------------------------------------------------
   *
   * An ADMISSION CONTROLLER over total blurred area, not a drag hook (constraint 49). It runs on
   * every event that can change the area — a window opening, the page reporting a new box after a
   * clamp or a resize, and a window being destroyed — and when the total crosses `BLUR_OFF_AT` it
   * takes glass away from the BOTTOM OF THE STACK upward until the total is under the budget.
   *
   * WHY THE KERNEL AND NOT THE PAGE. Only the kernel owns the z-order (constraint 226) and only
   * the kernel sees every area-changing call; a page that chose for itself would be deciding which
   * window is cheap enough to keep, which is a policy, and the page renders policy rather than
   * making it. The page is told WHICH windows are flat and draws a cheap fill for them.
   *
   * WHY IT DOES NOT FIRE IN PRACTICE, measured and stated here rather than discovered. A 640×440
   * window's four strips filter 109,040 device px at dpr 2, so `BLUR_OFF_AT` is 413 windows away —
   * past anything `WIN_CAP` × `PROC_CAP` makes reachable. That is a consequence of M11's geometry,
   * not of this threshold: the same window as ONE glass node filters 1.13 M device px and the
   * budget binds at 40. `bench/m12-governor/probe.py` carries the sweep, and `scripts/check.py`
   * drives the degrade branch through `cfg.blurBudgetPx` — the same bench-boot-only hook M3 uses
   * to build a 64 KiB trace ring, and for the same reason: a refusal path nothing can reach is a
   * refusal path nobody has seen work.
   */

  /** One window's blurred device pixels, from the box the page reported. `blurRingArea` is the
   *  ONE definition and it lives in `src/abi.mjs` because this file and the skin are the two
   *  sides that must agree on it (constraint 255). */
  blurCost(win) {
    if (!win || win.destroyed || !win.attached) return 0;
    /* M14. A WINDOW WITH NO FRAME ON SCREEN FILTERS NOTHING, and there are two of them. A
     * MINIMIZED window is not rendered at all, and the DESKTOP has no frame by definition — the
     * shell draws its icons straight onto the backdrop. Charging either would be accounting a ring
     * nobody renders, which is constraint 49's under-read arrived at from the other side, and it
     * would make a desktop full of minimized windows degrade the glass of the one in use. */
    if (win.state === WST_MIN || win.role === WROLE_DESKTOP) return 0;
    /* A SURFACED WINDOW COSTS THE SAME, which is why there is no branch on it. The surface
     * replaces the client area, and the client area was already opaque and already outside the
     * ring — so the four strips are unchanged. Charging zero for one would let a desktop full of
     * `paint` windows cross the wall uncounted. */
    return blurRingArea(win.box.w, win.box.h) * this.dprSq;
  }

  /** The budget in force. A bench boot may lower it; nothing may raise it. */
  blurBudget() {
    return this.blurBudgetPx > 0 ? Math.min(this.blurBudgetPx, BLUR_OFF_AT) : BLUR_OFF_AT;
  }

  /** The restore edge, kept in the same proportion to the budget as `BLUR_ON_AT` is to
   *  `BLUR_OFF_AT` — so a lowered budget keeps its hysteresis instead of collapsing to one edge,
   *  which is what a control that removed the hysteresis would look like by accident. */
  blurRestore() {
    return Math.round(this.blurBudget() * (BLUR_ON_AT / BLUR_OFF_AT));
  }

  /**
   * Re-run admission. Returns the number of windows that are flat afterwards.
   *
   * THE INPUT IS THE ALL-GLASS COST, AND THAT IS THE WHOLE DESIGN. Every window's ring area is
   * summed whether it is currently flat or not, so **the number this governor decides on does not
   * respond to what it does.** Two consequences, and both were defects before:
   *
   *   - IT IS IDEMPOTENT. The first version summed only the non-flat windows, so flattening a
   *     window lowered the total, which re-admitted it, which raised the total again — a genuine
   *     feedback loop, and the reason hysteresis looked necessary. With an action-independent
   *     input there is no loop to damp.
   *   - AND THERE IS NO STUCK STATE. Gating re-admission on a restore edge below the budget means
   *     a single window whose own cost exceeds that edge can never get its glass back: `0 + c`
   *     is always greater than `0.8 * c`. Hit at a real prompt — four windows closed and three
   *     captions stayed flat — and then hit again from the other side, with both staged windows
   *     flat because neither fitted under the lower edge.
   *
   * SO THE HYSTERESIS IS NOT LOAD-BEARING HERE, and saying so is better than keeping a mechanism
   * that cannot change an outcome. `BLUR_ON_AT` still decides WHETHER the governor is in its
   * degraded state, which is what `blurDegraded` reports and what a reader sees — but since the
   * keep-set is computed against the budget either way, the band between the two edges never
   * changes which windows are flat. **It becomes load-bearing the moment a successor drives this
   * from a MEASURED frame cost**, because flattening does reduce that, and the loop returns. That
   * measurement is what this environment cannot take (constraint 267), which is exactly why the
   * model-based input is what shipped.
   *
   * DEGRADES FROM THE BOTTOM, by recomputing the keep-set from the TOP of the stack every time and
   * stopping at the first window that does not fit. The keep-set is a top suffix and the flat set a
   * bottom prefix by construction — which is what constraint 49's "degrade by z-order from the
   * bottom" means, and what makes a RAISE do the right thing with no special case. The first
   * version walked the existing flags instead and could not swap a raised window with the one
   * below it, so a window the user had just clicked to the top stayed flat.
   */
  governBlur(why = "") {
    /* THE GOVERNOR OFF. Everything else still runs — the accounting below is skipped with it, so
     * `blurPx` goes stale, which is why the control's declared set includes the accounting
     * clauses and not only the degrade ones. */
    if (governor.off) {
      this.stats.blurPxIfAllGlass = this.live()
        .reduce((s, w) => s + this.blurCost(w), 0);
      this.stats.blurPx = this.stats.blurPxIfAllGlass;
      return 0;
    }
    const budget = this.blurBudget();
    const restore = this.blurRestore();
    const live = this.live();
    const cost = new Map(live.map((w) => [w.id, this.blurCost(w)]));
    /** The ALL-GLASS cost: every live window, flat or not. See the note above — this is the input,
     *  and it is independent of what the governor did last time. */
    const full = live.reduce((s2, w) => s2 + (cost.get(w.id) || 0), 0);
    const before = live.filter((w) => w.flat).map((w) => w.id);

    /** The windows that fit under `limit`, taken from the TOP of the stack and stopping at the
     *  first that does not — so the result is a top suffix. `topFirst` takes them from the bottom
     *  instead, which is the control: it still fits the budget and still flattens, and what moves
     *  is which window pays.
     *
     *  STALE COSTS are the other control: summing only the non-flat windows restores the feedback
     *  loop this design removes. */
    const fit = (limit) => {
      const keep = new Set();
      const order = governor.topFirst ? this.stack : [...this.stack].reverse();
      let run = 0;
      for (const id of order) {
        const win = this.get(id);
        if (!win || win.destroyed || !win.attached) continue;
        const c = cost.get(id) || 0;
        if (run + c > limit) break;
        run += c;
        keep.add(id);
      }
      return keep;
    };

    /* The degraded STATE carries the hysteresis: it takes the budget to enter and the restore edge
     * to leave. The keep-set is computed against the budget either way (see the note above), so
     * this is what a reader is told rather than what decides the pixels. */
    /* THE CONTROL IS APPLIED TO THE INPUT, which is where the defect was. `current` sums only the
     * windows that still have glass, so flattening lowers it — and the governor then re-admits
     * everything, which raises it again. `blurDegrades` climbs on every run over an unchanged
     * desktop, which is what oscillation looks like from outside. */
    const current = live.reduce((s2, w) => s2 + (w.flat ? 0 : cost.get(w.id) || 0), 0);
    const input = governor.staleCosts ? current : full;
    this.blurDegraded = this.blurDegraded ? input > restore : input > budget;
    const keep = input > budget ? fit(budget) : new Set(live.map((w) => w.id));
    for (const win of live) {
      const flat = !keep.has(win.id);
      if (flat && !win.flat) this.stats.flattened += 1;
      win.flat = flat;
    }

    const after = this.live().filter((w) => w.flat).map((w) => w.id);
    this.stats.blurPx = live.reduce((s2, w) => s2 + (w.flat ? 0 : cost.get(w.id) || 0), 0);
    this.stats.blurPxIfAllGlass = full;
    const changed = before.length !== after.length
      || before.some((id, at) => id !== after[at]);
    if (changed) {
      this.stats.blurDegrades += 1;
      /* THE PAGE IS TOLD WHICH, and the whole set rather than a delta — the same reason the whole
       * stack is posted rather than a "raise this one" (constraint 226): a page applying a delta
       * can disagree with the kernel about the current state and nothing would say so. */
      K.post({
        t: "win-blur",
        flat: after,
        blurPx: this.stats.blurPx,
        budget,
        restore,
        why: String(why),
      });
    }
    return after.length;
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
  /**
   * STEP A NEW WINDOW OFF ONE THAT IS ALREADY THERE.
   *
   * Programs name their own geometry, and several name a CONSTANT: `src/bin/files.mjs` asks for
   * `x: 40, y: 40` every time. So two of them land on exactly the same pixel, and the second is a
   * window a reader cannot see and cannot tell apart from one that never opened — which is how
   * this was reported: a double-click on a second folder "did nothing", and what it had done was
   * open a window perfectly behind the first.
   *
   * THE KERNEL IS WHERE THIS CAN LIVE, because it is the only side that knows every window. The
   * rule is narrow on purpose: an EXACT collision of the top-left corner with a live, floating,
   * non-desktop window steps down-right by `CASCADE_STEP` and tries again. A window that merely
   * overlaps is left alone — overlapping is what windows do, and a manager that spread them out
   * would be deciding a layout nobody asked for.
   *
   * The walk is bounded by the number of live windows: each step either finds a free corner or
   * passes one occupied corner. A window that cannot be
   * placed keeps what it asked for, because losing the window would be worse than stacking it.
   */
  #cascade(win) {
    if (win.role === WROLE_DESKTOP || win.state !== WST_NORMAL) return;
    const taken = () => {
      for (const other of this.byId.values()) {
        if (other.destroyed || other === win) continue;
        if (other.role === WROLE_DESKTOP || other.state !== WST_NORMAL) continue;
        if (other.box.x === win.box.x && other.box.y === win.box.y) return true;
      }
      return false;
    };
    // BOUNDED BY HOW MANY WINDOWS EXIST, exactly: each step passes at most one occupied corner.
    const limit = this.byId.size + 1;
    for (let step = 0; step < limit && taken(); step += 1) {
      win.box = { ...win.box, x: win.box.x + CASCADE_STEP, y: win.box.y + CASCADE_STEP };
      this.stats.cascadedPlacements += 1;
    }
  }

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
    // THE TABLE IT BELONGS TO, for one fact: the display's ratio, which a client event carries and
    // no window owns a copy of. See `Window.pushClient`.
    win.mgr = this;
    this.#cascade(win);
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
      // M14. THE PROGRAM, so a Superbar can group its buttons by it: two terminals are one button
      // with two windows, and a page that only has a pid and a title cannot know that. The title
      // is whatever the program says it is; this is what the user typed.
      prog: K.progOf ? K.progOf(pid) : "",
      x: win.box.x, y: win.box.y, w: win.box.w, h: win.box.h,
    });
    this.postStack();
    // M12: OPENING A WINDOW IS AN AREA-CHANGING EVENT, which constraint 49 lists first. After the
    // stack, because the governor degrades BY the stack and a window not yet in it cannot be
    // ordered.
    this.governBlur("create");
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
      /* AND ITS UNCOLLECTED DROP GOES WITH IT. A payload dropped on a window that never read the
       * event is held by the kernel, and a window that is gone can never collect it — so the
       * reference is released here, where the window's other resources are. Injected rather than
       * imported, like `pollWake`: `src/kernel/dataobj.mjs` reads the window table through its own
       * getter and an import here would be the cycle. */
      if (K.windowGone) K.windowGone(w.id);
      // OUT OF THE STACK, or a destroyed window would hold a place in the order for ever and
      // `blockingFor` would keep finding it.
      this.stack = this.stack.filter((id) => id !== w.id);
      this.stats.destroyed += 1;
    }
    if (ids.length > 1) this.stats.cascaded += ids.length - 1;
    K.post({ t: "win-destroy", ids });
    this.postStack();
    // M12: AND CLOSING ONE GIVES THE AREA BACK, so a desktop that came down under the restore
    // edge gets its glass again. Without this a single busy moment would leave every window flat
    // for the rest of the session — the failure a governor with no restore path has.
    this.governBlur("destroy");
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
    /* M10. A DRAG RECORD IS THE KERNEL'S TO PRODUCE, AND THIS IS THE PAGE'S ROUTE, so the four of
     * them are refused here and counted. The page reports WHERE the pointer is (`drag-at`,
     * `drag-drop`); which window is the target, whether it may be one, and what the payload is are
     * `src/kernel/dataobj.mjs`'s — the same division M9 made for the stack. Without this line a
     * page could post a `WEV_DROP` naming an offer no object carries, and a target would ask for a
     * drop that does not exist. */
    if (ev.type === WEV_DRAG_ENTER || ev.type === WEV_DRAG_LEAVE || ev.type === WEV_DROP
      || ev.type === WEV_DRAG_DONE) {
      this.stats.forgedDrags += 1;
      return false;
    }
    /* M14. AND NEITHER OF THE TWO M14 ADDED, for the same reason and with its own counter. A
     * `WEV_STATE` the page posted would tell a program it had been minimized when the kernel
     * believes otherwise; a `WEV_ITEM` would name a row index nothing published. Both have a
     * kernel route — `setState` and `activateItem` — which is where the validation lives.
     *
     * M16'S CLIENT EVENT JOINS THEM, and the general rule is the PRD's: every KERNEL-PRODUCED
     * event belongs in this list. A page-posted `WEV_CLIENT` would tell a program its content box
     * is a size no frame has, and the program would re-surface to it — charging the budget for a
     * rectangle nobody renders. The kernel's route is `setBox`, from the box the page MEASURED,
     * which is where the `> 0` guard lives.
     *
     * M17'S WHEEL MUST NOT JOIN THIS LIST. A wheel is a browser event and the page is its only
     * honest source, so refusing one would refuse the thing itself. What the kernel owns there is
     * `WWHEEL_COALESCED`: `feed` must MASK that bit out of a wheel record it accepts, or a page
     * can tell a program that twenty notches arrived as one. */
    if (ev.type === WEV_STATE || ev.type === WEV_ITEM || ev.type === WEV_CLIENT) {
      this.stats.forgedKernelEvents += 1;
      return false;
    }
    if (ev.type === WEV_KEY || ev.type === WEV_POINTER) {
      const blocker = this.blockingFor(w);
      if (blocker) {
        // COUNTED, on the window that did not get it: a program whose keys silently stopped
        // arriving would have no way to tell that from a keyboard that stopped working.
        w.stats.suppressed += 1;
        this.stats.suppressed += 1;
        /* AND A SUPPRESSED POINTER EVENT CLEARS THE GATE, which is the fail-closed reading: the
         * kernel no longer knows where the pointer is, so no program may claim a gesture on it.
         * The hole without this is a stale `down`: press in window A, move over a BLOCKED window
         * B and release there, and B's up is suppressed too — so the kernel would still believe a
         * button was held in A, and A's process could begin a drag with nothing pressed
         * (constraint 244). */
        if (ev.type === WEV_POINTER) this.pointer = { win: 0, down: false };
        return false;
      }
    }
    /* THE POINTER'S OWN STATE, recorded from the event that carries it and nowhere else. Below the
     * suppression on purpose: a press a modal refused is not a gesture a program may build a drag
     * on (constraint 244). */
    if (ev.type === WEV_POINTER) {
      if (ev.mods & WPTR_DOWN) {
        this.pointer = { win: w.id, down: true };
        this.stats.presses += 1;
      } else if (ev.mods & WPTR_UP) {
        this.pointer = { win: w.id, down: false };
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
    const desk = this.desktop();
    return {
      ...this.stats,
      stack: [...this.stack],
      live: this.live().length,
      rows: this.byId.size,
      nextId: this.nextId,
      // M16. THE DISPLAY'S RATIO, which `dprSq` below is derived from. A page reads it back to
      // assert the kernel took what it posted; a process reads it off a client event or `/proc`.
      dpr: this.dpr,
      // M14. Which window is the desktop, and the show state of every live window — the two facts
      // a shell renders and a check reads, in the kernel's own words rather than the page's.
      desktop: desk ? desk.id : 0,
      states: Object.fromEntries(this.live().map((w) => [w.id, w.state])),
      minimized: this.live().filter((w) => w.state === WST_MIN).map((w) => w.id),
      // M12. The governor's whole state, because a budget nobody can read is a budget nobody
      // believes — the same reason `refusedSurface` is counted apart from the other refusals.
      blur: {
        budget: this.blurBudget(),
        restore: this.blurRestore(),
        dprSq: this.dprSq,
        flat: this.live().filter((w) => w.flat).map((w) => w.id),
        // Per-window cost, so a check can assert the accounting rather than only its total.
        cost: Object.fromEntries(this.live().map((w) => [w.id, this.blurCost(w)])),
        lowered: this.blurBudgetPx > 0,
      },
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
