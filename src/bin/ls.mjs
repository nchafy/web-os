// `ls`: list directory contents.
//
// The contract this program is written against is in src/bin/true.mjs.

import { DT_DIR, DT_LNK, S_IFDIR, S_IFLNK, S_IFMT } from "/src/abi.mjs";

const NAME = "ls";

/** A fallback width for the column layout when the terminal will not say. 80 is the width every
 *  terminal has had since the card deck. */
const DEFAULT_COLUMNS = 80;

/** Two spaces between columns, which is what `ls` leaves. */
const GAP = 2;

/** POSIX's permission string: a type character, then three rwx triples. */
function modeString(mode) {
  const type = (mode & S_IFMT) === S_IFDIR ? "d" : (mode & S_IFMT) === S_IFLNK ? "l" : "-";
  let out = type;
  for (let shift = 6; shift >= 0; shift -= 3) {
    const bits = (mode >> shift) & 7;
    out += (bits & 4) ? "r" : "-";
    out += (bits & 2) ? "w" : "-";
    out += (bits & 1) ? "x" : "-";
  }
  return out;
}

function joinPath(dir, name) {
  if (dir === "/") return `/${name}`;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

/**
 * Whether fd 1 is a terminal, and how wide it is.
 *
 * THIS IS WHAT MAKES `ls | wc -l` COUNT FILES rather than counting 1. A terminal gets columns
 * because a reader wants them; a pipe gets one name per line because the next program parses it.
 * `tty_get` answering ENOTTY is `isatty()` — the ABI has no separate call for it, which is why
 * there is no second way to ask.
 */
function outputWidth(env) {
  const tm = env.tty.get(1);
  if (typeof tm === "number") return { tty: false, columns: 0 };
  const ws = env.tty.winsizeGet(1);
  const columns = (typeof ws === "object" && ws && ws.cols > 0) ? ws.cols : DEFAULT_COLUMNS;
  return { tty: true, columns };
}

/**
 * Names laid out down columns, as `ls` does.
 *
 * The column count is the largest that fits, computed from the longest name — not a fixed four.
 * `rows` is a ceiling division so the last column is the short one.
 */
function columnize(names, width) {
  const longest = names.reduce((n, s) => Math.max(n, s.length), 0);
  const cell = longest + GAP;
  const perRow = Math.max(1, Math.floor(width / cell));
  if (perRow === 1) return names.map((n) => `${n}\n`).join("");
  const rows = Math.ceil(names.length / perRow);
  let out = "";
  for (let r = 0; r < rows; r += 1) {
    let line = "";
    for (let c = 0; c < perRow; c += 1) {
      const i = c * rows + r;
      if (i >= names.length) continue;
      // The LAST cell in a row is not padded: trailing spaces on every line are invisible until
      // something diffs the output.
      const isLast = i + rows >= names.length;
      line += isLast ? names[i] : names[i].padEnd(cell);
    }
    out += `${line.replace(/\s+$/, "")}\n`;
  }
  return out;
}

/** One `-l` row. The fields are POSIX's, in POSIX's order, minus the timestamp — the VFS keeps
 *  nanosecond times and there is no `strftime` here, so the field is omitted rather than printed
 *  in a format nothing else in this system uses. Named as a gap in docs/CONSTRAINTS.md 138. */
function longRow(env, path, name) {
  const st = env.fs.lstat(path);
  if (typeof st === "number") {
    return `?????????  ? ? ? ${env.std.errnoName(st).padStart(9)} ${name}\n`;
  }
  return `${modeString(st.mode)} ${String(st.nlink).padStart(3)} `
    + `${String(st.uid).padStart(5)} ${String(st.gid).padStart(5)} `
    + `${String(st.size).padStart(9)} ${name}\n`;
}

export function run(env) {
  const std = env.std;
  const { flags, operands, bad } = std.getopt((env.argv || []).slice(1), "la1");
  if (bad) {
    return { exit: std.complain(env, NAME, null, `unknown option ${bad}`, std.EXIT_USAGE) };
  }
  const targets = operands.length ? operands : ["."];
  const out = outputWidth(env);
  const onePerLine = !!flags["1"] || !!flags.l || !out.tty;
  let status = 0;
  let listed = 0;

  for (let t = 0; t < targets.length; t += 1) {
    const path = targets[t];
    // STAT FIRST, so a file operand is printed as itself rather than reported as ENOTDIR. `ls
    // /usr/bin/ls` naming one program is how a caller checks a program exists.
    const st = env.fs.stat(path);
    if (typeof st === "number") {
      status = std.complainErrno(env, NAME, path, st);
      continue;
    }
    if ((st.mode & S_IFMT) !== S_IFDIR) {
      std.say(env, flags.l ? longRow(env, path, path) : `${path}\n`);
      listed += 1;
      continue;
    }
    const entries = std.listDir(env, path);
    if (typeof entries === "number") {
      status = std.complainErrno(env, NAME, path, entries);
      continue;
    }
    // A HEADER ONLY WHEN THERE IS MORE THAN ONE TARGET, so one directory's listing pipes cleanly.
    if (targets.length > 1) std.say(env, `${t > 0 ? "\n" : ""}${path}:\n`);
    const names = entries
      // A LEADING DOT IS HIDDEN unless `-a`. `.` and `..` are not in this system's directories at
      // all — the VFS keeps parents as a field, not as entries — so there is nothing to filter for
      // them and `-a` shows only real dotfiles.
      .filter((e) => flags.a || !e.name.startsWith("."))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    listed += names.length;
    if (flags.l) {
      for (const e of names) std.say(env, longRow(env, joinPath(path, e.name), e.name));
      continue;
    }
    // A DIRECTORY GETS A TRAILING SLASH, which is the one piece of `-F` worth having: it is how a
    // reader tells `bin` from `sh` without a second column.
    const shown = names.map((e) => (e.type === DT_DIR ? `${e.name}/`
      : e.type === DT_LNK ? `${e.name}@` : e.name));
    if (!shown.length) continue;
    std.say(env, onePerLine ? shown.map((n) => `${n}\n`).join("")
      : columnize(shown, out.columns));
  }
  return { exit: status, listed, tty: out.tty, columns: out.columns };
}

/** Exported for the host probe: the two pure functions in this program — a layout over names and
 *  a width, and a mode word as a string. Neither touches an fd, so `node` can check both. */
export const _columnize = columnize;
export const _modeString = modeString;
