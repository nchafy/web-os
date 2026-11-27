// `m23blit`: the program `www/m23.html` reads pixels out of, and the one that asks for every way a
// `DL_BLIT` can be refused.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// WHY A PROGRAM AND NOT THE PAGE. A blit's payload is KERNEL-OWNED and named by a data-object fd
// (constraints 240, 241), and a page holds no fd and makes no syscall — so the only side that can
// ask for a blit, well-formed or not, is a process. `src/bin/files.mjs` blits real thumbnails and is
// the product reading of M23; it cannot ask for a REFUSAL, and it cannot draw a bitmap whose every
// pixel the page already knows. Both of those are what a proof needs, so they live here.
//
//   m23blit                 draw the known pattern and PARK until `q`. The page reads the pixels
//                           back while the window is alive, then quits it and reads this account
//   m23blit --once          draw it and exit at once, which is how the page learns WHAT THE PICTURE
//                           IS before it reads any pixel. The two runs are not redundant: an
//                           account arrives on a process's death and a window dies with its process
//                           (constraint 14, `WinMgr.reapPid`), so one run cannot hand the page both
//                           the points to read and the pixels at them. The page asserts the two
//                           accounts' pictures are equal, which is what says the first run
//                           described the second
//   m23blit --no-refusals   skip the refusal attempts. A CONTROL, and the only thing it proves is
//                           that the refusal clauses are coupled to these calls: with it, every
//                           errno row is absent rather than wrong
//   m23blit --whole-payload  the EBADMSG attempt writes a payload that IS a whole bitmap, so the
//                           kernel has nothing to refuse. A CONTROL over the EBADMSG clause and the
//                           whole-batch clause, which ride one fd
//
// THE SURFACE IS PINNED IN DEVICE PIXELS and does not follow the frame, which is `paint -w`'s own
// mode and here it is load-bearing rather than a knob: every pixel this page asserts is at a surface
// coordinate this program chose, so the whole proof holds at dpr 1 and dpr 2 without a ratio in it.
// A surface pixel is not a device pixel and never was (PRD §2) — the page stretches this one.
//
// THE PICTURE IS RETURNED AS DATA, which is `src/bin/paint.mjs`'s `testPattern()` rule and the same
// reason: a check that agreed a list of colours with the program it is checking has asserted that
// two copies of a constant match. `account.pattern` carries the colour this program asked for at
// every point it asks the page to read, so the page restates no colour and no coordinate.

import {
  POLLIN, POLLHUP, POLLERR, POLLNVAL, EINTR, EHOSTGONE,
  WEV_KEY, WEV_DESTROYED, WEV_CLOSE,
  DL_CLEAR, DL_FILL_RECT,
  DOBJ_BITMAP, DOBJ_TEXT, O_RDONLY,
  encodeBlit, encodeBitmap, BITMAP_HEADER,
  keyBytesOf,
} from "/src/abi.mjs";

const NAME = "m23blit";

/** The pinned surface, DEVICE px. Wide enough that the refused batch's rectangle is nowhere near
 *  the two pictures: a clause asserting "the refused fill did not appear" must not be able to read
 *  a pixel something else drew. */
const SURF_W = 320;
const SURF_H = 200;

/** The window's frame, CSS px. It only has to be big enough to show a surface the page stretches
 *  into it; the proof reads the BACKING STORE and not the frame. */
const WIN_W = 320;
const WIN_H = 200;

const POLL_MS = 200;
/** A parked window outlives a nine-clause read but reaps itself if the driver walks away. The page
 *  quits it with a key; this is what happens when nothing does. */
const CEILING_MS = 300000;

/* ---- the picture, as numbers this file owns ---------------------------------------------------- */

/** `0xRRGGBBAA`, which is the only encoding of a colour in this system (`unpackColor`). */
const PAPER = 0x0b0d11ff;

/** THE FOUR QUADRANTS OF THE KNOWN BITMAP, and they are four rather than one for two reasons. A
 *  single-colour payload cannot say which way up it was drawn — a blit that transposed or mirrored
 *  its rows would read identical — and it cannot say the extent is the PAYLOAD'S: four colours in
 *  four corners pin the orientation and both edges at once. */
const TL = 0x4a9bd8ff;
const TR = 0xd87a4aff;
const BL = 0x9fd4a8ff;
const BR = 0xd8d14aff;

