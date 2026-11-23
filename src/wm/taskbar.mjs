// M14: the Superbar — the taskbar, its grouped buttons, their hover thumbnails and jump lists, the
// start menu, and the tray with its clock and Show desktop.
//
// THERE IS NO SYSCALL IN THIS FILE. It is handed a `WinHost` and talks to the kernel only through
// it: `askState` to minimize or restore, `win-raise` to bring a window up, `activateItem` to report
// that one of a window's published rows was clicked. Every one of those is an ASK — the kernel owns
// the stack, the show state and the meaning of a row (constraints 226, 271) — so nothing here
// decides anything a program could disagree with.
//
// ## Why the shell is page-side, and what that costs
//
// `docs/research/09-hobbyist-os-actions.md` §4 records that a taskbar needs cross-process window
// enumeration no ordinary client may have, and that SerenityOS answers it with a SECOND, separately
// gated management endpoint. This project needs no such endpoint, for a reason that is specific to
// its architecture rather than a shortcut: the page ALREADY holds every window's frame. `win-create`
// built it, `win-stack` ordered it, `win-title` named it — so a taskbar rendered by the page reads
// facts the page was already told, and adds no capability to anything. A taskbar as a PROCESS would
// need the endpoint, and that is the trade recorded as `docs/DECISIONS.md` D39.
//
// What it costs is stated rather than hidden: the display list has no text and no image op
// (`src/abi.mjs` DL_*), and a `WEV_POINTER` is only delivered while a button is down
// (`src/wm/winhost.mjs`) — so a process-drawn Superbar could have neither labels nor hover, which
// are two of the three things a Superbar IS.
//
// ## What the kernel still owns
//
//   a click on a button      -> `win-raise` or `win-show-ask`, and the kernel answers
//   a jump-list row          -> `win-item-ask`, and the kernel validates the INDEX
//   Show desktop             -> one `win-show-ask` per window, each of which the kernel may refuse
//   the window list          -> `host.frames`, which is the kernel's own `win-create` log
//
// The one thing this file decides for itself is WHICH BUTTON IS WHICH: windows are grouped by the
// program behind them, which the kernel reports in `win-create` (`prog`) because the page cannot
// learn it — a title is whatever a program says it is.

import {
  WST_NORMAL, WST_MIN, WST_MAX, WITEM_DESKTOP, WITEM_JUMP, WITEM_MENU, WITEM_SEPARATOR,
  WITEM_DISABLED, WROLE_DESKTOP, WICON_PROGRAM,
} from "../abi.mjs";
// `progName` AND `iconForProgram` ARE THE ICON MODULE'S, because a window's CAPTION needs the
// same answer this bar does — see `iconForProgram`'s own note.
import { iconMarkup, iconForProgram, progName } from "./icons.mjs";
import { TASKBAR_H, THUMB_W, THUMB_H } from "./aero.mjs";

/** How long the pointer must rest on a button before its thumbnails appear. Windows 7 waits about
 *  this long; shorter and the previews flash past as the pointer crosses the bar. */
const HOVER_MS = 120;

/**
 * HOW LONG A THUMBNAIL PANEL SURVIVES THE POINTER LEAVING THE BUTTON.
 *
 * It used to be zero — `pointerleave` on the button closed the panel at once — and that made the
 * panel UNREACHABLE: it sits `TASKBAR_H + 6` px above the bar, so moving the pointer up from the
 * button to a thumbnail crosses a gap where the pointer is over neither, and the panel closed in
 * that gap every time. Reported as "I am unable to scroll up to focus on a specific process",
 * which is exactly what it looks like from the outside.
 *
 * Windows 7 gives the same flyout a grace period and so does this: the close is scheduled rather
 * than done, and entering either the button or the panel cancels it. 400 ms is long enough to
 * cross 6 px with a hand and short enough that a panel does not linger over the desktop.
 */
const HOVER_CLOSE_MS = 400;

/**
 * M14's THIRD NEGATIVE CONTROL: the bar draws one button per WINDOW instead of one per program.
 *
 * That is the pre-Windows-7 taskbar, and it is the plausible implementation — every window is a
 * button, which is simpler and is what a page with no `prog` field could do. What it loses is the
 * whole of what a Superbar IS: two terminals become two buttons, the bar fills up at a dozen
 * windows, and the window list that answers "which of these three" never appears.
 *
 * Module-level and page-side, which is `setGeometryControls`'s shape and for its reason: nothing
 * in `src/wm/` is reachable from a process, and the page is the supervisor.
 */
let shellControls = { noGroup: false };

export function setShellControls(opts = {}) {
  shellControls = { noGroup: opts.noGroup === true };
  return { ...shellControls };
}

export function shellControlsInForce() {
  return { ...shellControls };
}

/* What a thumbnail is drawn out of. A preview at `THUMB_W`x`THUMB_H` is a picture of a window and
 * not a readable page, so these are sized to make it RECOGNISABLE: a caption strip deep enough for
 * a title, and a body line height small enough that a terminal's text reads as the texture it is.
 * How MANY lines fit is derived from the space left, never written — see `#drawThumb`. */
