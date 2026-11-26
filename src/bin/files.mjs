// `files`: a window of file rows you can DRAG OUT of.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// THIS IS HALF OF M10's HEADLINE AS A PROGRAM YOU CAN RUN — `imgview` is the other half. The
// milestone's claim is that bytes of a declared format cross from one process to another on a
// gesture, so there have to be two processes and a gesture:
//
//   files                       a row per file in the SESSION'S OWN TREE — the writable copy of
//                               the read-only base (`std.sessionDir`, D40)
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
// M18: IT NAVIGATES, AND A ROW OPENS. Three pieces, and they are separate on purpose:
//
//   THE KEYBOARD CURSOR is `focus`, moved by `WKEY_UP`/`WKEY_DOWN`/`WKEY_HOME`/`WKEY_END` and the
//   two Page keysyms — a `WEV_KEY` with no bytes, which this program could not receive before M18
//   because `src/wm/winhost.mjs` dropped every key `bytesForKey` could not spell. It is NOT the
//   selection: a press on the header clears the selection and must not clear the reader's place in
//   the list, so the two are drawn differently and one can outlive the other. Moving it SCROLLS to
//   it, because a cursor outside the viewport is a cursor on a row nobody can see.
//
//   THE ACTIVATION VERB is a DOUBLE-CLICK or Enter on the cursor. A single click only selects, and
//   that is a real distinction rather than a convention: `WPTR_CLICK2` rides the DOWN record only,
//   so the second click is the one place it can be read. A directory RE-LISTS IN THIS WINDOW — new
//   rows, a title naming the child, the offset and the selection reset because they belonged to the
//   directory that is gone. A file spawns the program `std.openerForPath` names, with the argv the
//   association carries: `imgview` wants `-f PATH` and `editor` wants a bare path, and a caller
//   that guessed would hand one program the other's operand.
//
//   BACK is Alt+Left or Backspace, because Windows 7 binds Backspace to Back and has no Up button.
//   The history is a stack of directories and going back from the bottom of it is a REFUSAL — by
//   name and counted, like every other thing this program declines to do.
//
// NOTHING IS FOCUSED AT STARTUP OR AFTER A RE-LIST, and `activate(-1)` refuses rather than opening
// row 0. A first Enter that opened the first row would be this window acting on a choice the reader
// never made, which is the same defect as a double-click that silently does nothing — so both ends
// of it are counted in `refused` and named in `refusals`.
//
// M19: IT IS A DETAILS VIEW. Four columns, a sort a reader chooses, a selection of more than one
// row, and a lit row under the pointer. Five pieces, and the first of them pays for the rest:
//
//   EVERY ROW IS `lstat`ED, DIRECTORIES INCLUDED. The call used to sit inside `if (!dir)`, so a
//   folder had no size, no modification time and no execute bit — and a Date modified column with
//   an empty cell on every folder is a column that is lying about half its rows. A FOLDER'S SIZE
//   CELL IS STILL EMPTY, and that is the distinction: a directory's `st_size` is the size of its
//   own entry table, which is not what a reader asked, so it is drawn as nothing on purpose while
//   the date beside it is drawn because the call was paid.
//
//   THE COLUMNS ARE DATA (`COLUMNS`), and their geometry is `columnBoxes` — one function, read by
//   the header, by every cell, by the sort's hit test and by anything outside the process that
//   wants to aim at a column. `columnAt` is its declared inverse, which is what makes a press land
//   on the column a reader sees.
//
//   A HEADER CLICK CHOOSES THE SORT AND A SECOND CLICK ON THE SAME COLUMN REVERSES IT. The opening
//   order is name-ascending and nobody chose it, so the first click on the `Name` header is a
//   CHOICE and not a reversal: a reader looking at an ascending list who clicks `Name` expects what
//   they are looking at, not its opposite. DIRECTORIES STAY FIRST either way, and the NAME is the
//   secondary key ASCENDING either way — so the order within a group of equal dates or equal types
//   does not depend on which way the primary sorted, which is the whole of what "stable" means
//   here. A RE-LIST RESETS IT, for the reason `relist` resets everything else: a directory opened
//   from the command line and the same directory navigated into must show the same rows in the same
//   order, or row 1 is decided by a reader's history with a directory that is gone.
//
//   THE SELECTION IS A SET, WITH AN ANCHOR. A plain press replaces it and moves the anchor;
//   Ctrl+press TOGGLES one row and MOVES THE ANCHOR THERE (so the next Shift+press ranges from the
//   row the reader last touched); Shift+press selects the range between the anchor and the press in
//   LAYOUT order. Layout order is index order in this program because the sort reorders `rows`
//   ITSELF rather than an index beside it — which is the one design in which the two cannot
//   disagree, and the reason there is no separate "display order" to get wrong.
//
//   A RUBBER BAND COMES FROM EMPTY SPACE AND A DRAG COMES FROM A ROW. That arbitration is taken at
//   the press, once, from `rowUnder` alone: a press that found a row arms the drag threshold, a
//   press that found none arms the band. Nothing downstream re-decides it, because a gesture that
//   could become either depending on how far the hand moved is a gesture that publishes a file the
//   reader never touched.
//
//   A LIT ROW IS THE HOVER, AND IT IS A BAND AND NOT AN INK. A pointer record with neither button
//   bit and no buttons held is a hover (`WPTR_LEAVE`'s docstring in src/abi.mjs); `WPTR_LEAVE`
//   clears it, because the last hover a window ever gets is the one nearest the edge and a lit row
//   with the pointer gone is a lie. It is drawn as a fill UNDER the row's text rather than as a
//   different ink, so "which row is lit" and "which row is selected" stay two readings — the
//   selection is the only thing that changes a name's colour.
//
// WHAT THIS PROGRAM DOES NOT DO WITH `/dev/advance`: it does not read it. A column's width here is
// a CSS-px constant, and the table is indexed in SURFACE px — so a column fitted to its widest cell
// would be a width that moved with the display's ratio, which is the ratio-shaped defect that cost
// M11, M12 and M16 (CLAUDE.md). A cell that does not fit its column is handed to the renderer as
// `DLT_ELLIPSIS` plus the column's width in surface px, which is where the ABI puts that decision:
// a program must not pre-cut, and a sum of published advances is only an upper bound for a
// proportional run anyway (`advanceWidth` in src/abi.mjs).
//
// `--no-drain MS` IS A FIXTURE AND NOT A CONTROL, which is why it is documented apart from the two
// below. It holds the event loop for MS milliseconds before the first poll, so a notch stream longer
// than `WIN_EVENT_CAP` laps a queue nobody is draining — the state the kernel's wheel coalescing is
// proven in, and the state an uncoalesced stream drops its NEWEST record in. It breaks nothing by
// itself: when the hold ends the program drains the queue and applies the whole summed delta, which
// is the clause the proof asserts. The precedent for a shipped flag whose only job is to put the
// system into a state a check needs is `cfg.blurBudgetPx` and `scripts/serve.py --no-isolation`.
//
// SEVEN FLAGS EXIST ONLY TO BREAK THAT, as negative controls a check can re-run rather than source
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
//   --stable-sort-off   let the secondary key follow the sort's DIRECTION — `dir * (byKey ||
//                       byName)`, which is the naive spelling. Names then descend inside a group of
//                       equal dates or equal types whenever the primary descends, so the order
//                       within a group depends on which way the reader last clicked. The ONLY
//                       clause it moves is the stable-order one: the primary key still sorts and
//                       still reverses.
//   --folders-last      put directories after files instead of before them. "Directories stay first
//                       whichever way it sorts" is the clause; this is its world.
//   --no-dir-stat       skip the `lstat` for a DIRECTORY, which is the call that used to be missing.
//                       A folder's Date modified cell goes empty and its Size cell — empty either
//                       way — does not move, so the clause this breaks is the one that proves the
//                       directory stat is paid rather than the one that proves the size is omitted.
//   --band-from-row     start a RUBBER BAND from a press on a row. The arbitration removed: the
//                       drag never begins, and dragging across rows selects them instead of
//                       publishing the pressed one.
//
// None belongs on a prompt. A reader who passes one gets the bug the milestone removed.

import {
  POLLIN, POLLHUP, POLLERR, POLLNVAL, EINTR, EINVAL, EHOSTGONE, DT_DIR,
  WEV_KEY, WEV_POINTER, WEV_CLOSE, WEV_DESTROYED, WEV_RESIZE, WEV_FOCUS, WEV_DRAG_DONE,
  WEV_CLIENT, WPTR_DOWN, WPTR_UP, WPTR_CLICK2, WPTR_LEAVE,
  clientBoxAt, keyBytesOf, keysymOf,
  WKEY_LEFT, WKEY_UP, WKEY_DOWN, WKEY_HOME, WKEY_END, WKEY_PAGE_UP, WKEY_PAGE_DOWN,
  WMOD_ALT, WMOD_CTRL, WMOD_SHIFT,
  WEV_WHEEL, WWHEEL_PAGE, WWHEEL_COALESCED, wheelAt,
  DL_CLEAR, DL_FILL_RECT, DL_STROKE_RECT, DL_CLIP, DL_MAX_OPS,
  DLT_BOLD, DLT_MONO, DLT_RIGHT, DLT_ELLIPSIS, encodeTextRun,
  DOBJ_PATHS, DOBJ_TEXT, DOBJ_PNG, DOBJ_BITMAP, DOBJ_EFFECT_COPY,
  O_RDONLY, fmtName, fmtsOf,
} from "/src/abi.mjs";

const NAME = "files";

