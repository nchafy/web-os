// `files`: a window of file rows you can DRAG OUT of.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// THIS IS HALF OF M10's HEADLINE AS A PROGRAM YOU CAN RUN — `imgview` is the other half. The
// milestone's claim is that bytes of a declared format cross from one process to another on a
// gesture, so there have to be two processes and a gesture:
//
//   files                       a row per file in /usr/share
//   press a row and drag it     onto `imgview`'s window. The row's bytes arrive there under the
//                               format this program declared, and the kernel owns the payload in
//                               between — so this process may exit mid-drag and the drop still
//                               lands (constraint 241)
//   files /some/dir             any directory
//
// WHAT IT OFFERS PER ROW: the PATH LIST always, and the file's own format from
// `std.formatForPath` — `.png` as PNG, `.rgba` as a bitmap, `.txt` as text. Which is to say the
// offer is a FILE ASSOCIATION, and it is one table in one place (`src/libos/std.mjs`).
//
// THE ROWS ARE TEXT, since `DL_TEXT` arrived in M15 (constraint 293): a small glyph, a name, and
// the type right-aligned. They were coloured BANDS with no name on them, because the display list
// had no text op — a column of amber and blue stripes, which a reader summarised as "the file
// system view is not correct". The band colour survives as the glyph's, so the amber a reader
// learned to read as "directory" is still amber.
//
// UNITS, AND THEY ARE THE WHOLE OF M16 (PRD §2). Every layout constant in this file is a CSS
// pixel, because a list view's metrics are what a reader reasons about. A SURFACE coordinate is a
// different unit: `win_surface` is asked for DEVICE pixels, and `WEV_CLIENT` is a program's only
// route to the ratio between them. So the factor `S` exists once, is applied once — in `px`, on
// the way into the display list — and the device-px box becomes CSS px at exactly one boundary, in
// `relayout`. Before this, `SURFACE_W = 420` was handed to `win_surface` unconverted: one integer
// in two units, which on a dpr-2 display is a 420-pixel picture stretched over an 856-pixel client
// area, and which no amount of resizing could ever sharpen.
//
// M17: IT SCROLLS, AND THE VIEWPORT IS CLIPPED. `WEV_WHEEL` moves a scroll offset and `DL_CLIP`
// bounds what a row may paint to the list area below the header. Both halves are needed: a row
// scrolled half out of the top paints over the header without the clip, and the row after the last
// visible one paints past the bottom edge. The offset CLAMPS at both ends, so a wheel at the top of
// the list and a wheel at the bottom of it both stop rather than running the content off the window.
//
// THE WHEEL'S DELTAS ARE SURFACE PIXELS (constraint 248), like `WEV_POINTER`'s coordinates, so they
// divide by `S` on the way in — the same border `cssPointAt` is on, and the same unit error M16
// cost a milestone for. `WWHEEL_PAGE` says the delta is in PAGES instead, and a page here is the
// viewport's own height.
//
// WHAT THE SCROLL REPLACES: the row CAP and the "+N more" line constraint 294 required. That
// constraint's premise was that the window ABI delivered no wheel, so a scrollbar would be a control
// this program could not receive input for; `WEV_WHEEL` removes the premise. The remainder is now
// REACHABLE rather than stated, and the header names which rows are on screen so a reader still
// knows where in the list they are. There is still no scrollbar, for the unchanged half of the
// reason: a thumb is dragged, and a drag on one would be a gesture this program cannot route.
//
// `--no-drain MS` IS A FIXTURE AND NOT A CONTROL, which is why it is documented apart from the two
// below. It holds the event loop for MS milliseconds before the first poll, so a notch stream longer
// than `WIN_EVENT_CAP` laps a queue nobody is draining — the state the kernel's wheel coalescing is
// proven in, and the state an uncoalesced stream drops its NEWEST record in. It breaks nothing by
// itself: when the hold ends the program drains the queue and applies the whole summed delta, which
// is the clause the proof asserts. The precedent for a shipped flag whose only job is to put the
// system into a state a check needs is `cfg.blurBudgetPx` and `scripts/serve.py --no-isolation`.
//
// THREE FLAGS EXIST ONLY TO BREAK THAT, as negative controls a check can re-run rather than source
// mutations nobody re-runs (the precedent is `scripts/serve.py --no-isolation`):
//
//   --no-resurface      ignore `WEV_CLIENT` entirely. The pre-M16 program exactly: a backing store
//                       that never follows its window, so a resize CSS-stretches a 420 px list
//                       over however much room the reader just made. The reported defect, restored.
//   --css-px-surface    refit, but ask for the client box in CSS pixels and leave `S` at 1 — the
//                       unit error on its own, with the resize path working.
//   --unclamped-scroll  accept an offset past the END of the list. M17's clamp control: the list
//                       scrolls into blank paper below its last row and nothing refuses. The TOP
//                       clamp stays — removing both costs a clause this control is not about, and
//                       the harness said so. It counts no bottom clamp, because a clamp that did
//                       not happen must not be reported as one.
//
// Neither belongs on a prompt. A reader who passes one gets the bug the milestone removed.

import {
  POLLIN, POLLHUP, POLLERR, POLLNVAL, EINTR, EINVAL, EHOSTGONE, DT_DIR,
  WEV_KEY, WEV_POINTER, WEV_CLOSE, WEV_DESTROYED, WEV_RESIZE, WEV_FOCUS, WEV_DRAG_DONE,
  WEV_CLIENT, WPTR_DOWN, WPTR_UP, WPTR_MOVE, clientBoxAt, keyBytesOf,
  WEV_WHEEL, WWHEEL_PAGE, WWHEEL_COALESCED, wheelAt,
  DL_CLEAR, DL_FILL_RECT, DL_STROKE_RECT, DL_CLIP,
  DLT_BOLD, DLT_MONO, DLT_RIGHT, encodeTextRun,
  DOBJ_PATHS, DOBJ_TEXT, DOBJ_PNG, DOBJ_BITMAP, DOBJ_EFFECT_COPY,
  O_RDONLY, fmtName, fmtsOf,
} from "/src/abi.mjs";

const NAME = "files";

const POLL_MS = 200;
const CEILING_MS = 300000;

/** The default directory, which is where M10's own assets live. */
const DEFAULT_DIR = "/usr/share";

/* ONE ROW, IN CSS PIXELS — the unit a list view's metrics are reasoned about in, and the unit
 * every constant below shares. A surface coordinate is `S` times one of these and is produced
 * nowhere but `px`.
 *
 * The geometry is a list view's: a header row, then one row per entry, each with a small glyph, a
 * name, and the type right-aligned. */
const ROW_H = 20;
const ROW_GAP = 2;
const PAD = 6;
/** The header, which is also what makes the first row's `y` not zero. */
const HEAD_H = 22;
/** The glyph box at the left of a row: a folder or a page, drawn out of rectangles. */
const GLYPH_W = 16;
/** Where the name starts. A fixed inset, so it does not follow the window. */
const NAME_X = PAD + GLYPH_W + 8;
/** How far inside the padding the type column's right edge sits. The column is right-aligned to
 *  the LIVE width, so this is an inset and not a position. */
const TYPE_INSET = 4;
const TEXT_PX = 12;
/** Text sits this far below a row's top, which centres a 12 px run in a 20 px row. */
const TEXT_DY = 4;
/** The width the window OPENS at, CSS px. It is a guess and nothing reads it afterwards: the first
 *  `WEV_CLIENT` replaces it with the measured client box. */
