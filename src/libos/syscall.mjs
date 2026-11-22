// The in-process syscall stub, and the trust boundary in file form: it runs inside a process, so it
// acquires nothing the kernel did not hand it — one SAB, the globals SAB and one MessagePort.
//
// TWO LAYERS. syscall() is the raw ABI and returns short counts; write() below is the libc-shaped
// loop that consumes them, which is the whole answer to overflow above MAX_INLINE (docs/ABI.md
// decision 4, constraint 9).

import {
  SEQ, STATUS, RLEN, SIGPEND, CALLID, NR, A0, R0, R1, KDOWN_SEEN, KDOWN_MS, IDLE_PARK,
  P_PROGRESS,
  H_MAGIC, H_VERSION, SAB_MAGIC, SAB_VERSION,
  LEN_I32, DATA_OFF, MAX_INLINE,
  ST_RETURN, ST_INTR, ST_KDOWN,
  REARM_MS, HB_MISS_LIMIT, G_HEARTBEAT, G_INFLIGHT, G_THINK_US,
  G_WINDOW, G_BARRIER, G_DEADLINE_LO, G_DEADLINE_HI, W_PRE, W_OPEN, W_CLOSED, W_DONE,
  SYS_getpid, SYS_write, SYS_read, SYS_open, SYS_close, SYS_fsync, SYS_fstat, SYS_stat,
  SYS_lstat, SYS_seek, SYS_mkdir, SYS_unlink, SYS_chmod, SYS_readdir, SYS_readlink,
  SYS_symlink, SYS_rename, SYS_link, SYS_statfs, SYS_ftruncate, SYS_chown,
  SYS_pread, SYS_pwrite, SYS_rmdir, SYS_truncate, SYS_dup, SYS_dup2,
  SYS_pipe2, SYS_spawn, SYS_waitpid, SYS_kill, SYS_sigaction, SYS_setpgid, SYS_setsid,
  SYS_pty_open, SYS_tty_get, SYS_tty_set, SYS_tty_winsize_get, SYS_tty_winsize_set,
  SYS_poll, SYS_ioctl,
  SYS_win_create, SYS_win_destroy, SYS_win_set, SYS_win_surface, SYS_win_draw, SYS_win_raise,
  SYS_win_items,
  SYS_dataobj_create, SYS_dataobj_set, SYS_dataobj_get, SYS_dataobj_offer, SYS_dataobj_open,
  DOBJ_WHERE_CLIPBOARD, DOBJ_WHERE_DRAG, DOBJ_F_APPEND, fmtBit,
  WEV_BYTES, WIN_SET_TITLE, WIN_SET_BOX, WIN_SET_MODAL, WIN_SET_STATE, WIN_SET_ROLE,
  decodeWinEvents, encodeWinItems,
  DLOP_BYTES, DL_MAX_OPS, encodeDrawOp,
  TERMIOS_BYTES, WINSIZE_BYTES, POLLFD_BYTES, PFD_FD, PFD_EVENTS, PFD_REVENTS,
  TIOCGPGRP, TIOCSPGRP, encodeTermios, decodeTermios, decodeWinsize,
  SYS_getpgid, SYS_getppid, SYS_exit, SYS_clock_nanosleep, SYS_chdir, encodeSpawnRequest,
  STAT_EXITED, STAT_KILLED, WNOHANG,
  FILESTAT_BYTES, DIRENT_HEADER, DE_INO, DE_TYPE, DE_NLEN, direntSize,
  STATFS_BYTES, decodeFilestat, decodeStatfs,
  EINTR, EIO, EINVAL, isErr, nextCallId, unpackI64, packI64,
} from "../abi.mjs";

const now = () => performance.now();

let ctl = null;
let u8 = null;
let g = null;
let port = null;
let myPid = 0;
let callid = 0;
let kernelDown = false;

/** Wait-outcome and accounting tallies: issued == returned here, dispatched == replied there. */
const C = {
  issued: 0, returned: 0,
  ok: 0, notEqual: 0, spurious: 0, timedOut: 0, timedOutButReplied: 0,
  hostGone: 0, seqSkip: 0, intr: 0, kdown: 0, rlenFault: 0,
  signalsDrained: 0, signalBits: 0, interruptedAtEntry: 0,
  forcedNotEqual: 0, forcedOther: 0,
};

/** The same outcomes for the barrier: a re-arm waiting for release is not a 50 ms syscall. */
const B = {
  ok: 0, notEqual: 0, spurious: 0, timedOut: 0, timedOutButReplied: 0, hostGone: 0,
};

// The histogram is lossless, not a raw array: a 128 x 60k Float64Array is 61 MB and the allocation
// would land inside the measured region. Deltas from performance.now() are exact integer multiples
// of the clamp, so a bin width of one measured quantum loses nothing and the percentiles are exact.

const LIN_BINS = 400;          // 0..2 ms at a 5 us quantum
const LOG_BINS = 60;           // the linear top out to 10 s
const LOG_TOP_MS = 10000;

let quantumMs = 0.005;
let linTopMs = LIN_BINS * quantumMs;
let logStep = 1;
const lin = new Int32Array(LIN_BINS);
const log = new Int32Array(LOG_BINS);
let count = 0;
let sum = 0;
let sumsq = 0;
let min = Infinity;
let max = 0;
let beyondTop = 0;             // a sample no bin can represent. Non-zero INVALIDATES the run.

function setQuantum(ms) {
  // A zero or negative quantum makes every bin index NaN: nothing counted, yet a count reported.
  if (!(ms > 0)) throw new Error(`syscall.mjs: measured clock quantum is ${ms}`);
  quantumMs = ms;
  linTopMs = LIN_BINS * quantumMs;
  logStep = Math.log(LOG_TOP_MS / linTopMs) / LOG_BINS;
}

