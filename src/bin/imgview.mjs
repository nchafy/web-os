// `imgview`: a window you can DROP an image into, or paste one into.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// THE OTHER HALF OF M10's HEADLINE (`files` is the first). It is the receiver, and a receiver is
// where a typed clipboard either works or is exposed:
//
//   imgview            a window that waits for a drop
//   imgview -p         paste from the clipboard at once, then wait
//   imgview -f path    show a file, which is what a double-click on a desktop icon means
//   press v            paste from the clipboard at any time
//   drop a row on it   from `files`, or from anything else that offers one of the formats below
//   --no-resurface     R34's NEGATIVE CONTROL. See `run`.
//
// WHAT IT ACCEPTS, in order of preference: a BITMAP, which it draws; a PNG, whose header it reads
// and reports; and nothing else. A PATH LIST IS NOT AN IMAGE and this program says so out loud —
// which is the whole claim. `PLAN.md` §5's negative control for M10 is "offer only the text format;
// the image paste must fail cleanly, not silently paste a path", and the thing that must not happen
// is this window rendering a filename as a picture (constraint 247).
//
// IT DOES NOT DECODE PNG, and that is stated rather than hidden. There is no decoder in this system
// and a display list has no image op (M8), so the PNG is proof that OPAQUE BYTES of a format
// nothing here understands cross two processes untouched — its header is read, its size reported,
// and the picture a reader sees comes from the BITMAP, which is the one image format fill-rects can
// draw.
//
// M16/R34: A BIGGER WINDOW IS A BIGGER PICTURE, NOT A STRETCHED ONE. A reader reported that
// "expanding just expands a png", which is a CSS stretch of a backing store that never changed:
// the surface was asked for once, at 200x200, and a client area of any other size got it
// interpolated. So this program answers `WEV_CLIENT` by re-asking for a surface at the measured
// client box and re-rendering — `drawnBox` recomputes the integer scale from the new extent and
// re-centres — and it keeps the DECODED bitmap to re-render FROM. The decoded copy is why a
// resize still works after the source process was killed or the clipboard was replaced: the
// payload is kernel-owned and released when the fd closes (constraint 241), so re-opening the
// object is not a route a resize can rely on.

import {
  POLLIN, POLLHUP, POLLERR, POLLNVAL, EINTR, EINVAL, EHOSTGONE,
  WEV_KEY, WEV_CLOSE, WEV_DESTROYED, WEV_RESIZE, WEV_FOCUS, WEV_POINTER, WEV_CLIENT,
  WEV_DRAG_ENTER, WEV_DRAG_LEAVE, WEV_DROP,
  DL_CLEAR, DL_FILL_RECT, DL_STROKE_RECT,
  DOBJ_BITMAP, DOBJ_PNG,
  DOBJ_WHERE_CLIPBOARD, DOBJ_WHERE_DROP,
  decodeBitmap, fmtBit, fmtsOf, fmtName, keyBytesOf,
} from "/src/abi.mjs";

const NAME = "imgview";

const POLL_MS = 200;
const CEILING_MS = 300000;

/**
 * THE FIRST SURFACE REQUEST, in DEVICE pixels, and it is a guess that lasts one frame.
 *
 * A program has no device-pixel ratio until its first `WEV_CLIENT` (PRD §2: the only dpr channel
 * runs page -> kernel), and the client box is MEASURED page-side, so there is nothing here to
 * derive a correct first request from. Modelling one from `WIN_CAP_H`/`WIN_INSET` is what §2
 * forbids. So this asks for a square store, draws into it, and the first client event corrects
 * both the extent and the scale. What a reader sees in that gap is a stretch, which is also what
 * Windows 7 shows mid-drag — the defect R34 names is the stretch that never ends.
 */
const FIRST_SURFACE_W_DEV = 200;
const FIRST_SURFACE_H_DEV = 200;

/** The frame, the band and the stroke, in CSS pixels — a layout constant's unit (PRD §2). Every
 *  one of them is multiplied by the live surface scale on the way into a display list, whose
 *  coordinates are SURFACE pixels (constraint 223). */
const INSET_CSS = 4;
const STROKE_CSS = 2;
const BAND_H_CSS = 24;

const PAPER = 0x0b0d11ff;
const FRAME = 0x3a3f48ff;
/** The colour of a REFUSAL. A reader must be able to tell "nothing arrived" from "something
 *  arrived that I cannot show", and those are the two things this window can be. */
