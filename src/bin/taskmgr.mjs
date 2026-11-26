// `taskmgr`: every process, what it is doing, and what it has cost — in a window.
//
// WHAT IT CAN HONESTLY SHOW, AND WHAT IT REFUSES TO.
//
// Windows 7's Task Manager has a CPU column. THIS ONE DOES NOT, and that is the first thing to
// understand about it: there is no scheduler here. A process is a Worker, the browser decides when
// it runs, and nothing in this system is told how long it ran for. A "% CPU" column would be a
// number invented in this file — and a plausible invented number is worse than an absent one,
// which is the same argument M11 used for drawing a caption button DISABLED rather than live.
//
// So the columns are what the kernel actually measures, under names that say so:
//
//   KRNLms   the time the KERNEL spent servicing this process's syscalls (`Slot.serviceMs`).
//            Not the process's own compute: a program spinning in a tight JS loop makes no
//            syscalls and accrues none of this. It is the "busy" a kernel can see.
//   CALLS    syscalls issued, which is the other half of busy — a thousand cheap calls and one
//            expensive one are different shapes of load and this tells them apart.
//   READ /   bytes that crossed `read` and `write`, counted at the one funnel every answered call
//   WRITE    passes through (`finish` in src/kernel/kernel.mjs).
//   FD       open file descriptions, which is the handle leak a long-running program shows first.
//   WIN      windows. NOT their accounted surface area, although that is the one memory-shaped
//            figure this kernel owns (`win_surface` charges it against a budget, constraint 219):
//            the area is per-WINDOW and lives in `/proc/<pid>/win/<winid>`'s `surface:` line, so a
//            column would cost a read per window per refresh to print a sum of unlike things. This
//            header claimed a SURF column that no version of the table has had.
//
// IT SCROLLS, AND BEFORE M17 IT COULD NOT. The table drew the rows that fit and named the count it
// was hiding, pointing a reader at `ps` for the rest. That was correct for the ABI as it stood:
// no event delivered a wheel, and a row drawn above the viewport would have painted over the
// column headers. Constraint 294 is the statement of it, and M17 removes its premise rather than
// routing around it. `WEV_WHEEL` is the first half of the answer and `DL_CLIP` the second — the
// offset moves the rows and the clip keeps them off the header. Neither works without the other:
// an unclipped scroll is a table whose headers vanish under its own rows, which is exactly what
// the `no-clip` world shows.
//
// M19: THE LIT ROW, AND A SELECTION THAT IS MORE THAN ONE ROW. Three pieces, held apart because
// they are three different facts about the table:
//
//   THE SELECTION is what `t` and `x` apply to, and it is a SET OF PIDS rather than a set of row
//   indices. That is the one decision here that is not a matter of taste: the table is re-read
//   every second and a process that exits slides every row below it up by one, so a selection held
//   by index names a different process a second later — and the verbs this program offers are
//   `kill(2)`. A pid is the kernel's own identity for a process and cannot slide.
//
//   THE CURSOR is where the keys are, drawn as the row's OUTLINE where the selection is drawn as
//   its FILL. Two marks because a Ctrl+click that DESELECTS a row leaves the cursor standing on an
//   unselected row, and one mark cannot show that state at all.
//
//   THE LIT ROW is the hover, and it arrives as a `WEV_POINTER` with no button in it — which this
//   program could not receive before M19, because `src/wm/winhost.mjs` dropped every buttonless
//   move (constraint 223's amendment). `WPTR_LEAVE` is the other half: without it the last hover a
//   window ever gets is the one nearest the edge, so a row stays lit after the pointer has gone.
//
// THE TABLE FOLLOWS THE WINDOW. Its metrics are CSS pixels and the surface is the client box in
// device pixels, so `S` converts and `px` is the only place it is applied. A reader who resizes the
// window gets more rows and more room for a program name, not a stretched picture of the old one.
//
// THERE IS NO PER-PROCESS HEAP FIGURE, and the window says so rather than leaving a gap a reader
// fills in with a guess: `performance.measureUserAgentSpecificMemory` is per-AGENT, so it would
// report one number for every Worker together, attributed to whichever process asked.
//
// IT IS A USERLAND CLIENT OF `/proc`, with no privilege at all — the same files `ps` reads. That
// is the point of it being a program: a task manager that needed a capability would be evidence
// the boundary leaks.
//
// USAGE
//
//   taskmgr [-c MS]        MS is how long an idle window stays open
//   taskmgr --ev-b-pointer A NEGATIVE CONTROL AND NOTHING ELSE: it restores the pre-de8a68a
//                          pointer test, which read a y coordinate as a button mask. The
//                          registered check's control is this flag rather than a source edit, so
//                          it is re-runnable and scored.
//
// The contract this program is written against is in src/bin/true.mjs.

import {
  POLLIN, POLLHUP, POLLERR, POLLNVAL, EINTR, EHOSTGONE,
  WEV_KEY, WEV_CLOSE, WEV_DESTROYED, WEV_RESIZE, WEV_FOCUS, WEV_POINTER, WEV_CLIENT, WEV_WHEEL,
  WPTR_DOWN, WPTR_UP, WPTR_LEAVE, WMOD_SHIFT, WMOD_CTRL, WWHEEL_PAGE, WWHEEL_COALESCED,
  WKEY_UP, WKEY_DOWN, keyBytesOf, keysymOf, wheelAt,
  DL_CLEAR, DL_FILL_RECT, DL_STROKE_RECT, DL_CLIP, DLC_RESET,
  DLT_BOLD, DLT_MONO, DLT_RIGHT, encodeTextRun,
  DL_MAX_OPS, textOpCount, NAME_MAX,
  SIGTERM, SIGKILL,
} from "/src/abi.mjs";

const NAME = "taskmgr";

const POLL_MS = 100;
const CEILING_MS = 600000;

/** How often the table is re-read and redrawn. Windows 7's own default is about a second, and a
 *  faster refresh would mostly measure this program's own syscalls. */
const REFRESH_MS = 1000;

/* THE LAYOUT, IN CSS PIXELS — every number in this block, and `px` below is the one place they
   become surface pixels. A table is READ, so its metrics belong in the reader's unit: 18 px is a
   row that fits 12 px of text at any device-pixel ratio, and the same integer handed to
   `win_surface` would be a row half that tall on the reference display (PRD §2). */
const ROW_H = 18;
const HEAD_H = 40;
const FOOT_H = 34;
const PAD = 8;
const TEXT_PX = 12;
const TEXT_DY = 3;
/** The column grid's designed width, and the FLOOR it is laid out at. A narrower client area clips
 *  the right of the table instead of squeezing it: the glyphs do not shrink with the box, so a
 *  squeezed grid draws its figures over each other and under the wrong headers, while a clipped
 *  one draws fewer columns correctly. */
const TABLE_W = 560;
/** How many rows the DEFAULT window is sized to fit. The live count is `maxRows`, derived from the
 *  client box, because the box is the thing a reader resizes. It is no longer how many rows are
 *  REACHABLE — the wheel reaches the rest (M17). */
const ROWS_WANTED = 20;
/** The surface height that fits `ROWS_WANTED`. `maxRows` inverts this arithmetic. */
const DEFAULT_H = HEAD_H + ROWS_WANTED * ROW_H + FOOT_H;

