#!/usr/bin/env python3
"""WHICH EVENT CARRIES THE CLICK COUNT? `detail` on both halves of a double-click, in BOTH engines.

    python3 bench/m18-keys/clickcount.py              # both engines
    python3 bench/m18-keys/clickcount.py --firefox    # one of them
    python3 bench/m18-keys/clickcount.py --chrome

M18's activation verb is the PLATFORM's click count — a double-click has a threshold the reader
configured, and a program that timed two presses itself would disagree with every other application
on their machine (`src/wm/winhost.mjs`'s `clickBits`). The count is read off `event.detail`, and
WHICH event it is read from is the question: `clickBits(e)` is called from a `pointerdown` listener.

So this presses twice, in both engines, and prints `detail` for every event the press produces. It
asserts nothing about this project's code and scores nothing: it is the measurement a code decision
rests on, which is the same shape as `bench/m14-shell/input-probe.py`. Exit 0 whenever both engines
answered.

MEASURED, Firefox 156 / Chrome 157 / macOS 26.7.2, both with a pointer capture taken on the
pointerdown exactly as `#wirePointer` takes one — re-run it rather than trusting this comment:

    engine   event          detail, press 1 / press 2
    firefox  pointerdown    0 / 0          <-- the listener `clickBits` is called from
    firefox  mousedown      1 / 2
    chrome   pointerdown    0 / 0          <-- and the same here
    chrome   mousedown      1 / 2

SO A DOUBLE-CLICK NEVER REACHES A PROGRAM IN EITHER ENGINE. `WPTR_CLICK2` is ORed in from a number
that is always 0, nothing errors anywhere, and the row simply does not open. This is NOT an engine
difference, which is what makes it worse than the five bills `CLAUDE.md` records: there is no engine
in which the landed code works. Pointer Events Level 3
(<https://www.w3.org/TR/pointerevents3/>) gives `detail` the value 0 on a pointerdown, so neither
browser is at fault and no newer version will fix it.

CHROME'S COLUMN IS WITH `clickCount` STATED ON THE WIRE — 1 then 2, which is what a CDP driver must
send — and `pointerdown.detail` is still 0, so the count is not even reachable by stating it louder.

A `mousedown` listener on the same element carries the count in both engines, and `send` reads only
`clientX`/`clientY`/`buttons`/`modifiers`, all of which a MouseEvent has. `pointerdown` fires first,
so the DOWN-then-UP order of the records is unchanged.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

#: A plain box with a pointerdown handler that TAKES A CAPTURE, because that is what
#: `src/wm/winhost.mjs` does and a capture changes which element the compatibility mouse events are
#: dispatched at (`bench/m14-shell/input-probe.py` measured that for the target; this is about
#: `detail`).
PAGE = ("data:text/html,<body style=margin:0>"
        "<div id=t style='width:400px;height:400px;background:%23333' tabindex=0></div>")

RECORD = """(() => {
  window.__hits = []
  const el = document.getElementById('t')
  for (const kind of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick']) {
    el.addEventListener(kind, (e) => window.__hits.push([kind, e.detail]))
  }
  el.addEventListener('pointerdown', (e) => {
    try { el.setPointerCapture(e.pointerId) } catch (error) { window.__hits.push(['capture-threw', 0]) }
  })
  return 1
})()"""

READ = "JSON.stringify(window.__hits)"


def table(rows: list) -> dict:
    """`detail` per event kind, in the order the events arrived."""
    out: dict[str, list] = {}
    for kind, detail in rows:
        out.setdefault(kind, []).append(detail)
    return out


def firefox() -> dict:
    import bidi
    with bidi.Firefox() as ff:
        ff.navigate(PAGE)
        ff.evaluate(RECORD)
        ff.dblclick(100, 100)
        got = ff.evaluate(READ)
    return table(got if isinstance(got, list) else json.loads(got))


def chrome() -> dict:
    import cdp
    with cdp.Browser() as browser:
        page = browser.page()
        page.navigate(PAGE)
        page.evaluate(RECORD)
        # THE COUNT IS THE DRIVER'S TO STATE over CDP: `Input.dispatchMouseEvent` takes
        # `clickCount`, and 1 then 2 is what a double-click is on this wire.
        for count in (1, 2):
            for kind in ("mousePressed", "mouseReleased"):
                page.call("Input.dispatchMouseEvent", type=kind, x=100, y=100,
                          button="left", buttons=1 if kind == "mousePressed" else 0,
                          clickCount=count)
        got = page.evaluate(READ)
    return table(json.loads(got) if isinstance(got, str) else got)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--firefox", action="store_true")
    ap.add_argument("--chrome", action="store_true")
    args = ap.parse_args(argv)
    want = [name for name, on in (("firefox", args.firefox), ("chrome", args.chrome)) if on]
    if not want:
        want = ["firefox", "chrome"]

    ran = {}
    for name in want:
        ran[name] = (firefox if name == "firefox" else chrome)()
        print("%s" % name)
        for kind, details in ran[name].items():
            print("  %-14s detail %s" % (kind, details))

    print()
    for name, got in ran.items():
        down = got.get("pointerdown") or []
        mouse = got.get("mousedown") or []
        carries = [kind for kind, details in got.items() if details and max(details) >= 2]
        print("%-8s pointerdown %s | mousedown %s | carries a 2: %s"
              % (name, down, mouse, carries or "NOTHING"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
