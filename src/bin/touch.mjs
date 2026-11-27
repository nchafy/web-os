// `touch`: set a file's access and modification times to now, and create it if it is not there.
//
// `-c` does not create, and the absence of a file is then not an error — the one behaviour that
// does not need a clock.
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
  const stamped = [];
  for (const path of operands) {
    const st = env.fs.stat(path);
    if (typeof st === "number") {
      if (flags.c) continue;
      const fd = env.fs.open(path, O_WRONLY | O_CREAT, DEFAULT_MODE);
      if (fd < 0 && fd !== -EEXIST) {
        status = std.complainErrno(env, NAME, path, fd);
        continue;
      }
      if (fd >= 0) {
        env.fs.close(fd);
        created.push(path);
        /* A CREATE ALREADY CARRIES THE TIME. `OP.CREATE` stamps the inode from the filesystem's
         * own clock (`src/fs/vfs.mjs`), so a `utimes` here would journal a second record for a
         * time the file already holds. */
        continue;
      }
      // -EEXIST: it arrived between the stat and the open, so this is the existing-file case.
    }
    /* `utimesNow` AND NOT `utimes(path, Date.now() * 1e6, ...)`: the ms -> ns factor has one
     * definition on this side of the ABI (src/libos/syscall.mjs), and the value must be a BigInt
     * because 2^53 ns is 104 days after the epoch. */
    const r = env.fs.utimesNow(path);
    if (r < 0) {
      status = std.complainErrno(env, NAME, path, r);
      continue;
    }
    stamped.push(path);
  }
  return { exit: status, created, stamped };
}