function bin(dt) {
  count += 1;
  sum += dt;
  sumsq += dt * dt;
  if (dt < min) min = dt;
  if (dt > max) max = dt;
  const i = Math.round(dt / quantumMs);
  if (i < LIN_BINS) {
    lin[i] += 1;
    return;
  }
  const j = Math.floor(Math.log(dt / linTopMs) / logStep);
  if (j >= LOG_BINS) {
    beyondTop += 1;
    return;
  }
  log[j] += 1;
}

let onsignal = null;

/**
 * The SIGPEND check at syscall entry (constraint 16). A process parked in Atomics.wait cannot
 * service postMessage, so a signal arrives as a bit here instead.
 *
 * IT RETURNS THE BITS IT DRAINED, because a pending signal must INTERRUPT the call rather than
 * merely be noticed before it. Any bit present means "interrupt": the kernel does not set SIGPEND
 * for a signal it drops or for one fatal by default, so the disposition is already applied.
 */
function drainSignals() {
  const bits = Atomics.exchange(ctl, SIGPEND, 0);
  if (bits !== 0) {
    C.signalsDrained += 1;
    C.signalBits |= bits;
    if (onsignal) onsignal(bits);
  }
  return bits;
}

/** The offered-rate gap for the rate-limited control. IT MUST BE IDLE RATHER THAN A SPIN: spinning
 *  workers starve the kernel and inflate the p99 the control is measuring. Nothing writes or
 *  notifies IDLE_PARK, so this wait always times out and costs no syscall. */
let think = () => {};

/** The negative control: skip the SIGPEND check at syscall entry entirely. */
let noSigpendCheck = false;

/**
 * The park, and every outcome Atomics.wait can return. Constraint 46: finite re-arm, heartbeat
 * check, and a timeout that NEVER faults a process on elapsed time alone. The watched word is an
 * argument because this is the one copy of the wake protocol — the syscall path watches (ctl, SEQ),
 * the barrier (globals, G_WINDOW). Returns true if that word changed, false if the kernel is gone.
 *
 * THE EXPECTED VALUE `s` STAYS CONSTANT ACROSS EVERY RE-ARM. If the reply lands between the timeout
 * returning and the next wait, a baseline re-read from SEQ parks for ever on a value that will
 * never change again.
 */
function park(arr, index, s, t) {
  let misses = 0;
  const tPark = now();
  let hb = Atomics.load(g, G_HEARTBEAT);
  for (;;) {
    const w = Atomics.wait(arr, index, s, REARM_MS);
    if (w !== "timed-out") {
      // "ok" and "not-equal" are ONE path: not-equal is the absence of a park, not an error
      // (constraint 7). The re-check is what makes that safe.
      if (Atomics.load(arr, index) !== s) {
        if (w === "ok") t.ok += 1; else t.notEqual += 1;
        return true;
      }
      t.spurious += 1;
      continue;
    }
    const hb2 = Atomics.load(g, G_HEARTBEAT);
    if (Atomics.load(arr, index) !== s) {
      // The reply landed inside the timeout-firing window: neither a timeout nor a not-equal, and
      // calling it a timeout would lose a reply.
      t.timedOutButReplied += 1;
      return true;
    }
    if (hb2 !== hb) {           // !== , not > , so i32 wraparound is harmless
      hb = hb2;
      misses = 0;
      t.timedOut += 1;
      continue;
    }
    if (++misses < HB_MISS_LIMIT) {
      t.timedOut += 1;
      continue;
    }
    // HB_MISS_LIMIT consecutive re-arms with no heartbeat ADVANCE, never elapsed time: an idle
    // waitpid takes thousands of silent re-arms and no fixed timeout separates that from a dead
    // kernel. THE DESIGNED TRADE: a kernel alive but SYNCHRONOUSLY BUSY for longer than
    // REARM_MS x HB_MISS_LIMIT is declared dead, so that product is a ceiling on synchronous work.
    t.hostGone += 1;
    kernelDown = true;
    // Stated in the SAB, because a terminated kernel worker cannot forward this conclusion.
    Atomics.store(ctl, KDOWN_MS, Math.round(now() - tPark));
    Atomics.store(ctl, KDOWN_SEEN, 1);
    return false;
  }
}

/** The raw ABI. Returns r0; r1 is readable with r1of(). Error iff isErr(r0, r1of()). */
export function syscall(
  nr, a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0, a6 = 0, a7 = 0,
  src = null, srcOff = 0, srcLen = 0,
) {
  // The entry check INTERRUPTS rather than observes: a pending bit returns -EINTR WITHOUT issuing
  // the call, which is what reaches a process that is computing rather than parked (the parked case
  // is kernel-side ST_INTR, docs/ABI.md decision 1). The exchange has already cleared the bits.
  if (noSigpendCheck) {
    think();
  } else if (drainSignals() !== 0) {
    C.interruptedAtEntry += 1;
    return -EINTR;
  } else {
    think();
  }
  if (kernelDown) return -EIO;

  ctl[A0] = a0 | 0; ctl[A0 + 1] = a1 | 0; ctl[A0 + 2] = a2 | 0; ctl[A0 + 3] = a3 | 0;
  ctl[A0 + 4] = a4 | 0; ctl[A0 + 5] = a5 | 0; ctl[A0 + 6] = a6 | 0; ctl[A0 + 7] = a7 | 0;
  ctl[NR] = nr | 0;
  ctl[LEN_I32] = srcLen | 0;
  if (srcLen > 0) u8.set(src.subarray(srcOff, srcOff + srcLen), DATA_OFF);

  const s = Atomics.load(ctl, SEQ);
  // One statement pair: the depth device cannot be inflated without the accounting identity too.
  Atomics.add(g, G_INFLIGHT, 1); C.issued += 1;
  callid = nextCallId(callid);
  // RELEASE: the last write before the post, which is how the plain stores above become visible to
  // the kernel. Move it earlier and the kernel can read the previous call's a0..a7 and NR.
  Atomics.store(ctl, CALLID, callid);
  const t0 = now();
  port.postMessage(callid);

  if (!park(ctl, SEQ, s, C)) return -EIO;
  bin(now() - t0);

  if (Atomics.load(ctl, SEQ) - s !== 1) C.seqSkip += 1;
  // RLEN is bounds-checked BEFORE any reply payload is read: a larger value is a kernel fault,
  // not an out-of-range read (constraint 9).
  if (Atomics.load(ctl, RLEN) > MAX_INLINE) {
    C.rlenFault += 1;
    return -EIO;
  }
  C.returned += 1;

  const st = ctl[STATUS];
  if (st === ST_RETURN) return ctl[R0];
  if (st === ST_INTR) { C.intr += 1; return -EINTR; }
  if (st === ST_KDOWN) { C.kdown += 1; kernelDown = true; return -EIO; }
  return -EIO;
}

