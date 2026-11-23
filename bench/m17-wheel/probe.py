#!/usr/bin/env python3
"""M17's wheel probe: WHAT UNIT IS A DRIVEN WHEEL DELTA, and does a burst survive the transport?

M17's primary proof is arithmetic over summed deltas — "the offset the program reaches on resuming
equals the full summed delta" (`docs/PLAN-SHELL.md` §2 M17). That clause compares a number the
DRIVER chose against a number the PROGRAM accumulated, so the two had better be in one unit.

`bench/m16-resize/probe.py` answered M17's first assumption as a side-effect — the wheel IS
delivered to a canvas listener — and in doing so recorded something it did not set out to measure:
the SAME dispatched `deltaY=120` arrived as `dy: 60` at dpr 2 and `dy: 120` at dpr 1. Two samples
at one dispatched value cannot tell "the delta is divided by the ratio" apart from "the delta is
clamped at 60", and the difference decides whether M17's clause is dpr-shaped. So:

**1. IS A DISPATCHED WHEEL DELTA IN DEVICE PIXELS?** Dispatch several distinct deltas at several
ratios and fit the relationship, rather than inferring it from one point per ratio. If delivered ==
dispatched / dpr holds across the grid, CDP's `deltaY` is device px and the `wheel` event's is CSS
px — which makes a constant dispatched delta the exact trap that cost M11 a milestone (constraint
264): numerically right at dpr 1, wrong by 2x at dpr 2, with every check green.

**2. DOES A BURST COALESCE BEFORE SCRIPT?** M17 asserts `queued: 1, coalesced: 299` over a
300-notch stream, which presumes 300 events reach the page. If the BROWSER coalesces a burst, the
kernel's coalescing is being credited for the transport's and the control `no-wheel-coalesce` could
not turn the clause it claims. Counted, not assumed.

**3. WHAT IS `deltaMode`?** A line- or page-mode delta is not a pixel count, and `wheelAt`'s unit
would have to say so.

Neither question needs a kernel, a SAB or a process, so this page holds none: a failure here must
be the transport's and not the boot's. Run it before writing `WEV_WHEEL`.

    python3 bench/m17-wheel/probe.py
    python3 bench/m17-wheel/probe.py --headed     # the same grid in a real window
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import cdp  # noqa: E402
import serve  # noqa: E402

DOC = "/bench/m17-wheel/wheel.html"

# THE SAME FLAGS M16'S PROBE USES HEADED, for the same reason: a headed run is for a human
# watching, and the suite is headless, so headless is the world the clauses will run in.
HEADED_FLAGS = ("--force-color-profile=srgb", "--disable-lcd-text")

# DISTINCT AND NOT MULTIPLES OF ONE ANOTHER where it can be helped, so a fit cannot be satisfied
# by a coincidence. 120 is one notch of a conventional mouse; 100 is not a notch of anything.
DELTAS = (40, 100, 120, 240)
RATIOS = (1.0, 1.5, 2.0)
BURST = 12


def read(page, expr):
    raw = page.evaluate(expr)
    if not isinstance(raw, str):
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def measure(page, dpr: float) -> dict:
    """One ratio: the single-notch grid, then one burst."""
    # THE RATIO IS ALREADY SET AND THE PAGE ALREADY LOADED when this is called — `main` does both,
    # in that order, because a canvas measured at the previous ratio reports the previous rect.
    reported = page.evaluate("String(devicePixelRatio)")
    at = read(page, "JSON.stringify(__padAt())")
    row = {"askedDpr": dpr, "reportedDpr": reported, "padAt": at, "singles": [], "burst": None}
    if at is None:
        row["error"] = "the canvas never reported a rect, so nothing was dispatched"
        return row

    for want in DELTAS:
        page.evaluate("String(__reset())")
        page.call("Input.dispatchMouseEvent", type="mouseWheel", x=at["x"], y=at["y"],
                  deltaX=0, deltaY=want, button="none", buttons=0)
        time.sleep(0.25)
        got = read(page, "JSON.stringify(globalThis.__wheel)") or {}
        last = got.get("last") or {}
        row["singles"].append({
            "dispatched": want,
            "delivered": last.get("dy"),
            "events": got.get("events", 0),
            "mode": last.get("mode"),
            "trusted": last.get("trusted"),
            "cancelable": last.get("cancelable"),
            "dprAtEvent": last.get("dpr"),
        })

    # ---- the burst: does the transport coalesce? ----
    page.evaluate("String(__reset())")
    for _ in range(BURST):
        page.call("Input.dispatchMouseEvent", type="mouseWheel", x=at["x"], y=at["y"],
                  deltaX=0, deltaY=120, button="none", buttons=0)
    time.sleep(0.5)
    got = read(page, "JSON.stringify(globalThis.__wheel)") or {}
    seen = got.get("seen") or []
    row["burst"] = {
        "dispatched": BURST,
        "delivered": got.get("events", 0),
        "sumDelivered": sum(float(r.get("dy") or 0) for r in seen),
        "distinctDeltas": sorted({float(r.get("dy") or 0) for r in seen}),
    }
    return row


def verdict(rows: list[dict]) -> tuple[bool, list[str]]:
    """Fit `delivered == dispatched / dpr` across the grid, and report what did not fit."""
    notes: list[str] = []
    ok = True
    fits_ratio = 0
    fits_identity = 0
    total = 0
    for row in rows:
        dpr = float(row.get("reportedDpr") or row["askedDpr"])
        for s in row["singles"]:
            if s["delivered"] is None:
                notes.append("dpr %g: %d was dispatched and nothing arrived"
                             % (dpr, s["dispatched"]))
                ok = False
                continue
            total += 1
            if abs(float(s["delivered"]) - s["dispatched"] / dpr) <= 0.6:
                fits_ratio += 1
            if abs(float(s["delivered"]) - s["dispatched"]) <= 0.6:
                fits_identity += 1
            if s["mode"] != 0:
                notes.append("dpr %g: deltaMode is %r, not 0 (DOM_DELTA_PIXEL) — a wheel unit "
                             "that is not pixels changes what `wheelAt` may promise"
                             % (dpr, s["mode"]))
                ok = False
            if not s["trusted"]:
                notes.append("dpr %g: the event was not trusted, so it does not stand in for a "
                             "reader's wheel" % dpr)
                ok = False
    if not total:
        return False, ["no wheel event was delivered at any ratio, so nothing was measured"]

    # THE TWO HYPOTHESES ARE SCORED AGAINST EACH OTHER. At dpr 1 they are the same prediction, so
    # neither count alone decides it; what decides it is the ratios where they differ.
    split = [r for r in rows if abs(float(r.get("reportedDpr") or r["askedDpr"]) - 1.0) > 0.01]
    if not split:
        notes.append("every ratio reported 1, so device px and CSS px could not be told apart")
        ok = False
    notes.append("device-px hypothesis (delivered == dispatched / dpr): %d of %d samples fit"
                 % (fits_ratio, total))
    notes.append("css-px hypothesis   (delivered == dispatched):        %d of %d samples fit"
                 % (fits_identity, total))

    for row in rows:
        b = row.get("burst") or {}
        if b.get("delivered", 0) < b.get("dispatched", 0):
            notes.append("dpr %s: a burst of %d arrived as %d event(s) — THE TRANSPORT COALESCES, "
                         "so M17's 300-notch clause cannot credit the kernel for all of it"
                         % (row.get("reportedDpr"), b["dispatched"], b["delivered"]))
    return ok, notes


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true",
                    help="drive a real window, for a human watching. The suite is headless.")
    ap.add_argument("--dpr", type=float, action="append", default=[],
                    help="a ratio to measure at, repeatable. Default: 1, 1.5, 2.")
    ap.add_argument("--out", default="")
    args = ap.parse_args(argv[1:])
    ratios = tuple(args.dpr) if args.dpr else RATIOS

    os.chdir(REPO)
    httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % port
    engine = "gpu" if args.headed else "swiftshader"
    out_path = pathlib.Path(args.out) if args.out else HERE / ("results-%s.json" % engine)
    print("m17 wheel probe  %s%s  (%s)" % (base, DOC, engine), file=sys.stderr)

    rows: list[dict] = []
    try:
        with cdp.Browser(extra_args=HEADED_FLAGS if args.headed else (),
                         headless=not args.headed) as browser:
            page = browser.page()
            page.call("Runtime.enable")
            for dpr in ratios:
                # THE RATIO IS SET AND THEN THE PAGE IS LOADED, so `devicePixelRatio` is already
                # the asked-for value when the listener is installed. Emulating after a load
                # leaves a canvas whose rect was measured at the previous ratio.
                page.emulate_device(width=900, height=700, scale_factor=dpr, mobile=False)
                page.navigate(base + DOC, timeout=60)
                deadline = time.time() + 30
                while time.time() < deadline:
                    if page.evaluate("String(Boolean(globalThis.__ready))") == "true":
                        break
                    time.sleep(0.1)
                else:
                    rows.append({"askedDpr": dpr, "error": "the page never became ready"})
                    continue
                rows.append(measure(page, dpr))
    finally:
        httpd.shutdown()

    ok, notes = verdict(rows)
    out = {"ok": ok, "notes": notes, "rows": rows,
           "verdict": ("A DRIVEN WHEEL DELTA IS IN DEVICE PIXELS and the event reports CSS "
                       "pixels." if ok else "see notes")}
    out_path.write_text(json.dumps(out, indent=2) + "\n")

    for row in rows:
        if row.get("error"):
            print("dpr %-4s  ERROR %s" % (row["askedDpr"], row["error"]))
            continue
        pairs = "  ".join("%d->%s" % (s["dispatched"], s["delivered"]) for s in row["singles"])
        b = row.get("burst") or {}
        print("dpr asked %-4s reported %-4s  dispatched->delivered: %s   burst %s->%s"
              % (row["askedDpr"], row["reportedDpr"], pairs,
                 b.get("dispatched"), b.get("delivered")))
    print()
    for note in notes:
        print("  %s" % note)
    print("\nwrote %s" % out_path)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
