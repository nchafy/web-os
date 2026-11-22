// `clip`: the typed clipboard, from a prompt.
//
// The contract this program is written against is in src/bin/true.mjs.
//
//   clip copy FILE...     publish a data object. A PATH LIST always, and the file's own format too
//                         when there is exactly one file — so `clip copy /usr/share/logo.png`
//                         offers both "that file" and "those bytes, as a PNG"
//   clip copy -           the bytes on stdin, as TEXT. `echo hi | clip copy -`
//   clip paste [-f FMT]   write one format's bytes to stdout
//   clip list             what the clipboard offers, and how big each one is
//
// WHY A PATH LIST AND THE BYTES BOTH. This is Windows' own answer and the reason is a receiver that
// cannot read either one: a file manager wants the PATH (to move the file), an image view wants the
// BYTES (it may not be able to open the path at all), and neither should have to ask the other what
// it meant. One object, two formats, and the receiver picks (constraint 240).
//
// AND WHY THE FILE'S FORMAT ONLY FOR ONE FILE: two files of two formats cannot both be "the PNG in
// this object". A format is a slot and not a list.

import {
  DOBJ_TEXT, DOBJ_PATHS, DOBJ_PNG, DOBJ_BITMAP, DOBJ_WHERE_CLIPBOARD,
  fmtsOf, fmtName,
} from "/src/abi.mjs";

const NAME = "clip";

/** A format NAME to its id, which is the inverse of `fmtName` for the one place a person types
 *  one. Derived from the table rather than written again: `-f png` must name format 3 for as long
 *  as `fmtName(3)` is "png". */
const BY_NAME = Object.fromEntries(
  [DOBJ_TEXT, DOBJ_PATHS, DOBJ_PNG, DOBJ_BITMAP].map((f) => [fmtName(f), f]),
);

const USAGE = `usage: ${NAME} copy FILE... | ${NAME} copy - | ${NAME} paste [-f FORMAT] `
  + `| ${NAME} list\n       formats: ${Object.keys(BY_NAME).join(" ")}\n`;

export function run(env) {
  const argv = (env.argv || []).map(String);
  const { flags, operands, bad, why } = env.std.getopt(argv.slice(1), "f:");
  if (bad) return { exit: env.std.complain(env, NAME, bad, why, env.std.EXIT_USAGE), program: NAME };
  const verb = operands[0] || "";
  const rest = operands.slice(1);

  if (verb === "copy") return copy(env, rest);
  if (verb === "paste") return paste(env, flags.f);
  if (verb === "list") return list(env);
  env.std.warn(env, USAGE);
  return { exit: env.std.EXIT_USAGE, program: NAME, why: "no verb" };
}

