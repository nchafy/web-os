#!/usr/bin/env python3
"""IF I DELETE SOMETHING BY MISTAKE, CAN I GET IT BACK? M21's Recycle Bin in FIREFOX, on the
LANDING page, with real trusted input.

    python3 bench/m21-bin/firefox-bin.py                     # the gate
    python3 bench/m21-bin/firefox-bin.py --prove-failure      # ...and it MUST report failures
    python3 bench/m21-bin/firefox-bin.py --control no-ctrl --prove-failure
    python3 bench/m21-bin/firefox-bin.py --headed             # in a window you can watch
    python3 bench/m21-bin/firefox-bin.py --control            # ...prints what each world moves

Pipe stderr away for a quiet transcript: `serve.Handler` logs every request there.

WHY THIS FILE EXISTS. `CLAUDE.md` makes a second engine a condition of reporting a milestone done
and records the bill for skipping it: M4a shipped a window that could not be dragged in Firefox
(constraint 175), M6 a policy under which no process started there (206), M11 and M12 each a
geometry derived from a dpr-2 constant (264), M14 a desktop a reader could not open anything on
(289), M17 a bare URL that threw in both engines while the suite stayed green. Firefox renders at
**dpr 1** here, which is where every one of those hid. No constant below is copied from
`check_m21`'s gesture table: that table is Chrome at dpr 2, and a point taken from it is right by a
factor of two in exactly the direction nothing reports.

WHAT MAKES THIS MILESTONE'S OWN QUESTION DIFFERENT FROM M20'S. M20 asked whether a reader can
change the disk by pointing. M21 asks whether a change they did not mean can be UNDONE, which is
four readings and not one, and the third of them is the only one a reader actually trusts:

  1. a delete takes the row out of the list;
  2. the Bin shows it;
  3. a Restore puts it back where it was — with its BYTES, not just its name;
  4. and after a RELOAD it is still there, because the session is a writable copy of the read-only
     base and not a tab's memory (M19a, `docs/DECISIONS.md` D40).

Reading 3 is the one this gate spends most of its gestures on. A name coming back is cheap: the
restore is a `rename`, so a path that exists again says nothing about whether the bytes followed it.
So each fixture file is written with a DISTINCT NONCE at a real prompt and the restored path is
`cat`-ed back, with the OTHER file's nonce asserted absent — which is what makes the byte comparison
capable of failing rather than a `length > 0` test wearing its clothes.

THE DELETE IS A MULTIPLE SELECTION MADE BY A HELD MODIFIER, and that is the measurement this file
needed from the driver rather than a flourish. `scripts/bidi.py`'s `press(..., ctrl=True)` opens and
closes the modifier inside one KEY sequence, so no pointer action could happen under it, and
Ctrl+press — `src/bin/files.mjs`'s `WMOD_CTRL` branch, the gesture that EXTENDS a selection instead
of replacing it — had no spelling on this wire at all. `Firefox.held` is that capability, and
`python3 scripts/bidi.py` is where it is measured: a `mousedown` under it arrives
`ctrlKey === true` and `isTrusted === true`, and the next one does not. Two rows go to the Bin here
and ONE comes back, which is the shape a Bin is for — a restore that emptied it would pass a
one-file gate and be wrong.

IT RUNS ON `www/index.html`, THE BARE URL, so what is driven is the product and not a proof page
(constraint 283). The fixture is built by TYPING AT THE REAL PROMPT, in the session's writable tree
(`INDEX.seed.dest`, read rather than spelled) because `/tmp` is a tmpfs and nothing there outlives a
reload:

    rm -r -f <session>/m21ff-<stamp> <bin> ; mkdir -p <session>/m21ff-<stamp>
    echo <nonce-A> > .../kept-<hex>.txt ; echo <nonce-B> > .../back-<hex>.txt
    files <session>/m21ff-<stamp> &

THE BIN'S PATH IS NEVER SPELLED HERE. `FILES_METRICS.binDirIn(std.HOME_DIR)` is asked for it in the
page, which is the program's own arithmetic — `$Recycle.Bin` written in this file would be the
second copy `CLAUDE.md`'s `FILES_METRICS` row exists to prevent, and the one that breaks is always
the driver.

THE BIN IS EMPTIED AS PART OF THE FIXTURE. It accumulates by design, so a run over a dirty Bin would
have `freeFrom` number the payload `back-<hex> (2).txt` and every aim below would be looking for a
name that is not there.

WHAT IS ASSERTED, and every row is read back out of the display list the program actually drew —
decoded with `src/abi.mjs`'s own `decodeDrawOps`/`textOfOps` and located with `FILES_METRICS`, so
the gate and the renderer share one arithmetic:

  1. `desktop`     the bare url is a desktop at all: a taskbar, a start orb, icons, and no driver
                   banner (constraint 283). The clause that collapses when there is no product,
                   which is what makes it the one every control must leave alone.
  2. `deleted`     a real click, a Ctrl-click under a HELD modifier, and the Delete key: BOTH rows
                   leave the list, and the program reports two went to the Bin. Both halves — a row
                   that went away is not the same fact as bytes that were kept.
  3. `binIcon`     a double-click on the DESKTOP'S OWN Recycle Bin icon opens a `files` window
                   looking at the Bin. THIS IS THE READER'S ONLY ROUTE and it is scored separately
                   from what the Bin then shows, because the two fail independently — see the
                   paragraph below, which is why it is UNSCOPED under every control.
  4. `shown`       the Bin's list holds BOTH payloads, by the names the files had. The origin
                   RECORDS are not rows (they are symlinks and a reader cannot restore one), so the
                   row count is asserted too: a Bin listing its own bookkeeping is a different
                   defect from one listing nothing.
  5. `restored`    a real right-click on one payload raises the Bin's menu with `Restore` as its
                   FIRST row, a real click on it takes that row out of the Bin, and the file is
                   listed again in the directory it was deleted from. Three readings: the menu, the
                   Bin, and the origin directory.
  6. `bytes`       `cat` of the restored path prints the nonce that was written INTO THAT FILE, and
                   not the other file's. The reading that separates a restore from a `touch`.
  7. `keptInBin`   the other payload is STILL in the Bin, with its origin record. A restore moves
                   one file; one that drained the Bin is a Bin that cannot be used twice.
  8. `persists`    after a RELOAD the restored file is still at its origin path, in `ls` at a new
                   prompt AND in a new `files` window's own rows, still holding its nonce.
  9. `persists-bin` ...and the payload that was left in the Bin is still in the Bin, so the Bin is
                   on the volume and not in the page.

`binIcon` IS RED TODAY FOR A NAMED REASON IN A FILE THIS GATE DOES NOT OWN, and the run says so
rather than routing around it. `src/bin/desktop.mjs:265-270` publishes the Recycle Bin row as
`["files", "--bin"]` (`:269`), and `src/bin/files.mjs`'s long-option loop (`:1041-1054`) has no
`--bin` — `grep -c '"--bin"' src/bin/files.mjs` is 0. So the argument falls through to
`std.getopt(rest, "")`, which answers `bad: "--"` for ANY long option it does not know
(`src/libos/std.mjs:239`), and the program exits `EXIT_USAGE` with no window open. Measured below
as `binIcon`. The gate then opens the Bin by typing its path at the prompt and SAYS it did, so
clauses 4-9 are still measured — a harness that stopped here would report one defect and leave the
milestone's actual subject untested. It is in no control's proof set and in no control's kept set,
and the run prints it as unscoped: a control is about the world it builds, and a clause already red
for an unrelated reason can neither fire for it nor be kept by it.

THE THREE CONTROLS, each re-runnable from the command line with no source edit:

  `--control esc-not-restore` (the default) DISMISSES THE BIN'S MENU WITH ESC INSTEAD OF CLICKING
      `Restore`. The menu still opens and the Bin still holds both rows, so `restored`, `bytes` and
      `persists` MUST fire and `deleted`, `shown` and `keptInBin` MUST NOT. It is the default
      because it is the only world that proves the restore was the CLICK on that row and not
      something that happened near it.
  `--control no-ctrl` DROPS THE HELD MODIFIER from the second click. A plain press REPLACES the
      selection (`src/bin/files.mjs`'s own rule), so one row is deleted instead of two:
      `deleted`, `shown`, `keptInBin` and `persists-bin` MUST fire, and the restore of the row that
      IS deleted MUST still work — `restored`, `bytes` and `persists` stay green. It is what tells
      "a held Control extended the selection" apart from "two clicks selected two rows".
  `--control wipe` REMOVES THE OPFS VOLUME BETWEEN THE TWO BOOTS, reusing
      `bench/m19a-seed-firefox/wipe.html`: the second boot meets a fresh volume and the kernel seeds
      a new copy of the base over the reader's tree. `persists` and `persists-bin` MUST fire and
      every pre-reload clause MUST stay green — which is the only thing that keeps clause 8 from
      being satisfied by a volume that never forgot anything.

`--prove-failure` exits 0 when the proof SUCCEEDED, which is `scripts/check.py`'s convention.
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

#: WHAT THE BIN'S FIRST MENU ROW SAYS. `src/bin/files.mjs`'s `rowMenuFor` prepends it inside the Bin
#: and nowhere else, and the label is the assertion: a reader looking for their file looks for this
#: word. It cannot be imported into python, and it is the only program string this file restates.
RESTORE = "Restore"

#: WHAT `deleteSelection` SAYS WHEN BOTH ROWS WERE RECYCLED RATHER THAN REMOVED. Asserted beside the
#: rows having gone, because those are two facts: `src/bin/files.mjs` counts a delete OUTSIDE the
#: session tree, or one inside the Bin, as `permanently` — and a row that went away without bytes
#: kept is exactly the world this milestone exists to remove.
BINNED_TWO = "deleted 2 of 2: 2 to the Bin"

#: (proof, kept). A control must move a NAMED subset; a clause in neither is UNSCOPED and the run
#: prints it as such rather than letting silence read as a claim. `binIcon` is deliberately in
#: neither — see this file's header.
CONTROLS = {
    "esc-not-restore": (("restored", "bytes", "persists"),
                        ("desktop", "deleted", "shown", "keptInBin", "persists-bin")),
    "no-ctrl": (("deleted", "shown", "keptInBin", "persists-bin"),
                ("desktop", "restored", "bytes", "persists")),
    "wipe": (("persists", "persists-bin"),
             ("desktop", "deleted", "shown", "restored", "bytes", "keptInBin")),
}
TAGS = ("desktop", "deleted", "binIcon", "shown", "restored", "bytes", "keptInBin",
        "persists", "persists-bin")

#: WHAT IS ON SCREEN, in one read. Every selector is one `src/wm/` builds; `INDEX` is the landing
#: page's own globals object, published before its module so a driver polling it cannot mistake a
#: syntax error for a slow boot (`www/index.html`).
#:
#: THE DESKTOP ICON IS LOCATED BY ITS LABEL AND NOT BY ITS INDEX. `src/bin/desktop.mjs` inserted the
#: Bin row between the session folder and Terminal, so every positional index past 2 moved — and a
#: driver indexing rows is exactly what that shift breaks.
STATE = """JSON.stringify((() => {
  const M = globalThis.INDEX || {}
  const mid = (el) => { const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } }
  const orb = document.querySelector('[data-start]')
  const log = document.getElementById('log')
  const term = document.querySelectorAll('.terminal')
  const tr = term.length ? term[0].getBoundingClientRect() : null
  const cells = [...document.querySelectorAll('.desk-icon')]
  const labelOf = (c) => ((c.querySelector('.desk-label') || {}).textContent || '')
  return {
    state: String(M.state || ''), phase: String(M.phase || ''),
    dpr: devicePixelRatio, search: location.search,
    errors: (M.errors || []).map(String).slice(0, 4),
    preflight: document.documentElement.dataset.preflight || '',
    banner: (() => { const b = document.getElementById('driver-hint')
      return b ? (b.textContent || '').slice(0, 120) : '' })(),
    taskbar: Boolean(document.querySelector('[data-taskbar]')),
    orb: orb ? mid(orb) : null,
    mark: Boolean(window.__m21Mark),
    terminals: term.length,
    term: tr ? { x: Math.round(tr.left + 30), y: Math.round(tr.top + 20) } : null,
    icons: cells.map(labelOf),
    iconAims: cells.map((c) => ({ label: labelOf(c), ...mid(c) })),
    seed: (() => { const s = M.seed || {}
      return { dest: s.dest || '', home: s.home || '', drifted: Boolean(s.drifted),
               ran: Boolean((s.seed || {}).ran), why: String(s.why || '') } })(),
    windows: [...(((M.host || {}).frames) || new Map()).values()]
      .map((e) => String(e.win.titleText || '')),
    tail: log ? (log.textContent || '').trim().split('\\n').slice(-3) : [],
  }
})())"""

#: One terminal's screen, as text. A pty is the one surface in this system whose whole content is
#: characters, which is why it is also the one a command's output can be asserted out of.
SCREEN = "(document.querySelector('.terminal') || {}).textContent || ''"

#: The marker the reload has to destroy. Set on `window`, so it cannot survive a navigation and
#: cannot be confused with anything the page itself keeps.
MARK = "(() => { window.__m21Mark = 1; return 1 })()"

#: INSTALL THE READER, ONCE PER PAGE. Three halves, and none is a second copy of anything:
#:
#:   - the TAP. A surfaced window's content is a canvas, and the only way to read its rows back is
#:     the batch that drew them. The landing page publishes no kernel handle — by design, it is the
#:     product — so the tap goes on `Surface.prototype.replay`, the one function every batch passes
#:     through. It DELEGATES, so the page renders exactly what it would have, and it is on the
#:     PROTOTYPE so a re-surface does not lose it. `bench/m20-verbs/firefox-verbs.py` is the
#:     precedent.
#:   - the ARITHMETIC. `FILES_METRICS` is imported rather than restated — `columnBoxes`, `rowMid`
#:     and `toSurface` are the program's own, which is the whole reason that object is exported.
#:   - the BIN'S PATH, asked of `binDirIn(std.HOME_DIR)`: the same expression `src/bin/files.mjs`
#:     evaluates for `binRoot`, so the driver and the program cannot disagree about where a deleted
#:     file went.
INSTALL = """(async () => {
  const abi = await import('/src/abi.mjs')
  const surf = await import('/src/wm/surface.mjs')
  const files = await import('/src/bin/files.mjs')
  const std = await import('/src/libos/std.mjs')
  const G = globalThis.__M21FF || (globalThis.__M21FF = { last: new WeakMap() })
  G.abi = abi
  G.M = files.FILES_METRICS
  if (!G.wrapped) {
    const proto = surf.Surface.prototype
    const orig = proto.replay
    proto.replay = function (bytes) {
      G.last.set(this, bytes.slice())
      return orig.call(this, bytes)
    }
    G.wrapped = true
  }
  // STRINGIFIED INSIDE THE PROMISE: BiDi's `script.evaluate` has no top-level `await`, so the
  // expression IS the async call and `awaitPromise` resolves it.
  return JSON.stringify({ ok: true, home: std.HOME_DIR,
                          bin: G.M.binDirIn(std.HOME_DIR), suffix: G.M.ORIGIN_SUFFIX,
                          rowH: G.M.ROW_H, cols: G.M.COLUMNS.map((c) => c.key) })
})()"""

#: WHAT ONE `files` WINDOW HAS DRAWN, where to aim inside it, and what the host has recorded about
#: its menus. The window is chosen by a SUBSTRING OF ITS TITLE, because this run has two of them —
#: the fixture's directory and the Bin — and `src/bin/files.mjs:2180` titles each with the directory
#: it is looking at. Picking "the first `files` window" would read one window and aim at the other.
#:
#: Nothing below compares a colour against a literal: the inks of `src/bin/files.mjs` are
#: module-private, so every discriminator here is STRUCTURAL. A ROW NAME is a run whose x is the
#: `name` column's own `textX` and which is not bold — the three metadata cells hang off their
#: columns' RIGHT edges and the four header labels are bold.
READ = """JSON.stringify((() => {
  const want = %s
  const G = globalThis.__M21FF
  if (!G || !G.abi) return { error: 'the reader was never installed' }
  const host = (globalThis.INDEX || {}).host
  if (!host) return { error: 'the landing page published no window host' }
  const titles = []
  let entry = null
  for (const e of host.frames.values()) {
    const t = String(e.win.titleText || '')
    if (t.startsWith('files')) titles.push(t)
    if (!entry && e.surface && t.startsWith('files') && t.includes(want)) entry = e
  }
  if (!entry) return { error: 'no `files` window with a surface whose title holds ' + want,
                       titles }
  const bytes = G.last.get(entry.surface)
  if (!bytes || !bytes.length) {
    return { error: 'that `files` surface has replayed no batch since the reader was installed' }
  }
  const { decodeDrawOps, textOfOps, DL_TEXT, DLT_BOLD } = G.abi
  const M = G.M
  const ops = decodeDrawOps(bytes, bytes.length)
  const runs = []
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i].op !== DL_TEXT) continue
    const got = textOfOps(ops, i)
    if (!got) continue
    runs.push({ text: got.text, x: ops[i].a0, y: ops[i].a1, flags: ops[i].flags })
    i += got.records - 1
  }
  const r = entry.surface.el.getBoundingClientRect()
  // THE SCALE AND THE WIDTH ARE BOTH MEASURED, never assumed: the backing store is device px and
  // the box is CSS px, and the whole of M16 is that those are different numbers (constraint 264).
  const scale = r.width > 0 ? entry.surface.w / r.width : 1
  const wCss = r.width
  const cols = M.columnBoxes(wCss)
  const nameX = M.toSurface((cols.find((c) => c.key === 'name') || {}).textX || 0, scale)
  const names = runs.filter((t) => t.x === nameX && !(t.flags & DLT_BOLD))
                    .sort((a, b) => a.y - b.y)
  const at = (x, y) => ({ x: Math.round(r.left + x), y: Math.round(r.top + y) })
  const popup = document.querySelector('[data-popup]')
  return {
    title: String(entry.win.titleText || ''), id: entry.id, scale, wCss, titles,
    clientH: entry.surface.extent().cssH, batches: entry.surface.batches,
    names: names.map((n) => n.text),
    place: (runs.find((t) => /^\\d+ items?$/.test(t.text)
                            || /^\\d+-\\d+ of \\d+$/.test(t.text)) || {}).text || '',
    rows: names.map((n, i) => ({ name: n.text, ...at(M.NAME_X + 10, M.rowMid(i, 0)) })),
    menu: {
      open: Boolean(popup) && !popup.hidden,
      kind: popup ? String(popup.dataset.popup || '') : '',
      labels: popup && !popup.hidden
        ? [...popup.querySelectorAll('.shell-row')].map((el) =>
            (el.querySelector('.shell-label') || {}).textContent || '')
        : [],
      aims: popup && !popup.hidden
        ? [...popup.querySelectorAll('.shell-row')].map((el) => {
            const b = el.getBoundingClientRect()
            return { label: (el.querySelector('.shell-label') || {}).textContent || '',
                     index: Number(el.dataset.contextIndex),
                     disabled: el.disabled === true,
                     x: Math.round(b.left + b.width / 2),
                     y: Math.round(b.top + b.height / 2) } })
        : [],
    },
    host: { menus: host.stats.menus | 0, choices: host.stats.menuChoices | 0,
            dismisses: host.stats.menuDismisses | 0,
            lastContext: host.lastContextMenu || null,
            lastReport: host.lastMenuReport || null },
  }
})())"""

#: WHAT A HIT TEST FINDS at a point, because a covered canvas and an inert one are the same picture
#: (constraint 40). Every gesture below is aimed through this, so a press that went to another
#: window is reported rather than silently counted as a program that did nothing.
UNDER = """JSON.stringify((() => {
  const el = document.elementFromPoint(%d, %d)
  if (!el) return { hits: 'nothing' }
  const frame = el.closest ? el.closest('.window') : null
  const pop = el.closest ? el.closest('[data-popup]') : null
  const term = el.closest ? el.closest('.terminal') : null
  if (pop) return { tag: String(el.tagName || ''), hits: 'the shell popup' }
  if (term) return { tag: String(el.tagName || ''), hits: 'the terminal' }
  return { tag: String(el.tagName || ''),
           hits: frame ? ((frame.querySelector('h2') || {}).textContent || '').trim()
                       : 'no window' }
})())"""


def settle(ff, tries: int = 100) -> dict:
    """Wait for the desktop to stage and its layout to stop moving.

    THE SECOND HALF IS NOT DECORATION. The page prints its own log, the log grows, and the desktop
    is pushed down under it — measured on m14, an icon at y=65 became y=249 — so a rect read before
    that and clicked after is clicked where nothing is. Two identical reads is the signal, which is
    `bench/m14-shell/firefox-drive.py`'s rule for the same hazard.
    """
    last, stable, st = None, 0, {}
    for _ in range(tries):
        st = ff.evaluate(STATE)
        now = None if not st.get("term") else (st["term"]["x"], st["term"]["y"], st["terminals"])
        stable = stable + 1 if now and now == last and st.get("state") == "done" else 0
        last = now
        if stable >= 2:
            return st
        time.sleep(0.4)
    return st


def read(ff, want: str) -> dict:
    got = ff.evaluate(READ % (repr(str(want)).replace("'", '"'),))
    return got if isinstance(got, dict) else {"error": "the reader returned %r" % (got,)}


def under(ff, point: dict) -> dict:
    got = ff.evaluate(UNDER % (int(point["x"]), int(point["y"])))
    return got if isinstance(got, dict) else {}


def shq(path: str) -> str:
    """A path as ONE shell word, with nothing in it expanded.

    THE BIN'S NAME STARTS WITH `$`. `src/libos/shlex.mjs`'s `expandWord` runs `expandVars` over
    every span that is not single-quoted, so a bare `/Users/Default/$Recycle.Bin` reaches `files` as
    `/Users/Default/.Bin` — a path that does not exist, from a command that reported nothing wrong.
    Measured: the first run of this gate cleared the wrong directory and then opened no window, and
    the reader's `error` was the only sign.

    A single quote inside the path would need the `'\\''` dance and is REFUSED instead, because this
    gate names no such path and a quoting routine nobody exercises is a quoting routine that is
    wrong.
    """
    if "'" in path:
        raise ValueError("a path holding a single quote cannot be spelled at this prompt: %r"
                         % path)
    return "'%s'" % path


def at_prompt(ff, cmd: str) -> str:
    """Type a command at a real prompt and return ONLY what it printed.

    IT WAITS FOR THE PROMPT, not for a timer: a command slower than a guess would have its output
    read as the next command's, which is how a gate comes to assert one command's success against
    another's (`bench/m14-shell/coreutils.py`).
    """
    before = len(ff.evaluate(SCREEN, raw=True))
    ff.type_keys(cmd + "\n")
    out = ""
    for _ in range(80):
        time.sleep(0.15)
        out = ff.evaluate(SCREEN, raw=True)[before:]
        if re.search(r"\$\s*$", out) and len(out.strip()) > len(cmd):
            break
    said = " ".join(out.split())
    print("    $ %-56s | %s" % (cmd, said[len(" ".join(cmd.split())):].strip()[:150]))
    return out


def focus_terminal(ff, st: dict) -> str:
    """Put the caret in the desktop's pty, and PROVE the keystrokes are landing in it.

    THE PROBE IS THE POINT. A harness must fail when it is not reading what it was pointed at
    (`CLAUDE.md` §Harness honesty), and a pty that has the caret is indistinguishable from one that
    does not until something is typed into it. The hit test goes first because this run opens
    windows between its typings: a point the caret would have reached on a bare desktop can be under
    a `files` frame by the time it is used again, and a click that landed on a canvas would read as
    a shell that printed nothing.
    """
    if st.get("terminals") != 1 or not st.get("term"):
        return "%s terminal(s) on screen; `SCREEN` reads the first and the keys go to the " \
               "focused one, so this run could not be trusted" % st.get("terminals")
    hit = under(ff, st["term"])
    if hit.get("hits") != "the terminal":
        return "the point this gate types at (%s,%s) is covered by %r, so the keystrokes would " \
               "go to another window" % (st["term"]["x"], st["term"]["y"], hit.get("hits"))
    ff.click(st["term"]["x"], st["term"]["y"])
    time.sleep(0.3)
    probe = "m21-probe-%s" % secrets.token_hex(2)
    if probe not in at_prompt(ff, "echo %s" % probe):
        return "a real keystroke did not reach the pty: `echo %s` printed nothing back, so the " \
               "caret is not in the terminal this run reads" % probe
    return ""


def open_files(ff, directory: str, want: str, *, settle_s: float = 4.0) -> dict:
    """Spawn `files` at a real prompt and return what the named window drew.

    IT RETURNS THE READER'S OWN `error` RATHER THAN RAISING OR SCORING. A `files` that opened no
    window is sometimes the defect under test and sometimes a broken run, and only the caller knows
    which: after the `wipe` control the directory itself is gone, and `files` on a path that does
    not exist correctly opens nothing.
    """
    ff.type_keys("files %s &\n" % shq(directory))
    time.sleep(settle_s)
    return read(ff, want)


def aim_row(state: dict, name: str):
    for row in state.get("rows") or []:
        if row.get("name") == name:
            return row
    return None


def aim_popup(state: dict, label: str):
    hits = [a for a in ((state.get("menu") or {}).get("aims") or []) if a.get("label") == label]
    return hits[0] if len(hits) == 1 else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--url", default="", help="an already-running server; otherwise one is bound")
    ap.add_argument("--page", default="/www/index.html",
                    help="the landing page, at its BARE url: no query, no proofs")
    ap.add_argument("--w", type=int, default=1560)
    ap.add_argument("--h", type=int, default=1010)
    ap.add_argument("--settle", type=float, default=1.4,
                    help="seconds between gestures. Over the platform's double-click threshold, so "
                         "two single clicks on one row are not read as an activation")
    ap.add_argument("--shot", default=str(HERE / "firefox-bin.png"))
    ap.add_argument("--control", choices=sorted(CONTROLS), default="esc-not-restore",
                    help="which world `--prove-failure` builds. %s"
                         % "; ".join("%s moves %s and must leave %s alone"
                                     % (k, ", ".join(v[0]), ", ".join(v[1]))
                                     for k, v in sorted(CONTROLS.items())))
    ap.add_argument("--prove-failure", action="store_true",
                    help="run the control named by --control. Its own clauses MUST fire and the "
                         "ones it does not name MUST NOT. Exits 0 when the proof SUCCEEDED.")
    args = ap.parse_args(argv)

    proof_tags, kept_tags = CONTROLS[args.control]
    on = args.prove_failure
    #: THE THREE THINGS A CONTROL MAY CHANGE, and each world changes exactly one of them.
    hold_ctrl = not (on and args.control == "no-ctrl")
    restore_by = "escape" if on and args.control == "esc-not-restore" else "click"
    wipe = on and args.control == "wipe"

    httpd = None
    url = args.url
    if not url:
        os.chdir(REPO)
        httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d%s" % (httpd.server_address[1], args.page)
    # THE ORIGIN MUST NOT CHANGE ACROSS THE RELOAD. OPFS is keyed by origin, so a run that bound a
    # second server on a second port for the second boot would meet an empty volume every time and
    # report a defect that is its own (`bench/m19a-seed-firefox/firefox-session.py`).
    wipe_url = url.rsplit("/www/", 1)[0] + "/bench/m19a-seed-firefox/wipe.html"

    stamp = secrets.token_hex(3)
    leaf = "m21ff-%s" % stamp
    # THE TWO FIXTURE FILES, AND EACH HAS ONE JOB. `KEPT` stays in the Bin and `BACK` comes out of
    # it, and the names are nonces so that a dirty Bin could not have numbered either of them —
    # `freeFrom` would answer `back-… (2).txt` and every aim below would miss.
    #
    # `BACK` SORTS FIRST, which is why it is the Ctrl-clicked one: the list is name-ascending, the
    # plain click lands on `KEPT`, and the `no-ctrl` control therefore deletes `BACK` ALONE — the
    # row this run restores. A control that took the restore's own subject away would collapse
    # clauses it does not name, and a control satisfied by any failure verifies nothing.
    kept_name = "kept-%s.txt" % secrets.token_hex(4)
    back_name = "back-%s.txt" % secrets.token_hex(4)
    nonce_kept = "kept-bytes-%s" % secrets.token_hex(5)
    nonce_back = "back-bytes-%s" % secrets.token_hex(5)
    print("url      %s" % url)
    print("fixture  %s holding %s (-> %s) and %s (-> %s)"
          % (leaf, back_name, nonce_back, kept_name, nonce_kept))
    if on:
        print("control  --control %s. %s MUST fire; %s MUST NOT"
              % (args.control, ", ".join(proof_tags), ", ".join(kept_tags)))
        unscoped = sorted(set(TAGS) - set(proof_tags) - set(kept_tags))
        if unscoped:
            print("         unscoped under it: %s — neither claimed nor kept" % ", ".join(unscoped))

    #: (tag, message). The tag is what `--prove-failure` scopes its proof to.
    bad: list[tuple[str, str]] = []
    good: list[str] = []
    pause = max(0.2, args.settle)
    try:
        with bidi.Firefox(headless=not args.headed, width=args.w, height=args.h) as ff:
            # ---- BOOT 1, and clause 1: IS THERE A DESKTOP AT ALL? ------------------------------
            ff.navigate(url)
            st = settle(ff)
            print("firefox  dpr %s  state=%r phase=%r search=%r preflight=%r"
                  % (st.get("dpr"), st.get("state"), st.get("phase"), st.get("search"),
                     st.get("preflight")))
            for line in st.get("tail") or []:
                print("log      %s" % line)
            if st.get("errors"):
                print("page     errors %s" % st["errors"])
            if st.get("search"):
                print("\nthis is not the bare url: location.search is %r" % st["search"])
                return 1
            if not st.get("taskbar"):
                bad.append(("desktop", "no taskbar: nothing matches [data-taskbar]"))
            if not st.get("orb"):
                bad.append(("desktop", "no start orb: nothing matches [data-start]"))
            if not st.get("icons"):
                bad.append(("desktop", "the desktop published no icons"))
            if st.get("banner"):
                bad.append(("desktop", "the bare url is a proof harness waiting for a driver "
                                       "(constraint 283): %s" % st["banner"]))
            print("desktop  taskbar=%s orb=%s icons=%s"
                  % (st.get("taskbar"), bool(st.get("orb")), st.get("icons")))
            if not st.get("taskbar") or not st.get("icons"):
                for tag, line in bad:
                    print("BAD  [%s] %s" % (tag, line))
                print("\nthere is no desktop to drive, so clauses 2-9 were not run")
                ff.screenshot(args.shot)
                return 1
            good.append("the bare url is a desktop: a taskbar, a start orb, %d icon(s) and no "
                        "driver banner" % len(st["icons"]))

            # ---- THE SESSION'S WRITABLE TREE AND THE BIN, BOTH READ AND NEITHER TYPED ----------
            seed = st.get("seed") or {}
            print("seed     %s" % seed)
            if not seed.get("dest") or seed.get("drifted"):
                print("\nthe session's writable tree could not be located (dest=%r drifted=%s "
                      "why=%r), so there is nowhere a delete could put anything and nothing below "
                      "could be about a Bin."
                      % (seed.get("dest"), seed.get("drifted"), seed.get("why")))
                ff.screenshot(args.shot)
                return 1
            directory = "%s/%s" % (seed["dest"], leaf)

            got = ff.evaluate(INSTALL)
            print("reader   %s" % got)
            if not isinstance(got, dict) or not got.get("ok") or not got.get("bin"):
                print("\nthe display-list reader could not be installed, so no row below could be "
                      "read back out of what was drawn: %s" % (got,))
                return 1
            bin_dir = str(got["bin"])
            bin_leaf = bin_dir[bin_dir.rfind("/") + 1:]
            suffix = str(got["suffix"])
            print("bin      %s   (asked of FILES_METRICS.binDirIn(std.HOME_DIR))" % bin_dir)

            # ---- THE FIXTURE, TYPED AT A REAL PROMPT -------------------------------------------
            why = focus_terminal(ff, st)
            if why:
                print("\n%s" % why)
                ff.screenshot(args.shot)
                return 1
            # THE BIN IS EMPTIED WITH THE FIXTURE: it accumulates by design (this file's header).
            at_prompt(ff, "rm -r -f %s %s" % (shq(directory), shq(bin_dir)))
            at_prompt(ff, "mkdir -p %s" % shq(directory))
            at_prompt(ff, "echo %s > %s" % (nonce_kept, shq("%s/%s" % (directory, kept_name))))
            at_prompt(ff, "echo %s > %s" % (nonce_back, shq("%s/%s" % (directory, back_name))))
            listed = at_prompt(ff, "ls %s" % shq(directory))
            if kept_name not in listed or back_name not in listed:
                print("\nthe fixture did not take: `ls %s` printed %r, so every clause below would "
                      "be about a different directory."
                      % (directory, " ".join(listed.split())[:200]))
                ff.screenshot(args.shot)
                return 1
            # THE NONCES ARE READ BACK BEFORE ANYTHING IS DELETED, so clause 6 is a comparison
            # against bytes that were measured to be there rather than against a string this file
            # hoped `echo` wrote. A `cat` that cannot pass here cannot fail there for the right
            # reason.
            seeded = at_prompt(ff, "cat %s" % shq("%s/%s" % (directory, back_name)))
            if nonce_back not in seeded:
                print("\nthe fixture's own bytes are not readable before the delete: "
                      "`cat %s/%s` printed %r. Clause 6 would be asserting against nothing."
                      % (directory, back_name, " ".join(seeded.split())[:160]))
                ff.screenshot(args.shot)
                return 1

            state = open_files(ff, directory, leaf)
            if state.get("error"):
                print("\nthe `files` window could not be read, so clauses 2-9 were not run: %s"
                      % state["error"])
                ff.screenshot(args.shot)
                return 1
            print("files    title=%r scale=%s wCss=%s clientH=%s batches=%s place=%r"
                  % (state["title"], state["scale"], round(state["wCss"], 2), state["clientH"],
                     state["batches"], state["place"]))
            print("rows     %s" % state["names"])
            if sorted(state["names"]) != sorted((kept_name, back_name)):
                print("\nthe list is not the fixture this gate was written against: %s, wanted %s"
                      % (state["names"], sorted((kept_name, back_name))))
                ff.screenshot(args.shot)
                return 1
            if not str(state["place"]).endswith("items"):
                print("\nthe list is SCROLLED (%r), so `rowMid(i, 0)` is not where row i is and "
                      "every aim point below would miss." % state["place"])
                ff.screenshot(args.shot)
                return 1

            # ---- 2. TWO ROWS, A HELD MODIFIER, AND THE DELETE KEY ------------------------------
            first = aim_row(state, kept_name)
            second = aim_row(state, back_name)
            if not first or not second:
                print("\nboth fixture rows must be drawn to select two of them: %s"
                      % state["names"])
                ff.screenshot(args.shot)
                return 1
            for name, point in ((kept_name, first), (back_name, second)):
                hit = under(ff, point)
                print("aim      %-22s %s,%s -> %r" % (name, point["x"], point["y"],
                                                      hit.get("hits")))
                if "files" not in str(hit.get("hits")):
                    print("\nthe row %r is covered by %r, so a press on it would go to another "
                          "window." % (name, hit.get("hits")))
                    ff.screenshot(args.shot)
                    return 1
            ff.click(first["x"], first["y"])
            time.sleep(pause)
            if hold_ctrl:
                # THE MODIFIER IS HELD ACROSS THE PRESS, which `press(..., ctrl=True)` cannot do:
                # see `Firefox.held` and this file's header. Without it the press REPLACES the
                # selection, which is the `no-ctrl` world.
                with ff.held("Control"):
                    ff.click(second["x"], second["y"])
            else:
                ff.click(second["x"], second["y"])
            time.sleep(pause)
            before_screen = len(ff.evaluate(SCREEN, raw=True))
            ff.press("Delete")
            time.sleep(2.0)
            emptied = read(ff, leaf)
            said = " ".join(ff.evaluate(SCREEN, raw=True)[before_screen:].split())
            print("delete   held-ctrl=%s rows %s -> %s" % (hold_ctrl, state["names"],
                                                           emptied.get("names")))
            print("program  %s" % said[:200])
            left = [n for n in (kept_name, back_name) if n in (emptied.get("names") or [])]
            if left:
                bad.append(("deleted", "%s still in the list after the Delete key: %s. The "
                                       "selection the two presses made was %s"
                            % (", ".join(left), emptied.get("names"),
                               "two rows" if hold_ctrl else "one row, by design")))
            elif BINNED_TWO not in said:
                bad.append(("deleted", "both rows left the list and the program did not say %r: "
                                       "%r. A row that went away is not the same fact as bytes "
                                       "that were kept" % (BINNED_TWO, said[:200])))
            else:
                good.append("a click, a Ctrl-click under a HELD modifier and the Delete key took "
                            "BOTH rows out, and the program said %r" % BINNED_TWO)

            # ---- 3. THE DESKTOP'S OWN RECYCLE BIN ICON ---------------------------------------
            #
            # THE READER'S ONLY ROUTE, and it is scored on its own: every clause below asks what the
            # Bin CONTAINS, and a Bin a reader cannot open is a different defect from a Bin that
            # lost something. See this file's header for why it is unscoped under every control.
            time.sleep(pause)
            aims = [a for a in (st.get("iconAims") or []) if "Recycle" in str(a.get("label"))]
            bin_window = {"error": "the Bin was never opened"}
            if len(aims) != 1:
                bad.append(("binIcon", "the desktop publishes %d icon(s) labelled Recycle Bin, not "
                                       "one: %s" % (len(aims), st.get("icons"))))
            else:
                icon = aims[0]
                hit = under(ff, icon)
                print("icon     %r at %s,%s -> %r"
                      % (icon["label"], icon["x"], icon["y"], hit.get("hits")))
                ff.dblclick(icon["x"], icon["y"])
                time.sleep(4.0)
                bin_window = read(ff, bin_leaf)
                if bin_window.get("error"):
                    bad.append(("binIcon", "a real double-click on the desktop's %r icon opened no "
                                           "`files` window looking at %s: %s. `files` windows on "
                                           "screen: %s"
                                % (icon["label"], bin_dir, bin_window["error"],
                                   bin_window.get("titles"))))
                else:
                    good.append("a double-click on the desktop's %r icon opened %r"
                                % (icon["label"], bin_window["title"]))

            # ---- ...AND THE FALLBACK, SAID OUT LOUD ------------------------------------------
            if bin_window.get("error"):
                print("fallback the Bin is being opened by TYPING ITS PATH, because the icon did "
                      "not. Clauses 4-9 below are still measured; clause 3 is the one that failed")
                why = focus_terminal(ff, st)
                if why:
                    print("\n%s" % why)
                    ff.screenshot(args.shot)
                    return 1
                # WHAT THE ICON'S OWN ARGV DOES, RUN RATHER THAN READ. The row is
                # `["files", "--bin"]` and the reason it opens nothing is a sentence this gate
                # would otherwise be asserting out of the source: typing it at the prompt is the
                # observation, and it goes into the `binIcon` message so the finding carries its
                # own reproduction. Nothing here is scored on the text — the clause is already red
                # on the window that did not open.
                said_bin = " ".join(at_prompt(ff, "files --bin").split())
                bad.append(("binIcon", "and the row's own argv at a real prompt says why: "
                                       "`files --bin` -> %r"
                            % said_bin[len("files --bin"):].strip()[:160]))
                bin_window = open_files(ff, bin_dir, bin_leaf)
            if bin_window.get("error"):
                print("\nno window is looking at %s by either route, so clauses 4-9 could not be "
                      "read at all: %s" % (bin_dir, bin_window["error"]))
                ff.screenshot(args.shot)
                return 1

            # ---- 4. THE BIN SHOWS BOTH PAYLOADS ----------------------------------------------
            print("bin      title=%r rows %s place=%r"
                  % (bin_window["title"], bin_window.get("names"), bin_window.get("place")))
            bin_rows = bin_window.get("names") or []
            missing = [n for n in (kept_name, back_name) if n not in bin_rows]
            records = [n for n in bin_rows if n.endswith(suffix)]
            if missing:
                bad.append(("shown", "%s is not in the Bin's own rows: %s. A delete that reported "
                                     "the bytes went where a reader cannot see them is a delete "
                                     "that lost them" % (", ".join(missing), bin_rows)))
            elif records:
                bad.append(("shown", "the Bin lists its own bookkeeping as rows: %s. An origin "
                                     "record is a symlink carrying a path, it has no bytes, and a "
                                     "reader cannot restore one" % records))
            elif len(bin_rows) != 2:
                bad.append(("shown", "the Bin holds %d row(s) and the delete put 2 there: %s"
                            % (len(bin_rows), bin_rows)))
            else:
                good.append("the Bin shows both deleted files under the names they had: %s, with "
                            "no origin record among the rows" % bin_rows)

            # ---- 5. A RIGHT-CLICK, THE `Restore` ROW, AND THE FILE BACK WHERE IT WAS ----------
            time.sleep(pause)
            target = aim_row(bin_window, back_name)
            if not target:
                bad.append(("restored", "the payload %r is not drawn in the Bin, so there is "
                                        "nothing to restore: %s" % (back_name, bin_rows)))
                after = bin_window
            else:
                hit = under(ff, target)
                print("aim      %-22s %s,%s -> %r"
                      % (back_name, target["x"], target["y"], hit.get("hits")))
                if "files" not in str(hit.get("hits")):
                    print("\nthe Bin's row %r is covered by %r, so a press on it would go to "
                          "another window." % (back_name, hit.get("hits")))
                    ff.screenshot(args.shot)
                    return 1
                ff.click(target["x"], target["y"], button=2)
                time.sleep(pause)
                opened = read(ff, bin_leaf)
                menu = opened.get("menu") or {}
                ctx = (opened.get("host") or {}).get("lastContext") or {}
                print("menu     open=%s kind=%r labels=%s" % (menu.get("open"), menu.get("kind"),
                                                              menu.get("labels")))
                print("host     %s" % (opened.get("host") or {}))
                pick = aim_popup(opened, RESTORE)
                if not menu.get("open") or menu.get("kind") != "context":
                    bad.append(("restored", "a trusted secondary press on the Bin's row opened no "
                                            "context popup (open=%s kind=%r lastContext=%s)"
                                % (menu.get("open"), menu.get("kind"), ctx)))
                    after = opened
                elif (menu.get("labels") or [None])[0] != RESTORE:
                    bad.append(("restored", "the Bin's row menu does not lead with %r: %s. A "
                                            "reader looking for their file looks for that word "
                                            "first" % (RESTORE, menu.get("labels"))))
                    after = opened
                elif not pick or pick.get("disabled"):
                    bad.append(("restored", "there is no single enabled %r row to click: %s"
                                % (RESTORE, menu.get("aims"))))
                    after = opened
                else:
                    print("pick     %r index=%s at %s,%s  (ended with %s)"
                          % (pick["label"], pick["index"], pick["x"], pick["y"], restore_by))
                    if restore_by == "escape":
                        # THE MENU DISMISSED INSTEAD OF CHOSEN: `commitRestore` is never reached, so
                        # the payload stays in the Bin and the origin path stays empty.
                        ff.press("Escape")
                    else:
                        ff.click(pick["x"], pick["y"])
                    time.sleep(2.0)
                    after = read(ff, bin_leaf)
                    print("bin      rows %s -> %s" % (bin_rows, after.get("names")))
                    why = focus_terminal(ff, st)
                    if why:
                        print("\n%s" % why)
                        ff.screenshot(args.shot)
                        return 1
                    home_again = at_prompt(ff, "ls %s" % shq(directory))
                    if back_name in (after.get("names") or []):
                        bad.append(("restored", "%r is STILL in the Bin after %r was %s: %s"
                                    % (back_name, RESTORE,
                                       "dismissed with Escape" if restore_by == "escape"
                                       else "clicked", after.get("names"))))
                    elif back_name not in home_again:
                        bad.append(("restored", "%r left the Bin and is not in the directory it "
                                                "was deleted from: `ls %s` printed %r. A restore "
                                                "that named no destination lost the file"
                                    % (back_name, directory,
                                       " ".join(home_again.split())[:160])))
                    else:
                        good.append("a real right-click on %r raised the Bin's own menu leading "
                                    "with %r, and a real click on it took the row out of the Bin "
                                    "and put the file back in %s" % (back_name, RESTORE, directory))

            # ---- 6. AND THE BYTES CAME WITH IT ----------------------------------------------
            why = focus_terminal(ff, st)
            if why:
                print("\n%s" % why)
                ff.screenshot(args.shot)
                return 1
            body = at_prompt(ff, "cat %s" % shq("%s/%s" % (directory, back_name)))
            if nonce_back not in body:
                bad.append(("bytes", "the restored %r does not hold the bytes it was written with: "
                                     "`cat` printed %r, and %r is not in it. A name that came back "
                                     "says nothing about the payload"
                            % (back_name, " ".join(body.split())[:160], nonce_back)))
            elif nonce_kept in body:
                bad.append(("bytes", "the restored %r holds the OTHER file's nonce (%r): %r. The "
                                     "restore moved the wrong payload home"
                            % (back_name, nonce_kept, " ".join(body.split())[:160])))
            else:
                good.append("and it holds its OWN bytes: `cat` prints %r, with the other fixture "
                            "file's nonce absent — which is what makes this comparison capable of "
                            "failing" % nonce_back)

            # ---- 7. THE OTHER PAYLOAD IS STILL IN THE BIN -----------------------------------
            still = at_prompt(ff, "ls %s" % shq(bin_dir))
            if kept_name not in still:
                bad.append(("keptInBin", "%r is no longer in %s: `ls` printed %r. A restore moves "
                                         "ONE file; one that drained the Bin is a Bin that cannot "
                                         "be used twice"
                            % (kept_name, bin_dir, " ".join(still.split())[:160])))
            elif (kept_name + suffix) not in still:
                bad.append(("keptInBin", "%r is in the Bin with no origin record beside it (%r), "
                                         "so its Restore has no destination to name and the row "
                                         "would be published disabled"
                            % (kept_name, " ".join(still.split())[:160])))
            else:
                good.append("%r is still in the Bin with its origin record %r beside it"
                            % (kept_name, kept_name + suffix))

            # ---- THE RELOAD, and the control that goes in front of it -------------------------
            ff.evaluate(MARK)
            if wipe:
                # THE VOLUME TAKEN AWAY, so the next boot meets a fresh one and the kernel seeds a
                # new copy of the base over the reader's tree: constraint 28's defect as a world. It
                # cannot be done from the landing page — the kernel holds the blob locks — so the
                # navigation is part of the mechanism and not a convenience. The page is
                # `bench/m19a-seed-firefox/wipe.html`, reused rather than copied.
                ff.navigate(wipe_url)
                time.sleep(0.5)
                wiped = ff.evaluate("wipeOpfs().then((r) => JSON.stringify(r))")
                print("control  %s" % (wiped,))
                if not isinstance(wiped, dict) or not wiped.get("before"):
                    print("\nTHE CONTROL DID NOT TAKE: there was nothing in the OPFS root to "
                          "remove, so the second boot would have met a fresh volume anyway and "
                          "this run proves nothing about the gate. %s" % (wiped,))
                    return 1
                if wiped.get("left") or wiped.get("after"):
                    print("\nTHE CONTROL DID NOT TAKE: %s could not be removed and %s is still "
                          "there, so the second boot meets a HALF volume — which is neither fresh "
                          "nor the reader's tree, and is a third world nobody asked about."
                          % (wiped.get("left"), wiped.get("after")))
                    return 1

            ff.navigate(url)
            st2 = settle(ff)
            scroll = ff.evaluate(SCREEN, raw=True)
            print("reload   search=%r terminals=%s mark=%s screen=%d chars"
                  % (st2.get("search"), st2.get("terminals"), st2.get("mark"), len(scroll)))
            # TWO SIGNALS THAT THE PAGE IS NEW, and the second is the one that matters. A window
            # count cannot be it: `www/shell.mjs` stages a terminal, so the reloaded desktop
            # legitimately has one. What a page that never navigated WOULD have is the first boot's
            # scrollback — the `mkdir` that built the fixture, carrying `leaf` — so its absence is
            # what says the pty below is a new pty and clause 8 is not reading clause 2's output.
            if st2.get("mark"):
                print("\n`window.__m21Mark` survived, so the page never navigated and every clause "
                      "below would read the FIRST boot's kernel.")
                ff.screenshot(args.shot)
                return 1
            if leaf in scroll:
                print("\nthe terminal still carries the first boot's scrollback (%r), so the "
                      "clauses below would be reading this run's own typing rather than the "
                      "volume." % leaf)
                ff.screenshot(args.shot)
                return 1
            if not st2.get("taskbar") or not st2.get("icons"):
                bad.append(("desktop", "the reloaded page is not a desktop: taskbar=%s icons=%s"
                            % (st2.get("taskbar"), st2.get("icons"))))
                for tag, line in bad:
                    print("BAD  [%s] %s" % (tag, line))
                ff.screenshot(args.shot)
                return 1
            print("seed     %s" % (st2.get("seed") or {}))

            got = ff.evaluate(INSTALL)
            print("reader   %s" % got)
            if not isinstance(got, dict) or not got.get("ok"):
                print("\nthe reader could not be installed on the reloaded page: %s" % (got,))
                return 1
            why = focus_terminal(ff, st2)
            if why:
                print("\n%s" % why)
                ff.screenshot(args.shot)
                return 1

            # ---- 8+9. THE RESTORE AND THE BIN, AFTER THE RELOAD -----------------------------
            #
            # THREE INDEPENDENT READINGS of the restored file: `ls` at a new prompt, `cat` of its
            # bytes, and a NEW `files` window's own display list. Either of the first two could be
            # right while the list is wrong, and a reader sees the list.
            again = at_prompt(ff, "ls %s" % shq(directory))
            body2 = at_prompt(ff, "cat %s" % shq("%s/%s" % (directory, back_name)))
            in_ls = back_name in again
            rows_after = None
            if in_ls:
                back = open_files(ff, directory, leaf)
                if back.get("error"):
                    print("\n`ls %s` lists %r and no `files` window could be read for it: %s. The "
                          "two readings cannot be compared, so this run could not be trusted."
                          % (directory, back_name, back["error"]))
                    ff.screenshot(args.shot)
                    return 1
                rows_after = back.get("names") or []
                print("rows     %s" % rows_after)
            else:
                # THE THIRD READING IS NOT TAKEN WHEN THE FIRST ALREADY SAYS THE FILE IS GONE, and
                # that is a scope and not a softening: clause 8 is about a RESTORED file, so a list
                # read in a world where `ls` does not name it would be a reading of an absence. It
                # is required exactly where it matters — a directory `ls` says holds the file and a
                # window that does not show it is the disagreement a reader actually meets — and
                # the clause is already red here for the first reason. Measured: the
                # `esc-not-restore` world leaves the directory EMPTY, and `files` on it opened no
                # surface this gate could read, which is a third world nobody asked about.
                print("rows     not taken: `ls %s` does not name %r, so there is no row to look "
                      "for and clause 8 is already red on its first reading"
                      % (directory, back_name))
            in_rows = rows_after is None or back_name in rows_after
            if in_ls and in_rows and nonce_back in body2:
                good.append("after the reload the restored %r is in `ls`%s, still holding %r — and "
                            "neither the name nor the nonce was typed on this page, so the only "
                            "place either could have come from is the volume"
                            % (back_name,
                               "" if rows_after is None
                               else " AND in a new file manager window's own rows", nonce_back))
            else:
                # THE READINGS DISAGREEING IS ITS OWN SENTENCE, because it is a different defect
                # from all of them being empty: one of `ls`, `cat` and the list is wrong, and a
                # reader is being shown a directory that is not what the shell says it is.
                bad.append(("persists", "after the reload the restored %r is not what the reader "
                                        "left: `ls` %s it, the rows are %s, and `cat` printed %r. "
                                        "A restore that did not survive is a file a reader got "
                                        "back and lost again"
                            % (back_name, "lists" if in_ls else "does not list",
                               "unreadable" if rows_after is None else rows_after,
                               " ".join(body2.split())[:120])))
            # THE CARET WENT TO THE WINDOW THAT JUST OPENED, so it has to be taken back before
            # anything else is typed. Measured: without this, `ls <bin>` was typed INTO the new
            # `files` window and the Enter arrived as an activation — the clause below read
            # `files: no row is focused` as its listing and reported the Bin empty.
            why = focus_terminal(ff, st2)
            if why:
                print("\n%s" % why)
                ff.screenshot(args.shot)
                return 1
            still2 = at_prompt(ff, "ls %s" % shq(bin_dir))
            if kept_name in still2 and (kept_name + suffix) in still2:
                good.append("and %r is still in %s with its origin record, so the Bin is on the "
                            "volume and not in the page" % (kept_name, bin_dir))
            else:
                bad.append(("persists-bin", "after the reload %r is not in %s with its record: "
                                            "`ls` printed %r. A Bin that empties on a reload is a "
                                            "Bin a reader cannot come back to"
                            % (kept_name, bin_dir, " ".join(still2.split())[:160])))

            ff.screenshot(args.shot)
            print("shot     %s" % args.shot)
    finally:
        if httpd is not None:
            httpd.shutdown()

    print()
    for line in good:
        print("ok   %s" % line)
    for tag, line in bad:
        print("%s  [%s] %s" % ("would report" if on else "BAD ", tag, line))

    if on:
        fired = sorted({tag for tag, _ in bad if tag in proof_tags})
        collapsed = sorted({tag for tag, _ in bad if tag in kept_tags})
        loose = sorted({tag for tag, _ in bad} - set(proof_tags) - set(kept_tags))
        if loose:
            print("\nunscoped and red: %s. Neither claimed nor kept by `%s`, so it is reported and "
                  "not scored." % (", ".join(loose), args.control))
        # EXIT 0 WHEN THE PROOF SUCCEEDED, which is `scripts/check.py`'s convention: a non-zero exit
        # is reserved for a proof that failed to fail.
        if collapsed:
            print("\nTHE PROOF FAILED: `%s` also moved %s, which it must not touch. A control "
                  "satisfied by any failure verifies nothing." % (args.control, collapsed))
            return 1
        if fired:
            print("\nthe proof succeeded: `%s` fired %s of the %s clause(s), and %s stayed green."
                  % (args.control, fired, ", ".join(proof_tags), ", ".join(kept_tags)))
            return 0
        print("\nTHE PROOF FAILED: `%s` fired none of %s, so those clauses are not reading what "
              "the control changes." % (args.control, ", ".join(proof_tags)))
        return 1

    if bad:
        return 1
    print("\na reader who deleted two files by mistake can get one back: a Ctrl-click under a HELD "
          "modifier and the Delete key put both in the Bin, the desktop's own icon opened it, a "
          "right-click's %r put one file back where it was WITH ITS BYTES, the other stayed in the "
          "Bin — and after a reload both are still what the reader left, in FIREFOX, on the "
          "landing page, with real trusted input" % RESTORE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
