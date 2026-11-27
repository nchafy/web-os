#!/usr/bin/env python3
"""CAN A READER REACH M23'S EXPLORER SURFACE IN FIREFOX? Real trusted input in a second engine.

    python3 bench/m23-files/firefox-files.py
    python3 bench/m23-files/firefox-files.py --headed
    python3 bench/m23-files/firefox-files.py --prove-failure

WHY THIS FILE EXISTS. CLAUDE.md makes a second engine a condition of reporting a milestone done and
records the bill for skipping it: M4a shipped a window that could not be dragged in Firefox, M6
shipped a policy under which no process started there, and M11 and M12 each failed on an engine
whose feature was fine because a geometry was derived from a constant measured at dpr 2. Four
milestones, every Chrome expectation green each time, every one found by a human opening the page.
M17's bare URL was the fifth.

WHAT MAKES M23 THE LIKELIEST REPEAT OF THAT BILL. Everything this slice added is a CONTROL IN A
BAND, and two of its three bands are new:

  1. **The address strip's hit test is the only place a press means "navigate".** `crumbHit` is
     `crumbSegments`'s declared inverse and both run on CSS-px numbers, so a ratio error would
     send a press to the segment next door — and Firefox renders at dpr 1 here (constraint 264),
     where every device-px/CSS-px mistake collapses to multiplication by one and HIDES.
  2. **A breadcrumb segment's WIDTH is a measurement.** It is `label.length * TEXT_PX *
     MONO_ADVANCE_PER_PX`, and that constant was read out of `src/kernel/advance.mjs` — a table
     measured in CHROME. Its own header records the cross-engine worst case as 0.0208 px for
     anything but the space, so the segments should fit here too; this is the gate that says
     whether they do, rather than the note that says they ought to.
  3. **A thumbnail's payload extent is `min(cell, imagePx) * dpr`.** At dpr 2 the logo's is 32
     square and at dpr 1 it is 16, so a payload built from a constant is right in exactly one
     engine. That is the M11/M12/M16 shape, and this is where it would show.

WHAT IS ASSERTED, all of it read back out of the program's own account or the display list it drew:

  1. the window OPENS at all, with a surface and a batch in it — which is M6's bill restated;
  2. the breadcrumb is drawn, one segment per path component, and every segment's box FITS inside
     the strip's room (the advance-table question above);
  3. a trusted press on a segment NAVIGATES to the path THAT SEGMENT NAMED;
  4. a trusted press on the view button CHANGES THE VIEW MODE, which is the one pointer route to a
     mode a reader has (Ctrl+Shift+1..7 cannot reach a program: `bytesForKey` answers null for
     every Ctrl chord that is not a C0 letter);
  5. a trusted Ctrl+F and typed keys NARROW the listing, and the program says how many matched.

`--prove-failure` presses the EMPTY STRIP instead of a segment. That is a real gesture with a real
and different meaning — R28 says it opens the editable path — so the navigation clause MUST report
red while the window stays usable. It exits 0 when the proof SUCCEEDED.

IT DOES NOT ASSERT A PIXEL OF A THUMBNAIL, and the reason is not Firefox: the `DL_BLIT` payload
never reaches any page's renderer, because `WinMgr.draw` takes two parameters and `src/kernel/
calls.mjs` calls it with three. `bench/m23-files/probe.py`'s diagnosis carries the three lines.
What this gate asserts instead is the half that IS reachable — that the program made a payload of
the right extent FOR THIS ENGINE'S RATIO, which is the ratio-shaped half.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import bidi   # noqa: E402
import serve  # noqa: E402

#: The page, the directory, and the mode. The same three `bench/m23-files/probe.py` drives, so a
#: disagreement between the engines is a disagreement about the engine and not about the fixture.
DOC = "/bench/m23-files/page.html"
SUBJECT_DIR = "/Users/Default/share"
VIEW = "medium"

#: Everything this gate can see of the one `files` window, in CSS px — which is the unit BiDi's
#: pointer actions take, so no conversion happens anywhere in this file.
STATE = """JSON.stringify((() => {
  const M = globalThis.M23F || {}
  const e = M.entry
  if (!e || !e.surface) {
    return { ready: false, phase: String(M.phase || ''), state: String(M.state || ''),
             why: String(M.why || '') }
  }
  const r = e.surface.el.getBoundingClientRect()
  const F = M.metrics
  const wCss = e.win.bodyEl.clientWidth
  const segs = F.crumbSegments(e.win.titleText.split(' \\u2014 ')[1] || '', wCss)
  return {
    ready: true,
    phase: String(M.phase || ''),
    dpr: window.devicePixelRatio || 1,
    title: e.win.titleText,
    clientW: wCss,
    scale: e.surface.w / e.surface.extent().cssW,
    store: { w: e.surface.w, h: e.surface.h },
    surface: e.surface.report(),
    // THE STRIP'S OWN ROOM, from the program's exported constants rather than from a number here.
    stripRoom: wCss - F.SEARCH_W - F.VIEWBTN_W - F.CRUMB_PAD,
    crumbs: segs.map((s) => ({ label: s.label, path: s.path,
      x: Math.round(r.left + s.x + s.w / 2), y: Math.round(r.top + F.CRUMB_MID),
      right: s.x + s.w })),
    // The empty strip, past the last segment: `--prove-failure`'s target.
    emptyAt: segs.length ? { x: Math.round(r.left + segs[segs.length - 1].x
                                           + segs[segs.length - 1].w + F.CRUMB_PAD * 2),
                             y: Math.round(r.top + F.CRUMB_MID) } : null,
    viewAt: { x: Math.round(r.left + wCss - F.VIEWBTN_W / 2), y: Math.round(r.top + F.CRUMB_MID) },
    centre: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
    // WHAT A READER CAN SEE, which is the only live route to the program's state: its account
    // travels at exit. The search field's text and the sort strip's label are both in here.
    runs: (M.runsNow || (() => []))(),
  }
})())"""


def read(fx, expr):
    """`bidi.Firefox.evaluate` ALREADY PARSES a JSON string, which `scripts/cdp.py`'s does not —
    so a second `json.loads` here raised `TypeError: the JSON object must be str ... not dict` on
    the first call. One helper, so the asymmetry between the two drivers is written down once."""
    return fx.evaluate(expr)


def wait_ready(fx, timeout=90.0, step=0.3):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = read(fx, STATE)
        if last and last.get("ready") and last.get("phase") == "live":
            return last
        time.sleep(step)
    return last


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--prove-failure", action="store_true",
                    help="press the EMPTY STRIP instead of a segment. The navigation clause MUST "
                         "report red; exits 0 when the proof succeeded.")
    ap.add_argument("--out", default="")
    args = ap.parse_args(argv[1:])

    os.chdir(REPO)
    httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % port
    url = "%s%s?dir=%s&argv=--view%%20%s" % (base, DOC, SUBJECT_DIR, VIEW)
    out_path = pathlib.Path(args.out) if args.out else HERE / "results-firefox.json"
    print("m23 files, Firefox: %s" % url, file=sys.stderr)

    clauses: dict = {}
    ev: dict = {"url": url, "proveFailure": args.prove_failure}
    try:
        with bidi.Firefox(headless=not args.headed) as fx:
            fx.navigate(url)
            start = wait_ready(fx)
            ev["start"] = start
            if not start or not start.get("ready"):
                ev["why"] = ("the window never surfaced in Firefox: %s"
                             % json.dumps(start)[:400])
                clauses["the window opened with a surface and a batch"] = False
                raise SystemExit(_report(out_path, ev, clauses, args.prove_failure))
            clauses["the window opened with a surface and a batch"] = (
                (start["surface"].get("ops") or 0) > 0)
            # 2. THE TRAIL, AND EVERY SEGMENT'S BOX INSIDE THE STRIP'S ROOM.
            segs = start["crumbs"]
            clauses["the breadcrumb has a segment per path component"] = len(segs) >= 3
            clauses["and every segment's box fits the strip's room"] = bool(segs) and all(
                s["right"] <= start["stripRoom"] for s in segs)

            # 3. A SEGMENT PRESS NAVIGATES — or, under the control, the EMPTY STRIP does not.
            target = (start["emptyAt"] if args.prove_failure
                      else {"x": segs[-2]["x"], "y": segs[-2]["y"]})
            wanted = segs[-2]["path"]
            ev["pressed"] = {"at": target, "wanted": wanted,
                             "what": "the empty strip" if args.prove_failure else segs[-2]["label"]}
            fx.click(target["x"], target["y"])
            time.sleep(1.0)
            after = read(fx, STATE)
            ev["afterPress"] = after
            # THE DIRECTORY IS COMPARED EXACTLY AND NOT AS A SUBSTRING, which is a fix and not a
            # tidy. `wanted` is `/Users/Default` and the window OPENS on `/Users/Default/share`, so
            # `wanted in title` is satisfied by a press that navigated NOWHERE — measured: the
            # `--prove-failure` half pressed the empty strip and this clause stayed green. The
            # title's own form is `files — <dir>` and `relist` is its only writer.
            got = str((after or {}).get("title") or "").split(" — ")
            ev["titleDir"] = got[1] if len(got) > 1 else ""
            clauses["a trusted press on a segment navigated to the path it named"] = (
                ev["titleDir"] == wanted)
            # AND THE CONTROL'S OWN SIDE EFFECT IS UNDONE BEFORE THE REST RUNS. Pressing the empty
            # strip opens the editable PATH field (R28), and an open field takes the whole keyboard
            # — so the Ctrl+F below would be swallowed and two clauses this control does not claim
            # would turn with it. Measured: the first run reported exactly that and the gate refused
            # it as unscoped.
            if args.prove_failure:
                fx.press("Escape")
                time.sleep(0.4)
                after = read(fx, STATE)
                ev["afterEscape"] = after

            # 4. THE VIEW BUTTON.
            before_ops = (after or start)["surface"].get("ops") or 0
            fx.click((after or start)["viewAt"]["x"], (after or start)["viewAt"]["y"])
            time.sleep(0.9)
            viewed = read(fx, STATE)
            ev["afterViewButton"] = viewed
            clauses["a trusted press on the view button repainted the window"] = bool(
                viewed and (viewed["surface"].get("ops") or 0) > before_ops)

            # 5. CTRL+F AND TYPED KEYS.
            fx.click((viewed or start)["centre"]["x"], (viewed or start)["centre"]["y"])
            time.sleep(0.3)
            fx.press("f", ctrl=True)
            time.sleep(0.4)
            fx.type_keys("o")
            time.sleep(0.8)
            searched = read(fx, STATE)
            ev["afterSearch"] = searched
            # THE NARROWING IS ASSERTED LIVE AND NOT FROM THE ACCOUNT, and that is a measurement
            # rather than a preference. The account travels at EXIT, and Esc clears the query on
            # the way out — so `matched` and `listed` are both 4 by the time the row arrives, and a
            # clause reading them would be red over a filter that worked. What a READER sees is the
            # status strip's own sentence, `"o" — 0 of 4 here`, which is the program's statement of
            # the narrowing at the moment it happened. `searches` is the second reading and IS
            # cumulative.
            said = next((t for t in ((searched or {}).get("runs") or [])
                         if t.startswith('"o"') and " here" in t), "")
            ev["searchSaid"] = said
            narrowed = re.match(r'^"o" \u2014 (\d+) of (\d+) here$', said)
            clauses["a trusted Ctrl+F and typed keys narrowed the listing"] = bool(
                narrowed and int(narrowed.group(1)) < int(narrowed.group(2)))

            # THE PAGE QUITS THE PROGRAM, NOT THIS GATE. It is blocked in `until(() => driven)` and
            # types the `q` itself once released; a `q` typed here as well would be one typed into
            # whatever has the keyboard, and the first run of this gate waited 40 s for a result row
            # the page had not yet asked for.
            fx.press("Escape")
            time.sleep(0.3)
            fx.evaluate("(globalThis.M23F.driven = true, 1)")
            deadline = time.time() + 45
            row = None
            while time.time() < deadline:
                row = read(fx, "JSON.stringify((globalThis.M23F || {}).row || null)")
                if row:
                    break
                time.sleep(0.4)
            ev["row"] = row
            t = (row or {}).get("thumbs") or {}
            clauses["and the program counted the narrowing"] = (
                (row or {}).get("searches", 0) >= 1)
            # THE RATIO-SHAPED HALF, which is the whole reason this engine is driven: the payload's
            # extent is `min(cell, imagePx) * dpr`, so at Firefox's dpr 1 the logo's payload is 16
            # square where Chrome's at dpr 2 is 32. A constant would be right in one engine only.
            made = t.get("made") or []
            want = int(min(VIEW_CELL_CSS, LOGO_PX) * (start.get("dpr") or 1))
            ev["payloads"] = made
            ev["wantedSide"] = want
            clauses["a payload was made at THIS engine's ratio"] = bool(made) and all(
                m["w"] == want and m["h"] == want for m in made)
            if args.headed:
                fx.screenshot(HERE / "firefox-files.png")
    except bidi.BidiError as error:
        ev["why"] = "Firefox could not be driven: %s" % error
        print(json.dumps({"ok": False, **ev}, indent=2))
        return 3
    finally:
        httpd.shutdown()
        httpd.server_close()

    return _report(out_path, ev, clauses, args.prove_failure)


#: The Medium cell, CSS px — restated from `VIEWS` in `src/bin/files.mjs` with its source named,
#: because a Python module cannot import an `.mjs`. The page reads the real table; a drift here
#: makes the ratio clause assert the wrong square and says so by failing.
VIEW_CELL_CSS = 48
#: `logo.png` and `logo.rgba` are both 16x16 (`src/share/readme.txt`, and the header of the `.rgba`).
LOGO_PX = 16

#: THE CONTROL'S NAMED SUBSET. `--prove-failure` presses the empty strip, which R28 says opens the
#: editable path — so the NAVIGATION clause must turn and nothing else may. A control satisfied by
#: any failure verifies nothing (CLAUDE.md).
CONTROL_SUBJECT = ("a trusted press on a segment navigated to the path it named",)


def _report(out_path, ev, clauses, prove_failure):
    failed = [k for k, v in clauses.items() if not v]
    if prove_failure:
        turned = [k for k in CONTROL_SUBJECT if k in clauses and not clauses[k]]
        others = [k for k in failed if k not in CONTROL_SUBJECT]
        ok = len(turned) == len([k for k in CONTROL_SUBJECT if k in clauses]) and not others
        why = ("--prove-failure pressed the empty strip: %d of %d named clause(s) turned and %d "
               "other clause(s) also went red%s"
               % (len(turned), len(CONTROL_SUBJECT), len(others),
                  (" (" + ", ".join(others) + ") — the control is NOT scoped and must be "
                   "rescoped") if others else ""))
    else:
        ok = not failed
        why = ("all %d clause(s) green in Firefox" % len(clauses)) if ok else (
            "%d of %d red: %s" % (len(failed), len(clauses), ", ".join(failed)))
    out = {"ok": ok, "why": why, "clauses": clauses, "evidence": ev}
    out_path.write_text(json.dumps(out, indent=2))
    print(json.dumps({"ok": ok, "why": why, "clauses": clauses, "results": str(out_path)},
                     indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
