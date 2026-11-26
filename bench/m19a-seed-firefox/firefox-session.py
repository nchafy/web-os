#!/usr/bin/env python3
"""CAN A READER CHANGE THINGS, AND DO THE CHANGES STAY? The landing desktop, in FIREFOX.

    python3 bench/m19a-seed-firefox/firefox-session.py                  # the gate
    python3 bench/m19a-seed-firefox/firefox-session.py --prove-failure  # ...and it MUST fail
    python3 bench/m19a-seed-firefox/firefox-session.py --headed         # in a window you can watch
    python3 bench/m19a-seed-firefox/firefox-session.py --url http://127.0.0.1:8000/www/index.html

Pipe stderr away for a quiet transcript: `serve.Handler` logs every request there.

WHAT IT ASKS, and it is the reader's own question rather than the kernel's. D40 is "all operating
systems a copy of the read only base, then each session modified freely", so the three things a
reader finds out in their first minute are:

  1. `desktop`  — the bare url is a desktop at all: a taskbar, a start orb, icons, no driver banner
     (constraint 283). It is the clause that collapses when there is no product, which is what
     makes it the one a control must leave alone.
  2. `session`  — the directory a reader is pointed at is the WRITABLE COPY and not the read-only
     mount. Asserted twice over, from both ends: the kernel's own seed report says it copied the
     base to a destination outside the base, and a desktop icon named after that destination's
     basename is on screen, so a reader can actually reach it.
  3. `writable` — a write there lands, AND THE SAME WRITE ON THE BASE REFUSES `EROFS`. The second
     half is not decoration: a run that only wrote to the copy would pass just as well on a system
     where nothing is read-only, and would say nothing about which of the two a reader got.
  4. `created`  — the file is in `ls` and in the FILE MANAGER'S OWN ROWS. The rows are canvas, so
     they are read at `CanvasRenderingContext2D.prototype.fillText` — the one place a display-list
     text run becomes pixels (`src/wm/surface.mjs`, constraint 293). That is the list a reader
     looks at, and a DOM query cannot see it.
  5. `reloaded` — the page really did reload. Infrastructure as a clause, because a "reload" that
     did not navigate would make clause 7 a read of the still-live kernel.
  6. `no-reseed` — the second boot reports `ran: false` with a reason. Constraint 28 directly: the
     kernel must not copy the base over a tree that already exists.
  7. `persists` — THE ONE THAT MATTERS. After the reload the file is still there, with its bytes.

HOW CLAUSE 7 IS KEPT FALSIFIABLE, which is the whole difficulty: an assertion about persistence is
trivially easy to write so that it cannot fail.

  - IT ASSERTS THE CONTENT, NOT THE NAME. `cat <path>` echoes the path at the prompt, so a run that
    looked for the filename in the terminal would find the string it had just typed and pass over an
    empty volume. The file holds a second nonce that is NEVER typed after the reload, so the only
    place it can come from is the volume. The name is asserted too, but only in `ls` output and in
    the file manager's rows, where nothing typed it.
  - IT PROVES THE PAGE IS NEW. A marker is set on `window` before the navigation and must be gone
    after it, and the terminal on the reloaded page must carry NO TRACE of the first boot — neither
    nonce anywhere in its scrollback — so the pty clause 7 types into cannot be the one clause 4
    used. A window count could not say that: `www/shell.mjs` stages a terminal, so the reloaded
    desktop legitimately has one.
  - AND IT WAS SEEN TO FAIL. `--prove-failure` navigates to `bench/m19a-seed-firefox/wipe.html` and
    removes the OPFS volume between the two boots, so the second boot meets a FRESH volume and the
    kernel seeds a new copy of the base over what the reader had. That is constraint 28's defect as
    a world, and it must turn `persists` and `no-reseed` and NOTHING ELSE: the desktop still comes
    up, still on a writable copy, and a file can still be created on it. A control satisfied by any
    failure verifies nothing (CLAUDE.md §Verification).

THE SECOND CONTROL IS THE NO-ISOLATION WORLD, and it moves a different clause — `desktop` — which
is what tells the two apart:

    python3 scripts/serve.py --no-isolation --port 8731 &
    python3 bench/m19a-seed-firefox/firefox-session.py \
        --url http://127.0.0.1:8731/www/index.html

WHY FIREFOX. Driving Chrome only has cost this project five milestones, every one green in Chrome
and found by a person opening the page (CLAUDE.md, constraints 175, 206, 264, 289). M19a is the
first milestone whose subject is a WRITE that has to survive, and Firefox's OPFS is a different
implementation of the one thing the claim rests on — so "the copy is durable" measured in one engine
is a claim about that engine. Firefox also renders at dpr 1 here, which is where the unit errors of
M11, M12 and M16 hid.
"""
from __future__ import annotations

