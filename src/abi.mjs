// The ABI: every integer the kernel and a process must agree on, and four pure codecs.
//
// A departure from CLAUDE.md's src/kernel | src/libos | src/wm layout, recorded where the reader
// meets it: this module sits above all three because both sides of the trust boundary import it,
// and it is one file rather than a src/abi/ directory because a directory for one file invites a
// second file with behaviour in it.
//
// STANDING RULE. Nothing here may close over a capability, read a global other than TypedArray
// and Atomics arithmetic, or perform I/O. That rule is why a process may import it at all: a
// process that imports this module gains no reach it did not already have.
//
// Every integer lives in INTS, once, and is re-exported by destructuring. Two copies hand-synced
// across the kernel/process boundary is the defect CLAUDE.md names explicitly, so there is no
// second place to write one.

const SAB_BYTES_ = 65536;
const BYTE_OFF_ = 128;

const INTS = {
  // i32 indices into the per-process control region, transcribed once from docs/ABI.md
  // "The transport". 7 is free; 18..31 are reserved.
  SEQ: 0,
  STATUS: 1,
  RLEN: 2,
  SIGPEND: 3,
  // CALLID is a PER-CALL UNIQUE value, monotonic per process, wrapping at 2^31 — not the syscall
  // number. docs/ABI.md names i32[4] CALLID and separately drops a late reply "by CALLID", and
  // those two readings are incompatible: a syscall NUMBER cannot tell two consecutive read()s
  // apart, which is exactly the case cancellation creates. Interrupt a read, the caller retries
  // read, and a late reply to the first must not be taken for the second.
  CALLID: 4,
  UID: 5,
  // The syscall number, in its own word. i32[6] and i32[7] are unused in the documented layout.
  // Deliberately NOT packed with a sequence into one i32: a 16-bit sequence wraps about once a
  // second under saturation, and an aliased stale reply is the bug CALLID exists to prevent.
  NR: 6,
  A0: 8, A1: 9, A2: 10, A3: 11, A4: 12, A5: 13, A6: 14, A7: 15,
  R0: 16, R1: 17,
  // Two of the reserved words 18..31, claimed for the one fact a process must be able to state
  // after its kernel has gone: that it noticed. When the kernel worker is terminated or its
  // thread wedges, the port is the thing that died, so a process cannot report through it — and
  // without these words the whole heartbeat branch is untested code sitting in the hot path,
  // which is worse than no branch at all. A supervisor (M1) reads them off the SAB it still
  // holds; the kernel-dead control reads them to assert N of N faulted inside
  // REARM_MS x (HB_MISS_LIMIT + 1).
  KDOWN_SEEN: 18,
  KDOWN_MS: 19,
  // A third reserved word, claimed for the one thing a process cannot otherwise do: idle without
  // a syscall. NOTHING EVER WRITES OR NOTIFIES IT, so an Atomics.wait on it always times out,
  // which is a genuinely idle sleep that releases the core. The rate-limited control needs that:
  // a performance.now() busy-spin in N processes starves the kernel and raises the very latency
  // the control is supposed to leave alone.
  IDLE_PARK: 20,

  // A scratch word a PROGRAM may advance and the page may read, so a test can observe that a
  // process reached a particular phase without asking it to make a syscall. M1's proof (e) needs
  // exactly that: it must raise a signal while the process is computing, and a process that had
  // to report its progress by syscall would be in a syscall when the signal arrived.
  // Kernel-neutral: nothing in src/kernel reads or writes it.
  P_PROGRESS: 21,

  // M1, item (f). The SAB frame header carries a MAGIC and a VERSION, four bytes each, written
  // once by the kernel at spawn and asserted once by the libos at init. Four bytes impossible to
  // retrofit later — AROS's ABI v1 break was ten years of forks on representation decisions that
  // were cheaper to pin here than to grow around. Two reserved words, nothing else moves.
  H_MAGIC: 22,
  H_VERSION: 23,

  // The one variable-length argument: byte 128, laid out [u32 len][bytes].
  SAB_BYTES: SAB_BYTES_,
  BYTE_OFF: BYTE_OFF_,
  LEN_I32: BYTE_OFF_ >> 2,
  // The BYTES start after the length word, not at BYTE_OFF. Writing them at BYTE_OFF puts the
  // payload's first four bytes on top of the length the kernel is about to read, which is how
  // this was found: a 65,404-byte write came back -EINVAL because the kernel read the payload as
  // its own length. Derived, so the two sides cannot disagree about where the data starts.
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
  // M0a. These two exist to measure which half of OPFS holds the kernel thread, because the two
  // halves behave oppositely: createSyncAccessHandle returns a PROMISE, so its 495 us
  // (constraint 22) is awaited and the dispatch thread stays free, while the handle's own
  // write/flush are SYNCHRONOUS and flush is 260 us (constraint 23) of kernel thread nobody else
  // can use. open is therefore the cheap one to serve and fsync is the expensive one, which is the
  // reverse of how their raw costs read.
  SYS_open: 3,
  SYS_fsync: 4,
  // M1. Append-only, never renumber. 5..14 are the ten process calls of this milestone's build;
  // 15 is the perform() escape hatch (item (f)), reserved now so a future ABI growth has one
  // slot it can route a new call through without widening NSYS or shifting any number.
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
  // M2. Append-only, never renumbered. 16..21 are the fd group docs/ABI.md lists; 22..36 are the
  // path group. SYS_open keeps number 3 and gains its real signature (a0 = flags, a1 = mode, byte
  // region = path): M0a's flat-name open was the same call with the VFS missing underneath it, and
  // a second "open" would be two renderers of one fact.
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
  // M4. Append-only, never renumbered. `dup` and `dup2` above are M2's and the pipe work reuses
  // them rather than adding a second way to move an fd.
  SYS_pipe2: 39,
  NSYS: 40,

  // STATUS. 1 is a deliberate hole: docs/ABI.md decision 1 pins "sets STATUS=2" for the
  // interrupt case, and renumbering a published value is worse than a gap.
  ST_RETURN: 0,
  ST_INTR: 2,
  ST_KDOWN: 3,

  // File-description kinds. M0 registers F_SINK only; the rest are reserved by name so M2's
  // F_FILE and M4's pipes are rows in the ops table rather than a rewrite.
  //
  // M3 adds F_SYNTH: a description whose bytes are held in memory by the kernel, which is what
  // `/proc` and `/dev` hand back. It is a row in the same ops table, which is the property that
  // makes `read(2)` identical for a generated file and a real one — see src/kernel/files.mjs.
  // F_TMP is a WRITABLE in-memory description: /tmp's bytes live in a Map in the kernel, so
  // unlike F_SYNTH it accepts a write and unlike F_FILE it needs no handle and no round trip.
  F_SINK: 0, F_FILE: 1, F_PIPE_R: 2, F_PIPE_W: 3, F_TTY: 4, F_WIN: 5, F_SYNTH: 6, F_TMP: 7,

  // Constraint 17: the process table carries a hard cap. 128 is M0's; 1,000 is the design limit.
  PROC_CAP: 128,

  // CALLID wraps here rather than going negative: the word is an i32 and a negative callid would
  // compare unequal to the posted copy after the Atomics round trip sign-extends differently from
  // the >>> 0 a reader might apply.
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
  // The measured window, in one word, so a process has one thing to park on and the kernel's
  // dispatcher has one thing to test. W_PRE -> W_OPEN is the barrier release; W_OPEN -> W_CLOSED
  // is the FIRST process to reach the deadline. Both edges matter: without the first, the windows
  // are staggered and the first dispatch of each genuinely sees depth 1; without the second, the
  // ramp-down — processes stopping one by one — puts depth-1 samples in a saturated window.
  G_WINDOW: 8,
  // Arrivals at the barrier. The kernel releases when this reaches the spawned count.
  G_BARRIER: 9,
  // ONE deadline for the whole cell, as a (lo, hi) i32 pair over Date.now() milliseconds.
  // performance.now() cannot be used: timeOrigin differs per agent, so only DURATIONS cross an
  // agent boundary. Date.now() is the same clock in every agent in the renderer.
  G_DEADLINE_LO: 10,
  G_DEADLINE_HI: 11,

  // W_CLOSED is set by the first process to reach the deadline; W_DONE by the kernel once every
  // process has left. The gap between them is the only place a process may issue a call that is
  // outside the measured window, and it exists so the out-of-window checks — a 1 MiB write, a
  // 5 ms spin — cannot land inside another process's window and move its p99.
  W_PRE: 0, W_OPEN: 1, W_CLOSED: 2, W_DONE: 3,

  K_BOOT: 0, K_UP: 1, K_PANIC: 2,

  // docs/ABI.md: the DOM object behind a host fd was destroyed. 77..99 stay reserved for WASI.
  EHOSTGONE: 100,

  // ---- M1 ----------------------------------------------------------------------------------

  // The MAGIC the kernel writes into H_MAGIC and the libos asserts once at init. Four ASCII bytes
  // in little-endian — 'wSBO' — chosen because it is impossible to collide with an accidental
  // zero or an uninitialised memory pattern. If this ever has to change, do it by adding a second
  // magic next to this one, not by rewriting this.
  SAB_MAGIC: 0x4f425377,
  SAB_VERSION: 1,

  // Signals the kernel delivers through SIGPEND. One bit each, so SIGPEND is 32 signals wide.
  // POSIX numbers, not WASI's: the former is what every existing program expects.
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGABRT: 6,
  SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13,
  SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19,
  SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGWINCH: 28,

  // sigaction dispositions. SIG_DFL and SIG_IGN are handled by the kernel at delivery; SIG_HANDLE
  // tells the kernel "a handler exists in the process, set the bit and let it drain at syscall
  // entry".
  SIG_DFL: 0, SIG_IGN: 1, SIG_HANDLE: 2,

  // waitpid flags + status encoding. r1 carries the status; the kernel is the only writer of it,
  // because terminate() leaves the dying worker no way to report (item (c)).
  WNOHANG: 1,
  // r1 = (kind << 8) | (0..255). Kind separates a clean exit from a signal death because without
  // that distinction waitpid cannot tell "ran to completion with code 0" from "SIGKILL'd before
  // it could run" — identical from a process that is already gone.
  STAT_EXITED: 0,
  STAT_KILLED: 1,

  // The capability bitmask (item (a)). Named bits reserved for the credentials M6 narrows; M1
  // asserts only MONOTONICITY, so a widening after an initial narrowing must fail.
  CAP_ALL: -1,  // every bit set, as a 32-bit signed value — i.e. 0xffffffff as an i32

  // ---- M2 ----------------------------------------------------------------------------------

  // open(2) flags, LINUX's numeric values rather than WASI's oflags. The errno space is WASI's
  // (docs/ABI.md) because a wasi-libc binary needs no translation on the error path; the flag
  // space is Linux's because WASI splits "how to open" across oflags + fdflags + rights, and a
  // three-word open is the shape docs/ABI.md's `open(flags, mode)` already rejected.
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_ACCMODE: 3,
  O_CREAT: 0x40, O_EXCL: 0x80, O_TRUNC: 0x200, O_APPEND: 0x400,
  O_DIRECTORY: 0x10000, O_NOFOLLOW: 0x20000,

  SEEK_SET: 0, SEEK_CUR: 1, SEEK_END: 2,

  // POSIX's own NAME_MAX. Here rather than in src/fs/vfs.mjs because it CROSSES the boundary: the
  // kernel refuses a longer component with -ENAMETOOLONG and a program has to know what length it
  // is being refused for, so there is one declaration and vfs.mjs imports it.
  NAME_MAX: 255,

  // The POSIX file-type bits inside a mode word. The VFS stores the permission bits alone and
  // carries the type as a string; these are what fstat/stat publish, so a program can do
  // `(mode & S_IFMT) === S_IFDIR` the way it would anywhere else.
  S_IFMT: 0o170000, S_IFREG: 0o100000, S_IFDIR: 0o040000, S_IFLNK: 0o120000,

  // The Filestat record, 64 bytes as docs/ABI.md publishes. The FIELDS are not WASI's: WASI's
  // filestat has no mode, no uid and no gid, and constraint 29 turns on exactly those — a
  // credential per call is decoration if stat cannot report the bits it was checked against. The
  // size is kept at WASI's 64 so the published figure stands.
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

  // Per-fd in-flight budget (item (e)). Charged per fd — not per process, not per event source —
  // because the fd is already the unit `poll()` waits on (constraint 42) and the unit `close()`
  // releases. The errno is ENOBUFS: the published WASI number for "no buffer space", which is
  // what head-of-line blocking on one fd is. 64 is a budget, not a measurement: enough that no
  // normal caller sees it, few enough that one pathological caller cannot pin 64 KiB of kernel
  // state per fd. The invariant lives in the fd table; the number can be tuned.
  FD_INFLIGHT_CAP: 64,

  // ---- M4 ----------------------------------------------------------------------------------

  /**
   * One pipe's buffer, in bytes.
   *
   * NO DOCUMENT SPECIFIED THIS. 65536 is chosen because it is just above MAX_INLINE (65404), so a
   * single maximal write fits in an empty pipe and a caller never has to split a write the ABI
   * allowed it to make.
   *
   * NO ATOMIC-WRITE GUARANTEE IS CLAIMED, at any size. POSIX guarantees a write under `PIPE_BUF`
   * is atomic against other writers; this does not, and a caller needing atomicity must not infer
   * it from the name. Stated here because `PIPE_BUF` is the constant a reader expects to find and
   * its absence is the answer.
   *
   * A write that would exceed the remaining space blocks until a reader drains it. A write larger
   * than the whole capacity makes progress in pieces rather than deadlocking.
   */
  PIPE_CAPACITY: 65536,

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
  SYS_dup, SYS_dup2, SYS_pipe2, NSYS,
  O_RDONLY, O_WRONLY, O_RDWR, O_ACCMODE, O_CREAT, O_EXCL, O_TRUNC, O_APPEND,
  O_DIRECTORY, O_NOFOLLOW, SEEK_SET, SEEK_CUR, SEEK_END, NAME_MAX,
  S_IFMT, S_IFREG, S_IFDIR, S_IFLNK,
  FST_DEV, FST_INO, FST_MODE, FST_NLINK, FST_UID, FST_GID, FST_SIZE,
  FST_ATIM, FST_MTIM, FST_CTIM, FILESTAT_BYTES,
  DT_UNKNOWN, DT_DIR, DT_REG, DT_LNK, DIRENT_HEADER,
  BOOT_LOCK_BUDGET_MS, BOOT_LOCK_FIRST_MS, JOURNAL_IDLE_MS,
  ST_RETURN, ST_INTR, ST_KDOWN,
  F_SINK, F_FILE, F_PIPE_R, F_PIPE_W, F_TTY, F_WIN, F_SYNTH, F_TMP,
  PROC_CAP, A_SHM, CALLID_WRAP,
  REARM_MS, HB_PERIOD_MS, HB_MISS_LIMIT,
  GLOBAL_BYTES, G_HEARTBEAT, G_HB_PERIOD_MS, G_KSTATE, G_EPOCH, G_INFLIGHT,
  G_THINK_US, G_STALL_US, G_READY, G_WINDOW, G_BARRIER, G_DEADLINE_LO, G_DEADLINE_HI,
  W_PRE, W_OPEN, W_CLOSED, W_DONE,
  K_BOOT, K_UP, K_PANIC,
  EHOSTGONE, SAB_MAGIC, SAB_VERSION,
  SIGHUP, SIGINT, SIGQUIT, SIGKILL, SIGUSR1, SIGUSR2, SIGPIPE, SIGALRM, SIGTERM,
  SIGCHLD, SIGCONT, SIGSTOP, SIGTSTP, SIGTTIN, SIGTTOU, SIGWINCH,
  SIG_DFL, SIG_IGN, SIG_HANDLE,
  WNOHANG, STAT_EXITED, STAT_KILLED,
  CAP_ALL, FD_INFLIGHT_CAP,
  PIPE_CAPACITY, SPAWN_DUP2, SPAWN_CLOSE,
} = INTS;

