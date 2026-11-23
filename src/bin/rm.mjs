// `rm`: remove files, and with `-r` directories and what is under them.
//
// The contract this program is written against is in src/bin/true.mjs.

import { ENOENT, EISDIR, EPERM, S_IFMT, S_IFDIR, DT_DIR } from "/src/abi.mjs";

const NAME = "rm";

/**
 * HOW DEEP A RECURSIVE REMOVE MAY GO.
 *
 * Not a performance limit — a loop guard. A filesystem with a symlink cycle, or a `readdir` that
 * answered with `.` for any reason, would otherwise recurse until the stack went. Depth is cheap
 * to count and a real tree here is a handful deep, so exceeding this is a defect report rather
 * than a thing to tune.
 */
const MAX_DEPTH = 64;

/** Remove `path` and everything under it, depth first: a directory cannot go while it has
 *  children. Returns 0, or the first negative errno — the walk stops there, because carrying on
 *  under a directory that refused to open is walking a tree nobody can see. */
function removeTree(env, path, depth, account) {
  if (depth > MAX_DEPTH) {
    account.tooDeep.push(path);
    return -EPERM;
  }
  const st = env.fs.lstat(path);
  if (typeof st === "number") return st;
  const isDir = (st.mode & S_IFMT) === S_IFDIR;
  if (!isDir) {
    const r = env.fs.unlink(path);
    if (r === 0) account.files += 1;
    return r;
  }
  const rows = env.std.listDir(env, path);
  if (typeof rows === "number") return rows;
  for (const row of rows) {
    if (row.name === "." || row.name === "..") continue;
    const child = path.endsWith("/") ? `${path}${row.name}` : `${path}/${row.name}`;
    // THE TYPE COMES FROM THE DIRENT where it is known, and from `lstat` where it is not: a
    // synthetic filesystem may answer DT_UNKNOWN, and treating that as a file would try to
    // `unlink` a directory and report the wrong reason.
    const r = row.type === DT_DIR || row.type === undefined
      ? removeTree(env, child, depth + 1, account)
      : (() => { const u = env.fs.unlink(child); if (u === 0) account.files += 1; return u; })();
    if (r < 0) return r;
  }
  const r = env.fs.rmdir(path);
  if (r === 0) account.dirs += 1;
  return r;
}

export function run(env) {
  const std = env.std;
  const { flags, operands, bad } = std.getopt((env.argv || []).slice(1), "rRf");
  if (bad) {
    return { exit: std.complain(env, NAME, null, `unknown option ${bad}`, std.EXIT_USAGE) };
  }
  const recursive = Boolean(flags.r || flags.R);
  const force = Boolean(flags.f);
  if (operands.length === 0) {
    // `rm -f` with no operand is success and says nothing, which is POSIX's own rule.
    if (force) return { exit: 0 };
    return { exit: std.complain(env, NAME, null, "needs a file name", std.EXIT_USAGE) };
  }

  const account = { files: 0, dirs: 0, tooDeep: [] };
  let status = 0;
  for (const path of operands) {
    const r = recursive
      ? removeTree(env, path, 0, account)
      : (() => {
        const u = env.fs.unlink(path);
        if (u === 0) account.files += 1;
        return u;
      })();
    if (r === 0) continue;
    // `-f` SWALLOWS A MISSING FILE AND NOTHING ELSE. A permission error or a non-empty directory
    // is still reported, because "force" is about absence, not about silence.
    if (force && r === -ENOENT) continue;
    status = r === -EISDIR
      ? std.complain(env, NAME, path, "is a directory; use -r")
      : std.complainErrno(env, NAME, path, r);
  }
  return { exit: status, ...account };
}
