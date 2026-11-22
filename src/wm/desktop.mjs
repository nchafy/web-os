// M14: the desktop's icons — the view, the selection, the rubber band, the drag and the two
// context menus.
//
// THERE IS NO SYSCALL IN THIS FILE. It renders the rows a WROLE_DESKTOP window published
// (`win_items`) and reports an activation back through `WinHost.activateItem`, which the kernel
// validates against the list it is holding. What a row MEANS — spawn this program, open that
// directory — is the publishing process's: `src/bin/desktop.mjs` reads the filesystem, decides what
// the desktop contains, and acts on `WEV_ITEM`. So the icons on screen are a rendering of a
// process's own view of the filesystem, and this file knows nothing about files.
//
// WHY THE PAGE DRAWS THEM: `docs/DECISIONS.md` D39. A display list has no text op and no image op,
// and `WEV_POINTER` is only delivered while a button is down — so a process-drawn desktop could
// have neither labels nor hover, and double-click, rubber-band selection and a context menu are
// not expressible in a stream of filled rectangles.
//
// THE POSITIONS ARE THE VIEW'S AND NOT THE PROCESS'S. Where an icon sits is a property of this
// display: a 1,280 px desktop and a 640 px one lay the same rows out differently, and a process
// that owned the coordinates would be deciding a layout it cannot measure. A dragged icon keeps its
// cell for as long as the view lives, which is the whole of what "arranged" means here — nothing is
// persisted, and that is recorded as not done rather than half-built.

import {
  WITEM_DESKTOP, WITEM_SEPARATOR, WITEM_DISABLED, WITEM_CONTAINER,
} from "../abi.mjs";
import { iconMarkup } from "./icons.mjs";
import { ICON_PX, ICON_CELL_W, ICON_CELL_H } from "./aero.mjs";

/** How far the pointer must travel before a press on bare desktop becomes a rubber band rather
 *  than a click that clears the selection. Below it, a hand that moved two pixels while clicking
 *  still means "deselect". */
const BAND_PX = 4;

/** The grid's margin, so the first icon is not against the edge. Windows 7 leaves about this. */
const PAD = 8;

/** The view's negative-control switches. `snapToGrid` off is the world the grid clauses are about:
 *  a dropped icon keeps the raw pixel the pointer left it on, which is what this view did before
 *  it aligned, so the control shows those clauses are coupled to the snapping. */
const viewControls = { snapToGrid: true };

export function setViewControls(next) {
  Object.assign(viewControls, next || {});
  return { ...viewControls };
}

/* ---------------------------------------------------------------------------------------------
   THE GRID, AS ONE ARITHMETIC IN BOTH DIRECTIONS — AND AS PURE FUNCTIONS.

   `cellAtPoint` is the declared inverse of `boxForCell`, the same relationship `src/wm/surface.mjs`
   states between `clientAt` and `pointAt`, and it is what lets a DROPPED icon land exactly where
   the auto-layout would have put it. Two copies of that map is how a dragged icon comes to sit a
   few pixels off the column its neighbours are in, which is the whole visible difference between a
   desktop and a pile.

   THEY ARE MODULE FUNCTIONS AND NOT METHODS for `src/fs/`'s reason, in the small: this is the part
   with arithmetic worth checking, and it is only checkable in plain node — no DOM, no browser —
   while it closes over nothing. `bench/m14-shell/probe.mjs` asserts the round trip, the tie-break
   and the full-desktop case directly. The view's own methods measure a rect and call these.
   --------------------------------------------------------------------------------------------- */

/** How many whole cells fit a view of this size. At least one of each: a view too small for a
 *  single cell still has to place the icons it was given somewhere. */
export function gridFor(width, height) {
  return {
    cols: Math.max(1, Math.floor((width - PAD * 2) / ICON_CELL_W)),
    rows: Math.max(1, Math.floor((height - PAD * 2) / ICON_CELL_H)),
  };
}

/** A cell's top-left, in view pixels. */
export function boxForCell(cell) {
  return { x: PAD + cell.col * ICON_CELL_W, y: PAD + cell.row * ICON_CELL_H };
}

