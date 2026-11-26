#!/usr/bin/env python3
"""DOES THE DETAILS VIEW RESPOND TO A REAL HAND? M19's three new gestures in FIREFOX, on the
LANDING page.

    python3 bench/m19-details/firefox-details.py                 # the gate
    python3 bench/m19-details/firefox-details.py --prove-failure  # ...and it MUST report failures
    python3 bench/m19-details/firefox-details.py --control stable-sort-off --prove-failure
    python3 bench/m19-details/firefox-details.py --headed         # in a window you can watch

WHY THIS FILE EXISTS. `CLAUDE.md` makes a second engine a condition of reporting a milestone done,
and records the bill for skipping it: M4a shipped a window that could not be dragged in Firefox
(constraint 175), M6 a policy under which no process started there (206), M11 and M12 each a
geometry derived from a dpr-2 constant (264), M14 a desktop a reader could not open anything on
(289), and M17 a bare URL that threw in both engines while the suite stayed green. Six
milestones, every Chrome expectation green each time, every one found by a person opening a page.

M19'S THREE GESTURES ARE EXACTLY THE SHAPE THAT BILL COMES IN.

  - A HEADER PRESS is a hit test against `columnAt` at a CSS-px x, and a column's box is a FRACTION
    of the client width: a driver that handed it device pixels would sort the column next door, and
    at dpr 1 the two numbers are equal and the defect is invisible. Firefox renders at dpr 1 here,
    so this gate is the half of the pair where the bug HIDES. Every point it aims is derived from a
    MEASURED rect and `src/bin/files.mjs`'s own `columnBoxes`, never from a constant — and this run
    is why that is not pedantry: the client box measures 428 CSS px, not the 420 of `START_W`, so a
    gate that had derived its column centres from the program's opening width would have aimed 4 px
    off every boundary. That is the discipline constraints 264 and 297 were written out of.
  - A HOVER is new plumbing end to end: a buttonless `pointermove` the page posted for the first
    time in M19 (`src/wm/winhost.mjs`), a tail replacement in the kernel
    (`Window.pushPointer`), and a lit row in the program. Three layers, no error anywhere if the
    middle one drops the record, and a screenshot cannot tell an unlit row from an inert one
    (constraint 40).
  - A SHIFT+CLICK needs the modifier to survive the engine's own input plumbing. A dropped
    modifier is a DIFFERENT gesture and not a weaker one: without it a Shift+press is a plain
    press, which selects exactly one row and reports no error at all.

IT RUNS ON `www/index.html`, THE BARE URL, so what is driven is the product and not a proof page
(constraint 283). That costs a fixture — the landing desktop stages `term` and nothing else — so
the fixture is built by TYPING AT THE REAL PROMPT with trusted keys:

    rm -r -f /tmp/m19ff ; mkdir -p /tmp/m19ff/sub ; touch .../a.txt .../b.png .../c.txt
    files /tmp/m19ff &

THE FIXTURE IS CHOSEN SO THAT EACH CLAUSE HAS A DIFFERENT ANSWER. Sorting by `Type` must produce
an order that name-ascending does not, and reversing it must produce a third:

    name  asc  (the opening order) sub  a.txt  b.png  c.txt
    type  asc                      sub  b.png  a.txt  c.txt      `png` sorts before `text`
    type  desc                     sub  a.txt  c.txt  b.png      and the `text` tie stays ascending

`sub` IS FIRST IN ALL THREE, because "directories first" is not a reading of a column and does not
turn over (`compareRows` term 1). The three-row `.txt`/`.png` spread is what gives the second click
something to reverse and `--stable-sort-off` something to disturb.

WHAT IS ASSERTED, and every row of it is read back out of the display list the program actually
drew — decoded with `src/abi.mjs`'s own `decodeDrawOps`/`textOfOps` and located with
`src/bin/files.mjs`'s own `FILES_METRICS`, so the gate and the renderer share one arithmetic and
there is no second copy of a row's geometry, a column's box or a cell's format here:

  1. `sort`        a press on the `Type` header reorders the list to type-ascending AND moves the
                   caret onto that column, pointing up. Both halves: a caret that moved over rows
                   that did not is a header that lies, and rows that moved under a caret that did
                   not is a reader who cannot tell what they are looking at.
  2. `reverse`     a second press on the same header turns it over — the third order above, with
                   the caret pointing down and the `text` tie still ascending.
  3. `range`       a plain click then a SHIFT+click selects the whole inclusive range, read two
                   independent ways: the outlined row bands in the list, and the program's own
                   `N selected` run in the status strip. Either alone could be right while the
                   other is wrong, and a reader sees both.
  4. `hover`       a BUTTONLESS move over a row lights it — a band under the row with no outline,
                   which is what distinguishes it from a selection — and the selection stays EMPTY,
                   because a reader moving the pointer across a list has chosen nothing.
  5. `hover-moved` a second move lights the second row and UNLIGHTS the first. Exactly one row is
                   lit; a gate that only asserted "the second row is lit" would pass for a program
                   that lights every row it is ever hovered over.
  6. `leave`       moving the pointer off the window clears the light. Asserted as a TRANSITION —
                   something was lit, and then nothing was — so a world where nothing was ever lit
                   fails this clause rather than passing it vacuously.

THE ORDER IS NOT ARBITRARY. `files` opens its window to exactly fit its content
(`clientHeightFor`), so there is NO empty paper inside the viewport to click the selection off on.
The restore between clause 3 and clause 4 is therefore a press on the `Name` header: `sortBy`
clears the selection and the lit row on its way past (`src/bin/files.mjs`), which is both the
cheapest way back to a known state and a fact worth seeing printed. It is reported loudly and not
scored — a clause needs a reader who cares, and nobody clicks a header to deselect.

THE TWO CONTROLS, each re-runnable from the command line with no source edit:

  `--control held-button` (the default) HOLDS THE MOUSE BUTTON DOWN ACROSS THE TWO HOVER MOVES.
      That is precisely the pre-M19 world: `src/wm/winhost.mjs` carried
      `if (!e.buttons) return;` before this milestone, so the only moves that ever reached a
      program had a button held, and the hover case documented in `src/abi.mjs` was unreachable.
      `hover`, `hover-moved` and `leave` MUST fire; `sort`, `reverse` and `range` MUST NOT — they
      run before the control's first gesture and nothing it does can reach back to them.
  `--control stable-sort-off` SPAWNS `files --stable-sort-off`, the declared argv flag that
      multiplies the stable name term by the direction (`compareRows` term 3). `reverse` MUST fire
      — the `text` tie comes back as `c.txt a.txt`, measured — and `sort`, `hover`, `hover-moved`
      and `leave` MUST NOT. `range` is UNSCOPED under it and the run says so: the selection is a
      range of POSITIONS and the control changes which rows those positions hold, so a kept-green
      claim about it would be a claim about the fixture rather than about the gesture.

A control satisfied by any failure verifies nothing (`CLAUDE.md` §Verification), so each control
names its own subset and the run fails when the other half moves. `--prove-failure` exits 0 when
the proof SUCCEEDED, which is `scripts/check.py`'s convention.
"""
from __future__ import annotations