/**
 * Kernel-internal message kinds for the I/O worker. NOT integers, so they are not in INTS, and
 * NOT part of the process ABI: a process never sends one and never receives one. They are declared
 * here for the one reason anything is declared here — so the dispatch kernel and the I/O worker
 * cannot disagree about a string.
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
 * One blob's PHYSICAL length, from the handle that holds it.
 *
 * Not a measurement request: it is on the headline path. A file description holds no cached size,
 * so "how far do this generation's bytes reach" is asked of the blob at the point of use — and an
 * uncommitted append lives exactly there, in the committed generation above the size the metadata
 * publishes, where no number in the metadata names it.
 */
export const IO_SIZE = "io-size";
/** The storage edge's own counters and operation trace. A MEASUREMENT request: it performs no I/O,
 *  and it is what makes constraint 23's write ordering and constraint 24's one-directory-handle
 *  budget observable from a check rather than only readable in the code. */
export const IO_STATS = "io-stats";

/** How many trace entries the storage edge keeps. A ring: the sequence number survives it, so
 *  "this flush preceded that journal append" is a comparison of integers rather than of positions
 *  in an array a 10,000-file run would have overrun. */
export const IO_TRACE_KEEP = 512;

/**
 * The flat blob directory (constraint 26). One subdirectory of the OPFS root, names `<ino>.<gen>`.
 * Declared beside the I/O message kinds for the same reason they are: the dispatch kernel and the
 * I/O worker must not disagree about a string.
 */
