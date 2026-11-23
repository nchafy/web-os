// `touch`: create a file if it is not there.
//
// WHAT THIS DOES NOT DO, stated rather than discovered: it does not update a timestamp on a file
// that already exists. There is no `utimes` in this ABI (`src/abi.mjs`'s path group has `mkdir`
// through `statfs` and no time-setting call), so the half of `touch` that sets mtime cannot be
// written yet — and a program that silently did nothing for the common case would be worse than
// one that says so. `-c` is accepted because "do not create" is the one behaviour that IS
// expressible.
//
// The contract this program is written against is in src/bin/true.mjs.

import { O_WRONLY, O_CREAT, EEXIST } from "/src/abi.mjs";

const NAME = "touch";

const DEFAULT_MODE = 0o644;

export function run(env) {
  const std = env.std;
  const { flags, operands, bad } = std.getopt((env.argv || []).slice(1), "c");
  if (bad) {
    return { exit: std.complain(env, NAME, null, `unknown option ${bad}`, std.EXIT_USAGE) };
  }
  if (operands.length === 0) {
    return { exit: std.complain(env, NAME, null, "needs a file name", std.EXIT_USAGE) };
  }
  let status = 0;
  const created = [];
  for (const path of operands) {
    const st = env.fs.stat(path);
    if (typeof st !== "number") continue;      // it exists; there is no mtime to set
    if (flags.c) continue;                      // -c: do not create
    const fd = env.fs.open(path, O_WRONLY | O_CREAT, DEFAULT_MODE);
    if (fd < 0) {
      if (fd === -EEXIST) continue;
      status = std.complainErrno(env, NAME, path, fd);
      continue;
    }
    env.fs.close(fd);
    created.push(path);
  }
  return { exit: status, created };
}
