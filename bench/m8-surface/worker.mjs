// A WORKER SHAPED LIKE A PROCESS, and nothing else. No kernel, no syscall table, no program.
//
// `src/libos/process.mjs` is the thing this stands in for: a dedicated module worker that receives
// one SAB and one MessagePort, then runs a program which blocks in `Atomics.wait` between
// syscalls and never yields to its own event loop. The question M8 has to answer before it builds
// anything is whether an `OffscreenCanvas` can be TRANSFERRED to such a worker after it has
// started — `PLAN.md` §5 and `CLAUDE.md` both say a window's surface is a transferred
// `OffscreenCanvas`, and nobody has measured whether it can arrive.
//
// THE DOUBLE IS NOT GENTLER THAN THE REAL THING (constraint 98): it blocks in the same primitive
// for the same reason, and the three phases below are the three a program can actually be in.
//
//   PHASE "spin"    synchronous work, no await — what a program computing between syscalls is
//   PHASE "park"    `Atomics.wait` with a finite re-arm, which is what every blocking syscall does
//   PHASE "yield"   an awaited macrotask, which only an async program ever reaches
//
// The worker reports, at each phase, whether the transfer has arrived. Everything it reports comes
// out of its OWN state at the moment it was asked; the page cannot see into it.

const state = {
  canvas: null,
  messages: [],
  /** When the canvas arrived, in ms since the worker's own start. */
  arrivedAt: 0,
  /** What happened when it tried to DRAW on whatever it was given: a transfer that arrives and
   *  then cannot be used would be a worse answer than one that never arrives. */
  drew: "",
  drawError: "",
};

const t0 = performance.now();
let ctl = null;

/** The phase markers the page reads out of the SAB, so it never has to guess where the worker is.
 *  Shared memory and not a message, for the whole reason this experiment exists. */
const W_PHASE = 0;        // 1 spin, 2 park, 3 yield, 4 done
const W_ASK = 1;          // the page sets this to ask for a report
const W_SEEN_SPIN = 2;    // 1 if the canvas had arrived by the end of the spin
const W_SEEN_PARK = 3;
const W_SEEN_YIELD = 4;

self.onmessage = (ev) => {
  const m = ev.data || {};
  state.messages.push(m.t || "?");
  if (m.t === "init") {
    ctl = new Int32Array(m.sab);
    run().catch((error) => {
      self.postMessage({ t: "fault", why: String((error && error.stack) || error) });
    });
    return;
  }
  if (m.t === "surface") {
    // THE TRANSFER, if it ever gets here. Recorded with its arrival time, because "it arrived
    // eventually" and "it arrived while the worker was blocked" are different answers.
    state.canvas = m.canvas || null;
    state.arrivedAt = Math.round(performance.now() - t0);
    return;
  }
  if (m.t === "report") {
    self.postMessage({ t: "report", ...snapshot() });
  }
};

function snapshot() {
  return {
    hasCanvas: !!state.canvas,
    arrivedAt: state.arrivedAt,
    messages: [...state.messages],
    drew: state.drew,
    drawError: state.drawError,
    phase: ctl ? Atomics.load(ctl, W_PHASE) : -1,
    seen: ctl
      ? {
        spin: Atomics.load(ctl, W_SEEN_SPIN),
        park: Atomics.load(ctl, W_SEEN_PARK),
        yielded: Atomics.load(ctl, W_SEEN_YIELD),
      }
      : null,
  };
}

/** Synchronous work, for `ms`. A program computing between syscalls is exactly this, and it is
 *  what `MILESTONES.md` M1 proof (e) had to build to raise a signal at a RUNNING process. */
function spin(ms) {
  const until = performance.now() + ms;
  let acc = 0;
  while (performance.now() < until) acc += Math.sqrt(acc + 1);
  return acc;
}

async function run() {
  // ---- PHASE 1: spinning, no await ------------------------------------------------------
  Atomics.store(ctl, W_PHASE, 1);
  spin(400);
  Atomics.store(ctl, W_SEEN_SPIN, state.canvas ? 1 : 0);

  // ---- PHASE 2: parked in Atomics.wait, with a finite re-arm ----------------------------
  //
  // THE ONE THAT MATTERS. Every blocking syscall in this system parks here (constraint 46), so if
  // a transfer cannot arrive during it, a process cannot be handed a surface while it waits for
  // the call that asked for one.
  Atomics.store(ctl, W_PHASE, 2);
  const parkStart = performance.now();
  while (performance.now() - parkStart < 600) {
    // The same shape as `src/libos/syscall.mjs`'s park: wait on a word nobody will change, with a
    // timeout, and loop. `"timed-out"` is the normal return.
    Atomics.wait(ctl, W_ASK, Atomics.load(ctl, W_ASK), 50);
  }
  Atomics.store(ctl, W_SEEN_PARK, state.canvas ? 1 : 0);

  // ---- PHASE 3: an awaited macrotask ----------------------------------------------------
  //
  // The event loop turns here and nowhere else. A program's `run` MAY be async
  // (`src/libos/process.mjs`), so this phase is reachable — but only by a program written to
  // reach it, and never by one in the middle of a synchronous computation.
  Atomics.store(ctl, W_PHASE, 3);
  await new Promise((resolve) => setTimeout(resolve, 0));
  Atomics.store(ctl, W_SEEN_YIELD, state.canvas ? 1 : 0);

  // ---- AND CAN IT BE USED? --------------------------------------------------------------
  //
  // A transfer that arrives and cannot be drawn on would be a worse answer than one that never
  // arrives, because it would look like success in every test that only counted the arrival.
  if (state.canvas) {
    try {
      const g = state.canvas.getContext("2d");
      g.fillStyle = "#4a9bd8";
      g.fillRect(0, 0, 4, 4);
      const px = g.getImageData(1, 1, 1, 1).data;
      state.drew = `rgba(${px[0]},${px[1]},${px[2]},${px[3]})`;
    } catch (error) {
      state.drawError = String((error && error.message) || error);
    }
  }
  Atomics.store(ctl, W_PHASE, 4);
  self.postMessage({ t: "done", ...snapshot() });
}
