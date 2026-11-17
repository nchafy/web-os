`abi.mjs` is every integer the kernel and a process both agree on, and nothing else. It sits
outside the three directories below on purpose: a syscall number, errno or SAB offset must have one
definition imported on both sides, and the kernel and a process are precisely the two sides.

- `fs/` — the filesystem codecs, the mount table and the byte ring. PURE over byte arrays, which
  is what lets `scripts/fsfuzz.py` run 10,000 torn journals under plain Node in about three
  seconds. All I/O lives at the edges, in `kernel/`.
- `kernel/` — the only privileged code. The dispatcher, the process table, the store, the devices.
- `libos/` — the in-process syscall stubs and the realm lockdown. The trust boundary in file form:
  everything here runs inside a process.
- `bin/` — the programs in `/usr/bin`, one file each. `true.mjs` states the program contract.
- `wm/` — the userland window manager.

`CLAUDE.md` §What is where carries a line per file. `MILESTONES.md` says what is done.
