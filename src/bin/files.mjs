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
  POLLIN, POLLHUP, POLLERR, POLLNVAL, EINTR, EHOSTGONE,
  WEV_KEY, WEV_POINTER, WEV_CLOSE, WEV_DESTROYED, WEV_RESIZE, WEV_FOCUS, WEV_DRAG_DONE,
  WPTR_DOWN, WPTR_UP, WPTR_MOVE, pointerAt, keyBytesOf,
  DL_CLEAR, DL_FILL_RECT, DL_STROKE_RECT,
  DOBJ_PATHS, DOBJ_TEXT, DOBJ_PNG, DOBJ_BITMAP, DOBJ_EFFECT_COPY,
  O_RDONLY, fmtName, fmtsOf,
} from "/src/abi.mjs";

const NAME = "files";

const POLL_MS = 200;
const CEILING_MS = 300000;

/** The default directory, which is where M10's own assets live. */
const DEFAULT_DIR = "/usr/share";

/** One row, in SURFACE pixels. A band and a gap, so the bands do not touch. */
const ROW_H = 22;
const ROW_GAP = 4;
const PAD = 6;
const SURFACE_W = 240;

const PAPER = 0x12161cff;
const OUTLINE = 0xdde3ebff;
/** A row's colour IS ITS FORMAT, because that is the only thing a reader can see without text. */
const BAND = {
  [DOBJ_PNG]: 0x4a9bd8ff,
  [DOBJ_BITMAP]: 0x9fd4a8ff,
  [DOBJ_TEXT]: 0x8a8f98ff,
};
const BAND_UNKNOWN = 0x3a3f48ff;

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

  const entries = env.std.listDir(env, dir);
  if (typeof entries === "number") {
    return {
      exit: env.std.complainErrno(env, NAME, dir, entries), program: NAME, errno: -entries,
    };
  }
  /* A ROW PER FILE WHOSE FORMAT THIS SYSTEM KNOWS. A file no rule covers is NOT offered: a program
   * that put arbitrary bytes under TEXT would hand a receiver a payload it will decode as UTF-8,
   * which is the guess a typed clipboard exists to refuse (`std.formatForPath`). */
  const rows = entries
    .map((e) => ({ name: e.name, format: env.std.formatForPath(e.name) }))
    .filter((r) => r.format !== 0)
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((r) => ({ ...r, path: dir.endsWith("/") ? `${dir}${r.name}` : `${dir}/${r.name}` }));
  account.rows = rows.map((r) => ({ name: r.name, format: fmtName(r.format) }));
  if (rows.length === 0) {
    return {
      exit: env.std.complain(env, NAME, dir, "no file here has a known format"), program: NAME,
      ...account,
    };
  }

  const h = PAD * 2 + rows.length * (ROW_H + ROW_GAP) - ROW_GAP;
  const made = env.win.create({
    title: `${NAME} — ${dir}`, w: 300, h: h + 40, x: 40, y: 40,
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
  const rowTop = (i) => PAD + i * (ROW_H + ROW_GAP);
  const rowAt = (y) => {
    for (let i = 0; i < rows.length; i += 1) {
      const top = rowTop(i);
      if (y >= top && y < top + ROW_H) return i;
    }
    return -1;
  };

  const paint = (hot) => {
    const ops = [{ op: DL_CLEAR, a0: PAPER }];
    for (let i = 0; i < rows.length; i += 1) {
      const colour = BAND[rows[i].format] || BAND_UNKNOWN;
      ops.push({
        op: DL_FILL_RECT, a0: PAD, a1: rowTop(i), a2: SURFACE_W - PAD * 2, a3: ROW_H, a4: colour,
      });
      if (i === hot) {
        ops.push({
          op: DL_STROKE_RECT, a0: PAD - 2, a1: rowTop(i) - 2, a2: SURFACE_W - PAD * 2 + 4,
          a3: ROW_H + 4, a4: OUTLINE, a5: 1,
        });
      }
    }
    return env.win.draw(made.fd, ops);
  };
  paint(-1);

  env.std.say(env, `${NAME}: win ${made.win}, ${rows.length} row(s) in ${dir}\n`);
  rows.forEach((r, i) => env.std.say(env, `  row ${i + 1}  ${r.name}\t${fmtName(r.format)}\n`));
  env.std.say(env, "press a row and drag it onto another window. q quits.\n");

  /** Publish one row as a drag. The object's fd is CLOSED immediately and on purpose: the session
   *  holds the kernel's own reference, so the payload outlives this program's handle on it — and
   *  outlives this program (constraint 241). */
  const startDrag = (i) => {
    const row = rows[i];
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
