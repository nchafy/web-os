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

import { Win } from "./window.mjs";
import { Terminal } from "./terminal.mjs";
import {
  WEV_KEY, WEV_CLOSE, WEV_FOCUS, WMOD_SHIFT, WMOD_CTRL, WMOD_ALT, packKeyBytes,
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

export class WinHost {
  /** `spec.into` is the desktop element, `spec.post` sends one message to the kernel. */
  constructor(spec) {
    this.into = spec.into;
    this.post = spec.post;
    /** winid -> {win: Win, term: Terminal, meta}. */
    this.frames = new Map();
    this.cell = measureCell(this.into);
    /** Every win-create the host saw, in order, so a check can assert on what the kernel asked for
     *  rather than on what survived. */
    this.created = [];
    this.destroyed = [];
    /** TRUSTED AND SYNTHETIC KEYS ARE COUNTED BY THE WIDGET, not here: `isTrusted` is a property
     *  of the browser's own event and `src/wm/terminal.mjs` is where it is read, so a second count
     *  in this file would be the same fact with two renderers. See `keyCounts`. */
    this.stats = { creates: 0, destroys: 0, keys: 0, cells: 0, geoms: 0, closes: 0, focus: 0,
      dropped: 0, unknown: 0 };
    /** The kernel's receipt for each batch of events: offered against queued. SOMETHING READS IT —
     *  an unread receipt is how M4a's silent input loss survived (constraint 160). */
    this.fed = { offered: 0, queued: 0 };
    /** The key counts of windows that have GONE. Summed into `keyCounts` so a check that reads the
     *  count after a session ended does not read zero for keys that were really pressed. */
    this.retired = { trusted: 0, synthetic: 0 };
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
      /* THE X BUTTON TELLS THE KERNEL AND THE KERNEL TAKES THE FRAME DOWN. Returning false keeps
       * the frame until `win-destroy` arrives, so the window's own process sees WEV_CLOSE first and
       * the DOM is never ahead of the kernel. M9 is what lets that process refuse. */
      onClose: () => {
        this.stats.closes += 1;
        this.post({ t: "win-in", win: id, evs: [{ type: WEV_CLOSE }] });
        this.post({ t: "win-gone", win: id });
        return false;
      },
      onEndProcess: () => {
        win.el.dataset.endPressed = "1";
        this.post({ t: "win-gone", win: id });
      },
    });
    const term = new Terminal({
      into: win.bodyEl,
      onKeys: (bytes, event) => this.#keys(id, bytes, event),
    });
    const entry = { id, win, term, pid: m.pid | 0, owner: m.owner | 0, health: [] };
    this.frames.set(id, entry);
    this.created.push({ win: id, pid: m.pid | 0, owner: m.owner | 0, title: m.title });
    this.stats.creates += 1;
    // The box the CLAMP settled on, reported straight back: the kernel asked for a geometry and
    // records only what the page actually did with it.
    this.#report(entry);
    // Focus follows creation, which is what a user expects of a window that just opened and is what
    // lets a check type into the newest one without hunting for it.
    term.focus();
    // Drag and arrow-key moves both end in `apply()`, so one listener per frame covers both.
    win.el.addEventListener("pointerup", () => this.#report(entry));
    win.barEl.addEventListener("keyup", () => this.#report(entry));
    // Focus is an EVENT and not a query, because the process that wants it is asleep in `poll`.
    term.el.addEventListener("focus", () => this.#focus(id, 1));
    term.el.addEventListener("blur", () => this.#focus(id, 0));
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
    entry.term.write(bytes);
  }

  #destroy(m) {
    const ids = Array.isArray(m.ids) ? m.ids : [];
    // IN REVERSE, so a child's frame goes before its parent's: the other order leaves a dialog on
    // screen over a desktop whose window has gone, which is the picture constraint 179 forbids.
    for (const id of [...ids].reverse()) {
      const entry = this.get(id);
      if (!entry) continue;
      this.retired.trusted += entry.term.trustedKeys;
      this.retired.synthetic += entry.term.synthKeys;
      entry.win.destroy();
      this.frames.delete(id);
      this.destroyed.push(id);
      this.stats.destroys += 1;
    }
  }

  #title(m) {
    const entry = this.get(m.win | 0);
    if (!entry) { this.stats.unknown += 1; return; }
    entry.win.setTitle(m.title || "");
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
    const placed = entry.win.placed;
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
    for (const [id, entry] of this.frames) out[id] = entry.term.screen();
    return out;
  }

  /** The widget's own key counts, summed. A SYNTHESISED KeyboardEvent exercises the handler and
   *  nothing in front of it, so a check that asserts a real key press must assert on `trusted`. */
  keyCounts() {
    let trusted = this.retired.trusted;
    let synthetic = this.retired.synthetic;
    for (const entry of this.frames.values()) {
      trusted += entry.term.trustedKeys;
      synthetic += entry.term.synthKeys;
    }
    return { trusted, synthetic };
  }

  report() {
    return {
      ...this.stats,
      keyCounts: this.keyCounts(),
      cell: this.cell,
      live: [...this.frames.keys()],
      created: this.created,
      destroyed: this.destroyed,
      fed: { ...this.fed },
    };
  }
}