/** The second return register. docs/ABI.md: r0 and r1 together are an i64, and r1 === -1 marks an
 *  error. Read it immediately after the call that produced it. */
export function r1of() {
  return ctl[R1];
}

/** Layer 2: the libc-shaped loop that consumes short counts. Every program calls this, never
 *  syscall(SYS_write) directly, which is why a 1 MiB write is 17 calls rather than a truncation. */
export function write(fd, buf) {
  let off = 0;
  while (off < buf.length) {
    const chunk = Math.min(buf.length - off, MAX_INLINE);
    const r = syscall(SYS_write, fd, 0, 0, 0, 0, 0, 0, 0, buf, off, chunk);
    if (isErr(r, r1of())) return r;
    if (r <= 0) break;          // no progress; a sink that returned 0 forever would spin here
    off += r;
  }
  return off;
}

// Layer 2 for the filesystem, so the short-count loop, the path encoding and the reply-record
// decoding each have one implementation. A path goes out as bytes in the process's own SAB and an
// fd comes back as an integer, which is the whole of what constraint 15 permits a process to hold.

const PATH_ENC = new TextEncoder();
const PATH_DEC = new TextDecoder();

/** A path as bytes in a PRIVATE buffer: the kernel's TextDecoder refuses a shared view. */
function pathBytes(path) {
  return PATH_ENC.encode(path);
}

/** Two paths, NUL-joined, as docs/ABI.md's `rename` specifies. */
function twoPaths(a, b) {
  return PATH_ENC.encode(`${a}\0${b}`);
}

