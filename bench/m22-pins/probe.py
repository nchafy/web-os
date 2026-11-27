#!/usr/bin/env python3
"""M22's publisher probe: ARE A PINNED BUTTON AND A TRAY ICON ROWS A PROCESS PUBLISHED, and does
the pin a reader makes SURVIVE A RELOAD?

WHY THIS EXISTS, and it is not the check's job. `src/bin/desktop.mjs` gained three things that
cannot be read off the source: a `WITEM_TRAY|WITEM_MENU` bit on a program's own menu row, a
`WITEM_TRAY` status row, and a pin gesture that writes a file. Each of them is a claim about a
ROUTE, and this project's own record is that a route is the thing a reader finds missing while every
expectation is green — constraints 289-292 are four of them in one milestone.

ONE ROUTE WAS ALREADY WRONG WHEN THIS PROBE WAS WRITTEN, which is why it exists in this shape. The
pin toggle was first published as a `WITEM_CONTEXT` row, raised with `win_menu` from a right press
on bare desktop. That row can never be pressed: `src/wm/winhost.mjs:1320-1325` says the desktop
window is neither surfaced nor text, `#wirePointer` is wired on a SURFACE only, so the desktop
process receives no `WEV_POINTER` at all and `raiseMenu` never fires on a real desktop. The gesture
is a START MENU row now, and this probe is what tells those two worlds apart — a source read cannot.

IT DRIVES THE PRODUCT AND NOTHING ELSE: `www/index.html` at its bare URL, which is the desktop
(constraint 283). Every gesture is a real Chrome input event and every reading is either the DOM a
reader sees or the shell's own `report()`.

    python3 bench/m22-pins/probe.py                  # the table
    python3 bench/m22-pins/probe.py --headed         # ...with the window on screen
    python3 bench/m22-pins/probe.py --prove-failure  # the control: the menu is OPENED and dismissed
                                                     # with Escape instead of the row being clicked

THE CONTROL IS THE POSITIVE CONTROL FOR THE GESTURE. Clauses 3-6 attribute a pinned button and a
line in a file to one click on one row. Under `--prove-failure` the same menu is opened and closed
with Escape, so a run in which the button or the line appears anyway is a run measuring something
other than the click — the shape `bench/m22-switch/probe.py` uses for its host-quiet clause.

EVERY FIGURE IS CSS px AT dpr 1. There is no device-px reading here and none is wanted.
"""
from __future__ import annotations

import argparse
import functools
import json
import pathlib
import re
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve()
REPO = HERE.parents[2]
sys.path.insert(0, str(REPO / "scripts"))

import cdp  # noqa: E402
import serve as serve_mod  # noqa: E402

#: THE PROGRAM THE GESTURE PINS. `editor` and not `files` or `term`: both of those are in
#: `DEFAULT_PINS` or staged as a window by `www/shell.mjs`, so "a button appeared" would be
#: satisfied by the desktop having loaded. This one is pinnable, unpinned and not running.
SUBJECT = "editor"

#: Where the list lives, as the PROGRAM resolves it: `std.HOME_DIR` + the leaf. Read out of the two
#: files rather than written here, because a constant in this probe is the second copy that goes
#: stale the day either one moves.
PINS_PATH = ""

VIEW_W = 1280
VIEW_H = 800

#: A prompt, and a command's output read until it comes back. `scripts/check.py`'s `_M15_PROMPT`
#: and `M15_SCREEN` under their own names, because a bench script cannot import that module.
PROMPT_RE = re.compile(r"\$ $|\$\s*$")
SCREEN = "(document.querySelector('.terminal') || {}).textContent || ''"


