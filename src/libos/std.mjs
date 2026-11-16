// The program support library: what every program in `/usr/bin` would otherwise write out again.
//
// WHY IT IS IN src/libos/ AND NOT src/bin/lib/. A program's image is a Blob URL built by the
// kernel (src/kernel/exec.mjs), and a static specifier inside it resolves against the DOCUMENT —
// so a module no process has already imported would be fetched once per spawned process, which is
// the herd `src/kernel/kernel.mjs` measured losing 6 of 480 connections to. `src/libos/process.mjs`
// imports this file for its own graph, so it is already in every process's module map; a program
// receives it as `env.std` and imports nothing at all.
//
// EVERY FUNCTION HERE TAKES `env` AND HOLDS NOTHING. There is no module state, no fd cached across
// calls and no capability closed over — constraint 15's seam is that a process holds only
// integers, and a helper library that cached a file description would be the first thing to break
// it. The rule is testable: nothing below is a class and nothing below assigns a module variable.

import { E, MAX_INLINE, O_DIRECTORY, O_RDONLY, errName } from "../abi.mjs";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** Text as UTF-8 bytes. One encoder for every program rather than one per program. */
export function bytes(text) {
  return ENC.encode(text);
}

export function text(u8) {
  return DEC.decode(u8);
}

/** The errno behind a negative return, as a name. `-2` reads as nothing; `ENOENT` reads as itself. */
export function errnoName(r) {
  return errName(r < 0 ? -r : r);
}

/**
 * Write a whole string to `fd`. Returns the byte count, or a NEGATIVE ERRNO.
 *
 * The short-count loop is already in `env.write`; this is the string half, and it returns the
 * errno rather than throwing because a program's answer to EPIPE is to stop, not to unwind.
 */
export function out(env, fd, s) {
  return env.write(fd, ENC.encode(s));
}

/** stdout, which is fd 1 for every program this system starts. */
export function say(env, s) {
  return out(env, 1, s);
}

/** stderr. NEVER redirected into a pipeline by this shell, which is why a failing stage inside a
 *  pipeline still says so. */
export function warn(env, s) {
  return out(env, 2, s.endsWith("\n") ? s : `${s}\n`);
}

/**
 * A program's own diagnostic, in the one format every program here uses:
 * `name: subject: reason`, on stderr, with the exit code the caller should return.
 *
 * ONE RENDERER, because the shape of a diagnostic is a fact about this system rather than a
 * preference of each program — and a reader greps for `grep:` across every program's output.
 */
export function complain(env, name, subject, reason, code = 1) {
  // `null` MEANS "NO SUBJECT"; an empty string is a subject that happens to be empty, and the two
  // are different. A truthiness test treated `""` as absent, so a command name that expanded to
  // nothing produced `sh: command not found` naming nothing at all.
  const has = subject !== null && subject !== undefined;
  warn(env, has ? `${name}: ${subject}: ${reason}` : `${name}: ${reason}`);
  return code;
}

/** `complain` for a negative errno, which is the overwhelmingly common case. */
export function complainErrno(env, name, subject, r, code = 1) {
  return complain(env, name, subject, errnoName(r), code);
}

/**
 * Read `fd` to end of file. Returns bytes, or a NEGATIVE ERRNO.
 *
 * SIZE IS NOT ASKED FOR, and that is the point: a pipe and a terminal have no size, and a file's
 * size can change under a reader. The loop consumes short counts, which is what makes this correct
 * over a pipe whose writer is slow — `read` returning 3 bytes is not end of file.
 *
 * `cap` bounds the result. A program that slurps an unbounded stream is a program that can be made
 * to exhaust the renderer's heap by its own input, so the default is generous and finite, and
 * hitting it is reported as -EFBIG rather than as a short read that looks like EOF.
 */
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

/** One file's whole contents as text, by path. Returns a string or a NEGATIVE ERRNO — and closes
 *  the fd on every path, including the failing one. */
export function readFileText(env, path, cap) {
  const fd = env.fs.open(path, O_RDONLY);
  if (fd < 0) return fd;
  try {
    return slurpText(env, fd, cap);
  } finally {
    env.fs.close(fd);
  }
}

