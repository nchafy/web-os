// `head`: the first N lines of each operand, or of standard input.
//
// The contract this program is written against is in src/bin/true.mjs.

import { O_RDONLY } from "/src/abi.mjs";

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
  const buf = new Uint8Array(65536);
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
  const { flags, operands, bad } = std.getopt((env.argv || []).slice(1), "n:");
  if (bad) {
    // `head -5` IS REFUSED rather than guessed at. It is a real idiom this program does not
    // support, and treating `5` as a filename would print "5: no such file" for a line that reads
    // perfectly well — a message about the wrong thing entirely.
    return {
      exit: std.complain(env, NAME, null,
        `unknown option ${bad} (use -n ${bad.slice(1)})`, std.EXIT_USAGE),
    };
  }
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
