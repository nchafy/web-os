// The kernel. A dedicated Worker, and the only privileged code in the repository.
//
// There is no loop: an event-driven dispatcher, which is the whole of constraint 2. Parking here
// would be LEGAL (constraint 10), so it is a rule rather than an impossibility, and
// bench/syscall-contention asserts it by grepping this directory.

import {
  SEQ, STATUS, RLEN, SIGPEND, CALLID, UID, NR, R0, R1, A0, A1, A2, A3, A4, A5, A6, A7, H_MAGIC,
  H_VERSION, SAB_MAGIC, SAB_VERSION, LEN_I32, DATA_OFF, ST_RETURN, ST_INTR, ST_KDOWN, SIG_BIT,
  GLOBAL_BYTES, G_HEARTBEAT, G_HB_PERIOD_MS, G_KSTATE, G_EPOCH, G_INFLIGHT, G_THINK_US,
  G_STALL_US, G_READY, G_WINDOW, G_BARRIER, G_DEADLINE_LO, G_DEADLINE_HI, W_PRE, W_OPEN,
  W_CLOSED, W_DONE, K_BOOT, K_UP, K_PANIC, HB_PERIOD_MS, SAB_BYTES, PROC_CAP, EINTR, EINVAL,
  ENOSYS, EIO, EAGAIN, EPERM, ESRCH, ECHILD, TEARDOWN_ERRNO, SIGKILL, SIGTERM, SIGINT, SIGHUP,
  SIGPIPE, SIGABRT, SIGQUIT, SIGILL, SIGSEGV,
  SIG_DFL, SIG_IGN, SIG_HANDLE, F_PIPE_R, F_PIPE_W, MAX_INLINE, SPAWN_DUP2,
  ENOEXEC, SYS_NAME, decodeSpawnRequest, STAT_EXITED, STAT_KILLED, ABI_FINGERPRINT, packI64,
  SYS_read, SYS_write, SYS_pread, SYS_pwrite,
} from "../abi.mjs";
import { ProcTable, RUNNING, ZOMBIE, SPAWNING } from "./table.mjs";
import {
  makeSink, installTruncateOverflow, installStore, installWins, installData, KIND_OPS,
} from "./files.mjs";
import {
  buildCalls, installStall, PENDING, pollWake, pollForget, pollPending, setPollFirstOnly,
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
import { makeDevFS, renderTrace, TRACE_RENDER_LIMIT } from "./devfs.mjs";
import { TmpFS } from "./tmpfs.mjs";
import { installPipeKernel } from "./pipe.mjs";
import { installPtyKernel, setPtyDefaultIsig, setPtyWinch, setPtyDetached } from "./pty.mjs";
import {
  WinMgr, installWindowKernel, setCascade, setDrawReaches, setOwnerChain, setModalBlocks,
  setItemsReach, setWheelCoalesce,
  setGovernor,
  NOT_RESPONDING_MS, END_PROCESS_MS,
} from "./wins.mjs";
import {
  DataMgr, installDataKernel, setTypedFormats, setDropReaches,
} from "./dataobj.mjs";

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
/** Whether each mountpoint exists as a DIRECTORY on the volume beneath it. Published because a
 *  missing one is invisible in every other report: the mount still works and the parent's listing
 *  silently omits it (constraint 238). */
let mountpointReport = [];
let table = null;
/** `trace` and `mounts` are null before boot, so every use of them is guarded. */
/**
 * The signals whose SIG_DFL disposition is to kill. Data, so M4's negative control removes a row.
 *
 * SIGPIPE's membership is what makes `yes | head -1` terminate: without it a writer whose reader
 * has gone only gets the bit, which `drainSignals` discards at the next syscall entry.
 */
const FATAL_DEFAULT = new Set([
  SIGTERM, SIGINT, SIGHUP, SIGPIPE,
  SIGQUIT, SIGABRT, SIGILL, SIGSEGV,
]);

let trace = null;
let mounts = null;
/** Frame reports that arrived after their window was destroyed. A race the page cannot avoid —
 *  see the `win-geom` case — so it is counted here and published in `win-state`. */
let lateGeoms = 0;
/** Clicks that arrived after their window was destroyed. The same race in the other direction, and
 *  a SEPARATE number because the two diagnose different things. */
let lateRaises = 0;

/** M7. The window table. Built at boot and never null: a kernel with no windows is a kernel with
 *  an empty table, which is a state `win_create` can change — unlike M4a's single console, which
 *  the PAGE had to create before any process could open it. */
let WINDOWS = null;
/** M10. The typed data objects, the one clipboard slot and the one drag session. Built beside the
 *  window table because a drag is a gesture over windows: `src/kernel/dataobj.mjs` reads the window
 *  table through a getter, and this file is the only place both exist. */
let DATA = null;
/** The exec loader, and the kernel's OWN byte region, registered with the I/O worker under a
 *  NEGATIVE id so it can never collide with a process's. One buffer, locked around the reads that
 *  use it: two `SYS_spawn` calls are two `later()` bodies interleaving at every await. */
let EXEC = null;
let execSab = null;
let execView = null;
/** The /usr provider mount's outcome. A /usr that failed its probe must be visible as a refusal
 *  rather than as an empty directory. */
let usrReport = null;
/** The same for `/bench`, which exists only under a bench boot. Null reads as "no such mount". */
let benchReport = null;
/** Whether this kernel was booted as a bench. Module-level because the boot `cfg` is scoped to the
 *  boot handler, and M12's runtime budget hook is gated on it from the message switch. */
let benchBoot = false;
let hb = 0;
let kServiceMs = 0;
let kCalls = 0;
let notifyWoke = 0;
let notify0 = 0;
let lateReply = 0;
let dropped = 0;
let badCallId = 0;
/** KERNEL-SIDE EXCEPTIONS IN AN ASYNC SYSCALL BODY, counted: `later()` is the completion path for
 *  open, write, fsync, truncate and close, and an exception reported only by the errno a real I/O
 *  failure would return is indistinguishable from one. */
let asyncFail = 0;
let intrCount = 0;
let hbTick = 0;
let lastTick = 0;

// The heartbeat tick gap, as a BOUNDED histogram; summarise.mjs owns every percentile over it.
const HB_GAP_BIN_MS = 0.5;
// 0..128 ms: the busy ceiling is REARM_MS x HB_MISS_LIMIT = 150 ms, past which the heartbeat is no
// longer the question.
const HB_GAP_BINS = 256;
const hbGapHist = new Int32Array(HB_GAP_BINS);
let hbGapCount = 0;
let hbGapSumMs = 0;
let hbGapMaxMs = 0;
let hbGapOver = 0;

// WHICH HISTOGRAM A DISPATCH LANDS IN IS THE WINDOW. depthWindow holds only the dispatches taken
// while every process was inside the measured window, and it is the only set the concurrency gates
// may read: warm-up dispatches are serial by construction. depthRamp ends at saturation.
const depthAll = new Int32Array(256);
const depthWindow = new Int32Array(256);
const depthRamp = new Int32Array(256);

let depthTarget = depthRamp;
let satTarget = Infinity;
// The depth the hand-over fired at: `saturated` alone is a boolean whose meaning is its threshold.
let satDepth = 0;

/** A process fault, never folded into `dropped`: a swallowed fault turns N processes into N-1. */
const faults = [];

/** THE NOTE CHANNEL. A note is a storage failure nobody is awaiting. It is a NUMBER as well as a
 *  text, because a failure only a human reading logs can find is not reported: the count rides in
 *  `fsState` and `kstats`, and the suite asserts it at zero where nothing may be refused.
 *  `NOTE_KEEP` bounds the texts; the count is unbounded. */
const NOTE_KEEP = 32;
const noteTexts = [];
let noteCount = 0;


/**
 * The single writer of SEQ, STATUS, RLEN, the notify and G_INFLIGHT. No handler may reach these.
 *
 * MEMORY ORDERING, load-bearing. r0, r1, RLEN and any reply bytes are written with plain stores;
 * the Atomics.store to SEQ is the RELEASE that makes them visible to the process's acquiring read
 * after its wake. Without it a process can observe the new SEQ and the previous call's r0. */
function reply(p, r0, r1 = 0, st = ST_RETURN, rlen = 0) {
  // THE EXIT RECORD, written here because `reply` is the one place a call concludes. IT CARRIES ITS
  // CALL'S ENTRY TIME, not the exit's: the dispatcher already holds `tIn`, and a clock read here
  // would cost more than the record. CONSEQUENCE: SYSCALL DURATION IS NOT IN THE TRACE; order is,
  // from the monotonic `seq`.
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
  // A notify that woke nobody is the event the process tallies as "not-equal": two counters on
  // opposite sides of the boundary measuring one phenomenon (constraint 7).
  if (woke === 0) notify0 += 1;
  Atomics.sub(g, G_INFLIGHT, 1);
  // Progress, not just an idle timer: a kernel saturated with synchronous handler work can starve
  // its own interval task, and constraint 46's stall control would then fault healthy processes.
  Atomics.store(g, G_HEARTBEAT, ++hb);
  p.replies += 1;
  if (r0 < 0 && r1 === -1) p.errors += 1;
  p.inflight = null;
  // EVERY PARKED `poll` IS RE-EVALUATED HERE, because `reply` is the one funnel every state change
  // that could make an fd ready passes through. Hooked here, a new kind cannot forget to notify.
  pollWakeAll();
}

const POLL_K = { reply };

/** Re-evaluate every parked `poll`, under the flag that governs re-evaluation. TWO CALLERS:
 *  `reply`, and a window, whose events from the page pass through no reply at all
 *  (constraint 160).
 *  TEARDOWN IS NOT A CALLER: its wake is deliberately UNGATED, so under `no-poll-wake` a peer
 *  parked over a dying process's pipe is still woken. */
function pollWakeAll() {
  if (pollWakeEnabled && pollPending()) pollWake(POLL_K);
}

/** M4b's second control: with it cleared, a parked `poll` only ever answers from its timeout. */
let pollWakeEnabled = true;

function fail(p, errno) {
  reply(p, -errno, -1);
}

function intr(p) {
  intrCount += 1;
  reply(p, -EINTR, -1, ST_INTR);
}

/** Calls answered by their own handler's side effect — see `finish`. */
let answeredDuringCall = 0;

/** M4b's third control. With it off, a call whose handler's side effect already answered it is
 *  answered a SECOND time — the double-reply class, restored. */
let finishGuardEnabled = true;

/** A handler's numeric return, in docs/ABI.md's single-register convention. `p.rlen` and `p.r1` are
 *  the two scratch words a handler may set, cleared at every dispatch so one that sets neither
 *  cannot publish the previous call's. Routing the replies that are not one integer through them
 *  keeps reply() the single writer of SEQ, STATUS and RLEN. */
function finish(p, r) {
  // THE HANDLER'S OWN SIDE EFFECT MAY HAVE ANSWERED THIS CALL ALREADY: a pty operation signals the
  // foreground group, which usually contains the caller. Replying again would be two SEQ bumps and
  // two G_INFLIGHT decrements, breaking the issued == replied identity `check_syscall` asserts.
  if (finishGuardEnabled && p.inflight === null) {
    answeredDuringCall += 1;
    return;
  }
  /* THE I/O COUNTERS, HERE AND NOT IN THE HANDLERS. A `read` answers with the number of bytes it
   * moved, so the return value IS the measurement — and this is the one funnel every answered call
   * passes through, which is the same argument the `pollWakeAll` below is hooked here for: a new
   * read-shaped call cannot forget to account itself.
   *
   * A NEGATIVE RETURN IS AN ERRNO AND NOT A COUNT, so only a non-negative one is added; an
   * `EAGAIN` would otherwise subtract eleven bytes from a process's total. */
  if (r >= 0 && p.inflight) {
    const nr = p.inflight.nr;
    if (nr === SYS_read || nr === SYS_pread) p.readBytes += r;
    else if (nr === SYS_write || nr === SYS_pwrite) p.writeBytes += r;
  }
  if (r < 0) reply(p, r, -1);
  else reply(p, r, p.r1 | 0, ST_RETURN, p.rlen | 0);
}

/** A reply for a call already answered is dropped and counted: docs/ABI.md decision 1's
 *  cancellation path, which M1's kill needs. */
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

/** The I/O worker surface. One outstanding-request map keyed by a sequence the worker echoes, so
 *  answers can arrive out of order. Kernel-side in the sense constraint 15 requires: the port lives
 *  here, and what a process gets back is an integer fd. */
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
    // A blob that would not delete is a leak, not a corruption: surfaced under its own name.
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
        // THE ENVELOPE WINS OVER THE BODY. `t` and `seq` are the transport's own fields; a body
        // carrying either would overwrite the correlation id, `pending.get` would miss and the
        // promise would NEVER SETTLE — a syscall parked forever, a mount timing out with no error.
        worker.postMessage({ ...body, t, seq: s });
      });
    },
    // No reply expected, so a notification cannot queue behind a request (constraint 57).
    boot() { worker.postMessage({ t: "boot" }); },
    /** The boot handshake, awaited. A `booted` that has not landed is a worker that has not
     *  answered yet, not one with no OPFS; mounting on the difference reads a populated volume
     *  as fresh. */
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

