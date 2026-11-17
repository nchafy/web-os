// `wc`: count lines, words and bytes.
//
// The contract this program is written against is in src/bin/true.mjs.

import { MAX_INLINE, O_RDONLY } from "/src/abi.mjs";

const NAME = "wc";

/**
 * Count one stream.
 *
 * LINES ARE NEWLINE CHARACTERS, not "pieces between newlines", which is what `wc -l` actually
 * counts everywhere — a file with no final newline reports one fewer line than it has text lines,
 * and that is correct rather than an off-by-one. `src/libos/std.mjs`'s `lines()` answers the other
 * question and is deliberately not used here.
 *
 * WORDS ARE RUNS OF NON-WHITESPACE, counted in one pass over the bytes rather than by splitting:
 * splitting a 1 MiB file on whitespace allocates an array of every word in it to then take only
 * its length.
 */
function count(env, fd) {
  const buf = new Uint8Array(MAX_INLINE);
  let lines = 0;
  let words = 0;
  let bytes = 0;
  let inWord = false;
  for (;;) {
    const n = env.fs.read(fd, buf, 0, buf.length);
    if (n < 0) return n;
    if (n === 0) break;
    bytes += n;
    for (let i = 0; i < n; i += 1) {
      const b = buf[i];
      if (b === 0x0a) lines += 1;
      // space, tab, LF, CR, VT, FF — the same set `isspace` has for ASCII.
      const space = b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0b
        || b === 0x0c;
      if (space) inWord = false;
      else if (!inWord) { inWord = true; words += 1; }
    }
  }
  return { lines, words, bytes };
}

/** The selected counts, in POSIX's own order — lines, words, bytes — whatever order the flags came
 *  in. `wc -cl` and `wc -lc` print the same thing everywhere, and a program that echoed the flag
 *  order would be the only one that did not. */
function format(got, want) {
  const parts = [];
  if (want.l) parts.push(String(got.lines));
  if (want.w) parts.push(String(got.words));
  if (want.c) parts.push(String(got.bytes));
  return parts.join(" ");
}

export function run(env) {
  const std = env.std;
  const { flags, operands, bad } = std.getopt((env.argv || []).slice(1), "lwc");
  if (bad) {
    return { exit: std.complain(env, NAME, null, `unknown option ${bad}`, std.EXIT_USAGE) };
  }
  // NO FLAGS MEANS ALL THREE, which is POSIX's default and not a special case to remember: the
  // selection is computed once, here, so `format` has one input shape.
  const want = (flags.l || flags.w || flags.c) ? flags : { l: true, w: true, c: true };

  if (operands.length === 0) {
    const got = count(env, 0);
    if (typeof got === "number") {
      return { exit: std.complainErrno(env, NAME, null, got), errno: -got };
    }
    std.say(env, `${format(got, want)}\n`);
    return { exit: 0, counts: got };
  }

  let status = 0;
  const total = { lines: 0, words: 0, bytes: 0 };
  let counted = 0;
  for (const path of operands) {
    const fd = path === "-" ? 0 : env.fs.open(path, O_RDONLY);
    if (fd < 0) {
      status = std.complainErrno(env, NAME, path, fd);
      continue;
    }
    const got = count(env, fd);
    if (fd !== 0) env.fs.close(fd);
    if (typeof got === "number") {
      status = std.complainErrno(env, NAME, path, got);
      continue;
    }
    total.lines += got.lines;
    total.words += got.words;
    total.bytes += got.bytes;
    counted += 1;
    std.say(env, `${format(got, want)} ${path}\n`);
  }
  // A TOTAL ONLY FOR TWO OR MORE FILES THAT WERE ACTUALLY READ. `wc a missing` prints one row and
  // no total, because a total under a row is a sum of one number.
  if (counted > 1) std.say(env, `${format(total, want)} total\n`);
  return { exit: status, total };
}
