// The in-process syscall stub. This file is the trust boundary in file form: it runs inside a
// process, so it is reviewed as untrusted-adjacent. It acquires nothing the kernel did not hand it
// — one SAB, the globals SAB and one MessagePort, all three of which the kernel also holds.
//
// Two layers, deliberately. syscall() is the raw ABI and returns short counts; write() below is
// the libc-shaped loop that consumes them. That split is the whole answer to overflow above
// MAX_INLINE (docs/ABI.md decision 4, constraint 9).

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
  SYS_pipe2, SYS_spawn, SYS_waitpid, SYS_kill, SYS_setpgid, SYS_setsid,
  SYS_getpgid, SYS_getppid, SYS_exit, encodeSpawnRequest,
  STAT_EXITED, STAT_KILLED, WNOHANG,
  FILESTAT_BYTES, DIRENT_HEADER, decodeFilestat,
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

/** Wait-outcome and accounting tallies. Two counters per agent is what ties every increment to a
 *  message the kernel actually dispatched: issued == returned here, dispatched == replied there. */
const C = {
  issued: 0, returned: 0,
  ok: 0, notEqual: 0, spurious: 0, timedOut: 0, timedOutButReplied: 0,
  hostGone: 0, seqSkip: 0, intr: 0, kdown: 0, rlenFault: 0,
  signalsDrained: 0, signalBits: 0, interruptedAtEntry: 0,
  forcedNotEqual: 0, forcedOther: 0,
};

/** The same five outcomes, tallied separately for the barrier: a re-arm spent waiting to be
 *  released is not a syscall that took 50 ms, and adding it to C would say it was. */
const B = {
  ok: 0, notEqual: 0, spurious: 0, timedOut: 0, timedOutButReplied: 0, hostGone: 0,
};

// ---------------------------------------------------------------------------- the histogram
//
// Lossless, not a raw array. A 128 x 60k Float64Array is 61 MB and the allocation would land
// inside the measured region. Deltas from performance.now() are exact integer multiples of the
// clamp, so a bin width of one measured quantum loses nothing and the percentiles are exact
// rather than interpolated.

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
  // A zero or negative quantum makes every bin index NaN and the histogram would silently count
  // nothing while reporting a count. Fail at init instead.
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

// ---------------------------------------------------------------------------- signals

let onsignal = null;

/**
 * Constraint 16. A process parked in Atomics.wait cannot service postMessage, so a signal cannot
 * arrive that way; it arrives as a bit in SIGPEND and is drained at syscall entry.
 *
 * M1 replaces the body with handler dispatch and must add masking — exchange, then restore the
 * masked bits. The seam exists at M0 so M1's negative control (remove this call, Ctrl-C must stop
 * working) has something to remove.
 */
/**
 * The SIGPEND check at syscall entry (constraint 16). Returns the bits it drained, because a
 * pending signal must INTERRUPT the call rather than merely be noticed before it.
 *
 * It returned nothing at first, and that was the defect M1's negative control was built to catch:
 * the bit was read, cleared, recorded, and the syscall then proceeded normally, so a signal raised
 * at a RUNNING process was seen and discarded. Measured with the `entry` program — 400 rounds of
 * arithmetic with a SIGINT raised in the middle — the process never observed it and ran to
 * completion.
 *
 * Any bit present here means "interrupt": the kernel does not set SIGPEND for a signal it is
 * dropping (SIG_IGN returns before the store) or for one that is fatal by default (those reap the
 * process instead), so the disposition has already been applied kernel-side and the stub does not
 * need to know it.
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

// ---------------------------------------------------------------------------- think time

/**
 * The offered-rate gap for the rate-limited control, and it MUST be idle rather than a spin.
 *
 * A performance.now() busy-spin was measured to break the control's own subject: at N=16 with
 * --think-us 2000 the gates failed as designed AND the p99 went to 8,270 us, because sixteen
 * spinning workers on twelve cores starve the kernel. The control is supposed to show the gates
 * failing while the latency HOLDS, so the gap has to release the core.
 *
 * Atomics.wait on IDLE_PARK is that: nothing ever writes or notifies that word, so the wait always
 * times out, and it costs no syscall — a clock_nanosleep gap would put one extra round trip per
 * iteration inside the thing being measured.
 */
