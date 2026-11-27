#!/usr/bin/env python3
"""M22's chord probe: WHICH Alt+Tab SUBSTITUTE IS FREE, in Chrome and in Firefox?

    python3 bench/m22-switch/probe.py                      # both engines, headless
    python3 bench/m22-switch/probe.py --headed             # ...in real windows
    python3 bench/m22-switch/probe.py --engine firefox     # one engine
    python3 bench/m22-switch/probe.py --control nodispatch # THE REQUIRED CONTROL (see below)
    python3 bench/m22-switch/probe.py --prove-failure      # all three controls, scored

R22 says a window switcher MUST exist with a PUBLISHED chord (`docs/PRD-SHELL.md:357`), and A14
(`:718`) says the published accelerator must be one the system actually receives, because a menu
showing an accelerator the system cannot receive is the live-looking-button defect M11 already
recorded. `docs/PLAN-SHELL.md:1206` names this file as the measurement that prices the choice.

WHAT "FREE" MEANS HERE, as five readings and not one. A chord is free only if all five hold:

  1. **received** — a `keydown` reached the page at all;
  2. **mods** — it carried exactly the modifiers that were held, and no others. A dropped modifier
     is a DIFFERENT chord, not a weaker one, and it arrives as a working keypress rather than as an
     error (the trap `scripts/bidi.py`'s `press` docstring records);
  3. **code** — it arrived on the physical key that was asked for. `code` and NOT `key`, because
     the two engines disagree about `key`: see `Chord.code`, which carries the measurement;
  4. **preventable** — `cancelable` is true AND `defaultPrevented` reads true after the listener
     called `preventDefault`. A chord the page receives but cannot cancel is NOT free: the host
     acts on it too, so one press produces two behaviours;
  5. **host quiet** — the press did not blur the window or hide the document. `preventDefault`
     governs the DOM's default action and says NOTHING about a browser accelerator, so clauses 4
     and 5 are independent: a tab switch is observable only as a `visibilitychange`, and focusing
     browser chrome only as a `blur`. The probe opens a SECOND TAB first, so a tab-switching chord
     has somewhere to go — with one tab, Ctrl+Tab does nothing and would report free.

Clause 5 then gets a PER-CHORD POSITIVE CONTROL, which is what makes it evidence rather than an
assertion over a detector nobody saw fire: every chord is run a second time with the listener
cancelling nothing, and the `host` column reports `never` / `stopped` / `anyway`. See
`merge_uncancelled`.

WHAT THIS CANNOT MEASURE, STATED PLAINLY. A CDP or BiDi keystroke is injected at the RENDERER, so
it passes neither the host window manager nor — on the evidence below — the browser's own
accelerator table reliably. Two classes of chord are therefore reported by this probe as arriving
when a physical press would not have, and in both the reading is an artefact of the injection point
and not evidence:

  - **the window manager's.** Alt+Tab on Windows and most Linux desktops, Cmd+Tab and Cmd+` on
    macOS, anything with the Win key (`docs/PRD-SHELL.md:754-757`). The reference machine is macOS,
    where the app switcher is Cmd+Tab and NOT Alt+Tab, so a macOS run cannot answer the
    Windows/Linux question for Alt+Tab at all.
  - **the browser's own.** Headless Chrome stayed quiet on Ctrl+Tab with two tabs open, which an
    accelerator table reached by a physical press would not have. `F6` is what shows this class is
    weak rather than absent: Chrome DID act on that one.

So a `Chord` carries an `os` field and a `browser` field naming the documented consumers at each
level, and the verdict REFUSES a chord on either ground even when all five measured clauses are
green. The qualifying list is what is left.

WHICH RUN IS THE HONEST ONE, MEASURED. A headless browser has no tab strip and no menu bar, so a
headed run ought to be the better world for a question about accelerators. On the reference machine
it is only half available:

  - **headed FIREFOX works.** BiDi's `input.performActions` delivers to a window that does not hold
    the OS focus, and the headed table matches the headless one on all 25 rows — at dpr 2 headed
    against dpr 1 headless, so the agreement is not a ratio coincidence either.
  - **headed CHROME measures NOTHING.** The window opens behind the terminal, never takes the OS
    focus, and `Input.dispatchKeyEvent` delivers no key at all — not the bare digit either.
    `Emulation.setFocusEmulationEnabled` was tried and does not change it. `osascript` could raise
    the window, but `System Events` answers `-1743 Not authorized` without an accessibility grant,
    which a harness must not ask for. So the CHROME column is a HEADLESS measurement, and the
    headless browser's weaker accelerator handling is a stated limit of this table rather than a
    thing it hides.

THE CONTROL, which is the point of the file as much as the table is. `--control nodispatch` sends
nothing and EVERY row must then read `received: no` — which is exactly how this table renders a
chord the host consumed, so a row reading "taken" is shown to be coupled to arrival rather than
constant. `--control nomods` sends the bare key and every modified row must lose its `mods`
reading. `--control nopreventdefault` loads the fixture with `?nopd=1` and every row must lose its
`preventable` reading. `--prove-failure` runs all three and checks each moved its OWN named column
and no other; it exits 0 when the proof SUCCEEDED.
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

import bidi  # noqa: E402
import cdp  # noqa: E402
import serve  # noqa: E402

DOC = "/bench/m22-switch/chords.html"

#: Chrome's `Input.dispatchKeyEvent` modifier bitmask, as `scripts/cdp.py` records it.
CDP_MOD_BITS = {"alt": 1, "ctrl": 2, "meta": 4, "shift": 8}

#: The UI Events `key` a modifier delivers, its `code`, and its Windows virtual key code. Needed
#: because a chord is dispatched as the modifier's OWN keydown and then the key, which is what a
#: real hand does — a bare `modifiers` bitmask with no modifier keydown is a shape no keyboard
#: produces, and a browser accelerator table may read either.
CDP_MODIFIER_WIRE = {
    "alt": ("Alt", "AltLeft", 18),
    "ctrl": ("Control", "ControlLeft", 17),
    "shift": ("Shift", "ShiftLeft", 16),
    "meta": ("Meta", "MetaLeft", 91),
}

#: `key` -> (`code`, Windows virtual key code). The ONE place a chord's Chrome wire spelling lives.
#: `scripts/cdp.py`'s `KEYS` covers Tab and Escape only and carries no `code`, and this probe needs
#: Backquote, Space, the digits and F6 — so the table is here rather than a second copy there.
CDP_KEY_WIRE = {
    "Tab": ("Tab", 9),
    "Escape": ("Escape", 27),
    "`": ("Backquote", 192),
    " ": ("Space", 32),
    "F6": ("F6", 117),
    **{str(n): ("Digit%d" % n, 48 + n) for n in range(1, 10)},
}

#: Modifier order is fixed, so a row's id and its dispatch agree and two rows cannot differ only
#: in the order their modifiers went down.
MOD_ORDER = ("ctrl", "alt", "shift", "meta")

#: THE REACHABILITY KEY, and why the whole table rests on it. A bare digit is reserved by no
#: accelerator in either engine, so if IT does not arrive the keyboard channel is not reaching the
#: page at all — and then every row reads `received: NO`, which is indistinguishable from "the host
#: took every chord". A harness MUST fail when it cannot reach what it was pointed at (CLAUDE.md),
#: so an unreachable run refuses to print a table instead of printing a table of refusals.
#:
#: MEASURED, NOT ASSUMED, AND IT CAUGHT A REAL ONE: a HEADED Chrome on this machine opens behind
#: the terminal, never takes the OS focus, and delivers no key at all. Without this gate that run
#: reported every one of the 23 chords taken, which is the worst outcome available: a clean-looking
#: table about a channel that was not carrying anything.
#:
#: It is also the POSITIVE CONTROL FOR `nodispatch`: the gate runs there too, so the channel is
#: proven live and only then is nothing sent.
REACH_KEY = "5"


class Chord:
    """One candidate, in the one form both engine drivers read.

    TWO DOCUMENTED-CONSUMER FIELDS, NEITHER OF THEM MEASURED HERE, and both of them blocking:

    `os`      the window managers documented to eat the PHYSICAL chord before any browser sees it.
              An injected keystroke never passes a window manager, so this probe reports such a
              chord as arriving and that reading is an artefact of the injection point.
    `browser` the engines documented to bind the chord in their own UI. Measured and DOCUMENTED
              disagree for this class: headless Chrome stayed quiet on Ctrl+Tab with two tabs open,
              which an accelerator table reached by a physical press would not have. CDP and BiDi
              both inject at the renderer, so a `never` here is weak evidence exactly where the
              documentation is strong — and `F6` is the proof that it is weak rather than absent,
              because Chrome DID act on that one.

    A chord is not selected over either field, however green its four measured clauses are. That is
    the whole point of recording them beside the table rather than in a report nobody re-runs.
    """

    __slots__ = ("cid", "key", "mods", "why", "os", "browser")

    def __init__(self, cid: str, key: str, mods: tuple, why: str, host_os: str = "",
                 browser: str = "") -> None:
        self.cid, self.key, self.mods, self.why = cid, key, mods, why
        self.os, self.browser = host_os, browser

    def blocked(self) -> str:
        """Why a documented consumer rules it out, or "" if none does."""
        return "; ".join(part for part in (self.os, self.browser) if part)

    def code(self) -> str:
        """The `KeyboardEvent.code` this chord must arrive as.

        READ OUT OF `CDP_KEY_WIRE` AND NOT RESTATED, because that table already holds the one
        mapping from the key to its physical identity.

        WHY `code` AND NOT `key` IS THE IDENTITY, MEASURED: Firefox delivers a shifted backtick as
        `key: '~'` and Chrome, over CDP, as `key: '`'` — because `Input.dispatchKeyEvent` lets the
        caller assert `key` outright while BiDi lets the ENGINE apply the layout, which is what a
        real keyboard does. So `key` is layout- and shift-dependent and the two engines disagree
        about it; `code` is the physical key and does not move. A dispatcher that binds a chord on
        `key` is bound to a keyboard layout nobody promised it.
        """
        return CDP_KEY_WIRE[self.key][0]

    def label(self) -> str:
        parts = [m.capitalize() if m != "ctrl" else "Ctrl" for m in MOD_ORDER if m in self.mods]
        shown = {" ": "Space", "`": "`"}.get(self.key, self.key)
        return "+".join([*parts, shown])


def candidates() -> list[Chord]:
    """The table: the plan's eleven, plus six with a stated reason each.

    A SWITCHER NEEDS A REVERSE, so every forward candidate worth taking is tested with its Shift
    partner. A chord selected without one ships half a gesture: Windows 7's switcher goes both ways
    and a reader who overshoots has no way back.
    """
    rows = [
        Chord("alt-tab", "Tab", ("alt",),
              "the baseline, and Windows 7's own switcher",
              "Windows, GNOME, KDE, Xfce: the window manager's switcher"),
        Chord("ctrl-tab", "Tab", ("ctrl",),
              "the browser's own tab switcher, so the likeliest collision",
              browser="Chrome and Firefox: next tab"),
        Chord("alt-backquote", "`", ("alt",),
              "no Windows 7 meaning and no documented consumer at either level, which is what "
              "makes it a candidate. ` is also the key physically next to Tab"),
        Chord("ctrl-backquote", "`", ("ctrl",),
              "no Windows 7 meaning and no documented consumer either"),
        Chord("alt-escape", "Escape", ("alt",),
              "Windows' own 'cycle windows without the overlay'",
              "Windows: cycles windows"),
        Chord("ctrl-escape", "Escape", ("ctrl",),
              "opens the Start menu on Windows",
              "Windows: opens Start"),
        Chord("meta-tab", "Tab", ("meta",),
              "Cmd+Tab on macOS, Win+Tab on Windows: the OS switcher on both",
              "macOS: Cmd+Tab app switcher; Windows: Win+Tab Task View"),
        Chord("ctrl-shift-tab", "Tab", ("ctrl", "shift"),
              "the tab switcher, backwards",
              browser="Chrome and Firefox: previous tab"),
        Chord("alt-shift-tab", "Tab", ("alt", "shift"),
              "Alt+Tab backwards, so it inherits Alt+Tab's fate",
              "Windows, GNOME, KDE, Xfce: the switcher, reversed"),
        Chord("f6", "F6", (),
              "both engines move focus between browser UI regions with it",
              browser="Chrome and Firefox: move focus between browser UI regions — and Chrome's "
                      "was MEASURED acting on it, uncancelled"),
        # ---- six additions, each with a stated reason ----
        Chord("ctrl-alt-tab", "Tab", ("ctrl", "alt"),
              "Windows 7's OWN persistent switcher: the overlay that stays up",
              "Windows: the sticky Alt+Tab"),
        Chord("alt-space", " ", ("alt",),
              "Windows' window menu — R22's sibling gesture, and a chord this shell will want",
              "Windows: opens the system menu"),
        Chord("ctrl-f6", "F6", ("ctrl",),
              "Windows' MDI 'next child window', which is THIS system's shape: windows inside one "
              "host window"),
        Chord("shift-f6", "F6", ("shift",),
              "the reverse of F6, and of Ctrl+F6",
              browser="Chrome and Firefox: the same focus walk, reversed"),
        # The reverses of the two candidates nothing is documented to consume. Tested because a
        # forward chord selected without a working reverse is half a gesture.
        Chord("alt-shift-backquote", "`", ("alt", "shift"),
              "the REVERSE of Alt+`, which a switcher needs and which nothing is documented to "
              "consume"),
        Chord("ctrl-shift-backquote", "`", ("ctrl", "shift"),
              "the reverse of Ctrl+`"),
    ]
    rows += [Chord("alt-%d" % n, str(n), ("alt",),
                   "the Superbar's Nth button; Windows 7 spells it Win+%d, which no page can "
                   "receive" % n)
             for n in range(1, 10)]
    return rows


# ---------------------------------------------------------------------------------------------
# the page side, shared by both engines
# ---------------------------------------------------------------------------------------------

def snap(evaluate) -> dict:
    """`__snap()` as a dict. `evaluate` is whichever engine's one-argument evaluator."""
    raw = evaluate("globalThis.__snap()")
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def await_ready(evaluate, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if evaluate("String(Boolean(globalThis.__ready))") == "true":
            return True
        time.sleep(0.1)
    return False


def reachable(evaluate, send_reach) -> dict:
    """Prove the keyboard channel reaches the page before any chord is read off it.

    Returns the reading, so the caller can refuse the run rather than print a table of `NO`s.
    """
    evaluate("String(globalThis.__focus())")
    evaluate("String(globalThis.__reset())")
    send_reach()
    time.sleep(0.2)
    got = snap(evaluate)
    seen = got.get("seen") or []
    return {"ok": any(r.get("key") == REACH_KEY for r in seen),
            "events": len(seen),
            "keys": [r.get("key") for r in seen][:4]}


def score(chord: Chord, got: dict, baseline: dict) -> dict:
    """One row's four readings, from the page's snapshot.

    `baseline` is the snapshot taken BEFORE any chord was sent. HARNESS HONESTY: if the page did
    not hold the focus to begin with, `hostQuiet` cannot report a clean state, so it is marked
    unusable rather than read as evidence against every chord.
    """
    seen = got.get("seen") or []
    rec = seen[-1] if seen else None
    row = {
        "id": chord.cid,
        "label": chord.label(),
        "why": chord.why,
        "os": chord.os,
        "events": len(seen),
        "received": rec is not None,
        "key": (rec or {}).get("key"),
        "code": (rec or {}).get("code"),
        "wantCode": chord.code(),
        "trusted": (rec or {}).get("trusted"),
        "cancelable": (rec or {}).get("cancelable"),
        "prevented": (rec or {}).get("prevented"),
        "blurs": got.get("blurs"),
        "hidden": got.get("hidden"),
        "hasFocus": got.get("hasFocus"),
        "modsSeen": None,
        "mods": False,
        "preventable": False,
        "hostQuiet": None,
        "free": False,
    }
    if rec is not None:
        # `MOD_ORDER`'s names ARE the fixture's record keys, which is why there is no second table.
        held = {name for name in MOD_ORDER if rec.get(name)}
        row["modsSeen"] = "+".join(n for n in MOD_ORDER if n in held) or "-"
        row["mods"] = held == set(chord.mods)
        # `code` IS THE IDENTITY CLAUSE, not `key` — see `Chord.code`. `keyOk` is kept as
        # reportage, so a run says WHICH character each engine put on the same physical key.
        row["codeOk"] = rec.get("code") == chord.code()
        row["keyOk"] = rec.get("key") == chord.key
        row["preventable"] = bool(rec.get("cancelable")) and bool(rec.get("prevented"))
    else:
        row["codeOk"] = False
        row["keyOk"] = False

    # CLAUSE 5 IN TWO HALVES, because they need different things to be readable at all.
    # `visibilitychange` is a TAB-level fact and fires whether or not the page ever held the focus,
    # so the tab-switch half is readable in both engines. `blur` and `hasFocus` need the page to
    # have had the focus to begin with — Firefox under BiDi never reports it, headed or headless —
    # so that half is marked unreadable rather than read as evidence against every chord.
    tab_quiet = not got.get("hidden")
    focus_quiet = None
    if baseline.get("hasFocus"):
        focus_quiet = (not got.get("blurs")) and bool(got.get("hasFocus"))
    row["tabQuiet"] = tab_quiet
    row["focusQuiet"] = focus_quiet
    row["hostQuiet"] = tab_quiet if focus_quiet is None else (tab_quiet and focus_quiet)
    row["hostQuietPartial"] = focus_quiet is None

    row["free"] = bool(row["received"] and row["mods"] and row["codeOk"]
                       and row["preventable"] and row["hostQuiet"])
    return row


def merge_uncancelled(result: dict, loose: dict) -> None:
    """Fold the UNCANCELLED world's host-action reading into each row of the cancelled one.

    THIS IS A PER-CHORD POSITIVE CONTROL FOR CLAUSE 5, and without it clause 5 is an assertion over
    something that was never shown capable of firing. `hostQuiet: yes` can mean either "the page
    cancelled the host's action" or "the detector never fires for anything". Running the same chord
    with the listener cancelling NOTHING tells the two apart:

      `never`   the host does nothing with this chord in either world — free, and clause 5 is
                vacuous because there was nothing to suppress;
      `stopped` the host acts when uncancelled and is quiet when cancelled — free, and clause 5 is
                PROVEN on this very chord;
      `anyway`  the host acts even when the page cancelled — NOT free, which is the
                two-behaviours-from-one-press case stated as a measurement.
    """
    by_id = {row["id"]: row for row in loose["rows"]}
    for row in result["rows"]:
        other = by_id.get(row["id"])
        if other is None:
            row["host"] = "?"
            continue
        row["hostActsUncancelled"] = not other["hostQuiet"]
        if not row["hostActsUncancelled"]:
            row["host"] = "never"
        else:
            row["host"] = "stopped" if row["hostQuiet"] else "anyway"
        row["clause4Proven"] = row["host"] == "stopped"


# ---------------------------------------------------------------------------------------------
# Chrome
# ---------------------------------------------------------------------------------------------

def chrome_send(page, chord: Chord, *, drop_mods: bool) -> None:
    """Dispatch the chord: the modifiers down, the key, then everything up.

    `rawKeyDown` and no `text` throughout. A modified key inserts nothing, and a `text`-carrying
    keyDown would also put a character into whatever holds the focus (`scripts/cdp.py`'s
    `press_ctrl` records the same reason).
    """
    if chord.key not in CDP_KEY_WIRE:
        raise cdp.CDPError("no Chrome wire spelling for %r" % chord.key)
    code, vk = CDP_KEY_WIRE[chord.key]
    mods = () if drop_mods else tuple(m for m in MOD_ORDER if m in chord.mods)

    held = 0
    for name in mods:
        held |= CDP_MOD_BITS[name]
        mkey, mcode, mvk = CDP_MODIFIER_WIRE[name]
        page.call("Input.dispatchKeyEvent", type="rawKeyDown", key=mkey, code=mcode,
                  windowsVirtualKeyCode=mvk, nativeVirtualKeyCode=mvk, modifiers=held)
    for event_type in ("rawKeyDown", "keyUp"):
        page.call("Input.dispatchKeyEvent", type=event_type, key=chord.key, code=code,
                  windowsVirtualKeyCode=vk, nativeVirtualKeyCode=vk, modifiers=held)
    for name in reversed(mods):
        mkey, mcode, mvk = CDP_MODIFIER_WIRE[name]
        held &= ~CDP_MOD_BITS[name]
        page.call("Input.dispatchKeyEvent", type="keyUp", key=mkey, code=mcode,
                  windowsVirtualKeyCode=mvk, nativeVirtualKeyCode=mvk, modifiers=held)


def run_chrome(base: str, chords: list[Chord], *, headed: bool, control: str) -> dict:
    url = base + DOC + ("?nopd=1" if control == "nopreventdefault" else "")
    out: dict = {"engine": "chrome", "url": url, "rows": [], "notes": []}
    with cdp.Browser(headless=not headed) as browser:
        page = browser.page()
        page.call("Runtime.enable")
        page.navigate(url, timeout=60)
        if not await_ready(page.evaluate):
            out["notes"].append("the fixture never became ready; nothing was measured")
            return out
        # A SECOND TAB, so a tab-switching chord has somewhere to go. With one tab Ctrl+Tab is a
        # no-op and would be reported free.
        try:
            page.call("Target.createTarget", url="about:blank")
            out["tabs"] = 2
        except cdp.CDPError as error:
            out["notes"].append("could not open a second tab (%s), so a tab switch is "
                                "unobservable and clause 5 is weaker than it claims" % error)
            out["tabs"] = 1
        page.call("Page.bringToFront")
        out["userAgent"] = page.evaluate("navigator.userAgent")
        out["dpr"] = page.evaluate("String(devicePixelRatio)")

        reach = reachable(page.evaluate,
                          lambda: chrome_send(page, Chord("reach", REACH_KEY, (), ""),
                                              drop_mods=False))
        out["reach"] = reach
        if not reach["ok"]:
            out["unreachable"] = (
                "a bare %r keydown — which no accelerator in any engine reserves — did not arrive "
                "(%d event(s): %r). The keyboard channel is not reaching the page, so NOTHING was "
                "measured and every row would read `received: NO` for a reason that is this "
                "harness's and not the host's."
                % (REACH_KEY, reach["events"], reach["keys"]))
            return out

        page.evaluate("String(globalThis.__focus())")
        page.evaluate("String(globalThis.__reset())")
        baseline = snap(page.evaluate)
        out["baseline"] = baseline
        if not baseline.get("hasFocus"):
            out["notes"].append("the page does not report the focus even before a chord, so "
                                "clause 5's BLUR half is unreadable here. Its TAB half is still "
                                "read: `visibilitychange` is a tab-level fact and does not need "
                                "the focus.")

        for chord in chords:
            page.call("Page.bringToFront")
            page.evaluate("String(globalThis.__focus())")
            page.evaluate("String(globalThis.__reset())")
            if control != "nodispatch":
                chrome_send(page, chord, drop_mods=(control == "nomods"))
            time.sleep(0.12)
            out["rows"].append(score(chord, snap(page.evaluate), baseline))
    return out


# ---------------------------------------------------------------------------------------------
# Firefox
# ---------------------------------------------------------------------------------------------

def firefox_send(ff, chord: Chord, *, drop_mods: bool) -> None:
    """`scripts/bidi.py`'s `press`, which holds each modifier down across the key.

    A single character goes through as itself; a named key goes through `bidi.KEYS`, which refuses
    an unknown name rather than typing it as text.
    """
    mods = set() if drop_mods else set(chord.mods)
    ff.press(chord.key, alt="alt" in mods, ctrl="ctrl" in mods,
             shift="shift" in mods, meta="meta" in mods)


def run_firefox(base: str, chords: list[Chord], *, headed: bool, control: str) -> dict:
    url = base + DOC + ("?nopd=1" if control == "nopreventdefault" else "")
    out: dict = {"engine": "firefox", "url": url, "rows": [], "notes": []}
    with bidi.Firefox(headless=not headed) as ff:
        ff.navigate(url)
        if not await_ready(lambda expr: ff.evaluate(expr, raw=True)):
            out["notes"].append("the fixture never became ready; nothing was measured")
            return out
        try:
            ff.call("browsingContext.create", {"type": "tab"})
            out["tabs"] = 2
        except bidi.BidiError as error:
            out["notes"].append("could not open a second tab (%s), so a tab switch is "
                                "unobservable and clause 5 is weaker than it claims" % error)
            out["tabs"] = 1
        ff.call("browsingContext.activate", {"context": ff.ctx})
        out["userAgent"] = ff.evaluate("navigator.userAgent")
        out["dpr"] = ff.evaluate("String(devicePixelRatio)", raw=True)

        reach = reachable(ff.evaluate,
                          lambda: firefox_send(ff, Chord("reach", REACH_KEY, (), ""),
                                               drop_mods=False))
        out["reach"] = reach
        if not reach["ok"]:
            out["unreachable"] = (
                "a bare %r keydown — which no accelerator in any engine reserves — did not arrive "
                "(%d event(s): %r). The keyboard channel is not reaching the page, so NOTHING was "
                "measured and every row would read `received: NO` for a reason that is this "
                "harness's and not the host's."
                % (REACH_KEY, reach["events"], reach["keys"]))
            return out

        ff.evaluate("String(globalThis.__focus())")
        ff.evaluate("String(globalThis.__reset())")
        baseline = snap(ff.evaluate)
        out["baseline"] = baseline
        if not baseline.get("hasFocus"):
            out["notes"].append("the page does not report the focus even before a chord, so "
                                "clause 5's BLUR half is unreadable here. Its TAB half is still "
                                "read: `visibilitychange` is a tab-level fact and does not need "
                                "the focus.")

        for chord in chords:
            ff.call("browsingContext.activate", {"context": ff.ctx})
            ff.evaluate("String(globalThis.__focus())")
            ff.evaluate("String(globalThis.__reset())")
            if control != "nodispatch":
                try:
                    firefox_send(ff, chord, drop_mods=(control == "nomods"))
                except bidi.BidiError as error:
                    out["notes"].append("%s: BiDi refused the press (%s)" % (chord.cid, error))
            time.sleep(0.12)
            out["rows"].append(score(chord, snap(ff.evaluate), baseline))
    return out


# ---------------------------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------------------------

def yn(value) -> str:
    return "-" if value is None else ("yes" if value else "NO")


def print_engine(result: dict) -> None:
    print("\n=== %s === %s" % (result["engine"].upper(), result.get("userAgent") or ""))
    print("    %s   dpr %s   tabs %s   baseline hasFocus=%s"
          % (result["url"], result.get("dpr"), result.get("tabs"),
             (result.get("baseline") or {}).get("hasFocus")))
    for note in result["notes"]:
        print("    note: %s" % note)
    if result.get("unreachable"):
        print("    CANNOT MEASURE: %s" % result["unreachable"])
        return
    print("    reach: a bare %r arrived (%d event(s)), so the channel is live"
          % (REACH_KEY, (result.get("reach") or {}).get("events", 0)))
    print("    %-20s %-5s %-5s %-6s %-9s %-10s %-8s %-5s %s"
          % ("chord", "recvd", "mods", "cancel", "prevented", "host quiet", "host", "free", "key"))
    for row in result["rows"]:
        print("    %-20s %-5s %-5s %-6s %-9s %-10s %-8s %-5s %s"
              % (row["label"], yn(row["received"]), yn(row["mods"]), yn(row["cancelable"]),
                 yn(row["prevented"]),
                 "%s%s" % (yn(row["hostQuiet"]), "*" if row.get("hostQuietPartial") else ""),
                 row.get("host", "-"), yn(row["free"]),
                 "code=%s%s key=%r blurs=%s hidden=%s"
                 % (row["code"], "" if row.get("codeOk") else "(WANTED %s)" % row["wantCode"],
                    row["key"], row["blurs"], row["hidden"])))
    if any(row.get("hostQuietPartial") for row in result["rows"]):
        print("    * the TAB half only: this engine never reported the focus, so `blur` is "
              "unreadable and only `visibilitychange` was read")


def combine(results: list[dict], chords: list[Chord]) -> dict:
    """The owner's rule: free in BOTH engines, preventable in both."""
    by_engine = {r["engine"]: {row["id"]: row for row in r["rows"]} for r in results}
    engines = sorted(by_engine)
    verdict: dict = {"engines": engines, "qualify": [], "blocked": [], "rows": []}
    for chord in chords:
        rows = [by_engine[e].get(chord.cid) for e in engines]
        if any(r is None for r in rows):
            continue
        both_free = all(r["free"] for r in rows)
        both_prev = all(r["preventable"] for r in rows)
        entry = {
            "id": chord.cid, "label": chord.label(),
            "os": chord.os, "browser": chord.browser, "blockedBy": chord.blocked(),
            "free": {e: by_engine[e][chord.cid]["free"] for e in engines},
            "preventable": {e: by_engine[e][chord.cid]["preventable"] for e in engines},
            "host": {e: by_engine[e][chord.cid].get("host", "?") for e in engines},
            "key": {e: by_engine[e][chord.cid]["key"] for e in engines},
            "bothFree": both_free, "bothPreventable": both_prev,
        }
        # THE ENGINES PUT DIFFERENT CHARACTERS ON ONE PHYSICAL KEY, and a dispatcher bound to
        # `key` would see only one of them. Named here because a per-engine table does not show a
        # disagreement: each column alone looks right.
        if len({str(v) for v in entry["key"].values()}) > 1:
            entry["keyDisagrees"] = True
            verdict.setdefault("key_disagreements", []).append(entry)
        verdict["rows"].append(entry)
        if both_free and both_prev:
            if chord.blocked():
                verdict["blocked"].append(entry)
            else:
                verdict["qualify"].append(entry)
    return verdict


def print_verdict(verdict: dict) -> None:
    engines = verdict["engines"]
    if len(engines) < 2:
        print("\nONE ENGINE ONLY (%s): the owner's rule needs both, so this run cannot select a "
              "chord." % ", ".join(engines))
        return
    print("\n--- the owner's rule: free in BOTH engines, preventable in both ---")
    if verdict.get("key_disagreements"):
        print("\n    THE ENGINES DISAGREE ABOUT `KeyboardEvent.key` ON THE SAME PHYSICAL KEY, so a")
        print("    dispatcher MUST bind on `code`. Each column alone looks right (%d):"
              % len(verdict["key_disagreements"]))
        for entry in verdict["key_disagreements"]:
            print("      %-20s %s" % (entry["label"], "  ".join("%s=%r" % (e, entry["key"][e])
                                                                for e in engines)))
    if verdict["blocked"]:
        print("\n    MEASURED FREE IN BOTH ENGINES AND NOT SELECTABLE: a documented consumer takes")
        print("    the chord at a level an INJECTED keystroke does not pass, so the measurement is")
        print("    an artefact of the injection point and not evidence (%d):"
              % len(verdict["blocked"]))
        for entry in verdict["blocked"]:
            print("      %-20s %s" % (entry["label"], entry["blockedBy"]))
    if not verdict["qualify"]:
        print("\n    NO CANDIDATE QUALIFIES. R22's fallback applies: a chord that works in one")
        print("    engine, LABELLED as such in the menu (docs/PLAN-SHELL.md:657-662).")
        return
    print("\n    QUALIFYING (%d), with what the host does with each when the page cancels "
          "nothing:" % len(verdict["qualify"]))
    for entry in verdict["qualify"]:
        print("      %-20s %s" % (entry["label"],
                                  "  ".join("%s=%s" % (e, entry["host"][e]) for e in engines)))
    print("\n    `never` = the host does nothing with it in either world, so there is nothing for")
    print("    a dispatcher to suppress and clause 5 is vacuous. `stopped` = the host DOES act on")
    print("    it uncancelled and `preventDefault` stopped it, so clause 5 is proven ON THAT")
    print("    CHORD — and a dispatcher that misses the `preventDefault` leaks the host's action.")


def control_moved(results: list[dict], control: str) -> tuple[bool, list[str]]:
    """Did the control move its OWN named column, and did it leave the others alone?

    A control satisfied by ANY failure verifies nothing (CLAUDE.md), so each of the three is scored
    on one named column.
    """
    notes: list[str] = []
    ok = True
    for result in results:
        rows = result["rows"]
        if not rows:
            notes.append("%s: no rows, so nothing could move" % result["engine"])
            ok = False
            continue
        if control == "nodispatch":
            still = [r["label"] for r in rows if r["received"]]
            if still:
                notes.append("%s: nothing was dispatched and %d row(s) still reported a keydown "
                             "(%s) — the `received` reading is not coupled to arrival"
                             % (result["engine"], len(still), ", ".join(still[:4])))
                ok = False
            else:
                notes.append("%s: nothing dispatched, %d of %d rows read `received: no` — which is "
                             "exactly how a host-consumed chord renders"
                             % (result["engine"], len(rows), len(rows)))
        elif control == "nomods":
            modified = [r for r in rows if r["label"].count("+")]
            still = [r["label"] for r in modified if r["mods"]]
            if not modified:
                notes.append("%s: no modified rows in the table, so this control has no world"
                             % result["engine"])
                ok = False
            elif still:
                notes.append("%s: the modifiers were dropped and %d row(s) still read `mods: yes` "
                             "(%s)" % (result["engine"], len(still), ", ".join(still[:4])))
                ok = False
            else:
                notes.append("%s: modifiers dropped, all %d modified rows lost `mods`"
                             % (result["engine"], len(modified)))
        elif control == "nopreventdefault":
            still = [r["label"] for r in rows if r["prevented"]]
            if still:
                notes.append("%s: the listener cancelled nothing and %d row(s) still read "
                             "`prevented: yes` (%s)"
                             % (result["engine"], len(still), ", ".join(still[:4])))
                ok = False
            else:
                notes.append("%s: nothing cancelled, no row read `prevented: yes`"
                             % result["engine"])
    return ok, notes


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--engine", choices=("both", "chrome", "firefox"), default="both")
    ap.add_argument("--headed", action="store_true",
                    help="real windows. A headless browser has no tab strip and no menu bar, so "
                         "a headed run is the more honest one for a question about accelerators.")
    ap.add_argument("--control", choices=("none", "nodispatch", "nomods", "nopreventdefault"),
                    default="none")
    ap.add_argument("--prove-failure", action="store_true",
                    help="run all three controls and check each moved its own named column. "
                         "Exits 0 when the proof SUCCEEDED.")
    ap.add_argument("--only", default="", help="a comma-separated list of chord ids")
    ap.add_argument("--out", default="")
    args = ap.parse_args(argv[1:])

    chords = candidates()
    if args.only:
        wanted = {part.strip() for part in args.only.split(",") if part.strip()}
        unknown = wanted - {c.cid for c in chords}
        if unknown:
            print("no such chord id: %s" % ", ".join(sorted(unknown)), file=sys.stderr)
            return 2
        chords = [c for c in chords if c.cid in wanted]

    os.chdir(REPO)
    httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % port

    engines = ("chrome", "firefox") if args.engine == "both" else (args.engine,)
    controls = (("nodispatch", "nomods", "nopreventdefault") if args.prove_failure
                else (args.control,))
    report: dict = {"base": base, "headed": args.headed, "chords": len(chords), "runs": []}
    failures: list[str] = []

    try:
        for control in controls:
            print("\n######## control: %s  (%d chord(s), %s) ########"
                  % (control, len(chords), "headed" if args.headed else "headless"))
            results = []
            refused = []
            for engine in engines:
                runner = run_chrome if engine == "chrome" else run_firefox
                try:
                    result = runner(base, chords, headed=args.headed, control=control)
                except Exception as error:  # a driver that cannot start must say so, not pass
                    print("    %s: DRIVER FAILED %s: %s"
                          % (engine, type(error).__name__, error))
                    failures.append("%s driver failed: %s" % (engine, error))
                    continue
                if control == "none" and not result.get("unreachable"):
                    # THE UNCANCELLED PASS, which is what makes clause 5 evidence rather than an
                    # assertion. Same engine, same chords, listener cancelling nothing.
                    try:
                        loose = runner(base, chords, headed=args.headed,
                                       control="nopreventdefault")
                    except Exception as error:
                        print("    %s: the uncancelled pass failed (%s), so clause 5 has no "
                              "per-chord positive control" % (engine, error))
                    else:
                        if loose.get("unreachable"):
                            print("    %s: the uncancelled pass could not reach the page, so "
                                  "clause 5 has no per-chord positive control" % engine)
                        else:
                            merge_uncancelled(result, loose)
                            result["uncancelled"] = loose["rows"]
                print_engine(result)
                if result.get("unreachable"):
                    # Kept out of `results`, so neither the verdict nor a control is computed over
                    # a run that measured nothing. Refusing to conclude is the honest answer.
                    failures.append("%s: %s" % (engine, result["unreachable"]))
                    refused.append(result)
                    continue
                results.append(result)
            run: dict = {"control": control, "results": results, "refused": refused}
            if not results:
                print("\n    no engine measured anything, so there is nothing to conclude")
            elif control == "none":
                run["verdict"] = combine(results, chords)
                print_verdict(run["verdict"])
            else:
                moved, notes = control_moved(results, control)
                run["controlMoved"] = moved
                run["controlNotes"] = notes
                print("\n    --- control %s ---" % control)
                for note in notes:
                    print("    %s %s" % ("ok " if moved else "BAD", note))
                if not moved:
                    failures.append("control %s did not move its named column" % control)
            report["runs"].append(run)
    finally:
        httpd.shutdown()

    # A CONTROL RUN GETS ITS OWN FILE. Sharing one name let `--prove-failure` silently overwrite
    # the measurement the table is read out of, leaving a committed artifact that is all refusals.
    out_path = pathlib.Path(args.out) if args.out else HERE / ("results-%s%s.json" % (
        "controls-" if args.prove_failure or args.control != "none" else "",
        "headed" if args.headed else "headless"))
    out_path.write_text(json.dumps(report, indent=2) + "\n")
    print("\nwrote %s" % out_path)

    if args.prove_failure:
        if failures:
            print("\n--prove-failure: FAILED — %s" % "; ".join(failures))
            return 1
        print("\n--prove-failure: all three controls moved their own column, as required")
        return 0
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