/** Where a program lives. Restated from `src/bin/sh.mjs`'s `DEFAULT_PATH` and
 *  `src/bin/desktop.mjs`'s `BIN_DIR`, which is a second copy this file cannot remove: the one
 *  definition would have to be in `src/libos/std.mjs`, and that file is not this change's. */
const BIN_DIR = "/usr/bin";

/* THE TWO BYTE KEYS THIS PROGRAM BINDS. They are BYTES and not keysyms — `src/wm/terminal.mjs`'s
 * `bytesForKey` turns Enter into 10 (line feed, not carriage return) and Backspace into 127 (DEL),
 * and `KEYSYM_BY_KEY` deliberately has no row for either, so `keysymOf` answers 0 for both. A
 * program that waited for a keysym here would wait for ever. */
const KEY_ENTER = 10;
const KEY_BACKSPACE = 127;

const POLL_MS = 200;
const CEILING_MS = 300000;

/* THERE IS NO DEFAULT DIRECTORY CONSTANT HERE. It was `/usr/share` — a READ-ONLY provider mount,
 * which is the whole of what D40 fixed: every mutating verb M20 adds would have been unreachable
 * from the one directory this program showed. The default is now the session's own tree, resolved
 * by `std.sessionDir` — one definition, beside the other userland conventions, read by this program
 * and by `src/bin/desktop.mjs`. */

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
/** THE STATUS STRIP, CSS px: the bottom line of the client area, below the viewport, carrying the
 *  position statement M17 added and the selection count M19 did. It is Windows 7's status bar, and
 *  it exists because a header holding four column labels has no room left for a sentence.
 *
 *  IT IS DRAWN BEFORE THE `DL_CLIP`, with the header, and that is load-bearing rather than tidy: a
 *  clip bounds the VIEWPORT, this sits below it, and a canvas clip only ever intersects — so a
 *  footer drawn after the clip would be cut away entirely. */
const FOOT_H = 20;
/** The glyph box at the left of a row: a folder or a page, drawn out of rectangles. */
const GLYPH_W = 16;
/** Where the name starts. A fixed inset, so it does not follow the window. */
const NAME_X = PAD + GLYPH_W + 8;
/** How far inside the padding the LAST column's right edge sits — the type column's own inset
 *  until M19 gave it three neighbours. The columns are laid out from the LIVE width, so this is an
 *  inset and not a position. */
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

/** How far inside a row the keyboard cursor's ring sits, CSS px. One pixel, so a row that is both
 *  selected and focused shows the selection's outline AND this one rather than one over the other.
 *  `focusBox` is the only reader. */
const FOCUS_INSET = 1;

/** THE KEYBOARD CURSOR'S RING as a rectangle, CSS px — the ONE definition of where it is drawn.
 *  `paint` strokes it and anything outside the process that wants to read its pixels asks here, for
 *  `rowTop`'s reason: a second copy of an inset is a check sampling one pixel off the ring. */
const focusBox = (i, scroll = 0, wCss = 0) => ({
  x: PAD + FOCUS_INSET,
  y: rowTop(i, scroll) + FOCUS_INSET,
  w: Math.max(0, wCss - PAD * 2 - FOCUS_INSET * 2),
  h: ROW_H - FOCUS_INSET * 2,
});

/**
 * THE CLIPPED VIEWPORT, CSS px, inside a client area `wCss` x `hCss`. One rectangle, read in three
 * places — the `DL_CLIP` op, the hit test's bound, and whatever outside the process wants to aim
 * inside it — so a driver cannot pick a point the program would clip away.
 *
 * ITS BOTTOM KEEPS `PAD`, which is what makes the bottom edge a VIEWPORT edge rather than the
 * canvas's: a row cut there was cut by this rectangle, and a check reading the pixels can tell the
 * two apart. `scrollMax` is derived from the same `PAD`, so the last row's bottom lands exactly on
 * it at full scroll.
 *
 * M19: AND `FOOT_H` BELOW THAT, because the status strip is part of the client area and not part of
 * the list. Every one of the four functions below carries the same term, which is what keeps
 * `rowsThatFit` and `clientHeightFor` declared inverses and `scrollMax(n, clientHeightFor(n))` zero.
 */
const viewBox = (wCss, hCss) => ({
  x: 0, y: VIEW_TOP, w: Math.max(0, wCss), h: Math.max(0, hCss - VIEW_TOP - PAD - FOOT_H),
});

/** The largest legal scroll offset for `n` rows in a client area `hCss` tall, CSS px: the offset at
 *  which the last row's bottom sits on the viewport's. ZERO when everything fits, which is the top
 *  clamp and the bottom clamp being the same number — a window taller than its content cannot
 *  scroll at all. The DECLARED PARTNER of `rowTop`: `rowTop(n - 1, scrollMax(n, h)) + ROW_H` is the
 *  viewport's bottom. */
const scrollMax = (n, hCss) =>
  Math.max(0, (n > 0 ? rowTop(n - 1) + ROW_H : 0) + PAD + FOOT_H - hCss);

/** How many rows a client area `hCss` CSS px tall shows at once — `viewBox`'s height less the pad
 *  above the first row, in whole pitches. At least one: a window clamped to its minimum still owes
 *  a reader a row rather than a header over nothing. `clientHeightFor` is the declared inverse. */
const rowsThatFit = (hCss) =>
  Math.max(1, Math.floor((hCss - VIEW_TOP - PAD * 2 - FOOT_H + ROW_GAP) / ROW_STRIDE));

/** The client height `n` rows need, CSS px. Only the OPENING size reads it — after that the height
 *  is the reader's and the row count follows it — but it is `rowsThatFit`'s declared inverse, so
 *  `scrollMax(n, clientHeightFor(n))` is 0 and a window opened to fit its content cannot scroll. */
const clientHeightFor = (n) => VIEW_TOP + PAD * 2 + FOOT_H + n * ROW_STRIDE - ROW_GAP;

/**
 * A RUBBER BAND AS A RECTANGLE, CSS px, from the two corners it was dragged between. The corners
 * are in CONTENT coordinates — `y` measured down the whole list rather than down the window —
 * which is what lets a band keep hold of the rows it was drawn over while the list scrolls.
 *
 * NORMALISED, because a band is dragged in all four directions and a negative width is a rectangle
 * nothing intersects. ONE definition, read by the drawing, by the hit test and by a driver outside
 * the process, so a reader cannot see a band over a row it did not select.
 */
const bandBox = (band) => ({
  x: Math.min(band.x0, band.x1),
  y: Math.min(band.y0, band.y1),
  w: Math.abs(band.x1 - band.x0),
  h: Math.abs(band.y1 - band.y0),
});

/**
 * THE ROWS A BAND TOUCHES, BY INTERSECTION — not by containment, which is the rule every file
 * manager uses: a band drawn across the middle of a list selects the rows it crosses rather than
 * only the ones it swallowed whole.
 *
 * A ROW'S RECTANGLE IS THE ONE `paint` FILLS, in content coordinates: `rowTop(i)` with no offset,
 * `PAD` to `wCss - PAD` across. A zero-width or zero-height band touches nothing, which is a press
 * that never moved — and is why a click on empty space clears the selection rather than selecting
 * whatever row the degenerate rectangle happens to graze.
 *
 * PURE, AND EXPORTED FOR `rowTop`'S REASON: a driver that wanted to assert which rows a band took
 * would otherwise restate the intersection, and an off-by-one in a restated edge is a check that
 * passes for the wrong set.
 */
