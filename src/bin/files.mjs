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
// THE ROWS HAVE NO LABELS AND THAT IS NOT AN OVERSIGHT. A display list is CLEAR, FILL_RECT,
// STROKE_RECT and LINE (M8) — there is no text op, and inventing one here would be a second
// renderer for the thing M11 is for. So a row is a BAND whose colour is its format, the row under
// the pointer is outlined, and the window's TITLE says which file is being dragged. The legend goes
// to stdout, where there is a terminal that can draw letters.

import {
  POLLIN, POLLHUP, POLLERR, POLLNVAL, EINTR, EINVAL, EHOSTGONE, DT_DIR,
  WEV_KEY, WEV_POINTER, WEV_CLOSE, WEV_DESTROYED, WEV_RESIZE, WEV_FOCUS, WEV_DRAG_DONE,
  WPTR_DOWN, WPTR_UP, WPTR_MOVE, pointerAt, keyBytesOf,
  DL_CLEAR, DL_FILL_RECT, DL_STROKE_RECT, DLT_BOLD, DLT_MONO, DLT_RIGHT, encodeTextRun,
  DOBJ_PATHS, DOBJ_TEXT, DOBJ_PNG, DOBJ_BITMAP, DOBJ_EFFECT_COPY,
  O_RDONLY, fmtName, fmtsOf,
} from "/src/abi.mjs";

const NAME = "files";

const POLL_MS = 200;
const CEILING_MS = 300000;

/** The default directory, which is where M10's own assets live. */
const DEFAULT_DIR = "/usr/share";

/* ONE ROW, IN SURFACE PIXELS — and it is a row of TEXT now rather than a coloured band.
 *
 * It was bands: a 22 px rectangle per entry, coloured by format, with no name on it. That was not
 * a stylistic choice but the display list's own limit — there was no text op, so `files` could
 * draw a row and not what the row WAS, and a reader looking at the result said "the file system
 * view is not correct". It was a column of amber and blue stripes. `DL_TEXT` (constraint 293) is
 * what changed, and this is the first program to use it.
 *
 * The geometry is a list view's: a header row, then one row per entry, each with a small glyph, a
 * name, and the type right-aligned. The surface is wider because a name needs the room. */
const ROW_H = 20;
const ROW_GAP = 2;
const PAD = 6;
const SURFACE_W = 420;
/** The header, which is also what makes the first row's `y` not zero. */
const HEAD_H = 22;
/** The glyph box at the left of a row: a folder or a page, drawn out of rectangles. */
const GLYPH_W = 16;
/** Where the name starts, and where the type column is right-aligned to. */
const NAME_X = PAD + GLYPH_W + 8;
const TYPE_RIGHT = SURFACE_W - PAD - 4;
const TEXT_PX = 12;
/** Text sits this far below a row's top, which centres a 12 px run in a 20 px row. */
const TEXT_DY = 4;
/** How many rows one window shows. 24 x 22 px plus a header is about 560 px, which fits a work
 *  area on the smallest screen this has been opened on and leaves the taskbar reachable. */
const MAX_ROWS = 24;

/**
 * THIS PROGRAM'S ROW GEOMETRY, EXPORTED — because three things outside the process need it and
 * each copy is a copy that drifts.
 *
 * `www/m10.html` drives a REAL mouse onto a row and `bench/m10-data/shell.py` does the same at a
 * prompt; both used to restate `ROW_H = 22` and `ROW_GAP = 4` beside their own `rowMid`, and
 * CLAUDE.md listed them as a known second copy with the consequence spelled out: "a drift there
 * arrives as the WRONG FILE being dragged, which the run prints". This change made that true —
 * the rows moved down by a header and shrank by 2 px — so the copies go.
 *
 * `rowMid` is the one function that turns a row INDEX into a surface y, and it is the declared
 * partner of `rowAt`, which turns a y back into an index.
 */
