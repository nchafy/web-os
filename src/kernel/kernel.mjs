// The kernel. A dedicated Worker, and the only privileged code in the repository.
//
// There is no loop. The kernel is an event-driven dispatcher on its own event loop, and that is
// the whole of constraint 2: a process blocks, the kernel replies asynchronously. Parking here is
// LEGAL — a nested dedicated worker has [[CanBlock]] true (constraint 10) — so it is a rule, not
// an impossibility, and bench/syscall-contention asserts the rule by grepping this directory.

import {
  SEQ, STATUS, RLEN, SIGPEND, CALLID, UID, NR, R0, R1,
  ST_RETURN, ST_INTR, ST_KDOWN, SIG_BIT,
  GLOBAL_BYTES, G_HEARTBEAT, G_HB_PERIOD_MS, G_KSTATE, G_EPOCH, G_INFLIGHT,
  G_THINK_US, G_STALL_US, G_READY,
  G_WINDOW, G_BARRIER, G_DEADLINE_LO, G_DEADLINE_HI, W_PRE, W_OPEN, W_CLOSED, W_DONE,
  K_BOOT, K_UP, K_PANIC, HB_PERIOD_MS, SAB_BYTES, PROC_CAP,
  EINTR, EINVAL, ENOSYS, ABI_FINGERPRINT, packI64,
} from "../abi.mjs";
import { ProcTable, RUNNING, ZOMBIE } from "./table.mjs";
import { makeSink, installTruncateOverflow } from "./files.mjs";
import { buildCalls, installStall, PENDING } from "./calls.mjs";

const RUNTIME_URL = "/src/libos/process.mjs";

const now = () => performance.now();

let cfg = {};
let globals = null;
let g = null;
let CALLS = null;
let table = null;
let hb = 0;
let kServiceMs = 0;
let kCalls = 0;
let notifyWoke = 0;
let notify0 = 0;
let lateReply = 0;
let dropped = 0;
let badCallId = 0;
let intrCount = 0;
let hbTick = 0;
let lastTick = 0;

// The heartbeat tick gap, as a BOUNDED histogram. A growing array was 403 entries after a 4 s
// probe and was copied whole into every stats and results post; a 3 s x 5-cell x 3-run sweep would
// ship tens of thousands of floats per message. These bins are fixed in size whatever the run
// length, and Decision 2's published distribution (p50/p99/p999/max) is computed from them by
// summarise.mjs, which owns every percentile in this bench.
const HB_GAP_BIN_MS = 0.5;
// 0..128 ms, which is the range that matters: the busy ceiling is REARM_MS x HB_MISS_LIMIT =
// 150 ms, so a gap this histogram cannot represent is already past the point where the heartbeat
// stops being the question. 64 bins (32 ms) was too few — the tick gap's p99 at N=32 fell past the
// top and the harness had nothing to print.
const HB_GAP_BINS = 256;
const hbGapHist = new Int32Array(HB_GAP_BINS);
let hbGapCount = 0;
let hbGapSumMs = 0;
let hbGapMaxMs = 0;
let hbGapOver = 0;

// Two depth histograms, and WHICH ONE A DISPATCH LANDS IN IS THE WINDOW. depthAll is every
// dispatch since boot — spawn, warm-up, the out-of-window checks and all. depthWindow is only the
// dispatches taken while every process was inside the measured window, which is the only set the
// concurrency gates may be read from: warm-up dispatches are serial by construction and would put
// depth 1 in the minimum however saturated the window itself was.
// A third: the RELEASE RAMP. N processes released together are woken one at a time, so whichever
// one issues first genuinely sees an arrival backlog of one — a barrier cannot remove that, it can
// only make it short. The ramp is the dispatches between the release and the first moment the
// kernel held N calls at once; they are counted and reported, not discarded, and the concurrency
// gates are read from depthWindow, which starts at that first saturation.
const depthAll = new Int32Array(256);
const depthWindow = new Int32Array(256);
const depthRamp = new Int32Array(256);