/** The same completion contract for work that is awaited rather than timed: run `job()` off the
 *  dispatch path and answer when it settles, dropping it if the call is gone (constraint 57). */
function later(p, job) {
  const seqAtDispatch = p.inflight.seq;
  // Captured here: `finish` nulls `inflight`, so a later rejection could not name the call.
  const nrAtDispatch = p.inflight.nr;
  Promise.resolve()
    .then(job)
    .then(
      (r) => {
        if (!p.ctl || p.seq !== seqAtDispatch) { lateReply += 1; return; }
        finish(p, r);
      },
      (reason) => {
        // THE REASON IS NAMED, COUNTED, AND ONLY THEN TURNED INTO AN ERRNO: inventing an errno for
        // "the kernel threw" would put a kernel defect in the ABI. Counted BEFORE the identity
        // check, so a process reaped while its write was in flight still counts.
        asyncFail += 1;
        noteOut(`pid ${p.pid} call ${nrAtDispatch} threw inside its async body: `
          + `${(reason && (reason.stack || reason.message)) || String(reason)}`);
        if (!p.ctl || p.seq !== seqAtDispatch) { lateReply += 1; return; }
        fail(p, EIO);
      },
    );
}


function onSyscall(p, posted) {
  const depth = Atomics.load(g, G_INFLIGHT);   // the arrival backlog, BEFORE any work
  const tIn = now();
  // ACQUIRE, matching the process's Atomics.store of CALLID: it is what makes its plain stores to
  // NR, a0..a7 and the byte region visible here.
  const callid = Atomics.load(p.ctl, CALLID);
  // Two sources for one value, so a process that posts before storing its registers, posts twice,
  // or posts a number it did not write is caught at the door.
  if (posted !== callid) {
    badCallId += 1;
    fail(p, EINVAL);
    return;
  }
  const nr = p.ctl[NR];
  // Constraint 16, in the measured path.
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
  // One atomic load at dispatch entry, so no ramp-down sample enters the window histogram.
  if (Atomics.load(g, G_WINDOW) === W_OPEN) depthTarget[bucket] += 1;
  p.calls += 1;
  p.inflight = { nr, callid, seq: p.seq, abort: null, t: tIn };
  if (trace) trace.put(TR_ENTER, p.pid, nr, callid, p.ctl[A0] | 0, p.ctl[A1] | 0, tIn);
  p.rlen = 0;
  p.r1 = 0;
  const r = h(p);
  if (r !== PENDING) finish(p, r);
  const spent = now() - tIn;
  kServiceMs += spent;
  // PER PROCESS AS WELL AS GLOBALLY: the same measurement, attributed. See `Slot.serviceMs`.
  p.serviceMs += spent;
  kCalls += 1;
}

/** The same dispatcher without the depth sample, chosen at boot, so the two variants differ by
 *  zero per-call branches. */
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
  if (trace) trace.put(TR_ENTER, p.pid, nr, callid, p.ctl[A0] | 0, p.ctl[A1] | 0, tIn);
  p.rlen = 0;
  p.r1 = 0;
  const r = h(p);
  if (r !== PENDING) finish(p, r);
  const spent = now() - tIn;
  kServiceMs += spent;
  // PER PROCESS AS WELL AS GLOBALLY: the same measurement, attributed. See `Slot.serviceMs`.
  p.serviceMs += spent;
  kCalls += 1;
}

/** The M1 negative control: no SIGPEND check at syscall entry, so Ctrl-C must stop working. A whole
 *  variant rather than a branch, so the headline path carries no control branch. */
function onSyscallNoSigpend(p, posted) {
  const tIn = now();
  const callid = Atomics.load(p.ctl, CALLID);
  if (posted !== callid) {
    badCallId += 1;
    fail(p, EINVAL);
    return;
  }
  const nr = p.ctl[NR];
  // No SIGPEND check here, which is the one line the control removes.
  const h = CALLS[nr];
  if (h === undefined) {
    fail(p, ENOSYS);
    return;
  }
  p.calls += 1;
  p.inflight = { nr, callid, seq: p.seq, abort: null, t: tIn };
  if (trace) trace.put(TR_ENTER, p.pid, nr, callid, p.ctl[A0] | 0, p.ctl[A1] | 0, tIn);
  p.rlen = 0;
  p.r1 = 0;
  const r = h(p);
  if (r !== PENDING) finish(p, r);
  const spent = now() - tIn;
  kServiceMs += spent;
  // PER PROCESS AS WELL AS GLOBALLY: the same measurement, attributed. See `Slot.serviceMs`.
  p.serviceMs += spent;
  kCalls += 1;
}

let dispatch = onSyscall;


/**
 * THE SUPERVISOR'S PROGRAM LOADER. A PROCESS NEVER REACHES THIS: `SYS_spawn` resolves a program
 * path through the mount table (src/kernel/exec.mjs) and never touches the network. What is left
 * serves the PAGE's own `t: "spawn"`, and the kernel fetches rather than each process because
 * constraint 41 deletes `fetch` from the process realm (constraint 19 also prices this path).
 *
 * The image is a Blob URL, built once per program. A blob URL has an opaque path, so a specifier
 * inside the image cannot be resolved against it; the loader rewrites each to the SAME absolute URL
 * `src/libos/process.mjs` already resolved, so it comes out of the process's module map.
 */
const images = new Map();
let programFetches = 0;
/** Program fetches abandoned on the deadline below, and the retries after them. A check asserts
 *  both are 0 in a healthy run, so the bound cannot quietly become the normal path. */
let programFetchTimeouts = 0;
/** TRANSPORT FAILURES, counted apart from deadlines because they have a different cause and a
 *  different fix. Measured on this machine: `www/m7.html` boots five kernels and takes ~75 ranged
 *  GETs plus four program fetches through one local server in 17 s, and about one run in three
 *  lost ONE of those fetches to `TypeError: Failed to fetch` — a refused or reset connection, not
 *  a timeout and not a 404. Constraint 210. */
let programFetchTransport = 0;
let programFetchRetries = 0;

/** HOW LONG A PROGRAM FETCH MAY TAKE. `spawn` cannot answer until the program is loaded, so an
 *  unbounded fetch makes process creation HANG rather than fail, with no errno and nothing in the
 *  trace. 5 s is ~15x the worst boot seen under contention (`bench/kernel-churn/probe.py`). */
const PROGRAM_FETCH_MS = 5000;
const PROGRAM_FETCH_TRIES = 2;

/** How long to wait before the retry. AN IMMEDIATE RETRY HITS THE SAME CONDITION, and that was
 *  measured: a page taking ~75 ranged GETs through one local server lost both attempts at a
 *  program fetch to a refused connection in the same instant, and the kernel panicked anyway.
 *  60 ms is long enough for a listen queue to drain and short enough that a spawn still answers
 *  well inside `PROGRAM_FETCH_MS`. Constraint 212. */
const PROGRAM_RETRY_BACKOFF_MS = 60;

/** A STATIC import or `export ... from` specifier, and only a path-shaped one: a bare specifier has
 *  no resolution in a worker without an import map. The quote must follow `from` or `import`
 *  directly, which keeps prose out of the match. */
