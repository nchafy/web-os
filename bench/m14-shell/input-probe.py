#!/usr/bin/env python3
"""WHICH DOM EVENTS `Input.dispatchMouseEvent` ACTUALLY DELIVERS, measured rather than assumed.

    python3 bench/m14-shell/input-probe.py

M14's shell is driven by gestures a check sends over CDP, and two of them cost a run each because
the DOM event a hand produces is not the DOM event a driver produces:

  - a RIGHT press delivers `pointerdown` with `button: 2`, and whether it also delivers
    `contextmenu` is the question the jump list's route depends on
  - a double-click delivered as two press/release pairs with `clickCount` 1 then 2 delivers
    `dblclick` — but AT WHICH ELEMENT, once a `pointerdown` handler has taken a pointer capture, is
    what decided whether a desktop icon could be opened at all

So this page records every event it receives, with its `target`, its `button` and whether a capture
was active, and prints the table. It asserts NOTHING and scores nothing: it is a measurement, and
`scripts/check.py --only m14` is the gate. Exit code 0 whenever the page answered.

The findings, measured on Chrome 157 / macOS 26.7.2 — re-run it rather than trusting this comment,
which is the point of it being a script:

    gesture                 events delivered (target in brackets)
    left click              pointerdown pointerup mouseup click            [inner]
    right click             pointerdown(b2) mousedown(b2) CONTEXTMENU ...  [inner]
    ctrl + left click       pointerdown mousedown CONTEXTMENU ... and NO CLICK
    meta + left click       pointerdown ... click                          [inner]
    dblclick                ... click click dblclick                       [inner]
    dblclick, with capture  ... click click dblclick                       [the CAPTURING element]

Three of those decided code:

  1. A right press DOES deliver `contextmenu`, and it also delivers `pointerdown` with
     `button === 2` one event earlier. `src/wm/taskbar.mjs` opens its jump list on the pointerdown,
     which is Windows 7's own timing, and refuses the browser's menu on the contextmenu.
  2. **On macOS a Ctrl-click IS the secondary click** — it delivers `contextmenu` and NO `click` at
     all — so the desktop's multi-select gesture is driven with META, which `src/wm/desktop.mjs`
     accepts beside Ctrl.
  3. Under a pointer capture, the compatibility mouse events are dispatched at the CAPTURING
     element rather than at what is under the pointer. A desktop icon's press takes a capture so a
     drag can leave the view, so `dblclick.target` is the icon VIEW — which is why
     `src/wm/desktop.mjs` falls back to a coordinate hit test.

And one of them corrected a hypothesis this probe was written to confirm: the jump list's real
defect was in the DRIVER, which sent a left button for a gesture named `rightclick`. The measurement
is what separated "the browser does not deliver this" from "we never sent it".
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import tempfile
import time

REPO = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))

import cdp  # noqa: E402  (the path has to be set up first)

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>input probe</title>
<style>
  body { margin:0; font:13px/1.4 ui-monospace, monospace; background:#101820; color:#dde }
  #target { position:absolute; left:40px; top:60px; width:160px; height:60px;
            background:#2b6ca8; color:#fff; display:grid; place-items:center }
  #inner { width:80px; height:28px; background:#8fd0f5; color:#07131f;
           display:grid; place-items:center }
</style></head>
<body>
<div id="target" data-el="target"><div id="inner" data-el="inner">inner</div></div>
<script>
  globalThis.P = { log: [], capture: false }
  const el = document.getElementById('target')
  const record = (e) => {
    globalThis.P.log.push({
      type: e.type,
      target: e.target && e.target.dataset ? (e.target.dataset.el || e.target.id || '') : '',
      button: e.button === undefined ? null : e.button,
      buttons: e.buttons === undefined ? null : e.buttons,
      detail: e.detail === undefined ? null : e.detail,
      ctrl: e.ctrlKey === true, meta: e.metaKey === true,
    })
  }
  for (const kind of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick',
    'contextmenu']) {
    el.addEventListener(kind, (e) => {
      record(e)
      // THE CAPTURE IS THE VARIABLE. With it on, the compatibility mouse events are dispatched at
      // the capturing element rather than at what is under the pointer — which is the behaviour
      // M14's icon view had to be written against.
      if (kind === 'pointerdown' && globalThis.P.capture) {
        try { el.setPointerCapture(e.pointerId) } catch (x) { globalThis.P.captureError = x.name }
      }
    })
  }
</script>
</body></html>
"""


