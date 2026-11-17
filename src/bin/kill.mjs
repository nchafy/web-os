// `kill`: send a signal.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// `%1` is not handled here. A job spec names a job in the shell's table, which no program can see,
// so `src/bin/sh.mjs` expands it to a pid before this runs.

import { SIGNALS, SIGTERM, signalOf } from "/src/abi.mjs";

const NAME = "kill";

export function run(env) {
  const std = env.std;
  const args = (env.argv || []).slice(1);
  let sig = SIGTERM;
  let i = 0;

  // `-s TERM`, `-TERM`, `-9`. Hand-rolled rather than `getopt`'d, because `-9` is not an option
  // letter and a general parser would read it as the unknown flag `-9`.
  if (args[i] === "-s") {
    i += 1;
    const named = signalOf(args[i] || "");
    if (named === null) {
      return {
        exit: std.complain(env, NAME, args[i] || "", "not a signal", std.EXIT_USAGE),
      };
    }
    sig = named;
    i += 1;
  } else if (args[i] === "-l") {
    const names = Object.entries(SIGNALS)
      .sort((a, b) => a[1] - b[1])
      .map(([n, v]) => `${v} ${n}`);
    std.say(env, `${names.join("\n")}\n`);
    return { exit: 0 };
  } else if (args[i] === "--") {
    i += 1;
  } else if (typeof args[i] === "string" && args[i].length > 1 && args[i][0] === "-") {
    const named = signalOf(args[i].slice(1));
    if (named === null) {
      /* A leading `-<digits>` that is not a signal is an error, not a target: `kill -9` with no
       * pids must not mean "SIGTERM to group 9", or a plausible typo signals a process group
       * silently. A group is written `kill -TERM -3` or `kill -- -3`, and `src/bin/sh.mjs` writes
       * the second for every job spec so the ambiguity never arises. */
      return {
        exit: std.complain(env, NAME, args[i].slice(1), "not a signal", std.EXIT_USAGE),
      };
    }
    sig = named;
    i += 1;
  }

  const targets = args.slice(i);
  if (targets.length === 0) {
    return {
      exit: std.complain(env, NAME, null, "usage: kill [-s SIG | -SIG] pid...", std.EXIT_USAGE),
    };
  }

  let status = 0;
  const sent = [];
  for (const target of targets) {
    // A negative pid is a process group — how a shell interrupts a whole pipeline. `-\d+` can be a
    // target here only because the signal, if any, was consumed above.
    if (!/^-?\d+$/.test(target)) {
      status = std.complain(env, NAME, target, "not a pid", std.EXIT_USAGE);
      continue;
    }
    const pid = Number(target);
    const r = env.proc.kill(pid, sig);
    if (r < 0) {
      status = std.complainErrno(env, NAME, target, r);
      continue;
    }
    sent.push(pid);
  }
  return { exit: status, signal: sig, sent };
}
