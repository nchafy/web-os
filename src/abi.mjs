// The ABI: every integer the kernel and a process must agree on, and four pure codecs.
//
// A departure from CLAUDE.md's src/kernel | src/libos | src/wm layout, recorded where the reader
// meets it: this module sits above all three because both sides of the trust boundary import it.
//
// STANDING RULE. Nothing here may close over a capability, read a global other than TypedArray and
// Atomics arithmetic, or perform I/O. That rule is why a process may import it at all.
//
// Every integer lives in INTS, once, and is re-exported by destructuring.

const SAB_BYTES_ = 65536;
const BYTE_OFF_ = 128;

const INTS = {
  // i32 indices into the per-process control region, transcribed once from docs/ABI.md
  // "The transport". 7 is free; 18..31 are reserved.
  SEQ: 0,
  STATUS: 1,
  RLEN: 2,
  SIGPEND: 3,
  // i32[4], a PER-CALL UNIQUE value, monotonic per process, wrapping at 2^31 — not the syscall
  // number. A syscall number cannot tell two consecutive read()s apart, which is exactly what
  // cancellation creates: interrupt a read, the caller retries, and a late reply to the first must
  // not be taken for the second.
  CALLID: 4,
  UID: 5,
  // The syscall number in its own word; i32[6] and i32[7] are unused in the documented layout.
  // Deliberately NOT packed with a sequence into one i32: a 16-bit sequence wraps about once a
  // second under saturation, and an aliased stale reply is the bug CALLID exists to prevent.
  NR: 6,
  A0: 8, A1: 9, A2: 10, A3: 11, A4: 12, A5: 13, A6: 14, A7: 15,
  R0: 16, R1: 17,
  // Two of the reserved words 18..31, for the one fact a process must be able to state after its
  // kernel has gone: that it noticed. The port is what died, so a process cannot report through
  // it. A supervisor reads these off the SAB it still holds; the kernel-dead control reads them to
  // assert N of N faulted inside REARM_MS x (HB_MISS_LIMIT + 1).
  KDOWN_SEEN: 18,
  KDOWN_MS: 19,
  // A third reserved word, for the one thing a process cannot otherwise do: idle without a
  // syscall. NOTHING EVER WRITES OR NOTIFIES IT, so an Atomics.wait on it always times out, which
  // is a genuinely idle sleep that releases the core. A performance.now() busy-spin in N processes
  // would starve the kernel and raise the very latency the rate-limited control leaves alone.
  IDLE_PARK: 20,

  // A scratch word a PROGRAM may advance and the page may read, so a test can observe a phase
  // without asking for a syscall — a process reporting progress by syscall would be in a syscall
  // when a signal arrived. Kernel-neutral: nothing in src/kernel reads or writes it.
  P_PROGRESS: 21,

  // The SAB frame header: a MAGIC and a VERSION, four bytes each, written once by the kernel at
  // spawn and asserted once by the libos at init. Two reserved words, nothing else moves; a header
  // is impossible to retrofit once processes are reading frames.
  H_MAGIC: 22,
  H_VERSION: 23,

  // The one variable-length argument: byte 128, laid out [u32 len][bytes].
  SAB_BYTES: SAB_BYTES_,
  BYTE_OFF: BYTE_OFF_,
  LEN_I32: BYTE_OFF_ >> 2,
  // The BYTES start after the length word, not at BYTE_OFF: writing them at BYTE_OFF puts the
  // payload's first four bytes on top of the length the kernel is about to read, and a maximal
  // write comes back -EINVAL because the kernel reads the payload as its own length. Derived, so
  // the two sides cannot disagree about where the data starts.
  DATA_OFF: BYTE_OFF_ + 4,
  // Derived, never restated. The literal 65404 appears nowhere; selfTest() asserts the
  // derivation equals docs/ABI.md's published figure, so changing SAB_BYTES fires an assertion
  // instead of leaving two numbers to drift.
  MAX_INLINE: SAB_BYTES_ - BYTE_OFF_ - 4,

  // Syscall numbers. Dense from 0, append-only, NEVER renumbered: renumbering is an ABI break.
  // Allocation order is milestone order, not docs/ABI.md's group order — a reader expecting the
  // document's grouping will not find it here.
  SYS_getpid: 0,
  SYS_write: 1,
  SYS_clock_nanosleep: 2,
  // The two halves of OPFS behave oppositely: createSyncAccessHandle returns a PROMISE, so its
  // 495 us (constraint 22) is awaited and the dispatch thread stays free, while the handle's own
  // write/flush are SYNCHRONOUS and flush is 260 us (constraint 23) of kernel thread nobody else
  // can use. open is the cheap one to serve and fsync the expensive one, the reverse of how their
  // raw costs read.
  SYS_open: 3,
  SYS_fsync: 4,
  // 15 is the perform() escape hatch, reserved so a future ABI growth has one slot to route a new
  // call through without widening NSYS or shifting any number.
  SYS_spawn: 5,
  SYS_exit: 6,
  SYS_waitpid: 7,
  SYS_kill: 8,
  SYS_sigaction: 9,
  SYS_setpgid: 10,
  SYS_sched_yield: 11,
  SYS_getppid: 12,
  SYS_getpgid: 13,
  SYS_setsid: 14,
  SYS_perform: 15,
  // 16..21 are the fd group docs/ABI.md lists; 22..36 are the path group. SYS_open keeps number 3
  // and carries a0 = flags, a1 = mode, byte region = path; a second "open" would be two renderers
  // of one fact.
  SYS_close: 16,
  SYS_read: 17,
  SYS_pread: 18,
  SYS_pwrite: 19,
  SYS_seek: 20,
  SYS_fstat: 21,
  SYS_ftruncate: 22,
  SYS_mkdir: 23,
  SYS_rmdir: 24,
  SYS_unlink: 25,
  SYS_rename: 26,
  SYS_symlink: 27,
  SYS_readlink: 28,
  SYS_link: 29,
  SYS_stat: 30,
  SYS_lstat: 31,
  SYS_chmod: 32,
  SYS_chown: 33,
  SYS_readdir: 34,
  SYS_truncate: 35,
  SYS_statfs: 36,
  SYS_dup: 37,
  SYS_dup2: 38,
  SYS_pipe2: 39,
  // `ioctl` is here for exactly two requests, the foreground process group: POSIX's own channel.
  SYS_pty_open: 40,
  SYS_tty_get: 41,
  SYS_tty_set: 42,
  SYS_tty_winsize_get: 43,
  SYS_tty_winsize_set: 44,
  SYS_poll: 45,
  SYS_ioctl: 46,
  // The write side of `/proc/<pid>/cwd`. There is no `getcwd`: that file already answers it.
  SYS_chdir: 47,
  NSYS: 48,

  // STATUS. 1 is a deliberate hole: docs/ABI.md decision 1 pins "sets STATUS=2" for the
  // interrupt case, and renumbering a published value is worse than a gap.
  ST_RETURN: 0,
  ST_INTR: 2,
  ST_KDOWN: 3,

  // File-description kinds. Each is a row in one ops table (src/kernel/files.mjs), which is the
  // property that makes `read(2)` identical for a generated file and a real one. F_SYNTH is
  // read-only kernel bytes, F_TMP the writable in-memory kind; F_TTY is the pty SLAVE and F_PTY_M
  // the MASTER, which behave oppositely (src/kernel/pty.mjs).
  F_SINK: 0, F_FILE: 1, F_PIPE_R: 2, F_PIPE_W: 3, F_TTY: 4, F_WIN: 5, F_SYNTH: 6, F_TMP: 7,
  F_PTY_M: 8,

  // Constraint 17: the process table carries a hard cap. 128 is M0's; 1,000 is the design limit.
  PROC_CAP: 128,

  // CALLID wraps here rather than going negative: the word is an i32, and a negative callid would
  // compare unequal to the posted copy once the Atomics round trip sign-extends differently from
  // a reader's `>>> 0`.
  CALLID_WRAP: 0x7fffffff,

  // The bulk-transfer flag bit in a7 (docs/ABI.md decision 4). Named, unimplemented, -ENOSYS.
  A_SHM: 1,

  // Constraint 46. The park is finite and re-arms; HB_MISS_LIMIT consecutive re-arms with no
  // heartbeat advance is what declares the kernel gone. Elapsed time alone never does.
  REARM_MS: 50,
  HB_PERIOD_MS: 10,
  HB_MISS_LIMIT: 3,

  // The globals SAB: one word per fact, shared by the kernel and every process. A per-process
  // heartbeat would be the O(N) per-tick sweep constraint 18 forbids.
  GLOBAL_BYTES: 64,
  G_HEARTBEAT: 0,
  G_HB_PERIOD_MS: 1,
  G_KSTATE: 2,
  G_EPOCH: 3,
  G_INFLIGHT: 4,
  G_THINK_US: 5,
  G_STALL_US: 6,
  G_READY: 7,
  // The measured window, in one word, so a process has one thing to park on and the dispatcher
  // one thing to test. Both edges matter: without W_PRE -> W_OPEN the windows are staggered and
  // the first dispatch of each genuinely sees depth 1; without W_OPEN -> W_CLOSED the ramp-down
  // puts depth-1 samples in a saturated window.
  G_WINDOW: 8,
  // Arrivals at the barrier. The kernel releases when this reaches the spawned count.
  G_BARRIER: 9,
  // ONE deadline for the whole cell, as a (lo, hi) i32 pair over Date.now() milliseconds.
  // performance.now() cannot be used: timeOrigin differs per agent, so only DURATIONS cross an
  // agent boundary. Date.now() is the same clock in every agent in the renderer.
  G_DEADLINE_LO: 10,
  G_DEADLINE_HI: 11,

  // W_CLOSED is set by the first process to reach the deadline, W_DONE by the kernel once every
  // process has left. The gap between them is the only place a process may issue a call outside
  // the measured window, so an out-of-window check — a 1 MiB write, a 5 ms spin — cannot land
  // inside another process's window and move its p99.
  W_PRE: 0, W_OPEN: 1, W_CLOSED: 2, W_DONE: 3,

  K_BOOT: 0, K_UP: 1, K_PANIC: 2,

  // docs/ABI.md: the DOM object behind a host fd was destroyed. 77..99 stay reserved for WASI.
  EHOSTGONE: 100,

  // Four ASCII bytes little-endian, 'wSBO': a value an accidental zero or an uninitialised memory
  // pattern cannot produce.
  SAB_MAGIC: 0x4f425377,
  SAB_VERSION: 1,

  // Signals the kernel delivers through SIGPEND. One bit each, so SIGPEND is 32 signals wide.
  // POSIX numbers, not WASI's: the former is what every existing program expects.
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGABRT: 6,
  SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13,
  SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19,
  SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGWINCH: 28,

  // SIG_DFL and SIG_IGN are handled by the kernel at delivery; SIG_HANDLE means "a handler exists
  // in the process, set the bit and let it drain at syscall entry".
  SIG_DFL: 0, SIG_IGN: 1, SIG_HANDLE: 2,

  // r1 carries the status, and the kernel is its only writer because terminate() leaves the dying
  // worker no way to report.
  WNOHANG: 1,
  // r1 = (kind << 8) | (0..255). Without the kind, waitpid cannot tell "ran to completion with
  // code 0" from "SIGKILL'd before it could run" — identical from a process already gone.
  STAT_EXITED: 0,
  STAT_KILLED: 1,

  // The capability bitmask. Only MONOTONICITY is asserted, so a widening after an initial
  // narrowing must fail.
  CAP_ALL: -1,  // every bit set, as a 32-bit signed value — i.e. 0xffffffff as an i32

  // open(2) flags, LINUX's numeric values rather than WASI's oflags: WASI splits "how to open"
  // across oflags + fdflags + rights, and a three-word open is the shape docs/ABI.md's
  // `open(flags, mode)` already rejected. The errno space stays WASI's.
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_ACCMODE: 3,
  O_CREAT: 0x40, O_EXCL: 0x80, O_TRUNC: 0x200, O_APPEND: 0x400,
  O_DIRECTORY: 0x10000, O_NOFOLLOW: 0x20000,

  SEEK_SET: 0, SEEK_CUR: 1, SEEK_END: 2,

  // POSIX's own NAME_MAX. Here rather than in src/fs/vfs.mjs because it CROSSES the boundary: a
  // program refused with -ENAMETOOLONG has to know what length it was refused for, so there is one
  // declaration and vfs.mjs imports it.
  NAME_MAX: 255,

  // The POSIX file-type bits inside a mode word. The VFS stores the permission bits alone and
  // carries the type as a string; these are what fstat/stat publish, so `(mode & S_IFMT) ===
  // S_IFDIR` works the way it would anywhere else.
  S_IFMT: 0o170000, S_IFREG: 0o100000, S_IFDIR: 0o040000, S_IFLNK: 0o120000,

  // The Filestat record, 64 bytes as docs/ABI.md publishes. The FIELDS are not WASI's: WASI's
  // filestat has no mode, no uid and no gid, and constraint 29 turns on exactly those — a
  // credential per call is decoration if stat cannot report the bits it was checked against.
  FST_DEV: 0, FST_INO: 8, FST_MODE: 16, FST_NLINK: 20, FST_UID: 24, FST_GID: 28,
  FST_SIZE: 32, FST_ATIM: 40, FST_MTIM: 48, FST_CTIM: 56,
  FILESTAT_BYTES: 64,

  // A readdir record: [u64 ino][u8 type][u8 nlen][u16 pad][char[] name], padded to 4 bytes.
  // docs/ABI.md's shape with the pad made explicit, because an unaligned u64 read is the kind of
  // defect that only shows up on a name of the wrong length.
  DT_UNKNOWN: 0, DT_DIR: 4, DT_REG: 8, DT_LNK: 10,
  DIRENT_HEADER: 12,

  // Constraint 48: the boot lock must retry for LONGER than the terminate abort grace before
  // declaring another tab. Constraint 55 measured that grace at ~2.0 s, so a 3 s budget is the
  // measured figure plus a margin — not a round number. Backoff doubles from BOOT_LOCK_FIRST_MS.
  BOOT_LOCK_BUDGET_MS: 3000,
  BOOT_LOCK_FIRST_MS: 25,

  // Constraint 23: the journal is flushed on fsync, on snapshot, and on idle. This is "idle".
  JOURNAL_IDLE_MS: 250,

  // Charged per fd — not per process, not per event source — because the fd is already the unit
  // `poll()` waits on (constraint 42) and the unit `close()` releases. 64 is a budget, not a
  // measurement: enough that no normal caller sees it, few enough that one pathological caller
  // cannot pin 64 KiB of kernel state per fd.
  FD_INFLIGHT_CAP: 64,

  /**
   * One pipe's buffer, in bytes. No document specified it: 65536 sits just above MAX_INLINE
   * (65404), so a single maximal write fits in an empty pipe.
   *
   * NO ATOMIC-WRITE GUARANTEE IS CLAIMED, at any size. POSIX guarantees a write under `PIPE_BUF`
   * is atomic against other writers; this does not, and the absence of `PIPE_BUF` is the answer.
   * A write past the remaining space blocks; one larger than the capacity progresses in pieces.
   */
  PIPE_CAPACITY: 65536,

  /**
   * The highest fd a process may hold, plus one. POSIX's `OPEN_MAX`, and load-bearing: the fd table
   * is a plain array indexed by fd, so a `dup2` naming fd 2^30 grows it to a billion entries that
   * `spawn`'s inheritance loop and `teardown`'s fd sweep then walk ON THE KERNEL THREAD —
   * constraint 56 gives that 200 ms before every parked process declares the kernel dead.
   */
  OPEN_MAX: 1024,

  /**
   * One line of input and a screenful of output, which is what a terminal actually holds. A pty is
   * not a bulk transport, and 64 KiB per direction would be 128 KiB of kernel memory per terminal.
   */
  PTY_INPUT_BYTES: 4096,
  PTY_OUTPUT_BYTES: 16384,

  // termios: 64 bytes, LINUX's field order and LINUX's flag and cc-index values. A program that
  // knows what ICANON is knows it as 0o2, and `docs/ABI.md` names the same flags.
  TERMIOS_BYTES: 64,
  TRM_IFLAG: 0, TRM_OFLAG: 4, TRM_CFLAG: 8, TRM_LFLAG: 12,
  //: 20 control characters at offset 16, which is Linux's NCCS.
  TRM_CC: 16, TRM_NCCS: 20,

  //: c_lflag bits. Only these three have behaviour; the rest of the word is reserved and MUST be
  //: preserved across a set so a future flag is not silently cleared by an old caller.
  ISIG: 0o1,
  ICANON: 0o2,
  ECHO: 0o10,

  //: c_cc indices, Linux's. VMIN and VTIME are carried because docs/ABI.md requires them in the
  //: struct; no behaviour reads them.
  VINTR: 0, VQUIT: 1, VERASE: 2, VKILL: 3, VEOF: 4, VTIME: 5, VMIN: 6, VSUSP: 10,

  //: The POSIX defaults a fresh pty comes up with: canonical, echoing, signal-generating.
  TRM_DEF_INTR: 3,      // ^C
  TRM_DEF_QUIT: 28,     // ^\
  TRM_DEF_ERASE: 127,   // DEL
  TRM_DEF_KILL: 21,     // ^U
  TRM_DEF_EOF: 4,       // ^D
  TRM_DEF_SUSP: 26,     // ^Z

  WINSIZE_BYTES: 8,
  WS_ROWS: 0, WS_COLS: 2, WS_XPIXEL: 4, WS_YPIXEL: 6,

  // docs/ABI.md: `poll(nfds, byteregion = nfds x {i32 fd, u16 events, u16 revents}, timeout_ms)`.
  POLLFD_BYTES: 8,
  PFD_FD: 0, PFD_EVENTS: 4, PFD_REVENTS: 6,
  POLLIN: 0x1,
  POLLOUT: 0x4,
  POLLERR: 0x8,
  POLLHUP: 0x10,
  POLLNVAL: 0x20,

  TIOCGPGRP: 0x540f,
  TIOCSPGRP: 0x5410,

  // `spawn`'s file actions, posix_spawn-shaped. The two a shell needs and no more: a case that
  // does not exist yet must not get a parameter (CLAUDE.md, general enough and no further).
  SPAWN_DUP2: 1,
  SPAWN_CLOSE: 2,

};

