// The process entry point. Receives the SAB, the globals SAB and the port, closes over all three
// in MODULE SCOPE, and hands the program only {syscall, write, pid, argv, envp}.
//
// Constraint 15, enforced where a process could leak a releasable resource: nothing the program
// receives is an object with a byteLength or a postMessage, so the program holds nothing whose
// correctness depends on it running shutdown code — which is the invariant that makes
// Worker.terminate() a legal SIGKILL. The bench enumerates the keys and asserts exactly that.

import { ABI_FINGERPRINT, SIG_BIT } from "../abi.mjs";
import {
  initSyscall, syscall, write, r1of, rawWriteLength, probeNotEqual, samples, resetSamples,
  observeHeartbeat, barrierArrive, barrierDepart, barrierCounters,
} from "./syscall.mjs";

const now = () => performance.now();

let ctl = null;
let u8 = null;
let g = null;
let port = null;
let pid = 0;
let myIndex = 0;
let program = null;
let clock = null;

/**
 * The clock's quantum, measured in THIS process in THIS run: the smallest non-zero delta over n
 * reads. A quoted quantum is a different run's quantum, and the cross-agent equal-tick-rate
 * assumption is detected rather than trusted — the bench asserts every process agrees.
 *
 * The same loop yields the noise floor: an empty region timed through the same code path. Chrome
 * clamps performance.now() to 5 us BECAUSE the context is cross-origin isolated; without
 * COOP/COEP it is 100 us, at which most of a ~14 us region times as zero.
 */
function measureClock(n) {
  // Online, with no array: 200,000 Float64s per process is 1.6 MB and 205 MB across a full
  // table, and the allocation would land in the thing being measured.
  let smallest = Infinity;
  let zeros = 0;
  let total = 0;
  let worst = 0;
  const seen = new Map();
  for (let i = 0; i < n; i += 1) {
    const a = now();
    const d = now() - a;
    total += d;
    if (d === 0) zeros += 1;
    else if (d < smallest) smallest = d;
    if (d > worst) worst = d;
    if (seen.size < 64) seen.set(d, (seen.get(d) || 0) + 1);
  }
  return {
    n,
    quantumMs: Number.isFinite(smallest) ? smallest : 0,
    zeroFraction: zeros / n,
    meanMs: total / n,
    maxMs: worst,
    distinct: [...seen.entries()].sort((a, b) => a[0] - b[0]).slice(0, 8),
  };
}

function panic(why) {
  port.postMessage({ t: "fault", pid, why: String(why) });
}

self.onerror = (e) => panic(`process onerror: ${e.message ?? e}`);
self.onunhandledrejection = (e) => panic(`process rejection: ${e.reason}`);

let exiting = false;

/** M0's signal hook: count, and honour the SIGKILL bit by stopping. M1 replaces the body with
 *  handler dispatch; the seam is here so M1's negative control has something to remove. */
function onsignal(bits) {
  if (bits & SIG_BIT(9)) exiting = true;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.t === "init") {
    try {
      ctl = new Int32Array(m.sab);
      u8 = new Uint8Array(m.sab);
      g = new Int32Array(m.globals);
      port = m.port;
      pid = m.pid;
      myIndex = (m.cfg && m.cfg.index) | 0;
      clock = measureClock((m.cfg && m.cfg.clockReads) || 200000);
      initSyscall({ ctl, u8, g, port, pid, quantumMs: clock.quantumMs, onsignal });
      // The program's own commands arrive on the port, the same channel its syscalls leave by.
      port.onmessage = (e) => onCommand(e.data);
      const mod = await import(m.programUrl);
      program = mod;
      // Phase 2 of spawn. The kernel marks RUNNING on this, and it can only arrive because the
      // kernel returned to its event loop after posting init — a kernel that spawned and then
      // parked would never read it.
      port.postMessage({
        t: "ready",
        pid,
        abiFingerprint: ABI_FINGERPRINT,
        isolated: self.crossOriginIsolated === true,
        clock,
        cfg: m.cfg,
      });
    } catch (error) {
      panic(error && error.stack);
    }
    return;
  }
  panic(`unexpected kernel message ${m && m.t}`);
};

function onCommand(m) {
  if (!m || m.t !== "go") return;
  try {
    // What the program receives, and nothing else. No SAB, no port, no handle.
    const env = {
      syscall, write, r1of, rawWriteLength, probeNotEqual, samples, resetSamples,
      observeHeartbeat, barrierArrive, barrierDepart, barrierCounters,
      pid, index: myIndex, argv: m.argv || [], envp: m.envp || {},
    };
    const data = program.run(env, m);
    port.postMessage({
      t: "result",
      pid,
      data: {
        ...data,
        clock,
        abiFingerprint: ABI_FINGERPRINT,
        isolated: self.crossOriginIsolated === true,
        exiting,
        // The constraint-15 seam, as a measurement rather than an assertion: these are the keys
        // the program was handed, for the bench to assert none is a transferable object.
        envKeys: Object.keys(env),
        envKinds: Object.keys(env).map((k) => {
          const v = env[k];
          return typeof v === "object" && v !== null
            ? (v.byteLength !== undefined ? "buffer" : (v.postMessage !== undefined ? "port" : "plain"))
            : typeof v;
        }),
      },
    });
  } catch (error) {
    panic(error && error.stack);
  }
}
