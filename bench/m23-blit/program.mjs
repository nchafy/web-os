// M23's owed measurement, process side: CAN A PROCESS DECODE A PNG?
//
// `docs/PLAN-SHELL.md` §M23 "If the assumption is wrong" asserts that "a locked-down realm has no
// `createImageBitmap` (src/libos/lockdown.mjs)". `createImageBitmap` is NOT in that file's
// `TARGETS`, so the assertion is false and the page checks that against the single source of truth
// rather than restating the list. This program answers the question the row did not ask:
//
//   A BINDING BEING PRESENT IS NOT A BINDING BEING USABLE. `createImageBitmap` is ASYNC, and
//   constraint 219 is the precedent: M8 measured that a transferred `OffscreenCanvas` reaches a
//   process only when the program AWAITS a macrotask — never while it spins and never while it is
//   parked in `Atomics.wait` at a syscall (constraint 46). A promise settles through the same event
//   loop, so the same three phases decide it.
//
// So the three phases are a process's three possible states, and each gets its OWN promise: a
// phase reusing an earlier phase's promise would score a settle the earlier phase caused.
//
//   park     a fresh decode, then `nanosleep` — the process is in Atomics.wait inside a syscall
//   spin     a fresh decode, then a synchronous busy loop — the stack never empties
//   await    a fresh decode, then `await` — the one state M8 found a transfer arriving in
//
// And a settle is not a thumbnail. `PIXELS` closes the gap: an `ImageBitmap` cannot leave a process
// (constraint 15 — a process holds only integers, and there is no transfer out), so the only route
// to `DL_BLIT` is pixels read back as bytes. That is a second platform call — `OffscreenCanvas` and
// `getImageData` — and a second thing that may or may not survive the realm strip and the process
// realm's `default-src 'none'` policy. Measured against `/usr/share/logo.rgba`, which is the SAME
// IMAGE as `/usr/share/logo.png` already stored as a `DOBJ_BITMAP` payload, so the comparison is
// against this repo's own bytes and not against the decoder's own opinion.
//
// TWO CONTROLS RUN IN EVERY RUN, through the same watchdog as the subject: a promise that settles
// at once must read `settled`, and one that never settles must read `unsettled`. A harness that
// cannot tell those apart has measured nothing, and `--control-never` substitutes the second one
// FOR THE SUBJECT so the verdict itself flips from the command line.

import { BITMAP_HEADER, MAX_INLINE, decodeBitmap } from "/src/abi.mjs";

/** Long enough that a 16x16 decode cannot plausibly still be running when the park ends, which is
 *  what makes "it did not settle while parked" a statement about the event loop and not about the
 *  decoder being slow. */
const PARK_MS = 400;
const SPIN_MS = 400;
/** The watchdog on one awaited promise. A 16x16 decode is sub-millisecond; this is three orders
 *  above it, so `unsettled` means "never" and not "not yet". */
const WATCHDOG_MS = 1500;

const PNG = "/usr/share/logo.png";
const RGBA = "/usr/share/logo.rgba";

const now = () => performance.now();
const round = (x) => Math.round(x * 1000) / 1000;
const msg = (e) => String((e && (e.message || e.name)) || e);
const sleep = (t) => new Promise((r) => setTimeout(r, t));

/**
 * Start one promise and stamp the time its own handler ran.
 *
 * The handler is attached HERE, in the same turn as the call, so `settledAt` is the FIRST turn in
 * which this realm could have observed the settle — a handler attached later would measure when
 * the program got round to looking. It also means an eventual rejection already has a handler:
 * an unhandled one faults the process (`src/libos/process.mjs`'s `onunhandledrejection`), which
 * would destroy the measurement rather than record it.
 */
function stamp(label, make) {
  const row = { label, calledAt: -1, settledAt: -1, error: "", kind: "" };
  row.calledAt = now();
  let p = null;
  try {
    p = make();
  } catch (e) {
    row.error = `threw synchronously: ${msg(e)}`;
    return { row, p: null };
  }
  if (!p || typeof p.then !== "function") {
    row.error = `returned ${typeof p}, which is not a thenable`;
    return { row, p: null };
  }
  p.then(
    (v) => {
      row.settledAt = now();
      row.kind = (v && v.constructor && v.constructor.name) || typeof v;
      row.value = v;
    },
    (e) => {
      row.settledAt = now();
      row.error = `rejected: ${msg(e)}`;
    },
  );
  return { row, p };
}

