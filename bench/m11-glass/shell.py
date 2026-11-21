#!/usr/bin/env python3
"""Type at a REAL prompt on the Aero desktop, and sample the glass of the window you typed into.

    python3 bench/m11-glass/shell.py                 # `ls /usr/bin` at the prompt, then the glass
    python3 bench/m11-glass/shell.py --cmd "winopen -n 2"
    python3 bench/m11-glass/shell.py --headed        # a real window rather than SwiftShader

WHY THIS EXISTS, as `bench/m9-modal/shell.py` says for `editor`: `scripts/check.py --only m11` runs
the proofs page, which spawns `winopen` BY URL — the page's supervisor path (`docs/DECISIONS.md`
D18), not the path a person takes. A user opens the desktop, types a command, and the shell resolves
it through the mount table while `exec` loads it from `/usr/bin`.

AND IT ASSERTS THE THING THE PROOFS PAGE CANNOT. The proofs run over a black/white seam, which is a
test fixture — a reader never sees it. This runs on the SKIN'S OWN DESKTOP, the gradient
`src/wm/aero.mjs` actually ships, and asks the question constraint 50 is about in the place it
matters: is there a blur over a backdrop nobody chose for being measurable?

The Aero desktop's own gradient is not flat but it is SMOOTH, so a concentration figure over it says
little either way — which is exactly why the proofs page needs its seam. What this asserts instead
is the pair the real desktop CAN answer: the caption's glass differs from the desktop immediately
outside the frame (so something is compositing there), and the caption's text is legible against it.
A flat caption over a flat desktop fails both.
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
from png import Image, local_range, luma  # noqa: E402

#: What the page can answer about itself in one evaluate, so the parts cannot be read a moment apart.
#: `cdp.Session.evaluate` returns the value already deserialized, so this expression yields the
#: object itself rather than a string to parse.
STATE = """(() => {
  const wins = [...document.querySelectorAll('.window')]
  const cap = wins.length ? wins[0].querySelector('.aero-cap') : null
  const body = wins.length ? wins[0].querySelector('.window-body') : null
  const term = wins.length ? wins[0].querySelector('.terminal') : null
  const dpr = window.devicePixelRatio
  const dev = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.ceil(r.left * dpr), y: Math.ceil(r.top * dpr),
             w: Math.floor(r.width * dpr), h: Math.floor(r.height * dpr) }
  }
  return {
    phase: String((globalThis.M11 || {}).phase || ''),
    state: String((globalThis.M11 || {}).state || ''),
    windows: wins.length,
    titles: wins.map((w) => (w.querySelector('h2') || {}).textContent || ''),
    screen: term ? term.textContent : '',
    dpr,
    caption: dev(cap),
    body: dev(body),
    captionFilter: cap ? getComputedStyle(cap).backdropFilter : '',
    sheen: cap && cap.querySelector('.aero-sheen')
      ? getComputedStyle(cap.querySelector('.aero-sheen')).backgroundColor : '',
    desktopBackground: getComputedStyle(document.getElementById('desktop')).backgroundImage
      .slice(0, 60),
  }
})()"""


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cmd", default="ls /usr/bin")
    ap.add_argument("--expect", default="winopen",
                    help="a name --cmd must PRINT, so the round trip is proved through a real "
                         "process rather than just through the echo")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--dpr", type=float, default=2.0)
    ap.add_argument("--shot", default=str(HERE / "shell.png"))
    args = ap.parse_args(argv[1:])

    os.chdir(REPO)
    httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/www/m11.html?live=1" % port
    print("m11 shell  %s" % url, file=sys.stderr)

    bad: list[str] = []
    try:
        with cdp.Browser(extra_args=("--window-size=1100,860",) if args.headed else (),
                         headless=not args.headed) as browser:
            page = browser.page()
            page.emulate_device(width=1024, height=760, scale_factor=args.dpr, mobile=False)
            page.navigate(url, timeout=60)
            # The prompt, not a timer: a shell that has not printed one cannot be typed at.
            deadline = time.time() + 60
            while time.time() < deadline:
                st = page.evaluate(STATE)
                if st["windows"] >= 1 and "$" in (st["screen"] or ""):
                    break
                time.sleep(0.25)
            else:
                print(json.dumps({"ok": False, "why": "no prompt appeared on the Aero desktop",
                                  "state": st}, indent=2))
                return 3

            # REAL KEYS, through Chrome's own input pipeline. `src/wm/terminal.mjs` counts trusted
            # and synthetic presses apart, and a synthesised event exercises the handler and
            # nothing in front of it.
            page.type_keys(args.cmd + "\n")
            # THE WHOLE COMMAND, AND THEN ITS OUTPUT. Waiting for the first word alone is a race
            # this run already lost once: it broke on `ls` while `/usr/bin` was still arriving, so
            # the sample was taken mid-typing and the assertion passed on four characters.
            deadline = time.time() + 30
            echoed = False
            produced = False
            while time.time() < deadline:
                st = page.evaluate(STATE)
                screen = st["screen"] or ""
                echoed = echoed or args.cmd in screen
                # Output, not just the echo: `args.expect` is a name the command must print, so the
                # round trip is proved all the way through a real process and back.
                produced = echoed and args.expect in screen.split(args.cmd, 1)[-1]
                if produced:
                    break
                time.sleep(0.25)
            screen = st["screen"] or ""
            if not echoed:
                bad.append("the command never echoed in full: the pty did not round-trip %r"
                           % args.cmd)
            elif not produced:
                bad.append("the command echoed but printed no %r: the process did not run"
                           % args.expect)

            data = page.call("Page.captureScreenshot", format="png").get("data")
    except cdp.CDPError as error:
        print(json.dumps({"ok": False, "why": str(error)}, indent=2))
        return 3
    finally:
        httpd.shutdown()
        httpd.server_close()

    if not data:
        # NAMED, never a TypeError out of b64decode. `probe.py` guards this and these did not.
        print(json.dumps({"ok": False, "why": "Page.captureScreenshot returned no data, so no "
                                              "pixel below was measured"}, indent=2))
        return 3
    pathlib.Path(args.shot).write_bytes(base64.b64decode(data))
    img = Image.decode(base64.b64decode(data))
    cap, body = st["caption"], st["body"]

    # THE CAPTION'S GLASS AGAINST THE DESKTOP JUST OUTSIDE THE FRAME. Sampled a few device px to
    # the left of the window, at the caption's own vertical middle, so the two are the same band of
    # the desktop's gradient — one with glass over it and one without.
    outside = {"x": max(0, cap["x"] - 24), "y": cap["y"] + cap["h"] // 3,
               "w": 16, "h": max(2, cap["h"] // 3)}
    inside = {"x": cap["x"] + cap["w"] // 2, "y": cap["y"] + 2,
              "w": 16, "h": max(2, cap["h"] // 4)}
    out_px = local_range(img, outside)
    in_px = local_range(img, inside)
    # A mean each, because the question is whether the glass CHANGED the backdrop, not whether
    # either region has internal structure.
    mean = lambda box: sum(                                     # noqa: E731 - one expression
        luma(img.rgb(box["x"] + c, box["y"] + r))
        for r in range(box["h"]) for c in range(box["w"])) / (box["h"] * box["w"])
    out_mean, in_mean = mean(outside), mean(inside)
    if abs(in_mean - out_mean) < 6.0:
        bad.append("the caption is indistinguishable from the desktop behind it "
                   "(%.1f vs %.1f luma): nothing is compositing there"
                   % (in_mean, out_mean))

    # And the caption's TEXT is legible against whatever that came out as.
    glyphs = {"x": cap["x"] + 8, "y": cap["y"] + cap["h"] // 4,
              "w": min(120, cap["w"] // 3), "h": max(4, cap["h"] // 2)}
    text_px = local_range(img, glyphs)
    if (text_px["ratio"] or 0) < 4.5:
        bad.append("the caption's text is not legible on the real desktop: %s:1"
                   % text_px["ratio"])

    if not st["captionFilter"] or st["captionFilter"] == "none":
        bad.append("the caption carries no backdrop-filter at all: %r" % st["captionFilter"])

    print(json.dumps({
        "ok": not bad,
        "bad": bad,
        "cmd": args.cmd,
        "titles": st["titles"],
        "screenTail": (st["screen"] or "")[-240:],
        "captionFilter": st["captionFilter"],
        "sheen": st["sheen"],
        "desktopBackground": st["desktopBackground"],
        "captionLuma": round(in_mean, 1),
        "desktopLuma": round(out_mean, 1),
        "captionBand": in_px,
        "desktopBand": out_px,
        "glyphContrast": text_px,
        "shot": args.shot,
    }, indent=2))
    if bad:
        for line in bad:
            print("BAD  %s" % line, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