import argparse
import os
import pathlib
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import bidi   # noqa: E402
import serve  # noqa: E402

#: The fixture, built at a real prompt. `/tmp` is a tmpfs (`src/kernel/kernel.mjs` mounts it), so
#: nothing here outlives the run; `rm -r -f` first makes a second run against a warm page legal.
DIR = "/tmp/m19ff"
#: One directory and three files over two type cells, with a two-row `.txt` tie. The `type` cell is
#: `fmtName(format)` off the extension (`src/bin/files.mjs`'s `kindOf`), so these spell `png` and
#: `text` and an empty `touch`ed file is enough — nothing here decodes a byte.
SUBDIR = "sub"
FILES = ("a.txt", "b.png", "c.txt")

FIXTURE = (
    "rm -r -f %s\n" % DIR,
    "mkdir -p %s/%s\n" % (DIR, SUBDIR),
    "touch %s\n" % " ".join("%s/%s" % (DIR, n) for n in FILES),
)

#: THE THREE ORDERS, and they are the whole reason the fixture is what it is. Derived here from the
#: comparator's own three terms rather than typed per clause, so a fixture change moves all three.
NAME_ASC = (SUBDIR, "a.txt", "b.png", "c.txt")
TYPE_ASC = (SUBDIR, "b.png", "a.txt", "c.txt")
TYPE_DESC = (SUBDIR, "a.txt", "c.txt", "b.png")
#: ...and what `--stable-sort-off` turns the third one into: the `text` tie reversed with its
#: column. MEASURED, by running that control. It is never an EXPECTATION — a control that moved the
#: clause's own claim with it would turn nothing, which is the first version of this file's bug —
#: only a recognised world, named in the failure message so the reader is told which one they are
#: looking at.
TYPE_DESC_UNSTABLE = (SUBDIR, "c.txt", "a.txt", "b.png")

#: The column a header press is aimed at, and the one the restore press is aimed at. `type` and not
#: `name`: the FIRST press on the default column is a CHOICE and not a reversal (`sort.chosen` in
#: `src/bin/files.mjs`), so a gate that clicked `Name` first would assert a reversal that the
#: program correctly does not perform.
SORT_COL = "type"
RESTORE_COL = "name"

#: Which rows the two hover moves are aimed at, as INDICES INTO `NAME_ASC` — the order the restore
#: press puts the list back into. Two FILE rows and not the directory, so the pair is adjacent and
#: a light that failed to move is a light on a row the second move never touched.
HOVER_ROWS = (1, 2)
#: The plain click and the Shift+click, as indices into `TYPE_DESC` — the order clause 2 leaves.
#: 1 and 3, so the range has an INTERIOR row: a range that selected only its endpoints would pass
#: a two-row assertion.
RANGE_FROM = 1
RANGE_TO = 3

#: (proof, kept). A control must move a NAMED subset; the clauses in neither are UNSCOPED and the
#: run prints them as such rather than letting silence read as a claim.
CONTROLS = {
    "held-button": (("hover", "hover-moved", "leave"), ("sort", "reverse", "range")),
    "stable-sort-off": (("reverse",), ("sort", "hover", "hover-moved", "leave")),
}

