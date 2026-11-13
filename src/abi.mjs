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
  NSYS: 3,

  // STATUS. 1 is a deliberate hole: docs/ABI.md decision 1 pins "sets STATUS=2" for the
  // interrupt case, and renumbering a published value is worse than a gap.
  ST_RETURN: 0,
  ST_INTR: 2,
  ST_KDOWN: 3,

  // File-description kinds. M0 registers F_SINK only; the rest are reserved by name so M2's
  // F_FILE and M4's pipes are rows in the ops table rather than a rewrite.
  F_SINK: 0, F_FILE: 1, F_PIPE_R: 2, F_PIPE_W: 3, F_TTY: 4, F_WIN: 5,

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
};

export const {
  SEQ, STATUS, RLEN, SIGPEND, CALLID, UID, NR,
  A0, A1, A2, A3, A4, A5, A6, A7, R0, R1, KDOWN_SEEN, KDOWN_MS,
  IDLE_PARK,
  SAB_BYTES, BYTE_OFF, DATA_OFF, LEN_I32, MAX_INLINE,
  SYS_getpid, SYS_write, SYS_clock_nanosleep, NSYS,
  ST_RETURN, ST_INTR, ST_KDOWN,
  F_SINK, F_FILE, F_PIPE_R, F_PIPE_W, F_TTY, F_WIN,
  PROC_CAP, A_SHM, CALLID_WRAP,
  REARM_MS, HB_PERIOD_MS, HB_MISS_LIMIT,
  GLOBAL_BYTES, G_HEARTBEAT, G_HB_PERIOD_MS, G_KSTATE, G_EPOCH, G_INFLIGHT,
  G_THINK_US, G_STALL_US, G_READY, G_WINDOW, G_BARRIER, G_DEADLINE_LO, G_DEADLINE_HI,
  W_PRE, W_OPEN, W_CLOSED, W_DONE,
  K_BOOT, K_UP, K_PANIC,
  EHOSTGONE,
} = INTS;

/** Indexed by syscall number, so a number and its printed name cannot drift. */
export const SYS_NAME = Object.freeze(["getpid", "write", "clock_nanosleep"]);

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
  if (R1 >= LEN_I32 || KDOWN_MS >= LEN_I32 || IDLE_PARK >= LEN_I32) {
    fail("the register file overlaps the byte region");
  }
  if (IDLE_PARK === KDOWN_SEEN || IDLE_PARK === KDOWN_MS) fail("IDLE_PARK aliases a live word");
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
  for (const [name, value] of Object.entries({
    EAGAIN, EBADF, EINTR, EINVAL, EIO, ENOSYS, ENOTSUP, EPERM, ESRCH,
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
  if (!ABI_FINGERPRINT) fail("fingerprint is zero");
  return ABI_FINGERPRINT;
}

selfTest();
