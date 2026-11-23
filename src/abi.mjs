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
  // M7. THREE CALLS AND NOT A `/dev/wm` DEVICE FILE: M8 transfers an OffscreenCanvas out of
  // `win_create`, and a file write cannot transfer a handle (PLAN.md §5). A window's EVENTS travel
  // the other way, through `read(2)` on the fd these return, so `poll` needs no window-specific
  // wait (constraint 42).
  SYS_win_create: 48,
  SYS_win_destroy: 49,
  SYS_win_set: 50,
  // M8. The surface is KERNEL-OWNED and a process draws by sending a DISPLAY LIST, which is one
  // syscall per batch rather than one per operation. A transferred `OffscreenCanvas` was measured
  // first and rejected: it cannot reach a process that is spinning or parked in `Atomics.wait`,
  // so it cannot be the reply to the call that asked for it, and a surface given away can be
  // neither accounted nor revoked (constraint 219, `docs/DECISIONS.md` D31).
  SYS_win_surface: 51,
  SYS_win_draw: 52,
  // M9. RAISING IS THE KERNEL'S, because modality has to be ENFORCED and not drawn: a page that
  // owned the stack could be asked to put a window above the modal that blocks it, and would.
  // SerenityOS's server computes the blocker by walking the owner chain and suppresses input to
  // the blocked windows; this is the same division (constraint 226).
  SYS_win_raise: 53,
  // M10. THE TYPED DATA OBJECT, which is the clipboard and drag-and-drop both: one kernel-owned,
  // refcounted, format-tagged payload, reached through an fd. `clipboard_read`/`clipboard_write`
  // were in docs/ABI.md's host group taking BYTES with no format tag, and that is the ABI defect
  // `docs/designs/REVIEW-FINDINGS.md` §2 named — a receiver cannot tell a pasted PNG from a pasted
  // UTF-8 string, so they are DELETED rather than kept beside these (constraint 240).
  //
  // FIVE CALLS AND NOT THREE. `create`/`set`/`get` is what `PLAN.md` §5 costed; `offer` and `open`
  // are what makes the object reach another process at all — and they are two rather than four
  // because the clipboard and a drag differ only in WHERE the object was published, which is an
  // argument (constraint 240).
  SYS_dataobj_create: 54,
  SYS_dataobj_set: 55,
  SYS_dataobj_get: 56,
  SYS_dataobj_offer: 57,
  SYS_dataobj_open: 58,
  // M14. A WINDOW'S ITEM LIST: the rows a shell renders ON THIS WINDOW'S BEHALF — desktop icons,
  // a start-menu entry, a jump-list command. ONE call and one list, because the three differ only
  // in WHERE the shell puts them, which is a flag on each row (`WITEM_*`).
  //
  // WHY IT IS AN ABI CALL AND NOT A CONVENTION. The shell that draws them is page-side chrome
  // (`docs/DECISIONS.md` D39) and a process cannot reach the page except through the kernel, so a
  // program that wants a jump list has exactly one route — and the kernel bounds it: a count, a
  // label length, and a label the page sets as TEXT. Activation comes back as `WEV_ITEM` on the
  // window's own fd, which is the readiness the process is already parked on.
  SYS_win_items: 59,
  NSYS: 60,

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
  // M10. A DATA OBJECT IS A FILE DESCRIPTION for the reason a window is one: it is a kernel-owned
  // thing a process must be able to release, and `terminate()` offers no chance to finish — so the
  // fd table's existing refcount and teardown sweep are what free it (constraints 15, 241). It is
  // the one kind whose `read` and `write` are -EINVAL: an untyped read of a typed object is the
  // defect the whole milestone exists to remove (constraint 240).
  F_DATA: 9,

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

  // statfs: [u64 blocks][u64 bfree][u64 files][u64 ffree][u32 bsize][u32 namemax].
  SFS_BLOCKS: 0, SFS_BFREE: 8, SFS_FILES: 16, SFS_FFREE: 24, SFS_BSIZE: 32, SFS_NAMEMAX: 36,
  STATFS_BYTES: 40,

  // A readdir record: [u64 ino][u8 type][u8 nlen][u16 pad][char[] name], padded to 4 bytes.
  // docs/ABI.md's shape with the pad made explicit, because an unaligned u64 read is the kind of
  // defect that only shows up on a name of the wrong length.
  DT_UNKNOWN: 0, DT_DIR: 4, DT_REG: 8, DT_LNK: 10,
  DE_INO: 0, DE_TYPE: 8, DE_NLEN: 9,
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

  /**
   * M7's window event record. FIXED WIDTH, so a `read` that asks for fewer bytes than the ring
   * holds cannot split a record in half: the kernel floors every window read to a multiple of this
   * and refuses a shorter buffer. A variable-length record would need the reader to re-assemble a
   * header across two reads, which is the pty's problem and a pty has a line discipline to do it.
   */
  WEV_BYTES: 16,
  WEV_TYPE: 0, WEV_MODS: 2, WEV_A: 4, WEV_B: 8, WEV_C: 12,

  //: Event types. 0 is not used, so a record read out of a zeroed buffer is not a valid KEY event.
  //: KEY carries its UTF-8 bytes INLINE — `a` is the length 1..4 and `b` the bytes, little-endian —
  //: because a keystroke that needed a second read to collect its payload would be a second
  //: readiness edge for one key press.
  WEV_KEY: 1,
  WEV_RESIZE: 2,
  WEV_CLOSE: 3,
  WEV_FOCUS: 4,
  //: The destroy cascade: destroying a parent destroys its children, so ONE `win_destroy` closes
  //: SEVERAL windows and a process whose window was a child learns of it here. Without this event
  //: that process's fd table silently disagrees with the kernel's (MILESTONES, ordering correction).
  WEV_DESTROYED: 5,
  //: M8. A pointer inside the window's own surface, in SURFACE pixels — not CSS px and not page
  //: coordinates, because a process knows only its own surface. `a` and `b` are x and y, `c` is
  //: the button bitmask, and `mods` carries DOWN/UP/MOVE below beside the keyboard modifiers: one
  //: type rather than three, so a program that only wants movement need not know about the others.
  //:
  //: THE COORDINATES ARE SIGNED AND THE RECORD IS NOT. A capture keeps delivering moves after the
  //: pointer leaves the surface, so a negative x is the normal case — and `a` is a u32, which
  //: reads -7 back as 4,294,967,289. `pointerAt` below is the one place that is undone; a program
  //: that read `ev.a` directly and clamped it would get a wildly wrong answer (constraint 225).
  WEV_POINTER: 6,
  //: M10's drag events. FOUR AND NOT FIVE: there is NO `DRAG_OVER`, which every drag-and-drop API
  //: this one borrows from has, and the reason is arithmetic rather than taste. A drag is a pointer
  //: with a button down, so an OVER per motion sample streams at full rate — and `WIN_EVENT_CAP` is
  //: 256 records, about a second of moves (constraint 223). A target that only wanted the drop
  //: would fill its queue with OVER records and `push` drops the NEWEST, so THE DROP ITSELF would
  //: be the record discarded. Enter, leave and drop are edges, and there are at most three of them
  //: per target per gesture (constraint 243).
  //:
  //: ENTER and DROP carry the position in `a`,`b` and THE OFFER MASK in `c`, so a target can decide
  //: whether it can accept before any bytes exist — which is what a typed clipboard is for. The
  //: position's UNIT follows the window's content mode: surface pixels for a surfaced window, CELLS
  //: for a text one, which are the two units `WEV_POINTER` and `WEV_RESIZE` already use
  //: (constraint 248).
  WEV_DRAG_ENTER: 7,
  WEV_DRAG_LEAVE: 8,
  WEV_DROP: 9,
  //: To the SOURCE's window when the gesture ends: `a` is the effect that took place (0 for
  //: nothing), `b` the target winid or 0. Without it a MOVE source cannot know whether to delete
  //: what it moved.
  WEV_DRAG_DONE: 10,
  //: M14. THE SHOW STATE CHANGED: `a` is the new state, `b` the one it came from. An EVENT and not
  //: a query, for `WEV_FOCUS`'s reason — the process that wants to know is asleep in `poll`. A
  //: minimized window is told, because a program that keeps drawing into a surface nobody is
  //: showing is a program paying for pixels no reader sees.
  WEV_STATE: 11,
  //: M14. ONE OF THIS WINDOW'S PUBLISHED ITEMS WAS ACTIVATED: `a` is its INDEX in the list the
  //: window last published, `b` its flags, and `c` the `WITEM_*` bit saying WHERE it was activated
  //: from — a desktop icon, a start-menu row or a jump-list command are the same row in three
  //: places, and a program that cares can tell them apart.
  //:
  //: THE INDEX AND NOT A STRING, which is what keeps the page out of the program's business: the
  //: shell renders labels and returns a position, and what that position MEANS is the publisher's
  //: own array. The kernel validates the index against the list it is holding, so a page cannot
  //: name a row that does not exist.
  WEV_ITEM: 12,
  WEV_MAX: 12,

  //: `mods` on a WEV_POINTER. A move with no button held is a hover, which is the zero case.
  WPTR_DOWN: 0x10,
  WPTR_UP: 0x20,
  WPTR_MOVE: 0x40,

  //: Modifier bits on WEV_KEY, in `mods`. The widget translates Ctrl into a C0 byte, so these are
  //: for a reader that wants to know what was held, never for deriving the byte.
  WMOD_SHIFT: 0x1,
  WMOD_CTRL: 0x2,
  WMOD_ALT: 0x4,

  /** How many events one window queues before it drops them, counted and published in
   *  `/proc/<pid>/win/<winid>`. The per-fd bound constraint 42 requires — see src/kernel/wins.mjs.
   *  256 records is 4 KiB, the same order as the pty's input queue it sits beside. */
  WIN_EVENT_CAP: 256,

  //: `win_set`'s `what`. One call with a selector rather than four calls, because every one of them
  //: is "change a field of this window" and the kernel's answer is the same post to the page.
  WIN_SET_TITLE: 1,
  WIN_SET_BOX: 2,
  //: M9. a2 = the SCOPE, a3 = the BEHAVIOUR. Two axes and not one, which is the correction
  //: `MILESTONES.md`'s ordering note makes to M9's own plan: `modal ∈ {none,window,app,system}`
  //: describes WHICH windows are affected, and SerenityOS's enforced `WindowMode` describes WHAT
  //: happens to them. An owned window needs both (constraint 226).
  WIN_SET_MODAL: 3,
  //: M14. a2 = the SHOW STATE. Until M14 the window ABI had no state property at all, which is why
  //: `src/wm/window.mjs` drew minimize and maximize DISABLED: there was nothing to minimize into
  //: and no snap state to maximize to, and a live-looking button that silently did nothing is the
  //: defect. One selector, because this is "change a field of this window" like the three above it.
  WIN_SET_STATE: 4,
  //: M14. a2 = the ROLE. What a window IS to the shell, which is a different question from what it
  //: looks like: the desktop is a window at the bottom of the stack with no frame and no taskbar
  //: button, and nothing about that is expressible as geometry.
  WIN_SET_ROLE: 5,

  /**
   * THE SHOW STATE. Win32 calls it that (`ShowWindow`'s `SW_*`) and the name is worth keeping,
   * because "state" alone collides with the modality axes above and with the process state.
   *
   * THE KERNEL OWNS IT AND THE PAGE COMPUTES THE GEOMETRY FOR IT, which is the same division
   * `WIN_SET_BOX` already makes: only the kernel sees every area-changing call and owns the
   * z-order (constraints 49, 226), and only the page knows what the WORK AREA is — the desktop
   * minus whatever the shell has taken off it. So a state change is kernel-recorded, the page lays
   * the frame out for it, and the box comes back through `win-geom` like every other box.
   *
   * THE RESTORE BOX IS THE KERNEL'S, for the reason the state is: a maximized window that lost
   * where it came from is a window a user cannot put back, and the page is a renderer that may be
   * re-laid-out at any moment (`WinHost.relayout`).
   */
  WST_NORMAL: 0,
  //: Minimized: no frame on screen, no blurred area, and STILL A WINDOW — its fd is live, its
  //: events still queue, and its process is none the wiser except for the `WEV_STATE` it is told.
  WST_MIN: 1,
  //: Maximized to the WORK AREA. Not to the screen: a maximized window that covered the taskbar
  //: would be a window a user cannot get out from under.
  WST_MAX: 2,
  //: Aero Snap's two halves. A third and fourth value rather than a flag on MAX, because a snapped
  //: window restores to its own box and a maximized one does not stop being maximized when you
  //: drag it to an edge.
  WST_SNAP_L: 3,
  WST_SNAP_R: 4,
  WST_LIMIT: 4,

  /**
   * THE ROLE. What the shell does with this window, as a closed enum the kernel enforces.
   *
   * WHY THE KERNEL AND NOT A PAGE CONVENTION: a desktop window must be at the BOTTOM of the stack
   * and must stay there — that is the z-order, which is the kernel's (constraint 226) — and there
   * may be only one, which is a uniqueness the page cannot enforce against two processes that
   * cannot see each other.
   */
  WROLE_NORMAL: 0,
  //: The desktop surface: pinned to the bottom of the stack, no frame, no taskbar button, sized to
  //: the work area by the shell. Its `win_items` are the desktop's icons.
  WROLE_DESKTOP: 1,
  WROLE_LIMIT: 1,

  /**
   * THE SCOPE: which windows a modal window affects. Computed by walking the owner chain, so a
   * window with no owner can be system-modal and nothing else.
   */
  WMODAL_NONE: 0,
  //: Its OWNER only. A save dialog over the document it belongs to.
  WMODAL_WINDOW: 1,
  //: Every window of the owner's PROCESS. The owner's pid and not the dialog's: a picker broker's
  //: dialog is owned by the requesting app's window and runs in the broker, and it is the APP that
  //: must be blocked.
  WMODAL_APP: 2,
  //: Everything but itself and its own descendants. There is no second user, so this is the
  //: honest spelling of "nothing else may be touched until this is answered".
  WMODAL_SYSTEM: 3,
  WMODAL_MAX: 3,

  /**
   * THE BEHAVIOUR, SerenityOS's four values, which is the axis M9's plan was missing.
   * `docs/research/08-hobbyist-os-survey.md` carries the reference and the file it lives in.
   */
  //: Ordinary. Stacks and raises like anything else.
  WMODE_MODELESS: 0,
  //: Never takes the stack from its owner: a tooltip or a status bubble. It is raised WITH its
  //: owner and never above a sibling.
  WMODE_PASSIVE: 1,
  //: Always above its owner and does not block it — a palette or a toolbox.
  WMODE_RENDER_ABOVE: 2,
  //: Above its owner AND the owner cannot be raised over it. The only mode that refuses a raise.
  WMODE_BLOCKING: 3,
  WMODE_MAX: 3,

  //: `win_create` flags. A window with no owner passes 0 for the owner winid, which is why winids
  //: start at 1.
  WIN_F_NONE: 0,

  /**
   * M8's DISPLAY LIST OP. One fixed-width record, for the reason the event record is one: a batch
   * that could split an op in half would make the kernel's count and the page's replay disagree
   * about where the next op starts.
   *
   * 32 bytes: a u16 op, a u16 flags, and six i32 arguments. Six because the widest op — a line
   * with a colour and a width — needs x0, y0, x1, y1, rgba, width, and a seventh would double the
   * record for one case that does not exist.
   */
  DLOP_BYTES: 32,
  DL_OP: 0, DL_FLAGS: 2, DL_A0: 4, DL_A1: 8, DL_A2: 12, DL_A3: 16, DL_A4: 20, DL_A5: 24,
  //: A RESERVED WORD, written zero and preserved, which is the growth mechanism this ABI already
  //: uses for the termios flags it does not implement: a seventh argument can be added without
  //: changing the record size, and a record size that changes is a batch the two sides count
  //: differently. The encoder writes it; nothing reads it.
  DL_RESERVED: 28,

  //: The ops. 0 is not used, so a record read out of a zeroed buffer is not a valid op.
  //: EVERY COLOUR IS AN RGBA u32, 0xRRGGBBAA, which is the one place the colour encoding is
  //: declared — the page unpacks it in `src/wm/surface.mjs` and nowhere else.
  DL_CLEAR: 1,          // a0 = rgba. The whole surface.
  DL_FILL_RECT: 2,      // a0..a3 = x, y, w, h; a4 = rgba
  DL_STROKE_RECT: 3,    // a0..a3 = x, y, w, h; a4 = rgba; a5 = line width
  DL_LINE: 4,           // a0..a3 = x0, y0, x1, y1; a4 = rgba; a5 = line width

  /*
   * TEXT, AND WHY IT IS TWO OPS.
   *
   * CLAUDE.md said for four milestones that "a display list has no text op", and that sentence was
   * load-bearing in two arguments: why the taskbar is page-side (D39) and why a process cannot draw
   * a desktop. Both still hold — a shell needs hover, menus and a rubber band, none of which is a
   * drawing op. What did NOT hold is the consequence a reader hit: `files` could draw a row and not
   * its NAME, so the file manager was columns of coloured bars, and a task manager was unwritable.
   * A GUI whose windows cannot render a string cannot have a list in it.
   *
   * A RECORD IS 32 BYTES AND A STRING IS NOT. The three ways out were a string table appended to
   * the batch (changes the call's payload shape, and the kernel counts records), a kernel-side
   * intern table (new calls, new kernel state, a lifetime to get wrong), or CONTINUATION RECORDS.
   * The last one is additive: the batch is still a whole number of fixed-size ops, the kernel still
   * counts records without interpreting them, and `DL_MAX_OPS` already bounds how much text a
   * single call can carry (2,048 records — one header plus 24 bytes of UTF-8 each).
   *
   * `DL_TEXT` declares the run and `DL_TEXT_DATA` carries its bytes, in a0..a5 as six little-endian
   * u32 words — 24 bytes per record, `ceil(len / 24)` of them, immediately after the header. A
   * header whose data records are missing or short is REFUSED by the kernel rather than drawn
   * partially (constraint 293): half a filename is a filename, and a reader cannot tell it from the
   * real one.
   */
  DL_TEXT: 5,           // a0,a1 = x,y (TOP-left); a2 = px size; a3 = byte length; a4 = rgba
  DL_TEXT_DATA: 6,      // a0..a5 = 24 bytes of UTF-8, little-endian words
  DL_MAX: 6,

  //: `DL_TEXT`'s flags. A FAMILY AND AN ALIGNMENT, which is everything a list needs and nothing
  //: more: a column of numbers has to be right-aligned to be comparable, and a monospace run is
  //: how a size or a pid lines up at all. Bold is the one weight a caption or a header needs.
  DLT_BOLD: 1,
  DLT_MONO: 2,
  DLT_RIGHT: 4,
  DLT_CENTER: 8,

  /** How many ops one `win_draw` may carry. Derived from MAX_INLINE and the record size at the
   *  bottom of this file, never written as a number twice. */

  /**
   * THE SURFACE BUDGET, in device pixels, across every window of every process. M12's blur
   * governor is an admission controller over area (constraint 49) and constraint 17's process cap
   * exists because one renderer is shared — so the kernel refuses a surface it cannot account
   * rather than discovering the ceiling as a dead tab.
   *
   * 64 M px is just above the 58–63 M device-px wall gap-04 measured for compositing, so a run
   * that hits this budget is a run that was about to hit the real one. It is NOT the governor:
   * that admits and degrades, and this only refuses.
   */
  SURFACE_BUDGET_PX: 64 * 1024 * 1024,

  /** The largest single surface, in device pixels. A maximized window at dpr 2 is 3.69 M
   *  (constraint 49), so 16 M leaves room for a 4× one and refuses a typo. */
  SURFACE_MAX_PX: 16 * 1024 * 1024,

  /** Windows per process. A process that could create them without limit would exhaust the page's
   *  DOM the way an unbounded worker count exhausts the renderer (constraint 17's shape). */
  WIN_CAP: 32,

  /* ---- M14: a window's published items ------------------------------------------------------
   *
   * ONE LIST PER WINDOW, and the three places a shell shows it are a FLAG PER ROW rather than
   * three calls: a desktop icon, a start-menu row and a jump-list command are the same record in
   * three renderings, and "adding the next case is adding data, not editing logic" (`CLAUDE.md`).
   *
   * The record is `dirent`'s shape and for its reason: a fixed header, a variable name, and the
   * whole thing padded to 4 so the next header is aligned.
   */

  //: `[u16 icon][u16 flags][u16 label bytes][u16 reserved]`, then the label, then padding to 4.
  WITEM_HEADER: 8,
  WIT_ICON: 0, WIT_FLAGS: 2, WIT_LEN: 4, WIT_RESERVED: 6,

  /** Rows one window may publish. A list a shell has to draw is a list a reader has to read, and
   *  64 is already more than a Windows 7 jump list shows. A program with more has a window to put
   *  them in. */
  WIN_ITEM_CAP: 64,

  /** One label's bytes. Shorter than `NAME_MAX` on purpose: this is a caption on a 75-px icon,
   *  not a filename, and a 255-byte label is a label nothing can lay out. The publisher truncates
   *  — a refusal would make a long filename unpublishable. */
  WITEM_LABEL_MAX: 64,

  //: WHERE a row appears, as bits. A row may appear in more than one place, which is why these are
  //: bits and not an enum: `files` belongs on the desktop and in the start menu both.
  WITEM_DESKTOP: 0x1,
  WITEM_MENU: 0x2,
  WITEM_JUMP: 0x4,
  //: A rule, not a row: the label is ignored and the shell draws a separator. Windows 7's jump
  //: lists are grouped by them and a list without them reads as one undifferentiated column.
  WITEM_SEPARATOR: 0x8,
  //: This row is a CONTAINER — a directory. The shell may draw it differently; what it means is
  //: the publisher's business, because only the publisher knows what activating it does.
  WITEM_CONTAINER: 0x10,
  //: Drawn greyed and not activatable. Windows 7's own rule for an inapplicable command, which
  //: this project already follows for the caption buttons: a live-looking row that does nothing is
  //: the defect.
  WITEM_DISABLED: 0x20,
  WITEM_FLAGS_ALL: 0x3f,

  /**
   * THE ICON SET, as a closed dense table the PAGE draws and a PROGRAM chooses from.
   *
   * WHY AN ID AND NOT A PATH OR BYTES. Windows 7's icons cannot be shipped (constraint 37), so
   * every icon here is redrawn as vector art in `src/wm/icons.mjs` — and a process that named a
   * file would be asking the shell to load an image from the filesystem on its behalf, which is a
   * capability nothing needs. An id is a word in a register, the page owns the drawing, and a
   * program that wants pixels of its own has a surface.
   *
   * 0 IS A VALID ICON here, unlike an event type: a row that names nothing gets the generic one,
   * which is what a reader should see for a file nothing recognises.
   */
  WICON_GENERIC: 0,
  WICON_FOLDER: 1,
  WICON_TEXT: 2,
  WICON_IMAGE: 3,
  WICON_PROGRAM: 4,
  WICON_TERMINAL: 5,
  WICON_PAINT: 6,
  WICON_EDITOR: 7,
  WICON_FILES: 8,
  WICON_COMPUTER: 9,
  WICON_TRASH: 10,
  WICON_LIMIT: 10,

  /* ---- M12: the frame's chrome, because the KERNEL now has to account it -------------------
   *
   * These two are here and not in `src/wm/aero.mjs` for the reason everything else in this file is
   * here: they became a fact BOTH SIDES must agree on. Constraint 49 requires the blur governor to
   * account each glass element's BORDER BOX, and the governor is the kernel's — only the kernel
   * owns the z-order it degrades by (constraint 226) and only the kernel sees every area-changing
   * call. But the ring's geometry is the skin's. So the area function has to be one definition
   * imported by both, which is this file's whole job.
   *
   * THE CONSEQUENCE IS WORTH STATING: the kernel now knows a caption is 29 px tall. It is not
   * drawing one — `src/wm/aero.mjs` does, and imports these — but a second skin with different
   * chrome is a change to the ABI rather than to a stylesheet. That is the price of an admission
   * controller that accounts what the compositor really filters, and constraint 49 leaves no
   * cheaper way to pay it.
   */

  /** The caption strip's height, in CSS px. 7.css's measured Win7 caption. */
  WIN_CAP_H: 29,
  /** The left, right and bottom frame inset, in CSS px. 7.css's 6 px. */
  WIN_INSET: 6,

  /**
   * The blur governor's two edges, in BLURRED DEVICE PIXELS PER FRAME.
   *
   * A threshold on a continuous input must have hysteresis and both edges must be checked, so this
   * is a pair and not a number: glass goes flat above `BLUR_OFF_AT` and comes back below
   * `BLUR_ON_AT`. One threshold would oscillate for any desktop sitting on it — open a window,
   * flatten, which lowers the area, unflatten, which raises it.
   *
   * SOURCED, NOT CHOSEN. gap-04 measured the wall at 58–63 M device px per frame (constraint 36):
   * 120 fps held at 58 M and halved to 62 fps at 63 M. 45 M off / 36 M on are
   * `docs/designs/fidelity-first.md`'s own figures, quoted in `docs/designs/REVIEW-FINDINGS.md`
   * §3's correction, and they sit far enough below 58 M that a degrade happens before the cliff
   * rather than on it.
   *
   * MEASURED CONSEQUENCE, stated where the number is: under the four-strip ring M11 shipped, a
   * 640×440 window filters 109,040 device px, so `BLUR_OFF_AT` is 413 windows away — past
   * `WIN_CAP` × `PROC_CAP` in any realistic desktop. **This governor does not fire in normal use,
   * and that is a property of the geometry rather than of the threshold.** `bench/m12-governor/`
   * carries the sweep; `MILESTONES.md` M12 carries what it means.
   */
  BLUR_OFF_AT: 45 * 1000 * 1000,
  BLUR_ON_AT: 36 * 1000 * 1000,

  /**
   * M10's FORMATS. A CLOSED, DENSE TABLE AND NOT A REGISTRY, and the review that asked for this
   * asked for a registerable one — so the departure is stated here rather than discovered. The
   * reason is the OFFER: a drop target has to decide whether it can accept a payload during the
   * gesture, before any bytes exist, so the offer travels as ONE WORD in a register and in an event
   * record's `c` field. A bitmask of 31 formats is what fits there; a registry needs a call to
   * enumerate, which nothing yet has a use for (constraint 240).
   *
   * 0 IS NOT A FORMAT, so a zeroed register and an uninitialised event field are not one.
   */
  DOBJ_TEXT: 1,
  //: Windows' CF_HDROP, as this filesystem spells it: absolute paths, NUL-separated, no trailing
  //: NUL. The format that makes "drag a file" expressible at all.
  DOBJ_PATHS: 2,
  //: OPAQUE bytes of a PNG. The kernel does not decode it and neither does any program here — the
  //: point of a typed clipboard is that an unreadable format is REFUSED by name rather than pasted
  //: as a path (constraint 247).
  DOBJ_PNG: 3,
  //: Windows' CF_BITMAP: a `[u32 w][u32 h]` header and then w x h RGBA8 rows, top row first. The
  //: one image format anything here can actually RENDER, because a display list has no image op.
  DOBJ_BITMAP: 4,
  DOBJ_FMT_MAX: 4,

  //: The bitmap payload's header, declared where the format is. A second reader computing `8 +
  //: w*h*4` for itself is the drift this table exists to stop.
  BMP_W: 0, BMP_H: 4, BITMAP_HEADER: 8,

  /**
   * WHERE an object is published, and where one is opened FROM. ONE ENUM for both because the
   * clipboard is a value of each; `offer` refuses DROP and `open` refuses DRAG, by name, rather
   * than each call carrying half a table.
   */
  DOBJ_WHERE_CLIPBOARD: 1,
  DOBJ_WHERE_DRAG: 2,
  DOBJ_WHERE_DROP: 3,
  DOBJ_WHERE_MAX: 3,

  //: `dataobj_set`'s flags. Absent, a set REPLACES that format's bytes; with it, it appends — which
  //: is how a payload larger than one byte region is written, the same short-count loop `write(2)`
  //: uses (docs/ABI.md decision 4).
  DOBJ_F_APPEND: 1,

  //: The drop effects a source allows and a drop reports, as bits. There is no NEGOTIATION — a
  //: target cannot answer "I would take a copy but not a move" — because nothing here has two
  //: answers yet; see MILESTONES' M10 "what is not done".
  DOBJ_EFFECT_COPY: 1,
  DOBJ_EFFECT_MOVE: 2,

  /** One object's payload ceiling, over all its formats. -EFBIG above it: an object nothing can
   *  carry is a refusal and not a short count, because the formats are a SET and a half-written
   *  image is not a smaller image. */
  DOBJ_MAX_BYTES: 1024 * 1024,

  /** Every live object's payload, together. -ENOMEM above it, which is M8's budget argument applied
   *  to the other kernel-owned allocation: the kernel refuses what it cannot account rather than
   *  discovering the ceiling as a dead tab (constraint 246). */
  DOBJ_BUDGET_BYTES: 8 * 1024 * 1024,

  /** Live objects PER PROCESS, which is `WIN_CAP`'s shape and for its reason: a global cap would
   *  let one program's leak refuse every other program's copy, and a process that created them
   *  without limit would grow the kernel's own map the way an unbounded worker count grows the
   *  renderer (constraint 17's shape). */
  DOBJ_CAP: 32,

  /**
   * How long a drag session may go WITHOUT A POINTER REPORT before the kernel cancels it, releases
   * the payload and tells the source nothing happened.
   *
   * IT BOUNDS IDLE TIME AND NOT THE GESTURE, which is `term`'s correction applied before the same
   * bug happens here (constraint 239): a slow careful drag across a desktop is a gesture that lasts
   * as long as the user wants, and every motion sample re-arms this. What it catches is a session
   * whose pointer is GONE — a page that stopped reporting, a frame torn down mid-drag — because one
   * live session refuses the next with -EBUSY and a stuck one would refuse every drag for ever.
   */
  DRAG_IDLE_MS: 5000,

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
  SYS_poll, SYS_ioctl, SYS_chdir,
  SYS_win_create, SYS_win_destroy, SYS_win_set, SYS_win_surface, SYS_win_draw,
  SYS_win_raise,
  SYS_dataobj_create, SYS_dataobj_set, SYS_dataobj_get, SYS_dataobj_offer, SYS_dataobj_open,
  SYS_win_items,
  NSYS,
  O_RDONLY, O_WRONLY, O_RDWR, O_ACCMODE, O_CREAT, O_EXCL, O_TRUNC, O_APPEND,
  O_DIRECTORY, O_NOFOLLOW, SEEK_SET, SEEK_CUR, SEEK_END, NAME_MAX,
  S_IFMT, S_IFREG, S_IFDIR, S_IFLNK,
  FST_DEV, FST_INO, FST_MODE, FST_NLINK, FST_UID, FST_GID, FST_SIZE,
  FST_ATIM, FST_MTIM, FST_CTIM, FILESTAT_BYTES,
  SFS_BLOCKS, SFS_BFREE, SFS_FILES, SFS_FFREE, SFS_BSIZE, SFS_NAMEMAX, STATFS_BYTES,
  DT_UNKNOWN, DT_DIR, DT_REG, DT_LNK, DE_INO, DE_TYPE, DE_NLEN, DIRENT_HEADER,
  BOOT_LOCK_BUDGET_MS, BOOT_LOCK_FIRST_MS, JOURNAL_IDLE_MS,
  ST_RETURN, ST_INTR, ST_KDOWN,
  F_SINK, F_FILE, F_PIPE_R, F_PIPE_W, F_TTY, F_WIN, F_SYNTH, F_TMP, F_PTY_M, F_DATA,
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
  WEV_BYTES, WEV_TYPE, WEV_MODS, WEV_A, WEV_B, WEV_C,
  WEV_KEY, WEV_RESIZE, WEV_CLOSE, WEV_FOCUS, WEV_DESTROYED, WEV_MAX,
  WEV_DRAG_ENTER, WEV_DRAG_LEAVE, WEV_DROP, WEV_DRAG_DONE,
  WEV_STATE, WEV_ITEM,
  WST_NORMAL, WST_MIN, WST_MAX, WST_SNAP_L, WST_SNAP_R, WST_LIMIT,
  WROLE_NORMAL, WROLE_DESKTOP, WROLE_LIMIT,
  WITEM_HEADER, WIT_ICON, WIT_FLAGS, WIT_LEN, WIT_RESERVED,
  WIN_ITEM_CAP, WITEM_LABEL_MAX,
  WITEM_DESKTOP, WITEM_MENU, WITEM_JUMP, WITEM_SEPARATOR, WITEM_CONTAINER, WITEM_DISABLED,
  WITEM_FLAGS_ALL,
  WICON_GENERIC, WICON_FOLDER, WICON_TEXT, WICON_IMAGE, WICON_PROGRAM, WICON_TERMINAL,
  WICON_PAINT, WICON_EDITOR, WICON_FILES, WICON_COMPUTER, WICON_TRASH, WICON_LIMIT,
  DOBJ_TEXT, DOBJ_PATHS, DOBJ_PNG, DOBJ_BITMAP, DOBJ_FMT_MAX,
  BMP_W, BMP_H, BITMAP_HEADER,
  DOBJ_WHERE_CLIPBOARD, DOBJ_WHERE_DRAG, DOBJ_WHERE_DROP, DOBJ_WHERE_MAX,
  DOBJ_F_APPEND, DOBJ_EFFECT_COPY, DOBJ_EFFECT_MOVE,
  DOBJ_MAX_BYTES, DOBJ_BUDGET_BYTES, DOBJ_CAP, DRAG_IDLE_MS,
  WMOD_SHIFT, WMOD_CTRL, WMOD_ALT,
  WIN_EVENT_CAP, WIN_SET_TITLE, WIN_SET_BOX, WIN_SET_MODAL, WIN_SET_STATE, WIN_SET_ROLE,
  WIN_F_NONE, WIN_CAP,
  WMODAL_NONE, WMODAL_WINDOW, WMODAL_APP, WMODAL_SYSTEM, WMODAL_MAX,
  WMODE_MODELESS, WMODE_PASSIVE, WMODE_RENDER_ABOVE, WMODE_BLOCKING, WMODE_MAX,
  WEV_POINTER, WPTR_DOWN, WPTR_UP, WPTR_MOVE,
  DLOP_BYTES, DL_OP, DL_FLAGS, DL_A0, DL_A1, DL_A2, DL_A3, DL_A4, DL_A5, DL_RESERVED,
  DL_CLEAR, DL_FILL_RECT, DL_STROKE_RECT, DL_LINE, DL_TEXT, DL_TEXT_DATA, DL_MAX,
  DLT_BOLD, DLT_MONO, DLT_RIGHT, DLT_CENTER,
  SURFACE_BUDGET_PX, SURFACE_MAX_PX,
  WIN_CAP_H, WIN_INSET, BLUR_OFF_AT, BLUR_ON_AT,
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
  "win_create", "win_destroy", "win_set", "win_surface", "win_draw", "win_raise",
  "dataobj_create", "dataobj_set", "dataobj_get", "dataobj_offer", "dataobj_open",
  "win_items",
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
/** M8's surface budget refusal. A CEILING AND NOT A TRANSIENT, which is why it is not EAGAIN: a
 *  caller told to try again would try for ever (constraint 220). */
