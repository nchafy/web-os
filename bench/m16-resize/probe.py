#!/usr/bin/env python3
"""M16's owed probe, and it answers THREE unretired measurement assumptions before any clause
rests on one.

    python3 bench/m16-resize/probe.py              # the suite's own world: headless, both ratios
    python3 bench/m16-resize/probe.py --headed      # ...in a real window
    python3 bench/m16-resize/probe.py --dpr 2       # one ratio only

**1. CAN A RESIZE GRIP BE DRIVEN AT ALL?** Nothing in this project had ever driven one:
`grep -rn grip scripts bench www` returned nothing before this file. A grip takes a POINTER
CAPTURE on the grip element and then runs the gesture on `document` listeners
(`src/wm/window.mjs`), and `setPointerCapture` MAY THROW for a pointerId no live pointer owns
(constraint 175). Whether `Input.dispatchMouseEvent` reaches that path was unmeasured, and M16's
whole proof is built on it: if it cannot be driven, R1's geometry clause survives through
`WIN_SET_BOX` and R2's mid-drag clauses move to Firefox over `scripts/bidi.py`.

**2. CAN THE SUITE BE DRIVEN AT A CHOSEN DEVICE-PIXEL RATIO?** Every registered size clause runs at
one ratio, and M16's defect is ratio-shaped: at dpr 1 a CSS-px box handed to `win_surface` is
numerically right, so the unit error is INVISIBLE. M11 and M12 each cost a milestone to a figure
measured at one ratio (constraint 264). `scripts/check.py` sets `deviceScaleFactor` through
`Emulation.setDeviceMetricsOverride`, so the question is whether `devicePixelRatio`, a canvas's
backing store and a frame's layout all follow it.

**3. DOES `Input.dispatchMouseEvent` type=mouseWheel REACH A `wheel` LISTENER ON A CANVAS?** That is
M17's A1, and `PLAN.md` §5 puts it in this probe rather than its own because answering it now is
free: `_perform_gesture` (`scripts/check.py`) performs no wheel and
`scripts/bidi.py` is pointer and key only, so if CDP cannot deliver one then R3 is unmeasurable in
the registered suite by construction and A1's delivery route changes.

**AND IT RE-DERIVES THE PRD's TABLE AT BOTH RATIOS**, which that table is owed: `docs/PRD-SHELL.md`
§1's figures were taken at dpr 1 on a dpr-2 reference machine, so they UNDERSTATE the defect by 2x
and the page that produced them is not committed. One row per surfaced window per ratio: the client
content box in CSS px, the backing store the program asked for, and the factor between them — which
is what a reader sees as half-size text.

**HEADLESS IS THE SUITE'S OWN WORLD, so a geometry figure from it is a figure about the thing the
suite will measure** — unlike `bench/m12-governor/probe.py`, whose frame times are about a
rasteriser and refuse to conclude without `--headed`. What THIS probe refuses to conclude is a
figure whose ratio was not the one it asked for: if `devicePixelRatio` does not come back as the
ratio requested, every row under that label is a row about another machine and the verdict says so
instead of reporting it (constraint 264).
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

import cdp     # noqa: E402
import serve   # noqa: E402

#: THE LIVE DESKTOP AND NOT THE PROOFS. `?proofs=1` stages fixtures and blocks in `gestureAsker`
#: waiting for a driver that speaks the gesture protocol; this probe drives raw input at rects it
#: measures itself, which is the question it is here to answer.
DOC = "/www/m16.html"

#: What a headed run needs to produce frames and events at all. Chrome throttles a window it
#: believes is occluded, and a CDP-launched window on macOS is not foregrounded.
HEADED_FLAGS = (
    "--window-size=1440,900",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
)

#: Every surfaced window, as the page can see it: the client CONTENT box in CSS px, the backing
#: store in device px, the canvas's own CSS box, what the client area would have to scroll, and
#: where this frame's SE grip is. `clientWidth`/`clientHeight` and not the bounding rect, because
#: the rect is the BORDER box and `.window-body` carries a 1 px `border-top` (PRD §2).
TABLE = """JSON.stringify((() => {
  const M = globalThis.M16 || {}
  const h = M.host
  if (!h) return null
  const rows = []
  for (const [id, e] of h.frames) {
    if (!e.surface) continue
    const b = e.win.bodyEl
    const r = e.surface.el.getBoundingClientRect()
    const g = e.win.el.querySelector('[data-grip="se"]')
    const gr = g ? g.getBoundingClientRect() : null
    const cx = gr ? Math.round(gr.left + gr.width / 2) : 0
    const cy = gr ? Math.round(gr.top + gr.height / 2) : 0
    const hit = gr ? document.elementFromPoint(cx, cy) : null
    rows.push({
      win: id,
      title: e.win.titleText,
      store: { w: e.surface.w, h: e.surface.h },
      client: { w: b.clientWidth, h: b.clientHeight },
      css: { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 },
      scroll: { w: b.scrollWidth, h: b.scrollHeight },
      box: { x: Math.round(e.win.placed.x), y: Math.round(e.win.placed.y),
             w: Math.round(e.win.placed.w), h: Math.round(e.win.placed.h) },
      grip: gr ? { x: cx, y: cy } : null,
      // WHAT THE BROWSER FINDS AT THE GRIP'S OWN CENTRE. A grip under another frame is a grip a
      // hand cannot use either, and the first run of this probe reported one as UNDRIVABLE for
      // exactly that reason — the terminal's own window was over it (`firefox-hover.py`'s
      // `reachable`, applied to a grip).
      gripReachable: Boolean(hit && hit.closest && hit.closest('[data-grip]') === g),
      gripHit: hit ? String(hit.className || hit.tagName) : null,
      // The canvas's own centre, in CLIENT coordinates. `placed` is in DESKTOP coordinates, and
      // the first version of this probe dispatched its wheel at those — into the page's log.
      canvasAt: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
      ops: e.surface.ops,
    })
  }
  return { dpr: window.devicePixelRatio || 1, phase: String(M.phase || ''),
           state: String(M.state || ''), why: String(M.why || ''),
           resurfaces: h.report().resurfaces, geomFrames: h.report().geomFrames, rows }
})())"""

#: A `wheel` listener on one window's canvas, installed from outside and counting. M17's question,
#: and the counter has to live in the page because a `wheel` event the page never saw is exactly
#: the answer "no".
WHEEL_ARM = """JSON.stringify((() => {
  const h = (globalThis.M16 || {}).host
  if (!h) return { armed: 0 }
  globalThis.__wheel = { events: 0, last: null }
  let armed = 0
  for (const [, e] of h.frames) {
    if (!e.surface) continue
    e.surface.el.addEventListener('wheel', (ev) => {
      globalThis.__wheel.events += 1
      globalThis.__wheel.last = { dx: ev.deltaX, dy: ev.deltaY, mode: ev.deltaMode,
                                  trusted: ev.isTrusted === true,
                                  cancelable: ev.cancelable === true }
    })
    armed += 1
  }
  return { armed }
})())"""


def wait_for(page, expr, want, timeout=90.0, step=0.25):
    """Poll an expression until it equals `want`. Returns whether it did."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if page.evaluate(expr) == want:
            return True
        time.sleep(step)
    return False