const STATIC_SPECIFIER = /(\bfrom\s*|\bimport\s*)(["'])(\.{0,2}\/[^"']*)\2/g;

/** Fetch a program's text under the deadline above, retried once. `AbortController` rather than a
 *  racing timer: a racing promise leaves the original request outstanding, still holding the
 *  connection being guarded against. */
async function programText(url) {
  let last = null;
  for (let attempt = 0; attempt < PROGRAM_FETCH_TRIES; attempt += 1) {
    if (attempt > 0) {
      programFetchRetries += 1;
      await new Promise((resolve) => setTimeout(resolve, PROGRAM_RETRY_BACKOFF_MS));
    }
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), PROGRAM_FETCH_MS);
    try {
      const response = await fetch(url, { cache: "no-store", signal: control.signal });
      programFetches += 1;
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      // THE BODY IS UNDER THE SAME DEADLINE as the headers: a body that never arrives is the same
      // hang.
      const text = await response.text();
      clearTimeout(timer);
      return text;
    } catch (error) {
      clearTimeout(timer);
      /* TWO RETRYABLE FAILURES AND ONE THAT IS NOT, and the split is by CAUSE rather than by
       * convenience:
       *
       *   an abort           this deadline firing. Retried, as it always was.
       *   a TypeError        the TRANSPORT failed — a refused or reset connection. `fetch` reports
       *                      every network-level failure as `TypeError: Failed to fetch`, with no
       *                      status, and it is the class one retry actually fixes. It was NOT
       *                      retried, and a page that boots five kernels in seventeen seconds hit
       *                      it about one run in three: the kernel PANICKED and the page reported
       *                      `timed out waiting for spawned` with nothing naming the cause
       *                      (constraint 212).
       *   anything else      an HTTP status, which `response.ok` above raises as a plain Error. A
       *                      404 is not worth retrying and never was.
       */
      if (control.signal.aborted) {
        programFetchTimeouts += 1;
        last = new Error(
          `program fetch for ${url} did not complete within ${PROGRAM_FETCH_MS} ms`);
        continue;
      }
      if (error instanceof TypeError) {
        programFetchTransport += 1;
        last = new Error(`program fetch for ${url} failed at the transport: ${error.message}`);
        continue;
      }
      throw error;
    }
  }
  throw last;
}

async function programImage(programUrl) {
  const cached = images.get(programUrl);
  if (cached) return cached;
  const url = new URL(programUrl, self.location.href).href;
  const text = await programText(url);
  let resolved = 0;
  const linked = text.replace(STATIC_SPECIFIER, (all, lead, quote, specifier) => {
    resolved += 1;
    return `${lead}${quote}${new URL(specifier, url).href}${quote}`;
  });
  // Not revoked: the image is live as long as any process may import it, and the kernel's own
  // lifetime is that bound.
  const image = {
    url,
    imageUrl: URL.createObjectURL(new Blob([linked], { type: "text/javascript" })),
    bytes: text.length,
    resolved,
  };
  images.set(programUrl, image);
  return image;
}


const results = [];
/** How many processes the last `go` was addressed to. `results` is posted when that many have
 *  answered and not when the live count has: a kernel that lost a process would otherwise wait out
 *  its timeout for a result nobody is going to send. */
let goCount = 0;

/** Two phase, forced by measurement. Phase 1 allocates and posts; phase 2 is the process's own
 *  {t:"ready"}, and the kernel returns to its event loop between them because it never blocks: a
 *  worker that creates a nested worker and then parks starves it, measured as a park on the child's
 *  ready word never seeing the flag set, 4/4 runs (tmp/m0-probe-nested, Chrome 157.0.8103.52). */
function spawn(image, programCfg, index = 0, parent = null) {
  const slot = table.alloc();
  if (typeof slot === "number") return slot;   // -EAGAIN, the hard cap (constraint 17)

  // WHAT A CHILD INHERITS. The pgid and sid come from the PARENT and never from the caller's
  // request, which is what lets `kill(-pgid)` reach a whole pipeline.
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
  // What `/proc/<pid>/cmdline` reports: the caller's argv, or the image URL for a page spawn.
  slot.cmdline = programCfg.cmdline !== undefined
    ? String(programCfg.cmdline)
    : ((image && image.url) || "");
  // THE PROCESS'S IDENTITY, set at spawn and read per call by every path syscall (constraint 29).
  if (programCfg.uid !== undefined) slot.uid = programCfg.uid | 0;
  if (programCfg.gid !== undefined) slot.gid = programCfg.gid | 0;
  slot.ctl[UID] = slot.uid;
  // The frame header magic+version: the libos reads it once at init and panics on mismatch.
  slot.ctl[H_MAGIC] = SAB_MAGIC | 0;
  slot.ctl[H_VERSION] = SAB_VERSION | 0;

  // The I/O worker reads write payloads straight out of this SAB, so a write is three integers and
  // no copy. Safe because the calling process is parked in Atomics.wait until the kernel bumps its
  // SEQ, which it does not do until the I/O worker has answered. Constraint 15 still holds.
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
  /** A PROCESS WORKER'S ERROR IS THAT PROCESS'S FAULT, NOT THE KERNEL'S PANIC. `panic` would tell
   *  every live process the kernel is dead, and a program is process-supplied text:
   *  `setTimeout(() => { throw 0 })` is enough. The libos cancels the error event, so this is
   *  reached only for an error the process could not catch. */
  slot.worker.onerror = (e) => {
    const why = `process ${slot.pid} runtime: ${e.message || e.type || "worker error"}`;
    faults.push({ pid: slot.pid, why });
    post({ t: "fault", pid: slot.pid, why });
    // Through `reap`, never by assigning ZOMBIE: see the `fault` arm below.
    if (table.get(slot.pid)) reap(slot, STAT_KILLED, SIGABRT);
  };
  slot.worker.postMessage(
    {
      t: "init",
      sab: slot.sab,
      globals,
      port: channel.port2,
      pid: slot.pid,
      uid: slot.uid,
      image: image.imageUrl,
      // The M1 and M6 negative controls travel to the process, because what each removes lives in
      // the process's own realm (constraints 16, 41, 53). Both come off the BOOT cfg and not the
      // spawn's, so a process cannot ask for either on its own behalf.
      cfg: { ...programCfg, index, noSigpend: !!cfg.noSigpend, noLockdown: !!cfg.noLockdown },
    },
    [channel.port2],
  );
  return slot.pid;
}

/** One program load, then `count` processes against the one image. The load is reported with the
 *  batch — url, bytes, specifiers resolved, network fetches — because "the program crossed the wire
 *  once" is the invariant the herd broke. */
async function spawnBatch(m) {
  const image = await programImage(m.programUrl);
  const pids = [];
  // G_READY IS CUMULATIVE, so the target is absolute: a second batch against one kernel otherwise
  // finds the counter past its own count and reports ready before the new processes exist.
  const already = Atomics.load(g, G_READY);
  // The ordinal in pids-ever-allocated terms, which names the process count the cap stopped at.
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
      // THE RETRIES TRAVEL WITH THE ANSWER, so a spawn that SUCCEEDED can still show what it
      // took: `bench/kernel-churn/probe.py --drop` asserts a non-zero `transport` here, which is
      // the only direct evidence that the retry in `programText` did anything (constraint 212).
      retries: programFetchRetries, timeouts: programFetchTimeouts,
      transport: programFetchTransport,
    },
    why: refused ? capRefusedWhy(refusedAt, refused, pids.length) : "",
  });
  // Nothing to wait for. A process the cap refused cannot increment G_READY, so awaitReady would
  // spend its timeout and report starvation where the kernel behaved as constraint 17 specifies.
  if (refused) return;
  if (cfg.spawnThenPark) {
    // A busy-spin, not a park, so the no-parking lint over this directory still holds. It never
    // yields, so the child's ready message is never processed: the same mechanism.
    const want = already + m.count;
    const until = now() + (m.parkMs || 10000);
    while (now() < until && Atomics.load(g, G_READY) < want) { /* starve the children */ }
    const ready = Atomics.load(g, G_READY);
    post({ t: "ready", ready, want, starved: ready < want,
      why: starvedWhy(ready, want, m.parkMs || 10000) });
    return;
  }
  // THIS BATCH'S PIDS, so another batch's child cannot answer for them. `already` is still read
  // above for `cfg.spawnThenPark`, whose control is about the cumulative counter itself.
  awaitReady(pids, m.readyTimeoutMs || 10000);
}

function onProcessMessage(slot, m) {
  if (m.t === "ready") {
    slot.state = RUNNING;
    if (m.abiFingerprint !== ABI_FINGERPRINT) {
      panic(`pid ${slot.pid} ABI fingerprint ${m.abiFingerprint} != ${ABI_FINGERPRINT}`);
      return;
    }
    Atomics.add(g, G_READY, 1);
    // A child created by SYS_spawn runs itself, on the `go` spawnChild armed and this fires.
    if (slot.pendingGo) {
      const go = slot.pendingGo;
      slot.pendingGo = null;
      slot.port.postMessage({ t: "go", ...go });
    }
    return;
  }
  if (m.t === "result") {
    // A PROCESS-SPAWNED CHILD EXITS; it does not join the page's result batch, which accounts for
    // a `go` the PAGE issued and would fire early. Reaping it is what gives `waitpid` its status.
    if (slot.ppid) {
      const code = (m.data && Number.isInteger(m.data.exit)) ? m.data.exit : 0;
      reap(slot, STAT_EXITED, code);
      return;
    }
    const sink = slot.fds.get(1);
    // THE KERNEL'S OWN FIELDS GO LAST, so a program cannot forge them: bench/m3-fs/program.mjs
    // returns a field called `pid` of its own.
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
    // Reported the instant it arrives: otherwise the page waits out a two-minute timeout for
    // `results` that can never complete, with `dropped 1` as the only trace.
    const fault = { pid: slot.pid, why: String(m.why) };
    faults.push(fault);
    // THROUGH `reap`, not by setting ZOMBIE here: that leaves `exitKind` at -1, so a parent's
    // `waitpid` gets a status meaning neither exited nor killed, and teardown never runs, leaving a
    // pipeline peer parked on an EOF that cannot arrive (constraint 92).
    reap(slot, STAT_KILLED, SIGABRT);
    post({ t: "fault", ...fault, kernel: kstats() });
    return;
  }
  dropped += 1;
  post({ t: "error", why: `pid ${slot.pid} sent an unhandled message kind ${m && m.t}` });
}

// The kernel owns the barrier release, because it is the only agent that can report a barrier that
// did not close. Both phases are polled on its own event loop, outside the measured window.

const BARRIER_POLL_MS = 2;

let barrier = null;

function barrierState() {
  return barrier ? { ...barrier } : null;
}

/** @param want       processes that must arrive before the window opens — every spawned process
 *  @param saturateAt calls outstanding at once before the depth histogram starts. That is N, not
 *                    `want`: the heartbeat observer never issues a syscall. */
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
    // ONE deadline for the cell, in the one clock every agent in this renderer shares:
    // performance.now() instants are not comparable across agents.
    const deadline = Date.now() + windowMs;
    const [lo, hi] = packI64(deadline);
    Atomics.store(g, G_DEADLINE_LO, lo);
    Atomics.store(g, G_DEADLINE_HI, hi);
    barrier.deadlineWall = deadline;
    barrier.releasedWall = Date.now();
    barrier.goToReleaseMs = barrier.releasedWall - barrier.armedWall;
    barrier.phase = "open";
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