/**
 * Split text into lines, WITHOUT inventing a last empty one.
 *
 * `"a\nb\n".split("\n")` is `["a", "b", ""]`, and every program that counted those got one line
 * too many — `wc -l` and `grep -c` both. A trailing newline terminates the last line; it does not
 * start another. Text with no trailing newline still has its last line, which is what `head` on a
 * file with no final newline has to preserve.
 */
export function lines(s) {
  if (s === "") return [];
  const out2 = s.split("\n");
  if (out2[out2.length - 1] === "") out2.pop();
  return out2;
}

/**
 * Call `onLine(text, number)` for each line of `fd`, STREAMING.
 *
 * NOT `slurp` THEN SPLIT, and the difference is a hang: a filter that reads its whole input before
 * emitting anything turns `yes | grep y | head -1` into a program that never prints, because the
 * middle stage is waiting for an EOF its writer will never send. The same reason `cat` and `head`
 * copy in pieces.
 *
 * The last line is delivered even with no trailing newline, which is what `grep` on a file whose
 * final line is unterminated has to do. `onLine` returning `false` stops the read — that is how a
 * caller gives up early and lets its writer see EPIPE.
 *
 * `maxLine` bounds the buffer. A stream with no newline in it is otherwise a way to make a filter
 * allocate without limit; -EFBIG names what happened.
 */
export function eachLine(env, fd, onLine, { maxLine = 1024 * 1024 } = {}) {
  // ITS OWN DECODER, not the module's. `{stream: true}` makes a TextDecoder STATEFUL across calls
  // — it holds the tail of a split multi-byte character — so a shared one would carry that state
  // into the next unrelated `text()` call, and two reads interleaved by a nested `eachLine` would
  // each decode with the other's partial character.
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
  // The flush: a truncated multi-byte character at end of input becomes a replacement character
  // here rather than being dropped.
  rest += dec.decode();
  if (rest !== "") {
    number += 1;
    onLine(rest, number);
  }
  return 0;
}

/**
 * Every entry of a directory fd, through `readdir`'s cookie protocol.
 *
 * `cookie === entries.length` is NOT the end condition — a directory can run out exactly at a
 * batch boundary (src/libos/syscall.mjs says so). An EMPTY BATCH is the end, and the bound on the
 * loop is here so a filesystem that answered a non-empty batch forever reports instead of hanging.
 */
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
  // O_DIRECTORY IS REQUIRED HERE, not optional: both this system's filesystems refuse to open a
  // directory without it with EISDIR (constraint 82 records the divergence from Linux, where the
  // open succeeds and the read fails instead).
  const fd = env.fs.open(path, O_RDONLY | O_DIRECTORY);
  if (fd < 0) return fd;
  try {
    return readdirAll(env, fd);
  } finally {
    env.fs.close(fd);
  }
}

/**
 * A tiny getopt: single-letter flags, with an optional argument.
 *
 * @param {string[]} args  argv WITHOUT the program name.
 * @param {string} spec    letters that are flags; a letter followed by `:` takes an argument.
 * @returns {{flags: object, operands: string[], bad: string|null, why: string}}
 *
 * `why` IS "unknown" OR "missing-argument", because a program cannot write a useful message
 * without knowing which: `head -n` with no operand answered `unknown option -n (use -n n)`,
 * telling the reader to type what they had just typed.
 *
 * `--` ends option parsing, `-` is an operand (POSIX's "read standard input"), and an unknown
 * letter is REPORTED rather than ignored: a program that silently accepted `-Q` would run with
 * behaviour nobody asked for, and `head -5` — a real idiom this does not support — must say so
 * instead of treating 5 as a filename.
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

/**
 * A non-negative integer option, or null.
 *
 * SEPARATE FROM `getopt` because the refusal belongs to the program: `head -n banana` is a usage
 * error with a message naming `banana`, and `Number("banana")` is NaN, which compares false against
 * every bound and would silently behave like `-n 0`.
 */
export function wholeNumber(s) {
  if (typeof s !== "string" || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** The standard exit codes these programs use, named once. 2 is a usage error, which is what every
 *  Unix tool returns for one; 1 is "ran and something failed"; 127 is the shell's own
 *  "command not found" and is not a program's to return. */
export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;