let depthTarget = depthRamp;
let satTarget = Infinity;
// The depth the hand-over actually fired at. Published, because `saturated` on its own is a
// boolean whose meaning is the threshold it was set at: latched on the first dispatch it reads
// exactly the same, and the gate that quotes it would be quoting a comment.
let satDepth = 0;

/** A process fault. Named here and reported immediately, never folded into `dropped`: a swallowed
 *  fault turns N processes into N-1, the kernel is then measured under less contention than
 *  claimed, and the number looks clean. */
const faults = [];

// ---------------------------------------------------------------------------- reply

/**
 * The single writer of SEQ, STATUS, RLEN, the notify and G_INFLIGHT. No handler may reach these.
 *
 * MEMORY ORDERING, load-bearing. The ECMAScript memory model establishes synchronize-with only
 * through atomic operations. r0, r1, RLEN and any reply bytes are written with plain stores; the
 * Atomics.store to SEQ below is the RELEASE that makes them visible to the process's acquiring
 * read after its wake. Without that ordering a process can observe the new SEQ and the previous
 * call's r0.
 */
function reply(p, r0, r1 = 0, st = ST_RETURN, rlen = 0) {
  const ctl = p.ctl;
  ctl[R0] = r0 | 0;
  ctl[R1] = r1 | 0;
  ctl[RLEN] = rlen | 0;
  Atomics.store(ctl, STATUS, st);
  Atomics.store(ctl, SEQ, ++p.seq);
  const woke = Atomics.notify(ctl, SEQ, 1);
  notifyWoke += woke;
  // A notify that woke nobody is the same event the process tallies as "not-equal". Two counters
  // on opposite sides of the boundary measuring one phenomenon (constraint 7).
  if (woke === 0) notify0 += 1;
  Atomics.sub(g, G_INFLIGHT, 1);
  // Progress, not just an idle timer: a kernel saturated with synchronous handler work can starve
  // its own interval task, and liveness that depended on the timer alone would fault healthy
  // processes under the stall control (constraint 46).
  Atomics.store(g, G_HEARTBEAT, ++hb);
  p.replies += 1;
  if (r0 < 0 && r1 === -1) p.errors += 1;
  p.inflight = null;
}

function fail(p, errno) {
  reply(p, -errno, -1);
}

function intr(p) {
  intrCount += 1;
  reply(p, -EINTR, -1, ST_INTR);
}

/** A handler's numeric return, in docs/ABI.md's single-register convention. */
function finish(p, r) {
  if (r < 0) reply(p, r, -1);
  else reply(p, r, 0);
}

/** An async handler's completion. A reply for a call already answered is dropped and counted —
 *  docs/ABI.md decision 1's cancellation path, which M1's kill needs. */
function setTimer(p, ms) {
  const seqAtDispatch = p.inflight.seq;
  setTimeout(() => {
    if (!p.ctl || p.seq !== seqAtDispatch) {
      lateReply += 1;
      return;
    }
    reply(p, 0);
  }, ms);
}

// ---------------------------------------------------------------------------- dispatch