export const {
  SEQ, STATUS, RLEN, SIGPEND, CALLID, UID, NR,
  A0, A1, A2, A3, A4, A5, A6, A7, R0, R1, KDOWN_SEEN, KDOWN_MS,
  IDLE_PARK, P_PROGRESS, H_MAGIC, H_VERSION,
  SAB_BYTES, BYTE_OFF, DATA_OFF, LEN_I32, MAX_INLINE,
  SYS_getpid, SYS_write, SYS_clock_nanosleep, SYS_open, SYS_fsync,
  SYS_spawn, SYS_exit, SYS_waitpid, SYS_kill, SYS_sigaction, SYS_setpgid,
  SYS_sched_yield, SYS_getppid, SYS_getpgid, SYS_setsid, SYS_perform,
  SYS_close, SYS_read, SYS_pread, SYS_pwrite, SYS_seek, SYS_fstat, SYS_ftruncate,
  SYS_mkdir, SYS_rmdir, SYS_unlink, SYS_rename, SYS_symlink, SYS_readlink, SYS_link,
  SYS_stat, SYS_lstat, SYS_chmod, SYS_chown, SYS_readdir, SYS_truncate, SYS_statfs,
  SYS_dup, SYS_dup2, SYS_pipe2,
  SYS_pty_open, SYS_tty_get, SYS_tty_set, SYS_tty_winsize_get, SYS_tty_winsize_set,
  SYS_poll, SYS_ioctl, SYS_chdir, NSYS,
  O_RDONLY, O_WRONLY, O_RDWR, O_ACCMODE, O_CREAT, O_EXCL, O_TRUNC, O_APPEND,
  O_DIRECTORY, O_NOFOLLOW, SEEK_SET, SEEK_CUR, SEEK_END, NAME_MAX,
  S_IFMT, S_IFREG, S_IFDIR, S_IFLNK,
  FST_DEV, FST_INO, FST_MODE, FST_NLINK, FST_UID, FST_GID, FST_SIZE,
  FST_ATIM, FST_MTIM, FST_CTIM, FILESTAT_BYTES,
  DT_UNKNOWN, DT_DIR, DT_REG, DT_LNK, DIRENT_HEADER,
  BOOT_LOCK_BUDGET_MS, BOOT_LOCK_FIRST_MS, JOURNAL_IDLE_MS,
  ST_RETURN, ST_INTR, ST_KDOWN,
  F_SINK, F_FILE, F_PIPE_R, F_PIPE_W, F_TTY, F_WIN, F_SYNTH, F_TMP, F_PTY_M,
  PROC_CAP, A_SHM, CALLID_WRAP,
  REARM_MS, HB_PERIOD_MS, HB_MISS_LIMIT,
  GLOBAL_BYTES, G_HEARTBEAT, G_HB_PERIOD_MS, G_KSTATE, G_EPOCH, G_INFLIGHT,
  G_THINK_US, G_STALL_US, G_READY, G_WINDOW, G_BARRIER, G_DEADLINE_LO, G_DEADLINE_HI,
  W_PRE, W_OPEN, W_CLOSED, W_DONE,
  K_BOOT, K_UP, K_PANIC,
  EHOSTGONE, SAB_MAGIC, SAB_VERSION,
  SIGHUP, SIGINT, SIGQUIT, SIGILL, SIGABRT, SIGKILL, SIGUSR1, SIGUSR2, SIGSEGV,
  SIGPIPE, SIGALRM, SIGTERM,
  SIGCHLD, SIGCONT, SIGSTOP, SIGTSTP, SIGTTIN, SIGTTOU, SIGWINCH,
  SIG_DFL, SIG_IGN, SIG_HANDLE,
  WNOHANG, STAT_EXITED, STAT_KILLED,
  CAP_ALL, FD_INFLIGHT_CAP,
  PIPE_CAPACITY, OPEN_MAX, SPAWN_DUP2, SPAWN_CLOSE,
  PTY_INPUT_BYTES, PTY_OUTPUT_BYTES,
  TERMIOS_BYTES, TRM_IFLAG, TRM_OFLAG, TRM_CFLAG, TRM_LFLAG, TRM_CC, TRM_NCCS,
  ISIG, ICANON, ECHO, VINTR, VQUIT, VERASE, VKILL, VEOF, VTIME, VMIN, VSUSP,
  TRM_DEF_INTR, TRM_DEF_QUIT, TRM_DEF_ERASE, TRM_DEF_KILL, TRM_DEF_EOF, TRM_DEF_SUSP,
  WINSIZE_BYTES, WS_ROWS, WS_COLS, WS_XPIXEL, WS_YPIXEL,
  POLLFD_BYTES, PFD_FD, PFD_EVENTS, PFD_REVENTS,
  POLLIN, POLLOUT, POLLERR, POLLHUP, POLLNVAL,
  TIOCGPGRP, TIOCSPGRP,
} = INTS;