const PAPER = 0x10151bff;
const INK = 0xe8edf4ff;
const INK_DIM = 0x9aa5b4ff;
const HEAD_INK = 0xbcc8d6ff;
const RULE = 0x29313cff;
const SELECT_FILL = 0x2d4a6bff;
const ZOMBIE_INK = 0xe8946cff;
const OUTLINE = 0x9fc6f0ff;
/** THE LIT ROW'S WASH. Translucent, so the row's own figures read through it rather than being
 *  redrawn over a second opaque paper, and far enough from `SELECT_FILL` that a driver reading one
 *  pixel cannot mistake the two: over `PAPER` this resolves to about 0x242b35. */
const HOVER_FILL = 0x9fc6f024;
/** How far the hover wash is inset from the row's band, in CSS px, TOP AND BOTTOM.
 *
 *  IT IS LOAD-BEARING AND NOT A STYLE. The selection band is exactly `ROW_H` tall and full width,
 *  and that SHAPE is how a driver outside this process finds it — `www/m16.html`'s `selectedRow`
 *  takes the first fill rect within a pixel of `ROW_H * scale`, having no other way to ask. A wash
 *  of the same shape would be indistinguishable from a selection, so this one is two CSS px
 *  shorter at every ratio: 16 against 18 at dpr 1, 32 against 36 at dpr 2. It also reads as a
 *  softer mark than the selection, which is what a hover should be. */
const HOVER_INSET = 1;

/* THE COLUMNS, AS DATA. A column is a header, an ANCHOR, an alignment and a function of a row — so
   adding one is a row in this array and nothing else, and the header cannot drift from the cell
   under it because both read the same entry.

   TWO ANCHORS, AND ONE COLUMN ABSORBS THE SLACK. `x` is a distance from the table's LEFT edge and
   `fromRight` a distance from its RIGHT edge; a column declares exactly one and `colX` resolves
   it. PID and PROG are left-anchored, the seven figure columns right-anchored, so a window made
   wider grows the one gap that benefits from the room — after PROG, where a long program name goes
   — and every figure keeps the glyph room it was measured for.

   SCALING THE X VALUES WITH THE BOX WAS THE ALTERNATIVE AND IT IS WRONG. The glyphs do not scale
   with the client area, so a proportional grid overlaps its own numbers at a narrow width and
   spreads a six-digit column over 200 px of nothing at a wide one. Column widths a reader can drag
   are a Details view's job (M19). */
const COLUMNS = [
  { head: "PID", x: 44, right: true, of: (r) => String(r.pid) },
  { head: "PROG", x: 52, right: false, of: (r) => r.prog },
  { head: "STAT", fromRight: 312, right: false, of: (r) => r.state },
  { head: "CALLS", fromRight: 230, right: true, of: (r) => String(r.calls) },
  { head: "KRNLms", fromRight: 166, right: true, of: (r) => r.kernelMs.toFixed(1) },
  { head: "READ", fromRight: 108, right: true, of: (r) => bytes(r.readBytes) },
  { head: "WRITE", fromRight: 52, right: true, of: (r) => bytes(r.writeBytes) },
  { head: "FD", fromRight: 26, right: true, of: (r) => String(r.fds) },
  { head: "WIN", fromRight: 0, right: true, of: (r) => String(r.wins) },
];

/** A column's x in CSS px, given the table's right anchor. The ONE resolver, so a header and the
 *  cells under it cannot resolve the same entry two ways. */
const colX = (col, right) => (col.fromRight === undefined ? col.x : right - col.fromRight);

/* HOW MANY ROWS ONE DRAW CAN CARRY, derived rather than chosen.

   `winDraw` splits a batch at `DL_MAX_OPS` (src/libos/syscall.mjs) and the kernel refuses any batch
   whose `DL_TEXT` header is parted from its data records (constraint 293, src/kernel/calls.mjs), so
   a display list over the limit does not scroll — the window goes BLANK. The cap keeps the list
   under it.

   IT BOUNDS THE VIEWPORT NOW, NOT THE TABLE. Before M17 it was the last word on how many rows a
   reader could ever see, and the rows past it were stated by an overflow line (constraint 294);
   the wheel reaches them, so this is only the largest viewport one batch can fill — a client box
   over about 1,250 CSS px tall stops gaining rows and keeps scrolling.

   The worst case per row is one text run per cell with a program name at `NAME_MAX`, plus two
   rectangles: the selection's fill, which EVERY row may carry, and the cursor's outline, which
   exactly one may. `CHROME_OPS` covers the clear, the two header strings, the nine column headers,
   the rule, the clip and its reset, the hover wash, the position line and the legend, with slack.
   The final `- 1` is the PARTIAL row a mid-row scroll offset exposes: a viewport that fits N rows
   draws N+1 whenever the offset is not a multiple of `ROW_H`. */
const OPS_PER_ROW = (COLUMNS.length - 1) * textOpCount(16) + textOpCount(NAME_MAX) + 2;
const CHROME_OPS = 50;
const ROWS_CAP = Math.floor((DL_MAX_OPS - CHROME_OPS) / OPS_PER_ROW) - 1;

/** How many rows a client box of `hCss` CSS px fits. The inverse of `DEFAULT_H`. */
const maxRowsFor = (hCss) =>
  Math.max(1, Math.min(ROWS_CAP, Math.floor((hCss - HEAD_H - FOOT_H) / ROW_H)));

/** THE FURTHEST THE TABLE MAY SCROLL, in CSS px: the rows that do not fit, and not one pixel more.
 *  One arithmetic with two callers — the live clamp inside `run` and `TASKMGR_METRICS.maxScroll`
 *  for a driver outside the process — because a clamp a driver computes differently is a driver
 *  that aims past the end and reports the program wrong. */
const maxScrollFor = (n, rowsFit) => Math.max(0, (n - rowsFit) * ROW_H);

/**
 * THIS PROGRAM'S ROW GEOMETRY, EXPORTED, IN CSS PIXELS — for the reason `FILES_METRICS` is
 * (`src/bin/files.mjs`): a driver outside the process has to know where a row is, and a copy of
 * these numbers is a copy that drifts.
 *
 * `bench/m14-shell/taskmgr.py` restates `40 + i * 18 + 9` and converts it with
 * `Surface.clientAt`, which was right while the surface was a CSS-px box handed to `win_surface`
 * unconverted and is wrong from M16 on: at dpr 2 a row's SURFACE y is twice its CSS y, so the
 * unscaled value lands above the table. CSS px is the honest unit for a driver because the canvas
 * now fills the client content box — a row's CSS y IS its offset inside the canvas's own CSS rect,
 * with no surface arithmetic at all.
 *
 * `rowMid` is the partner of the `rowAt` inside `run`, which turns a y back into an index, and
 * `maxRows` is the partner of `DEFAULT_H`.
 *
 * THE SCROLL OFFSET IS A PARAMETER OF THE GEOMETRY FROM M17 ON, and that is why the `*At` pair
 * exists. `rowTop(i)` is where the i-th VIEWPORT SLOT is, which is where row i sits only while the
 * offset is 0; `rowTopAt(i, scroll)` is where the i-th row of the TABLE is at a given offset.
 * A driver that aims at row N of a scrolled table MUST use the second form with the offset the
 * program reports (`scrollCss` in its account), or it clicks whichever row happens to be in slot N.
 * `rowAt` is the declared inverse of `rowTopAt` and takes the same offset.
 */