function onSyscall(p, posted) {
  const depth = Atomics.load(g, G_INFLIGHT);   // the arrival backlog, BEFORE any work
  const tIn = now();
  // ACQUIRE. The process's last write before its post was the Atomics.store of CALLID; this is
  // the matching acquire, and it is what makes its plain stores to NR, a0..a7 and the byte region
  // visible here. Read the registers before it and they may be the previous call's.
  const callid = Atomics.load(p.ctl, CALLID);
  // The free integrity check: the posted callid and the CALLID word are two sources for one
  // value, so a process that posts before storing its registers, posts twice, or posts a number
  // it did not write is caught at the door rather than executing a handler over the previous
  // call's arguments. One compare.
  if (posted !== callid) {
    badCallId += 1;
    fail(p, EINVAL);
    return;
  }
  const nr = p.ctl[NR];
  // Constraint 16, in the measured path: M1 must not discover the channel got slower afterwards.
  if ((Atomics.load(p.ctl, SIGPEND) & ~p.mask) !== 0) {
    intr(p);
    return;
  }
  const h = CALLS[nr];
  if (h === undefined) {
    fail(p, ENOSYS);
    return;
  }
  const bucket = depth < 256 ? depth : 255;
  depthAll[bucket] += 1;
  // Latches forward, once per window: the ramp ends the first time the kernel holds N calls.
  if (depthTarget !== depthWindow && depth >= satTarget) {
    depthTarget = depthWindow;
    satDepth = depth;
  }
  // The window test is an atomic load against ONE word, evaluated at dispatch entry, so the very
  // first dispatch after the first process leaves is already excluded and no ramp-down sample can
  // enter the window histogram. Its cost is instrumentation, and --no-depth is what prices it.
  if (Atomics.load(g, G_WINDOW) === W_OPEN) depthTarget[bucket] += 1;
  p.calls += 1;
  p.inflight = { nr, callid, seq: p.seq, abort: null };
  const r = h(p);
  if (r !== PENDING) finish(p, r);
  kServiceMs += now() - tIn;
  kCalls += 1;
}

/** The same dispatcher without the depth sample, chosen at boot so the instrumented and
 *  uninstrumented variants differ by zero per-call branches. */
function onSyscallNoDepth(p, posted) {
  const tIn = now();
  const callid = Atomics.load(p.ctl, CALLID);
  if (posted !== callid) {
    badCallId += 1;
    fail(p, EINVAL);
    return;
  }
  const nr = p.ctl[NR];
  if ((Atomics.load(p.ctl, SIGPEND) & ~p.mask) !== 0) {
    intr(p);
    return;
  }
  const h = CALLS[nr];
  if (h === undefined) {
    fail(p, ENOSYS);
    return;
  }
  p.calls += 1;
  p.inflight = { nr, callid, seq: p.seq, abort: null };
  const r = h(p);
  if (r !== PENDING) finish(p, r);
  kServiceMs += now() - tIn;
  kCalls += 1;
}

let dispatch = onSyscall;

// ---------------------------------------------------------------------------- spawn

const results = [];

/**
 * Two phase, forced by measurement. Phase 1 allocates and posts; phase 2 is the process's own
 * {t:"ready"}. The kernel returns to its event loop between them by construction, because it
 * never blocks.
 *
 * This is not incidental. A worker that creates a nested worker and then parks starves it: a park
 * on the child's ready word timed out at 3002 ms with the flag never set, 4/4 runs
 * (tmp/m0-probe-nested, Chrome 157.0.8103.52 — docs/CONSTRAINTS.md's figures were taken on
 * 157.0.8103.38). A kernel that spawned and parked would hang for a full re-arm interval and be
 * misread as a syscall-latency problem, which is why that failure is reported under its own name.
 */
function spawn(programUrl, programCfg, index = 0) {
  const slot = table.alloc();
  if (typeof slot === "number") return slot;   // -EAGAIN, the hard cap (constraint 17)

  slot.sab = new SharedArrayBuffer(SAB_BYTES);
  slot.ctl = new Int32Array(slot.sab);
  slot.bytes = new Uint8Array(slot.sab);
  slot.ctl[UID] = slot.uid;

  // fds 1 and 2 to the sink; fd 0 stays null so a future read(0) is -EBADF, not a silent zero.
  const sink = makeSink();
  sink.refs = 2;
  slot.fds.set(1, sink);
  slot.fds.set(2, sink);

  const channel = new MessageChannel();
  slot.port = channel.port1;
  slot.port.onmessage = (ev) => {
    const data = ev.data;
    if (typeof data === "number") dispatch(slot, data);
    else onProcessMessage(slot, data);
  };

  slot.worker = new Worker(RUNTIME_URL, { type: "module", name: `pid${slot.pid}` });
  slot.worker.onerror = (e) => panic(`process ${slot.pid} runtime: ${e.message}`);
  slot.worker.postMessage(
    {
      t: "init",
      sab: slot.sab,
      globals,
      port: channel.port2,
      pid: slot.pid,
      uid: slot.uid,
      programUrl,
      cfg: { ...programCfg, index },
    },
    [channel.port2],
  );
  return slot.pid;
}