let think = () => {};

/** M1's negative control: skip the SIGPEND check at syscall entry entirely. */
let noSigpendCheck = false;

// ---------------------------------------------------------------------------- the park

/**
 * The park, and every outcome Atomics.wait can return. Constraint 46: finite re-arm, heartbeat
 * check, and a timeout that NEVER faults a process on elapsed time alone.
 *
 * THE EXPECTED VALUE `s` STAYS CONSTANT ACROSS EVERY RE-ARM. Re-reading SEQ as a fresh baseline is
 * the bug this sentence exists to prevent: if the reply landed between the timeout returning and
 * the next wait, a re-read baseline parks forever on a value that will never change again.
 *
 * This is the ONE copy of the wake protocol, which is why it takes the word to watch as an
 * argument: the syscall path watches (ctl, SEQ) and the barrier watches (globals, G_WINDOW), and a
 * second copy of the five outcomes is the defect — two renderers of one fact, with nobody
 * exercising the second. probeNotEqual() below repeats the four lines of marshal-and-post for the
 * same reason, and calls this.
 *
 * @returns true if the watched word changed, false if the kernel is gone.
 */
function park(arr, index, s, t) {
  let misses = 0;
  const tPark = now();
  let hb = Atomics.load(g, G_HEARTBEAT);
  for (;;) {
    const w = Atomics.wait(arr, index, s, REARM_MS);
    if (w !== "timed-out") {
      // "ok" and "not-equal" are ONE path: not-equal is the absence of a park, not an error
      // (constraint 7). The re-check is what makes them one path safely — a notify with nothing
      // published must never return the previous call's r0.
      if (Atomics.load(arr, index) !== s) {
        if (w === "ok") t.ok += 1; else t.notEqual += 1;
        return true;
      }
      t.spurious += 1;
      continue;
    }
    const hb2 = Atomics.load(g, G_HEARTBEAT);
    if (Atomics.load(arr, index) !== s) {
      // The fourth outcome: the reply landed inside the timeout-firing window. Neither a timeout
      // nor a not-equal, and a stub that called it a timeout would lose a reply. A non-zero count
      // at REARM_MS means re-arm-length syscalls exist and the headline is suspect.
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
    // HB_MISS_LIMIT consecutive re-arms with no heartbeat ADVANCE. Never elapsed time: a
    // clock_nanosleep(500 ms) takes ten silent re-arms and an idle waitpid at M1 takes thousands,
    // and no fixed timeout can separate those from a dead kernel.
    //
    // THE DESIGNED TRADE, where the reader meets the -EIO: a kernel that is alive but
    // SYNCHRONOUSLY BUSY for longer than REARM_MS x HB_MISS_LIMIT is indistinguishable from a dead
    // one here, and is declared dead. That is the cost of constraint 46's rule that elapsed time
    // alone must never fault a process, and it makes that product a hard ceiling on any
    // synchronous kernel work — M2's flush and snapshot included.
    t.hostGone += 1;
    kernelDown = true;
    // Stated in the SAB, because the port is the thing that died: a terminated kernel worker
    // cannot forward this process's conclusion, so it records it where whoever still holds the
    // SAB can read it.
    Atomics.store(ctl, KDOWN_MS, Math.round(now() - tPark));
    Atomics.store(ctl, KDOWN_SEEN, 1);
    return false;
  }
}

// ---------------------------------------------------------------------------- the stub

/**
 * The raw ABI. Returns r0; r1 is readable with r1of() for the calls that use an i64 or a pair.
 * Error iff isErr(r0, r1of()).
 */
export function syscall(
  nr, a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0, a6 = 0, a7 = 0,
  src = null, srcOff = 0, srcLen = 0,
) {
  // The entry check, and it interrupts rather than observes. A pending bit returns -EINTR WITHOUT
  // issuing the call, which is what makes Ctrl-C reach a process that is computing rather than
  // parked — the parked case is handled kernel-side by ST_INTR (docs/ABI.md decision 1).
  //
  // The bits are already cleared by the exchange, so the caller's next syscall proceeds: a program
  // that answers -EINTR by calling exit() is not interrupted again on the way out.
  if (noSigpendCheck) {
    // The M1 negative control: skip the entry check entirely. Ctrl-C must stop working for a
    // process that is not parked, which is the claim constraint 16 makes.
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
  // One statement pair, so the depth device cannot be inflated without also inflating the
  // accounting identity that ties it to a dispatched message (section 5 of the design).
  Atomics.add(g, G_INFLIGHT, 1); C.issued += 1;
  callid = nextCallId(callid);
  // RELEASE: the last write before the post. The plain stores above are made visible to the
  // kernel by its matching Atomics.load of CALLID. Move this earlier and the kernel can read the
  // previous call's a0..a7 and NR.
  Atomics.store(ctl, CALLID, callid);
  const t0 = now();
  port.postMessage(callid);

  if (!park(ctl, SEQ, s, C)) return -EIO;
  bin(now() - t0);

  if (Atomics.load(ctl, SEQ) - s !== 1) C.seqSkip += 1;
  // The reply direction is where wanix actually failed: bounds-check RLEN BEFORE reading any
  // reply payload. A larger value is a kernel fault, not an out-of-range read (constraint 9).
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

/**
 * Layer 2: the libc-shaped loop that consumes short counts. Every program calls this, never
 * syscall(SYS_write) directly, which is why a 1 MiB write is 17 calls rather than a truncation.
 */
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

// ---------------------------------------------------------------------------- M2: the file API
//
// Layer 2 for the filesystem. A program calls these, never `syscall(SYS_open)` directly, for the
// same reason it calls write() rather than syscall(SYS_write): the short-count loop, the path
// encoding and the reply-record decoding each want exactly one implementation.
//
// EVERY ONE OF THESE RUNS INSIDE A PROCESS and acquires nothing. A path goes out as bytes in the
// process's own SAB and an fd comes back as an integer, which is the whole of what constraint 15
// permits a process to hold.

const PATH_ENC = new TextEncoder();
const PATH_DEC = new TextDecoder();

/** A path as bytes in a PRIVATE buffer. The kernel copies it out of the SAB before decoding —
 *  TextDecoder refuses a shared view — and this is the encoding half of that pair. */
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

/**
 * Read up to `want` bytes into `into` at `at`. Returns the count, 0 at EOF, or -errno.
 *
 * The bytes land in the process's own byte region and are copied out here, because `into` is the
 * caller's private buffer and the region is reused by the next syscall.
 */
export function read(fd, into, at = 0, want = into.length - at) {
  const n = syscall(SYS_read, fd, Math.min(want, MAX_INLINE));
  if (n <= 0) return n;
  into.set(u8.subarray(DATA_OFF, DATA_OFF + n), at);
  return n;
}

/**
 * pread/pwrite: the same two calls at an explicit offset, which does NOT move the fd's cursor.
 * That is the whole reason they exist — two readers sharing one description must be able to read
 * different places — so the offset goes out as an (lo, hi) pair and the cursor is never touched.
 */
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

/** The whole of a file, through the short-count loop. Returns bytes or -errno. */
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

/** fsync is its own call (constraint 23): the 260 us flush is paid when a caller asks for
 *  durability, never per write. */
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

export function mkdir(path, mode = 0o755) {
  const bytes = pathBytes(path);
  return syscall(SYS_mkdir, mode, 0, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
}

/** dup/dup2 share one file DESCRIPTION, so a seek through either moves both. That is POSIX's own
 *  shape and it is what makes `2>&1` mean anything. */
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
 * `cookie === entries.length` is NOT the end condition — a directory can run out exactly at a
 * batch boundary. An empty batch is the end, which is what `readdir(3)` means by a null return.
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
    const ino = dv.getBigUint64(at, true);
    const type = bytes[at + 8];
    const nlen = bytes[at + 9];
    if (at + DIRENT_HEADER + nlen > bytes.length) return -EIO;
    const name = PATH_DEC.decode(bytes.subarray(at + DIRENT_HEADER, at + DIRENT_HEADER + nlen));
    out.push({ ino, type, name });
    at += (DIRENT_HEADER + nlen + 3) & ~3;
  }
  return { entries: out, cookie: next, done: out.length === 0 };
}

/* --------------------------- M4: pipes and process control ---------------------------
 *
 * These are the calls `spawn` + `pipe` + `setpgid` replaces `fork` with (constraint 20). Grouped
 * on `env.proc` in src/libos/process.mjs for the reason `FS` is grouped: constraint 15's seam is
 * asserted by ENUMERATING what a program was handed, and one object of functions keeps that
 * enumeration readable.
 */

/**
 * pipe2(flags) -> {rfd, wfd}, or a negative errno.
 *
 * Two fds from one call, so the write end comes back in r1 — the same channel `seek` uses for the
 * high half of an i64 and `readdir` for its cookie. Returned as an OBJECT rather than a pair,
 * because a caller that mixed up the order of a two-element array would wire a pipeline backwards
 * and the mistake would look like a hang.
 */
export function pipe2(flags = 0) {
  const r = syscall(SYS_pipe2, flags);
  if (r < 0) return r;
  return { rfd: r, wfd: r1of() };
}

/**
 * spawn a child. `actions` are posix_spawn-shaped: `{op: SPAWN_DUP2, a: from, b: to}` and
 * `{op: SPAWN_CLOSE, a: fd}`.
 *
 * The child inherits this process's whole fd table and THEN the actions rearrange it, which is
 * posix_spawn's own order and what lets a shell say "put the pipe's write end on 1, then close the
 * pipe fd". Encoding is the shared codec in src/abi.mjs, so there is one definition of the bytes.
 */
export function spawn(path, argv = [], actions = []) {
  const bytes = encodeSpawnRequest({ path, argv, actions });
  if (bytes.length > MAX_INLINE) return -EINVAL;
  return syscall(SYS_spawn, 0, 0, 0, 0, 0, 0, 0, 0, bytes, 0, bytes.length);
}

/**
 * waitpid(pid, flags) -> {pid, exited, killed, code}, or a negative errno.
 *
 * The status is in r1, encoded `(kind << 8) | value` by the kernel — the only call that uses r1 as
 * a value rather than as the error sentinel. Decoded here so a caller never open-codes the shift:
 * `exited` with code 0 and `killed` by signal 0 are the two states that would otherwise be
 * indistinguishable, which is why the kernel carries a kind bit at all.
 */
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

export function statfs() {
  const n = syscall(SYS_statfs);
  if (n < 0) return n;
  const bytes = new Uint8Array(u8.subarray(DATA_OFF, DATA_OFF + n));
  const dv = new DataView(bytes.buffer);
  return {
    blocks: dv.getBigUint64(0, true), bfree: dv.getBigUint64(8, true),
    files: dv.getBigUint64(16, true), ffree: dv.getBigUint64(24, true),
    bsize: dv.getUint32(32, true), namemax: dv.getUint32(36, true),
  };
}

/**
 * The raw path that bypasses layer 2's split, for the check that an impossible length is refused
 * loudly rather than clamped. The kernel must answer -EINVAL and leave its byte counter alone.
 */
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

/**
 * Constraint 7's fast path, FORCED. A check that waits for a natural 0.065% occurrence either
 * costs thousands of iterations or passes vacuously; this is what would catch a kernel that only
 * handles "ok". Post, busy-spin without yielding until the reply has certainly landed, then park.
 *
 * It repeats the marshal-and-post lines on purpose and calls the same park() as the hot path, so
 * the four-outcome logic still has exactly one copy.
 */
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
 * The heartbeat-gap distribution, the number Decision 2 makes M0 owe M1: HB_MISS_LIMIT is set
 * from this, and M1 restates its "within 2x the re-arm interval" bar from it rather than guessing.
 *
 * It lives here because it reads the globals SAB, which a program never receives (constraint 15),
 * and it is the same Atomics.load a parked process does in park()'s timed-out branch.
 *
 * DEVIATION, stated where it is introduced: this POLLS rather than parking. A parked process reads
 * the heartbeat once per REARM_MS (50 ms), which cannot resolve the distribution of a 10 ms-period
 * signal — the measurement would be quantised twenty times coarser than the thing measured. The
 * cost is one busy process, so the observer's own figures are reported as a separate row and the
 * sweep's N excludes it.
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

// ---------------------------------------------------------------------------- the barrier
//
// Why a barrier exists at all: without one, every process runs its own warm-up and then its own
// window, the windows do not overlap, and the first dispatch of each window genuinely sees an
// arrival backlog of one. A sweep whose processes are not simultaneously inside their measured
// windows is measuring a partially loaded kernel and calling the result contention.
//
// Both edges are needed. G_WINDOW: W_PRE -> W_OPEN releases everyone together; the FIRST process
// to reach the deadline moves it W_OPEN -> W_CLOSED, which is what keeps the ramp-down — processes
// stopping one at a time — out of the kernel's depth histogram. The kernel moves it to W_DONE once
// every process has left, and only then may a process issue the out-of-window checks.

/** Arrive, park until released, and return the window this process must run. */
export function barrierArrive() {
  const tArrive = now();
  Atomics.add(g, G_BARRIER, 1);
  while (Atomics.load(g, G_WINDOW) === W_PRE) {
    if (!park(g, G_WINDOW, W_PRE, B)) return { released: false, why: "kernel gone at the barrier" };
  }
  // ONE deadline for the cell, published once by the kernel in the shared wall clock, then
  // derived into this agent's own monotonic clock exactly once. performance.now() instants are not
  // comparable across agents — timeOrigin differs — so the wall clock carries the deadline and the
  // monotonic clock runs the loop.
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

/** Leave the window: close it for everyone, then park until every process has left. */
export function barrierDepart() {
  const leftWall = Date.now();
  // The first departure closes the depth window, at dispatch-entry granularity in the kernel, so
  // not one ramp-down sample can enter it.
  const first = Atomics.compareExchange(g, G_WINDOW, W_OPEN, W_CLOSED) === W_OPEN;
  Atomics.add(g, G_BARRIER, 1);
  while (Atomics.load(g, G_WINDOW) !== W_DONE) {
    if (!park(g, G_WINDOW, W_CLOSED, B)) return { left: false, leftWall, closedTheWindow: first };
  }
  return { left: true, leftWall, closedTheWindow: first };
}

/** The barrier's own wait outcomes, reported separately from the syscall path's. */
export function barrierCounters() {
  return { ...B };
}

// ---------------------------------------------------------------------------- init and readout

/**
 * Advance the program-visible progress word. NOT a syscall: it is a plain atomic store into the
 * process's own SAB, so a program can say "I reached phase N" without being inside a syscall when
 * an observer reacts. M1's proof (e) needs that distinction — see bench/m1-lifecycle/program.mjs.
 */
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
  // M1 (f). Four bytes, read once. A kernel that wrote the wrong magic, or a stale SAB from a
  // kernel running a previous ABI version, fails here rather than six calls in as a wrong reply.
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
  // Boot-time specialisation, not a per-call branch: the headline path contains no control
  // branch at all, so "your flags perturbed the measurement" is not available as an objection.
  const thinkUs = Atomics.load(g, G_THINK_US);
  if (thinkUs > 0) {
    // If anything ever writes IDLE_PARK, the wait below returns "not-equal" immediately, the gap
    // silently becomes zero and the rate-limited control passes while rate-limiting nothing.
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

/** The raw histogram and every tally. summarise.mjs is the only thing that turns these into
 *  percentiles, so the bench and the suite cannot disagree about what a p99 means. */
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

export { kernelDown as isKernelDown };
