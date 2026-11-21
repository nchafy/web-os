#!/usr/bin/env python3
"""M11's owed experiment: IS THE GLASS REAL, AND WHICH GEOMETRY DOES THE BUDGET BIND ON?

    python3 bench/m11-glass/probe.py            # headless, which is what the suite runs
    python3 bench/m11-glass/probe.py --headed   # the engine gap-04 measured Aero in

Two questions, both of which decide code that would otherwise be written on an assumption.

**1. Does `backdrop-filter: blur()` actually blur in the Chrome the suite drives?**
`scripts/check.py` runs `--headless=new`. If the blur is a no-op there, M11's pixel proof cannot
live in the suite at all and has to be a headed bench — and nobody has measured which. gap-04's
Aero numbers were taken in a HEADED window at 120 Hz, so the question is open by construction.

**2. Is a frame-only ring cheaper, measured in the unit constraint 49 requires?**
`backdrop-filter` filters the element's BORDER BOX. So one glass node with an opaque client child
pays the whole window and "frame-only glass is ~11x cheaper" (`docs/DECISIONS.md` D13) is false of
that geometry; only four separately-filtered strips make the filtered area the ring
(`docs/designs/REVIEW-FINDINGS.md` §3). This prints both areas so D13 rests on an arithmetic a
reader can check rather than on the phrase "frame-only".

**And the control that matters is not the one the plan named.** `PLAN.md` §5 gives M11's negative
control as `backdrop-filter: none`. REVIEW-FINDINGS §8 measured that `none` also removes the
isolated group the additive layers blend into, shifting the pixel by (31,46,71) for a reason that
has nothing to do with blurring — so it would pass against a system with no blur. `blur(0px)` keeps
the isolation and changes only the blur. This probe samples BOTH, so the choice is a measurement.

ABORTS rather than reporting a number from a non-isolated context, which `CLAUDE.md` requires of
every harness here.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import pathlib
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import cdp          # noqa: E402  the project's one CDP driver
import serve        # noqa: E402  the project's one static server
# The project's one PNG reader, and the one seam sampler. `scripts/check.py` imports the same
# three functions, so the suite's assertion and the bench that chose its threshold are the same
# arithmetic rather than two copies of it.
from png import Image, band_profile, transition  # noqa: E402

DOC = "/bench/m11-glass/page.html"

#: How far either side of the seam to sample, in CSS px. A 9 px standard deviation puts ~68% of the
#: kernel inside +-9, so +-8 is the steep part of the ramp and is monotonic there; a wider run runs
#: into the flat tails where a one-LSB wobble is not a defect.
REACH_CSS = 8

#: How many device rows to average each sample over. The compositor dithers, so one row carries a
#: +-1 wobble that a monotonicity test would read as a failure. Averaging rows is honest because the
#: seam is VERTICAL: every row in the run sees the same horizontal profile.
ROWS = 6


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true",
                    help="drive a real window, which is the engine gap-04 measured Aero in")
    ap.add_argument("--dpr", type=float, default=2.0,
                    help="device scale factor; gap-04's Aero figures are all at 2")
    ap.add_argument("--shot", default="", help="also write the screenshot here")
    args = ap.parse_args(argv[1:])

    os.chdir(REPO)
    httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d%s" % (port, DOC)
    print("glass probe  %s  (%s, dpr %g)"
          % (url, "headed" if args.headed else "headless", args.dpr), file=sys.stderr)

    extra = ("--window-size=1100,760",) if args.headed else ()
    try:
        with cdp.Browser(extra_args=extra, headless=not args.headed) as browser:
            page = browser.page()
            page.emulate_device(width=1000, height=1250, scale_factor=args.dpr, mobile=False)
            page.navigate(url, timeout=60)
            # The isolation gate, before any number is taken. A bench that reports a figure from a
            # non-isolated context is the worst outcome available (CLAUDE.md).
            isolated = page.evaluate("Boolean(globalThis.crossOriginIsolated)")
            deadline = time.time() + 30
            state = ""
            while time.time() < deadline:
                state = page.evaluate(
                    "String((globalThis.GLASS && globalThis.GLASS.state) || '')")
                if state == "done":
                    break
                time.sleep(0.1)
            if state != "done":
                print(json.dumps({"ok": False, "state": state or "timeout"}, indent=2))
                return 3
            report = json.loads(page.evaluate("JSON.stringify(globalThis.GLASS)"))
            data = page.call("Page.captureScreenshot", format="png").get("data")
    except cdp.CDPError as error:
        print(json.dumps({"ok": False, "state": "no-browser", "why": str(error)}, indent=2))
        return 3
    finally:
        httpd.shutdown()
        httpd.server_close()

    if not isolated:
        print(json.dumps({
            "ok": False, "state": "not-isolated",
            "why": "crossOriginIsolated is false, so this run would report a number from a "
                   "context the project does not ship. Nothing was measured.",
        }, indent=2))
        return 3
    if not data:
        print(json.dumps({"ok": False, "state": "no-screenshot"}, indent=2))
        return 3
    raw = base64.b64decode(data)
    if args.shot:
        pathlib.Path(args.shot).write_bytes(raw)
    img = Image.decode(raw)

    dpr = report["dpr"]
    desk = report["desk"]
    seam_dev = desk["x"] + int(round(report["seamX"] * dpr))
    out = {}
    for name, spec in report["specimens"].items():
        rect = spec["rect"]
        # The caption's own vertical middle, so the sample is inside the glass and clear of its
        # 1 px borders.
        mid_y = rect["y"] + rect["h"] // 2
        if name in ("ring640", "box640"):
            # A window's sampled band is its CAPTION, which is the part a reader looks at, the only
            # glass a ring has at the top, and the only band a box window's opaque client does not
            # cover. Sampling a box window's middle would read its client area and say nothing.
            mid_y = rect["y"] + int(round(report["capH"] * dpr / 2))
        xs, lumas = band_profile(img, seam_x=seam_dev, y=mid_y - ROWS // 2, rows=ROWS,
                                 dpr=dpr, reach_css=REACH_CSS)
        entry = transition(lumas).as_dict()
        entry["xs"] = xs
        entry["filteredCssPx"] = round(spec["filteredCssPx"])
        entry["backdropFilter"] = spec["backdropFilter"]
        entry["severedBy"] = spec["severed"]
        entry["glassNodes"] = spec["nodes"]
        out[name] = entry

    # The bare backdrop, with no glass over it, as the reference step. Sampled well below every
    # specimen so nothing filters it.
    xs, lumas = band_profile(img, seam_x=seam_dev, y=desk["y"] + desk["h"] - 20 - ROWS // 2,
                             rows=ROWS, dpr=dpr, reach_css=REACH_CSS)
    out["bare"] = transition(lumas).as_dict()
    out["bare"]["xs"] = xs
    out["bare"]["filteredCssPx"] = 0

    ring_area = out["ring640"]["filteredCssPx"]
    box_area = out["box640"]["filteredCssPx"]
    verdict = {
        "headless": not args.headed,
        "dpr": dpr,
        "isolated": isolated,
        # Q1. A ramp spread across the run is a blur; a step concentrated in one jump is not.
        "blurReachesTheCompositor":
            out["blur9"]["concentration"] < 0.5 and out["bare"]["concentration"] > 0.8,
        # Q1b. Which control actually discriminates. Both are printed; neither is assumed.
        "blur0IsAStep": out["blur0"]["concentration"] > 0.5,
        "nofilterIsAStep": out["nofilter"]["concentration"] > 0.5,
        "severedIsAStep": out["severed"]["concentration"] > 0.5,
        # Q2. The two geometries at ONE window size, in the unit constraint 49 requires: the sum of
        # each glass element's own border box.
        "windowCssPx": 640 * 440,
        "ringFilteredCssPx": ring_area,
        "boxFilteredCssPx": box_area,
        "ringIsCheaperBy": round(box_area / ring_area, 2) if ring_area else None,
        "ringGlassNodes": out["ring640"]["glassNodes"],
        "boxGlassNodes": out["box640"]["glassNodes"],
        "ringStillBlurs": out["ring640"]["concentration"] < 0.5,
        "boxStillBlurs": out["box640"]["concentration"] < 0.5,
        # What each geometry does to gap-04's measured ~58 M device-px wall, at dpr 2.
        "windowsToTheWall": {
            "ring": int(58e6 / (ring_area * dpr * dpr)) if ring_area else None,
            "box": int(58e6 / (box_area * dpr * dpr)) if box_area else None,
        },
    }
    print(json.dumps({"ok": True, "verdict": verdict, "profiles": out}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
