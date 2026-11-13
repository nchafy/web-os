// The in-process syscall stub. This file is the trust boundary in file form: it runs inside a
// process, so it is reviewed as untrusted-adjacent. It acquires nothing the kernel did not hand it
// — one SAB, the globals SAB and one MessagePort, all three of which the kernel also holds.
//
// Two layers, deliberately. syscall() is the raw ABI and returns short counts; write() below is
// the libc-shaped loop that consumes them. That split is the whole answer to overflow above
// MAX_INLINE (docs/ABI.md decision 4, constraint 9).

import {
  SEQ, STATUS, RLEN, SIGPEND, CALLID, NR, A0, R0, R1, KDOWN_SEEN, KDOWN_MS, IDLE_PARK,
  LEN_I32, DATA_OFF, MAX_INLINE,
  ST_RETURN, ST_INTR, ST_KDOWN,
  REARM_MS, HB_MISS_LIMIT, G_HEARTBEAT, G_INFLIGHT, G_THINK_US,
  G_WINDOW, G_BARRIER, G_DEADLINE_LO, G_DEADLINE_HI, W_PRE, W_OPEN, W_CLOSED, W_DONE,
  SYS_getpid, SYS_write, EINTR, EIO, isErr, nextCallId, unpackI64,
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
  signalsDrained: 0, signalBits: 0,
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
function drainSignals() {
  const bits = Atomics.exchange(ctl, SIGPEND, 0);
  if (bits !== 0) {
    C.signalsDrained += 1;
    C.signalBits |= bits;
    if (onsignal) onsignal(bits);
  }
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
  drainSignals();
  think();
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

export function initSyscall(opts) {
  ctl = opts.ctl;
  u8 = opts.u8;
  g = opts.g;
  port = opts.port;
  myPid = opts.pid;
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
