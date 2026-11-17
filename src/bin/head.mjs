// `head`: the first N lines of each operand, or of standard input.
//
// The contract this program is written against is in src/bin/true.mjs.

import { MAX_INLINE, O_RDONLY } from "/src/abi.mjs";

const NAME = "head";

/** POSIX's default. */
const DEFAULT_LINES = 10;

/**
 * Copy the first `want` lines of `fd` to standard output, then STOP READING.
 *
 * STOPPING IS THE POINT, not an optimization. `yes | head -1` terminates because `head` closes
 * its end of the pipe and the writer dies of SIGPIPE — M4's headline proof. A `head` that slurped
 * its input first would make that pipeline hang forever, and the whole dead-peer asymmetry in
 * docs/ABI.md decision 5 would be untestable through the shell.
 *
 * A partial last line is still emitted: `printf 'a'` through `head -1` prints `a` with no newline
 * added, because head copies bytes and does not reformat them.
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
  /* `head -1` IS A LINE COUNT, not an unknown option.
   *
   * It was refused on the grounds that this program does not support the obsolescent form — and
   * MILESTONES.md M5's own headline proof is written `yes | head -1`, so the first thing anybody
   * typed hit the refusal. It is also what every `head` in existence accepts. Consumed here,
   * before `getopt`, because `-1` is not an option letter and a general parser can only read it
   * as one.
   */
  let obsolescent = null;
  if (args.length && /^-\d+$/.test(args[0])) {
    obsolescent = args[0].slice(1);
    args.shift();
  }
  const { flags, operands, bad, why } = std.getopt(args, "n:");
  if (bad) {
    // `head -n` with nothing after it is a MISSING OPERAND, and saying "use -n n" to that reader
    // told them to type what they had just typed.
    const message = why === "missing-argument"
      ? `option ${bad} needs a line count`
      : `unknown option ${bad}`;
    return { exit: std.complain(env, NAME, null, message, std.EXIT_USAGE) };
  }
  // `-n` WINS OVER `-5` when both are written, which is what GNU head does: the last count given
  // is the one that applies and `-n` is the current spelling.
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
    // THE HEADER ONLY FOR TWO OR MORE OPERANDS, which is what head does: one file's output must be
    // pipeable without a banner in front of it.
    if (operands.length > 1) std.say(env, `${i > 0 ? "\n" : ""}==> ${path} <==\n`);
    const r = headFd(env, fd, want);
    if (fd !== 0) env.fs.close(fd);
    if (r < 0) status = std.complainErrno(env, NAME, path, r);
  }
  return { exit: status };
}