const bandRows = (band, n, wCss) => {
  const r = bandBox(band);
  const hit = new Set();
  if (r.w <= 0 || r.h <= 0) return hit;
  const left = PAD;
  const right = Math.max(left, wCss - PAD);
  if (r.x >= right || r.x + r.w <= left) return hit;
  for (let i = 0; i < n; i += 1) {
    const top = rowTop(i);
    if (r.y < top + ROW_H && r.y + r.h > top) hit.add(i);
  }
  return hit;
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
/** WHAT A CELL SAYS WHEN THE SYSTEM KNOWS NOTHING, and it is a MARK rather than a blank for a
 *  reason M19 measured: `/usr` is a provider mount whose files publish no modification time, so a
 *  Date column over `/usr/bin` — which is what the desktop's own `files` window opens on — was
 *  twenty-five empty cells. An empty cell reads as a column that is broken; this reads as a column
 *  saying it does not know. `kindOf` already used the same mark for a type nothing names.
 *
 *  AN EMPTY CELL STILL MEANS SOMETHING, which is why both spellings exist: no call was PAID. A
 *  directory's Size is empty because its `st_size` is not the question, and every cell of a row
 *  under `--no-dir-stat` is empty because nothing was asked. */
const UNKNOWN_CELL = "—";

const kindOf = (row) => (row.dir ? "DIR"
  : row.format ? fmtName(row.format)
    : row.exec ? "PROG" : UNKNOWN_CELL);

/* ---- M19: THE FOUR COLUMNS, AS DATA ------------------------------------------------------- */

/** The three fixed column widths, CSS px, each sized to the widest cell it has to hold: a
 *  16-character timestamp, `BITMAP`, and a six-digit kilobyte count. They are written here rather
 *  than fitted to content for the reason in this file's header — a fitted width would move with the
 *  display's ratio. */
const DATE_W = 120;
const TYPE_W = 60;
const SIZE_W = 64;
/** The narrowest the flexible Name column may become. Below it the fixed columns run off the right
 *  edge and the canvas cuts them, which is what Explorer does and is better than a name column too
 *  narrow to hold a character. */
const NAME_MIN_W = 48;

/**
 * THE DETAILS VIEW'S COLUMNS. One row per column: the key a sort and a cell are named by, the
 * header's label, and the fixed width — `0` meaning "take whatever is left". Adding a column is
 * adding a row here.
 *
 * EVERY COLUMN BUT THE NAME IS RIGHT-ALIGNED, and that is structural as well as a look. A
 * metadata column is read down its own edge; and the NAME is then the only LEFT-aligned run after
 * the `DL_CLIP`, which is how a driver outside the process names the rows with no coordinate and no
 * scale in the test (`www/m18.html`'s `rowRuns`). A second left-aligned cell would make every date
 * read as a row name.
 *
 * `mono` IS NOT DECORATION EITHER: a monospaced column of dates and sizes lines its digits up, and
 * a monospaced run is the one kind whose width a published advance table prices EXACTLY
 * (`advanceWidth` in src/abi.mjs, measured over 2,448 samples).
 */
const COLUMNS = Object.freeze([
  Object.freeze({ key: "name", label: "Name", w: 0, mono: false }),
  Object.freeze({ key: "date", label: "Date modified", w: DATE_W, mono: true }),
  Object.freeze({ key: "type", label: "Type", w: TYPE_W, mono: true }),
  Object.freeze({ key: "size", label: "Size", w: SIZE_W, mono: true }),
]);

/** The column the sort opens on, and the direction. ASCENDING, which is also the order `buildRows`
 *  produces, so the opening list and the opening sort state agree. */
const SORT_DEFAULT = Object.freeze({ key: "name", dir: 1 });

/**
 * WHERE EVERY COLUMN IS, CSS px, inside a client area `wCss` wide — the ONE definition, read by
 * the header's labels, by every cell, by the sort's hit test and by anything outside the process
 * that wants to aim at a column.
 *
 * `x`/`right` BOUND THE COLUMN AND `textX` IS WHERE ITS RUN IS DRAWN, and the two differ in both
 * directions: the Name column's box starts at `PAD` because the glyph belongs to it while its text
 * starts at `NAME_X`, and a right-aligned column's text sits AT its right edge, which is what
 * `DLT_RIGHT` means.
 */
const columnBoxes = (wCss) => {
  const edge = Math.max(0, wCss - PAD - TYPE_INSET);
  const fixed = COLUMNS.reduce((n, c) => n + c.w, 0);
  const flexible = Math.max(NAME_MIN_W, edge - PAD - fixed);
  let x = PAD;
  return COLUMNS.map((c) => {
    const w = c.w || flexible;
    const box = {
      key: c.key, label: c.label, mono: c.mono, x, w, right: x + w,
      textX: c.key === "name" ? NAME_X : x + w,
      right_aligned: c.key !== "name",
    };
    x += w;
    return box;
  });
};

/** The key of the column a CSS-px `x` falls in, or `null` past the last one. THE DECLARED INVERSE
 *  OF `columnBoxes`, which is what makes a header press sort the column a reader is pointing at. */
const columnAt = (xCss, wCss) => {
  const hit = columnBoxes(wCss).find((c) => xCss >= c.x && xCss < c.right);
  return hit ? hit.key : null;
};

/**
 * A MODIFICATION TIME AS A CELL, or `""` for a stamp of zero. `cellOf` is what turns that into the
 * UNKNOWN mark for a row that WAS statted, so this stays a pure format of a number.
 *
 * `YYYY-MM-DD HH:MM` IN LOCAL TIME, AND THE FORMAT IS DELIBERATELY NOT THE HOST'S. A locale
 * rendering is whatever the browser's `toLocaleString` decides, which no driver outside the process
 * can predict and no check can assert; this one is 16 characters wide whatever the date, which is
 * also what lets `DATE_W` be a constant. The sort reads the NUMBER and never this string, so the
 * ordering does not depend on the spelling.
 */
const dateText = (mtimeMs) => {
  if (!(mtimeMs > 0)) return "";
  const d = new Date(mtimeMs);
  const p = (v, n = 2) => String(v).padStart(n, "0");
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * A SIZE AS A CELL — kilobytes, rounded UP, which is Explorer's own Size column.
 *
 * A DIRECTORY'S CELL IS EMPTY, and that is a statement rather than a gap: `st_size` on a directory
 * is the size of its entry table, which is not the question "how big is this folder" that a reader
 * asked. The DATE beside it is drawn, and the pair is what says the stat was paid.
 *
 * ROUNDED UP SO NO NON-EMPTY FILE READS AS `0 KB`: a one-byte file occupies a block, and `0 KB`
 * beside a name is the spelling of "empty". An empty file is `0 KB` and is the only thing that is.
 */
const sizeText = (row) => {
  if (row.dir || !row.statted) return "";
  const bytes = Number(row.size) || 0;
  return `${bytes > 0 ? Math.max(1, Math.ceil(bytes / 1024)) : 0} KB`;
};

/**
 * ONE CELL'S TEXT, and the ONE place a column's key becomes a string. `paint` draws what this
 * returns and `account.rows` reports it, so what a check reads is what a reader saw.
 *
 * THE DATE IS WHERE "NOT ASKED" AND "ASKED AND UNKNOWN" PART. A row whose `lstat` was never paid
 * has an empty cell; a row that was statted and came back with a zero stamp gets the UNKNOWN mark.
 * Collapsing the two would make `--no-dir-stat` turn nothing on a provider mount, and a control
 * that turns nothing verifies nothing.
 */
const cellOf = (row, key) => {
  if (key === "name") return row.name;
  if (key === "type") return kindOf(row);
  if (key === "date") return row.statted ? (dateText(row.mtimeMs) || UNKNOWN_CELL) : "";
  if (key === "size") return sizeText(row);
  return "";
};

/** WHAT A COLUMN SORTS ON, which is a number for two of them and a string for two. Never the cell
 *  text: a date sorted by its spelling is a date sorted lexicographically, and a size sorted by
 *  `"9 KB"` against `"10 KB"` puts the larger first. A DIRECTORY'S SIZE IS `-1` — below every file,
 *  including an empty one — because its cell is empty and an empty cell has no magnitude. */
const sortValue = (row, key) => {
  if (key === "date") return Number(row.mtimeMs) || 0;
  if (key === "size") return row.dir ? -1 : (Number(row.size) || 0);
  if (key === "type") return kindOf(row);
  return row.name;
};

/** Two sort values of the same kind. `<` orders numbers numerically and strings by code unit, which
 *  is the one comparison both kinds share — `sortValue` is what guarantees they are never mixed. */
const compareValues = (a, b) => (a === b ? 0 : (a < b ? -1 : 1));

/**
 * THE ORDER, AS ONE COMPARATOR — three terms, applied in this sequence and no other.
 *
 * 1. DIRECTORIES FIRST, and NOT multiplied by the direction: "folders before files" is not a
 *    reading of a column, so reversing the sort must not turn it over. `--folders-last` is the
 *    world where it is the other way, and nothing else moves.
 * 2. THE CHOSEN COLUMN, times the direction.
 * 3. THE NAME, ASCENDING WHICHEVER WAY THE PRIMARY SORTED. This is the stable term, and the
 *    sentence above is the whole of it: the order inside a group of equal dates or equal types is
 *    the same whether the dates ascend or descend, so a reader who reverses a sort does not find
 *    the rows inside each group shuffled as well. `--stable-sort-off` multiplies this term by the
 *    direction too — `dir * (byKey || byName)`, the naive spelling — and that is the only clause it
 *    moves.
 *
 * WHEN THE PRIMARY IS THE NAME there is no third term to apply, so the direction reaches the names
 * directly and a descending name sort descends.
 */
const compareRows = (a, b, { key, dir }, { foldersLast = false, stableSortOff = false } = {}) => {
  if (a.dir !== b.dir) return (a.dir ? -1 : 1) * (foldersLast ? -1 : 1);
  const primary = compareValues(sortValue(a, key), sortValue(b, key));
  if (key === "name" || primary !== 0) return primary * dir;
  const byName = compareValues(a.name, b.name);
  return stableSortOff ? byName * dir : byName;
};

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
 *
 * M18: `focusBox` IS HERE FOR THE SAME REASON `rowTop` IS. The keyboard cursor's ring is a
 * rectangle inset inside a row, and a driver that wanted to read its pixels would otherwise restate
 * the inset — which is the drift this export exists to stop, one pixel's worth of it. The ROW
 * GEOMETRY ITSELF DID NOT MOVE: the ring is drawn inside the row it marks, so `rowTop` and `rowMid`
 * mean exactly what they meant before and the drivers that aim at them need no change.
 *
 * M19: THE COLUMNS AND THE TWO CELL FORMATTERS ARE HERE, AND THE ROW GEOMETRY DID MOVE. `FOOT_H`
 * is a new term in `viewBox`, `scrollMax`, `rowsThatFit` and `clientHeightFor` — all four of which
 * are exported, so a driver that already asks here follows it and a driver that restated one of
 * them does not. `columnBoxes` is what a header press must be aimed with and `columnAt` is its
 * declared inverse; `dateText` and `sizeText` are exported so a driver can PREDICT a cell rather
 * than restate the format, which is the same argument `rowTop` is exported under. The cells the
 * program actually drew are in its account, row by row, so the two readings can be compared.
 * `bandBox` and `bandRows` are here for the same reason again: which rows a rubber band took is
 * an intersection, and a driver restating it is a driver asserting the wrong set.
 */
export const FILES_METRICS = Object.freeze({
  ROW_H, ROW_GAP, ROW_STRIDE, PAD, HEAD_H, VIEW_TOP, FOOT_H, NAME_X, GLYPH_W, TEXT_PX, FOCUS_INSET,
  SURFACE_W: START_W,
  COLUMNS, SORT_DEFAULT, DATE_W, TYPE_W, SIZE_W, NAME_MIN_W, UNKNOWN_CELL,
  rowTop, rowMid, rowAt, toSurface, viewBox, scrollMax, rowsThatFit, clientHeightFor, focusBox,
  columnBoxes, columnAt, dateText, sizeText, bandBox, bandRows,
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
/** THE KEYBOARD CURSOR'S RING, and it is its own HUE rather than its own brightness: the selection
 *  already owns a filled band outlined in `OUTLINE`, so a second near-white rectangle would make
 *  "focused" and "selected" the same picture — which is the state a press on the header produces,
 *  and the one a reader most needs to tell apart. */
const FOCUS_RING = 0x8fd0ffff;
/**
 * THE HOVER'S BAND, AND IT IS A FILL RATHER THAN AN INK.
 *
 * A lit row and a selected row must stay two readings. The selection already owns a name's COLOUR —
 * which is the only property a reader outside the surface can tell one row from another by
 * (`www/m18.html` reads the selection as the minority ink, with no geometry in the test) — so a
 * hover that changed an ink would make "lit" and "selected" the same fact seen twice, and a check
 * for either would answer for both. This sits UNDER the text and changes no ink at all.
 *
 * ONE STEP OFF `PAPER` AND NO MORE: a hover is a hint that the pointer is here, not a selection.
 */
const LIT_FILL = 0x1e2630ff;
/** THE RUBBER BAND: a translucent wash inside a solid edge, which is what makes a band over a lit
 *  or selected row read as a band over it rather than as a third selection colour. The alpha is the
 *  low byte and `cssColor` is what turns it into a canvas `rgba()` (constraint 224). */
const BAND_WASH = 0x4a9bd83c;
const BAND_EDGE = 0x8fd0ffff;

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
  let stableSortOff = false;
  let foldersLast = false;
  let noDirStat = false;
  let bandFromRow = false;
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
      if (arg === "--stable-sort-off") { stableSortOff = true; continue; }
      if (arg === "--folders-last") { foldersLast = true; continue; }
      if (arg === "--no-dir-stat") { noDirStat = true; continue; }
      if (arg === "--band-from-row") { bandFromRow = true; continue; }
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
  /* M19a. AN OPERAND IS THE READER'S WORD AND IS NEVER SECOND-GUESSED: a named directory that is
   * not there must answer ENOENT by name, not be replaced with somewhere that works. The fallback
   * belongs to the case where nobody named one. */
  const opened = operands[0]
    ? { dir: operands[0], home: false, why: "" }
    : env.std.sessionDir(env);
  if (opened.why) {
    env.std.warn(env, `${NAME}: no session tree (${opened.why}), opening ${opened.dir}, `
      + "which is the base's own data directory and is READ-ONLY");
  }
  /** WHERE THE WINDOW IS, AND IT MOVES. M18 re-lists in place, so the directory is state rather
   *  than an argument — and `history` is the stack Back pops. */
  let dir = opened.dir;
  const history = [];
  const t0 = performance.now();
  const account = {
    program: NAME, dir, win: 0, fd: 0, rows: [], drags: 0, refusedDrags: 0,
    /* M19a. WHO CHOSE THE DIRECTORY, and why it is not the session's tree when it is not: `dir`
     * alone cannot tell a reader's own operand from the read-only fallback, and those are the two
     * worlds D40 is about. THREE VALUES AND NOT A BOOLEAN — `argv`, `session`, `fallback` — because
     * an operand may name the session's tree or anywhere else, and a flag would have to lie about
     * one of them. `dirWhy` is "" except under `fallback`. */
    dirFrom: operands[0] ? "argv" : (opened.home ? "session" : "fallback"),
    dirWhy: opened.why,
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
    /* M18. THE CURSOR, THE NAVIGATION AND EVERY REFUSAL. `focus` is the keyboard cursor's row and
     * `-1` is "nothing is focused", which is a state and not an absence — a first Enter in it is a
     * refusal and the count below is where that is visible. `refusals` carries each one BY NAME,
     * because a counter alone passes for a window that refused the wrong thing. */
    focus: -1, keysyms: 0, dblclicks: 0, activations: 0, relists: 0, backs: 0,
    spawned: [], refused: 0, refusals: [], refusalWhy: "", history: 0,
    /* M19. THE SORT, THE SELECTION, THE BAND, THE HOVER AND WHAT THE `lstat` COST.
     *
     * `sort.chosen` is whether a reader has clicked a header at all, and it is a state rather than
     * a convenience: the first click on the DEFAULT column is a choice and not a reversal, so
     * without it that click would turn the list over.
     *
     * `selected` IS THE SET, IN ASCENDING INDEX ORDER, because a set of row indices read back out
     * of a program is the only statement of a Shift range a check can assert, and `anchor` is the
     * other half — a Ctrl+press that did not move the anchor is invisible in the set alone.
     *
     * `stats` AGAINST `dirStats` IS THE EVIDENCE THE DIRECTORY CALL IS PAID. One `lstat` per row,
     * directories included, so `stats === rows.length` after a listing and `dirStats` is how many
     * of them were the call that used to be skipped. `--no-dir-stat` drops the second to zero. */
    sort: { key: SORT_DEFAULT.key, dir: SORT_DEFAULT.dir, chosen: false }, sorts: 0,
    selected: [], anchor: -1, selects: 0,
    bands: 0, bandSelected: 0,
    hovers: 0, leaves: 0, lit: -1,
    stats: 0, dirStats: 0, cappedRows: 0,
    controls: {
      frozenSurface, cssPxSurface, unclampedScroll,
      stableSortOff, foldersLast, noDirStat, bandFromRow,
    },
    // A FIXTURE AND NOT A CONTROL (see this file's header), so it is reported apart from them.
    noDrainMs, heldMs: 0,
  };

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
  /** THE SORT A READER CHOSE, or the default nobody chose. `chosen` is what makes the first click
   *  on the `Name` header a choice rather than a reversal (this file's header). */
  let sort = { key: SORT_DEFAULT.key, dir: SORT_DEFAULT.dir, chosen: false };

  /** THE ORDER, APPLIED TO A LIST IN PLACE. One call site per list — `buildRows` for a new
   *  directory and the header press for a new column — so the comparator cannot be applied with one
   *  set of controls here and another there. `order` is a parameter because `relist` sorts a list it
   *  has not committed yet, with a sort state it has not committed either. */
  const sortRows = (list, order = sort) => list.sort((a, b) =>
    compareRows(a, b, order, { foldersLast, stableSortOff }));

  /**
   * THE LIST AS THE ACCOUNT CARRIES IT: one entry per row, IN LAYOUT ORDER, with the four CELLS
   * THIS PROGRAM DREW.
   *
   * `cells` is `cellOf`'s output and nothing else, so what a check reads is what a reader saw — a
   * driver that formatted a date of its own would be a second renderer of one fact. The numbers are
   * beside them because a sort is asserted on the VALUE and not on the spelling, and `format` keeps
   * the name it has had since M10: it is `kindOf`, which is the type cell.
   */
  const reportRows = () => rows.map((r) => ({
    name: r.name, format: kindOf(r), dir: r.dir, size: r.size, mtimeMs: r.mtimeMs,
    statted: r.statted,
    cells: Object.fromEntries(COLUMNS.map((c) => [c.key, cellOf(r, c.key)])),
  }));

  const buildRows = (path, order = sort) => {
    const entries = env.std.listDir(env, path);
    if (typeof entries === "number") return entries;
    // The directory with exactly one trailing slash, so a child path is `base + name` and the
    // root does not become `//name`.
    const base = path.endsWith("/") ? path : `${path}/`;
    const built = entries
      .filter((e) => e.name !== "." && e.name !== "..")
      .map((e) => {
        const isDir = e.type === DT_DIR;
        const format = isDir ? 0 : env.std.formatForPath(e.name);
        /* THE KIND, WHICH IS WHAT THE TYPE COLUMN SHOWS WHEN THERE IS NO FORMAT.
         *
         * It printed `fmt?0` for every row of `/usr/bin` — `fmtName(0)` for a file whose extension
         * nothing maps, which is every program in the system. A column that reads `fmt?0`
         * thirty-two times is a column carrying no information, and it was the first thing visible
         * once the names were legible.
         *
         * One `lstat` per row buys it. That is 32 extra calls for a directory of 32 things, which
         * is what `ls -l` already costs — and the alternative is a listing that cannot tell a
         * program from a data file, which is the distinction a reader of `/usr/bin` most wants. */
        /* M19: AND THE CALL IS NOW PAID FOR A DIRECTORY TOO, which is what a Date modified column
         * costs. It sat inside `if (!isDir)`, so a folder had no modification time at all and the
         * column would have had an empty cell on every one of them — a column lying about half its
         * rows. `--no-dir-stat` is that world, kept as a control: the folder DATE cells go empty
         * and nothing else moves, so the clause it breaks is exactly the one that says the call
         * happens.
         *
         * A REFUSED STAT LEAVES THE ROW, with its cells empty. A listing that dropped the rows it
         * could not stat would be a file manager hiding files, which is the defect M14 removed
         * from the other end. */
        let exec = false;
        let size = 0;
        let mtimeMs = 0;
        /* WHETHER THE CALL WAS PAID AND ANSWERED, which is what `cellOf` reads to tell an empty
         * cell from an unknown one. A REFUSED stat leaves it false and the row stays, with empty
         * cells: a listing that dropped the rows it could not stat would be a file manager hiding
         * files, which is the defect M14 removed from the other end. */
        let statted = false;
        if (!isDir || !noDirStat) {
          account.stats += 1;
          if (isDir) account.dirStats += 1;
          const st = env.fs.lstat(`${base}${e.name}`);
          if (typeof st !== "number") {
            statted = true;
            exec = (st.mode & 0o111) !== 0;
            size = Number(st.size);
            // NANOSECONDS INTO MILLISECONDS, which is the unit `Date` takes and the unit the VFS
            // stamped in the first place (`src/kernel/calls.mjs`). A BigInt would also not survive
            // the account's trip out of this process.
            mtimeMs = Number(st.mtimeNs / 1000000n);
          }
        }
        return {
          name: e.name, dir: isDir, format, exec, size, mtimeMs, statted,
          path: `${base}${e.name}`,
        };
      });
    return sortRows(built, order);
  };

  /** The rows, AND THEY ARE STATE SINCE M18: a re-list replaces the whole array rather than opening
   *  a second window, so everything that indexes it — the selection, the press, the cursor — is
   *  reset by `relist` and not by its callers. */
  let rows = buildRows(dir);
  if (typeof rows === "number") {
    return {
      exit: env.std.complainErrno(env, NAME, dir, rows), program: NAME, errno: -rows,
    };
  }
  account.rows = reportRows();
  /* AN EMPTY DIRECTORY ON THE COMMAND LINE IS STILL A REFUSAL, AND AN EMPTY ONE NAVIGATED INTO IS
   * NOT. The difference is whether there is a window to say it in: here there is none, so the only
   * honest place for the message is stdout and the only honest outcome is an exit. `relist` keeps
   * the window and draws a header reading `0 items`, which is where a reader meets the same fact. */
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
  /** The press that might become a drag or a band, and whether it has become a drag. Declared here
   *  because a resize re-reads them. */
  let press = null;
  let dragging = false;
  /**
   * THE SELECTION, AS A SET OF ROW INDICES, AND ITS ANCHOR.
   *
   * A SET because M19's rules need more than one row and an anchor-based range cannot be expressed
   * with a single index. INDICES rather than names because `rows` IS the layout — the sort reorders
   * the array itself — so an index is a position a reader can point at, and a Shift range over
   * indices is a range in layout order by construction.
   *
   * THE ANCHOR IS WHERE A RANGE STARTS, and it is moved by a plain press AND by a Ctrl+press. The
   * second half is the rule that is easy to miss: Ctrl+clicking three rows and then Shift+clicking
   * a fourth must range from the third, not from the first, or the reader's last gesture is not
   * where the next one starts from.
   */
  let sel = new Set();
  let anchor = -1;
  /** THE LIT ROW — the hover, `-1` for none. Not the selection and not the cursor: a reader moving
   *  the pointer across a list has chosen nothing, and a hover that selected would make every pass
   *  of the hand a choice. */
  let lit = -1;
  /** THE RUBBER BAND, or null. ITS CORNERS ARE IN CONTENT COORDINATES — `y` plus the scroll offset
   *  — so a band that is open while the list scrolls keeps hold of the rows it was drawn over
   *  rather than sliding across new ones. The drawing converts back by subtracting the offset, in
   *  the one place every other rectangle is converted. */
  let band = null;
  /** THE KEYBOARD CURSOR, and `-1` is "nothing is focused" rather than "row 0". It is NOT the
   *  selection: a press on the header clears the selection, and clearing the reader's place in the
   *  list with it would make the arrow keys start over every time the pointer missed. */
  let focus = -1;
  const setFocus = (i) => { focus = i; account.focus = i; };

  /** Publish the selection. ASCENDING, because a set has no order and a check asserting a Shift
   *  range needs one — and the anchor beside it, because a Ctrl+press that moved the anchor and
   *  toggled nothing else is invisible in the set alone. */
  const reportSelection = () => {
    account.selected = [...sel].sort((a, b) => a - b);
    account.anchor = anchor;
  };
  /** Replace the selection with one row, or with nothing at `-1`. */
  const selectOnly = (i) => {
    sel = i >= 0 ? new Set([i]) : new Set();
    anchor = i;
    reportSelection();
  };

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
    if (!inViewport(yCss)) return -1;
    const i = FILES_METRICS.rowAt(yCss, scroll);
    return i >= 0 && i < rows.length ? i : -1;
  };

  /** WHETHER A CSS-PX `y` IS INSIDE THE VIEWPORT AT ALL — the HEADER, the status strip and the gap
   *  between two rows answer differently to `rowUnder`, which cannot tell "above the list" from
   *  "between two rows". A rubber band may start in either of the second two and in neither of the
   *  first, so the two questions are separate functions rather than one return value. */
  const inViewport = (yCss) => {
    const box = FILES_METRICS.viewBox(clientW, clientH);
    return yCss >= box.y && yCss < box.y + box.h;
  };

  /** Light row `i`, or nothing at `-1`. Answers whether it CHANGED, so a stream of hovers across
   *  one row costs one repaint and not one per sample. */
  const setLit = (i) => {
    if (i === lit) return false;
    lit = i;
    account.lit = i;
    return true;
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
  const text = (ops, s, { x, y, size, rgba, flags = 0, maxWidth = 0 }) =>
    ops.push(...encodeTextRun(s, {
      x: px(x), y: px(y), size: px(size), rgba, flags, maxWidth: maxWidth ? px(maxWidth) : 0,
    }));
  /**
   * ONE CELL, CLIPPED TO ITS OWN COLUMN BY THE RENDERER.
   *
   * `DLT_ELLIPSIS` plus `a5` is the ABI's answer to "this run may be wider than the room it has",
   * and the limit is handed over rather than applied here: a program cannot measure a string, and a
   * sum of published advances is a strict UPPER bound for a proportional run — so a program that
   * pre-cut would truncate early by up to 8.55% of the string (`advanceWidth` in src/abi.mjs). The
   * renderer measures what it is about to draw and is the only thing that can.
   *
   * THE LIMIT IS THE COLUMN'S WIDTH LESS ONE `PAD`, so two neighbouring cells cannot touch. A
   * right-aligned run's `x` is its right edge, so the width is what bounds it leftwards.
   */
  const cellRun = (ops, box, s, { y, size, rgba, mono = false }) => {
    if (s === "") return;
    text(ops, s, {
      x: box.textX,
      y,
      size,
      rgba,
      flags: DLT_ELLIPSIS | (mono ? DLT_MONO : 0) | (box.right_aligned ? DLT_RIGHT : 0),
      maxWidth: Math.max(1, box.w - PAD),
    });
  };

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

  /**
   * THE SORT INDICATOR: a wedge at the TOP of the sorted column's header cell, pointing UP for
   * ascending. Windows 7 draws a triangle in that exact place, and the display list has no path op,
   * so it is three fills of descending width — the glyph's argument applied to four pixels.
   *
   * CENTRED ON THE COLUMN'S BOX, which is `columnBoxes`'s own rectangle, so a check can locate it
   * from the export rather than from a number of its own.
   */
  const sortCaret = (ops, box, dir) => {
    const mid = box.x + box.w / 2;
    for (let r = 0; r < 3; r += 1) {
      const w = dir > 0 ? 5 - r * 2 : 1 + r * 2;
      fill(ops, mid - w / 2, 1 + r, w, 1, HEAD_INK);
    }
  };

  /** One frame. EVERY NUMBER IN HERE IS A CSS PIXEL — `fill`, `stroke`, `text` and `cellRun` are
   *  what turn them into surface pixels, and they are the only things that do. */
  const paint = () => {
    // `DL_CLEAR`'s `a0` IS A COLOUR AND NOT A COORDINATE, so it is pushed raw: scaling it would
    // produce a different colour, which is the one way this list could go silently wrong.
    const ops = [{ op: DL_CLEAR, a0: PAPER }];
    /* THE CLIP DECIDES WHETHER THERE IS A LIST AT ALL, so it is built before the account is
     * written: no viewport means no rows drawn, and reporting rows nobody drew is the harness
     * dishonesty CLAUDE.md names. */
    const clip = clipOp();
    const { first, last } = visible();
    const cols = columnBoxes(clientW);

    /* THE STATUS STRIP, BEFORE THE CLIP, because it sits BELOW the viewport and a canvas clip only
     * ever intersects — drawn after the clip it would be cut away entirely.
     *
     * THE POSITION STATEMENT IS WHAT M17 PUT IN THE HEADER and what M19's four column labels left
     * no room for. It is the same sentence in the same words: `a-b of N` while the list scrolls and
     * `N items` while it does not, which is itself the statement "this list cannot scroll".
     *
     * IT IS THE ONLY RIGHT-ALIGNED RUN BEFORE THE CLIP, AND THAT IS LOAD-BEARING OUTSIDE THIS
     * PROCESS. `www/m18.html`'s `positionLine` reads this statement as "the first `DLT_RIGHT` run
     * ahead of the clip", because before M19 it was the only one there was. So the column labels
     * below are LEFT-aligned at their own boxes — which is also what Explorer does with a column
     * header over right-aligned values — and the selection count is left-aligned too. Give any of
     * them `DLT_RIGHT` and a label is read as the list's position: the clause asserting "this list
     * does not scroll" goes red over a list that does not scroll, which is the shape of defect that
     * takes a day to find.
     *
     * THE SELECTION COUNT IS A SEPARATE RUN so neither reading can be mistaken for the other by
     * something matching text — and `N selected` matches neither of that page's two regexes. */
    const drawn = clip ? Math.max(0, last - first + 1) : 0;
    const place = maxScroll() > 0 && drawn > 0
      ? `${first + 1}-${last + 1} of ${rows.length}`
      : `${rows.length} item${rows.length === 1 ? "" : "s"}`;
    const footY = clientH - FOOT_H + 4;
    fill(ops, 0, clientH - FOOT_H, clientW, 1, HEAD_RULE);
    text(ops, place, {
      x: clientW - PAD - TYPE_INSET, y: footY, size: TEXT_PX - 1, rgba: HEAD_INK,
      flags: DLT_RIGHT,
    });
    if (sel.size > 0) {
      text(ops, `${sel.size} selected`, { x: PAD, y: footY, size: TEXT_PX - 1, rgba: HEAD_INK });
    }

    /* THE HEADER, ALSO BEFORE THE CLIP — which is the whole reason the clip exists. A scrolled
     * row's top is above the header's baseline, so an unclipped list paints its name over these
     * words; the check reads the header's pixels back for exactly that reason.
     *
     * SINCE M19 IT IS FOUR COLUMN LABELS AND NOTHING ELSE, each over the column it names, with a
     * wedge on the one the sort is on. A label is what tells a reader the right-hand text is a DATE
     * and not part of the name, and it is also the thing a press on it sorts — so the labels and
     * the hit test read one geometry (`columnBoxes`) and cannot disagree about which column a
     * reader pointed at. There is no scrollbar — a thumb is dragged, and a drag on one would be a
     * gesture this program cannot route. */
    for (const box of cols) {
      text(ops, box.label, {
        // The `Name` label keeps the column's own text origin, because the rows' names are there
        // and a label over its values is the point. The other three have no left text origin of
        // their own — their cells hang off the right edge — so the label takes the box's left.
        x: box.key === "name" ? box.textX : box.x + 2,
        y: PAD,
        size: TEXT_PX,
        rgba: HEAD_INK,
        flags: DLT_BOLD | DLT_ELLIPSIS,
        maxWidth: Math.max(1, box.w - PAD),
      });
      if (box.key === sort.key) sortCaret(ops, box, sort.dir);
    }
    fill(ops, PAD, HEAD_H - 4, clientW - PAD * 2, 1, HEAD_RULE);

    /* FROM HERE DOWN THE LIST IS CLIPPED. No reset follows it: `Surface.replay` resets the clip at
     * the top of every batch (`src/abi.mjs`'s `DL_CLIP` docstring), so a clip is batch-scoped and a
     * trailing `DLC_RESET` would be a second definition of that rule. */
    if (clip) ops.push(clip);

    // NO CLIP, NO ROWS: `first - 1` is an empty range, and it is the ONE place that decision is
    // taken — a row drawn outside a viewport this program could not name would paint the header.
    const lastDrawn = clip ? last : first - 1;
    let shown = 0;
    let capped = 0;
    for (let i = first; i <= lastDrawn; i += 1) {
      const row = rows[i];
      const top = rowTop(i, scroll);
      const selected = sel.has(i);
      /* ONE ROW IS BUILT APART AND THEN MEASURED, WHICH IS WHAT `DL_MAX_OPS` COSTS. A batch over
       * the cap is refused WHOLE (`win_draw`), and a refused batch is a window that stopped
       * repainting with no error a reader can see. Four columns is four text runs, and a run is a
       * header plus one record per 24 bytes: a 255-byte name in a selected and focused row is 24
       * ops, and ninety of those is 2,160 against a 2,048-op batch — reachable by a tall window
       * over a directory of long names with everything selected. So the loop stops while there is
       * still room and SAYS HOW MANY ROWS IT DROPPED, rather than sending a batch that draws
       * nothing. */
      const rowOps = [];
      /* A SELECTED ROW INVERTS, which is what a list view does and what makes the selection
       * visible without a second colour to learn. The fill is the row's own KIND colour, so the
       * amber/green distinction survives selection rather than being painted over by one
       * highlight.
       *
       * THE HOVER'S BAND IS UNDER IT AND LOSES TO IT: a row that is both lit and selected reads as
       * selected, because the selection is the reader's choice and the hover is only where their
       * hand is. */
      if (selected) {
        fill(rowOps, PAD, top, clientW - PAD * 2, ROW_H,
          row.dir ? SELECT_FILL_DIR : SELECT_FILL);
      } else if (i === lit) {
        fill(rowOps, PAD, top, clientW - PAD * 2, ROW_H, LIT_FILL);
      }
      const kind = row.dir ? BAND_DIR : (BAND[row.format] || BAND_UNKNOWN);
      glyph(rowOps, row, PAD + 2, top + 2, selected ? INK_SELECTED : kind);
      /* THE CELLS, ONE PER COLUMN AND IN COLUMN ORDER. `cellOf` decides every string and
       * `columnBoxes` every rectangle, so the column a cell lands in is the column its header names.
       * The NAME is drawn at the row's own size and the three metadata columns one pixel smaller and
       * monospace, which is what makes a column of dates and sizes line its digits up. */
      for (const box of cols) {
        cellRun(rowOps, box, cellOf(row, box.key), {
          y: top + TEXT_DY,
          size: box.key === "name" ? TEXT_PX : TEXT_PX - 1,
          rgba: selected ? INK_SELECTED : (box.key === "name" ? INK : INK_DIM),
          mono: box.mono,
        });
      }
      if (selected) {
        stroke(rowOps, PAD, top, clientW - PAD * 2, ROW_H, OUTLINE);
      }
      /* THE KEYBOARD CURSOR, LAST AND INSIDE THE ROW. Windows 7 draws a dotted focus rectangle and
       * the display list has no dash pattern, so this is a hairline inset by one CSS pixel — which
       * is what lets a row that is both focused and selected show both rings instead of one hiding
       * the other. Its ink follows the row: `INK_SELECTED` on an inverted band, `FOCUS_RING` on
       * paper, for the contrast reason the selected text already has. */
      if (i === focus) {
        const ring = FILES_METRICS.focusBox(i, scroll, clientW);
        stroke(rowOps, ring.x, ring.y, ring.w, ring.h, selected ? INK_SELECTED : FOCUS_RING);
      }
      // ONE op of headroom is kept for the band below, which is two ops and is drawn at most once.
      if (ops.length + rowOps.length + 2 > DL_MAX_OPS) { capped = lastDrawn - i + 1; break; }
      ops.push(...rowOps);
      shown += 1;
    }
    account.firstRow = shown > 0 ? first : 0;
    account.shownRows = shown;
    if (capped !== account.cappedRows) {
      account.cappedRows = capped;
      if (capped > 0) {
        env.std.say(env, `${NAME}: ${capped} row(s) past a ${DL_MAX_OPS}-op batch were not drawn\n`);
      }
    }

    /* THE RUBBER BAND, LAST AND INSIDE THE CLIP, because it is drawn over the rows it is selecting
     * and bounded by the same viewport they are. Its corners are CONTENT coordinates, so the offset
     * comes back off here — the one place that conversion happens. */
    if (band) {
      const r = bandBox(band);
      fill(ops, r.x, r.y - scroll, r.w, r.h, BAND_WASH);
      stroke(ops, r.x, r.y - scroll, r.w, r.h, BAND_EDGE);
    }
    return env.win.draw(made.fd, ops);
  };
  paint();

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
     * empty directory could do, so there is nothing left to test.
     *
     * M18: THE CURSOR IS NOT SCROLLED TO EITHER. A resize is the reader's gesture on the WINDOW,
     * and moving the list under it to chase a cursor they are not using would be this program
     * taking over a scroll they did not ask for. The next arrow key reveals it, which is the one
     * moment the cursor's position is what the reader is thinking about. */
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

  /* ---- M18: THE CURSOR, THE ACTIVATION VERB AND BACK ---------------------------------------- */

  /**
   * SOMETHING THIS WINDOW WILL NOT DO, SAID BY NAME AND COUNTED.
   *
   * `account.why` is deliberately not touched. It is the EXIT reason and the event loop breaks on
   * it — `startDrag` uses it that way, so a drag onto a directory ends the program — and a refused
   * open must leave a reader with a window they can go on using.
   *
   * THE NAME IS THE POINT. A count alone is satisfied by a window that refused the wrong row, so
   * `refusals` carries what was asked for beside why it was declined, and a check reads the entry
   * rather than the number.
   */
  const refuse = (what, why) => {
    account.refused += 1;
    account.refusals.push({ what: String(what), why });
    account.refusalWhy = `${what}: ${why}`;
    env.std.say(env, `${NAME}: ${what}: ${why}\n`);
    return false;
  };

  /**
   * SCROLL THE LEAST THAT BRINGS ROW `i` FULLY INSIDE THE VIEWPORT, CSS px.
   *
   * IT IS NOT A CLAMP AND MUST NOT BE COUNTED AS ONE. `scrollBy` counts an end it refused to pass;
   * here nothing was refused — the offset is CHOSEN — so `dyTotal` and `clamped` are untouched, and
   * `scroll === dyTotal` stays an assertion about what the wheel did.
   *
   * THE REVEALED ROW KEEPS THE LIST'S OWN `PAD` beside it, which is what makes the two ends come
   * out exact: revealing row 0 lands on offset 0, and revealing the last row lands on `scrollMax`
   * (the pad takes the target past it and the clamp brings it back).
   */
  const revealRow = (i) => {
    if (i < 0 || i >= rows.length) return false;
    const box = FILES_METRICS.viewBox(clientW, clientH);
    if (box.h <= 0) return false;
    const top = rowTop(i);
    let next = scroll;
    if (top - PAD - scroll < box.y) next = top - PAD - box.y;
    else if (top + ROW_H + PAD - scroll > box.y + box.h) next = top + ROW_H + PAD - box.y - box.h;
    next = Math.max(0, Math.min(maxScroll(), next));
    if (next === scroll) return false;
    scroll = next;
    account.scroll = scroll;
    account.scrollMax = maxScroll();
    return true;
  };

  /** Put the cursor on row `i`, clamped to the list, and scroll to it. A CURSOR OUTSIDE THE
   *  VIEWPORT IS A CURSOR ON A ROW NOBODY CAN SEE — and the clip makes that literal, so the move
   *  and the reveal are one operation rather than two a caller could forget to pair. */
  const focusAt = (i) => {
    if (rows.length === 0) return refuse("the list", "is empty, so there is no row to focus");
    const next = Math.max(0, Math.min(rows.length - 1, i));
    const moved = next !== focus;
    if (moved) setFocus(next);
    return revealRow(next) || moved;
  };

  /** Move the cursor by `delta` rows. WITH NOTHING FOCUSED THE CURSOR ENTERS AT THE NEAR END AND
   *  DOES NOT ALSO TAKE THE STEP: a first Down lands on the first row and a first Page Down lands
   *  there too, rather than a page into a list the reader has not looked at yet. That is an entry
   *  rule and not an activation — `focus` is `-1` until a key asks for a row, which is what keeps a
   *  first Enter a refusal. */
  const moveFocus = (delta) => {
    if (rows.length === 0) return refuse("the list", "is empty, so there is no row to focus");
    if (focus < 0) return focusAt(delta > 0 ? 0 : rows.length - 1);
    return focusAt(focus + delta);
  };

  /**
   * ENTER `next` IN THIS WINDOW: new rows, a new title, and a reader who has not lost their place
   * in a stack of windows. A re-list and not a spawn, because a file manager that opened a window
   * per folder is a window manager's problem rather than a file manager.
   *
   * EVERYTHING THAT INDEXES THE OLD LIST IS DROPPED HERE. The offset, the selection, the press and
   * the cursor all named rows in a directory that is gone, and carrying any of them over is how a
   * drag comes to publish the bytes of a file the reader never touched.
   *
   * THE LISTING IS DONE BEFORE ANYTHING IS COMMITTED, so a directory that cannot be read leaves the
   * window exactly as it was — with the refusal named. A half-applied navigation would be a title
   * naming one directory over the rows of another.
   */
  /**
   * SORT BY COLUMN `key`, OR REVERSE IT.
   *
   * A CLICK ON A COLUMN THAT IS NOT THE SORT COLUMN sorts ASCENDING by it. A click on the one that
   * IS reverses it — EXCEPT the very first click, because the opening order is name-ascending and
   * nobody chose it: a reader looking at an ascending list who clicks `Name` expects the order they
   * are looking at and not its opposite. `sort.chosen` is the state that tells the two apart.
   *
   * THE SELECTION GOES AND THE CURSOR STAYS ON ITS ROW. The selection named POSITIONS in an order
   * that no longer exists, so carrying it over would highlight rows the reader never chose — the
   * same argument `relist` makes. The cursor is carried by IDENTITY instead of by index, because a
   * reader's place in a list is the FILE they were on: an index would leave the ring on whatever
   * happened to land in that slot.
   */
  const sortBy = (key) => {
    if (!COLUMNS.some((c) => c.key === key)) return refuse(String(key), "is not a column");
    const was = focus >= 0 && focus < rows.length ? rows[focus] : null;
    sort = sort.chosen && sort.key === key
      ? { key, dir: -sort.dir, chosen: true }
      : { key, dir: 1, chosen: true };
    sortRows(rows);
    account.sort = { ...sort };
    account.sorts += 1;
    account.rows = reportRows();
    selectOnly(-1);
    setFocus(was ? rows.indexOf(was) : -1);
    setLit(-1);
    band = null;
    press = null;
    dragging = false;
    env.std.say(env, `${NAME}: sorted by ${key} `
      + `${sort.dir > 0 ? "ascending" : "descending"}\n`);
    return true;
  };

  const relist = (next, { push = true } = {}) => {
    /* M19: AND THE SORT GOES WITH THEM, which is why the new list is built with the DEFAULT order
     * rather than the one in hand. `files /some/dir` and the same directory navigated into must
     * show the same rows in the same order — a sort that travelled would make row 1 depend on a
     * column the reader chose for a directory that is gone, and nothing on screen would say so.
     * Built before it is committed, like the rows, so a directory that cannot be read leaves both
     * the listing and the sort exactly as they were. */
    const order = { key: SORT_DEFAULT.key, dir: SORT_DEFAULT.dir, chosen: false };
    const built = buildRows(next, order);
    if (typeof built === "number") return refuse(next, env.std.errnoName(built));
    if (push) history.push(dir);
    dir = next;
    rows = built;
    sort = order;
    account.sort = { ...sort };
    account.dir = dir;
    account.rows = reportRows();
    account.history = history.length;
    account.relists += 1;
    scroll = 0;
    account.scroll = 0;
    account.scrollMax = maxScroll();
    selectOnly(-1);
    lit = -1;
    account.lit = -1;
    band = null;
    press = null;
    dragging = false;
    setFocus(-1);
    // THE TITLE NAMES WHERE THE WINDOW IS, which is the only text outside the surface a reader has
    // and the one thing a driver outside the process can read without decoding a display list.
    env.win.setTitle(made.fd, `${NAME} — ${dir}`);
    env.std.say(env, `${NAME}: ${dir}, ${rows.length} row(s)\n`);
    return true;
  };

  /** Back, which is Alt+Left and Backspace. GOING BACK FROM THE BOTTOM OF THE STACK IS A REFUSAL —
   *  this window was opened on a directory and there is nothing above it that a reader asked for.
   *  The entry is put back if the re-list fails, so a directory deleted under the window does not
   *  silently cost a level. */
  const goBack = () => {
    if (history.length === 0) return refuse(dir, "there is nowhere to go back to");
    const to = history.pop();
    if (!relist(to, { push: false })) {
      history.push(to);
      account.history = history.length;
      return false;
    }
    account.backs += 1;
    return true;
  };

  /**
   * OPEN ROW `i`. A directory re-lists in place; a file spawns the program the association names.
   *
   * THE ASSOCIATION IS `std.openerForPath` AND NOT A TABLE OF THIS PROGRAM'S. It carries the ARGV
   * as well as the program, because `imgview` wants `-f PATH` and `editor` wants a bare path — a
   * caller that guessed would hand one of them the other's operand (`src/libos/std.mjs`).
   *
   * A FILE NOTHING OPENS IS REFUSED BY NAME AND COUNTED. Silently doing nothing is the defect:
   * M14 shipped a desktop icon that launched a program which exited at once, and a reader reported
   * it as an icon that did not work. `openerForPath` answers null rather than defaulting, for the
   * reason recorded there — launching an arbitrary program on unknown bytes shows a reader a binary
   * as text.
   */
  const activate = (i) => {
    if (i < 0) return refuse("no row is focused", "press a row or use the arrow keys first");
    if (i >= rows.length) return refuse(`row ${i + 1}`, "is not in this list");
    const row = rows[i];
    if (row.dir) {
      if (!relist(row.path)) return false;
      account.activations += 1;
      return true;
    }
    const open = env.std.openerForPath(row.path);
    if (!open) return refuse(row.name, "no program in this system opens a file of that type");
    const argv = open.argv(row.path);
    const pid = env.proc.spawn(`${BIN_DIR}/${argv[0]}`, argv);
    if (pid < 0) return refuse(row.name, `spawn ${open.prog}: ${env.std.errnoName(pid)}`);
    account.activations += 1;
    account.spawned.push({ pid, argv });
    env.std.say(env, `${NAME}: ${argv.join(" ")} -> pid ${pid}\n`);
    // NOTHING IN THIS WINDOW CHANGED. The new process draws its own.
    return false;
  };

  env.std.say(env, `${NAME}: win ${made.win}, ${rows.length} row(s) in ${dir}\n`);
  rows.forEach((r, i) => env.std.say(env, `  row ${i + 1}  ${r.name}\t${kindOf(r)}\n`));
  env.std.say(env, "press a row and drag it onto another window. the wheel scrolls. "
    + "arrows move, Enter or a double-click opens, Backspace goes back. q quits.\n");
  env.std.say(env, "click a column header to sort, again to reverse. shift or ctrl extend the "
    + "selection; drag from empty space to band-select.\n");

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
          /* THE ARBITRATION, TAKEN HERE AND NOWHERE ELSE. A press that found a row arms the DRAG
           * threshold; a press inside the viewport that found none arms a BAND. Nothing downstream
           * re-decides it, because a gesture that could become either depending on how far the hand
           * moved is a gesture that publishes a file the reader never touched.
           *
           * `--band-from-row` IS THE WORLD WITHOUT IT: every press arms a band, so a press on a row
           * and a drag across its neighbours selects them and no drag session ever begins. */
          const inView = inViewport(at.y);
          press = i >= 0 && !bandFromRow ? { row: i, x: at.x, y: at.y } : null;
          band = (i < 0 || bandFromRow) && inView
            ? { x0: at.x, y0: at.y + scroll, x1: at.x, y1: at.y + scroll }
            : null;
          dragging = false;
          if (setLit(-1)) repaint = true;
          /* A PRESS IN THE HEADER SORTS THE COLUMN UNDER IT. The hit test is `columnAt`, the
           * declared inverse of the geometry the labels were drawn with, so the column a reader
           * pointed at is the column that sorts. A press ABOVE the viewport that is not on a column
           * clears the selection and does no more, which is what it did before M19. */
          if (at.y < VIEW_TOP) {
            const key = columnAt(at.x, clientW);
            if (key !== null) { if (sortBy(key)) repaint = true; continue; }
            if (sel.size > 0) { selectOnly(-1); repaint = true; }
            continue;
          }
          if (i >= 0) {
            account.presses += 1;
            /* THE THREE SELECTION GESTURES, AND THE MODIFIER DECIDES WHICH.
             *
             * Shift RANGES from the anchor to this row in LAYOUT order, which is index order
             * because the sort reorders `rows` itself. With no anchor there is no range, so a first
             * Shift+press behaves as a plain one rather than selecting from row 0 — a range a
             * reader never started one end of.
             *
             * Ctrl TOGGLES one row AND MOVES THE ANCHOR HERE. The second half is the rule that is
             * easy to miss and is asserted on its own: three Ctrl+presses then a Shift+press must
             * range from the third, or the reader's last gesture is not where the next starts.
             *
             * Neither modifier REPLACES the selection, which is the whole of what they are for. */
            if (ev.mods & WMOD_SHIFT) {
              if (anchor < 0) selectOnly(i);
              else {
                const lo = Math.min(anchor, i);
                const hi = Math.max(anchor, i);
                sel = new Set();
                for (let r = lo; r <= hi; r += 1) sel.add(r);
                reportSelection();
              }
            } else if (ev.mods & WMOD_CTRL) {
              if (sel.has(i)) sel.delete(i);
              else sel.add(i);
              anchor = i;
              reportSelection();
            } else {
              selectOnly(i);
            }
            account.selects += 1;
            repaint = true;
            // THE POINTER CARRIES THE CURSOR WITH IT. Without this, Enter after a click opens a
            // row other than the one the reader just highlighted.
            if (i !== focus) setFocus(i);
          } else if (sel.size > 0 || anchor >= 0) {
            // A PRESS ON EMPTY SPACE CLEARS THE SELECTION, which is where the band starts from.
            selectOnly(-1);
            repaint = true;
          }
          /* THE SECOND CLICK IS THE ACTIVATION VERB, AND THE FIRST ONE IS NOT. `WPTR_CLICK2` rides
           * the DOWN record and nothing else (`src/wm/winhost.mjs`), so this is the only place it
           * can be read — and a single click reaching here has already done the whole of what it
           * may do, which is select. A double-click on blank paper is not a refusal: there is no
           * row under it to refuse, which is a different thing from a row this program will not
           * open. */
          if (ev.mods & WPTR_CLICK2) {
            account.dblclicks += 1;
            if (i >= 0 && activate(i)) repaint = true;
          }
          continue;
        }
        /* THE POINTER LEFT THE SURFACE. It carries no usable position — the event fired outside the
         * window — so the lit row is CLEARED rather than hit-tested, which is `WPTR_LEAVE`'s own
         * contract (src/abi.mjs). Without it the last hover a window ever gets is the one nearest
         * the edge, and that row stays lit for as long as the window is open.
         *
         * TESTED BEFORE THE MOVE, because a leave is not a move: the bits are exclusive and reading
         * it as one would hit-test a coordinate the ABI says is meaningless. */
        if (ev.mods & WPTR_LEAVE) {
          account.leaves += 1;
          if (setLit(-1)) repaint = true;
          continue;
        }
        if (ev.mods & WPTR_UP) {
          /* THE BAND ENDS WITH THE PRESS THAT STARTED IT, and the selection it made STAYS. A band
           * released is a choice taken; only the rectangle goes. */
          if (band) {
            account.bands += 1;
            account.bandSelected = sel.size;
            band = null;
            repaint = true;
          }
          press = null;
          dragging = false;
          continue;
        }
        /* A MOVE, AND IT IS ONE OF THREE THINGS: a band being dragged, a press becoming a drag, or
         * A HOVER. `c` carries `event.buttons`, so a hover is a record with neither button bit and
         * nothing held — which is what makes a drag's own motion samples NOT hovers without this
         * program having to track whether a gesture is in flight. */
        if (band) {
          band.x1 = at.x;
          band.y1 = at.y + scroll;
          const hit = bandRows(band, rows.length, clientW);
          if (hit.size !== sel.size || [...hit].some((r) => !sel.has(r))) {
            sel = hit;
            reportSelection();
          }
          /* A FRAME PER SAMPLE, AND IT IS OWED RATHER THAN WASTEFUL: the rectangle is the feedback,
           * so a band that only repainted when the selection changed would lag the pointer by a
           * whole row and read as the gesture not working. */
          repaint = true;
          continue;
        }
        if (press && !dragging) {
          const far = Math.abs(at.x - press.x) >= DRAG_THRESHOLD_CSS_PX
            || Math.abs(at.y - press.y) >= DRAG_THRESHOLD_CSS_PX;
          if (!far) continue;
          dragging = true;
          const began = startDrag(press.row);
          if (began < 0 && account.why) break;
          continue;
        }
        if (press || (ev.c | 0) !== 0) continue;
        account.hovers += 1;
        if (setLit(rowUnder(at.y))) repaint = true;
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
        /* A KEYSYM AND A KEY'S BYTES ARE DISJOINT AND EXHAUSTIVE (`src/abi.mjs`'s `keysymOf`), so
         * the keysym is tested first and the byte reader below it never sees an arrow. Reading the
         * bytes first would be reading an empty array for every navigation key. */
        const sym = keysymOf(ev);
        if (sym !== 0) {
          account.keysyms += 1;
          /* ALT+LEFT IS BACK, AND IT IS TESTED BEFORE THE BARE KEYSYM. The modifier changes the
           * verb and not the key, so a plain Left — which this list has no use for, having no
           * horizontal overflow — must not fall into it. */
          if (sym === WKEY_LEFT) {
            if ((ev.mods & WMOD_ALT) && goBack()) repaint = true;
            continue;
          }
          /* A PAGE IS WHAT THE VIEWPORT HOLDS, read from the live client height and not from
           * `START_ROWS`: a reader who made the window taller gets a longer page, which is the
           * whole of what a page key means. `rowsThatFit` already floors at one. */
          const page = rowsThatFit(clientH);
          if (sym === WKEY_DOWN && moveFocus(1)) repaint = true;
          else if (sym === WKEY_UP && moveFocus(-1)) repaint = true;
          else if (sym === WKEY_PAGE_DOWN && moveFocus(page)) repaint = true;
          else if (sym === WKEY_PAGE_UP && moveFocus(-page)) repaint = true;
          else if (sym === WKEY_HOME && focusAt(0)) repaint = true;
          else if (sym === WKEY_END && focusAt(rows.length - 1)) repaint = true;
          continue;
        }
        const bytes = keyBytesOf(ev);
        if (bytes.length === 1) {
          /* ENTER AND BACKSPACE ARE BYTES, NOT KEYSYMS, and that is the ABI's decision rather than
           * this program's: `bytesForKey` already spells them 10 and 127, and a keysym row for
           * either would take them away from every program that reads them as bytes today. */
          if (bytes[0] === KEY_ENTER) {
            if (activate(focus)) repaint = true;
            continue;
          }
          if (bytes[0] === KEY_BACKSPACE) {
            if (goBack()) repaint = true;
            continue;
          }
          if (String.fromCharCode(bytes[0]) === "q") {
            account.why = "q";
            break;
          }
        }
        continue;
      }
      if (ev.type === WEV_CLOSE) { account.why = "the window asked to close"; break; }
      if (ev.type === WEV_DESTROYED) { account.why = "the window was destroyed"; break; }
    }
    if (repaint) paint();
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
  /* THE NAVIGATION, AND THE REFUSALS BESIDE IT. A reader looking at a window that did not open
   * what they double-clicked needs the reason on the same line as the count, and the LAST one is
   * printed because that is the one they just hit; `account.refusals` carries the rest. */
  env.std.say(env, `${NAME}: ${dir}, cursor ${account.focus < 0 ? "none" : account.focus + 1}, `
    + `${account.activations} opened from ${account.dblclicks} double-click(s), `
    + `${account.relists} re-list(s), ${account.backs} back, ${account.spawned.length} spawned, `
    + `${account.refused} refused`
    + `${account.refused ? ` (last: ${account.refusalWhy})` : ""}\n`);
  /* M19: THE COLUMNS' OWN LINE. The sort is where the reader left it; `selected` against `anchor`
   * is the pair a range gesture is read from; `stats` against `dirStats` is the evidence the
   * directory `lstat` was paid, which is the call the Date modified column exists on. */
  env.std.say(env, `${NAME}: sorted by ${account.sort.key} `
    + `${account.sort.dir > 0 ? "ascending" : "descending"}`
    + `${account.sort.chosen ? "" : " (the opening order, unchosen)"}`
    + ` from ${account.sorts} header click(s), `
    + `${account.selected.length} row(s) selected around anchor `
    + `${account.anchor < 0 ? "none" : account.anchor + 1}, `
    + `${account.bands} band(s), ${account.hovers} hover(s) and ${account.leaves} leave(s), `
    + `${account.stats} lstat(s) of which ${account.dirStats} on directories\n`);
  return { exit: 0, ...account };
}
