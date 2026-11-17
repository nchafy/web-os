// `cat`: concatenate files, or standard input when there are none.
//
// The contract this program is written against is in src/bin/true.mjs.

import { MAX_INLINE, O_RDONLY } from "/src/abi.mjs";

const NAME = "cat";

/**
 * Copy one fd to standard output, in MAX_INLINE-sized pieces.
 *
 * Streamed, not slurped: `cat` with no operands is a filter whose writer may never finish, so a
 * slurp would hold every byte until an EOF that never comes. That is `yes | cat` printing rather
 * than hanging.
 */
function copy(env, fd) {
  const buf = new Uint8Array(MAX_INLINE);
  for (;;) {
    const n = env.fs.read(fd, buf, 0, buf.length);
    if (n < 0) return n;
    if (n === 0) return 0;
    const w = env.write(1, buf.subarray(0, n));
    if (w < 0) return w;
  }
}

export function run(env) {
  const std = env.std;
  const operands = (env.argv || []).slice(1);
  let status = 0;

  if (operands.length === 0) {
    const r = copy(env, 0);
    if (r < 0) return { exit: std.complainErrno(env, NAME, "-", r), errno: -r };
    return { exit: 0 };
  }

  for (const path of operands) {
    if (path === "-") {
      const r = copy(env, 0);
      if (r < 0) status = std.complainErrno(env, NAME, "-", r);
      continue;
    }
    const fd = env.fs.open(path, O_RDONLY);
    if (fd < 0) {
      // `cat missing present` prints `present` and exits 1: stopping at the first failure would
      // lose output the caller asked for.
      status = std.complainErrno(env, NAME, path, fd);
      continue;
    }
    const r = copy(env, fd);
    env.fs.close(fd);
    if (r < 0) status = std.complainErrno(env, NAME, path, r);
  }
  return { exit: status };
}