const THUMB_CAP_H = 15;
const THUMB_TITLE_PX = 9;
const THUMB_TEXT_PX = 6;
const THUMB_LEAD = 7;
const THUMB_COLS = 62;
const THUMB_UI_FONT = '"Segoe UI", system-ui, -apple-system, sans-serif';

export class Taskbar {
  /**
   * `spec.into` is the desktop element and `spec.host` the `WinHost` whose frames this shell
   * renders — and nothing else.
   *
   * THERE IS NO LAUNCH CALLBACK, and there was one: read from the spec, stored, and never called.
   * A start-menu row posts `win-item-ask` and the PUBLISHING PROCESS spawns, which is the whole
   * point of `win_items` — so a second route would have been a way for the page to start programs
   * on its own. A critic found it before it became one.
   */
  constructor(spec) {
    this.into = spec.into;
    this.host = spec.host;
    /** The popup that is open, as `{kind, win}` or null. ONE AT A TIME, because every one of them
     *  is a menu and two open menus is a state a user cannot get out of by clicking elsewhere. */
    this.open = null;
    this.hoverTimer = 0;
    /** A SCHEDULED close, so the button and its panel are one hover target. HOVER_CLOSE_MS. */
    this.closeTimer = 0;
    this.peeking = false;
    this.stats = {
      syncs: 0, buttonClicks: 0, raises: 0, minimizes: 0, restores: 0,
      jumpOpens: 0, jumpClicks: 0, menuOpens: 0, windowMenus: 0, launches: 0, thumbOpens: 0,
      peeks: 0, showDesktops: 0, closes: 0,
    };
    this.#build();
    /* THE STRIP IS RESERVED BEFORE THE FIRST SYNC, so the work area is right from the first frame:
     * a maximized window laid out before this call is a window covering the taskbar. `reserve`
     * re-clamps every existing frame, which is M13's `relayout` doing the job it was written for. */
    this.host.reserve(TASKBAR_H);
    /** The watcher, KEPT so `dispose` can take it off again. */
    this.watcher = this.host.watch(() => this.sync());
    // THE HOST LEARNS OF THE SHELL HERE, which is what lets a right-click on a caption reach a
    // menu: the frame asks the host and the host asks whatever shell exists.
    this.host.useShell(this);
    this.sync();
    this.#startClock();
  }

  #build() {
    const bar = document.createElement("div");
    // `aero-strip` IS THE GLASS, shared with the window frame's four strips: one definition of what
    // glass is, so the bar cannot drift from the windows above it.
    bar.className = "taskbar aero-strip";
    bar.dataset.taskbar = "1";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Taskbar");
    for (const cls of ["aero-sheen", "aero-light"]) {
      const layer = document.createElement("div");
      layer.className = cls;
      layer.style.position = "absolute";
      layer.setAttribute("aria-hidden", "true");
      bar.append(layer);
    }