export const ENOMEM = E.ENOMEM;
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

/** statfs, both directions, so the kernel's writer and a process's reader cannot disagree.
 *  `bsize` is 1 on the durable volume, which makes `blocks` and `bfree` BYTES rather than blocks. */
export function encodeStatfs(dv, off, s) {
  dv.setBigUint64(off + SFS_BLOCKS, BigInt(s.blocks), true);
  dv.setBigUint64(off + SFS_BFREE, BigInt(s.bfree), true);
  dv.setBigUint64(off + SFS_FILES, BigInt(s.files), true);
  dv.setBigUint64(off + SFS_FFREE, BigInt(s.ffree), true);
  dv.setUint32(off + SFS_BSIZE, s.bsize >>> 0, true);
  dv.setUint32(off + SFS_NAMEMAX, s.namemax >>> 0, true);
}

export function decodeStatfs(dv, off) {
  return {
    blocks: dv.getBigUint64(off + SFS_BLOCKS, true),
    bfree: dv.getBigUint64(off + SFS_BFREE, true),
    files: dv.getBigUint64(off + SFS_FILES, true),
    ffree: dv.getBigUint64(off + SFS_FFREE, true),
    bsize: dv.getUint32(off + SFS_BSIZE, true),
    namemax: dv.getUint32(off + SFS_NAMEMAX, true),
  };
}

