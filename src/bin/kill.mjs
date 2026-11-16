// `kill`: send a signal.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// `%1` IS NOT HANDLED HERE. A job spec names a job in the SHELL's table and no program can see it,
// so `src/bin/sh.mjs` expands `%1` to a pid before this ever runs — which is how it works in
// every shell, and why `kill %1` from a script with no job control is an error there too.

import { SIGNALS, SIGTERM, signalOf } from "/src/abi.mjs";

const NAME = "kill";

export function run(env) {
  const std = env.std;
  const args = (env.argv || []).slice(1);
  let sig = SIGTERM;
  let i = 0;

  // `-s TERM`, `-TERM`, `-9`. THE PARSE IS HAND-ROLLED rather than `getopt`'d, because `-9` is not
  // an option letter and a general parser would read it as the unknown flag `-9`.
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
    // `kill -l`, which is how a caller finds out what this system has. Printed as names, because
    // the numbers are POSIX's and the names are what a reader types.
    const names = Object.entries(SIGNALS)
      .sort((a, b) => a[1] - b[1])
      .map(([n, v]) => `${v} ${n}`);
    std.say(env, `${names.join("\n")}\n`);
    return { exit: 0 };
  } else if (typeof args[i] === "string" && args[i].length > 1 && args[i][0] === "-") {
    const named = signalOf(args[i].slice(1));
    if (named === null) {
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
    // A NEGATIVE PID IS A PROCESS GROUP, which is the whole of how a shell interrupts a pipeline:
    // `kill -INT -42` reaches every stage. `-\d+` is therefore a target and not an option, and it
    // can only be one because the signal, if any, was consumed above.
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
