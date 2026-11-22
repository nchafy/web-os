// The page's half of every window: one frame per kernel window, and the one route between a
// browser event and a window's event queue.
//
// THERE IS NO SYSCALL IN THIS FILE: a window agent cannot `Atomics.wait` (constraint 1), so this
// module draws and listens while the page holds the one route to the kernel. It is handed a `post`
// and nothing else.
//
// It replaces `www/m4a.html`'s hand-wired console pair. M4a had ONE window, created by the page
// before any process existed, so the page could keep its widget in a variable. A process creates
// its own windows now and may create several, so the mapping winid -> {frame, widget} has to be a
// table — and that table is the whole of this file.
//
//   kernel -> win-create  -> a frame and a widget appear
//   kernel -> win-out     -> cells into the widget
//   kernel -> win-destroy -> the frame goes, children first
//   browser keydown       -> win-in with a WEV_KEY record
//   browser drag/resize   -> win-geom with the box the clamp settled on

import { Win, geometryControlsInForce } from "./window.mjs";
// `bytesForKey` is the TERMINAL's key translation, reused for a surface rather than written
// again: a Ctrl-C is 0x03 whatever is inside the window (constraint 161's file is where it lives).
import { Terminal, bytesForKey } from "./terminal.mjs";
import { Surface } from "./surface.mjs";
// A CAPTION'S ICON IS THE SHELL'S ANSWER TO "which program is this", and the same answer a taskbar
// button uses — one table, in the module that owns the drawings.
import { iconMarkup, iconForProgram } from "./icons.mjs";
// M14's THIRD CONTENT MODE. A window is text, pixels, or ITEMS — and which one is decided by the
// window's ROLE rather than by a call, because the desktop is the only window whose inside is a
// set of rows the shell draws. See `#role`.
import { IconView } from "./desktop.mjs";
import {
  WEV_KEY, WEV_CLOSE, WEV_FOCUS, WEV_POINTER, WMOD_SHIFT, WMOD_CTRL, WMOD_ALT,
  WPTR_DOWN, WPTR_UP, WPTR_MOVE, packKeyBytes,
  WMODAL_SYSTEM, WMODE_BLOCKING,
  WST_NORMAL, WST_MIN, WROLE_NORMAL, WROLE_DESKTOP,
} from "../abi.mjs";

/** Cell metrics, measured once per host from a real rendered glyph rather than assumed: the cell
 *  count is what a resize event carries, and a hard-coded 8×16 would make every `stty size` wrong
 *  on a display that is not this one. */
function measureCell(into) {
  const probe = document.createElement("pre");
  probe.className = "terminal";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  // Ten columns and two rows, so one glyph's fractional advance is divided out rather than rounded.
  probe.textContent = `${"M".repeat(10)}\n${"M".repeat(10)}`;
  into.append(probe);
  const r = probe.getBoundingClientRect();
  probe.remove();
  const w = r.width / 10;
  const h = r.height / 2;
  // A zero would make every cell count Infinity. Falling back SAYS SO rather than looking measured.
  if (!(w > 0) || !(h > 0)) return { w: 8, h: 16, measured: false };
  return { w, h, measured: true };
}

/**
 * M13's SECOND NEGATIVE CONTROL. `#report` tells the kernel the box the process ASKED FOR instead
 * of the box the clamp settled on, so the kernel's record is a geometry no frame ever had.
 *
 * WHAT IT IS ABOUT: `src/kernel/wins.mjs` says "the kernel RECORDS geometry; it never decides it",
 * and the only thing making that true is this one post. Everything downstream of it — `/proc`, the
 * blur governor's area, a terminal's cell count — is arithmetic over a number the page supplied, so
 * a page that supplied the wrong one would be believed. Module-level for `setGeometryControls`'s
 * reason, and page-side for the same one: nothing here is reachable from a process.
 */
/**
 * And M13's THIRD: the desktop changing size re-clamps nothing, which is the world this file was in
 * until M13 — frames hanging outside a desktop that shrank, with their captions out of reach, and
 * a kernel still accounting the boxes they used to have.
 */
let hostControls = { staleGeom: false, noRelayout: false };

export function setHostControls(opts = {}) {
  hostControls = {
    staleGeom: opts.staleGeom === true,
    noRelayout: opts.noRelayout === true,
  };
  return { ...hostControls };
}