/** The byte length of one readdir record for a name of `nlen` bytes, padded to 4. Declared once
 *  because the writer walks forward by it and the reader walks forward by it. */
export function direntSize(nlen) {
  return (DIRENT_HEADER + nlen + 3) & ~3;
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
 * M7's window event record, declared once and used by the kernel that writes it, the libos that
 * decodes it and the host probe that checks it — the one-source-of-truth rule applied to the one
 * record that crosses the window boundary.
 *
 * `a` carries a UTF-8 LENGTH for a KEY event and a COORDINATE for a RESIZE, so the field is
 * unsigned on both: a negative width is not expressible and a 4-byte key length cannot be read as
 * -1 by a decoder that chose the wrong signedness.
 */
export function encodeWinEvent(dv, off, ev) {
  dv.setUint16(off + WEV_TYPE, ev.type & 0xffff, true);
  dv.setUint16(off + WEV_MODS, (ev.mods || 0) & 0xffff, true);
  dv.setUint32(off + WEV_A, (ev.a || 0) >>> 0, true);
  dv.setUint32(off + WEV_B, (ev.b || 0) >>> 0, true);
  dv.setUint32(off + WEV_C, (ev.c || 0) >>> 0, true);
}

export function decodeWinEvent(dv, off) {
  return {
    type: dv.getUint16(off + WEV_TYPE, true),
    mods: dv.getUint16(off + WEV_MODS, true),
    a: dv.getUint32(off + WEV_A, true),
    b: dv.getUint32(off + WEV_B, true),
    c: dv.getUint32(off + WEV_C, true),
  };
}

/**
 * A POINTER event's coordinates, SIGN-EXTENDED. The record's fields are u32 because a key event's
 * inline bytes and a resize's cell counts are unsigned, and a pointer's coordinates are not: a
 * drag that leaves the surface delivers negative x and y, which `a >>> 0` turns into four billion.
 *
 * THE ONE PLACE THAT IS UNDONE, for the reason `keyBytesOf` is the one place a key's bytes are
 * unpacked: a program that did it itself would get it wrong once and silently.
 */
export function pointerAt(ev) {
  return { x: ev.a | 0, y: ev.b | 0, buttons: ev.c >>> 0 };
}

/** A KEY event's own bytes, out of the inline `(a, b)` pair. Empty for any other type, and for a
 *  length outside 1..4 — a record claiming 7 bytes in a 4-byte field is corrupt, not clamped. */
export function keyBytesOf(ev) {
  if (ev.type !== WEV_KEY) return new Uint8Array(0);
  const n = ev.a | 0;
  if (n < 1 || n > 4) return new Uint8Array(0);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (ev.b >>> (8 * i)) & 0xff;
  return out;
}

/** The inline `(a, b)` pair for up to 4 UTF-8 bytes. The INVERSE of keyBytesOf, declared beside it
 *  so the packing order cannot be written twice and disagree. */
export function packKeyBytes(bytes) {
  const n = Math.min(bytes.length, 4);
  let b = 0;
  for (let i = 0; i < n; i += 1) b |= (bytes[i] & 0xff) << (8 * i);
  return { a: n, b: b >>> 0 };
}

/** Decode a whole read's worth of records. A trailing partial record is IMPOSSIBLE by the floor the
 *  kernel applies, so it is a kernel fault here rather than a silently dropped tail. */
export function decodeWinEvents(bytes, length = bytes.length) {
  if (length % WEV_BYTES !== 0) {
    throw new Error(`decodeWinEvents: ${length} bytes is not a whole number of records`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, length);
  const out = [];
  for (let off = 0; off < length; off += WEV_BYTES) out.push(decodeWinEvent(dv, off));
  return out;
}

/* ---- M14: the item list, both directions ------------------------------------------------------
 *
 * A PUBLISHER WRITES AND A SHELL READS, which are the two sides — a process encodes its rows into
 * the byte region and the page decodes them to draw. The kernel carries them and validates the
 * bounds, exactly as it carries a title: it knows a row has a label and an icon id, and nothing
 * about what the row MEANS.
 */

/** One row's encoded length: the header plus its label, padded to 4 so the next header is aligned.
 *  `direntSize`'s arithmetic, declared again here because the two records are not the same record
 *  and sharing the function would tie this list's growth to the filesystem's. */
export function winItemSize(labelBytes) {
  const n = Math.max(0, labelBytes | 0);
  return WITEM_HEADER + n + ((4 - (n % 4)) % 4);
}

/**
 * Encode a list of `{icon, flags, label}` rows. Returns the bytes, or null for a list this ABI
 * cannot carry — too many rows, a label too long, or a flag outside the table.
 *
 * NULL AND NEVER A THROW, which is the shape every codec in this file takes: the caller is a
 * program and a throw inside a libos stub is a fault the program cannot handle.
 */
export function encodeWinItems(items) {
  if (!Array.isArray(items) || items.length > WIN_ITEM_CAP) return null;
  const enc = new TextEncoder();
  const rows = [];
  let total = 0;
  for (const item of items) {
    const label = enc.encode(String((item && item.label) || ""));
    if (label.length > WITEM_LABEL_MAX) return null;
    const icon = (item && item.icon) | 0;
    const flags = (item && item.flags) | 0;
    if (icon < 0 || icon > WICON_LIMIT) return null;
    if (flags < 0 || (flags & ~WITEM_FLAGS_ALL) !== 0) return null;
    rows.push({ icon, flags, label });
    total += winItemSize(label.length);
  }
  if (total > MAX_INLINE) return null;
  const bytes = new Uint8Array(total);
  const dv = new DataView(bytes.buffer);
  let at = 0;
  for (const row of rows) {
    dv.setUint16(at + WIT_ICON, row.icon, true);
    dv.setUint16(at + WIT_FLAGS, row.flags, true);
    dv.setUint16(at + WIT_LEN, row.label.length, true);
    dv.setUint16(at + WIT_RESERVED, 0, true);
    bytes.set(row.label, at + WITEM_HEADER);
    at += winItemSize(row.label.length);
  }
  return bytes;
}

/**
 * Decode a whole list. Returns the rows, or null for bytes that are not a list: a truncated row, a
 * label running past the end, a count over the cap, or an icon outside the table.
 *
 * REFUSING THE WHOLE LIST AND NOT THE ROW, for `decodeSpawnRequest`'s reason: a shell that drew
 * the rows it could parse would show a desktop missing an icon and say nothing, and a partial list
 * is indistinguishable from a complete one once it is on screen.
 */
export function decodeWinItems(bytes, length = bytes.length) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, length);
  const dec = new TextDecoder("utf-8", { fatal: false });
  const out = [];
  let at = 0;
  while (at < length) {
    if (length - at < WITEM_HEADER) return null;
    const icon = dv.getUint16(at + WIT_ICON, true);
    const flags = dv.getUint16(at + WIT_FLAGS, true);
    const len = dv.getUint16(at + WIT_LEN, true);
    if (icon > WICON_LIMIT) return null;
    if ((flags & ~WITEM_FLAGS_ALL) !== 0) return null;
    if (len > WITEM_LABEL_MAX) return null;
    const size = winItemSize(len);
    if (at + size > length) return null;
    /* `slice` AND NOT `subarray`, which is not a style choice: `TextDecoder.decode` refuses a view
     * onto a SharedArrayBuffer, and the kernel's byte region is one. `slice` copies into a fresh
     * ArrayBuffer, so this codec is safe wherever it is called from — the kernel copies the whole
     * region as well, but a codec that only works on one side of the channel is a codec with a
     * precondition nobody can see. */
    const label = dec.decode(bytes.slice(at + WITEM_HEADER, at + WITEM_HEADER + len));
    // A NUL IN A LABEL IS REFUSED, for the reason a title's is: the page renders the rest as text
    // and a reader sees a row whose name stops in the middle.
    if (label.includes("\0")) return null;
    out.push({ icon, flags, label });
    if (out.length > WIN_ITEM_CAP) return null;
    at += size;
  }
  return out;
}