/** `settled` | `unsettled` | `absent`, from an AWAIT with a watchdog. One spelling for the subject
 *  and for both controls, because a control run through a different harness tests a different
 *  harness. */
async function watch(h) {
  if (!h.p) return "absent";
  return await Promise.race([
    h.p.then(() => "settled", () => "settled"),
    sleep(WATCHDOG_MS).then(() => "unsettled"),
  ]);
}

/**
 * HOW MANY MACROTASK TURNS A SETTLE COSTS, counted from here. -1 when `cap` turns were not enough.
 *
 * It is the figure that tells a blocked phase apart from a slow decoder, and the first run of this
 * probe needed it: one `await sleep(0)` after a 400 ms park was NOT enough, so a reading of
 * "one turn and it is there" would have been wrong. A design that wanted to fold a decode into a
 * syscall reply would need the answer to be zero.
 */
async function turnsUntil(row, cap = 64) {
  for (let turns = 0; turns <= cap; turns += 1) {
    if (row.settledAt >= 0) return turns;
    await sleep(0);
  }
  return -1;
}

/**
 * What the realm still has, as the program sees it — AFTER `lockdown` ran (it runs before any
 * program text is evaluated). Every name a decode-in-the-process design would need, plus two
 * `undefined`s that are there as a POSITIVE CONTROL ON THE STRIP ITSELF: a run in which `fetch`
 * were still a function would be a run whose realm is not the one M6 ships, and its figures would
 * be about a different realm.
 *
 * `cspRefusesEval` is the SECOND half of M6 (constraint 187), and it is here for the same reason:
 * the policy is on the worker script's response and a program cannot read a header, but
 * `script-src` without `'unsafe-eval'` makes `eval` throw — so a throw is the policy, measured
 * from inside. `scripts/serve.py --no-csp` is the world where it does not.
 */
function realmHas() {
  const has = {};
  for (const name of ["createImageBitmap", "OffscreenCanvas", "Blob", "ImageData",
                      "fetch", "createObjectURL"]) {
    has[name] = name === "createObjectURL"
      ? typeof (self.URL && self.URL.createObjectURL)
      : typeof self[name];
  }
  try {
    // eslint-disable-next-line no-eval -- the refusal IS the measurement
    const got = self.eval("1 + 1");
    has.cspRefusesEval = `no: eval returned ${got}`;
  } catch (e) {
    has.cspRefusesEval = `yes: ${msg(e)}`;
  }
  return has;
}

/**
 * Read the pixels back out. THE ONLY ROUTE FROM A DECODE TO `DL_BLIT`: an `ImageBitmap` is a handle
 * and constraint 15 forbids a process holding one that the kernel must account, so the bitmap has
 * to become bytes inside the process and travel as a data-object payload.
 *
 * `imageOrientation: 'none'` and `premultiplyAlpha: 'none'` are not available on this path — the
 * bitmap is already made — so a mismatch against `logo.rgba` is reported as a per-channel MAX
 * DELTA rather than asserted as equality: a 2d canvas stores premultiplied alpha and `getImageData`
 * un-premultiplies it, which is lossy for a partially transparent pixel. Equality is asserted only
 * over the FULLY OPAQUE pixels, where the round trip is exact.
 */
function pixelsOf(bmp, want) {
  const out = { w: bmp.width, h: bmp.height, error: "" };
  let data = null;
  try {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      out.error = "OffscreenCanvas.getContext('2d') returned null";
      return out;
    }
    ctx.drawImage(bmp, 0, 0);
    data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  } catch (e) {
    out.error = `readback: ${msg(e)}`;
    return out;
  }
  out.bytes = data.length;
  out.nonZero = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] !== 0) out.nonZero += 1;
  if (!want) {
    out.error = "no reference bitmap to compare against";
    return out;
  }
  if (want.w !== bmp.width || want.h !== bmp.height) {
    out.error = `reference is ${want.w}x${want.h}, the decode is ${bmp.width}x${bmp.height}`;
    return out;
  }
  let maxDelta = 0;
  let opaquePx = 0;
  let opaqueExact = 0;
  for (let p = 0; p < want.w * want.h; p += 1) {
    const o = p * 4;
    for (let c = 0; c < 4; c += 1) {
      const d = Math.abs(data[o + c] - want.pixels[o + c]);
      if (d > maxDelta) maxDelta = d;
    }
    if (want.pixels[o + 3] === 255) {
      opaquePx += 1;
      if (data[o] === want.pixels[o] && data[o + 1] === want.pixels[o + 1]
          && data[o + 2] === want.pixels[o + 2] && data[o + 3] === 255) opaqueExact += 1;
    }
  }
  out.maxDelta = maxDelta;
  out.opaquePx = opaquePx;
  out.opaqueExact = opaqueExact;
  return out;
}

