// `rmdir`: remove empty directories.
//
// The contract this program is written against is in src/bin/true.mjs.

import { ENOTEMPTY } from "/src/abi.mjs";

const NAME = "rmdir";

export function run(env) {
  const std = env.std;
  const { operands, bad } = std.getopt((env.argv || []).slice(1), "");
  if (bad) {
    return { exit: std.complain(env, NAME, null, `unknown option ${bad}`, std.EXIT_USAGE) };
  }
  if (operands.length === 0) {
    return { exit: std.complain(env, NAME, null, "needs a directory name", std.EXIT_USAGE) };
  }
  let status = 0;
  let removed = 0;
  for (const path of operands) {
    const r = env.fs.rmdir(path);
    if (r === 0) { removed += 1; continue; }
    // ENOTEMPTY is the one a reader will hit, and the hint is what `rm -r` is for. Reported as
    // itself rather than folded into a generic errno line, because "it refused" and "it refused
    // because there is something in it" lead to different next actions.
    status = r === -ENOTEMPTY
      ? std.complain(env, NAME, path, "not empty; use rm -r to remove what is in it")
      : std.complainErrno(env, NAME, path, r);
  }
  return { exit: status, removed };
}