function onProcessMessage(slot, m) {
  if (m.t === "ready") {
    slot.state = RUNNING;
    if (m.abiFingerprint !== ABI_FINGERPRINT) {
      panic(`pid ${slot.pid} ABI fingerprint ${m.abiFingerprint} != ${ABI_FINGERPRINT}`);
      return;
    }
    Atomics.add(g, G_READY, 1);
    return;
  }
  if (m.t === "result") {
    const sink = slot.fds.get(1);
    results.push({
      pid: slot.pid,
      calls: slot.calls,
      replies: slot.replies,
      errors: slot.errors,
      sinkBytes: sink ? sink.bytes : 0,
      sinkSum: sink ? sink.sum : 0,
      sinkWrites: sink ? sink.writes : 0,
      ...m.data,
    });
    if (results.length === table.live.size) post({ t: "results", results, kernel: kstats() });
    return;
  }
  if (m.t === "fault") {
    // The process's runtime caught something and could not continue. It is reported under its own
    // name, with the pid and the stack, the instant it arrives: the alternative measured here was
    // the page waiting out a two-minute timeout for `results` that can never complete, with
    // `dropped 1` as the only trace.
    const fault = { pid: slot.pid, why: String(m.why) };
    faults.push(fault);
    slot.state = ZOMBIE;
    post({ t: "fault", ...fault, kernel: kstats() });
    return;
  }
  dropped += 1;
  post({ t: "error", why: `pid ${slot.pid} sent an unhandled message kind ${m && m.t}` });
}

// ---------------------------------------------------------------------------- the barrier
//
// The kernel owns the release because it is the only agent that can report a barrier that did not
// close. It never blocks to do it: both phases are polled on its own event loop, outside the
// measured window, so the poll interval costs the measurement nothing.

const BARRIER_POLL_MS = 2;

let barrier = null;

function barrierState() {
  return barrier ? { ...barrier } : null;
}

/**
 * @param want       processes that must arrive before the window opens — every spawned process
 * @param saturateAt calls that must be outstanding at once before the gates' depth histogram
 *                   starts. That is N, not `want`: the heartbeat observer never issues a syscall,
 *                   so waiting for `want` outstanding calls with --hb would wait forever.
 */
function armBarrier(want, saturateAt, windowMs, timeoutMs) {
  Atomics.store(g, G_BARRIER, 0);
  Atomics.store(g, G_DEADLINE_LO, 0);
  Atomics.store(g, G_DEADLINE_HI, 0);
  Atomics.store(g, G_WINDOW, W_PRE);
  barrier = {
    want,
    saturateAt,
    windowMs,
    phase: "arriving",
    armedWall: Date.now(),
    releasedWall: 0,
    deadlineWall: 0,
    allLeftWall: 0,
    goToReleaseMs: 0,
    failed: null,
  };
  pollBarrier("arriving", want, timeoutMs, () => {
    // ONE deadline for the cell, in the one clock every agent in this renderer shares. Each
    // process derives its own monotonic equivalent exactly once, because performance.now()
    // instants are not comparable across agents.
    const deadline = Date.now() + windowMs;
    const [lo, hi] = packI64(deadline);
    Atomics.store(g, G_DEADLINE_LO, lo);
    Atomics.store(g, G_DEADLINE_HI, hi);
    barrier.deadlineWall = deadline;
    barrier.releasedWall = Date.now();
    barrier.goToReleaseMs = barrier.releasedWall - barrier.armedWall;
    barrier.phase = "open";
    // The ramp starts here, and the gates' histogram starts at the first saturated dispatch.
    depthRamp.fill(0);
    depthTarget = depthRamp;
    satTarget = saturateAt;
    satDepth = 0;
    Atomics.store(g, G_WINDOW, W_OPEN);
    Atomics.notify(g, G_WINDOW, want);
    pollBarrier("leaving", 2 * want, windowMs + timeoutMs, () => {
      barrier.phase = "done";
      barrier.allLeftWall = Date.now();
      Atomics.store(g, G_WINDOW, W_DONE);
      Atomics.notify(g, G_WINDOW, want);
    });
  });
}

