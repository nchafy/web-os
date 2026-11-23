// `cp`: copy files, and with `-r` directories.
//
// The contract this program is written against is in src/bin/true.mjs.

import {
  MAX_INLINE, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, O_DIRECTORY,
  S_IFMT, S_IFDIR, EEXIST, EPERM, DT_DIR,
} from "/src/abi.mjs";

const NAME = "cp";

/** The loop guard `rm -r` has, for the same reason: a cycle must end as a report, not a crash. */
const MAX_DEPTH = 64;

const DEFAULT_MODE = 0o644;

/** Whether `path` is a directory. A missing path is not, which is what lets the caller tell
 *  "copy into this directory" from "copy to this new name". */
function isDir(env, path) {
  const st = env.fs.stat(path);
  if (typeof st === "number") return false;
  return (st.mode & S_IFMT) === S_IFDIR;
}

function join(dir, name) {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function baseName(path) {
  const parts = path.split("/").filter((p) => p.length > 0);
  return parts.length ? parts[parts.length - 1] : path;
}

/** Copy one file's bytes. The mode is the SOURCE's, because a copy of an executable that was not
 *  executable is a copy a reader cannot run. */
function copyFile(env, from, to, account) {
  const st = env.fs.stat(from);
  const mode = typeof st === "number" ? DEFAULT_MODE : (st.mode & 0o7777);
  const src = env.fs.open(from, O_RDONLY);
  if (src < 0) return src;
  const dst = env.fs.open(to, O_WRONLY | O_CREAT | O_TRUNC, mode);
  if (dst < 0) { env.fs.close(src); return dst; }
  const buf = new Uint8Array(MAX_INLINE);
  let moved = 0;
  try {
    for (;;) {
      const n = env.fs.read(src, buf, 0, buf.length);
      if (n === 0) break;
      if (n < 0) return n;
      let off = 0;
      while (off < n) {
        // A SHORT WRITE IS NOT AN ERROR and must be finished: `write` may take less than it was
        // given, and a loop that assumed otherwise would truncate the copy silently.
        const w = env.fs.write(dst, buf.subarray(off, n));
        if (w < 0) return w;
        if (w === 0) return -EPERM;
        off += w;
      }
      moved += n;
    }
  } finally {
    env.fs.close(src);
    env.fs.close(dst);
  }
  account.files += 1;
  account.bytes += moved;
  return 0;
}

function copyTree(env, from, to, depth, account) {
  if (depth > MAX_DEPTH) return -EPERM;
  const st = env.fs.lstat(from);
  if (typeof st === "number") return st;
  if ((st.mode & S_IFMT) !== S_IFDIR) return copyFile(env, from, to, account);
  const made = env.fs.mkdir(to, st.mode & 0o7777);
  if (made < 0 && made !== -EEXIST) return made;
  if (made === 0) account.dirs += 1;
  const rows = env.std.listDir(env, from);
  if (typeof rows === "number") return rows;
  for (const row of rows) {
    if (row.name === "." || row.name === "..") continue;
    const r = row.type === DT_DIR || row.type === undefined
      ? copyTree(env, join(from, row.name), join(to, row.name), depth + 1, account)
      : copyFile(env, join(from, row.name), join(to, row.name), account);
    if (r < 0) return r;
  }
  return 0;
}

export function run(env) {
  const std = env.std;
  const { flags, operands, bad } = std.getopt((env.argv || []).slice(1), "rR");
  if (bad) {
    return { exit: std.complain(env, NAME, null, `unknown option ${bad}`, std.EXIT_USAGE) };
  }
  const recursive = Boolean(flags.r || flags.R);
  if (operands.length < 2) {
    return {
      exit: std.complain(env, NAME, null, "needs a source and a destination", std.EXIT_USAGE),
    };
  }
  const dest = operands[operands.length - 1];
  const sources = operands.slice(0, -1);
  const intoDir = isDir(env, dest);
  if (sources.length > 1 && !intoDir) {
    return {
      exit: std.complain(env, NAME, dest, "is not a directory, so it cannot take several sources",
                         std.EXIT_USAGE),
    };
  }

  const account = { files: 0, dirs: 0, bytes: 0 };
  let status = 0;
  for (const from of sources) {
    const to = intoDir ? join(dest, baseName(from)) : dest;
    if (isDir(env, from) && !recursive) {
      status = std.complain(env, NAME, from, "is a directory; use -r");
      continue;
    }
    const r = recursive
      ? copyTree(env, from, to, 0, account)
      : copyFile(env, from, to, account);
    if (r < 0) status = std.complainErrno(env, NAME, `${from} -> ${to}`, r);
  }
  return { exit: status, ...account };
}