/** The order cells are filled: down the first column, then the next, which is Windows 7's own and
 *  is why a desktop with eleven icons has them beside each other rather than wrapped across the
 *  top. A slot past the last cell overflows to the RIGHT rather than wrapping back over an icon
 *  that is already there. */
export function slotCell(slot, grid) {
  return { col: Math.floor(slot / grid.rows), row: slot % grid.rows };
}

/** The cell a point falls in. ROUNDED and not floored, so an icon let go past a cell's midpoint
 *  takes the next one — which is what makes a short nudge read as "it snapped back" rather than as
 *  a move that half happened. Clamped into the grid for the window clamp's reason: a cell outside
 *  it is an icon nobody can reach. */
export function cellAtPoint(x, y, grid) {
  return {
    col: Math.min(Math.max(Math.round((x - PAD) / ICON_CELL_W), 0), grid.cols - 1),
    row: Math.min(Math.max(Math.round((y - PAD) / ICON_CELL_H), 0), grid.rows - 1),
  };
}

/**
 * The nearest FREE cell to the one a drop asked for. Windows 7 does not stack two icons in one
 * square, and a drop that silently overlapped would hide a row the keyboard can still reach.
 *
 * `taken` is a set of `"col,row"` keys. Every cell is considered and the closest free one wins;
 * the scan is column-major, so a tie goes to the lower column and then the lower row.
 * Deterministic on purpose — a check asserts which cell a given drop takes, and "whichever the
 * loop found first" is not a rule. The grid is a few hundred cells and this runs once per dropped
 * icon.
 *
 * A FULL desktop keeps the asked-for cell: refusing the drop would lose the gesture, and there is
 * no free square to honour it with.
 */
export function nearestFreeCell(want, taken, grid) {
  const key = (col, row) => `${col},${row}`;
  if (!taken.has(key(want.col, want.row))) return want;
  let best = null;
  for (let col = 0; col < grid.cols; col += 1) {
    for (let row = 0; row < grid.rows; row += 1) {
      if (taken.has(key(col, row))) continue;
      const d = (col - want.col) ** 2 + (row - want.row) ** 2;
      if (!best || d < best.d) best = { col, row, d };
    }
  }
  return best ? { col: best.col, row: best.row } : want;
}

export class IconView {
  /** `spec.into` is the desktop window's client area, `spec.host` the `WinHost`, and `spec.win`
   *  the winid whose rows this view is showing — the one it reports activations against. */
  constructor(spec) {
    this.into = spec.into;
    this.host = spec.host;
    this.win = spec.win | 0;
    /** The rows, as the kernel last posted them, with their INDEX kept: an activation names the
     *  index in the publisher's own list, so a view that re-sorted and lost it would activate the
     *  wrong row. */
    this.rows = [];
    /** index -> {x, y} for an icon a user has dragged. Everything else is laid out by the grid. */
    this.placed = new Map();
    /** The selected indexes, in no order. A SET and not a single index, because a rubber band
     *  selects several and every action here works on "the selection". */
    this.selection = new Set();
    this.drag = null;
    this.stats = {
      renders: 0, clicks: 0, activations: 0, bands: 0, drags: 0, menus: 0, keys: 0,
    };
    this.#build();
  }

  #build() {
    const view = document.createElement("div");
    view.className = "icon-view";
    view.dataset.iconView = String(this.win);
    // A LISTBOX, which is the closest honest role: a set of rows, several of which may be
    // selected, each of which can be activated.
    view.setAttribute("role", "listbox");
    view.setAttribute("aria-multiselectable", "true");
    view.setAttribute("aria-label", "Desktop");
    view.tabIndex = 0;

    const band = document.createElement("div");
    band.className = "rubber";
    band.hidden = true;
    band.setAttribute("aria-hidden", "true");
    view.append(band);

    const menu = document.createElement("div");
    menu.className = "shell-popup";
    menu.dataset.popup = "0";
    menu.hidden = true;
    view.append(menu);

    this.el = view;
    this.bandEl = band;
    this.menuEl = menu;
    this.into.append(view);