export const TASKMGR_METRICS = Object.freeze({
  ROW_H, HEAD_H, FOOT_H, PAD, TABLE_W, ROWS_WANTED, ROWS_CAP, DEFAULT_H,
  rowTop: (i) => HEAD_H + i * ROW_H,
  rowMid: (i) => HEAD_H + i * ROW_H + ROW_H / 2,
  rowTopAt: (i, scroll = 0) => HEAD_H + i * ROW_H - scroll,
  rowMidAt: (i, scroll = 0) => HEAD_H + i * ROW_H + ROW_H / 2 - scroll,
  rowAt: (yCss, scroll = 0) => Math.floor((yCss + scroll - HEAD_H) / ROW_H),
  /** The first row the viewport shows at `scroll`, which is the figure a proof of "the row at the
   *  viewport top changed" asserts on. */
  firstRowAt: (scroll = 0) => Math.max(0, Math.floor(scroll / ROW_H)),
  maxRows: maxRowsFor,
  maxScroll: (n, hCss) => maxScrollFor(n, maxRowsFor(hCss)),
});

/** Bytes, short enough for a column. Binary units, as a filesystem's own figures are. */
function bytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return String(v);
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)}K`;
  return `${(v / (1024 * 1024)).toFixed(1)}M`;
}

/** `key:\tvalue` lines into an object, which is the shape `/proc/<pid>/status` is written in for
 *  exactly this reason: no parser. */
function parseStatus(text) {
  const out = Object.create(null);
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (at < 0) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

/** One row per live pid, read out of `/proc`. A pid that exits between the listing and the read is
 *  skipped rather than reported as a zero row: it is gone, not idle. */
function readTable(env) {
  const names = env.std.listDir(env, "/proc");
  if (typeof names === "number") return names;
  const rows = [];
  for (const entry of names) {
    if (!/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const status = env.std.readFileText(env, `/proc/${pid}/status`);
    if (typeof status === "number") continue;
    const st = parseStatus(status);
    const cmdline = env.std.readFileText(env, `/proc/${pid}/cmdline`);
    // NUL-SEPARATED, as the file says it is; the first entry is the program.
    const argv0 = typeof cmdline === "string"
      ? (cmdline.split("\u0000").filter((s) => s.length)[0] || "?")
      : "?";
    const fds = env.std.listDir(env, `/proc/${pid}/fd`);
    const wins = env.std.listDir(env, `/proc/${pid}/win`);
    rows.push({
      pid,
      ppid: Number(st.ppid || 0),
      prog: argv0.replace(/^.*\//, ""),
      state: st.state || "?",
      calls: Number(st.calls || 0),
      // ABSENT MEANS ZERO AND NOT UNKNOWN only because this program and that file ship together;
      // a missing field would otherwise print as NaN, which is a number that reads like a figure.
      kernelMs: Number(st.kernelms || 0),
      readBytes: Number(st.readbytes || 0),
      writeBytes: Number(st.writebytes || 0),
      fds: typeof fds === "number" ? 0 : fds.filter((e) => /^\d+$/.test(e.name)).length,
      wins: typeof wins === "number" ? 0 : wins.filter((e) => /^\d+$/.test(e.name)).length,
    });
  }
  rows.sort((a, b) => a.pid - b.pid);
  return rows;
}

export function run(env) {
  const std = env.std;
  /* `--ev-b-pointer` COMES OFF ARGV BEFORE `getopt`, which knows single letters only — a long
   * option reaching it is refused as an unknown `-`. `src/bin/files.mjs` strips its two controls
   * the same way, and `src/bin/term.mjs` is where the convention comes from. */
  let evBPointer = false;
  const rest = [];
  let endOfOptions = false;
  for (const arg of (env.argv || []).slice(1).map(String)) {
    if (!endOfOptions) {
      if (arg === "--") { endOfOptions = true; rest.push(arg); continue; }
      if (arg === "--ev-b-pointer") { evBPointer = true; continue; }
    }
    rest.push(arg);
  }
  const { flags, bad } = std.getopt(rest, "c:");
  if (bad) {
    return { exit: std.complain(env, NAME, null, `unknown option ${bad}`, std.EXIT_USAGE) };
  }
  let ceiling = CEILING_MS;
  if (flags.c !== undefined) {
    const ms = std.wholeNumber(flags.c);
    if (ms === null || ms === 0) {
      return { exit: std.complain(env, NAME, null, `bad ceiling: ${flags.c}`, std.EXIT_USAGE) };
    }
    ceiling = ms;
  }

  const account = {
    program: NAME, win: 0, fd: 0, refreshes: 0, rows: 0, kills: [], why: "",
    // M16's units, as figures a harness can read: the box the kernel last granted in DEVICE px,
    // the ratio it came with, and how many of each the box bought.
    resurfaces: 0, refusedSurface: 0, clientW: 0, clientH: 0, dpr: 1, maxRows: ROWS_WANTED,
    /* M17'S SCROLL, as figures a driver can assert on. `scrollCss` is the live offset in CSS px —
       the second argument `TASKMGR_METRICS.rowTopAt` wants — and `firstRow` is the row at the
       viewport top, which is the clause the proof reads. `clampTop` and `clampEnd` are counted
       SEPARATELY because the two ends are two clauses: a run that only ever hit one of them has
       not shown the clamp works, and an unclamped build leaves both at 0 while the offset runs
       past its own end. `wheelsCoalesced` counts records the KERNEL marked as sums, which is this
       side's half of the `coalesced:` line in `/proc/<pid>/win/<winid>`. */
    scrollCss: 0, firstRow: 0, wheels: 0, wheelsCoalesced: 0, wheelPages: 0,
    clampTop: 0, clampEnd: 0, scrolledPx: 0,
    /* M19'S SELECTION AND LIT ROW, as figures a driver can assert on. PIDS and not indices, for
       the reason the state below holds pids — a driver that asserted an index would be asserting
       whichever process is at that index when it reads. `cursorRow` is the one index here and it
       is derived, for the driver that wants to aim `TASKMGR_METRICS.rowMidAt` at the cursor.
       `hoverPid` is 0 for "nothing is lit", which no process can be: `src/kernel/table.mjs`
       allocates pids from 1.
       `hovers` counts the buttonless records this program RECEIVED and `hoverChanges` the times
       the lit row actually moved — two figures because the kernel replaces a tail hover rather
       than appending it (constraint 223), so a 500-sample stream reaches a draining program as
       many records and a held one as few, and only the second figure is about this program.
       `leaves` counts `WPTR_LEAVE` records and `hoverCleared` the ones that put a lit row out,
       which is the clause "a `pointerleave` clears it" asserts. */
    selectedPids: [], selectedCount: 0, cursorPid: 0, cursorRow: -1, anchorPid: 0,
    plainSelects: 0, ranges: 0, toggles: 0,
    hoverPid: 0, hoverRow: -1, hovers: 0, hoverChanges: 0, leaves: 0, hoverCleared: 0,
    // WHICH WORLD THIS RUN IS IN, so a control that forgot to pass its flag cannot read as a pass.
    evBPointer,
  };

  let rows = readTable(env);
  if (typeof rows === "number") {
    return { exit: std.complainErrno(env, NAME, "/proc", rows), program: NAME, errno: -rows };
  }

  const made = env.win.create({
    title: "Task Manager", w: TABLE_W + 20, h: DEFAULT_H + 40,
    x: env.std.WIN_ORIGIN_X, y: env.std.WIN_ORIGIN_Y,
  });
  if (typeof made === "number") {
    return { exit: 2, ...account, why: `win_create: ${std.errnoName(made)}`, errno: -made };
  }
  account.win = made.win;
  account.fd = made.fd;
  /* THE FIRST SURFACE IS ASKED FOR AT SCALE 1, AND IT HAS TO BE. `win_surface` takes device pixels
   * and the only route to the ratio is a `WEV_CLIENT` this window has not had yet, so the opening
   * store is a CSS-px box read as device px — at dpr 2 a half-size store stretched over the client
   * area. The kernel initialises a window's client box to -1, so the page's first geometry report
   * raises the event and the paint below is replaced within a frame; `S` stays 1 until then, which
   * makes the opening list self-consistent rather than merely small. */
  const surf = env.win.surface(made.fd, TABLE_W, DEFAULT_H);
  if (surf < 0) {
    env.win.destroy(made.fd);
    return { exit: 3, ...account, why: `win_surface: ${std.errnoName(surf)}`, errno: -surf };
  }

  /* THE SELECTION, THE CURSOR AND THE LIT ROW — all three as PIDS, and the header says why. 0 is
     "none" in every one of them, which is a value no process can have.
     `selection` is what the verbs apply to, `cursorPid` is where the keys are, `anchorPid` is
     where a Shift range measures FROM. The anchor is separate from the cursor because a Shift
     range must keep measuring from the row the reader last committed to, not from the end of the
     range they are currently sweeping — dragging a range out and back must give the rows between
     the anchor and the pointer, not grow monotonically. */
  const selection = new Set();
  let cursorPid = 0;
  let anchorPid = 0;
  let hoverPid = 0;

  /** A pid's place in the LAYOUT ORDER, which is the order `rows` is in — `readTable` sorts by pid,
   *  and a Shift range is a range in THIS order whatever that order becomes. -1 for a pid that is
   *  no longer in the table. */
  const rowIndexOf = (pid) => (pid ? rows.findIndex((r) => r.pid === pid) : -1);

  /** THE ONE WRITER OF THE ACCOUNT'S SELECTION FIELDS, for `setScroll`'s reason: a figure a driver
   *  reads must not be able to disagree with what the program drew. */
  const publish = () => {
    account.selectedPids = [...selection].sort((a, b) => a - b);
    account.selectedCount = selection.size;
    account.cursorPid = cursorPid;
    account.cursorRow = rowIndexOf(cursorPid);
    account.anchorPid = anchorPid;
    account.hoverPid = hoverPid;
    account.hoverRow = rowIndexOf(hoverPid);
  };

  /* THE LIVE LAYOUT. `relayout` is the only writer, and it is called with what `std.resurface`
     returns — so these three follow the client box and nothing else does arithmetic on it. */
  /** The table's grid width in CSS px: the client box, floored at `TABLE_W`. */
  let tableW = TABLE_W;
  /** The client box's height in CSS px, which is where the legend sits. */
  let viewH = DEFAULT_H;
  /** Surface px per CSS px. One factor, and it is the dpr only because `std.resurface` asks for
   *  exactly the client box in device px — see its docstring. */
  let S = 1;
  /** How many rows fit the live height. */
  let maxRows = ROWS_WANTED;
  /** HOW FAR THE TABLE IS SCROLLED, in CSS px, and it may be fractional: a notch is surface px
   *  divided by `S`, so at dpr 2 an odd delta is half a CSS pixel. Keeping the remainder is what
   *  makes a slow trackpad gesture move the list at all — rounding each notch to a whole pixel
   *  loses the sub-pixel part of every one of them. `setScroll` is the only writer. */
  let scroll = 0;

  /** CSS px to surface px. THE ONE PLACE THE FACTOR IS APPLIED: a per-constant scaling is how two
   *  of them come to disagree, which is the defect M16 removes. */
  const px = (v) => Math.round(v * S);

  /** The offset's legal range, both ends, in CSS px. SEPARATE FROM THE COUNTING in the wheel path:
   *  a resize and a refresh both have to re-clamp, and neither is a reader hitting an end. */
  const clamp = (v) => Math.min(Math.max(0, v), maxScrollFor(rows.length, maxRows));

  /** THE ONE WRITER OF `scroll`, so the account cannot disagree with the pixels. It takes an
   *  already-clamped offset — the clamp is separate because its two ends are counted. */
  const setScroll = (v) => {
    scroll = v;
    account.scrollCss = scroll;
    account.firstRow = TASKMGR_METRICS.firstRowAt(scroll);
  };

  const relayout = (wCss, hCss, dpr) => {
    tableW = Math.max(wCss, TABLE_W);
    viewH = hCss;
    S = dpr;
    // THE INVERSE OF `DEFAULT_H`, written once in one direction and read in both — the same
    // relationship `rowTop` and `rowAt` have for a row's y.
    maxRows = TASKMGR_METRICS.maxRows(hCss);
    account.maxRows = maxRows;
    /* A TALLER BOX SHORTENS THE SCROLL RANGE, so an offset that was legal is now past the end and
     * the table would be drawn against empty space below its last row. The selection is NOT
     * clamped to the viewport — it names processes and not slots — so a resize leaves it alone and
     * `ensureVisible` brings the cursor back when the reader moves it. */
    setScroll(clamp(scroll));
  };

  /** The inverse of `rowTopAt`, in CSS px, so a press selects the row a reader is pointing at —
   *  and the BOUNDS are the viewport band, not the table: a press on the header, on the position
   *  line or below the last drawn row must find nothing. The partial row a mid-row offset exposes
   *  is clipped, so a press in its clipped-away part lands outside the band and finds nothing
   *  either, which is what a reader sees. */
  const rowAt = (y) => {
    if (y < HEAD_H || y >= HEAD_H + maxRows * ROW_H) return -1;
    const i = TASKMGR_METRICS.rowAt(y, scroll);
    return i >= 0 && i < rows.length ? i : -1;
  };

  /** Scroll the least that puts row `i` wholly inside the viewport. The partner of the u/j keys: a
   *  selection off the screen is one a reader cannot see `t` or `x` apply to. */
  const ensureVisible = (i) => {
    const top = i * ROW_H;
    if (top < scroll) setScroll(clamp(top));
    else if (top + ROW_H > scroll + maxRows * ROW_H) {
      setScroll(clamp(top + ROW_H - maxRows * ROW_H));
    }
  };

  /* THE THREE SELECTION VERBS, AND THEY ARE THE FILE MANAGER'S RULES — Windows 7's, which is where
     both got them. A reader who has learnt the gesture in one window must not have to learn a
     second one here.

     THEY TAKE A ROW INDEX AND STORE A PID, and that conversion is the whole of why they are three
     named functions rather than three branches at the press: a range is computed in layout order,
     which only indices have, and then held as identity, which only pids have. */

  /** A plain click and every unmodified key: the selection becomes this row alone, and the anchor
   *  follows — the next Shift+click measures from here. */
  const selectOnly = (i) => {
    selection.clear();
    const row = rows[i];
    if (row) {
      selection.add(row.pid);
      cursorPid = row.pid;
      anchorPid = row.pid;
    }
    publish();
  };

  /** Ctrl+click: this row alone changes, and THE ANCHOR MOVES TO IT. Moving the anchor is what
   *  makes a Ctrl+click followed by a Shift+click select the band between them, which is the
   *  gesture a reader builds a scattered selection with. */
  const toggleAt = (i) => {
    const row = rows[i];
    if (!row) return;
    if (selection.has(row.pid)) selection.delete(row.pid);
    else selection.add(row.pid);
    cursorPid = row.pid;
    anchorPid = row.pid;
    publish();
  };

  /** Shift+click: every row between the anchor and `i` IN LAYOUT ORDER, and nothing else. The
   *  anchor does NOT move, so sweeping the range back shrinks it.
   *
   *  AN ANCHOR WHOSE PROCESS HAS EXITED falls back to the cursor and then to the clicked row
   *  itself, in that order. A dead anchor is not an error — it is a process that ended between two
   *  clicks — and a range measured from a row that no longer exists would silently be a range from
   *  wherever that index now points. */
  const rangeTo = (i) => {
    if (!rows[i]) return;
    const at = rowIndexOf(anchorPid);
    const cursorAt = rowIndexOf(cursorPid);
    const from = at >= 0 ? at : (cursorAt >= 0 ? cursorAt : i);
    const lo = Math.min(from, i);
    const hi = Math.max(from, i);
    selection.clear();
    for (let n = lo; n <= hi; n += 1) selection.add(rows[n].pid);
    cursorPid = rows[i].pid;
    if (at < 0) anchorPid = rows[from].pid;
    publish();
  };

  /** THE ONE WRITER OF `hoverPid`, and it answers whether the picture changed — so a stream of
   *  samples across one row costs one repaint and not one per sample. */
  const setHover = (pid) => {
    if (pid === hoverPid) return false;
    hoverPid = pid;
    account.hoverChanges += 1;
    publish();
    return true;
  };

  /**
   * Move the cursor `delta` rows and bring it into view. `extend` is Shift: the selection becomes
   * the band from the anchor to where the cursor lands, which is the keyboard's half of the same
   * rule Shift+click follows — one range function, reached two ways.
   *
   * THE CURSOR INDEXES THE TABLE AND NOT THE VIEWPORT, which was M17's change to these keys: `j`
   * stopped at `maxRows - 1` because that was the last row on screen, so a reader could not reach
   * — or signal — a process below the fold at all.
   *
   * Answers whether anything moved, so an unmodified key at either end of the table costs no
   * repaint. A SHIFTED one at an end still repaints: the range it asks for is the range it already
   * has, and proving that costs more than drawing it.
   */
  const moveCursor = (delta, extend) => {
    if (!rows.length) return false;
    const at = rowIndexOf(cursorPid);
    const to = Math.max(0, Math.min(rows.length - 1, (at >= 0 ? at : 0) + delta));
    if (to === at && !extend) return false;
    if (extend) rangeTo(to);
    else selectOnly(to);
    ensureVisible(to);
    return true;
  };

  const paint = () => {
    /** The first row the viewport shows, and one more than fits: a mid-row offset exposes the top
     *  of the row after the last whole one, and `ROWS_CAP` holds a slot for it. */
    const first = TASKMGR_METRICS.firstRowAt(scroll);
    const shown = rows.slice(first, first + maxRows + 1);
    /** The rows band in CSS px, floored at the last row when the table is shorter than the box —
     *  so the position line and the legend sit under the table rather than under empty space. */
    const bandH = Math.min(rows.length * ROW_H - scroll, maxRows * ROW_H);
    /** The table's right anchor in CSS px. ONE ANCHOR: the figure columns, the header's caption and
     *  the rule all read it, so none of them can sit past another. */
    const right = tableW - PAD;
    /** A rule stays a rule at every ratio, and floors at one surface pixel: `px(1)` rounds to 0
     *  below dpr 0.5, and an invisible rule reads as a missing header. */
    const hair = Math.max(1, px(1));
    const ops = [{ op: DL_CLEAR, a0: PAPER }];

    /* THE TITLE SAYS WHAT THE NUMBERS ARE. A reader who thinks KRNLms is CPU time will draw the
     * wrong conclusion from it, and the one place that misreading can be headed off is here. */
    ops.push(...encodeTextRun(`${rows.length} process${rows.length === 1 ? "" : "es"}`, {
      x: px(PAD), y: px(PAD - 2), size: px(TEXT_PX + 1), rgba: INK, flags: DLT_BOLD,
    }));
    ops.push(...encodeTextRun("KRNLms is kernel time servicing syscalls, not CPU", {
      x: px(right), y: px(PAD - 1), size: px(TEXT_PX - 2), rgba: INK_DIM, flags: DLT_RIGHT,
    }));

    for (const col of COLUMNS) {
      ops.push(...encodeTextRun(col.head, {
        x: px(colX(col, right)), y: px(HEAD_H - 16), size: px(TEXT_PX - 1), rgba: HEAD_INK,
        flags: DLT_BOLD | DLT_MONO | (col.right ? DLT_RIGHT : 0),
      }));
    }
    ops.push({
      op: DL_FILL_RECT, a0: px(PAD), a1: px(HEAD_H - 3), a2: px(tableW - PAD * 2), a3: hair,
      a4: RULE,
    });

    /* THE VIEWPORT, AND THE ROWS MAY ONLY PAINT INSIDE IT. It starts at `HEAD_H` and not at the
     * rule three pixels above it, so a row scrolled up cannot touch the header or the rule —
     * which is the pixel the proof reads. The width overhangs the surface whenever the client box
     * is narrower than `TABLE_W`, and that is legal and deliberate: the kernel refuses a clip that
     * is wholly outside the surface or degenerate, never one that merely extends past an edge
     * (`src/kernel/calls.mjs`). Both extents floor at one surface pixel for that reason — a
     * degenerate rect would be refused and the refusal takes the WHOLE batch, so the window would
     * go blank with no error anywhere. `HEAD_H` is inside the surface at every box the frame's
     * `MIN_H` admits, which is what makes `a1` safe without a second clamp. */
    ops.push({
      op: DL_CLIP,
      a0: 0, a1: px(HEAD_H), a2: Math.max(1, px(tableW)), a3: Math.max(1, px(maxRows * ROW_H)),
    });

    /* THE LIT ROW GOES UNDER EVERYTHING ELSE IN THE BAND, which is the only order that works: a
     * wash drawn after a row's figures would be drawn OVER them, and a wash drawn after the
     * selection's fill would change the one pixel `bench/m14-shell/taskmgr.py` reads the selection
     * out of. A row that is already selected is already lit, so it gets no wash at all — the
     * selection says more than the hover does, and leaving the fill unblended is what keeps that
     * pixel readable. */
    const litAt = rowIndexOf(hoverPid);
    if (litAt >= first && litAt <= first + maxRows && !selection.has(hoverPid)) {
      ops.push({
        op: DL_FILL_RECT,
        a0: px(PAD), a1: px(TASKMGR_METRICS.rowTopAt(litAt, scroll) + HOVER_INSET),
        a2: px(tableW - PAD * 2), a3: Math.max(1, px(ROW_H - HOVER_INSET * 2)), a4: HOVER_FILL,
      });
    }

    shown.forEach((row, n) => {
      /** The row's own index in the TABLE, which is what the scroll offset is relative to. */
      const i = first + n;
      const top = TASKMGR_METRICS.rowTopAt(i, scroll);
      /* THE FILL SAYS SELECTED AND THE OUTLINE SAYS WHERE THE KEYS ARE. Two marks for two facts:
       * a Ctrl+click that deselects a row leaves the cursor on an unselected row, and a Shift
       * range leaves it at the end of a band whose other rows are equally selected. A reader who
       * could not see the cursor could not predict what the next Shift+click would take. */
      if (selection.has(row.pid)) {
        ops.push({
          op: DL_FILL_RECT, a0: px(PAD), a1: px(top), a2: px(tableW - PAD * 2), a3: px(ROW_H),
          a4: SELECT_FILL,
        });
      }
      if (row.pid === cursorPid) {
        ops.push({
          op: DL_STROKE_RECT, a0: px(PAD), a1: px(top), a2: px(tableW - PAD * 2), a3: px(ROW_H),
          a4: OUTLINE, a5: hair,
        });
      }
      // A ZOMBIE IS NOT A RUNNING PROCESS and must not read like one: it holds a pid and an exit
      // status and nothing else, which is why `kill` on it does nothing and `wait` is what clears
      // it. The colour is the only way a table can say that at a glance.
      const ink = row.state === "zombie" ? ZOMBIE_INK : INK;
      for (const col of COLUMNS) {
        ops.push(...encodeTextRun(col.of(row), {
          x: px(colX(col, right)), y: px(top + TEXT_DY), size: px(TEXT_PX - 1),
          rgba: col.head === "PROG" ? ink : (row.state === "zombie" ? ZOMBIE_INK : INK_DIM),
          flags: DLT_MONO | (col.right ? DLT_RIGHT : 0),
        }));
      }
    });

    /* THE CLIP IS DROPPED BEFORE ANYTHING ELSE IS DRAWN, because the two lines below sit BELOW the
     * rows band and a clip only ever intersects — they would be clipped away entirely. The
     * renderer also resets at the top of every batch, so this is not about leaking state into the
     * next paint; it is about the rest of THIS one. */
    ops.push({ op: DL_CLIP, flags: DLC_RESET });

    const footY = HEAD_H + bandH + 6;
    /* WHERE THE READER IS IN THE TABLE, and it replaces the overflow notice the row cap needed
     * (constraint 294): the rows past the viewport are reachable now, so the honest line is which
     * ones are on screen rather than how many are not. It goes when it would land on the legend —
     * at the smallest window a frame can be clamped to, one row fits and the two lines are 4 px
     * apart, and two strings drawn over each other read as neither. */
    if (rows.length > maxRows && footY + TEXT_PX <= viewH - 16) {
      const last = Math.min(rows.length, first + maxRows);
      ops.push(...encodeTextRun(`rows ${first + 1}-${last} of ${rows.length}`, {
        x: px(PAD), y: px(footY), size: px(TEXT_PX - 1), rgba: INK_DIM,
      }));
    }
    /* THE LEGEND IS LENGTH-BOUND, NOT TASTE-BOUND, and the bound is measured. The room at the
     * default width is `TABLE_W` less a `PAD` at each side: 544 CSS px. Summing M19's published
     * advances at size 11 for the ui family (`bench/m19-advance/table-headless.json`), this line
     * is at most 483.9 px and the fuller wording it replaced — "u/j or arrows move   shift/ctrl
     * click selects" — at most 556.2 px. A SUM IS A STRICT UPPER BOUND for a proportional family
     * because the renderer kerns, so the shipped line is PROVEN to fit and the longer one is
     * merely not proven to; proving a fit is the only direction a bound is good for, and a line
     * that overruns is clipped mid-word by the surface's own edge. */
    ops.push(...encodeTextRun(
      "u/j or arrows   shift/ctrl click   wheel scrolls   "
      + "t = SIGTERM   x = SIGKILL   r = refresh   q = quit", {
        x: px(PAD), y: px(viewH - 16), size: px(TEXT_PX - 1), rgba: INK_DIM,
      }));
    return env.win.draw(made.fd, ops);
  };

  const refresh = () => {
    const got = readTable(env);
    if (typeof got === "number") return got;
    /** Where the cursor was in the OLD table, read before the new one replaces it: it is the only
     *  thing left to put the cursor near when the process it was on has exited. */
    const wasAt = rowIndexOf(cursorPid);
    rows = got;
    account.refreshes += 1;
    account.rows = rows.length;
    /* A PROCESS THAT EXITED LEAVES THE SELECTION, AND NOTHING SLIDES INTO ITS PLACE. The pruning
     * is the reason the selection holds pids, and the second half is the reason it must not be
     * refilled: if the last selected process exits and the row below it slid up into the
     * selection, the reader's next `x` would SIGKILL a process they never chose. An empty
     * selection is the honest state and `signal` refuses by name.
     *
     * THE CURSOR IS DIFFERENT, because it is not a target: it is where the keys are, so it moves
     * to whatever now occupies the place it was in and the reader's next `j` carries on from
     * there. The anchor goes to 0 rather than following, and `rangeTo` says what that means. */
    const alive = new Set(rows.map((r) => r.pid));
    for (const pid of selection) if (!alive.has(pid)) selection.delete(pid);
    if (!alive.has(anchorPid)) anchorPid = 0;
    if (!alive.has(hoverPid)) setHover(0);
    if (!alive.has(cursorPid)) {
      const i = Math.min(Math.max(wasAt, 0), rows.length - 1);
      cursorPid = i >= 0 ? rows[i].pid : 0;
    }
    publish();
    /* A SHORTER TABLE SHORTENS THE SCROLL RANGE. Processes exit, so a refresh can leave the offset
     * past the end of its own table — which draws a viewport of nothing and no error. */
    setScroll(clamp(scroll));
    paint();
    return 0;
  };
  /* THE FIRST ROW IS SELECTED AT STARTUP, which it has been since this program's first version and
   * is kept deliberately: a table whose verbs apply to nothing until the reader clicks would have
   * `t` and `x` do nothing on a window that looks ready. It is also what makes a driver's first
   * press a CHANGE rather than a coincidence — `www/m16.html` presses row 3 first for exactly that
   * reason, so a world where the press is dropped cannot agree by accident. */
  selectOnly(0);
  paint();
  std.say(env, `${NAME}: win ${made.win}, ${rows.length} process(es)\n`);
  std.say(env, "KRNLms is the kernel's own service time, not CPU: there is no scheduler here.\n");
  std.say(env, "shift+click takes a range, ctrl+click toggles one row, and t/x signal all of "
    + "them.\n");

  /**
   * SIGTERM or SIGKILL to EVERY SELECTED PID. `kill` AND NOT A PRIVILEGE: this program may signal
   * exactly what any process may signal, which is what keeps it a userland client.
   *
   * THE WHOLE SELECTION, because that is what a selection means — a verb that applied to one row
   * of a band the reader built would be a window that did a fraction of what it showed. The pids
   * come out of `rows` rather than out of the set, so the signals go in LAYOUT ORDER and a report
   * reads in the order the reader sees.
   *
   * AN EMPTY SELECTION IS A REFUSAL BY NAME, not a no-op. The selection empties on its own when
   * every process in it exits (see `refresh`), so "nothing happened" is a state a reader can reach
   * without doing anything wrong, and a silent one would read as a broken key.
   */
  const signal = (sig) => {
    const targets = rows.filter((r) => selection.has(r.pid));
    if (!targets.length) {
      account.kills.push({ refused: "nothing is selected" });
      std.say(env, `${NAME}: nothing is selected\n`);
      return;
    }
    let sent = 0;
    for (const row of targets) {
      // NOT ITSELF. A task manager that killed itself would be a window that closed on a keystroke
      // the reader meant for something else, and the pid is right there to compare.
      if (row.pid === env.pid) {
        account.kills.push({ pid: row.pid, refused: "self" });
        continue;
      }
      const r = env.proc.kill(row.pid, sig);
      account.kills.push({ pid: row.pid, sig, r });
      sent += 1;
    }
    // ONE REFRESH FOR THE WHOLE BATCH, and none at all when every target was refused: a re-read
    // that nothing could have changed is a paint a reader cannot distinguish from a signal landing.
    if (sent) refresh();
  };

  let lastRefresh = performance.now();
  let lastWake = performance.now();
  let why = "";
  for (;;) {
    if (performance.now() - lastWake > ceiling) {
      why = `idle for ${ceiling} ms`;
      break;
    }
    if (performance.now() - lastRefresh >= REFRESH_MS) {
      lastRefresh = performance.now();
      const r = refresh();
      if (r < 0 && r !== -EINTR) { why = `refresh: ${std.errnoName(r)}`; break; }
    }
    const got = env.tty.poll([{ fd: made.fd, events: POLLIN }], POLL_MS);
    if (typeof got === "number") {
      if (got === -EINTR) continue;
      if (got < 0) { why = `poll: ${std.errnoName(got)}`; break; }
      continue;
    }
    const rev = got.fds[0].revents;
    if (rev & (POLLHUP | POLLERR | POLLNVAL)) { why = "the window went away"; break; }
    if (!(rev & POLLIN)) continue;
    const evs = env.win.read(made.fd);
    if (evs === -EHOSTGONE) { why = "the window was destroyed"; break; }
    if (typeof evs === "number") {
      if (evs < 0 && evs !== -EINTR) { why = `read(win): ${std.errnoName(evs)}`; break; }
      continue;
    }
    /* ONE RE-SURFACE PER DRAINED BATCH, which is what `lastClientEvent` is for: `win_surface`
     * destroys and rebuilds the canvas page-side, so re-surfacing per event pays a rebuild for
     * every intermediate size of a drag and throws all but the last away. */
    const client = std.lastClientEvent(evs);
    for (const ev of evs) {
      lastWake = performance.now();
      if (ev.type === WEV_KEY) {
        /* A KEYSYM FIRST, because a keysym and a key's bytes are disjoint and exhaustive
         * (`keysymOf` in src/abi.mjs), so the byte reader below never sees an arrow.
         *
         * THE ARROWS DO REACH A PROCESS, and this comment said they could not. What
         * `src/wm/window.mjs` binds them on is the TITLE BAR (`bar.addEventListener("keydown")`),
         * not the frame — so a window whose SURFACE holds the focus receives them, which is what
         * `www/m18.html`'s second proof and `bench/m18-keys/firefox-keys.py` both measure by moving
         * a cursor with a real Down arrow in two engines. They are the frame's only while the
         * caption has the focus, which is where a reader puts it by dragging the window.
         *
         * Shift EXTENDS, and that is the keyboard reaching the same `rangeTo` a Shift+click does.
         *
         * `x` AND NOT `k` FOR SIGKILL. The first version of this bound `k` to both the kill and
         * the up-arrow in one `else if` chain, so one of them was dead code — `x` for "kill it"
         * reads as a close box and collides with nothing. */
        const sym = keysymOf(ev);
        if (sym) {
          const extend = (ev.mods & WMOD_SHIFT) !== 0;
          if (sym === WKEY_DOWN) { if (moveCursor(1, extend)) paint(); }
          else if (sym === WKEY_UP) { if (moveCursor(-1, extend)) paint(); }
          continue;
        }
        const text = new TextDecoder().decode(keyBytesOf(ev));
        if (text === "q") { why = "the reader asked to quit"; break; }
        if (text === "r") refresh();
        else if (text === "t") signal(SIGTERM);
        else if (text === "x") signal(SIGKILL);
        // `u`/`j` ARE THE ARROWS' TWINS and not a second rule: both go through `moveCursor`. They
        // stay because a shifted letter is a different letter — there is no Shift+`j` that is still
        // `j` — so the range-extending half of the gesture is the arrows' alone.
        else if (text === "u") { if (moveCursor(-1, false)) paint(); }
        else if (text === "j") { if (moveCursor(1, false)) paint(); }
      } else if (ev.type === WEV_WHEEL) {
        /* THE WHEEL, IN THE RECORD'S OWN UNIT. `wheelAt` restores the sign — a scroll up is a
         * negative `dy` and an unsigned read turns it into four billion (constraint 225) — and the
         * deltas are SURFACE px for a surfaced window, so `/ S` is the same border `px` guards in
         * the other direction. A `WWHEEL_PAGE` delta is in PAGES and must NOT be divided: it is
         * not a length in any unit, and scaling it would make a page shorter at a high ratio.
         *
         * A COALESCED RECORD IS A SUM AND IS ADDED WHOLE. The kernel merges a run of notches into
         * one record (`WinMgr.feed`), so a program that scrolled by one notch's worth per record
         * would lose everything but the last notch of a fast gesture — the list would stop
         * following the reader's hand. Adding the delta is what makes that automatic.
         *
         * THE AIM POINT IS NOT CONSULTED, because this window has exactly one scrollable region.
         * It rides the record for the program that has two (a Details view's panes, M19), and a
         * reader of this branch should not conclude the position is unavailable.
         *
         * `dx` IS DISCARDED AND THE TABLE DOES NOT SCROLL SIDEWAYS. A box narrower than `TABLE_W`
         * does clip the right of the grid, so an x offset would have something to reveal; what
         * this milestone claims is the vertical axis, and the narrow-box answer is column widths a
         * reader can drag (M19). An undeclared half-working axis is the worse of the two. */
        const w = wheelAt(ev);
        const paged = (ev.mods & WWHEEL_PAGE) !== 0;
        account.wheels += 1;
        if (ev.mods & WWHEEL_COALESCED) account.wheelsCoalesced += 1;
        if (paged) account.wheelPages += 1;
        const by = paged ? w.dy * maxRows * ROW_H : w.dy / S;
        if (!by) continue;
        const want = scroll + by;
        const next = clamp(want);
        // THE TWO ENDS ARE COUNTED SEPARATELY, because they are two clauses: a run that only ever
        // reached the end has not shown that the top clamps, and vice versa.
        if (next !== want) {
          if (want < 0) account.clampTop += 1;
          else account.clampEnd += 1;
        }
        if (next === scroll) continue;
        account.scrolledPx += Math.abs(next - scroll);
        setScroll(next);
        paint();
      } else if (ev.type === WEV_POINTER) {
        /* THE POINTER LEFT, AND IT IS THE ONE RECORD WITH NO POSITION: `a`/`b` are whatever the
         * page reported for a point outside the surface, so this branch MUST clear the hover and
         * MUST NOT hit-test (`WPTR_LEAVE` in src/abi.mjs). Without it the last hover a window ever
         * receives is the one nearest the edge and the lit row never goes out.
         *
         * IT IS TESTED BEFORE THE PRESS AND BEFORE THE HOVER, because `mods` is exactly
         * `WPTR_LEAVE` and matches neither of their shapes — ordering it last would make the
         * reading depend on the other two staying exclusive of it. */
        if (ev.mods & WPTR_LEAVE) {
          account.leaves += 1;
          if (setHover(0)) { account.hoverCleared += 1; paint(); }
          continue;
        }
        /* A HOVER IS WHAT IT IS NOT: no button changed in this record and none is held — `c`
         * carries `event.buttons`, so a DRAG's move is excluded by the record itself and needs no
         * flag. It is the same test the kernel's tail replacement makes (`Window.pushPointer`),
         * deliberately: two tests over one field cannot disagree. `WPTR_MOVE` is not consulted for
         * the same reason it is not there — a hover and a drag sample both carry it.
         *
         * THE STREAM IS THE KERNEL'S TO THIN, NOT THIS PROGRAM'S. A buttonless move replaces a
         * tail buttonless move in the window's own queue (constraint 223's amendment, measured by
         * `bench/m19-hover/probe.py`), so what arrives here is already one record per drain for a
         * program that is busy, and `setHover` makes a sample that does not move the lit row cost
         * no repaint.
         *
         * IT IS TESTED BEFORE THE PRESS, AND THAT IS WHAT KEEPS `--ev-b-pointer` SCOPED. In that
         * world the press test reads a y coordinate as a flag word; a hover reaching it would then
         * select a row on a buttonless move whose y happened to have bit 0x10 set, which is a
         * SECOND defect and would move clauses the control is not about. A record with no button
         * in it is a hover here in both worlds. */
        if (!(ev.mods & (WPTR_DOWN | WPTR_UP)) && !(ev.c | 0)) {
          account.hovers += 1;
          const where = std.cssPointAt(ev, S);
          const over = rowAt(where.y);
          if (setHover(over >= 0 ? rows[over].pid : 0)) paint();
          continue;
        }
        /* `mods` AND NOT `b`. This read `ev.b & WPTR_DOWN`, and `ev.b` is the pointer's Y
         * COORDINATE — `pointerAt` is `{x: ev.a, y: ev.b, buttons: ev.c}` (src/abi.mjs:1424) — so
         * it tested bit 0x10 of a y value and selected a row only when the pointer happened to
         * land in an alternating 16-pixel band. `src/bin/files.mjs:443` and
         * `src/bin/paint.mjs:184` both have it right; this was the one copy that did not, and the
         * audit found it. DOWN/UP/MOVE travel in `mods` beside the keyboard modifiers
         * (src/abi.mjs:418, 463).
         *
         * `--ev-b-pointer` PUTS THE DEFECT BACK, and that is its whole job: a negative control
         * kept as a source mutation is a control nobody re-runs, so the suite's is a flag this
         * program ships — the precedent is `cfg.blurBudgetPx` and `files --css-px-surface`. Five
         * heights are needed to see it, because the failure is PERIODIC in y: with the selection
         * starting at row 0, a press that lands where `y & 0x10` is set still works. */
        if (!(evBPointer ? ev.b & WPTR_DOWN : ev.mods & WPTR_DOWN)) continue;
        /* CSS PIXELS, AND `rowAt` HAS NO OTHER UNIT. A `WEV_POINTER` carries SURFACE pixels
         * (constraint 223) and this program's rows are CSS px, so an undivided y selects the wrong
         * row by a margin that grows down the table: at dpr 2 a press on row 0 at surface y 104
         * resolves to row 3. It is the same unit error as the display side and it was invisible
         * while the surface was a CSS-px box handed to `win_surface` unconverted — fixing only the
         * output side is what would ship it. `std.cssPointAt` is the one converter, and it
         * restores the sign too, which an inlined divide would not. */
        const at = std.cssPointAt(ev, S);
        const hit = rowAt(at.y);
        /* A PRESS ON THE HEADER OR PAST THE LAST ROW CHANGES NOTHING, and does not clear the
         * selection: the only thing below the rows band is the position line and the legend, so a
         * press there is a reader reading rather than a reader deselecting. */
        if (hit < 0) continue;
        /* THE THREE GESTURES, IN THE ORDER THEY MUST BE TESTED. Shift outranks Ctrl, so
         * Shift+Ctrl+click is read as a Shift+click: Windows 7 unions the range into the selection
         * there, and this program does not — a fourth gesture nothing in this milestone's proof
         * exercises would be an undeclared half-working one. */
        if (ev.mods & WMOD_SHIFT) { account.ranges += 1; rangeTo(hit); }
        else if (ev.mods & WMOD_CTRL) { account.toggles += 1; toggleAt(hit); }
        else { account.plainSelects += 1; selectOnly(hit); }
        paint();
      } else if (ev.type === WEV_CLIENT) {
        if (ev !== client) continue;
        const got = std.resurface(env, made.fd, ev);
        if (!got.ok) {
          /* A REFUSED SURFACE DOES NOT CLOSE THE WINDOW. `-ENOMEM` is the surface budget and
           * `-EINVAL` the ceiling (`WinMgr.surface`), and both leave the PREVIOUS surface in
           * place — so the existing layout and `S` are still correct for the canvas that is still
           * there, and the client area merely stretches it, which is what a reader sees mid-drag
           * anyway. Quitting would make a table vanish because a window grew. No repaint: the
           * canvas was not rebuilt, so its pixels are intact.
           *
           * NOT A RETRY LOOP, because nothing re-asks: the kernel raises `WEV_CLIENT` only when
           * the box CHANGES, so the next attempt is a different request. The refusal is said once
           * and then counted — during a drag the page reports per animation frame, and a line per
           * frame on stdout is a terminal nobody can read. */
          if (account.refusedSurface === 0) {
            std.say(env, `${NAME}: win_surface ${std.errnoName(got.errno)} at `
              + `${got.w}x${got.h} device px — keeping the surface it has\n`);
          }
          account.refusedSurface += 1;
          continue;
        }
        account.resurfaces += 1;
        account.clientW = got.w;
        account.clientH = got.h;
        account.dpr = got.dpr;
        relayout(got.wCss, got.hCss, got.dpr);
        paint();
      } else if (ev.type === WEV_CLOSE) {
        why = "the window asked to close";
      } else if (ev.type === WEV_DESTROYED) {
        why = "the window was destroyed";
      } else if (ev.type === WEV_RESIZE) {
        /* DISCARDED, AND IT USED TO REPAINT. `WEV_RESIZE` carries CELLS (src/kernel/wins.mjs) and
         * this program renders no cell grid; it repainted because it was the only signal that the
         * frame had moved, and `WEV_CLIENT` is now that signal in the unit a surface is measured
         * in. It also fires for changes `WEV_RESIZE` suppresses — a resize inside one cell changes
         * every pixel of a table — so the repaint would be both late and incomplete. */
        continue;
      } else if (ev.type === WEV_FOCUS) {
        paint();
      }
    }
    if (why) break;
  }

  env.win.destroy(made.fd);
  return { exit: 0, ...account, why: why || "done" };
}
