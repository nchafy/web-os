#!/usr/bin/env python3
"""Type `files` and `imgview` AT A REAL PROMPT, drag a row from one into the other with a real
mouse, and read back what arrived.

    python3 bench/m10-data/shell.py
    python3 bench/m10-data/shell.py --row 2      # readme.txt, which an image view must REFUSE
    python3 bench/m10-data/shell.py --clip       # the clipboard route: `clip copy` then `v`

WHY THIS EXISTS. `scripts/check.py --only m10` spawns both programs BY URL, which is the page's
supervisor path (`docs/DECISIONS.md` D18) and not the path a person takes: a user opens the desktop,
types `files &`, and the shell resolves it through the mount table while `exec` loads it from
`/usr/bin`. Those are different loaders with different refusals — and the two bugs a reader found in
five minutes after M9 was reported done were both on this path, not the other one (constraints 238,
239). `bench/shell-reports/repro.py` is where those live; this is the same discipline applied before
the report rather than after it.

**`--row 2` IS THE NEGATIVE CONTROL, and it is the SAME GESTURE.** The third row is `readme.txt`,
whose format is TEXT — so an image view must refuse it BY NAME and draw no picture. Without that
run, "the bitmap arrived" could be a window that draws whatever it is handed, and the assertion
would pass against a receiver that renders a filename as an image (constraint 247).

The screenshot is evidence a reader looks at.
"""

from __future__ import annotations

import argparse
import base64
import json
import pathlib
import subprocess
import sys
import time

REPO = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))

import cdp  # noqa: E402

#: What the page looks like, as the page can answer it: the frames, their titles, the kernel's
#: depth for each, and which one it says is the drop target. One evaluate, so the four cannot be
#: read a moment apart.
STATE = """(() => {
  const wins = [...document.querySelectorAll('.window')]
  return JSON.stringify({
    frames: wins.length,
    titles: wins.map((w) => (w.querySelector('h2') || {}).textContent || ''),
    depth: wins.map((w) => Number(w.dataset.depth || -1)),
    dropTarget: wins.map((w) => w.dataset.dropTarget === '1'),
    dragImage: !!document.querySelector('[data-drag-image="1"]:not([hidden])'),
  })
})()"""

#: A frame's canvas rectangle, by a word in its title. The canvas is scaled by CSS and positioned
#: by the clamp, so its own rectangle is the only honest source for where to press.
SURFACE_AT = """(() => {
  const w = [...document.querySelectorAll('.window')]
    .find((x) => ((x.querySelector('h2') || {}).textContent || '').includes(%s))
  const c = w && w.querySelector('canvas')
  if (!c) return ''
  const r = c.getBoundingClientRect()
  return JSON.stringify({left: r.left, top: r.top, width: r.width, height: r.height})
})()"""

#: `src/bin/files.mjs`'s own row geometry, in SURFACE pixels. Restated here because this script is
#: outside the process and cannot import it; the row INDEX is what is passed in, and the program's
#: own printed listing is read back to say which file that was — so a drift in these numbers shows
#: up as the wrong file arriving rather than as a silent miss.
ROW_H = 22
ROW_GAP = 4
PAD = 6
SURFACE_W = 240


