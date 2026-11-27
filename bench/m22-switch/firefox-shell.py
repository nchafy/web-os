#!/usr/bin/env python3
"""M22'S WHOLE SHELL IN A SECOND ENGINE: the five things a reader does, driven with REAL TRUSTED
INPUT on the LANDING desktop in Firefox.

    python3 bench/m22-switch/firefox-shell.py                  # the gate
    python3 bench/m22-switch/firefox-shell.py --headed          # ...in a window you can watch
    python3 bench/m22-switch/firefox-shell.py --prove-failure    # the `save-to-window-fd` world
    python3 bench/m22-switch/firefox-shell.py --url http://...   # against a server already up
    python3 bench/m22-switch/firefox-shell.py --json out.json    # every reading, for a diff

...and the one that proves the KNOWN_RED allowance below is a NAMED set and not a blanket — a
clause listed there that comes back green must FAIL the gate, so the allowance cannot outlive the
defect. Measured: `theTrayDrewAStatusIcon is GREEN and is listed in KNOWN_RED`, and the two real
red clauses became ordinary failures the moment they left the set.

    python3 -c "import importlib.util, sys; \
      s = importlib.util.spec_from_file_location('g', 'bench/m22-switch/firefox-shell.py'); \
      m = importlib.util.module_from_spec(s); s.loader.exec_module(m); \
      m.KNOWN_RED = {'theTrayDrewAStatusIcon': 'a clause that is GREEN on this tree'}; \
      sys.exit(m.main([]))"

WHY THIS FILE EXISTS. `CLAUDE.md` makes a second engine a condition of reporting a milestone done,
and it records the bill: M4a shipped a window that could not be dragged in Firefox (constraint 175),
M6 a policy under which no process started there (206), M11 a blur band placed at a dpr-2 constant,
M12 a dpr-2 window count (264), M14 a desktop a reader could not open anything on (289), and M17 a
bare URL that threw in both engines while the suite stayed green. Six milestones, every Chrome
expectation green each time, every one found by a person opening the page.

THE READER'S FIVE QUESTIONS, which are the five things M22 claims:

  1. can I reach every taskbar button when many windows are open?
  2. does a pinned button launch the program it stands for?
  3. does the tray icon go away when I kill the program?
  4. **if I save a file, is it actually saved?** — reopened and compared by BYTES, through `cat` at
     the real prompt, which is the only reader-visible route to the file's contents;
  5. does the switcher chord work, and does the menu show the right accelerator?

THE CHORD IS THE ENGINE-SPECIFIC PART, and this file is where that is settled rather than assumed.
`bench/m22-switch/probe.py` scored 25 candidates on five clauses in both engines and found Alt+` and
Alt+Shift+` free, preventable and host-quiet in BOTH (`results-headless.json`). What a scored table
cannot say is whether the SHELL receives them, and the one engine-shaped way this can still be wrong
is the one the measurement itself found: **Firefox delivers Shift+Backquote as `key: "~"` where
Chrome delivers `key: "`"`, and both deliver `code: "Backquote"`.** A dispatcher matching on
`key` works in Chrome and silently misses Alt+Shift+` here — which is the exact shape of all six
bills above. So this gate reads the `code` off the event that actually arrived and asserts it.

THIS GATE PRESSES WHAT THE MENU SAYS. The chord table is read out of `/src/wm/chords.mjs` through the
page, and the key to press is derived from each row's own published `label` — so the gesture driven
is the one a reader is told to use. A label that drifted from its binding fails here rather than
reading correctly in a screenshot. Nothing in this file spells a chord.

WHAT IT IS NOT. It is not a second `scripts/check.py`, and it is not the other three M22 gates:
`bench/m22-band/firefox-band.py` owns the band on `www/m14.html` and the wheel AXIS measurement,
`bench/m22-pins/firefox-pins.py` owns the pin GESTURE and its survival of a reload, and
`bench/m22-switch/probe.py` owns the chord table. This one drives the LANDING page — the bare URL,
which is the product (constraint 283) — end to end in one session, because the five questions above
are things a reader does in one sitting and several of them only interact there.

GEOMETRY IS DERIVED FROM MEASURED RECTS, NEVER FROM A CONSTANT. Firefox renders at dpr 1 on this
machine (constraint 264), which is where a ratio error hides: every click below is at the centre of a
`getBoundingClientRect` that was just read, hit-tested with `elementFromPoint` first, and the one
viewport figure this file needs is SEARCHED for rather than written down.

TWO CLAUSES ARE RED ON THIS TREE AND ARE REPORTED, NOT HIDDEN. `www/m22.html` already records the
tray defect with its cause — `src/kernel/kernel.mjs`'s `spawnChild` copies every fd into a child,
window fds included, so a dying process's window keeps refs > 0 and `src/kernel/files.mjs`'s
`F_WIN.close` never runs, against constraint 14's "teardown destroys windows". Those two clause names
are listed in `KNOWN_RED` and are printed as `RED` with their address. They do NOT move this gate's
exit code, because the gate's subject is the ENGINE and the defect is in a kernel file no M22 slice
owns — but a `KNOWN_RED` clause that comes back GREEN **fails** the gate, which is what stops the
allowance outliving the defect. A clause weakened to pass is a clause that reports a defect as a
feature; this one is measured, named and addressed every run.

`--prove-failure` ARMS M22's OWN `save-to-window-fd` CONTROL, and it needs no source edit: it is
per-process argv, so the editor is started as `editor --save-to-window-fd &` at the real prompt. That
is the world the defect shipped in — `commitSave` writes `[saved]` to the WINDOW fd and reports the
count it would have written — so the BYTES clause must die while every DRAWING clause lives. The
gate reports that asymmetry by name and exits 0 when the proof SUCCEEDED.

COMMITTED EVIDENCE, every clause with the reading behind it:
`bench/m22-switch/results-firefox-shell.json` (25 of 32 green — the five chord-DISPATCH clauses and
the two `KNOWN_RED` tray clauses are the rest) and `results-firefox-shell-control.json` (24 of 32:
the bytes clause as well, which is the control). `firefox-shell.png` is the screenshot beside them —
evidence, never the gate, because an inert frame and a working one are the same picture
(constraint 40).

WHAT THIS RUN FOUND, with the address, because it is a defect and not a limitation of the engine:
**the chord ARRIVES in Firefox and nothing takes it.** `code: "Backquote"`, `altKey: true`,
`isTrusted: true`, `defaultPrevented: true` — and `report().switches` stays at 0, because
`src/wm/winhost.mjs`'s `#keys(id, bytes, event, sym)` has no `takeChord(event, modifierBits(event))`
at its top. While it has none, `bytesForKey` answers a byte for Alt+` (Alt is not Ctrl), so the chord
lands in the focused program as text: this gate's own first run typed `` `~`1editor & `` at the shell
and read back `command not found`. `type_command` below is what keeps that defect from also failing
the save clause.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import bidi   # noqa: E402
import serve  # noqa: E402

#: The clauses this gate measures, reports with an address, and does NOT fail on — see the module
#: docstring. A FIXED SET OF NAMES and not a count: a control or an allowance satisfied by any
#: failure verifies nothing (`CLAUDE.md`). A name here that comes back green is a BAD.
KNOWN_RED = {
    "theTrayIconWentWhenItsOwnProcessDied":
        "src/kernel/kernel.mjs spawnChild copies every fd into a child, window fds included, so "
        "the desktop's window kept refs > 0 and src/kernel/files.mjs F_WIN.close never ran. "
        "Constraint 14 says teardown DESTROYS windows. Recorded on www/m22.html, proofTray.",
    "theKernelDestroyedItsWindowsToo":
        "the kernel answers `reaped` and no `win-destroy` for the same reason. Same address.",
}

#: The pinned program this gate LAUNCHES. `src/bin/desktop.mjs`'s `DEFAULT_PINS` is read off the
#: page rather than restated, so this is only the preference for which of them to click — and the
#: clause refuses rather than passes if it has no window-less pin to work with.
PREFER_PIN = "files"

#: How wide the desktop starts, and how far down the band search goes. The band only overflows
#: between "narrower than its buttons" and "wider than one button", and that gap is about ten
#: pixels (`bench/m22-band/probe.py`). SEARCHED, not assumed: the landing page publishes pins as
#: well as window groups, so it overflows at a different width than `www/m14.html` does.
WIDE_W, WIDE_H = 1500, 1000
BAND_FROM, BAND_TO, BAND_STEP = 620, 150, 8

#: What the editor is handed. The CONTROL is a declared argv flag on the program, which is what
#: makes this control re-runnable from a command line with no source edit.
SAVE_CONTROL = "--save-to-window-fd"

#: How long the staged `winopen` windows must outlive. An hour, because this gate runs for minutes
#: and a window that exits on its own ceiling halfway through is a window the liveness clause at
#: the end reads as collateral from the kill.
WINOPEN_CEILING_MS = 3600000

STATE = """JSON.stringify((() => {
  const I = globalThis.INDEX || {}
  const shell = I.shell || null
  const host = I.host || null
  const r = shell ? shell.report() : null
  const mid = (el) => { const b = el.getBoundingClientRect()
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } }
  const desk = shell ? shell.desktopEntry() : null
  return {
    state: String(I.state || ''), isolated: I.isolated === true, dpr: devicePixelRatio,
    viewport: { w: innerWidth, h: innerHeight },
    errors: (I.errors || []).slice(0, 4).map(String),
    notes: (I.notes || []).slice(0, 4).map(String),
    pids: I.pids || null,
    shell: Boolean(shell),
    deskWin: desk ? desk.id : 0, deskPid: desk ? desk.pid : 0,
    deskRows: desk ? (desk.items || []).length : 0,
    buttons: r ? r.buttons : 0,
    pins: r ? r.pins : 0,
    pinButtons: [...document.querySelectorAll('[data-pin-btn]')].map((e) => e.dataset.pinBtn),
    slots: r ? r.slots : [],
    groups: r ? r.groups : [],
    topmost: r ? r.topmost : 0,
    switches: r ? (r.switches | 0) : 0,
    selects: r ? (r.selects | 0) : 0,
    raises: r ? (r.raises | 0) : 0,
    pinLaunches: r ? (r.pinLaunches | 0) : 0,
    trayClicks: r ? (r.trayClicks | 0) : 0,
    bandScrolls: r ? (r.bandScrolls | 0) : 0,
    chords: r ? r.chords : null,
    accels: r ? r.accels : [],
    slotAccels: r ? r.slotAccels : [],
    band: r ? r.band : null,
    popup: r ? r.popupKind : '',
    tray: r ? r.tray : [],
    trayIcons: [...document.querySelectorAll('[data-tray-icon]')].length,
    frames: host ? [...host.frames].map(([id, e]) => ({
      id, pid: e.pid | 0, role: e.role | 0, title: String(e.win.titleText || ''),
      term: Boolean(e.term) })) : [],
    orb: (() => { const o = document.querySelector('[data-start]'); return o ? mid(o) : null })(),
    /* ALT+TAB MUST NOT BE ON SCREEN ANYWHERE. It is in `src/wm/chords.mjs`'s BLOCKED set — the
     * host acts on it in Chrome unless the page cancels — so a menu advertising it would be the
     * live-looking-button defect. Read over the bar and the popup's TEXT and their two
     * accelerator attributes, because an `aria-keyshortcuts` is announced and not drawn. */
    altTabOnScreen: (() => {
      const bits = []
      for (const el of document.querySelectorAll(
          '.taskbar, .taskbar *, .shell-popup, .shell-popup *')) {
        bits.push(el.textContent || '', el.getAttribute('aria-keyshortcuts') || '',
                  el.getAttribute('title') || '')
      }
      return bits.some((s) => s.includes('Alt+Tab'))
    })(),
  }
})())"""

#: THE CHORD TABLE AS DATA, out of the module both readers share. A dynamic `import` of a URL the
#: page has already loaded returns the SAME instance, so this is the real table and not a copy —
#: which is the whole reason this gate never spells a chord.
CHORDS = """(() => {
  globalThis.__ffchords = 'pending'
  import('/src/wm/chords.mjs').then((m) => {
    globalThis.__ffchords = JSON.stringify({
      rows: m.CHORDS.map((c) => ({ id: c.id, code: c.code, mods: c.mods, label: c.label,
                                   action: c.action, arg: c.arg })),
      blocked: m.BLOCKED.map((b) => ({ id: b.id, label: b.label, why: b.why })),
      next: m.SWITCH_NEXT.label, prev: m.SWITCH_PREV.label, slots: m.SELECT_SLOTS,
      switch: m.CHORD_SWITCH, select: m.CHORD_SELECT,
    })
  }).catch((e) => { globalThis.__ffchords = JSON.stringify({ threw: String(e && e.message || e) }) })
  return ''
})()"""
CHORDS_READ = "JSON.stringify(String(globalThis.__ffchords || ''))"

#: WHAT THE KEY EVENT ACTUALLY CARRIED, recorded at the CAPTURE phase on the window so it is seen
#: before any handler and regardless of which element has the focus. `defaultPrevented` is read in
#: a microtask-free way by re-reading the event after the listeners ran, which is what the second
#: (bubble-phase, on `window`) listener is for: a capture-phase read would always be false.
RECORDER = """(() => {
  const log = []
  globalThis.__ffkeys = log
  const seen = new Map()
  addEventListener('keydown', (e) => {
    const row = { code: e.code, key: e.key, trusted: e.isTrusted, alt: e.altKey,
                  ctrl: e.ctrlKey, shift: e.shiftKey, meta: e.metaKey,
                  cancelable: e.cancelable, prevented: false }
    seen.set(e, row)
    log.push(row)
  }, true)
  addEventListener('keydown', (e) => {
    const row = seen.get(e)
    if (row) { row.prevented = e.defaultPrevented === true; seen.delete(e) }
  }, false)
  return ''
})()"""
KEYS_READ = "JSON.stringify(globalThis.__ffkeys || [])"
KEYS_CLEAR = "(() => { globalThis.__ffkeys.length = 0; return '' })()"

#: One window's body rect and its screen, by id. `entry.term.transcript` is what the terminal widget
#: has printed — the same reading `www/m22.html` takes — and a surfaced window has none.
FRAME = """JSON.stringify((() => {
  const host = globalThis.INDEX.host
  const e = host.get(%d)
  if (!e) return null
  const b = e.win.bodyEl.getBoundingClientRect()
  const el = document.elementFromPoint(Math.round(b.left + b.width / 2),
                                       Math.round(b.top + b.height / 2))
  return {
    id: e.id, title: String(e.win.titleText || ''),
    x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
    hits: Boolean(el && e.win.bodyEl.contains(el)),
    focused: Boolean(e.term && e.term.el === document.activeElement),
    screen: e.term ? String(e.term.transcript || '') : '',
  }
})())"""

#: The band, its chevron and the slot the shell says is last — all read through the shell's own
#: report, which is what a registered check would read.
BAND = """JSON.stringify((() => {
  const shell = globalThis.INDEX.shell
  const r = shell.report()
  const el = document.querySelector('[data-band]')
  const chev = document.querySelector('[data-band-chev="next"]')
  const cb = chev && !chev.hidden && !chev.disabled ? chev.getBoundingClientRect() : null
  return {
    band: r.band, slots: r.slots, bandScrolls: r.bandScrolls | 0,
    scrollLeft: el.scrollLeft,
    chevron: cb ? { x: Math.round(cb.left + cb.width / 2),
                    y: Math.round(cb.top + cb.height / 2) } : null,
  }
})())"""
BAND_RESET = "(() => { document.querySelector('[data-band]').scrollLeft = 0; return '' })()"
REVEAL_LAST = """JSON.stringify((() => {
  const s = globalThis.INDEX.shell
  const n = s.report().slots.length
  return n ? { n, ...s.revealSlot(n) } : null
})())"""

#: A TRAY ICON'S CENTRE, hit-tested. An icon inside its strip but under a popup is still an icon a
#: hand cannot reach, which is `revealSlot`'s own `reachable` reading applied here.
TRAY_AIM = """JSON.stringify((() => {
  const btn = document.querySelector('[data-tray-icon]')
  if (!btn) return null
  const b = btn.getBoundingClientRect()
  const x = Math.round(b.left + b.width / 2), y = Math.round(b.top + b.height / 2)
  const el = document.elementFromPoint(x, y)
  return { x, y, label: btn.getAttribute('aria-label') || '',
           win: Number(btn.dataset.trayIcon), index: Number(btn.dataset.trayIndex),
           hits: Boolean(el && el.closest && el.closest('.tray-icon') === btn) }
})())"""

#: ONE PINNED BUTTON BY ITS LABEL, hit-tested the same way.
PIN_AIM = """JSON.stringify((() => {
  const btn = document.querySelector('[data-pin-btn=%s]')
  if (!btn) return null
  const b = btn.getBoundingClientRect()
  const x = Math.round(b.left + b.width / 2), y = Math.round(b.top + b.height / 2)
  const el = document.elementFromPoint(x, y)
  return { x, y, label: btn.dataset.pinBtn,
           hits: Boolean(el && el.closest && el.closest('.task-btn') === btn) }
})())"""

#: A KILL, BY PID, THROUGH THE PAGE'S OWN ROUTE. `end-process` is `reap(p, STAT_KILLED, SIGKILL)` in
#: `src/kernel/kernel.mjs`: fds closed, windows destroyed, NOTHING asked of the process — which is
#: the plan's requirement that the withdrawal be asserted by killing and not by asking (constraint
#: 14, teardown is not reap). `host.post` is the page's half of the transport and is the same
#: channel every `win-*` message goes down.
KILL = "(() => { globalThis.INDEX.host.post({ t: 'end-process', pid: %d }); return '' })()"


def settle(ff, tries: int = 100) -> dict:
    """Wait for the desktop to boot AND for its slot layout to stop moving.

    TWO IDENTICAL READS IN A ROW, which is `bench/m14-shell/firefox-drive.py`'s signal: a button
    read before the bar settles is a button clicked where it is not.
    """
    last, stable, st = None, 0, {}
    for _ in range(tries):
        got = ff.evaluate(STATE)
        st = got if isinstance(got, dict) else st
        now = json.dumps([(s.get("slot"), s.get("key")) for s in st.get("slots", [])])
        stable = stable + 1 if st.get("slots") and now == last else 0
        last = now
        if st.get("state") == "done" and st.get("shell") and stable >= 2:
            return st
        time.sleep(0.4)
    return st


def until(ff, want, tries: int = 60, pause: float = 0.4):
    """Poll the page's STATE until `want` likes it. Returns the last reading either way, so a
    caller reports what it saw rather than only that it waited."""
    st = {}
    for _ in range(tries):
        got = ff.evaluate(STATE)
        if isinstance(got, dict):
            st = got
            if want(st):
                return st
        time.sleep(pause)
    return st


def frame(ff, fid: int) -> dict:
    got = ff.evaluate(FRAME % int(fid))
    return got if isinstance(got, dict) else {}


def focus_frame(ff, fid: int, bad: list) -> dict:
    """Click into a window's body so the next real key goes to THAT window.

    A REAL CLICK AND NOT `term.focus()`. `src/wm/terminal.mjs` focuses its `<pre>` on `pointerdown`,
    so this exercises the route a hand takes — and a page calling `focus()` would pass in a world
    where the pointer never reached the widget at all.
    """
    f = frame(ff, fid)
    if not f or not f.get("hits"):
        bad.append("window %s was not hit-testable at its body centre: %s" % (fid, f))
        return f
    ff.click(f["x"], f["y"])
    time.sleep(0.4)
    after = frame(ff, fid)
    if not after.get("focused"):
        bad.append("a real click in window %s (%r) did not give its terminal the keyboard"
                   % (fid, after.get("title")))
    return after


def app_frames(st: dict, desk: int) -> list:
    return [f for f in st.get("frames", []) if f["id"] != desk]


def type_command(ff, line: str) -> None:
    """Type one shell command, after CLEARING whatever is already on the input line.

    THE CLEAR IS NOT HOUSEKEEPING. While the chord dispatcher is unwired, `bytesForKey` answers a
    byte for Alt+` (Alt is not Ctrl) — so every chord this gate presses into the terminal lands in
    the shell's line buffer, and the next command typed is `` `~`1editor `` and reads back as
    `command not found`. A SAVE clause failing because of a CHORD defect is a control moving an
    unnamed subset, which is the thing `CLAUDE.md` says verifies nothing.

    `ctrl-U` IS THE LINE DISCIPLINE'S OWN KILL — `TRM_DEF_KILL` is 21 in `src/abi.mjs` and
    `src/kernel/pty.mjs` clears the line on it — so this is the kernel's erase and not a count of
    backspaces that would be wrong by one the day a chord changes.
    """
    ff.press("u", ctrl=True)
    time.sleep(0.3)
    ff.type_keys(line)


def press_label(ff, label: str) -> dict:
    """PRESS WHAT THE MENU SAYS. `label` is a `src/wm/chords.mjs` row's own published spelling, so
    the gesture driven is the one a reader is told to use — and the `code` the engine delivers for
    the character is asserted against the row's `code` by the caller, which is what makes this
    derivation self-checking rather than a second copy of `KEY_LABEL`.
    """
    parts = label.split("+")
    char, mods = parts[-1], {p.lower() for p in parts[:-1]}
    unknown = mods - {"ctrl", "alt", "shift", "meta"}
    if unknown:
        raise SystemExit("chords.mjs published a modifier this gate cannot send: %s in %r"
                         % (sorted(unknown), label))
    ff.press(char, alt="alt" in mods, ctrl="ctrl" in mods, shift="shift" in mods,
             meta="meta" in mods)
    time.sleep(0.6)
    return {"label": label, "char": char, "mods": sorted(mods)}


def last_key(ff) -> dict:
    log = ff.evaluate(KEYS_READ)
    rows = [r for r in (log or []) if r.get("code") not in
            ("AltLeft", "AltRight", "ShiftLeft", "ShiftRight",
             "ControlLeft", "ControlRight", "MetaLeft", "MetaRight")]
    return rows[-1] if rows else {}


def narrow_until_overflow(ff) -> dict:
    """Find a viewport where the band overflows AND is still wider than one button.

    SEARCHED FOR THE REASON `bench/m22-band/probe.py` searches: the gap between those two states is
    about ten pixels and sits wherever this engine's clock and tray rendering put it, so a width
    measured in the other engine is a width that misses.
    """
    tried = []
    width = BAND_FROM
    while width >= BAND_TO:
        ff.set_viewport(width, WIDE_H)
        time.sleep(0.3)
        got = ff.evaluate(BAND)
        band = (got or {}).get("band") or {}
        tried.append({"w": width, "clientW": band.get("clientW"), "over": band.get("over")})
        if (band.get("over") or 0) > 1 and (band.get("clientW") or 0) >= band.get("minBtnW", 1e9):
            return {"width": width, "tried": tried, "read": got}
        width -= BAND_STEP
    return {"width": 0, "tried": tried, "read": None}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--url", default="", help="an already-running server; otherwise one is bound")
    ap.add_argument("--shot", default=str(HERE / "firefox-shell.png"))
    ap.add_argument("--json", default="", help="write every reading to this path")
    ap.add_argument("--prove-failure", action="store_true",
                    help="start the editor with %s — the world the defect shipped in. The BYTES "
                         "clause MUST die and every DRAWING clause MUST live. Exits 0 when the "
                         "proof SUCCEEDED." % SAVE_CONTROL)
    args = ap.parse_args(argv)

    httpd = None
    url = args.url
    if not url:
        os.chdir(REPO)
        httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d/www/index.html" % httpd.server_address[1]
    print("url      %s" % url)
    if args.prove_failure:
        print("control  --prove-failure: save-to-window-fd, started as `editor %s &` at the real "
              "prompt" % SAVE_CONTROL)

    #: UNIQUE PER RUN, so a marker found in the file cannot be last run's: Firefox gets a throwaway
    #: profile and therefore a fresh OPFS, and this says so rather than relying on it.
    marker = "FFSAVE%d" % (int(time.time()) % 100000)

    bad: list[str] = []
    red: list[str] = []
    out: dict = {"url": url, "control": SAVE_CONTROL if args.prove_failure else "",
                 "marker": marker, "clauses": {}}

    def clause(name: str, ok: bool, why: str) -> bool:
        out["clauses"][name] = bool(ok)
        if name in KNOWN_RED:
            if ok:
                bad.append("%s is GREEN and is listed in KNOWN_RED: the defect is fixed, so "
                           "PROMOTE the clause and delete the allowance" % name)
            else:
                red.append("%s — %s" % (name, KNOWN_RED[name]))
            return ok
        if not ok:
            bad.append("%s: %s" % (name, why))
        return ok

    try:
        with bidi.Firefox(headless=not args.headed, width=WIDE_W, height=WIDE_H) as ff:
            # THE VIEWPORT IS FORCED AND NOT LAUNCHED. `--width`/`--height` are capped by the
            # display, so the desktop a reader's layout is measured against would differ between
            # machines — and the band search below is a claim about a WIDTH. Set before the
            # navigation, because the taskbar reserves its strip in its constructor and every frame
            # is clamped into what is left (M13's `WinHost.relayout` lesson).
            ff.set_viewport(WIDE_W, WIDE_H)
            ff.navigate(url)
            st = settle(ff)
            print("firefox  dpr %s viewport %s" % (st.get("dpr"), st.get("viewport")))
            print("page     state=%r isolated=%s errors=%s"
                  % (st.get("state"), st.get("isolated"), st.get("errors")))
            if st.get("state") != "done" or st.get("isolated") is not True or not st.get("shell"):
                # A GATE THAT CANNOT REACH ITS SUBJECT MUST FAIL, never report clean: without the
                # SAB there is no kernel, no window and no published row, so every clause below
                # would be about nothing (CLAUDE.md, harness honesty).
                print("BAD      www/index.html did not boot a kernel and a shell in Firefox")
                return 1
            desk = st["deskWin"]
            out["boot"] = {k: st.get(k) for k in
                           ("dpr", "viewport", "deskWin", "deskPid", "deskRows", "buttons",
                            "pins", "pinButtons", "trayIcons", "pids")}
            print("shell    %s button(s), %s pin(s) %s, %s tray icon(s), desk win %s pid %s"
                  % (st["buttons"], st["pins"], st["pinButtons"], st["trayIcons"],
                     desk, st["deskPid"]))

            # ---- the chord table, out of the module both readers share --------------------------
            ff.evaluate(CHORDS, raw=True)
            table = {}
            for _ in range(40):
                got = ff.evaluate(CHORDS_READ)
                if got and got != "pending":
                    table = json.loads(got) if isinstance(got, str) else got
                    break
                time.sleep(0.2)
            if not table or table.get("threw") or not table.get("rows"):
                print("BAD      /src/wm/chords.mjs did not load in Firefox: %s" % json.dumps(table))
                return 1
            out["chordTable"] = table
            print("chords   %s row(s): %s" % (len(table["rows"]),
                                              [r["label"] for r in table["rows"]]))
            print("blocked  %s" % [b["label"] for b in table["blocked"]])

            # =================================================================================
            # QUESTION 5a: DOES THE MENU SHOW THE RIGHT ACCELERATOR?
            # =================================================================================
            ff.click(st["orb"]["x"], st["orb"]["y"])
            time.sleep(0.7)
            menu = ff.evaluate(STATE)
            print("menu     popup=%r accels=%s" % (menu.get("popup"), menu.get("accels")))
            clause("theStartMenuPublishedBothSwitchAccelerators",
                   table["next"] in (menu.get("accels") or [])
                   and table["prev"] in (menu.get("accels") or []),
                   "the start menu's accelerator cells are %s; the table says %r / %r"
                   % (menu.get("accels"), table["next"], table["prev"]))
            # THE OWNER'S RULE IS VERBATIM, so the two strings are named: a menu is a contract with
            # a reader, and `chords.mjs`'s `selfTest` asserting them against itself would pass over
            # a menu that printed nothing.
            clause("theAcceleratorsAreTheMeasuredOnes",
                   table["next"] == "Alt+`" and table["prev"] == "Alt+Shift+`",
                   "the published pair is %r / %r, not Alt+` / Alt+Shift+`"
                   % (table["next"], table["prev"]))
            clause("noBlockedChordIsOnScreen", menu.get("altTabOnScreen") is False,
                   "Alt+Tab is drawn or announced somewhere on the bar or in the popup, and it is "
                   "in chords.mjs's BLOCKED set: %s"
                   % json.dumps([b["why"] for b in table["blocked"] if b["id"] == "alt-tab"]))
            clause("everySlotButtonAnnouncesItsChord",
                   bool(menu.get("slotAccels"))
                   and all(a in [r["label"] for r in table["rows"]]
                           for a in menu["slotAccels"]),
                   "the band's aria-keyshortcuts are %s, which are not all chord labels"
                   % json.dumps(menu.get("slotAccels")))
            ff.press("Escape")
            time.sleep(0.5)

            # =================================================================================
            # QUESTION 2: DOES A PINNED BUTTON LAUNCH?
            # =================================================================================
            pins = st.get("pinButtons") or []
            want_pin = PREFER_PIN if PREFER_PIN in pins else (pins[0] if pins else "")
            aim = ff.evaluate(PIN_AIM % json.dumps(want_pin)) if want_pin else None
            print("pin      %r of %s -> %s" % (want_pin, pins, json.dumps(aim)))
            if not want_pin or not aim or not aim.get("hits"):
                clause("aRealClickOnAPinnedButtonStartedItsProgram", False,
                       "no hit-testable pinned button with no window of its own: pins=%s aim=%s"
                       % (pins, json.dumps(aim)))
                launched = st
            else:
                before = len(app_frames(st, desk))
                ff.click(aim["x"], aim["y"])
                launched = until(ff, lambda s: len(app_frames(s, desk)) > before, tries=50)
                after = len(app_frames(launched, desk))
                print("launch   %s -> %s app window(s), pinLaunches %s -> %s"
                      % (before, after, st["pinLaunches"], launched.get("pinLaunches")))
                clause("aRealClickOnAPinnedButtonStartedItsProgram",
                       after > before and launched.get("pinLaunches", 0) > st["pinLaunches"],
                       "the click left %s app window(s) and pinLaunches at %s"
                       % (after, launched.get("pinLaunches")))
                # AND THE PIN BECAME THE RUNNING PROGRAM'S BUTTON rather than a second one beside
                # it, which is Windows 7's own merge and the reason a pin's label is the group key.
                slot_kinds = {s["key"]: s["kind"] for s in launched.get("slots", [])}
                clause("theLaunchedPinMergedIntoItsWindowsButton",
                       slot_kinds.get(want_pin) == "group",
                       "the slot for %r is %r, so the pin and its window are two buttons"
                       % (want_pin, slot_kinds.get(want_pin)))
            out["pin"] = {"want": want_pin, "aim": aim,
                          "slots": launched.get("slots"), "pins": launched.get("pins")}

            # ---- more windows, so there is something to switch BETWEEN -------------------------
            term = next((f for f in app_frames(launched, desk)
                         if f["term"] and "$" in frame(ff, f["id"]).get("screen", "")), None)
            if not term:
                print("BAD      no terminal with a prompt on the landing desktop; nothing can be "
                      "typed, so questions 1, 3, 4 and 5b are unreachable")
                print("         frames %s" % json.dumps(launched.get("frames")))
                return 1
            print("term     win %s %r" % (term["id"], term["title"]))
            focus_frame(ff, term["id"], bad)
            # `-c` IS NOT DECORATION. `winopen` exits on its own ceiling and closes its windows
            # with it, and this run takes minutes — so without an explicit ceiling the windows
            # staged here die of old age mid-gate and the liveness clause at the end reads as a
            # kill that took too much. `www/shell.mjs`'s `PROGRAMS.winopen` passes `-c` for the
            # same reason.
            type_command(ff, "winopen -n 2 -c %d &\n" % WINOPEN_CEILING_MS)
            staged = until(ff, lambda s: len(app_frames(s, desk)) >= 4, tries=60)
            wins = app_frames(staged, desk)
            print("staged   %s app window(s): %s"
                  % (len(wins), [(w["id"], w["title"]) for w in wins]))
            if len(wins) < 3:
                print("BAD      fewer than three app windows; a switcher needs somewhere to go")
                print("         the terminal said: %s" % frame(ff, term["id"]).get("screen", "")[-400:])
                return 1

            # =================================================================================
            # QUESTION 5b: DOES THE CHORD WORK?
            # =================================================================================
            ff.evaluate(RECORDER, raw=True)
            focus_frame(ff, term["id"], bad)
            nxt = next(r for r in table["rows"] if r["label"] == table["next"])
            prv = next(r for r in table["rows"] if r["label"] == table["prev"])

            ff.evaluate(KEYS_CLEAR, raw=True)
            before = ff.evaluate(STATE)
            press_label(ff, nxt["label"])
            ev_next = last_key(ff)
            fwd = until(ff, lambda s: s.get("switches", 0) > before.get("switches", 0), tries=12)
            print("chord    %s -> code=%r key=%r trusted=%s mods=%s prevented=%s"
                  % (nxt["label"], ev_next.get("code"), ev_next.get("key"),
                     ev_next.get("trusted"), [k for k in ("alt", "ctrl", "shift", "meta")
                                              if ev_next.get(k)], ev_next.get("prevented")))
            print("         topmost %s -> %s, switches %s -> %s"
                  % (before.get("topmost"), fwd.get("topmost"),
                     before.get("switches"), fwd.get("switches")))

            # THE ENGINE CLAUSES: what arrived, which is this gate's own subject. The `code` reading
            # is the one `bench/m22-switch/probe.py` found the two engines disagreeing about on
            # `key`, so it is asserted against the TABLE's `code` and not against a spelling here.
            clause("theChordArrivedInFirefoxAsATrustedKey",
                   ev_next.get("trusted") is True,
                   "the forward chord did not arrive trusted: %s" % json.dumps(ev_next))
            clause("theChordCarriedTheCodeTheTableBindsOn",
                   ev_next.get("code") == nxt["code"],
                   "the menu says %r and Firefox delivered code=%r (key=%r); chords.mjs binds on "
                   "`code`, so a label a reader presses must produce the bound one"
                   % (nxt["label"], ev_next.get("code"), ev_next.get("key")))
            clause("theChordCarriedExactlyItsModifiers",
                   ev_next.get("alt") is True and ev_next.get("ctrl") is False
                   and ev_next.get("shift") is False,
                   "the modifiers that arrived were %s"
                   % json.dumps({k: ev_next.get(k) for k in ("alt", "ctrl", "shift", "meta")}))
            clause("theChordWasCancelledSoTheHostCannotHaveIt",
                   ev_next.get("prevented") is True,
                   "nothing called preventDefault on the chord. Every qualifying chord reads "
                   "host=never so nothing leaks today, but F6 measured host=stopped in Chrome: a "
                   "missed preventDefault there moves the reader's focus out of the page with no "
                   "error anywhere (bench/m22-switch/results-headless.json)")

            # THE DISPATCH CLAUSES: what the SHELL did with it.
            moved_fwd = fwd.get("switches", 0) > before.get("switches", 0)
            clause("theForwardChordWasTakenByTheShell", moved_fwd,
                   "switches stayed at %s. The chord ARRIVED (above), so this is the dispatcher "
                   "and not the engine: src/wm/winhost.mjs `#keys(id, bytes, event, sym)` (:661) "
                   "still has no `takeChord(event, modifierBits(event))` at its top, so no "
                   "`shell.switchWindow(chord.arg)` / `shell.selectSlot(chord.arg)` is ever "
                   "reached. That one call is the whole of the wiring and this file does not own "
                   "it." % before.get("switches"))
            clause("theForwardChordRaisedADifferentWindow",
                   moved_fwd and fwd.get("topmost") != before.get("topmost")
                   and any(w["id"] == fwd.get("topmost") for w in wins),
                   "topmost went %s -> %s, and the app windows are %s"
                   % (before.get("topmost"), fwd.get("topmost"), [w["id"] for w in wins]))

            # AND THE REVERSE, against the stack AS IT WAS AT THAT PRESS. A raise re-orders the
            # stack, so forward-then-back does NOT return a reader to where they were — measured
            # 4 -> 3 -> 2 on this tree. The clause is therefore "it moved again", not "it came
            # back": asserting a return would be asserting a transient held-chord order that does
            # not exist (`www/m22.html`, theReverseChordWentTheOtherWay).
            ff.evaluate(KEYS_CLEAR, raw=True)
            press_label(ff, prv["label"])
            ev_prev = last_key(ff)
            rev = until(ff, lambda s: s.get("switches", 0) > fwd.get("switches", 0), tries=12)
            print("chord    %s -> code=%r key=%r shift=%s; topmost %s -> %s, switches %s"
                  % (prv["label"], ev_prev.get("code"), ev_prev.get("key"), ev_prev.get("shift"),
                     fwd.get("topmost"), rev.get("topmost"), rev.get("switches")))
            # THE ENGINE DISAGREEMENT, ASSERTED WHERE IT BITES. Firefox delivers Shift+Backquote as
            # `key: "~"`; Chrome delivers "`". Both deliver `code: "Backquote"`. This clause is the
            # whole reason chords.mjs binds on `code`.
            clause("theShiftedChordStillCarriedTheBoundCode",
                   ev_prev.get("code") == prv["code"] and ev_prev.get("shift") is True,
                   "Firefox delivered code=%r key=%r shift=%s for %r. A dispatcher matching on "
                   "`key` would miss this one in Firefox and work in Chrome"
                   % (ev_prev.get("code"), ev_prev.get("key"), ev_prev.get("shift"),
                      prv["label"]))
            out["keyDisagrees"] = {"forward": ev_next.get("key"), "reverse": ev_prev.get("key"),
                                   "codeForward": ev_next.get("code"),
                                   "codeReverse": ev_prev.get("code")}
            clause("theReverseChordAlsoMovedTheStack",
                   rev.get("switches", 0) > fwd.get("switches", 0)
                   and rev.get("topmost") != fwd.get("topmost"),
                   "switches %s -> %s and topmost %s -> %s"
                   % (fwd.get("switches"), rev.get("switches"),
                      fwd.get("topmost"), rev.get("topmost")))

            # ---- THE INLINE NEGATIVE: an EXACT modifier word, not a superset or a bare key ------
            # A bare ` must not switch anything AND must still reach the program as a byte. The
            # second half is the positive control for the first: without it, "nothing switched" is
            # satisfied by "nothing arrived", which is the vacuous world CLAUDE.md names.
            ff.evaluate(KEYS_CLEAR, raw=True)
            ed_before = frame(ff, term["id"]).get("screen", "")
            bare_before = ff.evaluate(STATE)
            ff.press(nxt["label"].split("+")[-1])
            time.sleep(0.7)
            ev_bare = last_key(ff)
            bare = ff.evaluate(STATE)
            grew = frame(ff, term["id"]).get("screen", "")
            print("negative bare %r -> code=%r switches %s (was %s), screen grew %s byte(s)"
                  % (nxt["label"].split("+")[-1], ev_bare.get("code"), bare.get("switches"),
                     bare_before.get("switches"), len(grew) - len(ed_before)))
            clause("aBareKeyWithNoModifierIsNotTheChord",
                   bare.get("switches") == bare_before.get("switches"),
                   "switches moved %s -> %s on a bare key, so chordAt matched a subset of the "
                   "modifier word" % (bare_before.get("switches"), bare.get("switches")))
            clause("theBareKeyReachedTheProgramInstead",
                   ev_bare.get("code") == nxt["code"] and len(grew) > len(ed_before),
                   "the bare key arrived as code=%r and the terminal's screen grew %s byte(s); "
                   "without this the clause above is satisfied by a key that never arrived"
                   % (ev_bare.get("code"), len(grew) - len(ed_before)))

            # ---- AND THE DIRECT-SELECT SET ----------------------------------------------------
            slot1 = next((r for r in table["rows"]
                          if r["action"] == table["select"] and r["arg"] == 1), None)
            sel_before = ff.evaluate(STATE)
            if slot1 and sel_before.get("slots"):
                focus_frame(ff, term["id"], bad)
                press_label(ff, slot1["label"])
                sel = until(ff, lambda s: s.get("selects", 0) > sel_before.get("selects", 0),
                            tries=12)
                key1 = sel_before["slots"][0]["key"]
                group1 = next((g for g in sel.get("groups", []) if g["key"] == key1), None)
                print("chord    %s -> selects %s -> %s; slot 1 is %r, now %r"
                      % (slot1["label"], sel_before.get("selects"), sel.get("selects"), key1,
                         (group1 or {}).get("state")))
                clause("theSlotChordWasTakenByTheShell",
                       sel.get("selects", 0) > sel_before.get("selects", 0),
                       "selects stayed at %s — the same one unwired call named above"
                       % sel_before.get("selects"))
                clause("theSlotChordActedOnSlotOne",
                       (group1 or {}).get("state") == "active"
                       or sel.get("pinLaunches", 0) > sel_before.get("pinLaunches", 0),
                       "slot 1 is %r and its group reads %r with pinLaunches %s -> %s"
                       % (key1, (group1 or {}).get("state"), sel_before.get("pinLaunches"),
                          sel.get("pinLaunches")))
                out["slot"] = {"label": slot1["label"], "key": key1,
                               "state": (group1 or {}).get("state")}

            # =================================================================================
            # QUESTION 4: IF I SAVE A FILE, IS IT ACTUALLY SAVED?
            # =================================================================================
            focus_frame(ff, term["id"], bad)
            type_command(ff, "editor%s &\n"
                         % ((" " + SAVE_CONTROL) if args.prove_failure else ""))
            opened = until(ff, lambda s: any(f["title"].startswith("editor")
                                             for f in app_frames(s, desk)), tries=60)
            ed = next((f for f in app_frames(opened, desk) if f["title"].startswith("editor")),
                      None)
            save = {"opened": bool(ed), "title": (ed or {}).get("title")}
            if not ed:
                clause("theEditorOpenedAWindow", False,
                       "`editor &` opened no window in Firefox; the terminal said %r"
                       % frame(ff, term["id"]).get("screen", "")[-400:])
            else:
                clause("theEditorOpenedAWindow", True, "")
                print("editor   win %s %r" % (ed["id"], ed["title"]))
                focus_frame(ff, ed["id"], bad)
                ff.type_keys(marker)
                typed = frame(ff, ed["id"])
                for _ in range(20):
                    if marker in typed.get("screen", ""):
                        break
                    time.sleep(0.3)
                    typed = frame(ff, ed["id"])
                clause("theTypedBytesReachedTheEditor", marker in typed.get("screen", ""),
                       "%r is not on the editor's screen: %r"
                       % (marker, typed.get("screen", "")[-300:]))
                # WHERE A SAVE GOES IS READ OFF THE PROGRAM'S OWN SCREEN and never written here.
                # `src/bin/editor.mjs` prints `ctrl-S saves to <path>.` before any save happens, and
                # `std.sessionDir` is the one definition of that path — a constant here would be the
                # copy that drifts the day the session's tree moves (M19a, D40).
                # GREEDY, AND THE SENTENCE'S FULL STOP IS THE ANCHOR. `\S+?` matched
                # `/Users/Default/untitled` out of `/Users/Default/untitled.txt.` — a path that
                # exists in no filesystem, so `cat` answered ENOENT and this gate reported the
                # editor at fault for a save that had worked. The trailing `\s` is what makes the
                # backtrack land on the sentence's stop rather than on the extension's dot.
                found = re.search(r"ctrl-S saves to (\S+)\.\s", typed.get("screen", ""))
                path = found.group(1) if found else ""
                save["path"] = path
                clause("theEditorSaidWhereItWouldSave", bool(path),
                       "the editor's screen does not name a save destination: %r"
                       % typed.get("screen", "")[:300])
                before_len = len(typed.get("screen", ""))
                ff.press("s", ctrl=True)
                saved = frame(ff, ed["id"])
                for _ in range(30):
                    if "[saved" in saved.get("screen", "")[before_len:]:
                        break
                    time.sleep(0.3)
                    saved = frame(ff, ed["id"])
                tail = saved.get("screen", "")[before_len:]
                save["tail"] = tail
                print("save     path=%r tail=%r" % (path, tail.strip()[:160]))
                # THE DRAWING CLAUSE, which is the one that HELD while the defect shipped.
                clause("theEditorDrewASaveItsReaderCanSee", "[saved" in tail,
                       "ctrl-S drew nothing on the editor's screen: %r" % tail[-300:])
                # AND IT SAVED WHERE IT SAID IT WOULD, which also cross-checks the parse above: a
                # path read one character short reads back as ENOENT and would report the editor at
                # fault for a save that worked. It has already done exactly that once.
                told = re.search(r"\[saved \d+ byte\(s\) to (.+?)\]", tail)
                save["reportedPath"] = told.group(1) if told else ""
                clause("theSaveWentWhereTheEditorSaidItWould",
                       bool(told) and bool(path) and told.group(1) == path,
                       "the editor offered %r before the save and reported %r after it"
                       % (path, told.group(1) if told else None))

                # ---- AND THE BYTES, THROUGH A READER'S OWN ROUTE ----
                # `cat` at the real prompt is a FRESH `open` in a DIFFERENT process, which is the
                # only reading that distinguishes "the ABI accepted the bytes" from "the bytes are
                # in the file" — exactly the defect M22 retires.
                if path:
                    focus_frame(ff, term["id"], bad)
                    prompt_before = len(frame(ff, term["id"]).get("screen", ""))
                    type_command(ff, "cat %s\n" % path)
                    shown = frame(ff, term["id"])
                    for _ in range(40):
                        if len(shown.get("screen", "")) > prompt_before + len(path):
                            break
                        time.sleep(0.3)
                        shown = frame(ff, term["id"])
                    time.sleep(1.0)
                    body = frame(ff, term["id"]).get("screen", "")[prompt_before:]
                    save["cat"] = body
                    print("cat      %r" % body.strip()[:200])
                    clause("theBytesAreInTheFileWhenItIsReopened", marker in body,
                           "`cat %s` at the real prompt does not show %r — the save drew a "
                           "message and wrote nothing a second process can read: %r"
                           % (path, marker, body[-300:]))
            out["save"] = save

            # =================================================================================
            # QUESTION 1: CAN I REACH EVERY TASKBAR BUTTON?
            # =================================================================================
            found = narrow_until_overflow(ff)
            out["band"] = {"width": found["width"], "tried": found["tried"]}
            if not found["width"]:
                clause("theBandReachesItsLastButtonWhenItOverflows", False,
                       "no viewport between %s and %s px left the band overflowing and still "
                       "wider than one button: %s"
                       % (BAND_FROM, BAND_TO, json.dumps(found["tried"][-4:])))
            else:
                band = found["read"]["band"]
                print("band     %s px desktop -> clientW=%s scrollW=%s over=%s overflow-x=%r"
                      % (found["width"], band["clientW"], band["scrollW"], band["over"],
                         band["overflowX"]))
                clause("theBandIsAScrollerAndNotAClip", band["overflowX"] == "auto",
                       "computed overflow-x is %r, so the buttons past the edge are clipped and "
                       "unreachable — which is what `band-clips` restores" % band["overflowX"])
                ff.evaluate(BAND_RESET, raw=True)
                chev = ff.evaluate(BAND).get("chevron")
                scrolls_before = ff.evaluate(BAND).get("bandScrolls", 0)
                if not chev:
                    clause("aRealClickOnTheChevronScrollsTheBand", False,
                           "no enabled chevron was shown while the band overflowed, so a reader "
                           "has no affordance at all")
                else:
                    ff.click(chev["x"], chev["y"])
                    time.sleep(0.6)
                    after = ff.evaluate(BAND)
                    print("chevron  a trusted click at (%s,%s) -> scrollLeft %s, bandScrolls %s"
                          % (chev["x"], chev["y"], after.get("scrollLeft"),
                             after.get("bandScrolls")))
                    clause("aRealClickOnTheChevronScrollsTheBand",
                           (after.get("scrollLeft") or 0) > 0
                           and after.get("bandScrolls", 0) > scrolls_before,
                           "scrollLeft is %s and bandScrolls went %s -> %s"
                           % (after.get("scrollLeft"), scrolls_before, after.get("bandScrolls")))
                ff.evaluate(BAND_RESET, raw=True)
                reveal = ff.evaluate(REVEAL_LAST)
                print("reveal   %s" % json.dumps(reveal))
                clause("theBandReachesItsLastButtonWhenItOverflows",
                       bool(reveal) and reveal.get("inView") is True
                       and reveal.get("reachable") is True,
                       "the last button reads inView=%s reachable=%s at any scroll position"
                       % ((reveal or {}).get("inView"), (reveal or {}).get("reachable")))
            ff.set_viewport(WIDE_W, WIDE_H)
            time.sleep(0.5)

            # =================================================================================
            # QUESTION 3: DOES THE TRAY ICON GO WHEN I KILL THE PROGRAM?
            # LAST, because the kill it ends on takes the desktop process with it.
            # =================================================================================
            st = ff.evaluate(STATE)
            tray_aim = ff.evaluate(TRAY_AIM)
            print("tray     %s icon(s) %s -> %s"
                  % (st.get("trayIcons"), json.dumps(st.get("tray")), json.dumps(tray_aim)))
            clause("theTrayDrewAStatusIcon",
                   (st.get("trayIcons") or 0) >= 1 and bool(st.get("tray")),
                   "the tray drew %s icon(s) for %s published row(s)"
                   % (st.get("trayIcons"), len(st.get("tray") or [])))
            if tray_aim and tray_aim.get("hits"):
                before = len(app_frames(st, desk))
                ff.click(tray_aim["x"], tray_aim["y"])
                ran = until(ff, lambda s: len(app_frames(s, desk)) > before, tries=50)
                print("tray     a trusted click on %r -> %s -> %s app window(s), trayClicks %s"
                      % (tray_aim.get("label"), before, len(app_frames(ran, desk)),
                         ran.get("trayClicks")))
                clause("aRealClickOnTheTrayIconRanItsVerb",
                       len(app_frames(ran, desk)) > before
                       and ran.get("trayClicks", 0) > st.get("trayClicks", 0),
                       "the click left %s app window(s) and trayClicks at %s — an icon that does "
                       "nothing is not a tray icon"
                       % (len(app_frames(ran, desk)), ran.get("trayClicks")))
                st = ran
            else:
                clause("aRealClickOnTheTrayIconRanItsVerb", False,
                       "the tray icon was not hit-testable at its centre: %s"
                       % json.dumps(tray_aim))

            # THE PLAN'S SENTENCE: kill the process that published the row, and the icon goes.
            # Asserted by KILLING and not by asking the process to withdraw (constraint 14).
            owner = st.get("deskPid") or 0
            strangers = [w["id"] for w in app_frames(st, desk)]
            ff.evaluate(KILL % owner, raw=True)
            killed = until(ff, lambda s: (s.get("trayIcons") or 0) == 0, tries=25, pause=0.4)
            print("kill     pid %s (published the row) -> %s tray icon(s), desk frame present=%s"
                  % (owner, killed.get("trayIcons"),
                     any(f["id"] == desk for f in killed.get("frames", []))))
            out["tray"] = {"aim": tray_aim, "ownerPid": owner,
                           "iconsAfterKill": killed.get("trayIcons"),
                           "deskFrameStillUp": any(f["id"] == desk
                                                   for f in killed.get("frames", []))}
            # THE `why` IS WRITTEN EVEN THOUGH THESE TWO ARE IN `KNOWN_RED`, because the day the
            # kernel fix lands and the allowance is deleted this is the sentence the gate has to
            # say. Two of them printed as a bare name with an empty reason in the run that proved
            # the allowance is coupled, which is how this was noticed.
            clause("theTrayIconWentWhenItsOwnProcessDied",
                   (killed.get("trayIcons") or 0) == 0,
                   "killing pid %s left %s tray icon(s) on screen: the icon outlives the process "
                   "that published it, which is the classic tray defect"
                   % (owner, killed.get("trayIcons")))
            clause("theKernelDestroyedItsWindowsToo",
                   not any(f["id"] == desk for f in killed.get("frames", [])),
                   "window %s is still in the page's table after its process was reaped, so "
                   "teardown closed fds and destroyed nothing (constraint 14)" % desk)
            # AND THE KILL WAS AIMED: the windows the PAGE started inherited nothing from the
            # desktop and must still be there. A clause reading only an empty tray would pass for a
            # page that ended everything.
            clause("theKillWasAimedAtOneProcess",
                   bool(strangers) and all(any(f["id"] == s for f in killed.get("frames", []))
                                           for s in strangers),
                   "the windows the page itself started (%s) are not all still up: %s"
                   % (strangers, [f["id"] for f in killed.get("frames", [])]))

            try:
                ff.screenshot(args.shot)
                print("shot     %s" % args.shot)
            except Exception as error:   # a screenshot is evidence, never the gate
                print("shot     unavailable: %s" % error)
    finally:
        if httpd:
            httpd.shutdown()

    if args.json:
        pathlib.Path(args.json).write_text(json.dumps(out, indent=1), encoding="utf-8")
        print("json     %s" % args.json)

    print("")
    for line in red:
        print("RED      %s" % line)
    for line in bad:
        print("BAD      %s" % line)

    if args.prove_failure:
        # THE NAMED ASYMMETRY, and the POSITIVE HALF IS PART OF THE PROOF. Under
        # `--save-to-window-fd` the bytes clause must be the one that died while the drawing
        # clauses lived. A control whose subject never worked in the first place proves nothing —
        # an assertion over a constant still inverts and still fires (CLAUDE.md) — so an absent
        # `[saved` line or an editor that never opened makes this BROKEN rather than SUCCEEDED.
        c = out["clauses"]
        want_drawn = ("theEditorOpenedAWindow", "theTypedBytesReachedTheEditor",
                      "theEditorSaidWhereItWouldSave", "theEditorDrewASaveItsReaderCanSee",
                      "theSaveWentWhereTheEditorSaidItWould")
        drew = [n for n in want_drawn if c.get(n) is True]
        bytes_dead = c.get("theBytesAreInTheFileWhenItIsReopened") is False
        print("\nprove-failure: bytes clause died=%s, drawing clauses alive=%s/%s %s"
              % (bytes_dead, len(drew), len(want_drawn), drew))
        print("               cat said %r" % (out.get("save", {}).get("cat", "")[:160]))
        if len(drew) != len(want_drawn):
            print("BROKEN   the editor's drawing clauses did not all hold, so the control has no "
                  "world: the defect it restores is one a reader CANNOT see")
            return 1
        return 0 if bytes_dead else 1

    print("%s" % ("ok       every engine clause held in Firefox"
                  + (" (%d known-red clause(s) reported above)" % len(red) if red else "")
                  if not bad else "%d clause(s) failed" % len(bad)))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
