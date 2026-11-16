// The kernel. A dedicated Worker, and the only privileged code in the repository.
//
// There is no loop. The kernel is an event-driven dispatcher on its own event loop, and that is
// the whole of constraint 2: a process blocks, the kernel replies asynchronously. Parking here is
// LEGAL — a nested dedicated worker has [[CanBlock]] true (constraint 10) — so it is a rule, not
// an impossibility, and bench/syscall-contention asserts the rule by grepping this directory.

import {
  SEQ, STATUS, RLEN, SIGPEND, CALLID, UID, NR, R0, R1, A0, A1, A2, A3, A4, A5, A6, A7, H_MAGIC,
  H_VERSION, SAB_MAGIC, SAB_VERSION, LEN_I32, DATA_OFF, ST_RETURN, ST_INTR, ST_KDOWN, SIG_BIT,
  GLOBAL_BYTES, G_HEARTBEAT, G_HB_PERIOD_MS, G_KSTATE, G_EPOCH, G_INFLIGHT, G_THINK_US,
  G_STALL_US, G_READY, G_WINDOW, G_BARRIER, G_DEADLINE_LO, G_DEADLINE_HI, W_PRE, W_OPEN,
  W_CLOSED, W_DONE, K_BOOT, K_UP, K_PANIC, HB_PERIOD_MS, SAB_BYTES, PROC_CAP, EINTR, EINVAL,
  ENOSYS, EIO, EAGAIN, EPERM, ESRCH, ECHILD, TEARDOWN_ERRNO, SIGKILL, SIGTERM, SIGINT, SIGHUP,
  SIGPIPE, SIGABRT, SIG_DFL, SIG_IGN, SIG_HANDLE, F_PIPE_R, F_PIPE_W, MAX_INLINE, SPAWN_DUP2,
  ENOEXEC, SYS_NAME, decodeSpawnRequest, STAT_EXITED, STAT_KILLED, ABI_FINGERPRINT, packI64,
} from "../abi.mjs";
import { ProcTable, RUNNING, ZOMBIE, SPAWNING } from "./table.mjs";
import { makeSink, installTruncateOverflow, installStore, KIND_OPS } from "./files.mjs";
import {
  buildCalls, installStall, PENDING, pollWake, pollForget, pollPending,
} from "./calls.mjs";
import { Store, MOUNT_RW, MOUNT_RO, MOUNT_REFUSE, MOUNT_FRESH } from "./store.mjs";
import { makeInlineIo } from "./io-inline.mjs";
import { TraceRing, TR_ENTER, TR_EXIT, TRACE_DEFAULT_BYTES } from "./trace.mjs";
import {
  MountTable, MNT_RO, FS_OPFS, FS_PROC, FS_DEV, FS_PROVIDER, FS_TMPFS,
} from "../fs/mounts.mjs";
import { mountProvider, USR_ENTRIES, BENCH_ENTRIES } from "./providerfs.mjs";
import { makeExec, EXEC_VIEW_ID, EXEC_CHUNK } from "./exec.mjs";
import { makeProcFS } from "./procfs.mjs";
import { makeDevFS, renderTrace } from "./devfs.mjs";
import { TmpFS } from "./tmpfs.mjs";
import { installPipeKernel } from "./pipe.mjs";
import { installPtyKernel, setPtyDefaultIsig, setPtyWinch } from "./pty.mjs";

const RUNTIME_URL = "/src/libos/process.mjs";

const now = () => performance.now();

let cfg = {};
let globals = null;
let g = null;
let CALLS = null;
let OPFS_ROOT = null;
let opfsWhy = "";
let IO = null;
let ioBooted = false;
let ioWhy = "";
let STORE = null;
let QUOTA = null;
let mountReport = null;
let table = null;
/** M3. The syscall trace ring, and the mount table. Both are built at boot and both are null
 *  before it, which is why every use of `trace` is guarded: a kernel that has not booted still
 *  dispatches the page's own messages. */
/**
 * The signals whose SIG_DFL disposition is to kill.
 *
 * DATA, not a condition, so M4's negative control removes a row at boot and the headline path
 * carries one Set lookup either way. SIGPIPE's membership is what makes `yes | head -1` terminate:
 * without it a writer whose reader has gone only gets the SIGPEND bit, which `drainSignals`
 * discards at the next syscall entry, and it loops forever on a write that keeps failing.
 */
const FATAL_DEFAULT = new Set([SIGTERM, SIGINT, SIGHUP, SIGPIPE]);

let trace = null;
let mounts = null;
/**
 * M5. The exec loader, and the buffer a durable-volume program is read into.
 *
 * The SAB is the kernel's OWN byte region, registered with the I/O worker under a NEGATIVE id so
 * it can never collide with a process's (src/kernel/exec.mjs EXEC_VIEW_ID). ONE buffer for the
 * kernel, and the loader takes a lock around the reads that use it — two processes calling
 * `SYS_spawn` at the same moment are two `later()` bodies interleaving at every await, so a
 * shared buffer with no lock would have each load reading the other's chunks.
 */
let EXEC = null;
let execSab = null;
let execView = null;
/** What happened to the /usr provider mount. Reported, never swallowed: a /usr that
 *  failed its capability probe must be visible as a refusal rather than as an empty
 *  directory. */
let usrReport = null;
/** M5. The same for `/bench`, which exists only under a bench boot. Null in a real boot, which is
 *  the state "there is no such mount" should read as. */
let benchReport = null;
let hb = 0;
let kServiceMs = 0;
let kCalls = 0;
let notifyWoke = 0;
let notify0 = 0;
let lateReply = 0;
let dropped = 0;
let badCallId = 0;
/**
 * KERNEL-SIDE EXCEPTIONS IN AN ASYNC SYSCALL BODY, counted. `later()` is the completion path for
 * open, write, fsync, truncate and close, so its rejection arm is where ANY throw inside ANY of
 * those bodies lands — and it used to answer a bare `-EIO` that named nothing, noted nothing and
 * moved no counter. A number is what makes "nothing threw" assertable: an exception reported only
 * by the errno a caller would have got from a real I/O failure is indistinguishable from one.
 */
let asyncFail = 0;
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

/**
 * THE NOTE CHANNEL'S COUNTER, and the reason it exists rather than the texts alone.
 *
 * A note is a storage failure nobody is awaiting, and the case it was built for is the one that
 * cannot be anything else: a process's own teardown closes its fds, `closeFd` commits whatever was
 * staged, and teardown cannot await the answer — so a write the kernel could not publish has no
 * caller to return an errno to. The channel carried that fact to the page as a STRING, and every
 * consumer printed it next to the other logs. Measured: a workload that destroyed an acknowledged
 * 4-byte write in 3 of 12 rounds emitted `close of inode 22 could not publish its write: errno 8`
 * every time, the suite passed, and fsck reported the volume clean. A failure only a human reading
 * logs can find is not reported.
 *
 * So the channel is a NUMBER as well as a text: counted here, carried in `fsState` and `kstats`,
 * and asserted at zero by the suite on a workload where nothing may be refused
 * (`scripts/check.py` "drop the note channel stayed silent under a killed writer").
 *
 * `NOTE_KEEP` bounds the texts. The count is unbounded and is the thing assertions read.
 */
const NOTE_KEEP = 32;
const noteTexts = [];
let noteCount = 0;

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
  // THE EXIT RECORD, written here because `reply` is the one place a call concludes: fail, intr,
  // finish and every async settlement all funnel through it, so one call site covers them all.
  //
  // IT CARRIES ITS CALL'S ENTRY TIME, not the time of the exit, and that is a measured trade
  // rather than an oversight. A clock read here would cost more than the record: measured on this
  // machine, `performance.now()` is 69.0 ns and `Date.now()` 52.9 ns against a 19.4 ns record
  // (`node bench/m3-trace/probe.mjs`, Node 18.20.2 darwin/arm64). The dispatcher already holds
  // `tIn`, so the pair costs nothing. CONSEQUENCE, stated so nobody derives a wrong number from
  // it: SYSCALL DURATION IS NOT AVAILABLE FROM THE TRACE. Order is, from the monotonic `seq`.
  // Latency comes from the kernel's own service accounting and M0's histogram, which measure it
  // properly. A future milestone wanting durations in the trace should have the dispatcher write
  // a third record after its existing end-of-dispatch `now()`, which is also free.
  if (trace && p.inflight) {
    trace.put(TR_EXIT, p.pid, p.inflight.nr, p.inflight.callid, r0 | 0, rlen | 0, p.inflight.t);
  }
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
  // EVERY PARKED `poll` IS RE-EVALUATED HERE, because `reply` is the one funnel every state change
  // that could make an fd ready passes through — a pipe write, a pty keystroke, a close, a
  // teardown. Hooking it here rather than threading a callback into each pollable object means a
  // new kind cannot forget to notify. `pollWake` guards its own reentrancy; the length test keeps
  // the common case (nothing polling) to one comparison.
  if (pollWakeEnabled && pollPending()) pollWake(POLL_K);
}

/** The one thing `pollWake` needs, built once rather than per reply. */
const POLL_K = { reply };

/** M4b's second control. True in every real boot; the kernel refuses to clear it without
 *  bench=1. A parked `poll` then only ever answers from its own timeout. */
let pollWakeEnabled = true;

function fail(p, errno) {
  reply(p, -errno, -1);
}

function intr(p) {
  intrCount += 1;
  reply(p, -EINTR, -1, ST_INTR);
}

/** Calls whose handler's own side effect answered them before the handler returned — see
 *  `finish`. Nonzero only where a signal reached the calling process. */
let answeredDuringCall = 0;

/** M4b's third control. True in every real boot; the kernel refuses to clear it without bench=1.
 *  With it off, a call whose handler's side effect already answered it is answered a SECOND
 *  time — the double-reply class, restored. */
let finishGuardEnabled = true;

