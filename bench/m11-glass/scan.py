#!/usr/bin/env python3
"""WHERE in a caption is the glass clean? One concentration figure per row.

    python3 bench/m11-glass/scan.py                 # drive www/m11.html and scan its caption
    python3 bench/m11-glass/scan.py --shot a.png --cap-y 452 --cap-h 58 --seam 212

`www/m11.html`'s blur proof samples ONE band and has to place it where nothing but glass is in the
way. This prints the whole column, so the placement rule rests on a measurement rather than on an
instinct about where a caption's text is.

It is what found the asymmetry the rule now encodes. Measured on Chrome 157 at dpr 2:

    caption rows  0- 8 CSS   conc 0.077-0.097   clean glass
    caption rows  9-10 CSS   conc 0.137-0.171   the glyph tops beginning to tell
    caption rows 11-21 CSS   conc 0.48 -0.95    THE GLYPHS
    caption rows 22-27 CSS   conc 0.52 -0.74    still contaminated, and WORSENING downward

The last row is the finding: the caption's `text-shadow` halo is a 10 px blur, so it spills ~10 CSS
px BELOW the glyph box — past the caption's own bottom edge — carrying the glyphs' horizontal
structure with it. The region below the text is inside the text, and a rule that treated the glyph
box as the text's footprint would place the band there. Above the text only ascender tops reach up,
and the measurement is clean from the caption's first row.
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

import cdp          # noqa: E402
import serve        # noqa: E402
from png import Image, band_profile, transition  # noqa: E402

#: The same reach the suite asserts over, so a row's figure here is the figure it would record.
REACH_CSS = 8
#: Three rows, which is the shallowest band the page will ever place (its MIN_ROWS). A deeper scan
#: would smear two adjacent rows' answers together, and the point here is per-row resolution.
ROWS = 3


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--shot", default="", help="scan an existing PNG instead of driving the page")
    ap.add_argument("--seam", type=int, default=0, help="the seam's device x (with --shot)")
    ap.add_argument("--cap-y", type=int, default=0, help="the caption's device y (with --shot)")
    ap.add_argument("--cap-h", type=int, default=0, help="the caption's device height (with --shot)")
    ap.add_argument("--dpr", type=float, default=2.0)
    args = ap.parse_args(argv[1:])

    if args.shot:
        if not (args.seam and args.cap_y and args.cap_h):
            print("--shot needs --seam, --cap-y and --cap-h: this tool reports where in the "
                  "CAPTION a row is, and it cannot find the caption in a bare PNG", file=sys.stderr)
            return 2
        img = Image.decode(pathlib.Path(args.shot).read_bytes())
        geom = {"seamDeviceX": args.seam, "caption": {"y": args.cap_y, "h": args.cap_h},
                "dpr": args.dpr, "textTop": None, "textHeight": None}
    else:
        os.chdir(REPO)
        httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d/www/m11.html" % port
        print("scan  %s" % url, file=sys.stderr)
        try:
            with cdp.Browser() as browser:
                page = browser.page()
                page.emulate_device(width=1024, height=820, scale_factor=args.dpr, mobile=False)
                page.navigate(url, timeout=60)
                deadline = time.time() + 120
                while time.time() < deadline:
                    state = page.evaluate(
                        "(() => { const s = globalThis.M11 && globalThis.M11.state; "
                        "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")
                    if state:
                        break
                    time.sleep(0.2)
                geom = json.loads(page.evaluate(
                    "JSON.stringify((globalThis.M11.proofs.blur || {}).evidence || {})"))
                data = page.call("Page.captureScreenshot", format="png").get("data")
        except cdp.CDPError as error:
            print(json.dumps({"ok": False, "why": str(error)}, indent=2))
            return 3
        finally:
            httpd.shutdown()
            httpd.server_close()
        if not data or not geom.get("caption"):
            print(json.dumps({"ok": False, "why": "the page published no caption geometry"}))
            return 3
        img = Image.decode(base64.b64decode(data))

    dpr = geom["dpr"]
    seam = int(geom["seamDeviceX"])
    cap = geom["caption"]
    text_top, text_h = geom.get("textTop"), geom.get("textHeight")
    print("caption device y=%d h=%d, seam device x=%d, dpr=%g"
          % (cap["y"], cap["h"], seam, dpr))
    if text_top:
        print("glyph box  device y=%d h=%d  (caption rows %.1f-%.1f CSS)"
              % (text_top, text_h, (text_top - cap["y"]) / dpr,
                 (text_top + text_h - cap["y"]) / dpr))
    print()
    print("  device y   caption row   span    jump    concentration")
    for y in range(cap["y"], cap["y"] + cap["h"] - ROWS, max(1, int(round(dpr)))):
        try:
            _, lumas = band_profile(img, seam_x=seam, y=y, rows=ROWS, dpr=dpr,
                                    reach_css=REACH_CSS)
        except Exception as error:             # noqa: BLE001 - named, never swallowed
            print("  %8d   %11s   %s" % (y, "-", error))
            continue
        t = transition(lumas)
        inside = ""
        if text_top and text_top <= y + ROWS and y <= text_top + text_h:
            inside = "  <- glyph box"
        print("  %8d   %8.1f CSS  %6.1f  %6.1f   %.3f%s"
              % (y, (y - cap["y"]) / dpr, t.span, t.biggest_jump, t.concentration, inside))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