def pins_path() -> str:
    """The pin file's path, derived from the two definitions that make it.

    `HOME_DIR` is `src/libos/std.mjs`'s and `PINS_LEAF` is `src/bin/desktop.mjs`'s. A probe that
    wrote `/Users/Default/.taskbar-pins` would be a third copy, and the drift CLAUDE.md predicts
    for that is this probe `cat`ing a file nothing writes and reporting an empty list as a defect.
    """
    home = re.search(r'HOME_DIR\s*=\s*"([^"]+)"',
                     (REPO / "src/libos/std.mjs").read_text(encoding="utf-8"))
    leaf = re.search(r'PINS_LEAF\s*=\s*"([^"]+)"',
                     (REPO / "src/bin/desktop.mjs").read_text(encoding="utf-8"))
    if not home or not leaf:
        raise SystemExit("could not read HOME_DIR from src/libos/std.mjs or PINS_LEAF from "
                         "src/bin/desktop.mjs, so there is no path to read back")
    return f"{home.group(1)}/{leaf.group(1)}"


def serve_repo() -> tuple[object, int]:
    """The repo root with COOP/COEP, on a port the OS picks. `scripts/serve.py`'s server and
    handler, never a `ThreadingHTTPServer` of this file's own: the headers have one definition and
    `www/index.html` does not boot without them."""
    serve_mod.Handler.isolate = True
    handler = functools.partial(serve_mod.Handler, directory=str(REPO))
    httpd = serve_mod.Server(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def settle(page, ms: int = 260) -> None:
    page.evaluate(f"new Promise(r=>setTimeout(r,{ms}))", await_promise=True)


#: WHAT THE PUBLISHER PUBLISHED AND WHAT THE SHELL DREW, in one read.
#:
#: `isTrayRow`/`isPinnedRow` ARE IMPORTED AND NOT RESTATED, the way `scripts/check.py`'s
#: `READ_LANDING` imports `WITEM_*`: `src/abi.mjs` is the one definition of what those flag words
#: mean and this expression is a second reader of them.
READ = """(async () => {
  const A = await import('/src/abi.mjs')
  const I = globalThis.INDEX || {}
  const shell = I.shell || null
  const desk = shell ? shell.desktopEntry() : null
  const rows = desk ? desk.items : []
  const r = shell ? shell.report() : null
  const spot = (el) => {
    if (!el) return null
    const b = el.getBoundingClientRect()
    const at = { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
    const hit = document.elementFromPoint(at.x, at.y)
    return { at, w: Math.round(b.width), h: Math.round(b.height),
             onTop: Boolean(hit && (el === hit || el.contains(hit))) }
  }
  const trayEl = document.querySelector('[data-tray-icon]')
  return {
    state: String(I.state || ''),
    isolated: I.isolated === true,
    publishedPins: rows.map((row, index) => ({ index, label: row.label, flags: row.flags }))
      .filter((row) => A.isPinnedRow(row.flags)),
    publishedTray: rows.map((row, index) => ({ index, label: row.label, flags: row.flags }))
      .filter((row) => A.isTrayRow(row.flags)),
    menuLabels: rows.filter((row) => (row.flags & A.WITEM_MENU) !== 0).map((row) => row.label),
    pinned: r ? r.pinned : [],
    tray: r ? r.tray : [],
    pins: r ? r.pins : -1,
    pinButtons: [...document.querySelectorAll('[data-pin-btn]')].map((el) => el.dataset.pinBtn),
    taskButtons: [...document.querySelectorAll('[data-task-btn]')].map((el) => el.dataset.taskBtn),
    trayIcons: [...document.querySelectorAll('[data-tray-icon]')].length,
    traySpot: spot(trayEl),
    frames: I.host ? I.host.frames.size : 0,
  }
})()"""


#: ONE START MENU ROW, FOUND BY ITS EXACT LABEL AND HIT-TESTED AT THE PIXEL THE CLICK GOES TO.
#: `scrollIntoView` is staging: `.start-list` caps at 300 px over more rows than that, so a row
#: below the fold has a rect outside the popup and a click at its centre lands on the desktop.
AIM_ROW = """(() => {
  const want = %s
  const rows = [...document.querySelectorAll('.start-list .shell-row')]
  const row = rows.find((r) => (r.querySelector('.shell-label') || {}).textContent === want)
  if (!row) {
    return { found: false, shown: rows.length,
             labels: rows.map((r) => (r.querySelector('.shell-label') || {}).textContent) }
  }
  row.scrollIntoView({ block: 'nearest' })
  const b = row.getBoundingClientRect()
  const at = { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }
  const hit = document.elementFromPoint(at.x, at.y)
  return { found: true, at, shown: rows.length,
           onTop: Boolean(hit && row.contains(hit)) }
})()"""


def click(page, at: dict) -> None:
    for kind in ("mousePressed", "mouseReleased"):
        page.call("Input.dispatchMouseEvent", type=kind, x=at["x"], y=at["y"],
                  button="left", buttons=1, clickCount=1, pointerType="mouse")


def type_at_prompt(page, cmd: str, *, until: str = "", timeout: float = 25.0) -> str:
    """One command at the real prompt, read until the prompt comes back.

    THE SCREEN IS A PROGRAM'S OUTPUT AND NOT THIS PROBE'S FACT, which is the point of reading the
    file this way: `cat` is a second process opening the path with no help from the publisher, so a
    name on screen is a name on the volume and not a name in the desktop's memory.

    THE TERMINAL IS CLICKED FIRST, AND THAT WAS LEARNED THE WAY EVERYTHING HERE WAS. A click on a
    start-menu row leaves the keyboard with the shell's popup and not with the terminal, so the
    FIRST version of this function typed `cat` into nothing: the read came back
    `[no prompt within 25s]` and `has()` then answered False for a name that WAS in the file —
    a clause passing because its measurement failed, which is the worst outcome available.
    `score` now fails a clause whose read did not come back, and this click is why it comes back.
    """
    spot = page.evaluate(
        "(() => { const el = document.querySelector('.terminal'); if (!el) return null;"
        " const b = el.getBoundingClientRect();"
        " return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } })()")
    if spot:
        click(page, spot)
        settle(page, 300)
    before = len(page.evaluate(SCREEN) or "")
    page.type_keys(cmd + "\n")
    deadline = time.monotonic() + timeout
    while True:
        out = (page.evaluate(SCREEN) or "")[before:]
        if (PROMPT_RE.search(out) and len(out.strip()) > len(cmd)
                and (not until or until in out)):
            return out
        if time.monotonic() >= deadline:
            return out + "\n[no prompt%s within %.0fs]" % (
                (" and no %r" % until) if until else "", timeout)
        time.sleep(0.12)


def wait_live(page, port: int, *, navigate: bool = True) -> dict:
    if navigate:
        page.navigate(f"http://127.0.0.1:{port}/www/index.html")
    deadline = time.time() + 180
    state = {}
    while time.time() < deadline:
        state = page.evaluate(
            "(() => { const I = globalThis.INDEX || {};"
            " return { s: String(I.state || ''), shell: Boolean(I.shell),"
            " term: Boolean(document.querySelector('.terminal')) } })()") or {}
        if state.get("s") in ("done", "aborted", "error") and state.get("shell"):
            break
        time.sleep(0.4)
    if state.get("s") != "done":
        raise SystemExit(f"www/index.html never reached done with a shell: {state}")
    # THE PROMPT, BEFORE ANYTHING IS TYPED. A command typed before `sh` has printed one is a
    # command the shell never sees, and the symptom is an empty reading rather than an error.
    deadline = time.time() + 90
    while time.time() < deadline:
        if PROMPT_RE.search(page.evaluate(SCREEN) or ""):
            break
        time.sleep(0.25)
    settle(page, 400)
    return state


def open_start(page) -> None:
    orb = page.evaluate(
        "(() => { const el = document.querySelector('[data-start]'); if (!el) return null;"
        " const b = el.getBoundingClientRect();"
        " return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } })()")
    if not orb:
        raise SystemExit("no start orb on the desktop, so the menu cannot be opened")
    click(page, orb)
    settle(page, 300)


def toggle_pin(page, label: str, *, press: bool) -> dict:
    """Open the start menu, aim at one `Pin`/`Unpin` row, and either click it or press Escape.

    `press=False` IS THE CONTROL and it is the same code path up to the click, so the two runs
    differ in the gesture and in nothing else.
    """
    open_start(page)
    aim = page.evaluate(AIM_ROW % json.dumps(label))
    if not aim.get("found"):
        page.evaluate("globalThis.INDEX.shell.closePopup()")
        return {"found": False, "aim": aim, "clicked": False}
    if press:
        click(page, aim["at"])
    else:
        page.press("Escape")
    settle(page, 900)
    page.evaluate("globalThis.INDEX.shell.closePopup()")
    settle(page, 300)
    return {"found": True, "aim": aim, "clicked": press}


def run(headed: bool, control: bool) -> dict:
    httpd, port = serve_repo()
    path = pins_path()
    out: dict = {"subject": SUBJECT, "pinsPath": path, "control": control}
    args = () if headed else ("--headless=new",)
    try:
        with cdp.Browser(extra_args=args) as browser:
            page = browser.page()
            # dpr 1, NOT MOBILE: every figure here is CSS px and there is no ratio to restore.
            page.emulate_device(width=VIEW_W, height=VIEW_H, scale_factor=1, mobile=False)
            wait_live(page, port)
            first = page.evaluate(READ, await_promise=True)
            if first.get("isolated") is not True:
                # A BENCH HARNESS ABORTS RATHER THAN REPORTING A NUMBER FROM A NON-ISOLATED
                # CONTEXT: without the SAB there is no kernel, no process and no published row, so
                # every figure below would be about a different system.
                raise SystemExit("crossOriginIsolated is false: www/index.html did not boot a "
                                 "kernel, so nothing here was measured")
            out["fresh"] = first
            out["freshFile"] = type_at_prompt(page, f"cat {path}", until="$")

            out["gesture"] = toggle_pin(page, f"Pin {SUBJECT}", press=not control)
            out["afterPin"] = page.evaluate(READ, await_promise=True)
            out["afterPinFile"] = type_at_prompt(page, f"cat {path}", until="$")

            # THE RELOAD IS R24. A pin that lives in the page is a pin that is gone, and the only
            # way to tell that from a pin on the volume is to throw the page away.
            wait_live(page, port)
            out["afterReload"] = page.evaluate(READ, await_promise=True)
            out["afterReloadFile"] = type_at_prompt(page, f"cat {path}", until="$")

            out["unpin"] = toggle_pin(page, f"Unpin {SUBJECT}", press=not control)
            out["afterUnpin"] = page.evaluate(READ, await_promise=True)
            out["afterUnpinFile"] = type_at_prompt(page, f"cat {path}", until="$")

            # AND THE TRAY ICON, CLICKED WHERE A READER WOULD. The row's verb is `taskmgr`, so the
            # evidence is a window that was not there before.
            tray = out["afterUnpin"].get("traySpot")
            if tray and tray.get("onTop"):
                before = out["afterUnpin"]["frames"]
                click(page, tray["at"])
                settle(page, 1200)
                out["afterTray"] = page.evaluate(READ, await_promise=True)
                out["trayFrames"] = {"before": before, "after": out["afterTray"]["frames"]}
    finally:
        httpd.shutdown()
    return out


def has(text: str, name: str) -> bool:
    """Is `name` a LINE of the file's contents on screen? A substring test would accept the echoed
    `cat /Users/Default/.taskbar-pins` itself, which contains no program name but would accept one
    a longer name contained."""
    return any(line.strip() == name for line in (text or "").splitlines())


def read_came_back(text: str) -> bool:
    """Did the `cat` actually run? `type_at_prompt` writes its own failure into the text it
    returns, and a clause scored over a read that never happened is a clause that reports the
    absence of a measurement as the absence of a defect."""
    return bool(text) and "[no prompt" not in text


def score(out: dict) -> list[tuple[str, bool, str]]:
    fresh = out.get("fresh") or {}
    pinned = out.get("afterPin") or {}
    reload_ = out.get("afterReload") or {}
    unpinned = out.get("afterUnpin") or {}
    control = out.get("control") is True
    want = out["subject"]
    rows = []

    rows.append((
        "a fresh desktop publishes pinned rows, and the shell drew one button per pin",
        bool(fresh.get("publishedPins"))
        and sorted(r["label"] for r in fresh["publishedPins"])
        == sorted(set(fresh.get("pinButtons", []) + [
            b for b in fresh.get("taskButtons", [])
            if b in [r["label"] for r in fresh["publishedPins"]]])),
        f"published {[r['label'] for r in fresh.get('publishedPins', [])]}, "
        f"pin buttons {fresh.get('pinButtons')}, task buttons {fresh.get('taskButtons')}"))

    tray = fresh.get("publishedTray") or []
    rows.append((
        "the tray's row is a STATUS icon and not a pin, and the icon is hit-testable",
        len(tray) == 1 and fresh.get("trayIcons") == 1
        and bool((fresh.get("traySpot") or {}).get("onTop")),
        f"tray rows {tray}, icons {fresh.get('trayIcons')}, spot {fresh.get('traySpot')}"))

    rows.append((
        f"the start menu carries a `Pin {want}` row, hit-testable at the pixel the click went to",
        bool((out.get("gesture") or {}).get("found"))
        and bool(((out.get("gesture") or {}).get("aim") or {}).get("onTop")),
        f"{out.get('gesture')}"))

    pin_arrived = want in (pinned.get("pinButtons") or [])
    rows.append((
        ("the click did NOT pin it (control)" if control
         else f"the click pinned {want}: the band gained its button"),
        (not pin_arrived) if control else pin_arrived,
        f"pin buttons {pinned.get('pinButtons')}, published "
        f"{[r['label'] for r in pinned.get('publishedPins', [])]}"))

    pin_text = out.get("afterPinFile", "")
    in_file = has(pin_text, want)
    rows.append((
        ("and the file was not written (control)" if control
         else "and the name is in the file, read by `cat` at a REAL PROMPT"),
        read_came_back(pin_text) and ((not in_file) if control else in_file),
        f"{out['pinsPath']}: {json.dumps(pin_text)[:220]}"))

    survived = want in (reload_.get("pinButtons") or [])
    reload_text = out.get("afterReloadFile", "")
    rows.append((
        ("and a reload shows no pin (control)" if control
         else "and it SURVIVED A RELOAD, which is R24 — the button AND the file, after the page "
              "was thrown away"),
        read_came_back(reload_text)
        and ((not survived and not has(reload_text, want)) if control
             else (survived and has(reload_text, want))),
        f"after reload: pin buttons {reload_.get('pinButtons')}, "
        f"file {json.dumps(reload_text)[:200]}"))

    if control:
        rows.append((
            "the control never found an `Unpin` row to press, because nothing was pinned",
            (out.get("unpin") or {}).get("found") is False,
            f"{out.get('unpin')}"))
    else:
        gone = want not in (unpinned.get("pinButtons") or [])
        unpin_text = out.get("afterUnpinFile", "")
        rows.append((
            f"unpinning removed the button AND the line: {want}",
            read_came_back(unpin_text) and gone and not has(unpin_text, want),
            f"pin buttons {unpinned.get('pinButtons')}, "
            f"file {json.dumps(unpin_text)[:200]}"))

    frames = out.get("trayFrames") or {}
    rows.append((
        "a real click on the tray icon reached the process, which spawned",
        frames.get("after", 0) > frames.get("before", 0),
        f"frames {frames}"))
    return rows


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--headed", action="store_true", help="show the browser window")
    ap.add_argument("--prove-failure", action="store_true",
                    help="dismiss the menu with Escape instead of clicking the row; every clause "
                         "that attributes a pin to the click MUST invert")
    ap.add_argument("--json", type=pathlib.Path, help="write the raw readings here")
    opts = ap.parse_args(argv)

    out = run(opts.headed, opts.prove_failure)
    rows = score(out)
    for name, ok, why in rows:
        print(f"[{'ok  ' if ok else 'BAD '}] {name}\n        {why}")
    if opts.json:
        opts.json.write_text(json.dumps(out, indent=1))
        print(f"raw: {opts.json}")
    bad = [name for name, ok, _ in rows if not ok]
    print(f"\n{len(rows) - len(bad)} of {len(rows)} clause(s) ok"
          f"{' (control run)' if opts.prove_failure else ''}")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