/** The side of the known bitmap, in payload pixels. EVEN, so the quadrants are exact. */
const BMP_SIDE = 8;

/** WHERE THE TWO PICTURES GO, surface px. Chosen clear of each other and of the refused rectangle;
 *  the page does not read these, it reads the `DL_BLIT` op's own `a0`/`a1`. */
const BLIT_X = 16;
const BLIT_Y = 16;
const OVER_X = 16;
const OVER_Y = 48;

/** THE TRANSLUCENT PAYLOAD AND THE OPAQUE GROUND IT IS DRAWN OVER.
 *
 *  THIS IS THE HALF OF CONSTRAINT 224 A THUMBNAIL CANNOT REACH. Every payload `src/bin/files.mjs`
 *  makes is opaque, so nothing in the product distinguishes a renderer that COMPOSITES a blit from
 *  one that overwrites — and `putImageData`, which is the obvious way to put a payload on a canvas,
 *  overwrites: it ignores the clip, the transform, the alpha and the composite
 *  (`src/wm/surface.mjs`). A half-alpha payload over a known ground is the one reading that tells
 *  those two renderers apart, and the expected colour is arithmetic the page does rather than a
 *  fifth constant here. */
const OVER_SIDE = 4;
const OVER_GROUND = 0xf2f4f8ff;
const OVER_SRC = 0x4a9bd880;

/** THE REFUSED BATCH'S RECTANGLE, surface px. A fill the kernel must never forward, because it
 *  travels in the same `win_draw` as a blit naming an fd that holds no bitmap. `win_draw` refuses a
 *  batch WHOLE (constraint 293's rule for a text run, applied to a payload), so the clause is that
 *  this rectangle is still PAPER. */
const REFUSED_X = 240;
const REFUSED_Y = 16;
const REFUSED_SIDE = 32;
const REFUSED_INK = 0xd84a7aff;

/** An fd no process has. Above `DOBJ_CAP` and above any fd a program with one window, one file and
 *  three data objects could have been given. */
const NO_SUCH_FD = 4096;

/** The file whose fd is not a data object. A READ-ONLY data row of the provider mount, so the
 *  attempt costs nothing and the path exists on every boot (`src/kernel/providerfs.mjs`). */
const NOT_A_DATA_OBJECT = "/usr/share/readme.txt";

/* ---- the bitmaps ------------------------------------------------------------------------------ */

/**
 * THE KNOWN BITMAP, and the points the page is asked to read it at.
 *
 * Answers `{ bytes, samples, outside }`. A sample is an offset INSIDE the payload plus the colour
 * that is there; `outside` is one pixel past the payload's bottom-right corner, which must still be
 * the clear colour — the renderer draws `BMP_W` x `BMP_H` surface pixels and scales nothing, so a
 * renderer that stretched a payload to a cell would paint it.
 */
function knownBitmap() {
  const side = BMP_SIDE;
  const half = side / 2;
  const px = new Uint8Array(side * side * 4);
  const quadrant = (x, y) => (y < half ? (x < half ? TL : TR) : (x < half ? BL : BR));
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const rgba = quadrant(x, y);
      const at = (y * side + x) * 4;
      px[at] = (rgba >>> 24) & 0xff;
      px[at + 1] = (rgba >>> 16) & 0xff;
      px[at + 2] = (rgba >>> 8) & 0xff;
      px[at + 3] = rgba & 0xff;
    }
  }
  /* THE CORNERS AND THE FOUR PIXELS AROUND THE CENTRE. The corners are what say the payload was
   * drawn whole and the right way up; the centre four are what say the quadrant boundary is where
   * the payload puts it and not half a pixel over. */
  const samples = [];
  for (const [x, y] of [[0, 0], [side - 1, 0], [0, side - 1], [side - 1, side - 1],
    [half - 1, half - 1], [half, half - 1], [half - 1, half], [half, half]]) {
    samples.push({ dx: x, dy: y, rgba: quadrant(x, y) });
  }
  return {
    bytes: encodeBitmap(side, side, px),
    w: side,
    h: side,
    samples,
    outside: { dx: side, dy: side, rgba: PAPER },
  };
}

/** THE TRANSLUCENT PAYLOAD: one colour, one alpha, every pixel. The ground under it is a fill in
 *  the same batch, so the composite is a fact about this frame and not about whatever was there. */
