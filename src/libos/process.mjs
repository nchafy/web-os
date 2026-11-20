// The process entry point. Receives the SAB, the globals SAB and the port, closes over all three
// in MODULE SCOPE, and hands the program only {syscall, write, pid, argv, envp}.
//
// This module runs INSIDE a process: nothing here may acquire a capability the kernel did not hand
// it. Constraint 15: nothing the program receives is an object with a byteLength or a postMessage,
// which is the invariant that makes Worker.terminate() a legal SIGKILL.

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
  winCreate, winDestroy, winSetTitle, winSetBox, winRead, winSurface, winDraw,
  winSetModal, winRaise,
  dataobjCreate, dataobjSet, dataobjGet, dataobjToClipboard, dataobjDrag, dataobjOpen,
} from "./syscall.mjs";
/** The two libraries a program in `/usr/bin` is handed, imported here so a program never has to.
 *  A module no process had already imported would be fetched once PER SPAWNED PROCESS — the herd
 *  src/kernel/kernel.mjs measured losing 6 of 480 connections to. */
import * as std from "./std.mjs";
import * as shlex from "./shlex.mjs";
/** M6. The realm strip, run before any program text is evaluated. Constraints 41 and 53. */
import { lockdown } from "./lockdown.mjs";

/** M2's file API, as one object on `env.fs`. Grouped rather than spread across nineteen more keys
 *  because constraint 15's seam is asserted by ENUMERATING what a program was handed: every value
 *  here is a function. `PROC`, `TTY`, `STD` and `SHLEX` below are grouped for the same reason. */
const FS = Object.freeze({
  open, close, read, pread, pwrite, readAll, write, fsync, ftruncate, truncate, seek,
  fstat, stat, lstat, mkdir, rmdir, unlink, chmod, chown, symlink, link: linkAt,
  rename, readlink, readdir, statfs, dup, dup2, chdir,
});

/** M4's process and IPC calls, on `env.proc`. `spawn` + `pipe2` + `setpgid` is the whole of process
 *  creation; there is no `fork` (constraint 20). */
const PROC = Object.freeze({
  pipe2, spawn, waitpid, kill, sigaction, setpgid, setsid, getpgid, getppid, exit,
  nanosleep,
});

/** M4b's terminal and wait calls, on `env.tty`. */
const TTY = Object.freeze({
  ptyOpen, get: ttyGet, set: ttySet,
  winsizeGet: ttyWinsizeGet, winsizeSet: ttyWinsizeSet,
  getPgrp: tcGetPgrp, setPgrp: tcSetPgrp,
  poll,
});

/** M7's window calls, on `env.win`. `read` is here as well as on `env.fs` because a window read
 *  returns RECORDS: the same syscall, with the one decoder (`src/abi.mjs`) attached. */
const WIN = Object.freeze({
  create: winCreate, destroy: winDestroy,
  setTitle: winSetTitle, setBox: winSetBox,
  read: winRead,
  // M8. `surface` asks the KERNEL to allocate one; `draw` sends a display list. A program is never
  // handed a canvas — see `docs/DECISIONS.md` D31 and constraint 219.
  surface: winSurface, draw: winDraw,
  // M9. The kernel owns the stack, so raising is a call and modality is enforced rather than drawn.
  setModal: winSetModal, raise: winRaise,
});

/**
 * M10's typed clipboard and drag-and-drop, on `env.data`. FIVE CALLS and one object: the clipboard
 * is `toClipboard` plus `open(DOBJ_WHERE_CLIPBOARD)`, and a drag is `drag` plus
 * `open(DOBJ_WHERE_DROP)` — the same payload published to two places (constraint 240).
 *
 * `clipboard_read`/`clipboard_write` are NOT here. They took bytes with no format tag, which left a
 * receiver unable to tell a pasted PNG from pasted UTF-8; that is the defect this group replaces.
 */
const DATA = Object.freeze({
  create: dataobjCreate, set: dataobjSet, get: dataobjGet,
  toClipboard: dataobjToClipboard, drag: dataobjDrag, open: dataobjOpen,
});

/** M5's two libraries. A module namespace object is non-writable per property but NOT frozen, so a
 *  program could add to the object every later program in this worker then sees. */
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
/** M6's report on this realm. Carried in `ready` and in every result, because a check that could
 *  only assert "the call failed" cannot tell a stripped realm from a broken one. */
