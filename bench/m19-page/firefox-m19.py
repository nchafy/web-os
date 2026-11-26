#!/usr/bin/env python3
"""CAN A READER HOVER AND SORT IN FIREFOX? M19's details view, driven with REAL trusted input.

    python3 bench/m19-page/firefox-m19.py
    python3 bench/m19-page/firefox-m19.py --headed
    python3 bench/m19-page/firefox-m19.py --prove-failure

WHY THIS FILE EXISTS. CLAUDE.md makes a second engine a condition of reporting a milestone done,
and it records the bill for skipping it: M4a shipped a window that could not be dragged in Firefox,
M6 shipped a policy under which no process started there, M11 and M12 each failed on an engine
whose feature was fine because a geometry was derived from a constant taken at dpr 2, and M17's
bare URL threw in both engines while its `?proofs=1` suite stayed green. Five milestones, every
Chrome expectation green each time, every one found by a human opening the page.

M19 IS THE LIKELIEST REPEAT YET, for two reasons it shares with none of the earlier rows:

  1. **A HOVER IS A NEW INPUT CLASS.** Until M19 `src/wm/winhost.mjs` dropped every buttonless
     move (`if (!e.buttons) return`), so no engine had ever delivered one to a process. A driver
     that cannot produce a trusted buttonless move cannot test it at all, and a synthesised
     `PointerEvent` is `isTrusted === false` (constraint 175). `scripts/bidi.py`'s
     `input.performActions` produces trusted ones.
  2. **A `pointerleave` IS THE ONE RECORD WITH NO POSITION.** It fires outside the backing store,
     where `Surface.pointAt` answers null — so it travels a different path from every other
     pointer record and an engine that fired it differently would leave a row lit for ever with
     nothing in any Chrome expectation to say so.

WHAT IS ASSERTED, all of it read back through the PAGE's own `M19.listState` and aimed through the
page's own `M19.aimAt`. This file owns no geometry and no palette on purpose: a gate that computed
a column's x for itself would be a second copy of `columnBoxes`, and a driver aiming one column
over sorts a column nobody pointed at with every reading still agreeing.

  1. `hover-lights-a-row`        a driven buttonless move over a row lights THAT row
  2. `hover-moves-the-light`     a second move over another row MOVES it, which is the newest
                                 sample winning and is what a tail replacement owes
  3. `leave-clears-the-light`    a move off the canvas clears it, rather than leaving the last row
                                 nearest the edge lit for the life of the window
  4. `a-header-click-sorts`      a click on the `Type` header reorders the rows and puts the caret
                                 on that column, pointing up
  5. `a-second-click-reverses`   a second click on the same header turns the caret over
  6. `cells-sit-in-their-columns` every row drew a Type cell and no run landed outside a column,
                                 which is the four-column layout arriving in this engine at all

THE BARE URL IS WHAT IS DRIVEN, not `?proofs=1`. The product path is the one M17 shipped broken
(constraint 283 from the other direction), and `/usr/share` is what the live desktop's `files`
window opens on — three rows of three different formats, which is enough for a sort and for two
distinct rows to hover.

`--prove-failure` aims BOTH moves four pixels from the top-left corner of the viewport, which is
outside the window: nothing may light, so clauses 1 and 2 MUST go red while 3 to 6 hold. That is a
NAMED subset and not "some failure happened". A gate nobody has seen fail is a gate nobody has
checked. It exits 0 when the proof SUCCEEDED.
"""
from __future__ import annotations

import argparse
import json
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

#: The window this gate drives, by the title its program set. The live desktop opens exactly one.
TITLE = "files"

#: How long the desktop has to reach `phase === "live"`, seconds. It stages four processes.
SETTLE_S = 90.0

#: How long a driven gesture has to cross the kernel and come back as a repaint, seconds. There is
#: no channel on which a program says "I lit a row", so this is a settle and not a poll.
GESTURE_S = 0.9

#: Where a "the pointer is nowhere near the window" aim goes, in VIEWPORT px. The top-left corner is
#: outside every frame the live desktop stages, and it is also where the leave is aimed.
OFF_WINDOW = {"x": 4, "y": 4}


