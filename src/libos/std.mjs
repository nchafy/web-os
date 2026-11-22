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
} from "../abi.mjs";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

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

/** The format a path's bytes are, or 0 for one no rule covers. 0 and not a guess: a program that
 *  offered TEXT for an unknown extension would put arbitrary bytes under a format a receiver will
 *  decode as UTF-8. */
export function formatForPath(path) {
  const name = String(path).split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return 0;
  const ext = name.slice(dot + 1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(FORMAT_BY_EXT, ext) ? FORMAT_BY_EXT[ext] : 0;
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
  const name = String(path).split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (Object.prototype.hasOwnProperty.call(ICON_BY_EXT, ext)) return ICON_BY_EXT[ext];
  if (isProgram) return WICON_PROGRAM;
  return WICON_GENERIC;
}
