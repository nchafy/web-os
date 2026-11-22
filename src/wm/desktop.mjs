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

  /**
   * Where an icon goes if nobody has dragged it: down the first column, then the next, which is
   * Windows 7's own order and is why a desktop with eleven icons has them beside each other rather
   * than wrapped across the top.
   */
  #cell(slot) {
    const r = this.el.getBoundingClientRect();
    const rows = Math.max(1, Math.floor((r.height - PAD * 2) / ICON_CELL_H));
    const col = Math.floor(slot / rows);
    const row = slot % rows;
    return { x: PAD + col * ICON_CELL_W, y: PAD + row * ICON_CELL_H };
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
    visible.forEach((row, slot) => {
      const at = this.placed.get(row.index) || this.#cell(slot);
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

  /** Drag the selection. Icons move by the pointer's delta and stay where they are let go — the
   *  view's own arrangement, which is why `placed` is keyed by publisher index. */
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
        this.placed.set(index, { x: Math.round(x), y: Math.round(y) });
      }
    };
    const up = (e) => {
      if (e.pointerId !== gesture.id) return;
      if (gesture.moved) this.stats.drags += 1;
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
      placed: Object.fromEntries([...this.placed]),
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