const START_W = 420;
/** How many rows the window OPENS tall. 24 rows plus a header is about 560 CSS px, which fits the
 *  work area on the smallest screen this has been opened on and leaves the taskbar reachable. It
 *  decides the OPENING HEIGHT ONLY and caps nothing: the list scrolls, so a longer directory is
 *  reachable at this height and a taller window shows more of it at once. */
const START_ROWS = 24;

/** One row's pitch: its height plus the gap under it. The whole of the scroll arithmetic. */
const ROW_STRIDE = ROW_H + ROW_GAP;
/** The top of the CLIPPED viewport, CSS px — below the header rule at `HEAD_H - 4` and above the
 *  first row at `HEAD_H + PAD`, so a row scrolled under the header is cut here and the rule and its
 *  padding stay visible. It is the clip's edge and not a row's, which is why it is its own
 *  constant. */
const VIEW_TOP = HEAD_H;

/** The y of a row's top, CSS px, measured inside the client area and MINUS THE SCROLL OFFSET.
 *  `scroll` defaults to 0, which is the unscrolled layout every caller before M17 asked for. */
const rowTop = (i, scroll = 0) => HEAD_H + PAD + i * ROW_STRIDE - scroll;
/** The middle of a row, CSS px: where a driver outside the process aims. */
const rowMid = (i, scroll = 0) => rowTop(i, scroll) + ROW_H / 2;

/**
 * The row index a CSS-px `y` falls in at scroll offset `scroll`, or `-1` for the header, a gap
 * between two rows, or anything above the list. THE DECLARED INVERSE OF `rowTop`, which is what
 * makes a press land on the row a reader sees — `src/wm/desktop.mjs` states the same rule for its
 * icon grid.
 *
 * IT IS NOT BOUNDED BY THE ROW COUNT OR BY THE VIEWPORT, because both are live and this object is
 * frozen. The caller bounds it; see `rowUnder` in `run`.
 */
const rowAt = (yCss, scroll = 0) => {
  const i = Math.floor((yCss - rowTop(0, scroll)) / ROW_STRIDE);
  if (i < 0) return -1;
  // The gap between two rows belongs to neither, so a press there selects nothing rather than
  // the row above it by rounding.
  return yCss - rowTop(i, scroll) < ROW_H ? i : -1;
};

/**
 * THE CLIPPED VIEWPORT, CSS px, inside a client area `wCss` x `hCss`. One rectangle, read in three
 * places — the `DL_CLIP` op, the hit test's bound, and whatever outside the process wants to aim
 * inside it — so a driver cannot pick a point the program would clip away.
 *
 * ITS BOTTOM KEEPS `PAD`, which is what makes the bottom edge a VIEWPORT edge rather than the
 * canvas's: a row cut there was cut by this rectangle, and a check reading the pixels can tell the
 * two apart. `scrollMax` is derived from the same `PAD`, so the last row's bottom lands exactly on
 * it at full scroll.
 */
const viewBox = (wCss, hCss) => ({
  x: 0, y: VIEW_TOP, w: Math.max(0, wCss), h: Math.max(0, hCss - VIEW_TOP - PAD),
});

/** The largest legal scroll offset for `n` rows in a client area `hCss` tall, CSS px: the offset at
 *  which the last row's bottom sits on the viewport's. ZERO when everything fits, which is the top
 *  clamp and the bottom clamp being the same number — a window taller than its content cannot
 *  scroll at all. The DECLARED PARTNER of `rowTop`: `rowTop(n - 1, scrollMax(n, h)) + ROW_H` is the
 *  viewport's bottom. */
const scrollMax = (n, hCss) =>
  Math.max(0, (n > 0 ? rowTop(n - 1) + ROW_H : 0) + PAD - hCss);

/** How many rows a client area `hCss` CSS px tall shows at once — `viewBox`'s height less the pad
 *  above the first row, in whole pitches. At least one: a window clamped to its minimum still owes
 *  a reader a row rather than a header over nothing. `clientHeightFor` is the declared inverse. */
const rowsThatFit = (hCss) =>
  Math.max(1, Math.floor((hCss - VIEW_TOP - PAD * 2 + ROW_GAP) / ROW_STRIDE));

/** The client height `n` rows need, CSS px. Only the OPENING size reads it — after that the height
 *  is the reader's and the row count follows it — but it is `rowsThatFit`'s declared inverse, so
 *  `scrollMax(n, clientHeightFor(n))` is 0 and a window opened to fit its content cannot scroll. */
const clientHeightFor = (n) => VIEW_TOP + PAD * 2 + n * ROW_STRIDE - ROW_GAP;

/** A CSS-px length as a surface coordinate, rounded: `encodeDrawOp` truncates (`a0: op.a0 | 0`),
 *  and a truncated edge is a half-pixel seam at a fractional ratio. */
const toSurface = (vCss, scale) => Math.round(vCss * scale);

/**
 * WHAT A ROW IS: `DIR`, a format name, `PROG`, or a dash — in that order of specificity, and in
 * ONE place because three things print it. The drawn type column, the `account.rows` a check reads
 * and the stdout legend all said it separately, and the format is what decides whether a row can
 * be DRAGGED — so a reader who was shown one word and refused for another would have no way to
 * tell which of the three was lying (constraint 294).
 *
 * The execute bit is the fallback and not a guess at a format: `/usr/bin` is 32 files no extension
 * rule covers, and a column that read `fmt?0` thirty-two times carried no information at all.
 */
const kindOf = (row) => (row.dir ? "DIR"
  : row.format ? fmtName(row.format)
    : row.exec ? "PROG" : "—");

/**
 * THIS PROGRAM'S ROW GEOMETRY, EXPORTED — because things outside the process need it and each copy
 * is a copy that drifts.
 *
 * `www/m10.html` drives a REAL mouse onto a row and `bench/m10-data/shell.py` does the same at a
 * prompt; both used to restate `ROW_H = 22` and `ROW_GAP = 4` beside their own `rowMid`, and
 * CLAUDE.md listed them as a known second copy with the consequence spelled out: "a drift there
 * arrives as the WRONG FILE being dragged, which the run prints". M15 made that true — the rows
 * moved down by a header and shrank by 2 px — so the copies went.
 *
 * EVERY LENGTH HERE IS A CSS PIXEL, AND M16 IS WHY THAT NOW HAS TO BE SAID. The surface is the
 * client box in DEVICE pixels, so a driver that wants surface coordinates converts with
 * `toSurface(v, scale)` — the same arithmetic the program draws with, which is the point of
 * exporting it rather than a number. The honest `scale` for a driver is MEASURED, not assumed:
 * `canvas.width / canvas.getBoundingClientRect().width`. A driver working in page coordinates
 * needs no scale at all, because the canvas's CSS box IS the client area these are measured in —
 * `rect.left + xCss` is the point.
 *
 * `SURFACE_W` IS THE OPENING WIDTH AND NO LONGER THE LIVE ONE. It cannot be live: a page imports
 * this module into its own realm, and the running process has another — two module instances, so
 * no exported binding can carry the program's state. The live width is readable where it is
 * actually true, off the canvas.
 *
 * M17: THE SCROLL OFFSET IS A PARAMETER OF THE ROW ARITHMETIC, for the same reason. The offset is
 * the running process's state and no export can carry it either, so `rowTop`, `rowMid` and `rowAt`
 * take it — defaulting to 0, which is every pre-M17 caller's unscrolled list and why none of them
 * had to change. A driver that scrolled the list reads the offset the program REPORTS (`scroll` in
 * its account, and the line it prints on exit) and passes it here; `scrollMax` is what the end
 * clamps are, so a driver can assert the clamp against the program's own arithmetic rather than a
 * number of its own.
 */
