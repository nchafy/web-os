// `echo`: write the arguments, space-separated, with a newline unless `-n`.
//
// The contract this program is written against is in src/bin/true.mjs.

export function run(env) {
  const args = (env.argv || []).slice(1);
  // `-n` is an option only as the first word: `echo a -n` prints `a -n`. A general option parser
  // would eat the second one.
  const noNewline = args[0] === "-n";
  const words = noNewline ? args.slice(1) : args;
  const line = words.join(" ") + (noNewline ? "" : "\n");
  const r = env.std.say(env, line);
  // A failed write is an exit code, not a silent success. The reader of `echo x | head -1` can be
  // gone, and a SIGPIPE whose disposition the caller ignored arrives here as -EPIPE.
  if (r < 0) return { exit: 1, errno: -r };
  return { exit: 0, wrote: r };
}
