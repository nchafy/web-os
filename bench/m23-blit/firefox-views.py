#!/usr/bin/env python3
"""CAN A READER CHANGE HOW A FOLDER LOOKS, GO SOMEWHERE BY POINTING AT IT, AND FIND A FILE? M23's
view modes, breadcrumb, thumbnails and search in FIREFOX, on the LANDING page, with real trusted
input.

    python3 bench/m23-blit/firefox-views.py                      # the gate
    python3 bench/m23-blit/firefox-views.py --dpr 2               # ...AT A RATIO THAT IS NOT 1
    python3 bench/m23-blit/firefox-views.py --prove-failure       # ...and it MUST report failures
    python3 bench/m23-blit/firefox-views.py --control thumb-no-fallback --prove-failure
    python3 bench/m23-blit/firefox-views.py --headed              # in a window you can watch
    python3 bench/m23-blit/firefox-views.py --control             # ...prints what each world moves

Pipe stderr away for a quiet transcript: `serve.Handler` logs every request there.

WHY THIS FILE EXISTS. `CLAUDE.md` makes a second engine a condition of reporting a milestone done
and records the bill for skipping it: M4a shipped a window that could not be dragged in Firefox
(constraint 175), M6 a policy under which no process started there (206), M11 and M12 each a
geometry derived from a dpr-2 constant (264), M14 a desktop a reader could not open anything on
(289), M17 a bare URL that threw in both engines while the suite stayed green. Firefox renders at
**dpr 1** here, which is where every one of those hid.

AND IT NO LONGER HAS TO. `scripts/bidi.py`'s `set_dpr` — measured, not assumed — chooses the
CONTEXT's ratio, so `--dpr 2` drives this whole gate in Firefox at the ratio the four milestones
above were wrong by. The two runs are the same arithmetic at two ratios: a 16x16 image owes a 16x16
payload at dpr 1 and a 32x32 one at dpr 2, and nothing in this file multiplies anything by either
figure.

M23 IS THE WORST MILESTONE SO FAR FOR THAT CLASS, which is why the whole of this file's geometry is
derived from MEASURED rects and from `FILES_METRICS`' own functions, and why not one number below is
copied out of a Chrome run. `DL_BLIT` carries no destination extent (`src/abi.mjs`), so the PAYLOAD's
size is the drawn size, and `thumbFit` multiplies by the display's ratio: a program that decoded at
the wrong ratio draws a picture of the wrong size with nothing thrown anywhere, and at dpr 2 a
dpr-1-sized payload is a quarter of the area it was asked for. The only honest assertion is the one
below — the payload's extent predicted by the program's OWN `thumbFit` at the ratio this run
measured, against the blit the program really emitted.

WHAT A READER ACTUALLY DOES, and each of the four gestures is one clause or two:

  1. `desktop`  the bare url is a desktop at all: a taskbar, a start orb, icons, and no driver
                banner (constraint 283). The clause that collapses when there is no product, which
                is what makes it the one every control must leave alone.
  2. `views`    a real click on the VIEW BUTTON in the address strip steps Details -> Tiles. Two
                readings, because they fail independently: the header stops carrying the four COLUMN
                LABELS and starts carrying the mode's own name, and the LAYOUT becomes the grid —
                every file's name is found inside the cell `itemBox` puts it in. A window that
                renamed its header without re-laying out is a view mode in word only.
  3. `thumbs`   in Tiles, the `.png` and the `.rgba` each drew ONE `DL_BLIT`, and the blit's
                destination is where the payload's own extent — `thumbFit(w, h, icon, scale)` at the
                MEASURED ratio — centres it in the plate the program drew under it. The two files
                are the same 16x16 image by two different routes (the platform's PNG decoder and
                `decodeBitmap`), so their extents must AGREE: that is what tells a correct fit from
                a decoder that happened to produce something.
  4. `icon`     ...and the `.txt`, which nothing can decode, drew NO blit and still has its TYPE
                ICON and its NAME. R26's second half, and the half a `--thumb-no-fallback` world
                takes away. Scored apart from `thumbs` because a picture that did not appear and a
                row left blank are different defects.
  5. `slider`   Ctrl+wheel is the OTHER route to a mode and the only one a reader with no pointer
                has (`bytesForKey` drops Ctrl+Shift+1..7 before a `WEV_KEY` exists). BOTH EDGES: a
                notch towards the reader at the END of the table steps NOTHING (`stepView` clamps
                rather than wrapping) and a notch away from it steps back to Details. The clamp
                alone is indistinguishable from a wheel that never arrived, which is why the step is
                asserted beside it — and `devicePixelRatio` is read before and after, because
                Ctrl+wheel is also the browser's zoom and a host that acted on it would move every
                number in this file.
  6. `search`   a real click on the SEARCH FIELD and a typed query narrows the listing to the one
                name that matches, the field shows what was typed, and Escape puts the whole
                directory back. Three readings: a field that took the keyboard, a filter that ran,
                and an abandon that restored.
  7. `crumb`    a real click on the PARENT SEGMENT of the trail arrives there: the window's own
                title names the path THAT SEGMENT CARRIED, and the fixture directory is a row in the
                new listing. Aimed through `crumbSegments`, which is the rectangle the label was
                drawn inside, so a short name in a wide box still lands on its own segment.

EVERY AIM POINT IS FOUND AND NOT SPELLED. The view button and the search field are located by
SCANNING `crumbHit` across the strip and taking the one run of each kind — never by restating
`wCss - VIEWBTN_W`, which is the second copy `www/m23.html`'s own note warns about. A cell is located
by `itemBox` and a row by `rowTop`, both through `FILES_METRICS`, and the trail read out of the
display list is asserted against `crumbSegments` so the drawing and the hit test are known to agree
rather than assumed to.

IT RUNS ON `www/index.html`, THE BARE URL, so what is driven is the product and not a proof page
(constraint 283). The fixture is built by TYPING AT THE REAL PROMPT, in the session's writable tree
(`INDEX.seed.dest`, read rather than spelled) because `/tmp` is a tmpfs and nothing there outlives a
reload:

    rm -r -f <session>/m23ff-<stamp> ; mkdir -p <session>/m23ff-<stamp>
    cp /usr/share/logo.png  .../pic-<hex>.png     # the platform decoder's route
    cp /usr/share/logo.rgba .../raw-<hex>.rgba    # `decodeBitmap`'s route, same image
    echo <nonce> > .../note-<hex>.txt             # nothing decodes this, so it keeps its icon
    files <session>/m23ff-<stamp> &

THE TWO PICTURE FILES ARE THIS REPOSITORY'S OWN, and their intrinsic size is READ OUT OF THE BYTES
here rather than written down: a PNG's IHDR and an `.rgba`'s `BMP_W`/`BMP_H` (little-endian, which
`src/abi.mjs`'s `encodeBitmap` fixes). `thumbFit` is then asked, in the page, what extent that image
owes at this run's cell and ratio. Nothing in this file multiplies anything by a ratio.

THE FOUR CONTROLS, each re-runnable from the command line with no source edit — two are declared
argv flags on `files` and two change the GESTURE, which is `bench/m21-bin/firefox-bin.py`'s own
split:

  `--control no-thumbs` (the default) RUNS `files --no-thumbs`. It decodes nothing, so no blit is
      emitted at all while every row keeps the type icon it would have had: `thumbs` MUST fire and
      `icon` MUST NOT. It is the default because it is the only world that proves the picture came
      from a DECODE and not from something drawn near the cell.
  `--control thumb-no-fallback` RUNS `files --thumb-no-fallback`. A thumbnail mode's row with no
      picture draws NOTHING, so `icon` MUST fire and `thumbs` MUST NOT — the `.png` still blits. It
      is what tells "every item has a mark" apart from "the pictures worked".
  `--control crumb-here` PRESSES THE SEGMENT THE WINDOW IS ALREADY IN instead of its parent.
      `goToCrumb` answers false for the directory it is already looking at, so nothing navigates:
      `crumb` MUST fire and nothing else may. It is what tells a trail that NAVIGATES from one that
      re-lists whatever is pressed.
  `--control esc-not-type` OPENS THE SEARCH FIELD AND PRESSES ESCAPE instead of typing the query.
      The field opens and closes and the listing is never narrowed, so `search` MUST fire alone. It
      is what tells a filter that ran from a field that merely took a click.

`--prove-failure` exits 0 when the proof SUCCEEDED, which is `scripts/check.py`'s convention.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import secrets
import struct
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import bidi   # noqa: E402
import serve  # noqa: E402

#: THE TWO PICTURES AND THE ONE FILE THAT IS NOT ONE, as repository paths and as the `/usr/share`
#: paths the running system mounts them at. `src/share/` IS what `/usr/share` serves
#: (`src/kernel/providers.mjs`), so the bytes this file measures and the bytes the program decodes
#: are the same bytes — which is what lets the intrinsic size be read here instead of written.
SOURCES = {
    "png": ("src/share/logo.png", "/usr/share/logo.png"),
    "rgba": ("src/share/logo.rgba", "/usr/share/logo.rgba"),
}

#: (proof, kept). A control must move a NAMED subset; a clause in neither is UNSCOPED and the run
#: prints it as such rather than letting silence read as a claim.
CONTROLS = {
    "no-thumbs": (("thumbs",),
                  ("desktop", "views", "icon", "slider", "search", "crumb")),
    "thumb-no-fallback": (("icon",),
                          ("desktop", "views", "thumbs", "slider", "search", "crumb")),
    "crumb-here": (("crumb",),
                   ("desktop", "views", "thumbs", "icon", "slider", "search")),
    "esc-not-type": (("search",),
                     ("desktop", "views", "thumbs", "icon", "slider", "crumb")),
}
TAGS = ("desktop", "views", "thumbs", "icon", "slider", "search", "crumb")

#: WHAT IS ON SCREEN, in one read. Every selector is one `src/wm/` builds; `INDEX` is the landing
#: page's own globals object, published before its module so a driver polling it cannot mistake a
#: syntax error for a slow boot (`www/index.html`).
STATE = """JSON.stringify((() => {
  const M = globalThis.INDEX || {}
  const mid = (el) => { const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } }
  const orb = document.querySelector('[data-start]')
  const log = document.getElementById('log')
  const term = document.querySelectorAll('.terminal')
  const tr = term.length ? term[0].getBoundingClientRect() : null
  const cells = [...document.querySelectorAll('.desk-icon')]
  const labelOf = (c) => ((c.querySelector('.desk-label') || {}).textContent || '')
  return {
    state: String(M.state || ''), phase: String(M.phase || ''),
    dpr: devicePixelRatio, search: location.search,
    errors: (M.errors || []).map(String).slice(0, 4),
    banner: (() => { const b = document.getElementById('driver-hint')
      return b ? (b.textContent || '').slice(0, 120) : '' })(),
    taskbar: Boolean(document.querySelector('[data-taskbar]')),
    orb: orb ? mid(orb) : null,
    terminals: term.length,
    term: tr ? { x: Math.round(tr.left + 30), y: Math.round(tr.top + 20) } : null,
    icons: cells.map(labelOf),
    seed: (() => { const s = M.seed || {}
      return { dest: s.dest || '', home: s.home || '', drifted: Boolean(s.drifted),
               ran: Boolean((s.seed || {}).ran), why: String(s.why || '') } })(),
    windows: [...(((M.host || {}).frames) || new Map()).values()]
      .map((e) => String(e.win.titleText || '')),
    tail: log ? (log.textContent || '').trim().split('\\n').slice(-3) : [],
  }
})())"""

#: One terminal's screen, as text. A pty is the one surface in this system whose whole content is
#: characters, which is why it is also the one a command's output can be asserted out of.
SCREEN = "(document.querySelector('.terminal') || {}).textContent || ''"

#: INSTALL THE READER, ONCE PER PAGE. Two halves, and neither is a second copy of anything:
#:
#:   - the TAP. A surfaced window's content is a canvas, and the only way to read what it drew is
#:     the batch that drew it. The landing page publishes no kernel handle — by design, it is the
#:     product — so the tap goes on `Surface.prototype.replay`, the one function every batch passes
#:     through. It DELEGATES, so the page renders exactly what it would have, and it is on the
#:     PROTOTYPE so a re-surface does not lose it. `bench/m20-verbs/firefox-verbs.py` and
#:     `bench/m21-bin/firefox-bin.py` are the precedent.
#:   - the ARITHMETIC. `FILES_METRICS` is imported rather than restated: `itemBox`, `crumbSegments`,
#:     `crumbHit`, `thumbFit`, `columnBoxes`, `toSurface` and the `VIEWS` table are the program's
#:     own, which is the whole reason that object is exported.
INSTALL = """(async () => {
  const abi = await import('/src/abi.mjs')
  const surf = await import('/src/wm/surface.mjs')
  const files = await import('/src/bin/files.mjs')
  const std = await import('/src/libos/std.mjs')
  const G = globalThis.__M23FF || (globalThis.__M23FF = { last: new WeakMap() })
  G.abi = abi
  G.M = files.FILES_METRICS
  if (!G.wrapped) {
    const proto = surf.Surface.prototype
    const orig = proto.replay
    proto.replay = function (bytes, blits = null) {
      G.last.set(this, bytes.slice())
      return orig.call(this, bytes, blits)
    }
    G.wrapped = true
  }
  // STRINGIFIED INSIDE THE PROMISE: BiDi's `script.evaluate` has no top-level `await`, so the
  // expression IS the async call and `awaitPromise` resolves it.
  return JSON.stringify({ ok: true, home: std.HOME_DIR,
                          views: G.M.VIEWS.map((v) => ({ id: v.id, label: v.label, flow: v.flow,
                                                         icon: v.icon, thumbs: v.thumbs })),
                          columns: G.M.COLUMNS.map((c) => c.label),
                          defaultView: G.M.VIEW_DEFAULT })
})()"""

#: WHAT ONE `files` WINDOW HAS DRAWN, laid out against the view mode the caller NAMES, and where to
#: aim inside it. Three parameters: the title substring, the view id, and how many items to lay out.
#:
#: THE VIEW IS AN ARGUMENT AND NOT A DISCOVERY, and that is the assertion rather than a shortcut: a
#: process publishes no mode to the page, so "the window is in Tiles" can only be read as "the names
#: are inside the cells the Tiles layout puts them in". A caller that names the wrong mode finds no
#: names, which is the clause failing for the right reason.
#:
#: EVERY LENGTH THAT CROSSES THE BOUNDARY IS CONVERTED BY `toSurface` AT THE MEASURED SCALE, which
#: is the program's own converter at the ratio this run read off the canvas — not at a ratio any
#: constant in this file believes in.
READ = """JSON.stringify((() => {
  const want = %s
  const viewId = %s
  const upTo = %d
  const G = globalThis.__M23FF
  if (!G || !G.abi) return { error: 'the reader was never installed' }
  const host = (globalThis.INDEX || {}).host
  if (!host) return { error: 'the landing page published no window host' }
  const titles = []
  let entry = null
  for (const e of host.frames.values()) {
    const t = String(e.win.titleText || '')
    if (t.startsWith('files')) titles.push(t)
    if (!entry && e.surface && t.startsWith('files') && t.includes(want)) entry = e
  }
  if (!entry) return { error: 'no `files` window with a surface whose title holds ' + want, titles }
  const bytes = G.last.get(entry.surface)
  if (!bytes || !bytes.length) {
    return { error: 'that `files` surface has replayed no batch since the reader was installed' }
  }
  const { decodeDrawOps, textOfOps, blitFdOf,
          DL_TEXT, DL_FILL_RECT, DL_BLIT, DLT_BOLD } = G.abi
  const M = G.M
  const view = M.VIEW_BY_ID[viewId]
  if (!view) return { error: viewId + ' is not a view id' }
  const ops = decodeDrawOps(bytes, bytes.length)
  const runs = []
  const fills = []
  const blits = []
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]
    if (op.op === DL_FILL_RECT) { fills.push({ x: op.a0, y: op.a1, w: op.a2, h: op.a3 }); continue }
    if (op.op === DL_BLIT) { blits.push({ fd: blitFdOf(op), x: op.a0, y: op.a1 }); continue }
    if (op.op !== DL_TEXT) continue
    const got = textOfOps(ops, i)
    if (!got) continue
    runs.push({ text: got.text, x: op.a0, y: op.a1, size: op.a2, flags: op.flags })
    i += got.records - 1
  }
  const r = entry.surface.el.getBoundingClientRect()
  // THE SCALE AND THE BOX ARE BOTH MEASURED, never assumed: the backing store is device px and the
  // element is CSS px, and the whole of M16 is that those are different numbers (constraint 264).
  const scale = r.width > 0 ? entry.surface.w / r.width : 1
  const wCss = r.width
  const hCss = entry.surface.extent().cssH
  const px = (v) => M.toSurface(v, scale)
  const at = (xCss, yCss) => ({ x: Math.round(r.left + xCss), y: Math.round(r.top + yCss) })
  const title = String(entry.win.titleText || '')
  // THE DIRECTORY IS THE PROGRAM'S OWN STATEMENT OF WHERE IT IS (`env.win.setTitle`), which is what
  // makes "the crumb arrived" assertable without the process publishing anything.
  const cut = title.indexOf(' \\u2014 ')
  const dir = cut < 0 ? '' : title.slice(cut + 3)

  // ---- THE ADDRESS STRIP: the trail as DRAWN, the trail as COMPUTED, and the three aim points.
  const inStrip = (y) => y >= px(M.CRUMB_TOP) && y < px(M.VIEW_TOP)
  const stripRuns = runs.filter((t) => inStrip(t.y))
    .map((t) => ({ text: t.text, xCss: t.x / scale })).sort((a, b) => a.xCss - b.xCss)
  const segs = M.crumbSegments(dir, wCss)
  // `crumbHit` SCANNED RATHER THAN INVERTED BY HAND. It is `crumbSegments`' declared inverse, so a
  // scan over every CSS column of the strip finds the run of x that each target really owns — and a
  // driver that restated `wCss - VIEWBTN_W` would aim at the view button the day the strip's layout
  // moves and report the program at fault (`www/m23.html`'s own note).
  const scan = []
  for (let x = 0; x < Math.floor(wCss); x += 1) {
    const hit = M.crumbHit(x, dir, wCss)
    const last = scan[scan.length - 1]
    if (last && last.kind === hit.kind && last.index === hit.index) last.to = x
    else scan.push({ kind: hit.kind, index: hit.index, from: x, to: x })
  }
  const aimOf = (kind, index) => {
    const found = scan.filter((s) => s.kind === kind
      && (index === undefined || s.index === index))
    if (found.length !== 1) return null
    const midX = (found[0].from + found[0].to) / 2
    return { ...at(midX, M.CRUMB_MID), fromCss: found[0].from, toCss: found[0].to }
  }

  // ---- THE ITEMS, laid out by the mode's own `itemBox`, with what fell inside each one.
  const boxed = []
  for (let i = 0; i < upTo; i += 1) {
    const cell = M.itemBox(view, i, 0, wCss, hCss)
    const box = { x: px(cell.x), y: px(cell.y),
                  w: px(cell.x + cell.w) - px(cell.x), h: px(cell.y + cell.h) - px(cell.y) }
    const inside = (o) => o.x >= box.x && o.y >= box.y
      && o.x + (o.w || 0) <= box.x + box.w && o.y + (o.h || 0) <= box.y + box.h
    const side = px(view.icon)
    boxed.push({
      i, box,
      // THE CELL'S CSS MIDPOINT, which is where a press on this item goes. `itemAtPoint` is
      // `itemBox`'s declared inverse, so this is the point the program hit-tests back to `i`.
      aim: at(cell.x + cell.w / 2, cell.y + cell.h / 2),
      texts: runs.filter((t) => inside({ x: t.x, y: t.y })).map((t) => t.text),
      blits: blits.filter((b) => inside(b)),
      fills: fills.filter((f) => inside(f)).length,
      // THE PLATE IS THE ICON BOX, READ BACK OUT OF THE DRAWING. `picture` lays a square of the
      // icon's own side under a letterboxed thumbnail, so this is where the blit was centred —
      // taken from the ops rather than by re-deriving `cellItem`'s private `iconX`/`iconY`, which
      // would be the second copy every drift in this project has come from.
      plate: fills.filter((f) => inside(f) && f.w === side && f.h === side)[0] || null,
    })
  }

  return {
    title, dir, id: entry.id, scale, wCss, hCss, dpr: devicePixelRatio,
    batches: entry.surface.batches, surface: { w: entry.surface.w, h: entry.surface.h },
    titles, viewAsked: viewId,
    heads: runs.filter((t) => t.y < px(M.HEAD_H))
               .map((t) => ({ text: t.text, bold: Boolean(t.flags & DLT_BOLD) })),
    strip: stripRuns,
    segs: segs.map((s) => ({ label: s.label, path: s.path, elided: Boolean(s.elided),
                             ...at(s.x + s.w / 2, M.CRUMB_MID) })),
    scan: scan.map((s) => ({ kind: s.kind, index: s.index, from: s.from, to: s.to })),
    aims: { view: aimOf('view'), search: aimOf('search') },
    items: boxed,
    names: runs.filter((t) => t.y >= px(M.VIEW_TOP)).map((t) => t.text),
    blits: blits.length,
    place: (runs.find((t) => /^\\d+ items?$/.test(t.text)
                            || /^\\d+-\\d+ of \\d+$/.test(t.text)) || {}).text || '',
  }
})())"""

#: WHAT `thumbFit` OWES for an image of `imgW` x `imgH` in `viewId`'s cell at the MEASURED ratio, and
#: where a blit of that extent lands when it is centred in the plate the program drew.
#:
#: THE PREDICTION IS THE PROGRAM'S OWN FUNCTION AND THE PLATE IS THE PROGRAM'S OWN RECTANGLE, so the
#: only thing this file contributes is the image's intrinsic size — read out of the fixture's bytes.
#: A prediction built from a ratio written down here is the M11/M12/M16 bill again, in a file whose
#: whole purpose is to catch it.
FIT = """JSON.stringify((() => {
  const G = globalThis.__M23FF
  if (!G || !G.M) return { error: 'the reader was never installed' }
  const view = G.M.VIEW_BY_ID[%s]
  if (!view) return { error: 'not a view id' }
  const plate = %s
  const fit = G.M.thumbFit(%d, %d, view.icon, %s)
  return { fit,
           want: { x: plate.x + Math.round((plate.w - fit.w) / 2),
                   y: plate.y + Math.round((plate.h - fit.h) / 2) } }
})())"""

#: WHAT A HIT TEST FINDS at a point, because a covered canvas and an inert one are the same picture
#: (constraint 40). Every gesture below is aimed through this, so a press that went to another
#: window is reported rather than silently counted as a program that did nothing.
UNDER = """JSON.stringify((() => {
  const el = document.elementFromPoint(%d, %d)
  if (!el) return { hits: 'nothing' }
  const frame = el.closest ? el.closest('.window') : null
  const pop = el.closest ? el.closest('[data-popup]') : null
  const term = el.closest ? el.closest('.terminal') : null
  if (pop) return { tag: String(el.tagName || ''), hits: 'the shell popup' }
  if (term) return { tag: String(el.tagName || ''), hits: 'the terminal' }
  return { tag: String(el.tagName || ''),
           hits: frame ? ((frame.querySelector('h2') || {}).textContent || '').trim()
                       : 'no window' }
})())"""


def png_extent(path: pathlib.Path) -> tuple[int, int]:
    """A PNG's intrinsic size, out of its IHDR. Big-endian, which is the format's own order.

    REFUSED RATHER THAN GUESSED for anything that is not a PNG: the prediction below is only as good
    as this pair, and a zero would make `thumbFit` answer for a 1x1 image and the clause pass over a
    picture of the wrong size.
    """
    raw = path.read_bytes()
    if raw[:8] != b"\x89PNG\r\n\x1a\n" or raw[12:16] != b"IHDR":
        raise ValueError("%s is not a PNG with an IHDR first" % path)
    return struct.unpack(">II", raw[16:24])


def rgba_extent(path: pathlib.Path) -> tuple[int, int]:
    """An `.rgba`'s intrinsic size, out of `encodeBitmap`'s header — LITTLE-endian (`src/abi.mjs`
    `BMP_W`/`BMP_H`), and the length checked against it.

    THE LENGTH CHECK IS `decodeBitmap`'S OWN TEST, restated here as a refusal rather than as a
    prediction: this is the file the program will hand to that function, so a fixture it would refuse
    must stop this run instead of being asserted against.
    """
    raw = path.read_bytes()
    w, h = struct.unpack("<II", raw[:8])
    if w <= 0 or h <= 0 or len(raw) != 8 + w * h * 4:
        raise ValueError("%s is %d bytes for a %dx%d header" % (path, len(raw), w, h))
    return w, h


def settle(ff, tries: int = 100) -> dict:
    """Wait for the desktop to stage and its layout to stop moving.

    THE SECOND HALF IS NOT DECORATION. The page prints its own log, the log grows, and the desktop
    is pushed down under it — measured on m14, an icon at y=65 became y=249 — so a rect read before
    that and clicked after is clicked where nothing is. Two identical reads is the signal, which is
    `bench/m14-shell/firefox-drive.py`'s rule for the same hazard.
    """
    last, stable, st = None, 0, {}
    for _ in range(tries):
        st = ff.evaluate(STATE)
        now = None if not st.get("term") else (st["term"]["x"], st["term"]["y"], st["terminals"])
        stable = stable + 1 if now and now == last and st.get("state") == "done" else 0
        last = now
        if stable >= 2:
            return st
        time.sleep(0.4)
    return st


def read(ff, want: str, view: str, upTo: int = 8) -> dict:
    got = ff.evaluate(READ % (json.dumps(str(want)), json.dumps(str(view)), int(upTo)))
    return got if isinstance(got, dict) else {"error": "the reader returned %r" % (got,)}


def under(ff, point: dict) -> dict:
    got = ff.evaluate(UNDER % (int(point["x"]), int(point["y"])))
    return got if isinstance(got, dict) else {}


def shq(path: str) -> str:
    """A path as ONE shell word, with nothing in it expanded.

    `src/libos/shlex.mjs`'s `expandWord` runs `expandVars` over every span that is not
    single-quoted, so a bare path holding a `$` reaches the program with a variable expanded out of
    it — a path that does not exist, from a command that reported nothing wrong
    (`bench/m21-bin/firefox-bin.py` measured exactly that against the Bin's own name).

    A single quote inside the path would need the `'\\''` dance and is REFUSED instead, because this
    gate names no such path and a quoting routine nobody exercises is a quoting routine that is
    wrong.
    """
    if "'" in path:
        raise ValueError("a path holding a single quote cannot be spelled at this prompt: %r"
                         % path)
    return "'%s'" % path


def at_prompt(ff, cmd: str) -> str:
    """Type a command at a real prompt and return ONLY what it printed.

    IT WAITS FOR THE PROMPT, not for a timer: a command slower than a guess would have its output
    read as the next command's, which is how a gate comes to assert one command's success against
    another's (`bench/m14-shell/coreutils.py`).
    """
    before = len(ff.evaluate(SCREEN, raw=True))
    ff.type_keys(cmd + "\n")
    out = ""
    for _ in range(80):
        time.sleep(0.15)
        out = ff.evaluate(SCREEN, raw=True)[before:]
        if re.search(r"\$\s*$", out) and len(out.strip()) > len(cmd):
            break
    said = " ".join(out.split())
    print("    $ %-54s | %s" % (cmd, said[len(" ".join(cmd.split())):].strip()[:150]))
    return out


def focus_terminal(ff, st: dict) -> str:
    """Put the caret in the desktop's pty, and PROVE the keystrokes are landing in it.

    THE PROBE IS THE POINT. A harness must fail when it is not reading what it was pointed at
    (`CLAUDE.md` §Harness honesty), and a pty that has the caret is indistinguishable from one that
    does not until something is typed into it. The hit test goes first because this run opens a
    window between its typings: a point the caret would have reached on a bare desktop can be under
    a `files` frame by the time it is used again, and a click that landed on a canvas would read as
    a shell that printed nothing.
    """
    if st.get("terminals") != 1 or not st.get("term"):
        return "%s terminal(s) on screen; `SCREEN` reads the first and the keys go to the " \
               "focused one, so this run could not be trusted" % st.get("terminals")
    hit = under(ff, st["term"])
    if hit.get("hits") != "the terminal":
        return "the point this gate types at (%s,%s) is covered by %r, so the keystrokes would " \
               "go to another window" % (st["term"]["x"], st["term"]["y"], hit.get("hits"))
    ff.click(st["term"]["x"], st["term"]["y"])
    time.sleep(0.3)
    probe = "m23-probe-%s" % secrets.token_hex(2)
    if probe not in at_prompt(ff, "echo %s" % probe):
        return "a real keystroke did not reach the pty: `echo %s` printed nothing back, so the " \
               "caret is not in the terminal this run reads" % probe
    return ""


def cell_of(state: dict, name: str):
    """The laid-out cell whose own text runs hold `name`, or None.

    BY THE NAME AND NOT BY AN INDEX, which is `bench/m21-bin/firefox-bin.py`'s rule and this
    milestone makes it sharper: the sort is the program's, a grid's cells are filled across before
    down, and a driver indexing items asserts against whatever the layout put there.
    """
    for item in state.get("items") or []:
        if name in (item.get("texts") or []):
            return item
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--url", default="", help="an already-running server; otherwise one is bound")
    ap.add_argument("--page", default="/www/index.html",
                    help="the landing page, at its BARE url: no query, no proofs")
    ap.add_argument("--w", type=int, default=1560)
    ap.add_argument("--h", type=int, default=1010)
    ap.add_argument("--dpr", type=float, default=0.0,
                    help="drive at a chosen DEVICE PIXEL RATIO instead of the engine's own. 0 "
                         "leaves it alone, which is dpr 1 on this machine. The whole point of a "
                         "second ratio is that `thumbFit` multiplies by it: a 16x16 image owes a "
                         "16x16 payload at dpr 1 and a 32x32 one at dpr 2, and `DL_BLIT` carries "
                         "no destination size, so a payload made at the wrong ratio is a picture "
                         "of the wrong size with nothing thrown anywhere")
    ap.add_argument("--settle", type=float, default=1.4,
                    help="seconds between gestures. Over the platform's double-click threshold, so "
                         "two single clicks on one target are not read as an activation")
    ap.add_argument("--shot", default=str(HERE / "firefox-views.png"))
    ap.add_argument("--control", choices=sorted(CONTROLS), default="no-thumbs",
                    help="which world `--prove-failure` builds. %s"
                         % "; ".join("%s moves %s and must leave %s alone"
                                     % (k, ", ".join(v[0]), ", ".join(v[1]))
                                     for k, v in sorted(CONTROLS.items())))
    ap.add_argument("--prove-failure", action="store_true",
                    help="run the control named by --control. Its own clauses MUST fire and the "
                         "ones it does not name MUST NOT. Exits 0 when the proof SUCCEEDED.")
    args = ap.parse_args(argv)

    proof_tags, kept_tags = CONTROLS[args.control]
    on = args.prove_failure
    #: THE FOUR THINGS A CONTROL MAY CHANGE, and each world changes exactly one of them. Two are
    #: argv on the program and two are the gesture, which is what keeps every one re-runnable from
    #: the command line with no source edit.
    flags = []
    if on and args.control == "no-thumbs":
        flags.append("--no-thumbs")
    if on and args.control == "thumb-no-fallback":
        flags.append("--thumb-no-fallback")
    crumb_at = "here" if on and args.control == "crumb-here" else "parent"
    search_by = "escape" if on and args.control == "esc-not-type" else "type"

    # THE FIXTURE'S OWN BYTES, MEASURED BEFORE A BROWSER IS LAUNCHED. A missing or malformed source
    # file must stop the run here rather than become a prediction for a 1x1 image that passes.
    try:
        png_w, png_h = png_extent(REPO / SOURCES["png"][0])
        rgba_w, rgba_h = rgba_extent(REPO / SOURCES["rgba"][0])
    except (OSError, ValueError, struct.error) as error:
        print("the fixture's picture files could not be measured, so no thumbnail clause below "
              "could predict an extent: %s" % error)
        return 1

    httpd = None
    url = args.url
    if not url:
        os.chdir(REPO)
        httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d%s" % (httpd.server_address[1], args.page)

    stamp = secrets.token_hex(3)
    leaf = "m23ff-%s" % stamp
    # THREE FILES AND EACH HAS ONE JOB: a PNG through the platform's decoder, the SAME image as an
    # `.rgba` through `decodeBitmap`, and a text file nothing can decode. The names are nonces so
    # that a `searchMatch` query can be a token only one of them holds, and they are PREFIXED
    # `a-`/`b-`/`c-` so the name-ascending sort the window opens with puts the three subjects in
    # the first three items whatever the padding is called.
    png_tok = secrets.token_hex(4)
    rgba_tok = secrets.token_hex(4)
    note_tok = secrets.token_hex(4)
    png_name = "a-pic-%s.png" % png_tok
    rgba_name = "b-raw-%s.rgba" % rgba_tok
    note_name = "c-note-%s.txt" % note_tok
    nonce = "note-bytes-%s" % secrets.token_hex(5)
    # THE PADDING IS WHAT MAKES THE WINDOW TALL ENOUGH TO HOLD A GRID, and it is a measured property
    # of the program rather than a defect in it: `files` opens at `clientHeightFor(min(rows, 24))`
    # so that a window opened to fit its content cannot scroll, which for a three-file directory is
    # 150 CSS px — and three Tiles cells at a 54 px pitch in one lane need 162. MEASURED: the first
    # run of this gate found `b-raw-…` laid out at y=164 with a 150 px surface, and reported the
    # LAYOUT at fault for a window that was simply short. It is also what makes clause 7 readable:
    # the parent directory has six entries and a 150 px window shows four of them, so the fixture
    # directory was not among the rows there either.
    pads = ["d-pad-%02d.txt" % (n + 1) for n in range(9)]
    print("url      %s" % url)
    print("fixture  %s holding %s, %s, %s and %d padding file(s)"
          % (leaf, png_name, rgba_name, note_name, len(pads)))
    print("sources  %s is %dx%d, %s is %dx%d  (read out of the bytes, not written down)"
          % (SOURCES["png"][0], png_w, png_h, SOURCES["rgba"][0], rgba_w, rgba_h))
    if on:
        print("control  --control %s. %s MUST fire; %s MUST NOT"
              % (args.control, ", ".join(proof_tags), ", ".join(kept_tags)))
        unscoped = sorted(set(TAGS) - set(proof_tags) - set(kept_tags))
        if unscoped:
            print("         unscoped under it: %s — neither claimed nor kept" % ", ".join(unscoped))

    #: (tag, message). The tag is what `--prove-failure` scopes its proof to.
    bad: list[tuple[str, str]] = []
    good: list[str] = []
    pause = max(0.2, args.settle)
    try:
        with bidi.Firefox(headless=not args.headed, width=args.w, height=args.h) as ff:
            # THE RATIO IS CHOSEN BEFORE THE PAGE LOADS, so the kernel boots and every window is
            # surfaced at it — a ratio changed under a live desktop is a resize, which is M16's
            # subject and not this gate's. `set_dpr` is measured to survive the navigation
            # (`python3 scripts/bidi.py`), which is what makes this ordering available.
            if args.dpr > 0:
                ff.set_dpr(args.dpr)
                print("dpr      asked for %s before loading the page" % args.dpr)
            # ---- 1. IS THERE A DESKTOP AT ALL? ------------------------------------------------
            ff.navigate(url)
            st = settle(ff)
            print("firefox  dpr %s  state=%r phase=%r search=%r"
                  % (st.get("dpr"), st.get("state"), st.get("phase"), st.get("search")))
            for line in st.get("tail") or []:
                print("log      %s" % line)
            if st.get("errors"):
                print("page     errors %s" % st["errors"])
            if st.get("search"):
                print("\nthis is not the bare url: location.search is %r" % st["search"])
                return 1
            # A RATIO THAT WAS ASKED FOR AND DID NOT ARRIVE MAKES THIS RUN A dpr-1 RUN REPORTING A
            # dpr-2 ONE, which is the worst outcome available (`CLAUDE.md` §Harness honesty): every
            # clause below would pass, about a ratio nobody drove.
            if args.dpr > 0 and st.get("dpr") != args.dpr:
                print("\n`--dpr %s` was asked for and the page reports %r, so this run is about a "
                      "ratio nobody chose." % (args.dpr, st.get("dpr")))
                return 1
            if not st.get("taskbar"):
                bad.append(("desktop", "no taskbar: nothing matches [data-taskbar]"))
            if not st.get("orb"):
                bad.append(("desktop", "no start orb: nothing matches [data-start]"))
            if not st.get("icons"):
                bad.append(("desktop", "the desktop published no icons"))
            if st.get("banner"):
                bad.append(("desktop", "the bare url is a proof harness waiting for a driver "
                                       "(constraint 283): %s" % st["banner"]))
            print("desktop  taskbar=%s orb=%s icons=%s"
                  % (st.get("taskbar"), bool(st.get("orb")), st.get("icons")))
            if not st.get("taskbar") or not st.get("icons"):
                for tag, line in bad:
                    print("BAD  [%s] %s" % (tag, line))
                print("\nthere is no desktop to drive, so clauses 2-7 were not run")
                ff.screenshot(args.shot)
                return 1
            good.append("the bare url is a desktop: a taskbar, a start orb, %d icon(s) and no "
                        "driver banner" % len(st["icons"]))

            # ---- THE SESSION'S WRITABLE TREE, READ AND NOT TYPED ------------------------------
            seed = st.get("seed") or {}
            print("seed     %s" % seed)
            if not seed.get("dest") or seed.get("drifted"):
                print("\nthe session's writable tree could not be located (dest=%r drifted=%s "
                      "why=%r), so there is nowhere to put a fixture and nothing below could be "
                      "about a directory a reader has."
                      % (seed.get("dest"), seed.get("drifted"), seed.get("why")))
                ff.screenshot(args.shot)
                return 1
            directory = "%s/%s" % (seed["dest"], leaf)
            parent = seed["dest"]

            got = ff.evaluate(INSTALL)
            if not isinstance(got, dict) or not got.get("ok") or not got.get("views"):
                print("\nthe display-list reader could not be installed, so nothing below could be "
                      "read back out of what was drawn: %s" % (got,))
                return 1
            views = {v["id"]: v for v in got["views"]}
            columns = [str(c) for c in got["columns"]]
            opens_in = str(got["defaultView"])
            # THE TWO MODES THIS GATE DRIVES, TAKEN OUT OF THE TABLE AND NOT NAMED HERE: the one a
            # window opens in, and the one the view button steps to from it. `VIEWS` is largest
            # first and the button cycles, so "the next row, wrapping" is the button's own rule
            # (`cycleView`) — reproducing it here is how a reader's gesture and a gate's expectation
            # come to disagree the day a mode is inserted.
            order = [v["id"] for v in got["views"]]
            stepped = order[(order.index(opens_in) + 1) % len(order)]
            print("reader   opens in %r (%s); the view button steps to %r (%s, thumbs=%s, icon=%s)"
                  % (opens_in, views[opens_in]["label"], stepped, views[stepped]["label"],
                     views[stepped]["thumbs"], views[stepped]["icon"]))
            if not views[stepped]["thumbs"]:
                print("\nthe mode the view button steps to (%r) draws no pictures, so clauses 3 "
                      "and 4 have no world. The `VIEWS` table moved under this gate: it needs a "
                      "thumbnail mode one step from the default." % stepped)
                return 1

            # ---- THE FIXTURE, TYPED AT A REAL PROMPT -----------------------------------------
            why = focus_terminal(ff, st)
            if why:
                print("\n%s" % why)
                ff.screenshot(args.shot)
                return 1
            at_prompt(ff, "rm -r -f %s" % shq(directory))
            at_prompt(ff, "mkdir -p %s" % shq(directory))
            at_prompt(ff, "cp %s %s" % (shq(SOURCES["png"][1]),
                                        shq("%s/%s" % (directory, png_name))))
            at_prompt(ff, "cp %s %s" % (shq(SOURCES["rgba"][1]),
                                        shq("%s/%s" % (directory, rgba_name))))
            at_prompt(ff, "echo %s > %s" % (nonce, shq("%s/%s" % (directory, note_name))))
            at_prompt(ff, "touch %s"
                      % " ".join(shq("%s/%s" % (directory, p)) for p in pads))
            listed = at_prompt(ff, "ls %s" % shq(directory))
            missing = [n for n in (png_name, rgba_name, note_name) + tuple(pads)
                       if n not in listed]
            if missing:
                print("\nthe fixture did not take: %s absent from `ls %s`, which printed %r. Every "
                      "clause below would be about a different directory."
                      % (", ".join(missing), directory, " ".join(listed.split())[:200]))
                ff.screenshot(args.shot)
                return 1
            # THE PICTURE FILES' SIZES ARE READ BACK ON THE VOLUME, because a `cp` that copied a
            # short file is a decode that would fail for a reason this gate did not build. The
            # figures come from the repository's own bytes, so this is a comparison and not a guess.
            sized = at_prompt(ff, "wc -c %s %s" % (shq("%s/%s" % (directory, png_name)),
                                                   shq("%s/%s" % (directory, rgba_name))))
            for name, want_bytes in ((png_name, (REPO / SOURCES["png"][0]).stat().st_size),
                                     (rgba_name, (REPO / SOURCES["rgba"][0]).stat().st_size)):
                if str(want_bytes) not in sized:
                    print("\nthe copy of %r on the volume is not %d bytes: `wc -c` printed %r. A "
                          "short picture file would fall back for a reason this run did not build."
                          % (name, want_bytes, " ".join(sized.split())[:160]))
                    ff.screenshot(args.shot)
                    return 1

            spawn = "files%s %s &" % ("".join(" " + f for f in flags), shq(directory))
            ff.type_keys(spawn + "\n")
            print("    $ %s" % spawn)
            time.sleep(4.0)

            # ---- 2. THE WINDOW OPENS IN THE DEFAULT MODE, which is the baseline every later -----
            #         clause is a change FROM.
            opened = read(ff, leaf, opens_in)
            if opened.get("error"):
                print("\nthe `files` window could not be read, so clauses 2-7 were not run: %s"
                      % opened["error"])
                ff.screenshot(args.shot)
                return 1
            print("files    title=%r scale=%s wCss=%s hCss=%s surface=%s batches=%s"
                  % (opened["title"], opened["scale"], round(opened["wCss"], 2),
                     round(opened["hCss"], 2), opened["surface"], opened["batches"]))
            print("dir      %r  (out of the window's own title)" % opened["dir"])
            print("names    %s" % opened["names"][:12])
            if opened["dir"] != directory:
                print("\nthe window is looking at %r and the fixture is %r, so every aim below "
                      "would be inside another directory." % (opened["dir"], directory))
                ff.screenshot(args.shot)
                return 1
            head_labels = [h["text"] for h in opened["heads"]]
            print("header   %s" % head_labels)
            if [c for c in columns if c not in head_labels]:
                print("\nthe window did not open with the %r header this gate reads a mode change "
                      "against: wanted every one of %s, got %s"
                      % (opens_in, columns, head_labels))
                ff.screenshot(args.shot)
                return 1
            if opened["blits"]:
                print("\nthe %r mode drew %d blit(s), and R26 scopes pictures to Medium icons and "
                      "larger. There is no 'before' for clause 3 to be a change from."
                      % (opens_in, opened["blits"]))
                ff.screenshot(args.shot)
                return 1

            # ---- THE STRIP: the trail as DRAWN against the trail as COMPUTED -------------------
            #
            # `crumbSegments` IS THE DECLARED SOURCE OF BOTH, so this is the one reading that says
            # the rectangle a press is tested against is the rectangle the label was drawn inside.
            # It is a precondition and not a clause: with the two disagreeing, clause 7's aim point
            # is meaningless and the failure belongs to the trail rather than to the navigation.
            drawn = [s["text"] for s in opened["strip"]]
            computed = [s["label"] for s in opened["segs"]]
            print("trail    computed %s" % computed)
            print("         drawn    %s" % drawn)
            if [lab for lab in computed if lab not in drawn]:
                print("\nthe trail `crumbSegments` computes is not the trail that was drawn: %s "
                      "against %s. A press tested against a rectangle nothing was drawn in lands "
                      "on the wrong segment." % (computed, drawn))
                ff.screenshot(args.shot)
                return 1
            aims = opened["aims"] or {}
            if not aims.get("view") or not aims.get("search"):
                print("\nthe view button and the search field could not both be found by scanning "
                      "`crumbHit` across the strip: %s. The scan is %s"
                      % (aims, opened.get("scan")))
                ff.screenshot(args.shot)
                return 1
            print("aims     view button x %s-%s css, search field x %s-%s css  (found by scanning "
                  "crumbHit, not by restating a width)"
                  % (aims["view"]["fromCss"], aims["view"]["toCss"],
                     aims["search"]["fromCss"], aims["search"]["toCss"]))

            # ---- 2. THE VIEW BUTTON ----------------------------------------------------------
            hit = under(ff, aims["view"])
            print("under    the view button -> %r" % hit.get("hits"))
            if "files" not in str(hit.get("hits")):
                print("\nthe view button's own rectangle is covered by %r, so a press on it would "
                      "go to another window." % hit.get("hits"))
                ff.screenshot(args.shot)
                return 1
            ff.click(aims["view"]["x"], aims["view"]["y"])
            time.sleep(2.5)
            tiled = read(ff, leaf, stepped)
            if tiled.get("error"):
                print("\nthe window could not be read after the view button was pressed: %s"
                      % tiled["error"])
                ff.screenshot(args.shot)
                return 1
            heads2 = [h["text"] for h in tiled["heads"]]
            print("header   %s" % heads2)
            # THE FIRST THREE CELLS MUST BE ON THE SURFACE, and a run where they are not is BROKEN
            # rather than red: a cell below the backing store is not drawn at all, and scoring that
            # as a layout defect is what the first run of this gate did (see `pads`).
            room = [it for it in (tiled.get("items") or [])[:3]
                    if it["box"]["y"] + it["box"]["h"] > tiled["surface"]["h"]]
            if room:
                print("\nthe window's %d-px surface has no room for the first three cells of %r "
                      "(%s), so clauses 2-4 would be about items nothing drew. The fixture needs "
                      "more files: `files` opens at the height its content needs."
                      % (tiled["surface"]["h"], stepped, [it["box"] for it in room]))
                ff.screenshot(args.shot)
                return 1
            laid = {n: cell_of(tiled, n) for n in (png_name, rgba_name, note_name)}
            print("cells    %s" % {n: (c["i"] if c else None) for n, c in laid.items()})
            left_over = [c for c in columns if c in heads2]
            says_mode = [h for h in heads2 if views[stepped]["label"] in h]
            lost = [n for n, c in laid.items() if not c]
            if left_over:
                bad.append(("views", "the header still carries the %r column label(s) %s after the "
                                     "view button was pressed. A grid of icons has no Name column "
                                     "for a label to sit over" % (opens_in, left_over)))
            elif not says_mode:
                bad.append(("views", "the header names no mode after the view button was pressed: "
                                     "%s, and %r is not among them. A reader in a grid otherwise "
                                     "has nothing on screen saying which mode they are in"
                            % (heads2, views[stepped]["label"])))
            elif lost:
                bad.append(("views", "%s is not inside the cell `itemBox` puts it in for %r, so "
                                     "the header renamed the mode and the layout did not follow: "
                                     "the laid-out cells hold %s"
                            % (", ".join(lost), stepped,
                               [c["texts"] for c in (tiled.get("items") or [])[:4]])))
            else:
                good.append("a real click on the view button — found by scanning `crumbHit`, not "
                            "by restating a width — stepped %r to %r: the header dropped the four "
                            "column labels for %r, and all three files are inside the cells "
                            "`itemBox` lays out for the new mode"
                            % (opens_in, stepped, says_mode[0]))

            # ---- 3+4. THE PICTURES, AND THE ROW THAT CANNOT HAVE ONE -------------------------
            #
            # THE TWO ARE SCORED APART because they fail apart: a decode that did not happen and a
            # row left blank are different defects with different fixes, and a single "the cell has
            # something in it" passes for either.
            print("blits    %d in the batch" % tiled["blits"])
            pictures = []
            for name, imgW, imgH in ((png_name, png_w, png_h), (rgba_name, rgba_w, rgba_h)):
                cell = laid.get(name)
                if not cell:
                    bad.append(("thumbs", "%r is not laid out in %r, so there is no cell to look "
                                          "for a picture in" % (name, stepped)))
                    continue
                shots = cell.get("blits") or []
                if len(shots) != 1:
                    bad.append(("thumbs", "%r drew %d `DL_BLIT` op(s) in its own cell and R26 owes "
                                          "it one: %s. The cell holds %d fill(s) and the texts %s"
                                % (name, len(shots), shots, cell.get("fills"),
                                   cell.get("texts"))))
                    continue
                plate = cell.get("plate")
                if not plate:
                    bad.append(("thumbs", "%r blitted at %s with no plate under it: `picture` lays "
                                          "one when the payload is smaller than the icon box, so "
                                          "there is no drawn rectangle to say where the picture was "
                                          "centred" % (name, shots[0])))
                    continue
                want = ff.evaluate(FIT % (json.dumps(stepped), json.dumps(plate),
                                          int(imgW), int(imgH), json.dumps(tiled["scale"])))
                if not isinstance(want, dict) or not want.get("fit"):
                    bad.append(("thumbs", "`thumbFit` could not be asked what %r owes: %s"
                                % (name, want)))
                    continue
                fit = want["fit"]
                print("thumb    %-22s %dx%d -> fit %dx%d clamped=%s, plate %s, blit fd=%s at %s,%s "
                      "(want %s,%s)"
                      % (name, imgW, imgH, fit["w"], fit["h"], fit["clamped"], plate,
                         shots[0]["fd"], shots[0]["x"], shots[0]["y"],
                         want["want"]["x"], want["want"]["y"]))
                if (shots[0]["x"], shots[0]["y"]) != (want["want"]["x"], want["want"]["y"]):
                    bad.append(("thumbs", "%r blitted at %s,%s and a payload of the extent "
                                          "`thumbFit(%d, %d, %d, %s)` owes — %dx%d — centres in "
                                          "the plate %s at %s,%s. The op carries no destination "
                                          "size, so the offset is the only reading of the "
                                          "payload's own extent: a decode at the wrong ratio "
                                          "lands here"
                                % (name, shots[0]["x"], shots[0]["y"], imgW, imgH,
                                   views[stepped]["icon"], tiled["scale"], fit["w"], fit["h"],
                                   plate, want["want"]["x"], want["want"]["y"])))
                    continue
                pictures.append((name, fit["w"], fit["h"]))
            if len(pictures) == 2:
                if (pictures[0][1], pictures[0][2]) != (pictures[1][1], pictures[1][2]):
                    bad.append(("thumbs", "the same 16x16 image decoded to %dx%d through the "
                                          "platform's PNG decoder and %dx%d through `decodeBitmap`: "
                                          "%s against %s. Two routes to one picture must agree, or "
                                          "the fit is a property of the decoder"
                                % (pictures[0][1], pictures[0][2], pictures[1][1], pictures[1][2],
                                   pictures[0][0], pictures[1][0])))
                else:
                    good.append("the `.png` and the `.rgba` — the same image through the platform's "
                                "decoder and through `decodeBitmap` — each drew ONE `DL_BLIT`, both "
                                "at the %dx%d extent `thumbFit` owes at the MEASURED ratio %s, each "
                                "centred in the plate the program drew under it"
                                % (pictures[0][1], pictures[0][2], tiled["scale"]))

            note_cell = laid.get(note_name)
            if not note_cell:
                bad.append(("icon", "%r is not laid out in %r, so there is no cell to look for a "
                                    "type icon in" % (note_name, stepped)))
            elif note_cell.get("blits"):
                bad.append(("icon", "%r drew %s: nothing in this system decodes a text file, so a "
                                    "picture of one is a blit of another row's payload"
                            % (note_name, note_cell["blits"])))
            elif not note_cell.get("fills"):
                bad.append(("icon", "%r drew NO fill inside its own cell, so the row a reader can "
                                    "see has a name and a blank square where its type icon should "
                                    "be. R26's fallback is the icon the row would have had anyway"
                            % note_name))
            elif note_name not in (note_cell.get("texts") or []):
                bad.append(("icon", "%r has a type icon and no name beside it: the cell's texts are "
                                    "%s" % (note_name, note_cell.get("texts"))))
            else:
                good.append("and %r — which nothing here can decode — drew no blit, %d fill(s) of "
                            "its TYPE ICON inside its own cell, and its name beside them"
                            % (note_name, note_cell["fills"]))

            # ---- 5. CTRL+WHEEL, BOTH EDGES --------------------------------------------------
            #
            # THE CLAMP FIRST AND THE STEP SECOND. A notch at the end of the table must change
            # nothing (`stepView` clamps rather than wrapping), and that reading alone is satisfied
            # by a wheel that never arrived — so the step that follows is what makes it mean
            # anything. `devicePixelRatio` is read across both, because Ctrl+wheel is the browser's
            # own zoom and a host that acted on it would move every number above.
            lane = laid.get(png_name) or (tiled.get("items") or [None])[0]
            if not lane:
                print("\nno cell to aim a wheel at, so clause 5 could not be run")
                ff.screenshot(args.shot)
                return 1
            hit = under(ff, lane["aim"])
            print("under    the wheel's point -> %r" % hit.get("hits"))
            if "files" not in str(hit.get("hits")):
                print("\nthe point this gate turns the wheel over is covered by %r, so the notches "
                      "would go to another window." % hit.get("hits"))
                ff.screenshot(args.shot)
                return 1
            at_end = order.index(stepped) == len(order) - 1
            with ff.held("Control"):
                ff.wheel(lane["aim"]["x"], lane["aim"]["y"], 120)
            time.sleep(1.5)
            clamped = read(ff, leaf, stepped)
            still = [h["text"] for h in (clamped.get("heads") or [])]
            print("wheel    +120 under a HELD Control (towards the reader): header %s, dpr %s"
                  % (still, clamped.get("dpr")))
            with ff.held("Control"):
                ff.wheel(lane["aim"]["x"], lane["aim"]["y"], -120)
            time.sleep(2.5)
            back = read(ff, leaf, opens_in)
            if back.get("error"):
                print("\nthe window could not be read after the second Ctrl+wheel: %s"
                      % back["error"])
                ff.screenshot(args.shot)
                return 1
            heads3 = [h["text"] for h in back["heads"]]
            print("wheel    -120 under a HELD Control (away from it): header %s, dpr %s"
                  % (heads3, back.get("dpr")))
            got_cols = [c for c in columns if c in heads3]
            if back.get("dpr") != st.get("dpr"):
                bad.append(("slider", "`devicePixelRatio` moved from %s to %s across two "
                                      "Ctrl+wheels, so the browser zoomed: the window's own "
                                      "listener did not cancel it and every geometry above is in a "
                                      "unit that changed under it"
                            % (st.get("dpr"), back.get("dpr"))))
            elif at_end and not [h for h in still if views[stepped]["label"] in h]:
                bad.append(("slider", "a notch TOWARDS the reader at the last row of the `VIEWS` "
                                      "table left the header %s, and %r is the mode it was already "
                                      "in. `stepView` stops at both ends rather than wrapping"
                            % (still, views[stepped]["label"])))
            elif len(got_cols) != len(columns):
                bad.append(("slider", "a notch AWAY from the reader did not step back to %r: the "
                                      "header is %s and the four column labels are %s. Ctrl+wheel "
                                      "is the only route to a mode for a reader with no pointer"
                            % (opens_in, heads3, columns)))
            else:
                good.append("Ctrl+wheel is the other route and BOTH EDGES hold: a notch towards the "
                            "reader at the end of the table stepped nothing, a notch away from it "
                            "put %r and its four column labels back, and `devicePixelRatio` stayed "
                            "%s — so the window cancelled the browser's own zoom"
                            % (opens_in, back.get("dpr")))

            # ---- 6. THE SEARCH FIELD -------------------------------------------------------
            #
            # IN THE DEFAULT MODE, which is where `rowTop` and three proof pages already aim, and
            # BEFORE the navigation: a query typed in the fixture directory is a query whose match
            # this run built, where one typed after clause 7 would be about whatever the parent holds.
            aims2 = back["aims"] or {}
            if not aims2.get("search"):
                print("\nthe search field could not be found in the restored mode: %s" % aims2)
                ff.screenshot(args.shot)
                return 1
            before_names = [n for n in back["names"] if n in (png_name, rgba_name, note_name)]
            hit = under(ff, aims2["search"])
            print("under    the search field -> %r" % hit.get("hits"))
            if "files" not in str(hit.get("hits")):
                print("\nthe search field's own rectangle is covered by %r, so a press on it would "
                      "go to another window." % hit.get("hits"))
                ff.screenshot(args.shot)
                return 1
            ff.click(aims2["search"]["x"], aims2["search"]["y"])
            time.sleep(pause)
            if search_by == "type":
                ff.type_keys(note_tok)
            else:
                # THE FIELD OPENED AND WAS ABANDONED: `typeStrip` is never reached, so `query` stays
                # empty and `applyFilter` never narrows anything.
                ff.press("Escape")
            time.sleep(2.0)
            found = read(ff, leaf, opens_in)
            if found.get("error"):
                print("\nthe window could not be read after the search: %s" % found["error"])
                ff.screenshot(args.shot)
                return 1
            field = [s["text"] for s in (found.get("strip") or [])
                     if aims2["search"]["fromCss"] <= s["xCss"] <= aims2["search"]["toCss"]]
            matched = [n for n in found["names"] if n in (png_name, rgba_name, note_name)]
            print("search   typed %r (%s): field %s, rows %s"
                  % (note_tok, search_by, field, matched))
            if note_tok not in " ".join(field):
                bad.append(("search", "the search field does not hold what was typed: the runs "
                                      "inside its own rectangle are %s and %r is not among them. A "
                                      "field a reader cannot read back is a field they cannot "
                                      "correct" % (field, note_tok)))
            elif matched != [note_name]:
                bad.append(("search", "a query of %r left %s of the three fixture rows listed, and "
                                      "only %r holds that token. `searchMatch` is a case-folded "
                                      "substring over the NAME, so the other two must go"
                            % (note_tok, matched, note_name)))
            else:
                ff.press("Escape")
                time.sleep(2.0)
                restored = read(ff, leaf, opens_in)
                again = sorted(n for n in (restored.get("names") or [])
                               if n in (png_name, rgba_name, note_name))
                print("escape   rows %s" % again)
                if again != sorted(before_names):
                    bad.append(("search", "Escape did not put the directory back: %s against the "
                                          "%s that were listed before the query. A field abandoned "
                                          "must leave the listing exactly as it was"
                                % (again, sorted(before_names))))
                else:
                    good.append("a real click on the search field took the keyboard, the typed %r "
                                "narrowed three rows to the one name that holds it, and Escape put "
                                "all %d back" % (note_tok, len(again)))

            # ---- 7. THE BREADCRUMB --------------------------------------------------------
            final = read(ff, leaf, opens_in)
            if final.get("error"):
                print("\nthe window could not be read before the crumb press: %s" % final["error"])
                ff.screenshot(args.shot)
                return 1
            segs = final.get("segs") or []
            print("trail    %s" % [s["label"] for s in segs])
            if len(segs) < 2:
                print("\nthe trail has %d segment(s), so there is no parent to press: %s"
                      % (len(segs), segs))
                ff.screenshot(args.shot)
                return 1
            target = segs[-1] if crumb_at == "here" else segs[-2]
            hit = under(ff, target)
            print("under    the %r segment %r -> %r" % (crumb_at, target["label"], hit.get("hits")))
            if "files" not in str(hit.get("hits")):
                print("\nthe %r segment's own rectangle is covered by %r, so a press on it would "
                      "go to another window." % (target["label"], hit.get("hits")))
                ff.screenshot(args.shot)
                return 1
            was = final.get("dir")
            ff.click(target["x"], target["y"])
            time.sleep(2.5)
            # THE WINDOW IS FOUND BY THE SEGMENT'S OWN PATH, so the title it is looked up by is the
            # destination the SEGMENT named and not one this file worked out. A gate that searched
            # for the parent string it computed would pass over a trail whose labels and paths
            # disagree, which is exactly `crumbSegments`' contract.
            arrived = read(ff, target["path"], opens_in, upTo=24)
            if arrived.get("error"):
                bad.append(("crumb", "a real click on the %r segment of the trail opened no "
                                     "listing of %r: %s. `files` windows on screen: %s"
                            % (target["label"], target["path"], arrived["error"],
                               arrived.get("titles"))))
            elif arrived.get("dir") == was and was != target["path"]:
                bad.append(("crumb", "a real click on the %r segment did not navigate: the window "
                                     "is still looking at %r and the segment carried %r"
                            % (target["label"], was, target["path"])))
            elif arrived.get("dir") == was:
                bad.append(("crumb", "the press landed on the segment the window was ALREADY in "
                                     "(%r), and nothing moved. `goToCrumb` answers false for the "
                                     "directory it is looking at, which is what this reading is "
                                     "about" % was))
            elif arrived.get("dir") != target["path"]:
                bad.append(("crumb", "the window's own title says %r and the segment pressed "
                                     "carried %r. A trail that navigates somewhere other than the "
                                     "path it drew is a trail a reader cannot use"
                            % (arrived.get("dir"), target["path"])))
            elif leaf not in (arrived.get("names") or []):
                bad.append(("crumb", "the listing of %r does not hold %r, which is the directory "
                                     "the window was in: its rows are %s. Arriving at a path is "
                                     "not the same fact as listing it"
                            % (target["path"], leaf, (arrived.get("names") or [])[:14])))
            else:
                good.append("a real click on the %r segment of the trail — aimed at the rectangle "
                            "`crumbSegments` says its label was drawn inside — arrived at %r, which "
                            "is the path THAT SEGMENT carried, with %r listed as a row in it"
                            % (target["label"], target["path"], leaf))

            ff.screenshot(args.shot)
            print("shot     %s" % args.shot)
    finally:
        if httpd is not None:
            httpd.shutdown()

    print()
    for line in good:
        print("ok   %s" % line)
    for tag, line in bad:
        print("%s  [%s] %s" % ("would report" if on else "BAD ", tag, line))

    if on:
        fired = sorted({tag for tag, _ in bad if tag in proof_tags})
        collapsed = sorted({tag for tag, _ in bad if tag in kept_tags})
        loose = sorted({tag for tag, _ in bad} - set(proof_tags) - set(kept_tags))
        if loose:
            print("\nunscoped and red: %s. Neither claimed nor kept by `%s`, so it is reported and "
                  "not scored." % (", ".join(loose), args.control))
        # EXIT 0 WHEN THE PROOF SUCCEEDED, which is `scripts/check.py`'s convention: a non-zero exit
        # is reserved for a proof that failed to fail.
        if collapsed:
            print("\nTHE PROOF FAILED: `%s` also moved %s, which it must not touch. A control "
                  "satisfied by any failure verifies nothing." % (args.control, collapsed))
            return 1
        if fired:
            print("\nthe proof succeeded: `%s` fired %s of the %s clause(s), and %s stayed green."
                  % (args.control, fired, ", ".join(proof_tags), ", ".join(kept_tags)))
            return 0
        print("\nTHE PROOF FAILED: `%s` fired none of %s, so those clauses are not reading what "
              "the control changes." % (args.control, ", ".join(proof_tags)))
        return 1

    if bad:
        return 1
    print("\na reader can change how a folder looks and find what is in it: the view button and "
          "Ctrl+wheel each reach a mode, a picture file shows its OWN pixels at the extent "
          "`thumbFit` owes at THIS engine's ratio, a file nothing can decode keeps its named type "
          "icon, a typed query narrows the listing and Escape puts it back, and a press on the "
          "trail arrives at the path that segment carried — in FIREFOX, on the landing page, with "
          "real trusted input")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
