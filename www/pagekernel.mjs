// THE PAGE'S HALF OF A KERNEL, as a module, because the second caller justifies the abstraction.
//
// `CLAUDE.md` records this machinery as a KNOWN SECOND COPY: "the `crossOriginIsolated` abort gate
// and `out`/`say` are pasted into nine `www/*.html` pages". `www/m7.html` and `www/m8.html` both
// need all of it — boot, retry, shut down, spawn a program by URL, collect its result — so it is
// one definition here rather than a tenth paste. The older pages still carry their own copies;
// that is a reduction, not a repair.
//
// THERE IS NO SYSCALL AND NO WINDOW LOGIC IN THIS FILE. It owns the message plumbing to one kernel
// worker and nothing about what the kernel is for: `src/wm/winhost.mjs` is the window half, and a
// page's proofs are the page's own.

/** Every `win-*` message that is an EVENT rather than a reply to something.
 *
 *  QUEUEING ONE WOULD LEAK: a session's keystrokes, cells and frame reports arrive in the hundreds
 *  and `pending` only ever shrinks when something expects that exact kind. `win-state` is the only
 *  window reply, because something asks for it by name. `win-geom` was missing from this set once
 *  and every frame report sat in `pending` for the life of the page. */
export const UNSOLICITED = new Set([
  "win-create", "win-out", "win-destroy", "win-title", "win-box", "win-health", "win-fed",
  "win-geom", "win-surface", "win-draw",
  // M9. The stack, the refusal and the modality change are all events: the kernel posts them when
  // it decides, not when asked, so nothing ever `expect`s one.
  "win-stack", "win-blocked", "win-modal",
  // M10. The drag session and the clipboard are events for the same reason: the kernel posts them
  // when it decides, and nothing `expect`s one. `data-state` is the only data reply, because
  // something asks for it by name.
  "win-drag", "win-drag-target", "win-drag-end", "clipboard",
]);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a predicate until it holds. Returns the ms waited, or -1 on timeout.
 *
 * THE PREDICATE IS AWAITED, and once it was not: a `Promise` is always truthy, so an async
 * predicate returned TRUE IMMEDIATELY and its clause passed without measuring anything. Awaiting
 * is correct for a synchronous predicate too, which is why there is one spelling.
 */
export async function until(what, ms = 5000, step = 25) {
  const t0 = performance.now();
  for (;;) {
    if (await what()) return performance.now() - t0;
    if (performance.now() - t0 > ms) return -1;
    await sleep(step);
  }
}

export class KernelFail extends Error {}

/**
 * One kernel worker, with an `expect(kind)` over its replies and `on(fn)` over its events.
 *
 * `report` is the page's own globals object — `globalThis.M7`, `globalThis.M8` — and this writes
 * `errors`, `faults` and `notes` into it. A page that could not see the kernel's own complaints
 * would report a timeout where there was a panic.
 */
export function kernelBoot(cfg, report, say = () => {}) {
  const worker = new Worker("/src/kernel/kernel.mjs", { type: "module", name: "kernel" });
  const waiters = new Map();
  const pending = [];
  const events = [];
  const listeners = [];
  let abort = null;
  const fail = (why) => {
    abort = new KernelFail(why);
    for (const [t, w] of waiters) {
      waiters.delete(t);
      w(abort);
    }
  };
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (!UNSOLICITED.has(m.t)) events.push(m);
    if (m.t === "up") {
      report.kernelIsolated = m.isolated === true;
      report.kernelCfg = m.cfg;
    }
    if (m.t === "fault") {
      report.faults.push({ pid: m.pid, why: m.why });
      say(`FAULT pid ${m.pid}: ${m.why}`);
    }
    if (m.t === "error" || m.t === "panic") {
      report.errors.push(`kernel: ${m.t}: ${m.why}`);
      say(`kernel ${m.t}: ${m.why}`);
    }
    if (m.t === "io-note") report.notes.push(m.why);
    for (const fn of listeners) fn(m);
    if (UNSOLICITED.has(m.t)) return;
    const cb = waiters.get(m.t);
    if (cb) {
      waiters.delete(m.t);
      cb(m);
      return;
    }
    pending.push(m);
  };
  worker.onerror = (e) => {
    report.errors.push(`kernel worker: ${e.message}`);
    fail(`kernel worker: ${e.message}`);
  };
  const expect = (t, ms = 30000) => new Promise((res, rej) => {
    if (abort) return rej(abort);
    const i = pending.findIndex((m) => m.t === t);
    if (i >= 0) return res(pending.splice(i, 1)[0]);
    const timer = setTimeout(() => {
      waiters.delete(t);
      rej(new Error(`timed out waiting for ${t}`));
    }, ms);
    waiters.set(t, (m) => {
      clearTimeout(timer);
      if (m instanceof Error) rej(m); else res(m);
    });
  });
  worker.postMessage({ t: "boot", cfg });
  return {
    worker,
    expect,
    post: (m) => worker.postMessage(m),
    on: (fn) => { listeners.push(fn); },
    events,
  };
}

