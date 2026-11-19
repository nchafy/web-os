// What the SURFACE BUDGET refuses, and what a surfaced window refuses. One program, two subjects,
// because both are things only the kernel can answer and neither needs a frame to be looked at.
//
// A BENCH PROGRAM AND NOT A SHIPPED ONE: asking for surfaces until one is refused is not
// behaviour a user wants in `/usr/bin`, and `bench/m7-win/wedge.mjs` is here for the same reason.
//
// What it reports, and `www/m8.html` asserts on it:
//
//   tooBig        asking for more than one surface may be, by name
//   budget        how many window-sized surfaces were granted before one was refused, and with
//                 which errno — the budget is a CEILING, so it must be ENOMEM and never EAGAIN
//   released      a surface the same size granted again after the windows were destroyed, which
//                 is the half of accounting that revocation is
//   cellsRefused  `write(2)` on a surfaced window, which has no text widget to render them

import {
  EINVAL, ENOMEM, DL_CLEAR, DLOP_BYTES, DL_MAX_OPS, SYS_win_draw, encodeDrawOp,
} from "/src/abi.mjs";

const NAME = "greedy";

/** The surface each round asks for. A maximized window at dpr 2 is 3.69 M device px
 *  (constraint 49), so this is about one of those — the unit the budget is meant to count. */
const W = 1920;
const H = 1920;

export function run(env) {
  const account = {
    program: NAME, rounds: [], granted: 0, refusedWith: "", tooBig: "", released: "",
    cellsRefused: "", why: "",
  };

  // ---- a surface larger than any surface may be -------------------------------------------
  const first = env.win.create({ title: "greedy", w: 200, h: 140 });
  if (typeof first === "number") {
    return { exit: 2, ...account, why: `win_create: ${env.std.errnoName(first)}` };
  }
  // 8192 x 8192 is 67 M px, past both the per-surface cap and the whole budget. EINVAL and not
  // ENOMEM: it is not that the system is full, it is that no surface may be that big.
  const huge = env.win.surface(first.fd, 8192, 8192);
  account.tooBig = env.std.errnoName(huge);

  // ---- and one that is allowed ------------------------------------------------------------
  const ok = env.win.surface(first.fd, W, H);
  account.rounds.push({ win: first.win, r: env.std.errnoName(ok) });
  if (ok === 0) account.granted += 1;

  // ---- `write` on a surfaced window -------------------------------------------------------
  //
  // ONE CONTENT MODE PER WINDOW. The text widget is gone once a surface exists, so cells have
  // nowhere to go and are refused rather than accepted and dropped — accepting bytes nobody
  // renders is the silent loss a user cannot diagnose.
  const wrote = env.fs.write(first.fd, env.std.bytes("cells after a surface\n"));
  account.cellsRefused = wrote < 0 ? env.std.errnoName(wrote) : `ACCEPTED ${wrote}`;
  // And drawing still works, which is what makes the refusal above specific rather than a window
  // that stopped working.
  account.drewAfter = env.std.errnoName(env.win.draw(first.fd, [{ op: DL_CLEAR, a0: 0x101216ff }]));

  /* ---- A BATCH THAT LIES ABOUT ITS OWN SIZE ------------------------------------------------
   *
   * THE DEFECT THIS EXISTS FOR, found by an independent critic: `win_draw` was the one handler
   * that did not bound the byte length by `MAX_INLINE`. It checked only that the length matched
   * the declared op count — and `subarray` CLAMPS rather than throwing, so a caller declaring
   * 3,000 ops with a matching length had the kernel charge 2,043.875 ops, the page replay 2,043
   * ops of whatever the region last held, and the call return 0. Constraint 225.
   *
   * These go through `env.syscall` and not `env.win.draw`, deliberately: the libos splits a long
   * list and would never SEND a lying count, so the only way to reach the guard is to make the
   * call the libos protects the kernel from.
   */
  const one = new Uint8Array(DLOP_BYTES);
  encodeDrawOp(new DataView(one.buffer), 0, { op: DL_CLEAR, a0: 0x000000ff });
  account.badOps = {
    // More ops than a frame can hold, with a payload that cannot possibly be that long.
    tooMany: env.std.errnoName(env.syscall(
      SYS_win_draw, first.fd, DL_MAX_OPS + 1, 0, 0, 0, 0, 0, 0, one, 0, one.length)),
    // A count that does not match the payload, in both directions.
    tooFew: env.std.errnoName(env.syscall(
      SYS_win_draw, first.fd, 2, 0, 0, 0, 0, 0, 0, one, 0, one.length)),
    zero: env.std.errnoName(env.syscall(
      SYS_win_draw, first.fd, 0, 0, 0, 0, 0, 0, 0, one, 0, one.length)),
    negative: env.std.errnoName(env.syscall(
      SYS_win_draw, first.fd, -1, 0, 0, 0, 0, 0, 0, one, 0, one.length)),
    // And the honest one still works, which is what makes the refusals specific.
    honest: env.std.errnoName(env.syscall(
      SYS_win_draw, first.fd, 1, 0, 0, 0, 0, 0, 0, one, 0, one.length)),
  };

  // ---- the budget -------------------------------------------------------------------------
  const held = [first.fd];
  for (let i = 0; i < 64; i += 1) {
    const made = env.win.create({ title: `greedy ${i + 2}`, w: 120, h: 90 });
    if (typeof made === "number") {
      account.why = `win_create #${i + 2}: ${env.std.errnoName(made)}`;
      break;
    }
    held.push(made.fd);
    const r = env.win.surface(made.fd, W, H);
    account.rounds.push({ win: made.win, r: env.std.errnoName(r) });
    if (r === 0) {
      account.granted += 1;
      continue;
    }
    account.refusedWith = env.std.errnoName(r);
    break;
  }
  if (!account.refusedWith) account.why = account.why || "the budget refused nothing in 64 rounds";

  // ---- and the release --------------------------------------------------------------------
  //
  // REVOCATION IS THE OTHER HALF OF ACCOUNTING. Destroying the windows must give the area back, or
  // a long session would run out of surface it no longer has. Asked for the same size that was
  // just refused, so a grant here is the release and nothing else.
  for (const fd of held) env.win.destroy(fd);
  const after = env.win.create({ title: "greedy again", w: 200, h: 140 });
  if (typeof after === "number") {
    account.released = `win_create: ${env.std.errnoName(after)}`;
  } else {
    account.released = env.std.errnoName(env.win.surface(after.fd, W, H));
    env.win.destroy(after.fd);
  }
  account.errnos = { EINVAL, ENOMEM };
  account.why = account.why || `the budget refused round ${account.granted + 1}`;
  return { exit: 0, ...account };
}