import argparse
import os
import pathlib
import re
import secrets
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import bidi   # noqa: E402
import serve  # noqa: E402

#: WHAT IS ON SCREEN, in one read. Every selector is one `src/wm/` builds, which is what lets this
#: file name no page global for the product half — `firefox-landing.py`'s rule, for its reason.
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
    mark: Boolean(window.__m19aMark),
    terminals: document.querySelectorAll('.terminal').length,
    // EVERY FRAME AND ITS ROLE, UNFILTERED. `firefox-landing.py` drops `data-role="1"` to get the
    // app windows, which restates `WROLE_DESKTOP` in a file that cannot import `src/abi.mjs`.
    // Nothing here asserts on this — it is the transcript's record of what was on screen — so the
    // honest form is to print the role rather than keep a third copy of its value.
    windows: [...document.querySelectorAll('.window')].map((w) =>
      `${((w.querySelector('h2') || {}).textContent || '').trim()}#${w.dataset.role}`),
    icons: [...document.querySelectorAll('.desk-icon')].map((c) => {
      const r = c.getBoundingClientRect()
      // +24 is the GLYPH's row, not the caption's: `firefox-landing.py` clicks the same point.
      return { label: (c.querySelector('.desk-label') || {}).textContent || '',
               cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + 24) } }),
    tail: log ? (log.textContent || '').trim().split('\\n').slice(-3) : [],
  }
})())"""

#: THE KERNEL'S OWN SEED REPORT, at the address `www/shell.mjs`'s `seedState` publishes it. Read
#: because no selector carries it: whether the copy RAN, and whether userland's `HOME_DIR` agrees
#: with the kernel's `SEED_DEST`, are facts about two modules and not about the DOM.
SEED = """JSON.stringify((() => {
  const g = globalThis.INDEX
  if (!g) return { none: 'the landing page published no globals' }
  const s = g.seed
  if (!s) return { none: 'the page globals carry no seed report' }
  return { dest: s.dest, home: s.home, drifted: s.drifted, why: s.why, seed: s.seed }
})())"""

#: One terminal's screen, as text. A pty is the one surface in this system whose whole content is
#: characters, which is why it is also the one a command's output can be asserted out of.
SCREEN = "(document.querySelector('.terminal') || {}).textContent || ''"

#: EVERY STRING THE FILE MANAGER ACTUALLY DREW. `src/wm/surface.mjs` turns a `DL_TEXT` run into
#: exactly one `fillText`, so tapping the prototype reads the list a reader is looking at. A
#: bounding box or a pixel sample could not say WHICH name is in the row.
TAP = """(() => {
  const proto = CanvasRenderingContext2D.prototype
  if (!globalThis.__m19aTap) {
    const real = proto.fillText
    globalThis.__m19aTap = []
    proto.fillText = function (text, ...rest) {
      globalThis.__m19aTap.push(String(text))
      return real.call(this, text, ...rest)
    }
    return 'installed'
  }
  globalThis.__m19aTap.length = 0
  return 'reset'
})()"""

DRAWN = "JSON.stringify(globalThis.__m19aTap || [])"

#: The marker the reload has to destroy. Set on `window`, so it cannot survive a navigation and
#: cannot be confused with anything the page itself keeps.
MARK = "(() => { window.__m19aMark = 1; return 1 })()"

#: The clauses `--prove-failure` must turn, and the clauses it must leave alone. NAMED, because a
#: control satisfied by any failure verifies nothing.
PROOF_TAGS = ("persists", "no-reseed")
KEPT_TAGS = ("desktop", "session", "writable", "created", "reloaded", "bare-url")


def settle(ff, tries: int = 100):
    """Wait for the icon layout to stop moving, then return the last state.

    The page prints its own boot log, the log grows, and the desktop is pushed down under it — so an
    icon read before the log settled is clicked where the icon is not (`firefox-landing.py`).
    """
    last, state, stable = None, None, 0
    for _ in range(tries):
        state = ff.evaluate(STATE)
        now = [(i["label"], i["cy"]) for i in state["icons"]]
        stable = stable + 1 if now and now == last else 0
        last = now
        if stable >= 2:
            return state
        time.sleep(0.4)
    return state


#: WHERE TO CLICK INSIDE THE ONE PTY ON SCREEN, and how many there are. The count is read with the
#: point because `SCREEN` reads `querySelector`, which is the FIRST terminal: a second one would
#: take the focus and every keystroke with it, while the assertions went on reading the first. That
#: is not a hypothetical — it is what this gate did on its first run, and it reported the file
#: manager at fault for a file that was never created.
TERM_AT = """JSON.stringify((() => {
  const all = document.querySelectorAll('.terminal')
  if (!all.length) return null
  const r = all[0].getBoundingClientRect()
  return { x: Math.round(r.left + 30), y: Math.round(r.top + 20), count: all.length } })())"""


def focus_terminal(ff, state, bad, tag: str):
    """Put the caret in the desktop's pty, and PROVE the keystrokes are landing in it.

    `www/shell.mjs` stages a terminal on the landing desktop, so the usual case opens nothing. An
    icon is double-clicked only when there is no pty at all, and the label is preferred rather than
    required — the rows are a process's (`src/bin/desktop.mjs`) and a gate that hard-required one
    would go red the day the label changed rather than the day the terminal stopped working.

    THE PROBE IS THE POINT. A harness must fail when it is not reading what it was pointed at
    (CLAUDE.md §Harness honesty), and a pty that has the caret is indistinguishable from one that
    does not until something is typed into it.
    """
    at = ff.evaluate(TERM_AT)
    if not at:
        icons = state["icons"]
        order = ([i for i in icons if i["label"] == "Terminal"]
                 + [i for i in icons if i["label"] != "Terminal"])
        for icon in order:
            ff.dblclick(icon["cx"], icon["cy"])
            for _ in range(40):
                time.sleep(0.4)
                at = ff.evaluate(TERM_AT)
                if at:
                    break
            if at:
                print("terminal opened from the %r icon" % icon["label"])
                break
    if not at:
        bad.append((tag, "there is no terminal on the desktop and no icon opened one, so nothing "
                         "can be typed: icons %s" % [i["label"] for i in state["icons"]]))
        return None
    if at["count"] != 1:
        # TWO PTYS IS A BROKEN RUN, NOT A FAILING CLAUSE: the keys go to whichever has the focus and
        # `SCREEN` reads the first, so every assertion below would be read off the wrong screen.
        bad.append((tag, "%d terminals are on screen; `SCREEN` reads the first and the keys go to "
                         "the focused one, so this run could not be trusted" % at["count"]))
        return None
    ff.click(at["x"], at["y"])
    time.sleep(0.3)
    probe = "m19a-probe-%s" % secrets.token_hex(2)
    if probe not in at_prompt(ff, "echo %s" % probe):
        bad.append((tag, "a real keystroke did not reach the pty: `echo %s` printed nothing back, "
                         "so the caret is not in the terminal this run reads" % probe))
        return None
    return at


def at_prompt(ff, cmd: str) -> str:
    """Type a command at a real prompt and return ONLY what it printed.

    IT WAITS FOR THE PROMPT, not for a timer: a command slower than a guess would have its output
    read as the next command's, which is how a gate comes to assert one command's success against
    another's (`bench/m14-shell/coreutils.py`).
    """
    before = len(ff.evaluate(SCREEN, raw=True))
    ff.type_keys(cmd + "\n")
    out = ""
    for _ in range(60):
        time.sleep(0.15)
        out = ff.evaluate(SCREEN, raw=True)[before:]
        if re.search(r"\$\s*$", out) and len(out.strip()) > len(cmd):
            break
    # The echo of the command is what the pty put back, so it is dropped from the TRANSCRIPT and
    # kept in the returned text: an assertion about a refusal has to see the whole screen slice.
    said = " ".join(out.split())
    print("    $ %-46s | %s" % (cmd, said[len(" ".join(cmd.split())):].strip()[:150]))
    return out


def rows_of(ff, icon, bad, tag: str):
    """Open the session's directory in the file manager and return every string it drew.

    THE TAP GOES IN BEFORE THE WINDOW OPENS, which is what makes this deterministic: the rows are
    painted once, when the program first lays out, so instrumentation installed afterwards would
    read an empty list and report the file missing.
    """
    print("tap      %s" % ff.evaluate(TAP, raw=True))
    ff.dblclick(icon["cx"], icon["cy"])
    drawn = []
    for _ in range(40):
        time.sleep(0.4)
        drawn = ff.evaluate(DRAWN)
        if drawn:
            # One more beat: the first batch is the header, and the rows follow it.
            time.sleep(0.8)
            drawn = ff.evaluate(DRAWN)
            break
    if not drawn:
        bad.append((tag, "the file manager drew no text at all after a double-click on %r, so its "
                         "list could not be read" % icon["label"]))
    return drawn


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--url", default="", help="an already-running server; otherwise one is bound")
    ap.add_argument("--page", default="/www/index.html",
                    help="the landing page, at its BARE url: no query, no proofs")
    ap.add_argument("--w", type=int, default=1560)
    ap.add_argument("--h", type=int, default=1010)
    ap.add_argument("--shot", default=str(HERE / "firefox-session.png"))
    ap.add_argument("--prove-failure", action="store_true",
                    help="REMOVE THE OPFS VOLUME between the two boots, so the second meets a fresh "
                         "one and the kernel copies the base over the reader's tree. %s MUST then "
                         "fire and %s MUST NOT. Exits 0 when the proof SUCCEEDED."
                         % (list(PROOF_TAGS), list(KEPT_TAGS)))
    args = ap.parse_args(argv)

    httpd = None
    url = args.url
    if not url:
        os.chdir(REPO)
        httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d%s" % (httpd.server_address[1], args.page)
    # THE ORIGIN MUST NOT CHANGE ACROSS THE RELOAD. OPFS is keyed by origin, so a run that bound a
    # second server on a second port for the second boot would meet an empty volume every time and
    # report a defect that is its own.
    wipe_url = url.rsplit("/www/", 1)[0] + "/bench/m19a-seed-firefox/wipe.html"
    stamp = secrets.token_hex(3)
    leaf = "m19a-%s.txt" % stamp
    # TWO NONCES, AND THE SECOND ONE IS THE LOAD-BEARING ONE: it is never typed after the reload, so
    # finding it in `cat`'s output cannot be finding the command's own echo.
    body = "PERSISTED-%s" % secrets.token_hex(4)
    print("url      %s" % url)
    print("file     %s holding %r" % (leaf, body))

    bad: list[tuple[str, str]] = []
    try:
        with bidi.Firefox(headless=not args.headed, width=args.w, height=args.h) as ff:
            # ---- BOOT 1 -------------------------------------------------------------------------
            ff.navigate(url)
            st = settle(ff)
            print("firefox  viewport %s" % st["viewport"])
            print("page     search=%r preflight=%r windows=%s"
                  % (st["search"], st["preflight"], st["windows"]))
            for line in st["tail"]:
                print("log      %s" % line)

            if st["search"]:
                bad.append(("bare-url", "this is not the bare url: location.search is %r"
                            % st["search"]))
            if not st["taskbar"]:
                bad.append(("desktop", "no taskbar: nothing matches [data-taskbar]"))
            if not st["orb"]:
                bad.append(("desktop", "no start orb: nothing matches [data-start]"))
            if not st["icons"]:
                bad.append(("desktop", "the desktop published no icons"))
            if st["banner"]:
                bad.append(("desktop", "the bare url is a proof harness waiting for a driver "
                                       "(constraint 283): %s" % st["banner"]))
            print("desktop  taskbar=%s orb=%s icons=%s"
                  % (st["taskbar"], bool(st["orb"]), [i["label"] for i in st["icons"]]))
            if not st["icons"] or not st["taskbar"]:
                for tag, line in bad:
                    print("BAD  [%s] %s" % (tag, line))
                print("\nthere is no desktop to drive, so clauses 2-7 were not run")
                ff.screenshot(args.shot)
                return 1

            # ---- 2. THE SESSION'S TREE IS THE WRITABLE COPY --------------------------------------
            rep = ff.evaluate(SEED)
            print("seed     %s" % rep)
            seed = rep.get("seed") or {}
            dest = rep.get("dest") or ""
            base = seed.get("base") or ""
            if rep.get("none"):
                bad.append(("session", rep["none"]))
            if not seed.get("ran"):
                bad.append(("session", "the kernel did not seed this volume, so there is no "
                                       "writable copy to work in: why=%r" % seed.get("why")))
            if rep.get("drifted"):
                bad.append(("session", "the kernel seeded %r and userland opens %r: %s"
                            % (dest, rep.get("home"), rep.get("why"))))
            if not dest:
                bad.append(("session", "the seed report names no destination"))
            elif base and (dest == base or dest.startswith(base + "/")):
                # The copy must be OUTSIDE the base. A destination under `/usr` would be a copy on
                # the read-only mount, which is the refusal D40 removes wearing a new path.
                bad.append(("session", "the copy landed inside the read-only base: dest=%r base=%r"
                            % (dest, base)))
            leafname = dest.rsplit("/", 1)[-1] if dest else ""
            mine = next((i for i in st["icons"] if i["label"] == leafname), None)
            if not mine:
                bad.append(("session", "no desktop icon is named %r, so nothing points a reader at "
                                       "the session's tree: icons %s"
                            % (leafname, [i["label"] for i in st["icons"]])))
            if not dest or not mine:
                for tag, line in bad:
                    print("BAD  [%s] %s" % (tag, line))
                print("\nthe session's tree could not be located, so clauses 3-7 were not run")
                ff.screenshot(args.shot)
                return 1

            # ---- 3. A WRITE THERE LANDS, AND THE SAME WRITE ON THE BASE REFUSES -----------------
            if not focus_terminal(ff, st, bad, "writable"):
                for tag, line in bad:
                    print("BAD  [%s] %s" % (tag, line))
                ff.screenshot(args.shot)
                return 1

            path = "%s/%s" % (dest, leaf)
            wrote = at_prompt(ff, "echo %s > %s" % (body, path))
            for word in ("EROFS", "EACCES", "sh:"):
                if word in wrote:
                    bad.append(("writable", "a write to the session's tree printed %r: %s"
                                % (word, " ".join(wrote.split())[:200])))
            if base:
                onbase = at_prompt(ff, "echo %s > %s/%s" % (body, base, leaf))
                if "EROFS" not in onbase:
                    bad.append(("writable", "the base %r took a write, so this run cannot tell a "
                                            "writable copy from a system where nothing is "
                                            "read-only: %s"
                                % (base, " ".join(onbase.split())[:200])))

            # ---- 4. AND IT SHOWS UP IN THE LIST -------------------------------------------------
            listed = at_prompt(ff, "ls %s" % dest)
            if leaf not in listed:
                bad.append(("created", "`ls %s` does not list %r: %s"
                            % (dest, leaf, " ".join(listed.split())[:200])))
            read = at_prompt(ff, "cat %s" % path)
            if body not in read:
                bad.append(("created", "`cat %s` did not print the bytes that were written: %s"
                            % (path, " ".join(read.split())[:200])))

            drawn = rows_of(ff, mine, bad, "created")
            print("drawn    %d string(s), rows naming %r: %s"
                  % (len(drawn), leaf, [t for t in drawn if stamp in t] or "NONE"))
            if drawn and not any(stamp in text for text in drawn):
                bad.append(("created", "the file manager's own rows do not name %r; it drew %s"
                            % (leaf, drawn[:40])))

            # ---- THE RELOAD, and the control that goes in front of it ---------------------------
            ff.evaluate(MARK)
            if args.prove_failure:
                # THE VOLUME TAKEN AWAY, so the next boot meets a fresh one and seeds a new copy of
                # the base over the reader's tree: constraint 28's defect as a world. It cannot be
                # done from the landing page — the kernel holds the blob locks — so the navigation
                # here is part of the mechanism and not a convenience.
                ff.navigate(wipe_url)
                time.sleep(0.5)
                got = ff.evaluate("wipeOpfs().then((r) => JSON.stringify(r))")
                print("control  %s" % got)
                if not isinstance(got, dict) or not got.get("before"):
                    print("\nTHE CONTROL DID NOT TAKE: there was nothing in the OPFS root to "
                          "remove, so the second boot would have met a fresh volume anyway and this "
                          "run proves nothing about the gate. %s" % (got,))
                    return 1
                if got.get("left") or got.get("after"):
                    print("\nTHE CONTROL DID NOT TAKE: %s could not be removed and %s is still "
                          "there, so the second boot meets a HALF volume — which is neither fresh "
                          "nor the reader's tree, and is a third world nobody asked about."
                          % (got.get("left"), got.get("after")))
                    return 1

            ff.navigate(url)
            st2 = settle(ff)
            scroll = ff.evaluate(SCREEN, raw=True)
            print("reload   search=%r windows=%s terminals=%d mark=%s screen=%d chars"
                  % (st2["search"], st2["windows"], st2["terminals"], st2["mark"], len(scroll)))

            # ---- 5. THE PAGE REALLY RELOADED ----------------------------------------------------
            #
            # TWO SIGNALS, AND THE SECOND IS THE ONE THAT MATTERS. A window count cannot be it:
            # `www/shell.mjs` stages a terminal on the landing desktop, so the reloaded page
            # legitimately has one. What a page that never navigated WOULD have is the first boot's
            # scrollback — the `echo` that wrote the file, carrying both nonces — so its absence is
            # what says the pty below is a new pty and clause 7 is not reading clause 4's output.
            if st2["mark"]:
                bad.append(("reloaded", "`window.__m19aMark` survived, so the page never navigated "
                                        "and everything below reads the FIRST boot's kernel"))
            for nonce, what in ((body, "the bytes it wrote"), (leaf, "the file it named")):
                if nonce in scroll:
                    bad.append(("reloaded", "the terminal still carries the first boot's scrollback "
                                            "(%s, %r), so clause 7 would be reading clause 4's own "
                                            "output rather than the volume" % (what, nonce)))
            if not st2["icons"] or not st2["taskbar"]:
                bad.append(("desktop", "the reloaded page is not a desktop: taskbar=%s icons=%s"
                            % (st2["taskbar"], [i["label"] for i in st2["icons"]])))
                for tag, line in bad:
                    print("BAD  [%s] %s" % (tag, line))
                ff.screenshot(args.shot)
                return 1

            # ---- 6. AND THE KERNEL DID NOT COPY THE BASE OVER IT AGAIN --------------------------
            rep2 = ff.evaluate(SEED)
            print("seed     %s" % rep2)
            seed2 = rep2.get("seed") or {}
            if seed2.get("ran"):
                bad.append(("no-reseed", "the kernel SEEDED AGAIN on the second boot — %d file(s), "
                                         "%s bytes copied over a volume that already had a tree. "
                                         "That is constraint 28's silent data loss."
                            % (seed2.get("files"), seed2.get("bytes"))))
            elif not seed2.get("why"):
                bad.append(("no-reseed", "the second boot reports `ran: false` with no reason, so a "
                                         "seed that was skipped cannot be told from one that was "
                                         "never attempted"))

            # ---- 7. AND THE READER'S CHANGE IS STILL THERE --------------------------------------
            if not focus_terminal(ff, st2, bad, "persists"):
                for tag, line in bad:
                    print("BAD  [%s] %s" % (tag, line))
                ff.screenshot(args.shot)
                return 1
            again = at_prompt(ff, "ls %s" % dest)
            if leaf not in again:
                bad.append(("persists", "after the reload `ls %s` does not list %r any more: %s"
                            % (dest, leaf, " ".join(again.split())[:200])))
            back = at_prompt(ff, "cat %s" % path)
            # THE CONTENT AND NOT THE NAME. The command's own echo carries the path, so a name test
            # here would pass over an empty volume; `body` was never typed on this page.
            if body not in back:
                bad.append(("persists", "after the reload %s does not hold the bytes that were "
                                        "written to it: wanted %r, the prompt said %s"
                            % (path, body, " ".join(back.split())[:200])))

            drawn2 = rows_of(ff, mine, bad, "persists")
            print("drawn    %d string(s), rows naming %r: %s"
                  % (len(drawn2), leaf, [t for t in drawn2 if stamp in t] or "NONE"))
            if drawn2 and not any(stamp in text for text in drawn2):
                bad.append(("persists", "after the reload the file manager's rows no longer name "
                                        "%r; it drew %s" % (leaf, drawn2[:40])))

            ff.screenshot(args.shot)
            print("shot     %s" % args.shot)
    finally:
        if httpd is not None:
            httpd.shutdown()

    if args.prove_failure:
        print()
        for tag, line in bad:
            print("would report  [%s] %s" % (tag, line))
        fired = [tag for tag, _ in bad if tag in PROOF_TAGS]
        collapsed = [(tag, line) for tag, line in bad if tag in KEPT_TAGS]
        # EXIT 0 WHEN THE PROOF SUCCEEDED: `scripts/check.py`'s convention, where a non-zero exit is
        # reserved for a proof that failed to fail.
        if collapsed:
            print("\nTHE PROOF FAILED: the control also moved %s, so `persists` firing says nothing "
                  "about durability — it could be a desktop that did not come up. A control "
                  "satisfied by any failure verifies nothing."
                  % sorted({tag for tag, _ in collapsed}))
            return 1
        if "persists" not in fired:
            print("\nTHE PROOF FAILED: the volume was removed between the two boots, the kernel "
                  "copied the base over the reader's tree, and the `persists` clause said nothing. "
                  "The gate cannot see the defect it exists for.")
            return 1
        print("\nthe proof succeeded: with the volume taken away the second boot re-seeded, and "
              "that was reported as %s while %s stayed green."
              % (sorted(set(fired)), list(KEPT_TAGS)))
        return 0

    if bad:
        print()
        for tag, line in bad:
            print("BAD  [%s] %s" % (tag, line))
        return 1
    print("\na reader can change things and the changes stay: the bare url opens on a WRITABLE copy "
          "of the base, a file created there is in `ls` and in the file manager's own rows, and "
          "after a reload the kernel refused to seed again and the file still holds its bytes — in "
          "Firefox, with real trusted input")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