export const FILES_METRICS = Object.freeze({
  ROW_H, ROW_GAP, ROW_STRIDE, PAD, HEAD_H, VIEW_TOP, NAME_X, GLYPH_W, TEXT_PX,
  SURFACE_W: START_W,
  rowTop, rowMid, rowAt, toSurface, viewBox, scrollMax, rowsThatFit,
});

const PAPER = 0x12161cff;
const OUTLINE = 0xdde3ebff;
/** A row's colour IS ITS FORMAT, because that is the only thing a reader can see without text. */
const BAND = {
  [DOBJ_PNG]: 0x4a9bd8ff,
  [DOBJ_BITMAP]: 0x9fd4a8ff,
  [DOBJ_TEXT]: 0x8a8f98ff,
};
const BAND_UNKNOWN = 0x3a3f48ff;
/* THE INK. A list is read, so the contrast between these and `PAPER` is the whole of whether it
   works — and the selected row inverts, which is what every file manager does. */
const INK = 0xe8edf4ff;
const INK_DIM = 0x97a1afff;
const INK_SELECTED = 0x0b1118ff;
const HEAD_INK = 0xbcc8d6ff;
const HEAD_RULE = 0x2a313bff;
const SELECT_FILL = 0x9fd4a8ff;
const SELECT_FILL_DIR = 0xe8aa3cff;
/** A DIRECTORY'S BAND, which is a kind rather than a format: amber, because that is the colour the
 *  shell's folder icon is drawn in (`src/wm/icons.mjs`) and a reader should see one thing. */
const BAND_DIR = 0xe8aa3cff;

/**
 * HOW FAR THE POINTER MUST MOVE BEFORE A PRESS BECOMES A DRAG, in CSS pixels.
 *
 * IT WAS SURFACE PIXELS AND THE NUMBER DID NOT MOVE, because the coordinate did. A pointer event
 * carries surface pixels and is converted once, at `cssPointAt`, so every comparison below it is
 * in the reader's unit — and a threshold that stayed in surface pixels would be 3 device pixels,
 * which is 1.5 CSS pixels at dpr 2: half a hand tremor, and every click a drag.
 *
 * A PRESS ALONE MUST NOT START ONE: every click on a row would otherwise begin a gesture that ends
 * on the next pointerup, and the kernel's single session would spend its life being started and
 * cancelled. Windows has the same threshold for the same reason.
 *
 * THE HYSTERESIS IS THE PRESS AND NOT A SECOND DISTANCE. The threshold arms once per press and the
 * release disarms it, so a drag that comes back inside 3 px is still a drag — a distance test on
 * the way down would make one gesture several. `www/m10.html` drives both edges: a 1 px move must
 * start nothing and a long one must start exactly one session.
 */
const DRAG_THRESHOLD_CSS_PX = 3;

function unInterrupted(call) {
  const first = call();
  if (first !== -EINTR) return first;
  return call();
}

/** Read a whole file, or a negative errno. */
function readFile(env, path) {
  const fd = env.fs.open(path, O_RDONLY);
  if (fd < 0) return fd;
  try {
    return env.std.slurp(env, fd);
  } finally {
    env.fs.close(fd);
  }
}