def page_state(ff: bidi.Firefox) -> dict:
    """The page's own state, as it publishes it."""
    got = ff.evaluate("""JSON.stringify((() => {
      const M = globalThis.M19 || {}
      return { state: String(M.state || ''), phase: String(M.phase || ''),
               why: String(M.why || ''), dpr: devicePixelRatio,
               errors: (M.errors || []).map(String).slice(0, 4),
               hasList: typeof M.listState === 'function',
               hasAim: typeof M.aimAt === 'function' }
    })())""")
    return got if isinstance(got, dict) else {}


def settle(ff: bidi.Firefox) -> dict:
    """Wait for the live desktop. A page that threw says so in `state`, so this does not spin."""
    deadline = time.monotonic() + SETTLE_S
    row: dict = {}
    while time.monotonic() < deadline:
        row = page_state(ff)
        if row.get("phase") == "live" or row.get("state") in ("error", "aborted"):
            break
        time.sleep(0.5)
    return row


def listing(ff: bidi.Firefox) -> dict:
    """What one `files` window has drawn, through the page's own decoder."""
    got = ff.evaluate("JSON.stringify(M19.listState(%s))" % json.dumps(TITLE))
    return got if isinstance(got, dict) else {}


def aim(ff: bidi.Firefox, kind: str, key: str = "") -> dict:
    """A VIEWPORT point to drive at, from the page's own geometry. It RAISES on a refusal rather
    than returning a point nothing can receive — a gate aiming into empty space reports red
    clauses with nothing saying the aim was wrong, which is M18's own bill."""
    got = ff.evaluate("JSON.stringify(M19.aimAt(%s, %s, %s))"
                      % (json.dumps(TITLE), json.dumps(kind), json.dumps(key)))
    if not isinstance(got, dict) or "error" in got:
        raise RuntimeError("M19.aimAt(%r, %r) refused: %r" % (kind, key, got))
    return got


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--url", default="", help="an already-running server; otherwise one is bound")
    ap.add_argument("--w", type=int, default=1600)
    ap.add_argument("--h", type=int, default=1010)
    ap.add_argument("--shot", default=str(HERE / "firefox-m19.png"))
    ap.add_argument("--prove-failure", action="store_true",
                    help="aim both moves outside the window, so nothing may light and the gate "
                         "MUST say so. Exits 0 when the proof succeeded.")
    args = ap.parse_args(argv)

    httpd = None
    url = args.url
    if not url:
        os.chdir(REPO)
        httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d/www/m19.html" % httpd.server_address[1]
    print("url      %s" % url)
    if args.prove_failure:
        print("control  --prove-failure: every hover is aimed at %r, outside the window"
              % OFF_WINDOW)

    clauses: dict[str, bool] = {}
    try:
        with bidi.Firefox(headless=not args.headed, width=args.w, height=args.h) as ff:
            ff.navigate(url)
            st = settle(ff)
            print("firefox  dpr %s  state=%r phase=%r" % (st.get("dpr"), st.get("state"),
                                                          st.get("phase")))
            if st.get("errors"):
                print("page errors %s" % st["errors"])
            if st.get("phase") != "live":
                print("BAD  the desktop never went live: state=%r why=%r"
                      % (st.get("state"), st.get("why")))
                return 1
            if not (st.get("hasList") and st.get("hasAim")):
                print("BAD  the page publishes no listState/aimAt, so there is nothing to read "
                      "or aim with")
                return 1
            # ONE SETTLE BEFORE THE FIRST READING. `stageDesktop` places the frames it opened, and
            # a `win-geom` arriving after a measurement re-surfaces the canvas — so the rect an aim
            # is computed from would not be the rect the gesture lands on.
            time.sleep(1.5)

            start = listing(ff)
            print("rows     %s" % start.get("names"))
            print("caret    %s   position %r" % (start.get("caret"), start.get("position")))
            names = start.get("names") or []
            if len(names) < 2:
                print("BAD  the live `files` window drew %d row(s); two different rows are needed "
                      "to tell a light that MOVED from a light that appeared" % len(names))
                return 1
            if start.get("lit") is not None:
                print("BAD  a row was already lit before any gesture, so clause 1 is vacuous")
                return 1

            # ---- 6. THE COLUMNS ARRIVED AT ALL -------------------------------------------------
            cells = start.get("cells") or {}
            clauses["cells-sit-in-their-columns"] = (
                not (start.get("stray") or [])
                and all(isinstance(cells.get(n, {}).get("type"), str) for n in names))
            print("cells    %s   stray %s" % (json.dumps(cells), start.get("stray")))

            # ---- 1. A HOVER LIGHTS A ROW -------------------------------------------------------
            first, second = names[0], names[1]
            at1 = OFF_WINDOW if args.prove_failure else aim(ff, "row", first)
            ff.move(at1["x"], at1["y"])
            time.sleep(GESTURE_S)
            lit1 = listing(ff)
            print("hover 1  at %s -> lit %r" % (at1, lit1.get("lit")))
            clauses["hover-lights-a-row"] = lit1.get("lit") == first

            # ---- 2. AND A SECOND MOVE MOVES IT ------------------------------------------------
            at2 = OFF_WINDOW if args.prove_failure else aim(ff, "row", second)
            ff.move(at2["x"], at2["y"])
            time.sleep(GESTURE_S)
            lit2 = listing(ff)
            print("hover 2  at %s -> lit %r" % (at2, lit2.get("lit")))
            clauses["hover-moves-the-light"] = (lit2.get("lit") == second
                                                and lit2.get("lit") != lit1.get("lit"))

            # ---- 3. AND THE POINTER LEAVING CLEARS IT ----------------------------------------
            ff.move(OFF_WINDOW["x"], OFF_WINDOW["y"])
            time.sleep(GESTURE_S)
            left = listing(ff)
            print("leave    -> lit %r" % left.get("lit"))
            clauses["leave-clears-the-light"] = left.get("lit") is None

            # ---- 4 and 5. A HEADER CLICK SORTS, A SECOND REVERSES ----------------------------
            head = aim(ff, "header", "type")
            ff.click(head["x"], head["y"])
            time.sleep(GESTURE_S)
            asc = listing(ff)
            print("sort     at %s -> %s caret %s" % (head, asc.get("names"), asc.get("caret")))
            caret_asc = asc.get("caret") or {}
            clauses["a-header-click-sorts"] = (caret_asc.get("key") == "type"
                                               and caret_asc.get("dir") == 1
                                               and asc.get("names") != names)
            ff.click(head["x"], head["y"])
            time.sleep(GESTURE_S)
            desc = listing(ff)
            print("reverse  -> %s caret %s" % (desc.get("names"), desc.get("caret")))
            caret_desc = desc.get("caret") or {}
            clauses["a-second-click-reverses"] = (
                caret_desc.get("key") == "type" and caret_desc.get("dir") == -1
                and list(reversed(desc.get("names") or [])) == (asc.get("names") or []))

            ff.screenshot(args.shot)
            print("shot     %s" % args.shot)
    finally:
        if httpd:
            httpd.shutdown()

    red = sorted(k for k, v in clauses.items() if not v)
    for name in sorted(clauses):
        print("%-4s %s" % ("ok" if clauses[name] else "BAD", name))

    if args.prove_failure:
        #: The NAMED subset the control turns. A control satisfied by any failure verifies nothing.
        want = {"hover-lights-a-row", "hover-moves-the-light"}
        if set(red) == want:
            print("--prove-failure: %s went red and nothing else did, which is the proof"
                  % ", ".join(sorted(want)))
            return 0
        print("--prove-failure: expected exactly %s red, got %s. The control did not move the "
              "subset it claims." % (sorted(want), red))
        return 1

    if red:
        print("FAILED: %s" % ", ".join(red))
        return 1
    print("ok: %d clause(s), Firefox, real trusted input" % len(clauses))
    return 0


if __name__ == "__main__":
    sys.exit(main())
