// `mkdir`: make directories.
//
// The contract this program is written against is in src/bin/true.mjs.

import { EEXIST, ENOENT } from "/src/abi.mjs";

const NAME = "mkdir";

/** POSIX's default for a new directory, before any umask this system does not have. */
const DEFAULT_MODE = 0o755;

/** Split a path into the ancestors `-p` has to make, outermost first. A relative path is resolved
 *  by the kernel against the process's cwd, so the walk is over COMPONENTS and never over a
 *  reconstructed absolute path — a program that prefixed `/` would make the wrong directories for
 *  `mkdir -p a/b` run anywhere but the root. */
function ancestors(path) {
  const absolute = path.startsWith("/");
  const parts = path.split("/").filter((p) => p.length > 0);
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i + 1).join("/");
    out.push(absolute ? `/${prefix}` : prefix);
  }
  return out;
}

export function run(env) {
  const std = env.std;
  const { flags, operands, bad, why } = std.getopt((env.argv || []).slice(1), "pm:");
  if (bad) {
    const message = why === "missing-argument"
      ? `option ${bad} needs a mode`
      : `unknown option ${bad}`;
    return { exit: std.complain(env, NAME, null, message, std.EXIT_USAGE) };
  }
  if (operands.length === 0) {
    return { exit: std.complain(env, NAME, null, "needs a directory name", std.EXIT_USAGE) };
  }
  let mode = DEFAULT_MODE;
  if (flags.m !== undefined) {
    // OCTAL, because that is what a mode is written in. A decimal 755 is 0o1363 and would be
    // accepted silently by `Number`.
    if (!/^[0-7]{1,4}$/.test(flags.m)) {
      return {
        exit: std.complain(env, NAME, null, `bad mode: ${flags.m}`, std.EXIT_USAGE),
      };
    }
    mode = parseInt(flags.m, 8);
  }

  let status = 0;
  const made = [];
  for (const path of operands) {
    if (flags.p) {
      /* `-p` MAKES THE ANCESTORS AND IS NOT AN ERROR IF THEY EXIST, which is the whole of what it
       * means. EEXIST on an ancestor is skipped; any other errno stops this operand, because a
       * directory nobody could make is not a path to carry on building under. */
      let failed = false;
      for (const step of ancestors(path)) {
        const r = env.fs.mkdir(step, mode);
        if (r === -EEXIST) continue;
        if (r < 0) {
          status = std.complainErrno(env, NAME, step, r);
          failed = true;
          break;
        }
        made.push(step);
      }
      if (failed) continue;
      continue;
    }
    const r = env.fs.mkdir(path, mode);
    if (r < 0) {
      // ENOENT here means a missing PARENT, and that is the one errno worth a hint: it is what
      // `-p` exists for and the message otherwise reads as if the directory itself were missing.
      status = r === -ENOENT
        ? std.complain(env, NAME, path, "no such parent directory; use -p")
        : std.complainErrno(env, NAME, path, r);
      continue;
    }
    made.push(path);
  }
  return { exit: status, made };
}