/** Poll G_BARRIER for `target` arrivals, then run `then`. A barrier that does not close is posted
 *  under its own name and makes the cell INVALID — it must never be read as latency. */
function pollBarrier(phase, target, timeoutMs, then) {
  const t0 = now();
  const check = () => {
    if (Atomics.load(g, G_BARRIER) >= target) {
      then();
      return;
    }
    if (now() - t0 > timeoutMs) {
      const arrived = Atomics.load(g, G_BARRIER);
      barrier.failed = { phase, arrived, target, timeoutMs };
      post({
        t: "barrier",
        failed: true,
        why: `barrier did not close while ${phase}: ${arrived}/${target} in ${timeoutMs} ms`,
        barrier: barrierState(),
      });
      return;
    }
    setTimeout(check, BARRIER_POLL_MS);
  };
  check();
}

// ---------------------------------------------------------------------------- liveness

function tick() {
  const t = now();
  if (lastTick) {
    const gap = t - lastTick;
    hbGapCount += 1;
    hbGapSumMs += gap;
    if (gap > hbGapMaxMs) hbGapMaxMs = gap;
    const i = Math.floor(gap / HB_GAP_BIN_MS);
    if (i < HB_GAP_BINS) hbGapHist[i] += 1; else hbGapOver += 1;
  }
  lastTick = t;
  hbTick += 1;
  // No notify: processes only ever READ the heartbeat, so there is nobody to wake.
  Atomics.store(g, G_HEARTBEAT, ++hb);
}

/**
 * The complementary path to the heartbeat, and O(live) ONCE — constraint 18 forbids a per-frame
 * O(N) sweep, not a one-shot walk of the interested set. Every parked process wakes immediately
 * with -EIO instead of waiting out three re-arms. What a panic cannot reach — a terminated kernel
 * worker, or a wedged thread — is exactly what the heartbeat covers.
 */
function panic(why) {
  Atomics.store(g, G_KSTATE, K_PANIC);
  for (const p of table.live) {
    if (!p.ctl) continue;
    Atomics.store(p.ctl, STATUS, ST_KDOWN);
    Atomics.store(p.ctl, SEQ, ++p.seq);
    Atomics.notify(p.ctl, SEQ, 1);
  }
  post({ t: "panic", why: String(why) });
}

/** Non-zero bins only, as [bin, count] pairs. */
function pairs(hist) {
  const out = [];
  for (let i = 0; i < hist.length; i += 1) if (hist[i]) out.push([i, hist[i]]);
  return out;
}

function kstats() {
  return {
    abiFingerprint: ABI_FINGERPRINT,
    isolated: self.crossOriginIsolated === true,
    cfg,
    calls: kCalls,
    serviceMeanUs: kCalls ? (kServiceMs * 1000) / kCalls : 0,
    notifyWoke, notify0, lateReply, dropped, badCallId, intr: intrCount,
    faults: faults.slice(),
    heartbeat: hb, hbTick,
    hbGap: {
      binMs: HB_GAP_BIN_MS,
      bins: pairs(hbGapHist),
      count: hbGapCount,
      sumMs: hbGapSumMs,
      maxMs: hbGapMaxMs,
      over: hbGapOver,
      topMs: HB_GAP_BIN_MS * HB_GAP_BINS,
    },
    barrier: barrierState(),
    // The gates read depthHist, and it is the WINDOW one. depthHistAll is the whole record, kept
    // so the difference between them is inspectable rather than asserted.
    depthHist: pairs(depthWindow),
    depthHistAll: pairs(depthAll),
    depthHistRamp: pairs(depthRamp),
    saturated: depthTarget === depthWindow,
    // The hand-over, as the two numbers that give `saturated` its meaning: the threshold this
    // window was armed with, and the depth the hand-over fired at. `target` is null before a
    // barrier has armed one, never Infinity: a JSON round trip turns that into null anyway and a
    // reader cannot tell which end did it.
    latch: { target: Number.isFinite(satTarget) ? satTarget : null, depth: satDepth },
    spawned: table ? table.spawned : 0,
    refused: table ? table.refused : 0,
    cap: PROC_CAP,
    perProcess: table
      ? [...table.live].map((p) => ({ pid: p.pid, calls: p.calls, replies: p.replies, state: p.state }))
      : [],
  };
}

