// The program a process runs: a closed syscall loop with no think time, so N processes offer N
// outstanding calls and the kernel's arrival backlog is the measurement. Per-call timing and the
// lossless histogram live in the stub, the only place that can bracket the park.
//
// Modes (m.mode / m.call): park, getpid, write, nanosleep, io.
import {
  SYS_getpid, SYS_write, SYS_clock_nanosleep, SYS_open, SYS_fsync,
  O_WRONLY, O_CREAT, O_TRUNC,
  MAX_INLINE, packI64, fnv1a, FNV1A_BASIS,
} from "/src/abi.mjs";

const now = () => performance.now();

/** A fixed payload, allocated once: an allocation inside the loop would be measured. */
function payload(bytes) {
  const buf = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
}

/**
 * Everything this process intended to send through fd 1, in order, as one running checksum.
 *
 * One accumulator over the whole run, never one per phase: the kernel's sink is cumulative, so a
 * per-phase checksum compares two different byte streams and reports a meaningless mismatch.
 *
 * The hash and its seed are imported, not restated. Two hand-synced copies would drift together
 * and this comparison would become a tautology.
 */
const sent = { sum: FNV1A_BASIS, bytes: 0 };

function track(buf, length) {
  if (length <= 0) return;
  sent.sum = fnv1a(buf, 0, length, sent.sum);
  sent.bytes += length;
}

/**
 * The measured window. `until` is not this process's own idea of when to stop: it is the one
 * deadline the kernel published at the barrier release, derived into this agent's clock once.
 */
function runWindow(env, { call, until, buf }) {
  const t0 = now();
  let calls = 0;
  let wrong = 0;
  if (call === "getpid") {
    while (now() < until) {
      if (env.syscall(SYS_getpid) !== env.pid) wrong += 1;
      calls += 1;
    }
  } else if (call === "write") {
    while (now() < until) {
      const r = env.syscall(SYS_write, 1, 0, 0, 0, 0, 0, 0, 0, buf, 0, buf.length);
      if (r !== buf.length) wrong += 1;
      else track(buf, r);
      calls += 1;
    }
  } else if (call === "nanosleep") {
    while (now() < until) {
      if (env.syscall(SYS_clock_nanosleep, 1000000, 0, 0) !== 0) wrong += 1;
      calls += 1;
    }
  } else {
    throw new Error(`loop.mjs: unknown call ${call}`);
  }
  const t1 = now();
  return { calls, wrong, firstMs: t0, lastMs: t1, spanMs: t1 - t0 };
}

/**
 * M0a's arrangement: a few processes do real OPFS work, the rest issue getpid. The subject is what
 * a getpid costs while someone else's file I/O is in flight, so the two groups run in the same
 * window and are reported separately — a pooled figure hides it.
 *
 * The split is by role rather than by alternating calls inside one process: a process that
 * interleaves its own cheap and expensive calls measures its own queue, not the kernel's.
 */
function runIoWindow(env, { until, buf, ioRole }) {
  const t0 = now();
  let calls = 0;
  let wrong = 0;
  let fd = -1;
  let opened = 0;
  if (ioRole) {
    // One open per process, then fd I/O: constraint 22, open is rare and fd I/O common.
    const name = new TextEncoder().encode(`/m0a-${env.pid}.bin`);
    fd = env.syscall(SYS_open, O_WRONLY | O_CREAT | O_TRUNC, 0o644,
      0, 0, 0, 0, 0, 0, name, 0, name.length);
    if (fd < 0) return { calls: 0, wrong: 1, openErrno: fd, firstMs: t0, lastMs: now(), spanMs: 0 };
    opened = 1;
    while (now() < until) {
      const w = env.syscall(SYS_write, fd, 0, 0, 0, 0, 0, 0, 0, buf, 0, buf.length);
      if (w !== buf.length) wrong += 1;
      // The expensive half: flush() is synchronous and holds the kernel thread for ~260 us
      // (constraint 23) while every other process waits.
      if (env.syscall(SYS_fsync, fd) !== 0) wrong += 1;
      calls += 2;
    }
  } else {
    while (now() < until) {
      if (env.syscall(SYS_getpid) !== env.pid) wrong += 1;
      calls += 1;
    }
  }
  const t1 = now();
  return { calls, wrong, opened, fd, firstMs: t0, lastMs: t1, spanMs: t1 - t0 };
}

/** The checks on both edges of MAX_INLINE, and the raw bypass. Outside the latency sweep. */
function overflowChecks(env) {
  const maxInline = MAX_INLINE;
  const exact = payload(maxInline);
  const one = env.syscall(SYS_write, 1, 0, 0, 0, 0, 0, 0, 0, exact, 0, maxInline);
  track(exact, one);

  const over = payload(maxInline + 1);
  const before = env.samples().issued;
  const viaLayer2 = env.write(1, over);
  const callsUsed = env.samples().issued - before;
  track(over, viaLayer2);

  const megabyte = payload(1048576);
  const mbBefore = env.samples().issued;
  const mbWrote = env.write(1, megabyte);
  const mbCalls = env.samples().issued - mbBefore;
  track(megabyte, mbWrote);

  const zero = env.syscall(SYS_write, 1, 0, 0, 0, 0, 0, 0, 0, exact, 0, 0);

  // The raw bypass runs last and r1 is captured on the next line: r1of() reads the live register,
  // so any intervening syscall overwrites it.
  const raw = env.rawWriteLength(1, maxInline + 1);
  const rawR1 = env.r1of();

  return {
    zero,
    exact: one,
    // The raw bypass consumed nothing, so sent.bytes must equal the sink's byte count exactly.
    sentBytes: sent.bytes,
    sentSum: sent.sum,
    overReturned: viaLayer2,
    overCalls: callsUsed,
    megabyteWrote: mbWrote,
    megabyteCalls: mbCalls,
    rawOverLength: raw,
    rawOverR1: rawR1,
  };
}

