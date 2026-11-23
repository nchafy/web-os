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
// M16: THE SURFACE NOW FOLLOWS THE FRAME, and that is the opposite of what this file used to say.
// The branch at `WEV_RESIZE` below carries the old sentence and the reason it stopped being true.
// A program learns its client content box in DEVICE pixels, with the ratio beside it, so it can
// ask for a backing store that IS the box — and `paint` is the hard case, because it holds a
// drawing and a re-surface destroys the canvas it was drawn on. What happens to the drawing is
// decided and argued at THE PAPER below.
//
//   paint              a window you can draw in; q quits, c clears, 1-6 pick a colour
//   paint -t           draw the TEST PATTERN and exit, which is what M8's own proof asserts on
//   paint -w 480 -h 320  PIN the surface at that many device pixels, so it does NOT follow the
//                      frame. The page stretches it, which is the standing counter-example that a
//                      surface pixel is not a device pixel (`src/wm/surface.mjs`, PRD §2).
//   paint -R           re-surface WITHOUT replaying the drawing — a shipped negative control and
//                      nothing else, like `files --no-resurface` and `scripts/serve.py
//                      --no-isolation`: the control a suite can re-run instead of a source
//                      mutation nobody re-runs. Inert under `-w`/`-h`: a pinned surface is never
//                      re-asked, so there is no replay to suppress.
//
// The loop is the same shape as every other program here: one `poll`, one `read`, act, repeat.

import {
  POLLIN, POLLHUP, POLLERR, POLLNVAL, EINTR, EHOSTGONE,
  WEV_KEY, WEV_POINTER, WEV_RESIZE, WEV_CLIENT, WEV_CLOSE, WEV_DESTROYED, WEV_FOCUS,
  WPTR_DOWN, WPTR_UP, WPTR_MOVE, clientBoxAt,
  DL_CLEAR, DL_FILL_RECT, DL_STROKE_RECT, DL_LINE,
  keyBytesOf,
} from "/src/abi.mjs";

const NAME = "paint";

const POLL_MS = 200;
const CEILING_MS = 120000;

/** The startup surface, in DEVICE pixels, asked for before any client box is known. It lives one
 *  animation frame in the default mode — the host reports a geometry at window creation
 *  (`src/wm/winhost.mjs`) — and for the whole run under `-w`/`-h`, where it is the process's own
 *  choice of resolution and the page stretches it to the frame. */
const DEFAULT_W = 320;
const DEFAULT_H = 200;

/** A dot's side and a stroke's width, in PAPER pixels (see THE PAPER). Multiplied by the scale on
 *  the way into the display list, so a stroke is the same thickness to the eye at either ratio;
 *  a constant in surface pixels would be a 1-CSS-px hair at dpr 2. */
const DOT_PX = 3;
const LINE_PX = 2;

/** The most marks the journal holds. Past it the OLDEST are dropped — see WHAT A READER LOSES.
 *  A cap and not a measurement: it bounds what one process keeps and what one replay sends, which
 *  is ten `win_draw` syscalls at `DL_MAX_OPS` 2,048. `c` empties the journal, so a session that
 *  clears never reaches it. */
const MARKS_MAX = 20000;
/** Dropped in one slice rather than one per sample: `Array.prototype.shift` moves every remaining
 *  element, so evicting per mark is `MARKS_MAX` moves at every sample once the journal is full. */
const MARKS_EVICT = MARKS_MAX >> 3;

const MARK_DOT = 1;
const MARK_LINE = 2;

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

