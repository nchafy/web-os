#!/usr/bin/env python3
"""CAN A READER REACH THE LAST TASKBAR BUTTON IN FIREFOX? M22's band, with REAL trusted input.

    python3 bench/m22-band/firefox-band.py
    python3 bench/m22-band/firefox-band.py --headed
    python3 bench/m22-band/firefox-band.py --prove-failure

WHY THIS FILE EXISTS. CLAUDE.md makes a second engine a condition of reporting a milestone done and
records the bill for skipping it: M4a shipped a window that could not be dragged in Firefox, M6 a
policy under which no process started there, and M11 and M12 each failed on an engine whose feature
was fine because a geometry was derived from a dpr-2 constant. Five milestones, every Chrome
expectation green each time.

M22's band is the likeliest repeat yet, for three reasons that are all engine-shaped:

  1. **The affordance is CSS that the two engines spell differently.** The native scrollbar is
     suppressed with `scrollbar-width: none` for Firefox and `::-webkit-scrollbar` for Chrome. If
     one of them does not take, the bar gains a scrollbar's height out of a 40 px strip and the
     buttons are cropped — visible instantly to a reader and invisible to every geometry assertion
     that reads the band's own box.
  2. **The wheel's delta is not in the same unit in the two drivers** (constraint 297): CDP's is
     device px, BiDi's `scroll` is CSS px. `bench/m22-band/probe.py` measured in Chrome that a
     `deltaX` moves the band and a `deltaY` does not; whether Firefox agrees about the AXIS is a
     separate fact, and this gate reads it rather than assuming it.
  3. **Firefox renders at dpr 1 here** (constraint 264), which is where a ratio error hides.

WHAT IS ASSERTED, all of it read out of the shell's own `report().band` and `revealSlot`, which is
what a registered check would read:

  1. the band overflows at the width this gate found, and is a SCROLLER and not a clip;
  2. a chevron is shown while it overflows, and a REAL trusted click on it scrolls the band;
  3. the last button is then wholly inside the band AND is what the hit test finds at its centre;
  4. which wheel axis moves it, reported for both — a fact about this engine, not an assertion
     copied from the other;
  5. the menus publish the real accelerator, verbatim.

`--prove-failure` arms `band-clips` — `overflow: hidden`, the world this band used to be in — and
the gate MUST then report the WHEEL clause dead and the programmatic reveal alive. That asymmetry
is the control's whole world and was measured, not assumed: `overflow: hidden` still permits a
`scrollLeft`. It exits 0 when the proof SUCCEEDED.
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

import bidi   # noqa: E402
import serve  # noqa: E402

#: The viewport is SEARCHED and not fixed, for `probe.py`'s reason: the band must be narrower than
#: its content and wider than one button at once, and the gap between those is about ten pixels and
#: sits wherever this engine's clock rendering puts it.
WIDE_W = 460
MIN_W = 170
STEP_W = 6
VIEW_H = 640

#: One notch in CSS px. BiDi's `scroll` takes CSS px, NOT the device px CDP takes (constraint 297).
NOTCH = 120

STATE = """JSON.stringify((() => {
  const M = globalThis.M14 || {}
  const shell = M.shell
  return {
    state: String(M.state || ''), dpr: devicePixelRatio,
    errors: (M.errors || []).map(String).slice(0, 4),
    shell: Boolean(shell),
    buttons: shell ? shell.report().buttons : 0,
    screen: (document.querySelector('.terminal') || {}).textContent || '',
  }
})())"""

BAND = """JSON.stringify((() => {
  const shell = globalThis.M14.shell
  const r = shell.report()
  const el = document.querySelector('[data-band]')
  const box = el.getBoundingClientRect()
  const chev = document.querySelector('[data-band-chev="next"]')
  const cbox = chev && !chev.hidden ? chev.getBoundingClientRect() : null
  return {
    band: r.band, slots: r.slots, chords: r.chords,
    scrollLeft: el.scrollLeft,
    centre: { x: Math.round(box.left + box.width / 2),
              y: Math.round(box.top + box.height / 2) },
    chevron: cbox ? { x: Math.round(cbox.left + cbox.width / 2),
                      y: Math.round(cbox.top + cbox.height / 2) } : null,
  }
})())"""

RESET = "JSON.stringify((() => { document.querySelector('[data-band]').scrollLeft = 0; return 0 })())"
SCROLL_LEFT = "JSON.stringify(document.querySelector('[data-band]').scrollLeft)"
REVEAL_LAST = """JSON.stringify((() => {
  const s = globalThis.M14.shell
  return s.revealSlot(s.report().slots.length)
})())"""

#: THE CONTROL, THROUGH THE LIVE MODULE. A dynamic `import` of the URL the page already loaded
#: returns the SAME instance, so this reaches the real `shellControls` the real `Taskbar` reads —
#: and `sync()` is what puts the class on, which is why it works against a bar that already exists.
#: BiDi's `evaluate` is synchronous here, so the import is resolved by the page and the result is
#: read on the next call rather than awaited.
ARM_CLIPS = """(() => {
  globalThis.__m22 = 'pending'
  import('/src/wm/taskbar.mjs').then((m) => {
    m.setShellControls({ bandClips: true })
    globalThis.M14.shell.sync()
    globalThis.__m22 = globalThis.M14.shell.report().band.overflowX
  }).catch((e) => { globalThis.__m22 = 'threw: ' + e.message })
  return ''
})()"""
ARMED = "JSON.stringify(String(globalThis.__m22 || ''))"


def set_viewport(ff, width: int, height: int) -> None:
    """`browsingContext.setViewport`, which `scripts/bidi.py` does not wrap. Called directly rather
    than added there, because this is the only caller — the row goes into that module the day a
    second gate needs it."""
    ff.call("browsingContext.setViewport",
            {"context": ff.ctx, "viewport": {"width": width, "height": height}})


def wait_for_shell(ff, tries: int = 120) -> dict:
    st = {}
    for _ in range(tries):
        st = ff.evaluate(STATE)
        if isinstance(st, dict) and st.get("shell") and st.get("buttons", 0) >= 1 \
                and "$" in (st.get("screen") or ""):
            return st
        time.sleep(0.4)
    return st if isinstance(st, dict) else {}


def stage(ff) -> int:
    """`winopen -n 2 &` at the real prompt. BACKGROUNDED, because `winopen` in the foreground never
    returns a prompt — and it is the only command typed, because its window takes the keyboard."""
    ff.type_keys("winopen -n 2 &\n")
    for _ in range(60):
        st = ff.evaluate(STATE)
        if isinstance(st, dict) and st.get("buttons", 0) >= 2:
            return st["buttons"]
        time.sleep(0.4)
    return 0


def narrow(ff) -> dict:
    tried = []
    width = WIDE_W
    while width >= MIN_W:
        set_viewport(ff, width, VIEW_H)
        time.sleep(0.25)
        got = ff.evaluate(BAND)
        band = got["band"]
        tried.append({"w": width, "clientW": band["clientW"], "over": band["over"]})
        if band["over"] > 1 and band["clientW"] >= band["minBtnW"]:
            return {"width": width, "tried": tried, "read": got}
        width -= STEP_W
    return {"width": 0, "tried": tried, "read": None}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--url", default="", help="an already-running server; otherwise one is bound")
    ap.add_argument("--shot", default=str(HERE / "firefox-band.png"))
    ap.add_argument("--prove-failure", action="store_true",
                    help="arm band-clips; the WHEEL clause MUST die and the reveal MUST live. "
                         "Exits 0 when the proof succeeded.")
    args = ap.parse_args(argv)

    httpd = None
    url = args.url
    if not url:
        os.chdir(REPO)
        httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d/www/m14.html" % httpd.server_address[1]
    print("url      %s" % url)
    if args.prove_failure:
        print("control  --prove-failure: band-clips, the overflow: hidden world")

    bad: list[str] = []
    try:
        with bidi.Firefox(headless=not args.headed, width=WIDE_W, height=VIEW_H) as ff:
            ff.navigate(url)
            st = wait_for_shell(ff)
            print("firefox  dpr %s  state=%r shell=%s buttons=%s"
                  % (st.get("dpr"), st.get("state"), st.get("shell"), st.get("buttons")))
            if st.get("errors"):
                print("page errors %s" % st["errors"])
            if not st.get("shell"):
                print("BAD  the m14 desktop never published a shell in Firefox")
                return 1
            buttons = stage(ff)
            print("staged   %s Superbar button(s) after `winopen -n 2 &`" % buttons)
            if buttons < 2:
                print("BAD  only %s button(s); one button cannot overflow a band" % buttons)
                print("     the terminal said: %s" % (ff.evaluate(STATE).get("screen") or "")[-500:])
                return 1

            if args.prove_failure:
                ff.evaluate(ARM_CLIPS, raw=True)
                for _ in range(20):
                    armed = ff.evaluate(ARMED)
                    if armed and armed != "pending":
                        break
                    time.sleep(0.2)
                print("armed    computed overflow-x=%r" % armed)
                if armed != "hidden":
                    print("BAD  band-clips did not take, so the control has no world: %r" % armed)
                    return 1

            found = narrow(ff)
            if not found["width"]:
                print("BAD  no viewport left the band overflowing and wider than one button: %s"
                      % json.dumps(found["tried"]))
                return 1
            read = found["read"]
            band = read["band"]
            print("viewport %s CSS px, after %s step(s)" % (found["width"], len(found["tried"])))
            print("band     clientW=%s scrollW=%s over=%s overflow-x=%r chevrons=%s"
                  % (band["clientW"], band["scrollW"], band["over"], band["overflowX"],
                     json.dumps(band["chevrons"])))
            print("slots    %s" % json.dumps(read["slots"]))

            want_overflow = "hidden" if args.prove_failure else "auto"
            if band["over"] <= 1:
                bad.append("the band did not overflow, so nothing here is about reachability")
            if band["overflowX"] != want_overflow:
                bad.append("computed overflow-x is %r, expected %r"
                           % (band["overflowX"], want_overflow))

            # ---- WHICH WHEEL AXIS MOVES IT, in THIS engine ----
            axes = {}
            for name, dx, dy in (("deltaX", NOTCH, 0), ("deltaY", 0, NOTCH)):
                ff.evaluate(RESET)
                ff.wheel(read["centre"]["x"], read["centre"]["y"], dy, dx=dx)
                time.sleep(0.5)
                axes[name] = ff.evaluate(SCROLL_LEFT)
            print("wheel    %s  (CSS px of scrollLeft after one %s px notch on each axis)"
                  % (json.dumps(axes), NOTCH))

            # ---- THE CHEVRON, with a REAL trusted click ----
            ff.evaluate(RESET)
            chevron = ff.evaluate(BAND)["chevron"]
            if chevron is None:
                bad.append("no chevron was shown while the band overflowed, so a reader has no "
                           "affordance at all")
                chev_left = None
            else:
                ff.click(chevron["x"], chevron["y"])
                time.sleep(0.5)
                chev_left = ff.evaluate(SCROLL_LEFT)
                print("chevron  a trusted click at (%s,%s) moved scrollLeft to %s"
                      % (chevron["x"], chevron["y"], chev_left))
                if not chev_left or chev_left <= 0:
                    bad.append("a real click on the chevron did not scroll the band")

            # ---- AND THE LAST BUTTON ----
            ff.evaluate(RESET)
            reveal = ff.evaluate(REVEAL_LAST)
            print("reveal   %s" % json.dumps(reveal))
            if not reveal or reveal.get("inView") is not True:
                bad.append("the last button is not inside the band at any scroll position")
            if reveal and reveal.get("reachable") is not True:
                bad.append("the hit test at the last button's centre did not find it: something "
                           "is over it")

            chords = read["chords"]
            print("accel    %s" % json.dumps(chords))
            if chords.get("next") != "Alt+`" or chords.get("prev") != "Alt+Shift+`":
                bad.append("the menus do not publish the measured accelerator: %s"
                           % json.dumps(chords))

            try:
                ff.screenshot(args.shot)
                print("shot     %s" % args.shot)
            except Exception as error:  # a screenshot is evidence, never the gate
                print("shot     unavailable: %s" % error)

            if args.prove_failure:
                # THE NAMED ASYMMETRY. Under `overflow: hidden` a driven wheel must move nothing
                # and a programmatic reveal must still work — so a registered control's
                # `Expect(failed=)` names the WHEEL clause and not reachability.
                wheel_dead = not axes["deltaX"] and not axes["deltaY"]
                reveal_alive = bool(reveal) and reveal.get("inView") is True
                print("\nprove-failure: wheel died=%s (%s)  reveal survived=%s"
                      % (wheel_dead, json.dumps(axes), reveal_alive))
                return 0 if (wheel_dead and reveal_alive) else 1

            for line in bad:
                print("BAD  %s" % line)
            print("\n%s" % ("ok   every clause held in Firefox" if not bad
                            else "%d clause(s) failed" % len(bad)))
            return 1 if bad else 0
    finally:
        if httpd:
            httpd.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