def row_mid(row: int) -> float:
    return PAD + row * (ROW_H + ROW_GAP) + ROW_H / 2


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--row", type=int, default=1,
                    help="which row to drag: 0 logo.png, 1 logo.rgba (an image), 2 readme.txt "
                         "(THE CONTROL: must be refused)")
    ap.add_argument("--clip", action="store_true",
                    help="the CLIPBOARD route instead: `clip copy` at the prompt, then `v` in "
                         "imgview")
    ap.add_argument("--port", type=int, default=8717)
    ap.add_argument("--out", default="")
    args = ap.parse_args(argv)
    if not args.out:
        name = "shell-clip.png" if args.clip else ("shell-row%d.png" % args.row)
        args.out = str(REPO / "bench" / "m10-data" / name)

    server = subprocess.Popen(
        [sys.executable, str(REPO / "scripts" / "serve.py"), "--port", str(args.port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=str(REPO))
    try:
        time.sleep(0.7)
        url = "http://127.0.0.1:%d/www/m10.html?live=1" % args.port
        print("url      %s" % url)
        with cdp.Browser() as browser:
            page = browser.page()
            page.navigate(url)
            deadline = time.time() + 90
            prompted = False
            while time.time() < deadline:
                state = page.evaluate(
                    "(() => { const M = globalThis.M10 || {}; "
                    "if (M.state === 'error' || M.state === 'aborted') return 'dead'; "
                    "const t = document.querySelector('.terminal'); "
                    "return t && /\\$ /.test(t.textContent) ? 'prompt' : '' })()")
                if state == "dead":
                    print("the page died: %s"
                          % page.evaluate("String(globalThis.M10.why || '')"))
                    return 1
                if state == "prompt":
                    prompted = True
                    break
                time.sleep(0.25)
            if not prompted:
                print("no prompt in 90 s")
                return 1

            def focus_terminal():
                return page.evaluate(
                    "(() => { const t = document.querySelector('.terminal');"
                    " if (!t) return 'no terminal'; t.focus();"
                    " return document.activeElement === t ? '' : 'refused focus' })()")

            if focus_terminal():
                print("could not focus the terminal")
                return 1

            # ---- THE CLIPBOARD ROUTE, which is the one a terminal can reach -----------------
            if args.clip:
                # A DATA FILE IS NOT A PROGRAM, asserted at the prompt because that is where a
                # person would find out. M10 added the first data files to `/usr`, and every row
                # of that mount had been mode 0o555 — so `/usr/share/logo.png` was SPAWNABLE and
                # the kernel would fetch 146 bytes of PNG to evaluate as a module. The `share/`
                # rows are 0o444 now and the shell reports EACCES (constraint 240's neighbour,
                # `src/kernel/providerfs.mjs`).
                page.type_keys("/usr/share/logo.png\n")
                time.sleep(1.0)
                refused = page.evaluate(
                    "document.querySelector('.terminal').textContent.slice(-300)")
                if "EACCES" not in refused:
                    print("A DATA FILE IS EXECUTABLE: `/usr/share/logo.png` at the prompt did not "
                          "answer EACCES.\n%s" % refused)
                    return 1
                print("exec     /usr/share/logo.png -> EACCES, as a data file must")

                page.type_keys("clip copy /usr/share/logo.rgba\n")
                time.sleep(1.2)
                page.type_keys("clip list\n")
                time.sleep(1.2)
                page.type_keys("imgview &\n")
                opened = ""
                deadline = time.time() + 40
                while time.time() < deadline:
                    opened = page.evaluate(STATE)
                    if opened and any("imgview" in t for t in json.loads(opened)["titles"]):
                        break
                    time.sleep(0.25)
                if not opened or not any("imgview" in t for t in json.loads(opened)["titles"]):
                    print("imgview did not open from the shell: %s" % opened)
                    return 1
                # `v` INTO THE IMAGE VIEW's own canvas, which is where its key handler is.
                at = page.evaluate(SURFACE_AT % "'imgview'")
                if not at:
                    print("imgview has no canvas")
                    return 1
                box = json.loads(at)
                page.evaluate(
                    "(() => { const w = [...document.querySelectorAll('.window')]"
                    ".find((x) => ((x.querySelector('h2')||{}).textContent||'')"
                    ".includes('imgview'));"
                    " const c = w && w.querySelector('canvas'); if (c) c.focus();"
                    " return !!c })()")
                page.type_keys("v")
                time.sleep(1.5)
                pixel = page.evaluate(pixel_expr("imgview", box))
                shot = page.call("Page.captureScreenshot", format="png")
                pathlib.Path(args.out).write_bytes(base64.b64decode(shot["data"]))
                print("terminal %s" % page.evaluate(
                    "document.querySelector('.terminal').textContent.slice(-400)"))
                print("pixel    %s" % pixel)
                print("png      %s" % args.out)
                if pixel != "rgba(216,209,74,255)":
                    print("THE PASTE DID NOT DRAW THE LOGO: the corner pixel is %s, not the "
                          "logo's amber. `clip copy` then `v` is the clipboard route a person "
                          "has from a prompt." % pixel)
                    return 1
                print("ok: `clip copy /usr/share/logo.rgba` at a REAL prompt, `v` in a REAL "
                      "window, and the logo is on the canvas")
                return 0

            # ---- THE DRAG ROUTE -------------------------------------------------------------
            page.type_keys("files &\n")
            time.sleep(0.6)
            if focus_terminal():
                print("could not focus the terminal for the second command")
                return 1
            page.type_keys("imgview &\n")
            opened = ""
            deadline = time.time() + 40
            while time.time() < deadline:
                opened = page.evaluate(STATE)
                titles = json.loads(opened)["titles"] if opened else []
                if any("files" in t for t in titles) and any("imgview" in t for t in titles):
                    break
                time.sleep(0.25)
            titles = json.loads(opened)["titles"] if opened else []
            if not (any("files" in t for t in titles) and any("imgview" in t for t in titles)):
                print("the two programs did not both open from the shell: %s" % opened)
                return 1
            print("opened   %s" % json.dumps(json.loads(opened)))
            print("listing  %s" % page.evaluate(
                "document.querySelector('.terminal').textContent.slice(-500)"))

            src = page.evaluate(SURFACE_AT % "'files'")
            dst = page.evaluate(SURFACE_AT % "'imgview'")
            if not src or not dst:
                print("one of the two windows has no canvas: files=%r imgview=%r" % (src, dst))
                return 1
            s = json.loads(src)
            d = json.loads(dst)
            # SURFACE PIXELS TO CLIENT PIXELS, through the canvas's own rectangle — the same
            # arithmetic `Surface.clientAt` does inside the page.
            scale = s["width"] / SURFACE_W
            start = {"x": int(s["left"] + 120 * scale),
                     "y": int(s["top"] + row_mid(args.row) * scale)}
            end = {"x": int(d["left"] + d["width"] / 2), "y": int(d["top"] + d["height"] / 2)}
            print("drag     %s -> %s" % (json.dumps(start), json.dumps(end)))

            # A REAL PRESS, SEVERAL MOVES AND A RELEASE. Several moves because the program's drag
            # threshold is 3 surface pixels and because a single jump is not what a hand does.
            page.call("Input.dispatchMouseEvent", type="mousePressed", x=start["x"], y=start["y"],
                      button="left", buttons=1, clickCount=1)
            mid = {}
            for i in range(1, 13):
                x = start["x"] + (end["x"] - start["x"]) * i // 12
                y = start["y"] + (end["y"] - start["y"]) * i // 12
                page.call("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y,
                          button="left", buttons=1)
                if i == 10:
                    # MID-GESTURE, which is the only moment the drag image and the kernel's own
                    # target highlight exist. A screenshot afterwards cannot show either.
                    mid = json.loads(page.evaluate(STATE))
            page.call("Input.dispatchMouseEvent", type="mouseReleased", x=end["x"], y=end["y"],
                      button="left", buttons=0, clickCount=1)
            time.sleep(1.5)

            after = json.loads(page.evaluate(STATE))
            pixel = page.evaluate(pixel_expr("imgview", d))
            shot = page.call("Page.captureScreenshot", format="png")
            pathlib.Path(args.out).write_bytes(base64.b64decode(shot["data"]))
            print("mid-drag %s" % json.dumps(mid))
            print("after    %s" % json.dumps(after))
            print("pixel    %s" % pixel)
            print("png      %s" % args.out)

            # THE DRAG IMAGE AND THE TARGET HIGHLIGHT, mid-gesture. Both are the page's rendering
            # of what the KERNEL said, so a reader can see the gesture happening.
            if not mid.get("dragImage"):
                print("NO DRAG IMAGE mid-gesture: the page never saw `win-drag`, so no session "
                      "began — nothing below says anything about a drop")
                return 1
            if not any(mid.get("dropTarget") or []):
                print("NO TARGET HIGHLIGHT mid-gesture: the kernel never named a target, so the "
                      "drop had nowhere to go")
                return 1

            if args.row == 2:
                # THE CONTROL. A text file dragged into an image view must be refused BY NAME, and
                # the window must NOT draw a picture of anything.
                if pixel == "rgba(216,209,74,255)":
                    print("CONTROL FAILED: a TEXT file arrived and the image view drew the logo, "
                          "which means it draws whatever it is handed — the headline run proves "
                          "nothing about formats (constraint 247)")
                    return 1
                print("control ok: the SAME gesture with readme.txt drew no image; the corner "
                      "pixel is %s and the refusal is in the log above" % pixel)
                return 0

            if pixel != "rgba(216,209,74,255)":
                print("THE DROP DID NOT ARRIVE AS AN IMAGE: the corner pixel is %s, not the "
                      "logo's amber. The bytes either did not cross or arrived under a format the "
                      "receiver could not use." % pixel)
                return 1
            print("ok: `files &` and `imgview &` from a REAL prompt, a REAL mouse dragged row %d "
                  "between two processes' windows, and the logo is on the receiver's canvas"
                  % args.row)
        return 0
    finally:
        server.terminate()


def pixel_expr(title: str, box: dict) -> str:
    """One pixel of a window's canvas, read back out of the canvas the browser painted.

    THE LOGO IS DRAWN SCALED AND CENTRED by `src/bin/imgview.mjs`, so the pixel to read is derived
    from the canvas's own size rather than written as a number: a 16x16 bitmap at an integer scale
    in a 200x200 surface puts the amber corner at (4,4) plus a little.
    """
    return ("""(() => {
  const w = [...document.querySelectorAll('.window')]
    .find((x) => ((x.querySelector('h2') || {}).textContent || '').includes(%s))
  const c = w && w.querySelector('canvas')
  if (!c) return 'no canvas'
  const g = c.getContext('2d')
  const scale = Math.floor(c.width / 16)
  const x0 = Math.floor((c.width - 16 * scale) / 2)
  const d = g.getImageData(x0 + 2, x0 + 2, 1, 1).data
  return `rgba(${d[0]},${d[1]},${d[2]},${d[3]})`
})()""" % json.dumps(title))


if __name__ == "__main__":
    raise SystemExit(main())