/**
 * Kernel-internal message kinds for the I/O worker, NOT part of the process ABI: a process never
 * sends one and never receives one. Here so the dispatch kernel and the I/O worker cannot disagree
 * about a string.
 */
export const IO_OPEN = "io-open";
export const IO_WRITE = "io-write";
export const IO_FSYNC = "io-fsync";
export const IO_CLOSE = "io-close";
export const IO_READ = "io-read";
export const IO_BLOB_OPEN = "io-blob-open";
export const IO_TRUNCATE = "io-truncate";
export const IO_FREE = "io-free";
export const IO_LIST = "io-list";
export const IO_READ_ALL = "io-read-all";
export const IO_WRITE_ALL = "io-write-all";
export const IO_LOCK = "io-lock";
export const IO_JOURNAL = "io-journal";
export const IO_COPY = "io-copy";
/**
 * One blob's PHYSICAL length, from the handle that holds it. A file description holds no cached
 * size, and an uncommitted append lives above the size the metadata publishes, so this is asked of
 * the blob at the point of use.
 */
export const IO_SIZE = "io-size";
/** A MEASUREMENT request, performing no I/O: it makes constraint 23's write ordering and
 *  constraint 24's one-directory-handle budget observable from a check. */
export const IO_STATS = "io-stats";

