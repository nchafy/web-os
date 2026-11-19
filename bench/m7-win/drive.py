#!/usr/bin/env python3
"""Open `www/m7.html` in a real Chrome, type the keys it waits for, and print what it reported.

    python3 bench/m7-win/drive.py                  # the five proofs
    python3 bench/m7-win/drive.py --live           # the desktop only, left open
    python3 bench/m7-win/drive.py --query win_first_fd=1

THE FAST LOOP FOR A WINDOW MILESTONE. `scripts/check.py --only m7` is the gate and asserts labels;
this prints the page's own log and its evidence, which is what a defect is diagnosed from. It is
NOT a check: it scores nothing and asserts nothing, and it says so in its exit code — 0 whenever
the page reached a terminal state, whatever that state was.
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

import cdp  # noqa: E402  (the path has to be set up first)

READY = ("(() => { const M = globalThis.%(g)s || {}; const s = M.state; "
         "if (s === 'done' || s === 'aborted' || s === 'error') return s; "
         "return M.phase === 'await-keys' ? 'await-keys' : '' })()")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--live", action="store_true", help="open the desktop only, and leave it open")
    ap.add_argument("--query", action="append", default=[], help="k=v, repeatable")
    ap.add_argument("--hold", type=float, default=0.0,
                    help="seconds to leave the browser open at the end")
    ap.add_argument("--port", type=int, default=8711)
    ap.add_argument("--page", default="m7", help="which www/<page>.html to drive")
    ap.add_argument("--keys", default="a", help="what to type when the page asks for keys")
    args = ap.parse_args(argv)

    server = subprocess.Popen(
        [sys.executable, str(REPO / "scripts" / "serve.py"), "--port", str(args.port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=str(REPO))
    try:
        time.sleep(0.7)
        query = list(args.query)
        if args.live:
            query.append("live=1")
        glob = args.page.upper()
        ready = READY % {"g": glob}
        url = "http://127.0.0.1:%d/www/%s.html" % (args.port, args.page)
        if query:
            url += "?" + "&".join(query)
        print("url      %s" % url)
        with cdp.Browser() as browser:
            page = browser.page()
            page.navigate(url)
            deadline = time.time() + 300
            state = ""
            typed = False
            while time.time() < deadline:
                state = page.evaluate(ready) or ""
                if state == "await-keys" and not typed:
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
        return 0
    finally:
        server.terminate()


if __name__ == "__main__":
    raise SystemExit(main())