let realm = null;
/** The process's own argv, from its spawn: a page driving several different programs against one
 *  kernel would otherwise have every process read the last `go`'s arguments. `go.argv` still wins
 *  where it is given, which is how M0's and M1's benches pass argv. */
let myArgv = [];

/** The clock's quantum, measured in THIS process in THIS run: the smallest non-zero delta over n
 *  reads. The same loop yields the noise floor. Chrome clamps performance.now() to 5 us BECAUSE
 *  the context is cross-origin isolated; without COOP/COEP it is 100 us, at which most of a ~14 us
 *  region times as zero. */
function measureClock(n) {
  // Online, with no array: 200,000 Float64s per process is 1.6 MB and 205 MB across a full table,
  // and the allocation would land in the thing being measured.
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

/** A fault is reported AND the event is cancelled. An uncancelled `onerror` re-fires the exception
 *  at the `Worker` object in the parent — here, the kernel — so a program whose `setTimeout` throws
 *  takes the whole system to K_PANIC. Returning true cancels; `preventDefault` is the rejection
 *  event's form, which has no return-value one. */
self.onerror = (e) => {
  panic(`process onerror: ${e.message ?? e}`);
  return true;
};
self.onunhandledrejection = (e) => {
  panic(`process rejection: ${e.reason}`);
  if (e.preventDefault) e.preventDefault();
};

let exiting = false;
/** True while a `go` is in flight. One program at a time per process; see `onCommand`. */
let running = false;

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
      port.onmessage = (e) => onCommand(e.data);
      // The image the kernel loaded, never a path this process goes and gets: fetching its own
      // program text needs a network a process must not have (constraint 41). Checked on the
      // scheme, so the regression returns as a refusal naming itself, not an intermittent fault.
      if (!String(m.image).startsWith("blob:")) {
        throw new Error(`process ${pid}: program image ${m.image} is not a kernel-loaded blob`);
      }
      /* THE REALM IS STRIPPED BEFORE ANY PROGRAM TEXT IS EVALUATED (constraints 41 and 53): the
       * `import` below evaluates the program's module body, so a strip after it runs too late.
       * `lockdown` throws when a binding survives and the catch below faults the process — a realm
       * that cannot be stripped must not evaluate program text. `noLockdown` is M6's negative
       * control, which the kernel refuses to pass without a bench boot. */
      realm = (m.cfg && m.cfg.noLockdown)
        ? { skipped: true, stripped: [], absent: [], remaining: [], where: {} }
        : { skipped: false, ...lockdown() };
      program = await import(m.image);
      // Phase 2 of spawn: the kernel marks RUNNING on this, so it only arrives once the kernel is
      // back in its event loop — one that spawned and parked never reads it.
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

/** A program's `run` may be async, and this function is async because of it: every binding
 *  constraint 41 takes away is promise-shaped, so a program that demonstrates the hole cannot
 *  finish inside one synchronous turn and `{ ...promise }` would spread to `{}`. `await` inside
 *  `try` carries a rejection to the catch below, so a rejected promise faults exactly as a throw. */
async function onCommand(m) {
  if (!m || m.t !== "go") return;
  /* One `go` at a time, and a second one is a fault (constraint 197). An async `run` suspends, so a
   * second `go` would start a concurrent run in the same realm and post a second result that the
   * kernel's `results.length >= goCount` orphans. A guard and not a queue, so a caller that breaks
   * the invariant gets a fault naming it. */
  if (running) {
    panic(`process ${pid}: a second go arrived while a program was still running. One go per `
      + "process at a time; the result of the first would have been overtaken");
    return;
  }
  running = true;
  try {
    // What the program receives, and nothing else. No SAB, no port, no handle.
    const env = {
      syscall, write, r1of, rawWriteLength, probeNotEqual, samples, resetSamples,
      observeHeartbeat, barrierArrive, barrierDepart, barrierCounters, publishProgress,
      fs: FS,
      proc: PROC,
      tty: TTY,
      win: WIN,
      data: DATA,
      // Frozen: these are MODULE objects shared by every program this worker runs.
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
        // The constraint-15 seam as a measurement, for the bench to assert none is transferable.
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
  } finally {
    // Cleared even when the program faulted, so a worker that survives a caught throw can be
    // given another program.
    running = false;
  }
}
