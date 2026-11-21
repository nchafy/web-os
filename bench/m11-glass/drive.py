#!/usr/bin/env python3
"""Open `www/m11.html` in a real Chrome, print what it reported, and sample the glass.

    python3 bench/m11-glass/drive.py                 # the six proofs, and the pixels
    python3 bench/m11-glass/drive.py --no-blur       # the control: blur(0px), isolation kept
    python3 bench/m11-glass/drive.py --no-glass      # the weaker control PLAN.md named
    python3 bench/m11-glass/drive.py --sever         # a wrapper at opacity .99
    python3 bench/m11-glass/drive.py --no-halo       # the caption glow goes
    python3 bench/m11-glass/drive.py --flat-desk     # no seam: blur(flat) == flat
    python3 bench/m11-glass/drive.py --live          # just the desktop, left open to type into
    python3 bench/m11-glass/drive.py --headed        # a real window rather than SwiftShader

This is `bench/m7-win/drive.py`'s job for M11, and it exists for the same reason: the suite's own
check runs the page once, headless, and prints a verdict, while a reader wants the log and the PNG.
It samples the SAME bands and uses the SAME arithmetic as `scripts/check.py` (both import
`scripts/png.py`), so a disagreement between them is a real disagreement and not two samplers.
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
from png import Image, band_profile, transition, local_range  # noqa: E402

#: The same reach and band depth the suite asserts over. One definition would be better still, and
#: it is in `scripts/check.py` as M11_REACH_CSS / M11_BAND_ROWS; these mirror it and the driver
#: prints both so a drift is visible rather than silent.
REACH_CSS = 8
ROWS = 6


def sample(img: Image, blur_ev: dict, legible_ev: dict) -> dict:
    dpr = blur_ev["dpr"]
    seam = blur_ev["seamDeviceX"]
    caption = band_profile(img, seam_x=seam, y=blur_ev["bandY"], rows=blur_ev["bandRows"],
                           dpr=dpr, reach_css=REACH_CSS)
    bare = band_profile(img, seam_x=seam, y=blur_ev["bareY"] - ROWS // 2, rows=ROWS,
                        dpr=dpr, reach_css=REACH_CSS)
    out = {
        "caption": transition(caption[1]).as_dict(),
        "bare": transition(bare[1]).as_dict(),
    }
    for side in ("dark", "light"):
        box = legible_ev.get(side)
        out[side] = local_range(img, box) if box else None
    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-blur", action="store_true")
    ap.add_argument("--no-glass", action="store_true")
    ap.add_argument("--sever", action="store_true")
    ap.add_argument("--no-halo", action="store_true")
    # The control `scripts/check.py`'s own comments credit with finding a defect in the check —
    # the viewport-anchored highlight satisfying the spread assertion over a flat desktop. A bench
    # that claims the same arithmetic as the suite has to be able to reproduce it.
    ap.add_argument("--flat-desk", action="store_true")
    ap.add_argument("--live", action="store_true", help="skip the proofs; leave a desktop open")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--dpr", type=float, default=2.0)
    ap.add_argument("--shot", default=str(HERE / "page.png"))
    args = ap.parse_args(argv[1:])

    query = []
    if args.no_blur:
        query.append("no_blur=1")
    if args.no_glass:
        query.append("no_glass=1")
    if args.sever:
        query.append("sever=1")
    if args.no_halo:
        query.append("no_halo=1")
    if args.flat_desk:
        query.append("flat_desk=1")
    if args.live:
        query.append("live=1")
    doc = "/www/m11.html" + ("?" + "&".join(query) if query else "")

    os.chdir(REPO)
    httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d%s" % (port, doc)
    print("m11  %s  (%s)" % (url, "headed" if args.headed else "headless"), file=sys.stderr)

    try:
        with cdp.Browser(extra_args=("--window-size=1100,860",) if args.headed else (),
                         headless=not args.headed) as browser:
            page = browser.page()
            page.emulate_device(width=1024, height=820, scale_factor=args.dpr, mobile=False)
            page.navigate(url, timeout=60)
            deadline = time.time() + 120
            state = ""
            while time.time() < deadline:
                state = page.evaluate(
                    "(() => { const s = globalThis.M11 && globalThis.M11.state; "
                    "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")
                if state:
                    break
                time.sleep(0.2)
            log = page.evaluate("document.getElementById('log').textContent")
            report = json.loads(page.evaluate(
                "JSON.stringify({state: String(globalThis.M11.state||''), "
                "why: String(globalThis.M11.why||''), "
                "verdict: String(globalThis.M11.verdict||''), "
                "phase: String(globalThis.M11.phase||''), "
                "errors: (globalThis.M11.errors||[]).map(String), "
                "proofs: globalThis.M11.proofs})"))
            data = page.call("Page.captureScreenshot", format="png").get("data")
            if args.live:
                print(log)
                print("\nthe desktop is open; Ctrl-C to close it", file=sys.stderr)
                while True:
                    time.sleep(1)
    except KeyboardInterrupt:
        return 0
    except cdp.CDPError as error:
        print(json.dumps({"ok": False, "why": str(error)}, indent=2))
        return 3
    finally:
        httpd.shutdown()
        httpd.server_close()

    print(log)
    if state != "done":
        print(json.dumps({"ok": False, "state": state or "timeout",
                          "why": report.get("why")}, indent=2))
        return 3
    if not data:
        # NAMED, never a TypeError out of b64decode. `probe.py` guards this and these did not.
        print(json.dumps({"ok": False, "why": "Page.captureScreenshot returned no data, so no "
                                              "pixel below was measured"}, indent=2))
        return 3
    pathlib.Path(args.shot).write_bytes(base64.b64decode(data))
    proofs = report["proofs"] or {}
    blur = (proofs.get("blur") or {}).get("evidence") or {}
    legible = (proofs.get("legible") or {}).get("evidence") or {}
    measured = None
    if blur.get("seamDeviceX"):
        measured = sample(Image.decode(base64.b64decode(data)), blur, legible)
    print(json.dumps({
        "ok": report["verdict"] == "ok",
        "verdict": report["verdict"],
        "pageProofs": {k: bool(v and v.get("ok")) for k, v in proofs.items()},
        "pixels": measured,
        "shot": args.shot,
    }, indent=2))
    return 0 if report["verdict"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