#: Is there a desktop with a prompt in it yet? The landing page publishes `globalThis.INDEX`; its
#: `state` is the page's own word for "staged", and the terminal is where the fixture is typed.
READY = """JSON.stringify((() => {
  const M = globalThis.INDEX || {}
  const t = document.querySelector('.terminal')
  const r = t ? t.getBoundingClientRect() : null
  return {
    state: String(M.state || ''), phase: String(M.phase || ''), why: String(M.why || ''),
    dpr: devicePixelRatio, errors: (M.errors || []).map(String).slice(0, 4),
    search: location.search,
    term: r ? { x: Math.round(r.left + 30), y: Math.round(r.top + 20) } : null,
    wins: document.querySelectorAll('.window').length,
  }
})())"""

#: INSTALL THE READER, ONCE. Two halves, and neither is a second copy of anything:
#:
#:   - the TAP. A surfaced window's content is a canvas, and the only way to read the rows back is
#:     the batch that drew them. `www/m19.html` taps the kernel message; the landing page publishes
#:     no kernel handle — by design, it is the product — so the tap goes on `Surface.prototype.
#:     replay`, which is the one function every batch passes through. It DELEGATES, so the page
#:     renders exactly what it would have, and it is on the PROTOTYPE so a re-surface does not lose
#:     it. The module is fetched by the URL the host already loaded it under, so this is the same
#:     class object and not a second one.
#:   - the ARITHMETIC. `FILES_METRICS` is imported rather than restated: `columnBoxes`, `rowTop`,
#:     `rowMid`, `toSurface` and the two cell formatters are the program's own, which is the whole
#:     reason that object is exported (`CLAUDE.md`'s `FILES_METRICS` row — two drivers restated the
#:     row geometry and the drift arrived as the wrong file being dragged). A page can import a
#:     program's module even though a process cannot import the page's.
INSTALL = """(async () => {
  const abi = await import('/src/abi.mjs')
  const surf = await import('/src/wm/surface.mjs')
  const files = await import('/src/bin/files.mjs')
  const G = globalThis.__M19FF || (globalThis.__M19FF = { last: new WeakMap() })
  G.abi = abi
  G.M = files.FILES_METRICS
  if (!G.wrapped) {
    const proto = surf.Surface.prototype
    const orig = proto.replay
    proto.replay = function (bytes) {
      G.last.set(this, bytes.slice())
      return orig.call(this, bytes)
    }
    G.wrapped = true
  }
  // STRINGIFIED INSIDE THE PROMISE: BiDi's `script.evaluate` has no top-level `await`, so the
  // expression IS the async call and `awaitPromise` resolves it.
  return JSON.stringify({ ok: true, rowH: G.M.ROW_H, headH: G.M.HEAD_H, footH: G.M.FOOT_H,
                          cols: G.M.COLUMNS.map((c) => c.key) })
})()"""

