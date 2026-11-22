// `paint`: draw in a window with the mouse, where every pixel goes through a syscall.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// THIS IS M8's HEADLINE AS A PROGRAM YOU CAN RUN. The milestone's claim is that a process can put
// pixels inside its own window — and that it does so WITHOUT HOLDING ANYTHING: no canvas, no
// context, no handle. It asks the kernel for a surface, polls its window fd for pointer events,
// and sends a display list back. A process holds only integers (constraint 15), and a transferred
// `OffscreenCanvas` could not reach it anyway (constraint 219, `docs/DECISIONS.md` D31).
//
//   paint              a window you can draw in; q quits, c clears, 1-6 pick a colour
//   paint -t           draw the TEST PATTERN and exit, which is what M8's own proof asserts on
//   paint -w 480 -h 320  a surface of that many device pixels
//
// The loop is the same shape as every other program here: one `poll`, one `read`, act, repeat.

import {
  POLLIN, POLLHUP, POLLERR, POLLNVAL, EINTR, EHOSTGONE,
  WEV_KEY, WEV_POINTER, WEV_RESIZE, WEV_CLOSE, WEV_DESTROYED, WEV_FOCUS,
  WPTR_DOWN, WPTR_UP, WPTR_MOVE, pointerAt,
  DL_CLEAR, DL_FILL_RECT, DL_STROKE_RECT, DL_LINE,
  keyBytesOf,
} from "/src/abi.mjs";

const NAME = "paint";

const POLL_MS = 200;
const CEILING_MS = 120000;

/** The default surface, in device pixels. Smaller than the window it sits in, which the CSS scales
 *  — so a reader can see that a surface's size is the PROCESS's choice and not the frame's. */
const DEFAULT_W = 320;
const DEFAULT_H = 200;

/** `0xRRGGBBAA`. The six a key picks, and the background. Named here because a program's palette
 *  is the program's business; `cssColor` in `src/abi.mjs` is the one thing that turns one of these
 *  into a colour the canvas understands. */
const PAPER = 0x0b0d11ff;
const INK = [
  0xdde3ebff,   // 1  paper white
  0x4a9bd8ff,   // 2  the project's blue
  0xd87a4aff,   // 3  orange
  0x9fd4a8ff,   // 4  green
  0xd8d14aff,   // 5  yellow
  0xd84a7aff,   // 6  pink
];

/** THE TEST PATTERN M8's PROOF ASSERTS ON, and the reason it is in the shipped program rather than
 *  in a bench fixture: the milestone's proof is "a process draws a known 4×4 pattern; screenshot
 *  and assert the pixels", and a pattern drawn by a program a user can also run is a proof about
 *  the real path. Four 4×4 squares at known coordinates, then a line across them.
 *
 *  The coordinates and colours are returned as DATA so the check can derive what it expects
 *  instead of agreeing a list with the thing it is checking. */
export function testPattern() {
  return [
    { op: DL_CLEAR, a0: PAPER },
    { op: DL_FILL_RECT, a0: 8, a1: 8, a2: 4, a3: 4, a4: INK[1] },
    { op: DL_FILL_RECT, a0: 16, a1: 8, a2: 4, a3: 4, a4: INK[2] },
    { op: DL_FILL_RECT, a0: 8, a1: 16, a2: 4, a3: 4, a4: INK[3] },
    { op: DL_FILL_RECT, a0: 16, a1: 16, a2: 4, a3: 4, a4: INK[4] },
    { op: DL_STROKE_RECT, a0: 4, a1: 4, a2: 20, a3: 20, a4: INK[0], a5: 1 },
    { op: DL_LINE, a0: 32, a1: 8, a2: 60, a3: 8, a4: INK[5], a5: 3 },
  ];
}

function unInterrupted(call) {
  const first = call();
  if (first !== -EINTR) return first;
  return call();
}

