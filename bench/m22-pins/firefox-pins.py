#!/usr/bin/env python3
"""CAN A READER PIN A PROGRAM IN FIREFOX? The pin gesture, with REAL TRUSTED INPUT in a second
engine, and the pin still there after a reload.

    python3 bench/m22-pins/firefox-pins.py                  # the gate
    python3 bench/m22-pins/firefox-pins.py --headed         # ...in a window you can watch
    python3 bench/m22-pins/firefox-pins.py --prove-failure  # the menu is DISMISSED instead of the
                                                            # row being clicked; the pin clauses
                                                            # MUST then fire. Exits 0 on success.

WHY A SECOND ENGINE, which CLAUDE.md states as a bill rather than a principle: driving Chrome only
has cost this project FIVE milestones, and every one of them was green in Chrome while a reader
could not use the thing. This gesture is a start-menu row that WRITES A FILE, so the two
engine-shaped ways it can fail are an input event that does not reach the row and a write whose
durability the engine's OPFS does not honour across a reload. Both are invisible to a source read
and to `scripts/check.py`, which drives Chrome.

FIREFOX RENDERS AT dpr 1 ON THIS MACHINE, which is where a unit error hides. Nothing here is in
device px: a row is found by its own `getBoundingClientRect`, hit-tested with `elementFromPoint` and
clicked at that point, so the geometry is DERIVED FROM A MEASURED RECT and not from a constant —
which is the one property that survived a second engine every time M11, M12 and M16 did not.

`bench/m22-pins/probe.py` IS THE CHROME HALF and it asserts more: the bytes in the file, read by
`cat` at a real prompt. This file asserts the ROUTE, which is the engine-shaped half.
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

#: The program the gesture pins: pinnable, not in `DEFAULT_PINS`, and not staged as a window — so
#: "a button appeared" cannot be satisfied by the desktop merely having loaded.
SUBJECT = "editor"

STATE = """JSON.stringify((() => {
  const I = globalThis.INDEX || {}
  const shell = I.shell || null
  const orb = document.querySelector('[data-start]')
  const box = (el) => { const r = el.getBoundingClientRect()
    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) } }
  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    state: String(I.state || ''),
    isolated: I.isolated === true,
    errors: (I.errors || []).slice(0, 4).map(String),
    orb: orb ? box(orb) : null,
    popup: (() => { const p = document.querySelector('.shell-popup')
      return p && !p.hidden ? (p.dataset.popup || '') : '' })(),
    pins: shell ? shell.report().pins : -1,
    pinButtons: [...document.querySelectorAll('[data-pin-btn]')].map((el) => el.dataset.pinBtn),
    trayIcons: [...document.querySelectorAll('[data-tray-icon]')].length,
    icons: [...document.querySelectorAll('.desk-icon')].map((c) => {
      const r = c.getBoundingClientRect()
      return { label: (c.querySelector('.desk-label') || {}).textContent || '',
               cy: Math.round(r.top + 24) } }),
  }
})())"""

#: ONE START MENU ROW BY ITS EXACT LABEL, SCROLLED INTO ITS LIST AND HIT-TESTED. `.start-list` caps
#: at 300 px over more rows than fit, so a row below the fold has a rect outside the popup and a
#: click at its centre lands on the desktop — `clipped` is that state, named rather than clicked.
ROW = """JSON.stringify((() => {
  const p = document.querySelector('.shell-popup')
  if (!p || p.hidden) return null
  const want = %s
  for (const row of p.querySelectorAll('.shell-row')) {
    const label = (row.querySelector('.shell-label') || {}).textContent || ''
    if (label !== want) continue
    row.scrollIntoView({ block: 'nearest' })
    const b = row.getBoundingClientRect()
    const pr = p.getBoundingClientRect()
    if (b.top < pr.top || b.bottom > pr.bottom) return { label, clipped: true }
    const x = Math.round(b.left + 20), y = Math.round(b.top + b.height / 2)
    const el = document.elementFromPoint(x, y)
    return { label, x, y, hits: Boolean(el && el.closest && el.closest('.shell-row') === row) }
  }
  return null
})())"""


def settle(ff, tries: int = 80) -> dict:
    """Wait for the desktop to boot AND for its icon layout to stop moving.

    TWO IDENTICAL READS IN A ROW, which is `bench/m14-shell/firefox-drive.py`'s signal and exists
    for the same reason here: a row read before the layout settles is a row clicked where it is not.
    """
    last, stable = None, 0
    st: dict = {}
    for _ in range(tries):
        st = ff.evaluate(STATE)
        now = [(i["label"], i["cy"]) for i in st.get("icons", [])]
        stable = stable + 1 if now and now == last else 0
        last = now
        if st.get("state") == "done" and stable >= 2:
            return st
        time.sleep(0.4)
    return st


def open_start(ff) -> str:
    st = ff.evaluate(STATE)
    if not st.get("orb"):
        return "no start orb"
    ff.click(st["orb"]["cx"], st["orb"]["cy"])
    time.sleep(0.6)
    return ff.evaluate(STATE)["popup"]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--url", default="", help="an already-running server; otherwise one is bound")
    ap.add_argument("--w", type=int, default=1560)
    ap.add_argument("--h", type=int, default=1010)
    ap.add_argument("--shot", default=str(HERE / "firefox-pins.png"))
    ap.add_argument("--prove-failure", action="store_true",
                    help="dismiss the menu with Escape instead of clicking the row; both pin "
                         "clauses MUST then fire. Exits 0 when the proof SUCCEEDED.")
    args = ap.parse_args(argv)

    httpd = None
    url = args.url
    if not url:
        os.chdir(REPO)
        httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d/www/index.html" % httpd.server_address[1]
    print("url      %s" % url)

    bad: list[str] = []
    try:
        with bidi.Firefox(headless=not args.headed, width=args.w, height=args.h) as ff:
            ff.navigate(url)
            st = settle(ff)
            print("firefox  viewport %s" % st.get("viewport"))
            print("page     state=%r isolated=%s errors=%s"
                  % (st.get("state"), st.get("isolated"), st.get("errors")))
            if st.get("state") != "done" or st.get("isolated") is not True:
                # A GATE THAT CANNOT REACH ITS SUBJECT MUST FAIL, never report clean: without the
                # SAB there is no kernel and no published row, so every clause below is about
                # nothing (CLAUDE.md, harness honesty).
                print("BAD: www/index.html did not boot a kernel in Firefox")
                return 1

            print("pins     %d published, buttons %s, tray icons %d"
                  % (st.get("pins", -1), st.get("pinButtons"), st.get("trayIcons", 0)))
            if not st.get("pinButtons") and st.get("pins", 0) <= 0:
                bad.append("a fresh desktop published no pinned row at all")
            if st.get("trayIcons", 0) < 1:
                bad.append("the tray drew no status icon for the row the desktop published")
            if SUBJECT in (st.get("pinButtons") or []):
                bad.append("%s was ALREADY pinned before the gesture, so the clauses below would "
                           "pass without it" % SUBJECT)

            # ---- THE GESTURE: a real trusted click on `Pin <prog>` ----
            kind = open_start(ff)
            print("menu     popup=%r" % kind)
            row = ff.evaluate(ROW % ('"Pin %s"' % SUBJECT))
            print("row      %s" % row)
            if not row or row.get("clipped") or not row.get("hits"):
                bad.append("no hit-testable `Pin %s` row in the start menu: %s" % (SUBJECT, row))
            elif args.prove_failure:
                # THE CONTROL IS THE SAME PATH UP TO THE CLICK. Escape is a real key, so the two
                # runs differ in the gesture and in nothing else.
                ff.press("Escape")
                time.sleep(0.8)
                print("control  menu dismissed with Escape instead of clicking the row")
            else:
                ff.click(row["x"], row["y"])
                time.sleep(1.6)

            after = ff.evaluate(STATE)
            pinned = SUBJECT in (after.get("pinButtons") or [])
            print("after    buttons %s  -> %s pinned: %s"
                  % (after.get("pinButtons"), SUBJECT, pinned))
            if not pinned:
                bad.append("the click did not pin %s: the band has %s"
                           % (SUBJECT, after.get("pinButtons")))

            # ---- AND IT SURVIVES A RELOAD, which is R24 and the half a page-side pin fails ----
            ff.navigate(url)
            back = settle(ff)
            kept = SUBJECT in (back.get("pinButtons") or [])
            print("reload   buttons %s  -> %s kept: %s"
                  % (back.get("pinButtons"), SUBJECT, kept))
            if not kept:
                bad.append("%s did not survive a reload: the band has %s"
                           % (SUBJECT, back.get("pinButtons")))

            if args.shot:
                ff.screenshot(args.shot)
                print("shot     %s" % args.shot)
    finally:
        if httpd:
            httpd.shutdown()

    if args.prove_failure:
        # THE PROOF IS THAT THE TWO PIN CLAUSES MOVED AND ONLY THEY DID. A control satisfied by any
        # failure verifies nothing (CLAUDE.md), so the names are read rather than counted.
        moved = [line for line in bad if "pin %s" % SUBJECT in line or "survive a reload" in line]
        others = [line for line in bad if line not in moved]
        for line in bad:
            print("fired    %s" % line)
        print("\nprove-failure: %d pin clause(s) fired, %d other(s)" % (len(moved), len(others)))
        return 0 if len(moved) == 2 and not others else 1

    for line in bad:
        print("BAD      %s" % line)
    print("\n%s" % ("ok: a reader can pin a program in Firefox, and it survives a reload"
                    if not bad else "%d problem(s)" % len(bad)))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