#: WHAT THE `files` WINDOW HAS DRAWN, where to aim inside it, and how each reading is told apart
#: from the others. Nothing below compares a colour against a literal: the inks of
#: `src/bin/files.mjs` are module-private, so every discriminator here is STRUCTURAL.
#:
#:   A ROW NAME is a run whose x is the `name` column's own `textX`. The three metadata cells hang
#:   off their columns' right edges and the four header labels are bold, so matching the one text
#:   origin `columnBoxes` publishes for names cannot pick up any of them.
#:
#:   A SELECTED ROW is a band at `PAD` WITH an outline at `PAD`; A LIT ROW is a band at `PAD`
#:   WITHOUT one (`src/bin/files.mjs`: the selection strokes `OUTLINE` over its fill and the hover
#:   draws a fill alone). The keyboard cursor's ring is at `PAD + FOCUS_INSET`, a different x, so it
#:   is neither. That is the program's own rule — "a lit row and a selected row must stay two
#:   readings" — read as geometry rather than as a colour this file would have to restate.
#:
#:   THE CARET is three `HEAD_INK` fills at the top of the sorted column's box, descending in width
#:   for ascending and ascending for descending (`sortCaret`). Its column is `columnAt` of its own
#:   centre — the declared inverse of the geometry it was drawn with — and its direction is the SIGN
#:   OF THE WIDTH DIFFERENCE between its first and last bar, so neither is a number typed here.
READ = """JSON.stringify((() => {
  const G = globalThis.__M19FF
  if (!G || !G.abi) return { error: 'the reader was never installed' }
  const host = (globalThis.INDEX || {}).host
  if (!host) return { error: 'the landing page published no window host' }
  let entry = null
  for (const e of host.frames.values()) {
    if (e.surface && String(e.win.titleText || '').startsWith('files')) { entry = e; break }
  }
  if (!entry) return { error: 'no `files` window with a surface' }
  const bytes = G.last.get(entry.surface)
  if (!bytes || !bytes.length) {
    return { error: 'the `files` surface has replayed no batch since the reader was installed' }
  }
  const { decodeDrawOps, textOfOps, DL_TEXT, DL_FILL_RECT, DL_STROKE_RECT, DLT_BOLD } = G.abi
  const M = G.M
  const ops = decodeDrawOps(bytes, bytes.length)
  const runs = []
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i].op !== DL_TEXT) continue
    const got = textOfOps(ops, i)
    if (!got) continue
    runs.push({ text: got.text, x: ops[i].a0, y: ops[i].a1, flags: ops[i].flags })
    i += got.records - 1
  }
  const r = entry.surface.el.getBoundingClientRect()
  // THE SCALE AND THE WIDTH ARE BOTH MEASURED, never assumed: the backing store is device px and
  // the box is CSS px, and the whole of M16 is that those are different numbers (constraint 264).
  const scale = r.width > 0 ? entry.surface.w / r.width : 1
  const wCss = r.width
  const cols = M.columnBoxes(wCss)
  const nameX = M.toSurface((cols.find((c) => c.key === 'name') || {}).textX || 0, scale)
  const padS = M.toSurface(M.PAD, scale)
  const fills = ops.filter((o) => o.op === DL_FILL_RECT)
  const strokes = ops.filter((o) => o.op === DL_STROKE_RECT)
  const names = runs.filter((t) => t.x === nameX && !(t.flags & DLT_BOLD))
                    .sort((a, b) => a.y - b.y)

  // ---- the rows, each with its bands and its three metadata cells ----
  const rows = names.map((n, i) => {
    const top = M.toSurface(M.rowTop(i, 0), scale)
    const high = Math.abs(M.toSurface(M.ROW_H, scale))
    const band = fills.find((o) => o.a0 === padS && Math.abs(o.a1 - top) <= 1
                                   && Math.abs(o.a3 - high) <= 1)
    const ruled = strokes.some((o) => o.a0 === padS && Math.abs(o.a1 - top) <= 1)
    const cells = {}
    for (const c of cols) {
      if (c.key === 'name') continue
      const at = M.toSurface(c.textX, scale)
      const hit = runs.find((t) => t.x === at && Math.abs(t.y - n.y) <= 1)
      cells[c.key] = hit ? hit.text : ''
    }
    return { name: n.text, cells, selected: ruled, lit: !!band && !ruled,
             fill: band ? band.a4 : 0 };
  })

  // ---- the caret: which column the sort is on, and which way it points ----
  const headTop = M.toSurface(4, scale)
  const bars = fills.filter((o) => o.a1 <= headTop && o.a0 > padS && o.a2 <= padS)
                    .sort((a, b) => a.a1 - b.a1)
  let caret = { key: null, dir: 0, bars: bars.length }
  if (bars.length >= 2) {
    const mid = (bars[0].a0 + bars[0].a2 / 2) / scale
    const span = bars[bars.length - 1].a2 - bars[0].a2
    caret = { key: M.columnAt(mid, wCss), dir: span < 0 ? 1 : (span > 0 ? -1 : 0),
              bars: bars.length }
  }

  const at = (x, y) => ({ x: Math.round(r.left + x), y: Math.round(r.top + y) })
  return {
    title: String(entry.win.titleText || ''), id: entry.id, scale, wCss,
    batches: entry.surface.batches,
    names: rows.map((x) => x.name),
    cells: rows.map((x) => x.cells),
    selected: rows.filter((x) => x.selected).map((x) => x.name),
    lit: rows.filter((x) => x.lit).map((x) => x.name),
    litFill: (rows.find((x) => x.lit) || {}).fill || 0,
    selFill: (rows.find((x) => x.selected) || {}).fill || 0,
    caret,
    // The program's OWN count of its selection, in its own words, from the status strip. A second
    // and independent reading of clause 3: `N selected` is a run of its own precisely so neither
    // it nor the position statement can be mistaken for the other (`src/bin/files.mjs`).
    count: (runs.find((t) => / selected$/.test(t.text)) || {}).text || '',
    place: (runs.find((t) => /^\\d+ items?$/.test(t.text)
                            || /^\\d+-\\d+ of \\d+$/.test(t.text)) || {}).text || '',
    // WHERE TO AIM, in viewport CSS px. A row's point is `rowMid` — the function the program's own
    // hit test is the declared inverse of — and a header's is the CENTRE of `columnBoxes`'s own
    // rectangle, above `VIEW_TOP`. Both from the export; neither is a coordinate typed here.
    rows: rows.map((x, i) => ({ name: x.name, ...at(M.NAME_X + 10, M.rowMid(i, 0)) })),
    headers: cols.map((c) => ({ key: c.key, ...at(c.x + c.w / 2, M.HEAD_H / 2) })),
    // Off the window entirely, for the leave: past the FRAME's right edge and not merely past the
    // canvas, since a point still inside the chrome is still inside the window.
    off: { x: Math.round(entry.win.el.getBoundingClientRect().right + 24),
           y: Math.round(r.top + 8) },
  }
})())"""

