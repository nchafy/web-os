#!/usr/bin/env python3
"""CAN A READER OPEN ANYTHING? The desktop's launchers, driven with REAL input in FIREFOX.

    python3 bench/m14-shell/firefox-drive.py           # the gate
    python3 bench/m14-shell/firefox-drive.py --headed  # ...in a window you can watch
    python3 bench/m14-shell/firefox-drive.py --url http://127.0.0.1:8000/www/m14.html

WHY THIS FILE EXISTS, and it is the plainest reason in the repository: a reader opened the desktop
and said "I'm unable to open anything", twice. `scripts/check.py --only m14` was green both times,
57 expectations over nine proofs, every gesture a real pointer — in CHROME, on a page that stages
its own fixtures. None of its proofs asks the question a reader asks first, which is whether the
things on the desktop LAUNCH.

So this asks exactly that, in the engine they were using, through `scripts/bidi.py`:

  1. every desktop icon opens a window when it is double-clicked;
  2. the icons are STILL REACHABLE after one launch — `elementFromPoint` on each icon's own click
     point, because a window covering them is indistinguishable from a desktop that stopped
     working (constraint 289);
  3. a start-menu row for a CONSOLE program opens a terminal that RAN it — most of `/usr/bin`
     writes to stdout and owns no window, so those rows used to do nothing visible (290);
  4. two windows of one program do not land on the same pixel (291).

IT WAITS FOR THE LAYOUT TO SETTLE FIRST. The live page prints its banner after boot, the log grows
and the desktop is pushed down under it — measured, an icon at y=65 became y=249 — so an icon read
before that and clicked after is clicked where the icon is not. Two identical reads in a row is the
settle signal. A probe without it reported "nothing opened" for a desktop that was working.
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

STATE = """JSON.stringify((() => {
  const orb = document.querySelector('[data-start]')
  const box = (el) => { const r = el.getBoundingClientRect()
    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) } }
  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    verdict: (globalThis.M14 || {}).verdict || '',
    want: (globalThis.M14 || {}).want || null,
    windows: [...document.querySelectorAll('.window')].map((x) => ({
      title: ((x.querySelector('h2') || {}).textContent || '').trim(),
      role: Number(x.dataset.role || 0),
      x: Number(x.dataset.x), y: Number(x.dataset.y) })),
    icons: [...document.querySelectorAll('.desk-icon')].map((c) => {
      const r = c.getBoundingClientRect()
      return { label: (c.querySelector('.desk-label') || {}).textContent || '',
               cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + 24) } }),
    orb: orb ? box(orb) : null,
    popup: (() => { const p = document.querySelector('.shell-popup')
      return p && !p.hidden ? (p.dataset.popup || '') : '' })(),
    errors: ((globalThis.M14 || {}).errors || []).slice(0, 4),
  }
})())"""

#: WHAT IS UNDER EACH ICON'S OWN CLICK POINT. `elementFromPoint` and not a rectangle overlap: what
#: decides where a double-click lands is the hit test, and a bounding-box guess is not it.
UNDER = """JSON.stringify([...document.querySelectorAll('.desk-icon')].map((c) => {
  const r = c.getBoundingClientRect()
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + 24)
  const el = document.elementFromPoint(x, y)
  const icon = el && el.closest ? el.closest('.desk-icon') : null
  const frame = el && el.closest ? el.closest('.window') : null
  return {
    label: (c.querySelector('.desk-label') || {}).textContent || '',
    reachable: Boolean(icon) && icon === c,
    hits: icon ? 'its own icon'
          : frame ? 'window:' + ((frame.querySelector('h2') || {}).textContent || '').trim()
          : el ? String(el.className || el.tagName) : 'nothing',
  }
}))"""

#: A named start-menu row, scrolled into its list and hit-tested. The label carries the
#: "(in a terminal)" suffix for a console program, which is `src/bin/desktop.mjs`'s own wording.
ROW = """JSON.stringify((() => {
  const p = document.querySelector('.shell-popup')
  if (!p || p.hidden) return null
  const want = %s
  for (const row of p.querySelectorAll('.shell-row')) {
    const label = (row.querySelector('.shell-label') || {}).textContent || ''
    if (label !== want && label !== want + ' (in a terminal)') continue
    row.scrollIntoView({ block: 'nearest' })
    const b = row.getBoundingClientRect()
    const pr = p.getBoundingClientRect()
    if (b.top < pr.top || b.bottom > pr.bottom) return { label, clipped: true }
    const x = Math.round(b.left + 20), y = Math.round(b.top + b.height / 2)
    const el = document.elementFromPoint(x, y)
    return { label, x, y, hits: Boolean(el && el.closest && el.closest('.shell-row') === row) }
  }
  return null
})())"""

SCREENS = """JSON.stringify([...document.querySelectorAll('.terminal')].map(
  (t) => (t.textContent || '').slice(-400)))"""


def settle(ff, tries: int = 80) -> list:
    """Wait for the icon layout to stop moving. See the module docstring."""
    last, stable = None, 0
    for _ in range(tries):
        now = [(i["label"], i["cy"]) for i in ff.evaluate(STATE)["icons"]]
        stable = stable + 1 if now and now == last else 0
        last = now
        if stable >= 2:
            return last
        time.sleep(0.4)
    return last or []


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--url", default="", help="an already-running server; otherwise one is bound")
    ap.add_argument("--w", type=int, default=1560)
    ap.add_argument("--h", type=int, default=1010)
    ap.add_argument("--shot", default=str(HERE / "firefox-drive.png"))
    ap.add_argument("--prove-failure", action="store_true",
                    help="park a window on the icon column before the gate runs; the BURIED "
                         "assertion MUST then fire. A gate nobody has seen fail is a gate nobody "
                         "has checked (CLAUDE.md). Exits 0 when the proof SUCCEEDED.")
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
            icons = settle(ff)
            st = ff.evaluate(STATE)
            print("firefox  viewport %s" % st["viewport"])
            print("page     verdict=%r popup=%r" % (st["verdict"], st["popup"]))
            if st["want"]:
                bad.append("this is the PROOFS harness, not the desktop: it wants %s" % st["want"])
            if not icons:
                bad.append("the desktop published no icons, so there is nothing to open")
                print("BAD: no icons")
                return 1
            print("icons    %s" % [label for label, _ in icons])

            if args.prove_failure:
                # A WINDOW PARKED ON THE ICON COLUMN, through the frame's own geometry route —
                # which is the world the BURIED assertion is about, and the world this desktop
                # was in when a reader reported it.
                moved = ff.evaluate("""(() => {
                  const host = globalThis.M14 && globalThis.M14.host
                  if (!host) return 'no host published'
                  for (const entry of host.frames.values()) {
                    if (entry.role === 1) continue
                    entry.win.box = { ...entry.win.placed, x: 0, y: 0 }
                    entry.win.apply()
                    return 'parked ' + entry.id + ' at 0,0'
                  }
                  return 'no app window to park'
                })()""")
                print("control  %s" % moved)
                time.sleep(0.4)

            def apps():
                return [w["title"] for w in ff.evaluate(STATE)["windows"] if w["role"] != 1]

            # ---- 1. EVERY ICON OPENS SOMETHING ----
            for icon in ff.evaluate(STATE)["icons"]:
                before = len(apps())
                ff.dblclick(icon["cx"], icon["cy"])
                time.sleep(3.0)
                after = apps()
                opened = len(after) > before
                print("dblclick %-14s %d -> %d  %s" % (icon["label"], before, len(after),
                                                       "OPENED" if opened else "NOTHING"))
                if not opened:
                    bad.append("a double-click on %r opened nothing" % icon["label"])

                # ---- 2. AND THE ICONS ARE STILL REACHABLE ----
                buried = [r for r in ff.evaluate(UNDER) if not r["reachable"]]
                if buried:
                    for row in buried:
                        print("   BURIED %-14s hit test lands on %s" % (row["label"], row["hits"]))
                    bad.append("after opening %r, %d icon(s) are no longer clickable"
                               % (icon["label"], len(buried)))

            # ---- 4. TWO WINDOWS OF ONE PROGRAM DO NOT SHARE A PIXEL ----
            corners = [(w["x"], w["y"]) for w in ff.evaluate(STATE)["windows"] if w["role"] != 1]
            print("corners  %s" % corners)
            if len(set(corners)) != len(corners):
                bad.append("two windows opened on the same corner: %s" % corners)

            # ---- 3. A CONSOLE ROW OPENS A TERMINAL THAT RAN IT ----
            for name in ("ls", "cat"):
                st = ff.evaluate(STATE)
                if not st["popup"] and st["orb"]:
                    ff.click(st["orb"]["cx"], st["orb"]["cy"])
                    time.sleep(0.9)
                row = ff.evaluate(ROW % repr(name))
                if not isinstance(row, dict) or not row.get("hits"):
                    bad.append("the start-menu row for %r could not be pressed: %s" % (name, row))
                    continue
                before = len(apps())
                ff.click(row["x"], row["y"])
                time.sleep(4.0)
                after = apps()
                print("menu row %-22s %d -> %d" % (row["label"], before, len(after)))
                if len(after) <= before:
                    bad.append("the start-menu row %r opened nothing" % row["label"])
                    continue
                # IT MUST HAVE RUN, not merely opened a bare shell: the command has to be on screen.
                ran = any(name in text for text in ff.evaluate(SCREENS))
                print("         ...and a terminal shows %r having run: %s" % (name, ran))
                if not ran:
                    bad.append("a terminal opened for %r but the command never ran" % name)

            print("errors   %s" % ff.evaluate(STATE)["errors"])
            ff.screenshot(args.shot)
            print("shot     %s" % args.shot)
    finally:
        if httpd is not None:
            httpd.shutdown()

    if args.prove_failure:
        # EXIT 0 WHEN THE PROOF SUCCEEDED, which is `scripts/check.py`'s convention: a non-zero
        # exit is reserved for a proof that FAILED to fail.
        buried = [line for line in bad if "no longer clickable" in line]
        print()
        for line in bad:
            print("would report  %s" % line)
        if buried:
            print("\nthe proof succeeded: a window on the icon column was reported, %d time(s)"
                  % len(buried))
            return 0
        print("\nTHE PROOF FAILED: a window was parked on the icon column and the gate said "
              "nothing. It cannot see the defect it exists for.")
        return 1

    if bad:
        print()
        for line in bad:
            print("BAD  %s" % line)
        return 1
    print("\nevery launcher on the desktop opened something, in Firefox, with a real pointer")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
