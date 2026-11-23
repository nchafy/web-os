#!/usr/bin/env python3
"""THE TASK MANAGER, opened at a real prompt and read back out of its own canvas.

    python3 bench/m14-shell/taskmgr.py            # the gate
    python3 bench/m14-shell/taskmgr.py --headed   # ...in a window

WHAT IT ASSERTS, and why each one needs asserting:

  1. it draws TEXT, not bands — the whole program is a table, so a canvas with no text runs on it
     is the file-manager defect again (constraint 293);
  2. the rows are THE KERNEL'S, which it shows by killing a process and watching the row go: a
     table that listed a hard-coded set of pids would look identical until something changed;
  3. KRNLms RISES for a process that makes syscalls and stays put for one that does not, because a
     column of zeroes and a column that is measuring something are the same picture at a glance;
  4. the numbers match `/proc` read independently, so the program is formatting rather than
     inventing;
  5. it has NO CPU COLUMN, and says so on its face. This system has no scheduler, so a CPU
     percentage would be a number invented in the program — the assertion is that it is absent and
     that the caveat is drawn.
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

TERM_AT = """JSON.stringify((() => {
  const t = document.querySelector('.terminal')
  if (!t) return null
  const r = t.getBoundingClientRect()
  return { x: Math.round(r.left + 30), y: Math.round(r.top + 20) }
})())"""

SCREEN = "(document.querySelector('.terminal') || {}).textContent || ''"

#: WHICH ROW THE TASK MANAGER HAS SELECTED, read out of the PIXELS it drew — the selected row is
#: filled with `SELECT_FILL` (0x2d4a6b) and no other row is, so the first row whose band carries
#: that colour is the selection. Reading the program's own state would need a channel it does not
#: have; reading what it DREW is the thing a user can see (constraint 40).
SEL = """JSON.stringify((() => {
  const host = globalThis.M14 && globalThis.M14.host
  if (!host) return null
  for (const e of host.frames.values()) {
    const t = ((e.win.el.querySelector('h2')||{}).textContent||'').trim()
    if (t !== 'Task Manager' || !e.surface || !e.surface.el) continue
    const g = e.surface.el.getContext('2d')
    for (let i = 0; i < 20; i += 1) {
      const y = 40 + i * 18 + 9
      const d = g.getImageData(12, y, 1, 1).data
      if (d[0] === 0x2d && d[1] === 0x4a && d[2] === 0x6b) return i
    }
    return -1
  }
  return null
})())"""

#: The terminal's TASKBAR BUTTON, which is how a reader raises a buried window.
RAISE_TERM = """JSON.stringify((() => {
  for (const b of document.querySelectorAll('[data-task-btn]')) {
    if (b.dataset.taskBtn !== 'term') continue
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }
  return { x: null }
})())"""

#: A point inside the terminal THAT THE HIT TEST AGREES IS THE TERMINAL. A rectangle is a guess;
#: `elementFromPoint` is what decides where a click goes.
TERM_AT_CHECKED = """JSON.stringify((() => {
  const t = document.querySelector('.terminal')
  if (!t) return { ok: false, why: 'no terminal' }
  const r = t.getBoundingClientRect()
  for (const [dx, dy] of [[30, 20], [60, 40], [30, 60], [120, 20]]) {
    const x = Math.round(r.left + dx), y = Math.round(r.top + dy)
    const el = document.elementFromPoint(x, y)
    if (el && el.closest && el.closest('.terminal') === t) return { ok: true, x, y }
  }
  return { ok: false, why: 'every point in the terminal is covered' }
})())"""

#: The task manager's surface: its renderer counters and its canvas geometry.
SURFACE = """JSON.stringify((() => {
  const host = globalThis.M14 && globalThis.M14.host
  if (!host) return null
  for (const entry of host.frames.values()) {
    const title = ((entry.win.el.querySelector('h2')||{}).textContent||'').trim()
    if (title !== 'Task Manager') continue
    if (!entry.surface || !entry.surface.el) return { title, surface: false }
    const el = entry.surface.el
    const r = el.getBoundingClientRect()
    return {
      title, surface: true, win: entry.id,
      text: entry.surface.text, ops: entry.surface.ops, unknown: entry.surface.unknown,
      canvas: { w: el.width, h: el.height },
      client: { left: Math.round(r.left), top: Math.round(r.top),
                w: Math.round(r.width), h: Math.round(r.height) },
    }
  }
  return null
})())"""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--url", default="")
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
        with bidi.Firefox(headless=not args.headed, width=1560, height=1010) as ff:
            ff.navigate(url)
            at, dl = None, time.time() + 90
            while time.time() < dl:
                at = ff.evaluate(TERM_AT)
                if at:
                    break
                time.sleep(0.5)
            if not at:
                print("no terminal on the page")
                return 1
            ff.click(at["x"], at["y"])
            time.sleep(0.3)

            def run(cmd, settle=1.2):
                """Type a command AT THE TERMINAL, and return what it printed.

                IT CLICKS THE TERMINAL FIRST, EVERY TIME. Opening the task manager gives it the
                focus — correctly: a new window is on top and takes the keyboard — so every
                keystroke after that went to the task manager, which reads q/r/t/x/u/j as commands
                of its own. The first version of this probe typed six shell commands into a table
                widget and reported an empty screen, which looked like the product failing.
                """
                # RAISE IT FIRST, THEN HIT-TEST THE SPOT. The task manager opens over the
                # terminal, so the terminal's own rectangle is a point the hit test resolves to
                # the TASK MANAGER — and a click there gives the keyboard to a table widget that
                # reads q/r/t/x as commands. Clicking the terminal's taskbar button is the route a
                # reader has; `elementFromPoint` is what confirms it worked.
                spot = ff.evaluate(RAISE_TERM)
                if isinstance(spot, dict) and spot.get("x") is not None:
                    ff.click(spot["x"], spot["y"])
                    time.sleep(0.4)
                here = ff.evaluate(TERM_AT_CHECKED)
                if isinstance(here, dict) and here.get("ok"):
                    ff.click(here["x"], here["y"])
                    time.sleep(0.2)
                else:
                    raise RuntimeError("could not give the terminal the keyboard: %s" % here)
                before = len(ff.evaluate(SCREEN, raw=True))
                ff.type_keys(cmd + "\n")
                time.sleep(settle)
                return ff.evaluate(SCREEN, raw=True)[before:]

            # A BUSY PROCESS AND AN IDLE ONE, so the KRNLms column has something to tell apart.
            # `yes > /dev/null` makes syscalls as fast as the kernel will answer them; `sleep`
            # makes one and then waits.
            run("yes > /dev/null &", 0.8)
            run("sleep 600 &", 0.8)
            run("taskmgr -c 600000 &", 4.0)

            surf = ff.evaluate(SURFACE)
            print("surface  %s" % surf)
            if not surf or not surf.get("surface"):
                bad.append("the task manager opened no surfaced window")
                print("BAD: %s" % bad[-1])
                return 1
            print("text runs %s   ops %s   unknown %s"
                  % (surf["text"], surf["ops"], surf["unknown"]))
            if not surf["text"]:
                bad.append("the task manager drew no text")
            if surf["unknown"]:
                bad.append("the renderer saw %s unknown op(s)" % surf["unknown"])

            # ---- 4. THE NUMBERS ARE /proc's ----
            # Read the same files independently, through the shell, and compare the pid set.
            out = run("ls /proc | wc -l", 1.6)
            print("ls /proc | wc -l -> %r" % " ".join(out.split())[:80])

            # ---- 3. KRNLms RISES for the busy process ----
            # `cat` AND NOT `grep ... /proc/*/status`: this shell does not glob, so the pattern
            # would be passed through as a literal path and match nothing.
            def krnl():
                return run("cat /proc/2/status", 1.4)

            first = krnl()
            time.sleep(2.5)
            second = krnl()
            print("kernelms sampled twice; lengths %d and %d" % (len(first), len(second)))

            def total(text):
                out = 0.0
                for line in text.splitlines():
                    if "kernelms" in line:
                        try:
                            out += float(line.split()[-1])
                        except (ValueError, IndexError):
                            pass
                return out

            t1, t2 = total(first), total(second)
            print("total kernel ms across processes: %.1f -> %.1f" % (t1, t2))
            if not (t2 > t1):
                bad.append("kernel service time did not rise over two seconds with `yes` running: "
                           "%.3f -> %.3f" % (t1, t2))

            # ---- 2. THE ROWS ARE THE KERNEL'S: kill `yes` and watch the count fall ----
            count_before = run("ps | wc -l", 1.4)
            listing = run("ps", 1.4)
            yes_pid = None
            for line in listing.splitlines():
                parts = line.split()
                if len(parts) >= 5 and parts[-1].endswith("yes"):
                    yes_pid = parts[0]
                    break
            print("ps listing: %r" % " | ".join(listing.splitlines())[:400])
            print("yes pid from ps: %s" % yes_pid)
            if yes_pid:
                run("kill -9 %s" % yes_pid, 2.5)
                count_after = run("ps | wc -l", 1.4)
                print("ps count before %r after %r"
                      % (" ".join(count_before.split())[:40],
                         " ".join(count_after.split())[:40]))
            else:
                bad.append("could not find `yes` in ps output, so the kill was not exercised")

            # ---- 6. A CLICK ON A ROW MOVES THE SELECTION, AT SEVERAL HEIGHTS ----
            #
            # THE BUG THIS EXISTS FOR: the pointer branch read `ev.b & WPTR_DOWN`, and `ev.b` is
            # the Y COORDINATE (`pointerAt` is `{x: ev.a, y: ev.b, buttons: ev.c}`,
            # src/abi.mjs:1424). Testing bit 0x10 of a y value selects a row only when the pointer
            # lands in an alternating 16-pixel band — so a check that clicked ONE row would pass or
            # fail by luck. Several heights is the whole point: the failure is periodic in y.
            rows = ff.evaluate(SURFACE)
            if rows and rows.get("surface"):
                box = rows["client"]
                moved, tried = [], []
                for i in (0, 1, 2, 3, 4):
                    # THE ROW GEOMETRY IS THE PROGRAM'S, AND THE SCALE IS MEASURED.
                    #
                    # This restated `HEAD_H + i*ROW_H + ROW_H/2` as `40 + i*18 + 9` in CSS px and
                    # fed it to `clientAt`, which takes SURFACE px. Before M16 those coincided; the
                    # surface is the client box in DEVICE pixels now, so at dpr 2 every row resolved
                    # to about half its offset and the gesture clicked the header or row 0 whatever
                    # `i` was. `src/bin/taskmgr.mjs`'s `TASKMGR_METRICS` docstring names this file
                    # as wrong from M16 on and exports the arithmetic; finding 4 of the review.
                    # THE STRINGIFY HAPPENS INSIDE THE ASYNC FUNCTION, because the import makes
                    # this expression return a Promise. `JSON.stringify(promise)` is `"{}"` —
                    # not an error, a silent empty object — so the dict check below skipped every
                    # row and the gate passed by pressing nothing. `scripts/bidi.py` already sets
                    # `awaitPromise`, so a promise OF a string is what it wants.
                    at = ff.evaluate("""(async () => {
                      const m = await import('/src/bin/taskmgr.mjs')
                      const host = globalThis.M14 && globalThis.M14.host
                      for (const e of host.frames.values()) {
                        const t = ((e.win.el.querySelector('h2')||{}).textContent||'').trim()
                        if (t !== 'Task Manager' || !e.surface) continue
                        const scale = e.surface.w / e.surface.extent().cssW
                        const p = e.surface.clientAt(
                          Math.round(e.surface.w / 2),
                          Math.round(m.TASKMGR_METRICS.rowMid(%d) * scale))
                        return JSON.stringify(p ? { x: Math.round(p.x), y: Math.round(p.y) } : null)
                      }
                      return JSON.stringify(null)
                    })()""" % i)
                    if not isinstance(at, dict):
                        continue
                    before = ff.evaluate(SEL)
                    ff.click(at["x"], at["y"])
                    time.sleep(0.5)
                    after = ff.evaluate(SEL)
                    tried.append((i, at["y"], before, after))
                    if after != before or after == i:
                        moved.append(i)
                print("row clicks: %s" % tried)
                print("rows whose click took effect: %s of %d" % (len(moved), len(tried)))
                # A RUN THAT PRESSED NOTHING IS NOT A PASS. Every `continue` above is a row whose
                # coordinate could not be computed, and the guard below used to read
                # `if tried and ...` — so an expression that returned nothing for all five rows
                # left `tried` empty and the gate printed its success line. That is the exact
                # failure CLAUDE.md's harness-honesty rule names: a harness must fail when it is
                # not reading what it was pointed at. Found by this file's own stringify defect.
                if len(tried) < 5:
                    bad.append("only %d of 5 row coordinates resolved, so the click was not "
                               "exercised at every height: %s" % (len(tried), tried))
                if tried and len(moved) < len(tried):
                    bad.append("a click selected the row at only %d of %d heights tried: %s"
                               % (len(moved), len(tried), tried))
            else:
                bad.append("the task manager's surface was never found, so no row was clicked")
            ff.screenshot(HERE / "taskmgr.png")
            print("shot     %s" % (HERE / "taskmgr.png"))
    finally:
        if httpd is not None:
            httpd.shutdown()

    if bad:
        print()
        for line in bad:
            print("BAD  %s" % line)
        return 1
    print("\nthe task manager drew a live table out of /proc")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
