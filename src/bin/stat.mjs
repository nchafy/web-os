// `stat`: what the filesystem knows about a path.
//
// `-L` follows a symlink, which is the DEFAULT here being made explicit; the default is `lstat`,
// so `stat` on a link describes the LINK. That is the opposite of GNU stat and is deliberate: this
// is the program a reader reaches for to find out whether something is a link at all, and a tool
// that silently told them about the target instead could not answer that question.
//
// The contract this program is written against is in src/bin/true.mjs.

import { S_IFMT, S_IFDIR, S_IFREG, S_IFLNK } from "/src/abi.mjs";

const NAME = "stat";

/** The one-letter type, as `ls -l` writes it. A type this ABI has no constant for prints `?`
 *  rather than being guessed at. */
function typeLetter(mode) {
  const kind = mode & S_IFMT;
  if (kind === S_IFDIR) return "d";
  if (kind === S_IFREG) return "-";
  if (kind === S_IFLNK) return "l";
  return "?";
}

function typeName(mode) {
  const kind = mode & S_IFMT;
  if (kind === S_IFDIR) return "directory";
  if (kind === S_IFREG) return "regular file";
  if (kind === S_IFLNK) return "symbolic link";
  return "unknown";
}

/** `rwxr-xr-x` from the low nine bits. */
function permissions(mode) {
  const bits = ["r", "w", "x"];
  let out = "";
  for (let shift = 6; shift >= 0; shift -= 3) {
    for (let b = 0; b < 3; b += 1) {
      out += (mode >> (shift + (2 - b))) & 1 ? bits[b] : "-";
    }
  }
  return out;
}

export function run(env) {
  const std = env.std;
  const { flags, operands, bad } = std.getopt((env.argv || []).slice(1), "L");
  if (bad) {
    return { exit: std.complain(env, NAME, null, `unknown option ${bad}`, std.EXIT_USAGE) };
  }
  if (operands.length === 0) {
    return { exit: std.complain(env, NAME, null, "needs a path", std.EXIT_USAGE) };
  }
  let status = 0;
  const rows = [];
  for (const path of operands) {
    const st = flags.L ? env.fs.stat(path) : env.fs.lstat(path);
    if (typeof st === "number") {
      status = std.complainErrno(env, NAME, path, st);
      continue;
    }
    const mode = st.mode | 0;
    const row = {
      path,
      type: typeName(mode),
      size: Number(st.size),
      mode: (mode & 0o7777).toString(8).padStart(4, "0"),
      ino: String(st.ino),
      nlink: Number(st.nlink),
      uid: Number(st.uid),
      gid: Number(st.gid),
    };
    rows.push(row);
    std.say(env, `  File: ${path}\n`);
    std.say(env, `  Size: ${row.size}\tType: ${row.type}\n`);
    std.say(env, `  Mode: (${row.mode}/${typeLetter(mode)}${permissions(mode)})`
      + `  Uid: ${row.uid}  Gid: ${row.gid}\n`);
    std.say(env, ` Inode: ${row.ino}\tLinks: ${row.nlink}\n`);
  }
  return { exit: status, rows };
}