export class WinHost {
  /** `spec.into` is the desktop element, `spec.post` sends one message to the kernel. */
  constructor(spec) {
    this.into = spec.into;
    this.post = spec.post;
    /** winid -> {win: Win, term: Terminal, meta}. */
    this.frames = new Map();
    this.cell = measureCell(this.into);
    /* M12. THE DEVICE-PIXEL RATIO, REPORTED ONCE. The kernel accounts blur in device px and has no
     * way to learn the ratio — it is a property of the display and the kernel is a worker. Same
     * division as the terminal cell above: the page measures what only the page can see. */
    this.post({ t: "win-dpr", dpr: window.devicePixelRatio || 1 });
    /** Every win-create the host saw, in order, so a check can assert on what the kernel asked for
     *  rather than on what survived. */
    this.created = [];
    this.destroyed = [];
    /** TRUSTED AND SYNTHETIC KEYS ARE COUNTED BY THE WIDGET, not here: `isTrusted` is a property
     *  of the browser's own event and `src/wm/terminal.mjs` is where it is read, so a second count
     *  in this file would be the same fact with two renderers. See `keyCounts`. */
    this.stats = { creates: 0, destroys: 0, keys: 0, cells: 0, geoms: 0, closes: 0, focus: 0,
      dropped: 0, unknown: 0,
      // M8: surfaces created, batches replayed, ops in them, and pointer events sent back.
      surfaces: 0, batches: 0, ops: 0, pointers: 0,
      // M9: stacks applied, raises asked for, and raises the kernel refused.
      stacks: 0, raiseAsks: 0, blocked: 0,
      // M10: drags begun, pointer reports sent, releases sent, target changes rendered, and
      // clipboard publishes seen.
      drags: 0, dragAts: 0, dragDrops: 0, dragTargets: 0, copies: 0,
      // M12: how many times the governor changed the flat set, and how many frames are flat now.
      blurs: 0, flat: 0,
      // M14: show-state changes rendered, roles rendered, item lists rendered, item activations
      // reported, and faults in a watcher — a shell that throws must not take the window table
      // down with it, and a fault nobody counted is a shell that silently stopped updating.
      shows: 0, roles: 0, itemLists: 0, itemAsks: 0, iconViews: 0, watcherFaults: 0 };
    /** The live drag, as the KERNEL announced it: `{win, obj, offer, formats, effects}` or null.
     *  The page never decides that one is live — it reports where the pointer is (constraint 243). */
    this.drag = null;
    /** The winid the kernel says is the current drop target, or 0. RENDERED AND NOT COMPUTED: the
     *  page hit-tests, but only the kernel knows a window is blocked, so a highlight the page chose
     *  for itself would promise a drop that will not happen (constraint 226's rule). */
    this.dragTarget = 0;
    /** The last drag the kernel ended, and what it reported: `{effect, target, why}`. */
    this.lastDrag = null;
    /** What the clipboard holds, as the kernel announced it. For a reader; nothing here acts on it. */
    this.clipboard = null;
    /** The drag image: one element per host, built on the first drag and hidden between them. A
     *  cursor is a picture, so it is the page's — the kernel owns no pixels. */
    this.dragEl = null;
    /** The last stack the kernel sent, bottom first, and the last refusal it reported. A check
     *  reads these rather than the DOM's own order, because the kernel's order is the authority
     *  and the DOM is only what this file did with it. */
    this.order = [];
    this.lastBlocked = null;
    /** Which windows the KERNEL says are blocked, as of its last order. The page computes nothing
     *  here; it renders a set it was handed, for the reason it renders an order it was handed. */
    this.blockedSet = new Set();
    /** M12. Which windows the GOVERNOR took the glass from, as the kernel decided it, plus the
     *  arithmetic it decided on. RENDERED AND NOT COMPUTED, for `blockedSet`'s reason: only the
     *  kernel owns the z-order it degrades by, so a page choosing for itself would be making the
     *  policy it is supposed to be drawing (constraint 226). */
    this.flatSet = new Set();
    this.lastBlur = null;
    /** The kernel's receipt for each batch of events: offered against queued. SOMETHING READS IT —
     *  an unread receipt is how M4a's silent input loss survived (constraint 160). */
    this.fed = { offered: 0, queued: 0 };
    /** The key counts of windows that have GONE. Summed into `keyCounts` so a check that reads the
     *  count after a session ended does not read zero for keys that were really pressed. */
    this.retired = { trusted: 0, synthetic: 0 };
    /** How many times the desktop changed size and every frame was re-clamped, and what the last
     *  one did. Set before the observer below, which fires once on `observe`. */
    this.relayouts = 0;
    this.skippedRelayouts = 0;
    this.lastRelayout = null;
    /**
     * THE DESKTOP CHANGING SIZE IS A GEOMETRY EVENT, and until M13 nothing was listening.
     *
     * `Win.apply` clamps against the desktop's CURRENT rect, so the clamp was correct at every
     * gesture and stale at every resize: a desktop that shrank left frames hanging outside it with
     * their title bars out of reach, and nothing reported a box that had stopped being true. The
     * two-box design (`src/wm/window.mjs`) is what makes the recovery free — `box` is still what
     * the process asked for, so a desktop that grows back puts each window where the user put it.
     *
     * M14 needs the same callback for a reason that is not a resize at all: the taskbar takes a
     * strip off the bottom, so the WORK AREA changes when the shell appears.
     */
    this.observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => this.relayout("resize"))
      : null;
    if (this.observer) this.observer.observe(this.into);
    /**
     * M14. HOW MUCH OF THE DESKTOP'S BOTTOM EDGE THE SHELL HAS TAKEN, in CSS px.
     *
     * The taskbar reserves it (`reserve`), and the WORK AREA is what is left. A maximized window
     * fills the work area and not the desktop, because a window covering the taskbar is a window a
     * user cannot get out from under — and the desktop window itself is laid out in it, because an
     * icon under the taskbar is an icon nobody can click.
     */
    this.reserved = 0;
    /** Whoever wants to know when the window table changed: the shell, so a taskbar button appears
     *  the moment a window does. ONE list of callbacks and no DOM events — a CustomEvent would put
     *  the shell's wiring in the document, where two hosts over one desktop would both answer. */
    this.watchers = [];
  }

  /**
   * Reserve a strip off the bottom of the desktop for the shell, and re-lay-out every frame.
   *
   * IT RE-CLAMPS, which is the half that is easy to leave out: a maximized window laid out before
   * the taskbar appeared is a maximized window covering it. `relayout` is M13's own addition and
   * this is the second caller it was written for.
   */
  reserve(px) {
    const want = Math.max(0, px | 0);
    if (want === this.reserved) return this.reserved;
    this.reserved = want;
    this.relayout("reserve");
    return this.reserved;
  }

  /** The work area, in desktop coordinates: everything the shell has not taken. */
  workArea() {
    const r = this.into.getBoundingClientRect();
    return {
      x: 0,
      y: 0,
      w: Math.round(r.width),
      h: Math.max(1, Math.round(r.height) - this.reserved),
    };
  }

  /** Subscribe to "the window table changed". Returns the watcher, so a caller can keep it. */
  watch(fn) {
    if (typeof fn === "function") this.watchers.push(fn);
    return fn;
  }

  /** Tell the watchers, naming what happened. A THROW IN ONE WATCHER MUST NOT STOP THE OTHERS or
   *  the rest of this message's handling — the shell is a renderer and the window table is the
   *  product. */
  #changed(why) {
    for (const fn of this.watchers) {
      try {
        fn(why, this);
      } catch (error) {
        this.stats.watcherFaults += 1;
        this.lastWatcherFault = `${why}: ${error && error.message}`;
      }
    }
  }

  /**
   * Re-clamp every frame against the desktop as it is NOW, and tell the kernel what each settled
   * on. Returns how many frames moved.
   *
   * IT REPORTS, which is the half that is easy to leave out: a re-clamp the kernel is not told
   * about leaves `/proc` and the blur governor accounting a box nobody renders — the ~17× under-read
   * constraint 49 exists to forbid, arrived at from the other direction.
   */
  relayout(why = "") {
    // COUNTED, NOT SILENT: "the re-clamp was skipped" and "there was nothing to re-clamp" are
    // different facts, and a control that cannot be seen to have taken effect is a control nobody
    // can tell from a green run over an unmodified world.
    if (hostControls.noRelayout) {
      this.skippedRelayouts += 1;
      return 0;
    }
    this.relayouts += 1;
    let moved = 0;
    for (const entry of this.frames.values()) {
      const before = { ...entry.win.placed };
      entry.win.apply();
      const after = entry.win.placed;
      if (before.x !== after.x || before.y !== after.y
        || before.w !== after.w || before.h !== after.h) moved += 1;
      this.#report(entry);
    }
    this.lastRelayout = { why: String(why), moved, frames: this.frames.size };
    return moved;
  }

  /** Stop watching the desktop. A page that boots a second kernel builds a second host over the
   *  same element, and an observer nobody disconnected keeps re-clamping frames for a kernel that
   *  is gone. */
  dispose() {
    if (this.observer) this.observer.disconnect();
    this.observer = null;
  }

  /** Every kernel message this host owns. Returns true if it handled it, so a page can keep its
   *  own `expect` for the rest. */
  handle(m) {
    if (m.t === "win-create") { this.#create(m); return true; }
    if (m.t === "win-out") { this.#out(m); return true; }
    if (m.t === "win-destroy") { this.#destroy(m); return true; }
    if (m.t === "win-title") { this.#title(m); return true; }
    if (m.t === "win-box") { this.#box(m); return true; }
    if (m.t === "win-health") { this.#health(m); return true; }
    if (m.t === "win-surface") { this.#surface(m); return true; }
    if (m.t === "win-draw") { this.#draw(m); return true; }
    if (m.t === "win-blur") { this.#blur(m); return true; }
    // M14. The three the shell renders: a show state, a role, and a window's published rows.
    if (m.t === "win-show") { this.#show(m); return true; }
    if (m.t === "win-role") { this.#role(m); return true; }
    if (m.t === "win-items") { this.#items(m); return true; }
    if (m.t === "win-stack") { this.#stack(m); return true; }
    if (m.t === "win-blocked") { this.#blocked(m); return true; }
    if (m.t === "win-modal") { this.#modal(m); return true; }
    // M10. The drag session, as the kernel decided it: it began, the target changed, it ended.
    if (m.t === "win-drag") { this.#dragBegan(m); return true; }
    if (m.t === "win-drag-target") { this.#dragTarget(m); return true; }
    if (m.t === "win-drag-end") { this.#dragEnded(m); return true; }
    if (m.t === "clipboard") {
      this.clipboard = { obj: m.obj | 0, formats: (m.formats || []).map(Number) };
      this.stats.copies += 1;
      return true;
    }
    if (m.t === "win-fed") {
      this.fed.offered += m.offered | 0;
      this.fed.queued += m.queued | 0;
      if (m.window) this.stats.dropped = m.window.dropped | 0;
      return true;
    }
    return false;
  }

  get(id) {
    return this.frames.get(id | 0) || null;
  }

  /**
   * ASK A WINDOW TO CLOSE. The X button's route and a jump list's "Close window" row, which is why
   * it is a method: the second caller is what justifies the name.
   *
   * IT ASKS AND DOES NOT ACT (constraint 44): `WEV_CLOSE` is posted and nothing else — no
   * `win-gone` — so the frame stays until the window's own process calls `win_destroy`. A shell
   * that could close a window would be a way around the close contract, and the unsaved work that
   * contract exists for.
   */
  requestClose(id) {
    this.stats.closes += 1;
    this.post({ t: "win-in", win: id | 0, evs: [{ type: WEV_CLOSE }] });
    return true;
  }

  /** The widget of the newest live window, which is what a page wants to focus. */
  newest() {
    let best = null;
    for (const entry of this.frames.values()) if (!best || entry.id > best.id) best = entry;
    return best;
  }

  #create(m) {
    const id = m.win | 0;
    if (this.frames.has(id)) { this.stats.unknown += 1; return; }
    const win = new Win({
      id: `win-${id}`,
      title: m.title || `window ${id}`,
      into: this.into,
      x: m.x, y: m.y, w: m.w, h: m.h,
      /* M14. THE CAPTION BUTTONS AND THE SNAP GESTURE ASK, and this is the one route: the kernel
       * owns the show state, so a frame that minimized itself would be a second authority on what
       * is on screen. `win-show` comes back and `Win.setState` renders it. */
      onState: (state) => this.askState(id, state),
      /* AND THE WORK AREA IS A CALLBACK, not a value: the shell may take a strip off the desktop
       * at any moment, and a frame laid out against a stale work area is a maximized window
       * covering the taskbar. */
      workArea: () => this.workArea(),
      /* THE X BUTTON ASKS AND DOES NOT ACT, which is M9 and constraint 44: "a close MUST be a
       * request the owner can refuse... without a close-request event, unsaved work is discarded
       * silently". It posts WEV_CLOSE and NOTHING ELSE — no `win-gone` — so the frame stays until
       * the window's own process calls `win_destroy`.
       *
       * A PROCESS THAT IGNORES IT IS NOT A TRAP, and that falls out of M7 rather than needing
       * anything new: the close event sits uncollected, the not-responding detector's clock starts,
       * the caption greys at 1,000 ms and End Process appears at 5,000 ms. The user's escape hatch
       * is the one that was already there. */
      onClose: () => {
        this.requestClose(id);
        return false;
      },
      /* AND THAT ESCAPE HATCH KILLS THE PROCESS, not the frame. Removing the frame would leave the
       * process running with a window it still thinks it has; the kernel's own end-process path
       * reaps it, teardown closes its fds, and the window goes with them (constraint 14). */
      onEndProcess: () => {
        win.el.dataset.endPressed = "1";
        this.post({ t: "end-process", pid: entry.pid });
      },
    });
    const term = new Terminal({
      into: win.bodyEl,
      onKeys: (bytes, event) => this.#keys(id, bytes, event),
    });
    // `surface` is null until the process asks for one, and `term` becomes null when it does.
    // Exactly one of the two is set; see `#surface`.
    const entry = {
      id, win, term, surface: null, pid: m.pid | 0, owner: m.owner | 0, health: [],
      // M14. What the shell needs about this window, as the KERNEL last said it: its show state,
      // its role, the rows it published, and the program behind it — which is what a Superbar
      // groups buttons by. `prog` comes from the kernel's own `win-create`, because the page has
      // no way to learn what a pid is running.
      state: WST_NORMAL, role: WROLE_NORMAL, items: [], icons: null,
      prog: String(m.prog || ""),
    };
    this.frames.set(id, entry);
    /* NOT FLAT UNTIL THE KERNEL SAYS SO, and the flag is WRITTEN rather than left absent: "this
     * window is on glass" and "nobody has said" look identical in the DOM otherwise, which is the
     * reason `src/wm/window.mjs` builds its hidden buttons rather than omitting them.
     *
     * A frame cannot be born INTO the flat set. Winids are monotonic and the kernel posts
     * `win-create` before the `win-blur` that `governBlur` produces, so this id is never in the
     * set that is current here — an earlier version toggled the class against that stale set,
     * which could only ever be a no-op. The `win-blur` arriving next is what degrades it. */
    win.el.dataset.flat = "0";
    // THE CAPTION'S ICON, from the program the KERNEL named: the page cannot learn what a pid is
    // running, which is why `win-create` carries `prog` at all.
    if (entry.prog) win.setIconMarkup(iconMarkup(iconForProgram(entry.prog), 16));
    this.created.push({ win: id, pid: m.pid | 0, owner: m.owner | 0, title: m.title,
      prog: entry.prog });
    this.stats.creates += 1;
    // The box the CLAMP settled on, reported straight back: the kernel asked for a geometry and
    // records only what the page actually did with it.
    this.#report(entry);
    // Focus follows creation, which is what a user expects of a window that just opened and is what
    // lets a check type into the newest one without hunting for it.
    term.focus();
    /* A CLICK ANYWHERE IN THE FRAME ASKS THE KERNEL TO RAISE IT, and the kernel decides — it is the
     * only side that knows whether a modal blocks it (constraint 226). `pointerdown` in the
     * CAPTURE phase, so a click on the close box or inside a surface asks too: a user who clicks a
     * buried window expects it to come up whatever they hit. */
    win.el.addEventListener("pointerdown", () => {
      this.stats.raiseAsks += 1;
      this.post({ t: "win-raise", win: id });
    }, true);
    // Drag and arrow-key moves both end in `apply()`, so one listener per frame covers both.
    win.el.addEventListener("pointerup", () => this.#report(entry));
    win.barEl.addEventListener("keyup", () => this.#report(entry));
    // Focus is an EVENT and not a query, because the process that wants it is asleep in `poll`.
    term.el.addEventListener("focus", () => this.#focus(id, 1));
    term.el.addEventListener("blur", () => this.#focus(id, 0));
    // M14. The shell learns of the window here, and of its title and death below: a taskbar button
    // that appeared a message late would be a button for a window that is already gone.
    this.#changed("create");
    return entry;
  }

  #keys(id, bytes, event) {
    const entry = this.get(id);
    if (!entry) return;
    this.stats.keys += 1;
    let mods = 0;
    if (event) {
      if (event.shiftKey) mods |= WMOD_SHIFT;
      if (event.ctrlKey) mods |= WMOD_CTRL;
      if (event.altKey) mods |= WMOD_ALT;
    }
    // ONE RECORD PER KEY, with its UTF-8 bytes inline: a key that needed a second read to collect
    // its payload would be a second readiness edge for one press.
    this.post({ t: "win-in", win: id, evs: [{ type: WEV_KEY, mods, ...packKeyBytes(bytes) }] });
  }

  #focus(id, inward) {
    if (!this.frames.has(id)) return;
    this.stats.focus += 1;
    this.post({ t: "win-in", win: id, evs: [{ type: WEV_FOCUS, a: inward }] });
  }

  #out(m) {
    const entry = this.get(m.win | 0);
    if (!entry) { this.stats.unknown += 1; return; }
    const bytes = m.bytes instanceof Uint8Array ? m.bytes : new Uint8Array(m.bytes || 0);
    this.stats.cells += bytes.length;
    // A SURFACED WINDOW HAS NO TEXT WIDGET, so there is nowhere for cells to go. The kernel
    // refuses `write` on one (see `src/kernel/files.mjs`), so arriving here means the two sides
    // disagree — counted rather than dropped, because silent loss is the one failure a user
    // cannot diagnose.
    if (!entry.term) { this.stats.unknown += 1; return; }
    entry.term.write(bytes);
  }

  /**
   * THE WINDOW CHANGES CONTENT MODE, once, and this is the only place it happens. A window is a
   * TEXT window until its process asks for a surface, and a surface window afterwards: the text
   * widget goes, a canvas takes its place, and `write(2)` on the fd is refused from then on.
   *
   * One content mode per window, because two renderers for one window's inside is two places the
   * same pixel can come from — and a program that wanted both would be asking for a compositor it
   * does not have.
   */
  #surface(m) {
    const entry = this.get(m.win | 0);
    if (!entry) { this.stats.unknown += 1; return; }
    if (entry.surface) {
      // A RESIZE, which the kernel has already accounted. The old canvas goes rather than being
      // resized in place: a canvas's `width` assignment clears it anyway, so keeping it would
      // only hide that the pixels are gone.
      entry.surface.destroy();
      entry.surface = null;
    }
    if (entry.term) {
      /* THE WIDGET'S KEY COUNTS ARE RETIRED, NOT LOST. `keyCounts()` skips an entry whose `term`
       * is null, so a window that printed a banner, took a keystroke and then surfaced used to
       * drop that keystroke out of both the live sum and the retired one — and the trusted count
       * is what every real-key clause in this suite asserts on. */
      this.retired.trusted += entry.term.trustedKeys;
      this.retired.synthetic += entry.term.synthKeys;
      entry.term.el.remove();
      entry.term = null;
    }
    entry.surface = new Surface({
      into: entry.win.bodyEl, w: m.w, h: m.h, label: entry.win.titleText,
    });
    this.stats.surfaces += 1;
    this.#wirePointer(entry);
    entry.surface.el.focus();
  }

  #draw(m) {
    const entry = this.get(m.win | 0);
    if (!entry) { this.stats.unknown += 1; return; }
    if (!entry.surface) { this.stats.unknown += 1; return; }
    const bytes = m.ops instanceof Uint8Array ? m.ops : new Uint8Array(m.ops || 0);
    this.stats.batches += 1;
    this.stats.ops += entry.surface.replay(bytes);
  }

  /**
   * Pointer events, in SURFACE pixels, as window events on the window's own fd.
   *
   * A MOVE IS SENT ONLY WHILE A BUTTON IS DOWN. A hover would be one event per pointermove — and
   * `WIN_EVENT_CAP` is 256 records (constraint 213), so a second of hovering would overflow a
   * queue the process is being asked to drain. A program that needs hover can ask for it when
   * there is a program that needs hover.
   */
  #wirePointer(entry) {
    const send = (flags, event) => {
      if (!entry.surface) return;
      const at = entry.surface.pointAt(event);
      if (!at) return;
      let mods = flags;
      if (event.shiftKey) mods |= WMOD_SHIFT;
      if (event.ctrlKey) mods |= WMOD_CTRL;
      if (event.altKey) mods |= WMOD_ALT;
      this.stats.pointers += 1;
      this.post({
        t: "win-in",
        win: entry.id,
        evs: [{ type: WEV_POINTER, mods, a: at.x, b: at.y, c: event.buttons | 0 }],
      });
    };
    const el = entry.surface.el;
    el.addEventListener("pointerdown", (e) => {
      // The capture is what makes a drag that leaves the canvas keep arriving, and it may THROW
      // for a pointerId no live pointer owns — Firefox does, Chrome does not (constraint 175). A
      // throw here would leave the surface dead to the mouse and silent.
      try {
        el.setPointerCapture(e.pointerId);
      } catch (error) {
        this.stats.unknown += 1;
      }
      el.focus();
      send(WPTR_DOWN, e);
    });
    el.addEventListener("pointermove", (e) => {
      if (!e.buttons) return;
      send(WPTR_MOVE, e);
      // M10. THE SAME CAPTURE CARRIES THE DRAG. `setPointerCapture` above is what makes a move
      // that left the canvas keep arriving, which is exactly what a drag across the desktop needs
      // — so there is no second capture and no page-wide listener.
      this.#dragMove(entry, e);
    });
    el.addEventListener("pointerup", (e) => {
      // THE UP GOES FIRST, so the kernel's record of the pointer is down=false before the drop is
      // reported: the next drag must need a new press (constraint 244).
      send(WPTR_UP, e);
      this.#dragRelease(entry, e);
    });
    // A cancelled pointer is an UP as far as a program is concerned: a drag the browser took away
    // must not leave a program drawing for ever.
    el.addEventListener("pointercancel", (e) => {
      send(WPTR_UP, e);
      // AND IT ENDS THE DRAG AS A RELEASE OVER NOTHING. A cancelled pointer is a gesture the
      // browser took away, so reporting it as a drop wherever the pointer happened to be would
      // deliver a payload the user never let go of.
      this.#dragRelease(entry, e, true);
    });
    // A surface takes the keyboard too, through the same path a terminal's keys take.
    el.addEventListener("keydown", (e) => {
      const bytes = bytesForKey(e);
      if (!bytes) return;
      e.preventDefault();
      /* COUNTED HERE, because the widget that counts them is gone. A synthesised `KeyboardEvent`
       * exercises this handler and nothing in front of it, and `isTrusted` is the only way to tell
       * the two apart — which is what M4a's whole lesson rests on. Without this a surfaced window
       * could satisfy a "real keystroke" clause with a key the page dispatched to itself. */
      if (e.isTrusted) this.retired.trusted += 1; else this.retired.synthetic += 1;
      this.#keys(entry.id, bytes, e);
    });
    /* AND FOCUS, WHICH A SURFACE STOPPED EMITTING. The focus and blur listeners were the TERMINAL
     * widget's, and `#surface` removes it — so a surfaced window never reported another focus
     * change for the rest of its life, and a program that dimmed a caret on blur never recovered.
     * `src/abi.mjs` calls focus "an EVENT and not a query, because the process that wants it is
     * asleep in `poll`"; for a surface it was neither. */
    el.addEventListener("focus", () => this.#focus(entry.id, 1));
    el.addEventListener("blur", () => this.#focus(entry.id, 0));
  }

  #destroy(m) {
    const ids = Array.isArray(m.ids) ? m.ids : [];
    // IN REVERSE, so a child's frame goes before its parent's: the other order leaves a dialog on
    // screen over a desktop whose window has gone, which is the picture constraint 179 forbids.
    for (const id of [...ids].reverse()) {
      const entry = this.get(id);
      if (!entry) continue;
      if (entry.term) {
        this.retired.trusted += entry.term.trustedKeys;
        this.retired.synthetic += entry.term.synthKeys;
      }
      if (entry.surface) entry.surface.destroy();
      // M14. The desktop's icon view goes with its window, like a surface: it holds listeners on
      // an element that is about to be removed and a selection of rows that no longer exist.
      if (entry.icons) entry.icons.destroy();
      entry.win.destroy();
      this.frames.delete(id);
      this.destroyed.push(id);
      this.stats.destroys += 1;
    }
    this.#changed("destroy");
  }

  #title(m) {
    const entry = this.get(m.win | 0);
    if (!entry) { this.stats.unknown += 1; return; }
    entry.win.setTitle(m.title || "");
    this.#changed("title");
  }

  #box(m) {
    const entry = this.get(m.win | 0);
    if (!entry) { this.stats.unknown += 1; return; }
    entry.win.box = { x: m.x | 0, y: m.y | 0, w: m.w | 0, h: m.h | 0 };
    entry.win.apply();
    this.#report(entry);
  }

  #health(m) {
    const entry = this.get(m.win | 0);
    if (!entry) { this.stats.unknown += 1; return; }
    entry.health.push({ level: m.level, staleMs: m.staleMs });
    // THE KERNEL DECIDES AND THE WINDOW DISPLAYS. The page does not compute the condition: that is
    // `src/kernel/wins.mjs`'s job, because it is the side that can see the queue.
    entry.win.setHealth(m.level);
  }

  /** Tell the kernel the box and the CELL COUNT the frame settled on. The cell count is the page's
   *  to compute — it is the side with the font — and it is what a terminal needs for TIOCSWINSZ. */
  #report(entry) {
    // THE BOX THE CLAMP SETTLED ON, which is the whole contract. `staleGeom` reports the REQUESTED
    // one instead, so the kernel believes a geometry no frame ever had (see `setHostControls`).
    const placed = hostControls.staleGeom ? entry.win.box : entry.win.placed;
    const body = entry.win.bodyEl.getBoundingClientRect();
    this.stats.geoms += 1;
    this.post({
      t: "win-geom",
      win: entry.id,
      x: placed.x, y: placed.y, w: placed.w, h: placed.h,
      cols: Math.max(1, Math.floor(body.width / this.cell.w)),
      rows: Math.max(1, Math.floor(body.height / this.cell.h)),
    });
  }

  /** What is on every screen, for a check that wants to read a window's text back. */
  screens() {
    const out = {};
    for (const [id, entry] of this.frames) {
      out[id] = entry.term ? entry.term.screen() : null;
    }
    return out;
  }


  /**
   * THE KERNEL'S ORDER, APPLIED. `z-index` from the position in the list, so the DOM's own
   * insertion order stops mattering — and the page never decides what is on top, because only the
   * kernel knows what a modal is blocking.
   */
  #stack(m) {
    const ids = Array.isArray(m.ids) ? m.ids : [];
    this.order = [...ids];
    this.stats.stacks += 1;
    // WHICH WINDOWS ARE BLOCKED TRAVELS WITH THE ORDER, so the page never computes it: suppression
    // has to reach the frame's own chrome, which is drag and arrow-key moves, and those are
    // page-side from end to end (constraint 233).
    this.blockedSet = new Set((Array.isArray(m.blocked) ? m.blocked : []).map((id) => id | 0));
    this.#changed("stack");
    ids.forEach((id, at) => {
      const entry = this.get(id);
      if (!entry) return;
      // From 1, so a frame the kernel does not know about (there should be none) is visibly
      // behind every frame it does.
      entry.win.el.style.zIndex = String(at + 1);
      entry.win.el.dataset.depth = String(at);
    });
    this.#applyBlocked();
  }

  /**
   * Write the kernel's blocked set onto the frames.
   *
   * CALLED FROM TWO PLACES because the facts arrive in two messages and in this order: `win_set`
   * re-evaluates the stack, so `win-stack` is posted BEFORE the `win-modal` that says what the
   * window became. Applying only on the order would read a stale mode and never offer the
   * system-modal escape hatch.
   */
  #applyBlocked() {
    const blocked = this.blockedSet || new Set();
    for (const [id, entry] of this.frames) {
      entry.win.setBlocked({
        blocked: blocked.has(id),
        systemModal: entry.mode === WMODE_BLOCKING && entry.scope === WMODAL_SYSTEM,
      });
    }
  }

  /**
   * M12. The governor took glass from some windows, or gave it back.
   *
   * THE WHOLE SET AND NOT A DELTA, which is why this assigns rather than toggles: a page applying
   * a delta can come to disagree with the kernel about the current state and nothing would say so
   * — the same reason `win-stack` carries the whole order (constraint 226).
   */
  #blur(m) {
    this.flatSet = new Set((Array.isArray(m.flat) ? m.flat : []).map((id) => id | 0));
    this.lastBlur = {
      blurPx: m.blurPx | 0, budget: m.budget | 0, restore: m.restore | 0,
      why: String(m.why || ""), flat: [...this.flatSet],
    };
    this.stats.blurs += 1;
    this.stats.flat = this.flatSet.size;
    for (const [id, entry] of this.frames) {
      const on = this.flatSet.has(id);
      // The CLASS is the look and the DATASET is the fact, which is `setBlocked`'s division: a
      // check reads the flag and a reader sees the fill.
      entry.win.el.classList.toggle("is-flat", on);
      entry.win.el.dataset.flat = on ? "1" : "0";
    }
  }

  /* ---- M14: the three things a shell renders ------------------------------------------------- */

  /**
   * The kernel changed a window's SHOW STATE. The frame follows, and the box it settled on is
   * reported back.
   *
   * THE REPORT IS THE HALF THAT MATTERS BEYOND THE PIXELS: a maximize is an area-changing event,
   * and constraint 49's admission controller sees it exactly because the page says what geometry
   * it settled on — the same route a drag takes. A minimized frame is NOT reported, because its
   * client area is 0x0 while hidden and a cell grid of zero would be a lie about a terminal that
   * is still perfectly alive; the kernel already knows the state, and `blurCost` charges it
   * nothing.
   */
  #show(m) {
    const entry = this.get(m.win | 0);
    if (!entry) { this.stats.unknown += 1; return; }
    this.stats.shows += 1;
    entry.state = m.state | 0;
    entry.win.setState(m.state | 0, m.restore || null);
    if (entry.state !== WST_MIN) this.#report(entry);
    this.#changed("show");
  }

  /** The kernel changed a window's ROLE. A desktop window loses its frame and takes the work
   *  area; what goes INSIDE it is the shell's business, which is why this only renders the frame
   *  and then tells the watchers. */
  #role(m) {
    const entry = this.get(m.win | 0);
    if (!entry) { this.stats.unknown += 1; return; }
    this.stats.roles += 1;
    entry.role = m.role | 0;
    entry.win.setRole(m.role | 0);
    /**
     * BECOMING THE DESKTOP CHANGES WHAT IS INSIDE THE WINDOW, which is `#surface`'s rule for a
     * second case: a window is a TEXT window, a SURFACE window, or the DESKTOP, and exactly one of
     * the three renderers is live. The terminal widget goes the way it goes for a surface — with
     * its key counts retired rather than lost — because a desktop that kept a hidden text widget
     * would have two things able to take the keyboard.
     */
    if (entry.role === WROLE_DESKTOP && !entry.icons) {
      if (entry.term) {
        this.retired.trusted += entry.term.trustedKeys;
        this.retired.synthetic += entry.term.synthKeys;
        entry.term.el.remove();
        entry.term = null;
      }
      if (entry.surface) {
        entry.surface.destroy();
        entry.surface = null;
      }
      entry.icons = new IconView({ into: entry.win.bodyEl, host: this, win: entry.id });
      entry.icons.setItems(entry.items);
      this.stats.iconViews += 1;
    }
    this.#report(entry);
    this.#changed("role");
  }

  /** A window published its rows. STORED AND NOT DRAWN HERE: this file owns frames, and where a
   *  row appears — the desktop, the start menu, a jump list — is the shell's reading of the flags
   *  on it. */
  #items(m) {
    const entry = this.get(m.win | 0);
    if (!entry) { this.stats.unknown += 1; return; }
    this.stats.itemLists += 1;
    entry.items = (Array.isArray(m.items) ? m.items : []).map((row) => ({
      icon: row.icon | 0, flags: row.flags | 0, label: String(row.label || ""),
    }));
    // AND THE DESKTOP REDRAWS AT ONCE. Every other rendering of these rows is a menu that reads
    // them when it opens; the icons are on screen already.
    if (entry.icons) entry.icons.setItems(entry.items);
    this.#changed("items");
  }

  /**
   * The shell says one of a window's rows was activated. Reported, never acted on.
   *
   * `where` is the `WITEM_*` bit saying which rendering it came from, because a row on the desktop
   * and the same row in a jump list are the same row and a program may care which was clicked.
   * The kernel validates the index against the list it holds — a page cannot name a row nothing
   * published.
   */
  activateItem(win, index, where) {
    this.stats.itemAsks += 1;
    this.post({ t: "win-item-ask", win: win | 0, index: index | 0, where: where | 0 });
  }

  /** Ask the kernel for a show state. The one route a shell has, and the same shape as
   *  `win-raise`: the page says what the user did and the kernel decides. */
  askState(win, state) {
    this.post({ t: "win-show-ask", win: win | 0, state: state | 0 });
  }

  /** A raise the kernel refused, with the window that refused it. FLASHED AND NOT SWALLOWED: a
   *  click that does nothing reads as a broken window, and the modal is where the user has to go. */
  #blocked(m) {
    this.stats.blocked += 1;
    this.lastBlocked = { win: m.win | 0, by: m.by | 0 };
    const blocker = this.get(m.by | 0);
    if (!blocker) return;
    blocker.win.el.dataset.blocking = "1";
    // The class is removed on the next frame, so a check reading the DOM sees the state and a
    // person sees a flash. `requestAnimationFrame` and not a timer: one frame is the shortest
    // thing a person can see and the longest a check should have to wait.
    blocker.win.el.classList.add("is-blocking");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => blocker.win.el.classList.remove("is-blocking"));
    });
  }

  /** A window's modality changed. Recorded on the frame so a check can read it out of the DOM,
   *  which is the only place a reader can see it. */
  #modal(m) {
    const entry = this.get(m.win | 0);
    if (!entry) { this.stats.unknown += 1; return; }
    entry.scope = m.scope | 0;
    entry.mode = m.mode | 0;
    entry.win.el.dataset.modalScope = String(m.scope | 0);
    entry.win.el.dataset.windowMode = String(m.mode | 0);
    this.#applyBlocked();
  }

  /* ---- M10: the drag gesture, which is the page's half of it ---------------------------------
   *
   * THE DIVISION IS M9's, APPLIED TO A SECOND GESTURE. The page has the DOM, so it is the only
   * side that can hit-test a pointer against a frame; the kernel has the window table, so it is the
   * only side that knows a window is blocked, what the payload is, and who may receive it. So this
   * file reports WHERE and renders WHAT IT IS TOLD, and `src/kernel/dataobj.mjs` decides
   * (constraints 226, 243).
   */

  /** The frame under a point, TOP FIRST IN THE KERNEL'S OWN ORDER — not the DOM's, because the DOM
   *  order is only what `#stack` did with the order it was handed. The CLIENT AREA and not the
   *  frame: a title bar is not a drop area. */
  #frameAt(clientX, clientY) {
    for (let i = this.order.length - 1; i >= 0; i -= 1) {
      const entry = this.get(this.order[i]);
      if (!entry) continue;
      const r = entry.win.bodyEl.getBoundingClientRect();
      if (clientX >= r.left && clientX < r.right && clientY >= r.top && clientY < r.bottom) {
        return entry;
      }
    }
    return null;
  }

  /**
   * Where a drop landed INSIDE a window, in that window's own unit: SURFACE PIXELS for a surfaced
   * window and CHARACTER CELLS for a text one.
   *
   * ONE FUNCTION, because those are the two units this ABI already has — `WEV_POINTER` is surface
   * pixels and `WEV_RESIZE` is cells — and a third would be a coordinate system no program asked
   * for. A program's own inside is the only frame of reference it has (constraint 248).
   */
  #dropPointAt(entry, event) {
    if (entry.surface) return entry.surface.pointAt(event) || { x: 0, y: 0 };
    const r = entry.win.bodyEl.getBoundingClientRect();
    return {
      x: Math.floor((event.clientX - r.left) / this.cell.w),
      y: Math.floor((event.clientY - r.top) / this.cell.h),
    };
  }

  /** The kernel accepted a `dataobj_offer(DOBJ_WHERE_DRAG)`: a gesture is live. The drag image is
   *  the page's, because a cursor is a picture and the kernel owns no pixels. */
  #dragBegan(m) {
    this.drag = {
      win: m.win | 0, obj: m.obj | 0, offer: m.offer | 0,
      formats: (m.formats || []).map(Number), effects: m.effects | 0,
    };
    this.stats.drags += 1;
    if (!this.dragEl) {
      this.dragEl = document.createElement("div");
      this.dragEl.className = "drag-image";
      this.dragEl.dataset.dragImage = "1";
      // POSITION IS BEHAVIOUR AND LOOK IS THE PAGE'S: the geometry is set here because this file
      // is what follows the pointer, and `pointer-events:none` is load-bearing rather than
      // decorative — a drag image that swallowed the pointer would hit-test as the target.
      this.dragEl.style.position = "fixed";
      this.dragEl.style.pointerEvents = "none";
      this.dragEl.style.zIndex = "9999";
      document.body.append(this.dragEl);
    }
    this.dragEl.textContent = `obj ${this.drag.obj}`;
    this.dragEl.hidden = false;
  }

  /** The kernel says the target changed. A window the kernel REFUSED as a target — blocked, or
   *  gone — arrives here as 0, which is why this is rendered rather than computed. */
  #dragTarget(m) {
    this.dragTarget = m.win | 0;
    this.stats.dragTargets += 1;
    for (const [id, entry] of this.frames) {
      if (id === this.dragTarget) entry.win.el.dataset.dropTarget = "1";
      else delete entry.win.el.dataset.dropTarget;
    }
  }

  #dragEnded(m) {
    this.lastDrag = { effect: m.effect | 0, target: m.target | 0, why: String(m.why || "") };
    this.drag = null;
    this.dragTarget = 0;
    for (const entry of this.frames.values()) delete entry.win.el.dataset.dropTarget;
    if (this.dragEl) this.dragEl.hidden = true;
  }

  /** One pointer report per motion sample. The kernel answers nothing unless the target changed. */
  #dragMove(entry, event) {
    if (!this.drag || this.drag.win !== entry.id) return;
    if (this.dragEl) {
      this.dragEl.style.left = `${event.clientX + 12}px`;
      this.dragEl.style.top = `${event.clientY + 12}px`;
    }
    const over = this.#frameAt(event.clientX, event.clientY);
    const at = over ? this.#dropPointAt(over, event) : { x: 0, y: 0 };
    this.stats.dragAts += 1;
    this.post({ t: "drag-at", win: over ? over.id : 0, x: at.x, y: at.y });
  }

  /** The pointer was released. `cancelled` reports it over NOTHING, because a gesture the browser
   *  took away is not a drop the user made. */
  #dragRelease(entry, event, cancelled = false) {
    if (!this.drag || this.drag.win !== entry.id) return;
    const over = cancelled ? null : this.#frameAt(event.clientX, event.clientY);
    const at = over ? this.#dropPointAt(over, event) : { x: 0, y: 0 };
    this.stats.dragDrops += 1;
    this.post({ t: "drag-drop", win: over ? over.id : 0, x: at.x, y: at.y });
  }

  /** Every surface's own report, keyed by winid. What a check reads to ask how many ops the page
   *  actually replayed — as against how many the process sent, which is the kernel's count. */
  surfaces() {
    const out = {};
    for (const [id, entry] of this.frames) {
      if (entry.surface) out[id] = entry.surface.report();
    }
    return out;
  }

  /** The widget's own key counts, summed. A SYNTHESISED KeyboardEvent exercises the handler and
   *  nothing in front of it, so a check that asserts a real key press must assert on `trusted`. */
  keyCounts() {
    let trusted = this.retired.trusted;
    let synthetic = this.retired.synthetic;
    for (const entry of this.frames.values()) {
      if (!entry.term) continue;
      trusted += entry.term.trustedKeys;
      synthetic += entry.term.synthKeys;
    }
    return { trusted, synthetic };
  }

  report() {
    return {
      ...this.stats,
      keyCounts: this.keyCounts(),
      order: [...this.order],
      lastBlocked: this.lastBlocked,
      // The blocked set as the KERNEL sent it, and as the FRAMES now carry it. Two readings of one
      // fact on purpose: the second is what a drag actually consults, so a check that read only the
      // first would pass against a frame this file never marked.
      blocked: [...this.blockedSet],
      frameBlocked: [...this.frames].filter(([, e]) => e.win.blocked).map(([id]) => id),
      endOffered: [...this.frames].filter(([, e]) => !e.win.endBtn.hidden).map(([id]) => id),
      // What the DOM actually has, so a check can compare the kernel's order against the page's
      // rendering of it rather than trusting that this file applied it.
      zIndex: Object.fromEntries([...this.frames].map(
        ([id, e]) => [id, Number(e.win.el.style.zIndex || 0)])),
      cell: this.cell,
      // M14. What the shell is working from: the reserved strip, the work area it leaves, and the
      // show state, role, program and row count of every live frame — the kernel's facts as this
      // file is rendering them, which is the second reading `frameBlocked` exists for.
      reserved: this.reserved,
      workArea: this.workArea(),
      shell: Object.fromEntries([...this.frames].map(([id, e]) => [id, {
        state: e.state, role: e.role, prog: e.prog, items: e.items.length,
        hidden: e.win.el.hidden === true,
        frameState: Number(e.win.el.dataset.state || 0),
        armed: Number(e.win.el.dataset.armed || 0),
      }])),
      lastWatcherFault: this.lastWatcherFault || null,
      icons: Object.fromEntries([...this.frames]
        .filter(([, e]) => e.icons)
        .map(([id, e]) => [id, e.icons.report()])),
      // M13. The desktop-resize re-clamp: how many times it ran, and what the last one moved.
      relayouts: this.relayouts,
      skippedRelayouts: this.skippedRelayouts,
      lastRelayout: this.lastRelayout || null,
      // The CONTROLS in force, read back out of the module that owns them rather than from the
      // page's own query parsing: a control a check believed was on and was not is a green run
      // over an unmodified world.
      controls: { ...hostControls, ...geometryControlsInForce() },
      // M10. The drag as the kernel announced it, the target as this file RENDERED it, and the
      // end it reported. Two readings of the target on purpose, for `frameBlocked`'s reason: the
      // second is what a reader actually sees.
      drag: this.drag ? { ...this.drag } : null,
      dragTarget: this.dragTarget,
      frameDropTarget: [...this.frames]
        .filter(([, e]) => e.win.el.dataset.dropTarget === "1").map(([id]) => id),
      lastDrag: this.lastDrag,
      clipboard: this.clipboard,
      // M12. The kernel's flat set, and what the FRAMES now carry — two readings of one fact on
      // purpose, `frameBlocked`'s reason: the second is what a reader actually sees.
      flatSet: [...this.flatSet],
      frameFlat: [...this.frames].filter(([, e]) => e.win.el.dataset.flat === "1").map(([id]) => id),
      lastBlur: this.lastBlur,
      dragImage: this.dragEl ? !this.dragEl.hidden : false,
      live: [...this.frames.keys()],
      created: this.created,
      destroyed: this.destroyed,
      fed: { ...this.fed },
    };
  }
}
