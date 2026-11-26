#!/usr/bin/env python3
"""M19'S PAGE HALF, DRIVEN IN A REAL BROWSER: a hover, a leave, and a cursor.

THREE THINGS `src/wm/winhost.mjs` NOW OWES A PROGRAM, and none of them is visible to a check that
reads a screenshot:

1. A BUTTONLESS MOVE IS A `WEV_POINTER`. `if (!e.buttons) return;` was the one line making the
   hover case `src/abi.mjs` documents unreachable, and the overflow it was there to prevent was
   measured to be the APPEND's and not the hover's (`bench/m19-hover/probe.py`, constraint 223).
2. A `pointerleave` IS A `WPTR_LEAVE`. Without it the last hover a window ever gets is the one
   nearest its edge, so a lit row stays lit for ever.
3. A `win-cursor` IS RENDERED FROM `WCUR_CSS` AND NOTHING ELSE (constraint 226), on the window's
   CLIENT AREA rather than on its canvas — a canvas is replaced on every resize to a new size, so
   a cursor written there is lost by the next resize with nothing reporting it.

WHY BOTH ENGINES. Driving Chrome only has cost this project five milestones, and a hover is exactly
the shape that hides: the record is delivered by DOM hit-testing, so it is the engine's boundary
events that decide whether a program hears anything. Firefox runs at dpr 1 here, where a unit error
is numerically invisible — and this gate asserts COUNTS, which is what makes one answer serve both.

WHY THE GEOMETRY MUST SETTLE FIRST, and it is not decoration. Measured: a sweep started while the
live desktop was still placing frames read 10 hovers and 2 LEAVES from 12 moves that never left the
client box — the frame moved out from under a stationary pointer, which is a real leave and not the
one being counted. `pointerleave` is NOT fired by removing the element under the pointer (measured
in Chrome 158: a node removed under a stationary pointer fires nothing), so a resurface emits no
spurious leave and the host needs no suppression for one. The settle is for the MOVE, not the swap.

WHAT THIS CANNOT YET DRIVE: no program calls `win_set(WIN_SET_CURSOR)`, so the cursor clause enters
through `WinHost.handle` with the message `WinMgr.setCursor` posts — `{t: 'win-cursor', win, cursor}`
(`src/kernel/wins.mjs`). When a program sets a cursor of its own, point this clause at that instead:
a message this file composes proves the renderer and not the syscall.
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

import bidi  # noqa: E402
import cdp  # noqa: E402
import serve  # noqa: E402

#: The live desktop, because it is the page that publishes its host to a driver that is not itself
#: (`globalThis.M17.host`) — the same handle `bench/m17-wheel/firefox-scroll.py` drives.
DOC = "/www/m17.html"

#: WCUR_CROSSHAIR and its keyword. Read from the ABI rather than written here, so a renamed keyword
#: fails this gate instead of passing it. `scripts/` is on the path, `src/` is not, so the value is
#: pulled out of the module text the browser is about to load.
CURSOR_VALUE = 3

#: How long the frames get to stop moving. The live page boots a kernel, spawns programs and prints
#: a log that pushes the layout down; a pointer aimed before that is aimed where the window is not.
SETTLE_S = 6.0

STATE = """JSON.stringify((() => {
  const M = globalThis.M17 || {}
  const host = M.host
  const out = {state: String(M.state || ''), why: String(M.why || ''), dpr: devicePixelRatio,
               errors: (M.errors || []).map(String).slice(0, 4), win: 0, wins: []}
  if (!host) return out
  for (const e of host.frames.values()) {
    out.wins.push({id: e.id, title: e.win.titleText, surfaced: !!e.surface})
    if (e.surface && !out.win) out.win = e.id
  }
  return out
})())"""

STATS = """JSON.stringify((() => {
  const s = globalThis.M17.host.stats
  return {pointers: s.pointers, hovers: s.hovers, leaves: s.leaves, dragAts: s.dragAts,
          cursors: s.cursors, unknown: s.unknown, resurfaces: s.resurfaces, geoms: s.geoms}
})())"""


def box_of(win: int) -> str:
    """The client box in CSS px, with the frame raised so DOM hit-testing reaches its canvas."""
    return """JSON.stringify((() => {
      const e = globalThis.M17.host.get(%d)
      e.win.el.style.zIndex = '9000'
      const r = e.win.bodyEl.getBoundingClientRect()
      return {x: r.x, y: r.y, w: r.width, h: r.height}
    })())""" % win


def cursor_probe(win: int, value: int) -> str:
    """Render one cursor, then one with no row, and report what the frame actually shows.

    `computed` is read off the CANVAS and the style is written on the BODY, which is the assertion
    that matters: `cursor` inherits, so a reader's pointer over the pixels a process drew shows the
    cursor the kernel set without the canvas carrying it.
    """
    return """JSON.stringify((() => {
      const h = globalThis.M17.host
      const e = h.get(%d)
      h.handle({t: 'win-cursor', win: %d, cursor: %d})
      const out = {css: e.win.bodyEl.style.cursor, data: e.win.el.dataset.cursor, entry: e.cursor,
                   computed: getComputedStyle(e.surface.el).cursor, cursors: h.stats.cursors}
      const u = h.stats.unknown
      h.handle({t: 'win-cursor', win: %d, cursor: 99})
      out.afterBadCss = e.win.bodyEl.style.cursor
      out.afterBadEntry = e.cursor
      out.unknownRose = h.stats.unknown - u
      out.cursorsAfterBad = h.stats.cursors
      return out
    })())""" % (win, win, value, win)


def keyword_for(value: int) -> str:
    """The CSS keyword the ABI publishes for a `WCUR_*`, out of `src/abi.mjs`'s own table.

    A LITERAL HERE WOULD BE A SECOND COPY of the one map the page is forbidden to restate, so this
    reads the array out of the module and fails loudly rather than asserting against a guess.
    """
    text = (REPO / "src/abi.mjs").read_text(encoding="utf-8")
    needle = "export const WCUR_CSS = Object.freeze(["
    at = text.find(needle)
    if at < 0:
        raise SystemExit("src/abi.mjs no longer declares `export const WCUR_CSS = Object.freeze([`,"
                         " so this gate cannot name the keyword it is asserting. Read the table "
                         "beside its new declaration rather than writing the keyword here.")
    end = text.find("])", at)
    names = [part.strip().strip('"') for part in text[at + len(needle):end].split(",")]
    names = [n for n in names if n]
    if not (0 <= value < len(names)):
        raise SystemExit("WCUR_CSS publishes %d keyword(s) and this gate asks for index %d"
                         % (len(names), value))
    return names[value]


class Chrome:
    """A CDP page behind the two calls this gate makes of a browser."""

    def __init__(self, page) -> None:
        self.page = page

    def evaluate(self, expression: str):
        got = self.page.evaluate(expression, await_promise=True)
        return got if isinstance(got, dict) else json.loads(got)

    def move(self, x: float, y: float) -> None:
        # `button="none"` with `buttons=0` IS the hover: no button bit, which is what the removed
        # guard refused. A dispatch with a button would be a drag sample and would assert nothing.
        self.page.call("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y,
                       button="none", buttons=0)


class Fox:
    """A BiDi page behind the same two calls. Its events carry `isTrusted === true`."""

    def __init__(self, ff) -> None:
        self.ff = ff

    def evaluate(self, expression: str):
        got = self.ff.evaluate(expression)
        return got if isinstance(got, dict) else json.loads(got)

    def move(self, x: float, y: float) -> None:
        self.ff.move(x, y)


def run(drv, moves: int, outside: bool, keyword: str) -> dict:
    """Stage, drive, and return the row this engine contributes."""
    row: dict = {"moves": moves, "outside": outside, "clauses": {}, "bad": [], "state": "broken"}
    deadline = time.monotonic() + 90
    state: dict = {}
    while time.monotonic() < deadline:
        state = drv.evaluate(STATE)
        if state.get("win"):
            break
        time.sleep(0.5)
    row["staging"] = state
    if not state.get("win"):
        row["why"] = ("no window with a surface appeared on the live desktop, so there was nothing "
                      "to hover over. state=%r why=%r" % (state.get("state"), state.get("why")))
        return row
    win = int(state["win"])
    time.sleep(SETTLE_S)
    box = drv.evaluate(box_of(win))
    row["win"] = win
    row["box"] = box
    before = drv.evaluate(STATS)
    if before.get("geoms") is None:
        row["why"] = "the host publishes no `geoms`, so a mid-stream relayout cannot be excluded"
        return row

    if outside:
        # THE CONTROL: the same count of moves, aimed BELOW the client box at the bare desktop.
        aim = (4.0, box["y"] + box["h"] + 60.0)
    else:
        aim = (box["x"] + 30.0, box["y"] + 30.0)
    for i in range(moves):
        drv.move(aim[0] + i, aim[1] + i)
    time.sleep(0.6)
    mid = drv.evaluate(STATS)
    # ...AND THEN ONE MOVE FAR OUTSIDE, which is the leave.
    drv.move(3, 3)
    time.sleep(0.6)
    after = drv.evaluate(STATS)
    cur = drv.evaluate(cursor_probe(win, CURSOR_VALUE))
    row["before"], row["mid"], row["after"], row["cursor"] = before, mid, after, cur
    row["state"] = "staged"

    hovers = mid["hovers"] - before["hovers"]
    leaves_mid = mid["leaves"] - before["leaves"]
    leaves = after["leaves"] - mid["leaves"]
    row["clauses"] = {
        # A1. Every buttonless move became a record. A count and not "more than zero": a stream
        # that lost samples at the page is a stream the kernel's coalescing is credited for.
        "hover-delivered": hovers == moves,
        # A2. And none of them was reported as a drag position. `#dragMove` must not see a sample
        # with no button, or a hover would post a `drag-at` for a gesture nobody started.
        "hover-is-not-a-drag": (mid["dragAts"] - before["dragAts"]) == 0,
        # A3. The frames did not move under the pointer, so A1 is about the pointer and not about
        # a relayout that carried the window away from it.
        "geometry-quiet": (after["geoms"] - before["geoms"]) == 0 and leaves_mid == 0,
        # A4. ONE leave for one exit, not one per sample.
        "leave-delivered": leaves == 1,
        # A5. The cursor the kernel set is what the pixels show, and the body is what carries it.
        "cursor-rendered": (cur["css"] == keyword and cur["computed"] == keyword
                            and cur["data"] == str(CURSOR_VALUE)
                            and cur["entry"] == CURSOR_VALUE and cur["cursors"] >= 1),
        # A6. A value with no row in `WCUR_CSS` changes nothing and is COUNTED. `style.cursor =
        # undefined` is a silent no-op, so an unguarded index leaves the frame showing a cursor
        # nothing asked for and reports success.
        "cursor-refused": (cur["afterBadCss"] == keyword and cur["afterBadEntry"] == CURSOR_VALUE
                           and cur["unknownRose"] == 1
                           and cur["cursorsAfterBad"] == cur["cursors"]),
    }
    if outside:
        # The control moves A1, A4 and nothing else: the cursor is a message and not a pointer, so
        # it must still render with the pointer parked off the window.
        row["clauses"] = {k: v for k, v in row["clauses"].items()
                          if k in ("hover-delivered", "leave-delivered", "cursor-rendered",
                                   "cursor-refused")}
        row["hovers"], row["leaves"] = hovers, leaves
    return row


def drive_once(engine: str, url: str, args, keyword: str) -> dict:
    """One browser, one navigation, one row. The browser is closed before the row is judged."""
    if engine == "chrome":
        with cdp.Browser(headless=not args.headed) as browser:
            page = browser.page()
            page.call("Runtime.enable")
            page.navigate(url)
            return run(Chrome(page), args.moves, args.prove_failure, keyword)
    with bidi.Firefox(headless=not args.headed, width=1280, height=820) as ff:
        ff.navigate(url)
        return run(Fox(ff), args.moves, args.prove_failure, keyword)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--engine", action="append", default=[], choices=("chrome", "firefox"),
                    help="repeatable; both by default")
    ap.add_argument("--moves", type=int, default=20)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--root", default="",
                    help="serve this tree instead of the repository, for driving a patched copy")
    ap.add_argument("--prove-failure", action="store_true",
                    help="aim the SAME stream below the client box. No hover and no leave may "
                         "arrive, which is what makes the counts above about the pointer. Exits 0 "
                         "when the proof succeeded.")
    ap.add_argument("--out", default="")
    args = ap.parse_args(argv)
    engines = args.engine or ["chrome", "firefox"]
    keyword = keyword_for(CURSOR_VALUE)

    root = pathlib.Path(args.root).resolve() if args.root else REPO
    os.chdir(root)
    httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d%s" % (httpd.server_address[1], DOC)
    print("url      %s   root=%s" % (url, root))
    print("cursor   WCUR_CSS[%d] = %r, read out of src/abi.mjs" % (CURSOR_VALUE, keyword))
    if args.prove_failure:
        print("control  --prove-failure: the stream is aimed BELOW the client box")

    rows: dict[str, dict] = {}
    try:
        for engine in engines:
            # A FRESH BROWSER PER ENGINE, AND ONE RETRY THAT IS RECORDED. Measured once on this
            # gate: Chrome's channel went away mid-run with `connection closed mid-frame`, which is
            # a lost renderer and not a verdict. The retry is bounded at one and `attempts` goes in
            # the row, so a flake is reported rather than hidden — `bench/m19-hover/probe.py`'s
            # arrangement, for its reason.
            for attempt in (1, 2):
                try:
                    rows[engine] = drive_once(engine, url, args, keyword)
                except Exception as error:  # noqa: BLE001 - recorded, never discarded
                    rows[engine] = {"state": "broken", "attempts": attempt, "clauses": {},
                                    "why": "%s: %s" % (type(error).__name__, error)}
                rows[engine]["attempts"] = attempt
                if rows[engine].get("state") == "staged":
                    break
                print("    %s attempt %d: %s" % (engine, attempt, rows[engine].get("why")))
            row = rows[engine]
            if row["state"] != "staged":
                print("  %-8s BROKEN  %s" % (engine, row.get("why")))
                continue
            d = row["mid"]
            print("  %-8s win=%d  hovers=%d  leaves=%d  dragAts=%d  cursor=%r/%r"
                  % (engine, row["win"], d["hovers"] - row["before"]["hovers"],
                     row["after"]["leaves"] - d["leaves"],
                     d["dragAts"] - row["before"]["dragAts"],
                     row["cursor"]["css"], row["cursor"]["computed"]))
            for name, ok in row["clauses"].items():
                print("      %-22s %s" % (name, "ok" if ok else "BAD"))
    finally:
        httpd.shutdown()

    out = {"url": url, "root": str(root), "moves": args.moves, "keyword": keyword,
           "proveFailure": args.prove_failure, "rows": rows}
    out_path = pathlib.Path(args.out) if args.out else HERE / (
        "results-prove-failure.json" if args.prove_failure else "results.json")
    out_path.write_text(json.dumps(out, indent=2) + "\n")
    print("wrote %s" % out_path)

    broken = [e for e, r in rows.items() if r["state"] != "staged"]
    if broken:
        # A HARNESS THAT CANNOT REACH ITS SUBJECT FAILS. Reporting clean over a desktop with no
        # window is the worst outcome available (CLAUDE.md, Harness honesty).
        print("BROKEN in %s: nothing was measured, so nothing is proved." % ", ".join(broken))
        return 1

    if args.prove_failure:
        moved = {e: (r["hovers"], r["leaves"]) for e, r in rows.items()
                 if r["hovers"] or r["leaves"]}
        if moved:
            print("--prove-failure: THE CONTROL MOVED. %s delivered a record from a pointer that "
                  "was never over the client box." % json.dumps(moved))
            return 1
        # The two message clauses MUST still hold: a cursor is not a pointer.
        held = all(r["clauses"]["cursor-rendered"] and r["clauses"]["cursor-refused"]
                   for r in rows.values())
        if not held:
            print("--prove-failure: the cursor clauses moved with the pointer, so they are not "
                  "about the message route they claim to be about.")
            return 1
        print("--prove-failure: %d moves outside the client box delivered 0 hovers and 0 leaves "
              "in %s, and the cursor still rendered. The counts are about the pointer."
              % (args.moves, ", ".join(rows)))
        return 0

    bad = [(e, n) for e, r in rows.items() for n, ok in r["clauses"].items() if not ok]
    if bad:
        for engine, name in bad:
            print("BAD  %s: %s" % (engine, name))
        return 1
    print("%d engine(s), %d clause(s) each, all green."
          % (len(rows), len(next(iter(rows.values()))["clauses"])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