/** Poll G_BARRIER for `target` arrivals, then run `then`. A barrier that does not close makes the
 *  cell INVALID and must never be read as latency. */
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
  // The not-responding detector rides this timer rather than keeping its own.
  windowSample();
  dragSample();
}

/** M10. A drag session whose pointer has stopped reporting is cancelled, and the cancellation is
 *  REPORTED: one live session refuses the next with -EBUSY, so a stuck one would refuse every drag
 *  for the life of the kernel. It rides the heartbeat for the reason the detector does — a timer
 *  per session is a timer per gesture (constraint 244). */
function dragSample() {
  if (!DATA) return;
  const idle = DATA.tick();
  if (idle >= 0) noteOut(`a drag session was cancelled after ${idle} ms with no pointer report`);
}

/**
 * The per-heartbeat health sweep, EDGE-TRIGGERED and over the windows whose level moved only: a
 * message per window per tick is the O(N) fan-out constraint 18 forbids.
 *
 * The thresholds travel with every post rather than being pasted into the page, so the caption and
 * the detector cannot disagree about when 1,000 ms has passed.
 */
function windowSample() {
  if (!WINDOWS) return;
  for (const change of WINDOWS.sample()) {
    post({
      t: "win-health", ...change,
      notRespondingMs: NOT_RESPONDING_MS, endProcessMs: END_PROCESS_MS,
    });
  }
}

/** The complementary path to the heartbeat, and O(live) ONCE — constraint 18 forbids a per-frame
 *  O(N) sweep, not a one-shot walk of the interested set. What a panic cannot reach, a terminated
 *  kernel worker or a wedged thread, is what the heartbeat covers. */
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

/** `usr` is the load-bearing field, for the same reason `mode` is in `fsState`: an empty `/usr` and
 *  a `/usr` nobody could mount look identical from a listing, and the second negative control is
 *  exactly that confusion. */
function m3State() {
  return {
    mounted: !!mounts,
    rows: mounts
      ? mounts.rows().map((r) => ({
        path: r.path, type: r.type, dev: r.dev, readOnly: r.readOnly, durable: r.durable,
      }))
      : [],
    usr: usrReport,
    mountpoints: [...mountpointReport],
    bench: benchReport,
    exec: EXEC ? EXEC.stats() : null,
    trace: trace ? trace.stats() : null,
    tmp: mounts && mounts.at("/tmp")
      ? { bytes: mounts.at("/tmp").fs.bytes, limit: mounts.at("/tmp").fs.limit }
      : null,
  };
}

/** `mode` is the load-bearing field: a kernel that mounted READ-ONLY because the image failed
 *  validation must say so where a reader meets it (constraint 28). */
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
    // THE NOTE CHANNEL, AS A NUMBER: on a workload where nothing may be refused this reads zero.
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
    // Both 0 in a healthy run; a non-zero timeout means `spawn` was about to hang.
    programFetches, programFetchTimeouts, programFetchTransport, programFetchRetries,
    // Published so the double-reply class stays assertable: a check can require this to equal the
    // number of signals that reached a calling process. See `finish`.
    answeredDuringCall,
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
    // The gates read depthHist, the WINDOW one; depthHistAll is the whole record beside it.
    depthHist: pairs(depthWindow),
    depthHistAll: pairs(depthAll),
    depthHistRamp: pairs(depthRamp),
    saturated: depthTarget === depthWindow,
    // The two numbers that give `saturated` its meaning. `target` is null before a barrier has
    // armed one and never Infinity, which a JSON round trip would turn into null either way.
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

const TERM_QUARANTINE_MS = 2200;

/** Answer any in-flight call for this process with -errno, through reply(), which stays the one
 *  writer of SEQ/STATUS. */
function answerInflight(slot, errno) {
  if (!slot.inflight || !slot.ctl) return 0;
  // ST_RETURN carries a numeric return; the errno convention is r0 < 0 && r1 === -1.
  reply(slot, -errno, -1, ST_RETURN);
  return 1;
}

/** Teardown. Phase 1 answers every outstanding call with -TEARDOWN_ERRNO and closes every fd,
 *  running each kind's close op; phase 2 asserts the outstanding-count is zero; the delayed phase 3
 *  in `scheduleFree` terminates the worker. */
function teardown(slot) {
  const hadInflight = answerInflight(slot, TEARDOWN_ERRNO);

  // ONE DECREMENT PER FD, not per description: `fds.add`, `fds.set` and `dup2` each raise `refs`
  // once per fd, so one description on two fds decremented once leaves `refs` at 1 forever. Walked
  // explicitly rather than through FileTable.close, which returns -EBADF on a null slot.
  for (let fd = 0; fd < slot.fds.fds.length; fd += 1) {
    const d = slot.fds.fds[fd];
    if (!d) continue;
    slot.fds.fds[fd] = null;
    if (--d.refs <= 0) {
      try {
        // A file's close commits a staged generation, so it returns a PROMISE. Teardown is
        // synchronous and cannot await it — the quarantine is what gives the commit time to land
        // (constraint 14) — but a REJECTION must be reported, not left unhandled.
        const closing = KIND_OPS[d.kind]?.close?.(d);
        if (closing && typeof closing.then === "function") {
          closing.catch((error) => noteOut(
            `pid ${slot.pid} fd ${fd} did not close cleanly at teardown: ${error && error.message}`,
          ));
        }
      } catch (e) {
        // A close op that threw must not stop teardown: the rest still have to be released.
        noteOut(`pid ${slot.pid} fd ${fd} close threw: ${e && e.message}`);
      }
    }
  }
  // Any parent parked in waitpid is answered with (child.pid, status).
  if (slot.ppid) {
    const parent = table.get(slot.ppid);
    if (parent && parent.inflight && parent.inflight.waitingFor !== undefined) {
      const waited = parent.inflight.waitingFor;
      if (waited === -1 || waited === slot.pid) {
        const status = packStatus(slot.exitKind, slot.exitValue);
        // DETACH BEFORE REPLYING, as `reapForParent` does: otherwise the child stays in `live`
        // as a ZOMBIE, and the parent's next `waitpid` is answered with the same pid again.
        detachChild(slot);
        reply(parent, slot.pid, status, ST_RETURN);
      }
    }
  }
  // A parked `poll` belongs to a call `answerInflight` has already answered, but the record lives
  // in calls.mjs — left behind it would hold a reference to a freed slot forever.
  pollForget(slot);
  // AND WAKE EVERY OTHER PARKED POLL. The fd sweep above changes readiness WITHOUT passing through
  // `reply`, where the wake is hooked (constraint 109), so a peer's polled fd becomes ready with
  // nothing to notice it. AFTER `pollForget`, so this process's records are gone first.
  if (pollPending()) pollWake(POLL_K);
  // Phase 2: assert. An inflight still non-null after `answerInflight` ran is a dispatch defect —
  // a handler that answers without going through reply(), knowable only here.
  if (slot.inflight !== null) {
    post({ t: "teardown-leak", pid: slot.pid, kind: slot.exitKind, value: slot.exitValue,
      inflight: String(slot.inflight && slot.inflight.nr) });
  }
  return { hadInflight };
}

/** Pack (kind, value) into r1: a clean exit of 0 and a kill with signum 0 would otherwise look the
 *  same. */
function packStatus(kind, value) {
  return ((kind & 0xff) << 8) | (value & 0xff);
}

/** The final step of a death: terminate the worker, keep the slot for the quarantine, then free it.
 *  TEARDOWN IS NOT REAP — the quarantine protects the pid and the SAB, never the pixels
 *  (constraint 14): reusing the pid earlier would let a stale postMessage reach another process. */
function scheduleFree(slot) {
  try { if (IO) IO.unregister(slot.pid); } catch (e) { /* unregister is best-effort */ }
  try { if (slot.worker) slot.worker.terminate(); } catch (e) { /* already gone is fine */ }
  setTimeout(() => {
    // BY SLOT IDENTITY IN THE ALLOCATION ARRAY, not by `byPid`: `detachChild` has already removed
    // the pid, so `slots[index]` would stay non-null forever with its SAB, ctl and worker
    // unreleased, and after PROC_CAP such children every `spawn` would return -EAGAIN.
    if (table && table.slots[slot.index] === slot) table.free(slot);
  }, TERM_QUARANTINE_MS);
}

/** The single entry point for a clean exit (STAT_EXITED, code) and a kill (STAT_KILLED, sig). */
function reap(slot, kind, value) {
  if (!slot || slot.state === ZOMBIE) return;
  table.recordExit(slot, kind, value);
  teardown(slot);
  scheduleFree(slot);
  post({ t: "reaped", pid: slot.pid, kind, value });
}

/** Take a reaped child out of the live set, so a second `waitpid` cannot find it again. ONE
 *  DEFINITION, because two paths answer a parent — `reapForParent` and teardown's parent-wake — and
 *  a parent waiting for two children must not get the first child's pid twice. */
function detachChild(child) {
  if (table.byPid.get(child.pid) === child) {
    table.byPid.delete(child.pid);
    table.live.delete(child);
  }
}

/** Reply directly with (pid, status): the only call that uses r1 as a value and not as the error
 *  sentinel, so it returns PENDING to stop the dispatcher overwriting r1 with finish()'s zero. */
function reapForParent(parent, child) {
  const status = packStatus(child.exitKind, child.exitValue);
  // Out of live, so a follow-up waitpid returns -ECHILD.
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

/** Raise one signal on every member of a process group: the line discipline's whole purpose.
 *  O(interested), per constraint 18. It reaches a process that is wedged and not servicing
 *  messages, because delivery is a SAB control word and not a postMessage (constraint 16). */
function signalGroup(pgid, sig) {
  if (!table || pgid <= 0) return 0;
  const members = table.pgidMembers(pgid);
  for (const member of members) raiseOne(member, sig);
  return members.length;
}

/** A timer for a parked `poll` that does NOT answer the call itself: `setTimer` replies with 0 on
 *  expiry, which is right for `clock_nanosleep` and wrong here, because a `poll` that times out
 *  must publish its `revents` first and only `calls.mjs` knows the layout. */
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

/** Record that this parent is parked on a child pid, or on any; teardown() reads `waitingFor`. The
 *  inflight object is the SAME shape every other PENDING handler uses, so a terminated parent's
 *  parked wait is torn down by answerInflight like any other. */
function parkParent(parent, askedPid) {
  parent.inflight.waitingFor = askedPid;
}

/** Raise a signal bit on the target; SIGKILL and SIGSTOP are unmaskable. A kill may address a pgid
 *  (target < 0) or self (target === pid). Returns 0 or -errno. */
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
  // SIGKILL: fatal, no mask, no handler. SIGPEND is checked at syscall entry, but a compute-bound
  // process issues none, so this is also where terminate() fires (constraint 16).
  if (sig === SIGKILL) {
    reap(slot, STAT_KILLED, SIGKILL);
    return;
  }
  // A SIGTERM with SIG_DFL and no handler is still fatal (POSIX); SIG_IGN drops at raise.
  const disp = slot.sigDisp.get(sig) ?? SIG_DFL;
  if (disp === SIG_IGN) return;
  if (disp === SIG_DFL) {
    // The POSIX default disposition, as data — see FATAL_DEFAULT.
    if (FATAL_DEFAULT.has(sig)) {
      reap(slot, STAT_KILLED, sig);
      return;
    }
  }
  // SIG_HANDLE or a non-fatal default: the bit goes in SIGPEND and the process drains at syscall
  // entry. A process parked in Atomics.wait cannot service postMessage (constraint 16).
  if (!slot.ctl) return;
  Atomics.or(slot.ctl, SIGPEND, SIG_BIT(sig));

  // AND IF A CALL IS ALREADY IN FLIGHT, INTERRUPT IT. Setting the bit alone is not delivery: a
  // process parked in a PENDING call would notice it only at the NEXT syscall entry, which for a
  // blocking read is never. docs/ABI.md decision 1 is `intr()` plus setTimer()'s seq check.
  if (slot.inflight) intr(slot);
}

