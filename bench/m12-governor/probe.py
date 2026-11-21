#!/usr/bin/env python3
"""M12's owed experiment: WHAT DOES THE BLUR BUDGET ACTUALLY BIND ON — AREA, OR FILTER PASSES?

    python3 bench/m12-governor/probe.py --headed     # the only honest way to run it
    python3 bench/m12-governor/probe.py              # headless, and it says why that is not a number

Two things make this the first thing M12 does, before a line of the governor is written.

**1. The gate `PLAN.md` §5 and constraint 49 specify cannot fire.** Both size M12's kill gate at
"52 glass terminals at 640×440 (53.7 M device px)". That figure is BOX accounting — one filtered
node per window. M11 shipped the ring: four filtered strips whose border boxes sum to 27,260 CSS
px² per window, so 52 of them are **5.7 M device px, 10% of the measured wall**. Reaching 58 M
needs ~532 windows of 640×440 or ~273 maximized ones, against `WIN_CAP` 32 per process. A gate that
needs 532 windows is a gate that cannot fail — which is the EXACT defect constraint 49 was itself
corrected for once already (`docs/DECISIONS.md` §Corrections: the 4× dpr error that made the Aero
gate structurally green). Twice is a pattern, and the pattern is sizing a gate from an arithmetic
rather than from a run.

**2. gap-04 never separated area from pass count.** Its conclusion — "the predictor is area, not
layer count: 60 windows at 35 M is free" — varied both together. The ring geometry pays FOUR
filtered boxes per window where gap-04's paid one, so 52 windows is 208 passes, past anything
measured (`MILESTONES.md` M11 records this as owed). If passes cost, the thing that binds is not
area and the governor must account something else.

So this sweeps the two axes INDEPENDENTLY:

    axis A   area up, passes fixed at 4 per frame       mode=ring,  n sweeps
    axis B   passes up, TOTAL AREA HELD FIXED           mode=strips:N, N sweeps
    control  the same geometries with the blur off      must stay flat, or the metric is blind
    control  a 20 ms main-thread burn per frame         must collapse, or the metric cannot fail

HEADED, OR IT IS NOT A MEASUREMENT. `scripts/check.py` drives `--headless=new` with `--disable-gpu`
and SwiftShader; a frame time from there is a number about a software rasteriser wearing the name of
a number about Aero. gap-04's whole Aero budget was taken in a headed window at 120 Hz. Run without
`--headed` and every row is labelled `swiftshader` and the verdict refuses to draw a conclusion.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import statistics
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import cdp          # noqa: E402
import serve        # noqa: E402

DOC = "/bench/m12-governor/page.html"

#: gap-04's measured wall, in blurred device px per frame, and its measured floor for "holding
#: 120 Hz". Constraint 36. Quoted here so a row can be read against the figure it is testing.
WALL_DEVICE_PX = 58e6
#: `PLAN.md` §5's own acceptance figure for M12: frame rate holds at or above this.
FPS_FLOOR = 110.0


#: The flags a HEADED run needs to produce frames at all. Chrome throttles `requestAnimationFrame`
#: in a window it believes is occluded or backgrounded, and a CDP-launched window on macOS is not
#: foregrounded — measured: every row timed out with the page still in its warmup phase. Without
#: these the sweep reports nothing; with them it reports frames.
HEADED_FLAGS = (
    "--window-size=1440,900",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
    "--autoplay-policy=no-user-gesture-required",
)


def run_one(page, query: str, settle: float = 40.0) -> dict:
    page.navigate(page.base_url + DOC + query, timeout=60)
    deadline = time.time() + settle
    last = {}
    while time.time() < deadline:
        state = page.evaluate(
            "String((globalThis.M12 && globalThis.M12.state) || '')")
        if state == "done":
            return page.evaluate("JSON.stringify(globalThis.M12)")
        time.sleep(0.1)
    # NAMED, never an empty return: a page stuck in `warmup` has a different cause from one that
    # never built, and the difference is the whole of why the first headed run reported nothing.
    last = page.evaluate(
        "JSON.stringify({state: String((globalThis.M12||{}).state||''), "
        "samples: (globalThis.M12||{}).samples ?? null, "
        "frames: (globalThis.M12||{}).frames ?? null})")
    return "STALLED " + str(last)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true",
                    help="drive a real window; without it no row is a number about Aero")
    ap.add_argument("--dpr", type=float, default=2.0,
                    help="gap-04's Aero figures are all at dpr 2")
    ap.add_argument("--window-ms", type=int, default=2000)
    ap.add_argument("--quick", action="store_true", help="a short sweep, for a smoke run")
    #: NAMED BY ENGINE, because the two runs are not comparable and a single filename invites
    #: quoting a SwiftShader frame time as an Aero one. `docs/CONSTRAINTS.md` 266 cites the
    #: headless file for its pass-count RATIOS and says so.
    ap.add_argument("--out", default="")
    args = ap.parse_args(argv[1:])

    # AXIS A: area up, four passes per frame — the geometry that shipped.
    area_ns = [1, 16, 52] if args.quick else [1, 16, 52, 120, 260, 400, 532]
    # AXIS B: passes up at FIXED total area. One frame's worth of ring area, carved finer and
    # finer, times a fixed frame count — so the device px filtered stays put and only the number
    # of filtered boxes moves.
    pass_parts = [1, 4] if args.quick else [1, 2, 4, 8, 16, 32]
    pass_frames = 52

    os.chdir(REPO)
    httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % port
    engine = "gpu" if args.headed else "swiftshader"
    out_path = pathlib.Path(args.out) if args.out else HERE / ("results-%s.json" % engine)
    print("governor sweep  %s%s  (%s, dpr %g)" % (base, DOC, engine, args.dpr), file=sys.stderr)

    rows: list[dict] = []
    try:
        with cdp.Browser(extra_args=HEADED_FLAGS if args.headed else (),
                         headless=not args.headed) as browser:
            page = browser.page()
            page.base_url = base
            page.emulate_device(width=1280, height=800, scale_factor=args.dpr, mobile=False)

            def measure(label: str, query: str) -> None:
                got = run_one(page, query + "&window_ms=%d" % args.window_ms)
                if not got or got.startswith("STALLED"):
                    rows.append({"label": label, "query": query, "ok": False,
                                 "why": "the page never reached state done: %s" % got})
                    print("  %-22s TIMED OUT %s" % (label, got), file=sys.stderr)
                    return
                r = json.loads(got)
                r["label"] = label
                r["ok"] = True
                r["engine"] = engine
                rows.append(r)
                print("  %-22s %6.1f M dev px  %4d passes  %6.1f fps  (p95 %.1f ms)"
                      % (label, r["filteredDevicePx"] / 1e6, r["passes"], r["fps"],
                         r["p95Ms"]), file=sys.stderr)

            # ---- axis A: area, at four passes per frame ----------------------------------
            for n in area_ns:
                measure("ring n=%d" % n, "?mode=ring&n=%d" % n)
            # The same areas as ONE node per frame, which is gap-04's geometry and the control
            # that shows this harness reproduces its measured ~51-window wall.
            for n in ([1, 16, 52] if args.quick else [1, 16, 30, 52, 60]):
                measure("box n=%d" % n, "?mode=box&n=%d" % n)

            # ---- axis B: passes, at fixed total area -------------------------------------
            for parts in pass_parts:
                measure("strips:%d n=%d" % (parts, pass_frames),
                        "?mode=strips:%d&n=%d" % (parts, pass_frames))

            # ---- the two controls --------------------------------------------------------
            # Blur off at the heaviest geometry: must be flat, or the metric is not reading blur.
            measure("no-blur ring n=%d" % area_ns[-1],
                    "?mode=ring&n=%d&no_blur=1" % area_ns[-1])
            measure("no-blur box n=52", "?mode=box&n=52&no_blur=1")
            # A 20 ms main-thread burn, which gap-04 measured at 49.3 fps: proof the metric can
            # fail at all.
            measure("stall 20ms ring n=16", "?mode=ring&n=16&stall_ms=20")
    except cdp.CDPError as error:
        print(json.dumps({"ok": False, "why": str(error)}, indent=2))
        return 3
    finally:
        httpd.shutdown()
        httpd.server_close()

    ok = [r for r in rows if r.get("ok")]
    by = {r["label"]: r for r in ok}

    def fps(label):
        return by[label]["fps"] if label in by else None

    # ---- the verdict, derived rather than asserted ------------------------------------------
    ring_rows = [r for r in ok if r["label"].startswith("ring n=")]
    box_rows = [r for r in ok if r["label"].startswith("box n=")]
    strip_rows = [r for r in ok if r["label"].startswith("strips:")]

    def first_below(series, floor=FPS_FLOOR):
        """The first row whose frame rate fell below the floor, or None."""
        for r in sorted(series, key=lambda x: x["filteredDevicePx"]):
            if r["fps"] < floor:
                return r
        return None

    ring_wall = first_below(ring_rows)
    box_wall = first_below(box_rows)
    # Axis B's question: at FIXED area, does multiplying the pass count cost anything?
    strip_spread = None
    if len(strip_rows) >= 2:
        areas = {round(r["filteredDevicePx"]) for r in strip_rows}
        best = max(r["fps"] for r in strip_rows)
        worst = min(r["fps"] for r in strip_rows)
        strip_spread = {
            "areasHeldFixed": len(areas) == 1,
            "areaDevicePx": sorted(areas),
            "passes": {r["passes"]: r["fps"] for r in strip_rows},
            "bestFps": best, "worstFps": worst,
            "costOfPasses": round(best - worst, 1),
        }

    verdict = {
        "engine": engine,
        "honest": args.headed,
        "dpr": args.dpr,
        # Does this harness reproduce gap-04's own finding? If the box geometry does NOT wall near
        # 51 windows, nothing else here is trustworthy and the sweep says so rather than concluding.
        "reproducesGap04BoxWall": bool(box_wall) and 30 <= box_wall["frames"] <= 60,
        "boxWallAt": {"frames": box_wall["frames"], "deviceMpx": round(
            box_wall["filteredDevicePx"] / 1e6, 1), "fps": box_wall["fps"]} if box_wall else None,
        "ringWallAt": {"frames": ring_wall["frames"], "deviceMpx": round(
            ring_wall["filteredDevicePx"] / 1e6, 1), "fps": ring_wall["fps"],
            "passes": ring_wall["passes"]} if ring_wall else None,
        "ringNeverWalled": ring_wall is None,
        "passAxis": strip_spread,
        # BOTH OF THESE READ A CONTROL, so both must say when the control did not RUN. `all()`
        # over an empty generator is True, so a sweep whose blur-off rows both timed out used to
        # report "the metric is reading the blur" with no frame measured at all.
        "noBlurRows": len([r for r in ok if r["label"].startswith("no-blur")]),
        "noBlurFlat": (
            len([r for r in ok if r["label"].startswith("no-blur")]) >= 1
            and all(r["fps"] >= FPS_FLOOR
                    for r in ok if r["label"].startswith("no-blur"))),
        # `is None` and not `or`: a measured 0.0 fps is falsy, and a total collapse is the most
        # convincing result this row can produce — `or 999` reported it as "did not fire".
        "stallFired": (lambda v: v is not None and v < FPS_FLOOR)(
            fps("stall 20ms ring n=16")),
    }
    # What it means for the gate, stated in the gate's own terms.
    if not args.headed:
        verdict["M12"] = ("SwiftShader: no row here is a number about Aero. Re-run with --headed "
                          "before concluding anything.")
    elif not verdict["reproducesGap04BoxWall"]:
        verdict["M12"] = ("this harness did not reproduce gap-04's measured box wall near 51 "
                          "windows, so its ring result cannot be trusted either. Read `rows`.")
    elif verdict["ringNeverWalled"]:
        verdict["M12"] = (
            "AREA IS NOT A REACHABLE LIMIT UNDER RING GLASS. The box geometry walls where gap-04 "
            "said it does and the ring geometry does not wall at any geometry this swept, so "
            "constraint 49's 52-window gate cannot fire against what M11 shipped and an "
            "area-triggered governor would be dead code. What binds has to come from `passAxis`.")
    else:
        verdict["M12"] = (
            "the ring geometry DOES wall, at %d frames / %.1f M device px / %d passes — so an "
            "area-accounted governor is live, and constraint 49's gate must be re-sized to that "
            "figure rather than to 52." % (ring_wall["frames"],
                                           ring_wall["filteredDevicePx"] / 1e6,
                                           ring_wall["passes"]))

    out = {"ok": True, "verdict": verdict, "rows": rows}
    out_path.write_text(json.dumps(out, indent=2))
    print(json.dumps({"ok": True, "verdict": verdict, "results": str(out_path)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
