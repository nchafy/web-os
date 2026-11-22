// `imgview`: a window you can DROP an image into, or paste one into.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// THE OTHER HALF OF M10's HEADLINE (`files` is the first). It is the receiver, and a receiver is
// where a typed clipboard either works or is exposed:
//
//   imgview            a window that waits for a drop
//   imgview -p         paste from the clipboard at once, then wait
//   press v            paste from the clipboard at any time
//   drop a row on it   from `files`, or from anything else that offers one of the formats below
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

import {
  POLLIN, POLLHUP, POLLERR, POLLNVAL, EINTR, EINVAL, EHOSTGONE,
  WEV_KEY, WEV_CLOSE, WEV_DESTROYED, WEV_RESIZE, WEV_FOCUS, WEV_POINTER,
  WEV_DRAG_ENTER, WEV_DRAG_LEAVE, WEV_DROP,
  DL_CLEAR, DL_FILL_RECT, DL_STROKE_RECT,
  DOBJ_BITMAP, DOBJ_PNG,
  DOBJ_WHERE_CLIPBOARD, DOBJ_WHERE_DROP,
  decodeBitmap, fmtBit, fmtsOf, fmtName, keyBytesOf,
} from "/src/abi.mjs";

const NAME = "imgview";

const POLL_MS = 200;
const CEILING_MS = 300000;

const SURFACE_W = 200;
const SURFACE_H = 200;

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
 */
const MAX_DRAW_PX = 1024;

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
  const { flags, bad, why: badWhy } = env.std.getopt(argv.slice(1), "pf:");
  if (bad) {
    return { exit: env.std.complain(env, NAME, bad, badWhy, env.std.EXIT_USAGE), program: NAME };
  }
  const t0 = performance.now();
  const account = {
    program: NAME, win: 0, fd: 0, enters: 0, leaves: 0, drops: 0, pastes: 0, opened: "",
    shown: [], refusals: [], why: "",
  };

  const made = env.win.create({
    title: `${NAME} — drop an image here`, w: 260, h: 260, x: 380, y: 40,
  });
  if (typeof made === "number") {
    return { exit: 2, ...account, why: `win_create: ${env.std.errnoName(made)}`, errno: -made };
  }
  account.win = made.win;
  account.fd = made.fd;
  const surf = env.win.surface(made.fd, SURFACE_W, SURFACE_H);
  if (surf < 0) {
    env.win.destroy(made.fd);
    return { exit: 3, ...account, why: `win_surface: ${env.std.errnoName(surf)}`, errno: -surf };
  }

  const empty = (edge = FRAME) => env.win.draw(made.fd, [
    { op: DL_CLEAR, a0: PAPER },
    { op: DL_STROKE_RECT, a0: 4, a1: 4, a2: SURFACE_W - 8, a3: SURFACE_H - 8, a4: edge, a5: 2 },
  ]);
  empty();

  /** THE REFUSAL, AS PIXELS. A band a reader cannot mistake for a picture: the window says "I was
   *  given something and it was not an image", which is what must happen instead of a path being
   *  rendered as one. */
  const refuse = (why) => {
    account.refusals.push(why);
    env.win.draw(made.fd, [
      { op: DL_CLEAR, a0: PAPER },
      { op: DL_FILL_RECT, a0: 4, a1: SURFACE_H / 2 - 12, a2: SURFACE_W - 8, a3: 24, a4: REFUSED },
      { op: DL_STROKE_RECT, a0: 4, a1: 4, a2: SURFACE_W - 8, a3: SURFACE_H - 8, a4: REFUSED, a5: 2 },
    ]);
    env.std.warn(env, `${NAME}: ${why}\n`);
  };

  /** Draw a bitmap, ONE FILL_RECT PER PIXEL, scaled by an integer factor so a 16x16 image is
   *  visible. An integer factor and not a fit: a half-pixel scale on a nearest-neighbour blit is a
   *  picture with a seam in it. */
  const drawBitmap = (bmp) => {
    const scale = Math.max(1, Math.floor(Math.min(SURFACE_W / bmp.w, SURFACE_H / bmp.h)));
    const x0 = Math.floor((SURFACE_W - bmp.w * scale) / 2);
    const y0 = Math.floor((SURFACE_H - bmp.h * scale) / 2);
    const ops = [{ op: DL_CLEAR, a0: PAPER }];
    for (let y = 0; y < bmp.h; y += 1) {
      for (let x = 0; x < bmp.w; x += 1) {
        const at = (y * bmp.w + x) * 4;
        // 0xRRGGBBAA, which is the one colour encoding in this ABI. `>>> 0` because the alpha bit
        // makes it negative as an i32 and `src/abi.mjs` reads the colour slot unsigned.
        const rgba = ((bmp.pixels[at] << 24) | (bmp.pixels[at + 1] << 16)
          | (bmp.pixels[at + 2] << 8) | bmp.pixels[at + 3]) >>> 0;
        ops.push({
          op: DL_FILL_RECT, a0: x0 + x * scale, a1: y0 + y * scale, a2: scale, a3: scale, a4: rgba,
        });
      }
    }
    const r = env.win.draw(made.fd, ops);
    return r < 0 ? r : ops.length;
  };

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

  env.std.say(env, `${NAME}: win ${made.win} on fd ${made.fd}, surface ${SURFACE_W}x${SURFACE_H}\n`);
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
    for (const ev of evs) {
      if (ev.type === WEV_RESIZE || ev.type === WEV_FOCUS || ev.type === WEV_POINTER) continue;
      if (ev.type === WEV_DRAG_ENTER) {
        /* THE OFFER ARRIVES WITH THE ENTER, so a target can decide whether it can accept BEFORE
         * the drop and before any bytes exist — which is what a format tag is for. This window
         * shows the user the difference: an amber frame for something it can take, a pink one for
         * something it cannot. */
        account.enters += 1;
        const can = (ev.c & (fmtBit(DOBJ_BITMAP) | fmtBit(DOBJ_PNG))) !== 0;
        account.lastOffer = { offer: ev.c, formats: fmtsOf(ev.c).map(fmtName), accepts: can };
        empty(can ? HOVER : REFUSED);
        continue;
      }
      if (ev.type === WEV_DRAG_LEAVE) {
        account.leaves += 1;
        empty();
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
    + `paste(s), ${account.refusals.length} refusal(s)\n`);
  return { exit: 0, ...account };
}