/**
 * A handler's numeric return, in docs/ABI.md's single-register convention.
 *
 * `p.rlen` and `p.r1` are the two scratch words a handler may set, cleared at every dispatch so a
 * handler that sets neither cannot publish the previous call's. They exist because docs/ABI.md
 * gives three calls a reply that is not one integer: `fstat` and `statfs` write a record into the
 * byte region, `readdir` writes records AND returns a cookie in r1, and `seek` returns an i64 as
 * the (r0, r1) pair. Writing those through reply()'s existing parameters keeps reply() the single
 * writer of SEQ, STATUS and RLEN.
 */
function finish(p, r) {
  // THE HANDLER'S OWN SIDE EFFECT MAY HAVE ANSWERED THIS CALL ALREADY, and then there is nothing
  // left to finish. A pty operation that signals the foreground group signals the CALLER whenever
  // the caller is in that group — and it usually is, because `pty_open` sets `fgPgid` from the
  // opener's pgid. So `tty_winsize_set` raising SIGWINCH, or a keystroke raising SIGINT through
  // the line discipline, reaches the process making the call; `raiseOne` interrupts its in-flight
  // call with -EINTR (or reaps it outright), and `reply` nulls `inflight` on the way out.
  //
  // Replying again would be a SECOND reply for one call: two SEQ bumps, so the process can observe
  // a reply it never issued a call for, and two G_INFLIGHT decrements, which drives the depth
  // gauge negative and breaks the issued == replied identity `check_syscall` asserts. That is the
  // same class that cost M4 a day through `pipe.mjs`'s fatal SIGPIPE, where the fix was local to
  // the one path then known.
  //
  // GUARDED HERE AND NOT PER HANDLER, because `finish` is the single funnel: all three dispatchers
  // and `later` return through it, so a handler added later cannot forget the guard. The frequency
  // is counted rather than silent — a number that climbs where no signal is being delivered is a
  // real double-reply bug, and this must not be the thing that hides it.
  if (finishGuardEnabled && p.inflight === null) {
    answeredDuringCall += 1;
    return;
  }
  if (r < 0) reply(p, r, -1);
  else reply(p, r, p.r1 | 0, ST_RETURN, p.rlen | 0);
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

/**
 * The I/O worker surface. One outstanding-request map keyed by a sequence the worker echoes, so
 * answers can arrive out of order — which is the point of having a second thread at all.
 *
 * This is kernel-side in the sense constraint 15 requires: the port lives here, in the dispatch
 * kernel, and a process never receives it or a handle behind it. What a process gets back is an
 * integer fd, exactly as before.
 */
function makeIo(worker) {
  const pending = new Map();
  let seq = 1;
  let booted = null;
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.t === "booted") {
      ioBooted = m.ok;
      ioWhy = m.why || "";
      if (booted) booted(m.ok);
      return;
    }
    // A note is a fact the worker could not return to a caller — a blob that would not delete.
    // Surfaced under its own name rather than swallowed: it is a leak, not a corruption, and the
    // two want different responses.
    if (m.t === "io-note") { noteOut(m.why); return; }
    if (m.t === "io-error") {
      const w = pending.get(m.seq);
      pending.delete(m.seq);
      if (w) w.reject(new Error(m.why));
      return;
    }
    const w = pending.get(m.seq);
    pending.delete(m.seq);
    if (w) w.resolve(m.r);
  };
  return {
    request(t, body) {
      const s = seq++;
      return new Promise((resolve, reject) => {
        pending.set(s, { resolve, reject });
        // THE ENVELOPE WINS OVER THE BODY. `t` and `seq` are the transport's own two fields, and a
        // body that happened to carry either of them used to overwrite the correlation id: the
        // worker echoed the body's value, `pending.get` missed, and the promise NEVER SETTLED — a
        // syscall parked forever and a mount that timed out with no error anywhere. Measured with a
        // journal request whose payload named its own `seq`.
        worker.postMessage({ ...body, t, seq: s });
      });
    },
    // Notifications: no reply expected, so they cannot queue behind a request (constraint 57's
    // drain order — notifications first).
    boot() { worker.postMessage({ t: "boot" }); },
    /** The boot handshake, awaited. A `booted` that has not landed is not an I/O worker with no
     *  OPFS — it is an I/O worker that has not answered yet, and mounting against the difference
     *  would read a populated volume as a fresh one. */
    ready(timeoutMs) {
      if (ioBooted) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => { booted = null; resolve(false); }, timeoutMs);
        booted = (ok) => { clearTimeout(timer); booted = null; resolve(ok); };
      });
    },
    register(pid, sab) { worker.postMessage({ t: "register", pid, sab }); },
    unregister(pid) { worker.postMessage({ t: "unregister", pid }); },
    outstanding() { return pending.size; },
  };
}

/**
 * The same completion contract for work that is awaited rather than timed: run `job()` off the
 * dispatch path and answer when it settles, dropping the answer if the call it belongs to is gone.
 *
 * This is the shape constraint 57 requires of anything slow — a syscall that must wait does not
 * hold the kernel thread — and it reuses setTimer's identity check rather than writing a second
 * one, because two copies of a cancellation guard is how one of them ends up wrong.
 */
function later(p, job) {
  const seqAtDispatch = p.inflight.seq;
  // Captured here and not read in the handler: `finish` nulls `inflight`, so a rejection arriving
  // after one would have had nothing to name the call with.
  const nrAtDispatch = p.inflight.nr;
  Promise.resolve()
    .then(job)
    .then(
      (r) => {
        if (!p.ctl || p.seq !== seqAtDispatch) { lateReply += 1; return; }
        finish(p, r);
      },
      (reason) => {
        // THE REASON IS NAMED, COUNTED, AND ONLY THEN TURNED INTO AN ERRNO. The caller still gets
        // -EIO, because there is no errno for "the kernel threw" and inventing one would put a
        // kernel defect in the ABI — but the errno is no longer the only trace. The note carries
        // the call number and the stack, the counter makes zero assertable, and the two together
        // are the difference between a bug and a storage error from the reader's side.
        //
        // Counted BEFORE the identity check so a rejection is counted whether or not its caller is
        // still there: a process that was reaped while its write was in flight is exactly the case
        // where the throw is otherwise invisible.
        asyncFail += 1;
        noteOut(`pid ${p.pid} call ${nrAtDispatch} threw inside its async body: `
          + `${(reason && (reason.stack || reason.message)) || String(reason)}`);
        if (!p.ctl || p.seq !== seqAtDispatch) { lateReply += 1; return; }
        fail(p, EIO);
      },
    );
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
  p.inflight = { nr, callid, seq: p.seq, abort: null, t: tIn };
  // The entry record. `tIn` is the clock the dispatcher already read, so this adds no clock
  // read -- see reply() for why that is the whole design of the record's time field.
  if (trace) trace.put(TR_ENTER, p.pid, nr, callid, p.ctl[A0] | 0, p.ctl[A1] | 0, tIn);
  // The two reply scratch words, cleared per dispatch. See finish().
  p.rlen = 0;
  p.r1 = 0;
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
  p.inflight = { nr, callid, seq: p.seq, abort: null, t: tIn };
  // The entry record. `tIn` is the clock the dispatcher already read, so this adds no clock
  // read -- see reply() for why that is the whole design of the record's time field.
  if (trace) trace.put(TR_ENTER, p.pid, nr, callid, p.ctl[A0] | 0, p.ctl[A1] | 0, tIn);
  // The two reply scratch words, cleared per dispatch. See finish().
  p.rlen = 0;
  p.r1 = 0;
  const r = h(p);
  if (r !== PENDING) finish(p, r);
  kServiceMs += now() - tIn;
  kCalls += 1;
}

/** The M1 negative control. Removes the SIGPEND check at syscall entry; Ctrl-C must stop
 *  working. Re-runnable — it is wired in the existing style (installStall, installTruncateOverflow
 *  are boot-time wrappers gated on bench=1 so the headline path carries no control branch), and
 *  the page refuses to arm it without bench=1. */
function onSyscallNoSigpend(p, posted) {
  const tIn = now();
  const callid = Atomics.load(p.ctl, CALLID);
  if (posted !== callid) {
    badCallId += 1;
    fail(p, EINVAL);
    return;
  }
  const nr = p.ctl[NR];
  // No SIGPEND check here — M1's negative control. A process in an interruptible syscall must
  // now be left alone. Ctrl-C pathway is broken by removing one line, and that is exactly the
  // shape proof the control exists for.
  const h = CALLS[nr];
  if (h === undefined) {
    fail(p, ENOSYS);
    return;
  }
  p.calls += 1;
  p.inflight = { nr, callid, seq: p.seq, abort: null, t: tIn };
  // The entry record. `tIn` is the clock the dispatcher already read, so this adds no clock
  // read -- see reply() for why that is the whole design of the record's time field.
  if (trace) trace.put(TR_ENTER, p.pid, nr, callid, p.ctl[A0] | 0, p.ctl[A1] | 0, tIn);
  // The two reply scratch words, cleared per dispatch. See finish().
  p.rlen = 0;
  p.r1 = 0;
  const r = h(p);
  if (r !== PENDING) finish(p, r);
  kServiceMs += now() - tIn;
  kCalls += 1;
}

let dispatch = onSyscall;

// ---------------------------------------------------------------------- the program loader

/**
 * THE SUPERVISOR'S PROGRAM LOADER. A PROCESS NEVER REACHES THIS.
 *
 * M5 MOVED THE PROCESS'S HALF OUT. `SYS_spawn` used to come through here, which made a
 * process-supplied string a request origin — see src/kernel/exec.mjs, which now resolves a
 * program path through the mount table instead and never touches the network. What is left here
 * serves the PAGE's own `t: "spawn"`: the page is the supervisor, outside the process boundary,
 * and a supervisor that could not load a program from the repository could not boot a bench.
 *
 * Everything below still holds for that path, and the herd measurement is why it is the kernel
 * doing the fetching rather than each process:
 *
 * Constraint 41 deletes `fetch` and `importScripts` from the process realm, so a design where
 * each process pulls its own program text over HTTP is already dead at M6 — and it does not
 * survive to M6 either: 16 processes importing one URL at the same instant lost 6 of 480
 * connections to the server's listen backlog (`socketserver` listens with a backlog of 5), which
 * arrived as a process fault and an unmeasurable cell about one run in five. Constraint 19 also
 * prices this path below an HTTP spawn.
 *
 * The image is a Blob URL, built once per program and handed to every process. A blob URL has an
 * opaque path, so a specifier inside the image cannot be resolved against it — measured:
 * `Failed to resolve module specifier "/src/abi.mjs". Invalid relative url or base scheme isn't
 * hierarchical.` That is what the loader below is for, and it resolves against the program's own
 * URL, which makes the specifier the SAME absolute URL `src/libos/process.mjs` already resolved
 * for its own graph. So the dependency comes out of the process's module map instead of off the
 * network — measured at 320 processes: 320 fetches of `/src/abi.mjs`, which is the one each
 * process's runtime needed anyway, and 1 fetch of the program — and the program ends up holding
 * the libos stub's own instance of the ABI rather than a second copy of it.
 */