/** How many display-list ops one `win_draw` may carry. DERIVED, so the number is never written
 *  twice: a batch is bytes in the caller's own frame and the frame is MAX_INLINE. */
export const DL_MAX_OPS = Math.floor(MAX_INLINE / DLOP_BYTES);

/**
 * M8's display-list op, declared once and used by the process that writes it, the kernel that
 * counts it and the page that replays it.
 *
 * The arguments are SIGNED: a rectangle may legitimately start off the left edge of a surface, and
 * a clamp at zero would move a shape rather than clip it. The COLOUR is the exception — it is read
 * back unsigned, because 0xRRGGBBAA with the alpha set is negative as an i32 and a reader that
 * forgot would get a transparent black.
 */
export function encodeDrawOp(dv, off, op) {
  dv.setUint16(off + DL_OP, op.op & 0xffff, true);
  dv.setUint16(off + DL_FLAGS, (op.flags || 0) & 0xffff, true);
  dv.setInt32(off + DL_A0, op.a0 | 0, true);
  dv.setInt32(off + DL_A1, op.a1 | 0, true);
  dv.setInt32(off + DL_A2, op.a2 | 0, true);
  dv.setInt32(off + DL_A3, op.a3 | 0, true);
  dv.setInt32(off + DL_A4, op.a4 | 0, true);
  dv.setInt32(off + DL_A5, op.a5 | 0, true);
  // Zero, always: a future argument lands here and an old writer must not leave anything in it.
  dv.setUint32(off + DL_RESERVED, 0, true);
}

