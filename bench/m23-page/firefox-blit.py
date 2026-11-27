#!/usr/bin/env python3
"""DOES A `DL_BLIT` PUT PIXELS ON SCREEN IN FIREFOX? The second engine, on the bare URL.

    python3 bench/m23-page/firefox-blit.py
    python3 bench/m23-page/firefox-blit.py --headed
    python3 bench/m23-page/firefox-blit.py --prove-failure

WHY THIS FILE EXISTS. CLAUDE.md makes a second engine a condition of reporting a milestone done and
records the bill for skipping it: M4a shipped a window that could not be dragged in Firefox, M6
shipped a policy under which no process started there, M11 and M12 each failed on an engine whose
feature was fine because a geometry was derived from a constant measured at dpr 2, and M17's bare
URL threw in both engines while the `?proofs=1` suite stayed green. Five milestones, every Chrome
expectation green each time, every one found by a human opening the page.

WHAT MAKES THE BLIT THE LIKELIEST REPEAT. A payload's extent is `min(cell, imagePx) * dpr`, so at
dpr 2 the logo's thumbnail is 32 device px square and at dpr 1 it is 16 — and Firefox renders at
dpr 1 on this machine (constraint 264). THE RATIO IS ALSO WHERE THE ASSERTION WOULD HIDE: at dpr 1
the decode is 1:1 and every destination pixel is a source pixel, so a renderer that scaled a
payload, or a page that assumed an extent, is right here and wrong in Chrome. This gate therefore
asserts nothing about the extent as a NUMBER; it asserts that the pixels on screen are the payload's
own, whatever extent this engine's ratio produced.

IT ASSERTS WITH THE PAGE'S OWN FUNCTION AND NOT A COPY. `M23.blitReadback(title)` pairs every
`DL_BLIT`'s destination with the payload pixel that must be there and reads the canvas back through
`Surface.pixel`. A script here with its own copy of "where the payload is and what colour it should
be" is a script asserting the wrong pixel the first time `thumbFit` changes — which is the drift
CLAUDE.md's `FILES_METRICS` row exists to stop.

WHAT IS ASSERTED, all on the BARE URL, which is the product (constraint 283):

  1. the desktop reaches `phase: live` with no thrown module — M17's bill restated;
  2. `m23blit`'s window is surfaced, its batch holds two `DL_BLIT` ops, the renderer drew BOTH and
     counted ZERO unbacked;
  3. every sampled pixel of both payloads reads back EXACTLY the colour the payload holds there;
  4. `files` in Large icons decoded this engine's ratio's payloads and drew them, with every
     sampled pixel exact — the same reading on the product's own path.

`--prove-failure` loads the same URL with `?no_payloads=1`, which drops the payload map inside the
renderer: clauses 2 through 4 MUST report red and clause 1 MUST hold, because a window that opens
and draws nothing is exactly the picture this gate exists to tell apart. It exits 0 when the proof
SUCCEEDED; non-zero is reserved for a proof that failed.
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

import bidi   # noqa: E402  (the path has to be set up first)
import serve  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent

#: The two windows the live desktop opens that blit. Named by a substring of their titles, which is
#: what `blitReadback` takes.
WINDOWS = ("m23blit", "files")


def wait_live(fx, timeout: float) -> dict:
    """Wait for the desktop to be staged, and hand back what the page says about itself."""
    read = ("JSON.stringify({state: String(globalThis.M23.state || ''),"
            " phase: String(globalThis.M23.phase || ''), why: String(globalThis.M23.why || ''),"
            " dpr: globalThis.M23.dpr || window.devicePixelRatio,"
            " notes: globalThis.M23.notes || []})")
    deadline = time.monotonic() + timeout
    row = {}
    while time.monotonic() < deadline:
        row = fx.evaluate(read) or {}
        if row.get("phase") == "live" or row.get("state") in ("error", "aborted"):
            return row
        time.sleep(0.1)
    return row


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--prove-failure", action="store_true",
                    help="load ?no_payloads=1: clauses 2-4 MUST go red and clause 1 MUST hold")
    ap.add_argument("--timeout", type=float, default=120.0)
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--out", default=str(HERE / "results-firefox.json"))
    args = ap.parse_args(argv)

    if bidi.find_firefox() is None:
        print("no Firefox on this machine; nothing was measured")
        return 3

    os.chdir(REPO)
    httpd = serve.Server(("127.0.0.1", args.port), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    url = "http://127.0.0.1:%d/www/m23.html" % port
    if args.prove_failure:
        url += "?no_payloads=1"
    print("url      %s" % url)

    clauses = {}
    report = {"url": url, "proveFailure": args.prove_failure, "windows": {}}
    with bidi.Firefox(headless=not args.headed) as fx:
        fx.navigate(url)
        row = wait_live(fx, args.timeout)
        report["page"] = row
        print("dpr      %s" % row.get("dpr"))
        print("phase    %s  state %s" % (row.get("phase"), row.get("state")))
        if row.get("why"):
            print("why      %s" % row["why"])
        clauses["theDesktopReachedLiveWithNoThrownModule"] = (
            row.get("phase") == "live" and not row.get("why"))

        for title in WINDOWS:
            seen = fx.evaluate("JSON.stringify(globalThis.M23.batchOf(%s))" % json.dumps(title))
            back = fx.evaluate("JSON.stringify(globalThis.M23.blitReadback(%s))"
                               % json.dumps(title))
            report["windows"][title] = {"batch": seen, "readback": back}
            surface = (seen or {}).get("surface") or {}
            blits = (seen or {}).get("blits") or []
            rows = back if isinstance(back, list) else []
            exact = [r for r in rows if r.get("read") and r.get("read") == r.get("want")]
            unbacked = [r for r in rows if r.get("unbacked")]
            print("%-9s %d blit op(s), renderer drew %s with %s unbacked, %d/%d pixel(s) exact"
                  % (title, len(blits), surface.get("blits"), surface.get("blitsUnbacked"),
                     len(exact), len(rows)))
            clauses["%sDrewEveryBlitItWasSent" % title] = (
                len(blits) > 0 and surface.get("blits") == len(blits)
                and surface.get("blitsUnbacked") == 0 and not unbacked)
            clauses["%sPixelsAreItsPayloadsOwn" % title] = (
                len(rows) > 0 and len(exact) == len(rows))

    print()
    for name, ok in clauses.items():
        print("   %s %s" % ("ok " if ok else "BAD", name))
    report["clauses"] = clauses
    pathlib.Path(args.out).write_text(json.dumps(report, indent=1), encoding="utf-8")
    print("wrote    %s" % args.out)

    red = sorted(n for n, ok in clauses.items() if not ok)
    if args.prove_failure:
        # THE NAMED SUBSET, AND NOTHING ELSE: a window that failed to open would turn every clause
        # and prove nothing about the payload channel.
        want = sorted(n for n in clauses if n != "theDesktopReachedLiveWithNoThrownModule")
        if red != want:
            print("PROOF    MISMATCH: expected %s red, got %s" % (want, red))
            return 1
        print("PROOF    the %d payload clause(s) went red and the desktop still staged" % len(want))
        return 0
    if red:
        print("FAILED   %s" % ", ".join(red))
        return 1
    print("PASSED   %d clause(s)" % len(clauses))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
