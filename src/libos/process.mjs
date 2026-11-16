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
  publishProgress,
  observeHeartbeat, barrierArrive, barrierDepart, barrierCounters,
  open, close, read, pread, pwrite, readAll, fsync, ftruncate, truncate, seek,
  fstat, stat, lstat, mkdir, rmdir, unlink, chmod, chown, symlink, linkAt, rename,
  readlink, readdir, statfs, dup, dup2, chdir,
  pipe2, spawn, waitpid, kill, sigaction, setpgid, setsid, getpgid, getppid, exit,
  nanosleep,
  ptyOpen, ttyGet, ttySet, ttyWinsizeGet, ttyWinsizeSet, tcGetPgrp, tcSetPgrp, poll,
} from "./syscall.mjs";
/**
 * M5. The two libraries a program in `/usr/bin` is handed.
 *
 * IMPORTED HERE SO A PROGRAM NEVER HAS TO. A program's image is a Blob URL whose static specifiers
 * the kernel rewrites against the document (src/kernel/exec.mjs), so a module no process had
 * already imported would be fetched once PER SPAWNED PROCESS — the herd `src/kernel/kernel.mjs`
 * measured losing 6 of 480 connections to. These two are in this module's own graph, so a
 * program receives them through `env` and imports nothing, and a pipeline of three processes costs
 * no extra request at all.
 *
 * Both are function-only and hold no state, so the constraint-15 seam the bench enumerates still
 * shows nothing with a `byteLength` or a `postMessage`.
 */
import * as std from "./std.mjs";
import * as shlex from "./shlex.mjs";
/** M6. The realm strip, run before any program text is evaluated. Constraints 41 and 53. */
import { lockdown } from "./lockdown.mjs";

/**
 * M2's file API, as ONE object on `env.fs`.
 *
 * Grouped rather than spread across nineteen more keys because constraint 15's seam is asserted by
 * enumerating what a program was handed: every value here is a function, so the enumeration still
 * shows nothing with a byteLength or a postMessage, and a reader checking that claim has one
 * object to look at rather than nineteen rows.
 */
const FS = Object.freeze({
  open, close, read, pread, pwrite, readAll, write, fsync, ftruncate, truncate, seek,
  fstat, stat, lstat, mkdir, rmdir, unlink, chmod, chown, symlink, link: linkAt,
  rename, readlink, readdir, statfs, dup, dup2, chdir,
});

/**
 * M4's process and IPC calls, as ONE object on `env.proc`.
 *
 * Grouped for the reason `FS` is: constraint 15's seam is asserted by enumerating what a program
 * was handed, and every value here is a function — so the enumeration still shows nothing with a
 * byteLength or a postMessage. `spawn` + `pipe2` + `setpgid` is the whole of process creation
 * here; there is no `fork` (constraint 20).
 */
const PROC = Object.freeze({
  pipe2, spawn, waitpid, kill, sigaction, setpgid, setsid, getpgid, getppid, exit,
  nanosleep,
});

/**
 * M4b's terminal and wait calls, as ONE object on `env.tty`.
 *
 * Grouped for the reason `FS` and `PROC` are: constraint 15's seam is asserted by enumerating what
 * a program was handed, and every value here is a function.
 */
const TTY = Object.freeze({
  ptyOpen, get: ttyGet, set: ttySet,
  winsizeGet: ttyWinsizeGet, winsizeSet: ttyWinsizeSet,
  getPgrp: tcGetPgrp, setPgrp: tcSetPgrp,
  poll,
});

/**
 * M5's two libraries, frozen once at module load.
 *
 * A module namespace object is already non-writable per property, but it is not frozen and a
 * program could still add to it — and every program this worker ever runs sees the same object.
 * `Object.freeze` over a shallow copy is what makes `env.std` the same thing for the second
 * program as for the first.
 */
const STD = Object.freeze({ ...std });
const SHLEX = Object.freeze({ ...shlex });

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
 * M6's report on this realm: what was stripped, what the platform did not expose, and whether the
 * control skipped the strip. Carried in `ready` and in every result for the same reason `clock`
 * is — a property of the process worker the page cannot otherwise see, and a check that could only
 * assert "the call failed" could not tell a stripped realm from a broken one.
 */
let realm = null;
/**
 * THE PROCESS'S OWN argv, from its spawn. A process's arguments belong to the process, not to a
 * broadcast: a page driving several DIFFERENT programs against one kernel would otherwise have to
 * send one `go` per program and every process would read the last one's arguments.
 *
 * `go.argv` still wins where it is given, because M0's and M1's benches pass argv that way and a
 * change that broke them would be a change to a milestone that is already proved.
 */
let myArgv = [];

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