export function decodeDrawOp(dv, off) {
  return {
    op: dv.getUint16(off + DL_OP, true),
    flags: dv.getUint16(off + DL_FLAGS, true),
    a0: dv.getInt32(off + DL_A0, true),
    a1: dv.getInt32(off + DL_A1, true),
    a2: dv.getInt32(off + DL_A2, true),
    a3: dv.getInt32(off + DL_A3, true),
    // The colour slot, read UNSIGNED. See the note above.
    a4: dv.getUint32(off + DL_A4, true),
    a5: dv.getInt32(off + DL_A5, true),
  };
}

/** A whole batch. A length that is not a whole number of ops is a kernel fault here rather than a
 *  silently dropped tail — the same rule as `decodeWinEvents`. */
export function decodeDrawOps(bytes, length = bytes.length) {
  if (length % DLOP_BYTES !== 0) {
    throw new Error(`decodeDrawOps: ${length} bytes is not a whole number of ops`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, length);
  const out = [];
  for (let off = 0; off < length; off += DLOP_BYTES) out.push(decodeDrawOp(dv, off));
  return out;
}

/** How many bytes of text one `DL_TEXT_DATA` record carries: the six argument words. Derived, so
 *  a change to the record's shape moves the writer and the reader together. */
export const DL_TEXT_BYTES_PER_OP = 24;

/** How many records a run of `len` bytes needs, header included. The caller sizes a batch with
 *  this rather than guessing, and the kernel validates against it. */
export function textOpCount(len) {
  return 1 + Math.ceil((len | 0) / DL_TEXT_BYTES_PER_OP);
}

/**
 * ONE TEXT RUN, AS THE RECORDS IT IS MADE OF. The encoder every program uses, so no program packs
 * continuation bytes by hand — and the one place the packing is written, which is what lets
 * `textOfOps` below be its declared inverse.
 *
 * Returns an array of op objects for `encodeDrawOp`. The byte length is the UTF-8 length and not
 * the string's, because a two-byte character in a filename would otherwise make the header
 * disagree with its own data.
 */
export function encodeTextRun(text, { x, y, size, rgba, flags = 0 }) {
  const bytes = new TextEncoder().encode(String(text));
  const out = [{
    op: DL_TEXT, flags: flags & 0xffff,
    a0: x | 0, a1: y | 0, a2: size | 0, a3: bytes.length, a4: rgba | 0, a5: 0,
  }];
  for (let at = 0; at < bytes.length; at += DL_TEXT_BYTES_PER_OP) {
    const chunk = bytes.subarray(at, at + DL_TEXT_BYTES_PER_OP);
    const words = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < chunk.length; i += 1) {
      // LITTLE-ENDIAN WORDS, matching how `encodeDrawOp` writes every other argument. A reader
      // that assumed the other order would render the bytes of each word reversed, which is
      // legible enough to be missed.
      words[i >> 2] |= chunk[i] << ((i & 3) * 8);
    }
    out.push({
      op: DL_TEXT_DATA, flags: 0,
      a0: words[0] | 0, a1: words[1] | 0, a2: words[2] | 0,
      a3: words[3] | 0, a4: words[4] | 0, a5: words[5] | 0,
    });
  }
  return out;
}

/**
 * The declared INVERSE of `encodeTextRun`: the string a `DL_TEXT` header at `index` carries, read
 * out of the records that follow it.
 *
 * Returns `{ text, records }` — `records` counts the header and its data, so a renderer can skip
 * past them — or `null` when the data is missing or short. NULL AND NOT A PARTIAL STRING: half a
 * filename is a filename, and nothing downstream could tell it from the real one. The kernel
 * refuses such a batch (constraint 293); this returns null so a renderer that somehow sees one
 * draws nothing rather than a lie.
 */
export function textOfOps(ops, index) {
  const head = ops[index];
  if (!head || head.op !== DL_TEXT) return null;
  const len = head.a3 | 0;
  if (len < 0) return null;
  const need = Math.ceil(len / DL_TEXT_BYTES_PER_OP);
  // The data records are at index+1..index+need, so the last must be inside the array.
  if (index + need >= ops.length) return null;
  const bytes = new Uint8Array(len);
  let wrote = 0;
  for (let i = 1; i <= need; i += 1) {
    const rec = ops[index + i];
    if (!rec || rec.op !== DL_TEXT_DATA) return null;
    const words = [rec.a0, rec.a1, rec.a2, rec.a3, rec.a4, rec.a5];
    for (let b = 0; b < DL_TEXT_BYTES_PER_OP && wrote < len; b += 1) {
      bytes[wrote] = (words[b >> 2] >>> ((b & 3) * 8)) & 0xff;
      wrote += 1;
    }
  }
  if (wrote !== len) return null;
  return { text: new TextDecoder().decode(bytes), records: 1 + need };
}

/* M10's format table, as the three functions every side needs. THE OFFER IS A BITMASK and the bit
   for a format is computed HERE: the kernel builds a mask from a process's request, the event record
   carries it to a target, and the target tests it — three readers of one packing (constraint 240). */

