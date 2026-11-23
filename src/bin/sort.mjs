// `sort`: order the lines of the input.
//
// IT SLURPS, AND THAT IS NOT A SHORTCUT. Sorting cannot emit its first line until it has seen its
// last, so there is no streaming form of this program; the bound is `MAX_SLURP` in `std.slurp`,
// and a file past it is reported rather than silently truncated.
//
// The contract this program is written against is in src/bin/true.mjs.

import { O_RDONLY } from "/src/abi.mjs";

const NAME = "sort";

export function run(env) {
  const std = env.std;
  const { flags, operands, bad } = std.getopt((env.argv || []).slice(1), "rnu");
  if (bad) {
    return { exit: std.complain(env, NAME, null, `unknown option ${bad}`, std.EXIT_USAGE) };
  }

  let text = "";
  let status = 0;
  if (operands.length === 0) {
    const got = std.slurpText(env, 0);
    if (typeof got === "number") {
      return { exit: std.complainErrno(env, NAME, null, got), errno: -got };
    }
    text = got;
  } else {
    for (const path of operands) {
      const got = path === "-" ? std.slurpText(env, 0) : std.readFileText(env, path);
      if (typeof got === "number") {
        status = std.complainErrno(env, NAME, path, got);
        continue;
      }
      text = text + got;
    }
  }

  // A TRAILING NEWLINE IS A TERMINATOR AND NOT AN EMPTY LINE. Splitting without this turns every
  // well-formed file into one with a blank line at the end, which then sorts to the top.
  const lines = text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
  const numeric = Boolean(flags.n);
  lines.sort((a, b) => {
    if (numeric) {
      const x = Number.parseFloat(a);
      const y = Number.parseFloat(b);
      const xa = Number.isNaN(x);
      const ya = Number.isNaN(y);
      // A LINE THAT IS NOT A NUMBER SORTS BEFORE EVERY NUMBER, as GNU sort -n does, rather than
      // comparing NaN — which is false against everything and leaves the order undefined.
      if (xa && ya) return a < b ? -1 : a > b ? 1 : 0;
      if (xa) return -1;
      if (ya) return 1;
      return x - y;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
  if (flags.r) lines.reverse();
  const out = flags.u ? lines.filter((line, i) => i === 0 || line !== lines[i - 1]) : lines;
  if (out.length) std.say(env, `${out.join("\n")}\n`);
  return { exit: status, lines: out.length };
}
