#!/usr/bin/env python3
"""Open `www/m7.html` in a real Chrome, type the keys it waits for, and print what it reported.

    python3 bench/m7-win/drive.py                  # the five proofs
    python3 bench/m7-win/drive.py --page m14 --live # THE WINDOWS 7 DESKTOP, in a window you can use
    python3 bench/m7-win/drive.py --query win_first_fd=1

THE FAST LOOP FOR A WINDOW MILESTONE. `scripts/check.py --only m7` is the gate and asserts labels;
this prints the page's own log and its evidence, which is what a defect is diagnosed from. It is
NOT a check: it scores nothing and asserts nothing, and it says so in its exit code — 0 whenever
the page reached a terminal state, whatever that state was.

`--live` OPENS A WINDOW AND WAITS FOR YOU TO CLOSE IT. It did neither, and both were reported: this
script took `cdp.Browser()` at its default, which is HEADLESS, so the command CLAUDE.md advertises
as "the Windows 7 desktop, in a real Chrome, left open to type into" opened no window at all — and
then span for 300 s waiting for a terminal state the live page never reaches. A session that exists
to be used ends when the person using it closes it.

THE SERVER IS BOUND HERE, ON A PORT THE OS PICKS. It used to spawn `scripts/serve.py --port 8711`
with both streams sent to DEVNULL, which meant a port already in use arrived as a blank page with
no message — and 8711 appeared in no document while `scripts/serve.py` on its own serves 8000, so
the two numbers read as a contradiction. An ephemeral port cannot collide and is printed.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import threading
import time

REPO = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))

import cdp    # noqa: E402  (the path has to be set up first)
import serve  # noqa: E402

READY = ("(() => { const M = globalThis.%(g)s || {}; const s = M.state; "
         "if (s === 'done' || s === 'aborted' || s === 'error') return s; "
         "return ['await-keys', 'await-pointer', 'await-click'].includes(M.phase)"
         " ? M.phase : '' })()")


def mouse_drag(page, start, end, steps=8):
    """A real press, several moves and a release, through `Input.dispatchMouseEvent`.

    SEVERAL MOVES AND NOT ONE: a program that draws a line from the last point to this one needs
    at least two points to draw anything, and a single jump from press to release is what a
    synthesised drag looks like — not what a hand does.
    """
    page.call("Input.dispatchMouseEvent", type="mousePressed", x=start["x"], y=start["y"],
              button="left", buttons=1, clickCount=1)
    for i in range(1, steps + 1):
        x = start["x"] + (end["x"] - start["x"]) * i // steps
        y = start["y"] + (end["y"] - start["y"]) * i // steps
        page.call("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y,
                  button="left", buttons=1)
    page.call("Input.dispatchMouseEvent", type="mouseReleased", x=end["x"], y=end["y"],
              button="left", buttons=0, clickCount=1)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--live", action="store_true", help="open the desktop only, and leave it open")
    ap.add_argument("--query", action="append", default=[], help="k=v, repeatable")
    ap.add_argument("--hold", type=float, default=0.0,
                    help="seconds to leave the browser open at the end")
    ap.add_argument("--port", type=int, default=0,
                    help="0 (the default) asks the OS for a free port; a fixed one can collide")
    ap.add_argument("--headed", action="store_true",
                    help="open a real window. Implied by --live, which has nothing to show "
                         "without one")
    ap.add_argument("--headless", action="store_true",
                    help="force headless even with --live, for a screenshot-only run")
    ap.add_argument("--page", default="m7", help="which www/<page>.html to drive")
    ap.add_argument("--keys", default="a", help="what to type when the page asks for keys")
    ap.add_argument("--drag", action="store_true",
                    help="the page is waiting for a POINTER drag (www/m8.html): read the "
                         "coordinates it published and send real mouse events")
    args = ap.parse_args(argv)

    # BOUND BEFORE ANYTHING IS PRINTED, so the port in the URL is the port that is listening.
    # `serve.Server` is the same COOP/COEP handler `scripts/serve.py` installs; binding it in
    # process means there is no second interpreter whose failure could go unread.
    os.chdir(REPO)
    httpd = serve.Server(("127.0.0.1", args.port), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    headed = args.headed or (args.live and not args.headless)
    try:
        query = list(args.query)
        if args.live:
            query.append("live=1")
        glob = args.page.upper()
        ready = READY % {"g": glob}
        url = "http://127.0.0.1:%d/www/%s.html" % (port, args.page)
        if query:
            url += "?" + "&".join(query)
        print("url      %s" % url)
        print("mode     %s" % ("headed - close the window to end the session" if headed
                               else "headless"))
        with cdp.Browser(extra_args=("--window-size=1400,1000",) if headed else (),
                         headless=not headed) as browser:
            page = browser.page()
            page.navigate(url)
            deadline = time.time() + 300
            state = ""
            typed = False
            while time.time() < deadline:
                state = page.evaluate(ready) or ""
                if state == "await-click" and not typed:
                    # A CLICK ON A BURIED WINDOW, where the page says it is. Only the page knows:
                    # the frame is positioned by the clamp.
                    at = json.loads(page.evaluate(
                        "JSON.stringify(globalThis.%s.click || null)" % glob) or "null")
                    if not at:
                        print("the page asked for a click and published no coordinates")
                        break
                    page.evaluate("globalThis.%s.driver = 'check'" % glob)
                    page.call("Input.dispatchMouseEvent", type="mousePressed",
                              x=at["x"], y=at["y"], button="left", buttons=1, clickCount=1)
                    page.call("Input.dispatchMouseEvent", type="mouseReleased",
                              x=at["x"], y=at["y"], button="left", buttons=0, clickCount=1)
                    typed = True
                    state = ""
                elif state == "await-pointer" and not typed:
                    # THE DRAG THE PAGE ASKED FOR, through Chrome's own input pipeline, at the
                    # coordinates the page published — the canvas is scaled by CSS, so its own
                    # rectangle is the only honest source for where to click.
                    drag = json.loads(page.evaluate(
                        "JSON.stringify(globalThis.%s.drag || null)" % glob) or "null")
                    if not drag:
                        print("the page asked for a pointer drag and published no coordinates")
                        break
                    page.evaluate("globalThis.%s.driver = 'check'" % glob)
                    mouse_drag(page, drag["from"], drag["to"])
                    typed = True
                    state = ""
                elif state == "await-keys" and not typed:
                    # REAL KEYS, through Chrome's own input pipeline, which is the only way the
                    # widget receives an `isTrusted` event.
                    page.evaluate(
                        "(() => { const t = document.querySelector('.terminal');"
                        " if (t) t.focus(); return document.activeElement === t })()")
                    page.evaluate("globalThis.%s.driver = 'check'" % glob)
                    page.type_keys(args.keys)
                    typed = True
                    state = ""
                elif state in ("done", "aborted", "error"):
                    break
                time.sleep(0.25)
            print("state    %s" % (state or "<never reached a terminal state>"))
            print(page.evaluate("document.getElementById('log').textContent"))
            print("why      %s" % page.evaluate("String(globalThis.%s.why || '')" % glob))
            print("errors   %s" % page.evaluate("JSON.stringify(globalThis.%s.errors)" % glob))
            print("faults   %s" % page.evaluate("JSON.stringify(globalThis.%s.faults)" % glob))
            report = page.evaluate("JSON.stringify(globalThis.%s.proofs)" % glob)
            if report:
                parsed = json.loads(report)
                for name, row in parsed.items():
                    if not row:
                        print("%-12s not run" % name)
                        continue
                    print("%-12s %s" % (name, "ok" if row.get("ok") else "FAIL"))
                    if not row.get("ok"):
                        print(json.dumps(row.get("evidence") or {}, indent=2)[:4000])
                    clauses = (row.get("evidence") or {}).get("clauses") or {}
                    for label, value in clauses.items():
                        mark = "ok " if value is True else ("-- " if value is None else "RED")
                        print("   %s %s" % (mark, label))
            if args.hold:
                time.sleep(args.hold)
            elif args.live and headed:
                # THE SESSION ENDS WHEN THE READER CLOSES THE WINDOW, not after a guess at how
                # long someone wants to use a desktop. `--hold` still overrides it for a scripted
                # run that wants a bounded one.
                print("waiting - close the browser window to finish")
                browser.wait()
        return 0
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
