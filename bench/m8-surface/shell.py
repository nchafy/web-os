#!/usr/bin/env python3
"""Run `paint` FROM THE SHELL, in a real browser, and keep the screenshot.

    python3 bench/m8-surface/shell.py
    python3 bench/m8-surface/shell.py --cmd "paint -w 200 -h 120"

WHY THIS EXISTS. `scripts/check.py --only m8` spawns `paint` BY URL, which is the page's supervisor
path (`docs/DECISIONS.md` D18) — not the path a person takes. A user opens the desktop, types
`paint`, and the shell resolves it through the mount table, `exec` loads it from `/usr/bin`, and
`win_create` and `win_surface` happen inside a process the SHELL spawned. Those are different
loaders with different refusals, and M6's own history is the reason to care: a program that ran
from the page was refused from the filesystem, and only running it from the shell found that
(constraint 208).

It asserts two things and prints the rest: that a surface appeared, and that something was drawn on
it. The screenshot is evidence a reader looks at.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import time

REPO = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))

import cdp  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cmd", default="paint -w 160 -h 120",
                    help="the command line to type at the prompt")
    ap.add_argument("--port", type=int, default=8713)
    ap.add_argument("--out", default=str(REPO / "bench" / "m8-surface" / "shell.png"))
    ap.add_argument("--hold", type=float, default=0.0,
                    help="seconds to leave the browser open at the end")
    args = ap.parse_args(argv)

    server = subprocess.Popen(
        [sys.executable, str(REPO / "scripts" / "serve.py"), "--port", str(args.port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=str(REPO))
    try:
        time.sleep(0.7)
        url = "http://127.0.0.1:%d/www/m8.html?live=1" % args.port
        print("url      %s" % url)
        with cdp.Browser() as browser:
            page = browser.page()
            page.navigate(url)
            # THE PROMPT FIRST. Typing before the shell has one puts the keys in a queue nobody is
            # reading, and the failure would look like a program that did not start.
            deadline = time.time() + 90
            prompted = False
            while time.time() < deadline:
                state = page.evaluate(
                    "(() => { const M = globalThis.M8 || {}; "
                    "if (M.state === 'error' || M.state === 'aborted') return 'dead'; "
                    "const t = document.querySelector('.terminal'); "
                    # `/\\$ /` in JS. Over-escaping it here matched a literal backslash and
                    # the wait timed out against a prompt that was on the screen.
                    "return t && /\\$ /.test(t.textContent) ? 'prompt' : '' })()")
                if state == "dead":
                    print("the page died: %s"
                          % page.evaluate("String(globalThis.M8.why || '')"))
                    return 1
                if state == "prompt":
                    prompted = True
                    break
                time.sleep(0.25)
            if not prompted:
                print("no prompt in 90 s")
                return 1
            focused = page.evaluate(
                "(() => { const t = document.querySelector('.terminal');"
                " if (!t) return 'no terminal'; t.focus();"
                " return document.activeElement === t ? '' : 'the terminal refused focus' })()")
            if focused:
                print("could not type: %s" % focused)
                return 1
            # REAL KEYS, through Chrome's own input pipeline: the shell is on the other side of a
            # pty and a window, and nothing synthetic exercises that chain.
            page.type_keys(args.cmd + "\n")
            # A SURFACE, AND THEN SOMETHING ON IT. Two waits, because "the program started" and
            # "the program drew" are different facts and the first is not the milestone.
            surfaced = ""
            deadline = time.time() + 40
            while time.time() < deadline:
                surfaced = page.evaluate(
                    "(() => { const c = document.querySelectorAll('canvas.surface');"
                    " if (!c.length) return ''; const g = c[0].getContext('2d');"
                    " const d = g.getImageData(0, 0, c[0].width, c[0].height).data;"
                    " let ink = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) ink += 1;"
                    " return JSON.stringify({surfaces: c.length, w: c[0].width,"
                    " h: c[0].height, painted: ink}) })()")
                if surfaced:
                    got = json.loads(surfaced)
                    if got["painted"] > 0:
                        break
                time.sleep(0.25)
            page.call("Page.captureScreenshot")
            shot = page.call("Page.captureScreenshot", format="png")
            pathlib.Path(args.out).write_bytes(__import__("base64").b64decode(shot["data"]))
            screen = page.evaluate(
                "(() => { const t = document.querySelector('.terminal');"
                " return t ? t.textContent.slice(-400) : '' })()")
            print("terminal (last 400 chars):\n%s" % screen)
            if not surfaced:
                print("NO SURFACE appeared after typing %r at the prompt" % args.cmd)
                return 1
            got = json.loads(surfaced)
            print("surface  %s" % surfaced)
            print("png      %s" % args.out)
            if got["painted"] <= 0:
                print("A SURFACE APPEARED AND NOTHING WAS DRAWN ON IT, which is the half of this "
                      "that matters: the window exists and the display list did not arrive.")
                return 1
            print("ok: `%s` from the SHELL opened a surface of %dx%d and drew %d pixels on it"
                  % (args.cmd, got["w"], got["h"], got["painted"]))
            if args.hold:
                time.sleep(args.hold)
        return 0
    finally:
        server.terminate()


if __name__ == "__main__":
    raise SystemExit(main())
