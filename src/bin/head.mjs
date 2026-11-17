// `head`: the first N lines of each operand, or of standard input.
//
// The contract this program is written against is in src/bin/true.mjs.

import { MAX_INLINE, O_RDONLY } from "/src/abi.mjs";

const NAME = "head";

/** POSIX's default. */
const DEFAULT_LINES = 10;

/**
 * Copy the first `want` lines of `fd` to standard output, then stop reading.
 *
 * Stopping is the point, not an optimization: `yes | head -1` terminates because `head` closes its
 * end of the pipe and the writer dies of SIGPIPE (docs/ABI.md decision 5). A `head` that slurped
 * would hang that pipeline forever.
 */
function headFd(env, fd, want) {
  const buf = new Uint8Array(MAX_INLINE);
  let seen = 0;
  if (want === 0) return 0;
  for (;;) {
    const n = env.fs.read(fd, buf, 0, buf.length);
    if (n < 0) return n;
    if (n === 0) return 0;
    let upto = n;
    for (let i = 0; i < n; i += 1) {
      if (buf[i] !== 0x0a) continue;
      seen += 1;
      if (seen >= want) { upto = i + 1; break; }
    }
    const w = env.write(1, buf.subarray(0, upto));
    if (w < 0) return w;
    if (seen >= want) return 0;
  }
}

export function run(env) {
  const std = env.std;
  const args = (env.argv || []).slice(1);
  /* `head -1` is a line count. It is consumed before `getopt`, because `-1` is not an option
   * letter and a general parser can only read it as one. */
  let obsolescent = null;
  if (args.length && /^-\d+$/.test(args[0])) {
    obsolescent = args[0].slice(1);
    args.shift();
  }
  const { flags, operands, bad, why } = std.getopt(args, "n:");
  if (bad) {
    const message = why === "missing-argument"
      ? `option ${bad} needs a line count`
      : `unknown option ${bad}`;
    return { exit: std.complain(env, NAME, null, message, std.EXIT_USAGE) };
  }
  // `-n` wins over `-5` when both are written, as GNU head does.
  if (obsolescent !== null && flags.n === undefined) flags.n = obsolescent;
  let want = DEFAULT_LINES;
  if (flags.n !== undefined) {
    const n = std.wholeNumber(flags.n);
    if (n === null) {
      return {
        exit: std.complain(env, NAME, null, `bad line count: ${flags.n}`, std.EXIT_USAGE),
      };
    }
    want = n;
  }

  if (operands.length === 0) {
    const r = headFd(env, 0, want);
    if (r < 0) return { exit: std.complainErrno(env, NAME, null, r), errno: -r };
    return { exit: 0, lines: want };
  }

  let status = 0;
  for (let i = 0; i < operands.length; i += 1) {
    const path = operands[i];
    const fd = path === "-" ? 0 : env.fs.open(path, O_RDONLY);
    if (fd < 0) {
      status = std.complainErrno(env, NAME, path, fd);
      continue;
    }
    // One file's output must be pipeable without a banner in front of it.
    if (operands.length > 1) std.say(env, `${i > 0 ? "\n" : ""}==> ${path} <==\n`);
    const r = headFd(env, fd, want);
    if (fd !== 0) env.fs.close(fd);
    if (r < 0) status = std.complainErrno(env, NAME, path, r);
  }
  return { exit: status };
}
