#!/usr/bin/env python3
"""DOES THE LIST SCROLL IN FIREFOX? M17's wheel, driven with REAL trusted input in a second engine.

    python3 bench/m17-wheel/firefox-scroll.py
    python3 bench/m17-wheel/firefox-scroll.py --headed
    python3 bench/m17-wheel/firefox-scroll.py --prove-failure

WHY THIS FILE EXISTS. CLAUDE.md makes a second engine a condition of reporting a milestone done,
and it records the bill for skipping it: M4a shipped a window that could not be dragged in Firefox,
M6 shipped a policy under which no process started there, and M11 and M12 each failed on an engine
whose feature was fine because a geometry was derived from a constant taken at dpr 2. Four
milestones, every Chrome expectation green each time, every one found by a human opening the page.

M17's registered suite drives Chrome only, and M17's subject is a WHEEL — the one input class this
project had never delivered. Two things make it the likeliest repeat of that bill yet:

  1. **The delta's unit differs between the two drivers.** CDP's `deltaY` is DEVICE pixels and the
     `wheel` event reports `deltaY / devicePixelRatio` (constraint 297, measured 12/12 over four
     deltas at three ratios). BiDi's `scroll` takes CSS pixels. A gate that reused the Chrome
     figure here would scroll by the ratio too far.
  2. **Firefox renders at dpr 1 on the reference machine** (constraint 264), and at dpr 1 the whole
     device-px/CSS-px distinction M16 and M17 are built on collapses to multiplication by one. So
     this engine is where a unit error HIDES, which is exactly why the assertion has to be about a
     distance and not about a ratio.

WHAT IS ASSERTED, all of it read back out of the display list the program actually drew — through
`globalThis.M17.lastTextRuns`, which is the PAGE's own decoder rather than a second one that could
disagree with it:

  1. the list scrolls at all: the position line changes after a wheel over the window;
  2. it scrolls DOWN for a positive delta — the sign, which is the one thing a mirrored conversion
     gets wrong while every magnitude still looks right;
  3. the header survives: `Name` is still drawn after the scroll, which is the clip doing its job;
  4. it clamps at the END — a long stream stops, and the position line stops changing with it;
  5. it clamps at the TOP and the first row comes back to 1.

`--prove-failure` turns the wheel into a no-op by scrolling with a zero delta, and the gate MUST
then report that nothing moved. A gate nobody has seen fail is a gate nobody has checked. It exits
0 when the proof SUCCEEDED.
"""
from __future__ import annotations

import argparse
import os
import pathlib
import re
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import bidi   # noqa: E402
import serve  # noqa: E402

#: The page's state, plus the one window this gate is about. `cx`/`cy` are where the wheel goes:
#: the CENTRE of the canvas, in CSS px, which is the unit BiDi's `scroll` takes.
STATE = """JSON.stringify((() => {
  const M = globalThis.M17 || {}
  const host = M.host
  const out = { state: String(M.state || ''), phase: String(M.phase || ''),
                why: String(M.why || ''), dpr: devicePixelRatio,
                errors: (M.errors || []).map(String).slice(0, 4), files: null }
  if (!host) return out
  for (const entry of host.frames.values()) {
    if (!entry.win.titleText.includes('files') || !entry.surface) continue
    const r = entry.surface.el.getBoundingClientRect()
    out.files = {
      id: entry.id,
      cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
      cssW: Math.round(r.width), cssH: Math.round(r.height),
      store: { w: entry.surface.w, h: entry.surface.h },
      batches: entry.surface.batches,
    }
    break
  }
  return out
})())"""

