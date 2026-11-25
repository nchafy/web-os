#!/usr/bin/env python3
"""DOES A ROW OPEN, AND DOES THE KEYBOARD REACH IT? M18's gestures in FIREFOX, on the LANDING page.

    python3 bench/m18-keys/firefox-keys.py                  # the gate
    python3 bench/m18-keys/firefox-keys.py --prove-failure   # ...and it MUST report failures
    python3 bench/m18-keys/firefox-keys.py --headed          # in a window you can watch
    python3 bench/m18-keys/firefox-keys.py --url http://127.0.0.1:8000/www/index.html

WHY THIS FILE EXISTS. `CLAUDE.md` makes a second engine a condition of reporting a milestone done
and records the bill for skipping it: M4a shipped a window that could not be dragged in Firefox
(constraint 175), M6 shipped a policy under which no process started there (206), M11 and M12 each
asserted a geometry derived from a dpr-2 constant (264), and M14 shipped a desktop on which a reader
could not open anything after the first launch (289). Five milestones, every Chrome expectation
green each time, every one found by a person opening the page.

M18's subject is the two gestures a file manager IS — a row that opens and a cursor that walks — and
both arrive from the engine rather than from this project's own code: the ACTIVATION is the
platform's click count off a DOM event, and the CURSOR is a `key` string looked up in a table. Those
are exactly the two kinds of fact that differ between engines without anything erroring, so this is
the likeliest repeat of that bill yet.

IT RUNS ON `www/index.html`, THE BARE URL, so what is driven is the product and not a proof page
(constraint 283). That costs a fixture — the landing desktop stages `term` and nothing else — so the
fixture is built by TYPING AT THE REAL PROMPT with trusted keys, which is the same hand the gate is
about:

    mkdir -p /tmp/m18ff/sub ; touch /tmp/m18ff/note.txt ; ... ; files /tmp/m18ff &

WHAT IS ASSERTED, and every row of it is read back out of the display list the program actually
drew — decoded with `src/abi.mjs`'s own `decodeDrawOps`/`textOfOps` and located with
`src/bin/files.mjs`'s own `FILES_METRICS`, so the gate and the renderer share one arithmetic and
there is no second copy of a row's geometry here (`CLAUDE.md`'s `FILES_METRICS` row):

  1. `one-click`  a single click on a FILE row opens nothing: no new window, same rows, same title.
     The row is one that WOULD open something if it were activated, which is what makes the clause
     about the click count rather than about an inert program.
  2. `relist`     a DOUBLE click on a directory row re-lists the window — the drawn names become the
     child's and the title names the child.
  3. `back`       Backspace returns to the parent — Windows 7's own binding, and byte 127 rather
     than a keysym.
  4. `arrow`      a real Down arrow moves the keyboard cursor off the row a click left it on. The
     cursor is read as the PIXELS it is drawn as: the stroked ring at `focusBox`'s own x, matched to
     the name run inside it. An arrow is `null` from `bytesForKey`, so before M18 nothing downstream
     heard it at all.
  5. `enter`      Enter then opens THE ROW THE ARROW REACHED, and the new window's title must name
     that row and not the one the click had selected. A gate that only counted windows would pass
     for a keyboard that moved nothing.

THE ORDER IS MEASURED AND NOT ARBITRARY. `enter` opens an `editor`, and `editor` opens at the same
origin `files` did — measured, its frame covers the `files` header — so a clause that needed to
re-focus the file list AFTER that clicked the editor instead and sent its Backspace to the wrong
program. `back` therefore runs first, while nothing is on top, and `enter` is last because nothing
needs the window afterwards.

`--prove-failure` SENDS `j` WHERE THE ARROW GOES: a key the program binds nothing to, which is the
pre-M18 world in which an arrow reached `files` as nothing. The `arrow` clause MUST then fire, and
`enter` with it — Enter opens the row the CLICK selected, which is the defect stated as a wrong
window title — while `relist`, `one-click` and `back` MUST stay green. A control satisfied by any
failure verifies nothing (`CLAUDE.md` §Verification). It exits 0 when the proof SUCCEEDED.

A MEASURED DEFECT THIS GATE REPORTS RATHER THAN WORKS AROUND. `src/wm/winhost.mjs:754` reads the
click count off a `pointerdown`, and `pointerdown.detail` is 0 on BOTH presses of a double-click IN
BOTH ENGINES while `mousedown.detail` is 1 then 2 — measured by this directory's own
`python3 bench/m18-keys/clickcount.py`, and specified that way by Pointer Events Level 3, so no
browser version will change it. `WPTR_CLICK2` therefore reaches no program anywhere, and clause 2 is
RED until the DOWN record's bits come from a `mousedown` on the same element. When that clause fails
the gate ENTERS THE DIRECTORY WITH ENTER INSTEAD, announces that it did, and runs clauses 3-5
anyway: one named failure and four live clauses is worth more than five cascading ones, and the
fallback is printed so it can never be mistaken for a pass.
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
#: nothing here outlives the run, and `mkdir -p` makes a second run against a warm profile legal.
DIR = "/tmp/m18ff"
#: The one file row in the parent: a `.txt`, so `std.OPENS_FILES` HAS an opener for it and clause 1
#: is about the click count rather than about a file nothing opens.
PARENT_FILE = "note.txt"
#: The child's two rows, in the order `files` sorts them (directories first, then by name).
CHILD_ROWS = ("inner.txt", "other.txt")

FIXTURE = (
    "mkdir -p %s/sub\n" % DIR,
    "touch %s/%s\n" % (DIR, PARENT_FILE),
    "touch %s/sub/%s\n" % (DIR, CHILD_ROWS[0]),
    "touch %s/sub/%s\n" % (DIR, CHILD_ROWS[1]),
)

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
#:   - the TAP. A surfaced window's content is a canvas, and the only way to read the ROWS back is
#:     the batch that drew them. `www/m17.html` taps the kernel message with `k.on`; the landing
#:     page publishes no kernel handle — by design, it is the product — so the tap goes on
#:     `Surface.prototype.replay`, which is the one function every batch passes through. It
#:     DELEGATES, so the page renders exactly what it would have, and it is on the PROTOTYPE so a
#:     re-surface does not lose it. The module is fetched by the URL the host already loaded it
#:     under, so this is the same class object and not a second one.
#:   - the ARITHMETIC. `FILES_METRICS` is imported rather than restated: `PAD`, `FOCUS_INSET`,
#:     `rowMid` and `toSurface` are the program's own, which is the whole reason that object is
#:     exported (`CLAUDE.md`'s `FILES_METRICS` row — two drivers restated the row geometry and the
#:     drift arrived as the wrong file being dragged). A page can import a program's module even
#:     though a process cannot import the page's.
INSTALL = """(async () => {
  const abi = await import('/src/abi.mjs')
  const surf = await import('/src/wm/surface.mjs')
  const files = await import('/src/bin/files.mjs')
  const G = globalThis.__M18FF || (globalThis.__M18FF = { last: new WeakMap() })
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
  return JSON.stringify({ ok: true, pad: G.M.PAD, inset: G.M.FOCUS_INSET, rowH: G.M.ROW_H })
})()"""

#: WHAT THE `files` WINDOW HAS DRAWN, and where to aim inside it.
#:
#: A ROW NAME IS A RUN WITH NO FLAGS. `src/bin/files.mjs` draws the header bold, the position line
#: bold and right-aligned, and the type column monospace and right-aligned; only a name is plain. So
#: the discriminator is the program's own, not a coordinate guessed here.
#:
#: THE CURSOR IS READ AS PIXELS. The ring is a `DL_STROKE_RECT` at `focusBox`'s x — `PAD +
#: FOCUS_INSET` — and the selection outline is one at `PAD`; `toSurface` separates them at every
#: ratio. Which ROW it is on is then the name run that falls inside it, so the answer is a NAME and
#: never an index this file computed.
READ = """JSON.stringify((() => {
  const G = globalThis.__M18FF
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
  const { decodeDrawOps, textOfOps, DL_TEXT, DL_STROKE_RECT } = G.abi
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
  // THE SCALE IS MEASURED, not assumed: the store is device px and the box is CSS px, and the
  // whole of M16 is that those are different numbers (constraint 264 for why not reading it here).
  const scale = r.width > 0 ? entry.surface.w / r.width : 1
  const names = runs.filter((t) => t.flags === 0).sort((a, b) => a.y - b.y)
  const inside = (y, h) => {
    const hit = names.find((n) => n.y >= y - 1 && n.y <= y + h + 1)
    return hit ? hit.text : ''
  }
  const strokes = ops.filter((o) => o.op === DL_STROKE_RECT)
  const ring = strokes.find((o) => o.a0 === M.toSurface(M.PAD + M.FOCUS_INSET, scale))
  const sel = strokes.find((o) => o.a0 === M.toSurface(M.PAD, scale))
  const at = (x, y) => ({ x: Math.round(r.left + x), y: Math.round(r.top + y) })
  return {
    title: String(entry.win.titleText || ''), id: entry.id, scale,
    batches: entry.surface.batches,
    names: names.map((n) => n.text),
    header: runs.some((t) => t.text === 'Name'),
    place: (runs.find((t) => /^\\d+ items?$/.test(t.text)
                            || /^\\d+-\\d+ of \\d+$/.test(t.text)) || {}).text || '',
    cursor: ring ? inside(ring.a1, ring.a3) : '',
    selected: sel ? inside(sel.a1, sel.a3) : '',
    // WHERE TO AIM, in viewport CSS px, from `rowMid` — the function the program's own hit test is
    // the declared inverse of. `scroll` is 0 and `place` is what proves it: `files` prints a bare
    // item count exactly when the list cannot scroll.
    points: names.map((n, i) => ({ name: n.text, ...at(M.NAME_X + 10, M.rowMid(i, 0)) })),
  }
})())"""

#: The app windows a reader would count, by title. The desktop is `role === '1'` and is not one.
WINDOWS = """JSON.stringify([...document.querySelectorAll('.window')]
  .filter((w) => w.dataset.role !== '1')
  .map((w) => ((w.querySelector('h2') || {}).textContent || '').trim()))"""

#: WHAT A HIT TEST FINDS at a point, because a covered canvas and an inert one are the same picture
#: (constraint 40). A click aimed through another window is reported, never silently counted.
UNDER = """JSON.stringify((() => {
  const el = document.elementFromPoint(%d, %d)
  if (!el) return { hits: 'nothing' }
  const frame = el.closest ? el.closest('.window') : null
  return { tag: String(el.tagName || ''),
           hits: frame ? ((frame.querySelector('h2') || {}).textContent || '').trim() : 'no window' }
})())"""

#: The clauses `--prove-failure` proves, and the ones it MUST leave alone.
#:
#: `relist` IS DELIBERATELY NOT KEPT, and the reason is a measurement rather than a preference: it
#: is RED in both worlds while `src/wm/winhost.mjs` takes the click count off a `pointerdown`, so it
#: witnesses nothing about a control that changes one key. It belongs back in `KEPT_TAGS` the day
#: the DOWN record's bits come from a `mousedown` — `bench/m18-keys/clickcount.py` is the run that
#: decides which world this is.
PROOF_TAGS = ("arrow", "enter")
KEPT_TAGS = ("one-click", "back")


def settle(ff, tries: int = 90) -> dict:
    """Wait for the desktop to stage and its layout to stop moving.

    THE SECOND HALF IS NOT DECORATION. The page prints its own log, the log grows, and the desktop
    is pushed down under it — measured on m14, an icon at y=65 became y=249 — so a rect read before
    that and clicked after is clicked where nothing is. Two identical reads is the signal, which is
    `bench/m14-shell/firefox-drive.py`'s rule for the same hazard.
    """
    last, stable = None, 0
    st = {}
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


def point_for(state: dict, name: str) -> dict | None:
    for row in state.get("points") or []:
        if row["name"] == name:
            return row
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
    ap.add_argument("--settle", type=float, default=1.4,
                    help="seconds between gestures. Over the platform's double-click threshold, so "
                         "a single click after a double one is not a third click")
    ap.add_argument("--shot", default=str(HERE / "firefox-keys.png"))
    ap.add_argument("--prove-failure", action="store_true",
                    help="send `j` where the Down arrow goes — a key `files` binds nothing to, "
                         "which is the pre-M18 world where an arrow reached it as nothing. The %s "
                         "clauses MUST fire and the %s clauses MUST NOT. Exits 0 when the proof "
                         "SUCCEEDED." % (", ".join(PROOF_TAGS), ", ".join(KEPT_TAGS)))
    args = ap.parse_args(argv)

    #: THE ONE THING THE CONTROL CHANGES. A named key, or a letter in its place.
    down = "j" if args.prove_failure else "ArrowDown"

    httpd = None
    url = args.url
    if not url:
        os.chdir(REPO)
        httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d%s" % (httpd.server_address[1], args.page)
    print("url      %s" % url)
    if args.prove_failure:
        print("control  --prove-failure: the Down arrow is sent as %r" % down)

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
                time.sleep(0.5)
            ff.type_keys("files %s &\n" % DIR)
            time.sleep(4.0)

            state = read(ff)
            if state.get("error"):
                print("\nthe `files` window could not be read: %s" % state["error"])
                ff.screenshot(args.shot)
                return 1
            print("files    title=%r scale=%s batches=%s place=%r"
                  % (state["title"], state["scale"], state["batches"], state["place"]))
            print("rows     %s" % state["names"])
            parent_names = list(state["names"])
            if sorted(parent_names) != sorted(["sub", PARENT_FILE]):
                print("\nthe fixture is not what this gate was written against: %s. The typed "
                      "`mkdir`/`touch` lines did not take, so every clause below would be about a "
                      "different directory." % parent_names)
                ff.screenshot(args.shot)
                return 1
            if not state["place"].endswith("items"):
                print("\nthe list is SCROLLED (%r), so `rowMid(i, 0)` is not where row i is and "
                      "every aim point below would miss." % state["place"])
                ff.screenshot(args.shot)
                return 1
            parent_title = state["title"]

            # ---- 1. A SINGLE CLICK ON A FILE ROW OPENS NOTHING ----
            row = point_for(state, PARENT_FILE)
            hit = under(ff, row)
            print("click    %-10s at %s,%s  hit test finds %r"
                  % (PARENT_FILE, row["x"], row["y"], hit.get("hits")))
            before = ff.evaluate(WINDOWS)
            ff.click(row["x"], row["y"])
            time.sleep(pause)
            after = ff.evaluate(WINDOWS)
            once = read(ff)
            print("         windows %d -> %d  cursor=%r selected=%r"
                  % (len(before), len(after), once.get("cursor"), once.get("selected")))
            if len(after) != len(before):
                bad.append(("one-click", "a SINGLE click on %r opened a window: %s -> %s. One "
                                         "click selects; the second one is the verb"
                            % (PARENT_FILE, before, after)))
            elif once.get("names") != parent_names:
                bad.append(("one-click", "a SINGLE click on %r re-listed the window: %s -> %s"
                            % (PARENT_FILE, parent_names, once.get("names"))))
            else:
                good.append("a single click on %r opened nothing and selected it (cursor %r)"
                            % (PARENT_FILE, once.get("cursor")))

            # ---- 2. A DOUBLE CLICK ON A DIRECTORY ROW RE-LISTS ----
            time.sleep(pause)
            state = read(ff)
            row = point_for(state, "sub")
            print("dblclick %-10s at %s,%s" % ("sub", row["x"], row["y"]))
            ff.dblclick(row["x"], row["y"])
            time.sleep(2.5)
            child = read(ff)
            print("         title=%r rows=%s" % (child.get("title"), child.get("names")))
            relisted = (list(child.get("names") or []) == list(CHILD_ROWS)
                        and "sub" in str(child.get("title")))
            if not relisted:
                bad.append(("relist", "a DOUBLE click on the `sub` row did not re-list the window: "
                                      "title %r, rows %s. `src/wm/winhost.mjs:754` takes the click "
                                      "count from a `pointerdown`, whose `detail` is 0 on both "
                                      "presses in BOTH engines (bench/m18-keys/clickcount.py), so "
                                      "`WPTR_CLICK2` reaches no program anywhere"
                            % (child.get("title"), child.get("names"))))
                # ENTERED WITH ENTER INSTEAD, ANNOUNCED. The cursor is on `sub` — the DOWN record
                # carried it there — so this is the same activation by the other verb, and it is
                # what lets clauses 3-5 be about the keyboard rather than about clause 2's failure.
                print("         FALLBACK: entering `sub` with Enter instead, so clauses 3-5 still "
                      "run. Clause 2 stays RED.")
                ff.press("Enter")
                time.sleep(2.5)
                child = read(ff)
                print("         title=%r rows=%s" % (child.get("title"), child.get("names")))
                if list(child.get("names") or []) != list(CHILD_ROWS):
                    print("\nneither a double-click nor Enter entered `sub`, so there is no child "
                          "directory to drive the keyboard in.")
                    for tag, line in bad:
                        print("BAD  [%s] %s" % (tag, line))
                    ff.screenshot(args.shot)
                    return 1
            else:
                good.append("a double-click on the `sub` row re-listed it: %r, rows %s"
                            % (child["title"], child["names"]))

            # ---- 3. BACKSPACE GOES BACK ----
            #
            # BEFORE THE KEYBOARD CLAUSES AND NOT AFTER THEM, because clause 5 OPENS A WINDOW and
            # `editor` opens at the same origin `files` did: measured, its frame covers the
            # `files` header, so a re-focusing click aimed there lands on the editor and the
            # Backspace goes to a program that is not the subject. The cursor is already on the
            # `files` surface here — the activation above put it there — so nothing needs raising.
            time.sleep(pause)
            ff.press("Backspace")
            time.sleep(2.5)
            end = read(ff)
            print("back     Backspace -> title=%r rows=%s" % (end.get("title"), end.get("names")))
            if list(end.get("names") or []) == parent_names and end.get("title") == parent_title:
                good.append("Backspace went back to %r, rows %s" % (parent_title, parent_names))
            else:
                bad.append(("back", "Backspace did not go back: title %r (wanted %r), rows %s "
                                    "(wanted %s)" % (end.get("title"), parent_title,
                                                     end.get("names"), parent_names)))

            # ---- 4. BACK INTO THE CHILD, so the keyboard clauses have two rows to walk ----
            # NOT A CLAUSE. Enter on a directory row, which clause 2's fallback has already used
            # and clause 5 asserts on a file row; it is here to restore the state Backspace just
            # left, and a failure to restore it is reported as what it is rather than scored.
            time.sleep(pause)
            row = point_for(end, "sub")
            if not row:
                print("\nthe `sub` row is not drawn in %r, so the child cannot be re-entered."
                      % end.get("title"))
                return 1
            ff.click(row["x"], row["y"])
            time.sleep(0.8)
            ff.press("Enter")
            time.sleep(2.5)
            child = read(ff)
            print("again    title=%r rows=%s" % (child.get("title"), child.get("names")))
            if list(child.get("names") or []) != list(CHILD_ROWS):
                print("\nthe child directory could not be re-entered, so there is nothing to walk "
                      "with the keyboard.")
                for tag, line in bad:
                    print("BAD  [%s] %s" % (tag, line))
                ff.screenshot(args.shot)
                return 1

            # ---- 5. A REAL DOWN ARROW MOVES THE CURSOR ----
            time.sleep(pause)
            row = point_for(child, CHILD_ROWS[0])
            if not row:
                print("\nthe child's first row was not drawn, so there is nothing to click.")
                return 1
            hit = under(ff, row)
            if "files" not in str(hit.get("hits")):
                bad.append(("arrow", "the `files` row %r is covered by %r, so the click that puts "
                                     "the cursor on it went to another window"
                            % (CHILD_ROWS[0], hit.get("hits"))))
            ff.click(row["x"], row["y"])
            time.sleep(0.8)
            start = read(ff)
            print("cursor   click put it on %r (selected %r)"
                  % (start.get("cursor"), start.get("selected")))
            if start.get("cursor") != CHILD_ROWS[0]:
                bad.append(("arrow", "a click on %r did not put the cursor on it (%r), so an arrow "
                                     "has no measured starting point"
                            % (CHILD_ROWS[0], start.get("cursor"))))
            wins_before = ff.evaluate(WINDOWS)
            ff.press(down)
            time.sleep(1.0)
            moved = read(ff)
            print("         %s -> cursor %r" % (down, moved.get("cursor")))
            if moved.get("cursor") == CHILD_ROWS[1]:
                good.append("a real Down arrow moved the cursor %r -> %r"
                            % (CHILD_ROWS[0], CHILD_ROWS[1]))
            else:
                bad.append(("arrow", "%r left the cursor on %r, not %r: the key never reached the "
                                     "program as a keysym" % (down, moved.get("cursor"),
                                                              CHILD_ROWS[1])))
            if len(ff.evaluate(WINDOWS)) != len(wins_before):
                bad.append(("arrow", "the arrow OPENED something: %s -> %s. An arrow moves the "
                                     "cursor and never activates"
                            % (wins_before, ff.evaluate(WINDOWS))))

            # ---- 6. ENTER OPENS THE ROW THE ARROW REACHED, and it is LAST ----
            time.sleep(pause)
            before = ff.evaluate(WINDOWS)
            ff.press("Enter")
            time.sleep(3.5)
            after = ff.evaluate(WINDOWS)
            fresh = [t for t in after if t not in before]
            print("enter    windows %d -> %d  new %s" % (len(before), len(after), fresh))
            if not fresh:
                bad.append(("enter", "Enter on the cursor's row opened nothing: windows %s"
                            % (after,)))
            elif any(CHILD_ROWS[1] in t for t in fresh):
                good.append("Enter opened the row the ARROW reached: %s" % fresh)
            else:
                bad.append(("enter", "Enter opened %s, which does not name %r — the row the arrow "
                                     "reached. It opened the row the CLICK had selected, which is "
                                     "a keyboard that moved nothing"
                            % (fresh, CHILD_ROWS[1])))

            ff.screenshot(args.shot)
            print("shot     %s" % args.shot)
    finally:
        if httpd is not None:
            httpd.shutdown()

    print()
    for line in good:
        print("ok   %s" % line)
    for tag, line in bad:
        print("%s  [%s] %s" % ("would report" if args.prove_failure else "BAD ", tag, line))

    if args.prove_failure:
        fired = [line for tag, line in bad if tag in PROOF_TAGS]
        collapsed = [tag for tag, _ in bad if tag in KEPT_TAGS]
        # EXIT 0 WHEN THE PROOF SUCCEEDED, which is `scripts/check.py`'s convention: a non-zero
        # exit is reserved for a proof that failed to fail.
        if collapsed:
            print("\nTHE PROOF FAILED: the control also moved %s, which it must not touch — it "
                  "changes ONE key. A control satisfied by any failure verifies nothing."
                  % sorted(set(collapsed)))
            return 1
        if fired:
            print("\nthe proof succeeded: %r in place of the Down arrow fired %d of the %s "
                  "clause(s), and %s stayed green."
                  % (down, len(fired), ", ".join(PROOF_TAGS), ", ".join(KEPT_TAGS)))
            return 0
        print("\nTHE PROOF FAILED: a key the program binds nothing to moved the cursor anyway, so "
              "the %s clauses are not reading the key they send." % ", ".join(PROOF_TAGS))
        return 1

    if bad:
        return 1
    print("\na row opens on a double-click, a single click only selects, the arrow keys walk the "
          "cursor and Enter opens where it got to, and Backspace goes back — in FIREFOX, on the "
          "landing page, with real trusted input")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
