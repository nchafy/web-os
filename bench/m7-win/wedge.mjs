// A window whose process STOPS READING IT. The not-responding detector's fixture, and nothing else.
//
// WHY THIS IS A BENCH PROGRAM AND NOT AN OPTION ON A SHIPPED ONE. M4a's version of this proof
// attached a window with no process at all, which M7 makes impossible: a window is created by the
// process that will read it. The honest fixture is therefore a process that HAS a window and is not
// collecting its events — a program computing for ten seconds is exactly that, and it is the real
// case the caption is for. Adding a "wedge yourself" flag to `winopen` would have put test-only
// behaviour in a program a user runs (M4a's own objection to its earlier fixture), so it lives here.
//
// It sleeps rather than spins, for one measured reason: a spinning process at 100% of its worker
// starves the kernel it shares a renderer with, which is the defect M0's own anti-vacuity control
// walked into (`MILESTONES.md` M0, "the first attempt at this control was itself broken"). A
// sleeping process is just as deaf to its window and costs nothing.

import { EINTR, POLLIN, EHOSTGONE } from "/src/abi.mjs";

/** How long to hold the window without reading it. Long enough to pass both thresholds —
 *  1,000 ms and 5,000 ms — with room for the page to observe each edge. */
const HOLD_MS = 9000;

/** One sleep is one syscall, so a signal arrives at the next entry (constraint 131). The sleep is
 *  broken into slices so a SIGTERM from the page's End Process path is not waited out. */
const SLICE_MS = 250;

/** And then it COMES BACK and reads. The clearing edge of the detector needs a drain, and a
 *  process that was busy and then resumed reading is the ordinary case — so both edges come from
 *  one program and neither needs behaviour a real program would not have. A threshold with no
 *  tested lower edge is a threshold that latches. */
const DRAIN_MS = 4000;

export function run(env) {
  const argv = (env.argv || []).map(String);
  let hold = HOLD_MS;
  let drain = DRAIN_MS;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] !== "--hold" && argv[i] !== "--drain") continue;
    const ms = Number(argv[i + 1]);
    if (!Number.isFinite(ms) || ms < 0) {
      return { exit: 1, why: `${argv[i]} wants a non-negative number, got ${argv[i + 1]}` };
    }
    if (argv[i] === "--hold") hold = ms; else drain = ms;
    i += 1;
  }
  const made = env.win.create({ title: "wedged", w: 360, h: 160, x: 60, y: 60 });
  if (typeof made === "number") {
    return { exit: 2, why: `win_create: ${env.std.errnoName(made)}`, errno: -made };
  }
  // ONE WRITE, so the frame is not a blank rectangle and so a reader of the page can see which
  // window the caption is about. After this the process never touches the fd again.
  env.fs.write(made.fd, env.std.bytes(
    "this window's process has stopped reading it.\r\n"
    + "type here: the keystrokes queue, uncollected, and the caption greys.\r\n"));
  const t0 = performance.now();
  let slices = 0;
  while (performance.now() - t0 < hold) {
    const r = env.proc.nanosleep(SLICE_MS * 1e6);
    slices += 1;
    // An interrupted sleep is a signal, and the page's End Process path is how this program is
    // expected to end. Reported rather than swallowed.
    if (r === -EINTR) {
      return {
        exit: 0, program: "wedge", win: made.win, fd: made.fd, slices,
        why: "interrupted", heldMs: Math.round(performance.now() - t0),
      };
    }
  }
  // AND THEN THE DRAIN, which is the detector's clearing edge: the queue empties and the caption
  // must come back. `read` until there is nothing left, then keep polling so a key typed during
  // the drain is collected too.
  const t1 = performance.now();
  let drained = 0;
  let reads = 0;
  while (performance.now() - t1 < drain) {
    const r = env.tty.poll([{ fd: made.fd, events: POLLIN }], SLICE_MS);
    if (typeof r === "number") {
      if (r === -EINTR) continue;
      break;
    }
    if (!(r.fds[0].revents & POLLIN)) continue;
    const evs = env.win.read(made.fd);
    if (typeof evs === "number") {
      if (evs === -EHOSTGONE) break;
      continue;
    }
    reads += 1;
    drained += evs.length;
  }
  // THE WINDOW IS NOT DESTROYED HERE. The page's own teardown closes the kernel, and a wedge that
  // tidied up after itself would take away the frame whose caption this fixture is about.
  return {
    exit: 0, program: "wedge", win: made.win, fd: made.fd, slices, drained, reads,
    why: "held, then drained", heldMs: Math.round(t1 - t0),
    drainMs: Math.round(performance.now() - t1),
  };
}