/** A ring, whose sequence number survives eviction, so "this flush preceded that journal append"
 *  compares integers rather than positions in an array a 10,000-file run would overrun. */
export const IO_TRACE_KEEP = 512;

/** The flat blob directory (constraint 26): one subdirectory of the OPFS root, names
 *  `<ino>.<gen>`. */
export const BLOB_DIR = "blobs";

/** Its sync access handle IS the boot lock (constraint 48), so the name is agreed here rather than
 *  in the worker that holds it: a module assigning `self.onmessage` is an entry point and must not
 *  be imported for a constant. */
export const JOURNAL_NAME = "journal";

/** THREE, not two: against two alternating slots a bad write to the older one DURING a commit can
 *  leave zero valid copies. */
export const SUPER_SLOTS = Object.freeze(["sb.0", "sb.1", "sb.2"]);

/** Indexed by syscall number, so a number and its printed name cannot drift. The kernel's dispatch
 *  table is DERIVED from this at boot, not written separately. */
export const SYS_NAME = Object.freeze([
  "getpid", "write", "clock_nanosleep", "open", "fsync",
  "spawn", "exit", "waitpid", "kill", "sigaction", "setpgid",
  "sched_yield", "getppid", "getpgid", "setsid", "perform",
  "close", "read", "pread", "pwrite", "seek", "fstat", "ftruncate",
  "mkdir", "rmdir", "unlink", "rename", "symlink", "readlink", "link",
  "stat", "lstat", "chmod", "chown", "readdir", "truncate", "statfs",
  "dup", "dup2", "pipe2",
  "pty_open", "tty_get", "tty_set", "tty_winsize_get", "tty_winsize_set", "poll", "ioctl",
  "chdir",
]);

// The WASI preview1 errno enum, dense 0..76, in its published order. Generated mechanically from
// the `__WASI_ERRNO_*` macros in wasi-libc's wasip1.h at
// https://github.com/WebAssembly/wasi-libc/blob/3fa18af12545a4bf21011c28d64911ee9cf36315/libc-bottom-half/headers/public/wasi/wasip1.h
// sorted by value, and asserted dense over 0..76.
//
// selfTest() asserts SHAPE only — length, uniqueness, density, the two endpoints — which catches a
// dropped or duplicated row and CANNOT catch one value transcribed wrongly. What closes that hole
// is the generation step, not the test.
export const ERRNO_NAMES = Object.freeze([
  "ESUCCESS", "E2BIG", "EACCES", "EADDRINUSE", "EADDRNOTAVAIL", "EAFNOSUPPORT", "EAGAIN",
  "EALREADY", "EBADF", "EBADMSG", "EBUSY", "ECANCELED", "ECHILD", "ECONNABORTED", "ECONNREFUSED",
  "ECONNRESET", "EDEADLK", "EDESTADDRREQ", "EDOM", "EDQUOT", "EEXIST", "EFAULT", "EFBIG",
  "EHOSTUNREACH", "EIDRM", "EILSEQ", "EINPROGRESS", "EINTR", "EINVAL", "EIO", "EISCONN",
  "EISDIR", "ELOOP", "EMFILE", "EMLINK", "EMSGSIZE", "EMULTIHOP", "ENAMETOOLONG", "ENETDOWN",
  "ENETRESET", "ENETUNREACH", "ENFILE", "ENOBUFS", "ENODEV", "ENOENT", "ENOEXEC", "ENOLCK",
  "ENOLINK", "ENOMEM", "ENOMSG", "ENOPROTOOPT", "ENOSPC", "ENOSYS", "ENOTCONN", "ENOTDIR",
  "ENOTEMPTY", "ENOTRECOVERABLE", "ENOTSOCK", "ENOTSUP", "ENOTTY", "ENXIO", "EOVERFLOW",
  "EOWNERDEAD", "EPERM", "EPIPE", "EPROTO", "EPROTONOSUPPORT", "EPROTOTYPE", "ERANGE", "EROFS",
  "ESPIPE", "ESRCH", "ESTALE", "ETIMEDOUT", "ETXTBSY", "EXDEV", "ENOTCAPABLE",
]);

/** Name -> number, for every WASI errno plus the one extension. */
export const E = Object.freeze(
  Object.assign(
    Object.fromEntries(ERRNO_NAMES.map((name, value) => [name, value])),
    { EHOSTGONE },
  ),
);

export const EAGAIN = E.EAGAIN;
export const EBADF = E.EBADF;
export const EINTR = E.EINTR;
export const EINVAL = E.EINVAL;
export const EIO = E.EIO;
export const ENOSYS = E.ENOSYS;
export const ENOTSUP = E.ENOTSUP;
export const EPERM = E.EPERM;
export const ESRCH = E.ESRCH;
export const ECHILD = E.ECHILD;
export const ECONNABORTED = E.ECONNABORTED;
// Every one is read off the table above rather than written as a number, so the single-copy rule
// holds for the errnos too.
export const ENOENT = E.ENOENT;
export const ENOTDIR = E.ENOTDIR;
export const EISDIR = E.EISDIR;
export const EEXIST = E.EEXIST;
export const ENOTEMPTY = E.ENOTEMPTY;
export const EACCES = E.EACCES;
export const ELOOP = E.ELOOP;
export const ENAMETOOLONG = E.ENAMETOOLONG;
export const ENOSPC = E.ENOSPC;
export const EROFS = E.EROFS;
export const EMFILE = E.EMFILE;
export const EMLINK = E.EMLINK;
export const EFBIG = E.EFBIG;
export const EBUSY = E.EBUSY;
export const EXDEV = E.EXDEV;
export const ESPIPE = E.ESPIPE;
/** What `tty_get`, `tty_set` and `ioctl` answer for an fd that is not a pty, which is what makes
 *  `isatty()` expressible without a second call. */
export const ENOTTY = E.ENOTTY;
/** A file that resolved and is not a program this kernel can run. Not EIO: the storage worked. */
export const ENOEXEC = E.ENOEXEC;
/** The writer's half of docs/ABI.md decision 5: a write whose last reader went gets this AND
 *  SIGPIPE. */
export const EPIPE = E.EPIPE;
export const EOVERFLOW = E.EOVERFLOW;
/** `open` on a character device that is not there — `/dev/console` with no window attached. NOT
 *  ENOENT: the file exists and the device does not. Distinct from EHOSTGONE, a window that DID
 *  exist. */
export const ENXIO = E.ENXIO;
/** A character-device name with no driver behind it: a row added to `src/kernel/devfs.mjs`'s
 *  CHARDEVS without a kernel arm is refused rather than faulting the kernel on its first read. */