/* ---- THE PAPER -------------------------------------------------------------------------------
 *
 * THE DRAWING IS KEPT 1:1 AND A BIGGER WINDOW REVEALS MORE PAPER. It is not scaled, and it is not
 * forgotten.
 *
 * The constraint that forces a decision: a re-surface DESTROYS the canvas and builds a new one
 * (`src/wm/winhost.mjs`), and no syscall reads a surface back — a process holds only integers
 * (constraint 15), and `win_draw` is write-only. So a drawing survives a resize only if the
 * process can REPLAY it. Every stroke is therefore kept here as a mark, and the live path and the
 * replay path both go through `opsForMark`, because a resize that redrew the picture differently
 * from how it was drawn is a resize that changed the picture.
 *
 * A MARK IS IN PAPER PIXELS, and `scale` is surface pixels per paper pixel. In the default mode a
 * paper pixel IS a CSS pixel and `scale` is the dpr, which holds because `std.resurface` asks for
 * exactly the client content box in device pixels — the coincidence its own docstring states.
 * Under `-w`/`-h` the scale stays 1 and a paper pixel is a surface pixel, which is why the pinned
 * mode emits byte-identical ops to the pre-M16 program.
 *
 * WHY NOT SCALE THE DRAWING. A scale is a resample, and a resample at every resize destroys
 * information continuously: a 1-paper-px hair shrunk by a third is gone and no later growth brings
 * it back, where clipping loses nothing. It would also need a factor nobody asked for — two
 * factors, since the box moves in both axes independently, so a freehand line either shears or
 * stops reaching the pointer it was drawn under.
 *
 * WHY NOT CLIP AND FORGET. That is the `-R` world, and it is the one defect a reader reports as
 * "the resize ate my drawing".
 *
 * WHAT A READER LOSES, stated plainly. A stroke outside the new box is not drawn — the paper is
 * larger than the window and there is no scrolling until M17's wheel, so the only way back to it
 * is to grow the window again. That works, because a mark is independent of the box. What does
 * NOT come back is a drawing past `MARKS_MAX` marks: its oldest marks are evicted and the next
 * re-surface is where the loss becomes visible, which is why it is counted in `forgotten` and said
 * once rather than discovered.
 *
 * THE CHEAPEST CHECK THAT CATCHES THIS REGRESSING. One real drag, one driven grip resize wider,
 * then two pixel reads: the stroke's own midpoint, at `paper * dpr` in the NEW backing store, must
 * still be ink, and a point inside the revealed room must be paper. Two reads separate all three
 * answers: a scaled drawing moves the midpoint off its own ink AND puts ink in the revealed room,
 * and a forgotten one leaves paper at the midpoint. `paint -R` is the negative control and must
 * fail the first read alone.
 */

/** One mark as one display-list op. ONE RENDERER for the live stroke and the replay, so a resize
 *  cannot redraw the picture differently from the way it was drawn. `encodeDrawOp` truncates a
 *  fractional argument toward zero, so the rounding is done here where it can be seen. */
function opsForMark(m, scale) {
  const at = (v) => Math.round(v * scale);
  if (m.kind === MARK_DOT) {
    const side = Math.max(1, Math.round(DOT_PX * scale));
    return {
      op: DL_FILL_RECT, a0: at(m.x) - (side >> 1), a1: at(m.y) - (side >> 1),
      a2: side, a3: side, a4: m.ink,
    };
  }
  return {
    op: DL_LINE, a0: at(m.x), a1: at(m.y), a2: at(m.x2), a3: at(m.y2), a4: m.ink,
    a5: Math.max(1, Math.round(LINE_PX * scale)),
  };
}

function unInterrupted(call) {
  const first = call();
  if (first !== -EINTR) return first;
  return call();
}