const REFUSED = 0xd84a7aff;
/** And of a target that is being dragged over, which is the only feedback a drag has from inside
 *  the receiving process. */
const HOVER = 0xd8d14aff;

/**
 * THE MOST PIXELS THIS PROGRAM WILL DRAW, because every one of them is a FILL_RECT.
 *
 * A display list has no image op, so a bitmap is drawn pixel by pixel and `DL_MAX_OPS` bounds a
 * batch. 1,024 is 32x32, which the libos sends in one call. A larger bitmap is REPORTED AND NOT
 * DRAWN — refusing to draw is honest, and silently drawing the first thousand pixels of it would be
 * a picture that is wrong without saying so.
 *
 * IT BOUNDS THE SOURCE, AND R34 ADDS NO SECOND CEILING FOR THE BOX. `drawnBox` absorbs the client
 * extent into `scale`, so the op count is `bmp.w * bmp.h` whatever the window becomes — a
 * "box too large to draw" refusal here could never fire, and a refusal its own arithmetic makes
 * unreachable is the live-looking-button defect in clause form (PRD §5, R34). The ceiling a box
 * really meets is `SURFACE_MAX_PX`, on the `win_surface` call, and it arrives as the `-EINVAL`
 * that `std.resurface` reports.
 */
const MAX_DRAW_PX = 1024;

/**
 * WHERE A BITMAP LANDS IN A SURFACE: the integer scale, and the centred rectangle it fills. All
 * four numbers are SURFACE pixels; `scale` is surface pixels per SOURCE pixel.
 *
 * AN INTEGER FACTOR AND NOT A FIT. A half-pixel scale on a nearest-neighbour blit is a picture
 * with a seam in it, so the image is never stretched to the box — it grows in whole source pixels
 * and the remainder stays as margin. A box narrower than the source therefore centres NEGATIVELY
 * and the canvas clips, which `clampBox`'s `MIN_W`/`MIN_H` floors keep unreachable.
 *
 * EXPORTED BECAUSE THREE READERS OUTSIDE THIS PROCESS ALREADY RESTATE IT. `www/m10.html:244`,
 * `:375` and `bench/m10-data/shell.py`'s `pixel_expr` each compute `Math.floor(c.width / 16)` to
 * find the logo's corner pixel, and all three divide the WIDTH on both axes — correct only while
 * the surface is square, which is exactly what R34 stops being true. A page or a driven page can
 * import this module (the `FILES_METRICS` precedent in CLAUDE.md), so the arithmetic has one home.
 *
 * THE SIZE PAIR A HARNESS MUST DRIVE, named here because `docs/PRD-SHELL.md` §Residual 3 records
 * that nothing named one. For a square source of side `n` the extent along the limiting axis is
 * `n * floor(min(w,h) / n)` — `min(w,h)` floored to a multiple of `n`. **So the extent changes
 * only when the limiting client dimension crosses a multiple of `n` device pixels**, and a smaller
 * resize can leave it identical. `/usr/share/logo.rgba` is 16x16 (1,032 bytes = 8 + 16*16*4), so,
 * read out of this function:
 *
 *   client 496x448 device px  ->  scale 28, extent 448x448   448 = 16 * 28, an exact boundary
 *   client 496x464 device px  ->  scale 29, extent 464x464   one step up
 *   client 496x460 device px  ->  scale 28, extent 448x448   NO CHANGE. A 12 px grow from an
 *                                                            exact boundary asserts nothing —
 *                                                            Residual 3's vacuous pass, as a
 *                                                            size pair
 *
 * A grow of `n` or more device px in the limiting axis ALWAYS crosses a multiple of `n`, so it is
 * the only step a harness can pick without knowing where in the band it started. In CSS pixels
 * that is `n / dpr`: 8 at dpr 2, 16 at dpr 1. Height limits in all three rows, so growing the
 * frame's height by 8 CSS px at dpr 2 moves the extent and growing it by 4 may not.
 *
 * **The boxes above are what the PROGRAM is told, not a frame size.** The client box is measured
 * page-side (PRD §2), so a harness MUST read the extent back — from the surface report, or by
 * calling this function with the box it read — and MUST NOT model a frame height from them.
 */