export const BLOB_DIR = "blobs";

/** The journal file's name in the OPFS root. Its sync access handle IS the boot lock
 *  (constraint 48), so the name is agreed here rather than in the worker that holds it — a module
 *  that assigns `self.onmessage` is an entry point and must not be imported for a constant. */
export const JOURNAL_NAME = "journal";

/** The three superblock slots. THREE, not two, on Phantom's argument: against two alternating
 *  slots a bad write to the older one DURING a commit can leave zero valid copies. */
export const SUPER_SLOTS = Object.freeze(["sb.0", "sb.1", "sb.2"]);

/** Indexed by syscall number, so a number and its printed name cannot drift. The kernel reads
 *  this array at boot to derive its dispatch table and assert every declared call has a handler
 *  (item (f)): the dispatch table is DERIVED from this, not written separately. */
export const SYS_NAME = Object.freeze([
  "getpid", "write", "clock_nanosleep", "open", "fsync",
  "spawn", "exit", "waitpid", "kill", "sigaction", "setpgid",
  "sched_yield", "getppid", "getpgid", "setsid", "perform",
  "close", "read", "pread", "pwrite", "seek", "fstat", "ftruncate",
  "mkdir", "rmdir", "unlink", "rename", "symlink", "readlink", "link",
  "stat", "lstat", "chmod", "chown", "readdir", "truncate", "statfs",
  "dup", "dup2", "pipe2",
]);