    view.addEventListener("pointerdown", (e) => this.#press(e));
    view.addEventListener("dblclick", (e) => this.#dblclick(e));
    view.addEventListener("contextmenu", (e) => this.#context(e));
    view.addEventListener("keydown", (e) => this.#key(e));
  }

  /** The rows this view shows: the ones flagged for the desktop, with their publisher index. */
  #visible() {
    return this.rows
      .map((row, index) => ({ ...row, index }))
      .filter((row) => (row.flags & WITEM_DESKTOP) !== 0 && (row.flags & WITEM_SEPARATOR) === 0);
  }

  /** How many cells fit the view, measured. The only part of the grid that touches the DOM. */
  #grid() {
    const r = this.el.getBoundingClientRect();
    return gridFor(r.width, r.height);
  }

  #boxFor(cell) {
    return boxForCell(cell);
  }

  #slotCell(slot) {
    return slotCell(slot, this.#grid());
  }

  #cellAt(x, y) {
    return cellAtPoint(x, y, this.#grid());
  }

  #freeCell(want, taken) {
    return nearestFreeCell(want, taken, this.#grid());
  }

  /** What the kernel says this window published. Replaces the list whole, for the reason the
   *  kernel posts it whole: a view applying a delta can disagree with the publisher and nothing
   *  would say so. */
  setItems(rows) {
    this.rows = (Array.isArray(rows) ? rows : []).map((row) => ({
      icon: row.icon | 0, flags: row.flags | 0, label: String(row.label || ""),
    }));
    // A SELECTION CANNOT OUTLIVE ITS ROW. A republished list may be shorter, and an index past its
    // end would be a selection a user cannot see and an activation of nothing.
    for (const index of [...this.selection]) {
      if (index >= this.rows.length) this.selection.delete(index);
    }
    this.render();
    return this.rows.length;
  }

  render() {
    this.stats.renders += 1;
    // The band and the menu are kept; everything else is rebuilt.
    for (const node of [...this.el.querySelectorAll(".desk-icon")]) node.remove();
    const visible = this.#visible();
    /* THE DRAGGED CELLS ARE RESERVED BEFORE ANYTHING IS LAID OUT, and the rest fall into the free
     * cells in column order. Without the reservation an icon dragged onto a cell and an icon the
     * layout then puts there are given the same square — two icons in one place and one label
     * unreadable — which is the state snapping to a grid would otherwise have made REACHABLE,
     * since before it a dropped icon sat between cells and never exactly on one. */
    const taken = new Set();
    const key = (cell) => `${cell.col},${cell.row}`;
    for (const row of visible) {
      const held = this.placed.get(row.index);
      // A LOOSE placement holds pixels and no cell: it is what the `no_icon_grid` control
      // produces, and it reserves nothing because it sits on no square.
      if (held && !held.loose) taken.add(key(held));
    }
    // MEASURED ONCE. `#grid` reads `getBoundingClientRect`, which forces layout, and this used to
    // call it twice per icon inside the scan — up to 52 forced reads for a desktop of 26 rows,
    // during the render those reads are part of.
    const grid = this.#grid();
    const total = grid.cols * grid.rows;
    let next = 0;
    const boxFor = (row) => {
      const held = this.placed.get(row.index);
      if (held && held.loose) return { x: held.x, y: held.y };
      if (held) return boxForCell(held);
      while (next < total && taken.has(key(slotCell(next, grid)))) next += 1;
      const cell = slotCell(next, grid);
      next += 1;
      taken.add(key(cell));
      return boxForCell(cell);
    };
    visible.forEach((row) => {
      const at = boxFor(row);
      const cell = document.createElement("div");
      cell.className = "desk-icon";
      cell.dataset.index = String(row.index);
      cell.dataset.disabled = (row.flags & WITEM_DISABLED) ? "1" : "0";
      cell.dataset.container = (row.flags & WITEM_CONTAINER) ? "1" : "0";
      cell.style.left = `${Math.round(at.x)}px`;
      cell.style.top = `${Math.round(at.y)}px`;
      cell.setAttribute("role", "option");
      cell.setAttribute("aria-selected", this.selection.has(row.index) ? "true" : "false");
      cell.classList.toggle("is-selected", this.selection.has(row.index));
      cell.innerHTML = iconMarkup(row.icon, ICON_PX);
      const label = document.createElement("span");
      label.className = "desk-label";
      // TEXT AND NEVER HTML: the label came from a program.
      label.textContent = row.label;
      cell.append(label);
      this.el.append(cell);
    });
    this.el.dataset.icons = String(visible.length);
    return visible.length;
  }