const images = new Map();
let programFetches = 0;

/**
 * A STATIC import or `export ... from` specifier, and only a path-shaped one: `/x`, `./x`, `../x`.
 * A bare specifier has no resolution in a worker without an import map, and a dynamic `import()`
 * inside a program would still see the blob's opaque base — no program has either, and a loader
 * feature for a case that does not exist is a loader feature nobody has run. The quote must
 * follow `from` or `import` directly, which is what keeps prose out of the match; `resolved` is
 * reported so the count is asserted rather than assumed.
 */
const STATIC_SPECIFIER = /(\bfrom\s*|\bimport\s*)(["'])(\.{0,2}\/[^"']*)\2/g;

async function programImage(programUrl) {
  const cached = images.get(programUrl);
  if (cached) return cached;
  const url = new URL(programUrl, self.location.href).href;
  const response = await fetch(url, { cache: "no-store" });
  programFetches += 1;
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const text = await response.text();
  let resolved = 0;
  const linked = text.replace(STATIC_SPECIFIER, (all, lead, quote, specifier) => {
    resolved += 1;
    return `${lead}${quote}${new URL(specifier, url).href}${quote}`;
  });
  // Not revoked: the image is live for as long as any process may still import it, and the
  // kernel's own lifetime is that bound. One blob per distinct program, for one kernel.
  const image = {
    url,
    imageUrl: URL.createObjectURL(new Blob([linked], { type: "text/javascript" })),
    bytes: text.length,
    resolved,
  };
  images.set(programUrl, image);
  return image;
}

// ---------------------------------------------------------------------------- spawn

const results = [];
/** How many processes the last `go` was addressed to. `results` is posted when that many have
 *  answered, not when the live count has — a kernel that lost a process would otherwise wait out
 *  its whole timeout for a result nobody is going to send. */
let goCount = 0;

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
function spawn(image, programCfg, index = 0, parent = null) {
  const slot = table.alloc();
  if (typeof slot === "number") return slot;   // -EAGAIN, the hard cap (constraint 17)

  // M4. WHAT A CHILD INHERITS. Until now nothing did: `ppid` was initialised to 0 and assigned
  // nowhere, so `waitpid` could only ever return -ECHILD, `parkParent` and teardown's parent-wake
  // were unreachable, and `setpgid`'s "or your child" clause could never be true. Every process
  // was also its own process group and its own session, which makes `kill(-pgid)` unable to reach
  // a pipeline — and "Ctrl-C during `sleep 100 | cat` kills both" is one of M4's own proofs.
  //
  // The pgid and sid come from the PARENT and never from the caller's request. A page-spawned
  // process has no parent and stays its own group and session, which is what a process started by
  // the supervisor should be.
  if (parent) {
    slot.ppid = parent.pid;
    slot.pgid = parent.pgid;
    slot.sid = parent.sid;
    slot.cwd = parent.cwd;
    slot.uid = parent.uid;
    slot.gid = parent.gid;
  }

  slot.sab = new SharedArrayBuffer(SAB_BYTES);
  slot.ctl = new Int32Array(slot.sab);
  slot.bytes = new Uint8Array(slot.sab);
  // M3. What `/proc/<pid>/cmdline` reports. The image carries the URL it was loaded from, and
  // this is the only point at which the kernel still has it. M5 lets the CALLER name it instead,
  // because an exec'd program's cmdline is its argv (Linux's own content for that file) and only
  // `spawnChild` has the argv — a page-spawned process has no argv worth printing and keeps the
  // image URL.
  slot.cmdline = programCfg.cmdline !== undefined
    ? String(programCfg.cmdline)
    : ((image && image.url) || "");
  // THE PROCESS'S IDENTITY, set at spawn and read per call by every path syscall (constraint 29).
  // A spawn that did not take one would make every process root, and then the mode bits a check
  // asserts are bits nothing ever consults.
  if (programCfg.uid !== undefined) slot.uid = programCfg.uid | 0;
  if (programCfg.gid !== undefined) slot.gid = programCfg.gid | 0;
  slot.ctl[UID] = slot.uid;
  // M1 (f). The frame header magic+version, written once. The libos reads it once at init and
  // panics on mismatch — four bytes impossible to retrofit after a program is shipped.
  slot.ctl[H_MAGIC] = SAB_MAGIC | 0;
  slot.ctl[H_VERSION] = SAB_VERSION | 0;

  // The I/O worker reads write payloads straight out of this SAB, so a write is a message with
  // three integers and no copy. That is safe for one specific reason: the calling process is
  // parked in Atomics.wait until the dispatch kernel bumps its SEQ, and the dispatch kernel does
  // not bump it until the I/O worker has answered — so the process cannot mutate the buffer while
  // it is being read. A process still receives nothing but its own SAB and port (constraint 15).
  if (IO) IO.register(slot.pid, slot.sab);

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
      // The image, not a path to fetch: the program text has already crossed the wire once.
      image: image.imageUrl,
      // The M1 negative control travels to the process, because the entry check it
      // removes lives in the process's own stub (constraint 16).
      cfg: { ...programCfg, index, noSigpend: !!cfg.noSigpend },
    },
    [channel.port2],
  );
  return slot.pid;
}

/**
 * One program load, then `count` processes against the one image.
 *
 * The load is reported with the batch — url, bytes, how many specifiers the loader resolved, and
 * how many times this kernel has been to the network for program text — because "the program
 * crossed the wire once" is the invariant the herd broke, and a kernel that silently went back to
 * a per-process fetch would otherwise only show up as a flake.
 */