/**
 * WHAT IT COSTS TO GET A DECODE OUT OF A PROCESS, derived from the ABI and never written down.
 *
 * An `ImageBitmap` cannot leave: a process holds only integers (constraint 15) and there is no
 * transfer out. So the only route to `DL_BLIT` is the pixels as a `DOBJ_BITMAP` payload, written
 * through the SAB's byte region, which `MAX_INLINE` bounds per call — above it, `dataobj_set` is a
 * short-count loop with `DOBJ_F_APPEND` (`src/abi.mjs`'s note on that flag).
 *
 * The figure the next slice needs is therefore the largest SQUARE one call carries, because that
 * is where a thumbnail size stops being free. It is reported rather than asserted: this probe owns
 * no opinion about how big a thumbnail should be.
 */
function payloadCeiling() {
  const px = Math.floor((MAX_INLINE - BITMAP_HEADER) / 4);
  const side = Math.floor(Math.sqrt(px));
  return {
    maxInline: MAX_INLINE,
    header: BITMAP_HEADER,
    pixelsInOneSetCall: px,
    largestSquareInOneSetCall: side,
    bytesForThatSquare: BITMAP_HEADER + side * side * 4,
  };
}

export async function run(env) {
  const argv = env.argv || [];
  /** The command-line control: the SUBJECT becomes a promise that cannot settle, so a probe run
   *  with it must report `unsettled` for the phase that otherwise decides the verdict. */
  const controlNever = argv.includes("--control-never");

  /* `realmHas`, NOT `realm`: `src/libos/process.mjs` puts its own lockdown report on every result
   * under `realm` and spreads the program's data FIRST, so a key of that name is silently
   * overwritten on the way out. The first run of this probe reported `createImageBitmap` ABSENT in
   * a realm that had just used it, for exactly that reason. */
  const r = {
    mode: "m23-decode",
    controlNever,
    realmHas: realmHas(),
    payloadCeiling: payloadCeiling(),
    parkMs: PARK_MS,
    spinMs: SPIN_MS,
    watchdogMs: WATCHDOG_MS,
    notes: [],
  };

  const png = env.std.readFileBytes(env, PNG);
  if (typeof png === "number") {
    r.notes.push(`${PNG}: ${env.std.errnoName(png)}`);
    return { ...r, exit: 1 };
  }
  r.pngBytes = png.length;
  const rgba = env.std.readFileBytes(env, RGBA);
  let want = null;
  if (typeof rgba === "number") {
    r.notes.push(`${RGBA}: ${env.std.errnoName(rgba)}`);
  } else {
    want = decodeBitmap(rgba);
    r.referenceBitmap = want
      ? { w: want.w, h: want.h, header: BITMAP_HEADER, bytes: rgba.length }
      : { error: `${RGBA} is ${rgba.length} bytes and is not a DOBJ_BITMAP payload` };
  }

  if (r.realmHas.createImageBitmap !== "function") {
    r.notes.push("createImageBitmap is not callable in this realm; the phases cannot be run");
    return { ...r, exit: 0 };
  }

  // A fresh Blob per phase. One Blob reused would let the platform answer a second decode from a
  // cache, which is a different question.
  const decode = () => createImageBitmap(new Blob([png], { type: "image/png" }));

  /* PHASE 0 — THE COLD BASELINE, with nothing blocking, so the blocked phases below are compared
   * against a decode of the same bytes in the same process rather than against zero. It runs FIRST
   * because the first decode in a realm also warms the platform's decoder, and a baseline taken
   * after three others would be a warm number labelled cold. */
  const cold = stamp("cold", decode);
  r.cold = {
    turns: await turnsUntil(cold.row),
    latencyMs: cold.row.settledAt >= 0 ? round(cold.row.settledAt - cold.row.calledAt) : -1,
    error: cold.row.error,
  };

  /* PHASE 1 — PARKED IN A SYSCALL. `nanosleep` is a syscall like any other: it parks in
   * Atomics.wait on (ctl, SEQ) until the kernel replies (src/libos/syscall.mjs `park`). The
   * elapsed time is reported beside the requested time so a park that did not happen cannot be
   * mistaken for a park in which nothing settled. */
  const parked = stamp("park", decode);
  const tBefore = now();
  const slept = env.proc.nanosleep(PARK_MS * 1e6);
  const tAfter = now();
  r.park = {
    requestedMs: PARK_MS,
    elapsedMs: round(tAfter - tBefore),
    nanosleep: slept,
    // READ WITH NO AWAIT BETWEEN THE SYSCALL AND THE READ: an await here would be the very
    // event-loop turn the phase is about.
    settledDuringPark: parked.row.settledAt >= 0,
  };
  await Promise.resolve();
  r.park.settledAfterOneMicrotask = parked.row.settledAt >= 0;
  r.park.turnsAfterTheParkEnded = await turnsUntil(parked.row);
  r.park.observedAfterTheParkEndedMs = parked.row.settledAt >= 0
    ? round(parked.row.settledAt - tAfter) : -1;
  r.park.totalLatencyMs = parked.row.settledAt >= 0
    ? round(parked.row.settledAt - parked.row.calledAt) : -1;
  r.park.error = parked.row.error;

  /* PHASE 2 — SPINNING. The stack never empties, so neither a microtask nor a task can run. This
   * is the phase M8 found a transfer missing even though the page had already posted it. */
  const spun = stamp("spin", decode);
  const tSpin = now();
  while (now() - tSpin < SPIN_MS) { /* a synchronous program, which is the point */ }
  const tSpun = now();
  r.spin = {
    requestedMs: SPIN_MS,
    elapsedMs: round(tSpun - tSpin),
    settledDuringSpin: spun.row.settledAt >= 0,
  };
  r.spin.turnsAfterTheSpinEnded = await turnsUntil(spun.row);
  r.spin.observedAfterTheSpinEndedMs = spun.row.settledAt >= 0
    ? round(spun.row.settledAt - tSpun) : -1;
  r.spin.error = spun.row.error;

  /* PHASE 3 — AWAITED, which is the phase that decides whether a decode has a site here at all. */
  const subject = stamp("await", controlNever ? () => new Promise(() => {}) : decode);
  r.awaited = {
    verdict: await watch(subject),
    latencyMs: subject.row.settledAt >= 0
      ? round(subject.row.settledAt - subject.row.calledAt) : -1,
    kind: subject.row.kind,
    error: subject.row.error,
  };

  /* THE TWO CONTROLS, through `watch` — the same function that scored the subject. They are not
   * optional: `settled` over a constant would also be returned by a `watch` that ignored its
   * argument, and `unsettled` over a constant by one whose race was backwards. */
  const positive = stamp("control-resolved", () => Promise.resolve(1));
  const negative = stamp("control-never", () => new Promise(() => {}));
  r.controls = {
    aPromiseThatSettlesReads: await watch(positive),
    aPromiseThatNeverSettlesReads: await watch(negative),
  };
  r.controls.canTellThemApart =
    r.controls.aPromiseThatSettlesReads === "settled"
    && r.controls.aPromiseThatNeverSettlesReads === "unsettled";

  /* PHASE 4 — THE PIXELS. Only reachable when the subject settled with a real bitmap, and skipped
   * rather than faked when it did not. */
  if (r.awaited.verdict === "settled" && subject.row.value
      && typeof subject.row.value.width === "number") {
    r.pixels = pixelsOf(subject.row.value, want);
    try {
      subject.row.value.close();
      r.pixels.closed = true;
    } catch (e) {
      r.pixels.closed = msg(e);
    }
  } else {
    r.pixels = { skipped: `the awaited phase read ${r.awaited.verdict}` };
  }
  // Every bitmap this run made, released, and a refusal RECORDED rather than swallowed.
  for (const h of [cold, parked, spun]) {
    const v = h.row.value;
    delete h.row.value;
    if (!v || typeof v.close !== "function") continue;
    try {
      v.close();
    } catch (e) {
      r.notes.push(`${h.row.label}: close() refused: ${msg(e)}`);
    }
  }

  // `value` must not travel in the result: it is an ImageBitmap, and structured-cloning one out of
  // a process is the transfer constraint 15 forbids.
  delete subject.row.value;
  r.rows = [cold.row, parked.row, spun.row, subject.row, positive.row, negative.row];
  return { ...r, exit: 0 };
}