    this.startBtn = document.createElement("button");
    this.startBtn.type = "button";
    this.startBtn.className = "taskbar-start";
    this.startBtn.dataset.start = "1";
    this.startBtn.setAttribute("aria-label", "Start");
    this.startBtn.innerHTML = iconMarkup(WICON_PROGRAM, 22);
    this.startBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleStart();
    });

    this.band = document.createElement("div");
    this.band.className = "taskbar-band";
    this.band.dataset.band = "1";

    const tray = document.createElement("div");
    tray.className = "tray";
    tray.dataset.tray = "1";
    this.clockEl = document.createElement("div");
    this.clockEl.className = "clock";
    this.clockEl.dataset.clock = "1";
    this.clockEl.setAttribute("role", "status");
    this.showBtn = document.createElement("button");
    this.showBtn.type = "button";
    this.showBtn.className = "show-desktop";
    this.showBtn.dataset.showDesktop = "1";
    this.showBtn.setAttribute("aria-label", "Show desktop");
    /* HOVER PEEKS AND CLICK MINIMIZES, which is Windows 7's own pair and is why both are wired to
     * this one button: peek is a look and the click is the action. */
    this.showBtn.addEventListener("pointerenter", () => this.peek(true));
    this.showBtn.addEventListener("pointerleave", () => this.peek(false));
    this.showBtn.addEventListener("focus", () => this.peek(true));
    this.showBtn.addEventListener("blur", () => this.peek(false));
    this.showBtn.addEventListener("click", () => this.showDesktop());
    tray.append(this.clockEl, this.showBtn);

    bar.append(this.startBtn, this.band, tray);
    this.el = bar;
    this.into.append(bar);

    /** The one popup element, reused by the jump list, the window list and the start menu: they
     *  are one panel in Windows 7 too, and one element means one thing to close. */
    this.popup = document.createElement("div");
    this.popup.className = "shell-popup";
    this.popup.dataset.popup = "0";
    this.popup.hidden = true;
    this.into.append(this.popup);

    /* THE PANEL IS PART OF ITS OWN HOVER TARGET. Without these two the grace period above would
     * only delay the problem: the panel would close 400 ms after the pointer reached it. */
    this.popup.addEventListener("pointerenter", () => this.#holdHover());
    this.popup.addEventListener("pointerleave", () => this.#hoverOut());

    /* A CLICK ANYWHERE ELSE CLOSES THE MENU, and Escape does too. On the DESKTOP and not the
     * document: this shell may be one of several on a page, and a listener on the document would
     * close another desktop's menu. */
    this.into.addEventListener("pointerdown", (e) => {
      if (this.popup.hidden) return;
      if (this.popup.contains(e.target)) return;
      if (this.el.contains(e.target)) return;
      this.closePopup();
    }, true);
    this.into.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.popup.hidden) {
        e.preventDefault();
        this.closePopup();
      }
    });
  }

  /* ---- the clock ----------------------------------------------------------------------------- */

  /** The tray clock, on a one-second interval. A REAL CLOCK and not a frozen picture of one: the
   *  tray is the one part of this shell a reader checks against their own wrist. */
  #startClock() {
    const tick = () => {
      const now = new Date();
      this.clockEl.textContent = "";
      const time = document.createElement("div");
      time.className = "clock-time";
      time.textContent = now.toLocaleTimeString(undefined,
        { hour: "2-digit", minute: "2-digit" });
      const date = document.createElement("div");
      date.className = "clock-date";
      date.textContent = now.toLocaleDateString(undefined,
        { day: "2-digit", month: "2-digit", year: "numeric" });
      this.clockEl.append(time, date);
      this.clockEl.dataset.epoch = String(now.getTime());
    };
    tick();
    this.clockTimer = setInterval(tick, 1000);
  }

  /* ---- the buttons --------------------------------------------------------------------------- */

  /**
   * The window groups this bar is showing: one row per program, each holding its windows in winid
   * order.
   *
   * THE DESKTOP IS NOT IN IT. A desktop window has no button — it is the surface the buttons sit
   * over — and `WROLE_DESKTOP` is how this file knows that without a convention about titles.
   */
  groups() {
    const by = new Map();
    for (const [id, entry] of this.host.frames) {
      if (entry.role === WROLE_DESKTOP) continue;
      // THE KEY IS THE PROGRAM, which is what makes this a Superbar. The control keys by WINDOW
      // instead, which is the pre-Windows-7 bar: one button each, and no window list.
      const key = shellControls.noGroup
        ? `${progName(entry.prog) || "window"} ${id}`
        : (progName(entry.prog) || `pid ${entry.pid}`);
      if (!by.has(key)) by.set(key, { key, prog: entry.prog, wins: [] });
      by.get(key).wins.push({ id, entry });
    }
    for (const group of by.values()) group.wins.sort((a, b) => a.id - b.id);
    return [...by.values()];
  }

  /** The window the kernel has on top, or 0. The order is the KERNEL's — `host.order` is what it
   *  last sent — because a button's "active" cue must agree with what is actually in front. */
  topmost() {
    for (let i = this.host.order.length - 1; i >= 0; i -= 1) {
      const entry = this.host.get(this.host.order[i]);
      if (!entry || entry.role === WROLE_DESKTOP) continue;
      if (entry.state === WST_MIN) continue;
      return entry.id;
    }
    return 0;
  }

  /** The rendered button standing for a group, found by WALKING the band rather than by querying
   *  with a string a program chose. */
  #buttonFor(group) {
    for (const btn of this.band.querySelectorAll("[data-task-btn]")) {
      if (btn.dataset.taskBtn === group.key) return btn;
    }
    return null;
  }

  /** Rebuild the band. Called on every window-table change, which is what `WinHost.watch` is. */
  sync() {
    this.stats.syncs += 1;
    const top = this.topmost();
    this.band.textContent = "";
    for (const group of this.groups()) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "task-btn";
      btn.dataset.taskBtn = group.key;
      btn.dataset.wins = group.wins.map((w) => w.id).join(",");
      const icon = iconForProgram(group.prog);
      const live = group.wins.filter((w) => w.entry.state !== WST_MIN);
      const active = group.wins.some((w) => w.id === top);
      const allMin = live.length === 0;
      btn.classList.toggle("is-active", active);
      btn.classList.toggle("is-minimized", allMin);
      btn.classList.toggle("is-group", group.wins.length > 1);
      btn.dataset.state = allMin ? "min" : (active ? "active" : "idle");
      // THE ICON IS MARKUP AND THE LABEL IS TEXT. The label comes from a program's own title, so it
      // is set as `textContent` and never as HTML — one assignment is the whole of what keeps a
      // window title from being a script.
      btn.innerHTML = iconMarkup(icon, 20);
      const label = document.createElement("span");
      label.className = "task-label";
      label.textContent = group.wins.length === 1
        ? (group.wins[0].entry.win.titleText || group.key)
        : group.key;
      btn.append(label);
      if (group.wins.length > 1) {
        const count = document.createElement("span");
        count.className = "task-count";
        count.textContent = String(group.wins.length);
        btn.append(count);
      }
      /* THE BUTTON TRAVELS WITH THE CLICK, rather than being found again by a selector built from
       * the group's key. The key is `progName(prog)`, which is the basename of ARGV[0] — chosen by
       * whatever process called `spawn` — so interpolating it into a `querySelector` let a program
       * with a quote in its argv throw a SyntaxError inside this handler. A critic found it. */
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.clickGroup(group, btn);
      });
      /* THE JUMP LIST OPENS ON THE RIGHT BUTTON'S PRESS, which is Windows 7's own timing and is
       * also the only signal that reliably exists: a `contextmenu` event is produced by the
       * BROWSER's own input pipeline, and `Input.dispatchMouseEvent` with `button: "right"` does
       * not generate one — measured, as a jump-list proof that found `jumpOpens: 0` after a real
       * right-press landed on the button. `pointerdown` with `button === 2` is the event that
       * actually arrives, from a hand and from a driver alike. */
      btn.addEventListener("pointerdown", (e) => {
        if (e.button !== 2) return;
        e.preventDefault();
        e.stopPropagation();
        this.openJumpList(group, btn);
      });
      // And the browser's own menu is refused, or a right-click would show Chrome's.
      btn.addEventListener("contextmenu", (e) => e.preventDefault());
      /* AND IT HAS A KEYBOARD SPELLING, because every gesture in this shell does: Shift+F10 and
       * the Menu key are the platform's own bindings for "the context menu of what has focus", and
       * a taskbar button is a real `<button>` that can take focus. */
      btn.addEventListener("keydown", (e) => {
        const wants = e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
        if (!wants) return;
        e.preventDefault();
        this.openJumpList(group, btn);
      });
      btn.addEventListener("pointerenter", () => this.#hoverIn(group, btn));
      btn.addEventListener("pointerleave", () => this.#hoverOut());
      this.band.append(btn);
    }
    // A POPUP OUTLIVES A REBUILD ONLY IF ITS WINDOW DOES. A jump list for a window that has just
    // closed is a menu of commands nothing can carry out.
    if (this.open && this.open.win && !this.host.get(this.open.win)) this.closePopup();
    return this.band.children.length;
  }

  /**
   * A click on a group's button. Windows 7's own three-way behaviour, which is the part people
   * notice when it is missing:
   *
   *   every window minimized  -> restore them and raise the last one
   *   the group is in front   -> minimize it
   *   otherwise               -> raise it
   *
   * A GROUP OF SEVERAL IN FRONT SHOWS ITS WINDOW LIST instead of minimizing, because "which of
   * these three" is a question a click cannot answer.
   */
  clickGroup(group, anchor = null) {
    this.stats.buttonClicks += 1;
    this.closePopup();
    const top = this.topmost();
    const live = group.wins.filter((w) => w.entry.state !== WST_MIN);
    if (live.length === 0) {
      for (const w of group.wins) this.host.askState(w.id, WST_NORMAL);
      this.host.post({ t: "win-raise", win: group.wins[group.wins.length - 1].id });
      this.stats.restores += 1;
      return "restore";
    }
    const inFront = group.wins.some((w) => w.id === top);
    if (inFront && group.wins.length > 1) {
      this.openWindowList(group, anchor);
      return "list";
    }
    if (inFront) {
      this.host.askState(top, WST_MIN);
      this.stats.minimizes += 1;
      return "minimize";
    }
    const want = live[live.length - 1];
    this.host.post({ t: "win-raise", win: want.id });
    this.stats.raises += 1;
    return "raise";
  }

  /* ---- the popups ---------------------------------------------------------------------------- */

  closePopup() {
    // BOTH TIMERS GO WITH IT. A pending open would re-create the panel after it was closed, and a
    // pending close would fire against whatever is open next.
    clearTimeout(this.hoverTimer);
    clearTimeout(this.closeTimer);
    this.closeTimer = 0;
    this.popup.hidden = true;
    this.popup.textContent = "";
    this.popup.dataset.popup = "0";
    this.open = null;
  }

  /** Put the popup above a button, kept inside the desktop. A menu that opened off the edge of the
   *  screen would be a menu with rows nobody can reach. */
  #placeAbove(anchor) {
    const desk = this.into.getBoundingClientRect();
    const at = anchor.getBoundingClientRect();
    this.popup.hidden = false;
    const box = this.popup.getBoundingClientRect();
    const x = Math.min(Math.max(at.left - desk.left, 4), Math.max(desk.width - box.width - 4, 4));
    this.popup.style.left = `${Math.round(x)}px`;
    this.popup.style.bottom = `${TASKBAR_H + 6}px`;
    this.popup.style.top = "auto";
  }

  /** One row of a popup: an icon, a label, and what to do. Returns the button so a caller can mark
   *  it. */
  #row(parent, { icon, label, disabled = false, onClick = null, data = {} }) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "shell-row";
    if (icon !== undefined && icon !== null) row.innerHTML = iconMarkup(icon, 16);
    const text = document.createElement("span");
    text.className = "shell-label";
    // TEXT, NOT HTML: every label here came from a program.
    text.textContent = label;
    row.append(text);
    for (const [key, value] of Object.entries(data)) row.dataset[key] = String(value);
    if (disabled) row.disabled = true;
    if (onClick && !disabled) {
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });
    }
    parent.append(row);
    return row;
  }

  #separator(parent) {
    const line = document.createElement("div");
    line.className = "shell-sep";
    line.setAttribute("aria-hidden", "true");
    parent.append(line);
    return line;
  }

  /**
   * The jump list: the rows this group's windows published with `WITEM_JUMP`, then Close.
   *
   * THE ROWS ARE THE PROGRAM'S AND THE CLOSE IS THE SHELL'S, and the division is not cosmetic: a
   * row posts `win-item-ask` and the program decides what it means, where Close posts a `WEV_CLOSE`
   * the program may REFUSE (constraint 44). A jump list that could kill a window would be a way
   * around the close contract.
   */
  openJumpList(group, anchor) {
    this.closePopup();
    this.stats.jumpOpens += 1;
    this.popup.dataset.popup = "jump";
    this.popup.className = "shell-popup";
    const title = document.createElement("div");
    title.className = "shell-title";
    title.textContent = group.key;
    this.popup.append(title);
    /* THE FIRST WINDOW THAT PUBLISHED ROWS owns the list, and the first version took the NEWEST —
     * which found an empty list, because a program publishes its jump list once, on the window it
     * opened first. A jump list belongs to a PROGRAM in Windows 7 and this is the nearest honest
     * reading of that in an ABI where rows hang off a window. */
    const target = group.wins.find(
      (w) => (w.entry.items || []).some((row) => (row.flags & WITEM_JUMP) !== 0))
      || group.wins[group.wins.length - 1];
    const rows = (target.entry.items || [])
      .map((row, index) => ({ ...row, index }))
      .filter((row) => (row.flags & WITEM_JUMP) !== 0);
    for (const row of rows) {
      if (row.flags & WITEM_SEPARATOR) {
        this.#separator(this.popup);
        continue;
      }
      this.#row(this.popup, {
        icon: row.icon,
        label: row.label,
        disabled: (row.flags & WITEM_DISABLED) !== 0,
        data: { jumpIndex: row.index },
        onClick: () => {
          this.stats.jumpClicks += 1;
          this.host.activateItem(target.id, row.index, WITEM_JUMP);
          this.closePopup();
        },
      });
    }
    if (!rows.length) {
      this.#row(this.popup, {
        icon: null, label: "This program published no tasks", disabled: true,
        data: { jumpEmpty: 1 },
      });
    }
    this.#separator(this.popup);
    this.#row(this.popup, {
      icon: null,
      label: group.wins.length > 1 ? "Close all windows" : "Close window",
      data: { jumpClose: 1 },
      onClick: () => {
        this.stats.closes += 1;
        for (const w of group.wins) this.host.requestClose(w.id);
        this.closePopup();
      },
    });
    this.open = { kind: "jump", win: target.id };
    this.#placeAbove(anchor || this.el);
    return rows.length;
  }

  /** The window list: one thumbnail per window of a group. What a click on a group of several
   *  opens, and what hovering one shows. */
  openWindowList(group, anchor) {
    this.closePopup();
    this.stats.thumbOpens += 1;
    this.popup.dataset.popup = "thumbs";
    const strip = document.createElement("div");
    strip.className = "task-thumbs";
    for (const w of group.wins) {
      const cell = document.createElement("div");
      cell.className = "task-thumb";
      cell.dataset.thumbWin = String(w.id);
      const title = document.createElement("div");
      title.className = "thumb-title";
      title.textContent = w.entry.win.titleText || group.key;
      const canvas = document.createElement("canvas");
      canvas.width = THUMB_W;
      canvas.height = THUMB_H;
      cell.append(title, canvas);
      this.#drawThumb(w.entry, canvas);
      cell.addEventListener("click", (e) => {
        e.stopPropagation();
        if (w.entry.state === WST_MIN) this.host.askState(w.id, WST_NORMAL);
        this.host.post({ t: "win-raise", win: w.id });
        this.stats.raises += 1;
        this.closePopup();
      });
      strip.append(cell);
    }
    this.popup.append(strip);
    this.open = { kind: "thumbs", win: group.wins[0].id, group: group.key };
    // NO SELECTOR BUILT FROM A PROGRAM'S OWN STRING: see the click handler in `sync`.
    this.#placeAbove(anchor || this.#buttonFor(group) || this.el);
    return group.wins.length;
  }

  /**
   * A window's thumbnail, drawn into a canvas.
   *
   * WHAT A THUMBNAIL CAN AND CANNOT BE HERE, stated rather than discovered. A SURFACED window is
   * its own canvas, so `drawImage` is exact. A TEXT window is a DOM widget, and there is no way to
   * rasterise one from script — so its preview is its last few lines drawn small, which is a
   * READING of the window rather than a picture of it. Windows 7 gets a real DWM thumbnail; this is
   * the honest approximation, and it is labelled as one in `MILESTONES.md`.
   */
  #drawThumb(entry, canvas) {
    const g = canvas.getContext("2d");
    g.fillStyle = "#f4f7fb";
    g.fillRect(0, 0, canvas.width, canvas.height);
    if (entry.surface && entry.surface.el) {
      try {
        g.drawImage(entry.surface.el, 0, 0, canvas.width, canvas.height);
        canvas.dataset.thumb = "surface";
        return "surface";
      } catch (error) {
        // A canvas that cannot be read is not a reason to show nothing; fall through to the text
        // path, which at least names the window.
        canvas.dataset.thumbError = String(error && error.name);
      }
    }
    /* A MINIATURE WINDOW AND NOT A PAGE OF SHRUNKEN PROSE. Nine lines of 9 px text on a near-white
     * fill is what this drew before, and at 196x120 it reads as a blank white rectangle — which is
     * how it was reported. A preview at this size cannot be legible and Windows 7's is not either;
     * what it has to be is RECOGNISABLE as the window it stands for, so it is drawn as one: a
     * caption strip in the same blue, the title in it, and the text below as the texture it
     * becomes at this scale. The line count is DERIVED from the space left, never written. */
    const cap = THUMB_CAP_H;
    const grad = g.createLinearGradient(0, 0, 0, cap);
    grad.addColorStop(0, "#dceaf7");
    grad.addColorStop(1, "#9ec0dd");
    g.fillStyle = grad;
    g.fillRect(0, 0, canvas.width, cap);
    g.fillStyle = "rgba(10,30,52,.35)";
    g.fillRect(0, cap - 1, canvas.width, 1);
    g.fillStyle = "#13293d";
    g.font = `${THUMB_TITLE_PX}px ${THUMB_UI_FONT}`;
    g.fillText(String(entry.win.titleText || "").slice(0, 34), 4, cap - 4);

    const body = canvas.height - cap;
    g.fillStyle = "#fff";
    g.fillRect(0, cap, canvas.width, body);
    const fits = Math.max(1, Math.floor((body - 4) / THUMB_LEAD));
    const lines = entry.term ? entry.term.screen().split("\n").slice(-fits) : [];
    g.fillStyle = "#1d2b36";
    g.font = `${THUMB_TEXT_PX}px ui-monospace, Menlo, Consolas, monospace`;
    lines.forEach((line, i) => {
      g.fillText(line.slice(0, THUMB_COLS), 3, cap + THUMB_LEAD + i * THUMB_LEAD);
    });
    canvas.dataset.thumb = entry.term ? "text" : "blank";
    return canvas.dataset.thumb;
  }

  /** Cancel a scheduled close. The pointer is on the button or on the panel, which are one
   *  hover target even though they are two elements with a gap between them. */
  #holdHover() {
    clearTimeout(this.closeTimer);
    this.closeTimer = 0;
  }

  #hoverIn(group, btn) {
    clearTimeout(this.hoverTimer);
    this.#holdHover();
    // ALREADY SHOWING THIS GROUP: hold it rather than tear it down and build it again, which
    // would flicker and reset the pointer's target mid-gesture.
    if (this.open && this.open.kind === "thumbs" && this.open.group === group.key) return;
    this.hoverTimer = setTimeout(() => {
      // A HOVER MUST NOT STEAL AN OPEN MENU. A jump list the user opened on purpose outranks a
      // preview they got by moving the pointer.
      if (this.open && this.open.kind === "jump") return;
      this.openWindowList(group, btn);
    }, HOVER_MS);
  }

  #hoverOut() {
    clearTimeout(this.hoverTimer);
    // SCHEDULED, NOT IMMEDIATE: see `HOVER_CLOSE_MS`. A jump list is never closed this way,
    // because it was asked for rather than hovered into existence.
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => {
      this.closeTimer = 0;
      if (this.open && this.open.kind === "thumbs") this.closePopup();
    }, HOVER_CLOSE_MS);
  }

  /**
   * THE WINDOW MENU: what Windows 7 shows for a right-click on a caption, and the one mouse action
   * on a frame that M14 did not have at first.
   *
   * EVERY ROW IS A STATE ASK OR A CLOSE REQUEST, so there is nothing here the caption buttons
   * cannot already do — which is the point: a menu that could do MORE than the buttons would be a
   * second authority on a window's state. A row that does not apply is DRAWN AND DISABLED, which
   * is Windows 7's own rule for an inapplicable command and this project's for a caption button.
   */
  openWindowMenu(entry, at) {
    clearTimeout(this.hoverTimer);
    this.closePopup();
    this.stats.windowMenus += 1;
    this.popup.className = "shell-popup";
    this.popup.dataset.popup = "window";
    const title = document.createElement("div");
    title.className = "shell-title";
    title.textContent = entry.win.titleText;
    this.popup.append(title);
    const docked = entry.state !== WST_NORMAL;
    this.#row(this.popup, {
      icon: null, label: "Restore", disabled: !docked, data: { winMenu: "restore" },
      onClick: () => { this.host.askState(entry.id, WST_NORMAL); this.closePopup(); },
    });
    this.#row(this.popup, {
      icon: null, label: "Minimize", disabled: entry.state === WST_MIN,
      data: { winMenu: "minimize" },
      onClick: () => { this.host.askState(entry.id, WST_MIN); this.closePopup(); },
    });
    this.#row(this.popup, {
      icon: null, label: "Maximize", disabled: entry.state === WST_MAX,
      data: { winMenu: "maximize" },
      onClick: () => { this.host.askState(entry.id, WST_MAX); this.closePopup(); },
    });
    this.#separator(this.popup);
    this.#row(this.popup, {
      icon: null, label: "Close", data: { winMenu: "close" },
      onClick: () => { this.host.requestClose(entry.id); this.closePopup(); },
    });
    this.open = { kind: "window", win: entry.id };
    // AT THE POINTER, which is where a context menu belongs — and inside the desktop, because a
    // menu that opened off the edge is a menu with rows nobody can reach.
    this.popup.hidden = false;
    const desk = this.into.getBoundingClientRect();
    const box = this.popup.getBoundingClientRect();
    const x = Math.min(Math.max(at.x - desk.left, 4), Math.max(desk.width - box.width - 4, 4));
    const y = Math.min(Math.max(at.y - desk.top, 4), Math.max(desk.height - box.height - 4, 4));
    this.popup.style.left = `${Math.round(x)}px`;
    this.popup.style.top = `${Math.round(y)}px`;
    this.popup.style.bottom = "auto";
    return this.open;
  }

  /**
   * The start menu: the rows the DESKTOP window published with `WITEM_MENU`, a search box that
   * filters them, and Log off.
   *
   * THE ROWS COME FROM A PROCESS. `src/bin/desktop.mjs` reads `/usr/bin` through the filesystem and
   * publishes what it found — so this menu lists what is actually installed rather than what the
   * page was written to expect, and a program added to `/usr/bin` appears in it with no change
   * here. That is the whole reason `win_items` exists.
   */
  toggleStart() {
    if (this.open && this.open.kind === "start") {
      this.closePopup();
      return false;
    }
    this.openStart();
    return true;
  }

  /** The desktop window's entry, or null. The shell's one named window. */
  desktopEntry() {
    for (const entry of this.host.frames.values()) {
      if (entry.role === WROLE_DESKTOP) return entry;
    }
    return null;
  }

  openStart() {
    this.closePopup();
    this.stats.menuOpens += 1;
    this.popup.dataset.popup = "start";
    this.popup.className = "shell-popup startmenu";
    const desk = this.desktopEntry();
    const rows = (desk ? desk.items : [])
      .map((row, index) => ({ ...row, index }))
      .filter((row) => (row.flags & WITEM_MENU) !== 0);
    const list = document.createElement("div");
    list.className = "start-list";
    const render = (filter) => {
      list.textContent = "";
      const needle = filter.trim().toLowerCase();
      const shown = rows.filter((row) => !needle || row.label.toLowerCase().includes(needle));
      for (const row of shown) {
        if (row.flags & WITEM_SEPARATOR) {
          this.#separator(list);
          continue;
        }
        this.#row(list, {
          icon: row.icon,
          label: row.label,
          disabled: (row.flags & WITEM_DISABLED) !== 0,
          data: { menuIndex: row.index },
          onClick: () => {
            this.stats.launches += 1;
            // THROUGH THE DESKTOP PROCESS, which published the row and knows what it means. The
            // shell does not run programs: the kernel validates the index and the process acts.
            this.host.activateItem(desk.id, row.index, WITEM_MENU);
            this.closePopup();
          },
        });
      }
      if (!shown.length) {
        this.#row(list, {
          icon: null,
          label: desk ? "No programs match" : "No desktop process is publishing a menu",
          disabled: true,
          data: { menuEmpty: 1 },
        });
      }
      list.dataset.rows = String(shown.length);
      return shown.length;
    };
    /* WINDOWS 7's RIGHT COLUMN, which is the same list under a different flag: the rows the
     * desktop published for ITSELF are the places a reader goes — Computer, the folders, a
     * terminal — and Windows 7 puts exactly those on the right of its menu. A fourth rendering of
     * one mechanism, which is what `WITEM_*` being flags rather than an enum is for. */
    const places = (desk ? desk.items : [])
      .map((row, index) => ({ ...row, index }))
      .filter((row) => (row.flags & WITEM_DESKTOP) !== 0 && (row.flags & WITEM_SEPARATOR) === 0);
    const right = document.createElement("div");
    right.className = "start-places";
    right.dataset.places = String(places.length);
    for (const row of places) {
      this.#row(right, {
        icon: row.icon,
        label: row.label,
        disabled: (row.flags & WITEM_DISABLED) !== 0,
        data: { placeIndex: row.index },
        onClick: () => {
          this.stats.launches += 1;
          this.host.activateItem(desk.id, row.index, WITEM_DESKTOP);
          this.closePopup();
        },
      });
    }

    const title = document.createElement("div");
    title.className = "shell-title";
    title.textContent = "All Programs";
    const search = document.createElement("input");
    search.type = "search";
    search.className = "start-search";
    search.dataset.startSearch = "1";
    search.placeholder = "Search programs";
    search.setAttribute("aria-label", "Search programs");
    search.addEventListener("input", () => render(search.value));
    const foot = document.createElement("div");
    foot.className = "start-foot";
    this.#row(foot, {
      icon: null,
      label: "Log off",
      data: { logOff: 1 },
      onClick: () => {
        // EVERY PROCESS, THROUGH THE PAGE'S OWN SUPERVISOR ROUTE. There is no `shutdown` syscall
        // and there should not be: ending every process is a thing the page does, and the kernel's
        // own teardown closes their fds and takes their windows with them (constraint 14).
        const pids = new Set([...this.host.frames.values()].map((e) => e.pid));
        for (const pid of pids) this.host.post({ t: "end-process", pid });
        this.closePopup();
      },
    });
    /* TWO COLUMNS, laid out by the skin: the programs on the left and the places on the right,
     * which is Windows 7's own arrangement. The search box spans both, because it searches the
     * left one. */
    const columns = document.createElement("div");
    columns.className = "start-columns";
    const left = document.createElement("div");
    left.className = "start-left";
    left.append(title, list);
    columns.append(left, right);
    this.popup.append(columns, search, foot);
    render("");
    this.open = { kind: "start", win: desk ? desk.id : 0 };
    this.#placeAbove(this.startBtn);
    // THE SEARCH BOX TAKES THE KEYBOARD, which is where a Windows 7 user starts typing the moment
    // the menu opens.
    search.focus();
    return rows.length;
  }

  /* ---- the tray's two actions ---------------------------------------------------------------- */

  /** Aero Peek: every window becomes an outline while the pointer rests on Show desktop. A LOOK
   *  AND NOT AN ACTION — nothing is minimized and no state changes, so there is nothing to undo. */
  peek(on) {
    const want = on === true;
    if (want === this.peeking) return this.peeking;
    this.peeking = want;
    if (want) this.stats.peeks += 1;
    this.into.classList.toggle("is-peeking", want);
    this.into.dataset.peeking = want ? "1" : "0";
    return this.peeking;
  }

  /**
   * Show desktop: minimize everything, or put it all back if everything is already minimized.
   *
   * A TOGGLE, which is Windows 7's own behaviour and is what makes the button usable: a one-way
   * "minimize all" leaves a user clicking every taskbar button to recover.
   */
  showDesktop() {
    this.stats.showDesktops += 1;
    const windows = [...this.host.frames.values()].filter((e) => e.role !== WROLE_DESKTOP);
    const anyUp = windows.some((e) => e.state !== WST_MIN);
    for (const entry of windows) {
      this.host.askState(entry.id, anyUp ? WST_MIN : WST_NORMAL);
    }
    this.peek(false);
    return anyUp ? "minimized" : "restored";
  }

  /* ---- for a check, and for a reader of a failure ------------------------------------------- */

  report() {
    const groups = this.groups().map((g) => ({
      key: g.key,
      prog: g.prog,
      wins: g.wins.map((w) => w.id),
      state: (this.#buttonFor(g) || { dataset: {} }).dataset.state || "",
    }));
    return {
      ...this.stats,
      controls: shellControlsInForce(),
      height: TASKBAR_H,
      reserved: this.host.reserved,
      workArea: this.host.workArea(),
      buttons: this.band.children.length,
      groups,
      topmost: this.topmost(),
      open: this.open ? { ...this.open } : null,
      popupKind: this.popup.dataset.popup || "0",
      popupRows: [...this.popup.querySelectorAll(".shell-row")].map(
        (row) => row.querySelector(".shell-label")?.textContent || ""),
      thumbs: [...this.popup.querySelectorAll("[data-thumb-win]")].map((cell) => ({
        win: Number(cell.dataset.thumbWin),
        kind: cell.querySelector("canvas")?.dataset.thumb || "",
      })),
      peeking: this.peeking,
      clock: this.clockEl.textContent,
      clockEpoch: Number(this.clockEl.dataset.epoch || 0),
    };
  }

  /** Stop the clock and take the bar down. A page that boots a second kernel builds a second shell
   *  and an interval nobody cleared keeps ticking against an element that has gone. */
  dispose() {
    clearInterval(this.clockTimer);
    clearTimeout(this.hoverTimer);
    /* THE WIRING GOES WITH THE ELEMENTS, which a critic found it did not: the host kept calling
     * `sync()` into a detached band on every window-table change, and the WORK AREA stayed 40 px
     * shorter than the desktop with no taskbar occupying it — so every maximized window was laid
     * out against a strip reserved for nothing. */
    this.host.unwatch(this.watcher);
    this.host.useShell(null);
    this.host.reserve(0);
    this.el.remove();
    this.popup.remove();
    this.into.classList.remove("is-peeking");
  }
}
