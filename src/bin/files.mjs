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
// TWO FLAGS EXIST ONLY TO BREAK THAT, as negative controls a check can re-run rather than source
// mutations nobody re-runs (the precedent is `scripts/serve.py --no-isolation`):
//
//   --no-resurface      ignore `WEV_CLIENT` entirely. The pre-M16 program exactly: a backing store
//                       that never follows its window, so a resize CSS-stretches a 420 px list
//                       over however much room the reader just made. The reported defect, restored.
//   --css-px-surface    refit, but ask for the client box in CSS pixels and leave `S` at 1 — the
//                       unit error on its own, with the resize path working.
//
// Neither belongs on a prompt. A reader who passes one gets the bug the milestone removed.

import {
  POLLIN, POLLHUP, POLLERR, POLLNVAL, EINTR, EINVAL, EHOSTGONE, DT_DIR,
  WEV_KEY, WEV_POINTER, WEV_CLOSE, WEV_DESTROYED, WEV_RESIZE, WEV_FOCUS, WEV_DRAG_DONE,
  WEV_CLIENT, WPTR_DOWN, WPTR_UP, WPTR_MOVE, clientBoxAt, keyBytesOf,
  DL_CLEAR, DL_FILL_RECT, DL_STROKE_RECT, DLT_BOLD, DLT_MONO, DLT_RIGHT, encodeTextRun,
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
 *  caps the OPENING HEIGHT ONLY — once the client box is known the row count is geometric, so a
 *  reader who makes the window taller gets more rows (constraint 294 says the overflow must be
 *  stated, not that the list may not grow). */
const START_ROWS = 24;

/** The y of a row's top, CSS px, measured inside the client area. */
const rowTop = (i) => HEAD_H + PAD + i * (ROW_H + ROW_GAP);
/** The middle of a row, CSS px: where a driver outside the process aims. */
const rowMid = (i) => rowTop(i) + ROW_H / 2;

/**
 * The row index a CSS-px `y` falls in, or `-1` for the header, a gap between two rows, or anything
 * above the list. THE DECLARED INVERSE OF `rowTop`, which is what makes a press land on the row a
 * reader sees — `src/wm/desktop.mjs` states the same rule for its icon grid.
 *
 * IT IS NOT BOUNDED BY THE ROW COUNT, because the row count is live and this object is frozen.
 * The caller bounds it; see `rowUnder` in `run`.
 */
const rowAt = (yCss) => {
  const i = Math.floor((yCss - rowTop(0)) / (ROW_H + ROW_GAP));
  if (i < 0) return -1;
  // The gap between two rows belongs to neither, so a press there selects nothing rather than
  // the row above it by rounding.
  return yCss - rowTop(i) < ROW_H ? i : -1;
};

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
 */
export const FILES_METRICS = Object.freeze({
  ROW_H, ROW_GAP, PAD, HEAD_H, NAME_X, GLYPH_W, TEXT_PX,
  SURFACE_W: START_W,
  rowTop, rowMid, rowAt, toSurface,
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
  const rest = [];
  let endOfOptions = false;
  for (const arg of argv.slice(1)) {
    if (!endOfOptions) {
      if (arg === "--") { endOfOptions = true; rest.push(arg); continue; }
      if (arg === "--no-resurface") { frozenSurface = true; continue; }
      if (arg === "--css-px-surface") { cssPxSurface = true; continue; }
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
    maxRows: START_ROWS, shownRows: 0, hiddenRows: 0,
    controls: { frozenSurface, cssPxSurface },
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
  /** How many rows there is room for. Geometric after the first measurement; `START_ROWS` only
   *  decides how tall the window OPENS. */
  let maxRows = START_ROWS;
  let shown = [];
  let hidden = 0;
  /** The selected row, the press that might become a drag, and whether it has. Declared here
   *  because `relayout` drops a selection the reader can no longer see. */
  let press = null;
  let dragging = false;
  let hot = -1;

  /** The client height `n` rows need, CSS px, plus one row's worth when a line has to say what did
   *  not fit. `rowsThatFit` is the declared inverse: one arithmetic, read in both directions, the
   *  same rule `rowTop`/`rowAt` follow for a row's y. */
  const clientHeightFor = (n, overflow) =>
    HEAD_H + PAD * 2 + (n + (overflow ? 1 : 0)) * (ROW_H + ROW_GAP) - ROW_GAP;
  /** How many rows a client area `h` CSS px tall holds. At least one: a window clamped to `MIN_H`
   *  still owes a reader a row rather than a header over nothing. */
  const rowsThatFit = (h) =>
    Math.max(1, Math.floor((h - HEAD_H - PAD * 2 + ROW_GAP) / (ROW_H + ROW_GAP)));

  /* WHAT FITS, AND WHAT HAPPENS TO THE REST.
   *
   * A listing of `/usr/bin` is 32 entries and a window is as tall as a reader made it. THERE IS
   * STILL NO SCROLL: the window ABI delivers `WEV_POINTER` with down, up and move
   * (`src/abi.mjs`'s `WPTR_*`) and no wheel, so a scrollbar would be a control this program cannot
   * receive input for — the live-looking-button defect M11 recorded. M17 adds the wheel; until
   * then the remainder is SAID, which is constraint 294: a reader sees "+6 more" rather than six
   * files that do not appear to exist.
   *
   * WHAT CHANGED IN M16 IS ONLY THE CAP. It was a constant 24; it is now however many rows the
   * measured client box holds, so making the window taller shows more files instead of more
   * background. */
  const refit = () => {
    const fits = Math.min(rows.length, maxRows);
    // THE OVERFLOW LINE COSTS A ROW, because a line drawn past the bottom of the surface is not a
    // line — the remainder would be stated to nobody.
    const n = fits < rows.length ? Math.max(1, fits - 1) : fits;
    shown = rows.slice(0, n);
    hidden = rows.length - n;
    account.maxRows = maxRows;
    account.shownRows = shown.length;
    account.hiddenRows = hidden;
  };
  refit();
  clientH = clientHeightFor(shown.length, hidden > 0);

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
  account.surface = { w: Math.round(clientW), h: Math.round(clientH) };
  account.client = { w: clientW, h: clientH };

  /** The row under a CSS-px `y`, or -1. `FILES_METRICS.rowAt` is the arithmetic — the declared
   *  inverse of the `rowTop` that `paint` draws with — and the BOUND is here because the row count
   *  is live: a press below the last drawn row must find nothing rather than a row that is in the
   *  list and not on the screen. */
  const rowUnder = (yCss) => {
    const i = FILES_METRICS.rowAt(yCss);
    return i >= 0 && i < shown.length ? i : -1;
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

  /** One frame. EVERY NUMBER IN HERE IS A CSS PIXEL — `fill`, `stroke` and `text` are what turn
   *  them into surface pixels, and they are the only things that do. */
  const paint = (hot) => {
    // `DL_CLEAR`'s `a0` IS A COLOUR AND NOT A COORDINATE, so it is pushed raw: scaling it would
    // produce a different colour, which is the one way this list could go silently wrong.
    const ops = [{ op: DL_CLEAR, a0: PAPER }];

    /* THE HEADER. It names the columns, which is what tells a reader the right-hand text is a TYPE
     * and not part of the name — and it carries the count, because "this directory has 26 things
     * in it" is the first question a listing answers. */
    text(ops, "Name", { x: NAME_X, y: PAD, size: TEXT_PX, rgba: HEAD_INK, flags: DLT_BOLD });
    text(ops, `${rows.length} item${rows.length === 1 ? "" : "s"}`, {
      x: typeRight(), y: PAD, size: TEXT_PX, rgba: HEAD_INK, flags: DLT_BOLD | DLT_RIGHT,
    });
    if (hidden > 0) {
      // IN THE SLOT `refit` KEPT FOR IT, which is why that function takes a row off the list when
      // there is an overflow: `rowTop(shown.length)` is inside the client box only because of it.
      text(ops, `+${hidden} more — run \`ls ${dir}\` to see them all`, {
        x: NAME_X, y: rowTop(shown.length) + TEXT_DY, size: TEXT_PX - 1, rgba: INK_DIM,
      });
    }
    fill(ops, PAD, HEAD_H - 4, clientW - PAD * 2, 1, HEAD_RULE);

    for (let i = 0; i < shown.length; i += 1) {
      const row = shown[i];
      const top = rowTop(i);
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
    maxRows = rowsThatFit(h);
    refit();
    account.client = { w, h };
    account.dpr = dpr;
    /* A SELECTION THE READER CAN NO LONGER SEE IS DROPPED, and so is a press. The window got
     * shorter, so the row that was outlined is off the list — and a drag that would start from a
     * row nobody can see is a gesture nobody made. */
    if (hot >= shown.length) hot = -1;
    if (press && press.row >= shown.length) { press = null; dragging = false; }
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
    account.surface = { w, h };
    relayout(w, h, 1);
  };

  env.std.say(env, `${NAME}: win ${made.win}, ${rows.length} row(s) in ${dir}\n`);
  rows.forEach((r, i) => env.std.say(env, `  row ${i + 1}  ${r.name}\t${kindOf(r)}\n`));
  env.std.say(env, "press a row and drag it onto another window. q quits.\n");

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
        account.surface = { w: got.w, h: got.h };
        relayout(got.wCss, got.hCss, got.dpr);
        // THE OLD CANVAS IS GONE, so a repaint is owed rather than optional: the page built a new
        // backing store and nothing has drawn into it.
        repaint = true;
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
    + `${account.shownRows} of ${rows.length} row(s) shown, ${account.resurfaces} resurface(s)`
    + `${account.refusedSurfaces ? `, ${account.refusedSurfaces} refused` : ""}\n`);
  return { exit: 0, ...account };
}