export const ENODEV = E.ENODEV;
/** Every operation on a file description whose inode is gone. POSIX has no errno for it because
 *  POSIX keeps an unlinked file alive until the last descriptor closes; one name refuses
 *  CONSISTENTLY instead (src/kernel/store.mjs `resolve`). */
export const ESTALE = E.ESTALE;

/** DERIVED rather than written as an index: `ERRNO_NAMES` begins at ESUCCESS = 0 and has 77
 *  entries, and an index off by one is easy to write and hard to see. */
export const ELIMIT_ERRNO = E.ENOBUFS;
export const TEARDOWN_ERRNO = E.ECONNABORTED;

/** Signals 1..31 occupy one bit each in SIGPEND. */
export function SIG_BIT(sig) {
  return 1 << (sig - 1);
}

/** WRITTEN OUT, not derived from the `SIG*` keys of INTS: `SIGPEND` is in INTS and is a WORD INDEX
 *  rather than a signal. `selfTest()` asserts both directions, so adding a signal and forgetting
 *  this table makes the module refuse to load. */
export const SIGNALS = Object.freeze({
  HUP: SIGHUP, INT: SIGINT, QUIT: SIGQUIT, ILL: SIGILL, ABRT: SIGABRT,
  KILL: SIGKILL, USR1: SIGUSR1, SEGV: SIGSEGV, USR2: SIGUSR2, PIPE: SIGPIPE,
  ALRM: SIGALRM, TERM: SIGTERM, CHLD: SIGCHLD, CONT: SIGCONT, STOP: SIGSTOP,
  TSTP: SIGTSTP, TTIN: SIGTTIN, TTOU: SIGTTOU, WINCH: SIGWINCH,
});

/** Number -> name, for a one-line "killed by" that reads. Derived, so it cannot disagree. */
export const SIGNAL_NAME = Object.freeze(
  Object.fromEntries(Object.entries(SIGNALS).map(([name, n]) => [n, name])),
);

/** `kill`'s argument, as a number: `9`, `KILL` or `SIGKILL`. Null for anything else. */
export function signalOf(spec) {
  if (typeof spec === "number") return Object.hasOwn(SIGNAL_NAME, spec) ? spec : null;
  if (typeof spec !== "string" || spec === "") return null;
  if (/^\d+$/.test(spec)) {
    const n = Number(spec);
    return Object.hasOwn(SIGNAL_NAME, n) ? n : null;
  }
  const upper = spec.toUpperCase();
  const bare = upper.startsWith("SIG") ? upper.slice(3) : upper;
  return Object.hasOwn(SIGNALS, bare) ? SIGNALS[bare] : null;
}

// The four pure codecs. Total functions over integers, and nothing else.

/** docs/ABI.md "Errors": the Linux single-register convention, with one renderer of that fact. */
export function isErr(r0, r1) {
  return r0 < 0 && r1 === -1;
}


export function errName(errno) {
  return ERRNO_NAMES[errno] ?? (errno === EHOSTGONE ? "EHOSTGONE" : `E?${errno}`);
}

/** A 64-bit argument takes a (lo, hi) register pair. */
export function packI64(value) {
  const v = BigInt(value);
  return [Number(v & 0xffffffffn) | 0, Number((v >> 32n) & 0xffffffffn) | 0];
}

export function unpackI64(lo, hi) {
  return (BigInt(hi) << 32n) | (BigInt(lo >>> 0));
}

/**
 * ONE place, because the kernel writes the record and the process reads it. `mode` carries the
 * S_IF* type bits ORed with the permission bits, POSIX's own packing. Times are nanoseconds since
 * the epoch as BigInt: a u64 nanosecond field read as a double loses precision today.
 */
export function encodeFilestat(dv, off, st) {
  dv.setBigUint64(off + FST_DEV, BigInt(st.dev || 0), true);
  dv.setBigUint64(off + FST_INO, BigInt(st.ino), true);
  dv.setUint32(off + FST_MODE, st.mode >>> 0, true);
  dv.setUint32(off + FST_NLINK, st.nlink >>> 0, true);
  dv.setUint32(off + FST_UID, st.uid >>> 0, true);
  dv.setUint32(off + FST_GID, st.gid >>> 0, true);
  dv.setBigUint64(off + FST_SIZE, BigInt(st.size), true);
  dv.setBigUint64(off + FST_ATIM, BigInt(st.atimeNs), true);
  dv.setBigUint64(off + FST_MTIM, BigInt(st.mtimeNs), true);
  dv.setBigUint64(off + FST_CTIM, BigInt(st.ctimeNs), true);
}

export function decodeFilestat(dv, off) {
  return {
    dev: dv.getBigUint64(off + FST_DEV, true),
    ino: dv.getBigUint64(off + FST_INO, true),
    mode: dv.getUint32(off + FST_MODE, true),
    nlink: dv.getUint32(off + FST_NLINK, true),
    uid: dv.getUint32(off + FST_UID, true),
    gid: dv.getUint32(off + FST_GID, true),
    size: dv.getBigUint64(off + FST_SIZE, true),
    atimeNs: dv.getBigUint64(off + FST_ATIM, true),
    mtimeNs: dv.getBigUint64(off + FST_MTIM, true),
    ctimeNs: dv.getBigUint64(off + FST_CTIM, true),
  };
}

/** The next per-call-unique CALLID. Monotonic per process, wrapping at 2^31, never negative. */
export function nextCallId(previous) {
  return previous >= CALLID_WRAP ? 1 : previous + 1;
}

// FNV-1a, 32-bit, in ONE place.
//
// The kernel's sink and every process checksum the same byte stream and the two sides are
// compared. One implementation makes that comparison a tautology unless something external pins
// it, so selfTest() checks it against the published known-answer vectors.
//
// Constants and vectors from Landon Curt Noll's FNV page,
// http://www.isthe.com/chongo/tech/comp/fnv/ (offset basis 2166136261, prime 16777619).
export const FNV1A_BASIS = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;

export function fnv1a(u8, offset, length, seed = FNV1A_BASIS) {
  let h = seed;
  for (let i = offset; i < offset + length; i += 1) {
    h ^= u8[i];
    h = Math.imul(h, FNV1A_PRIME) >>> 0;
  }
  return h >>> 0;
}

/** The same hash over a string's UTF-16 code units. Every caller's input is ASCII. */
export function fnv1aString(text, seed = FNV1A_BASIS) {
  let h = seed;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, FNV1A_PRIME) >>> 0;
  }
  return h >>> 0;
}

/**
 * FNV-1a over the sorted `name=value` list of every integer above, which makes the single-copy
 * claim a measurement: the page, the kernel and every process report this and the bench asserts
 * they are equal and non-zero, so a stale copy of this module is a mismatch at boot rather than a
 * wrong errno later.
 */
export const ABI_FINGERPRINT = (() => {
  const rows = Object.keys(INTS).sort().map((k) => `${k}=${INTS[k]}`);
  rows.push(`SYS_NAME=${SYS_NAME.join(",")}`, `ERRNO=${ERRNO_NAMES.join(",")}`);
  return fnv1aString(rows.join(";"));
})();

/**
 * `spawn`'s request, as bytes. The process encodes it and the kernel decodes it, so the layout has
 * one definition.
 *
 * Layout, little-endian, every length a u32:
 *   [u32 pathLen][path UTF-8]
 *   [u32 argc]  then argc x ([u32 len][UTF-8])
 *   [u32 nActions] then nActions x [u32 op][i32 a][i32 b]
 *
 * A codec and not JSON because the kernel must not run a parser that can throw over
 * process-controlled input: `decodeSpawnRequest` returns null, and a kernel that threw on a
 * malformed spawn would be a process faulting the kernel.
 */