#: The app windows a reader would count, by title. The desktop is `role === '1'` and is not one.
WINDOWS = """JSON.stringify([...document.querySelectorAll('.window')]
  .filter((w) => w.dataset.role !== '1')
  .map((w) => ((w.querySelector('h2') || {}).textContent || '').trim()))"""

#: WHAT A HIT TEST FINDS at a point, because a covered canvas and an inert one are the same picture
#: (constraint 40). Every gesture below is aimed through this, so a press that went to another
#: window is reported rather than silently counted as a program that did nothing.
UNDER = """JSON.stringify((() => {
  const el = document.elementFromPoint(%d, %d)
  if (!el) return { hits: 'nothing' }
  const frame = el.closest ? el.closest('.window') : null
  return { tag: String(el.tagName || ''),
           hits: frame ? ((frame.querySelector('h2') || {}).textContent || '').trim()
                       : 'no window' }
})())"""


def settle(ff, tries: int = 90) -> dict:
    """Wait for the desktop to stage and its layout to stop moving.

    THE SECOND HALF IS NOT DECORATION. The page prints its own log, the log grows, and the desktop
    is pushed down under it — measured on m14, an icon at y=65 became y=249 — so a rect read before
    that and clicked after is clicked where nothing is. Two identical reads is the signal, which is
    `bench/m14-shell/firefox-drive.py`'s rule for the same hazard.
    """
    last, stable = None, 0
    st: dict = {}
    for _ in range(tries):
        st = ff.evaluate(READY)
        now = None if not st.get("term") else (st["term"]["x"], st["term"]["y"], st["wins"])
        stable = stable + 1 if now and now == last and st.get("state") == "done" else 0
        last = now
        if stable >= 2:
            return st
        time.sleep(0.4)
    return st


def read(ff) -> dict:
    got = ff.evaluate(READ)
    return got if isinstance(got, dict) else {"error": "the reader returned %r" % (got,)}


def under(ff, point: dict) -> dict:
    got = ff.evaluate(UNDER % (int(point["x"]), int(point["y"])))
    return got if isinstance(got, dict) else {}


def aim(state: dict, where: str, key) -> dict | None:
    """A point from the page's OWN aim, by row name or by column key. Never computed here."""
    field = "rows" if where == "row" else "headers"
    for row in state.get(field) or []:
        if row.get("name" if where == "row" else "key") == key:
            return row
    return None


def shift_click(ff, point: dict) -> None:
    """A click with Shift HELD ACROSS IT, as one action sequence over two input sources.

    TWO SOURCES IN ONE `input.performActions`, AND NOT TWO CALLS. WebDriver ticks every source in
    the sequence in lockstep, so the keyDown is delivered before the pointerDown of the same tick
    and the keyUp after the pointerUp — which is the only spelling the spec guarantees. Sending the
    modifier as its own call relies on the session's input state surviving between commands, and a
    dropped Shift is a DIFFERENT gesture rather than a weaker one: a plain press, which selects one
    row and reports nothing wrong anywhere.

    The pauses pad the key source to the pointer source's length. A source with fewer actions than
    the longest one simply idles, but padding makes the tick each key lands on explicit.
    """
    shift = bidi.KEYS["Shift"]
    x, y = int(point["x"]), int(point["y"])
    ff.call("input.performActions", {"context": ff.ctx, "actions": [
        {"type": "key", "id": "keyboard1", "actions": [
            {"type": "keyDown", "value": shift},
            {"type": "pause", "duration": 0},
            {"type": "pause", "duration": 0},
            {"type": "keyUp", "value": shift}]},
        {"type": "pointer", "id": "mouse1", "parameters": {"pointerType": "mouse"}, "actions": [
            {"type": "pointerMove", "x": x, "y": y},
            {"type": "pointerDown", "button": 0},
            {"type": "pointerUp", "button": 0},
            {"type": "pause", "duration": 0}]},
    ]})