export const FILES_METRICS = Object.freeze({
  ROW_H, ROW_GAP, PAD, HEAD_H, SURFACE_W, NAME_X, GLYPH_W,
  rowTop: (i) => HEAD_H + PAD + i * (ROW_H + ROW_GAP),
  rowMid: (i) => HEAD_H + PAD + i * (ROW_H + ROW_GAP) + ROW_H / 2,
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
 * HOW FAR THE POINTER MUST MOVE BEFORE A PRESS BECOMES A DRAG, in surface pixels.
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
const DRAG_THRESHOLD_PX = 3;

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
  const { operands, bad, why: badWhy } = env.std.getopt(argv.slice(1), "");
  if (bad) {
    return { exit: env.std.complain(env, NAME, bad, badWhy, env.std.EXIT_USAGE), program: NAME };
  }
  const dir = operands[0] || DEFAULT_DIR;
  const t0 = performance.now();
  const account = {
    program: NAME, dir, win: 0, fd: 0, rows: [], drags: 0, refusedDrags: 0,
    pointers: 0, presses: 0, drops: [], effects: [], why: "",
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
  account.rows = rows.map((r) => ({
    name: r.name,
    format: r.dir ? "DIR" : r.format ? fmtName(r.format) : r.exec ? "PROG" : "—",
  }));
  if (rows.length === 0) {
    return {
      exit: env.std.complain(env, NAME, dir, "this directory is empty"), program: NAME,
      ...account,
    };
  }

  /* HOW MANY ROWS FIT, AND WHAT HAPPENS TO THE REST.
   *
   * A listing of `/usr/bin` is 32 entries, which at 22 px a row is a 736 px surface — a window
   * taller than the work area, with its last rows under the taskbar and no way to reach them.
   * THERE IS NO SCROLL: the window ABI delivers `WEV_POINTER` with down, up and move
   * (`src/abi.mjs`'s `WPTR_*`) and no wheel, so a scrollbar would be a control this program cannot
   * receive input for. Inventing one would be the live-looking-button defect M11 already recorded.
   *
   * So the surface is CAPPED and the overflow is STATED: a reader sees "+6 more" rather than six
   * files that do not appear to exist. `MAX_ROWS` is a number of rows and not a pixel height
   * because the row is the unit a reader counts in, and `ls` is the way to see all of them —
   * which the overflow line says. */
  const shown = rows.slice(0, MAX_ROWS);
  const hidden = rows.length - shown.length;
  const h = HEAD_H + PAD * 2 + shown.length * (ROW_H + ROW_GAP) - ROW_GAP
    + (hidden > 0 ? ROW_H : 0);
  const made = env.win.create({
    title: `${NAME} — ${dir}`, w: SURFACE_W + 20, h: h + 40,
    // CLEAR OF THE DESKTOP'S ICON COLUMN: see `WIN_ORIGIN_X` in src/libos/std.mjs.
    x: env.std.WIN_ORIGIN_X, y: env.std.WIN_ORIGIN_Y,
  });
  if (typeof made === "number") {
    return { exit: 2, ...account, why: `win_create: ${env.std.errnoName(made)}`, errno: -made };
  }
  account.win = made.win;
  account.fd = made.fd;
  const surf = env.win.surface(made.fd, SURFACE_W, h);
  if (surf < 0) {
    env.win.destroy(made.fd);
    return { exit: 3, ...account, why: `win_surface: ${env.std.errnoName(surf)}`, errno: -surf };
  }

  /** The y of a row's band, and the row under a y. One arithmetic, both directions, so a hit test
   *  and a draw cannot disagree about where row 2 is. */
  // BELOW THE HEADER, and FROM THE EXPORT: `rowAt` is the inverse of this and both read it, so a
  // press lands on the row a reader sees (the same rule `src/wm/desktop.mjs` states for the icon
  // grid). A driver outside the process reads the same function — see `FILES_METRICS`.
  const rowTop = FILES_METRICS.rowTop;
  const rowAt = (y) => {
    // `shown` AND NOT `rows`: a press below the last drawn row must find nothing rather than a
    // row that is in the list and not on the screen.
    for (let i = 0; i < shown.length; i += 1) {
      const top = rowTop(i);
      if (y >= top && y < top + ROW_H) return i;
    }
    return -1;
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
      ops.push({ op: DL_FILL_RECT, a0: x, a1: y + 4, a2: GLYPH_W, a3: 10, a4: colour });
      ops.push({ op: DL_FILL_RECT, a0: x, a1: y + 1, a2: 7, a3: 3, a4: colour });
      return;
    }
    ops.push({ op: DL_FILL_RECT, a0: x + 2, a1: y + 1, a2: GLYPH_W - 5, a3: 13, a4: colour });
    // The corner, cut back out in the paper colour: the display list has no path op, so a
    // notch is a fill of the background over a fill of the foreground.
    ops.push({ op: DL_FILL_RECT, a0: x + GLYPH_W - 6, a1: y + 1, a2: 3, a3: 3, a4: PAPER });
  };

  const paint = (hot) => {
    const ops = [{ op: DL_CLEAR, a0: PAPER }];

    /* THE HEADER. It names the columns, which is what tells a reader the right-hand text is a TYPE
     * and not part of the name — and it carries the count, because "this directory has 26 things
     * in it" is the first question a listing answers. */
    ops.push(...encodeTextRun("Name", {
      x: NAME_X, y: PAD, size: TEXT_PX, rgba: HEAD_INK, flags: DLT_BOLD,
    }));
    ops.push(...encodeTextRun(`${rows.length} item${rows.length === 1 ? "" : "s"}`, {
      x: TYPE_RIGHT, y: PAD, size: TEXT_PX, rgba: HEAD_INK, flags: DLT_BOLD | DLT_RIGHT,
    }));
    if (hidden > 0) {
      ops.push(...encodeTextRun(`+${hidden} more — run \`ls ${dir}\` to see them all`, {
        x: NAME_X, y: HEAD_H + PAD + shown.length * (ROW_H + ROW_GAP) + TEXT_DY,
        size: TEXT_PX - 1, rgba: INK_DIM,
      }));
    }
    ops.push({
      op: DL_FILL_RECT, a0: PAD, a1: HEAD_H - 4, a2: SURFACE_W - PAD * 2, a3: 1, a4: HEAD_RULE,
    });

    for (let i = 0; i < shown.length; i += 1) {
      const row = shown[i];
      const top = rowTop(i);
      const selected = i === hot;
      /* A SELECTED ROW INVERTS, which is what a list view does and what makes the selection
       * visible without a second colour to learn. The fill is the row's own KIND colour, so the
       * amber/green distinction survives selection rather than being painted over by one
       * highlight. */
      if (selected) {
        ops.push({
          op: DL_FILL_RECT, a0: PAD, a1: top, a2: SURFACE_W - PAD * 2, a3: ROW_H,
          a4: row.dir ? SELECT_FILL_DIR : SELECT_FILL,
        });
      }
      const kind = row.dir ? BAND_DIR : (BAND[row.format] || BAND_UNKNOWN);
      glyph(ops, row, PAD + 2, top + 2, selected ? INK_SELECTED : kind);
      ops.push(...encodeTextRun(row.name, {
        x: NAME_X, y: top + TEXT_DY, size: TEXT_PX,
        rgba: selected ? INK_SELECTED : INK,
      }));
      /* THE TYPE, RIGHT-ALIGNED AND MONOSPACE. Right-aligned because a column of types is read
       * down its own edge; monospace because `DIR` and `PNG` and `TEXT` lining up is the whole
       * point of a column. It is the same `fmtName` the drag refusal uses, so what a reader sees
       * here is exactly what decides whether the row can be dragged. */
      /* DIR, a FORMAT NAME, PROG, or a dash — in that order of specificity. The format is what
       * decides whether the row can be dragged, so where there is one it is what gets shown; where
       * there is not, the execute bit is the next most useful fact about the file. */
      const kindText = row.dir ? "DIR"
        : row.format ? fmtName(row.format)
          : row.exec ? "PROG" : "—";
      ops.push(...encodeTextRun(kindText, {
        x: TYPE_RIGHT, y: top + TEXT_DY, size: TEXT_PX - 1,
        rgba: selected ? INK_SELECTED : INK_DIM, flags: DLT_MONO | DLT_RIGHT,
      }));
      if (selected) {
        ops.push({
          op: DL_STROKE_RECT, a0: PAD, a1: top, a2: SURFACE_W - PAD * 2, a3: ROW_H,
          a4: OUTLINE, a5: 1,
        });
      }
    }
    return env.win.draw(made.fd, ops);
  };
  paint(-1);

  env.std.say(env, `${NAME}: win ${made.win}, ${rows.length} row(s) in ${dir}\n`);
  rows.forEach((r, i) => env.std.say(env,
    `  row ${i + 1}  ${r.name}\t${r.dir ? "directory" : fmtName(r.format)}\n`));
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

  let press = null;
  let dragging = false;
  let hot = -1;
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
    for (const ev of evs) {
      if (ev.type === WEV_RESIZE || ev.type === WEV_FOCUS) continue;
      if (ev.type === WEV_POINTER) {
        account.pointers += 1;
        const at = pointerAt(ev);
        if (ev.mods & WPTR_DOWN) {
          const i = rowAt(at.y);
          press = i >= 0 ? { row: i, x: at.x, y: at.y } : null;
          dragging = false;
          if (i !== hot) { hot = i; repaint = true; }
          if (i >= 0) account.presses += 1;
          continue;
        }
        if (ev.mods & WPTR_MOVE) {
          if (!press || dragging) continue;
          const far = Math.abs(at.x - press.x) >= DRAG_THRESHOLD_PX
            || Math.abs(at.y - press.y) >= DRAG_THRESHOLD_PX;
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
  return { exit: 0, ...account };
}
