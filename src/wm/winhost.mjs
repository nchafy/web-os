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
//   browser wheel         -> win-in with a WEV_WHEEL record, in the WINDOW's unit
//   browser drag/resize   -> win-geom with the box the clamp settled on

import { Win, geometryControlsInForce } from "./window.mjs";
// `bytesForKey` is the TERMINAL's key translation, reused for a surface rather than written
// again: a Ctrl-C is 0x03 whatever is inside the window (constraint 161's file is where it lives).
import { Terminal, bytesForKey } from "./terminal.mjs";
import { Surface, surfaceControlsInForce } from "./surface.mjs";
// A CAPTION'S ICON IS THE SHELL'S ANSWER TO "which program is this", and the same answer a taskbar
// button uses — one table, in the module that owns the drawings.
import { iconMarkup, iconForProgram } from "./icons.mjs";
// M14's THIRD CONTENT MODE. A window is text, pixels, or ITEMS — and which one is decided by the
// window's ROLE rather than by a call, because the desktop is the only window whose inside is a
// set of rows the shell draws. See `#role`.
import { IconView } from "./desktop.mjs";
import {
  WEV_KEY, WEV_CLOSE, WEV_FOCUS, WEV_POINTER, WMOD_SHIFT, WMOD_CTRL, WMOD_ALT, WMOD_META,
  WPTR_DOWN, WPTR_UP, WPTR_MOVE, WPTR_CLICK2, WPTR_CLICK3, WPTR_LEAVE, packKeyBytes,
  // M19. The cursor's CSS keyword comes from the ABI, indexed by the `WCUR_*` the kernel sent. A
  // keyword list in this file would be a second table beside an enum the kernel enforces, and the
  // page renders what it was sent (constraint 226).
  WCUR_DEFAULT, WCUR_CSS,
  WKEY_LEFT, WKEY_RIGHT, WKEY_UP, WKEY_DOWN, WKEY_HOME, WKEY_END,
  WKEY_PAGE_UP, WKEY_PAGE_DOWN, WKEY_DELETE, WKEY_INSERT, WKEY_MENU,
  WKEY_F1, WKEY_F2, WKEY_F3, WKEY_F4, WKEY_F5, WKEY_F6,
  WKEY_F7, WKEY_F8, WKEY_F9, WKEY_F10, WKEY_F11, WKEY_F12,
  WEV_WHEEL, WWHEEL_PAGE, packWheelPoint,
  // M20. The `where` bit on every item report this file sends for a CONTEXT MENU, which is a
  // different list from the published `items` and the kernel indexes it by this bit.
  WITEM_CONTEXT,
  WMODAL_SYSTEM, WMODE_BLOCKING,
  WST_NORMAL, WST_MIN, WROLE_NORMAL, WROLE_DESKTOP,
} from "../abi.mjs";

/** The modifiers held, as `mods` bits. ONE mapping for every event type that carries them — a key,
 *  a pointer and a wheel had three copies of these three lines, and `mods` is one namespace
 *  (src/abi.mjs). An absent event is no modifiers, which is `#keys`'s synthetic-caller case. */
function modifierBits(event) {
  let mods = 0;
  if (!event) return mods;
  if (event.shiftKey) mods |= WMOD_SHIFT;
  if (event.ctrlKey) mods |= WMOD_CTRL;
  if (event.altKey) mods |= WMOD_ALT;
  // M18. The fourth modifier. `metaKey` is Command on a Mac and the Windows key elsewhere; the BIT
  // is one thing and which physical key sets it is the platform's business (src/abi.mjs).
  if (event.metaKey) mods |= WMOD_META;
  return mods;
}

/**
 * `KeyboardEvent.key` -> a `WKEY_*` keysym. M18.
 *
 * WHY A TABLE AND NOT A SWITCH: adding the next key is adding a row. `event.key` is the right
 * source rather than `code` or the long-deprecated `keyCode`, because it is the key's MEANING on
 * the reader's own layout — `code` is a physical position and would make an AZERTY keyboard send
 * the wrong keysym.
 *
 * IT IS CONSULTED ONLY WHEN `bytesForKey` RETURNED NOTHING, which is what keeps the two disjoint
 * at the source as well as in the record (`src/abi.mjs`'s `keysymOf`/`keyBytesOf`). Enter, Tab and
 * Backspace are deliberately ABSENT: `bytesForKey` already turns them into bytes (10, 9, 127) and a
 * row here would take them away from every program that reads them as bytes today — which is also
 * why M18's proof does not rest on Enter. `src/wm/terminal.mjs` is the one place that mapping
 * lives.
 */
const KEYSYM_BY_KEY = new Map([
  ["ArrowLeft", WKEY_LEFT], ["ArrowRight", WKEY_RIGHT],
  ["ArrowUp", WKEY_UP], ["ArrowDown", WKEY_DOWN],
  ["Home", WKEY_HOME], ["End", WKEY_END],
  ["PageUp", WKEY_PAGE_UP], ["PageDown", WKEY_PAGE_DOWN],
  ["Delete", WKEY_DELETE], ["Insert", WKEY_INSERT],
  // `ContextMenu` is the spelling in the UI Events key values table; Firefox has historically also
  // produced `Apps`, so both map to the one keysym rather than one engine losing the key.
  ["ContextMenu", WKEY_MENU], ["Apps", WKEY_MENU],
  ["F1", WKEY_F1], ["F2", WKEY_F2], ["F3", WKEY_F3], ["F4", WKEY_F4],
  ["F5", WKEY_F5], ["F6", WKEY_F6], ["F7", WKEY_F7], ["F8", WKEY_F8],
  ["F9", WKEY_F9], ["F10", WKEY_F10], ["F11", WKEY_F11], ["F12", WKEY_F12],
]);

/** The keysym a browser key event carries, or 0. Exported so a check can assert the mapping
 *  without dispatching a key, and so `selfTest`-style coverage has one table to read. */
