// `pwd`: print the working directory.
//
// IT READS `/proc/<pid>/cwd`, BECAUSE THERE IS NO `getcwd`. `src/abi.mjs` says so where `SYS_chdir`
// is declared — "the write side of /proc/<pid>/cwd. There is no getcwd: that file already answers
// it" — and `src/bin/sh.mjs` reads the same file for its prompt. One publisher, two readers.
//
// WHICH MAKES THIS A CHECK AND NOT ONLY A CONVENIENCE. The cwd is the PROCESS's, held by the
// kernel, and a spawned program inherits it; `cd` has to be a shell builtin because the shell
// needs its own cwd to expand a relative path. So `pwd` printing something other than the
// prompt's directory means the cwd did not travel across `spawn`.
//
// The contract this program is written against is in src/bin/true.mjs.

const NAME = "pwd";

export function run(env) {
  const std = env.std;
  const { bad } = std.getopt((env.argv || []).slice(1), "");
  if (bad) {
    return { exit: std.complain(env, NAME, null, `unknown option ${bad}`, std.EXIT_USAGE) };
  }
  const path = `/proc/${env.pid}/cwd`;
  const text = std.readFileText(env, path);
  if (typeof text === "number") {
    return { exit: std.complainErrno(env, NAME, path, text), errno: -text };
  }
  const cwd = text.trim();
  std.say(env, `${cwd}\n`);
  return { exit: 0, cwd };
}
