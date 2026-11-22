#!/usr/bin/env python3
"""Two bugs a reader found by USING the desktop, reproduced at a real prompt.

    python3 bench/shell-reports/repro.py
    python3 bench/shell-reports/repro.py --only root
    python3 bench/shell-reports/repro.py --only terminals

NEITHER WAS CAUGHT BY 494 PASSING EXPECTATIONS, and the reason is the same for both: every check
reaches the filesystem and the terminal through the page's supervisor path, and a person reaches
them by typing. So this file types.

**`ls /` PRINTED NOTHING, AND `cd /usr/..` ANSWERED ENOENT.** The mount table resolves by longest
component prefix, so `/usr` worked without existing on the volume beneath it — and that volume's
root had no entry for it. One cause, two symptoms: an empty listing and a `..` that could not be
resolved (constraint 238).

**A SECOND TERMINAL DIED AFTER 30 SECONDS.** `term`'s ceiling was a bound on the whole session, and
every page passes `--ceiling 3600000` — so the only caller left on the 30-second default was a
human typing `term &`. The ceiling bounds IDLE time now, and BOTH EDGES are checked here: busy past
the deadline must live, idle past it must exit (constraint 239).
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

#: Every frame, and the tail of each one's screen. One evaluate, so two frames are never read a
#: moment apart.
FRAMES = """(() => {
  const w = [...document.querySelectorAll('.window')]
  return JSON.stringify({
    frames: w.length,
    titles: w.map((x) => (x.querySelector('h2') || {}).textContent || ''),
    screens: w.map((x) => ((x.querySelector('.terminal') || {}).textContent || '').slice(-240)),
  })
})()"""

PROMPT = """(() => { const t = document.querySelector('.terminal')
  return t && /\\$ /.test(t.textContent) ? 1 : 0 })()"""

FIRST = """(() => { const t = document.querySelector('.terminal')
  return t ? t.textContent : '' })()"""

#: What `/` must contain. NAMED and not counted: a count passes while the one directory a reader
#: cd's into is the missing one.
WANT_ROOT = ("bench", "dev", "proc", "tmp", "usr")


def focus_first(page) -> bool:
    return not page.evaluate(
        "(() => { const t = document.querySelector('.terminal');"
        " if (!t) return 'no terminal'; t.focus();"
        " return document.activeElement === t ? '' : 'refused focus' })()")


def focus_last(page) -> bool:
    return bool(page.evaluate(
        "(() => { const w = [...document.querySelectorAll('.window')];"
        " const el = w.length && w[w.length - 1].querySelector('.terminal');"
        " if (!el) return 0; el.focus(); return 1 })()"))


def typed(page, line: str, settle: float = 1.2) -> None:
    page.type_keys(line + "\n")
    time.sleep(settle)


def check_root(page, out: list) -> list:
    """`ls /`, and a `..` out of a mount. The reader's own commands, in the reader's own order."""
    problems = []
    for line in ("ls /", "cd /usr", "cd ..", "pwd", "ls"):
        typed(page, line)
    screen = page.evaluate(FIRST)
    out.append(("the first terminal", screen[-600:]))

    missing = [name for name in WANT_ROOT if ("%s/" % name) not in screen]
    if missing:
        problems.append("`ls /` did not list %s - the mountpoints do not exist as directories on "
                        "the volume beneath them, so the root listing is empty (constraint 238)"
                        % ", ".join(missing))
    if "ENOENT" in screen:
        problems.append("something answered ENOENT: `cd ..` out of /usr asks the root volume to "
                        "resolve `/usr/..`, which needs `/usr` to exist there")
    # `pwd` MUST SAY `/`. Without this the `cd ..` above could "work" by not moving at all.
    if "\n/\n" not in screen:
        problems.append("`pwd` after `cd /usr` and `cd ..` did not print `/`, so the `..` did not "
                        "actually leave the mount")
    return problems


def check_terminals(page, out: list) -> list:
    """A second terminal: it must appear, it must work, and it must not die while in use."""
    problems = []
    before = json.loads(page.evaluate(FRAMES))["frames"]
    typed(page, "term &", settle=5.0)
    state = json.loads(page.evaluate(FRAMES))
    out.append(("after `term &`", json.dumps(state["titles"])))
    if state["frames"] <= before:
        return ["`term &` opened no window, so there is no way to watch one program from another"]

    # IT MUST BE A WORKING SHELL, not just a frame: an inert terminal and a live one are the same
    # picture (constraint 40's shape).
    if not focus_last(page):
        return ["the second terminal has no terminal element to type into"]
    typed(page, "echo hi-from-the-second-terminal", settle=3.0)
    state = json.loads(page.evaluate(FRAMES))
    out.append(("the second terminal", state["screens"][-1]))
    if "hi-from-the-second-terminal" not in state["screens"][-1]:
        problems.append("the second terminal did not run `echo`, so it is a frame and not a shell")

    # ---- AND IT MUST SURVIVE BEING USED --------------------------------------------------
    #
    # THE EDGE THAT WAS BROKEN. 34 seconds was enough to kill it when the ceiling bounded the whole
    # session. Kept busy, an idle-bounded ceiling never fires.
    deadline = time.time() + 34
    while time.time() < deadline:
        page.type_keys("x")
        time.sleep(2.0)
    page.type_keys("\n")
    time.sleep(1.0)
    alive = json.loads(page.evaluate(FRAMES))
    out.append(("after 34 s of use", json.dumps(alive["titles"])))
    if alive["frames"] < state["frames"]:
        problems.append("the second terminal DIED while it was being typed into (%d frames left), "
                        "which is the bug: the ceiling bounded the session and not the idle time "
                        "(constraint 239)" % alive["frames"])

    # ---- AND THE OTHER EDGE OF THE SAME THRESHOLD ----------------------------------------
    #
    # A DEADLINE THAT NEVER FIRES IS NOT A DEADLINE, and the clause above passes for one that was
    # simply removed. A threshold on a continuous input gets both edges (CLAUDE.md), so: a terminal
    # told to allow 8 s of idle, then left alone for 16, must be GONE. The bound is passed
    # explicitly rather than waiting out the 30-minute default — the same mechanism at a scale a
    # check can afford.
    #
    # 8 s AND NOT 4, and the first attempt at 4 is why the comment is here: the idle clock used to
    # start before the window and the pty, so the relay exited during its own startup and never
    # drew a frame. `src/bin/term.mjs` starts the clock after setup now, and 8 s is clear of it
    # either way.
    if not focus_first(page):
        problems.append("lost the first terminal, so the idle edge could not be driven")
        return problems
    held = json.loads(page.evaluate(FRAMES))["frames"]
    typed(page, "term --ceiling 8000 &", settle=3.0)
    opened = json.loads(page.evaluate(FRAMES))["frames"]
    if opened <= held:
        problems.append("`term --ceiling 8000 &` opened no window within 3 s, so the idle edge was "
                        "not driven - and a relay that exits during its own startup looks exactly "
                        "like this")
        return problems
    time.sleep(16.0)
    after = json.loads(page.evaluate(FRAMES))
    out.append(("after 16 s idle with an 8 s ceiling", json.dumps(after["titles"])))
    if after["frames"] >= opened:
        problems.append("a terminal with an 8 s idle ceiling was still open after 16 s of silence "
                        "(%d frames), so the deadline does not fire at all and 'it survives being "
                        "used' says nothing" % after["frames"])
    return problems


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", choices=("root", "terminals"), action="append", default=[])
    ap.add_argument("--port", type=int, default=0,
                    help="0 (the default) asks the OS for a free port; a fixed one can collide")
    ap.add_argument("--out", default=str(REPO / "bench" / "shell-reports" / "repro.png"))
    args = ap.parse_args(argv)
    wanted = args.only or ["root", "terminals"]

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
        problems = []
        out = []
        with cdp.Browser() as browser:
            page = browser.page()
            page.navigate(url)
            deadline = time.time() + 90
            while time.time() < deadline:
                if page.evaluate("(() => { const M = globalThis.M9 || {};"
                                 " return M.state === 'error' || M.state === 'aborted' ? 2 : 0"
                                 " })()") == 2:
                    print("the page died: %s"
                          % page.evaluate("String(globalThis.M9.why || '')"))
                    return 1
                if page.evaluate(PROMPT):
                    break
                time.sleep(0.25)
            else:
                print("no prompt in 90 s")
                return 1
            if not focus_first(page):
                print("could not focus the terminal")
                return 1

            if "root" in wanted:
                problems += check_root(page, out)
            if "terminals" in wanted:
                problems += check_terminals(page, out)

            shot = page.call("Page.captureScreenshot", format="png")
            pathlib.Path(args.out).write_bytes(base64.b64decode(shot["data"]))

        for label, text in out:
            print("---- %s ----\n%s" % (label, text))
        print("png      %s" % args.out)
        if problems:
            print("\nFAILED:\n  - " + "\n  - ".join(problems))
            return 1
        print("\nok: `ls /` lists every mountpoint, `cd ..` leaves a mount, and a second terminal "
              "opened from the shell is still alive after 34 s of use")
        return 0
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