export function open(path, flags, mode = 0o644) {
  const bytes = pathBytes(path);
  return syscall(SYS_open, flags, mode, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
}

export function close(fd) {
  return syscall(SYS_close, fd);
}

/** Read up to `want` bytes into `into` at `at`. Returns the count, 0 at EOF, or -errno. The copy
 *  out of the byte region is required: the region is reused by the next syscall. */
export function read(fd, into, at = 0, want = into.length - at) {
  const n = syscall(SYS_read, fd, Math.min(want, MAX_INLINE));
  if (n <= 0) return n;
  into.set(u8.subarray(DATA_OFF, DATA_OFF + n), at);
  return n;
}

/** pread/pwrite at an explicit offset, which does NOT move the fd's cursor. */
export function pread(fd, into, offset, want = into.length) {
  const [lo, hi] = packI64(offset);
  const n = syscall(SYS_pread, fd, Math.min(want, MAX_INLINE), lo, hi);
  if (n <= 0) return n;
  into.set(u8.subarray(DATA_OFF, DATA_OFF + n), 0);
  return n;
}

export function pwrite(fd, buf, offset) {
  const [lo, hi] = packI64(offset);
  return syscall(SYS_pwrite, fd, buf.length, lo, hi, 0, 0, 0, 0, buf, 0, buf.length);
}

export function readAll(fd, size) {
  const out = new Uint8Array(size);
  let off = 0;
  while (off < size) {
    const n = read(fd, out, off, size - off);
    if (n < 0) return n;
    if (n === 0) break;
    off += n;
  }
  return off === size ? out : out.subarray(0, off);
}

/** fsync is its own call (constraint 23): durability is paid when asked for, never per write. */
export function fsync(fd) {
  return syscall(SYS_fsync, fd);
}

export function ftruncate(fd, size) {
  const [lo, hi] = packI64(size);
  return syscall(SYS_ftruncate, fd, lo, hi);
}

export function seek(fd, offset, whence) {
  const [lo, hi] = packI64(offset);
  const r = syscall(SYS_seek, fd, lo, hi, whence);
  if (isErr(r, r1of())) return r;
  return Number(unpackI64(r, r1of()));
}

/** A 64-byte Filestat, decoded by the ONE codec in src/abi.mjs. */
function statAt(nr, a0, bytes) {
  const r = bytes === undefined
    ? syscall(nr, a0)
    : syscall(nr, 0, 0, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
  if (r < 0) return r;
  if (r !== FILESTAT_BYTES) return -EIO;
  const record = new Uint8Array(u8.subarray(DATA_OFF, DATA_OFF + FILESTAT_BYTES));
  return decodeFilestat(new DataView(record.buffer), 0);
}

export function fstat(fd) {
  return statAt(SYS_fstat, fd);
}

export function stat(path) {
  return statAt(SYS_stat, 0, pathBytes(path));
}

export function lstat(path) {
  return statAt(SYS_lstat, 0, pathBytes(path));
}

/** chdir(path). 0, or a negative errno. There is no `getcwd`: `/proc/<pid>/cwd` already publishes
 *  the answer, and `src/bin/sh.mjs` reads it that way. */
export function chdir(path) {
  const bytes = pathBytes(path);
  return syscall(SYS_chdir, 0, 0, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
}

export function mkdir(path, mode = 0o755) {
  const bytes = pathBytes(path);
  return syscall(SYS_mkdir, mode, 0, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
}

/** dup/dup2 share one file DESCRIPTION, so a seek through either moves both. */
export function dup(fd) {
  return syscall(SYS_dup, fd);
}

export function dup2(from, to) {
  return syscall(SYS_dup2, from, to);
}

export function rmdir(path) {
  const bytes = pathBytes(path);
  return syscall(SYS_rmdir, 0, 0, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
}

export function unlink(path) {
  const bytes = pathBytes(path);
  return syscall(SYS_unlink, 0, 0, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
}

export function truncate(path, size) {
  const bytes = pathBytes(path);
  const [lo, hi] = packI64(size);
  return syscall(SYS_truncate, lo, hi, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
}

export function chmod(path, mode) {
  const bytes = pathBytes(path);
  return syscall(SYS_chmod, mode, 0, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
}

export function chown(path, uid, gid) {
  const bytes = pathBytes(path);
  return syscall(SYS_chown, uid, gid, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
}

export function symlink(target, path) {
  const bytes = twoPaths(target, path);
  return syscall(SYS_symlink, 0, 0, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
}

export function linkAt(existing, path) {
  const bytes = twoPaths(existing, path);
  return syscall(SYS_link, 0, 0, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
}

export function rename(from, to) {
  const bytes = twoPaths(from, to);
  return syscall(SYS_rename, 0, 0, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
}

export function readlink(path) {
  const bytes = pathBytes(path);
  const n = syscall(SYS_readlink, 0, 0, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
  if (n < 0) return n;
  return PATH_DEC.decode(new Uint8Array(u8.subarray(DATA_OFF, DATA_OFF + n)));
}

/**
 * One batch of directory entries, and the cookie for the next. Unpacks docs/ABI.md's record:
 * [u64 ino][u8 type][u8 nlen][u16 pad][char[] name], each padded to four bytes.
 *
 * AN EMPTY BATCH IS THE END; `cookie === entries.length` is not, because a directory can run out
 * exactly at a batch boundary.
 */
export function readdir(fd, cookie = 0) {
  const n = syscall(SYS_readdir, fd, cookie);
  if (n < 0) return n;
  const next = r1of();
  const bytes = new Uint8Array(u8.subarray(DATA_OFF, DATA_OFF + n));
  const dv = new DataView(bytes.buffer);
  const out = [];
  let at = 0;
  while (at + DIRENT_HEADER <= bytes.length) {
    const ino = dv.getBigUint64(at + DE_INO, true);
    const type = bytes[at + DE_TYPE];
    const nlen = bytes[at + DE_NLEN];
    if (at + DIRENT_HEADER + nlen > bytes.length) return -EIO;
    const name = PATH_DEC.decode(bytes.subarray(at + DIRENT_HEADER, at + DIRENT_HEADER + nlen));
    out.push({ ino, type, name });
    at += direntSize(nlen);
  }
  return { entries: out, cookie: next, done: out.length === 0 };
}

/* What `spawn` + `pipe` + `setpgid` replaces `fork` with (constraint 20). Grouped on `env.proc` in
 * src/libos/process.mjs. */

/** pipe2(flags) -> {rfd, wfd}, or a negative errno. An OBJECT rather than a pair, because a caller
 *  that mixed up the order would wire a pipeline backwards, which looks like a hang. */
export function pipe2(flags = 0) {
  const r = syscall(SYS_pipe2, flags);
  if (r < 0) return r;
  return { rfd: r, wfd: r1of() };
}

/** spawn a child. `actions` are posix_spawn-shaped: `{op: SPAWN_DUP2, a: from, b: to}` and
 *  `{op: SPAWN_CLOSE, a: fd}`. The child inherits this process's whole fd table and THEN the
 *  actions rearrange it, which is posix_spawn's own order. */
export function spawn(path, argv = [], actions = []) {
  const bytes = encodeSpawnRequest({ path, argv, actions });
  if (bytes.length > MAX_INLINE) return -EINVAL;
  return syscall(SYS_spawn, 0, 0, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
}

/** waitpid(pid, flags) -> {pid, exited, killed, code}, or a negative errno. The status is in r1,
 *  encoded `(kind << 8) | value`: the kind bit exists because `exited` with code 0 and `killed` by
 *  signal 0 are otherwise indistinguishable. */
export function waitpid(pid = -1, flags = 0) {
  const r = syscall(SYS_waitpid, pid, flags);
  if (r < 0) return r;
  const status = r1of();
  const kind = (status >> 8) & 0xff;
  return {
    pid: r,
    exited: kind === STAT_EXITED,
    killed: kind === STAT_KILLED,
    code: status & 0xff,
  };
}

export function kill(pid, sig) {
  return syscall(SYS_kill, pid, sig);
}

/** Set a signal's disposition; returns the PREVIOUS one, or a negative errno. `SIG_HANDLE` means
 *  "set the bit and let the process notice at its next syscall entry", so a blocking `read` answers
 *  -EINTR and the caller decides. THE DISPOSITION IS THE WHOLE INTERFACE: there is no handler
 *  function to register, because a callback would be kernel-side state a process could not be
 *  killed out of (constraint 15). */
export function sigaction(sig, disp) {
  return syscall(SYS_sigaction, sig, disp);
}

export function setpgid(pid = 0, pgid = 0) {
  return syscall(SYS_setpgid, pid, pgid);
}

export function setsid() {
  return syscall(SYS_setsid);
}

export function getpgid(pid = 0) {
  return syscall(SYS_getpgid, pid);
}

export function getppid() {
  return syscall(SYS_getppid);
}

/** Never returns. The kernel reaps the caller, so there is nothing to come back to. */
export function exit(code = 0) {
  return syscall(SYS_exit, code & 0xff);
}

/** Sleep for `ns` NANOSECONDS. 0 on completion, -EINTR when a signal arrived first. It packs the
 *  (lo, hi) pair in one place: a caller open-coding `env.syscall(2, lo, hi, 0)` can pass (0, 0), a
 *  zero-nanosecond sleep answered on the next macrotask. -EINTR IS A NORMAL RETURN: an interrupted
 *  `sleep` slept for less time than it asked for. */
export function nanosleep(ns) {
  const [lo, hi] = packI64(ns);
  return syscall(SYS_clock_nanosleep, lo, hi, 0);
}

/** pty_open() -> {master, slave}, or a negative errno. */
export function ptyOpen() {
  const r = syscall(SYS_pty_open);
  if (r < 0) return r;
  return { master: r, slave: r1of() };
}

export function ttyGet(fd) {
  const n = syscall(SYS_tty_get, fd);
  if (n < 0) return n;
  const dv = new DataView(u8.buffer, DATA_OFF, TERMIOS_BYTES);
  return decodeTermios(dv, 0);
}

/** Replace a pty's termios. The caller supplies EVERY field, so `ttyGet`, mutate, `ttySet` is the
 *  only shape that stays correct: a flag a later milestone adds must survive a caller that has
 *  never heard of it. */
export function ttySet(fd, tm) {
  const bytes = new Uint8Array(TERMIOS_BYTES);
  encodeTermios(new DataView(bytes.buffer), 0, tm);
  return syscall(SYS_tty_set, fd, 0, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
}

export function ttyWinsizeGet(fd) {
  const n = syscall(SYS_tty_winsize_get, fd);
  if (n < 0) return n;
  return decodeWinsize(new DataView(u8.buffer, DATA_OFF, WINSIZE_BYTES), 0);
}

export function ttyWinsizeSet(fd, rows, cols) {
  return syscall(SYS_tty_winsize_set, fd, rows, cols);
}

/** tcgetpgrp / tcsetpgrp, which POSIX carries through ioctl. */
export function tcGetPgrp(fd) {
  return syscall(SYS_ioctl, fd, TIOCGPGRP);
}

export function tcSetPgrp(fd, pgid) {
  return syscall(SYS_ioctl, fd, TIOCSPGRP, pgid);
}

/** poll(fds, timeoutMs) -> {nready, fds: [{fd, events, revents}]}, or a negative errno. THE SINGLE
 *  WAIT PRIMITIVE OVER FDS (constraint 42): a process has one futex word and one outstanding call,
 *  so nothing else can wake it on a window plus a pipe. `revents` comes back IN PLACE in the byte
 *  region, so the returned rows carry it. */
export function poll(fds, timeoutMs = -1) {
  const n = fds.length;
  const bytes = new Uint8Array(n * POLLFD_BYTES);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < n; i += 1) {
    dv.setInt32(i * POLLFD_BYTES + PFD_FD, fds[i].fd | 0, true);
    dv.setUint16(i * POLLFD_BYTES + PFD_EVENTS, fds[i].events & 0xffff, true);
    dv.setUint16(i * POLLFD_BYTES + PFD_REVENTS, 0, true);
  }
  const r = syscall(SYS_poll, n, timeoutMs, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
  if (r < 0) return r;
  // The kernel wrote revents back into the SAB, not into `bytes`.
  const out = new DataView(u8.buffer, DATA_OFF, n * POLLFD_BYTES);
  return {
    nready: r,
    fds: fds.map((f, i) => ({
      fd: f.fd, events: f.events,
      revents: out.getUint16(i * POLLFD_BYTES + PFD_REVENTS, true),
    })),
  };
}

/* M7's window calls. A WINDOW IS A FILE DESCRIPTION: there is no `win_read` and no `win_poll`,
   because `read` and `poll` already work on the fd `winCreate` returns. */

/** win_create({title, w, h, owner, x, y}) -> {fd, win}, or a negative errno. TWO RETURNS: the fd
 *  is what this process waits on, and the winid is what ANOTHER process names to parent a window
 *  onto this one (`owner`). */
export function winCreate(spec = {}) {
  const bytes = PATH_ENC.encode(String(spec.title || ""));
  const r = syscall(
    SYS_win_create, spec.w | 0, spec.h | 0, spec.owner | 0, 0, spec.x | 0, spec.y | 0, 0, 0,
    bytes, 0, bytes.length,
  );
  if (r < 0) return r;
  return { fd: r, win: r1of() };
}

/** win_destroy(fd) -> the winids destroyed, oldest ancestor first, or a negative errno. THE LIST
 *  IS THE RETURN VALUE: destroying a parent destroys its children, so a caller that assumed one id
 *  would keep fds for windows the kernel has forgotten. The fd is closed by the kernel. */
export function winDestroy(fd) {
  const n = syscall(SYS_win_destroy, fd);
  if (n < 0) return n;
  const dv = new DataView(u8.buffer, DATA_OFF, n * 4);
  const ids = [];
  for (let i = 0; i < n; i += 1) ids.push(dv.getUint32(i * 4, true));
  return ids;
}

export function winSetTitle(fd, title) {
  const bytes = PATH_ENC.encode(String(title));
  return syscall(SYS_win_set, fd, WIN_SET_TITLE, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
}

/** Ask the page to move or resize. REQUESTED, not applied: the page owns the clamp, and the box it
 *  settled on arrives back as a WEV_RESIZE event and in `/proc/<pid>/win/<winid>`. */
export function winSetBox(fd, box) {
  return syscall(SYS_win_set, fd, WIN_SET_BOX, box.x | 0, box.y | 0, box.w | 0, box.h | 0);
}

/** M9. The two axes of an owned window: `scope` is WHICH windows this one affects and `mode` is
 *  WHAT happens to them. A window with no owner may only be system-modal or nothing, because both
 *  of the other scopes are defined by walking the owner chain. */
export function winSetModal(fd, scope, mode) {
  return syscall(SYS_win_set, fd, WIN_SET_MODAL, scope | 0, mode | 0);
}

/** Raise this window to the top, with the windows that ride with it. -EPERM when a modal blocks
 *  it: the kernel decides, and the refusal is a rule rather than a transient to retry. */
export function winRaise(fd) {
  return syscall(SYS_win_raise, fd);
}

/**
 * M14. Ask for a SHOW STATE — normal, minimized, maximized, snapped left or right. Returns the
 * state that was REACHED, which is not always the one asked for: restoring a minimized window
 * gives back what it was, so a window minimized while maximized comes back maximized (Win32's
 * `SW_RESTORE`). A caller that assumed its own argument would be wrong on the case a user hits
 * every day.
 *
 * The GEOMETRY is not this call's business: the shell lays the frame out for the state and reports
 * the box it settled on, exactly as it does for a drag (constraint 271).
 */
export function winSetState(fd, state) {
  return syscall(SYS_win_set, fd, WIN_SET_STATE, state | 0);
}

/** M14. Ask to BE something to the shell: an ordinary window, or the desktop. -EBUSY if another
 *  window already holds the desktop role, -EINVAL for an owned window — the owner chain exists so
 *  a dialog rides above its owner, and the desktop is the one window nothing may ride above. */
export function winSetRole(fd, role) {
  return syscall(SYS_win_set, fd, WIN_SET_ROLE, role | 0);
}

/**
 * M14. Publish this window's rows for the shell to draw: desktop icons, start-menu entries, or a
 * jump list, by the `WITEM_*` flag on each row. Returns how many rows the kernel now holds.
 *
 * THE LIST IS REPLACED WHOLE and `[]` withdraws it, which is what a program shutting down owes: a
 * jump list that outlived the window it describes is a menu of commands nothing can carry out.
 *
 * Encoded HERE through `src/abi.mjs`'s one codec, so no program writes a field offset — and a list
 * this ABI cannot carry (too many rows, a label too long, an icon nothing can draw) is -EINVAL
 * from this side rather than a round trip that fails.
 */
export function winItems(fd, items = []) {
  const bytes = encodeWinItems(items);
  if (bytes === null) return -EINVAL;
  return syscall(SYS_win_items, fd, 0, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
}

/** Ask the kernel for a surface of `w` x `h` DEVICE PIXELS on this window, or get an errno. The
 *  kernel owns it; this process is handed nothing and draws with `winDraw` (D31). */
export function winSurface(fd, w, h) {
  return syscall(SYS_win_surface, fd, w | 0, h | 0);
}

/**
 * One batch of display-list ops. The ops are encoded HERE, through `src/abi.mjs`'s one codec, so a
 * program never writes a field offset — and the batch is split at `DL_MAX_OPS`, which is derived
 * from the frame size rather than written down.
 *
 * Returns 0, or the first negative errno. A program that drew half a frame and was then refused
 * must be told, so the loop stops at the first refusal instead of reporting the last one.
 */
export function winDraw(fd, ops) {
  const bytes = new Uint8Array(DL_MAX_OPS * DLOP_BYTES);
  const dv = new DataView(bytes.buffer);
  for (let from = 0; from < ops.length; from += DL_MAX_OPS) {
    const batch = Math.min(DL_MAX_OPS, ops.length - from);
    for (let i = 0; i < batch; i += 1) encodeDrawOp(dv, i * DLOP_BYTES, ops[from + i]);
    const r = syscall(SYS_win_draw, fd, batch, 0, 0, 0, 0, 0, 0,
      bytes, 0, batch * DLOP_BYTES);
    if (r < 0) return r;
  }
  return 0;
}

/** Read whole window events: `read(2)` with the record decoding attached, so no program writes the
 *  offsets out again. A buffer under one record is -EINVAL from the kernel, never a short read. */
export function winRead(fd, max = 32) {
  const want = Math.min(max * WEV_BYTES, MAX_INLINE - (MAX_INLINE % WEV_BYTES));
  const n = syscall(SYS_read, fd, want);
  if (n <= 0) return n;
  // A COPY out of the byte region before decoding: the region is reused by the next syscall, so a
  // decoded record must not be a view onto it.
  const bytes = new Uint8Array(u8.subarray(DATA_OFF, DATA_OFF + n));
  return decodeWinEvents(bytes, n);
}

/* M10's data-object calls. A TYPED PAYLOAD AND NOT A BYTE BLOB: `dataobj_get` takes the format it
   wants and is REFUSED by name for one the object never offered, which is the whole difference
   between this and the `clipboard_read` it replaces (constraint 240). */

/** dataobj_create(formats) -> {fd, offer}, or a negative errno. `formats` is a LIST OF FORMAT IDS
 *  and the mask is built here through `src/abi.mjs`'s one packing, so no program writes a bit
 *  shift. The offer that comes back is the one the KERNEL settled on, which may be narrower. */
export function dataobjCreate(formats = []) {
  let mask = 0;
  for (const f of formats) mask |= fmtBit(f);
  const r = syscall(SYS_dataobj_create, mask);
  if (r < 0) return r;
  return { fd: r, offer: r1of() };
}

/**
 * Write one format's bytes, looping at MAX_INLINE. 0, or the first negative errno.
 *
 * THE LOOP IS LAYER 2's, exactly as `write`'s is: the first chunk REPLACES and every later one
 * APPENDS, so a 300 KiB PNG is five calls rather than a refusal. A program that wrote the loop
 * itself would get the first-chunk flag wrong once and silently append to a stale payload.
 */
export function dataobjSet(fd, format, bytes) {
  let off = 0;
  for (;;) {
    const chunk = Math.min(bytes.length - off, MAX_INLINE);
    const flags = off === 0 ? 0 : DOBJ_F_APPEND;
    const r = syscall(SYS_dataobj_set, fd, format, flags, 0, 0, 0, 0, 0, bytes, off, chunk);
    if (r < 0) {
      /* AND A REFUSAL MID-PAYLOAD LEAVES NOTHING BEHIND IT. `src/abi.mjs` promises that an object
       * nothing can carry is a REFUSAL and not a short count — "the formats are a SET and a
       * half-written image is not a smaller image" — and this loop was the one place that promise
       * could be broken: sixteen 64 KiB chunks accepted and the seventeenth refused -EFBIG left a
       * truncated bitmap readable under a format a receiver trusts. A critic found it while it was
       * still latent, because every program here frees the object on a refusal.
       *
       * The format is REPLACED WITH ZERO BYTES rather than left: "present and empty" is a state
       * `dataobj_get` already distinguishes from absent, and it cannot be mistaken for an image. A
       * failure to undo is reported in preference to the first errno, because then the object is
       * in neither state the caller can reason about. */
      if (off > 0) {
        const undo = syscall(SYS_dataobj_set, fd, format, 0, 0, 0, 0, 0, 0, bytes, 0, 0);
        if (undo < 0) return undo;
      }
      return r;
    }
    off += chunk;
    // An EMPTY payload is one call and means "this format is present and empty", so the test is
    // after the call and not before it.
    if (off >= bytes.length) return 0;
  }
}

/** Read one format WHOLE, or a negative errno. The total travels in r1, so the loop knows how much
 *  there is rather than reading until a short count — which cannot distinguish a final chunk from
 *  an object whose source stopped writing. */
export function dataobjGet(fd, format) {
  const first = syscall(SYS_dataobj_get, fd, format, 0);
  if (first < 0) return first;
  const total = r1of();
  const out = new Uint8Array(total);
  out.set(u8.subarray(DATA_OFF, DATA_OFF + first), 0);
  let off = first;
  while (off < total) {
    const n = syscall(SYS_dataobj_get, fd, format, off);
    if (n < 0) return n;
    if (n === 0) break;
    out.set(u8.subarray(DATA_OFF, DATA_OFF + n), off);
    off += n;
  }
  return off === total ? out : -EIO;
}

/** Publish to the clipboard. The object is SEALED by this and `dataobjSet` answers -EPERM
 *  afterwards: two readers of one object must not be shown different bytes. */
export function dataobjToClipboard(fd) {
  return syscall(SYS_dataobj_offer, fd, DOBJ_WHERE_CLIPBOARD);
}

/** Begin a drag from `winFd`, carrying this object. -EPERM unless the kernel saw a button go down
 *  in that window, and -EBUSY while another drag is live (constraint 244). */
export function dataobjDrag(fd, winFd, effects) {
  return syscall(SYS_dataobj_offer, fd, DOBJ_WHERE_DRAG, winFd, effects | 0);
}

/** An fd onto the clipboard's object, or onto a drop delivered to `winFd`. `{fd, offer}`, or a
 *  negative errno — -ENOENT for an empty clipboard and for a window with no uncollected drop. */
export function dataobjOpen(where, winFd = 0) {
  const r = syscall(SYS_dataobj_open, where, winFd);
  if (r < 0) return r;
  return { fd: r, offer: r1of() };
}

export function statfs() {
  const n = syscall(SYS_statfs);
  if (n < 0) return n;
  if (n !== STATFS_BYTES) return -EIO;
  const bytes = new Uint8Array(u8.subarray(DATA_OFF, DATA_OFF + STATFS_BYTES));
  return decodeStatfs(new DataView(bytes.buffer), 0);
}

/** The raw path that bypasses layer 2's split, for the check that an impossible length is refused
 *  loudly: the kernel must answer -EINVAL and leave its byte counter alone. */
export function rawWriteLength(fd, length) {
  ctl[A0] = fd | 0;
  ctl[NR] = SYS_write;
  ctl[LEN_I32] = length | 0;
  const s = Atomics.load(ctl, SEQ);
  Atomics.add(g, G_INFLIGHT, 1); C.issued += 1;
  callid = nextCallId(callid);
  Atomics.store(ctl, CALLID, callid);
  port.postMessage(callid);
  if (!park(ctl, SEQ, s, C)) return -EIO;
  C.returned += 1;
  return ctl[R0];
}

/** Constraint 7's fast path, FORCED. A check that waits for the natural occurrence either costs
 *  thousands of iterations or passes vacuously; this catches a kernel that only handles "ok". It
 *  repeats the marshal-and-post lines but calls the same park(), so the four-outcome logic still
 *  has exactly one copy. */
export function probeNotEqual(spinMs = 5) {
  const before = C.notEqual;
  ctl[NR] = SYS_getpid;         // a zero-work handler
  ctl[LEN_I32] = 0;
  const s = Atomics.load(ctl, SEQ);
  Atomics.add(g, G_INFLIGHT, 1); C.issued += 1;
  callid = nextCallId(callid);
  Atomics.store(ctl, CALLID, callid);
  port.postMessage(callid);
  const until = now() + spinMs;
  while (now() < until) { /* never yield: the reply is published while we hold the thread */ }
  const published = Atomics.load(ctl, SEQ) !== s;
  const replied = park(ctl, SEQ, s, C);
  if (replied) C.returned += 1;
  const got = C.notEqual > before;
  if (got) C.forcedNotEqual += 1; else C.forcedOther += 1;
  return { notEqual: got, publishedBeforePark: published, r0: ctl[R0] };
}

/**
 * The heartbeat-gap distribution. HB_MISS_LIMIT is set from this (Decision 2). It reads the globals
 * SAB, which a program never receives (constraint 15).
 *
 * DEVIATION, stated where it is introduced: this POLLS rather than parking, because a parked
 * process reads the heartbeat once per REARM_MS — twenty times coarser than the signal. The cost is
 * one busy process, so the observer's figures are a separate row and the sweep's N excludes it.
 */
export function observeHeartbeat(untilLocalMs) {
  const gaps = [];
  let last = Atomics.load(g, G_HEARTBEAT);
  let tLast = now();
  const started = tLast;
  const until = untilLocalMs;
  for (;;) {
    const t = now();
    if (t >= until) break;
    const v = Atomics.load(g, G_HEARTBEAT);
    if (v !== last) {
      gaps.push(t - tLast);
      last = v;
      tLast = t;
    }
  }
  gaps.sort((a, b) => a - b);
  const at = (q) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.ceil(q * gaps.length) - 1)] : 0);
  return {
    windowMs: now() - started,
    advances: gaps.length,
    p50Ms: at(0.5),
    p99Ms: at(0.99),
    p999Ms: at(0.999),
    maxMs: gaps.length ? gaps[gaps.length - 1] : 0,
  };
}

// THE BARRIER. Without one the windows do not overlap and the first dispatch of each process sees
// an arrival backlog of one, so a sweep measures a partially loaded kernel and calls it contention.
// BOTH EDGES ARE NEEDED: W_PRE -> W_OPEN releases everyone together, the FIRST process to reach the
// deadline moves W_OPEN -> W_CLOSED to keep the ramp-down out of the kernel's depth histogram, and
// W_DONE, set by the kernel once every process has left, gates the out-of-window checks.

export function barrierArrive() {
  const tArrive = now();
  Atomics.add(g, G_BARRIER, 1);
  while (Atomics.load(g, G_WINDOW) === W_PRE) {
    if (!park(g, G_WINDOW, W_PRE, B)) return { released: false, why: "kernel gone at the barrier" };
  }
  // ONE deadline for the cell. performance.now() instants are NOT comparable across agents, so the
  // wall clock carries the deadline and the monotonic clock runs the loop.
  const wall = Date.now();
  const deadlineWall = Number(unpackI64(
    Atomics.load(g, G_DEADLINE_LO), Atomics.load(g, G_DEADLINE_HI),
  ));
  return {
    released: true,
    waitedMs: now() - tArrive,
    releasedWall: wall,
    deadlineWall,
    untilLocalMs: now() + (deadlineWall - wall),
  };
}

export function barrierDepart() {
  const leftWall = Date.now();
  // The first departure closes the depth window, so no ramp-down sample can enter it.
  const first = Atomics.compareExchange(g, G_WINDOW, W_OPEN, W_CLOSED) === W_OPEN;
  Atomics.add(g, G_BARRIER, 1);
  while (Atomics.load(g, G_WINDOW) !== W_DONE) {
    if (!park(g, G_WINDOW, W_CLOSED, B)) return { left: false, leftWall, closedTheWindow: first };
  }
  return { left: true, leftWall, closedTheWindow: first };
}

export function barrierCounters() {
  return { ...B };
}

/** Advance the program-visible progress word. NOT a syscall but a plain atomic store into the
 *  process's own SAB, so a program can say "I reached phase N" without being inside a syscall. */
export function publishProgress(n) {
  Atomics.store(ctl, P_PROGRESS, n | 0);
}

export function initSyscall(opts) {
  ctl = opts.ctl;
  u8 = opts.u8;
  g = opts.g;
  port = opts.port;
  myPid = opts.pid;
  noSigpendCheck = !!opts.noSigpend;
  // Four bytes, read once: a wrong magic or a stale SAB fails here rather than six calls in.
  const seenMagic = Atomics.load(ctl, H_MAGIC);
  const seenVersion = Atomics.load(ctl, H_VERSION);
  if ((seenMagic | 0) !== (SAB_MAGIC | 0)) {
    throw new Error(`syscall.mjs: SAB magic ${seenMagic} != ${SAB_MAGIC}; this is an ABI break `
      + "that MAGIC/VERSION exist to catch. Refuse to start rather than execute against a frame "
      + "a kernel might read differently.");
  }
  if (seenVersion !== SAB_VERSION) {
    throw new Error(`syscall.mjs: SAB version ${seenVersion} != ${SAB_VERSION}; a kernel one `
      + "step ahead of this stub would read the registers at different offsets.");
  }
  setQuantum(opts.quantumMs);
  // Boot-time specialisation, not a per-call branch, so the headline path has no control branch.
  const thinkUs = Atomics.load(g, G_THINK_US);
  if (thinkUs > 0) {
    // Anything that writes IDLE_PARK makes the wait below return "not-equal" immediately, the gap
    // becomes zero, and the rate-limited control passes while rate-limiting nothing.
    if (Atomics.load(ctl, IDLE_PARK) !== 0) {
      throw new Error(`syscall.mjs: IDLE_PARK is ${Atomics.load(ctl, IDLE_PARK)}, not 0; the `
        + "think gap would not wait and the rate-limited control would be vacuous");
    }
    const thinkMs = thinkUs / 1000;
    think = () => { Atomics.wait(ctl, IDLE_PARK, 0, thinkMs); };
  }
  onsignal = opts.onsignal || null;
}

export function resetSamples() {
  lin.fill(0);
  log.fill(0);
  count = 0; sum = 0; sumsq = 0; min = Infinity; max = 0; beyondTop = 0;
}

/** The raw histogram and every tally. summarise.mjs alone turns these into percentiles. */
export function samples() {
  return {
    pid: myPid,
    quantumMs,
    linBins: LIN_BINS,
    logBins: LOG_BINS,
    logTopMs: LOG_TOP_MS,
    lin: Array.from(lin),
    log: Array.from(log),
    count, sum, sumsq,
    min: count ? min : 0,
    max,
    beyondTop,
    kernelDown,
    ...C,
  };
}

