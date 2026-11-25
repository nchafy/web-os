// The program support library: what every program in `/usr/bin` would otherwise write out again.
// It lives in src/libos/ and not src/bin/lib/ so that `src/libos/process.mjs` has it in its own
// module graph: under src/bin/lib/ it would be fetched once per spawned process.
//
// EVERY FUNCTION HERE TAKES `env` AND HOLDS NOTHING — no module state, no cached fd, no capability
// closed over. Constraint 15's seam is that a process holds only integers, and a helper library
// caching a file description is the first thing that would break it.

import {
  E, MAX_INLINE, O_DIRECTORY, O_RDONLY, errName,
  DOBJ_TEXT, DOBJ_PNG, DOBJ_BITMAP,
  WICON_GENERIC, WICON_FOLDER, WICON_TEXT, WICON_IMAGE, WICON_PROGRAM,
  WEV_CLIENT, clientBoxAt, pointerAt,
} from "../abi.mjs";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/**
 * WHERE A WINDOW OPENS IF ITS PROGRAM HAS NO OPINION, and why it is not the top-left corner.
 *
 * THE DESKTOP'S ICON COLUMN IS THE LEFT EDGE. `src/wm/desktop.mjs` fills cells down the first
 * column before starting the second (Windows 7's own order), so the icons occupy roughly x 8..94
 * from the top down — and `files`, `editor` and `paint` all asked for x:40, which lands squarely
 * on them. Measured in Firefox with `elementFromPoint`: after ONE launch, 3 of 4 icons answered
 * `window:files — /usr/bin` instead of their own icon, so a double-click on the next icon hit the
 * new window and did nothing. That is what "I'm unable to open anything" turned out to be.
 *
 * IT IS A USERLAND CONVENTION, which is why it lives here beside `FORMAT_BY_EXT` and
 * `iconForPath` rather than in the kernel or the shell: the kernel knows nothing about icons
 * (D39), and a program picks its own geometry. Three programs needed the same number, so it has
 * one definition. A program with a real opinion about where it belongs still states it —
 * `imgview` opens beside the file list on purpose.
 *
 * The KERNEL spreads what comes after: an exact corner collision steps down-right
 * (`WinMgr.#cascade`), so two windows from here do not land on the same pixel.
 */
export const WIN_ORIGIN_X = 160;
export const WIN_ORIGIN_Y = 48;

export function bytes(text) {
  return ENC.encode(text);
}

export function text(u8) {
  return DEC.decode(u8);
}

export function errnoName(r) {
  return errName(r < 0 ? -r : r);
}

/** Write a whole string to `fd`. Returns the byte count, or a NEGATIVE ERRNO, never a throw. */
export function out(env, fd, s) {
  return env.write(fd, ENC.encode(s));
}

export function say(env, s) {
  return out(env, 1, s);
}

/** stderr, which is never redirected into a pipeline, so a failing stage inside one still says so. */
export function warn(env, s) {
  return out(env, 2, s.endsWith("\n") ? s : `${s}\n`);
}

/** A program's own diagnostic: `name: subject: reason`, on stderr, with the exit code the caller
 *  should return. One renderer, so a reader can grep `grep:` across every program's output. */
export function complain(env, name, subject, reason, code = 1) {
  // `null` means "no subject"; `""` is a subject that happens to be empty. A truthiness test
  // treats `""` as absent and prints `sh: command not found` naming nothing at all.
  const has = subject !== null && subject !== undefined;
  warn(env, has ? `${name}: ${subject}: ${reason}` : `${name}: ${reason}`);
  return code;
}

export function complainErrno(env, name, subject, r, code = 1) {
  return complain(env, name, subject, errnoName(r), code);
}

/** Read `fd` to end of file. Returns bytes, or a NEGATIVE ERRNO. No size is asked for: a pipe and a
 *  terminal have none, and the short-count loop is what makes it correct over a slow writer —
 *  `read` returning 3 bytes is not end of file. `cap` stops a program's own input exhausting the
 *  renderer's heap, and hitting it is -EFBIG rather than a short read that looks like EOF. */