export function keysymForKey(event) {
  if (!event || typeof event.key !== "string") return 0;
  return KEYSYM_BY_KEY.get(event.key) || 0;
}

/** M18. The click count on a DOWN record, from the browser's own `detail`.
 *
 *  THE COUNT IS THE PLATFORM'S. A double-click has a threshold the reader configured, and a program
 *  that timed two presses itself would disagree with every other application on their machine.
 *  `detail` is 1, 2, 3 across the presses of a triple-click, and anything past 3 is still a third
 *  click as far as this ABI goes — there is no `WPTR_CLICK4` and a quadruple-click is not a gesture
 *  Windows 7 has. */
function clickBits(event) {
  const n = event && typeof event.detail === "number" ? event.detail : 0;
  if (n >= 3) return WPTR_CLICK3;
  if (n === 2) return WPTR_CLICK2;
  return 0;
}

/** How far apart the two probe points of `#wheel`'s scale reading are, in CSS px.
 *
 *  IT IS LONG ON PURPOSE. `#dropPointAt` rounds to the window's own unit, so differencing it over a
 *  short span quantizes the answer: a text window's cell is ~16 CSS px, and a notch differenced
 *  across one cell boundary is worth 7 cells at one pointer position and 6 a pixel lower. Over a
 *  thousand px the converter's ±1 unit is under a tenth of a percent of the scale. */
const WHEEL_SCALE_SPAN_PX = 1000;

/** An already-scaled delta rounded to whole units, and NEVER zero where the gesture was not.
 *
 *  A notch below one unit must still move the list by one, or a trackpad's fine scrolling leaves a
 *  window looking dead — and the host cannot carry the remainder instead, because the kernel sums
 *  records and a remainder held here would be state outside the thing that resets. One cell IS the
 *  quantum of a text window, so one is the honest answer rather than a rounding up. */
function wheelUnits(scaled) {
  const n = Math.round(scaled);
  if (n !== 0) return n;
  if (scaled > 0) return 1;
  return scaled < 0 ? -1 : 0;
}

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
/**
 * And M17's: `#wheel` posts the BROWSER's delta rather than the window's own unit — the defect M16
 * cost a milestone for, in the one place M17 could repeat it.
 *
 * WHAT IT IS ABOUT: a wheel's delta and its position must be in one unit (constraint 248), and the
 * position is converted by `#dropPointAt` whether or not the delta is — so a run with the scale
 * dropped still aims at the right row and still clamps at both ends. It scrolls by the wrong
 * amount, which is the only clause that can tell the two worlds apart: at dpr 2 a surfaced window
 * moves half as far as the reader asked, and a text window moves a cell per pixel.
 */
/**
 * And M20's TWO.
 *
 * `noMenuGuard`: the `contextmenu` handler no longer refuses the host browser's own menu, which is
 * the world M16/R8 found this file in — a foreign menu drawn over pixels a process rendered. The
 * record is still written, so the control is readable as `defaultPrevented: false` rather than as
 * an absence, and the `WEV_POINTER` a right press sends is untouched: ONE clause moves.
 *
 * `silentDismiss`: a context menu closed without a choice reports nothing. That is the plausible
 * implementation — a dismissal is not a choice, so there is nothing to say — and what it costs is
 * the program: it is parked in `poll` on the fd it raised the menu on, so Esc leaves a window that
 * never comes back. See `activateItem`.
 */
let hostControls = {
  staleGeom: false, noRelayout: false, rawWheel: false, noMenuGuard: false, silentDismiss: false,
};