// The WASI preview1 errno enum, dense 0..76, in its published order.
//
// THE DIFF WAS DONE, mechanically, not by eye: these 77 rows were generated from the
// `__WASI_ERRNO_*` macros in wasi-libc's wasip1.h at
// https://github.com/WebAssembly/wasi-libc/blob/3fa18af12545a4bf21011c28d64911ee9cf36315/libc-bottom-half/headers/public/wasi/wasip1.h
// (that header is wasi_snapshot_preview1.witx's own generated form), sorted by value, and
// asserted dense over 0..76 before being pasted here.
//
// selfTest() below asserts SHAPE only — length, uniqueness, density, the two endpoints. A shape
// test catches a dropped or duplicated row and CANNOT catch one value transcribed wrongly. What
// closes that hole is the generation step above, not the test.
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
// M2's path and fd group, by name. Every one is read off the table above rather than written as a
// number, so the single-copy rule holds for the errnos too.
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
/** M4. A program that resolved and is not a program this kernel can run. `spawn`'s answer, and
 *  deliberately not EIO: EIO says the storage failed, which is a different afternoon. */
export const ENOEXEC = E.ENOEXEC;
/** M4. The writer's half of docs/ABI.md decision 5: a write whose last reader went gets this AND
 *  SIGPIPE. Derived from the table like every other name here, never written as an index. */