export function run(env) {
  const argv = (env.argv || []).map(String);
  const { flags, bad, why: badWhy } = env.std.getopt(argv.slice(1), "w:h:tR");
  if (bad) return env.std.complain(env, NAME, bad, badWhy, env.std.EXIT_USAGE);
  const w = flags.w === undefined ? DEFAULT_W : env.std.wholeNumber(flags.w);
  const h = flags.h === undefined ? DEFAULT_H : env.std.wholeNumber(flags.h);
  if (w === null || h === null || w < 8 || h < 8 || w > 4096 || h > 4096) {
    return env.std.complain(env, NAME, `-w ${flags.w} -h ${flags.h}`, "wants 8..4096",
      env.std.EXIT_USAGE);
  }
  const patternOnly = flags.t === true;
  /** ASKING FOR A SIZE PINS IT. One knob, and omitting it is the off switch (CLAUDE.md): a program
   *  that named its own resolution asked for a resolution, so following the frame would overwrite
   *  the thing it asked for. `www/m8.html` spawns `-w 160 -h 120` and `-t -w 96 -h 64`, and both
   *  assert on a stretched surface. */
  const pinned = flags.w !== undefined || flags.h !== undefined;
  const noReplay = flags.R === true;
  const t0 = performance.now();
  /** Surface pixels per paper pixel. 1 until a client box arrives, and 1 for ever when pinned. */
  let scale = 1;
  /** Whether `scale` is the real one. A pinned surface's scale is 1 by construction and is known
   *  from the start; a following one is only known once a client box has been granted. */
  let known = pinned;
  /** The journal, in paper pixels. See THE PAPER. */
  const marks = [];
  const account = {
    program: NAME, win: 0, fd: 0, surface: { w, h }, pinned, scale,
    ops: 0, batches: 0, strokes: 0, keys: 0, pointers: 0, clears: 0, resizes: 0, focus: 0,
    clients: 0, replays: 0, refusals: 0, marks: 0, forgotten: 0, earlyMarks: 0,
    client: null, refused: "",
    why: "",
  };

  const made = env.win.create({
    // THE TITLE NAMES THE SURFACE ONLY WHEN THE SURFACE IS FIXED. A following surface is whatever
    // the frame last measured, so a size in the caption would be stale by the first drag.
    title: pinned ? `${NAME} ${w}x${h}` : NAME, w: 520, h: 360,
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

  /** Replay the journal onto a fresh surface. `win_draw` splits a list longer than `DL_MAX_OPS`
   *  into one syscall per batch (`src/libos/syscall.mjs`), so the whole drawing goes in one call
   *  and the clear leads it — the new canvas starts transparent, not paper. */
  const replay = () => {
    const ops = [{ op: DL_CLEAR, a0: PAPER }];
    for (const m of marks) ops.push(opsForMark(m, scale));
    account.replays += 1;
    return draw(ops);
  };

  /** Journal a mark and return it, evicting the oldest when the journal is full. See WHAT A READER
   *  LOSES. The mark is returned so the live op and the journal entry cannot drift: one call site
   *  produces both. */
  const remember = (m) => {
    marks.push(m);
    // COUNTED SEPARATELY, because the scale is not known until the page's first geometry report
    // and a mark made before it is in the startup store's pixels rather than CSS pixels. The
    // window is one animation frame wide — the host reports at window creation — so the figure is
    // normally 0, and a non-zero one is what a reader should be shown rather than a shifted
    // stroke with no explanation.
    if (!known) account.earlyMarks += 1;
    account.marks = marks.length;
    if (marks.length > MARKS_MAX) {
      marks.splice(0, MARKS_EVICT);
      account.forgotten += MARKS_EVICT;
      account.marks = marks.length;
      if (account.forgotten === MARKS_EVICT) {
        env.std.say(env,
          `${NAME}: past ${MARKS_MAX} marks; the oldest will not survive a resize\n`);
      }
    }
    return m;
  };

  // THE PATTERN IS `-t`'s ALONE NOW. It is in surface pixels at fixed coordinates and it is not a
  // mark, so it cannot be replayed — the first re-surface would erase it, and a drawing this
  // program cannot replay is a drawing it must not put on screen. An interactive run therefore
  // starts on blank paper. `www/m8.html`'s two pixel probes are unaffected: both read paper
  // (80,40) and (4, h-4), which the pattern never covered.
  const first = draw(patternOnly ? testPattern() : [{ op: DL_CLEAR, a0: PAPER }]);
  if (first < 0) {
    env.win.destroy(made.fd);
    return {
      exit: 4, ...account, why: `win_draw: ${env.std.errnoName(first)}`, errno: -first,
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

  env.std.say(env, `${NAME}: win ${made.win} on fd ${made.fd}, surface ${w}x${h}`
    + `${pinned ? " (pinned)" : ", following the frame"}\n`);
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
    // ONE RE-SURFACE PER DRAINED BATCH. The kernel replaces a tail client record, so a batch holds
    // two only when something arrived between two reports — and each one destroys and rebuilds a
    // canvas, so acting on the intermediate size costs a rebuild for pixels nobody sees.
    const client = env.std.lastClientEvent(evs);
    for (const ev of evs) {
      if (ev.type === WEV_FOCUS) {
        // COUNTED, because a surfaced window stopped emitting these and nothing noticed: the
        // focus listeners belonged to the TEXT widget the surface replaced (constraint 225).
        account.focus += 1;
        continue;
      }
      if (ev.type === WEV_POINTER) {
        account.pointers += 1;
        // `cssPointAt` AND NOT `{x: ev.a}`: the record's fields are u32 and a drag that leaves the
        // surface delivers negative coordinates, which read back as four billion. The DIVISION is
        // the other half of the same unit error — a `WEV_POINTER` carries SURFACE pixels
        // (constraint 223) and a mark is in paper pixels — and at `scale` 1 it is `pointerAt`
        // exactly, which is why the pinned mode's ops are unchanged.
        const at = env.std.cssPointAt(ev, scale);
        if (ev.mods & WPTR_DOWN) {
          last = at;
          // A DOT ON THE DOWN, so a click without a drag still marks the paper. A program that
          // only drew lines would look broken to anyone who clicked once.
          ops.push(opsForMark(remember({ kind: MARK_DOT, x: at.x, y: at.y, ink }), scale));
        } else if (ev.mods & WPTR_MOVE) {
          if (last) {
            ops.push(opsForMark(
              remember({ kind: MARK_LINE, x: last.x, y: last.y, x2: at.x, y2: at.y, ink }), scale));
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
          // A CLEAR EMPTIES THE JOURNAL TOO. Anything else would bring the drawing back at the
          // next resize, which is a clear that did not clear — and it is what bounds the journal
          // for a session that clears.
          marks.length = 0;
          account.marks = 0;
          ops.push({ op: DL_CLEAR, a0: PAPER });
          account.clears += 1;
          continue;
        }
        const pick = Number(ch);
        if (Number.isInteger(pick) && pick >= 1 && pick <= INK.length) ink = INK[pick - 1];
        continue;
      }
      if (ev.type === WEV_CLIENT) {
        account.clients += 1;
        // RECORDED EVEN WHEN NOTHING IS DONE WITH IT, and `clientBoxAt` is the only route to it on
        // the pinned path, where `std.resurface` is never called. A reader of a pinned run can
        // then see the box the surface is being stretched to.
        account.client = clientBoxAt(ev);
        // A PINNED SURFACE IS THE PROCESS'S OWN CHOICE OF RESOLUTION, so the box is news and not
        // an instruction. The stretch is what `src/wm/surface.mjs` documents and what
        // `www/m8.html`'s 4x4 pattern asserts through.
        if (pinned) continue;
        if (ev !== client) continue;
        const got = env.std.resurface(env, made.fd, ev);
        if (!got.ok) {
          // THE DRAWING OUTLIVES A REFUSAL. The kernel leaves the previous surface in place
          // (`WinMgr.surface` mutates nothing until all three gates pass), so the existing scale
          // and every mark are still correct and the program keeps running at the size it has —
          // exiting here would destroy a reader's drawing because a window grew past a budget.
          // The refusal is permanent and MUST NOT be retried, so nothing is scheduled: the next
          // SMALLER box will raise its own event.
          account.refusals += 1;
          // `got.errno` is POSITIVE where every other errno in this file is negative;
          // `errnoName` takes either sign.
          account.refused = env.std.errnoName(got.errno);
          if (account.refusals === 1) {
            env.std.say(env, `${NAME}: win_surface: ${account.refused}`
              + `; keeping the ${account.surface.w}x${account.surface.h} surface\n`);
          }
          continue;
        }
        scale = got.dpr;
        known = true;
        account.scale = scale;
        account.surface = { w: got.w, h: got.h };
        // THE PENDING BATCH IS SUPERSEDED: every op in it is either a mark the replay carries or a
        // clear its own leading clear covers, and all of them were built at the OLD scale — so
        // drawing it after the replay would stamp the same stroke twice, in two places. Under `-R`
        // the bare clear is the point: see WHY NOT CLIP AND FORGET.
        ops.length = 0;
        const sent = noReplay ? draw([{ op: DL_CLEAR, a0: PAPER }]) : replay();
        if (sent < 0) {
          account.why = `win_draw: ${env.std.errnoName(sent)}`;
          break;
        }
        continue;
      }
      if (ev.type === WEV_RESIZE) {
        // CELLS, NOT PIXELS, so a canvas program has nothing to do with this: `WEV_RESIZE` carries
        // a terminal's columns and rows, and the kernel suppresses it for any resize that changed
        // no cell count — which includes resizes that changed every pixel of a surface. The pixel
        // box arrives as `WEV_CLIENT`, above.
        //
        // THIS BRANCH USED TO READ "THE SURFACE DOES NOT FOLLOW THE FRAME, and that is
        // deliberate". It was true, and M16 ended it. A process could not learn its client box:
        // the one dpr channel ran page to kernel, the kernel kept only the square, and no event
        // carried the box — so a program's only honest option was to name its own resolution and
        // let CSS stretch it. `WEV_CLIENT` carries the box in device pixels with the ratio beside
        // it, so a surface can BE the client area and the stretch is what a reader sees DURING a
        // drag rather than for ever after it. The old sentence survives as `-w`/`-h`, which is
        // still the honest answer for a program that wants its own resolution.
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
  env.std.say(env, `${NAME}: ${account.why}. ${account.ops} ops in ${account.batches} batches`
    + `, ${account.marks} marks over ${account.replays} replays`
    + `${account.forgotten ? `, ${account.forgotten} forgotten` : ""}\n`);
  return { exit: 0, ...account };
}