/** The in-kernel spawn behind SYS_spawn. The byte region's shape is pinned in docs/ABI.md. */
function spawnChild(caller) {
  // THE CALL THAT REPLACES `fork` (constraint 20, decision D5). The request is bytes, decoded by
  // the one codec both sides import, which returns null for anything malformed rather than
  // throwing: this is process-controlled input on the kernel thread, where a throw faults it.
  const length = Atomics.load(caller.ctl, LEN_I32);
  if (length <= 0 || length > MAX_INLINE) return -EINVAL;
  const req = decodeSpawnRequest(new Uint8Array(caller.bytes.subarray(DATA_OFF, DATA_OFF + length)));
  if (!req) return -EINVAL;

  // VALIDATE THE FILE ACTIONS AGAINST THE CALLER'S TABLE BEFORE ANYTHING IS ALLOCATED: finding out
  // later means tearing down a process that should never have existed.
  for (const act of req.actions) {
    if (act.op === SPAWN_DUP2 && !caller.fds.get(act.a)) return -EBADF;
  }

  // The image load reads a file, so the call cannot answer on the dispatch thread. `later`'s seq
  // guard DROPS an answer whose caller has moved on, so the child it created must be reaped.
  const seqAtSpawn = caller.seq;
  later(caller, async () => {
    // THE PROGRAM COMES OUT OF THE FILESYSTEM, resolved against the caller's cwd and checked
    // against the caller's credential — see src/kernel/exec.mjs.
    let image;
    if (!EXEC) return -ENOEXEC;
    try {
      image = await EXEC.load(caller, req.path);
    } catch (error) {
      // A program that will not load is ENOEXEC, not EIO: the path resolved and the bytes were not
      // a program this kernel can run. NOTED, because the errno cannot tell bad from missing.
      noteOut(`spawn ${req.path}: ${(error && error.message) || error}`);
      return -ENOEXEC;
    }
    // An errno from the loader is the FILESYSTEM'S answer and travels unchanged.
    if (typeof image === "number") return image;

    /* M5'S NEGATIVE CONTROL: `spawn` returns the parent's pid, so nothing is created, the shell
     * believes it started a stage and waits on itself. AFTER THE LOADER on purpose, so every
     * refusal above still refuses, and only for a caller that was itself SPAWNED BY A PROCESS, so
     * the page's orchestrator still starts the shell and the proof is about pipelines. */
    if (cfg.spawnSelf && caller.ppid) {
      if (cfg.bench !== 1) throw new Error("spawnSelf requires bench=1");
      return caller.pid;
    }
    const childPid = spawn(
      image,
      {
        argv: req.argv,
        // An exec'd program's cmdline is its argv, NUL-joined.
        cmdline: (req.argv.length ? req.argv : [req.path]).join("\0"),
      },
      0,
      caller,
    );
    if (childPid < 0) return childPid;             // -EAGAIN, the cap
    const child = table.get(childPid);
    if (!child) return -EAGAIN;

    // FD INHERITANCE, then the actions, in posix_spawn's own order, which is what lets a shell say
    // "dup the pipe onto 1, then close the pipe fd". Inheriting over the fresh sink on fds 1 and 2
    // is correct: a child of a process with a redirected stdout gets the redirection.
    for (let fd = 0; fd < caller.fds.fds.length; fd += 1) {
      const d = caller.fds.get(fd);
      if (!d) continue;
      const existing = child.fds.get(fd);
      if (existing) {
        // Drop the sink `spawn` installed, or it leaks a refcount nothing will ever close.
        child.fds.close(fd);
      }
      d.refs += 1;
      if (child.fds.set(fd, d) < 0) {
        // Unreachable: `FileTable.add` and `dup2` refuse an fd past the ceiling. Not swallowed: a
        // refcount raised and then dropped is a description that never closes.
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
          // Unreachable: `decodeSpawnRequest` refuses an action naming an fd past OPEN_MAX.
          src.refs -= 1;
          continue;
        }
      } else {
        if (child.fds.get(act.a)) child.fds.close(act.a);
      }
    }
    // ARM THE RUN ON THE CHILD'S OWN `ready` rather than polling, so there is no window in which
    // the child could be told to run before its program exists.
    child.pendingGo = { mode: "park", argv: req.argv };
    // THE CALLER MAY BE GONE, and `later`'s seq guard would drop this answer silently, leaving a
    // child nobody holds the pid of. Checked here, where the child is still ours to undo.
    if (!caller.ctl || caller.seq !== seqAtSpawn) {
      reap(child, STAT_KILLED, SIGKILL);
      return -EINTR;
    }
    return child.pid;
  });
  return PENDING;
}


function post(m) {
  self.postMessage(m);
}