function copy(env, files) {
  if (files.length === 0) {
    env.std.warn(env, USAGE);
    return { exit: env.std.EXIT_USAGE, program: NAME, why: "copy with no file" };
  }
  const account = { program: NAME, verb: "copy", formats: [], bytes: 0, paths: [] };

  // STDIN AS TEXT, which is what makes the clipboard reachable from a pipeline at all.
  if (files.length === 1 && files[0] === "-") {
    const text = env.std.slurp(env, 0);
    if (typeof text === "number") {
      return { exit: env.std.complainErrno(env, NAME, "-", text), program: NAME };
    }
    const made = env.data.create([DOBJ_TEXT]);
    if (typeof made === "number") return { exit: env.std.complainErrno(env, NAME, "dataobj_create", made), program: NAME };
    const set = env.data.set(made.fd, DOBJ_TEXT, text);
    if (set < 0) {
      env.fs.close(made.fd);
      return { exit: env.std.complainErrno(env, NAME, "dataobj_set", set), program: NAME };
    }
    const r = env.data.toClipboard(made.fd);
    env.fs.close(made.fd);
    if (r < 0) return { exit: env.std.complainErrno(env, NAME, "clipboard", r), program: NAME };
    account.formats = ["text"];
    account.bytes = text.length;
    env.std.say(env, `${NAME}: ${text.length} bytes as text\n`);
    return { exit: 0, ...account };
  }

  // THE PATHS MUST RESOLVE BEFORE ANYTHING IS PUBLISHED. A clipboard holding a path list naming a
  // file that is not there is worse than a refusal, because the paste looks like it worked.
  const paths = [];
  for (const file of files) {
    const st = env.fs.stat(file);
    if (typeof st === "number") return { exit: env.std.complainErrno(env, NAME, file, st), program: NAME };
    paths.push(absolute(env, file));
  }
  account.paths = paths;

  const own = files.length === 1 ? env.std.formatForPath(files[0]) : 0;
  const offer = own ? [DOBJ_PATHS, own] : [DOBJ_PATHS];
  const made = env.data.create(offer);
  if (typeof made === "number") {
    return { exit: env.std.complainErrno(env, NAME, "dataobj_create", made), program: NAME };
  }
  try {
    /* WRITE WHAT THE KERNEL GRANTED, NOT WHAT WAS ASKED FOR. `dataobj_create` returns the offer it
     * settled on and it may be narrower than the request — M10's own control forces TEXT alone — so
     * a program that wrote from its own list would be refused -ENOTSUP for a format it never held.
     *
     * AND IT NEVER SUBSTITUTES. If the only granted format is one this file has no content for,
     * NOTHING is published and the exit code says so: writing the path as TEXT because TEXT is
     * what was granted is precisely the "silently paste a path" this milestone exists to prevent
     * (constraint 247). */
    const granted = fmtsOf(made.offer);
    account.granted = granted.map(fmtName);
    const written = [];
    if (granted.includes(DOBJ_PATHS)) {
      // NUL-SEPARATED, which is the one encoding of a path list in this system: a path may contain
      // a space and may not contain a NUL (`src/kernel/calls.mjs`'s `readPath`).
      const list = env.std.bytes(paths.join("\0"));
      const set = env.data.set(made.fd, DOBJ_PATHS, list);
      if (set < 0) return { exit: env.std.complainErrno(env, NAME, "paths", set), program: NAME };
      account.bytes += list.length;
      written.push(DOBJ_PATHS);
    }
    if (own && granted.includes(own)) {
      // `env.std.readFileBytes` SINCE M14: this program had its own copy of the open-slurp-close
      // loop, and `imgview -f` needed the same three lines. One definition, in the library.
      const body = env.std.readFileBytes(env, files[0]);
      if (typeof body === "number") {
        return { exit: env.std.complainErrno(env, NAME, files[0], body), program: NAME };
      }
      const wrote = env.data.set(made.fd, own, body);
      if (wrote < 0) {
        return { exit: env.std.complainErrno(env, NAME, fmtName(own), wrote), program: NAME };
      }
      account.bytes += body.length;
      written.push(own);
    }
    if (written.length === 0) {
      env.std.warn(env, `${NAME}: the kernel granted only `
        + `${granted.map(fmtName).join(", ")}, and this file has nothing to put there\n`);
      return { exit: 1, ...account, why: "no granted format fits this file" };
    }
    const r = env.data.toClipboard(made.fd);
    if (r < 0) return { exit: env.std.complainErrno(env, NAME, "clipboard", r), program: NAME };
    account.formats = written.map(fmtName);
    env.std.say(env, `${NAME}: ${paths.length} path(s), ${account.bytes} bytes, as `
      + `${account.formats.join(" + ")}\n`);
    return { exit: 0, ...account };
  } finally {
    // THE FD GOES AND THE OBJECT STAYS. The clipboard holds its own reference, which is the whole
    // of "copy, quit the program, paste" (constraint 241).
    env.fs.close(made.fd);
  }
}

