// `true`: succeed, saying nothing.
//
// The program contract, stated here because this is the smallest program that has it. A program in
// `/usr/bin` is an ES module exporting `run(env, go)`.
//
// 1. It receives `env`: `argv` (POSIX-shaped — `argv[0]` is the program name, arguments are
//    `argv.slice(1)`), `fs` (src/libos/syscall.mjs), `proc`, `tty`, `std` (src/libos/std.mjs),
//    `shlex` (src/libos/shlex.mjs; only `sh` uses it), `pid`.
// 2. It returns `{exit: code}`; nothing means exit 0. The kernel reaps on the result and takes
//    `data.exit` as the status (src/kernel/kernel.mjs `onProcessMessage`). `run` may be async —
//    the libos awaits it (src/libos/process.mjs) and a rejection faults the process.
// 3. It writes to fd 1, errors to fd 2, and reads fd 0.
// 4. It may import nothing but `/src/abi.mjs`, which src/libos/process.mjs has already put in the
//    module map; any other specifier is a network fetch per spawned process.
//
// `src/bin/` is a departure from CLAUDE.md's kernel | libos | wm layout: these are the contents of
// a filesystem directory, which `src/kernel/providerfs.mjs` maps into `/usr/bin` row by row.

export function run() {
  return { exit: 0 };
}
