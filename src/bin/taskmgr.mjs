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
  WPTR_DOWN, WWHEEL_PAGE, WWHEEL_COALESCED, keyBytesOf, wheelAt,
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

   The worst case per row is one text run per cell with a program name at `NAME_MAX`, plus the
   selected row's two rectangles. `CHROME_OPS` covers the clear, the two header strings, the nine
   column headers, the rule, the clip and its reset, the position line and the legend, with slack.
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

  let selected = 0;

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
     * clamped to the viewport any more — it indexes the whole table — so a resize leaves it alone
     * and `ensureVisible` brings it back when the reader moves it. */
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

    shown.forEach((row, n) => {
      /** The row's own index in the TABLE, which is what `selected` holds. */
      const i = first + n;
      const top = TASKMGR_METRICS.rowTopAt(i, scroll);
      if (i === selected) {
        ops.push({
          op: DL_FILL_RECT, a0: px(PAD), a1: px(top), a2: px(tableW - PAD * 2), a3: px(ROW_H),
          a4: SELECT_FILL,
        });
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
    ops.push(...encodeTextRun(
      "u/j select   wheel scrolls   click a row   "
      + "t = SIGTERM   x = SIGKILL   r = refresh   q = quit", {
        x: px(PAD), y: px(viewH - 16), size: px(TEXT_PX - 1), rgba: INK_DIM,
      }));
    return env.win.draw(made.fd, ops);
  };

  const refresh = () => {
    const got = readTable(env);
    if (typeof got === "number") return got;
    rows = got;
    account.refreshes += 1;
    account.rows = rows.length;
    if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
    /* A SHORTER TABLE SHORTENS THE SCROLL RANGE. Processes exit, so a refresh can leave the offset
     * past the end of its own table — which draws a viewport of nothing and no error. */
    setScroll(clamp(scroll));
    paint();
    return 0;
  };
  paint();
  std.say(env, `${NAME}: win ${made.win}, ${rows.length} process(es)\n`);
  std.say(env, "KRNLms is the kernel's own service time, not CPU: there is no scheduler here.\n");

  /** SIGTERM or SIGKILL to the selected pid. `kill` AND NOT A PRIVILEGE: this program may signal
   *  exactly what any process may signal, which is what keeps it a userland client. */
  const signal = (sig) => {
    const row = rows[selected];
    if (!row) return;
    // NOT ITSELF. A task manager that killed itself would be a window that closed on a keystroke
    // the reader meant for something else, and the pid is right there to compare.
    if (row.pid === env.pid) {
      account.kills.push({ pid: row.pid, refused: "self" });
      return;
    }
    const r = env.proc.kill(row.pid, sig);
    account.kills.push({ pid: row.pid, sig, r });
    refresh();
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
        const text = new TextDecoder().decode(keyBytesOf(ev));
        /* LETTERS AND NOT ARROWS, because the ARROWS BELONG TO THE FRAME: `src/wm/window.mjs`
         * binds them to move the window and to snap it, so they are consumed before a process
         * ever sees them. A program that advertised arrow keys here would advertise a key it
         * cannot receive.
         *
         * `x` AND NOT `k` FOR SIGKILL. The first version of this bound `k` to both the kill and
         * the up-arrow in one `else if` chain, so one of them was dead code — `x` for "kill it"
         * reads as a close box and collides with nothing. */
        if (text === "q") { why = "the reader asked to quit"; break; }
        if (text === "r") refresh();
        else if (text === "t") signal(SIGTERM);
        else if (text === "x") signal(SIGKILL);
        /* THE SELECTION INDEXES THE TABLE AND NOT THE VIEWPORT, which is M17's change to these two
         * keys: `j` stopped at `maxRows - 1` because that was the last row that existed on screen,
         * and a reader could not reach — or signal — a process below the fold at all. It follows
         * the keys now, and `ensureVisible` scrolls the least that keeps it in sight. */
        else if (text === "u") {
          selected = Math.max(0, selected - 1);
          ensureVisible(selected);
          paint();
        } else if (text === "j") {
          selected = Math.max(0, Math.min(rows.length - 1, selected + 1));
          ensureVisible(selected);
          paint();
        }
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
        if (hit >= 0) { selected = hit; paint(); }
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