/** How long one kernel boot may take before it is retried. */
const BOOT_WAIT_MS = 12000;

/**
 * Boot a kernel, and RETRY ONCE if its worker never starts.
 *
 * A Worker that will not start fires an error event with an EMPTY message (constraint 207), and
 * "the residual `up` stall is Chrome's worker startup under load" (constraint 155). A page that
 * boots six kernels in seventeen seconds hit it about one run in seven: `kernel worker: undefined`,
 * a BROKEN check and nothing to fix. So it is BOUNDED, COUNTED AND REPORTED — the shape
 * `docs/DECISIONS.md` D21 settled for the program fetch — because a silent retry turns a
 * measurable platform limit into a page that is mysteriously slow sometimes.
 *
 * It covers ONLY a worker that never reached `up`. Anything after that is the kernel's business.
 */
export async function bootKernel(cfg, report, say = () => {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const k = kernelBoot(cfg, report, say);
    try {
      await k.expect("up", BOOT_WAIT_MS);
      return k;
    } catch (e) {
      k.worker.terminate();
      report.bootRetries = (report.bootRetries || 0) + 1;
      const why = `kernel boot attempt ${attempt + 1} did not reach \`up\`: ${e.message}`;
      report.notes.push(why);
      if (attempt === 1) throw new Error(`${why} (retried once)`);
      say(`${why} — retrying once`);
    }
  }
  throw new Error("unreachable");
}

/**
 * REAP EVERY PROCESS BEFORE TERMINATING THE KERNEL THAT OWNS THEM. Terminating the kernel worker
 * alone ORPHANS its process workers — nested workers are collected eventually, not promptly — and
 * a page of proofs builds several kernels. `src/kernel/kernel.mjs`'s `shutdown` case carries the
 * note that it is NOT a remedy for a spawn that stalled (constraint 121).
 *
 * It also reads the kernel's PROGRAM-FETCH COUNTERS out of the acknowledgement and sums them into
 * `report.fetches`: a non-zero `transport` in a run that PASSED is the only direct evidence that
 * the retry in `programText` did anything (constraint 212).
 */
export async function shutdown(k, report) {
  try {
    k.post({ t: "shutdown" });
    const done = await k.expect("shutdown", 5000);
    const ks = (done && done.kernel) || {};
    const f = report.fetches;
    if (f) {
      f.kernels += 1;
      f.fetches += ks.programFetches || 0;
      f.retries += ks.programFetchRetries || 0;
      f.timeouts += ks.programFetchTimeouts || 0;
      f.transport += ks.programFetchTransport || 0;
    }
  } catch (e) {
    report.notes.push(`shutdown did not acknowledge: ${e && e.message}`);
  }
  k.worker.terminate();
}

/**
 * Spawn one program BY URL and park it. The page is the supervisor (`docs/DECISIONS.md` D18) and
 * its own `t: "spawn"` takes a URL; every program a page starts this way is also a row in
 * `USR_ENTRIES` or under `/bench`, so nothing about it is privileged.
 *
 * A SPAWN THAT DID NOT ANSWER NAMES WHAT THE KERNEL DID SAY. A bare "timed out waiting for
 * spawned" names the wait and not the cause, and that is what it reported the first time a page hit
 * the transport failure of constraint 212: the kinds the kernel HAD posted are the difference
 * between a stalled fetch, a refused program and a worker that never started.
 */
export async function spawnProgram(k, url, argv) {
  k.post({
    t: "spawn", count: 1, programUrl: url,
    cfg: { argv, uid: 0, gid: 0 }, readyTimeoutMs: 20000,
  });
  const spawned = await k.expect("spawned", 20000).catch((e) => {
    throw new Error(`${e.message} for ${url}; the kernel had posted `
      + `${JSON.stringify(k.events.map((m) => m.t))}, last: `
      + `${JSON.stringify(k.events[k.events.length - 1] || null).slice(0, 400)}`);
  });
  if (spawned.refused) throw new Error(`spawn refused: ${spawned.why}`);
  await k.expect("ready", 20000).catch((e) => {
    throw new Error(`${e.message} after spawning ${url}; the kernel had posted `
      + `${JSON.stringify(k.events.map((m) => m.t))}`);
  });
  const pid = spawned.pids[0];
  k.post({ t: "go", go: { mode: "park", pid } });
  return { pid };
}

/** One program's result row, or a row that says why there is none. A stopped program raises no
 *  error — a parked `poll` is a legitimate state — so a timeout CARRIES STATE (constraint 122). */
export async function resultOf(k, pid, ms = 60000) {
  try {
    const results = await k.expect("results", ms);
    return (results.results || []).find((r) => r.pid === pid)
      || { why: `no row for pid ${pid}`, results: results.results };
  } catch (e) {
    const state = await ask(k, "m4-state").catch((x) => String(x));
    const windows = await ask(k, "win-state").catch((x) => String(x));
    return { why: `no result: ${e.message}`, state, windows };
  }
}