/** The offer bit for one format id, or 0 for an id outside the table. 0 for an unknown format is
 *  deliberate: a mask ORed from unknown ids is EMPTY rather than wrong, so a refusal names the
 *  format instead of a plausible-looking mask reaching a target. */
export function fmtBit(format) {
  const f = format | 0;
  if (f < 1 || f > DOBJ_FMT_MAX) return 0;
  return 1 << (f - 1);
}

/** Every format id in the table, ascending. DERIVED from `DOBJ_FMT_MAX`, so adding a format is one
 *  edit and this list cannot be the copy that goes stale. */
export const DOBJ_FORMATS = Object.freeze(
  Array.from({ length: DOBJ_FMT_MAX }, (_, i) => i + 1),
);

/** Every bit set, for a program that offers the lot. Derived, never written as 0b1111. */
export const DOBJ_FMT_ALL = DOBJ_FORMATS.reduce((m, f) => m | fmtBit(f), 0);

/** A format's printed name. One renderer, so `/proc`, a program's output and a check's message
 *  cannot disagree about what format 2 is called. */
export const DOBJ_FMT_NAME = Object.freeze({
  [DOBJ_TEXT]: "text",
  [DOBJ_PATHS]: "paths",
  [DOBJ_PNG]: "png",
  [DOBJ_BITMAP]: "bitmap",
});

export function fmtName(format) {
  return DOBJ_FMT_NAME[format | 0] || `fmt?${format | 0}`;
}

/** The format ids a mask carries, ascending. The inverse of ORing `fmtBit`, declared beside it. */
export function fmtsOf(mask) {
  return DOBJ_FORMATS.filter((f) => (mask & fmtBit(f)) !== 0);
}

/** A `DOBJ_BITMAP` payload's header. ONE PLACE, because the program that writes a bitmap, the one
 *  that draws it and the check that measures it each need the same arithmetic — and `8 + w*h*4`
 *  written three times is the drift this exists to stop. Null for anything that is not a whole
 *  bitmap: a payload claiming 4096x4096 in 40 bytes is corrupt, not clamped (keyBytesOf's rule). */
export function decodeBitmap(bytes) {
  if (!bytes || bytes.length < BITMAP_HEADER) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = dv.getUint32(BMP_W, true);
  const h = dv.getUint32(BMP_H, true);
  if (w <= 0 || h <= 0) return null;
  if (bytes.length !== BITMAP_HEADER + w * h * 4) return null;
  return { w, h, pixels: bytes.subarray(BITMAP_HEADER) };
}

/** The inverse. `pixels` is RGBA8, top row first, and a length that does not match (w, h) is a
 *  throw here rather than a short bitmap on somebody's screen. */
export function encodeBitmap(w, h, pixels) {
  const want = w * h * 4;
  if (pixels.length !== want) {
    throw new Error(`encodeBitmap: ${pixels.length} bytes for ${w}x${h}, want ${want}`);
  }
  const out = new Uint8Array(BITMAP_HEADER + want);
  const dv = new DataView(out.buffer);
  dv.setUint32(BMP_W, w >>> 0, true);
  dv.setUint32(BMP_H, h >>> 0, true);
  out.set(pixels, BITMAP_HEADER);
  return out;
}

/**
 * The CSS px² a window's frame actually asks the compositor to filter: the sum of the four glass
 * strips' own border boxes.
 *
 * THE ONE DEFINITION, and M12's governor, M11's skin and every check call it. `backdrop-filter`
 * filters the element's border box, so a frame is only cheap if it is several boxes that sum to the
 * ring — one glass node with an opaque client child painted over its middle hides the blur and
 * saves none of it. A second copy of this arithmetic is how a governor comes to account a frame
 * nobody renders, which is the ~17× under-read constraint 49 exists to forbid.
 *
 * Measured against the rendered strips at 640×440: 27,260, byte-identical to this function
 * (`bench/m11-glass/probe.py`, constraint 255).
 */
export function blurRingArea(w, h) {
  const width = Math.max(0, w | 0);
  const height = Math.max(0, h | 0);
  const cap = width * Math.min(WIN_CAP_H, height);
  const sides = 2 * WIN_INSET * Math.max(0, height - WIN_CAP_H);
  const bottom = Math.max(0, width - 2 * WIN_INSET)
    * Math.min(WIN_INSET, Math.max(0, height - WIN_CAP_H));
  return cap + sides + bottom;
}

/** The same window as ONE glass node, which is what the ring is cheaper THAN. Kept beside
 *  `blurRingArea` so the ratio is never quoted without both halves of it. */
export function blurBoxArea(w, h) {
  return Math.max(0, w | 0) * Math.max(0, h | 0);
}

/** `0xRRGGBBAA` unpacked. THE ONE PLACE THOSE BYTES ARE TAKEN APART, so a process's idea of a
 *  colour, the canvas's and a check's cannot drift. */
export function unpackColor(rgba) {
  const v = rgba >>> 0;
  return { r: (v >>> 24) & 0xff, g: (v >>> 16) & 0xff, b: (v >>> 8) & 0xff, a: v & 0xff };
}

/** For a canvas: CSS wants alpha as 0–1. */
export function cssColor(rgba) {
  const c = unpackColor(rgba);
  return `rgba(${c.r},${c.g},${c.b},${c.a / 255})`;
}

/**
 * For a PIXEL READ BACK: `getImageData` gives alpha as a 0–255 byte.
 *
 * TWO RENDERINGS OF ONE COLOUR IS WHAT THIS EXISTS TO STOP, and it cost a run to learn: M8's
 * pattern proof compared `cssColor(op.a4)` against a pixel read out of the canvas and found
 * `rgba(74,155,216,1)` against `rgba(74,155,216,255)` — four clauses red over four pixels that
 * were exactly right. The alpha convention differs between the two APIs, and a check that renders
 * the colour itself will get one of them wrong.
 */