/** EVERY NOTE LEAVES THE KERNEL HERE, which is what makes the count equal to the channel. */
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
      // The OPFS root, acquired ONCE at boot: awaiting it per open would charge every caller for a
      // directory lookup, and the handle is not releasable per-process anyway (constraint 15).
      try {
        OPFS_ROOT = await navigator.storage.getDirectory();
      } catch (e) {
        OPFS_ROOT = null;
        opfsWhy = String((e && e.name) || e);
      }
      // The storage quota, asked for ONCE: the only source for the figure statfs publishes.
      try {
        QUOTA = await navigator.storage.estimate();
      } catch (e) {
        QUOTA = null;
      }
      // The I/O worker, unless the control routes storage back onto this thread (constraint 58).
      // The control is ONE OBJECT swapped at boot — src/kernel/io-inline.mjs implements the same
      // request() surface synchronously — so neither store.mjs nor files.mjs carries a branch.
      if (cfg.ioInline) {
        if (cfg.bench !== 1) throw new Error("ioInline requires bench=1");
        IO = makeInlineIo(() => OPFS_ROOT, noteOut);
        ioBooted = await IO.start();
        if (!ioBooted) ioWhy = opfsWhy || "no OPFS root";
      } else {
        IO = makeIo(new Worker(new URL("./io-worker.mjs", import.meta.url), { type: "module" }));
        IO.boot();
        // The mount below reads the superblock slots through this worker. Awaited: a mount that
        // raced its getDirectory() would read three absent slots and call a populated volume
        // fresh, the one mistake constraint 28 exists to prevent.
        await IO.ready(5000);
      }
      // Mounted BEFORE any process exists: a process's first syscall may be an open, and a
      // half-mounted filesystem has no honest answer for it.
      if (ioBooted) {
        STORE = new Store(IO, cfg, noteOut);
        STORE.quota = QUOTA;
        installStore(STORE);
        mountReport = await STORE.mount();
      } else {
        mountReport = { mountable: MOUNT_REFUSE, problems: [{ what: "opfs",
          why: `the I/O worker has no OPFS root: ${ioWhy || opfsWhy || "unknown"}` }] };
      }
      // The syscall trace ring, before the mount table because `/dev` reads it. `enforce: false`
      // is what lets M3's third negative control go below the 16 MiB floor; nothing else may.
      if (cfg.traceBytes) {
        if (cfg.bench !== 1) throw new Error("traceBytes requires bench=1");
        trace = new TraceRing(cfg.traceBytes | 0, { enforce: false });
      } else {
        trace = new TraceRing(TRACE_DEFAULT_BYTES);
      }

      // THE MOUNT TABLE, static at boot. There is no SYS_mount: a process cannot mount, which is
      // the narrowest form of docs/LEARNING-MODE.md §6's rule that `mount` must never accept a
      // caller-supplied URL. Built only when the volume mounted, so no path call answers ENOENT
      // where the store would answer -EIO.
      if (STORE && STORE.vfs) {
        mounts = new MountTable();
        mounts.add("/", {
          fs: STORE.vfs,
          type: FS_OPFS,
          // The volume's own read-only verdict (constraint 28): the write paths test this flag.
          flags: STORE.readOnly ? MNT_RO : 0,
        });
        /**
         * A MOUNTPOINT IS A REAL DIRECTORY ON THE VOLUME BENEATH IT, and it was not.
         *
         * The mount table short-circuits resolution by longest component prefix, so `/usr` worked
         * without existing anywhere — until something asked the volume underneath about it. Two
         * things did, and both are what a person types first:
         *
         *   `ls /`        the root volume has no entry for `/usr`, `/proc`, `/dev` or `/tmp`, so
         *                 the listing is EMPTY. Everything is there and nothing is visible.
         *   `cd /usr/..`  normalizes to `/`, which is the root mount — and `resolveMount` hands the
         *                 root volume the path WITH the `..` intact, deliberately, because it is
         *                 the only filesystem that resolves `..` against a real parent. So the
         *                 volume resolves `/usr/..` and answers ENOENT on `/usr`.
         *
         * Making the directory fixes both at once, which is the shape of the right fix: the mount
         * table stops being a second, invisible namespace. Done HERE and not in a fresh volume's
         * image, because a volume seeded before this change exists and constraint 28 forbids
         * reseeding it. Mode 0o555: a mountpoint is not a place to put files.
         *
         * A READ-ONLY VOLUME CANNOT BE GIVEN ONE, so the mount still happens and the gap is
         * REPORTED rather than silently tolerated (constraint 238).
         */
        mountpointReport = [];
        const mountpoints = mountpointReport;
        const ensureMountpoint = async (where) => {
          const cred = { uid: 0, gid: 0 };
          if (STORE.vfs.exists(cred, where)) {
            mountpoints.push({ path: where, made: false });
            return;
          }
          if (STORE.readOnly) {
            mountpoints.push({ path: where, made: false, why: "the volume is read-only" });
            return;
          }
          try {
            const op = STORE.vfs.mkdir(cred, where, { mode: 0o555 });
            // `freed` is stripped exactly as `metaOp` strips it: it is an instruction to the
            // store, not a field of the record, and journalling it would write a record no
            // replay understands.
            const { freed, ...record } = op || {};
            const r = op === null ? 0 : await STORE.journal(record);
            if (r >= 0 && freed) await STORE.freeInode(freed);
            mountpoints.push(r < 0
              ? { path: where, made: false, why: `journal errno ${-r}` }
              : { path: where, made: true });
          } catch (error) {
            mountpoints.push({ path: where, made: false, why: String(error && error.message) });
          }
        };
        /* THE NEGATIVE CONTROL, boot-gated on bench=1: no mountpoint is created, which is the
         * world a reader reported. The mounts still work, so what breaks is only what a person
         * sees - an empty `ls /` and a `..` that cannot be resolved out of a mount. */
        if (cfg.noMountpoints) {
          if (cfg.bench !== 1) throw new Error("noMountpoints requires bench=1");
          mountpointReport.push({ path: "*", made: false, why: "cfg.noMountpoints" });
        } else {
          for (const where of ["/proc", "/dev", "/tmp", "/usr", "/bench"]) {
            await ensureMountpoint(where);
          }
        }

        if (cfg.procCache && cfg.bench !== 1) throw new Error("procCache requires bench=1");
        const procFs = makeProcFS({
          table: () => table,
          mounts: () => mounts,
          // A getter, called per read: `/proc` is regenerated per read and never caches, and the
          // window table it reports is the live one.
          wins: () => WINDOWS,
          // M10's object table, for `/proc/dataobj`. A getter, like the two above it.
          data: () => DATA,
          // M3's first negative control. False in every real boot.
          cache: cfg.procCache === true,
        });
        const devFs = makeDevFS({ trace: () => trace });
        // setDev AFTER add, because the table assigns the number; a filesystem that chose its own
        // would be a second place uniqueness had to hold.
        procFs.setDev(mounts.add("/proc", { fs: procFs, type: FS_PROC, flags: MNT_RO }).dev);
        devFs.setDev(mounts.add("/dev", { fs: devFs, type: FS_DEV, flags: MNT_RO }).dev);

        // `/tmp`: WRITABLE, and the only mount besides the root that is. `durable: false`, so
        // `metaOp` applies an op and returns 0 without journalling — a record describing the OPFS
        // volume would be a record of an op that did not happen there.
        const tmpFs = new TmpFS({ now: () => Date.now() });
        tmpFs.setDev(mounts.add("/tmp", { fs: tmpFs, type: FS_TMPFS }).dev);

        // `/usr` ON THE PROVIDER INTERFACE. Awaited, because the mount reads its manifest over the
        // network and must refuse rather than come up empty; the refusal is RECORDED in `usrReport`
        // and the rest of the tree still boots. `usrProvider: "missing"` points it at a 404.
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
            // LOUD, and specifically not a mount: with no `/usr` row a path under it falls to the
            // root volume and answers ENOENT rather than resolving into an empty directory.
            usrReport = {
              ok: false, provider: usrId,
              code: error.code || "EIO", why: String(error.message || error),
            };
            noteOut(`/usr not mounted: ${usrReport.code} ${usrReport.why}`);
          }
        }

        // `/bench`, UNDER A BENCH BOOT ONLY, so the orchestrator programs M4 and M4b spawn by path
        // still resolve now that `SYS_spawn` loads from the filesystem: a milestone already proved
        // must not have its proof edited to keep passing.
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

      // THE EXEC LOADER. After the mount table, because a program path is resolved through it, and
      // before CALLS, because `spawnChild` is wired into the handler surface. Its buffer is under a
      // negative id, so a durable program is read through `Store.readFd` with no process region.
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

      // k.table is a getter below, so handlers see the live ProcTable.
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
        // Getters, not values: the mount table is built after this object in source order, and a
        // captured null would make every path call -EIO.
        get mounts() { return mounts; },
        get trace() { return trace; },
        setPollTimeout,
        signalGroup,
        // WHETHER A PARKED `poll` IS RE-EVALUATED AT ALL. A getter, because `no-poll-wake` arms
        // after this object is built. One flag governs BOTH places re-evaluation happens, because
        // removing only the wake leaves the timeout answering correctly 5 seconds late.
        get pollReevaluates() { return pollWakeEnabled; },
        // M7's window table, and the one post the window calls make: `win_create` and `win_set`
        // tell the page to build or change a frame. A getter for the reason the mount table is one.
        get wins() { return WINDOWS; },
        // M10's object table, a getter for the same reason.
        get data() { return DATA; },
        post,
      });
      // EVERY CONTROL HOOK BELOW IS GATED ON bench=1: a control requiring a hand edit is a control
      // nobody re-runs, and a hook a later change could leave armed is worse than either.
      if (cfg.stallUs > 0) {
        if (cfg.bench !== 1) throw new Error("stallUs requires bench=1");
        installStall(CALLS, cfg.stallUs);
      }
      if (cfg.truncateOverflow) {
        if (cfg.bench !== 1) throw new Error("truncateOverflow requires bench=1");
        installTruncateOverflow();
      }
      // The kernel operations a pipe, a pty and a window perform on a process, injected rather
      // than imported: this file imports all three, so the reverse would be a cycle.
      installPipeKernel({ reply, raise: raiseOne });
      installPtyKernel({ reply, signalGroup });
      // A window needs a wake nothing else will give: an event from the page passes through no
      // reply (constraint 160).
      WINDOWS = new WinMgr();
      installWins(WINDOWS);
      /* M10. `wins` is a GETTER for the reason the mount table is one: the window table is built
       * on the line above and a captured value would be whatever existed at install time. The
       * window manager calls back the other way through `windowGone`, so an uncollected drop is
       * released where the window's other resources are. */
      installDataKernel({ post, now, wins: () => WINDOWS });
      DATA = new DataMgr();
      installData(DATA);
      installWindowKernel({
        reply,
        post,
        now,
        pollWake: () => pollWakeAll(),
        windowGone: (id) => DATA.windowGone(id),
        /* M14. WHICH PROGRAM A PID IS RUNNING, for the shell. A Superbar groups its buttons by
         * program — two terminals are one button with two windows — and the page has no way to
         * learn that: it sees a pid and a title, and a title is whatever the program says it is.
         * The kernel already records argv for `/proc/<pid>/cmdline`, so this is a read of a fact
         * it holds rather than a new one, and it is the ARGV HEAD because that is the name a user
         * typed. Injected like `windowGone`, because `wins.mjs` must not import the table. */
        progOf: (pid) => {
          const slot = table.get(pid);
          if (!slot) return "";
          return String(slot.cmdline || "").split("\0")[0] || "";
        },
      });

      if (cfg.depth === false) dispatch = onSyscallNoDepth;
      // `noIsig` clears ISIG on every new pty, so Ctrl-C arrives as data. `noPollWake` stops
      // re-evaluating parked polls, so a blocked `poll` can only ever time out.
      if (cfg.noIsig) {
        if (cfg.bench !== 1) throw new Error("noIsig requires bench=1");
        setPtyDefaultIsig(false);
      }
      /* M14's control: a published item list is accepted and discarded, so a shell has nothing to
       * draw. Bench-gated like every other hook here — a PROCESS must not be able to ask for it. */
      if (cfg.noItems) {
        if (cfg.bench !== 1) throw new Error("noItems requires bench=1");
        setItemsReach(false);
      }
      if (cfg.noPollWake) {
        if (cfg.bench !== 1) throw new Error("noPollWake requires bench=1");
        pollWakeEnabled = false;
      }
      // `noWinch` leaves the resize and removes only its signal.
      if (cfg.noWinch) {
        if (cfg.bench !== 1) throw new Error("noWinch requires bench=1");
        setPtyWinch(false);
      }
      /* M7's two controls. `winFirstFd` evaluates only the FIRST fd of a poll set, which is
       * `PLAN.md` §5's control for M7 in its own words — "wake only on the first fd in the set;
       * the two-window case must hang". `noCascade` destroys a parent without its children. */
      if (cfg.winFirstFd) {
        if (cfg.bench !== 1) throw new Error("winFirstFd requires bench=1");
        setPollFirstOnly(true);
      }
      if (cfg.noCascade) {
        if (cfg.bench !== 1) throw new Error("noCascade requires bench=1");
        setCascade(false);
      }
      /* M17's control: the wheel APPENDS instead of summing into the tail. An uncoalesced stream
       * laps a 256-record ring and `push` discards the NEWEST record — the reader's latest notch —
       * so the list stops following their hand and jumps backwards on a direction change. The
       * clause it turns is the full-delta one: the offset reached on draining falls short by
       * exactly the motion that was dropped. */
      if (cfg.noWheelCoalesce) {
        if (cfg.bench !== 1) throw new Error("noWheelCoalesce requires bench=1");
        setWheelCoalesce(false);
      }
      // M8's control: a batch is accepted and counted and never reaches the page.
      benchBoot = cfg.bench === 1;
      if (cfg.noGovernor || cfg.blurTopFirst || cfg.blurStaleCosts) {
        // M12's three controls. Bench-gated together, because each of them makes the governor
        // worse in a different direction and none of them is a thing a product boot may ask for.
        if (cfg.bench !== 1) throw new Error("governor controls require bench=1");
        setGovernor({
          off: cfg.noGovernor === 1 || cfg.noGovernor === true,
          topFirst: cfg.blurTopFirst === 1 || cfg.blurTopFirst === true,
          staleCosts: cfg.blurStaleCosts === 1 || cfg.blurStaleCosts === true,
        });
      }
      if (cfg.blurBudgetPx) {
        /* M12's degrade branch, made reachable. Under the shipped ring geometry `BLUR_OFF_AT` is
         * 413 windows of 640×440 away, so nothing a check can build crosses it — and a refusal
         * path nothing can reach is a refusal path nobody has seen work. The same hook M3 uses to
         * build a 64 KiB trace ring instead of a 16 MiB one, with the same bench-boot gate, and
         * `WinMgr.blurBudget` takes the MINIMUM so this can only ever tighten the budget. */
        if (cfg.bench !== 1) throw new Error("blurBudgetPx requires bench=1");
        WINDOWS.blurBudgetPx = cfg.blurBudgetPx | 0;
      }
      if (cfg.noDraw) {
        if (cfg.bench !== 1) throw new Error("noDraw requires bench=1");
        setDrawReaches(false);
      }
      /* M9's two. `noOwnerChain` raises a window without the dialogs that ride with it, and
       * `noModal` makes nothing blocking — so a raise is granted and no input is suppressed. */
      if (cfg.noOwnerChain) {
        if (cfg.bench !== 1) throw new Error("noOwnerChain requires bench=1");
        setOwnerChain(false);
      }
      if (cfg.noModal) {
        if (cfg.bench !== 1) throw new Error("noModal requires bench=1");
        setModalBlocks(false);
      }
      /* M10's two, and they split the milestone's two gestures the way M9's pair splits its two
       * halves. `noTyped` makes every object offer TEXT and nothing else — `PLAN.md` §5's own
       * control, "offer only the text format; the image paste must fail cleanly" — and `noDrop`
       * delivers no drop at all, so the CLIPBOARD must keep working while the DRAG stops. */
      if (cfg.noTyped) {
        if (cfg.bench !== 1) throw new Error("noTyped requires bench=1");
        setTypedFormats(false);
      }
      if (cfg.noDrop) {
        if (cfg.bench !== 1) throw new Error("noDrop requires bench=1");
        setDropReaches(false);
      }
      // `ptyDetach` makes a master write accept its bytes and discard them, so only the pty stops.
      if (cfg.ptyDetach) {
        if (cfg.bench !== 1) throw new Error("ptyDetach requires bench=1");
        setPtyDetached(true);
      }
      // `noFinishGuard` lets `finish` reply to a call its handler's side effect already answered.
      // Reachable because a fresh pty's foreground group is its OPENER's.
      if (cfg.noFinishGuard) {
        if (cfg.bench !== 1) throw new Error("noFinishGuard requires bench=1");
        finishGuardEnabled = false;
      }
      // `noSigpipe` stops delivering a fatal SIGPIPE, and `yes | head -1` must then HANG: head
      // exits, the pipe loses its reader, and yes keeps writing into a pipe nobody reads.
      if (cfg.noSigpipe) {
        if (cfg.bench !== 1) throw new Error("noSigpipe requires bench=1");
        FATAL_DEFAULT.delete(SIGPIPE);
      }
      // `noLockdown` tells every process worker to SKIP the realm strip, so M6's bypass program
      // must then succeed. Gated HARD: it hands a process ambient OPFS over the kernel's volume.
      if (cfg.noLockdown && cfg.bench !== 1) throw new Error("noLockdown requires bench=1");
      // M2's negative control, both stages. `noCowOrder`: the commit drops the data-before-metadata
      // ordering, so fsck must report corruption. `noCrc`: replay and the image decoder stop
      // checking their CRCs, so a torn journal is ACCEPTED.
      if (cfg.noCowOrder && cfg.bench !== 1) throw new Error("noCowOrder requires bench=1");
      if (cfg.noCrc && cfg.bench !== 1) throw new Error("noCrc requires bench=1");
      if (cfg.noSigpend) {
        if (cfg.bench !== 1) throw new Error("noSigpend requires bench=1");
        dispatch = onSyscallNoSigpend;
      }
      setInterval(tick, HB_PERIOD_MS);
      lastTick = now();
      Atomics.store(g, G_KSTATE, K_UP);
      // The echoed cfg is how a control proves it was applied, and the mount report travels with
      // it: a kernel that came up READ-ONLY must say so at boot, not on the first write.
      post({
        t: "up", globals, abiFingerprint: ABI_FINGERPRINT, cfg,
        isolated: self.crossOriginIsolated === true,
        fs: fsState(),
      });
      return;
    }
    case "spawn":
      // This leg is async, and `handle`'s try/catch is one an unawaited promise walks past.
      spawnBatch(m).catch((error) => panic(`spawn: ${error && (error.stack || error)}`));
      return;
    case "go": {
      results.length = 0;
      // The kernel's counters are NOT reset here: running from boot keeps the accounting identity
      // (issued == dispatched == replied == returned) comparable against the processes' own
      // cumulative counters. The park controls have no window, so they take no barrier.
      if (m.go && m.go.mode !== "park") {
        const want = table.live.size;
        armBarrier(want, want - (m.go.roleOf >= 0 ? 1 : 0), m.go.windowMs | 0,
          m.go.barrierTimeoutMs || 60000);
      }
      // `go.pid` addresses ONE process: a page driving several programs cannot broadcast.
      const targets = [...table.live].filter((p) => !m.go || !m.go.pid || p.pid === m.go.pid);
      goCount = targets.length;
      for (const p of targets) p.port.postMessage({ t: "go", ...m.go });
      return;
    }
    case "raise": {
      const p = table.get(m.pid);
      if (!p) return;
      // Through the one raise path: flipping the bit here would silently drop SIGKILL.
      raiseOne(p, m.sig | 0);
      return;
    }
    case "end-process": {
      const p = table.get(m.pid);
      if (!p) return;
      reap(p, STAT_KILLED, SIGKILL);
      return;
    }
    case "shutdown": {
      /* EVERY LIVE PROCESS, REAPED, BEFORE THE PAGE TERMINATES THIS KERNEL. Terminating the kernel
       * worker alone ORPHANS every process worker it created: nested workers are collected
       * eventually, not promptly. IT IS NOT THE REMEDY for www/m4b.html's `timed out waiting for
       * spawned`, which still reports BROKEN with the sweep and without it (constraint 121). The
       * list is copied first because `reap` mutates `table.live`. */
      const live = [...table.live];
      for (const slot of live) {
        try {
          reap(slot, STAT_KILLED, SIGKILL);
        } catch (e) {
          // One slot that will not die must not strand the rest.
          noteOut(`pid ${slot.pid} did not reap at shutdown: ${e && e.message}`);
        }
      }
      post({ t: "shutdown", reaped: live.length, kernel: kstats() });
      return;
    }
    case "expose":
      // The SABs, shared and not transferred, for the one observation that has to outlive this
      // worker: whether each parked process concluded the kernel was gone.
      post({ t: "exposed", procs: [...table.live].map((p) => ({ pid: p.pid, sab: p.sab })) });
      return;
    case "m4-state": {
      // Who is parked, on what, and what every pipe holds. A pipeline that stops makes no error
      // anywhere — a parked reader and a parked writer are both legitimate. Pipes are reached by
      // walking the fd tables: a pipe is alive exactly as long as a description points at it.
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
          // The syscall NAME, because a number sends the reader to the table.
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
    /* M7: the page's half of every window. THESE FOUR ARE SERVED FROM THE PAGE'S PORT AND FROM
     * NOWHERE ELSE — a process's messages arrive on its own MessagePort and go to
     * `onProcessMessage` — so a process cannot forge a keystroke into another process's window or
     * destroy a frame it does not hold.
     *
     * There is no `win-attach`: a window is created BY A PROCESS, through `win_create`, which is
     * the whole of what M7 changed. The page builds a frame when the kernel tells it to. */
    case "win-in":
    case "win-geom":
    case "win-gone":
    case "win-raise":
    case "win-state":
    /* M10's two page reports and its one query. THEY ARE THE PAGE'S AND NOBODY ELSE'S, for the
     * reason the four above are: a process's messages arrive on its own MessagePort, so a process
     * cannot report a drop over another process's window. What the page sends is WHERE THE POINTER
     * IS; which window may receive a drop is the kernel's (constraint 243). */
    case "drag-at":
    case "drag-drop":
    case "data-state":
    /* M12's two, and they belong here for exactly the reason the others do. `WinHost`'s
     * constructor posts `win-dpr` unconditionally, so a page that built a host before awaiting
     * `up` would dereference `WINDOWS.dprSq` and panic the kernel instead of being told what it
     * did wrong. Every page here happens to construct the host after boot, which made it latent
     * rather than absent — and `win-blur-budget` was protected only incidentally, by its own
     * bench check. */
    case "win-dpr":
    case "win-blur-budget":
    /* M14's two page reports, and they belong here for the reason every one above does: a
     * process's messages arrive on its own MessagePort, so a process cannot minimize another
     * process's window or claim one of its rows was clicked. What the page sends is WHAT THE USER
     * DID — a taskbar button, an icon, a jump-list row — and the kernel decides what it means. */
    case "win-show-ask":
    case "win-item-ask":
      /* THE ONE GUARD FOR ALL FOUR. `WINDOWS` is built in the `boot` case, and `handle()` turns a
       * throw into a `panic` — so a page that posted any of these before awaiting `up` killed the
       * kernel with a TypeError instead of being told what it did wrong. The console these
       * replaced guarded the same way, and `windowSample()` still does. */
      if (!WINDOWS) {
        post({ t: "error", why: `${m.t} before boot: this kernel has no window table yet` });
        return;
      }
      break;
    default:
      break;
  }
  switch (m.t) {
    case "win-in": {
      // One message may carry several events: a paste is many keys, and a post per event would
      // cost a structured clone each.
      const evs = Array.isArray(m.evs) ? m.evs : [];
      let queued = 0;
      for (const ev of evs) if (WINDOWS.feed(m.win | 0, ev)) queued += 1;
      const fedWin = WINDOWS.get(m.win | 0);
      // `queued` against `offered` is how the page learns an event was DROPPED: silent input loss
      // cannot be diagnosed by a user (constraint 160's lesson, kept).
      post({
        t: "win-fed", win: m.win | 0, offered: evs.length, queued,
        window: fedWin ? fedWin.report() : null,
      });
      return;
    }
    case "win-geom": {
      /* THE RATIO TRAVELS WITH THE BOX, AND IT HAS TO BE CONSUMED HERE. `WinHost.#report` reads
       * `devicePixelRatio` per report rather than once per host — a window dragged to a second
       * display changes it — and scales the box it sends by exactly that value. Storing the box
       * and dropping the ratio stamps a dpr-3 box with the boot dpr, so a program computes its CSS
       * size 1.5x too large and draws every constant at the wrong scale: the defect class M16
       * exists to remove. `setDpr` refuses a ratio the 16.16 field cannot carry, so a bad one is
       * counted rather than silently believed. Finding 3 of the M16 review. */
      if (m.dpr > 0) WINDOWS.setDpr(m.dpr);
      const geomWin = WINDOWS.get(m.win | 0);
      /* A GEOMETRY FOR A WINDOW THAT IS GONE IS A RACE, NOT AN ERROR, and it was reported as one.
       * The page builds a frame when the kernel tells it to and reports the box it settled on —
       * but a process can create and destroy a window while those two messages are still in the
       * page's queue, so the report arrives about a window the kernel has already forgotten.
       * Measured: a program that created and destroyed eighteen windows produced four
       * `win-geom for unknown window N` errors and turned a green check red.
       *
       * COUNTED AND NOT SILENT: a page reporting geometry for windows that never existed would be
       * a defect, and the count is what tells the two apart. */
      if (!geomWin) { lateGeoms += 1; return; }
      geomWin.setBox(m);
      /* M12: A REPORTED BOX IS AN AREA-CHANGING EVENT, and it is the one that carries maximize,
       * snap, restore and a plain drag-resize — every one of them reaches the kernel as the page
       * reporting the geometry it settled on. Constraint 49 names those events and forbids a drag
       * HOOK, which is exactly why the governor hangs off the report rather than off a gesture:
       * there is one place a box becomes real, and this is it. */
      WINDOWS.governBlur("geom");
      post({ t: "win-geom", win: geomWin.id, window: geomWin.report() });
      return;
    }
    case "win-gone":
      /* The frame is gone — the page tore it down. NOT THE X BUTTON ANY MORE: M9 made a close a
       * REQUEST the process may refuse (constraint 44), so the X posts `win-in [WEV_CLOSE]` and
       * nothing else. What still arrives here is a page shutting a session down, which is a frame
       * that really has gone. Same cascade as `win_destroy`, because a child whose parent's frame
       * went has no frame either. */
      post({ t: "win-destroy", ids: WINDOWS.detach(m.win | 0), why: "page" });
      return;
    case "win-raise": {
      /* A USER CLICKED A WINDOW, and the KERNEL decides whether it comes up: it is the only side
       * that knows what a modal is blocking (constraint 226). The page is told the whole new order
       * either way — `win-stack` on a grant, `win-blocked` on a refusal — so it never has to guess.
       *
       * A raise for a window that is gone is a RACE and not an error, for the reason `win-geom`'s
       * is: the click and the destroy can cross in the page's own queue. */
      const toRaise = WINDOWS.get(m.win | 0);
      // ITS OWN COUNTER. `lateGeoms` is published as the number that tells a page reporting
      // geometry for windows that never existed from a benign race, and a click crossing a destroy
      // is a different race: one counter for two facts cannot answer either (constraint 235).
      if (!toRaise || toRaise.destroyed) { lateRaises += 1; return; }
      WINDOWS.raise(toRaise);
      return;
    }
    case "win-show-ask": {
      /* THE SHELL ASKS AND THE KERNEL DECIDES, which is `win-raise`'s division applied to the
       * other thing a taskbar button does. The page is the side that knows a button was clicked;
       * the kernel is the side that owns the state, the restore point and the blurred area the
       * change alters (constraints 49, 226, 271).
       *
       * A WINDOW THAT HAS GONE IS A RACE AND NOT AN ERROR, for `win-geom`'s measured reason: a
       * click and a destroy cross in the page's own queue. Counted with the raises, because it is
       * the same race on the same route. */
      const showWin = WINDOWS.get(m.win | 0);
      if (!showWin || showWin.destroyed) { lateRaises += 1; return; }
      WINDOWS.setState(showWin, m.state | 0);
      return;
    }
    case "win-item-ask": {
      /* A ROW WAS ACTIVATED. The INDEX is validated against the list the kernel holds, so a page
       * cannot name a row nothing published — and a separator or a disabled row is refused there
       * too, because the flags are the publisher's statement about its own list. */
      WINDOWS.activateItem(m.win | 0, m.index | 0, m.where | 0);
      return;
    }
    case "drag-at":
      /* ONE REPORT PER MOTION SAMPLE, AND NO ANSWER TO IT. The kernel posts `win-drag-target` when
       * the target CHANGES and nothing otherwise: a reply per sample would double the message
       * traffic of a gesture that already streams, and the page has nothing to do with an answer
       * that says what it just said (constraint 243). */
      DATA.dragAt(m.win | 0, m.x | 0, m.y | 0);
      return;
    case "drag-drop":
      // The effect comes back in `win-drag-end`, which the source's own event carries too, so
      // there is no second post here either.
      DATA.dragDrop(m.win | 0, m.x | 0, m.y | 0);
      return;
    case "data-state":
      post({ t: "data-state", data: DATA.report() });
      return;
    case "win-blur-budget":
      /* M12's degrade branch, armed at a figure the PAGE measured. Bench-gated, like the boot
       * hook it complements, and it can only ever TIGHTEN the budget — `WinMgr.blurBudget` takes
       * the minimum of this and `BLUR_OFF_AT`.
       *
       * WHY AT RUNTIME AND NOT ONLY AT BOOT. The real budget is 413 windows of 640×440 away, so a
       * check has to lower it — and to lower it to "exactly what N windows cost" it has to know
       * what a window costs, which it learns by opening one. A boot-time-only figure would have to
       * hardcode the geometry `src/bin/winopen.mjs` happens to ask for, and that is a number in a
       * second place waiting to drift. Unlike M3's trace ring, nothing is allocated from this: it
       * is a comparison, so there is no reason it must be fixed before the first window. */
      if (!benchBoot) { post({ t: "win-blur-budget", refused: "requires bench=1" }); return; }
      WINDOWS.blurBudgetPx = Math.max(0, m.px | 0);
      WINDOWS.governBlur("budget");
      post({ t: "win-blur-budget", px: WINDOWS.blurBudget() });
      return;
    case "win-dpr":
      /* M12. THE PAGE IS THE SIDE WITH THE DISPLAY, so it reports the device-pixel ratio and the
       * kernel squares it — a blur cost is an area. Same division as the terminal's cell count in
       * `win-geom`: the page measures what only the page can see, and the kernel accounts it.
       * Ignored unless it is a real ratio, because a 0 would make every cost 0 and silently
       * disarm the governor. */
      if (m.dpr > 0) WINDOWS.dprSq = m.dpr * m.dpr;
      return;
    case "win-state":
      post({
        t: "win-state",
        windows: WINDOWS.live().map((w) => w.report()),
        all: [...WINDOWS.byId.values()].map((w) => w.report()),
        wins: { ...WINDOWS.report(), lateGeoms, lateRaises },
      });
      return;
    case "trace-read":
      // The trace as TEXT, through the same renderer and limit `/dev/trace` uses, so the page and
      // a process cannot be shown two different traces.
      post({
        t: "trace-read",
        text: renderTrace(trace, { limit: m.limit > 0 ? (m.limit | 0) : TRACE_RENDER_LIMIT }),
      });
      return;
    case "stats":
      post({ t: "stats", kernel: kstats() });
      return;
    case "snapshot": {
      // Constraint 23's second flush point, driven by the page. NOT a syscall: docs/ABI.md's path
      // group lists none.
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
      // It never writes: src/fs/fsck.mjs holds no handle and no root directory.
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
      // A measurement channel, not a syscall: docs/ABI.md names no call for it.
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

/** The hard cap refusing a spawn (constraint 17), named as itself and not as starvation: children
 *  that were never created cannot report ready, so the two symptoms are identical. */
function capRefusedWhy(refusedAt, refused, asked) {
  return `spawn refused by the hard cap at process ${refusedAt}; cap is ${PROC_CAP}, `
    + `constraint 17. ${refused} of ${asked} requested spawn(s) refused; this is the cap `
    + "working as specified, not a kernel that failed to yield";
}

/** One renderer, so the busy-spin control and a genuine timeout name the failure the same way. It
 *  MUST be reported under this name and never folded into latency. */
function starvedWhy(ready, want, timeoutMs) {
  return `kernel-starved-children: ${ready}/${want} ready in ${timeoutMs} ms; the kernel did not `
    + "yield between spawn and first use";
}

/** Phase 2's completion, polled on the kernel's own event loop. Its timeout is reported under its
 *  own name and never folded into latency. */
/**
 * Wait until THIS BATCH'S OWN PROCESSES are running, and report.
 *
 * IT WAITS ON PIDS AND NOT ON A COUNTER, which is the whole point. `G_READY` is one cumulative
 * word incremented by ANY process reaching `ready` — including a child created by `SYS_spawn`,
 * which no batch asked for. So `already + count` is satisfiable by somebody else's child:
 *
 *   stage `term`, which spawns `sh` by syscall; then stage `files`. `files`'s batch samples
 *   `already`, `sh` readies, the counter hits the target, and the kernel reports a batch ready
 *   whose own worker is still inside `init` — where `program` is null. The page posts `go` and the
 *   worker faults with `TypeError: Cannot read properties of null (reading 'run')`
 *   (`src/libos/process.mjs:244`).
 *
 * THE REPORTED FAULT IS UNREPRODUCED, AND THAT IS STATED HERE RATHER THAN LEFT OUT. The sequence
 * above was reported while `www/shell.mjs` was extracted — staging `['term', 'files']` said to
 * fault, `['files', 'taskmgr', 'term']` not to — and `bench/kernel-ready/probe.py` could not
 * reproduce it. Four orders including that one, against a kernel whose wait was deliberately
 * restored to the cumulative counter (verified faithful by diffing the control's output), all came
 * up clean with no fault and every pid still in the table.
 *
 * SO THIS CHANGE RESTS ON THE ARGUMENT AND NOT ON A MEASUREMENT: a batch must wait on its own
 * processes, because a counter shared with every other process cannot distinguish "mine came up"
 * from "one more came up", and only the pids can. The absolute-vs-relative half was already fixed
 * (see `spawnBatch`'s `already`); whose readiness it is was not. That is a correctness argument
 * about the accounting, which stands whether or not the original fault was what it looked like.
 *
 * `bench/kernel-ready/probe.py` is the regression gate for what IS assertable: that no spawn order
 * leaves a pid the kernel reported ready absent from its own process table.
 *
 * `G_READY` stays: it is still the cumulative figure `cfg.spawnThenPark`'s control starves and the
 * one `starvedWhy` explains. It is simply not the batch's own answer.
 */
function awaitReady(pids, timeoutMs) {
  // A pid the cap refused is negative and never readies; `spawnBatch` returns before calling this
  // when anything was refused, so this filter is a guard and not the policy (constraint 17).
  const mine = (pids || []).filter((pid) => pid > 0);
  const want = mine.length;
  const t0 = now();
  const upNow = () => {
    let up = 0;
    for (const pid of mine) {
      const slot = table.get(pid);
      if (slot && slot.state === RUNNING) up += 1;
    }
    return up;
  };
  const check = () => {
    const ready = upNow();
    if (ready >= want) {
      post({ t: "ready", ready, want, starved: false, ms: now() - t0 });
      return;
    }
    if (now() - t0 > timeoutMs) {
      post({
        t: "ready",
        ready,
        want,
        starved: true,
        ms: now() - t0,
        why: starvedWhy(ready, want, timeoutMs),
      });
      return;
    }
    setTimeout(check, 5);
  };
  check();
}