export function run(env) {
  const argv = (env.argv || []).map(String);
  /* THE TWO CONTROLS COME OFF ARGV BEFORE `getopt`, which knows single letters only — a
   * `--no-resurface` reaching it is refused as an unknown `-`. `--` still ends the options, so a
   * directory named like a flag stays reachable. The long-option loop is `src/bin/term.mjs`'s
   * convention (`--title`, `--run`, `--ceiling`). */
  let frozenSurface = false;
  let cssPxSurface = false;
  let unclampedScroll = false;
  let noDrainMs = 0;
  const rest = [];
  let endOfOptions = false;
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!endOfOptions) {
      if (arg === "--") { endOfOptions = true; rest.push(arg); continue; }
      if (arg === "--no-resurface") { frozenSurface = true; continue; }
      if (arg === "--css-px-surface") { cssPxSurface = true; continue; }
      if (arg === "--unclamped-scroll") { unclampedScroll = true; continue; }
      if (arg === "--no-drain") {
        // Refused, not silently defaulted — `--ceiling`'s rule in src/bin/term.mjs: `Number(x) || d`
        // accepts both `0` and `abc`, and a fixture that silently did not hold is a check that
        // passed over a draining program.
        const raw = args[i + 1];
        const ms = Number(raw);
        if (raw === undefined || !Number.isFinite(ms) || ms <= 0) {
          return {
            exit: env.std.complain(env, NAME, raw === undefined ? "--no-drain" : String(raw),
              "--no-drain wants a positive number of milliseconds", env.std.EXIT_USAGE),
            program: NAME,
          };
        }
        noDrainMs = ms;
        i += 1;
        continue;
      }
    }
    rest.push(arg);
  }
  const { operands, bad, why: badWhy } = env.std.getopt(rest, "");
  if (bad) {
    return { exit: env.std.complain(env, NAME, bad, badWhy, env.std.EXIT_USAGE), program: NAME };
  }
  const dir = operands[0] || DEFAULT_DIR;
  const t0 = performance.now();
  const account = {
    program: NAME, dir, win: 0, fd: 0, rows: [], drags: 0, refusedDrags: 0,
    pointers: 0, presses: 0, drops: [], effects: [], why: "",
    // M16. The geometry, in both units, and what happened to it: `surface` is DEVICE px (what the
    // kernel granted), `client` is CSS px (what the layout is in), `dpr` is the factor.
    clients: 0, resurfaces: 0, refusedSurfaces: 0, surfaceWhy: "",
    surface: { w: 0, h: 0 }, client: { w: 0, h: 0 }, dpr: 1,
    /* M17. THE SCROLL STATE, IN CSS PIXELS, AND WHAT THE WHEEL DID TO IT. `scroll` is where the
     * list sits and `scrollMax` is its bottom clamp, so a driver reads both and needs neither
     * restated. `dyTotal` is the SUM OF EVERY DELTA ASKED FOR, clamped or not — the clause "the
     * offset equals the full summed delta" is `scroll === dyTotal`, and it separates a lost notch
     * from a notch the clamp ate. `clamped` counts each end, because both edges are asserted and a
     * single "it clamped" passes for a list that only ever hit one of them. */
    wheels: 0, coalescedWheels: 0, pageWheels: 0, scroll: 0, scrollMax: 0, dyTotal: 0,
    clamped: { top: 0, bottom: 0 },
    /* THE VIEWPORT'S CONTENTS. `firstRow` is the row at the top of it and `shownRows` is how many
     * were DRAWN, which is `maxRows` plus the one the clip cuts in half — a scrolled list almost
     * always has a partial row at an edge, so the two numbers differ by design and neither is the
     * other's bound. Nothing is HIDDEN any more: `rows.length - shownRows` is what the reader
     * scrolls to rather than what they are told about. */
    maxRows: START_ROWS, shownRows: 0, firstRow: 0,
    controls: { frozenSurface, cssPxSurface, unclampedScroll },
    // A FIXTURE AND NOT A CONTROL (see this file's header), so it is reported apart from them.
    noDrainMs, heldMs: 0,
  };

  // The directory with exactly one trailing slash, so a child path is `base + name` and the
  // root does not become `//name`.
  const base = dir.endsWith("/") ? dir : `${dir}/`;
  const entries = env.std.listDir(env, dir);
  if (typeof entries === "number") {
    return {
      exit: env.std.complainErrno(env, NAME, dir, entries), program: NAME, errno: -entries,
    };
  }
  /* A ROW PER ENTRY, AND A DIRECTORY IS AN ENTRY — which M14 is why: `files /` showed NOTHING,
   * because the root holds only directories and this program listed only files whose format it
   * knew. So a double-click on the desktop's Computer icon opened a program that exited at once
   * with "no file here has a known format", and a reader saw a live-looking icon do nothing. A
   * file manager that cannot show a folder is not a file manager.
   *
   * A DIRECTORY IS NOT A DRAG SOURCE. It has no format — there are no bytes to offer, and a
   * program that put a directory's PATH under TEXT would be making the guess a typed clipboard
   * exists to refuse (constraint 247) — so its band is drawn in the unknown colour and
   * `startDrag` refuses it by name. A FILE no format rule covers is kept for the same reason the
   * directory is: a row a reader can see and cannot drag is honest, and an invisible file is not.
   */
  const rows = entries
    .filter((e) => e.name !== "." && e.name !== "..")
    .map((e) => {
      const dir = e.type === DT_DIR;
      const format = dir ? 0 : env.std.formatForPath(e.name);
      /* THE KIND, WHICH IS WHAT THE TYPE COLUMN SHOWS WHEN THERE IS NO FORMAT.
       *
       * It printed `fmt?0` for every row of `/usr/bin` — `fmtName(0)` for a file whose extension
       * nothing maps, which is every program in the system. A column that reads `fmt?0` thirty-two
       * times is a column carrying no information, and it was the first thing visible once the
       * names were legible.
       *
       * One `lstat` per row buys it. That is 32 extra calls for a directory of 32 things, which is
       * what `ls -l` already costs — and the alternative is a listing that cannot tell a program
       * from a data file, which is the distinction a reader of `/usr/bin` most wants. */
      let exec = false;
      if (!dir) {
        const st = env.fs.lstat(dir ? e.name : `${base}${e.name}`);
        if (typeof st !== "number") exec = (st.mode & 0o111) !== 0;
      }
      return { name: e.name, dir, format, exec };
    })
    .sort((a, b) => {
      // Directories first, then by name, which is every file manager's order.
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name < b.name ? -1 : 1;
    })
    .map((r) => ({ ...r, path: dir.endsWith("/") ? `${dir}${r.name}` : `${dir}/${r.name}` }));
  account.rows = rows.map((r) => ({ name: r.name, format: kindOf(r) }));
  if (rows.length === 0) {
    return {
      exit: env.std.complain(env, NAME, dir, "this directory is empty"), program: NAME,
      ...account,
    };
  }

  /* ---- THE LIVE LAYOUT, WHICH IS WHAT M16 ADDED -------------------------------------------- */

  /** Surface pixels per CSS pixel. `1` until the first `WEV_CLIENT`, and the display's ratio after
   *  it: `std.resurface` asks for exactly the client box in device px, so the surface and the
   *  display share a unit and ONE factor converts both directions. A program that asked for some
   *  other backing-store size would not have that coincidence and could not use `cssPointAt`. */
  let S = 1;
  /** The client area, CSS px. The opening guess until the first `WEV_CLIENT` measures it. */
  let clientW = START_W;
  let clientH = 0;
  /** The surface the kernel granted, DEVICE px. Kept beside `S` because the clip rect is checked
   *  against it before it is sent: `win_draw` refuses a WHOLE batch whose `DL_CLIP` starts outside
   *  the surface, so a viewport the window has no room for must not be named at all. */
  let surfW = 0;
  let surfH = 0;
  /** The selected row, the press that might become a drag, and whether it has. Declared here
   *  because a resize re-reads them. */
  let press = null;
  let dragging = false;
  let hot = -1;

  /* ---- THE SCROLL OFFSET, WHICH IS WHAT M17 ADDED ------------------------------------------ */

  /** How far down the list the viewport sits, CSS px. FRACTIONAL ON PURPOSE: a notch is surface px
   *  divided by `S`, so at dpr 2 an odd delta is a half CSS pixel, and rounding each notch would
   *  lose a pixel per notch over a long gesture. `px` rounds at the display boundary, which is the
   *  one place a fraction may not survive. */
  let scroll = 0;

  /** The bottom clamp for the live row count and client height. */
  const maxScroll = () => FILES_METRICS.scrollMax(rows.length, clientH);

  /**
   * Move the offset by `dCss` and CLAMP IT AT BOTH ENDS, counting each end separately.
   *
   * BOTH EDGES ARE REAL AND BOTH ARE COUNTED, because both are asserted and a single "it clamped"
   * passes for a list that only ever reached one of them. The top clamp is 0 — a list does not
   * scroll above its first row — and the bottom is `scrollMax`, which puts the last row's bottom on
   * the viewport's rather than leaving the content to run off the window.
   *
   * THE ASKED-FOR DELTA IS SUMMED WHETHER OR NOT IT LANDED (`dyTotal`), which is what makes "the
   * offset equals the full summed delta" an assertion about COALESCING rather than about clamping:
   * a notch the clamp ate is visible as the difference, and a notch the kernel dropped is not in
   * either number.
   */
  const scrollBy = (dCss) => {
    if (dCss === 0) return false;
    account.dyTotal += dCss;
    const want = scroll + dCss;
    const limit = maxScroll();
    let next = want;
    /* THE COUNT IS OF CLAMPS AND NOT OF MOVES, so a wheel at an end that moves nothing still
     * counts: the clamp is what stopped the delta, and a reader pushing at the top of a list gets
     * one per notch. SAID ONCE PER EDGE, which is the rule the surface refusal in the event loop
     * already follows: a line per notch is a flood, and the count carries the rest. */
    /* `--unclamped-scroll` REMOVES THE END CLAMP, AND ONLY THAT ONE. It is a CONTROL rather than a
     * fixture: the world in which the list scrolls past its last row into blank paper, and nothing
     * refuses. Nothing counts a bottom clamp either, because a clamp that did not happen must not
     * be reported as one — an `account.clamped` that rose while the offset ran past the end would
     * make the program's own report disagree with its behaviour, and the check reads that report.
     *
     * THE TOP CLAMP STAYS, which is the difference between this control and a useless one.
     * `docs/PLAN-SHELL.md` §M17 asks that "the clamp clauses MUST fail alone", and removing BOTH
     * edges cannot deliver that: the page establishes its magnitude clause by scrolling back to
     * the top and measuring a known delta from there, so a list that cannot reach the top loses a
     * clause this control is not about. Measured, not reasoned — with both edges gone the control
     * also turned `and the scroll matched the wheel the page received`, and the harness refused it
     * for moving a clause it claims not to touch. */
    if (unclampedScroll && want > limit) {
      account.scrollMax = limit;
      if (want === scroll) return false;
      scroll = want;
      account.scroll = scroll;
      return true;
    }
    if (want < 0) {
      next = 0;
      account.clamped.top += 1;
      if (account.clamped.top === 1) env.std.say(env, `${NAME}: the list is at the top\n`);
    } else if (want > limit) {
      next = limit;
      account.clamped.bottom += 1;
      if (account.clamped.bottom === 1) {
        env.std.say(env, `${NAME}: the list is at the end, offset ${Math.round(limit)} CSS px\n`);
      }
    }
    account.scrollMax = limit;
    if (next === scroll) return false;
    scroll = next;
    account.scroll = scroll;
    return true;
  };

  /** The rows the viewport shows at the current offset: `[first, last]` inclusive, or `first > last`
   *  for a viewport with no room in it. BOUNDED BY THE VIEWPORT AND NOT BY A CAP, which is what
   *  keeps the op count of a frame the same as the pre-M17 capped list's — a 4,000-entry directory
   *  draws the forty rows a reader can see, not four thousand the clip would throw away. */
  const visible = () => {
    const box = FILES_METRICS.viewBox(clientW, clientH);
    if (box.h <= 0) return { first: 0, last: -1 };
    /* FLOORED TO THE PITCH, which can name a row whose last pixel sits just above the viewport. The
     * clip discards that row and erring this way is how a PARTIALLY visible one is never missed;
     * erring the other way is a blank strip under the header on every fractional offset. */
    const first = Math.max(0, Math.floor((scroll + VIEW_TOP - rowTop(0)) / ROW_STRIDE));
    let last = first - 1;
    while (last + 1 < rows.length && rowTop(last + 1, scroll) < box.y + box.h) last += 1;
    return { first, last };
  };

  /* THE OPENING HEIGHT FITS WHAT IT CAN AND SCROLLS TO THE REST, which is the one line M17 changed
   * here: the window used to open at the height of the rows it would DRAW, with a slot for the
   * "+N more" line. `START_ROWS` is a ceiling on the opening HEIGHT and no longer on the list. */
  clientH = clientHeightFor(Math.min(rows.length, START_ROWS));
  account.scrollMax = maxScroll();
  account.maxRows = rowsThatFit(clientH);

  const made = env.win.create({
    // THE FRAME IS THE CLIENT BOX PLUS A GUESS AT THE CHROME, and the guess is all it may be: what
    // the chrome costs is the page's to measure, and `WIN_CAP_H`/`WIN_INSET` describe no element
    // on four of the five hosts that render a surface (PRD §2). The first `WEV_CLIENT` corrects
    // whatever this opened at.
    title: `${NAME} — ${dir}`, w: clientW + 20, h: clientH + 40,
    // CLEAR OF THE DESKTOP'S ICON COLUMN: see `WIN_ORIGIN_X` in src/libos/std.mjs.
    x: env.std.WIN_ORIGIN_X, y: env.std.WIN_ORIGIN_Y,
  });
  if (typeof made === "number") {
    return { exit: 2, ...account, why: `win_create: ${env.std.errnoName(made)}`, errno: -made };
  }
  account.win = made.win;
  account.fd = made.fd;
  /* THE OPENING SURFACE IS ASKED FOR IN CSS NUMBERS, AND IT IS THE ONE REQUEST THAT CANNOT BE IN
   * DEVICE PIXELS: `WEV_CLIENT` is a program's only route to the ratio (PRD §2) and it has not
   * arrived yet. So the first frame is drawn at `S = 1` and CSS-stretched — the pre-M16 picture,
   * for as long as it takes one geometry report to cross — and then the client event refits it.
   *
   * DRAWN AT ONCE RATHER THAN WAITING FOR THE MEASUREMENT, because a host that reports no client
   * box would otherwise leave a reader looking at an empty window for ever, and a program must not
   * depend on an event to show anything at all. */
  const surf = env.win.surface(made.fd, Math.round(clientW), Math.round(clientH));
  if (surf < 0) {
    env.win.destroy(made.fd);
    return { exit: 3, ...account, why: `win_surface: ${env.std.errnoName(surf)}`, errno: -surf };
  }
  surfW = Math.round(clientW);
  surfH = Math.round(clientH);
  account.surface = { w: surfW, h: surfH };
  account.client = { w: clientW, h: clientH };

  /** The row under a CSS-px `y`, or -1. `FILES_METRICS.rowAt` is the arithmetic — the declared
   *  inverse of the `rowTop` that `paint` draws with, at the SAME offset — and the BOUND is here
   *  because both the row count and the viewport are live.
   *
   *  A PRESS OUTSIDE THE VIEWPORT FINDS NOTHING. The clip is what makes that necessary: a row the
   *  reader cannot see because it was clipped away is still at a `y` the arithmetic maps, and
   *  selecting it would be a press landing on a row nobody can see — the hit test and the clip must
   *  bound the same rectangle or one of them is lying. */
  const rowUnder = (yCss) => {
    const box = FILES_METRICS.viewBox(clientW, clientH);
    if (yCss < box.y || yCss >= box.y + box.h) return -1;
    const i = FILES_METRICS.rowAt(yCss, scroll);
    return i >= 0 && i < rows.length ? i : -1;
  };

  /* ---- THE ONE CONVERSION: CSS PIXELS INTO SURFACE PIXELS ---------------------------------- */

  /** A CSS-px length as a surface coordinate. THE ONLY MULTIPLICATION BY `S` IN THIS PROGRAM —
   *  everything above is CSS px and everything in a display list is surface px, so this function
   *  is the border between them. A per-constant scaling is how two constants come to disagree. */
  const px = (v) => FILES_METRICS.toSurface(v, S);
  /** A filled rect, converted by its EDGES, so a row band and the header rule above it — which
   *  share a CSS x — land on the same device pixel. `px(x) + px(w)` is a pixel past `px(x + w)`
   *  for some widths: not at dpr 1, 1.5 or 2, where the two forms agree for every width from 200
   *  to 2400 device px, but at 1.75 — a scale Windows offers — they differ, and a 906-device-px
   *  client area is one of the cases. Swept with `node -e`, and that width is why the check for
   *  this is at 1.75 rather than at the reference machine's ratio. */
  const fill = (ops, x, y, w, h, rgba) => ops.push({
    op: DL_FILL_RECT, a0: px(x), a1: px(y), a2: px(x + w) - px(x), a3: px(y + h) - px(y), a4: rgba,
  });
  /** An outline. Its width scales too: a 1 CSS px stroke is 2 device px at dpr 2, which is what
   *  makes it the same hairline a reader sees on the rest of the chrome. */
  const stroke = (ops, x, y, w, h, rgba) => ops.push({
    op: DL_STROKE_RECT, a0: px(x), a1: px(y), a2: px(x + w) - px(x), a3: px(y + h) - px(y),
    a4: rgba, a5: Math.max(1, px(1)),
  });
  /** A text run. `size` IS SURFACE PX (`src/wm/surface.mjs` sets the font from it), so it scales
   *  with everything else — a 12 px label drawn at 12 device px inside a 40-device-px row is the
   *  half-size text a reader reported. */
  const text = (ops, s, { x, y, size, rgba, flags = 0 }) => ops.push(...encodeTextRun(s, {
    x: px(x), y: px(y), size: px(size), rgba, flags,
  }));
  /** Where the type column is right-aligned to, CSS px. A function because the width is live. */
  const typeRight = () => clientW - PAD - TYPE_INSET;

  /**
   * A FOLDER OR A PAGE, OUT OF RECTANGLES. There is no image op either, so a 16x16 glyph is what
   * `DL_FILL_RECT` can be talked into: a folder is a body with a tab on top, a page is a sheet
   * with a dog-eared corner cut out of it. Drawn in the colour the row's KIND already had, so the
   * amber a reader learned to read as "directory" is still amber (`src/wm/icons.mjs` draws the
   * shell's folder in the same colour).
   */
  const glyph = (ops, row, x, y, colour) => {
    if (row.dir) {
      fill(ops, x, y + 4, GLYPH_W, 10, colour);
      fill(ops, x, y + 1, 7, 3, colour);
      return;
    }
    fill(ops, x + 2, y + 1, GLYPH_W - 5, 13, colour);
    // The corner, cut back out in the paper colour: the display list has no path op, so a
    // notch is a fill of the background over a fill of the foreground.
    fill(ops, x + GLYPH_W - 6, y + 1, 3, 3, PAPER);
  };

  /**
   * THE VIEWPORT AS A `DL_CLIP` OP, or `null` when the window has no room for one.
   *
   * SURFACE PIXELS, CONVERTED BY ITS EDGES like every other rectangle here. `win_draw` refuses the
   * WHOLE batch for a clip whose width or height is not positive or whose origin is outside the
   * surface, and a refused batch is a window that stopped repainting with no error a reader can
   * see — so a viewport that small is not named at all, and `paint` draws no rows instead. A
   * degenerate clip is also exactly what a window dragged to its minimum height produces.
   */
  const clipOp = () => {
    const box = FILES_METRICS.viewBox(clientW, clientH);
    const x = px(box.x);
    const y = px(box.y);
    const w = px(box.x + box.w) - x;
    const h = px(box.y + box.h) - y;
    if (w <= 0 || h <= 0 || x >= surfW || y >= surfH) return null;
    return { op: DL_CLIP, a0: x, a1: y, a2: w, a3: h };
  };

  /** One frame. EVERY NUMBER IN HERE IS A CSS PIXEL — `fill`, `stroke` and `text` are what turn
   *  them into surface pixels, and they are the only things that do. */
  const paint = (hot) => {
    // `DL_CLEAR`'s `a0` IS A COLOUR AND NOT A COORDINATE, so it is pushed raw: scaling it would
    // produce a different colour, which is the one way this list could go silently wrong.
    const ops = [{ op: DL_CLEAR, a0: PAPER }];
    /* THE CLIP DECIDES WHETHER THERE IS A LIST AT ALL, so it is built before the account is
     * written: no viewport means no rows drawn, and reporting rows nobody drew is the harness
     * dishonesty CLAUDE.md names. */
    const clip = clipOp();
    const { first, last } = visible();
    const drawn = clip ? Math.max(0, last - first + 1) : 0;
    account.firstRow = drawn > 0 ? first : 0;
    account.shownRows = drawn;

    /* THE HEADER, AND IT IS DRAWN BEFORE THE CLIP — which is the whole reason the clip exists. A
     * scrolled row's top is above the header's baseline, so an unclipped list paints its name over
     * these words; the check reads the header's pixels back for exactly that reason.
     *
     * It names the columns, which is what tells a reader the right-hand text is a TYPE and not part
     * of the name — and it carries the count, because "this directory has 26 things in it" is the
     * first question a listing answers. SINCE M17 IT ALSO CARRIES THE POSITION, because a scrolling
     * list that does not say where it is is a list a reader is lost in: the "+N more" line said
     * what was unreachable and this says what is on screen. There is no scrollbar — a thumb is
     * dragged, and a drag on one would be a gesture this program cannot route. */
    text(ops, "Name", { x: NAME_X, y: PAD, size: TEXT_PX, rgba: HEAD_INK, flags: DLT_BOLD });
    const place = maxScroll() > 0 && drawn > 0
      ? `${first + 1}-${last + 1} of ${rows.length}`
      : `${rows.length} item${rows.length === 1 ? "" : "s"}`;
    text(ops, place, {
      x: typeRight(), y: PAD, size: TEXT_PX, rgba: HEAD_INK, flags: DLT_BOLD | DLT_RIGHT,
    });
    fill(ops, PAD, HEAD_H - 4, clientW - PAD * 2, 1, HEAD_RULE);

    /* FROM HERE DOWN THE LIST IS CLIPPED. No reset follows it: `Surface.replay` resets the clip at
     * the top of every batch (`src/abi.mjs`'s `DL_CLIP` docstring), so a clip is batch-scoped and a
     * trailing `DLC_RESET` would be a second definition of that rule. */
    if (clip) ops.push(clip);

    // NO CLIP, NO ROWS: `first - 1` is an empty range, and it is the ONE place that decision is
    // taken — a row drawn outside a viewport this program could not name would paint the header.
    const lastDrawn = clip ? last : first - 1;
    for (let i = first; i <= lastDrawn; i += 1) {
      const row = rows[i];
      const top = rowTop(i, scroll);
      const selected = i === hot;
      /* A SELECTED ROW INVERTS, which is what a list view does and what makes the selection
       * visible without a second colour to learn. The fill is the row's own KIND colour, so the
       * amber/green distinction survives selection rather than being painted over by one
       * highlight. */
      if (selected) {
        fill(ops, PAD, top, clientW - PAD * 2, ROW_H,
          row.dir ? SELECT_FILL_DIR : SELECT_FILL);
      }
      const kind = row.dir ? BAND_DIR : (BAND[row.format] || BAND_UNKNOWN);
      glyph(ops, row, PAD + 2, top + 2, selected ? INK_SELECTED : kind);
      text(ops, row.name, {
        x: NAME_X, y: top + TEXT_DY, size: TEXT_PX,
        rgba: selected ? INK_SELECTED : INK,
      });
      /* THE TYPE, RIGHT-ALIGNED AND MONOSPACE. Right-aligned because a column of types is read
       * down its own edge; monospace because `DIR` and `PNG` and `TEXT` lining up is the whole
       * point of a column. `kindOf` is the one place the word is decided. */
      text(ops, kindOf(row), {
        x: typeRight(), y: top + TEXT_DY, size: TEXT_PX - 1,
        rgba: selected ? INK_SELECTED : INK_DIM, flags: DLT_MONO | DLT_RIGHT,
      });
      if (selected) {
        stroke(ops, PAD, top, clientW - PAD * 2, ROW_H, OUTLINE);
      }
    }
    return env.win.draw(made.fd, ops);
  };
  paint(-1);

  /** THE BOUNDARY, AND THE ONLY PLACE A DEVICE PIXEL BECOMES THIS PROGRAM'S OWN UNIT. `w` and `h`
   *  arrive from `std.resurface`, which divided the event's device-px box by the ratio the event
   *  carried; from here down everything is CSS px again. Nothing else in this file touches `S`
   *  except `px`, which is the other half of the same border. */
  const relayout = (w, h, dpr) => {
    S = dpr;
    clientW = w;
    clientH = h;
    /* HOW MANY ROWS THE VIEWPORT HOLDS, REPORTED AND NOT ENFORCED. It was the row CAP before M17
     * and nothing reads it as one now — `visible` bounds the drawn rows by the viewport itself, so
     * a count and a geometry cannot disagree. It stays in the account because "how much of this
     * directory can a reader see at once" is the question a resize is about. */
    account.maxRows = rowsThatFit(h);
    account.client = { w, h };
    account.dpr = dpr;
    /* THE OFFSET IS RE-CLAMPED AGAINST THE NEW HEIGHT, which is the bottom clamp doing the work a
     * resize creates: a window made taller shows more rows, so an offset that was the end of the
     * list is now past it, and leaving it there is a strip of empty paper under the last row that no
     * wheel can scroll away. `scrollBy(0)` is not that call — it returns early on a zero delta and
     * must, or every pointer move would count as a clamp. */
    const limit = maxScroll();
    // `--unclamped-scroll` REACHES HERE TOO, because this is the SAME end clamp applied at a
    // different moment. Gating only `scrollBy` left a control a resize silently undid: proof 2
    // re-places this window, and the re-clamp pulled the offset back inside the range the control
    // had just been asked to leave.
    if (scroll > limit && !unclampedScroll) scroll = limit;
    account.scroll = scroll;
    account.scrollMax = limit;
    /* A SELECTION SURVIVES A RESIZE NOW, and that is the scroll's doing rather than an omission: a
     * row the window got too short for is SCROLLED to, not gone, so dropping the selection would
     * discard a choice the reader can still reach. The pre-M17 rule dropped it because the row left
     * the drawn list entirely. A press is still dropped if its row left the LIST, which only an
     * empty directory could do, so there is nothing left to test. */
  };

  /* `--css-px-surface`: THE UNIT ERROR, ON PURPOSE, AND IT CANNOT GO THROUGH `std.resurface` —
   * that helper passes the event's DEVICE pixels through unscaled precisely so this is unwritable.
   * So the control asks for the box divided by the ratio: the CSS numbers a program's constants are
   * in, which is what every surfaced program asked `win_surface` for before M16. The surface is
   * then half the client box on each axis at dpr 2, the page stretches it to fit, and the result is
   * the blurry half-size list a reader reported — with the resize path otherwise working, so what
   * this control moves is the SCALE and nothing else. */
  const askInCssPx = (ev) => {
    const box = clientBoxAt(ev);
    const w = Math.round(box.w / box.dpr);
    const h = Math.round(box.h / box.dpr);
    const rc = env.win.surface(made.fd, w, h);
    if (rc < 0) {
      account.refusedSurfaces += 1;
      account.surfaceWhy = `win_surface: ${env.std.errnoName(rc)}`;
      return;
    }
    account.resurfaces += 1;
    surfW = w;
    surfH = h;
    account.surface = { w, h };
    relayout(w, h, 1);
  };

  env.std.say(env, `${NAME}: win ${made.win}, ${rows.length} row(s) in ${dir}\n`);
  rows.forEach((r, i) => env.std.say(env, `  row ${i + 1}  ${r.name}\t${kindOf(r)}\n`));
  env.std.say(env, "press a row and drag it onto another window. the wheel scrolls. q quits.\n");

  /** Publish one row as a drag. The object's fd is CLOSED immediately and on purpose: the session
   *  holds the kernel's own reference, so the payload outlives this program's handle on it — and
   *  outlives this program (constraint 241). */
  const startDrag = (i) => {
    const row = rows[i];
    /* A DIRECTORY AND AN UNKNOWN FORMAT ARE REFUSED HERE, by name and counted: there are no bytes
     * to offer for either, and a drag that published a path under TEXT would be the guess a typed
     * clipboard exists to refuse. */
    if (row.dir || row.format === 0) {
      account.refusedDrags += 1;
      account.why = `${row.name}: ${row.dir ? "a directory" : "an unknown format"} has no bytes `
        + "to offer";
      return -EINVAL;
    }
    const body = readFile(env, row.path);
    if (typeof body === "number") {
      account.why = `${row.path}: ${env.std.errnoName(body)}`;
      return body;
    }
    const made2 = env.data.create([DOBJ_PATHS, row.format]);
    if (typeof made2 === "number") {
      account.refusedDrags += 1;
      return made2;
    }
    try {
      /* WRITE WHAT THE KERNEL GRANTED, NOT WHAT WAS ASKED FOR. `dataobj_create` returns the offer
       * it settled on and it may be narrower — M10's own control forces TEXT alone — so a program
       * that wrote from its own list would be refused -ENOTSUP for a format it never held and
       * would abandon a gesture that was perfectly able to run. The GESTURE is not the TYPE: under
       * that control this drag still happens and the receiver refuses it by name, which is the
       * failure the control is about. */
      const granted = fmtsOf(made2.offer);
      account.granted = granted.map(fmtName);
      if (granted.includes(DOBJ_PATHS)) {
        const p = env.data.set(made2.fd, DOBJ_PATHS, env.std.bytes(row.path));
        if (p < 0) { account.refusedDrags += 1; return p; }
      }
      if (granted.includes(row.format)) {
        const b = env.data.set(made2.fd, row.format, body);
        if (b < 0) { account.refusedDrags += 1; return b; }
      }
      const r = env.data.drag(made2.fd, made.fd, DOBJ_EFFECT_COPY);
      if (r < 0) {
        account.refusedDrags += 1;
        return r;
      }
      account.drags += 1;
      account.drops.push({ row: i, name: row.name, offered: granted.map(fmtName) });
      // THE TITLE IS THE ONLY TEXT THIS WINDOW HAS, so it is what says which file is moving.
      env.win.setTitle(made.fd, `${NAME} — dragging ${row.name}`);
      return 0;
    } finally {
      env.fs.close(made2.fd);
    }
  };

  /* `--no-drain MS`: THE FIXTURE, AND IT MUST BE BEFORE THE FIRST POLL. The window exists and has
   * been painted, so a driver has something to aim a wheel at; nothing has been READ, so a stream
   * longer than `WIN_EVENT_CAP` laps the window's queue and `push` starts discarding its NEWEST
   * record. That is the state the kernel's coalescing is proven in and the state an uncoalesced
   * stream loses the reader's latest notch in — a draining program reaches neither, which is why an
   * earlier draft of the proof could assert nothing a control could move.
   *
   * IT PARKS RATHER THAN SPINS. `clock_nanosleep` parks the worker in `Atomics.wait` with a finite
   * re-arm (constraint 46), so the hold costs no CPU and the process stays killable; a
   * `performance.now()` spin would hold a core for the whole stream. -EINTR IS A SHORT SLEEP, so
   * the remainder is re-slept against a DEADLINE: a fixture that silently held for less than it was
   * asked is a check that ran against a program which was draining after all. */
  if (noDrainMs > 0) {
    env.std.say(env, `${NAME}: --no-drain, holding the event loop for ${noDrainMs} ms\n`);
    const heldFrom = performance.now();
    const until = heldFrom + noDrainMs;
    for (let left = noDrainMs; left > 0; left = until - performance.now()) {
      const slept = env.proc.nanosleep(Math.round(left * 1e6));
      // Only -EINTR is worth another pass. Any other refusal is permanent and re-sleeping on it
      // would spin the loop this flag exists to keep quiet.
      if (slept < 0 && slept !== -EINTR) break;
    }
    account.heldMs = performance.now() - heldFrom;
  }

  for (;;) {
    if (performance.now() - t0 > CEILING_MS) {
      account.why = `ceiling ${CEILING_MS} ms reached`;
      break;
    }
    const r = unInterrupted(() => env.tty.poll([{ fd: made.fd, events: POLLIN }], POLL_MS));
    if (typeof r === "number") {
      if (r === -EINTR) continue;
      account.why = `poll: ${env.std.errnoName(r)}`;
      break;
    }
    const rev = r.fds[0].revents;
    if (rev & (POLLHUP | POLLERR | POLLNVAL)) {
      account.why = "the window hung up";
      break;
    }
    if (!(rev & POLLIN)) continue;
    const evs = env.win.read(made.fd, 64);
    if (typeof evs === "number") {
      if (evs === -EHOSTGONE) { account.why = "the window was destroyed"; break; }
      if (evs !== -EINTR) { account.why = `read: ${env.std.errnoName(evs)}`; break; }
      continue;
    }
    let repaint = false;
    /* ONE RE-SURFACE PER DRAINED BATCH, NOT PER EVENT. `win_surface` destroys and rebuilds the
     * canvas page-side, so re-surfacing at every intermediate size of a two-second drag is a
     * rebuild per animation frame, all but one of them thrown away. The kernel replaces a TAIL
     * client record, so a batch carries more than one only when something else arrived between two
     * reports — `std.lastClientEvent` is the one place that collapse is written. */
    const client = env.std.lastClientEvent(evs);
    for (const ev of evs) {
      if (ev.type === WEV_FOCUS) continue;
      // CELLS, and this window has no cell grid: `WEV_RESIZE` is the terminal's event and reading
      // its `a`/`b` as pixels would lay a list view out in columns (PRD §6, A2).
      if (ev.type === WEV_RESIZE) continue;
      if (ev.type === WEV_CLIENT) {
        // COUNTED BEFORE THE COLLAPSE, so `clients` against `resurfaces` is the evidence that one
        // batch cost one canvas rebuild. A counter after it would report only the actions.
        account.clients += 1;
        if (ev !== client) continue;
        // `--no-resurface`: the pre-M16 program, which never asked again. Counted, so a control
        // that sets it is visible in the account rather than only in the pixels.
        if (frozenSurface) continue;
        if (cssPxSurface) { askInCssPx(ev); repaint = true; continue; }
        const got = env.std.resurface(env, made.fd, ev);
        if (!got.ok) {
          /* A REFUSAL IS REPORTED AND SURVIVED, NOT FATAL. `-ENOMEM` is the surface budget and
           * `-EINVAL` is a box past `SURFACE_MAX_PX` — 4096x4096 device px, which a maximized
           * window on a large display at dpr 2 can exceed — and both are permanent, so a retry
           * would retry for ever. The kernel leaves the previous surface in place, so the layout
           * already in hand is still the right one for it: a reader keeps a correct list, CSS
           * stretched, instead of losing the program for making its window bigger.
           *
           * SAID ONCE. The refusal recurs per geometry report, so a message per event would be a
           * line of stdout per animation frame; the count carries the rest. */
          account.refusedSurfaces += 1;
          account.surfaceWhy = `win_surface: ${env.std.errnoName(got.errno)} for `
            + `${got.w}x${got.h} device px`;
          if (account.refusedSurfaces === 1) env.std.say(env, `${NAME}: ${account.surfaceWhy}\n`);
          continue;
        }
        account.resurfaces += 1;
        surfW = got.w;
        surfH = got.h;
        account.surface = { w: got.w, h: got.h };
        relayout(got.wCss, got.hCss, got.dpr);
        // THE OLD CANVAS IS GONE, so a repaint is owed rather than optional: the page built a new
        // backing store and nothing has drawn into it.
        repaint = true;
        continue;
      }
      if (ev.type === WEV_WHEEL) {
        account.wheels += 1;
        const w = wheelAt(ev);
        /* A COALESCED RECORD IS A SUM, NOT A NOTCH. The kernel merges a run of identical-mods
         * notches into its tail record and says so with `WWHEEL_COALESCED`; a program that scrolled
         * by one notch's worth per record would lose the rest of the reader's gesture, which is the
         * whole of what the flag is for. So the delta is applied AS GIVEN and the flag is only
         * counted — there is nothing else to do with it, and that is the honest reading. */
        if (ev.mods & WWHEEL_COALESCED) account.coalescedWheels += 1;
        /* SURFACE PIXELS INTO CSS PIXELS, the division `cssPointAt` does for a pointer. A delta read
         * unconverted scrolls twice as far as the reader's hand at dpr 2 — the same unit error as
         * the display side, on the way in (constraint 248). */
        const box = FILES_METRICS.viewBox(clientW, clientH);
        /* `WWHEEL_PAGE` MEANS THE DELTA IS IN PAGES AND IS NOT SCALED, because a page is not a
         * length the host measured — a reader's `deltaMode` said "a viewport", and the viewport is
         * this program's to define. It is the CLIPPED height and not the client box: a page that
         * jumped by the window's height would step over the rows under the header. */
        if (ev.mods & WWHEEL_PAGE) {
          account.pageWheels += 1;
          if (scrollBy(w.dy * box.h)) repaint = true;
          continue;
        }
        /* `dx` IS READ AND IGNORED, deliberately and not by omission: the name column follows the
         * window and the type column is right-aligned to it, so the list has no horizontal overflow
         * for a horizontal wheel to reach. A program with a tree pane would use `w.x`/`w.y` to pick
         * which pane the gesture was aimed at; this one has a single viewport, so the aim adds
         * nothing and a wheel over the header scrolls the list — which is what Windows does. */
        if (scrollBy(w.dy / S)) repaint = true;
        continue;
      }
      if (ev.type === WEV_POINTER) {
        account.pointers += 1;
        // SURFACE PIXELS INTO CSS PIXELS, through the shared helper. `pointerAt` alone would leave
        // a press two rows off at dpr 2 — the same unit error as the display side, on the way in.
        const at = env.std.cssPointAt(ev, S);
        if (ev.mods & WPTR_DOWN) {
          const i = rowUnder(at.y);
          press = i >= 0 ? { row: i, x: at.x, y: at.y } : null;
          dragging = false;
          if (i !== hot) { hot = i; repaint = true; }
          if (i >= 0) account.presses += 1;
          continue;
        }
        if (ev.mods & WPTR_MOVE) {
          if (!press || dragging) continue;
          const far = Math.abs(at.x - press.x) >= DRAG_THRESHOLD_CSS_PX
            || Math.abs(at.y - press.y) >= DRAG_THRESHOLD_CSS_PX;
          if (!far) continue;
          dragging = true;
          const began = startDrag(press.row);
          if (began < 0 && account.why) break;
          continue;
        }
        if (ev.mods & WPTR_UP) {
          press = null;
          dragging = false;
          continue;
        }
        continue;
      }
      if (ev.type === WEV_DRAG_DONE) {
        /* THE SOURCE'S RECEIPT. A COPY source can ignore it; a MOVE source cannot, because effect
         * 0 means the bytes went nowhere and the original must stay. This program only ever offers
         * COPY, so what it does with it is report it. */
        account.effects.push({ effect: ev.a, target: ev.b });
        env.win.setTitle(made.fd, `${NAME} — ${dir}`);
        continue;
      }
      if (ev.type === WEV_KEY) {
        const bytes = keyBytesOf(ev);
        if (bytes.length === 1 && String.fromCharCode(bytes[0]) === "q") {
          account.why = "q";
          break;
        }
        continue;
      }
      if (ev.type === WEV_CLOSE) { account.why = "the window asked to close"; break; }
      if (ev.type === WEV_DESTROYED) { account.why = "the window was destroyed"; break; }
    }
    if (repaint) paint(hot);
    if (account.why) break;
  }

  const destroyed = env.win.destroy(made.fd);
  account.destroyed = Array.isArray(destroyed) ? destroyed : [];
  account.ms = performance.now() - t0;
  env.std.say(env, `${NAME}: ${account.why}. ${account.drags} drag(s) from ${account.presses} `
    + `press(es)\n`);
  /* THE GEOMETRY, IN BOTH UNITS AND NAMED, because a reader looking at a window that is the wrong
   * size needs to know which of the two numbers moved. `0x0 device px` here is a host that never
   * reported a client box, which is a different fault from a ratio of 1 on a dpr-2 display. */
  env.std.say(env, `${NAME}: client ${account.client.w}x${account.client.h} CSS px at dpr `
    + `${account.dpr}, surface ${account.surface.w}x${account.surface.h} device px, `
    + `rows ${account.firstRow + 1}-${account.firstRow + account.shownRows} of ${rows.length} `
    + `shown, ${account.resurfaces} resurface(s)`
    + `${account.refusedSurfaces ? `, ${account.refusedSurfaces} refused` : ""}\n`);
  /* THE SCROLL, AND BOTH ITS ENDS. `scroll` against `dyTotal` is where a delta went — equal means
   * every notch landed, short means the clamp ate the difference — and the two clamp counts are
   * reported separately because a run that only ever hit one end proves one edge. */
  env.std.say(env, `${NAME}: scroll ${Math.round(account.scroll)} of `
    + `${Math.round(account.scrollMax)} CSS px from ${account.wheels} wheel event(s) `
    + `(${account.coalescedWheels} coalesced, ${account.pageWheels} by the page), `
    + `${Math.round(account.dyTotal)} CSS px asked for, clamped ${account.clamped.top} at the top `
    + `and ${account.clamped.bottom} at the end\n`);
  return { exit: 0, ...account };
}