export function slurp(env, fd, cap = 8 * 1024 * 1024) {
  const chunk = new Uint8Array(MAX_INLINE);
  const parts = [];
  let total = 0;
  for (;;) {
    const n = env.fs.read(fd, chunk, 0, chunk.length);
    if (n < 0) return n;
    if (n === 0) break;
    total += n;
    if (total > cap) return -E.EFBIG;
    parts.push(chunk.slice(0, n));
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}

/** `slurp` decoded. A negative errno passes through unchanged, so a caller tests for a number. */
export function slurpText(env, fd, cap) {
  const r = slurp(env, fd, cap);
  return typeof r === "number" ? r : DEC.decode(r);
}

/** One file's whole contents as text, by path. Returns a string or a NEGATIVE ERRNO. */
export function readFileText(env, path, cap) {
  const fd = env.fs.open(path, O_RDONLY);
  if (fd < 0) return fd;
  try {
    return slurpText(env, fd, cap);
  } finally {
    env.fs.close(fd);
  }
}

/** Split text into lines, without inventing a last empty one. `"a\nb\n".split("\n")` ends in `""`,
 *  which gives `wc -l` and `grep -c` one line too many: a trailing newline terminates the last line
 *  rather than starting another. Text with no trailing newline still has its last line. */
/**
 * A whole file's BYTES by path, or a negative errno. `readFileText`'s sibling, and the second
 * caller is what justifies it being here: `src/bin/clip.mjs` had its own copy, and M14's `imgview
 * -f` needs the same three lines — a file's bytes under a format are what a typed clipboard is
 * about, and decoding them as text would corrupt every image.
 */
export function readFileBytes(env, path, cap) {
  const fd = env.fs.open(path, O_RDONLY);
  if (fd < 0) return fd;
  try {
    return slurp(env, fd, cap);
  } finally {
    env.fs.close(fd);
  }
}

export function lines(s) {
  if (s === "") return [];
  const out2 = s.split("\n");
  if (out2[out2.length - 1] === "") out2.pop();
  return out2;
}

/** Call `onLine(text, number)` for each line of `fd`, STREAMING — not `slurp` then split, and the
 *  difference is a hang: a filter that reads its whole input first turns `yes | grep y | head -1`
 *  into a program that never prints (constraint 134). `onLine` returning `false` stops the read, so
 *  a caller can give up early and let its writer see EPIPE. `maxLine` answers -EFBIG. */
export function eachLine(env, fd, onLine, { maxLine = 1024 * 1024 } = {}) {
  // Its own decoder, not the module's: `{stream: true}` makes a TextDecoder STATEFUL across calls,
  // so a shared one would carry a split character into the next unrelated `text()` call.
  const dec = new TextDecoder();
  const buf = new Uint8Array(MAX_INLINE);
  let rest = "";
  let number = 0;
  for (;;) {
    const n = env.fs.read(fd, buf, 0, buf.length);
    if (n < 0) return n;
    if (n === 0) break;
    rest += dec.decode(buf.subarray(0, n), { stream: true });
    let cut = rest.indexOf("\n");
    while (cut >= 0) {
      number += 1;
      if (onLine(rest.slice(0, cut), number) === false) return 0;
      rest = rest.slice(cut + 1);
      cut = rest.indexOf("\n");
    }
    if (rest.length > maxLine) return -E.EFBIG;
  }
  // A truncated multi-byte character at end of input becomes a replacement character, not nothing.
  rest += dec.decode();
  if (rest !== "") {
    number += 1;
    onLine(rest, number);
  }
  return 0;
}

/** Every entry of a directory fd, through `readdir`'s cookie protocol. An empty batch is the end;
 *  `cookie === entries.length` is not, because a directory can run out exactly at a batch boundary.
 *  `rounds` bounds the loop, so a filesystem answering non-empty for ever reports, not hangs. */
export function readdirAll(env, fd, rounds = 4096) {
  const all = [];
  let cookie = 0;
  for (let i = 0; i < rounds; i += 1) {
    const r = env.fs.readdir(fd, cookie);
    if (typeof r === "number") return r;
    if (r.done) return all;
    all.push(...r.entries);
    cookie = r.cookie;
  }
  return -E.EOVERFLOW;
}

/** A directory's entries by path. Returns an array or a NEGATIVE ERRNO. */
export function listDir(env, path) {
  // O_DIRECTORY is required, not optional: both filesystems here answer EISDIR without it, which
  // is constraint 82's divergence from Linux.
  const fd = env.fs.open(path, O_RDONLY | O_DIRECTORY);
  if (fd < 0) return fd;
  try {
    return readdirAll(env, fd);
  } finally {
    env.fs.close(fd);
  }
}

/**
 * A tiny getopt: single-letter flags, with an optional argument. An unknown letter is reported, so
 * `head -5` — a real idiom this does not support — says so instead of treating 5 as a filename.
 *
 * @param {string[]} args  argv WITHOUT the program name.
 * @param {string} spec    letters that are flags; a letter followed by `:` takes an argument.
 * @returns {{flags: object, operands: string[], bad: string|null, why: string}} `why` separates
 *          "unknown" from "missing-argument", or `head -n` is told to type what it just typed.
 */
export function getopt(args, spec) {
  const takesArg = new Set();
  const known = new Set();
  for (let i = 0; i < spec.length; i += 1) {
    const letter = spec[i];
    if (letter === ":") continue;
    known.add(letter);
    if (spec[i + 1] === ":") takesArg.add(letter);
  }
  const flags = Object.create(null);
  const operands = [];
  let i = 0;
  for (; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") { i += 1; break; }
    if (arg.length < 2 || arg[0] !== "-") { operands.push(arg); continue; }
    for (let c = 1; c < arg.length; c += 1) {
      const letter = arg[c];
      if (!known.has(letter)) return { flags, operands, bad: `-${letter}`, why: "unknown" };
      if (!takesArg.has(letter)) { flags[letter] = true; continue; }
      // The rest of this word, or the next word. `-n3` and `-n 3` are the same option.
      const inline = arg.slice(c + 1);
      if (inline) { flags[letter] = inline; c = arg.length; continue; }
      i += 1;
      if (i >= args.length) {
        return { flags, operands, bad: `-${letter}`, why: "missing-argument" };
      }
      flags[letter] = args[i];
      c = arg.length;
    }
  }
  for (; i < args.length; i += 1) operands.push(args[i]);
  return { flags, operands, bad: null, why: "" };
}

/** A non-negative integer option, or null. The refusal belongs to the program: `Number("banana")`
 *  is NaN, which compares false against every bound and so behaves like `-n 0`. */
export function wholeNumber(s) {
  if (typeof s !== "string" || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** A usage error. 127 is the shell's own "command not found" and is not a program's to return. */
export const EXIT_USAGE = 2;

/**
 * M10. WHICH DATA FORMAT A FILE'S BYTES ARE, by extension — the file association, as data.
 *
 * IT IS USERLAND AND IT IS ONE TABLE. The kernel knows a format id and nothing about names, so the
 * mapping is a convention programs share — and three programs need it (`clip` copies a file,
 * `files` offers one, `imgview` is told what arrived). A second copy is how `clip` and `files` come
 * to disagree about what a `.rgba` is, which is a drag that offers a format the receiver cannot
 * read (constraint 240).
 *
 * `/usr`'s own mount drops the extension from a PROGRAM's name and keeps it on a data file, which
 * is what makes this table usable at all (`src/kernel/providerfs.mjs`).
 */
export const FORMAT_BY_EXT = Object.freeze({
  txt: DOBJ_TEXT,
  md: DOBJ_TEXT,
  png: DOBJ_PNG,
  rgba: DOBJ_BITMAP,
});

/**
 * A PATH'S EXTENSION, lowercased, or "" — and the ONE place that split is written.
 *
 * It existed four times: inside `formatForPath`, inside `iconForPath`, and as `extOf` in
 * `src/bin/desktop.mjs`, each spelling the same four lines. Every table that keys off an extension
 * now asks this, so a rule about leading dots or a trailing one is decided once.
 *
 * A LEADING DOT IS NOT AN EXTENSION, which is what `dot > 0` means: `.profile` is a name, not a
 * file of type `profile`. A trailing dot yields "" for the same reason.
 */
export function extOf(path) {
  const name = String(path).split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The format a path's bytes are, or 0 for one no rule covers. 0 and not a guess: a program that
 *  offered TEXT for an unknown extension would put arbitrary bytes under a format a receiver will
 *  decode as UTF-8. */
export function formatForPath(path) {
  const ext = extOf(path);
  return Object.prototype.hasOwnProperty.call(FORMAT_BY_EXT, ext) ? FORMAT_BY_EXT[ext] : 0;
}

/**
 * M18. WHICH PROGRAM OPENS A FILE, and with what argv. The third table keyed by extension, beside
 * `FORMAT_BY_EXT` and `ICON_BY_EXT`, and userland's for the same reason: the kernel knows nothing
 * about names and the shell draws rows it was published.
 *
 * IT MOVED HERE FROM `src/bin/desktop.mjs`, where it was `OPENS_FILES` and the desktop was its only
 * reader. M18 gives `files` an activation verb — a double-click or Enter on a row — so the
 * association has a second reader, and the second caller is what justifies the move. A copy in
 * `files` is how a `.rgba` comes to open in one program from the desktop and another from the file
 * list.
 *
 * THE ARGV IS PART OF THE ASSOCIATION, not a caller's business: `imgview` wants `-f PATH` and
 * `editor` wants a bare path, and a caller that guessed would launch a program that reads its
 * operand as something else.
 */
export const OPENS_FILES = Object.freeze({
  png: { prog: "imgview", argv: (path) => ["imgview", "-f", path] },
  rgba: { prog: "imgview", argv: (path) => ["imgview", "-f", path] },
  txt: { prog: "editor", argv: (path) => ["editor", path] },
  md: { prog: "editor", argv: (path) => ["editor", path] },
});

/** The opener for a path, or null when no rule covers it. NULL AND NOT A DEFAULT: a file this
 *  system has no program for must be refused by name, because launching an arbitrary program on
 *  unknown bytes is how a reader is shown a binary as text. */
export function openerForPath(path) {
  const ext = extOf(path);
  return Object.prototype.hasOwnProperty.call(OPENS_FILES, ext) ? OPENS_FILES[ext] : null;
}

/**
 * M14. WHICH ICON A FILE GETS, by extension and by what it is — the other half of the file
 * association, and userland's for `FORMAT_BY_EXT`'s reason: the kernel carries an icon ID and knows
 * nothing about names (`src/abi.mjs` WICON_*), and the shell draws an ID and knows nothing about
 * files. The convention in between belongs to the programs that publish rows.
 *
 * A DIRECTORY IS A FOLDER WHATEVER IT IS CALLED, which is why `isDir` is an argument rather than
 * another extension: `/usr/bin` has no extension and is not a generic file.
 */
export const ICON_BY_EXT = Object.freeze({
  txt: WICON_TEXT,
  md: WICON_TEXT,
  png: WICON_IMAGE,
  rgba: WICON_IMAGE,
});

/** The icon id for a path. `WICON_FOLDER` for a directory, `WICON_PROGRAM` for something the
 *  caller says is executable, the table for a known extension, and the generic page otherwise —
 *  which is what a reader should see for a file nothing recognises. */
export function iconForPath(path, { isDir = false, isProgram = false } = {}) {
  if (isDir) return WICON_FOLDER;
  const ext = extOf(path);
  if (Object.prototype.hasOwnProperty.call(ICON_BY_EXT, ext)) return ICON_BY_EXT[ext];
  if (isProgram) return WICON_PROGRAM;
  return WICON_GENERIC;
}

/* ---- M16: a surfaced program's answer to WEV_CLIENT -----------------------------------------
 *
 * THREE FUNCTIONS AND ONE FACTOR. `lastClientEvent` collapses a drained batch, `resurface` asks
 * the kernel for the new backing store, and `cssPointAt` converts an input coordinate back. The
 * third is not an afterthought: fixing the OUTPUT side alone lands a press two rows off at dpr 2,
 * because `pointerAt` returns SURFACE pixels while a program's row heights are CSS pixels. Both
 * directions are the same unit error, so both live here.
 *
 * NO NEW CAPABILITY. `resurface` calls `env.win.surface`, which every windowed program already
 * holds; the other two are pure. This file runs inside a process (CLAUDE.md: the trust boundary in
 * file form), so a helper that reached for anything the kernel did not hand the caller would be
 * the breach.
 */

/**
 * The LAST `WEV_CLIENT` in a drained batch, or `null` — the one a caller should act on.
 *
 * ONE RE-SURFACE PER BATCH, NOT PER EVENT, and this is what makes that reachable. The kernel
 * replaces a TAIL client record rather than appending (`WinMgr.pushClient`), so a batch holds one
 * client event only while nothing else arrived between two reports; a resize that moves the
 * pointer interleaves `WEV_POINTER` records and the replacement no longer applies. A caller that
 * re-surfaced per event would then destroy and rebuild a canvas (`src/wm/winhost.mjs` `#surface`)
 * once per intermediate size and throw every one but the last away.
 *
 * The idiom, so five programs write the same three lines:
 *
 *     const client = env.std.lastClientEvent(evs);
 *     for (const ev of evs) {
 *       if (ev.type === WEV_CLIENT) { if (ev !== client) continue; ...resurface... }
 *
 * Identity and not an index, because `for (const ev of evs)` is what all five callers already
 * write and a record is the only handle that loop has.
 */
export function lastClientEvent(evs) {
  if (!Array.isArray(evs)) return null;
  for (let i = evs.length - 1; i >= 0; i -= 1) {
    if (evs[i] && evs[i].type === WEV_CLIENT) return evs[i];
  }
  return null;
}

/**
 * Re-ask for a surface at the client box a `WEV_CLIENT` reported, and return what the caller needs
 * to lay out. FIVE PROGRAMS NEED EXACTLY THIS — `files`, `editor`, `imgview`, `paint`, `taskmgr` —
 * so a second copy is how two of them come to disagree about whether a repaint is owed.
 *
 * TAKES THE EVENT AND THE WINDOW'S FD, AND NONE OF THE CALLER'S LAYOUT CONSTANTS. A program's
 * `ROW_H` is its own business and this function must not acquire an opinion about it; what it owns
 * is the unit boundary, which is the one thing all five share.
 *
 * RETURNS, on success (`ok: true`):
 *   `w`, `h`      the granted backing store, in DEVICE pixels — the unit `win_surface` takes and
 *                 `SURFACE_MAX_PX` bounds. The event's own `a`/`b`, passed through UNSCALED.
 *   `wCss`, `hCss` the same box in CSS pixels, which is the unit a caller's layout constants are
 *                 in. Derived here and not at five call sites, because `got.w / got.dpr` written
 *                 five times is five chances to write `*`.
 *   `dpr`         the device-pixel ratio, and ALSO this surface's scale. See below.
 *
 * ONE FACTOR SUFFICES, AND ONLY BECAUSE THIS FUNCTION CREATES THE COINCIDENCE. A surface pixel is
 * the process's own unit and a device pixel is the display's; they are equal only when the surface
 * IS the full client content box (PRD §2), and a surface smaller than its box is CSS-stretched to
 * it on purpose (`src/wm/surface.mjs`). This asks for exactly the box in device pixels, so
 * afterwards surface px = CSS px x dpr and `dpr` converts both directions. A program that wants a
 * backing store of some other size MUST NOT use these helpers: its scale is not the dpr and
 * `cssPointAt` would be wrong for it.
 *
 * AN UNCHANGED BOX NEVER ARRIVES HERE, so there is no early return for one. The kernel raises
 * `WEV_CLIENT` only when the measured box actually moved (`WinMgr.setBox`'s
 * `cw !== this.clientW` guard), and this file holds no state to compare against — every function
 * here holds nothing, which is constraint 15's seam. A caller that re-surfaces at the size it
 * already has pays a canvas rebuild for no pixels, and `lastClientEvent` is how it avoids that.
 *
 * A REFUSAL IS PERMANENT AND MUST BE SURFACED, NOT RETRIED. `-ENOMEM` is the surface budget, which
 * is a ceiling and not a transient (`WinMgr.surface`), and `-EINVAL` is a box no window may have;
 * a program that retried either would retry for ever. The kernel leaves the previous surface in
 * place on a refusal, so the caller's EXISTING layout and scale are still correct — it MUST keep
 * them and report, and MUST NOT lay out from a failed return. The derived CSS fields are zero
 * there for that reason: a layout built from them is wrong at a glance rather than subtly.
 *
 * THE CEILING IS NOT PRE-CHECKED HERE. `SURFACE_MAX_PX` is the kernel's to enforce and a copy of
 * the test inside a process is a second definition of a policy, which is worse than a round trip.
 *
 * THE POSITIVE-BOX GUARD IS THE PROGRAM'S OWN and does not rest on the kernel keeping its. A
 * zero-sized box is unactionable — `win_surface` answers `-EINVAL` for it — so a program told one
 * has nothing to do but say so, and the only route by which a box reaches here is a record the
 * page's `win-event` route can also carry. A library that trusted the far side for a number it
 * then spends a syscall on is the shape M6 removed.
 */
export function resurface(env, fd, ev) {
  const want = clientBoxAt(ev);
  if (!(want.w > 0) || !(want.h > 0) || !(want.dpr > 0)) {
    return { ok: false, errno: E.EINVAL, ...want, wCss: 0, hCss: 0 };
  }
  const rc = env.win.surface(fd, want.w, want.h);
  if (rc < 0) return { ok: false, errno: -rc, ...want, wCss: 0, hCss: 0 };
  // NOT ROUNDED. A 441-device-px box at dpr 2 is 220.5 CSS px, and rounding it here while
  // `cssPointAt` divides exactly would put the layout and the hit test on different grids — the
  // defect this pair exists to remove, reintroduced half a pixel at a time.
  return { ok: true, errno: 0, ...want, wCss: want.w / want.dpr, hCss: want.h / want.dpr };
}

/**
 * A `WEV_POINTER`'s coordinates in CSS pixels: the unit a program's layout constants are in.
 *
 * `scale` is the `dpr` a successful `resurface` returned, and the paragraph there says why one
 * factor is enough. Composed with `pointerAt` rather than left to the caller because the sign
 * extension and the division are both required and a program doing one without the other gets a
 * drag that leaves the surface as four billion CSS pixels.
 *
 * NOT FLOORED. A row test is a range test, so a fractional y resolves correctly, and flooring
 * would move the boundary by half a row at dpr 2 relative to the unfloored layout above.
 *
 * A NON-POSITIVE SCALE THROWS, for `dprFixed`'s reason rather than against it. `scale` is a number
 * the CALLER holds — 1 until its first `WEV_CLIENT` arrives, the `dpr` of the last SUCCESSFUL
 * `resurface` after that — and never a field read off this event, so a bad one is a program that
 * laid out from a failed return and not hostile input. Substituting 1 would answer a hit test in
 * the wrong unit with no error anywhere, which is the defect, and dividing by 0 would answer
 * `Infinity`, which a range test rejects everywhere and reads as a press that hit nothing.
 */
export function cssPointAt(ev, scale) {
  if (!(scale > 0)) throw new Error(`cssPointAt: ${scale} is not a surface scale`);
  const at = pointerAt(ev);
  return { x: at.x / scale, y: at.y / scale, buttons: at.buttons };
}