export function run(env, m) {
  if (m.mode === "park") {
    // Control 7.4's half of the kernel-dead phase, and control 7.5's whole subject: one long
    // sleep against a 50 ms re-arm. Live kernel must return 0 after ten silent re-arms; terminated
    // kernel must return -EIO. A timeout alone must never decide which (constraint 46).
    const [lo, hi] = packI64(BigInt(m.sleepMs) * 1000000n);
    const t = now();
    const r = env.syscall(SYS_clock_nanosleep, lo, hi, 0);
    return { role: "park", r0: r, r1: env.r1of(), elapsedMs: now() - t, counters: env.samples() };
  }
  // The injected fault, control 7.8: it exercises the kernel's fault path rather than assuming it.
  if (m.faultIndex === env.index) {
    throw new Error(`injected process fault at index ${env.index}, control 7.8`);
  }

  if (m.roleOf === env.index) {
    // The heartbeat-gap observer. Decision 2: this distribution sets HB_MISS_LIMIT. It joins the
    // barrier like every other process, so it observes the measured window and not one of its own.
    const released = env.barrierArrive();
    if (!released.released) return { role: "hb", barrier: released, barrierFailed: true };
    const heartbeat = env.observeHeartbeat(released.untilLocalMs);
    return { role: "hb", heartbeat, barrier: { ...released, ...env.barrierDepart() } };
  }

  const buf = payload(m.payloadBytes || 64);
  // One named round trip, so the smallest end-to-end claim — kernel booted, process spawned, one
  // getpid returned the right pid — is a reported value rather than an inference from an aggregate.
  const firstGetpid = env.syscall(SYS_getpid);

  // Warm-up is a separate window, reported rather than silently dropped: JIT and the first SAB
  // touch are real costs.
  const warm = { calls: 0 };
  const t0 = now();
  while (warm.calls < (m.warmupCalls || 2000)) {
    env.syscall(SYS_getpid);
    warm.calls += 1;
  }
  warm.ms = now() - t0;
  warm.samples = env.samples();
  env.resetSamples();

  // Without the barrier each process runs its own window back to back with its own warm-up, the
  // windows do not overlap, and the first dispatch of each window sees an arrival backlog of one.
  const released = env.barrierArrive();
  if (!released.released) {
    return { role: "loop", barrier: released, barrierFailed: true, counters: env.samples() };
  }

  const ioProcs = m.ioProcs | 0;
  const ioRole = ioProcs > 0 && env.index < ioProcs;
  const measured = (m.call === "io")
    ? runIoWindow(env, { until: released.untilLocalMs, buf, ioRole })
    : runWindow(env, { call: m.call || "getpid", until: released.untilLocalMs, buf });
  const after = env.samples();
  // Leave the window before anything out-of-window runs: a 1 MiB write or a 5 ms spin landing
  // inside another process's window moves its p99, and 1 ms of a 1,000 ms window is enough
  // samples to do it.
  const departed = env.barrierDepart();

  const extra = {};
  if (m.probeNotEqual) {
    // Constraint 7's fast path, forced three times: a check that waits for a 0.065% natural
    // occurrence either costs thousands of iterations or passes vacuously.
    extra.forced = [env.probeNotEqual(5), env.probeNotEqual(5), env.probeNotEqual(5)];
  }
  if (m.overflow) extra.overflow = overflowChecks(env);

  return {
    // The role the statistics partition on. "io" and "cheap" exist only in the M0a mix.
    role: m.call === "io" ? (ioRole ? "io" : "cheap") : "loop",
    firstGetpid,
    // The identity from the program's side of the boundary. The kernel's table and the kernel's
    // getpid are one source checked against itself; this is what the process was handed at spawn.
    envPid: env.pid,
    call: m.call || "getpid",
    warm: { calls: warm.calls, ms: warm.ms, count: warm.samples.count, sumMs: warm.samples.sum },
    // The window's two ends in the wall clock, the only clock comparable across agents. The
    // harness intersects these across processes: a cell whose windows do not overlap is not
    // measuring a saturated kernel, whatever its depth histogram says.
    barrier: { ...released, ...departed, barrierCounters: env.barrierCounters() },
    measured,
    sent: { bytes: sent.bytes, sum: sent.sum },
    samples: after,
    // The extras run outside the measured window, so `samples` above excludes them. The accounting
    // identity is read from these final counters, which include them: read off `after` it would
    // show issued < dispatched purely from the order of two snapshots.
    counters: env.samples(),
    ...extra,
  };
}