async function spawnBatch(m) {
  const image = await programImage(m.programUrl);
  const pids = [];
  // G_READY IS CUMULATIVE, so the target is absolute. A second batch against one kernel otherwise
  // finds the counter already at or past its own count and reports ready before the new processes
  // exist — measured as `TypeError: Cannot read properties of null (reading 'run')` in the child,
  // because its `go` arrived before its program had finished importing. M1 never saw it: one batch
  // per kernel.
  const already = Atomics.load(g, G_READY);
  // The ordinal of the attempt the cap refused, in pids-ever-allocated terms rather than in
  // this request's terms: pids are monotonic and nothing is freed at M0, so table.spawned at
  // the moment of the refusal is the number of live processes and the attempt was the next
  // one. A refusal reported as "the 1st of this batch" would hide which process count the
  // cap actually stopped at.
  let refusedAt = 0;
  for (let i = 0; i < m.count; i += 1) {
    const pid = spawn(image, m.cfg || {}, i);
    if (pid < 0 && !refusedAt) refusedAt = table.spawned + 1;
    pids.push(pid);
  }
  const refused = pids.filter((pid) => pid < 0).length;
  post({
    t: "spawned", pids, refused, cap: PROC_CAP, live: table.live.size,
    program: {
      url: image.url, bytes: image.bytes, resolved: image.resolved, fetches: programFetches,
    },
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
    const want = already + m.count;
    const until = now() + (m.parkMs || 10000);
    while (now() < until && Atomics.load(g, G_READY) < want) { /* starve the children */ }
    const ready = Atomics.load(g, G_READY);
    post({ t: "ready", ready, want, starved: ready < want,
      why: starvedWhy(ready, want, m.parkMs || 10000) });
    return;
  }
  awaitReady(already + m.count, m.readyTimeoutMs || 10000);
}

function onProcessMessage(slot, m) {
  if (m.t === "ready") {
    slot.state = RUNNING;
    if (m.abiFingerprint !== ABI_FINGERPRINT) {
      panic(`pid ${slot.pid} ABI fingerprint ${m.abiFingerprint} != ${ABI_FINGERPRINT}`);
      return;
    }
    Atomics.add(g, G_READY, 1);
    // M4. A child created by SYS_spawn runs itself: the page never sends it a `go`, because the
    // page does not know it exists. Armed by spawnChild and fired here, which is the first moment
    // the child's program is loaded.
    if (slot.pendingGo) {
      const go = slot.pendingGo;
      slot.pendingGo = null;
      slot.port.postMessage({ t: "go", ...go });
    }
    return;
  }
  if (m.t === "result") {
    // M4. A PROCESS-SPAWNED CHILD EXITS; it does not join the page's result batch.
    //
    // `results` and `goCount` are the page's accounting for a `go` IT issued, and a child the page
    // never spawned would make `results.length >= goCount` fire early and hand the page a batch
    // containing a process it did not ask about. A child that finished its program has exited, so
    // it is reaped — which is what makes its status available to the parent's `waitpid`.
    if (slot.ppid) {
      const code = (m.data && Number.isInteger(m.data.exit)) ? m.data.exit : 0;
      reap(slot, STAT_EXITED, code);
      return;
    }
    const sink = slot.fds.get(1);
    // THE KERNEL'S OWN FIELDS GO LAST, so a program cannot overwrite them.
    //
    // They used to go first, with `...m.data` spread over them, and a program returning a field
    // called `pid` therefore replaced the kernel's stamp with its own number. Found the hard way:
    // bench/m3-fs/program.mjs's `procgone` returns the pid it was ASKED about, so a result from
    // pid 1 arrived labelled pid 2 and the page could not find its own row. The dispatch log said
    // `to=1` while the result said `pid: 2`, which is as confusing a pair of facts as this
    // codebase has produced.
    //
    // It is also the right order on principle: `pid`, `calls`, `replies` and `errors` are the
    // kernel's account of a process, and a process must not be able to forge them. The program's
    // data is its own; where the two collide, the kernel wins.
    results.push({
      ...m.data,
      pid: slot.pid,
      calls: slot.calls,
      replies: slot.replies,
      errors: slot.errors,
      sinkBytes: sink ? sink.bytes : 0,
      sinkSum: sink ? sink.sum : 0,
      sinkWrites: sink ? sink.writes : 0,
    });
    if (results.length >= (goCount || table.live.size)) {
      post({ t: "results", results, kernel: kstats() });
    }
    return;
  }
  if (m.t === "fault") {
    // The process's runtime caught something and could not continue. It is reported under its own
    // name, with the pid and the stack, the instant it arrives: the alternative measured here was
    // the page waiting out a two-minute timeout for `results` that can never complete, with
    // `dropped 1` as the only trace.
    const fault = { pid: slot.pid, why: String(m.why) };
    faults.push(fault);
    // THROUGH `reap`, not by setting ZOMBIE here. Assigning the state directly left `exitKind` at
    // -1, so `packStatus(-1, 0)` gave a parent's `waitpid` a status meaning neither exited nor
    // killed — and, worse, teardown never ran, so the faulted process kept its fds open and a
    // pipeline peer parked on an EOF that could never arrive. That is constraint 92's symptom
    // reachable by any child whose program throws. SIGABRT is what a POSIX process gets for
    // dying on its own fault.
    reap(slot, STAT_KILLED, SIGABRT);
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

/**
 * M3's own account of itself: the mount table, the trace ring's counters, and what happened to
 * `/usr`.
 *
 * `usr` is the load-bearing field here, for the same reason `mode` is in `fsState` below. A `/usr`
 * that failed its capability probe must be visible as a REFUSAL where a reader meets it. An empty
 * `/usr` and a `/usr` nobody could mount look identical from a directory listing, and the second
 * negative control is exactly that confusion.
 */
function m3State() {
  return {
    mounted: !!mounts,
    rows: mounts
      ? mounts.rows().map((r) => ({
        path: r.path, type: r.type, dev: r.dev, readOnly: r.readOnly, durable: r.durable,
      }))
      : [],
    usr: usrReport,
    bench: benchReport,
    // M5. The exec loader's own counters, so "no program crossed the wire for a process" is a
    // measurement: `loads` counts images built from filesystem bytes and there is no `fetches`
    // field here because src/kernel/exec.mjs contains no fetch to count.
    exec: EXEC ? EXEC.stats() : null,
    trace: trace ? trace.stats() : null,
    tmp: mounts && mounts.at("/tmp")
      ? { bytes: mounts.at("/tmp").fs.bytes, limit: mounts.at("/tmp").fs.limit }
      : null,
  };
}

/**
 * The filesystem's own account of itself: how it mounted, what fsck found at mount, and the
 * storage counters. Reported at boot and on demand.
 *
 * `mode` is the load-bearing field. A kernel that mounted READ-ONLY because the image failed
 * validation must say so where a reader meets it (constraint 28) — webxp reseeded and reported
 * success, and the whole point of this milestone is that it does not.
 */
function fsState() {
  if (!STORE) {
    return { mounted: false, mode: MOUNT_REFUSE, report: mountReport, opfsWhy, ioWhy,
      notes: noteCount, noteTexts: noteTexts.slice() };
  }
  return {
    mounted: true,
    mode: STORE.mode,
    readOnly: STORE.readOnly,
    generation: String(STORE.generation),
    slot: STORE.slot,
    journalFirstSeq: String(STORE.journalFirstSeq),
    seq: String(STORE.seq),
    dirty: STORE.dirty,
    lock: STORE.lock,
    report: STORE.report,
    inodes: STORE.vfs ? STORE.vfs.stats() : null,
    stats: { ...STORE.stats },
    // THE NOTE CHANNEL, AS A NUMBER, beside the storage counters and for the same reason they are
    // here: a caller can assert on it. A note is a refusal nobody was awaiting, so on a workload
    // where nothing may be refused this must read zero — and before it was counted, the only
    // record of an unpublished write was a line in a log.
    notes: noteCount,
    noteTexts: noteTexts.slice(),
    quota: QUOTA ? { usage: QUOTA.usage, quota: QUOTA.quota } : null,
    inline: !!(IO && IO.inline),
  };
}

function kstats() {
  return {
    abiFingerprint: ABI_FINGERPRINT,
    isolated: self.crossOriginIsolated === true,
    cfg,
    calls: kCalls,
    serviceMeanUs: kCalls ? (kServiceMs * 1000) / kCalls : 0,
    notifyWoke, notify0, lateReply, dropped, badCallId, asyncFail, intr: intrCount,
    // Published so the double-reply class stays assertable rather than merely prevented: a check
    // can require this to be exactly the number of signals that reached a calling process, and a
    // climb anywhere else is a real defect. See `finish`.
    answeredDuringCall,
    // The note channel's count, so a bench that never asks for `fs-state` still reports it.
    notes: noteCount,
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
    fs: fsState(),
  };
}

// ---------------------------------------------------------------------------- M1 lifecycle
//
// Everything below is item (c), (d) and the shape proof (a)/(b)/(c)/(d) exercise. The shape:
//
//   kill(target, sig) -> raise SIGPEND bit; SIGKILL and SIGTERM-with-SIG_DFL are instantly
//     fatal and go through reap() with STAT_KILLED.
//   exit() -> reap() with STAT_EXITED.
//   reap() is the TEARDOWN point (item (d)): it answers every outstanding call on this process
//     with -TEARDOWN_ERRNO, closes every fd (which fires each kind's close op), raises the
//     child to ZOMBIE, wakes any parent parked in waitpid, and schedules terminate() plus a
//     delayed slot-free quarantine (constraint 14: a worker runs on ~2 s).
//   The invariant item (d) asks for, asserted after phase one: ZERO outstanding calls on this
//     process. If any remain, it is a dispatch defect.

const TERM_QUARANTINE_MS = 2200;

/** Answer any in-flight call for this process with -errno. One writer of SEQ/STATUS still:
 *  reply(). The outstanding-count invariant is what makes this cheap and checkable. */
function answerInflight(slot, errno) {
  if (!slot.inflight || !slot.ctl) return 0;
  // ST_RETURN carries a numeric return; the errno convention is r0 < 0 && r1 === -1.
  reply(slot, -errno, -1, ST_RETURN);
  return 1;
}

/** M1 (d). Teardown, two phases. Phase 1 answers every outstanding call with -ECONNABORTED and
 *  closes every fd (which releases the per-fd budget and runs each kind's close op). Phase 2
 *  asserts the outstanding-count is zero. Phase 3 — delayed — terminates the worker and frees
 *  the slot after the quarantine. The assertion is the point of writing this at teardown rather
 *  than scattering it across handlers. */
function teardown(slot) {
  // Phase 1: outstanding calls.
  const hadInflight = answerInflight(slot, TEARDOWN_ERRNO);

  // Phase 1b: fd closure. Walk fds explicitly, not FileTable.close, because close() returns
  // -EBADF on an already-null slot and we are iterating; a double-close would fire if a kind's
  // close op shared descriptions across fds. Going through the table by refcount is the one
  // right way.
  // ONE DECREMENT PER FD, not per description.
  //
  // This deduplicated by description, on the stated reasoning that "a dup'd description is closed
  // once" — which the REFCOUNT already guarantees, because `--d.refs <= 0` fires exactly once.
  // What the dedup actually did was LEAK a reference: `fds.add`, `fds.set` and `dup2` all raise
  // `refs` once per fd, and `FileTable.close` lowers it once per fd, so a process holding one
  // description on two fds left `refs` at 1 forever.
  //
  // Harmless until M4b, because the only shared description was the sink and its close is a no-op.
  // With a pty on fd 0 and fd 1 — which is what a terminal stage holds — the slave end never
  // closed, so `slaves` never reached 0 and the master's reader parked on an EOF that could never
  // arrive. No error anywhere: the symptom was a process stuck in `read`.
  for (let fd = 0; fd < slot.fds.fds.length; fd += 1) {
    const d = slot.fds.fds[fd];
    if (!d) continue;
    slot.fds.fds[fd] = null;
    if (--d.refs <= 0) {
      try {
        // A file's close commits a staged generation and releases its handle, so it returns a
        // PROMISE. Teardown cannot await — it runs synchronously and the pid's quarantine is what
        // gives the commit time to land (constraint 14's ~2 s) — but a REJECTION must be reported
        // rather than becoming an unhandled rejection that panics the whole kernel.
        const closing = KIND_OPS[d.kind]?.close?.(d);
        if (closing && typeof closing.then === "function") {
          closing.catch((error) => noteOut(
            `pid ${slot.pid} fd ${fd} did not close cleanly at teardown: ${error && error.message}`,
          ));
        }
      } catch (e) {
        // A close op that threw synchronously must not stop teardown: the remaining fds still
        // have to be released and the slot still has to be reaped.
        noteOut(`pid ${slot.pid} fd ${fd} close threw: ${e && e.message}`);
      }
    }
  }
  // Signal any parent parked in waitpid. The parent's slot still holds the waiter list; the
  // first matching parent is answered with (child.pid, status).
  if (slot.ppid) {
    const parent = table.get(slot.ppid);
    if (parent && parent.inflight && parent.inflight.waitingFor !== undefined) {
      const waited = parent.inflight.waitingFor;
      if (waited === -1 || waited === slot.pid) {
        const status = packStatus(slot.exitKind, slot.exitValue);
        // DETACH BEFORE REPLYING, as `reapForParent` does. Without it the child stayed in `live`
        // as a ZOMBIE after its parent had been answered, so the parent's next `waitpid` found
        // the same child and was answered with its pid a second time — and never saw the sibling
        // it was actually waiting for.
        detachChild(slot);
        reply(parent, slot.pid, status, ST_RETURN);
      }
    }
  }
  // A parked `poll` belongs to a call `answerInflight` has already answered, but the record lives
  // in calls.mjs rather than on the slot — so it is dropped explicitly. Left behind, it would be
  // skipped by the sequence guard forever and hold a reference to a freed slot.
  pollForget(slot);
  // AND WAKE EVERY OTHER PARKED POLL. The fd sweep above changes readiness WITHOUT passing
  // through `reply`: closing the dying process's ends drops a pipe's `writers` or a pty's
  // `slaves` to 0, which makes a PEER's polled fd ready — POLLIN|POLLHUP on a pipe whose last
  // writer has gone. `reply` is where the wake is hooked (constraint 109) exactly so that no kind
  // can forget it, and teardown is the one path in the kernel that moves readiness and does not
  // reply: its only `reply` is `answerInflight`, which runs BEFORE the sweep. So a peer parked in
  // `poll` over a dying process's pipe waited out its own timeout, or waited forever where it had
  // asked to block, for an event that had already happened.
  //
  // AFTER `pollForget`, so this process's own records are gone before anything rescans them —
  // rescanning a dying slot's fd table is what that call exists to prevent.
  if (pollPending()) pollWake(POLL_K);
  // Phase 2: assert. A process whose inflight is still non-null after phase 1 ran answerInflight
  // is a dispatch defect — a handler added without calling reply() through the kernel surface.
  // This is the only time that count is still knowable, which is exactly why item (d) puts the
  // assertion here.
  if (slot.inflight !== null) {
    post({ t: "teardown-leak", pid: slot.pid, kind: slot.exitKind, value: slot.exitValue,
      inflight: String(slot.inflight && slot.inflight.nr) });
  }
  return { hadInflight };
}

/** Pack (kind, value) into r1, documented once here so a reader only has to find it in one
 *  place. The split exists because a clean exit of 0 and a SIGZERO kill (there is none) would
 *  otherwise have the same r1. */
function packStatus(kind, value) {
  return ((kind & 0xff) << 8) | (value & 0xff);
}

/** The final step of a death: terminate the worker, keep the slot around for the quarantine,
 *  then free it. The pid is quarantined while the worker runs on (constraint 14: 2004-2051 ms),
 *  because reusing the pid earlier would let a stale postMessage reach a different process. */
function scheduleFree(slot) {
  try { if (IO) IO.unregister(slot.pid); } catch (e) { /* unregister is best-effort */ }
  try { if (slot.worker) slot.worker.terminate(); } catch (e) { /* already gone is fine */ }
  setTimeout(() => {
    // BY SLOT IDENTITY IN THE ALLOCATION ARRAY, not by a `byPid` lookup. `detachChild` removes the
    // pid so a second `waitpid` cannot find the child, and this used to key its free on the entry
    // that had just been removed — so `table.free` never ran, `slots[index]` stayed non-null
    // forever and the SAB, ctl and worker were never released. After PROC_CAP such children every
    // `spawn` returns -EAGAIN permanently. The waitpid path had the same ordering and became
    // reachable the moment `ppid` started being assigned.
    if (table && table.slots[slot.index] === slot) table.free(slot);
  }, TERM_QUARANTINE_MS);
}

/** Record the exit reason on the slot and run the teardown pipeline. This is the single entry
 *  point for both a clean exit (STAT_EXITED, code) and a signal kill (STAT_KILLED, signum). */
function reap(slot, kind, value) {
  if (!slot || slot.state === ZOMBIE) return;
  table.recordExit(slot, kind, value);
  teardown(slot);
  scheduleFree(slot);
  post({ t: "reaped", pid: slot.pid, kind, value });
}

/**
 * Take a reaped child out of the live set, so a second `waitpid` cannot find it again.
 *
 * ONE DEFINITION, because there are two paths that answer a parent and they disagreed. The
 * `reapForParent` path removed the child; teardown's parent-wake replied and left it in `live` as
 * a ZOMBIE — so a parent waiting for two children was answered with the FIRST child's pid twice
 * and never saw the second. That path was unreachable until `ppid` started being assigned, which
 * is exactly why it was wrong.
 *
 * The physical slot stays until `scheduleFree`'s quarantine expires; this removes only the
 * handles a `waitpid` sweep looks at.
 */
function detachChild(child) {
  if (table.byPid.get(child.pid) === child) {
    table.byPid.delete(child.pid);
    table.live.delete(child);
  }
}

/** Reply directly with (pid, status): the only call that uses r1 as a value rather than as the
 *  error sentinel. Reply via reply() and return PENDING so the dispatcher does not overwrite r1
 *  with the zero finish() would publish. */
function reapForParent(parent, child) {
  const status = packStatus(child.exitKind, child.exitValue);
  // Remove from live so a follow-up waitpid returns -ECHILD. The physical slot sticks around
  // until scheduleFree's quarantine times out.
  detachChild(child);
  reply(parent, child.pid, status, ST_RETURN);
  return PENDING;
}

function firstZombieChild(parent, askedPid) {
  for (const slot of table.live) {
    if (slot.ppid !== parent.pid) continue;
    if (askedPid !== -1 && slot.pid !== askedPid) continue;
    if (slot.state === ZOMBIE) return slot;
  }
  return null;
}

function hasChild(parent, askedPid) {
  for (const slot of table.live) {
    if (slot.ppid !== parent.pid) continue;
    if (askedPid !== -1 && slot.pid !== askedPid) continue;
    return true;
  }
  return false;
}

/**
 * Raise one signal on every member of a process group. The line discipline's whole purpose.
 *
 * O(members of that group), which is constraint 18's O(interested): `pgidMembers` is one pass over
 * the live set and a signal then goes to the group's members alone. It reaches a process that is
 * wedged and not servicing messages, because delivery is a SAB control word rather than a
 * postMessage (constraint 16) — which is the sentence "Ctrl-C depends on this" in the constraint.
 */
function signalGroup(pgid, sig) {
  if (!table || pgid <= 0) return 0;
  const members = table.pgidMembers(pgid);
  for (const member of members) raiseOne(member, sig);
  return members.length;
}

/**
 * A timer for a parked `poll` that does NOT answer the call itself.
 *
 * `setTimer` replies with 0 on expiry, which is right for `clock_nanosleep` and wrong here: a
 * `poll` that times out must publish its `revents` first, and only `calls.mjs` knows the layout.
 * So the callback decides, and the sequence guard is the caller's.
 */
function setPollTimeout(p, ms, onExpiry) {
  const seqAtDispatch = p.inflight ? p.inflight.seq : p.seq;
  setTimeout(() => {
    if (!p.ctl || p.seq !== seqAtDispatch) {
      lateReply += 1;
      return;
    }
    onExpiry();
  }, ms);
}

/** Record that this parent is parked on a (child pid or any). teardown() reads `waitingFor` to
 *  decide which wakes which. The inflight object is the SAME shape every other PENDING handler
 *  uses — this is the one source of truth for cancellation, so a terminated parent's parked
 *  wait is also torn down by answerInflight, with -ECONNABORTED, as its invariant requires. */
function parkParent(parent, askedPid) {
  parent.inflight.waitingFor = askedPid;
}

/** Raise a signal bit on the target. SIGKILL and SIGSTOP are unmaskable. The caller's own kill
 *  may deliver to a pgid (target < 0), and to self (target === pid). Returns 0 or -errno. */
function deliverSignal(caller, target, sig) {
  if (target === 0) {
    // Whole process group of caller.
    for (const m of table.pgidMembers(caller.pgid)) raiseOne(m, sig);
    return 0;
  }
  if (target < 0) {
    const pgid = -target;
    const members = table.pgidMembers(pgid);
    if (!members.length) return -ESRCH;
    for (const m of members) raiseOne(m, sig);
    return 0;
  }
  const t = table.get(target);
  if (!t) return -ESRCH;
  raiseOne(t, sig);
  return 0;
}

function raiseOne(slot, sig) {
  // SIGKILL: fatal, no mask, no handler, done. The process may be parked in Atomics.wait and
  // that is exactly the case constraint 16 names — SIGPEND is checked at syscall entry, but a
  // compute-bound process issues no syscalls, so SIGKILL is also where terminate() fires. The
  // headline M1 delivers is a process in for(;;){} that dies on End Process, and this is that
  // path.
  if (sig === SIGKILL) {
    reap(slot, STAT_KILLED, SIGKILL);
    return;
  }
  // Otherwise: set the bit. drainSignals() in the process libos reads it at syscall entry and
  // the handler disposition is consulted by the next syscall. A SIGTERM with SIG_DFL and no
  // handler installed is still fatal (POSIX); a SIGINT with SIG_IGN is dropped at raise.
  const disp = slot.sigDisp.get(sig) ?? SIG_DFL;
  if (disp === SIG_IGN) return;
  if (disp === SIG_DFL) {
    // The POSIX default for the signals M1 can reasonably name. Fatal for TERM/INT/HUP.
    // SIGPIPE JOINS THE FATAL LIST, and it is what makes `yes | head -1` terminate. POSIX's
    // default disposition for SIGPIPE is to kill, and without it a writer whose reader has gone
    // sees only the bit — which `drainSignals` discards at the next syscall entry — and loops
    // forever on a write that keeps failing. M4's negative control is to take it back out.
    if (FATAL_DEFAULT.has(sig)) {
      reap(slot, STAT_KILLED, sig);
      return;
    }
  }
  // SIG_HANDLE or a non-fatal default: the bit goes in SIGPEND and the process drains at syscall
  // entry. Constraint 16: a process parked in Atomics.wait cannot service postMessage, so this
  // is the only delivery path.
  if (!slot.ctl) return;
  Atomics.or(slot.ctl, SIGPEND, SIG_BIT(sig));

  // AND IF A CALL IS ALREADY IN FLIGHT, INTERRUPT IT. Setting the bit alone is not delivery:
  // a process parked in a PENDING call — clock_nanosleep is the one M1 exercises — would sleep
  // out its full duration and only notice the bit at the NEXT syscall entry, which for a blocking
  // read or a long sleep is never. docs/ABI.md decision 1 is explicit that the kernel sets the
  // bit, sets STATUS=ST_INTR, bumps SEQ and notifies, and drops the late reply by CALLID; intr()
  // is that, and setTimer()'s seq check is what discards the timer's own late reply.
  //
  // Without this, proof (e) times out: the signal is pending and nothing is waiting to read it.
  if (slot.inflight) intr(slot);
}

/** M1's in-kernel spawn. Called via SYS_spawn, which gets the (not-yet-decoded) argv/envp
 *  through the byte region. For M1 we only spawn against a URL recorded on the SpawnSpec; the
 *  shape of the byte region is pinned in docs/ABI.md and M2 fleshes it out.
 *
 *  A minimal M1 contract: a0 = programUrl length, byte region starts with that string, no argv,
 *  no envp. That is enough for proof (c) (spawn to the 129th) and does not pretend to be more. */
function spawnChild(caller) {
  // THE CALL THAT REPLACES `fork` (constraint 20, decision D5). `spawn` + `pipe` + `setpgid` is
  // the whole of process creation here, and M5's shell executor is specified against exactly this
  // shape: "posix_spawn-shaped file actions".
  //
  // The request is bytes, decoded by the one codec both sides import (`decodeSpawnRequest`). It
  // returns null for anything malformed rather than throwing, because this is process-controlled
  // input being parsed on the kernel thread and a throw here is a process faulting the kernel —
  // the defect class M3's review found three of.
  const length = Atomics.load(caller.ctl, LEN_I32);
  if (length <= 0 || length > MAX_INLINE) return -EINVAL;
  const req = decodeSpawnRequest(new Uint8Array(caller.bytes.subarray(DATA_OFF, DATA_OFF + length)));
  if (!req) return -EINVAL;

  // VALIDATE THE FILE ACTIONS AGAINST THE CALLER'S TABLE BEFORE ANYTHING IS ALLOCATED. A dup2
  // naming an fd the caller does not hold is EBADF, and finding that out after the worker has
  // started means tearing down a process that should never have existed.
  for (const act of req.actions) {
    if (act.op === SPAWN_DUP2 && !caller.fds.get(act.a)) return -EBADF;
  }

  // The image load reads a file, so the call cannot answer on the dispatch thread. `later` carries
  // the seq guard, which DROPS an answer whose caller has moved on — so the child it created must
  // be reaped here rather than left running with nobody holding its pid.
  const seqAtSpawn = caller.seq;
  later(caller, async () => {
    // M5. THE PROGRAM COMES OUT OF THE FILESYSTEM, resolved against the caller's cwd and checked
    // against the caller's credential. Until M5 this handed `req.path` to `fetch`, which made a
    // process-supplied string a request origin — see src/kernel/exec.mjs for what that was.
    let image;
    if (!EXEC) return -ENOEXEC;
    try {
      image = await EXEC.load(caller, req.path);
    } catch (error) {
      // A program that will not load is ENOEXEC, not EIO: the path resolved and the bytes were
      // not a program this kernel can run. The reason is NOTED rather than swallowed — the errno
      // alone cannot tell a bad module from a missing one.
      noteOut(`spawn ${req.path}: ${(error && error.message) || error}`);
      return -ENOEXEC;
    }
    // An errno from the loader is the FILESYSTEM'S answer and travels unchanged: ENOENT for a
    // program that is not there, EACCES for one without an execute bit, EISDIR for a directory.
    // Collapsing them all into ENOEXEC was this codebase's recurring bug in the other direction.
    if (typeof image === "number") return image;

    /* M5'S NEGATIVE CONTROL, in MILESTONES.md's own words: "make `spawn` return the parent's pid;
     * `ps` must show one process and the check must fail."
     *
     * NOTHING IS CREATED and the CALLER'S OWN PID is the answer, so the shell believes it started
     * a stage, waits on itself, and `/proc` holds one process. Placed AFTER the loader on purpose:
     * every refusal above still refuses, so the exec proofs (a missing program is 127, a file with
     * no execute bit is 126) must HOLD under the control and only the successful creation is
     * subverted. A control that also broke the error paths would be satisfied by a kernel that
     * had merely stopped working.
     *
     * IT SUBVERTS ONLY A CALLER THAT WAS ITSELF SPAWNED BY A PROCESS — `caller.ppid` non-zero —
     * and that narrowing is the difference between a control and a broken kernel. The page's
     * orchestrator has no parent, so it still starts the shell; the shell has one, so none of ITS
     * stages exist. Without the test, nothing could run at all and every section went red
     * together: measured, 7 of 8 sections failing, which is a control "satisfied by any failure"
     * and verifies nothing about pipelines. With it, the builtins, the refusals and the URL
     * refusals must HOLD — none of them creates a process — and only the sections that need a real
     * child may move.
     *
     * Gated on a bench boot, as every control hook here is. */
    if (cfg.spawnSelf && caller.ppid) {
      if (cfg.bench !== 1) throw new Error("spawnSelf requires bench=1");
      return caller.pid;
    }
    const childPid = spawn(
      image,
      {
        argv: req.argv,
        // What `/proc/<pid>/cmdline` reports for an exec'd program: its argv, NUL-joined, which is
        // Linux's own content for that file. The PAGE's spawn keeps reporting the image URL it
        // fetched, because that is what a page-spawned process actually ran.
        cmdline: (req.argv.length ? req.argv : [req.path]).join("\0"),
      },
      0,
      caller,
    );
    if (childPid < 0) return childPid;             // -EAGAIN, the cap
    const child = table.get(childPid);
    if (!child) return -EAGAIN;

    // FD INHERITANCE, then the actions, in that order — which is posix_spawn's own order and the
    // reason a shell can say "dup the pipe onto 1, then close the pipe fd". The child starts with
    // the caller's whole table, each description's refcount raised, and the actions rearrange it.
    //
    // fds 1 and 2 were already pointed at a fresh sink by `spawn`; inheriting over them is
    // correct, because a child of a process with a redirected stdout must get the redirection.
    for (let fd = 0; fd < caller.fds.fds.length; fd += 1) {
      const d = caller.fds.get(fd);
      if (!d) continue;
      const existing = child.fds.get(fd);
      if (existing) {
        // The sink `spawn` installed. Drop our reference to it before the inherited description
        // takes the slot, or it leaks a refcount nothing will ever close.
        child.fds.close(fd);
      }
      d.refs += 1;
      if (child.fds.set(fd, d) < 0) {
        // The caller held an fd past the ceiling, which `FileTable.add` and `dup2` now refuse —
        // so this is unreachable rather than tolerable. Undo the reference and stop inheriting
        // rather than leave a refcount nothing will close.
        d.refs -= 1;
        break;
      }
    }
    for (const act of req.actions) {
      if (act.op === SPAWN_DUP2) {
        const src = child.fds.get(act.a);
        if (!src) continue;             // validated above against the caller; a prior CLOSE may have taken it
        if (act.a === act.b) continue;  // dup2(fd, fd) is a no-op that must not drop a refcount
        if (child.fds.get(act.b)) child.fds.close(act.b);
        src.refs += 1;
        if (child.fds.set(act.b, src) < 0) {
          // Unreachable: `decodeSpawnRequest` refuses an action naming an fd past OPEN_MAX. Not
          // swallowed, because a refcount raised and then dropped on the floor is a description
          // that never closes.
          src.refs -= 1;
          continue;
        }
      } else {
        if (child.fds.get(act.a)) child.fds.close(act.a);
      }
    }
    // ARM THE RUN ON THE CHILD'S OWN `ready`, rather than polling for it. The worker is already
    // constructed and loading its image; `onProcessMessage`'s ready arm posts this `go` the moment
    // the child says it is initialised, so there is no sleep and no window in which the child
    // could be told to run before its program exists.
    child.pendingGo = { mode: "park", argv: req.argv };
    // THE CALLER MAY BE GONE. `later`'s seq guard would drop this answer silently, leaving a child
    // running that nobody holds the pid of — and the comment above promised a reap that did not
    // exist. Checked here, where the child is still ours to undo.
    if (!caller.ctl || caller.seq !== seqAtSpawn) {
      reap(child, STAT_KILLED, SIGKILL);
      return -EINTR;
    }
    return child.pid;
  });
  return PENDING;
}


// ---------------------------------------------------------------------------- boot

function post(m) {
  self.postMessage(m);
}

/**
 * EVERY NOTE LEAVES THE KERNEL HERE, which is what makes the count equal to the channel.
 *
 * Six call sites feed it — the I/O worker's relay, the inline I/O surface, the Store, teardown's
 * two close arms, and `later()`'s rejection arm — and a seventh that posted `io-note` directly
 * would be a note nothing counted. There is one function so there is one number.
 */
function noteOut(why) {
  noteCount += 1;
  const text = String(why);
  if (noteTexts.length < NOTE_KEEP) noteTexts.push(text);
  post({ t: "io-note", why: text });
}

self.onerror = (e) => panic(`kernel onerror: ${e.message ?? e}`);
self.onunhandledrejection = (e) => panic(`kernel rejection: ${e.reason}`);

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    await handle(m);
  } catch (error) {
    panic(`${m && m.t}: ${error && error.stack}`);
  }
};

async function handle(m) {
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
      // The OPFS root, acquired ONCE at boot. Awaiting it per open would charge every caller for
      // a directory lookup, and the handle is not releasable per-process anyway (constraint 15).
      // A kernel that cannot reach storage still boots: SYS_open then answers -EIO, which is the
      // honest state of a call the kernel cannot serve, rather than a boot that fails for a
      // capability M0's three original calls never needed.
      try {
        OPFS_ROOT = await navigator.storage.getDirectory();
      } catch (e) {
        OPFS_ROOT = null;
        opfsWhy = String((e && e.name) || e);
      }
      // The storage quota, asked for ONCE. `navigator.storage.estimate()` is the only source for
      // the figure statfs publishes, and asking per call would charge every `df` for it.
      try {
        QUOTA = await navigator.storage.estimate();
      } catch (e) {
        QUOTA = null;
      }
      // The I/O worker, unless the control routes storage back onto this thread. Constraint 58:
      // with the handles here, one process's fsync took every other process's p99 from 275 us to
      // 850 at N=16 and past the kill bar at N=64. The control is ONE OBJECT swapped at boot —
      // src/kernel/io-inline.mjs implements the same request() surface synchronously — so neither
      // store.mjs nor files.mjs carries an inline branch and the headline path cannot have been
      // perturbed by the control's existence.
      if (cfg.ioInline) {
        if (cfg.bench !== 1) throw new Error("ioInline requires bench=1");
        IO = makeInlineIo(() => OPFS_ROOT, noteOut);
        ioBooted = await IO.start();
        if (!ioBooted) ioWhy = opfsWhy || "no OPFS root";
      } else {
        IO = makeIo(new Worker(new URL("./io-worker.mjs", import.meta.url), { type: "module" }));
        IO.boot();
        // The mount below reads the superblock slots through this worker, so the boot handshake
        // has to have landed first. Awaited rather than assumed: a mount that raced the worker's
        // getDirectory() would read three absent slots and call a populated volume fresh, which is
        // the one mistake constraint 28 exists to prevent.
        await IO.ready(5000);
      }
      // The filesystem. Mounted BEFORE any process exists, because a process's first syscall may
      // be an open and a half-mounted filesystem has no honest answer for it.
      if (ioBooted) {
        // The note channel: a storage refusal nobody is awaiting. The one that matters is a
        // commit refused inside a process's teardown — teardown cannot await an fd's close, so a
        // write the kernel could not publish would otherwise leave no record anywhere.
        STORE = new Store(IO, cfg, noteOut);
        STORE.quota = QUOTA;
        installStore(STORE);
        mountReport = await STORE.mount();
      } else {
        mountReport = { mountable: MOUNT_REFUSE, problems: [{ what: "opfs",
          why: `the I/O worker has no OPFS root: ${ioWhy || opfsWhy || "unknown"}` }] };
      }
      // M3. The syscall trace ring, before the mount table because `/dev` reads it.
      //
      // Sized from cfg only under bench=1, same gate as every other control hook: an undersized
      // ring is M3's third negative control and a hook a later change could leave armed is worse
      // than one needing a hand edit. `enforce: false` is what lets the control go below the
      // 16 MiB floor, and nothing else may pass it.
      if (cfg.traceBytes) {
        if (cfg.bench !== 1) throw new Error("traceBytes requires bench=1");
        trace = new TraceRing(cfg.traceBytes | 0, { enforce: false });
      } else {
        trace = new TraceRing(TRACE_DEFAULT_BYTES);
      }

      // M3. THE MOUNT TABLE, static at boot (MILESTONES.md M3). There is no SYS_mount: a process
      // cannot mount, which is the narrowest possible form of docs/LEARNING-MODE.md §6's rule that
      // `mount` must never accept a caller-supplied URL.
      //
      // Built only when the volume mounted. A kernel with no filesystem has no root to hang
      // `/proc` off, and a mount table whose root was absent would answer every path call with a
      // confusing ENOENT instead of the honest -EIO the store already returns.
      if (STORE && STORE.vfs) {
        mounts = new MountTable();
        mounts.add("/", {
          fs: STORE.vfs,
          type: FS_OPFS,
          // The volume's own read-only verdict (constraint 28: a bad superblock mounts read-only
          // and reports). One renderer: the write paths test the mount flag, not two sources.
          flags: STORE.readOnly ? MNT_RO : 0,
        });
        if (cfg.procCache && cfg.bench !== 1) throw new Error("procCache requires bench=1");
        const procFs = makeProcFS({
          table: () => table,
          mounts: () => mounts,
          // M3's first negative control. False in every real boot.
          cache: cfg.procCache === true,
        });
        const devFs = makeDevFS({ trace: () => trace });
        // setDev AFTER add, because the table assigns the number — a filesystem that chose its
        // own device number would be a second place uniqueness had to hold.
        procFs.setDev(mounts.add("/proc", { fs: procFs, type: FS_PROC, flags: MNT_RO }).dev);
        devFs.setDev(mounts.add("/dev", { fs: devFs, type: FS_DEV, flags: MNT_RO }).dev);

        // `/tmp`: WRITABLE, and the only mount besides the root that is. It carries
        // `durable: false`, so `metaOp` applies an op and returns 0 without journalling — a
        // record describing the OPFS volume would be a record of an op that did not happen there.
        const tmpFs = new TmpFS({ now: () => Date.now() });
        tmpFs.setDev(mounts.add("/tmp", { fs: tmpFs, type: FS_TMPFS }).dev);

        // `/usr` ON THE PROVIDER INTERFACE. Awaited, because the mount reads its manifest over the
        // network and MILESTONES.md M3 requires the mount itself to refuse rather than come up
        // empty. A refusal is RECORDED AND REPORTED, never swallowed: `usrReport` is what the page
        // reads, and a kernel whose `/usr` failed still boots with the rest of the tree intact —
        // the honest state, since nothing in M3 depends on `/usr` existing.
        //
        // The provider id comes from cfg only under bench=1, same gate as every other control
        // hook. `usrProvider: "missing"` is how the second negative control points it at a 404.
        const usrId = cfg.usrProvider ? (() => {
          if (cfg.bench !== 1) throw new Error("usrProvider requires bench=1");
          return cfg.usrProvider;
        })() : "local";
        if (cfg.usrMount !== false) {
          try {
            const mounted = await mountProvider({
              id: usrId,
              entries: cfg.usrEntries || USR_ENTRIES,
            });
            mounted.fs.setDev(
              mounts.add("/usr", { fs: mounted.fs, type: FS_PROVIDER, flags: MNT_RO }).dev);
            usrReport = { ok: true, ...mounted.report };
          } catch (error) {
            // LOUD, and specifically not a mount. There is no `/usr` row in the table, so a path
            // under it falls to the root volume and answers ENOENT — which is the truth — rather
            // than resolving into an empty directory that looks like a working but bare volume.
            usrReport = {
              ok: false, provider: usrId,
              code: error.code || "EIO", why: String(error.message || error),
            };
            noteOut(`/usr not mounted: ${usrReport.code} ${usrReport.why}`);
          }
        }

        // M5. `/bench`, UNDER A BENCH BOOT ONLY, so that the orchestrator programs M4 and M4b
        // spawn by path still resolve now that `SYS_spawn` loads from the filesystem and not from
        // the network (src/kernel/exec.mjs says why that changed).
        //
        // IT IS THE SAME MOUNT MECHANISM AS `/usr` and the same committed manifest shape — a row,
        // not a driver. The paths the bench programs name (`/bench/m4-fs/program.mjs`) are
        // unchanged, which is deliberate: a milestone that is already proved must not have its
        // proof edited to keep passing.
        if (cfg.bench === 1 && cfg.benchMount !== false) {
          try {
            const mounted = await mountProvider({ id: "local", entries: BENCH_ENTRIES });
            mounted.fs.setDev(
              mounts.add("/bench", { fs: mounted.fs, type: FS_PROVIDER, flags: MNT_RO }).dev);
            benchReport = { ok: true, ...mounted.report };
          } catch (error) {
            benchReport = {
              ok: false, code: error.code || "EIO", why: String(error.message || error),
            };
            noteOut(`/bench not mounted: ${benchReport.code} ${benchReport.why}`);
          }
        }
      }

      // M5. THE EXEC LOADER. Built after the mount table, because a program path is resolved
      // through it, and before CALLS, because `spawnChild` is wired into the handler surface.
      //
      // The loader buffer is registered with the I/O worker under a negative id, so a durable-
      // volume program is read through the same `Store.readFd` a process's `read(2)` goes through
      // without borrowing a process's byte region. A kernel with no I/O worker registers nothing
      // and the durable arm answers -EIO, which is the state it is in.
      execSab = new SharedArrayBuffer(EXEC_CHUNK);
      execView = new Uint8Array(execSab);
      if (IO) IO.register(EXEC_VIEW_ID, execSab);
      EXEC = makeExec({
        mounts: () => mounts,
        store: () => STORE,
        execView: () => execView,
        base: self.location.href,
        note: noteOut,
      });

      // k.table is a getter in the surface below, so handlers see the live ProcTable rather
      // than a snapshot taken before anything was spawned. The alternative — passing `table`
      // directly — would capture the initial value and break every spawn after the kernel's
      // own test rig recreated the table.
      CALLS = buildCalls({
        reply, fail, setTimer, later,
        get store() { return STORE; },
        get table() { return table; },
        reap,
        reapForParent,
        firstZombieChild,
        hasChild,
        parkParent,
        deliverSignal,
        spawnChild,
        // M3. Getters, not values: the mount table is built after this object is described in
        // source order and a captured null would make every path call -EIO.
        get mounts() { return mounts; },
        get trace() { return trace; },
        setPollTimeout,
        signalGroup,
        // WHETHER A PARKED `poll` IS RE-EVALUATED AT ALL. A getter, because `no-poll-wake` arms
        // after this object is built — and the control is named for re-evaluation, which happens
        // in TWO places: the wake hooked on `reply`, and the rescan a timeout does before it
        // answers. Removing only the first left the timeout answering correctly 5 seconds late,
        // so the control broke nothing a check could see and the harness refused it. One flag
        // governs both.
        get pollReevaluates() { return pollWakeEnabled; },
      });
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
      // M4. The two kernel operations a pipe performs on a process, injected rather than imported:
      // `pipe.mjs` is imported BY this file, so the reverse would be a cycle. `reply` is the
      // single writer of SEQ/STATUS/RLEN, so a pipe waking a reader goes through the same release
      // every other answer does, and `raiseOne` is the one place a disposition is consulted.
      installPipeKernel({ reply, raise: raiseOne });
      // The pty needs to reply to parked readers and to signal a whole process group. Injected
      // for the same reason the pipe's surface is: this file imports pty.mjs.
      installPtyKernel({ reply, signalGroup });

      if (cfg.depth === false) dispatch = onSyscallNoDepth;
      // M4's negative control. Stop delivering a fatal SIGPIPE and `yes | head -1` must HANG:
      // head exits, the pipe loses its reader, and yes keeps writing into a pipe nobody reads.
      // Same discipline as installStall and noSigpend — refused unless the page asked for a
      // bench boot, so a hook a later change could leave armed is not possible silently.
      // M4b's controls. `noIsig` makes every new pty come up with ISIG cleared, so the line
      // discipline recognises no signal characters at all and Ctrl-C arrives as data —
      // MILESTONES.md M4's one specified behaviour, removed. `noPollWake` stops re-evaluating
      // parked polls when anything replies, so a blocked `poll` can only ever time out.
      if (cfg.noIsig) {
        if (cfg.bench !== 1) throw new Error("noIsig requires bench=1");
        setPtyDefaultIsig(false);
      }
      if (cfg.noPollWake) {
        if (cfg.bench !== 1) throw new Error("noPollWake requires bench=1");
        pollWakeEnabled = false;
      }
      // `noFinishGuard` lets `finish` reply to a call its handler's own side effect already
      // answered: one call, two replies, two SEQ bumps and two G_INFLIGHT decrements. Reachable
      // because a fresh pty's foreground group is its OPENER's, so a resize before the group
      // moves signals the caller — which `p_selfwinch` is.
      // `noWinch` leaves the resize and removes only its signal.
      if (cfg.noWinch) {
        if (cfg.bench !== 1) throw new Error("noWinch requires bench=1");
        setPtyWinch(false);
      }
      if (cfg.noFinishGuard) {
        if (cfg.bench !== 1) throw new Error("noFinishGuard requires bench=1");
        finishGuardEnabled = false;
      }
      if (cfg.noSigpipe) {
        if (cfg.bench !== 1) throw new Error("noSigpipe requires bench=1");
        FATAL_DEFAULT.delete(SIGPIPE);
      }
      // M2's negative control, both stages. Same discipline as installStall: a hook a later change
      // could leave armed is worse than one requiring a hand edit, so bench=1 is the gate, and the
      // echoed cfg above is how each proves it was applied.
      //
      // Stage 1, `noCowOrder`: the commit drops the data-before-metadata ordering, so the journal
      // record and its flush land and the blob is never flushed. fsck must report corruption.
      // Stage 2, `noCrc`: replay and the image decoder stop checking their CRCs, so a torn journal
      // is ACCEPTED and the torn-journal proof starts passing — if it passed either way it was
      // testing nothing.
      if (cfg.noCowOrder && cfg.bench !== 1) throw new Error("noCowOrder requires bench=1");
      if (cfg.noCrc && cfg.bench !== 1) throw new Error("noCrc requires bench=1");
      if (cfg.noSigpend) {
        // The M1 negative control. Refuses unless the page asked for a bench boot, the same
        // discipline installStall applies: a hook a later change could leave armed is worse
        // than one requiring a hand edit, so bench=1 is the gate.
        if (cfg.bench !== 1) throw new Error("noSigpend requires bench=1");
        dispatch = onSyscallNoSigpend;
      }
      setInterval(tick, HB_PERIOD_MS);
      lastTick = now();
      Atomics.store(g, G_KSTATE, K_UP);
      // The echoed cfg is not a courtesy: it is how a control proves it was applied. The mount
      // report travels with it for the same reason: a kernel that came up READ-ONLY must say so at
      // boot rather than answering -EROFS to the first write and leaving the caller to guess.
      post({
        t: "up", globals, abiFingerprint: ABI_FINGERPRINT, cfg,
        isolated: self.crossOriginIsolated === true,
        fs: fsState(),
      });
      return;
    }
    case "spawn":
      // The loader awaits a fetch, so this leg is async — and its rejection has to be turned
      // into the kernel's own panic here, because `handle` is called from a try/catch that an
      // unawaited promise walks straight past.
      spawnBatch(m).catch((error) => panic(`spawn: ${error && (error.stack || error)}`));
      return;
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
      // `go.pid` addresses ONE process. A page driving several different programs against one
      // kernel — M2's proof (c) holds a file open in one process while a second opens it and a
      // third overwrites it — cannot use a broadcast: every process would re-run on every go.
      const targets = [...table.live].filter((p) => !m.go || !m.go.pid || p.pid === m.go.pid);
      // What `results` waits for. The live-process count was wrong the moment a process could
      // die: a kernel that lost one would wait for a result that is never coming and report the
      // timeout as latency.
      goCount = targets.length;
      for (const p of targets) p.port.postMessage({ t: "go", ...m.go });
      return;
    }
    case "raise": {
      const p = table.get(m.pid);
      if (!p) return;
      // Goes through the one raise path, which honours SIGKILL (terminate + reap), the handler
      // table, and the SIGPEND bit. Before M1 this flipped the bit directly, which was correct
      // for M0 (no SIGKILL semantics yet) and would silently drop SIGKILL now.
      raiseOne(p, m.sig | 0);
      return;
    }
    case "end-process": {
      // The UI's "End Process" button. Equivalent to kill(-SIGKILL, pid): reap immediately,
      // terminate() the worker, quarantine the pid. Proof (a).
      const p = table.get(m.pid);
      if (!p) return;
      reap(p, STAT_KILLED, SIGKILL);
      return;
    }
    case "shutdown": {
      /* EVERY LIVE PROCESS, REAPED, BEFORE THE PAGE TERMINATES THIS KERNEL.
       *
       * The page terminated the kernel worker and nothing else, which ORPHANS every process worker
       * the kernel had created: a terminated worker's nested workers are collected eventually and
       * not promptly. A bench page that boots one kernel per proof — www/m4b.html boots thirteen —
       * then accumulates every stage it ever spawned, which is worth not doing.
       *
       * IT WAS REACHED FOR TO FIX A FLAKE AND DID NOT FIX IT, said here so nobody reads it as the
       * remedy: `www/m4b.html` reports BROKEN with `timed out waiting for spawned` about 1 run in
       * 12, and that rate was 11 of 12 with this sweep, 11 of 12 without it, and 11 of 12 at
       * eleven proofs instead of thirteen (constraint 121). The cause is unidentified.
       *
       * Reaped rather than signalled: `reap` is the path `end-process` already uses, so this adds
       * a sweep and no new teardown. The list is copied first because `reap` mutates `table.live`.
       */
      const live = [...table.live];
      for (const slot of live) {
        try {
          reap(slot, STAT_KILLED, SIGKILL);
        } catch (e) {
          // One slot that will not die must not strand the rest, and the page is waiting on the
          // acknowledgement below.
          noteOut(`pid ${slot.pid} did not reap at shutdown: ${e && e.message}`);
        }
      }
      post({ t: "shutdown", reaped: live.length, kernel: kstats() });
      return;
    }
    case "expose":
      // The SABs, shared (not transferred) to the page, for the one observation that has to
      // outlive this worker: whether each parked process concluded the kernel was gone. Nothing
      // privileged crosses — a SAB is the channel, and the page already holds the globals one.
      post({ t: "exposed", procs: [...table.live].map((p) => ({ pid: p.pid, sab: p.sab })) });
      return;
    case "m4-state": {
      // M4's own account of itself: who is parked, on what, and what every pipe holds.
      //
      // A pipeline that stops makes no error anywhere — a parked reader and a parked writer are
      // both legitimate states — so the only way to tell a working pipe from a deadlocked one is
      // to look at the counts. Pipes are reached by walking the fd tables because nothing holds a
      // registry of them: a pipe is alive exactly as long as a description points at it.
      const pipes = new Map();
      const procs = [...table.live].map((s) => {
        const fds = [];
        s.fds.fds.forEach((d, fd) => {
          if (!d) return;
          fds.push({ fd, kind: d.kind, refs: d.refs });
          if (d.pipe && !pipes.has(d.pipe)) pipes.set(d.pipe, d.pipe.report());
        });
        return {
          pid: s.pid, ppid: s.ppid, pgid: s.pgid, sid: s.sid, state: s.state,
          calls: s.calls, replies: s.replies, errors: s.errors,
          // What this process is parked on, if anything. The syscall NAME, because a number
          // sends the reader to the table.
          inflight: s.inflight ? (SYS_NAME[s.inflight.nr] || s.inflight.nr) : null,
          waitingFor: s.inflight ? (s.inflight.waitingFor ?? null) : null,
          fds,
        };
      });
      post({ t: "m4-state", procs, pipes: [...pipes.values()] });
      return;
    }
    case "m3-state":
      post({ t: "m3-state", m3: m3State() });
      return;
    case "trace-read":
      // The trace as TEXT, through the same renderer `/dev/trace` uses, so the page and a process
      // cannot be shown two different traces. One renderer of one fact.
      post({ t: "trace-read", text: renderTrace(trace, { limit: (m.limit | 0) || 256 }) });
      return;
    case "stats":
      post({ t: "stats", kernel: kstats() });
      return;
    case "snapshot": {
      // Constraint 23's second flush point. The shell's job in a real system; the page's here,
      // because M2 has no shell yet. It is NOT a syscall: docs/ABI.md's path group does not list
      // one, and inventing a number the ABI does not name would be a worse departure than
      // reaching it through the kernel's own control channel.
      if (!STORE) {
        post({ t: "snapshot", ok: false, why: "no filesystem is mounted" });
        return;
      }
      const r = await STORE.writeSnapshot();
      post({
        t: "snapshot", ok: r === 0, r,
        generation: String(STORE.generation), slot: STORE.slot,
        journalFirstSeq: String(STORE.journalFirstSeq), stats: { ...STORE.stats },
      });
      return;
    }
    case "fsck": {
      // An EXPLICIT fsck, blob sweep included (constraint 33 keeps the sweep off the boot path).
      // It never writes: src/fs/fsck.mjs holds no handle and no root directory, so there is no
      // object there through which a reseed could be expressed.
      if (!STORE) {
        post({ t: "fsck", ok: false, why: "no filesystem is mounted" });
        return;
      }
      const before = { generation: String(STORE.generation), slot: STORE.slot };
      const report = await STORE.check();
      post({ t: "fsck", ok: true, report, before,
        after: { generation: String(STORE.generation), slot: STORE.slot } });
      return;
    }
    case "fs-state":
      post({ t: "fs-state", fs: fsState() });
      return;
    case "io-stats": {
      // The storage edge's counters and operation trace. A measurement channel, not a syscall:
      // docs/ABI.md names no call for it and a process has no business reading it.
      if (!STORE) {
        post({ t: "io-stats", ok: false, why: "no filesystem is mounted" });
        return;
      }
      post({ t: "io-stats", ok: true, io: await STORE.ioStats() });
      return;
    }
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