export const EPIPE = E.EPIPE;
export const EOVERFLOW = E.EOVERFLOW;
/** Every operation on a file description whose inode is gone. POSIX has no errno for it because
 *  POSIX never reaches the state: it keeps an unlinked file alive until the last descriptor
 *  closes. M2 does not, so it refuses CONSISTENTLY under one name instead of answering some calls
 *  and failing others — see src/kernel/store.mjs `resolve`. */
export const ESTALE = E.ESTALE;

/**
 * The two errnos M1 gives a name to, DERIVED from the table rather than written as an index.
 *
 * Both were correct as literals — `ELIMIT_ERRNO: 42` really is ENOBUFS and `TEARDOWN_ERRNO: 13`
 * really is ECONNABORTED. They are derived anyway, because a literal index is a second place the
 * table's shape is recorded, and the first reader to re-check these by hand got it wrong in the
 * safe direction: off by one, because `ERRNO_NAMES` begins at ESUCCESS = 0 and has 77 entries.
 * Deriving removes the thing that has to be counted.
 */
export const ELIMIT_ERRNO = E.ENOBUFS;
export const TEARDOWN_ERRNO = E.ECONNABORTED;

/** Signals 1..31 occupy one bit each in SIGPEND. */
export function SIG_BIT(sig) {
  return 1 << (sig - 1);
}