/** Post a request and await the reply of the same kind. The kernel answers `m3-state`,
 *  `m4-state`, `win-state` and `stats` that way, so one helper covers them. */
export async function ask(k, kind, ms = 5000) {
  k.post({ t: kind });
  return await k.expect(kind, ms);
}

/**
 * THE GESTURE PROTOCOL: how a page asks for REAL input and waits for it.
 *
 * A window manager cannot be checked by screenshot — an inert frame and a working one are the same
 * picture (constraint 40) — so M13's and M14's proofs have to drive a real pointer and read the
 * geometry back. A page cannot drive one: a synthesised `PointerEvent` carries `isTrusted === false`
 * and `setPointerCapture` refuses a pointerId no live pointer owns (constraint 175), which is the
 * gesture half of M4a's whole lesson.
 *
 * So the page PUBLISHES the gesture it needs, at coordinates it measures off its own rects, and
 * blocks until something performed it. `scripts/check.py`'s `drive_gestures` is the other half and
 * uses `Input.dispatchMouseEvent`; a human opening the page performs them with a hand, which is
 * what the bench shells do. ONE definition of the handshake, because the two sides agreeing about
 * it by hand is how a page comes to wait for a gesture nobody is sending.
 *
 * `report.want` is the ask, `report.driven` is the receipt, and the id makes a second ask for the
 * same gesture distinguishable from a stale receipt — the `CALLID` argument, one layer up.
 */
/** How long a gesture may go unperformed before the page SAYS it is waiting for a driver. Short
 *  enough that a person sees it before they start pressing things, long enough that a driven run
 *  never paints it — `drive_gestures` answers an ask in about 40 ms. */
const DRIVER_HINT_MS = 2500;

/**
 * SAY, ON SCREEN, THAT THIS PAGE IS WAITING FOR A DRIVER.
 *
 * A proof page that blocks in `ask` looks exactly like a broken product: fixture windows it staged
 * itself, a caption button that belongs to a sequence halfway through, and a thrown
 * `nothing performed the … gesture` a minute later. That is how this page's defects have actually
 * been reported, twice, and the page had nothing on it that said so. The banner is removed the
 * moment anything drives the gesture, so a driven run never shows it.
 */
function driverHint(spec, live) {
  let hint = document.getElementById("driver-hint");
  if (!hint) {
    hint = document.createElement("div");
    hint.id = "driver-hint";
    hint.setAttribute("role", "status");
    hint.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:2147483647;"
      + "background:#7f1d1d;color:#fff;font:13px/1.5 ui-monospace,monospace;padding:8px 12px;"
      + "box-shadow:0 2px 8px rgba(0,0,0,.5)";
    document.body.append(hint);
  }
  hint.textContent = `THIS PAGE IS A PROOF HARNESS, and it is waiting for a driver to perform the `
    + `${spec.kind} gesture "${spec.name || spec.kind}". The windows on it are fixtures it staged, `
    + `so its buttons belong to a half-run sequence. To USE the desktop, open ${live}. `
    + `To run the proofs, let the harness drive them: scripts/check.py`;
  return hint;
}

function clearDriverHint() {
  const hint = document.getElementById("driver-hint");
  if (hint) hint.remove();
}

export function gestureAsker(report) {
  let serial = 0;
  report.want = null;
  report.driven = "";
  report.gestureLog = [];
  return async function ask(spec, ms = 60000) {
    serial += 1;
    const id = `${spec.name || spec.kind}#${serial}`;
    report.want = { id, ...spec };
    report.phase = "await-input";
    // The live URL is this page's own, with the proofs switched off — derived and never written,
    // so a page that is reached some other way still names a URL that exists.
    const live = `${location.pathname}?live=1`;
    const timer = setTimeout(() => driverHint(spec, live), DRIVER_HINT_MS);
    const waited = await until(() => report.driven === id, ms);
    clearTimeout(timer);
    clearDriverHint();
    report.want = null;
    report.phase = `drove ${id}`;
    report.gestureLog.push({ id, kind: spec.kind, waited: Math.round(waited) });
    // A THROW AND NOT A FLAG. A page that carried on after a gesture nobody performed would
    // measure the state before it and report numbers for a world that never happened.
    if (waited < 0) {
      throw new Error(`nothing performed the ${spec.kind} gesture ${id} within ${ms} ms. `
        + "A human reading this page performs it by hand; a check drives it over CDP.");
    }
    return waited;
  };
}

/** Synthesised keys into a widget's own element. They reach that handler and nothing in front of
 *  it, which is why `src/wm/terminal.mjs` counts trusted and synthetic keys separately. */
export function typeSynthetic(el, text) {
  for (const ch of text) {
    const init = { bubbles: true, cancelable: true };
    if (ch === "\n") Object.assign(init, { key: "Enter" });
    else if (ch === "\x03") Object.assign(init, { key: "c", ctrlKey: true });
    else if (ch === "\x04") Object.assign(init, { key: "d", ctrlKey: true });
    else Object.assign(init, { key: ch });
    el.dispatchEvent(new KeyboardEvent("keydown", init));
  }
}
