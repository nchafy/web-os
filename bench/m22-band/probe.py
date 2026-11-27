#!/usr/bin/env python3
"""M22's half-day probe, run BEFORE the band's check: IS A BUTTON PAST THE SHRINK FLOOR REACHABLE,
and what does `band-clips` actually take away?

WHY THIS EXISTS. `src/wm/aero.mjs` carried a comment saying the taskbar band "SCROLLS RATHER THAN
SHRINKS past its width" while its CSS was `overflow: hidden`. Those cannot both be true, and the
clipped half is the one that shipped: past the 42 CSS px shrink floor (`TASK_BTN_MIN_W`) the band
overflows and a running program's button is in the DOM, has a non-zero rect, and cannot be clicked.
Three facts had to be measured before the fix could be designed, because each of them decides a
clause:

  1. WHICH WHEEL AXIS MOVES A HORIZONTAL SCROLLER. A `mouseWheel` is the only user gesture a driver
     has for one, and if the answer is `deltaX` then a check dispatching `deltaY` asserts a constant
     against a scroller that never moved — the shape of constraints 264 and 297.
  2. WHETHER `overflow: hidden` STOPS A PROGRAMMATIC SCROLL. If it does not, then M22's `band-clips`
     control cannot break a chevron that scrolls by `scrollLeft`, and the control's `Expect(failed=)`
     has to name the wheel clause alone or it verifies nothing.
  3. WHETHER THE REAL BAR, with the real stylesheet and the real `Taskbar`, reaches its last button.
     A synthetic flex row proves the CSS; only the product proves the shell.

HOW IT DRIVES THE PRODUCT. It opens `www/m14.html` — the bare URL, which is the desktop — and
NARROWS THE VIEWPORT until the band overflows. Narrowing rather than opening a dozen windows is
deliberate: the subject is a band narrower than its content, and the viewport is the one input that
produces that state without depending on how many programs a desktop happens to stage.

    python3 bench/m22-band/probe.py                 # the table
    python3 bench/m22-band/probe.py --headed        # ...with the window on screen
    python3 bench/m22-band/probe.py --prove-failure  # the two controls, which MUST both fire

EVERY FIGURE IS CSS px ON THE EMULATED VIEWPORT, dpr 1. The band's own numbers are
`clientWidth`/`scrollWidth`/`scrollLeft`, which are CSS px by definition — this probe has no device-px
reading and wants none.
"""
from __future__ import annotations

import argparse
import functools
import json
import pathlib
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve()
REPO = HERE.parents[2]
sys.path.insert(0, str(REPO / "scripts"))

import cdp  # noqa: E402
import serve as serve_mod  # noqa: E402

#: THE VIEWPORT IS SEARCHED AND NOT WRITTEN, and the reason is a clause that failed over a band
#: that was working.
#:
#: The band needs TWO properties at once: narrower than its content, so it overflows, and wider than
#: one button, so "the last button is wholly inside the band" is satisfiable by some scroll position
#: at all. At a fixed 200 px viewport the orb, the two chevrons and the tray left the band 14 CSS px
#: — under the 42 px floor — and the reachability clause was unsatisfiable; at a fixed 250 px the
#: band was 99 px and two buttons FIT, so there was no overflow to reach past. The window between
#: them is about ten pixels wide and its position depends on the tray, whose width depends on how
#: wide the locale's clock renders. So the probe steps the viewport down until the band is in the
#: band, and REPORTS the width it found rather than asserting a constant that holds on one machine.
WIDE_W = 420
MIN_W = 170
STEP_W = 6
NARROW_H = 620

#: `deltaX` and `deltaY` at the same magnitude, so the axis is the only difference between the two
#: readings. 120 is one notch, which is what `bench/m17-wheel/probe.py` established a notch is.
WHEEL_DELTA = 120