// The four pure codecs. Total functions over integers, and nothing else.

/** docs/ABI.md "Errors": the Linux single-register convention, with one renderer of that fact. */
export function isErr(r0, r1) {
  return r0 < 0 && r1 === -1;
}

export function errOf(r0) {
  return -r0;
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
 * The Filestat codec, in ONE place because the kernel writes the record and the process reads it.
 * Pure over a DataView; it performs no I/O and names no capability, so a process may call it.
 *
 * `mode` carries the S_IF* type bits ORed with the permission bits, which is POSIX's own packing.
 * Times are nanoseconds since the epoch as BigInt: a millisecond Date.now() times 1e6 exceeds
 * 2^53 in 2255, but a u64 nanosecond field read as a double loses precision today, which is why
 * the pair is BigInt and not Number.
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
// compared. Two hand-synced implementations do not make that comparison independent — they drift
// together, and the check becomes a tautology that cannot fail. What protects it instead is a
// known-answer vector: selfTest() below pins this implementation against the published constants,
// so a bug here fails a check rather than cancelling out on both sides.
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
 * FNV-1a over the sorted `name=value` list of every integer above.
 *
 * The single-copy claim is then a measurement rather than an assertion: the page, the kernel and
 * every process report this, and the bench asserts they are all equal and non-zero. A stale or
 * second copy of this module shows up as a mismatch at boot instead of as a wrong errno later.
 */
export const ABI_FINGERPRINT = (() => {
  const rows = Object.keys(INTS).sort().map((k) => `${k}=${INTS[k]}`);
  rows.push(`SYS_NAME=${SYS_NAME.join(",")}`, `ERRNO=${ERRNO_NAMES.join(",")}`);
  return fnv1aString(rows.join(";"));
})();

/**
 * `spawn`'s request, as bytes. A FIFTH pure codec, here for the reason the other four are: the
 * process encodes it and the kernel decodes it, so there is one definition of the layout.
 *
 * Layout, little-endian, every length a u32:
 *   [u32 pathLen][path UTF-8]
 *   [u32 argc]  then argc x ([u32 len][UTF-8])
 *   [u32 nActions] then nActions x [u32 op][i32 a][i32 b]
 *
 * WHY A CODEC AND NOT JSON. The byte region is bytes and the kernel must not run a parser over
 * process-controlled input that can throw in a hundred places; a fixed layout with explicit
 * lengths fails in one place, on a length that does not fit, and `decodeSpawnRequest` returns null
 * rather than throwing. A kernel that threw on a malformed spawn would be a process faulting the
 * kernel, which is the defect class M3's review found three of.
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

/**
 * The inverse. Returns null for ANY malformed input — a short buffer, a length that runs past the
 * end, a path of zero bytes, an unknown action op. Null and not a throw: see the codec's note.
 */
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
    if (a < 0 || (op === SPAWN_DUP2 && b < 0)) return null;
    actions.push({ op, a, b });
  }
  return { path, argv, actions };
}