def read(page, expr):
    raw = page.evaluate(expr)
    return json.loads(raw) if raw else None


def drag(page, start, end, steps=10):
    """A real press, several moves and a release. SEVERAL MOVES: the resize gesture computes a
    delta per move, and one jump from press to release is what a synthesised drag looks like."""
    page.call("Input.dispatchMouseEvent", type="mousePressed", x=start["x"], y=start["y"],
              button="left", buttons=1, clickCount=1)
    for i in range(1, steps + 1):
        page.call("Input.dispatchMouseEvent", type="mouseMoved",
                  x=start["x"] + (end["x"] - start["x"]) * i // steps,
                  y=start["y"] + (end["y"] - start["y"]) * i // steps,
                  button="left", buttons=1)
    page.call("Input.dispatchMouseEvent", type="mouseReleased", x=end["x"], y=end["y"],
              button="left", buttons=0, clickCount=1)


def one_ratio(page, base: str, dpr: float) -> dict:
    """Everything this probe can learn at one device-pixel ratio."""
    page.emulate_device(width=1280, height=820, scale_factor=dpr, mobile=False)
    page.navigate(base + DOC, timeout=60)
    live = wait_for(page, "String((globalThis.M16 && globalThis.M16.phase) || '')", "live")
    table = read(page, TABLE)
    if not live or not table or not table["rows"]:
        return {"askedDpr": dpr, "ok": False,
                "why": "the live desktop never surfaced a window: %s"
                       % json.dumps(table)[:400]}

    out: dict = {"askedDpr": dpr, "ok": True, "reportedDpr": table["dpr"],
                 "ratioApplied": abs(table["dpr"] - dpr) < 1e-6,
                 "before": table["rows"]}

    # ---- 1. THE GRIP -----------------------------------------------------------------------
    subject = next((r for r in table["rows"] if "files" in r["title"]), table["rows"][0])
    # THE SUBJECT GOES TO THE TOP FIRST. A grip is 10 CSS px of a frame's corner and the kernel
    # owns the order (constraint 226), so this asks rather than restacking — and then re-measures,
    # because the rect and the hit test are both answers about the page after the raise.
    page.evaluate("(globalThis.M16.host.post({t:'win-raise',win:%d}), 1)" % subject["win"])
    time.sleep(0.3)
    table = read(page, TABLE) or table
    out["before"] = table["rows"]
    subject = next((r for r in table["rows"] if r["win"] == subject["win"]), subject)
    grip = subject["grip"]
    if not grip:
        out["grip"] = {"drivable": False, "why": "the frame has no [data-grip=se] element"}
        return out
    if not subject["gripReachable"]:
        out["grip"] = {"drivable": False, "at": grip, "hit": subject["gripHit"],
                       "why": "the browser finds %r at the grip's own centre, so no hand could "
                              "use it either" % subject["gripHit"]}
        return out
    want = {"x": grip["x"] + 180, "y": grip["y"] + 120}
    page.call("Input.dispatchMouseEvent", type="mousePressed", x=grip["x"], y=grip["y"],
              button="left", buttons=1, clickCount=1)
    # MID-GESTURE, because this is the one state that answers constraint 175: whether the capture
    # on the grip was taken, and what it said if it refused.
    mid = read(page, """JSON.stringify((() => {
      const h = (globalThis.M16 || {}).host
      for (const [, e] of h.frames) {
        if (e.win.resize) return { gesturing: true, captureError: e.win.resize.captureError || '',
                                   win: e.id }
      }
      return { gesturing: false }
    })())""")
    for i in range(1, 11):
        page.call("Input.dispatchMouseEvent", type="mouseMoved",
                  x=grip["x"] + (want["x"] - grip["x"]) * i // 10,
                  y=grip["y"] + (want["y"] - grip["y"]) * i // 10,
                  button="left", buttons=1)
    held = read(page, TABLE)
    page.call("Input.dispatchMouseEvent", type="mouseReleased", x=want["x"], y=want["y"],
              button="left", buttons=0, clickCount=1)
    time.sleep(0.4)
    after = read(page, TABLE)

    def row_for(table_, win):
        return next((r for r in (table_ or {}).get("rows", []) if r["win"] == win), None)

    held_row = row_for(held, subject["win"])
    after_row = row_for(after, subject["win"])
    out["grip"] = {
        "at": grip,
        "to": want,
        "gestureStarted": bool(mid and mid.get("gesturing")),
        # NAMED AND NOT ASSUMED EMPTY: Firefox throws here (constraint 175), and a Chrome that
        # started doing so would otherwise look like a grip that simply does not work.
        "captureError": (mid or {}).get("captureError", ""),
        "boxBefore": subject["box"],
        "boxHeld": held_row["box"] if held_row else None,
        "boxAfter": after_row["box"] if after_row else None,
        "drivable": bool(after_row and (after_row["box"]["w"] != subject["box"]["w"]
                                        or after_row["box"]["h"] != subject["box"]["h"])),
        # A2b's own question: did the kernel learn WHILE the button was down, or only on release?
        "grewMidGesture": bool(held_row and held_row["box"]["w"] > subject["box"]["w"]),
        "storeFollowed": bool(after_row and after_row["store"]["w"]
                              == round(after_row["client"]["w"] * table["dpr"])),
        "geomFrames": (after or {}).get("geomFrames"),
        "resurfaces": (after or {}).get("resurfaces"),
    }
    out["after"] = (after or {}).get("rows")

    # ---- 2. THE WHEEL (M17's A1) ------------------------------------------------------------
    armed = read(page, WHEEL_ARM)
    # THE CANVAS'S OWN CENTRE, IN CLIENT COORDINATES, re-read after the resize. A wheel dispatched
    # at `placed.x`/`placed.y` is dispatched at a DESKTOP coordinate, which lands on the page's log
    # — the first run of this probe reported 0 of 3 delivered for that reason and nothing else.
    after_subject = next((r for r in (after or {}).get("rows", [])
                          if r["win"] == subject["win"]), subject)
    canvas_at = after_subject["canvasAt"]
    for _ in range(3):
        page.call("Input.dispatchMouseEvent", type="mouseWheel", x=canvas_at["x"],
                  y=canvas_at["y"], deltaX=0, deltaY=120, button="none", buttons=0)
    time.sleep(0.3)
    got = read(page, "JSON.stringify(globalThis.__wheel || null)")
    out["wheel"] = {"armed": (armed or {}).get("armed", 0), "dispatched": 3,
                    "delivered": (got or {}).get("events", 0), "last": (got or {}).get("last"),
                    "at": canvas_at}
    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true",
                    help="drive a real window. The suite is headless, so headless is the world "
                         "its clauses will run in; this is for a human watching one.")
    ap.add_argument("--dpr", type=float, action="append", default=[],
                    help="a device-pixel ratio to measure at, repeatable. Default: 2 and 1.")
    ap.add_argument("--out", default="")
    args = ap.parse_args(argv[1:])
    ratios = args.dpr or [2.0, 1.0]

    os.chdir(REPO)
    httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % port
    engine = "gpu" if args.headed else "swiftshader"
    out_path = pathlib.Path(args.out) if args.out else HERE / ("results-%s.json" % engine)
    print("m16 resize probe  %s%s  (%s)" % (base, DOC, engine), file=sys.stderr)

    rows: list[dict] = []
    try:
        with cdp.Browser(extra_args=HEADED_FLAGS if args.headed else (),
                         headless=not args.headed) as browser:
            page = browser.page()
            page.call("Runtime.enable")
            page.call("Log.enable")
            page.call("Page.enable")
            for dpr in ratios:
                row = one_ratio(page, base, dpr)
                rows.append(row)
                if not row["ok"]:
                    print("  dpr %-4g FAILED  %s" % (dpr, row["why"]), file=sys.stderr)
                    continue
                g = row["grip"]
                print("  dpr %-4g reported %-4g  grip %s  box %s -> %s  wheel %d/%d"
                      % (dpr, row["reportedDpr"],
                         "DRIVABLE" if g["drivable"] else "NOT DRIVABLE",
                         g["boxBefore"], g["boxAfter"],
                         row["wheel"]["delivered"], row["wheel"]["dispatched"]),
                      file=sys.stderr)
                for r in row["before"]:
                    print("           %-28s client %4dx%-4d css %7.2fx%-7.2f store %4dx%-4d  "
                          "store/client %.2f"
                          % (r["title"][:28], r["client"]["w"], r["client"]["h"],
                             r["css"]["w"], r["css"]["h"], r["store"]["w"], r["store"]["h"],
                             (r["store"]["w"] / r["client"]["w"]) if r["client"]["w"] else 0),
                          file=sys.stderr)
    except cdp.CDPError as error:
        print(json.dumps({"ok": False, "why": str(error)}, indent=2))
        return 3
    finally:
        httpd.shutdown()
        httpd.server_close()

    measured = [r for r in rows if r.get("ok")]
    # THE RATIO IS CHECKED BEFORE ANYTHING IS CONCLUDED. A row whose `devicePixelRatio` is not the
    # one asked for is a row about another machine wearing this label, which is the exact failure
    # constraint 264 records twice.
    wrong_ratio = [r for r in measured if not r["ratioApplied"]]
    verdict = {
        "engine": engine,
        "ratiosAsked": ratios,
        "ratiosApplied": [r["reportedDpr"] for r in measured],
        "ratioEmulationWorks": bool(measured) and not wrong_ratio,
        "gripDrivable": all(r["grip"].get("drivable") for r in measured) if measured else False,
        "gripGrewMidGesture": all(r["grip"].get("grewMidGesture") for r in measured)
        if measured else False,
        "captureErrors": [r["grip"].get("captureError", "") for r in measured],
        "storeFollowedTheClientBox": all(r["grip"].get("storeFollowed") for r in measured)
        if measured else False,
        "wheelDelivered": all(r["wheel"]["delivered"] >= r["wheel"]["dispatched"]
                              for r in measured) if measured else False,
        # THE PRD's TABLE, RE-DERIVED: the factor between a program's backing store and its client
        # box, per ratio. 1.0 is a surface that followed; 0.5 at dpr 2 is the unit error as a
        # reader sees it, and the figure the PRD's dpr-1 table could not show.
        "storePerClientCssPx": {
            str(r["reportedDpr"]): sorted({
                round(w["store"]["w"] / w["client"]["w"], 3)
                for w in r["before"] if w["client"]["w"]})
            for r in measured},
    }
    if not measured:
        verdict["M16"] = ("nothing was measured: the live desktop never surfaced a window. Read "
                          "`rows`; this is not evidence about a grip.")
    elif wrong_ratio:
        verdict["M16"] = (
            "THE RATIO ASKED FOR WAS NOT THE RATIO RENDERED (%s), so no row here is a figure "
            "about the machine it is labelled with and the dpr axis of `check_m16` cannot rest "
            "on this run. Constraint 264." % ", ".join(
                "asked %g, got %g" % (r["askedDpr"], r["reportedDpr"]) for r in wrong_ratio))
    elif not verdict["gripDrivable"]:
        verdict["M16"] = (
            "A RESIZE GRIP IS NOT DRIVABLE over CDP: the gesture %s and the box did not move. "
            "M16's geometry clauses must be driven through `WIN_SET_BOX` instead, and the "
            "mid-drag clauses move to Firefox over `scripts/bidi.py`."
            % ("started" if measured[0]["grip"].get("gestureStarted") else "never started"))
    else:
        verdict["M16"] = (
            "A RESIZE GRIP IS DRIVABLE, the ratio is settable, and a program's backing store "
            "follows its client box in device px at %s. The wheel %s, which is M17's answer."
            % (", ".join("dpr %g" % r["reportedDpr"] for r in measured),
               "IS delivered to a canvas listener" if verdict["wheelDelivered"]
               else "is NOT delivered to a canvas listener"))

    out = {"ok": True, "verdict": verdict, "rows": rows}
    out_path.write_text(json.dumps(out, indent=2))
    print(json.dumps({"ok": True, "verdict": verdict, "results": str(out_path)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