  /* ---- the selection ------------------------------------------------------------------------- */

  /** Set the selection and redraw the marks. The ONE writer, so "what is selected" and "what looks
   *  selected" cannot drift. */
  select(indexes, { add = false } = {}) {
    if (!add) this.selection.clear();
    for (const index of indexes) this.selection.add(index | 0);
    for (const cell of this.el.querySelectorAll(".desk-icon")) {
      const on = this.selection.has(Number(cell.dataset.index));
      cell.classList.toggle("is-selected", on);
      cell.setAttribute("aria-selected", on ? "true" : "false");
    }
    this.el.dataset.selected = [...this.selection].sort((a, b) => a - b).join(",");
    return [...this.selection];
  }

  /** Activate a row: report it to the kernel, which validates the index and queues `WEV_ITEM` on
   *  the publishing window's own fd. NOTHING IS LAUNCHED HERE — the publisher decides. */
  activate(index) {
    const row = this.rows[index | 0];
    if (!row) return false;
    if (row.flags & WITEM_DISABLED) return false;
    this.stats.activations += 1;
    this.host.activateItem(this.win, index | 0, WITEM_DESKTOP);
    return true;
  }

  /* ---- the gestures -------------------------------------------------------------------------- */

  #iconAt(target) {
    const cell = target && target.closest ? target.closest(".desk-icon") : null;
    return cell ? { cell, index: Number(cell.dataset.index) } : null;
  }

  /**
   * The icon under a CLIENT POINT, which is the fallback a retargeted event needs.
   *
   * MEASURED, AND IT COST A RUN: a press on an icon takes a pointer capture (so a drag that leaves
   * the view keeps arriving), and Chrome dispatches the compatibility mouse events — `mouseup`,
   * `click`, `dblclick` — at the CAPTURE element rather than at the element under the pointer. So
   * `dblclick.target` is the icon VIEW, `closest('.desk-icon')` is null, and a double-click that
   * landed squarely on an icon activated nothing. The view's own counters said so: two clicks, zero
   * activations.
   */
  #iconAtPoint(x, y) {
    for (const cell of this.el.querySelectorAll(".desk-icon")) {
      const r = cell.getBoundingClientRect();
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) {
        return { cell, index: Number(cell.dataset.index) };
      }
    }
    return null;
  }

  /** By target first, by coordinates second. The target is right whenever it is available, and the
   *  coordinates are right when a capture has moved it. */
  #iconFor(event) {
    return this.#iconAt(event.target) || this.#iconAtPoint(event.clientX, event.clientY);
  }

  /**
   * A press: on an icon it selects and may begin a drag; on bare desktop it begins a rubber band.
   *
   * THE BAND ONLY BEGINS AFTER `BAND_PX` OF TRAVEL, so a plain click on the wallpaper still means
   * "clear the selection" — a hand that moves two pixels during a click is a click.
   */
  #press(event) {
    if (event.button !== 0) return;
    if (!this.menuEl.hidden) this.#closeMenu();
    const hit = this.#iconAt(event.target);
    this.stats.clicks += 1;
    if (hit) {
      // CTRL ADDS AND A PLAIN CLICK REPLACES, which is every file manager's contract. A press on
      // an icon that is already in a multiple selection keeps the selection, so a drag can move
      // all of it.
      if (event.ctrlKey || event.metaKey) {
        if (this.selection.has(hit.index)) {
          this.selection.delete(hit.index);
          this.select([], { add: true });
        } else {
          this.select([hit.index], { add: true });
        }
      } else if (!this.selection.has(hit.index)) {
        this.select([hit.index]);
      }
      this.#beginIconDrag(event, hit);
      return;
    }
    this.#beginBand(event);
  }

  /** Drag the selection. Icons follow the pointer while the button is down and SNAP TO THE GRID
   *  when they are let go — Windows 7's "Align icons to grid", which is on by default there. The
   *  arrangement is the view's own, which is why `placed` is keyed by publisher index; it holds a
   *  CELL and not a pixel, so a desktop that is resized re-lays the arrangement out instead of
   *  stranding an icon off the edge. */
  #beginIconDrag(event, hit) {
    const moving = [...(this.selection.size ? this.selection : [hit.index])];
    const from = new Map();
    for (const index of moving) {
      const cell = this.el.querySelector(`.desk-icon[data-index="${index}"]`);
      if (!cell) continue;
      from.set(index, { x: parseFloat(cell.style.left) || 0, y: parseFloat(cell.style.top) || 0 });
    }
    const gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    const move = (e) => {
      if (e.pointerId !== gesture.id) return;
      const dx = e.clientX - gesture.x;
      const dy = e.clientY - gesture.y;
      if (!gesture.moved && Math.abs(dx) + Math.abs(dy) < BAND_PX) return;
      gesture.moved = true;
      const r = this.el.getBoundingClientRect();
      for (const [index, at] of from) {
        const cell = this.el.querySelector(`.desk-icon[data-index="${index}"]`);
        if (!cell) continue;
        // CLAMPED INTO THE VIEW, for the window clamp's reason: an icon dragged off the desktop is
        // an icon nobody can get back.
        const x = Math.min(Math.max(at.x + dx, 0), Math.max(r.width - ICON_CELL_W, 0));
        const y = Math.min(Math.max(at.y + dy, 0), Math.max(r.height - ICON_CELL_H, 0));
        cell.style.left = `${Math.round(x)}px`;
        cell.style.top = `${Math.round(y)}px`;
        // NOT WRITTEN TO `placed` HERE. The arrangement is what the icon LANDS on, and recording
        // every intermediate pixel would make a cancelled drag an arrangement too.
      }
    };
    const up = (e) => {
      if (e.pointerId !== gesture.id) return;
      if (gesture.moved) {
        this.stats.drags += 1;
        this.#dropOnGrid(from, e.clientX - gesture.x, e.clientY - gesture.y);
      }
      this.el.removeEventListener("pointermove", move);
      this.el.removeEventListener("pointerup", up);
      this.el.removeEventListener("pointercancel", up);
    };
    this.el.addEventListener("pointermove", move);
    this.el.addEventListener("pointerup", up);
    this.el.addEventListener("pointercancel", up);
    try {
      this.el.setPointerCapture(event.pointerId);
    } catch (error) {
      // A pointerId no live pointer owns throws in Firefox and not in Chrome (constraint 175). The
      // listeners are already on, so the drag still works without the capture.
      this.lastCaptureError = `${error.name}: ${error.message}`;
    }
  }

  /**
   * WHERE A DROP LANDS: the nearest free cell to the pixel the hand let go on.
   *
   * The occupancy is built from the icons that are NOT part of this gesture, and each dropped icon
   * is added as it lands, so a selection of several dragged together cannot be given one square.
   * The asks are resolved in the order the rows are published, which makes the outcome of a
   * multiple drop a function of the list rather than of a Set's iteration order.
   *
   * `snapToGrid` off is a negative control, not a preference: it restores the old behaviour — the
   * raw pixel the pointer left the icon on — so a run can show the grid clauses are coupled to the
   * snapping and not to something that happens to be true of any drop.
   */
  #dropOnGrid(from, dx, dy) {
    const r = this.el.getBoundingClientRect();
    const key = (cell) => `${cell.col},${cell.row}`;
    const moving = new Set(from.keys());
    const taken = new Set();
    const visible = this.#visible();
    let next = 0;
    for (const row of visible) {
      if (moving.has(row.index)) continue;
      const held = this.placed.get(row.index);
      if (held && !held.loose) {
        taken.add(key(held));
        continue;
      }
      if (held) continue;
      // An un-dragged icon's cell is the one `render` will give it, which is the next free slot.
      const total = this.#grid().cols * this.#grid().rows;
      while (next < total && taken.has(key(this.#slotCell(next)))) next += 1;
      taken.add(key(this.#slotCell(next)));
      next += 1;
    }
    for (const row of visible) {
      if (!moving.has(row.index)) continue;
      const at = from.get(row.index);
      if (!at) continue;
      const x = Math.min(Math.max(at.x + dx, 0), Math.max(r.width - ICON_CELL_W, 0));
      const y = Math.min(Math.max(at.y + dy, 0), Math.max(r.height - ICON_CELL_H, 0));
      if (!viewControls.snapToGrid) {
        this.placed.set(row.index, { x: Math.round(x), y: Math.round(y), loose: true });
        continue;
      }
      const got = this.#freeCell(this.#cellAt(x, y), taken);
      taken.add(key(got));
      this.placed.set(row.index, got);
    }
    this.render();
  }

  /** The rubber band: a marquee over the bare desktop, selecting everything it touches. */
  #beginBand(event) {
    const r = this.el.getBoundingClientRect();
    const start = { x: event.clientX - r.left, y: event.clientY - r.top };
    const gesture = { id: event.pointerId, banding: false };
    const move = (e) => {
      if (e.pointerId !== gesture.id) return;
      const now = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (!gesture.banding
        && Math.abs(now.x - start.x) + Math.abs(now.y - start.y) < BAND_PX) return;
      if (!gesture.banding) {
        gesture.banding = true;
        this.stats.bands += 1;
        this.bandEl.hidden = false;
      }
      const box = {
        x: Math.min(start.x, now.x), y: Math.min(start.y, now.y),
        w: Math.abs(now.x - start.x), h: Math.abs(now.y - start.y),
      };
      this.bandEl.style.left = `${Math.round(box.x)}px`;
      this.bandEl.style.top = `${Math.round(box.y)}px`;
      this.bandEl.style.width = `${Math.round(box.w)}px`;
      this.bandEl.style.height = `${Math.round(box.h)}px`;
      // EVERYTHING THE BAND TOUCHES, measured against each icon's own rect: an intersection and
      // not containment, which is what a user expects of a marquee.
      const inside = [];
      for (const cell of this.el.querySelectorAll(".desk-icon")) {
        const c = cell.getBoundingClientRect();
        const cx = c.left - r.left;
        const cy = c.top - r.top;
        const hits = cx < box.x + box.w && cx + c.width > box.x
          && cy < box.y + box.h && cy + c.height > box.y;
        if (hits) inside.push(Number(cell.dataset.index));
      }
      this.select(inside, { add: e.ctrlKey === true });
    };
    const up = (e) => {
      if (e.pointerId !== gesture.id) return;
      // A PRESS THAT NEVER BECAME A BAND IS A CLICK ON THE WALLPAPER, which clears the selection.
      if (!gesture.banding) this.select([]);
      this.bandEl.hidden = true;
      this.el.removeEventListener("pointermove", move);
      this.el.removeEventListener("pointerup", up);
      this.el.removeEventListener("pointercancel", up);
    };
    this.el.addEventListener("pointermove", move);
    this.el.addEventListener("pointerup", up);
    this.el.addEventListener("pointercancel", up);
    try {
      this.el.setPointerCapture(event.pointerId);
    } catch (error) {
      this.lastCaptureError = `${error.name}: ${error.message}`;
    }
  }

  /** A DOUBLE-CLICK OPENS, which is the one gesture everybody tries first. `dblclick` and not a
   *  hand-rolled timer: the browser already owns how fast two clicks are one gesture. */
  #dblclick(event) {
    const hit = this.#iconFor(event);
    if (!hit) return;
    event.preventDefault();
    this.activate(hit.index);
  }

  /* ---- the two context menus ----------------------------------------------------------------- */

  #closeMenu() {
    this.menuEl.hidden = true;
    this.menuEl.textContent = "";
    this.menuEl.dataset.popup = "0";
  }

  #menuRow(label, onClick, data = {}) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "shell-row";
    const text = document.createElement("span");
    text.className = "shell-label";
    text.textContent = label;
    row.append(text);
    for (const [key, value] of Object.entries(data)) row.dataset[key] = String(value);
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
      this.#closeMenu();
    });
    this.menuEl.append(row);
    return row;
  }

  /**
   * Right-click. TWO MENUS, because there are two subjects: an icon's menu acts on the selection,
   * and the desktop's acts on the view.
   *
   * EVERY ROW DOES SOMETHING. A greyed row for a command this project does not have would be the
   * live-looking-button defect in a second place — so "New folder" and "Personalize" are absent
   * rather than disabled, and what is here is Open, Arrange icons and Select all.
   */
  #context(event) {
    event.preventDefault();
    this.#closeMenu();
    this.stats.menus += 1;
    const hit = this.#iconFor(event);
    const r = this.el.getBoundingClientRect();
    if (hit) {
      if (!this.selection.has(hit.index)) this.select([hit.index]);
      this.menuEl.dataset.popup = "icon";
      const many = this.selection.size > 1;
      this.#menuRow(many ? `Open ${this.selection.size} items` : "Open", () => {
        for (const index of [...this.selection]) this.activate(index);
      }, { menuOpen: 1 });
    } else {
      this.select([]);
      this.menuEl.dataset.popup = "desktop";
      this.#menuRow("Arrange icons", () => {
        // THE ARRANGEMENT IS THE VIEW'S, so putting it back is forgetting the dragged positions.
        this.placed.clear();
        this.render();
      }, { menuArrange: 1 });
      this.#menuRow("Select all", () => {
        this.select(this.#visible().map((row) => row.index));
      }, { menuSelectAll: 1 });
    }
    this.menuEl.hidden = false;
    const box = this.menuEl.getBoundingClientRect();
    const x = Math.min(event.clientX - r.left, Math.max(r.width - box.width - 4, 0));
    const y = Math.min(event.clientY - r.top, Math.max(r.height - box.height - 4, 0));
    this.menuEl.style.left = `${Math.round(x)}px`;
    this.menuEl.style.top = `${Math.round(y)}px`;
    this.menuEl.style.bottom = "auto";
    return this.menuEl.dataset.popup;
  }

  /**
   * The keyboard spelling of all of it, because every gesture in this project has one (WCAG SC
   * 2.1.1) and because a check can then drive it with real trusted keys: arrows move the
   * selection, Enter opens it, Escape clears it.
   */
  #key(event) {
    const visible = this.#visible();
    if (!visible.length) return;
    const order = visible.map((row) => row.index);
    const current = [...this.selection].sort((a, b) => a - b);
    const at = current.length ? order.indexOf(current[current.length - 1]) : -1;
    if (event.key === "Enter") {
      event.preventDefault();
      this.stats.keys += 1;
      for (const index of current) this.activate(index);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.select([]);
      return;
    }
    const step = { ArrowDown: 1, ArrowUp: -1, ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    this.stats.keys += 1;
    const next = at < 0 ? 0 : Math.min(Math.max(at + step, 0), order.length - 1);
    this.select([order[next]]);
  }

  report() {
    return {
      ...this.stats,
      win: this.win,
      items: this.rows.length,
      icons: this.el.querySelectorAll(".desk-icon").length,
      labels: [...this.el.querySelectorAll(".desk-label")].map((n) => n.textContent),
      selected: [...this.selection].sort((a, b) => a - b),
      /* THE ARRANGEMENT, AS CELLS AND AS PIXELS. A check needs both: the cell is what the view
       * decided, the pixel is what the reader sees, and asserting only the first would pass for a
       * grid whose own cell-to-pixel map is wrong. */
      placed: Object.fromEntries([...this.placed]),
      grid: { ...this.#grid(), pad: PAD, cellW: ICON_CELL_W, cellH: ICON_CELL_H },
      cells: [...this.el.querySelectorAll(".desk-icon")].map((node) => ({
        index: Number(node.dataset.index),
        x: parseFloat(node.style.left) || 0,
        y: parseFloat(node.style.top) || 0,
      })),
      menu: this.menuEl.hidden ? "" : (this.menuEl.dataset.popup || ""),
      menuRows: [...this.menuEl.querySelectorAll(".shell-label")].map((n) => n.textContent),
      banding: this.bandEl.hidden === false,
      lastCaptureError: this.lastCaptureError || "",
    };
  }

  destroy() {
    this.el.remove();
  }
}