/**
 * Derivation and shape assertions, run at module load in both agents.
 *
 * Load-bearing: these fire on the change that breaks them rather than leaving a wrong number to
 * be discovered by a wrong reply six months later.
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
  // literal can drift from the table. 0 is ESUCCESS and the table has 77 entries, which is the
  // off-by-one every hand count here has made.
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
  // This is the whole protection the kernel-side and process-side checksums have: they are now
  // ONE implementation, so a bug in it would cancel out on both sides of the comparison and the
  // byte-exactness check would pass while transferring nothing. An external constant cannot
  // cancel out.
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

  // M2. The Filestat record must fit its published size with no field overlapping another, and
  // it must round-trip: a mode bit lost in the codec is a mode bit the 10k-file proof cannot
  // observe, and the proof would pass by comparing two copies of the same mistake.
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

  // M4. The spawn codec round-trips, and REFUSES rather than throws. The refusal half is the
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
  // A declared length that runs past the buffer.
  const liar = new Uint8Array(8);
  new DataView(liar.buffer).setUint32(0, 999, true);
  if (decodeSpawnRequest(liar) !== null) fail("a spawn request with an over-long path decoded");
  // A zero-length path.
  const noPath = new Uint8Array(12);
  if (decodeSpawnRequest(noPath) !== null) fail("a spawn request with no path decoded");
  // An unknown action op.
  const badOp = encodeSpawnRequest({ path: "/x", argv: [], actions: [{ op: 99, a: 0, b: 0 }] });
  if (decodeSpawnRequest(badOp) !== null) fail("a spawn request with an unknown action decoded");
  // A negative fd in an action.
  const badFd = encodeSpawnRequest({ path: "/x", argv: [], actions: [{ op: SPAWN_DUP2, a: -1, b: 1 }] });
  if (decodeSpawnRequest(badFd) !== null) fail("a spawn request with a negative fd decoded");
  if (PIPE_CAPACITY <= MAX_INLINE) {
    fail(`a pipe capacity of ${PIPE_CAPACITY} cannot hold one maximal ${MAX_INLINE} B write`);
  }

  if (!ABI_FINGERPRINT) fail("fingerprint is zero");
  return ABI_FINGERPRINT;
}

selfTest();