export function pixelColor(rgba) {
  const c = unpackColor(rgba);
  return `rgba(${c.r},${c.g},${c.b},${c.a})`;
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

  // statfs, pinned to LITERAL byte positions and to a known-answer vector.
  //
  // A ROUND-TRIP ALONE CANNOT CATCH A MOVED OFFSET, and this check was written that way first:
  // `encodeStatfs` and `decodeStatfs` read the same constants, so swapping SFS_FILES with
  // SFS_FFREE swaps both sides and the comparison passes over two copies of one mistake. Measured
  // -- the swap was made and the round-trip stayed green. So the offsets are asserted against the
  // numbers docs/ABI.md publishes, and the encoded bytes against a vector computed by hand.
  if (SFS_BLOCKS !== 0 || SFS_BFREE !== 8 || SFS_FILES !== 16 || SFS_FFREE !== 24
      || SFS_BSIZE !== 32 || SFS_NAMEMAX !== 36 || STATFS_BYTES !== 40) {
    fail("a statfs offset moved away from the layout docs/ABI.md publishes");
  }
  {
    const buf = new DataView(new ArrayBuffer(STATFS_BYTES));
    encodeStatfs(buf, 0, { blocks: 1n, bfree: 2n, files: 3n, ffree: 4n, bsize: 5, namemax: 6 });
    const bytes = new Uint8Array(buf.buffer);
    // One distinct value per field, each little-endian at its own offset: byte 0 is blocks, byte 8
    // is bfree, and so on. Any pair swapped moves a 1..6 to the wrong index and this fires.
    const wantAt = [[0, 1], [8, 2], [16, 3], [24, 4], [32, 5], [36, 6]];
    for (const [at, v] of wantAt) {
      if (bytes[at] !== v) fail(`statfs byte ${at} is ${bytes[at]}, not the ${v} its field holds`);
    }
    const got = decodeStatfs(buf, 0);
    if (String(got.blocks) !== "1" || String(got.ffree) !== "4" || got.namemax !== 6) {
      fail("statfs does not read back what it wrote");
    }
  }

  // The dirent offsets and the padding are one declaration each, because the kernel writes a
  // record and a process walks forward by the same arithmetic. A name whose length is not a
  // multiple of 4 is the only input that catches a wrong pad.
  if (DE_INO !== 0 || DE_TYPE !== 8 || DE_NLEN !== 9) fail("dirent offsets moved under their u64");
  if (direntSize(0) !== DIRENT_HEADER) fail("an empty name must occupy exactly the header");
  for (const [nlen, want] of [[1, 16], [3, 16], [4, 16], [5, 20], [8, 20]]) {
    if (direntSize(nlen) !== want) {
      fail(`direntSize(${nlen}) is ${direntSize(nlen)}, not the 4-byte-padded ${want}`);
    }
  }

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

  // M7's window event record. The offsets are asserted CONTIGUOUS and FILLING, because a gap would
  // be read as part of the next field by the side that computed its own offsets.
  if (WEV_TYPE + 2 !== WEV_MODS || WEV_MODS + 2 !== WEV_A
    || WEV_A + 4 !== WEV_B || WEV_B + 4 !== WEV_C) {
    fail("the window event fields are not contiguous");
  }
  if (WEV_C + 4 !== WEV_BYTES) fail(`a window event is not ${WEV_BYTES} bytes`);
  const eprobe = new DataView(new ArrayBuffer(WEV_BYTES));
  const packed = packKeyBytes(new TextEncoder().encode("é"));   // 2 UTF-8 bytes, so n > 1 is tested
  encodeWinEvent(eprobe, 0, { type: WEV_KEY, mods: WMOD_CTRL, ...packed, c: 0 });
  const eround = decodeWinEvent(eprobe, 0);
  if (eround.type !== WEV_KEY || eround.mods !== WMOD_CTRL || eround.a !== 2) {
    fail(`a key event round-trips as ${JSON.stringify(eround)}`);
  }
  // A POINTER COORDINATE SURVIVES A ROUND TRIP THROUGH THE u32 FIELDS, which it does not without
  // `pointerAt`: -7 reads back as 4,294,967,289 (constraint 225).
  const pprobe = new DataView(new ArrayBuffer(WEV_BYTES));
  encodeWinEvent(pprobe, 0, { type: WEV_POINTER, mods: WPTR_MOVE, a: -7, b: 3, c: 1 });
  const pround = decodeWinEvent(pprobe, 0);
  if (pround.a === -7) fail("the event record's `a` is signed; pointerAt would be pointless");
  const at = pointerAt(pround);
  if (at.x !== -7 || at.y !== 3 || at.buttons !== 1) {
    fail(`pointerAt gave ${JSON.stringify(at)}`);
  }
  const kb = keyBytesOf(eround);
  if (new TextDecoder().decode(kb) !== "é") fail(`the inline key bytes decode as ${kb}`);
  // The two guards that make a corrupt record refuse rather than clamp.
  if (keyBytesOf({ ...eround, a: 7 }).length !== 0) fail("a 7-byte key length was accepted");
  if (keyBytesOf({ ...eround, type: WEV_RESIZE }).length !== 0) {
    fail("a resize event yielded key bytes");
  }
  const evTypes = [WEV_KEY, WEV_RESIZE, WEV_CLOSE, WEV_FOCUS, WEV_DESTROYED, WEV_POINTER,
    WEV_DRAG_ENTER, WEV_DRAG_LEAVE, WEV_DROP, WEV_DRAG_DONE, WEV_STATE, WEV_ITEM];
  if (new Set(evTypes).size !== evTypes.length) fail("two window event types collide");
  if (evTypes.includes(0)) fail("0 is a window event type: a zeroed buffer would decode as one");
  if (Math.max(...evTypes) !== WEV_MAX) fail("WEV_MAX is not the largest event type");
  // M8's display-list op: contiguous, filling, and its colour slot unsigned on the way back.
  if (DL_OP + 2 !== DL_FLAGS || DL_FLAGS + 2 !== DL_A0 || DL_A0 + 4 !== DL_A1
    || DL_A1 + 4 !== DL_A2 || DL_A2 + 4 !== DL_A3 || DL_A3 + 4 !== DL_A4
    || DL_A4 + 4 !== DL_A5) {
    fail("the display-list op fields are not contiguous");
  }
  if (DL_A5 + 4 !== DL_RESERVED) fail("the display-list op's reserved word is misplaced");
  if (DL_RESERVED + 4 !== DLOP_BYTES) fail(`a display-list op is not ${DLOP_BYTES} bytes`);
  const dprobe = new DataView(new ArrayBuffer(DLOP_BYTES));
  // 0x4a9bd8ff is the project's own blue at full alpha, and it is NEGATIVE as an i32 — which is
  // the mistake this assertion exists for.
  encodeDrawOp(dprobe, 0, { op: DL_LINE, a0: -5, a1: 2, a2: 300, a3: 4, a4: 0x4a9bd8ff, a5: 3 });
  const dround = decodeDrawOp(dprobe, 0);
  if (dround.op !== DL_LINE || dround.a0 !== -5 || dround.a2 !== 300 || dround.a5 !== 3) {
    fail(`a draw op round-trips as ${JSON.stringify(dround)}`);
  }
  if (dround.a4 !== 0x4a9bd8ff) fail(`the colour slot read back as ${dround.a4}`);
  if (dprobe.getUint32(DL_RESERVED, true) !== 0) fail("the reserved word was not written zero");
  if (cssColor(dround.a4) !== "rgba(74,155,216,1)") fail(`cssColor gave ${cssColor(dround.a4)}`);
  if (cssColor(0x00000000) !== "rgba(0,0,0,0)") fail("a transparent colour did not round-trip");
  // THE TWO RENDERINGS DIFFER ONLY IN THE ALPHA, which is the whole point: `getImageData` reports
  // a 0-255 byte and CSS wants 0-1, and a check that rendered the colour itself got one of them
  // wrong — four correct pixels reported as four failures.
  if (pixelColor(dround.a4) !== "rgba(74,155,216,255)") {
    fail(`pixelColor gave ${pixelColor(dround.a4)}`);
  }
  if (pixelColor(0x0b0d11ff) === cssColor(0x0b0d11ff)) {
    fail("pixelColor and cssColor agree, so one of them is wrong about alpha");
  }
  const dlOps = [DL_CLEAR, DL_FILL_RECT, DL_STROKE_RECT, DL_LINE, DL_TEXT, DL_TEXT_DATA];
  if (new Set(dlOps).size !== dlOps.length) fail("two display-list ops collide");
  if (dlOps.includes(0)) fail("0 is a display-list op: a zeroed buffer would decode as one");
  if (Math.max(...dlOps) !== DL_MAX) fail("DL_MAX is not the largest op");
  if (DL_MAX_OPS < 1024) fail(`a batch holds only ${DL_MAX_OPS} ops`);
  const dlt = [DLT_BOLD, DLT_MONO, DLT_RIGHT, DLT_CENTER];
  if (new Set(dlt).size !== dlt.length) fail("two text flags collide");
  for (const b of dlt) {
    if (b === 0 || (b & (b - 1)) !== 0) fail(`text flag ${b} is not a single bit`);
  }

  /* THE TEXT RUN, THROUGH THE RECORDS AND BACK. `textOfOps` is declared the inverse of
   * `encodeTextRun`, so the round trip is asserted here rather than trusted — including the two
   * cases the arithmetic gets wrong first: a run that exactly fills its last record, and a
   * multi-byte character, whose UTF-8 length is not its string length. */
  for (const sample of ["", "a", "hello.txt", "x".repeat(DL_TEXT_BYTES_PER_OP),
                        "x".repeat(DL_TEXT_BYTES_PER_OP + 1), "naïve — ünïcødé ✓",
                        "y".repeat(200)]) {
    const run = encodeTextRun(sample, { x: 3, y: 4, size: 11, rgba: 0x102030ff, flags: DLT_MONO });
    const bytes = new TextEncoder().encode(sample);
    if (run.length !== textOpCount(bytes.length)) {
      fail(`encodeTextRun made ${run.length} records for ${bytes.length} bytes, `
        + `textOpCount says ${textOpCount(bytes.length)}`);
    }
    // THROUGH THE WIRE AND NOT THE OBJECTS: the records are encoded and decoded the way a real
    // batch is, or this would assert over a structure that never crossed the boundary.
    const buf = new Uint8Array(run.length * DLOP_BYTES);
    const bdv = new DataView(buf.buffer);
    run.forEach((op, i) => encodeDrawOp(bdv, i * DLOP_BYTES, op));
    const back = decodeDrawOps(buf, buf.length);
    const got = textOfOps(back, 0);
    if (!got) fail(`textOfOps refused a run it encoded: ${JSON.stringify(sample)}`);
    else if (got.text !== sample) fail(`text round trip gave ${JSON.stringify(got.text)}`);
    else if (got.records !== run.length) fail(`textOfOps counted ${got.records} records`);
    if (back[0].a2 !== 11 || back[0].flags !== DLT_MONO) fail("a text header lost its own fields");
  }
  // A HEADER WITH ITS DATA MISSING IS REFUSED, which is what makes the kernel's refusal
  // (constraint 293) a statement about this codec and not a separate opinion.
  const lone = [{ op: DL_TEXT, flags: 0, a0: 0, a1: 0, a2: 10, a3: 9, a4: 0, a5: 0 }];
  if (textOfOps(lone, 0) !== null) fail("textOfOps accepted a header with no data records");
  const short = encodeTextRun("hello.txt", { x: 0, y: 0, size: 10, rgba: 0 }).slice(0, 1);
  if (textOfOps(short, 0) !== null) fail("textOfOps accepted a truncated run");
  const wptr = [WPTR_DOWN, WPTR_UP, WPTR_MOVE];
  if (new Set(wptr).size !== 3) fail("two pointer flags collide");
  for (const b of wptr) {
    if (b === 0 || (b & (b - 1)) !== 0) fail(`pointer flag ${b} is not a single bit`);
  }
  // A pointer flag must not collide with a MODIFIER, because both travel in `mods`.
  for (const b of wptr) {
    for (const m of [WMOD_SHIFT, WMOD_CTRL, WMOD_ALT]) {
      if (b === m) fail(`pointer flag ${b} collides with a modifier`);
    }
  }
  if (SURFACE_MAX_PX > SURFACE_BUDGET_PX) fail("one surface may exceed the whole budget");

  // M9's two axes. DENSE AND DISTINCT, each from 0, because they are read out of the same call's
  // arguments and a gap would make an unset argument mean something.
  const scopes = [WMODAL_NONE, WMODAL_WINDOW, WMODAL_APP, WMODAL_SYSTEM];
  const modes = [WMODE_MODELESS, WMODE_PASSIVE, WMODE_RENDER_ABOVE, WMODE_BLOCKING];
  for (const [name, set, max] of [["modal scope", scopes, WMODAL_MAX],
    ["window mode", modes, WMODE_MAX]]) {
    if (new Set(set).size !== set.length) fail(`two ${name} values collide`);
    if (Math.min(...set) !== 0) fail(`${name} does not start at 0`);
    if (Math.max(...set) !== max) fail(`${name}'s MAX is not its largest value`);
    if (set.length !== max + 1) fail(`${name} is not dense over 0..${max}`);
  }
  // THE TWO AXES ARE INDEPENDENT, and the selector numbering must not imply otherwise: NONE and
  // MODELESS are both 0, so a window nobody set up is modeless and affects nothing.
  if (WMODAL_NONE !== 0 || WMODE_MODELESS !== 0) {
    fail("the quiet value of each axis must be 0, so an unset window is ordinary");
  }
  const selectors = [WIN_SET_TITLE, WIN_SET_BOX, WIN_SET_MODAL, WIN_SET_STATE, WIN_SET_ROLE];
  if (new Set(selectors).size !== selectors.length) fail("two win_set selectors collide");
  // 0 IS NOT A SELECTOR, so a `win_set` with an unset a1 is refused rather than meaning the first
  // case. `calls.mjs` answers -EINVAL for an unknown one, which is what makes that true.
  if (selectors.includes(0)) fail("0 is a win_set selector: an unset argument would select it");

  /* M14's SHOW STATE and ROLE. Dense from 0 and distinct, for the reason M9's two axes are: they
   * are read out of the same call's arguments, so a gap would make an unset argument mean
   * something, and the quiet value must be 0 — a window nobody has minimized is normal. */
  const states = [WST_NORMAL, WST_MIN, WST_MAX, WST_SNAP_L, WST_SNAP_R];
  const roles = [WROLE_NORMAL, WROLE_DESKTOP];
  for (const [name, set, max] of [["show state", states, WST_LIMIT],
    ["window role", roles, WROLE_LIMIT]]) {
    if (new Set(set).size !== set.length) fail(`two ${name} values collide`);
    if (Math.min(...set) !== 0) fail(`${name} does not start at 0`);
    if (Math.max(...set) !== max) fail(`${name}'s LIMIT is not its largest value`);
    if (set.length !== max + 1) fail(`${name} is not dense over 0..${max}`);
  }
  if (WST_NORMAL !== 0 || WROLE_NORMAL !== 0) {
    fail("the quiet value of each M14 axis must be 0, so an unset window is an ordinary one");
  }

  /* M14's ITEM RECORD. The header is contiguous and filling, every `WITEM_*` flag is a single bit
   * inside `WITEM_FLAGS_ALL`, the icon table is dense from 0, and the codec round-trips — including
   * the padding, which is where a list of rows comes apart one row in. */
  if (WIT_ICON + 2 !== WIT_FLAGS || WIT_FLAGS + 2 !== WIT_LEN || WIT_LEN + 2 !== WIT_RESERVED) {
    fail("the item header's fields are not contiguous");
  }
  if (WIT_RESERVED + 2 !== WITEM_HEADER) fail(`an item header is not ${WITEM_HEADER} bytes`);
  if (WITEM_HEADER % 4 !== 0) fail("an item header that is not 4-byte aligned unaligns the next");
  const itemFlags = [WITEM_DESKTOP, WITEM_MENU, WITEM_JUMP, WITEM_SEPARATOR, WITEM_CONTAINER,
    WITEM_DISABLED];
  if (new Set(itemFlags).size !== itemFlags.length) fail("two item flags collide");
  for (const bit of itemFlags) {
    if (bit === 0 || (bit & (bit - 1)) !== 0) fail(`item flag ${bit} is not a single bit`);
    if ((bit & WITEM_FLAGS_ALL) !== bit) fail(`item flag ${bit} is outside WITEM_FLAGS_ALL`);
  }
  if (itemFlags.reduce((m, b) => m | b, 0) !== WITEM_FLAGS_ALL) {
    fail("WITEM_FLAGS_ALL is not the OR of the flags: an unknown bit would be accepted");
  }
  const icons = [WICON_GENERIC, WICON_FOLDER, WICON_TEXT, WICON_IMAGE, WICON_PROGRAM,
    WICON_TERMINAL, WICON_PAINT, WICON_EDITOR, WICON_FILES, WICON_COMPUTER, WICON_TRASH];
  if (new Set(icons).size !== icons.length) fail("two icon ids collide");
  if (Math.min(...icons) !== 0 || Math.max(...icons) !== WICON_LIMIT
    || icons.length !== WICON_LIMIT + 1) {
    fail("the icon table is not dense over 0..WICON_LIMIT");
  }
  // A LABEL WHOSE LENGTH IS NOT A MULTIPLE OF 4 is the case the padding exists for, so the fixture
  // uses one: "é" is two bytes, so row 1 is 10 bytes of content in a 12-byte record.
  const itemsIn = [
    { icon: WICON_FOLDER, flags: WITEM_DESKTOP | WITEM_CONTAINER, label: "Sharé" },
    { icon: WICON_GENERIC, flags: WITEM_SEPARATOR, label: "" },
    { icon: WICON_TERMINAL, flags: WITEM_MENU | WITEM_JUMP, label: "term" },
  ];
  const itemBytes = encodeWinItems(itemsIn);
  if (itemBytes === null) fail("a legal item list was refused by the encoder");
  const itemsOut = decodeWinItems(itemBytes, itemBytes.length);
  if (itemsOut === null || itemsOut.length !== itemsIn.length) {
    fail(`an item list round-trips as ${JSON.stringify(itemsOut)}`);
  }
  for (let i = 0; i < itemsIn.length; i += 1) {
    if (itemsOut[i].icon !== itemsIn[i].icon || itemsOut[i].flags !== itemsIn[i].flags
      || itemsOut[i].label !== itemsIn[i].label) {
      fail(`item ${i} round-trips as ${JSON.stringify(itemsOut[i])}`);
    }
  }
  // AND THE REFUSALS, each for a reason a shell could not recover from: a row too long to lay out,
  // an icon nothing can draw, a flag nothing knows, and a list longer than the cap.
  if (encodeWinItems([{ icon: 0, flags: 0, label: "x".repeat(WITEM_LABEL_MAX + 1) }]) !== null) {
    fail("an over-long label was accepted");
  }
  if (encodeWinItems([{ icon: WICON_LIMIT + 1, flags: 0, label: "x" }]) !== null) {
    fail("an icon id outside the table was accepted");
  }
  if (encodeWinItems([{ icon: 0, flags: WITEM_FLAGS_ALL + 1, label: "x" }]) !== null) {
    fail("an unknown item flag was accepted");
  }
  if (encodeWinItems(new Array(WIN_ITEM_CAP + 1).fill({ icon: 0, flags: 0, label: "x" })) !== null) {
    fail("a list over WIN_ITEM_CAP was accepted");
  }
  // A TRUNCATED LIST IS REFUSED WHOLE. A shell that drew the rows it could parse would show a
  // desktop missing an icon and say nothing.
  if (decodeWinItems(itemBytes, itemBytes.length - 1) !== null) {
    fail("a truncated item list was decoded");
  }

  /* M10's FORMAT TABLE. The offer is a bitmask in ONE word, so the table must be dense from 1 and
   * must fit: the derivation is what is asserted, never a written-out 0b1111. */
  if (DOBJ_FORMATS.length !== DOBJ_FMT_MAX) fail("the format table is not dense from 1");
  if (DOBJ_FORMATS[0] !== 1) fail("format 0 exists: a zeroed register would name a format");
  if (fmtBit(0) !== 0 || fmtBit(DOBJ_FMT_MAX + 1) !== 0 || fmtBit(-1) !== 0) {
    fail("fmtBit answered a bit for a format outside the table");
  }
  for (const f of DOBJ_FORMATS) {
    const b = fmtBit(f);
    if (b === 0 || (b & (b - 1)) !== 0) fail(`the offer bit for format ${f} is not a single bit`);
    if ((DOBJ_FMT_ALL & b) === 0) fail(`DOBJ_FMT_ALL is missing format ${f}`);
    if (!DOBJ_FMT_NAME[f]) fail(`format ${f} has no name`);
  }
  if (DOBJ_FMT_ALL >>> 0 >= 2 ** 31) fail("the offer mask does not fit an i32 register");
  if (fmtsOf(DOBJ_FMT_ALL).join(",") !== DOBJ_FORMATS.join(",")) {
    fail("fmtsOf does not invert the mask fmtBit builds");
  }
  if (fmtsOf(fmtBit(DOBJ_PNG)).join(",") !== String(DOBJ_PNG)) fail("a one-format mask is not one");
  if (fmtsOf(0).length !== 0) fail("an empty offer carries a format");
  if (fmtName(DOBJ_BITMAP) !== "bitmap" || fmtName(99) === "bitmap") fail("fmtName is wrong");
  if (new Set([DOBJ_TEXT, DOBJ_PATHS, DOBJ_PNG, DOBJ_BITMAP]).size !== 4) {
    fail("two formats collide");
  }
  const wheres = [DOBJ_WHERE_CLIPBOARD, DOBJ_WHERE_DRAG, DOBJ_WHERE_DROP];
  if (new Set(wheres).size !== 3 || Math.min(...wheres) !== 1
      || Math.max(...wheres) !== DOBJ_WHERE_MAX) {
    fail("the publish/open destinations are not dense from 1");
  }
  for (const b of [DOBJ_EFFECT_COPY, DOBJ_EFFECT_MOVE, DOBJ_F_APPEND]) {
    if (b === 0 || (b & (b - 1)) !== 0) fail(`${b} is not a single bit`);
  }
  if (DOBJ_EFFECT_COPY === DOBJ_EFFECT_MOVE) fail("the two drop effects are one bit");
  if (DOBJ_MAX_BYTES > DOBJ_BUDGET_BYTES) fail("one object may exceed the whole budget");
  if (DOBJ_MAX_BYTES <= MAX_INLINE) {
    fail("an object cannot hold more than one byte region, so DOBJ_F_APPEND is pointless");
  }
  if (DRAG_IDLE_MS <= 0) fail("a drag session with no idle bound can never be cancelled");
  // The bitmap header, pinned to LITERAL offsets and round-tripped. A round trip alone cannot
  // catch a swapped w/h — both sides read the same constants — so the bytes are asserted too.
  if (BMP_W !== 0 || BMP_H !== 4 || BITMAP_HEADER !== 8) fail("the bitmap header layout moved");
  {
    const px = new Uint8Array(2 * 1 * 4);
    px[0] = 0x11; px[4] = 0x22;
    const bmp = encodeBitmap(2, 1, px);
    if (bmp[BMP_W] !== 2 || bmp[BMP_H] !== 1) fail("the bitmap header bytes are in the wrong order");
    const round = decodeBitmap(bmp);
    if (!round || round.w !== 2 || round.h !== 1 || round.pixels.length !== 8) {
      fail(`a bitmap round-trips as ${JSON.stringify(round && { w: round.w, h: round.h })}`);
    }
    if (round.pixels[0] !== 0x11 || round.pixels[4] !== 0x22) fail("bitmap pixels moved");
    // THE REFUSALS, which are the half that matters: these bytes come from another process.
    if (decodeBitmap(new Uint8Array(0)) !== null) fail("an empty bitmap decoded");
    if (decodeBitmap(bmp.subarray(0, BITMAP_HEADER + 4)) !== null) fail("a short bitmap decoded");
    const liar = new Uint8Array(BITMAP_HEADER + 4);
    new DataView(liar.buffer).setUint32(BMP_W, 64, true);
    new DataView(liar.buffer).setUint32(BMP_H, 64, true);
    if (decodeBitmap(liar) !== null) fail("a bitmap that lies about its size decoded");
    let threw = false;
    try { encodeBitmap(2, 2, px); } catch { threw = true; }
    if (!threw) fail("encodeBitmap accepted a pixel count that is not w*h*4");
  }

  const wmods = [WMOD_SHIFT, WMOD_CTRL, WMOD_ALT];
  if (new Set(wmods).size !== 3) fail("two window modifier bits collide");
  for (const b of wmods) {
    if (b === 0 || (b & (b - 1)) !== 0) fail(`window modifier ${b} is not a single bit`);
  }

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