export function encodeSpawnRequest({ path, argv = [], actions = [] }) {
  const enc = new TextEncoder();
  const pathBytes = enc.encode(path);
  const argvBytes = argv.map((a) => enc.encode(String(a)));
  let size = 4 + pathBytes.length + 4;
  for (const a of argvBytes) size += 4 + a.length;
  size += 4 + actions.length * 12;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let at = 0;
  dv.setUint32(at, pathBytes.length, true); at += 4;
  out.set(pathBytes, at); at += pathBytes.length;
  dv.setUint32(at, argvBytes.length, true); at += 4;
  for (const a of argvBytes) {
    dv.setUint32(at, a.length, true); at += 4;
    out.set(a, at); at += a.length;
  }
  dv.setUint32(at, actions.length, true); at += 4;
  for (const act of actions) {
    dv.setUint32(at, act.op >>> 0, true); at += 4;
    dv.setInt32(at, act.a | 0, true); at += 4;
    dv.setInt32(at, act.b | 0, true); at += 4;
  }
  return out;
}

/** Null for ANY malformed input, and never a throw: see the codec's note. */
export function decodeSpawnRequest(bytes) {
  const dec = new TextDecoder("utf-8", { fatal: false });
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (at, n) => at + n <= bytes.length;
  let at = 0;
  if (!need(at, 4)) return null;
  const pathLen = dv.getUint32(at, true); at += 4;
  if (pathLen === 0 || !need(at, pathLen)) return null;
  const path = dec.decode(bytes.subarray(at, at + pathLen)); at += pathLen;
  if (path.includes("\0")) return null;
  if (!need(at, 4)) return null;
  const argc = dv.getUint32(at, true); at += 4;
  // A bound, not a guess: argv is carried in one 64 KiB byte region, so an argc past what could
  // fit is a malformed request rather than a large one.
  if (argc > 4096) return null;
  const argv = [];
  for (let i = 0; i < argc; i += 1) {
    if (!need(at, 4)) return null;
    const n = dv.getUint32(at, true); at += 4;
    if (!need(at, n)) return null;
    argv.push(dec.decode(bytes.subarray(at, at + n))); at += n;
  }
  if (!need(at, 4)) return null;
  const nActions = dv.getUint32(at, true); at += 4;
  if (nActions > 1024) return null;
  const actions = [];
  for (let i = 0; i < nActions; i += 1) {
    if (!need(at, 12)) return null;
    const op = dv.getUint32(at, true); at += 4;
    const a = dv.getInt32(at, true); at += 4;
    const b = dv.getInt32(at, true); at += 4;
    if (op !== SPAWN_DUP2 && op !== SPAWN_CLOSE) return null;
    // A ceiling on both, not just a sign check: an unbounded target fd grows the child's fd array
    // without limit (see OPEN_MAX).
    if (a < 0 || a >= OPEN_MAX) return null;
    if (op === SPAWN_DUP2 && (b < 0 || b >= OPEN_MAX)) return null;
    actions.push({ op, a, b });
  }
  return { path, argv, actions };
}

/**
 * ONE place, because the kernel writes it and the process reads it.
 *
 * `cc` is a 20-byte array at `TRM_CC` (Linux's NCCS). The three reserved flag words and the unused
 * cc slots ARE PRESERVED across a round trip: a caller built against today's three `lflag` bits
 * must not silently clear a bit a later flag claims, so `tty_set` reads the whole word and the
 * whole array rather than the fields it understands.
 */
export function encodeTermios(dv, off, tm) {
  dv.setUint32(off + TRM_IFLAG, tm.iflag >>> 0, true);
  dv.setUint32(off + TRM_OFLAG, tm.oflag >>> 0, true);
  dv.setUint32(off + TRM_CFLAG, tm.cflag >>> 0, true);
  dv.setUint32(off + TRM_LFLAG, tm.lflag >>> 0, true);
  for (let i = 0; i < TRM_NCCS; i += 1) {
    dv.setUint8(off + TRM_CC + i, (tm.cc[i] || 0) & 0xff);
  }
}

export function decodeTermios(dv, off) {
  const cc = new Uint8Array(TRM_NCCS);
  for (let i = 0; i < TRM_NCCS; i += 1) cc[i] = dv.getUint8(off + TRM_CC + i);
  return {
    iflag: dv.getUint32(off + TRM_IFLAG, true),
    oflag: dv.getUint32(off + TRM_OFLAG, true),
    cflag: dv.getUint32(off + TRM_CFLAG, true),
    lflag: dv.getUint32(off + TRM_LFLAG, true),
    cc,
  };
}

/** A fresh pty's termios: canonical, echoing, signal-generating — POSIX's own defaults. */
export function defaultTermios() {
  const cc = new Uint8Array(TRM_NCCS);
  cc[VINTR] = TRM_DEF_INTR;
  cc[VQUIT] = TRM_DEF_QUIT;
  cc[VERASE] = TRM_DEF_ERASE;
  cc[VKILL] = TRM_DEF_KILL;
  cc[VEOF] = TRM_DEF_EOF;
  cc[VSUSP] = TRM_DEF_SUSP;
  // VMIN 1 / VTIME 0 is "return as soon as one byte is available", which is what the non-canonical
  // path here does. Carried because docs/ABI.md requires the fields; NO BEHAVIOUR READS THEM.
  cc[VMIN] = 1;
  cc[VTIME] = 0;
  return { iflag: 0, oflag: 0, cflag: 0, lflag: ISIG | ICANON | ECHO, cc };
}

export function encodeWinsize(dv, off, ws) {
  dv.setUint16(off + WS_ROWS, ws.rows & 0xffff, true);
  dv.setUint16(off + WS_COLS, ws.cols & 0xffff, true);
  dv.setUint16(off + WS_XPIXEL, (ws.xpixel || 0) & 0xffff, true);
  dv.setUint16(off + WS_YPIXEL, (ws.ypixel || 0) & 0xffff, true);
}

export function decodeWinsize(dv, off) {
  return {
    rows: dv.getUint16(off + WS_ROWS, true),
    cols: dv.getUint16(off + WS_COLS, true),
    xpixel: dv.getUint16(off + WS_XPIXEL, true),
    ypixel: dv.getUint16(off + WS_YPIXEL, true),
  };
}

/**
 * Derivation and shape assertions, run at module load in both agents. They fire on the change that
 * breaks them rather than leaving a wrong number to be found by a wrong reply months later.
 */