function paste(env, want) {
  const opened = env.data.open(DOBJ_WHERE_CLIPBOARD);
  if (typeof opened === "number") {
    return { exit: env.std.complainErrno(env, NAME, "clipboard", opened), program: NAME };
  }
  const offered = fmtsOf(opened.offer);
  try {
    let format = 0;
    if (want !== undefined) {
      if (!Object.prototype.hasOwnProperty.call(BY_NAME, want)) {
        return { exit: env.std.complain(env, NAME, want, "not a format name", env.std.EXIT_USAGE), program: NAME };
      }
      format = BY_NAME[want];
    } else {
      /* A DEFAULT THAT IS NOT A GUESS: text if there is text, else the path list. An image has no
       * sensible rendering on a terminal, so it is NOT pasted by default — asking for it by name
       * is how a program says it can handle it. */
      format = offered.includes(DOBJ_TEXT) ? DOBJ_TEXT
        : (offered.includes(DOBJ_PATHS) ? DOBJ_PATHS : 0);
      if (!format) {
        env.std.warn(env, `${NAME}: the clipboard holds ${offered.map(fmtName).join(", ")}; `
          + `name one with -f\n`);
        return { exit: 1, program: NAME, verb: "paste", offered: offered.map(fmtName) };
      }
    }
    const got = env.data.get(opened.fd, format);
    if (typeof got === "number") {
      /* THE REFUSAL IS THE POINT, and it says what IS there. An untyped clipboard would have
       * handed back whatever bytes it held and let this program render a path as an image
       * (constraint 247). */
      env.std.warn(env, `${NAME}: no ${fmtName(format)} on the clipboard `
        + `(${env.std.errnoName(got)}); it offers ${offered.map(fmtName).join(", ")}\n`);
      return {
        exit: 1, program: NAME, verb: "paste", refused: env.std.errnoName(got),
        format: fmtName(format), offered: offered.map(fmtName),
      };
    }
    // PATHS ARE NUL-SEPARATED IN THE OBJECT AND NEWLINE-SEPARATED ON A TERMINAL: the encoding is
    // the object's and the rendering is this program's.
    const bytes = format === DOBJ_PATHS
      ? env.std.bytes(`${env.std.text(got).split("\0").join("\n")}\n`)
      : got;
    const wrote = env.write(1, bytes);
    if (wrote < 0) return { exit: env.std.complainErrno(env, NAME, "write", wrote), program: NAME };
    return {
      exit: 0, program: NAME, verb: "paste", format: fmtName(format),
      bytes: got.length, offered: offered.map(fmtName),
    };
  } finally {
    env.fs.close(opened.fd);
  }
}

function list(env) {
  const opened = env.data.open(DOBJ_WHERE_CLIPBOARD);
  if (typeof opened === "number") {
    return { exit: env.std.complainErrno(env, NAME, "clipboard", opened), program: NAME };
  }
  const rows = [];
  try {
    for (const f of fmtsOf(opened.offer)) {
      const got = env.data.get(opened.fd, f);
      rows.push({
        format: fmtName(f),
        bytes: typeof got === "number" ? -1 : got.length,
        why: typeof got === "number" ? env.std.errnoName(got) : "",
      });
    }
    for (const row of rows) {
      env.std.say(env, `${row.format}\t${row.bytes < 0 ? row.why : row.bytes}\n`);
    }
    return { exit: 0, program: NAME, verb: "list", rows };
  } finally {
    env.fs.close(opened.fd);
  }
}

/** A path as the clipboard must carry it: ABSOLUTE. A relative path means nothing to another
 *  process, whose cwd is its own — which is why `DOBJ_PATHS` is defined as absolute paths. */
function absolute(env, path) {
  if (path.startsWith("/")) return path;
  const cwd = env.std.readFileText(env, `/proc/${env.pid}/cwd`);
  const base = typeof cwd === "number" ? "/" : cwd.trim() || "/";
  return base === "/" ? `/${path}` : `${base}/${path}`;
}
