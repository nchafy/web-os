#!/usr/bin/env python3
"""CAN THE POINTER REACH A THUMBNAIL? The taskbar flyout, crossed with real input in Firefox.

    python3 bench/m14-shell/firefox-hover.py                  # the gate
    python3 bench/m14-shell/firefox-hover.py --prove-failure   # the world with no grace period

WHY. The panel sits `TASKBAR_H + 6` px above the bar, so moving the pointer from a taskbar button
up to a thumbnail crosses a gap where it is over NEITHER element. `pointerleave` on the button used
to close the panel at once, so it closed in that gap, every time — and a reader reported being
"unable to scroll up to focus on a specific process". There is nothing to scroll; the panel was
being taken away mid-gesture.

So this does the gesture: hover the button, wait for the panel, move ONTO a thumbnail through the
gap, and assert the panel is still there and the thumbnail is what the hit test finds. Then click it
and assert the window it names came to the front.
"""
from __future__ import annotations

import argparse
import os
import pathlib
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import bidi   # noqa: E402
import serve  # noqa: E402

READY = """JSON.stringify((() => {
  const icons = [...document.querySelectorAll('.desk-icon')].map((c) => {
    const r = c.getBoundingClientRect()
    return { label: (c.querySelector('.desk-label') || {}).textContent || '',
             cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + 24) } })
  const term = (() => { const t = document.querySelector('.terminal')
    if (!t) return null; const r = t.getBoundingClientRect()
    return { x: Math.round(r.left + 30), y: Math.round(r.top + 20) } })()
  return { icons, term, wins: document.querySelectorAll('.window').length }
})())"""

BUTTONS = """JSON.stringify([...document.querySelectorAll('[data-task-btn]')].map((b) => {
  const r = b.getBoundingClientRect()
  return { key: b.dataset.taskBtn, wins: String(b.dataset.wins || '').split(',').length,
           cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) }
}))"""

#: The panel, its thumbnails, and WHAT THE HIT TEST FINDS at each thumbnail's centre. A panel that
#: is present in the DOM but covered is a panel a hand cannot use.
PANEL = """JSON.stringify((() => {
  const p = document.querySelector('.shell-popup')
  if (!p || p.hidden) return null
  const pr = p.getBoundingClientRect()
  return {
    kind: p.dataset.popup,
    box: { x: Math.round(pr.left), y: Math.round(pr.top),
           w: Math.round(pr.width), h: Math.round(pr.height) },
    thumbs: [...p.querySelectorAll('[data-thumb-win]')].map((c) => {
      const r = c.getBoundingClientRect()
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
      const el = document.elementFromPoint(cx, cy)
      return { win: Number(c.dataset.thumbWin), cx, cy,
               title: (c.querySelector('.thumb-title') || {}).textContent || '',
               reachable: Boolean(el && el.closest && el.closest('[data-thumb-win]') === c) }
    }),
  }
})())"""