export function run(env) {
  const argv = (env.argv || []).map(String);
  const { flags, bad, why: badWhy } = env.std.getopt(argv.slice(1), "w:h:t");
  if (bad) return env.std.complain(env, NAME, bad, badWhy, env.std.EXIT_USAGE);
  const w = flags.w === undefined ? DEFAULT_W : env.std.wholeNumber(flags.w);
  const h = flags.h === undefined ? DEFAULT_H : env.std.wholeNumber(flags.h);
  if (w === null || h === null || w < 8 || h < 8 || w > 4096 || h > 4096) {
    return env.std.complain(env, NAME, `-w ${flags.w} -h ${flags.h}`, "wants 8..4096",
      env.std.EXIT_USAGE);
  }
  const patternOnly = flags.t === true;
  const t0 = performance.now();
  const account = {
    program: NAME, win: 0, fd: 0, surface: { w, h },
    ops: 0, batches: 0, strokes: 0, keys: 0, pointers: 0, clears: 0, resizes: 0, focus: 0,
    why: "",
  };

  const made = env.win.create({
    title: `${NAME} ${w}x${h}`, w: 520, h: 360,
    // CLEAR OF THE DESKTOP'S ICON COLUMN: see `WIN_ORIGIN_X` in src/libos/std.mjs.
    x: env.std.WIN_ORIGIN_X, y: env.std.WIN_ORIGIN_Y,
  });
  if (typeof made === "number") {
    return { exit: 2, ...account, why: `win_create: ${env.std.errnoName(made)}`, errno: -made };
  }
  account.win = made.win;
  account.fd = made.fd;

  // THE SURFACE IS ASKED FOR AND MAY BE REFUSED: the kernel allocates it and accounts for it
  // against a budget every window shares (constraint 220), so -ENOMEM is a real answer and this
  // program reports it rather than drawing into nothing.
  const surf = env.win.surface(made.fd, w, h);
  if (surf < 0) {
    env.win.destroy(made.fd);
    return {
      exit: 3, ...account, why: `win_surface: ${env.std.errnoName(surf)}`, errno: -surf,
    };
  }

  /** Send a batch and account it. ONE SYSCALL PER BATCH, not per op. */
  const draw = (ops) => {
    const r = env.win.draw(made.fd, ops);
    if (r < 0) return r;
    account.batches += 1;
    account.ops += ops.length;
    return 0;
  };

  const pattern = draw(testPattern());
  if (pattern < 0) {
    env.win.destroy(made.fd);
    return {
      exit: 4, ...account, why: `win_draw: ${env.std.errnoName(pattern)}`, errno: -pattern,
    };
  }
  if (patternOnly) {
    // THE PATTERN IS LEFT ON SCREEN and the window is NOT destroyed: a proof that asserts on
    // pixels needs them to still be there when it looks. The page tears the kernel down.
    account.why = "the test pattern is drawn";
    account.ms = performance.now() - t0;
    account.pattern = testPattern();
    return { exit: 0, ...account };
  }

  env.std.say(env, `${NAME}: win ${made.win} on fd ${made.fd}, surface ${w}x${h}\n`);
  env.std.say(env, "drag in the window to draw. 1-6 pick a colour, c clears, q quits.\n");

  let ink = INK[1];
  let last = null;
  for (;;) {
    if (performance.now() - t0 > CEILING_MS) {
      account.why = `ceiling ${CEILING_MS} ms reached`;
      break;
    }
    const r = unInterrupted(() => env.tty.poll([{ fd: made.fd, events: POLLIN }], POLL_MS));
    if (typeof r === "number") {
      if (r === -EINTR) continue;
      account.why = `poll: ${env.std.errnoName(r)}`;
      break;
    }
    const rev = r.fds[0].revents;
    if (rev & (POLLHUP | POLLERR | POLLNVAL)) {
      account.why = "the window hung up";
      break;
    }
    if (!(rev & POLLIN)) continue;
    const evs = env.win.read(made.fd, 64);
    if (typeof evs === "number") {
      if (evs === -EHOSTGONE) { account.why = "the window was destroyed"; break; }
      if (evs < 0 && evs !== -EINTR) {
        account.why = `read: ${env.std.errnoName(evs)}`;
        break;
      }
      continue;
    }
    // ONE BATCH PER WAKE, not one per event: a drag arrives as several moves in one read, and a
    // syscall each would be the per-op round trip the display list exists to avoid.
    const ops = [];
    for (const ev of evs) {
      if (ev.type === WEV_FOCUS) {
        // COUNTED, because a surfaced window stopped emitting these and nothing noticed: the
        // focus listeners belonged to the TEXT widget the surface replaced (constraint 225).
        account.focus += 1;
        continue;
      }
      if (ev.type === WEV_POINTER) {
        account.pointers += 1;
        // `pointerAt` AND NOT `{x: ev.a}`: the record's fields are u32 and a drag that leaves the
        // surface delivers negative coordinates, which read back as four billion.
        const at = pointerAt(ev);
        if (ev.mods & WPTR_DOWN) {
          last = at;
          // A DOT ON THE DOWN, so a click without a drag still marks the surface. A program that
          // only drew lines would look broken to anyone who clicked once.
          ops.push({ op: DL_FILL_RECT, a0: at.x - 1, a1: at.y - 1, a2: 3, a3: 3, a4: ink });
        } else if (ev.mods & WPTR_MOVE) {
          if (last) {
            ops.push({ op: DL_LINE, a0: last.x, a1: last.y, a2: at.x, a3: at.y, a4: ink, a5: 2 });
            account.strokes += 1;
          }
          last = at;
        } else if (ev.mods & WPTR_UP) {
          last = null;
        }
        continue;
      }
      if (ev.type === WEV_KEY) {
        account.keys += 1;
        const bytes = keyBytesOf(ev);
        if (bytes.length !== 1) continue;
        const ch = String.fromCharCode(bytes[0]);
        if (ch === "q") { account.why = "q"; break; }
        if (ch === "c") {
          ops.push({ op: DL_CLEAR, a0: PAPER });
          account.clears += 1;
          continue;
        }
        const pick = Number(ch);
        if (Number.isInteger(pick) && pick >= 1 && pick <= INK.length) ink = INK[pick - 1];
        continue;
      }
      if (ev.type === WEV_RESIZE) {
        // THE SURFACE DOES NOT FOLLOW THE FRAME, and that is deliberate: a surface is the
        // process's own choice of resolution and the page scales it to the client area. A program
        // that wants to match its frame asks for a new surface, which is what this counts.
        account.resizes += 1;
        continue;
      }
      if (ev.type === WEV_CLOSE) { account.why = "the window asked to close"; break; }
      if (ev.type === WEV_DESTROYED) { account.why = "the window was destroyed"; break; }
    }
    if (ops.length) {
      const sent = draw(ops);
      if (sent < 0) {
        account.why = `win_draw: ${env.std.errnoName(sent)}`;
        break;
      }
    }
    if (account.why) break;
  }

  const destroyed = env.win.destroy(made.fd);
  account.destroyed = Array.isArray(destroyed) ? destroyed : [];
  account.ms = performance.now() - t0;
  env.std.say(env, `${NAME}: ${account.why}. ${account.ops} ops in ${account.batches} batches\n`);
  return { exit: 0, ...account };
}
