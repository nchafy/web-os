// `grep`: print the lines of each operand that match a pattern.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// The pattern is a fixed string by default, and `-E` opts into a JavaScript regular expression:
// POSIX BRE is not JavaScript's syntax, so `grep 'a\+b'` under a BRE promise would silently mean
// something else. docs/CONSTRAINTS.md 138.

import { O_RDONLY } from "/src/abi.mjs";

const NAME = "grep";

/** A matcher over one line, built once per run so the flag test stays out of the per-line loop. */
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
   * One stream, a line at a time. Streamed and not slurped: a filter that waits for EOF before
   * printing makes `yes | grep y | head -1` hang. `src/libos/std.mjs` `eachLine` buffers.
   */
  const scan = (fd, label) => {
    let hits = 0;
    let wrote = 0;
    const r = std.eachLine(env, fd, (line, number) => {
      // `-v` is compared against, not branched on: two loops is where one stops printing `-n`.
      if (matcher.test(line) === !!flags.v) return true;
      hits += 1;
      // Stopping at the first hit under `-l` is what lets the upstream writer see EPIPE instead of
      // filling a pipe nobody will drain.
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
        // grep's three statuses are load-bearing in scripts: 0 found, 1 not found, 2 went wrong.
        // A missing file reported as 1 is indistinguishable from a file with no match.
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