export function drawnBox(src, extent) {
  const scale = Math.max(1, Math.floor(Math.min(extent.w / src.w, extent.h / src.h)));
  const w = src.w * scale;
  const h = src.h * scale;
  return { scale, w, h, x: Math.floor((extent.w - w) / 2), y: Math.floor((extent.h - h) / 2) };
}

function unInterrupted(call) {
  const first = call();
  if (first !== -EINTR) return first;
  return call();
}

/**
 * A PNG's declared size, from its signature and IHDR, or null.
 *
 * THIS IS NOT A DECODER and must not grow into one. The 8-byte signature, then a length, then the
 * four bytes `IHDR`, then two big-endian u32s: enough to say "this really is a PNG and it is 16x16",
 * which is what a receiver needs to report that the bytes arrived intact. Format from the PNG
 * specification, https://www.w3.org/TR/png-3/#5PNG-file-signature.
 */
export function pngSize(bytes) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!bytes || bytes.length < 24) return null;
  for (let i = 0; i < SIG.length; i += 1) if (bytes[i] !== SIG[i]) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== "IHDR") return null;
  return { w: dv.getUint32(16, false), h: dv.getUint32(20, false) };
}

export function run(env) {
  const argv = (env.argv || []).map(String);
  /* `--no-resurface` IS A NEGATIVE CONTROL AND NOTHING ELSE: it drains a `WEV_CLIENT` and ignores
   * it, which is this program before M16. R34's clause is that the drawn extent differs at two
   * client sizes, and this is the world where it does not — while R1's clause, that the canvas
   * fills its client box, still holds, because the fill is the renderer's (`src/wm/surface.mjs`).
   * Two causes, two controls, and a control satisfied by either would verify neither. A shipped
   * flag rather than a source mutation so the control is re-runnable and scored, which is
   * `scripts/serve.py --no-isolation`'s precedent.
   *
   * IT IS STRIPPED BEFORE `getopt`, which knows single letters only — a `--no-resurface` reaching
   * it is refused as an unknown `-`. `--` still ends the options. The loop is
   * `src/bin/files.mjs:215-222`'s, taken in turn from `src/bin/term.mjs`'s `--title`. */
  let frozenSurface = false;
  const rest = [];
  let endOfOptions = false;
  for (const arg of argv.slice(1)) {
    if (!endOfOptions) {
      if (arg === "--") { endOfOptions = true; rest.push(arg); continue; }
      if (arg === "--no-resurface") { frozenSurface = true; continue; }
    }
    rest.push(arg);
  }
  const { flags, bad, why: badWhy } = env.std.getopt(rest, "pf:");
  if (bad) {
    return { exit: env.std.complain(env, NAME, bad, badWhy, env.std.EXIT_USAGE), program: NAME };
  }
  const t0 = performance.now();
  const account = {
    program: NAME, win: 0, fd: 0, enters: 0, leaves: 0, drops: 0, pastes: 0, opened: "",
    shown: [], refusals: [], why: "",
    // M16/R34. `clients` counts the records drained, `resurfaced` the calls made: they differ by
    // the batches `lastClientEvent` collapsed, which is the only evidence this side holds that the
    // collapse happened at all. `extents` is R34's assertion as data — see `logExtent`.
    clients: 0, resurfaced: 0, repaints: 0, surfaceRefused: [],
    extents: [], extentRows: 0,
  };

  const made = env.win.create({
    title: `${NAME} — drop an image here`, w: 260, h: 260, x: 380, y: 40,
  });
  if (typeof made === "number") {
    return { exit: 2, ...account, why: `win_create: ${env.std.errnoName(made)}`, errno: -made };
  }
  account.win = made.win;
  account.fd = made.fd;
  const surf = env.win.surface(made.fd, FIRST_SURFACE_W_DEV, FIRST_SURFACE_H_DEV);
  if (surf < 0) {
    env.win.destroy(made.fd);
    return { exit: 3, ...account, why: `win_surface: ${env.std.errnoName(surf)}`, errno: -surf };
  }

  /** THE BACKING STORE THIS PROGRAM HOLDS, in SURFACE pixels, and the factor from its CSS-px
   *  layout constants. `scale` is 1 until the first `WEV_CLIENT` for the reason
   *  `FIRST_SURFACE_*_DEV` states; afterwards it is the dpr, because `std.resurface` asks for
   *  exactly the client box in device px and that is what makes one factor enough. */
  const store = { w: FIRST_SURFACE_W_DEV, h: FIRST_SURFACE_H_DEV, scale: 1 };

  /**
   * WHAT IS ON SCREEN, so a client-box change can re-render it (R34).
   *
   * Without this record a resize has nothing to draw and the old backing store is all a reader
   * gets, CSS-stretched — which is the reported bug. It holds the DECODED bitmap and not the data
   * object's fd: the payload is kernel-owned and released when that fd closes (constraint 241), so
   * by the time a resize arrives the clipboard may hold something else and the drag's source
   * process may be dead. A copy in this process is the only thing a re-render can rest on.
   *
   * Every painter below assigns it, and `repaint` is its only other reader. The invariant is that
   * `view` equals the pixels — a painter that drew without assigning would re-render as whatever
   * came before.
   */
  let view = { kind: "empty", edge: FRAME };

  /** One CSS-px length in SURFACE pixels. A stroke rounded to zero draws nothing, so the frame
   *  would vanish rather than thin — hence the floor of 1 for a width. */
  const px = (css) => Math.round(css * store.scale);
  const lineW = () => Math.max(1, px(STROKE_CSS));

  const frameOp = (edge) => {
    const i = px(INSET_CSS);
    return {
      op: DL_STROKE_RECT,
      a0: i, a1: i, a2: store.w - 2 * i, a3: store.h - 2 * i, a4: edge, a5: lineW(),
    };
  };

  const paintEmpty = (edge = FRAME) => {
    view = { kind: "empty", edge };
    account.repaints += 1;
    return env.win.draw(made.fd, [{ op: DL_CLEAR, a0: PAPER }, frameOp(edge)]);
  };

  /** THE REFUSAL, AS PIXELS. A band a reader cannot mistake for a picture: the window says "I was
   *  given something and it was not an image", which is what must happen instead of a path being
   *  rendered as one. */
  const paintRefusal = () => {
    view = { kind: "refused" };
    account.repaints += 1;
    const i = px(INSET_CSS);
    const band = px(BAND_H_CSS);
    return env.win.draw(made.fd, [
      { op: DL_CLEAR, a0: PAPER },
      {
        op: DL_FILL_RECT, a0: i, a1: Math.round(store.h / 2 - band / 2),
        a2: store.w - 2 * i, a3: band, a4: REFUSED,
      },
      frameOp(REFUSED),
    ]);
  };

  const refuse = (why) => {
    account.refusals.push(why);
    paintRefusal();
    env.std.warn(env, `${NAME}: ${why}\n`);
  };

  /**
   * R34's EVIDENCE, AS DATA. A harness reading pixels can see the extent; it cannot see whether
   * the extent it sees is the one the program meant, and `account.extents` is where the two meet.
   *
   * ONE ROW PER DISTINCT (EXTENT, STORE) PAIR. The store is part of the key and not decoration: a
   * resize that moved the backing store without moving the extent is `drawnBox`'s own warning
   * about a sub-`n` grow, and a key of the extent alone would hide it — which is the vacuous pass
   * this log exists to make visible. Consecutive duplicates are dropped because a repaint that
   * changed neither is not evidence of anything.
   *
   * THE CAP DROPS ROWS AND NEVER THE COUNT. Reports arrive per animation frame, so an uncapped log
   * grows without bound inside a five-minute ceiling; `extentRows` stays exact so a reader can see
   * that the list is a prefix.
   */
  const MAX_EXTENT_LOG = 16;
  const logExtent = (box) => {
    const row = {
      w: box.w, h: box.h, scale: box.scale, storeW: store.w, storeH: store.h,
    };
    const last = account.extents[account.extents.length - 1];
    if (last && last.w === row.w && last.h === row.h
      && last.storeW === row.storeW && last.storeH === row.storeH) return;
    account.extentRows += 1;
    if (account.extents.length < MAX_EXTENT_LOG) account.extents.push(row);
  };

  /** Draw a bitmap, ONE FILL_RECT PER PIXEL, at the integer scale `drawnBox` computes from the
   *  CURRENT store. Re-reading `store` on every call is what makes a re-render a re-render: the
   *  scale and the centring are recomputed, never carried over from the size that was granted
   *  first (R34). */
  const drawBitmap = (bmp) => {
    const at = drawnBox(bmp, store);
    const ops = [{ op: DL_CLEAR, a0: PAPER }];
    for (let y = 0; y < bmp.h; y += 1) {
      for (let x = 0; x < bmp.w; x += 1) {
        const i = (y * bmp.w + x) * 4;
        // 0xRRGGBBAA, which is the one colour encoding in this ABI. `>>> 0` because the alpha bit
        // makes it negative as an i32 and `src/abi.mjs` reads the colour slot unsigned.
        const rgba = ((bmp.pixels[i] << 24) | (bmp.pixels[i + 1] << 16)
          | (bmp.pixels[i + 2] << 8) | bmp.pixels[i + 3]) >>> 0;
        ops.push({
          op: DL_FILL_RECT,
          a0: at.x + x * at.scale, a1: at.y + y * at.scale, a2: at.scale, a3: at.scale, a4: rgba,
        });
      }
    }
    const r = env.win.draw(made.fd, ops);
    if (r < 0) return r;
    view = { kind: "bitmap", bmp };
    account.repaints += 1;
    logExtent(at);
    return ops.length;
  };

  /** RE-RENDER WHAT IS ON SCREEN at the size the store is now. Three kinds, one per painter, and
   *  the default is the empty frame rather than a silent return: a `view` this does not recognise
   *  would otherwise leave a stretched canvas, which is the bug. */
  const repaint = () => {
    if (view.kind === "bitmap") return drawBitmap(view.bmp);
    if (view.kind === "refused") return paintRefusal();
    return paintEmpty(view.edge);
  };

  paintEmpty();

  /**
   * Show one object, by asking for the formats this program can use — IN ORDER OF PREFERENCE, and
   * refusing by name when none of them is there.
   *
   * THE ORDER IS THE POINT. A receiver asks for what it can USE rather than taking what it is
   * given: bitmap first because it can be drawn, then PNG because its arrival can be proved, and a
   * path list is not an image however much the object also carries one.
   */
  const show = (objFd, offer, source) => {
    const offered = fmtsOf(offer);
    const row = { source, offered: offered.map(fmtName) };
    if (offer & fmtBit(DOBJ_BITMAP)) {
      const got = env.data.get(objFd, DOBJ_BITMAP);
      /* EVERY PATH BELOW FALLS THROUGH TO THE ONE `account.shown.push(row)`, and the two that
       * returned early did not — a critic found it. A bitmap offered but never written (-ENOENT),
       * or one whose header lies about its size, refused correctly and then left NO ROW: the page
       * and the check both read `shown[0]`, so that failure arrived as a missing row or as the
       * PREVIOUS paste's row, with the evidence pointing at the wrong object. A refusal is a
       * result and has to be reported as one. */
      const bmp = typeof got === "number" ? null : decodeBitmap(got);
      if (typeof got === "number") {
        refuse(`${source}: the bitmap could not be read: ${env.std.errnoName(got)}`);
        row.refused = env.std.errnoName(got);
      } else if (!bmp) {
        // A PAYLOAD THAT LIES ABOUT ITS SIZE IS REFUSED, not clamped: these bytes came from
        // another process (`decodeBitmap` is the one validator).
        refuse(`${source}: ${got.length} bytes are not a whole bitmap`);
        row.refused = "malformed";
      } else {
        row.bitmap = { w: bmp.w, h: bmp.h, bytes: got.length };
        if (bmp.w * bmp.h > MAX_DRAW_PX) {
          refuse(`${source}: ${bmp.w}x${bmp.h} is more than ${MAX_DRAW_PX} fill-rects; `
            + "a display list has no image op");
          row.refused = "too-large";
        } else {
          const ops = drawBitmap(bmp);
          if (ops < 0) {
            refuse(`${source}: win_draw: ${env.std.errnoName(ops)}`);
            row.refused = env.std.errnoName(ops);
          } else {
            row.ops = ops;
            row.drawn = true;
            // THE EXTENT AT THE MOMENT IT WAS DRAWN, in SURFACE px. A resize re-renders and moves
            // it, which `account.extents` records; this is the first entry's origin and the figure
            // a one-shot `-f`/`-p` run reports without ever receiving a client event.
            row.box = drawnBox(bmp, store);
          }
        }
      }
    }
    if (offer & fmtBit(DOBJ_PNG)) {
      const got = env.data.get(objFd, DOBJ_PNG);
      if (typeof got === "number") {
        row.png = { refused: env.std.errnoName(got) };
      } else {
        const size = pngSize(got);
        // THE BYTES ARRIVED INTACT OR THEY DID NOT, and the signature plus IHDR is what says so.
        row.png = size ? { ...size, bytes: got.length } : { bytes: got.length, malformed: true };
        if (!size) refuse(`${source}: ${got.length} bytes are not a PNG`);
      }
    }
    if (!row.bitmap && !row.png) {
      /* THE HEADLINE REFUSAL. The object may well carry a path or a line of text — it is just not
       * an image, and this program will not render one as the other. `-ENOTSUP` is the kernel's own
       * answer for a format an object never offered, and it is asked for ON PURPOSE here so the
       * errno in the report is the kernel's and not this program's opinion. */
      const asked = env.data.get(objFd, DOBJ_BITMAP);
      row.refused = typeof asked === "number" ? env.std.errnoName(asked) : "none";
      refuse(`${source}: no image here — it offers ${row.offered.join(", ") || "nothing"} `
        + `(${row.refused})`);
    }
    account.shown.push(row);
    return row;
  };

  /** Paste: open the clipboard and show it. -ENOENT for an empty clipboard, reported rather than
   *  drawn as an empty picture. */
  const paste = () => {
    const opened = env.data.open(DOBJ_WHERE_CLIPBOARD);
    if (typeof opened === "number") {
      refuse(`paste: the clipboard is ${env.std.errnoName(opened)}`);
      return opened;
    }
    account.pastes += 1;
    try {
      return show(opened.fd, opened.offer, "clipboard");
    } finally {
      env.fs.close(opened.fd);
    }
  };

  /**
   * M14. `-f path`: SHOW A FILE, which is what a double-click on a desktop icon has to mean.
   *
   * IT GOES THROUGH `show`, the same renderer a drop and a paste go through, by making a data
   * object out of the file's bytes under the format its extension names (`std.formatForPath`). So
   * one path renders every image this program ever sees, and a format nothing here can draw is
   * refused BY NAME whether it arrived from a drag, the clipboard or the filesystem — which is the
   * whole of what a typed clipboard bought (constraint 247).
   */
  const openFile = (path) => {
    const format = env.std.formatForPath(path);
    if (!format) {
      refuse(`${path}: no format rule covers this extension`);
      return -EINVAL;
    }
    const body = env.std.readFileBytes(env, path);
    if (typeof body === "number") {
      refuse(`${path}: ${env.std.errnoName(body)}`);
      return body;
    }
    const obj = env.data.create([format]);
    if (typeof obj === "number") {
      refuse(`${path}: dataobj_create: ${env.std.errnoName(obj)}`);
      return obj;
    }
    try {
      const set = env.data.set(obj.fd, format, body);
      if (set < 0) {
        refuse(`${path}: dataobj_set: ${env.std.errnoName(set)}`);
        return set;
      }
      account.opened = path;
      return show(obj.fd, obj.offer, `file ${path}`);
    } finally {
      // THE FD GOES EITHER WAY. The object is refcounted and this process is its only holder, so
      // closing is what frees the payload — a viewer that leaked one per file opened would spend
      // the kernel's whole data budget on pictures it had finished with.
      env.fs.close(obj.fd);
    }
  };

  env.std.say(env, `${NAME}: win ${made.win} on fd ${made.fd}, surface ${store.w}x${store.h} `
    + "device px, resized to the client box when the page reports it\n");
  env.std.say(env, "drop a file on this window, or press v to paste. q quits.\n");
  if (flags.p === true) paste();
  if (typeof flags.f === "string") {
    env.win.setTitle(made.fd, `${NAME} — ${flags.f}`);
    openFile(flags.f);
  }

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
      if (evs !== -EINTR) { account.why = `read: ${env.std.errnoName(evs)}`; break; }
      continue;
    }
    /* THE LAST CLIENT RECORD IN THE BATCH, and the only one worth acting on. `win_surface`
     * destroys and rebuilds a canvas page-side, so re-surfacing per record pays a rebuild for every
     * intermediate size of a drag and throws all but the last away. The kernel already replaces a
     * TAIL client record, so a batch carries more than one only when something arrived between two
     * reports. */
    const client = env.std.lastClientEvent(evs);
    for (const ev of evs) {
      /* `WEV_RESIZE` STILL GOES NOWHERE, and that is not an omission: it carries CELLS of a font a
       * canvas program never renders, and it is suppressed for a resize that changed no cell count
       * (`src/kernel/wins.mjs`) — a resize that changed every pixel here. The client box arrives
       * as `WEV_CLIENT` below and the two must not be conflated. A pointer is discarded
       * because this window has no gesture of its own, so it needs no `std.cssPointAt`. */
      if (ev.type === WEV_RESIZE || ev.type === WEV_FOCUS || ev.type === WEV_POINTER) continue;
      if (ev.type === WEV_CLIENT) {
        account.clients += 1;
        if (frozenSurface || ev !== client) continue;
        const got = env.std.resurface(env, made.fd, ev);
        if (!got.ok) {
          /* THE PREVIOUS SURFACE SURVIVES A REFUSAL, so the store and the scale above are still
           * the truth and MUST be kept — and the picture is not repainted, because a refused
           * resize says nothing about the image. Reported and never retried: `-ENOMEM` is the
           * surface budget and `-EINVAL` a box no window may have, and both are permanent. */
          const name = env.std.errnoName(got.errno);
          account.surfaceRefused.push(`${got.w}x${got.h}: ${name}`);
          env.std.warn(env, `${NAME}: win_surface ${got.w}x${got.h}: ${name}\n`);
          continue;
        }
        account.resurfaced += 1;
        store.w = got.w;
        store.h = got.h;
        store.scale = got.dpr;
        account.surface = { w: got.w, h: got.h, dpr: got.dpr, wCss: got.wCss, hCss: got.hCss };
        /* R34. THE RE-RENDER IS THE REQUIREMENT, not the re-surface. A new backing store that
         * nothing drew into is a blank window; one drawn at the old scale is the stretched png the
         * reader reported, arriving a second way. */
        repaint();
        continue;
      }
      if (ev.type === WEV_DRAG_ENTER) {
        /* THE OFFER ARRIVES WITH THE ENTER, so a target can decide whether it can accept BEFORE
         * the drop and before any bytes exist — which is what a format tag is for. This window
         * shows the user the difference: an amber frame for something it can take, a pink one for
         * something it cannot. */
        account.enters += 1;
        const can = (ev.c & (fmtBit(DOBJ_BITMAP) | fmtBit(DOBJ_PNG))) !== 0;
        account.lastOffer = { offer: ev.c, formats: fmtsOf(ev.c).map(fmtName), accepts: can };
        paintEmpty(can ? HOVER : REFUSED);
        continue;
      }
      if (ev.type === WEV_DRAG_LEAVE) {
        account.leaves += 1;
        paintEmpty();
        continue;
      }
      if (ev.type === WEV_DROP) {
        account.drops += 1;
        const opened = env.data.open(DOBJ_WHERE_DROP, made.fd);
        if (typeof opened === "number") {
          refuse(`drop: nothing to collect: ${env.std.errnoName(opened)}`);
          continue;
        }
        try {
          const row = show(opened.fd, opened.offer, "drop");
          row.at = { x: ev.a, y: ev.b };
        } finally {
          // THE FD IS THE REFERENCE. Closing it releases the payload, which is what gives the
          // budget back (constraint 241).
          env.fs.close(opened.fd);
        }
        continue;
      }
      if (ev.type === WEV_KEY) {
        const bytes = keyBytesOf(ev);
        if (bytes.length !== 1) continue;
        const ch = String.fromCharCode(bytes[0]);
        if (ch === "q") { account.why = "q"; break; }
        if (ch === "v") paste();
        continue;
      }
      if (ev.type === WEV_CLOSE) { account.why = "the window asked to close"; break; }
      if (ev.type === WEV_DESTROYED) { account.why = "the window was destroyed"; break; }
    }
    if (account.why) break;
  }

  const destroyed = env.win.destroy(made.fd);
  account.destroyed = Array.isArray(destroyed) ? destroyed : [];
  account.ms = performance.now() - t0;
  env.std.say(env, `${NAME}: ${account.why}. ${account.drops} drop(s), ${account.pastes} `
    + `paste(s), ${account.refusals.length} refusal(s), ${account.resurfaced} re-surface(s) `
    + `of ${account.clients} client event(s), ${account.extentRows} extent row(s)\n`);
  return { exit: 0, ...account };
}