// ---------------------------------------------------------------------------- boot

function post(m) {
  self.postMessage(m);
}

self.onerror = (e) => panic(`kernel onerror: ${e.message ?? e}`);
self.onunhandledrejection = (e) => panic(`kernel rejection: ${e.reason}`);

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    handle(m);
  } catch (error) {
    panic(`${m && m.t}: ${error && error.stack}`);
  }
};

function handle(m) {
  switch (m.t) {
    case "boot": {
      cfg = m.cfg || {};
      globals = new SharedArrayBuffer(GLOBAL_BYTES);
      g = new Int32Array(globals);
      Atomics.store(g, G_HB_PERIOD_MS, HB_PERIOD_MS);
      Atomics.store(g, G_THINK_US, cfg.thinkUs | 0);
      Atomics.store(g, G_STALL_US, cfg.stallUs | 0);
      Atomics.store(g, G_EPOCH, 1);
      Atomics.store(g, G_KSTATE, K_BOOT);
      table = new ProcTable(PROC_CAP);
      CALLS = buildCalls({ reply, fail, setTimer });
      // Test scaffolding inside privileged code, gated: a control requiring a hand edit is a
      // control nobody re-runs, but a hook a later change could leave armed is worse. It refuses
      // unless the page asked for a bench boot.
      if (cfg.stallUs > 0) {
        if (cfg.bench !== 1) throw new Error("stallUs requires bench=1");
        installStall(CALLS, cfg.stallUs);
      }
      if (cfg.truncateOverflow) {
        if (cfg.bench !== 1) throw new Error("truncateOverflow requires bench=1");
        installTruncateOverflow();
      }
      if (cfg.depth === false) dispatch = onSyscallNoDepth;
      setInterval(tick, HB_PERIOD_MS);
      lastTick = now();
      Atomics.store(g, G_KSTATE, K_UP);
      // The echoed cfg is not a courtesy: it is how a control proves it was applied.
      post({ t: "up", globals, abiFingerprint: ABI_FINGERPRINT, cfg, isolated: self.crossOriginIsolated === true });
      return;
    }
    case "spawn": {
      const pids = [];
      // The ordinal of the attempt the cap refused, in pids-ever-allocated terms rather than in
      // this request's terms: pids are monotonic and nothing is freed at M0, so table.spawned at
      // the moment of the refusal is the number of live processes and the attempt was the next
      // one. A refusal reported as "the 1st of this batch" would hide which process count the
      // cap actually stopped at.
      let refusedAt = 0;
      for (let i = 0; i < m.count; i += 1) {
        const pid = spawn(m.programUrl, m.cfg || {}, i);
        if (pid < 0 && !refusedAt) refusedAt = table.spawned + 1;
        pids.push(pid);
      }
      const refused = pids.filter((pid) => pid < 0).length;
      post({
        t: "spawned", pids, refused, cap: PROC_CAP, live: table.live.size,
        why: refused ? capRefusedWhy(refusedAt, refused, pids.length) : "",
      });
      // Nothing to wait for. A process the cap refused does not exist, so it can never increment
      // G_READY, and awaitReady would spend its whole timeout and then report the one thing that
      // did NOT happen: starvation between spawn and first use. That diagnosis names a latency
      // problem and sends the next day in the wrong direction, when the kernel was behaving
      // exactly as constraint 17 specifies.
      if (refused) return;
      if (cfg.spawnThenPark) {
        // A busy-spin, not a park, so the no-parking lint over this directory still holds — and
        // it reproduces the same mechanism, because it also never yields and the child's ready
        // message can never be processed.
        const until = now() + (m.parkMs || 10000);
        while (now() < until && Atomics.load(g, G_READY) < m.count) { /* starve the children */ }
        const ready = Atomics.load(g, G_READY);
        post({ t: "ready", ready, want: m.count, starved: ready < m.count, why: starvedWhy(ready, m.count, m.parkMs || 10000) });
        return;
      }
      awaitReady(m.count, m.readyTimeoutMs || 10000);
      return;
    }
    case "go": {
      results.length = 0;
      // The kernel's counters are NOT reset here. They run from boot, which is what keeps the
      // accounting identity (issued == dispatched == replied == returned) comparable against the
      // process's own cumulative counters — the stronger invariant. The one figure that cannot be
      // read from a boot-cumulative counter is the arrival depth, and that is what depthWindow and
      // the barrier are for.
      //
      // The park controls (7.4, 7.5) issue one long sleep each and have no window, so they take no
      // barrier: arming one would wait for arrivals that are never coming.
      if (m.go && m.go.mode !== "park") {
        const want = table.live.size;
        armBarrier(want, want - (m.go.roleOf >= 0 ? 1 : 0), m.go.windowMs | 0,
          m.go.barrierTimeoutMs || 60000);
      }
      for (const p of table.live) p.port.postMessage({ t: "go", ...m.go });
      return;
    }
    case "raise": {
      const p = table.get(m.pid);
      if (!p) return;
      Atomics.or(p.ctl, SIGPEND, SIG_BIT(m.sig));
      return;
    }
    case "expose":
      // The SABs, shared (not transferred) to the page, for the one observation that has to
      // outlive this worker: whether each parked process concluded the kernel was gone. Nothing
      // privileged crosses — a SAB is the channel, and the page already holds the globals one.
      post({ t: "exposed", procs: [...table.live].map((p) => ({ pid: p.pid, sab: p.sab })) });
      return;
    case "stats":
      post({ t: "stats", kernel: kstats() });
      return;
    case "panic":
      panic("requested by the page");
      return;
    default:
      post({ t: "error", why: `unknown command ${m && m.t}` });
  }
}