export function selfTest() {
  const fail = (why) => {
    throw new Error(`abi.mjs selfTest: ${why}`);
  };
  // docs/ABI.md publishes MAX_INLINE = 65404 B. If this fires, the derivation and the document
  // have parted company and one of them is wrong.
  if (MAX_INLINE !== 65404) fail(`MAX_INLINE derived ${MAX_INLINE}, docs/ABI.md says 65404`);
  if (LEN_I32 * 4 !== BYTE_OFF) fail("the length word is not at BYTE_OFF");
  if (DATA_OFF !== BYTE_OFF + 4) fail("the byte payload does not start after the length word");
  if (DATA_OFF + MAX_INLINE !== SAB_BYTES) fail("a MAX_INLINE payload does not fit the SAB");
  if (R1 >= LEN_I32 || KDOWN_MS >= LEN_I32 || IDLE_PARK >= LEN_I32
      || H_VERSION >= LEN_I32) {
    fail("the register file overlaps the byte region");
  }
  if (IDLE_PARK === KDOWN_SEEN || IDLE_PARK === KDOWN_MS) fail("IDLE_PARK aliases a live word");
  if (H_MAGIC === IDLE_PARK || H_VERSION === IDLE_PARK || H_MAGIC === H_VERSION
      || H_MAGIC === KDOWN_SEEN || H_MAGIC === KDOWN_MS
      || H_VERSION === KDOWN_SEEN || H_VERSION === KDOWN_MS) {
    fail("H_MAGIC/H_VERSION alias a live word");
  }
  if ((SAB_MAGIC | 0) === 0) fail("SAB_MAGIC must be non-zero so a fresh SAB fails the check");
  if (SAB_VERSION < 1) fail("SAB_VERSION must be at least 1");
  if (G_DEADLINE_HI * 4 >= GLOBAL_BYTES) fail("a globals word is past the end of the globals SAB");
  if (W_PRE !== 0) fail("W_PRE must be 0: a fresh globals SAB is all zeroes and that is pre-window");
  if (new Set([W_PRE, W_OPEN, W_CLOSED, W_DONE]).size !== 4) {
    fail("the window states are not distinct");
  }
  if (A7 - A0 !== 7) fail("a0..a7 is not eight contiguous words");
  if (NR === CALLID || NR === UID || NR >= A0) fail("NR collides with a documented word");
  if (nextCallId(CALLID_WRAP) !== 1 || nextCallId(0) !== 1) fail("CALLID does not wrap to 1");
  if (SAB_BYTES % 4 !== 0 || GLOBAL_BYTES % 4 !== 0) fail("a SAB size is not i32-aligned");
  if (SYS_NAME.length !== NSYS) fail(`SYS_NAME has ${SYS_NAME.length} names for ${NSYS} calls`);
  if (ERRNO_NAMES.length !== 77) fail(`errno table has ${ERRNO_NAMES.length} rows, not 77`);
  if (new Set(ERRNO_NAMES).size !== 77) fail("errno names are not unique");
  if (ERRNO_NAMES.some((n) => !n)) fail("errno table has a hole");
  if (E.ESUCCESS !== 0 || E.ENOTCAPABLE !== 76) fail("errno table endpoints moved");
  if (E.EHOSTGONE !== 100) fail("EHOSTGONE is not 100");

  // The named errnos must BE the errnos they are named for, so neither a derivation nor a future
  // literal can drift from the table.
  if (ELIMIT_ERRNO !== E.ENOBUFS) fail("ELIMIT_ERRNO is not ENOBUFS");
  if (TEARDOWN_ERRNO !== E.ECONNABORTED) fail("TEARDOWN_ERRNO is not ECONNABORTED");
  if (ERRNO_NAMES[ELIMIT_ERRNO] !== "ENOBUFS") {
    fail(`errno ${ELIMIT_ERRNO} is ${ERRNO_NAMES[ELIMIT_ERRNO]}, not ENOBUFS`);
  }
  if (ERRNO_NAMES[TEARDOWN_ERRNO] !== "ECONNABORTED") {
    fail(`errno ${TEARDOWN_ERRNO} is ${ERRNO_NAMES[TEARDOWN_ERRNO]}, not ECONNABORTED`);
  }
  for (const [name, value] of Object.entries({
    EAGAIN, EBADF, EINTR, EINVAL, EIO, ENOSYS, ENOTSUP, EPERM, ESRCH, EPIPE,
  })) {
    if (ERRNO_NAMES[value] !== name) fail(`${name} does not index back to itself`);
  }
  // KNOWN-ANSWER VECTORS for the shared hash, from http://www.isthe.com/chongo/tech/comp/fnv/.
  // The whole protection the kernel-side and process-side checksums have: they are ONE
  // implementation, so a bug in it cancels out on both sides and the byte-exactness check passes
  // while transferring nothing. An external constant cannot cancel out.
  if (fnv1aString("") !== 0x811c9dc5) fail(`FNV-1a("") is ${fnv1aString("")}, not the offset basis`);
  if (fnv1aString("a") !== 0xe40c292c) fail(`FNV-1a("a") is ${fnv1aString("a")}, not 0xe40c292c`);
  if (fnv1aString("foobar") !== 0xbf9cf968) {
    fail(`FNV-1a("foobar") is ${fnv1aString("foobar")}, not 0xbf9cf968`);
  }
  // The byte-wise entry point must agree with the string one over the same bytes, or the sink and
  // the process are hashing with two different functions again.
  const bytes = new Uint8Array([0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72]);
  if (fnv1a(bytes, 0, 6) !== 0xbf9cf968) fail("fnv1a over bytes disagrees with fnv1aString");
  if (fnv1a(bytes, 3, 3, fnv1a(bytes, 0, 3)) !== 0xbf9cf968) fail("fnv1a does not chain by seed");

  // The Filestat record must fit its published size with no field overlapping another, and must
  // round-trip: a mode bit lost in the codec is one the 10k-file proof cannot observe, and the
  // proof would pass by comparing two copies of the same mistake.
  const fields = [
    [FST_DEV, 8], [FST_INO, 8], [FST_MODE, 4], [FST_NLINK, 4], [FST_UID, 4], [FST_GID, 4],
    [FST_SIZE, 8], [FST_ATIM, 8], [FST_MTIM, 8], [FST_CTIM, 8],
  ];
  let covered = 0;
  for (const [at, width] of fields) {
    if (at % width !== 0) fail(`Filestat field at ${at} is not ${width}-byte aligned`);
    if (at + width > FILESTAT_BYTES) fail(`Filestat field at ${at} runs past the record`);
    covered += width;
  }
  if (covered !== FILESTAT_BYTES) fail(`Filestat fields cover ${covered} of ${FILESTAT_BYTES} B`);
  const probe = new DataView(new ArrayBuffer(FILESTAT_BYTES));
  const want = {
    dev: 0n, ino: 0x1_0000_0003n, mode: S_IFREG | 0o754, nlink: 2, uid: 1000, gid: 1001,
    size: 0x1_0000_0007n, atimeNs: 1n, mtimeNs: 0x7fff_ffff_ffffn, ctimeNs: 3n,
  };
  encodeFilestat(probe, 0, want);
  const round = decodeFilestat(probe, 0);
  for (const key of Object.keys(want)) {
    if (round[key] !== want[key]) fail(`Filestat ${key} round-trips as ${round[key]}`);
  }
  if ((round.mode & S_IFMT) !== S_IFREG) fail("Filestat loses the S_IFMT type bits");
  if ((round.mode & 0o7777) !== 0o754) fail("Filestat loses the permission bits");
  if (new Set([S_IFREG, S_IFDIR, S_IFLNK]).size !== 3) fail("the S_IF* type bits are not distinct");
  for (const bit of [S_IFREG, S_IFDIR, S_IFLNK]) {
    if ((bit & S_IFMT) !== bit) fail("an S_IF* bit is outside S_IFMT");
  }
  if ((O_RDONLY & O_ACCMODE) !== 0 || (O_WRONLY & O_ACCMODE) !== O_WRONLY
      || (O_RDWR & O_ACCMODE) !== O_RDWR) {
    fail("O_ACCMODE does not mask the three access modes");
  }
  if (new Set([SEEK_SET, SEEK_CUR, SEEK_END]).size !== 3) fail("the seek whences are not distinct");
  // Constraint 48 is a comparison, not a number: the budget must exceed constraint 55's measured
  // ~2.0 s terminate abort grace, or a normal reload comes up read-only at random.
  if (BOOT_LOCK_BUDGET_MS <= 2051) {
    fail(`the boot-lock budget ${BOOT_LOCK_BUDGET_MS} ms does not exceed the 2,051 ms worst `
      + "terminate abort grace measured in constraint 55");
  }
  if (BOOT_LOCK_FIRST_MS <= 0 || BOOT_LOCK_FIRST_MS >= BOOT_LOCK_BUDGET_MS) {
    fail("the boot-lock backoff must start inside its budget");
  }
  if (DIRENT_HEADER % 4 !== 0) fail("a dirent header that is not 4-byte aligned unaligns its u64");

  // The spawn codec round-trips, and REFUSES rather than throws. The refusal half is the
  // load-bearing one: this decodes process-controlled bytes in the kernel, and a throw there is a
  // process faulting the kernel.
  const spawnWant = {
    path: "/usr/bin/sh",
    argv: ["sh", "-c", "yes | head -1"],
    actions: [{ op: SPAWN_DUP2, a: 3, b: 1 }, { op: SPAWN_CLOSE, a: 3, b: 0 }],
  };
  const spawnRound = decodeSpawnRequest(encodeSpawnRequest(spawnWant));
  if (!spawnRound) fail("a well-formed spawn request did not decode");
  if (spawnRound.path !== spawnWant.path) fail("spawn path did not round-trip");
  if (spawnRound.argv.join("\u0000") !== spawnWant.argv.join("\u0000")) {
    fail("spawn argv did not round-trip");
  }
  if (spawnRound.actions.length !== 2 || spawnRound.actions[0].a !== 3
      || spawnRound.actions[0].b !== 1 || spawnRound.actions[1].op !== SPAWN_CLOSE) {
    fail("spawn file actions did not round-trip");
  }
  if (decodeSpawnRequest(new Uint8Array(0)) !== null) fail("an empty spawn request decoded");
  if (decodeSpawnRequest(new Uint8Array(3)) !== null) fail("a 3-byte spawn request decoded");
  const liar = new Uint8Array(8);
  new DataView(liar.buffer).setUint32(0, 999, true);
  if (decodeSpawnRequest(liar) !== null) fail("a spawn request with an over-long path decoded");
  const noPath = new Uint8Array(12);
  if (decodeSpawnRequest(noPath) !== null) fail("a spawn request with no path decoded");
  const badOp = encodeSpawnRequest({ path: "/x", argv: [], actions: [{ op: 99, a: 0, b: 0 }] });
  if (decodeSpawnRequest(badOp) !== null) fail("a spawn request with an unknown action decoded");
  const badFd = encodeSpawnRequest({ path: "/x", argv: [], actions: [{ op: SPAWN_DUP2, a: -1, b: 1 }] });
  if (decodeSpawnRequest(badFd) !== null) fail("a spawn request with a negative fd decoded");
  // The ceiling at both ends: an unbounded target fd grows a child's fd array to a billion entries
  // that the kernel then sweeps twice.
  const hugeTo = encodeSpawnRequest({
    path: "/x", argv: [], actions: [{ op: SPAWN_DUP2, a: 1, b: 1 << 30 }],
  });
  if (decodeSpawnRequest(hugeTo) !== null) fail("a spawn action past OPEN_MAX decoded");
  const hugeFrom = encodeSpawnRequest({
    path: "/x", argv: [], actions: [{ op: SPAWN_CLOSE, a: OPEN_MAX, b: 0 }],
  });
  if (decodeSpawnRequest(hugeFrom) !== null) fail("a spawn close at OPEN_MAX decoded");
  // The termios record must fit its published size with no field overlapping another, and must
  // round-trip EVERY byte — including the three reserved flag words and the unused cc slots,
  // because `tty_set` preserving them is what stops an old caller clearing a new flag.
  if (TRM_CC + TRM_NCCS > TERMIOS_BYTES) fail("the termios cc array runs past the record");
  if (new Set([TRM_IFLAG, TRM_OFLAG, TRM_CFLAG, TRM_LFLAG]).size !== 4) {
    fail("two termios flag words share an offset");
  }
  if (TRM_LFLAG + 4 > TRM_CC) fail("the lflag word overlaps the cc array");
  const tprobe = new DataView(new ArrayBuffer(TERMIOS_BYTES));
  const twant = defaultTermios();
  twant.iflag = 0xdeadbeef; twant.oflag = 0x12345678; twant.cflag = 0xfeedface;
  twant.cc[19] = 0xab;
  encodeTermios(tprobe, 0, twant);
  const tround = decodeTermios(tprobe, 0);
  for (const key of ["iflag", "oflag", "cflag", "lflag"]) {
    if (tround[key] !== twant[key] >>> 0) fail(`termios ${key} round-trips as ${tround[key]}`);
  }
  for (let i = 0; i < TRM_NCCS; i += 1) {
    if (tround.cc[i] !== twant.cc[i]) fail(`termios cc[${i}] round-trips as ${tround.cc[i]}`);
  }
  const tdef = defaultTermios();
  if (!(tdef.lflag & ISIG) || !(tdef.lflag & ICANON) || !(tdef.lflag & ECHO)) {
    fail("a fresh pty must come up canonical, echoing and signal-generating");
  }
  if (tdef.cc[VINTR] !== 3) fail("VINTR must default to ^C");
  if (new Set([VINTR, VQUIT, VERASE, VKILL, VEOF, VTIME, VMIN, VSUSP]).size !== 8) {
    fail("two cc indices collide");
  }
  if (new Set([ISIG, ICANON, ECHO]).size !== 3) fail("two lflag bits collide");
  if ((ISIG & ICANON) || (ISIG & ECHO) || (ICANON & ECHO)) fail("the lflag bits are not disjoint");

  const wprobe = new DataView(new ArrayBuffer(WINSIZE_BYTES));
  encodeWinsize(wprobe, 0, { rows: 24, cols: 80, xpixel: 640, ypixel: 480 });
  const wround = decodeWinsize(wprobe, 0);
  if (wround.rows !== 24 || wround.cols !== 80 || wround.xpixel !== 640 || wround.ypixel !== 480) {
    fail(`winsize round-trips as ${JSON.stringify(wround)}`);
  }
  if (WS_YPIXEL + 2 !== WINSIZE_BYTES) fail("winsize fields do not fill the record");

  // poll's pollfd, whose shape docs/ABI.md publishes.
  if (PFD_FD + 4 !== PFD_EVENTS || PFD_EVENTS + 2 !== PFD_REVENTS) {
    fail("the pollfd fields are not contiguous");
  }
  if (PFD_REVENTS + 2 !== POLLFD_BYTES) fail("a pollfd is not 8 bytes");
  const pollBits = [POLLIN, POLLOUT, POLLERR, POLLHUP, POLLNVAL];
  if (new Set(pollBits).size !== 5) fail("two poll bits collide");
  for (const b of pollBits) {
    if ((b & (b - 1)) !== 0) fail(`poll bit ${b} is not a single bit`);
  }
  if (TIOCGPGRP === TIOCSPGRP) fail("the two ioctl requests are not distinct");

  if (PIPE_CAPACITY <= MAX_INLINE) {
    fail(`a pipe capacity of ${PIPE_CAPACITY} cannot hold one maximal ${MAX_INLINE} B write`);
  }

  // The signal table, BOTH WAYS, because the hazard is a signal added to INTS and not to it.
  for (const [name, n] of Object.entries(SIGNALS)) {
    if (INTS[`SIG${name}`] !== n) fail(`SIGNALS.${name} is ${n}, not INTS.SIG${name}`);
    if (SIGNAL_NAME[n] !== name) fail(`signal ${n} does not name itself back`);
  }
  // `SIGPEND` is a WORD INDEX and `SIG_BIT`/`SIG_DFL`/`SIG_IGN`/`SIG_HANDLE` are not signals.
  // Every other SIG-prefixed integer must be in the table.
  const NOT_SIGNALS = new Set(["SIGPEND", "SIG_DFL", "SIG_IGN", "SIG_HANDLE"]);
  for (const key of Object.keys(INTS)) {
    if (!key.startsWith("SIG") || NOT_SIGNALS.has(key)) continue;
    if (SIGNAL_NAME[INTS[key]] === undefined) {
      fail(`${key} is a signal INTS declares and SIGNALS does not carry`);
    }
  }
  if (signalOf("9") !== SIGKILL || signalOf("KILL") !== SIGKILL
      || signalOf("sigkill") !== SIGKILL || signalOf(SIGKILL) !== SIGKILL) {
    fail("signalOf does not accept a number, a name and a SIG-prefixed name alike");
  }
  if (signalOf("NOPE") !== null || signalOf("") !== null || signalOf("0") !== null
      || signalOf(99) !== null || signalOf(null) !== null) {
    fail("signalOf accepted something that is not a signal");
  }

  if (!ABI_FINGERPRINT) fail("fingerprint is zero");
  return ABI_FINGERPRINT;
}

selfTest();