export function setHostControls(opts = {}) {
  hostControls = {
    staleGeom: opts.staleGeom === true,
    noRelayout: opts.noRelayout === true,
    rawWheel: opts.rawWheel === true,
    noMenuGuard: opts.noMenuGuard === true,
    silentDismiss: opts.silentDismiss === true,
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
      shows: 0, roles: 0, itemLists: 0, itemAsks: 0, iconViews: 0, watcherFaults: 0,
      // M16: surfaces rebuilt at a new size (as against created), geometry reports coalesced into
      // an animation frame, and right-clicks whose browser menu was refused.
      resurfaces: 0, geomFrames: 0, contextmenus: 0,
      // M17: wheel records routed into a window's queue. What the PAGE sent, as against what the
      // kernel queued after coalescing — the two differ by design, so neither answers for the
      // other.
      wheels: 0,
      // M19: buttonless moves and leaves sent, and cursors rendered. `hovers` is a SUBSET of
      // `pointers` and is counted separately because a drag's move and a hover are the same event
      // type: a check asserting the kernel coalesced a hover stream needs to know how many hovers
      // the page offered, and `pointers` answers for the presses too.
      hovers: 0, leaves: 0, cursors: 0,
      // M20: context menus the kernel asked for, rows in them, choices reported, dismissals
      // reported, and menus NOTHING COULD DRAW. The last one is counted rather than silent because
      // a page with no shell has no popup element, and the program is parked on the answer — so
      // the honest outcome is a dismissal, and a count is how a reader tells that apart from a
      // reader who really pressed Esc.
      menus: 0, menuRows: 0, menuChoices: 0, menuDismisses: 0, menusUnrendered: 0,
      // AND THE RIGHT PRESSES, which is the gesture that asks for one. A subset of `pointers`:
      // the record itself travels through `send` like any other press, and this is only the count
      // of how many of them carried button 2.
      rightPresses: 0 };
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
    /** M17. The last `WEV_WHEEL` this file sent, with the browser delta it came from. Declared
     *  here rather than left absent so "no wheel yet" and "a wheel whose conversion failed" are not
     *  the same reading. See `#wheel`. */
    this.lastWheel = null;
    /** M20. The last `win-menu` this file rendered: the point the kernel sent in the WINDOW's unit,
     *  the client point it converted to, the row count, and whether a shell drew it. Declared here
     *  for `lastWheel`'s reason — "no menu yet" and "a menu whose conversion failed" must not read
     *  the same. */
    this.lastMenu = null;
    /** The last item report this file sent for a context menu, as `{win, index, where}`. A
     *  DISMISSAL is `index < 0`, and it is here because the `silentDismiss` control's whole
     *  subject is whether the report went out at all. */
    this.lastMenuReport = null;
    /** The last right press on a surface, and whether the browser's own menu was refused. The
     *  `defaultPrevented` is read back OFF THE EVENT rather than inferred from the control, so a
     *  check asserts what the browser concluded and not what this file intended. */
    this.lastContextMenu = null;
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

  /** THE SHELL, if a page built one. It is set rather than constructed here because a shell is
   *  optional: M7 through M13's pages have frames and no taskbar, and a window menu that threw on
   *  those pages would make a right-click on a caption a page error. */
  useShell(shell) {
    this.shell = shell || null;
    return this.shell;
  }

  /** Subscribe to "the window table changed". Returns the watcher, so a caller can keep it — and
   *  `unwatch` it, which a shell taken down has to do. */
  watch(fn) {
    if (typeof fn === "function") this.watchers.push(fn);
    return fn;
  }

  /** Stop telling a watcher. A SHELL THAT WAS DISPOSED MUST NOT KEEP RENDERING: a page that boots
   *  a second kernel builds a second shell, and a callback nobody removed keeps rebuilding buttons
   *  inside a band that is no longer in the document. A critic found `Taskbar.dispose` doing
   *  exactly that, in the method whose docstring says it exists for this case. */
  unwatch(fn) {
    const at = this.watchers.indexOf(fn);
    if (at >= 0) this.watchers.splice(at, 1);
    return at >= 0;
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
    // M20. The fifth, and the only one that is TRANSIENT: a menu to raise now, at a point, rather
    // than a list to hold until it is withdrawn.
    if (m.t === "win-menu") { this.#menu(m); return true; }
    // M19. The fourth thing the page renders on a window's say-so and decides nothing about.
    if (m.t === "win-cursor") { this.#cursor(m); return true; }
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
      /* AND A RIGHT-CLICK ON THE CAPTION ASKS THE SHELL FOR A MENU. The host is the side that has
       * both the frame and the shell, so it is the one place the two are joined — `watch` is the
       * same arrangement in the other direction. A page with no shell gets no menu rather than a
       * broken one. */
      onMenu: (at) => {
        const entry = this.get(id);
        if (!entry || !this.shell || typeof this.shell.openWindowMenu !== "function") return;
        this.shell.openWindowMenu(entry, at);
      },
      /* AND THE WORK AREA IS A CALLBACK, not a value: the shell may take a strip off the desktop
       * at any moment, and a frame laid out against a stale work area is a maximized window
       * covering the taskbar. */
      workArea: () => this.workArea(),
      /* M16, A2b. EVERY SAMPLE OF A GESTURE REPORTS, coalesced to one per animation frame. The
       * frame changes its own box on every pointermove and the kernel learned nothing until the
       * release, so `/proc` and the blur governor described the pre-drag rectangle for the whole
       * drag — constraint 49's under-read in the direction constraint 49 exists to forbid. `this.get`
       * and not the `entry` below, which is still in its temporal dead zone here. */
      onGeom: () => this.#reportSoon(this.get(id)),
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
      // M19. The cursor the kernel last set, as a `WCUR_*` and never a keyword. A NUMBER FROM
      // BIRTH, so no reader has to tell `undefined` from a value: `WCUR_DEFAULT` is 0 precisely
      // because that is what a window nobody has set carries (`src/abi.mjs`). The STYLE is left
      // unwritten until a process asks, which keeps the stylesheet in charge of a window that
      // never asks — so `data-cursor` absent means "never set" and "0" means "set to the arrow".
      cursor: WCUR_DEFAULT,
      // M16. The animation frame a gesture's geometry report is waiting on, or 0. Per entry and
      // not per host, because two windows can be resized by two pointers.
      geomRaf: 0,
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
    /* M17. THE WHEEL, ON THE CLIENT AREA AND NOT ON THE CANVAS. `bodyEl` outlives every content
     * mode — a text widget, a surface, the desktop's icon view, and a surface replaced by the next
     * resize — so one listener here is the one route a wheel takes whatever is inside the window,
     * and `#wheel` asks `#dropPointAt` which unit that is. Wiring it beside the pointer listeners
     * would need re-wiring on every `#surface` and would reach a text window never.
     *
     * NOT PASSIVE, AND THE `preventDefault` IS THE REASON. A wheel inside a window is the window's
     * gesture; without this the host document ALSO acts on it — the page scrolls under the desktop,
     * a terminal's `overflow: auto` pre scrolls itself (src/wm/aero.mjs), and Ctrl+wheel zooms the
     * browser — so one notch gets two responders and the frames move out from under the pointer
     * that aimed at them. It is M16's refused context menu again (constraint 283's neighbour): a
     * host behaviour drawn over the operating system. */
    win.bodyEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.#wheel(entry, e);
    }, { passive: false });
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

  /** One key press into one window. `sym` is M18's keysym and is used only when there are no
   *  bytes — the two are disjoint at the source as well as in the record. */
  #keys(id, bytes, event, sym = 0) {
    const entry = this.get(id);
    if (!entry) return;
    this.stats.keys += 1;
    const mods = modifierBits(event);
    /* A KEYSYM RECORD IS `a = 0` WITH THE SYM IN `c`, which is what `keysymOf` reads and what makes
     * `keyBytesOf` answer empty for it. Counted apart from the byte keys, because "the arrows
     * arrived" and "the keyboard works" are different claims and a check asserting the first should
     * not be satisfiable by the second. */
    if (!bytes && sym) {
      this.stats.keysyms = (this.stats.keysyms | 0) + 1;
      this.post({ t: "win-in", win: id, evs: [{ type: WEV_KEY, mods, a: 0, b: 0, c: sym }] });
      return;
    }
    if (!bytes) return;
    // ONE RECORD PER KEY, with its UTF-8 bytes inline: a key that needed a second read to collect
    // its payload would be a second readiness edge for one press.
    this.post({ t: "win-in", win: id, evs: [{ type: WEV_KEY, mods, ...packKeyBytes(bytes) }] });
  }

  #focus(id, inward) {
    if (!this.frames.has(id)) return;
    /* A FOCUS THIS HOST CAUSED ITSELF IS NOT AN EVENT. `#surface` restores the keyboard to a
     * canvas it has just replaced, and a program must not be told its focus changed when it did
     * not — the one that would be told is mid-resize, and the record lands between two
     * `WEV_CLIENT`s and defeats their coalescing. Counted, so a run can see it happened. */
    if (this.get(id) && this.get(id).silentFocus) {
      this.stats.silentFocus = (this.stats.silentFocus | 0) + 1;
      return;
    }
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
    /* A RE-SURFACE MUST NOT STEAL FOCUS, AND MUST NOT DROP IT EITHER (A2d). Both facts are taken
     * before the destroy below, because removing the focused element moves focus to the body.
     *
     * M16 makes a program re-ask on every resize, so the unconditional `focus()` this method used
     * to end with — harmless while nothing re-asked — would yank the keyboard to this window on
     * every animation frame of somebody else's drag. A2d's fix is to focus only a FIRST surface,
     * and on its own that trades the defect for its mirror: the window being resized destroyed the
     * canvas that held the keyboard, so its own program would stop receiving keys at its first
     * resize and never recover. `hadFocus` is what distinguishes the two — the keyboard goes back
     * where it was, and nowhere else. */
    const resurface = !!entry.surface;
    const hadFocus = resurface
      && entry.surface.el.ownerDocument.activeElement === entry.surface.el;
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
    this.stats.resurfaces += resurface ? 1 : 0;
    // `#wirePointer` attaches to the NEW element, so a re-surface leaks no listener and delivers
    // nothing twice: the old canvas and its listeners went together above.
    this.#wirePointer(entry);
    if (!resurface || hadFocus) {
      /* THE FOCUS IS RESTORED WITHOUT ANNOUNCING IT, and that is the whole of this branch's
       * subtlety. `.focus()` fires the canvas `focus` listener `#wirePointer` just installed,
       * which posts a `WEV_FOCUS` — so during a resize each frame queued `WEV_CLIENT` then
       * `WEV_FOCUS`, and `Window.pushClient`'s tail replacement found a focus record at the tail
       * and appended instead of coalescing. Two records per frame against a 256-record ring, with
       * `stats.coalesced` stuck at 0 and `push` dropping the NEWEST when it laps — which is the
       * final client box. The keyboard must still come back to a window whose canvas was replaced
       * under it, so the focus happens and the event does not. Finding 6 of the M16 review. */
      entry.silentFocus = true;
      entry.surface.el.focus();
      entry.silentFocus = false;
    }
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
   * M19. A BUTTONLESS MOVE IS SENT, AND THE OVERFLOW THIS FILE PREDICTED WAS THE APPEND AND NOT THE
   * HOVER. It said "a second of hovering would overflow a queue the process is being asked to
   * drain", and the prediction was right about the append: measured over 500 driven moves into one
   * window, appending into a program that is not draining queues 501 records and drops 247 of them
   * at `WIN_EVENT_CAP`'s 256 (constraint 213), losing 49% of the stream. With the kernel's tail
   * replacement the SAME stream queues 2 and coalesces 499, with 4 records in the ring, and a
   * DRAINING program drops nothing either way. `bench/m19-hover/probe.py`, confirmed in Firefox 156
   * with trusted input at 2.7x the rate and identical counts — so the figure is a count and not a
   * rate (constraint 223).
   *
   * THE COALESCING IS THE KERNEL'S AND NOT THIS FILE'S. `Window.pushPointer` replaces a tail
   * buttonless move the way `pushClient` replaces a tail client box; a page that merged samples
   * itself would be deciding what a program was told it received (constraint 226).
   */
  #wirePointer(entry) {
    /** Posts one `WEV_POINTER` and answers whether it went. The answer is read by the hover count:
     *  a sample whose point fell outside the backing store is not a hover the program was told
     *  about, and counting it would make the page's figure disagree with the kernel's. */
    const send = (flags, event) => {
      if (!entry.surface) return false;
      const at = entry.surface.pointAt(event);
      if (!at) return false;
      const mods = flags | modifierBits(event);
      this.stats.pointers += 1;
      this.post({
        t: "win-in",
        win: entry.id,
        evs: [{ type: WEV_POINTER, mods, a: at.x, b: at.y, c: event.buttons | 0 }],
      });
      return true;
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
    });
    /* M18. THE DOWN RECORD IS SENT FROM `mousedown`, BECAUSE THAT IS THE EVENT THAT CARRIES THE
     * CLICK COUNT (constraint 300). It was sent from `pointerdown` above, and
     * `bench/m18-keys/clickcount.py` measured what that cost: `pointerdown.detail` is `[0, 0]`
     * across both presses of a driven double-click in Firefox AND Chrome, while `mousedown.detail`
     * is `[1, 2]` — so the bits were always zero, for every driver and by hand, and `--only m18`
     * was 15 of 38 red with `dblclicks: 0` in the program's own account.
     *
     * A LISTENER AND NOT AN ALGORITHM. Timing two presses here would disagree with the threshold
     * the reader configured for every other application on their machine, so the count stays the
     * platform's.
     *
     * `pointerdown` KEEPS the capture and the focus, and that split is what makes this safe:
     * `setPointerCapture` must be taken on the pointer event that owns the `pointerId`, and it is
     * what makes a drag that leaves the canvas keep arriving (constraint 279). `send` reads only
     * `clientX`/`clientY`/`buttons` and the modifier flags, all present on a MouseEvent, and
     * `pointerdown` fires BEFORE `mousedown`, so the DOWN-then-UP order a program sees is
     * unchanged and the capture is already held when this record goes out. */
    el.addEventListener("mousedown", (e) => {
      /* M20. A RIGHT PRESS TRAVELS AS AN ORDINARY DOWN RECORD, and that is the whole of what a
       * program needs to ask for a menu: `c` carries `event.buttons`, so button 2 is already in the
       * record (`pointerAt(ev).buttons`, src/abi.mjs) and there is no second event type. A right
       * press delivers BOTH this and `contextmenu` (constraint 279), which is why the two handlers
       * do disjoint things — this one is the report and that one is the refusal. */
      if ((e.buttons | 0) & 2) this.stats.rightPresses += 1;
      send(WPTR_DOWN | clickBits(e), e);
    });
    el.addEventListener("pointermove", (e) => {
      const sent = send(WPTR_MOVE, e);
      /* A HOVER IS A MOVE WITH NO BUTTON HELD, and `c` carries `event.buttons` — so the record
       * itself says which it is and no flag is needed. That is the same test the kernel's tail
       * replacement makes, deliberately: two tests over one field cannot disagree. */
      if (!(e.buttons | 0)) {
        if (sent) this.stats.hovers += 1;
        // AND NO DRAG. `#dragMove` returns at once without a live session, but a drag cannot
        // outlive its button (constraint 244), so a buttonless sample is never one of its own.
        return;
      }
      // M10. THE SAME CAPTURE CARRIES THE DRAG. `setPointerCapture` above is what makes a move
      // that left the canvas keep arriving, which is exactly what a drag across the desktop needs
      // — so there is no second capture and no page-wide listener.
      this.#dragMove(entry, e);
    });
    /* M19. THE POINTER LEFT, AND IT IS THE ONE RECORD WITH NO POSITION. Without it the last hover a
     * window ever receives is the one nearest the edge, so a lit row stays lit for ever.
     *
     * IT CANNOT GO THROUGH `send`. `Surface.pointAt` answers null for a point outside the backing
     * store and a leave fires exactly there, so `send` would drop the one record that clears the
     * hover. `a`/`b` are 0 and a program MUST NOT hit-test them (`src/abi.mjs`'s `WPTR_LEAVE`).
     *
     * `mods` IS `WPTR_LEAVE` AND NOTHING ELSE — no modifier bits, unlike every other record here.
     * A leave carries no gesture, so there is nothing a Shift could modify, and the kernel's tail
     * replacement compares the WHOLE `mods` word: an exact value is what lets two leaves collapse
     * into one while keeping a leave from being swallowed by the hover after it.
     *
     * A CAPTURED POINTER FIRES NO LEAVE. Boundary events go to the capture target while a drag
     * holds it, which is why this does not interrupt one. */
    el.addEventListener("pointerleave", (e) => {
      if (!entry.surface) return;
      this.stats.pointers += 1;
      this.stats.leaves += 1;
      this.post({
        t: "win-in",
        win: entry.id,
        evs: [{ type: WEV_POINTER, mods: WPTR_LEAVE, a: 0, b: 0, c: e.buttons | 0 }],
      });
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
      /* M18. A KEY THAT IS NOT BYTES IS NOW A KEYSYM, instead of being dropped here.
       *
       * `if (!bytes) return` was the one line that made every arrow, Home, End, Page and function
       * key unreachable to a process: `bytesForKey` answers null for them, and nothing downstream
       * ever heard the press. A list that cannot be walked with the arrow keys was the visible
       * cost, and `src/bin/taskmgr.mjs` had a comment declining to advertise arrows because it
       * could not receive them.
       *
       * `preventDefault` IS CALLED FOR A KEYSYM TOO, and it has to be: an unprevented Page Down or
       * F5 is the BROWSER's, and a reader walking a file list with Page Down would scroll the host
       * document or reload the page out from under the desktop. */
      const sym = bytes ? 0 : keysymForKey(e);
      if (!bytes && !sym) return;
      e.preventDefault();
      /* COUNTED HERE, because the widget that counts them is gone. A synthesised `KeyboardEvent`
       * exercises this handler and nothing in front of it, and `isTrusted` is the only way to tell
       * the two apart — which is what M4a's whole lesson rests on. Without this a surfaced window
       * could satisfy a "real keystroke" clause with a key the page dispatched to itself. */
      if (e.isTrusted) this.retired.trusted += 1; else this.retired.synthetic += 1;
      this.#keys(entry.id, bytes, e, sym);
    });
    /* AND FOCUS, WHICH A SURFACE STOPPED EMITTING. The focus and blur listeners were the TERMINAL
     * widget's, and `#surface` removes it — so a surfaced window never reported another focus
     * change for the rest of its life, and a program that dimmed a caret on blur never recovered.
     * `src/abi.mjs` calls focus "an EVENT and not a query, because the process that wants it is
     * asleep in `poll`"; for a surface it was neither. */
    el.addEventListener("focus", () => this.#focus(entry.id, 1));
    el.addEventListener("blur", () => this.#focus(entry.id, 0));
    /* M16, R8. A FOREIGN MENU DRAWN OVER THE OPERATING SYSTEM is the clearest breach of the
     * surface available, and `#wirePointer` wired pointerdown/move/up/cancel/keydown/focus/blur
     * and not this one: a right-click inside a window raised the host browser's own menu, over
     * pixels a process drew.
     *
     * M20 CLOSED THE OTHER HALF, and it needed no new event: the `mousedown` above already sends a
     * `WEV_POINTER` whose `c` is `event.buttons`, so a right press is a DOWN record carrying button
     * 2 and a program reads the gesture off the record it already receives. This handler still does
     * exactly one thing — refuse the browser's menu — because the two arrive as separate events for
     * one press (constraint 279) and a report sent from here would be a second DOWN for one press.
     *
     * `defaultPrevented` IS READ BACK OFF THE EVENT. `noMenuGuard` skips the `preventDefault` and
     * keeps the record, so the control reads as `false` rather than as a missing reading — an
     * absent record and a refusal that did not happen are not the same world. */
    el.addEventListener("contextmenu", (e) => {
      if (!hostControls.noMenuGuard) e.preventDefault();
      this.stats.contextmenus += 1;
      this.lastContextMenu = {
        win: entry.id,
        defaultPrevented: e.defaultPrevented === true,
        button: e.button | 0,
        trusted: e.isTrusted === true,
      };
    });
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

  /**
   * M19. The cursor over the window's CLIENT AREA, as the kernel set it.
   *
   * ON `bodyEl` AND NOT ON THE CANVAS, and that is the whole of this method's subtlety: `#surface`
   * replaces the canvas on every resize to a new size, so a cursor written there would be lost by
   * the next resize with nothing reporting it. `cursor` is an inherited property and the body is
   * the client area, so the canvas gets it and the frame's own grips — which are outside the body
   * and set their own (`src/wm/window.mjs`) — do not.
   *
   * THE KEYWORD COMES FROM `WCUR_CSS`, indexed by the number (constraint 226): the page renders a
   * name out of the ABI's table and never one a process handed it, which is what keeps `url(...)`
   * — a fetch — out of a syscall argument. An index with no row is counted and dropped rather
   * than written: `style.cursor = undefined` is a silent no-op that leaves the previous cursor in
   * place, so the frame would show a cursor nothing asked for. The kernel range-checks too; this
   * is the renderer refusing to render what it cannot name.
   *
   * `dataset.cursor` CARRIES THE NUMBER THE KERNEL SENT, where the style carries the rendering —
   * the division `dataset.state` and `dataset.role` already make, and what lets a driver assert
   * what was asked for rather than what CSS resolved it to.
   */
  #cursor(m) {
    const entry = this.get(m.win | 0);
    if (!entry) { this.stats.unknown += 1; return; }
    const cur = m.cursor | 0;
    const css = WCUR_CSS[cur];
    if (typeof css !== "string") { this.stats.unknown += 1; return; }
    entry.cursor = cur;
    entry.win.bodyEl.style.cursor = css;
    entry.win.el.dataset.cursor = String(cur);
    this.stats.cursors += 1;
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

  /**
   * Tell the kernel the box, the CELL COUNT and the CLIENT CONTENT BOX the frame settled on. The
   * cell count is the page's to compute — it is the side with the font — and it is what a terminal
   * needs for TIOCSWINSZ.
   *
   * THE CLIENT BOX IS MEASURED AND NEVER MODELLED (A2, PRD §2). `(w - 2*WIN_INSET) by
   * (h - WIN_CAP_H - WIN_INSET)` is wrong twice over: `.aero-desktop .window-body` carries a
   * `border-top: 1px solid` and is not `box-sizing: border-box`, so the content box the canvas
   * fills is a pixel shorter than the model — and four of the five pages that render a surface do
   * not load that stylesheet at all, so on those hosts the constants describe no element.
   * Constraint 264's rule: a geometry derived from a measured rect survives a second engine, and
   * one derived from a constant does not.
   *
   * `clientWidth`/`clientHeight` and NOT the bounding rect, which is the border box and so carries
   * that 1 px. The `cols`/`rows` above keep reading the rect, unchanged: a cell count off by a
   * pixel of border is not a defect, and moving it would move M4's expectations for nothing.
   *
   * IN DEVICE PIXELS, which is the unit `win_surface` takes and the unit `SURFACE_MAX_PX` is sized
   * in, with the ratio sent beside them — a program holds CSS-px layout constants and the record
   * is its only route to the factor.
   */
  #report(entry) {
    // THE BOX THE CLAMP SETTLED ON, which is the whole contract. `staleGeom` reports the REQUESTED
    // one instead, so the kernel believes a geometry no frame ever had (see `setHostControls`).
    // It does not reach the client box below: that is a reading of a live element, and the control
    // is about the box the page claims to have placed.
    const placed = hostControls.staleGeom ? entry.win.box : entry.win.placed;
    const body = entry.win.bodyEl.getBoundingClientRect();
    // Read per report and not once per host: a window dragged to a second display changes it.
    const dpr = window.devicePixelRatio || 1;
    this.stats.geoms += 1;
    this.post({
      t: "win-geom",
      win: entry.id,
      x: placed.x, y: placed.y, w: placed.w, h: placed.h,
      cols: Math.max(1, Math.floor(body.width / this.cell.w)),
      rows: Math.max(1, Math.floor(body.height / this.cell.h)),
      clientW: Math.round(entry.win.bodyEl.clientWidth * dpr),
      clientH: Math.round(entry.win.bodyEl.clientHeight * dpr),
      dpr,
    });
  }

  /**
   * Report at most once per animation frame. The route a GESTURE takes, because none of `#report`'s
   * seven call sites is inside one: the drag and the resize end in `apply()` and post nothing, so
   * the kernel held the pre-drag rectangle for the whole gesture — and permanently when
   * `setPointerCapture` throws, since the release then never reaches the frame's own `pointerup`
   * (constraint 175, A2b).
   *
   * ONE POST PER FRAME IS THE CEILING AND NOT ONE PER SAMPLE. A `win-geom` per `pointermove` is
   * the traffic constraint 243 refuses for a drag, and each one raises a client event into a
   * 256-record queue; the kernel coalesces what does arrive into a single tail record.
   *
   * A FRAME DESTROYED BETWEEN THE SCHEDULE AND THE CALLBACK MUST NOT REPORT: the kernel has no
   * window left to record it against and counts the message as unknown, so the identity is
   * re-checked rather than assumed to have survived the frame.
   */
  #reportSoon(entry) {
    if (!entry || entry.geomRaf) return;
    this.stats.geomFrames += 1;
    entry.geomRaf = requestAnimationFrame(() => {
      entry.geomRaf = 0;
      if (this.frames.get(entry.id) !== entry) return;
      this.#report(entry);
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
   * M20. A PROCESS ASKED FOR A MENU AT A POINT, and the SHELL draws it.
   *
   * WHY IT IS NOT THE PROCESS'S TO DRAW: `.window-body` is `overflow: hidden` (`src/wm/aero.mjs`),
   * so a popup drawn into the surface is clipped to the client area and a menu raised near the
   * bottom of a frame loses its last rows. The shell's one popup element lives on the DESKTOP, so
   * it extends past the frame — which is the clause `menu-in-surface` breaks.
   *
   * `m.x`/`m.y` ARE IN THE WINDOW'S OWN UNIT — surface px for a surfaced window, cells for a text
   * one (constraint 248) — because they came from the `WEV_POINTER` that asked for the menu.
   * `#clientPointAt` is the one conversion back, and it is `#dropPointAt`'s declared inverse.
   *
   * A PAGE WITH NO SHELL REPORTS THE DISMISSAL instead of dropping the menu. The program is parked
   * in `poll` on the fd it called on, so a menu nothing can draw and nobody answers is a window
   * frozen with no error anywhere; a dismissal is the truthful outcome and `menusUnrendered` is how
   * a reader tells it from a reader who pressed Esc. M7-M13's pages have frames and no shell.
   */
  #menu(m) {
    const entry = this.get(m.win | 0);
    if (!entry) { this.stats.unknown += 1; return; }
    const rows = (Array.isArray(m.items) ? m.items : []).map((row) => ({
      icon: row.icon | 0, flags: row.flags | 0, label: String(row.label || ""),
    }));
    const at = this.#clientPointAt(entry, m.x | 0, m.y | 0);
    this.stats.menus += 1;
    this.stats.menuRows += rows.length;
    this.lastMenu = {
      win: entry.id,
      x: m.x | 0,
      y: m.y | 0,
      clientX: at.x,
      clientY: at.y,
      rows: rows.length,
      drawn: false,
    };
    if (!this.shell || typeof this.shell.openContextMenu !== "function") {
      this.stats.menusUnrendered += 1;
      this.activateItem(entry.id, -1, WITEM_CONTEXT);
      return;
    }
    this.lastMenu.drawn = true;
    this.shell.openContextMenu(entry, rows, at);
  }

  /**
   * M20. A point in a window's OWN unit, back into client (viewport) CSS px.
   *
   * THE DECLARED INVERSE OF `#dropPointAt`, and declared because that is what makes a menu land
   * under the pointer that asked for it: the process was handed surface px or cells by a
   * `WEV_POINTER` and hands the same numbers back, so any disagreement between the two conversions
   * is a menu that opens somewhere the reader did not click. `Surface.clientAt` is itself
   * `pointAt`'s inverse, so a surfaced window's half is one call and not arithmetic here.
   *
   * THE CENTRE OF THE CELL, like `clientAt`'s centre of the surface pixel: a cell is `cell.w` wide
   * and its left edge is the boundary between two of them.
   *
   * AN ICON-VIEW WINDOW (`WROLE_DESKTOP`) FALLS DOWN THE CELL PATH AND SHOULD NOT. It is neither
   * surfaced nor text: `#wirePointer` is wired on a SURFACE only, so that window receives no
   * `WEV_POINTER` at all and a point from it is in no unit this file has ever handed it. A program
   * raising a menu on one has nothing to pass; the desktop's own menus are `src/wm/desktop.mjs`'s,
   * drawn page-side. Stated rather than guessed at, so a caller that appears is a caller that
   * reads this.
   */
  #clientPointAt(entry, x, y) {
    if (entry.surface) {
      const got = entry.surface.clientAt(x | 0, y | 0);
      if (got) return got;
    }
    const r = entry.win.bodyEl.getBoundingClientRect();
    return {
      x: Math.round(r.left + ((x | 0) + 0.5) * this.cell.w),
      y: Math.round(r.top + ((y | 0) + 0.5) * this.cell.h),
    };
  }

  /**
   * The shell says one of a window's rows was activated. Reported, never acted on.
   *
   * `where` is the `WITEM_*` bit saying which rendering it came from, because a row on the desktop
   * and the same row in a jump list are the same row and a program may care which was clicked.
   * The kernel validates the index against the list it holds — a page cannot name a row nothing
   * published.
   *
   * M20. A NEGATIVE INDEX FROM A CONTEXT MENU IS A DISMISSAL and it goes out like any other
   * report, because the program is parked on the answer: a swallowed dismissal is a window that
   * never wakes (`src/kernel/wins.mjs` holds the other half of that argument). It is the ONE route
   * for both, so the `silentDismiss` control has one place to sit — Esc and a click away are two
   * gestures and must not be two code paths that can disagree.
   */
  activateItem(win, index, where) {
    const i = index | 0;
    const w = where | 0;
    const dismissal = i < 0 && (w & WITEM_CONTEXT) !== 0;
    if (dismissal && hostControls.silentDismiss) return;
    this.stats.itemAsks += 1;
    if (w & WITEM_CONTEXT) {
      if (dismissal) this.stats.menuDismisses += 1; else this.stats.menuChoices += 1;
      this.lastMenuReport = { win: win | 0, index: i, where: w };
    }
    this.post({ t: "win-item-ask", win: win | 0, index: i, where: w });
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

  /**
   * M17. THE WHEEL TURNED INSIDE A WINDOW: one `WEV_WHEEL` on that window's own fd.
   *
   * THE UNIT CONVERSION IS THE WHOLE OF THIS METHOD. A `wheel` event's `deltaX`/`deltaY` and its
   * `clientX`/`clientY` are CSS px; a `WEV_WHEEL` carries SURFACE px for a surfaced window and
   * CELLS for a text one, deltas and position alike (constraint 248). `#dropPointAt` is already the
   * one place that choice is made, so the position comes straight out of it and THE SCALE IS READ
   * BACK OUT OF IT TOO — differenced over `WHEEL_SCALE_SPAN_PX`. `Surface.pointAt` owns the canvas's
   * CSS scale and `this.cell` owns the glyph; a second reading of either is how a delta comes to
   * disagree with the position it was aimed at, which is one window scrolling at twice the speed
   * the pointer says it should.
   */
  #wheel(entry, event) {
    /* `deltaMode`'s values are read off the EVENT, which carries them as its own interface
     * constants, rather than copied into this file as two integers nothing here can check. An event
     * carrying neither is pixels, which is `deltaMode`'s own default. */
    const mode = event.deltaMode | 0;
    const at = this.#dropPointAt(entry, event);
    let mods = modifierBits(event);
    let dx;
    let dy;
    if (mode === event.DOM_DELTA_PAGE) {
      /* A PAGE DELTA PASSES THROUGH UNSCALED, and `WWHEEL_PAGE` is what says so: the delta is in
       * pages, so multiplying it by a surface scale would turn a viewport-sized jump into a
       * different gesture (src/abi.mjs, WWHEEL_PAGE). */
      mods |= WWHEEL_PAGE;
      dx = Math.round(event.deltaX || 0);
      dy = Math.round(event.deltaY || 0);
    } else {
      /* A LINE DELTA BECOMES CSS PX THROUGH THE ONE LINE HEIGHT THIS HOST MEASURED — the terminal
       * cell, taken from a real rendered glyph (`measureCell`). There is no `WWHEEL_LINE`, so a
       * line left as a line would be a record whose unit nothing in the ABI names. */
      const line = mode === event.DOM_DELTA_LINE;
      const cssX = (event.deltaX || 0) * (line ? this.cell.w : 1);
      const cssY = (event.deltaY || 0) * (line ? this.cell.h : 1);
      const far = this.#dropPointAt(entry, {
        clientX: event.clientX + WHEEL_SCALE_SPAN_PX,
        clientY: event.clientY + WHEEL_SCALE_SPAN_PX,
      });
      const scaleX = (far.x - at.x) / WHEEL_SCALE_SPAN_PX;
      const scaleY = (far.y - at.y) / WHEEL_SCALE_SPAN_PX;
      // NO BOX, NO CONVERSION, AND IT SAYS SO. `Surface.pointAt` answers null for a canvas with no
      // measurable rect, which `#dropPointAt` renders as 0,0 for both probes — a window mid-resurface.
      // Posting a record from it would be a delta of 0 aimed at 0,0, which is a lie about a gesture
      // the reader made. Counted, like `#wirePointer`'s own unmeasurable pointer.
      if (scaleX === 0 && scaleY === 0) { this.stats.unknown += 1; return; }
      // THE SCALE IS THE CONTROL'S SUBJECT, so it is the one thing dropped and nothing else is.
      const sx = hostControls.rawWheel ? 1 : scaleX;
      const sy = hostControls.rawWheel ? 1 : scaleY;
      dx = wheelUnits(cssX * sx);
      dy = wheelUnits(cssY * sy);
    }
    this.stats.wheels += 1;
    /** What the PAGE sent, with the browser's own delta beside it. A driver cannot assert a
     *  dispatched delta against a scrolled offset — a CDP wheel delta is in DEVICE px and the
     *  `wheel` event delivers `deltaY / devicePixelRatio` (constraint 297) — so this is the reading
     *  it asserts against instead.
     *
     *  `rawX`/`rawY` ARE IN `mode`'s UNIT and not in CSS px: pixels at `DOM_DELTA_PIXEL`, lines at
     *  `DOM_DELTA_LINE`, pages at `DOM_DELTA_PAGE`. The mode is published beside them because
     *  without it a reader cannot tell a 3-line scroll from a 3-pixel one. */
    this.lastWheel = { win: entry.id, mode, mods, dx, dy, x: at.x, y: at.y,
      rawX: event.deltaX || 0, rawY: event.deltaY || 0 };
    this.post({
      t: "win-in",
      win: entry.id,
      // `WWHEEL_COALESCED` IS NEVER SET HERE. It is the kernel's claim to make and `WinMgr.feed`
      // masks it out of anything this page posts; a page that could assert it would be a page that
      // could tell a program two notches were one.
      evs: [{ type: WEV_WHEEL, mods, a: dx, b: dy, c: packWheelPoint(at.x, at.y) }],
    });
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
      controls: { ...hostControls, ...geometryControlsInForce(), ...surfaceControlsInForce() },
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
      // M17. The last wheel record this file sent, and the browser delta it came from: what a
      // driver asserts against, because a dispatched delta is not what the page received
      // (constraint 297).
      lastWheel: this.lastWheel,
      // M20. The menu the kernel asked for in the WINDOW's unit and the client point it was drawn
      // at, the item report that answered it, and the right press that asked. Three readings of one
      // gesture on purpose, `frameBlocked`'s reason: the conversion, the answer and the browser's
      // own conclusion about its menu are three different things to get wrong.
      lastMenu: this.lastMenu,
      lastMenuReport: this.lastMenuReport,
      lastContextMenu: this.lastContextMenu,
      dragImage: this.dragEl ? !this.dragEl.hidden : false,
      live: [...this.frames.keys()],
      created: this.created,
      destroyed: this.destroyed,
      fed: { ...this.fed },
    };
  }
}