function translucentBitmap() {
  const side = OVER_SIDE;
  const px = new Uint8Array(side * side * 4);
  for (let i = 0; i < side * side; i += 1) {
    px[i * 4] = (OVER_SRC >>> 24) & 0xff;
    px[i * 4 + 1] = (OVER_SRC >>> 16) & 0xff;
    px[i * 4 + 2] = (OVER_SRC >>> 8) & 0xff;
    px[i * 4 + 3] = OVER_SRC & 0xff;
  }
  return { bytes: encodeBitmap(side, side, px), w: side, h: side };
}

/* ---- the program ------------------------------------------------------------------------------ */

/** One data object holding one payload, or a `{ why }`. The fd is the thing a blit names. */
function objectWith(env, formats, format, bytes) {
  const made = env.data.create(formats);
  if (typeof made === "number") return { why: `dataobj_create: ${env.std.errnoName(made)}` };
  if (bytes === null) return { fd: made.fd, offer: made.offer };
  const set = env.data.set(made.fd, format, bytes);
  if (set < 0) {
    env.fs.close(made.fd);
    return { why: `dataobj_set: ${env.std.errnoName(set)}` };
  }
  return { fd: made.fd, offer: made.offer };
}

export async function run(env) {
  const argv = (env.argv || []).map(String);
  const noRefusals = argv.includes("--no-refusals");
  /** Exit as soon as the picture is sent, instead of parking. See `--once` in the header. */
  const once = argv.includes("--once");
  /** Whether the EBADMSG attempt's payload is TORN. The flag names the world it builds, so the
   *  default reads as the shipped one. */
  const tornPayload = !argv.includes("--whole-payload");
  const t0 = performance.now();

  const account = {
    program: NAME,
    win: 0,
    fd: 0,
    surface: { w: SURF_W, h: SURF_H },
    /* THE PICTURE AND THE POINTS TO READ IT AT, published for the page. `paint`'s `testPattern()`
     * rule: the check derives what it expects from this rather than agreeing a list with the
     * program it is checking. */
    pattern: null,
    /* EVERY REFUSAL ATTEMPTED, in order, with the errno NAME it was answered and the one it owed.
     * A single "it refused" passes for a refusal for the wrong reason (CLAUDE.md), so each row
     * carries both names and the page asserts them one clause each. */
    refusals: [],
    /* THE BATCH THAT MUST HAVE BEEN REFUSED WHOLE: a good fill and a bad blit in one `win_draw`. */
    wholeBatch: null,
    batches: 0,
    blitOps: 0,
    controls: { noRefusals, wholePayload: !tornPayload, once },
    why: "",
    quitBy: "",
    ms: 0,
  };
  const fail = (why, exit = 4) => {
    account.why = why;
    account.ms = performance.now() - t0;
    env.std.warn(env, `${NAME}: ${why}\n`);
    return { exit, ...account };
  };

  const made = env.win.create({ title: `${NAME} — a known bitmap`, w: WIN_W, h: WIN_H });
  if (typeof made === "number") return fail(`win_create: ${env.std.errnoName(made)}`);
  account.win = made.win;
  account.fd = made.fd;

  const surfaced = env.win.surface(made.fd, SURF_W, SURF_H);
  if (surfaced < 0) {
    env.win.destroy(made.fd);
    return fail(`win_surface: ${env.std.errnoName(surfaced)}`);
  }

  /* THE SURFACE IS CLEARED FIRST AND ON ITS OWN, so the refused batch below has a known ground to
   * have failed to change. A clear in the same batch as the refusal would be refused with it. */
  const cleared = env.win.draw(made.fd, [{ op: DL_CLEAR, a0: PAPER }]);
  if (cleared < 0) {
    env.win.destroy(made.fd);
    return fail(`win_draw clear: ${env.std.errnoName(cleared)}`);
  }
  account.batches += 1;

  const known = knownBitmap();
  const over = translucentBitmap();

  /* ---- every way a blit can be refused ------------------------------------------------------ */

  /** One attempt: draw a batch whose only op is a blit naming `fd`, and record what came back. */
  const attempt = (what, want, fd) => {
    const r = env.win.draw(made.fd, [encodeBlit(fd, BLIT_X, BLIT_Y)]);
    account.refusals.push({
      what,
      fd,
      want,
      got: r < 0 ? env.std.errnoName(-r) : "0",
      errno: r < 0 ? -r : 0,
    });
    return r;
  };

  if (!noRefusals) {
    attempt("no such fd", "EBADF", NO_SUCH_FD);
    /* A NEGATIVE FD IS ITS OWN ROW, because `a2` is unsigned in the record and `blitFdOf` is the
     * one reader that restores the sign (`src/abi.mjs`). A kernel reading `a2` raw would resolve
     * fd 4294967295 and answer EBADF for the wrong reason — the same answer, and a different
     * defect. The page asserts the ARGUMENT came back signed out of `blitFdOf`. */
    attempt("a negative fd", "EBADF", -1);

    const file = env.fs.open(NOT_A_DATA_OBJECT, O_RDONLY);
    if (file < 0) {
      account.refusals.push({
        what: "not a data object", fd: 0, want: "EINVAL",
        got: `open: ${env.std.errnoName(file)}`, errno: 0,
      });
    } else {
      attempt("not a data object", "EINVAL", file);
      env.fs.close(file);
    }

    const texty = objectWith(env, [DOBJ_TEXT], DOBJ_TEXT, new TextEncoder().encode("not a picture"));
    if (texty.why) {
      account.refusals.push({
        what: "never offered a bitmap", fd: 0, want: "ENOTSUP", got: texty.why, errno: 0,
      });
    } else {
      attempt("never offered a bitmap", "ENOTSUP", texty.fd);
      env.fs.close(texty.fd);
    }

    const empty = objectWith(env, [DOBJ_BITMAP], DOBJ_BITMAP, null);
    if (empty.why) {
      account.refusals.push({
        what: "offered and never written", fd: 0, want: "ENOENT", got: empty.why, errno: 0,
      });
    } else {
      attempt("offered and never written", "ENOENT", empty.fd);
      env.fs.close(empty.fd);
    }

    /* THE PAYLOAD WHOSE BYTES CONTRADICT ITS OWN HEADER. The header says 4x4 and the payload is
     * eight bytes short of one row of it, which `decodeBitmap` refuses on an EXACT length — so this
     * is the one refusal the kernel can only reach by decoding, and the one `--short-payload`
     * removes by writing a whole bitmap instead. The kernel learns nothing about image formats
     * here: `decodeBitmap` checks a header against a length. */
    const bad = tornPayload
      ? known.bytes.subarray(0, BITMAP_HEADER + 4 * 4 * 4 - 8)
      : known.bytes;
    const torn = objectWith(env, [DOBJ_BITMAP], DOBJ_BITMAP, bad);
    if (torn.why) {
      account.refusals.push({
        what: "a payload that is not a bitmap", fd: 0, want: "EBADMSG", got: torn.why, errno: 0,
      });
    } else {
      /* THE WHOLE-BATCH CLAUSE RIDES THIS SAME FD, and that is the cheapest honest way to ask it:
       * one batch, a fill the page can see and a blit the kernel must refuse. If the fill appears,
       * the batch was validated op by op and something was drawn before the refusal. */
      const r = env.win.draw(made.fd, [
        { op: DL_FILL_RECT, a0: REFUSED_X, a1: REFUSED_Y, a2: REFUSED_SIDE, a3: REFUSED_SIDE,
          a4: REFUSED_INK },
        encodeBlit(torn.fd, BLIT_X, BLIT_Y),
      ]);
      account.wholeBatch = {
        at: { x: REFUSED_X, y: REFUSED_Y, w: REFUSED_SIDE, h: REFUSED_SIDE },
        ink: REFUSED_INK,
        paper: PAPER,
        want: "EBADMSG",
        got: r < 0 ? env.std.errnoName(-r) : "0",
        errno: r < 0 ? -r : 0,
      };
      account.refusals.push({
        what: "a payload that is not a bitmap",
        fd: torn.fd,
        want: "EBADMSG",
        got: r < 0 ? env.std.errnoName(-r) : "0",
        errno: r < 0 ? -r : 0,
      });
      env.fs.close(torn.fd);
    }
  }

  /* ---- the two pictures --------------------------------------------------------------------- */

  const good = objectWith(env, [DOBJ_BITMAP], DOBJ_BITMAP, known.bytes);
  if (good.why) {
    env.win.destroy(made.fd);
    return fail(`the known bitmap: ${good.why}`);
  }
  const alpha = objectWith(env, [DOBJ_BITMAP], DOBJ_BITMAP, over.bytes);
  if (alpha.why) {
    env.win.destroy(made.fd);
    return fail(`the translucent bitmap: ${alpha.why}`);
  }

  /* ONE BATCH, so the ground and the picture over it cannot be two frames: a composite asserted
   * across two repaints would be asserting that the first one happened. */
  const drew = env.win.draw(made.fd, [
    encodeBlit(good.fd, BLIT_X, BLIT_Y),
    { op: DL_FILL_RECT, a0: OVER_X, a1: OVER_Y, a2: OVER_SIDE, a3: OVER_SIDE, a4: OVER_GROUND },
    encodeBlit(alpha.fd, OVER_X, OVER_Y),
  ]);
  if (drew < 0) {
    env.win.destroy(made.fd);
    return fail(`win_draw the pattern: ${env.std.errnoName(drew)}`);
  }
  account.batches += 1;
  account.blitOps += 2;
  account.pattern = {
    clear: PAPER,
    /* THE EXTENT IS THE PAYLOAD'S, which is the whole of why `DL_BLIT` carries no destination
     * width or height: a caller wanting a 32x32 picture decodes at 32x32. The page reads the
     * DESTINATION off the op it tapped and the EXTENT off this row, so neither is restated. */
    blit: { at: { x: BLIT_X, y: BLIT_Y }, w: known.w, h: known.h,
      samples: known.samples, outside: known.outside },
    over: { at: { x: OVER_X, y: OVER_Y }, w: over.w, h: over.h,
      ground: OVER_GROUND, src: OVER_SRC },
  };

  env.std.say(env, `${NAME}: win ${made.win}, surface ${SURF_W}x${SURF_H} (pinned), `
    + `${known.w}x${known.h} known bitmap at ${BLIT_X},${BLIT_Y}, `
    + `${account.refusals.length} refusal(s) attempted\n`);
  env.std.say(env, `${NAME}: q quits. The window parks until something does.\n`);

  /* ---- park, so the pixels are still there when the page looks ------------------------------ */

  for (; !once;) {
    if (performance.now() - t0 > CEILING_MS) {
      account.quitBy = `ceiling ${CEILING_MS} ms`;
      break;
    }
    const r = env.tty.poll([{ fd: made.fd, events: POLLIN }], POLL_MS);
    if (typeof r === "number") {
      if (r === -EINTR) continue;
      account.quitBy = `poll: ${env.std.errnoName(r)}`;
      break;
    }
    const rev = r.fds[0].revents;
    if (rev & (POLLHUP | POLLERR | POLLNVAL)) {
      account.quitBy = "the window hung up";
      break;
    }
    if (!(rev & POLLIN)) continue;
    const evs = env.win.read(made.fd, 64);
    if (typeof evs === "number") {
      if (evs === -EHOSTGONE) { account.quitBy = "the window was destroyed"; break; }
      if (evs < 0 && evs !== -EINTR) {
        account.quitBy = `read: ${env.std.errnoName(evs)}`;
        break;
      }
      continue;
    }
    let done = "";
    for (const ev of evs) {
      if (ev.type === WEV_DESTROYED) { done = "the window was destroyed"; break; }
      if (ev.type === WEV_CLOSE) { done = "a close request"; break; }
      if (ev.type !== WEV_KEY) continue;
      const bytes = keyBytesOf(ev);
      if (bytes.length > 0 && (bytes[0] === 0x71 || bytes[0] === 0x51)) { done = "q"; break; }
    }
    if (done) { account.quitBy = done; break; }
  }

  /* THE OBJECTS GO BEFORE THE WINDOW, which is an ordering and not a tidy-up: a data object's
   * payload is released on the last close of its description (constraint 241), and a blit naming a
   * closed fd is a batch refused -EBADF — so a repaint between these two lines would be a window
   * that stopped repainting. There is no repaint here, and that is why the order is stated. */
  if (once) account.quitBy = "--once";
  env.fs.close(good.fd);
  env.fs.close(alpha.fd);
  env.win.destroy(made.fd);
  account.ms = performance.now() - t0;
  return { exit: 0, ...account };
}
