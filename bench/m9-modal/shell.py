#!/usr/bin/env python3
"""Run `editor` FROM THE SHELL, press its X, and prove it did not close.

    python3 bench/m9-modal/shell.py
    python3 bench/m9-modal/shell.py --cmd "editor -a"

WHY THIS EXISTS, as `bench/m8-surface/shell.py` says for `paint`: `scripts/check.py --only m9`
spawns `editor` BY URL, which is the page's supervisor path (`docs/DECISIONS.md` D18) — not the
path a person takes. A user opens the desktop, types `editor`, and the shell resolves it through
the mount table while `exec` loads it from `/usr/bin`. Those are different loaders with different
refusals, and M6's own history is the reason to care.

It asserts the thing a person would check first: THE X DOES NOT CLOSE THE WINDOW. The screenshot is
evidence a reader looks at.

**`--clean` IS THE NEGATIVE CONTROL, and it is the same click.** Nothing is typed, so the editor's
buffer is clean and its own contract says a close with nothing to save is honoured at once — so the
window MUST go away. Without that run, "the window is still there" could be a click that never
landed, and the assertion would pass against a close box that does nothing at all.
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

REPO = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))

import cdp    # noqa: E402
import serve  # noqa: E402

#: What the page looks like, as the page itself can answer it: how many frames, their titles, and
#: which of them the kernel has on top. One evaluate, so the three cannot be read a moment apart.
STATE = """(() => {
  const wins = [...document.querySelectorAll('.window')]
  return JSON.stringify({
    frames: wins.length,
    titles: wins.map((w) => (w.querySelector('h2') || {}).textContent || ''),
    depth: wins.map((w) => Number(w.dataset.depth || -1)),
    modes: wins.map((w) => Number(w.dataset.windowMode || 0)),
  })
})()"""


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cmd", default="editor", help="the command line to type at the prompt")
    ap.add_argument("--clean", action="store_true",
                    help="THE NEGATIVE CONTROL: type nothing, so the X must CLOSE the window")
    ap.add_argument("--port", type=int, default=0,
                    help="0 (the default) asks the OS for a free port; a fixed one can collide")
    ap.add_argument("--out", default="")
    args = ap.parse_args(argv)
    if not args.out:
        args.out = str(REPO / "bench" / "m9-modal"
                       / ("shell-clean.png" if args.clean else "shell.png"))

    # THE SERVER IS BOUND HERE, ON A PORT THE OS PICKS. It used to spawn `scripts/serve.py` on a
    # FIXED port with both streams sent to DEVNULL, so a port already in use arrived as a blank
    # page with no message - and `bench/m10-data/shell.py` and `bench/shell-reports/repro.py` both
    # claimed 8717, which is the collision stated as a fact. `serve.Server` is the same COOP/COEP
    # handler `scripts/serve.py` installs; in process there is no second interpreter whose failure
    # could go unread. This is the form `bench/m11-glass`, `m12-governor` and `m14-shell` already
    # use.
    os.chdir(REPO)
    httpd = serve.Server(("127.0.0.1", args.port), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        time.sleep(0.7)
        url = "http://127.0.0.1:%d/www/m9.html?live=1" % port
        print("url      %s" % url)
        with cdp.Browser() as browser:
            page = browser.page()
            page.navigate(url)
            deadline = time.time() + 90
            prompted = False
            while time.time() < deadline:
                state = page.evaluate(
                    "(() => { const M = globalThis.M9 || {}; "
                    "if (M.state === 'error' || M.state === 'aborted') return 'dead'; "
                    "const t = document.querySelector('.terminal'); "
                    "return t && /\\$ /.test(t.textContent) ? 'prompt' : '' })()")
                if state == "dead":
                    print("the page died: %s"
                          % page.evaluate("String(globalThis.M9.why || '')"))
                    return 1
                if state == "prompt":
                    prompted = True
                    break
                time.sleep(0.25)
            if not prompted:
                print("no prompt in 90 s")
                return 1
            if page.evaluate(
                    "(() => { const t = document.querySelector('.terminal');"
                    " if (!t) return 'no terminal'; t.focus();"
                    " return document.activeElement === t ? '' : 'refused focus' })()"):
                print("could not focus the terminal")
                return 1
            page.type_keys(args.cmd + "\n")
            # THE EDITOR AND ITS PALETTE, which is three frames with the terminal.
            opened = ""
            deadline = time.time() + 40
            while time.time() < deadline:
                opened = page.evaluate(STATE)
                if opened and json.loads(opened)["frames"] >= 3:
                    break
                time.sleep(0.25)
            if not opened or json.loads(opened)["frames"] < 3:
                print("the editor did not open: %s" % opened)
                return 1
            before = json.loads(opened)
            print("opened   %s" % json.dumps(before))

            # TYPE INTO THE EDITOR, so its buffer is dirty and the close will ask. Under `--clean`
            # this is SKIPPED and nothing else changes, which is what makes the two runs a control
            # pair rather than two different tests.
            if not args.clean:
                page.evaluate(
                    "(() => { const t = [...document.querySelectorAll('.window')]"
                    ".find((w) => (w.querySelector('h2')||{}).textContent.includes('notes'));"
                    " const el = t && t.querySelector('.terminal'); if (el) el.focus();"
                    " return !!el })()")
                page.type_keys("hello")
                time.sleep(0.4)

            # AND PRESS THE X. A real click on the real close box, at the coordinates the page
            # reports for it.
            box = page.evaluate(
                "(() => { const t = [...document.querySelectorAll('.window')]"
                ".find((w) => (w.querySelector('h2')||{}).textContent.includes('notes'));"
                " const b = t && t.querySelector('.window-close'); if (!b) return '';"
                " const r = b.getBoundingClientRect();"
                " return JSON.stringify({x: Math.round(r.left + r.width/2),"
                " y: Math.round(r.top + r.height/2)}) })()")
            if not box:
                print("no close box on the editor's frame")
                return 1
            at = json.loads(box)
            page.call("Input.dispatchMouseEvent", type="mousePressed", x=at["x"], y=at["y"],
                      button="left", buttons=1, clickCount=1)
            page.call("Input.dispatchMouseEvent", type="mouseReleased", x=at["x"], y=at["y"],
                      button="left", buttons=0, clickCount=1)

            asked = {}
            deadline = time.time() + 20
            while time.time() < deadline:
                asked = json.loads(page.evaluate(STATE))
                done = (not any("notes" in t for t in asked["titles"]) if args.clean
                        else any("Save changes" in t for t in asked["titles"]))
                if done:
                    break
                time.sleep(0.25)
            shot = page.call("Page.captureScreenshot", format="png")
            pathlib.Path(args.out).write_bytes(base64.b64decode(shot["data"]))
            print("after X  %s" % json.dumps(asked))
            print("png      %s" % args.out)

            if args.clean:
                # THE CONTROL. A clean buffer is closed at once, and the palette goes with it
                # through M7's cascade — so if the frame is still up, the click never landed and
                # the headline run proves nothing.
                if any("notes" in t for t in asked["titles"]):
                    print("CONTROL FAILED: the X did not close a CLEAN editor either, so the "
                          "headline run's 'still there' says nothing about the close contract")
                    return 1
                if any("Save changes" in t for t in asked["titles"]):
                    print("CONTROL FAILED: a clean buffer asked anyway")
                    return 1
                print("control ok: the SAME click on a CLEAN buffer closed the editor and its "
                      "palette with it — %d frame(s) left: %s"
                      % (asked["frames"], json.dumps(asked["titles"])))
                return 0

            if not any("Save changes" in t for t in asked.get("titles", [])):
                print("THE X DID NOT ASK: no dialog appeared after pressing it")
                return 1
            if not any("notes" in t for t in asked["titles"]):
                print("THE X CLOSED THE WINDOW, which is the whole thing M9 forbids: a close is a "
                      "REQUEST the program may refuse (constraint 228)")
                return 1
            # AND THE DIALOG IS ON TOP OF ITS OWNER, read out of the depth the kernel sent.
            depth = dict(zip(asked["titles"], asked["depth"]))
            dialog = next((t for t in asked["titles"] if "Save changes" in t), "")
            editor = next((t for t in asked["titles"] if "notes" in t), "")
            if depth.get(dialog, -1) <= depth.get(editor, 0):
                print("the dialog is NOT above the window that owns it: %s" % json.dumps(depth))
                return 1
            print("ok: `%s` from the SHELL opened an editor, and its X asked instead of closing — "
                  "the dialog is at depth %d over an editor at %d, and the editor is still there"
                  % (args.cmd, depth[dialog], depth[editor]))
        return 0
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