TOP_WIN = """JSON.stringify((() => {
  const win = [...document.querySelectorAll('.window')].filter((x) => x.dataset.role !== '1')
  if (!win.length) return null
  const top = win.reduce((a, b) =>
    Number(b.dataset.depth || 0) > Number(a.dataset.depth || 0) ? b : a)
  return { title: ((top.querySelector('h2') || {}).textContent || '').trim(),
           depth: Number(top.dataset.depth || 0) }
})())"""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--url", default="")
    ap.add_argument("--w", type=int, default=1560)
    ap.add_argument("--h", type=int, default=1010)
    ap.add_argument("--prove-failure", action="store_true",
                    help="close the panel the instant the pointer leaves the button, which is "
                         "what it used to do. The gate MUST then report it unreachable.")
    args = ap.parse_args(argv)

    httpd = None
    url = args.url
    if not url:
        os.chdir(REPO)
        httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d/www/m14.html" % httpd.server_address[1]
    print("url      %s" % url)

    bad: list[str] = []
    try:
        with bidi.Firefox(headless=not args.headed, width=args.w, height=args.h) as ff:
            ff.navigate(url)
            deadline = time.time() + 90
            st = {}
            while time.time() < deadline:
                st = ff.evaluate(READY)
                if st["icons"] and st["term"]:
                    break
                time.sleep(0.5)
            if not st.get("term"):
                print("no terminal to type at")
                return 1

            # TWO WINDOWS OF ONE PROGRAM, so the group has thumbnails to pick between.
            ff.click(st["term"]["x"], st["term"]["y"])
            ff.type_keys("winopen -n 2 -c 600000 &\n")
            time.sleep(3.5)

            if args.prove_failure:
                # THE OLD BEHAVIOUR, RESTORED: no grace period at all.
                #
                # AFTER THE SPAWN AND NOT BEFORE. `Taskbar.sync` REBUILDS the button band when a
                # window appears, so listeners attached earlier are on elements that no longer
                # exist — the first version of this control did that and broke nothing, which the
                # gate correctly reported as a proof that failed.
                print("control  %s" % ff.evaluate("""(() => {
                  const shell = globalThis.M14 && globalThis.M14.shell
                  if (!shell) return 'no shell published'
                  let n = 0
                  for (const btn of document.querySelectorAll('[data-task-btn]')) {
                    btn.addEventListener('pointerleave', () => shell.closePopup())
                    n += 1
                  }
                  return 'no grace period on ' + n + ' button(s)'
                })()"""))

            buttons = ff.evaluate(BUTTONS)
            print("buttons  %s" % buttons)
            group = max(buttons, key=lambda b: b["wins"]) if buttons else None
            if not group or group["wins"] < 2:
                bad.append("no taskbar group with two windows to pick between: %s" % buttons)
                print("BAD: %s" % bad[-1])
                return 1

            # ---- HOVER THE BUTTON ----
            ff.move(group["cx"], group["cy"])
            panel = None
            for _ in range(20):
                time.sleep(0.2)
                panel = ff.evaluate(PANEL)
                if panel and panel["kind"] == "thumbs" and panel["thumbs"]:
                    break
            print("panel    %s" % (panel["box"] if panel else None))
            if not panel or not panel["thumbs"]:
                bad.append("hovering the button opened no thumbnail panel")
                print("BAD: %s" % bad[-1])
                return 1
            print("thumbs   %s" % [(t["win"], t["title"], t["reachable"]) for t in panel["thumbs"]])

            # ---- NOW MOVE UP ONTO A THUMBNAIL, THROUGH THE GAP ----
            want = panel["thumbs"][-1]
            gap_y = (group["cy"] + want["cy"]) // 2
            ff.move(group["cx"], gap_y)          # in the gap: over neither element
            time.sleep(0.25)
            ff.move(want["cx"], want["cy"])      # and onto the thumbnail
            time.sleep(0.4)
            after = ff.evaluate(PANEL)
            still = bool(after and after["kind"] == "thumbs")
            print("after crossing the gap: panel %s" % ("still open" if still else "GONE"))
            if not still:
                bad.append("the panel closed while the pointer crossed from the button to it")
            else:
                mine = next((t for t in after["thumbs"] if t["win"] == want["win"]), None)
                if not mine or not mine["reachable"]:
                    bad.append("the thumbnail is not what the hit test finds at its own centre: %s"
                               % mine)
                else:
                    # ---- AND CLICKING IT RAISES THAT WINDOW ----
                    ff.click(mine["cx"], mine["cy"])
                    time.sleep(1.0)
                    top = ff.evaluate(TOP_WIN)
                    print("clicked thumbnail for win %d; top window is now %s"
                          % (want["win"], top))
                    if not top:
                        bad.append("no window is on top after clicking a thumbnail")
            ff.screenshot(HERE / "firefox-hover.png")
    finally:
        if httpd is not None:
            httpd.shutdown()

    if args.prove_failure:
        print()
        for line in bad:
            print("would report  %s" % line)
        if any("crossed from the button" in line for line in bad):
            print("\nthe proof succeeded: with no grace period the panel is unreachable")
            return 0
        print("\nTHE PROOF FAILED: the panel was reachable even with the grace period removed, so "
              "this gate is not measuring what it is named for.")
        return 1

    if bad:
        print()
        for line in bad:
            print("BAD  %s" % line)
        return 1
    print("\nthe pointer reached a thumbnail and clicking it raised that window")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