def hover_moves(ff, points: list[dict], *, held: bool) -> None:
    """One hover sample or a run of them, buttonless — or with the button HELD, the control.

    HELD IS THE PRE-M19 WORLD AND NOT A WEAKER HOVER. `src/wm/winhost.mjs` carried
    `if (!e.buttons) return;` before this milestone, so every move that reached a program had a
    button down and the hover case `src/abi.mjs` documents was unreachable. `c` carries
    `event.buttons`, so the record itself is what the program and the kernel both test — holding
    the button is holding that field non-zero, which is exactly the record the old line produced.
    """
    actions: list = [{"type": "pointerMove", "x": int(points[0]["x"]), "y": int(points[0]["y"])}]
    if held:
        actions.append({"type": "pointerDown", "button": 0})
    for p in points[1:]:
        actions.append({"type": "pause", "duration": 120})
        actions.append({"type": "pointerMove", "x": int(p["x"]), "y": int(p["y"])})
    if held:
        actions.append({"type": "pointerUp", "button": 0})
    ff.pointer(actions)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--url", default="", help="an already-running server; otherwise one is bound")
    ap.add_argument("--page", default="/www/index.html",
                    help="the landing page, at its BARE url: no query, no proofs")
    ap.add_argument("--w", type=int, default=1560)
    ap.add_argument("--h", type=int, default=1010)
    ap.add_argument("--settle", type=float, default=1.4,
                    help="seconds between gestures. Over the platform's double-click threshold, so "
                         "two single clicks on one row are not read as an activation")
    ap.add_argument("--shot", default=str(HERE / "firefox-details.png"))
    ap.add_argument("--control", choices=sorted(CONTROLS), default="held-button",
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
    #: THE TWO THINGS A CONTROL MAY CHANGE, and each world changes exactly one of them.
    held = on and args.control == "held-button"
    flags = " --stable-sort-off" if on and args.control == "stable-sort-off" else ""

    httpd = None
    url = args.url
    if not url:
        os.chdir(REPO)
        httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d%s" % (httpd.server_address[1], args.page)
    print("url      %s" % url)
    if on:
        print("control  --control %s: %s. %s MUST fire; %s MUST NOT"
              % (args.control,
                 "the hover moves are driven with the button HELD" if held
                 else "`files%s` is spawned" % flags,
                 ", ".join(proof_tags), ", ".join(kept_tags)))
        unscoped = sorted({"sort", "reverse", "range", "hover", "hover-moved", "leave"}
                          - set(proof_tags) - set(kept_tags))
        if unscoped:
            print("         unscoped under it: %s — neither claimed nor kept" % ", ".join(unscoped))

    #: (tag, message). The tag is what `--prove-failure` scopes its proof to.
    bad: list[tuple[str, str]] = []
    good: list[str] = []
    pause = max(0.2, args.settle)
    try:
        with bidi.Firefox(headless=not args.headed, width=args.w, height=args.h) as ff:
            ff.navigate(url)
            st = settle(ff)
            print("firefox  dpr %s  state=%r phase=%r search=%r"
                  % (st.get("dpr"), st.get("state"), st.get("phase"), st.get("search")))
            if st.get("errors"):
                print("page     errors %s" % st["errors"])
            if st.get("search"):
                print("\nthis is not the bare url: location.search is %r" % st["search"])
                return 1
            if not st.get("term"):
                print("\nno terminal ever appeared, so the fixture cannot be typed. why=%r"
                      % st.get("why"))
                ff.screenshot(args.shot)
                return 1

            # ---- the reader, then the fixture, typed at a REAL prompt ----
            got = ff.evaluate(INSTALL)
            print("reader   %s" % got)
            if not isinstance(got, dict) or not got.get("ok"):
                print("\nthe display-list reader could not be installed, so nothing below could be "
                      "read back out of what was drawn: %s" % (got,))
                return 1

            ff.click(st["term"]["x"], st["term"]["y"])
            for line in FIXTURE:
                ff.type_keys(line)
                time.sleep(0.6)
            ff.type_keys("files%s %s &\n" % (flags, DIR))
            time.sleep(4.0)

            state = read(ff)
            if state.get("error"):
                print("\nthe `files` window could not be read: %s" % state["error"])
                ff.screenshot(args.shot)
                return 1
            print("files    title=%r scale=%s wCss=%s batches=%s place=%r"
                  % (state["title"], state["scale"], round(state["wCss"], 2),
                     state["batches"], state["place"]))
            print("rows     %s" % state["names"])
            print("cells    %s" % [c.get("type") for c in state["cells"]])
            print("caret    %s" % (state["caret"],))
            if tuple(state["names"]) != NAME_ASC:
                print("\nthe fixture is not what this gate was written against: %s, wanted %s. The "
                      "typed `mkdir`/`touch` lines did not take, so every clause below would be "
                      "about a different directory." % (state["names"], list(NAME_ASC)))
                ff.screenshot(args.shot)
                return 1
            if not state["place"].endswith("items"):
                print("\nthe list is SCROLLED (%r), so `rowMid(i, 0)` is not where row i is and "
                      "every aim point below would miss." % state["place"])
                ff.screenshot(args.shot)
                return 1
            if state["caret"]["key"] != "name" or state["caret"]["dir"] != 1:
                print("\nthe opening caret is not on `name` ascending (%s), so the two sort clauses "
                      "below would be measuring from an unknown state." % (state["caret"],))
                ff.screenshot(args.shot)
                return 1

            # ---- 1. A PRESS ON THE `Type` HEADER SORTS BY IT ----
            head = aim(state, "header", SORT_COL)
            if not head:
                print("\nthe page published no aim point for the %r column." % SORT_COL)
                return 1
            hit = under(ff, head)
            print("header   %-5s at %s,%s  hit test finds %r"
                  % (SORT_COL, head["x"], head["y"], hit.get("hits")))
            if "files" not in str(hit.get("hits")):
                print("\nthe %r header is covered by %r, so a press there would go to another "
                      "window." % (SORT_COL, hit.get("hits")))
                ff.screenshot(args.shot)
                return 1
            ff.click(head["x"], head["y"])
            time.sleep(pause)
            asc = read(ff)
            print("sort     rows=%s caret=%s" % (asc.get("names"), asc.get("caret")))
            if tuple(asc.get("names") or ()) != TYPE_ASC:
                bad.append(("sort", "a press on the %r header left the rows %s, not %s"
                            % (SORT_COL, asc.get("names"), list(TYPE_ASC))))
            elif (asc["caret"]["key"], asc["caret"]["dir"]) != (SORT_COL, 1):
                bad.append(("sort", "the rows sorted by %r but the caret says %s — a header that "
                                    "lies about which column a reader is looking at"
                            % (SORT_COL, asc["caret"])))
            else:
                good.append("a press on the %r header sorted by it ascending: %s, caret %s"
                            % (SORT_COL, asc["names"], asc["caret"]["key"]))

            # ---- 2. A SECOND PRESS REVERSES IT ----
            time.sleep(pause)
            ff.click(head["x"], head["y"])
            time.sleep(pause)
            desc = read(ff)
            print("reverse  rows=%s caret=%s" % (desc.get("names"), desc.get("caret")))
            if tuple(desc.get("names") or ()) != TYPE_DESC:
                bad.append(("reverse", "a second press on the %r header left the rows %s, not %s%s"
                            % (SORT_COL, desc.get("names"), list(TYPE_DESC),
                               ". That is the `text` tie reversed WITH its column, which is the "
                               "stable term multiplied by the direction: a reader who reverses a "
                               "sort finds the rows inside each group shuffled as well"
                               if tuple(desc.get("names") or ()) == TYPE_DESC_UNSTABLE else "")))
            elif desc["caret"]["dir"] != -1:
                bad.append(("reverse", "the rows reversed but the caret still points %s"
                            % ("up" if desc["caret"]["dir"] > 0 else "nowhere")))
            else:
                good.append("a second press reversed it and turned the caret over: %s"
                            % (desc["names"],))
            # CLAUSE 3 AIMS AT WHAT IS ON SCREEN, not at what clause 2 wanted. The range is a range
            # of POSITIONS, so a world in which clause 2 is red still has three adjacent rows for a
            # Shift+click to take — which is why `range` is UNSCOPED under `--stable-sort-off`
            # rather than claimed green: the gesture works and the names it selects are the
            # control's.
            order = list(desc.get("names") or TYPE_DESC)

            # ---- 3. A PLAIN CLICK THEN A SHIFT+CLICK SELECTS THE RANGE ----
            time.sleep(pause)
            first = aim(desc, "row", order[RANGE_FROM]) if len(order) > RANGE_TO else None
            last = aim(desc, "row", order[RANGE_TO]) if len(order) > RANGE_TO else None
            if not first or not last:
                print("\nthe rows %s do not include both ends of the range, so clause 3 has "
                      "nothing to select." % order)
                ff.screenshot(args.shot)
                return 1
            want_sel = order[RANGE_FROM:RANGE_TO + 1]
            ff.click(first["x"], first["y"])
            time.sleep(pause)
            one = read(ff)
            print("click    %-6s -> selected %s count=%r"
                  % (order[RANGE_FROM], one.get("selected"), one.get("count")))
            shift_click(ff, last)
            time.sleep(pause)
            ranged = read(ff)
            print("shift    %-6s -> selected %s count=%r"
                  % (order[RANGE_TO], ranged.get("selected"), ranged.get("count")))
            got_sel = list(ranged.get("selected") or [])
            if got_sel != want_sel:
                bad.append(("range", "a plain click on %r then a SHIFT+click on %r selected %s, "
                                     "not the range %s. A dropped Shift is a plain press, which "
                                     "selects one row and reports nothing wrong"
                            % (order[RANGE_FROM], order[RANGE_TO], got_sel, want_sel)))
            elif ranged.get("count") != "%d selected" % len(want_sel):
                bad.append(("range", "the list shows %s selected but the program's own strip says "
                                     "%r — two readings of one fact that disagree"
                            % (got_sel, ranged.get("count"))))
            else:
                good.append("a plain click then a SHIFT+click selected the range %s, and the "
                            "program's own strip says %r" % (got_sel, ranged["count"]))

            # ---- RESTORE, NOT A CLAUSE: a header press clears the selection and the light ----
            # `files` opens its window to exactly fit its content (`clientHeightFor`), so there is
            # no empty paper inside the viewport to click a selection off on. `sortBy` clears both
            # on its way past, which is the only route back to a known state from here.
            time.sleep(pause)
            back = aim(ranged, "header", RESTORE_COL)
            if not back:
                print("\nthe page published no aim point for the %r column, so there is no route "
                      "back to an unselected list." % RESTORE_COL)
                ff.screenshot(args.shot)
                return 1
            ff.click(back["x"], back["y"])
            time.sleep(pause)
            clean = read(ff)
            print("restore  %-5s -> rows=%s selected=%s lit=%s"
                  % (RESTORE_COL, clean.get("names"), clean.get("selected"), clean.get("lit")))
            if tuple(clean.get("names") or ()) != NAME_ASC or clean.get("selected"):
                print("\nthe %r header press did not restore a clean name-ascending list: rows %s, "
                      "selected %s. The hover clauses need an unselected row to light, because a "
                      "selected one reads as selected by the program's own rule."
                      % (RESTORE_COL, clean.get("names"), clean.get("selected")))
                ff.screenshot(args.shot)
                for tag, line in bad:
                    print("BAD  [%s] %s" % (tag, line))
                return 1

            # ---- 4+5. A BUTTONLESS MOVE LIGHTS A ROW, AND A SECOND MOVES THE LIGHT ----
            time.sleep(pause)
            points = [aim(clean, "row", NAME_ASC[i]) for i in HOVER_ROWS]
            if any(p is None for p in points):
                print("\nthe hover rows %s are not all drawn in %s."
                      % ([NAME_ASC[i] for i in HOVER_ROWS], clean.get("names")))
                return 1
            hit = under(ff, points[0])
            if "files" not in str(hit.get("hits")):
                print("\nthe row %r is covered by %r, so a move over it would be a move over "
                      "another window." % (NAME_ASC[HOVER_ROWS[0]], hit.get("hits")))
                ff.screenshot(args.shot)
                return 1
            hover_moves(ff, [points[0]], held=held)
            time.sleep(1.0)
            first_lit = read(ff)
            print("hover    %-6s -> lit=%s selected=%s fill=%s"
                  % (NAME_ASC[HOVER_ROWS[0]], first_lit.get("lit"), first_lit.get("selected"),
                     hex(first_lit.get("litFill") or 0)))
            want_lit = NAME_ASC[HOVER_ROWS[0]]
            if list(first_lit.get("lit") or []) != [want_lit]:
                bad.append(("hover", "a buttonless move over %r lit %s, not exactly [%r]. The "
                                     "record is a `WEV_POINTER` with neither button bit and `c` "
                                     "zero; one of the page, the kernel's tail replacement or the "
                                     "program dropped it"
                            % (want_lit, first_lit.get("lit"), want_lit)))
            elif first_lit.get("selected"):
                bad.append(("hover", "the move over %r lit it AND selected %s. A reader moving the "
                                     "pointer across a list has chosen nothing"
                            % (want_lit, first_lit.get("selected"))))
            else:
                good.append("a buttonless move over %r lit it and selected nothing (band %s)"
                            % (want_lit, hex(first_lit["litFill"])))

            hover_moves(ff, [points[1]], held=held)
            time.sleep(1.0)
            moved = read(ff)
            second = NAME_ASC[HOVER_ROWS[1]]
            print("hover    %-6s -> lit=%s" % (second, moved.get("lit")))
            if list(moved.get("lit") or []) == [second]:
                good.append("a second move lit %r and unlit %r — exactly one row lit"
                            % (second, want_lit))
            else:
                bad.append(("hover-moved", "a move from %r to %r left %s lit. Exactly one row may "
                                           "be lit: a program that lights every row it is hovered "
                                           "over passes a clause that only looks for the new one"
                            % (want_lit, second, moved.get("lit"))))

            # ---- 6. THE POINTER LEAVES, AND THE LIGHT GOES ----
            was_lit = list(moved.get("lit") or []) or list(first_lit.get("lit") or [])
            time.sleep(pause)
            off = moved.get("off") or clean.get("off")
            hit = under(ff, off)
            print("leave    off to %s,%s  hit test finds %r" % (off["x"], off["y"],
                                                                hit.get("hits")))
            # THE POINT MUST BE OUTSIDE THE FRAME AND NOT MERELY OUTSIDE THE CANVAS, because a
            # `pointerleave` fires on the surface element: a point still inside the window's chrome
            # would clear the light and prove nothing about a pointer that left. The page aims past
            # the FRAME's right edge, and this is the reading that says it landed there.
            if "files" in str(hit.get("hits")):
                print("\nthe off-window point %s,%s is still inside %r, so a move to it is not a "
                      "pointer leaving the window." % (off["x"], off["y"], hit.get("hits")))
                ff.screenshot(args.shot)
                for tag, line in bad:
                    print("BAD  [%s] %s" % (tag, line))
                return 1
            ff.move(off["x"], off["y"])
            time.sleep(1.0)
            gone = read(ff)
            print("         lit=%s" % (gone.get("lit"),))
            if not was_lit:
                bad.append(("leave", "nothing was lit before the pointer left, so there was no "
                                     "light for the leave to clear. The clause is a TRANSITION and "
                                     "a world that never lit a row fails it rather than passing "
                                     "it vacuously"))
            elif gone.get("lit"):
                bad.append(("leave", "the pointer left the window and %s stayed lit. Without the "
                                     "`WPTR_LEAVE` record the last hover a window ever gets is the "
                                     "one nearest the edge, and that row stays lit for ever"
                            % (gone.get("lit"),)))
            else:
                good.append("the pointer left the window and the light on %s went out"
                            % (was_lit,))

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
        # EXIT 0 WHEN THE PROOF SUCCEEDED, which is `scripts/check.py`'s convention: a non-zero
        # exit is reserved for a proof that failed to fail.
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
    print("\na header press sorts and a second reverses, a plain click then a Shift+click selects "
          "the range, a buttonless move lights a row and moving off clears it — in FIREFOX, on the "
          "landing page, with real trusted input")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
