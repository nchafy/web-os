// `uniq`: collapse ADJACENT identical lines.
//
// ADJACENT, which is the thing about `uniq` that surprises people: it is not "the distinct lines",
// it is "runs of one line become one". That is why `sort | uniq` is the idiom and `uniq` alone on
// unsorted input is usually a mistake — and it is also what makes this program streamable, where
// a distinct-lines filter would have to hold every line it had seen.
//
// The contract this program is written against is in src/bin/true.mjs.

import { O_RDONLY } from "/src/abi.mjs";

const NAME = "uniq";

export function run(env) {
  const std = env.std;
  const { flags, operands, bad } = std.getopt((env.argv || []).slice(1), "cdu");
  if (bad) {
    return { exit: std.complain(env, NAME, null, `unknown option ${bad}`, std.EXIT_USAGE) };
  }
  if (operands.length > 1) {
    return {
      exit: std.complain(env, NAME, null, "takes at most one file", std.EXIT_USAGE),
    };
  }
  const path = operands[0];
  const got = !path || path === "-"
    ? std.slurpText(env, 0)
    : std.readFileText(env, path);
  if (typeof got === "number") {
    return { exit: std.complainErrno(env, NAME, path || null, got), errno: -got };
  }
  const lines = got.length === 0 ? [] : got.replace(/\n$/, "").split("\n");

  let out = "";
  let kept = 0;
  let i = 0;
  while (i < lines.length) {
    let run = 1;
    while (i + run < lines.length && lines[i + run] === lines[i]) run += 1;
    // `-d` only repeated runs, `-u` only runs of one, neither means every run once. They are not
    // exclusive in GNU uniq either: both together prints nothing, which falls out of this.
    const wanted = (!flags.d && !flags.u)
      || (flags.d && run > 1)
      || (flags.u && run === 1);
    if (wanted) {
      out += flags.c ? `${String(run).padStart(7)} ${lines[i]}\n` : `${lines[i]}\n`;
      kept += 1;
    }
    i += run;
  }
  if (out) std.say(env, out);
  return { exit: 0, lines: kept };
}
