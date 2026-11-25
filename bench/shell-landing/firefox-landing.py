#!/usr/bin/env python3
"""CAN A READER USE THE LANDING PAGE? The bare URL, driven with REAL input in FIREFOX.

    python3 bench/shell-landing/firefox-landing.py                  # the gate
    python3 bench/shell-landing/firefox-landing.py --prove-failure  # ...and it MUST report failures
    python3 bench/shell-landing/firefox-landing.py --headed         # in a window you can watch
    python3 bench/shell-landing/firefox-landing.py --page /bench/shell-landing/fixture.html
    python3 bench/shell-landing/firefox-landing.py --url http://127.0.0.1:8000/www/index.html

TWO CONTROLS, AND THEY BREAK DIFFERENT THINGS. `--prove-failure` drags a window onto the icon
column and must move the `reachable` clause while `desktop` stays green — a control satisfied by
any failure verifies nothing. The second is the `--no-isolation` world, which takes the desktop
away entirely and must move `desktop` instead:

    python3 scripts/serve.py --no-isolation --port 8731 &
    python3 bench/shell-landing/firefox-landing.py --url http://127.0.0.1:8731/www/index.html

Measured: that run exits 1 with `preflight='fail'`, no taskbar, no orb, no icons, and clauses 2-4
not run — which is the preflight refusing, and is the behaviour `www/index.html` must keep.

WHY THIS FILE EXISTS. `CLAUDE.md` records that driving Chrome only has cost this project FOUR
milestones: M4a shipped a window that could not be dragged in Firefox (constraint 175), M6 shipped
a policy under which no process started there (206), and M11 and M12 asserted geometry derived from
dpr-2 constants that is wrong at dpr 1 (264). Every one shipped with every Chrome expectation green
and was found by a person opening the page. `www/index.html` is now the ONE url a reader opens, so
it is the worst place in the repository for that to happen a fifth time.

It is `bench/m14-shell/firefox-drive.py` pointed at the landing page, and it asks the four things a
reader does in their first ten seconds:

  1. THE DESKTOP IS THERE AT ALL — a taskbar, a start orb, at least one icon, and NO driver banner.
     The banner clause is constraint 283 from the product side: `#driver-hint` on the url a reader
     opens means the page they were given is a proof harness blocked on a gesture.
  2. EVERY DESKTOP ICON OPENS A WINDOW when it is double-clicked. Every icon, enumerated from the
     DOM — so an icon a later milestone publishes is covered the day it lands and no list here is
     edited.
  3. THE ICONS ARE STILL REACHABLE AFTER A LAUNCH, hit-tested with `elementFromPoint` on each
     icon's own click point. A window covering the icon column is indistinguishable from a desktop
     that stopped working, which is what a reader reported twice (constraint 289).
  4. THE START MENU OPENS AND A ROW LAUNCHES SOMETHING, and a console row at that: most of
     `/usr/bin` writes to stdout and owns no window, and those rows used to do nothing visible
     (290). The row is CHOSEN FROM THE MENU, not named here — `src/bin/desktop.mjs` suffixes a row
     "(in a terminal)" exactly when the program is outside its `OPENS_OWN_WINDOW` allowlist, so the
     first suffixed row tracks that allowlist without a second copy of it. Today that is `cat`.

NOTHING HERE READS A PAGE GLOBAL. `firefox-drive.py` reads `globalThis.M14`, which is fine for a
page it was written beside; the landing page's own globals are not this file's to depend on, and a
gate that needs them cannot be pointed at a second page. Every clause is read out of the DOM that
`src/wm/` builds, so the selectors are the contract: `[data-taskbar]`, `[data-start]`, `.desk-icon`,
`.window[data-role]`, `.shell-popup[data-popup=start]`, `.shell-row`.

IT WAITS FOR THE LAYOUT TO SETTLE FIRST, for the reason `firefox-drive.py` does: the page prints its
own log, the log grows, and the desktop is pushed down under it — measured on m14, an icon at y=65
became y=249 — so an icon read before that and clicked after is clicked where the icon is not. Two
identical reads in a row is the settle signal.
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

#: WHAT IS ON SCREEN, in one read. `search` and `preflight` are read because the landing page is the
#: BARE url plus a preflight that must still refuse (CLAUDE.md, and `www/index.html`'s own gate):
#: a run against `?proofs=1` is a run against a different page and must not be reported as this one.
STATE = """JSON.stringify((() => {
  const mid = (el) => { const r = el.getBoundingClientRect()
    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) } }
  const orb = document.querySelector('[data-start]')
  const log = document.getElementById('log')
  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    search: location.search,
    preflight: document.documentElement.dataset.preflight || '',
    banner: (() => { const b = document.getElementById('driver-hint')
      return b ? (b.textContent || '').slice(0, 120) : '' })(),
    taskbar: Boolean(document.querySelector('[data-taskbar]')),
    orb: orb ? mid(orb) : null,
    windows: [...document.querySelectorAll('.window')].map((w) => ({
      title: ((w.querySelector('h2') || {}).textContent || '').trim(),
      role: Number(w.dataset.role || 0),
      x: Number(w.dataset.x), y: Number(w.dataset.y) })),
    icons: [...document.querySelectorAll('.desk-icon')].map((c) => {
      const r = c.getBoundingClientRect()
      // The LABEL's own row is not the click target: an icon cell is a glyph above a caption, and
      // +24 is where `desktop.mjs` draws the glyph. Same point `firefox-drive.py` clicks.
      return { label: (c.querySelector('.desk-label') || {}).textContent || '',
               cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + 24) } }),
    popup: (() => { const p = document.querySelector('.shell-popup')
      return p && !p.hidden ? (p.dataset.popup || '') : '' })(),
    tail: log ? (log.textContent || '').trim().split('\\n').slice(-3) : [],
  }
})())"""

#: WHAT IS UNDER EACH ICON'S OWN CLICK POINT. `elementFromPoint` and not a rectangle overlap: the
#: hit test is what decides where a double-click lands, and a bounding-box guess is not it.
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

#: THE FIRST CONSOLE ROW IN THE OPEN START MENU, scrolled into its list and hit-tested. The suffix
#: is `src/bin/desktop.mjs`'s own wording for a program outside `OPENS_OWN_WINDOW`, which is why
#: matching on it keeps this gate current without naming a program.
CONSOLE_ROW = """JSON.stringify((() => {
  const p = document.querySelector('.shell-popup[data-popup="start"]')
  if (!p || p.hidden) return { none: 'the start menu is not open' }
  const rows = [...p.querySelectorAll('.shell-row')]
  for (const row of rows) {
    const label = (row.querySelector('.shell-label') || {}).textContent || ''
    if (!label.endsWith(' (in a terminal)')) continue
    row.scrollIntoView({ block: 'nearest' })
    const b = row.getBoundingClientRect()
    const pr = p.getBoundingClientRect()
    if (b.top < pr.top || b.bottom > pr.bottom) return { label, clipped: true }
    const x = Math.round(b.left + 20), y = Math.round(b.top + b.height / 2)
    const el = document.elementFromPoint(x, y)
    return { label, program: label.replace(' (in a terminal)', ''), x, y,
             rows: rows.length,
             hits: Boolean(el && el.closest && el.closest('.shell-row') === row) }
  }
  return { none: 'no console row among ' + rows.length + ' menu row(s)' }
})())"""

SCREENS = """JSON.stringify([...document.querySelectorAll('.terminal')].map(
  (t) => (t.textContent || '').slice(-400)))"""

#: THE CONTROL, as GEOMETRY rather than as a handle: where to grab an app window's caption and
#: where to let go so the window lands on the icon column. Measured off the icons' own rects, so it
#: parks the frame wherever the icons actually are.
#:
#: The grab point is 35% along the caption — right of the window icon, left of the three buttons —
#: and at its vertical centre, because the top 4 px of a caption is the `n` resize grip
#: (`src/wm/window.mjs` `#grips`). A grab there resizes instead of moving.
#:
#: THE POINTER NEVER NEARS A DESKTOP EDGE, which is what keeps Aero Snap out of it: `SNAP_ARM_PX` is
#: 1 and the arm test reads the POINTER, not the box, so a frame parked at the icon column by a
#: pointer in mid-caption neither maximizes nor snaps left.
PARK = """JSON.stringify((() => {
  const cell = document.querySelector('.desk-icon')
  if (!cell) return { error: 'no icon to park a window on' }
  const win = [...document.querySelectorAll('.window')].find((w) => w.dataset.role !== '1')
  if (!win) return { error: 'no app window to park' }
  const bar = win.querySelector('.window-title')
  if (!bar) return { error: 'the app window has no caption to drag' }
  const t = cell.getBoundingClientRect(), wb = win.getBoundingClientRect()
  const cb = bar.getBoundingClientRect()
  const grab = { x: Math.round(cb.left + cb.width * 0.35),
                 y: Math.round(cb.top + cb.height / 2) }
  return {
    title: ((win.querySelector('h2') || {}).textContent || '').trim(),
    was: { x: Number(win.dataset.x), y: Number(win.dataset.y) },
    grab,
    to: { x: Math.round(grab.x + (t.left - 4 - wb.left)),
          y: Math.round(grab.y + (t.top - 4 - wb.top)) },
  }
})())"""

#: Where the parked frame ended up, so a drag that did not move it is reported instead of being
#: mistaken for a gate that cannot see burial.
PARKED = """JSON.stringify([...document.querySelectorAll('.window')]
  .filter((w) => w.dataset.role !== '1')
  .map((w) => ({ x: Number(w.dataset.x), y: Number(w.dataset.y) })))"""

#: The clause tag whose firing IS the proof. Named, because a control satisfied by any failure
#: verifies nothing (CLAUDE.md §Verification).
PROOF_TAG = "reachable"
#: ...and the clause that MUST NOT move: a world with no desktop at all would fire everything.
KEPT_TAG = "desktop"


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
    ap.add_argument("--page", default="/www/index.html",
                    help="the landing page, at its BARE url: no query, no proofs")
    ap.add_argument("--w", type=int, default=1560)
    ap.add_argument("--h", type=int, default=1010)
    ap.add_argument("--shot", default=str(HERE / "firefox-landing.png"))
    ap.add_argument("--prove-failure", action="store_true",
                    help="DRAG an app window onto the icon column with a real pointer before the "
                         "gate runs; the `%s` clause MUST then fire and the `%s` clause MUST NOT. "
                         "A gate nobody has seen fail is a gate nobody has checked (CLAUDE.md). "
                         "Exits 0 when the proof SUCCEEDED." % (PROOF_TAG, KEPT_TAG))
    args = ap.parse_args(argv)

    httpd = None
    url = args.url
    if not url:
        os.chdir(REPO)
        httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d%s" % (httpd.server_address[1], args.page)
    print("url      %s" % url)

    #: (tag, message). The tag is what `--prove-failure` scopes its proof to.
    bad: list[tuple[str, str]] = []
    try:
        with bidi.Firefox(headless=not args.headed, width=args.w, height=args.h) as ff:
            ff.navigate(url)
            icons = settle(ff)
            st = ff.evaluate(STATE)
            print("firefox  viewport %s" % st["viewport"])
            print("page     search=%r preflight=%r popup=%r"
                  % (st["search"], st["preflight"], st["popup"]))
            for line in st["tail"]:
                print("log      %s" % line)

            # ---- 1. THE DESKTOP IS THERE AT ALL ----
            if st["search"]:
                bad.append(("bare-url", "this is not the bare url: location.search is %r"
                            % st["search"]))
            if not st["taskbar"]:
                bad.append((KEPT_TAG, "no taskbar: nothing matches [data-taskbar]"))
            if not st["orb"]:
                bad.append((KEPT_TAG, "no start orb: nothing matches [data-start]"))
            if not icons:
                bad.append((KEPT_TAG, "the desktop published no icons, so there is nothing to open"))
            if st["banner"]:
                bad.append((KEPT_TAG, "the landing page is a proof harness waiting for a driver "
                                      "(constraint 283): %s" % st["banner"]))
            print("desktop  taskbar=%s orb=%s icons=%s"
                  % (st["taskbar"], bool(st["orb"]), [label for label, _ in icons]))
            if not icons or not st["taskbar"]:
                for tag, line in bad:
                    print("BAD  [%s] %s" % (tag, line))
                print("\nthere is no desktop to drive, so clauses 2-4 were not run")
                ff.screenshot(args.shot)
                print("shot     %s" % args.shot)
                return 1

            if args.prove_failure:
                # A WINDOW DRAGGED ONTO THE ICON COLUMN BY A REAL POINTER — the world constraint
                # 289 names, and the one a reader was in when they said "I'm unable to open
                # anything". A drag and not a geometry poke through a page global: the control
                # should be reachable by the same hand the gate is about.
                park = ff.evaluate(PARK)
                print("control  %s" % park)
                if park.get("error"):
                    print("\nTHE CONTROL COULD NOT BE SET UP: %s" % park["error"])
                    return 1
                ff.drag(park["grab"], park["to"], steps=14)
                time.sleep(0.6)
                now = ff.evaluate(PARKED)
                print("control  frames now at %s" % now)
                if park["was"] in now:
                    print("\nTHE CONTROL DID NOT TAKE: the caption drag left %r at %s, so the icon "
                          "column was never covered and this run proves nothing about the gate."
                          % (park["title"], park["was"]))
                    return 1

            def apps():
                return [w["title"] for w in ff.evaluate(STATE)["windows"] if w["role"] != 1]

            # ---- 2. EVERY ICON OPENS A WINDOW ----
            for icon in ff.evaluate(STATE)["icons"]:
                before = len(apps())
                ff.dblclick(icon["cx"], icon["cy"])
                time.sleep(3.0)
                after = apps()
                opened = len(after) > before
                print("dblclick %-14s %d -> %d  %s" % (icon["label"], before, len(after),
                                                       "OPENED" if opened else "NOTHING"))
                if not opened:
                    bad.append(("opens", "a double-click on %r opened nothing" % icon["label"]))

                # ---- 3. AND THE ICONS ARE STILL REACHABLE ----
                buried = [r for r in ff.evaluate(UNDER) if not r["reachable"]]
                for row in buried:
                    print("   BURIED %-14s hit test lands on %s" % (row["label"], row["hits"]))
                if buried:
                    bad.append((PROOF_TAG,
                                "after opening %r, %d icon(s) are no longer clickable: %s"
                                % (icon["label"], len(buried),
                                   ", ".join(r["label"] for r in buried))))

            # ---- 4. THE START MENU OPENS AND A ROW LAUNCHES SOMETHING ----
            st = ff.evaluate(STATE)
            if not st["popup"]:
                ff.click(st["orb"]["cx"], st["orb"]["cy"])
                time.sleep(0.9)
            kind = ff.evaluate(STATE)["popup"]
            print("menu     popup=%r" % kind)
            if kind != "start":
                bad.append(("menu", "the start orb did not open the start menu: popup=%r" % kind))
            else:
                row = ff.evaluate(CONSOLE_ROW)
                print("menu row %s" % row)
                if not row.get("hits"):
                    bad.append(("menu", "no start-menu console row could be pressed: %s" % row))
                else:
                    before = len(apps())
                    ff.click(row["x"], row["y"])
                    time.sleep(4.0)
                    after = apps()
                    print("menu row %-22s %d -> %d" % (row["label"], before, len(after)))
                    if len(after) <= before:
                        bad.append(("menu", "the start-menu row %r opened nothing" % row["label"]))
                    else:
                        # IT MUST HAVE RUN, not merely opened a bare shell: a console row that
                        # opens an empty terminal is constraint 290 half-fixed.
                        name = row["program"]
                        ran = any(name in text for text in ff.evaluate(SCREENS))
                        print("         ...and a terminal shows %r having run: %s" % (name, ran))
                        if not ran:
                            bad.append(("menu", "a terminal opened for %r but the command never ran"
                                        % name))

            ff.screenshot(args.shot)
            print("shot     %s" % args.shot)
    finally:
        if httpd is not None:
            httpd.shutdown()

    if args.prove_failure:
        print()
        for tag, line in bad:
            print("would report  [%s] %s" % (tag, line))
        fired = [line for tag, line in bad if tag == PROOF_TAG]
        collapsed = [line for tag, line in bad if tag == KEPT_TAG]
        # EXIT 0 WHEN THE PROOF SUCCEEDED, which is `scripts/check.py`'s convention: a non-zero
        # exit is reserved for a proof that failed to fail.
        if collapsed:
            print("\nTHE PROOF FAILED: the control took the whole desktop down, so `%s` firing "
                  "says nothing about burial. A control satisfied by any failure verifies nothing."
                  % PROOF_TAG)
            return 1
        if fired:
            print("\nthe proof succeeded: a window dragged onto the icon column was reported %d "
                  "time(s) as `%s`, and `%s` stayed green." % (len(fired), PROOF_TAG, KEPT_TAG))
            return 0
        print("\nTHE PROOF FAILED: a window was dragged onto the icon column and the `%s` clause "
              "said nothing. The gate cannot see the defect it exists for." % PROOF_TAG)
        return 1

    if bad:
        print()
        for tag, line in bad:
            print("BAD  [%s] %s" % (tag, line))
        return 1
    print("\nthe landing page is a desktop a reader can use: every icon opened a window, the icons "
          "stayed reachable, and the start menu launched something — in Firefox, with a real "
          "pointer")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