def serve_repo() -> tuple[object, int]:
    """The repo root with COOP/COEP, on a port the OS picks.

    `serve.Server` AND `serve.Handler`, not a `ThreadingHTTPServer` of this file's own: the listen
    backlog and the COOP/COEP headers each have one definition in `scripts/serve.py`, and
    `www/m14.html` needs a SharedArrayBuffer — `python3 -m http.server` cannot serve it at all.
    """
    serve_mod.Handler.isolate = True
    handler = functools.partial(serve_mod.Handler, directory=str(REPO))
    httpd = serve_mod.Server(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def wheel(page, x: float, y: float, dx: int, dy: int) -> None:
    page.call("Input.dispatchMouseEvent", type="mouseWheel", x=x, y=y,
              deltaX=dx, deltaY=dy, pointerType="mouse")


def settle(page, ms: int = 260) -> None:
    page.evaluate(f"new Promise(r=>setTimeout(r,{ms}))", await_promise=True)


BAND_RECT = """(() => {
  const b = document.querySelector('[data-band]')
  if (!b) return null
  const r = b.getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
})()"""

REPORT = "(() => globalThis.M14.shell.report())()"

#: THE CONTROL, APPLIED THROUGH THE LIVE MODULE AND NOT A SOURCE EDIT. A dynamic `import` of the
#: same URL the page loaded returns the SAME module instance, so this reaches the real
#: `shellControls` the real `Taskbar` reads. `sync()` is what puts the class on, which is why the
#: control is re-runnable against a bar that already exists.
ARM_CLIPS = """import('/src/wm/taskbar.mjs').then((m) => {
  m.setShellControls({ bandClips: true })
  globalThis.M14.shell.sync()
  return globalThis.M14.shell.report().band.overflowX
})"""

DISARM_CLIPS = """import('/src/wm/taskbar.mjs').then((m) => {
  m.setShellControls({})
  globalThis.M14.shell.sync()
  return globalThis.M14.shell.report().band.overflowX
})"""


#: What the live desktop looks like from outside: how many Superbar buttons, and whether the
#: terminal has reached a prompt. A command typed before the prompt is a command the shell never
#: sees, and the symptom is an empty band rather than an error.
LIVE_STATE = """(() => {
  const shell = globalThis.M14 && globalThis.M14.shell
  return {
    buttons: shell ? shell.report().buttons : 0,
    screen: (document.querySelector('.terminal') || {}).textContent || '',
  }
})()"""


#: How many Superbar buttons the band must hold. TWO: `n` buttons at the 42 px floor with 3 px gaps
#: is `n*42 + (n-1)*3`, so two is an 87 px content floor, and the viewport search below finds a
#: width where the band is narrower than that and still wider than one button.
WANT_BUTTONS = 2


def stage_more_programs(page) -> dict:
    """Start one more program at the live desktop's real prompt, and wait for its button.

    REAL KEYS, through Chrome's own input pipeline — `bench/m12-governor/shell.py`'s own gesture,
    and the reason these numbers are the product's rather than a fixture's: every button here came
    from a `win-create` and is grouped by program the way a reader's would be.

    `winopen -n 2` SO ONE BUTTON CARRIES A GROUP COUNT, which is the widest button the bar draws.
    """
    deadline = time.time() + 60
    state = {}
    while time.time() < deadline:
        state = page.evaluate(LIVE_STATE)
        if state["buttons"] >= 1 and "$" in (state["screen"] or ""):
            break
        time.sleep(0.25)
    else:
        raise SystemExit(f"no prompt on the live desktop: {state}")
    # BACKGROUNDED. `winopen` holds its windows open until they are closed, so in the FOREGROUND it
    # never returns a prompt.
    #
    # AND IT IS THE ONLY COMMAND TYPED, which was learned rather than chosen: a `winopen` window
    # TAKES THE KEYBOARD when it opens, so a second command typed after it went into that window
    # instead of the shell — the terminal's own log shows `key 'f'`, `key 'i'`, `key 'l'`... against
    # `fd 4 (win 4)`. Two buttons is enough because the viewport is searched rather than fixed.
    page.type_keys("winopen -n 2 &\n")
    settle(page, 800)
    deadline = time.time() + 40
    while time.time() < deadline:
        state = page.evaluate(LIVE_STATE)
        if state["buttons"] >= WANT_BUTTONS:
            break
        time.sleep(0.25)
    settle(page, 400)
    if state["buttons"] < WANT_BUTTONS:
        # THE SCREEN GOES WITH THE REFUSAL. A program that refused printed WHY at the prompt, and a
        # harness that reported only the count would make a readable error unreadable.
        raise SystemExit(f"only {state['buttons']} button(s) came up; the band cannot overflow a "
                         f"viewport this wide with fewer than {WANT_BUTTONS}\n"
                         f"the terminal said:\n{(state['screen'] or '')[-900:]}")
    return {"buttons": state["buttons"]}


def narrow_until_overflow(page) -> dict:
    """Step the viewport down until the band overflows AND still holds one button, and report the
    width that produced it.

    THE SEARCH IS THE MEASUREMENT. A fixed width would be a constant from this machine's clock
    rendering, and the gap it has to land in is about ten pixels wide — see `WIDE_W` above. A run
    that finds no such width REFUSES rather than scoring the clauses against a band that was never
    in the state they are about.
    """
    tried = []
    width = WIDE_W
    while width >= MIN_W:
        page.emulate_device(width=width, height=NARROW_H, scale_factor=1, mobile=False)
        settle(page, 220)
        band = page.evaluate(REPORT)["band"]
        tried.append({"w": width, "clientW": band["clientW"], "over": band["over"]})
        if band["over"] > 1 and band["clientW"] >= band["minBtnW"]:
            return {"width": width, "tried": tried}
        width -= STEP_W
    raise SystemExit("no viewport between %d and %d left the band overflowing and wider than one "
                     "button: %s" % (MIN_W, WIDE_W, json.dumps(tried)))


def run(headed: bool) -> dict:
    httpd, port = serve_repo()
    out: dict = {"delta": WHEEL_DELTA, "height": NARROW_H}
    args = () if headed else ("--headless=new",)
    try:
        with cdp.Browser(extra_args=args) as browser:
            page = browser.page()
            # dpr 1 AND NOT MOBILE. A mobile viewport would add a visual-viewport layer this
            # measurement has no use for, and dpr 1 keeps every figure in CSS px with no ratio to
            # restore — the error that cost M16 and nearly cost M17.
            page.emulate_device(width=WIDE_W, height=NARROW_H, scale_factor=1, mobile=False)
            page.navigate(f"http://127.0.0.1:{port}/www/m14.html")
            deadline = time.time() + 90
            while time.time() < deadline:
                state = page.evaluate(
                    "(() => ({ s: String(globalThis.M14.state||''),"
                    " shell: Boolean(globalThis.M14.shell) }))()")
                if state and state.get("shell"):
                    break
                time.sleep(0.4)
            else:
                raise SystemExit("the m14 desktop never published a shell")
            settle(page, 400)

            # A SECOND PROGRAM, STARTED AT THE REAL PROMPT. The live desktop stages `term` alone,
            # and one button never overflows anything — so the state this probe is about does not
            # exist until a second program is running. Typing it is what makes these numbers the
            # product's rather than a fixture's: the buttons come from `win-create` and are grouped
            # by program the way a reader's would be.
            out["staged"] = stage_more_programs(page)
            # ...AND THEN THE WIDTH IS FOUND, after the buttons exist: the content floor is what the
            # search is looking for a band narrower than.
            out["search"] = narrow_until_overflow(page)

            out["isolated"] = page.evaluate("self.crossOriginIsolated === true")
            report = page.evaluate(REPORT)
            out["band"] = report["band"]
            out["slots"] = report["slots"]
            out["accels"] = {"chords": report["chords"], "onButtons": report["slotAccels"]}
            rect = page.evaluate(BAND_RECT)
            if rect is None:
                raise SystemExit("no [data-band] in the document")
            cx, cy = rect["x"] + rect["w"] / 2, rect["y"] + rect["h"] / 2

            # 1. WHICH AXIS. Reset between the two, or the second reading inherits the first.
            for name, dx, dy in (("deltaX", WHEEL_DELTA, 0), ("deltaY", 0, WHEEL_DELTA)):
                page.evaluate("document.querySelector('[data-band]').scrollLeft = 0")
                wheel(page, cx, cy, dx, dy)
                settle(page)
                out[f"wheel_{name}"] = page.evaluate(
                    "document.querySelector('[data-band]').scrollLeft")

            # 2. THE CHEVRON, which is the gesture a plain vertical-wheel mouse has.
            page.evaluate("document.querySelector('[data-band]').scrollLeft = 0")
            chev = page.evaluate(
                "(() => { const c = document.querySelector('[data-band-chev=\"next\"]')"
                " ; if (!c || c.hidden) return null"
                " ; const r = c.getBoundingClientRect()"
                " ; return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }"
                " })()")
            out["chevron_shown"] = chev is not None
            if chev:
                page.call("Input.dispatchMouseEvent", type="mousePressed", x=chev["x"],
                          y=chev["y"], button="left", buttons=1, clickCount=1)
                page.call("Input.dispatchMouseEvent", type="mouseReleased", x=chev["x"],
                          y=chev["y"], button="left", buttons=0, clickCount=1)
                settle(page)
                out["chevron_scrollLeft"] = page.evaluate(
                    "document.querySelector('[data-band]').scrollLeft")

            # 3. THE LAST BUTTON, REVEALED AND HIT-TESTED. `revealSlot` is the shell's own, so this
            #    reads what a check would read.
            out["reveal_last"] = page.evaluate(
                "(() => { const s = globalThis.M14.shell"
                " ; return s.revealSlot(s.report().slots.length) })()")

            # 4. AND THE CONTROL'S WORLD. `overflow: hidden` restored: which of the three dies?
            out["clipped_overflowX"] = page.evaluate(ARM_CLIPS, await_promise=True)
            page.evaluate("document.querySelector('[data-band]').scrollLeft = 0")
            wheel(page, cx, cy, WHEEL_DELTA, 0)
            settle(page)
            out["clipped_wheel_deltaX"] = page.evaluate(
                "document.querySelector('[data-band]').scrollLeft")
            page.evaluate("document.querySelector('[data-band]').scrollLeft = 0")
            out["clipped_reveal_last"] = page.evaluate(
                "(() => { const s = globalThis.M14.shell"
                " ; return s.revealSlot(s.report().slots.length) })()")
            page.evaluate(DISARM_CLIPS, await_promise=True)
    finally:
        httpd.shutdown()
    return out


def score(out: dict) -> list[tuple[str, bool, str]]:
    """One clause per row, each naming what it read. A clause that cannot be read from `out` is
    FALSE and says so — a missing figure must not score as a pass."""
    band = out.get("band") or {}
    reveal = out.get("reveal_last") or {}
    clipped = out.get("clipped_reveal_last") or {}
    return [
        ("isolated", out.get("isolated") is True,
         f"crossOriginIsolated={out.get('isolated')}"),
        ("a viewport exists where the band overflows and still holds a button",
         bool((out.get("search") or {}).get("width")),
         f"found at {(out.get('search') or {}).get('width')} CSS px wide, after "
         f"{len((out.get('search') or {}).get('tried') or [])} step(s)"),
        ("the band overflows at this width", (band.get("over") or 0) > 1,
         f"scrollW={band.get('scrollW')} clientW={band.get('clientW')} over={band.get('over')}"),
        ("it is a scroller and not a clip", band.get("overflowX") == "auto",
         f"computed overflow-x={band.get('overflowX')!r}"),
        ("a deltaX wheel moves it", (out.get("wheel_deltaX") or 0) > 0,
         f"scrollLeft={out.get('wheel_deltaX')} after deltaX={WHEEL_DELTA}"),
        ("a deltaY wheel does NOT", (out.get("wheel_deltaY") or 0) == 0,
         f"scrollLeft={out.get('wheel_deltaY')} after deltaY={WHEEL_DELTA} — so a check that "
         "dispatches deltaY asserts nothing"),
        ("the chevron is shown while it overflows", out.get("chevron_shown") is True,
         f"shown={out.get('chevron_shown')}"),
        ("a real click on it scrolls", (out.get("chevron_scrollLeft") or 0) > 0,
         f"scrollLeft={out.get('chevron_scrollLeft')}"),
        ("the last button is reachable", reveal.get("inView") is True
         and reveal.get("reachable") is True,
         f"inView={reveal.get('inView')} hitTest={reveal.get('reachable')} "
         f"scrollLeft={reveal.get('scrollLeft')}"),
        ("the menus publish the real accelerator",
         (out.get("accels") or {}).get("chords", {}).get("next") == "Alt+`"
         and (out.get("accels") or {}).get("chords", {}).get("prev") == "Alt+Shift+`",
         json.dumps((out.get("accels") or {}).get("chords"))),
        # AND WHAT THE CONTROL TAKES AWAY, which is narrower than it looks.
        ("band-clips makes it a clip", out.get("clipped_overflowX") == "hidden",
         f"computed overflow-x={out.get('clipped_overflowX')!r}"),
        ("band-clips KILLS the wheel", (out.get("clipped_wheel_deltaX") or 0) == 0,
         f"scrollLeft={out.get('clipped_wheel_deltaX')} after deltaX={WHEEL_DELTA}"),
        ("band-clips does NOT kill a programmatic reveal", clipped.get("inView") is True,
         f"inView={clipped.get('inView')} scrollLeft={clipped.get('scrollLeft')} — so the "
         "control's Expect(failed=) must name the WHEEL clause, not reachability"),
    ]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--headed", action="store_true", help="show the browser window")
    ap.add_argument("--prove-failure", action="store_true",
                    help="run the two controls; the run MUST report both firing")
    ap.add_argument("--json", type=pathlib.Path, help="write the raw readings here")
    opts = ap.parse_args(argv)

    out = run(opts.headed)
    rows = score(out)
    for name, ok, why in rows:
        print(f"[{'ok  ' if ok else 'BAD '}] {name}\n        {why}")
    if opts.json:
        opts.json.write_text(json.dumps(out, indent=1))
        print(f"raw: {opts.json}")
    bad = [name for name, ok, _ in rows if not ok]
    if opts.prove_failure:
        # THE PROOF IS THAT THE TWO CONTROL CLAUSES MOVED. Under `band-clips` the wheel clause reads
        # 0 and the reveal clause still passes; a run where either flipped would mean the control
        # has a different world than the one this probe recorded.
        wheel_dead = (out.get("clipped_wheel_deltaX") or 0) == 0
        reveal_alive = (out.get("clipped_reveal_last") or {}).get("inView") is True
        print(f"\nprove-failure: wheel died={wheel_dead} reveal survived={reveal_alive}")
        return 0 if (wheel_dead and reveal_alive) else 1
    print(f"\n{len(rows) - len(bad)} of {len(rows)} clause(s) ok")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
