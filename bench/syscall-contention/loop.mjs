// The program a process runs. USERLAND: it reaches the system only through syscall(), and it is
// handed no SAB, no port and no handle — see src/libos/process.mjs.
//
// Closed loop, no think time, so N processes offer N outstanding calls and the kernel's arrival
// backlog is the measurement. Per-call timing and the lossless histogram live in the stub, which
// is the only place that can bracket the park.

// The syscall numbers come from the one module that defines them. A program imports no capability
// by doing this — src/abi.mjs is integers and four pure codecs, and its standing rule is what
// makes it importable from inside a process. Writing `const SYS_write = 1` here instead would be
// the second hand-synced copy CLAUDE.md names as the defect this rule exists for.
import {
  SYS_getpid, SYS_write, SYS_clock_nanosleep, MAX_INLINE, packI64, fnv1a, FNV1A_BASIS,
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
 * It must be ONE accumulator over the whole run and not one per phase, because the kernel's sink
 * is cumulative: comparing a per-phase checksum against a cumulative sink compares two different
 * byte streams and reports a mismatch that means nothing.
 *
 * The hash and its seed are imported, not restated. The kernel's sink hashes with the same one
 * copy, pinned in src/abi.mjs against a published test vector — two hand-synced copies would drift
 * together and this comparison would become a tautology.
 */
const sent = { sum: FNV1A_BASIS, bytes: 0 };

function track(buf, length) {
  if (length <= 0) return;
  sent.sum = fnv1a(buf, 0, length, sent.sum);
  sent.bytes += length;
}

/**
 * The measured window. `until` is NOT this process's own idea of when to stop: it is the one
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

  // The raw bypass, LAST, and r1 is captured on the next line. r1of() reads the live register,
  // so any intervening syscall overwrites it — which is how the first version of this reported
  // r1 = 0 for an error the kernel had correctly marked -1.
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
    // Control 7.4's half of the kernel-dead phase, and control 7.5's whole subject: ONE long
    // sleep against a 50 ms re-arm. If the kernel lives it must return 0 after ten silent
    // re-arms, and if the kernel is terminated the same call must return -EIO. A timeout alone
    // must never decide which (constraint 46).
    const [lo, hi] = packI64(BigInt(m.sleepMs) * 1000000n);
    const t = now();
    const r = env.syscall(SYS_clock_nanosleep, lo, hi, 0);
    return { role: "park", r0: r, r1: env.r1of(), elapsedMs: now() - t, counters: env.samples() };
  }
  // The injected fault, control 7.8. It exists so the kernel's fault path is exercised rather
  // than assumed: before it, a process that threw turned N into N-1 silently and the page waited
  // out a two-minute timeout with `dropped 1` as the only trace.
  if (m.faultIndex === env.index) {
    throw new Error(`injected process fault at index ${env.index}, control 7.8`);
  }

  if (m.roleOf === env.index) {
    // The heartbeat-gap observer. Decision 2: this distribution is what sets HB_MISS_LIMIT, and
    // M1 restates its liveness bar from it. It joins the barrier like every other process, so it
    // observes exactly the measured window and not a window of its own.
    const released = env.barrierArrive();
    if (!released.released) return { role: "hb", barrier: released, barrierFailed: true };
    const heartbeat = env.observeHeartbeat(released.untilLocalMs);
    return { role: "hb", heartbeat, barrier: { ...released, ...env.barrierDepart() } };
  }

  const buf = payload(m.payloadBytes || 64);
  // One named round trip before anything else, so the smallest end-to-end claim — the kernel
  // booted, this process was spawned by the kernel, one getpid returned the right pid — is a
  // reported value rather than an inference from an aggregate.
  const firstGetpid = env.syscall(SYS_getpid);

  // Warm-up is a SEPARATE window, reported rather than silently dropped: JIT and the first SAB
  // touch are real costs, and hiding them is how a harness flatters itself.
  const warm = { calls: 0 };
  const t0 = now();
  while (warm.calls < (m.warmupCalls || 2000)) {
    env.syscall(SYS_getpid);
    warm.calls += 1;
  }
  warm.ms = now() - t0;
  warm.samples = env.samples();
  env.resetSamples();

  // THE BARRIER. Warm up, report ready, then wait to be released with everyone else. Without this
  // each process ran its own window back to back with its own warm-up, the windows did not
  // overlap, and the first dispatch of each window saw an arrival backlog of one.
  const released = env.barrierArrive();
  if (!released.released) {
    return { role: "loop", barrier: released, barrierFailed: true, counters: env.samples() };
  }

  const measured = runWindow(env, { call: m.call || "getpid", until: released.untilLocalMs, buf });
  const after = env.samples();
  // Leave the window before anything out-of-window runs: a 1 MiB write or a 5 ms spin landing
  // inside another process's window would move its p99, and 1 ms of a 1,000 ms window is enough
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
    role: "loop",
    firstGetpid,
    // WHAT THIS PROCESS THINKS IT IS, from the program's side of the boundary. The kernel's table
    // and the kernel's getpid are one source checked against itself; this is the identity the
    // kernel handed the process at spawn and the one a program actually uses, so M1's getppid,
    // setpgid and signal delivery all inherit it being wrong.
    envPid: env.pid,
    call: m.call || "getpid",
    warm: { calls: warm.calls, ms: warm.ms, count: warm.samples.count, sumMs: warm.samples.sum },
    // The window's two ends in the wall clock, which is the only clock comparable across agents.
    // The harness intersects these across processes: a cell whose windows do not overlap is not
    // measuring a saturated kernel, whatever its depth histogram says.
    barrier: { ...released, ...departed, barrierCounters: env.barrierCounters() },
    measured,
    sent: { bytes: sent.bytes, sum: sent.sum },
    samples: after,
    // The extras run OUTSIDE the measured window, so the histogram above excludes them. These
    // final counters include them, and they are what the accounting identity is read from:
    // reading the identity off `after` would show issued < dispatched for no better reason than
    // the order of two snapshots.
    counters: env.samples(),
    ...extra,
  };
}