/** The hard cap refusing a spawn (constraint 17), named as itself and not as starvation.
 *
 *  ProcTable.alloc returns -EAGAIN once every slot is taken, which is the cap working exactly as
 *  specified. The children that were never created cannot report ready, so the symptom is
 *  identical to a kernel that never yielded — and the cause is the caller asking for more
 *  processes than the table has slots. */
function capRefusedWhy(refusedAt, refused, asked) {
  return `spawn refused by the hard cap at process ${refusedAt}; cap is ${PROC_CAP}, `
    + `constraint 17. ${refused} of ${asked} requested spawn(s) refused; this is the cap `
    + "working as specified, not a kernel that failed to yield";
}

/** One renderer of the failure, so the busy-spin control and a genuine timeout name it the same
 *  way. It MUST be reported under this name and never folded into latency: read as a syscall
 *  latency problem it would send the next day in the wrong direction. */
function starvedWhy(ready, want, timeoutMs) {
  return `kernel-starved-children: ${ready}/${want} ready in ${timeoutMs} ms; the kernel did not `
    + "yield between spawn and first use";
}

/** Phase 2's completion, polled on the kernel's own event loop. The timeout is reported under its
 *  own name and is never folded into latency. */
function awaitReady(count, timeoutMs) {
  const t0 = now();
  const check = () => {
    const ready = Atomics.load(g, G_READY);
    if (ready >= count) {
      post({ t: "ready", ready, want: count, starved: false, ms: now() - t0 });
      return;
    }
    if (now() - t0 > timeoutMs) {
      post({
        t: "ready",
        ready,
        want: count,
        starved: true,
        ms: now() - t0,
        why: starvedWhy(ready, count, timeoutMs),
      });
      return;
    }
    setTimeout(check, 5);
  };
  check();
}
