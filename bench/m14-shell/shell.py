#!/usr/bin/env python3
"""USE THE WINDOWS 7 DESKTOP, at a real prompt, with a real mouse — and keep the picture.

    python3 bench/m14-shell/shell.py                  # the desktop, used, and a screenshot
    python3 bench/m14-shell/shell.py --headed         # ...in a window you can take over
    python3 bench/m14-shell/shell.py --menu           # leave the start menu OPEN in the shot
    python3 bench/m14-shell/shell.py --jump           # ...or a jump list

WHY THIS EXISTS, and it is not decoration. `scripts/check.py --only m14` drives the PROOFS path,
which stages its own windows and arms its own fixtures. The LIVE desktop — `www/m14.html`, the
BARE url, because the product is what the obvious address gives (constraint 283) —
is a different path with no assertions on it, and that is exactly where this project has been
bitten before: M12's live desktop never armed its governor and its own log told the reader to watch
something that could not happen, M11's End Process button was offered on every healthy window the
moment the skin existed, and both were found by a person opening the page rather than by a check.

So this boots the live desktop, types at the shell, opens the Start menu, hovers a taskbar button
for its thumbnail, snaps a window to the left edge with a real drag, and photographs the result. It
asserts the few things that would be invisible in a picture — that the bar is there, that the icons
came from a process, that a snap really changed the kernel's state — and leaves the AESTHETIC to
whoever looks at the PNG, which is the honest division when the claim is "this looks like Windows
7".
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import pathlib
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import cdp          # noqa: E402
import serve        # noqa: E402

#: One evaluate, so what is on the bar, on the desktop and in the kernel cannot be read a moment
#: apart. Everything here is read out of the DOM the page rendered — `data-state` is what
#: `src/wm/window.mjs` publishes from the kernel's own `win-show`, so these are the kernel's facts
#: as a reader sees them.
STATE = """(() => {
  const win = [...document.querySelectorAll('.window')]
  const title = (x) => ((x.querySelector('h2') || {}).textContent || '').trim()
  const bar = document.querySelector('.taskbar')
  const buttons = [...document.querySelectorAll('[data-task-btn]')]
  const icons = [...document.querySelectorAll('.desk-icon')]
  return {
    windows: win.map((x) => ({
      title: title(x), state: Number(x.dataset.state || 0),
      role: Number(x.dataset.role || 0), depth: Number(x.dataset.depth ?? -1),
      hidden: x.hidden === true,
      box: { x: Number(x.dataset.x), y: Number(x.dataset.y),
             w: Number(x.dataset.w), h: Number(x.dataset.h) },
    })),
    bar: bar ? Math.round(bar.getBoundingClientRect().height) : 0,
    buttons: buttons.map((b) => ({
      key: b.dataset.taskBtn, wins: b.dataset.wins, state: b.dataset.state,
      label: (b.querySelector('.task-label') || {}).textContent || '',
    })),
    icons: icons.map((c) => (c.querySelector('.desk-label') || {}).textContent || ''),
    clock: (document.querySelector('.clock') || {}).textContent || '',
    popup: (document.querySelector('.shell-popup') || {}).dataset?.popup || '0',
    popupRows: [...document.querySelectorAll('.shell-popup .shell-label')]
      .map((n) => n.textContent),
    screen: (document.querySelector('.terminal') || {}).textContent || '',
  }
})()"""

#: Where the terminal is, so a click can give it the keyboard before anything is typed.
TERMINAL_AT = """(() => {
  const t = document.querySelector('.terminal')
  if (!t) return null
  const r = t.getBoundingClientRect()
  return { x: Math.round(r.left + 30), y: Math.round(r.top + 20) }
})()"""

#: A caption to drag, and the desktop's own left edge to drag it to.
SNAP_PLAN = """(() => {
  const win = [...document.querySelectorAll('.window')]
    .filter((x) => x.dataset.role !== '1')
  if (!win.length) return null
  const top = win.reduce((a, b) =>
    Number(b.dataset.depth || 0) > Number(a.dataset.depth || 0) ? b : a)
  const bar = top.querySelector('.window-title').getBoundingClientRect()
  const desk = document.getElementById('desktop').getBoundingClientRect()
  return {
    title: ((top.querySelector('h2') || {}).textContent || '').trim(),
    from: { x: Math.round(bar.left + 10), y: Math.round(bar.top + bar.height / 2) },
    to: { x: Math.round(desk.left + 1), y: Math.round(desk.top + 200) },
  }
})()"""


def at(page, expr):
    raw = page.evaluate(expr)
    return json.loads(raw) if isinstance(raw, str) else raw


def click(page, point, button="left", clicks=1, modifiers=0):
    page.call("Input.dispatchMouseEvent", type="mousePressed", x=point["x"], y=point["y"],
              button=button, buttons=1 if button == "left" else 2, clickCount=clicks,
              modifiers=modifiers)
    page.call("Input.dispatchMouseEvent", type="mouseReleased", x=point["x"], y=point["y"],
              button=button, buttons=0, clickCount=clicks, modifiers=modifiers)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cmd", default="ls /usr/bin")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--menu", action="store_true", help="leave the Start menu open in the shot")
    ap.add_argument("--jump", action="store_true", help="leave a jump list open in the shot")
    ap.add_argument("--no-snap", action="store_true", help="skip the snap drag")
    ap.add_argument("--dpr", type=float, default=2.0)
    ap.add_argument("--shot", default=str(HERE / "shell.png"))
    ap.add_argument("--hold", type=float, default=0.0,
                    help="seconds to leave the browser open at the end")
    args = ap.parse_args(argv[1:])

    os.chdir(REPO)
    httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/www/m14.html?live=1" % port
    print("m14 shell  %s" % url, file=sys.stderr)

    bad: list[str] = []
    try:
        with cdp.Browser(extra_args=("--window-size=1340,980",) if args.headed else (),
                         headless=not args.headed) as browser:
            page = browser.page()
            page.emulate_device(width=1320, height=900, scale_factor=args.dpr, mobile=False)
            page.navigate(url, timeout=60)

            # THE PROMPT AND THE ICONS, not a timer: a desktop whose process has not published yet
            # is a desktop with nothing on it, and a shell that has not printed a prompt cannot be
            # typed at.
            deadline = time.time() + 90
            state = {}
            while time.time() < deadline:
                state = at(page, STATE)
                if state["icons"] and "$" in state["screen"]:
                    break
                time.sleep(0.3)
            if not state.get("icons"):
                bad.append("the desktop published no icons: %s" % state)
            if "$" not in state.get("screen", ""):
                bad.append("no prompt appeared in the terminal")

            # ---- TYPE AT IT, which is what a reader does first ----
            spot = at(page, TERMINAL_AT)
            if spot:
                click(page, spot)
                page.type_keys(args.cmd + "\n")
                time.sleep(1.2)
            after_typing = at(page, STATE)
            if args.cmd.split()[0] not in after_typing["screen"]:
                bad.append("the command never echoed: %r" % after_typing["screen"][-200:])

            # ---- SNAP THE TOP WINDOW TO THE LEFT EDGE, with a real drag ----
            snapped = None
            if not args.no_snap:
                plan = at(page, SNAP_PLAN)
                if plan:
                    page.call("Input.dispatchMouseEvent", type="mousePressed",
                              x=plan["from"]["x"], y=plan["from"]["y"], button="left",
                              buttons=1, clickCount=1)
                    for i in range(1, 9):
                        page.call(
                            "Input.dispatchMouseEvent", type="mouseMoved",
                            x=plan["from"]["x"] + (plan["to"]["x"] - plan["from"]["x"]) * i // 8,
                            y=plan["from"]["y"] + (plan["to"]["y"] - plan["from"]["y"]) * i // 8,
                            button="left", buttons=1)
                    page.call("Input.dispatchMouseEvent", type="mouseReleased",
                              x=plan["to"]["x"], y=plan["to"]["y"], button="left",
                              buttons=0, clickCount=1)
                    time.sleep(0.8)
                    now = at(page, STATE)
                    snapped = next((w for w in now["windows"] if w["title"] == plan["title"]),
                                   None)
                    # WST_SNAP_L is 3 (`src/abi.mjs`). A drag to the edge that left the state at 0
                    # is a snap that did not happen.
                    if not snapped or snapped["state"] != 3:
                        bad.append("the drag to the left edge did not snap: %s" % snapped)

            # ---- HOVER A TASKBAR BUTTON for its thumbnail ----
            buttons = at(page, STATE)["buttons"]
            if not buttons:
                bad.append("the taskbar has no buttons")
            else:
                where = at(page, """(() => {
                  const b = document.querySelector('[data-task-btn]')
                  const r = b.getBoundingClientRect()
                  return { x: Math.round(r.left + r.width / 2),
                           y: Math.round(r.top + r.height / 2) }
                })()""")
                page.call("Input.dispatchMouseEvent", type="mouseMoved", x=where["x"],
                          y=where["y"], button="none", buttons=0)
                time.sleep(0.5)
                if args.jump:
                    click(page, where, button="right")
                    time.sleep(0.4)

            # ---- OR THE START MENU ----
            if args.menu:
                orb = at(page, """(() => {
                  const b = document.querySelector('[data-start]')
                  const r = b.getBoundingClientRect()
                  return { x: Math.round(r.left + r.width / 2),
                           y: Math.round(r.top + r.height / 2) }
                })()""")
                click(page, orb)
                time.sleep(0.5)

            # RESTORE BEFORE THE SHOT, THROUGH THE REAL ROUTE. A left-snapped window covers the
            # whole left edge of the desktop, which is the icon column - so a picture taken over
            # the snap shows a desktop with no icons on it, and in this harness's first two
            # screenshots the icons were behind the terminal the whole time.
            #
            # THIS USED TO POKE `style.left` AND `dataset.x` DIRECTLY, and that was a harness
            # lying about its own subject: the kernel still held WST_SNAP_L while the dump below
            # printed {'x': 660, 'y': 30}, a box no snapped window has, so the run reported a
            # state and a geometry belonging to different worlds. `askState(WST_NORMAL)` is the
            # route a caption button takes, so the restore is the kernel's and the two agree.
            restored = page.evaluate("""(() => {
              const host = globalThis.M14 && globalThis.M14.host
              if (!host) return -1
              let n = 0
              for (const entry of host.frames.values()) {
                if (entry.role === 1) continue
                if ((entry.state | 0) === 0) continue
                host.askState(entry.id, 0)
                n += 1
              }
              return n
            })()""")
            if restored == -1:
                bad.append("the page published no host, so nothing could be restored "
                           "through the kernel")
            time.sleep(0.8)
            final = at(page, STATE)
            data = page.call("Page.captureScreenshot", format="png").get("data")
            if data:
                pathlib.Path(args.shot).write_bytes(base64.b64decode(data))
            if args.hold:
                time.sleep(args.hold)
    finally:
        httpd.shutdown()

    print("bar        %d px" % final.get("bar", 0))
    print("icons      %s" % ", ".join(final.get("icons", [])))
    print("buttons    %s" % ", ".join(
        "%s[%s]" % (b["label"] or b["key"], b["state"]) for b in final.get("buttons", [])))
    print("clock      %s" % final.get("clock", "").replace("\n", " "))
    print("popup      %s %s" % (final.get("popup"), final.get("popupRows") or ""))
    for w in final.get("windows", []):
        print("window     %-24s state %d role %d depth %d %s"
              % (w["title"], w["state"], w["role"], w["depth"], w["box"]))
    print("shot       %s" % args.shot)
    if bad:
        print()
        for line in bad:
            print("BAD  %s" % line)
        return 1
    print("\nused the desktop and nothing refused. The picture is the rest of the claim.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