def gestures(page, at):
    """Each gesture, with the log cleared before it, so the rows are per gesture."""
    out = {}

    def run(name, fn):
        page.evaluate("globalThis.P.log = []")
        fn()
        time.sleep(0.15)
        out[name] = json.loads(page.evaluate("JSON.stringify(globalThis.P.log)") or "[]")

    def press(button, buttons, clicks):
        page.call("Input.dispatchMouseEvent", type="mousePressed", x=at["x"], y=at["y"],
                  button=button, buttons=buttons, clickCount=clicks)

    def release(button, clicks):
        page.call("Input.dispatchMouseEvent", type="mouseReleased", x=at["x"], y=at["y"],
                  button=button, buttons=0, clickCount=clicks)

    run("left-click", lambda: (press("left", 1, 1), release("left", 1)))
    run("right-click", lambda: (press("right", 2, 1), release("right", 1)))
    run("ctrl-left-click", lambda: (
        page.call("Input.dispatchMouseEvent", type="mousePressed", x=at["x"], y=at["y"],
                  button="left", buttons=1, clickCount=1, modifiers=2),
        page.call("Input.dispatchMouseEvent", type="mouseReleased", x=at["x"], y=at["y"],
                  button="left", buttons=0, clickCount=1, modifiers=2)))
    run("meta-left-click", lambda: (
        page.call("Input.dispatchMouseEvent", type="mousePressed", x=at["x"], y=at["y"],
                  button="left", buttons=1, clickCount=1, modifiers=4),
        page.call("Input.dispatchMouseEvent", type="mouseReleased", x=at["x"], y=at["y"],
                  button="left", buttons=0, clickCount=1, modifiers=4)))
    run("dblclick", lambda: (press("left", 1, 1), release("left", 1),
                             press("left", 1, 2), release("left", 2)))
    page.evaluate("globalThis.P.capture = true")
    run("dblclick-with-capture", lambda: (press("left", 1, 1), release("left", 1),
                                          press("left", 1, 2), release("left", 2)))
    page.evaluate("globalThis.P.capture = false")
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8714)
    args = ap.parse_args(argv)

    # The probe page goes in a temp directory and is served from there: nothing here needs the
    # repo, COOP/COEP or a kernel, and a page in `www/` would be a page the suite has to account for.
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        (root / "probe.html").write_text(PAGE, encoding="utf-8")
        server = subprocess.Popen(
            [sys.executable, "-m", "http.server", str(args.port)],
            cwd=str(root), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            time.sleep(0.7)
            url = "http://127.0.0.1:%d/probe.html" % args.port
            print("url      %s" % url)
            with cdp.Browser() as browser:
                page = browser.page()
                page.navigate(url)
                # The INNER element's centre, so a retargeted event is visible as a changed target.
                at = json.loads(page.evaluate(
                    "(() => { const r = document.getElementById('inner')"
                    ".getBoundingClientRect(); return JSON.stringify("
                    "{x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)}) })()"))
                print("point    %s" % at)
                table = gestures(page, at)
        finally:
            server.terminate()

    print()
    for name, rows in table.items():
        shown = " ".join(
            "%s[%s%s]" % (r["type"], r["target"],
                          "" if r["button"] in (None, 0) else ",b%d" % r["button"])
            for r in rows)
        print("%-24s %s" % (name, shown or "<nothing>"))
    print()
    right = table.get("right-click", [])
    print("contextmenu from a right press: %s"
          % ("yes" if any(r["type"] == "contextmenu" for r in right) else "NO"))
    capture = table.get("dblclick-with-capture", [])
    targets = {r["target"] for r in capture if r["type"] == "dblclick"}
    print("dblclick target under capture:  %s" % (", ".join(sorted(targets)) or "<no dblclick>"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
