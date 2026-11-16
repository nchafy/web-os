// `grep`: print the lines of each operand that match a pattern.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// THE PATTERN IS A FIXED STRING BY DEFAULT, not a basic regular expression, and that is a stated
// floor rather than an unfinished feature. A BRE engine is a different afternoon — POSIX BRE is
// not JavaScript's syntax, so `grep 'a\+b'` would silently mean something else — and quietly
// accepting JS regexes under a name that promises BRE is worse than refusing to pretend.
// `-E` opts into a JavaScript regular expression and says so where a reader meets it. Recorded as
// docs/CONSTRAINTS.md 114.

import { O_RDONLY } from "/src/abi.mjs";

const NAME = "grep";

/** A matcher over one line. ONE closure built once per run, so the flag test is not inside the
 *  per-line loop of a 10,000-line file. */
function makeMatch(pattern, flags) {
  if (flags.E) {
    let re;
    try {
      re = new RegExp(pattern, flags.i ? "i" : "");
    } catch (error) {
      return { error: String((error && error.message) || error) };
    }
    return { test: (line) => re.test(line) };
  }
  if (flags.i) {
    const needle = pattern.toLowerCase();
    return { test: (line) => line.toLowerCase().includes(needle) };
  }
  return { test: (line) => line.includes(pattern) };
}

export function run(env) {
  const std = env.std;
  const { flags, operands, bad } = std.getopt((env.argv || []).slice(1), "nvicEl");
  if (bad) {
    return { exit: std.complain(env, NAME, null, `unknown option ${bad}`, std.EXIT_USAGE) };
  }
  if (operands.length === 0) {
    return { exit: std.complain(env, NAME, null, "usage: grep [-nvicEl] pattern [file...]",
      std.EXIT_USAGE) };
  }
  const pattern = operands[0];
  const paths = operands.slice(1);
  const matcher = makeMatch(pattern, flags);
  if (matcher.error) {
    return { exit: std.complain(env, NAME, pattern, matcher.error, std.EXIT_USAGE) };
  }

  const prefix = paths.length > 1;
  let matched = 0;
  let status = 0;

  /**
   * One stream, LINE AT A TIME.
   *
   * Streamed and not slurped, because a filter that waits for EOF before printing makes
   * `yes | grep y | head -1` hang — the middle stage would be waiting for an end its writer never
   * sends. `src/libos/std.mjs` `eachLine` carries the buffering.
   */
  const scan = (fd, label) => {
    let hits = 0;
    let wrote = 0;
    const r = std.eachLine(env, fd, (line, number) => {
      // `-v` INVERTS THE SELECTION, which is why the test is compared against the flag rather than
      // branched on: two branches over the same loop is where one of them stops getting the `-n`
      // prefix.
      if (matcher.test(line) === !!flags.v) return true;
      hits += 1;
      // `-l` NEEDS NO MORE THAN THE FIRST HIT, and stopping is what lets the writer upstream see
      // EPIPE instead of filling a pipe nobody will drain.
      if (flags.l) return false;
      if (flags.c) return true;
      const head = (prefix ? `${label}:` : "") + (flags.n ? `${number}:` : "");
      wrote = std.say(env, `${head}${line}\n`);
      return wrote >= 0;
    });
    if (r < 0) return r;
    if (wrote < 0) return wrote;
    if (flags.l) {
      if (hits) {
        const w = std.say(env, `${label}\n`);
        if (w < 0) return w;
      }
    } else if (flags.c) {
      const w = std.say(env, `${prefix ? `${label}:` : ""}${hits}\n`);
      if (w < 0) return w;
    }
    matched += hits;
    return 0;
  };

  if (paths.length === 0) {
    const r = scan(0, "(standard input)");
    if (r < 0) return { exit: std.complainErrno(env, NAME, null, r), errno: -r };
  } else {
    for (const path of paths) {
      const fd = path === "-" ? 0 : env.fs.open(path, O_RDONLY);
      if (fd < 0) {
        // Exit 2, NOT 1. grep's statuses are three and they are load-bearing in scripts: 0 found,
        // 1 not found, 2 something went wrong. Reporting a missing file as 1 would make
        // `grep x missing` indistinguishable from a file that simply had no match.
        status = std.complainErrno(env, NAME, path, fd, 2);
        continue;
      }
      const r = scan(fd, path);
      if (fd !== 0) env.fs.close(fd);
      if (r < 0) status = std.complainErrno(env, NAME, path, r, 2);
    }
  }
  if (status) return { exit: status, matched };
  return { exit: matched > 0 ? 0 : 1, matched };
}