#: The POSITION LINE and the header, out of the page's own decoder. `files` draws `1-9 of 40` while
#: the list can scroll and `40 items` when it cannot, which is that program's own wording.
DRAWN = """JSON.stringify((() => {
  const runs = (globalThis.M17 || {}).lastTextRuns
    ? globalThis.M17.lastTextRuns('files') : null
  if (!runs) return null
  const place = runs.find((r) => /^\\d+-\\d+ of \\d+$/.test(r.text) || /^\\d+ items?$/.test(r.text))
  return {
    place: place ? place.text : '',
    header: runs.some((r) => r.text === 'Name'),
    names: runs.filter((r) => r.text !== 'Name' && !/^\\d+-\\d+ of \\d+$/.test(r.text)
                              && !/^\\d+ items?$/.test(r.text)).map((r) => r.text).slice(0, 3),
    runs: runs.length,
  }
})())"""

POS = re.compile(r"^(\d+)-(\d+) of (\d+)$")


def first_row(place: str) -> int | None:
    """The row at the top of the viewport, from the program's own position line."""
    m = POS.match(place or "")
    return int(m.group(1)) if m else None


def drawn(ff) -> dict:
    got = ff.evaluate(DRAWN)
    return got if isinstance(got, dict) else {}


def settle(ff, tries: int = 100) -> dict:
    """Wait for a `files` window with a surface, and for its batch count to stop moving.

    THE SECOND HALF IS NOT DECORATION. The live page boots a kernel, spawns programs and prints a
    log that pushes the layout down; a canvas centre read before that and a wheel sent after it is
    a wheel sent where the window is not. Two identical reads is the signal, which is
    `bench/m14-shell/firefox-drive.py`'s rule for the same hazard.
    """
    last, stable = None, 0
    for _ in range(tries):
        st = ff.evaluate(STATE)
        f = st.get("files")
        now = None if not f else (f["cx"], f["cy"], f["batches"])
        stable = stable + 1 if now and now == last else 0
        last = now
        if stable >= 2:
            return st
        time.sleep(0.4)
    return ff.evaluate(STATE)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--url", default="", help="an already-running server; otherwise one is bound")
    ap.add_argument("--w", type=int, default=1560)
    ap.add_argument("--h", type=int, default=1010)
    ap.add_argument("--notch", type=int, default=120,
                    help="CSS px per notch. BiDi's `scroll` takes CSS px, NOT the device px CDP "
                         "takes (constraint 297)")
    ap.add_argument("--shot", default=str(HERE / "firefox-scroll.png"))
    ap.add_argument("--prove-failure", action="store_true",
                    help="scroll with a ZERO delta, so nothing may move and the gate MUST say so. "
                         "Exits 0 when the proof succeeded.")
    args = ap.parse_args(argv)

    notch = 0 if args.prove_failure else args.notch

    httpd = None
    url = args.url
    if not url:
        os.chdir(REPO)
        httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d/www/m17.html" % httpd.server_address[1]
    print("url      %s" % url)
    if args.prove_failure:
        print("control  --prove-failure: every wheel carries deltaY 0")

    bad: list[str] = []
    moved: list[str] = []
    try:
        with bidi.Firefox(headless=not args.headed, width=args.w, height=args.h) as ff:
            ff.navigate(url)
            st = settle(ff)
            print("firefox  dpr %s  state=%r phase=%r" % (st.get("dpr"), st.get("state"),
                                                          st.get("phase")))
            if st.get("errors"):
                print("page errors %s" % st["errors"])
            f = st.get("files")
            if not f:
                bad.append("no `files` window with a surface ever appeared, so there was nothing "
                           "to scroll. why=%r" % st.get("why"))
                print("BAD  %s" % bad[-1])
                return 1
            print("files    canvas %sx%s CSS px, store %sx%s device px, centre (%s,%s)"
                  % (f["cssW"], f["cssH"], f["store"]["w"], f["store"]["h"], f["cx"], f["cy"]))
            # THE SURFACE IS THE CLIENT BOX, IN DEVICE PX — M16's claim, re-read in this engine.
            # At dpr 1 the two numbers coincide, which is why this is reported and not asserted
            # here: `www/m16.html` owns that assertion and owns it at BOTH ratios.
            start = drawn(ff)
            print("drawn    place=%r header=%s runs=%s names=%s"
                  % (start.get("place"), start.get("header"), start.get("runs"),
                     start.get("names")))
            if not start.get("place"):
                bad.append("the list drew no position line, so where it is cannot be read")
            if not start.get("header"):
                bad.append("the header was not drawn before any wheel, so clause 3 is vacuous")
            if bad:
                for line in bad:
                    print("BAD  %s" % line)
                return 1
            before = first_row(start["place"])

            # ---- 1 and 2. IT SCROLLS, AND IT SCROLLS DOWN ----
            ff.wheel(f["cx"], f["cy"], notch, times=3, pause_ms=30)
            time.sleep(0.6)
            down = drawn(ff)
            after = first_row(down.get("place"))
            print("down     place=%r header=%s" % (down.get("place"), down.get("header")))
            if before is None or after is None:
                bad.append("the position line stopped parsing: %r -> %r"
                           % (start.get("place"), down.get("place")))
            elif after == before:
                bad.append("three notches of %d CSS px moved the top row not at all (%d), so the "
                           "wheel did not reach the program in this engine" % (notch, before))
            elif after < before:
                bad.append("a POSITIVE delta scrolled the list UP, %d -> %d: the sign is mirrored, "
                           "which every magnitude assertion would still pass" % (before, after))
            else:
                moved.append("the top row went %d -> %d on three notches" % (before, after))

            # ---- 3. THE HEADER SURVIVED ----
            if not down.get("header"):
                bad.append("`Name` was not drawn after the scroll: an unclipped row painted over "
                           "the header, which is what DL_CLIP exists to stop")
            else:
                moved.append("the header survived the scroll")

            # ---- 4. IT CLAMPS AT THE END ----
            ff.wheel(f["cx"], f["cy"], notch, times=30, pause_ms=10)
            time.sleep(0.8)
            end1 = drawn(ff)
            ff.wheel(f["cx"], f["cy"], notch, times=10, pause_ms=10)
            time.sleep(0.8)
            end2 = drawn(ff)
            print("end      %r then %r" % (end1.get("place"), end2.get("place")))
            if end1.get("place") != end2.get("place"):
                bad.append("the list was still moving after 33 notches: %r then %r, so the end "
                           "clamp did not hold" % (end1.get("place"), end2.get("place")))
            else:
                moved.append("it stopped at %r and ten more notches did not move it"
                             % end1.get("place"))

            # ---- 5. AND BACK TO THE TOP ----
            ff.wheel(f["cx"], f["cy"], -notch, times=60, pause_ms=10)
            time.sleep(0.9)
            top = drawn(ff)
            top_row = first_row(top.get("place"))
            print("top      place=%r header=%s" % (top.get("place"), top.get("header")))
            if top_row != 1:
                bad.append("sixty notches up left the top row at %r, not 1, so the top clamp did "
                           "not bring it home" % (top.get("place"),))
            else:
                moved.append("it came back to row 1")

            ff.screenshot(args.shot)
            print("shot     %s" % args.shot)
    finally:
        if httpd is not None:
            httpd.shutdown()

    print()
    for line in moved:
        print("ok   %s" % line)
    for line in bad:
        print("BAD  %s" % line)

    if args.prove_failure:
        # THE PROOF IS THAT IT FAILED. A zero delta that still scrolled the list would mean this
        # gate is reading something other than the wheel it sent.
        if bad:
            print("\n--prove-failure: the gate reported %d failure(s) with a zero delta, as "
                  "required" % len(bad))
            return 0
        print("\n--prove-failure: THE GATE PASSED WITH A ZERO DELTA. It is not measuring the "
              "wheel it sends.")
        return 1

    if bad:
        return 1
    print("\nthe list scrolls, clips and clamps in FIREFOX, with real trusted input")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
