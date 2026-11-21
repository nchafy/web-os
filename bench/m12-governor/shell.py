#!/usr/bin/env python3
"""Type `winopen -n 4` at a REAL prompt and watch the governor take the glass.

    python3 bench/m12-governor/shell.py
    python3 bench/m12-governor/shell.py --cmd "winopen -n 6 -c 60000"
    python3 bench/m12-governor/shell.py --headed

WHY THIS EXISTS, and it is not decoration: `scripts/check.py --only m12` drives the PROOFS path,
which spawns `winopen` by URL and arms the budget itself. The live desktop is a different code path
with its own arming, and **it was broken** — `bootHost` stopped setting the budget when the proofs
moved to arming one they measure, nothing re-armed it in `live()`, and the desktop ran at the
shipped 45 M budget. That is 413 windows away, so nothing ever degraded while the page's own log
told the reader to type this command and watch the bottom windows lose their glass. They did not.

No check could have caught it. The proofs arm their own budget and pass; the live path has no
assertions. What caught it was typing the command.

It then found a second one. The budget was armed at "four terminals' worth", a terminal is 560x360
and `src/bin/winopen.mjs` asks for 420x260 — so four of the smaller windows fitted a four-terminal
budget and five windows still showed no degrade. It is armed at exactly what is on screen now,
which makes the claim true for any window size.

WHAT IT ASSERTS: that a real keystroke at a real prompt drives the governor, that the glass comes
off the BOTTOM of the stack, that the top window keeps it, and that closing the windows gives it
back. The screenshot is evidence a reader looks at.
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

#: One evaluate, so the frame count, the flat set and the screen cannot be read a moment apart.
#: The flat flag is the DATASET one, which is what `src/wm/winhost.mjs` writes from the kernel's
#: own announcement — so this reads what the page rendered, not what it was told.
STATE = """(() => {
  const w = [...document.querySelectorAll('.window')]
  const title = (x) => ((x.querySelector('h2') || {}).textContent || '').trim()
  return {
    n: w.length,
    order: w.map((x) => ({ title: title(x), depth: Number(x.dataset.depth ?? -1),
                           flat: x.dataset.flat === '1' })),
    flat: w.filter((x) => x.dataset.flat === '1').map(title),
    glass: w.filter((x) => x.dataset.flat !== '1').map(title),
    screen: (document.querySelector('.terminal') || {}).textContent || '',
  }
})()"""


#: Where to click to give the topmost `winopen` window the keyboard. A click is what a person does
#: before typing into a window, and `q` has to reach the window that owns it.
TOP_WINOPEN = """(() => {
  const w = [...document.querySelectorAll('.window')]
    .filter((x) => (((x.querySelector('h2') || {}).textContent) || '').includes('winopen'))
  if (!w.length) return null
  const top = w.reduce((a, b) =>
    Number(b.dataset.depth || 0) > Number(a.dataset.depth || 0) ? b : a)
  const b = top.querySelector('.window-body').getBoundingClientRect()
  return { x: Math.round(b.left + 20), y: Math.round(b.top + 20) }
})()"""


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cmd", default="winopen -n 4 -c 60000")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--dpr", type=float, default=2.0)
    ap.add_argument("--shot", default=str(HERE / "shell.png"))
    args = ap.parse_args(argv[1:])

    os.chdir(REPO)
    httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/www/m12.html?live=1" % port
    print("m12 shell  %s" % url, file=sys.stderr)

    bad: list[str] = []
    try:
        with cdp.Browser(extra_args=("--window-size=1280,900",) if args.headed else (),
                         headless=not args.headed) as browser:
            page = browser.page()
            page.emulate_device(width=1280, height=820, scale_factor=args.dpr, mobile=False)
            page.navigate(url, timeout=60)

            # The PROMPT, not a timer: a shell that has not printed one cannot be typed at.
            deadline = time.time() + 60
            st = {}
            while time.time() < deadline:
                st = page.evaluate(STATE)
                if st["n"] >= 1 and "$" in (st["screen"] or ""):
                    break
                time.sleep(0.25)
            else:
                print(json.dumps({"ok": False, "why": "no prompt on the live desktop",
                                  "state": st}, indent=2))
                return 3
            before = st
            if before["flat"]:
                bad.append("the desktop was already degraded before anything was typed: %s"
                           % before["flat"])

            # REAL KEYS, through Chrome's own input pipeline.
            page.type_keys(args.cmd + "\n")
            want = 1 + int(args.cmd.split("-n")[1].split()[0]) if "-n" in args.cmd else 2
            deadline = time.time() + 40
            while time.time() < deadline:
                st = page.evaluate(STATE)
                if st["n"] >= want and st["flat"]:
                    break
                time.sleep(0.25)
            # A settle, because the governor runs on the page's geometry report and that is a
            # message behind the frame appearing.
            time.sleep(1.0)
            after = page.evaluate(STATE)
            data = page.call("Page.captureScreenshot", format="png").get("data")

            if not after["flat"]:
                bad.append("the governor never fired: %d windows and none flat" % after["n"])
            if not after["glass"]:
                bad.append("every window went flat, so nothing was kept — the budget is too low "
                           "for this to show an ORDER at all")
            # FROM THE BOTTOM: the flat ones must be the deepest. `data-depth` is the index the
            # kernel's own order gave each frame, so this reads the order the page was sent.
            depths = {r["title"]: r["depth"] for r in after["order"]}
            flat_depths = sorted(depths[t] for t in after["flat"] if t in depths)
            glass_depths = sorted(depths[t] for t in after["glass"] if t in depths)
            if flat_depths and glass_depths and max(flat_depths) > min(glass_depths):
                bad.append("the glass came off the wrong end: flat at depths %s, glass at %s"
                           % (flat_depths, glass_depths))

            # AND CLOSING THEM GIVES IT BACK, which is the other edge of the hysteresis at a real
            # prompt rather than through a kernel message.
            # ONE `q` CLOSES ONE WINDOW — `winopen -n 4` is one process holding four of them — so
            # this presses it until the desktop is back to what it started with. The restore edge
            # is below the budget, which is the point of having two, so the glass returns only
            # once the total is under the LOWER one.
            #
            # AND EACH ONE NEEDS A CLICK FIRST. Closing a window does not move the focus to
            # another, so after the first `q` the keystrokes went nowhere — measured, the desktop
            # stopped at four windows and the assertion failed on a focus problem rather than on
            # the governor. A click on the window then a `q` is the gesture a person makes.
            deadline = time.time() + 60
            restored = after
            while time.time() < deadline:
                restored = page.evaluate(STATE)
                if restored["n"] <= before["n"] and not restored["flat"]:
                    break
                at = page.evaluate(TOP_WINOPEN)
                if not at:
                    break
                for kind in ("mousePressed", "mouseReleased"):
                    page.call("Input.dispatchMouseEvent", type=kind, x=at["x"], y=at["y"],
                              button="left", buttons=1 if kind == "mousePressed" else 0,
                              clickCount=1)
                page.type_keys("q")
                time.sleep(0.5)
            if restored["flat"]:
                bad.append("closing windows did not give the glass back: still flat %s at %d "
                           "windows" % (restored["flat"], restored["n"]))
    except cdp.CDPError as error:
        print(json.dumps({"ok": False, "why": str(error)}, indent=2))
        return 3
    finally:
        httpd.shutdown()
        httpd.server_close()

    if data:
        pathlib.Path(args.shot).write_bytes(base64.b64decode(data))
    print(json.dumps({
        "ok": not bad,
        "bad": bad,
        "cmd": args.cmd,
        "before": {"n": before["n"], "flat": before["flat"], "glass": before["glass"]},
        "afterTyping": {"n": after["n"], "flat": after["flat"], "glass": after["glass"],
                        "order": after["order"]},
        "afterClosing": {"n": restored["n"], "flat": restored["flat"]},
        "screenTail": (after["screen"] or "")[-200:],
        "shot": args.shot,
    }, indent=2))
    if bad:
        for line in bad:
            print("BAD  %s" % line, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
