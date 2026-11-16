// `true`: succeed, saying nothing.
//
// ======================================================================================
// THE PROGRAM CONTRACT, stated once, here, because this is the smallest program that has it.
//
// A program in `/usr/bin` is an ES module exporting `run(env, go)`:
//
//   env.argv      argv, POSIX-shaped: argv[0] IS THE PROGRAM NAME and the arguments are
//                 argv.slice(1). `src/bin/sh.mjs` passes it that way, and a program must not
//                 assume otherwise — the bench orchestrators under `bench/` use argv[0] as a mode
//                 instead, which is their own convention and not this one.
//   env.fs        open/read/write/close/stat/readdir/...  (src/libos/syscall.mjs)
//   env.proc      spawn/waitpid/kill/setpgid/exit/pipe2
//   env.tty       pty_open, termios, winsize, poll
//   env.std       the program support library (src/libos/std.mjs)
//   env.shlex     the shell's language (src/libos/shlex.mjs); only `sh` uses it
//   env.pid       this process's pid
//
// fd 0 is standard input, 1 is standard output, 2 is standard error.
//
// RETURNING `{exit: code}` IS HOW A PROGRAM EXITS. The kernel reaps a process-spawned child on
// its result and takes `data.exit` as the status (src/kernel/kernel.mjs `onProcessMessage`), so
// the return value is the exit code and `env.proc.exit(n)` is the same thing said earlier.
// Returning nothing is exit 0.
//
// A PROGRAM MAY NOT IMPORT ANYTHING EXCEPT `/src/abi.mjs`. The kernel rewrites absolute
// specifiers against the document, so `/src/abi.mjs` comes out of the module map
// `src/libos/process.mjs` already populated; any other module would be a network fetch per
// spawned process. Everything else arrives through `env`.
//
// WHY `src/bin/` EXISTS AT ALL — a departure from CLAUDE.md's src/kernel | src/libos | src/wm
// layout, recorded where the reader meets it. These are not the kernel (unprivileged), not the
// libos (they are not linked into every process) and not the window manager. They are the
// contents of a filesystem directory, and `src/kernel/providerfs.mjs` maps them into `/usr/bin`
// row by row.
// ======================================================================================

export function run() {
  return { exit: 0 };
}