/**
 * A FAULT IS REPORTED AND THE EVENT IS CANCELLED. Both halves, and the second one is the fix.
 *
 * An `onerror` handler that does not cancel the event leaves the runtime to "report the exception",
 * which for a dedicated worker RE-FIRES it at the `Worker` object in the parent — and the parent
 * here is the kernel, whose `worker.onerror` used to call `panic`. So a program containing
 * `setTimeout(() => { throw new Error("x") })` took the WHOLE SYSTEM down: `G_KSTATE` went
 * K_PANIC and every live process was told through its own SAB that the kernel was dead.
 *
 * That wiring predates M5. What M5 changed is that a process now chooses its own program text, so
 * it needed no cooperation from the page. Returning true is how an `onerror` handler cancels;
 * `preventDefault` is the same thing for the rejection event, which has no return-value form.
 * The kernel's side is the other half (src/kernel/kernel.mjs): a process worker's error is that
 * PROCESS's fault and is reaped as one.
 */
self.onerror = (e) => {
  panic(`process onerror: ${e.message ?? e}`);
  return true;
};
self.onunhandledrejection = (e) => {
  panic(`process rejection: ${e.reason}`);
  if (e.preventDefault) e.preventDefault();
};

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
      myArgv = (m.cfg && m.cfg.argv) || [];
      clock = measureClock((m.cfg && m.cfg.clockReads) || 200000);
      initSyscall({ ctl, u8, g, port, pid, quantumMs: clock.quantumMs, onsignal,
        noSigpend: !!(m.cfg && m.cfg.noSigpend) });
      // The program's own commands arrive on the port, the same channel its syscalls leave by.
      port.onmessage = (e) => onCommand(e.data);
      // THE IMAGE THE KERNEL LOADED, never a path this process goes and gets. A process that
      // fetches its own program text needs a network it must not have (constraint 41 deletes
      // `fetch` and `importScripts` from this realm), and sixteen of them importing one URL at
      // once lost connections to the server about one run in five. The check on the scheme is
      // here because the alternative is that regression coming back as an intermittent fault
      // rather than as a refusal naming itself.
      if (!String(m.image).startsWith("blob:")) {
        throw new Error(`process ${pid}: program image ${m.image} is not a kernel-loaded blob`);
      }
      /**
       * M6. THE REALM IS STRIPPED HERE, and the line below is why this line is here.
       *
       * `import(m.image)` evaluates the program's module body, so anything after it is after the
       * program has already run — and a program's first statement would hold a reference to
       * whatever this was going to delete. Constraints 41 and 53.
       *
       * It throws when a binding survives, and the catch below faults the process: a realm that
       * could not be stripped must not evaluate program text (src/libos/lockdown.mjs). The
       * `noLockdown` cfg flag is M6's negative control, which the kernel refuses to pass without a
       * bench boot (src/kernel/kernel.mjs) — the same discipline as every other control hook.
       */
      realm = (m.cfg && m.cfg.noLockdown)
        ? { skipped: true, stripped: [], absent: [], remaining: [], where: {} }
        : { skipped: false, ...lockdown() };
      program = await import(m.image);
      // Phase 2 of spawn. The kernel marks RUNNING on this, and it can only arrive because the
      // kernel returned to its event loop after posting init — a kernel that spawned and then
      // parked would never read it.
      port.postMessage({
        t: "ready",
        pid,
        abiFingerprint: ABI_FINGERPRINT,
        isolated: self.crossOriginIsolated === true,
        clock,
        realm,
        cfg: m.cfg,
      });
    } catch (error) {
      panic(error && error.stack);
    }
    return;
  }
  panic(`unexpected kernel message ${m && m.t}`);
};

/**
 * A PROGRAM'S `run` MAY BE ASYNC, and this function is async because of it.
 *
 * M6 is why. Every binding constraint 41 takes away is promise-shaped — `navigator.storage`,
 * `caches`, `import(expr)` — so a program that demonstrates the hole cannot finish inside one
 * synchronous turn, and `{ ...promise }` spreads to `{}`: the result would have arrived EMPTY,
 * with nothing anywhere saying why. Awaiting a non-thenable is a no-op, so a synchronous program
 * is unaffected except for one microtask between its return and its result, which is after the
 * program has finished and inside no measurement.
 *
 * The throw still lands in the same place. `await` inside `try` carries a rejection to the catch
 * below, so a program that returns a rejected promise faults exactly as one that threw — which
 * `p_fault` in `bench/m6-realm/program.mjs` depends on, and which would silently have become "no
 * result, no fault, and a page waiting out its timeout" had this stayed synchronous.
 */
async function onCommand(m) {
  if (!m || m.t !== "go") return;
  try {
    // What the program receives, and nothing else. No SAB, no port, no handle.
    const env = {
      syscall, write, r1of, rawWriteLength, probeNotEqual, samples, resetSamples,
      observeHeartbeat, barrierArrive, barrierDepart, barrierCounters, publishProgress,
      fs: FS,
      proc: PROC,
      tty: TTY,
      // M5. Frozen, so one program cannot leave a monkey-patched helper behind for the next —
      // these are MODULE objects shared by every program this worker runs, which a per-spawn
      // object would not be.
      std: STD,
      shlex: SHLEX,
      pid, index: myIndex, argv: m.argv || myArgv, envp: m.envp || {},
    };
    const data = await program.run(env, m);
    port.postMessage({
      t: "result",
      pid,
      data: {
        ...data,
        clock,
        realm,
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
