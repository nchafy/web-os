#!/usr/bin/env python3
"""CAN A READER RIGHT-CLICK AND ACTUALLY DO THINGS, AND DO THEY STICK? M20 in FIREFOX, on the
LANDING page.

    python3 bench/m20-verbs/firefox-verbs.py                  # the gate
    python3 bench/m20-verbs/firefox-verbs.py --prove-failure   # ...and it MUST report failures
    python3 bench/m20-verbs/firefox-verbs.py --control wipe --prove-failure
    python3 bench/m20-verbs/firefox-verbs.py --headed          # in a window you can watch
    python3 bench/m20-verbs/firefox-verbs.py --control         # ...prints what each world moves

Pipe stderr away for a quiet transcript: `serve.Handler` logs every request there.

WHY THIS FILE EXISTS. `CLAUDE.md` makes a second engine a condition of reporting a milestone done
and records the bill for skipping it: M4a shipped a window that could not be dragged in Firefox
(constraint 175), M6 a policy under which no process started there (206), M11 and M12 each a
geometry derived from a dpr-2 constant (264), M14 a desktop a reader could not open anything on
(289), and M17 a bare URL that threw in both engines while the suite stayed green. Six milestones,
every Chrome expectation green each time, every one found by a person opening a page.

M20 IS THE FIRST MILESTONE WHOSE SUBJECT IS A GESTURE THAT CHANGES THE DISK, which is why the
second engine matters here more than usual and in three specific places:

  - A SECONDARY PRESS IS AN ENGINE'S OWN PLUMBING. `src/wm/winhost.mjs` reads the button off
    `event.buttons` in a `mousedown` and refuses the browser's menu in a separate `contextmenu`
    handler, because one press delivers both (constraint 279). Whether a driver's "button 2" really
    arrives as both, trusted, is a fact about the wire: BiDi's `button: 2` was VERIFIED by running
    this gate, not read out of the spec — `host.lastContextMenu` reports
    `{button: 2, trusted: true, defaultPrevented: true}` below.
  - THE MENU IS THE SHELL'S POPUP IN THE PAGE'S DOM, not a drawing in the process's surface
    (constraint 226, D39). So "did a menu open" is a DOM question in one engine's layout and a
    `win_menu` count in the kernel, and the two must agree.
  - THE WRITES HAVE TO SURVIVE A RELOAD, and OPFS is a different implementation in each engine.
    M19a's gate proved a `>` at a prompt persists; this one asks it of a verb a reader reached by
    POINTING, which is the only route most readers have.

Firefox renders at **dpr 1** here, which is where this project's three unit bills hid. Every point
aimed below is derived from a MEASURED rect and `src/bin/files.mjs`'s own `FILES_METRICS`, never
from a constant.

IT RUNS ON `www/index.html`, THE BARE URL, so what is driven is the product and not a proof page
(constraint 283). That costs a fixture, and the fixture is built by TYPING AT THE REAL PROMPT:

    rm -r -f <session>/m20ff-<stamp> ; mkdir -p ... ; touch .../a.txt .../doomed.txt
    files <session>/m20ff-<stamp> &

THE FIXTURE LIVES IN THE SESSION'S WRITABLE TREE AND NOT IN `/tmp`. `/tmp` is a tmpfs
(`src/kernel/kernel.mjs` mounts it) and nothing there outlives a reload, so a persistence clause
written against it would be a clause that cannot pass. The tree is `INDEX.seed.dest` — the
destination the kernel reported copying the read-only base to (M19a, D40) — read rather than typed,
because a path written here would be a second copy of `src/kernel/seed.mjs`'s `SEED_DEST`.

THE WINDOW IS MAXIMIZED BY A DOUBLE-CLICK ON ITS CAPTION, and that is a fixture rather than a
flourish. `files` opens its window to exactly fit its content (`clientHeightFor`), so a freshly
opened one has NO empty paper inside the clipped viewport — measured here at 428x122 CSS px with
the last row ending 4 px past the viewport's bottom edge. The empty-space menu is the only menu
carrying New folder, and the only press that raises it is one that finds no row INSIDE the viewport
(`files`' own arbitration). A caption double-click is what a Windows reader does, and it takes the
client area to 1330x822 — so the aim has 700 px of empty paper under the last row.

WHAT IS ASSERTED. Every row of the list is read back out of the display list the program actually
drew, decoded with `src/abi.mjs`'s own `decodeDrawOps`/`textOfOps` and located with
`FILES_METRICS` — so the gate and the renderer share one arithmetic and there is no second copy of
a row's geometry or a cell's format here:

  1. `desktop`      the bare url is a desktop at all: a taskbar, a start orb, icons, and no driver
                    banner (constraint 283). The clause that collapses when there is no product,
                    which is what makes it the one every control must leave alone.
  2. `menu`         a REAL right-click on empty space raises THIS system's menu and not the
                    browser's. Four readings, because each alone passes in a world the others
                    catch: the shell's popup is open with the PROGRAM's own two labels; a
                    `win_menu` reached the kernel (`host.stats.menus`); the browser's own menu was
                    REFUSED (`defaultPrevented`); and the press that did it was button 2 and
                    `isTrusted`.
  3. `chosen`       a real click on the popup's `New folder` row reports THAT row back —
                    `host.lastMenuReport` carries the index the row itself publishes in
                    `dataset.contextIndex` and the `WITEM_CONTEXT` bit. Without this clause the
                    menu could be decoration: a reader who clicks a row and gets nothing has a
                    picture of a menu.
  4. `created`      and a DIRECTORY appears in the program's own rows — named, with a `DIR` Type
                    cell and an EMPTY Size cell, which is how a directory reads in this list. A
                    name alone would pass for a file.
  5. `renamed`      F2 on a clicked row, the field cleared, a nonce typed, Enter: the list shows
                    the new name and NO LONGER the old one. Both halves — a list showing both is a
                    copy, not a rename.
  6. `deleted`      Delete on a clicked row: the row is gone from the list.
  7. `persists`     after a RELOAD the renamed file is still there, in `ls` at a NEW prompt and in
                    a NEW `files` window's own rows.
  8. `persists-new` ...and so is the directory the MENU created.
  9. `persists-gone` ...and the deleted file is still absent.

CLAUSE 9 IS AN ABSENCE AND IS THEREFORE THE WEAK ONE: an empty volume satisfies it. What keeps it
honest is that it is read from the SAME listing as clauses 7 and 8, so a world where everything went
away fails those two in the same read. It is scored, and the `wipe` control is the run that shows
exactly this — `persists-gone` stays green there while `persists` and `persists-new` fire.

THE RENAME AND THE DELETE ARE DRIVEN BY KEYS AND THE CREATE BY THE MENU, deliberately. The menu's
own Rename and Delete rows are the Chrome suite's (`www/m20.html`'s `verbs` proof asserts the
`WEV_ITEM` for each); driving all three through the popup here would make every clause below 2
depend on clause 2, and a control that collapsed the menu would collapse the whole run. A control
satisfied by any failure verifies nothing (`CLAUDE.md` §Verification), so the three verbs are
reached by three independent routes and each control names a subset of its own.

THE FIVE CONTROLS, each re-runnable from the command line with no source edit:

  `--control left-button` (the default) DRIVES THE SECONDARY PRESS WITH BUTTON 0. The gesture, and
      nothing else, is changed: a left press on empty space is a rubber band and raises no menu
      (`files`' arbitration), so `menu`, `chosen`, `created` and `persists-new` MUST fire and the
      keyboard verbs MUST NOT. It is the default because it is the only world that proves this
      gate's own gesture is a SECONDARY press rather than any press — which is the half a driver
      gets wrong silently.
  `--control menu-in-surface` SPAWNS `files --menu-in-surface`, the program's declared flag: the
      process draws its own popup into its surface and no `win_menu` reaches the kernel. The same
      four clauses, by a different mechanism — the architecture rather than the gesture.
  `--control esc-not-enter` ENDS THE RENAME WITH ESC INSTEAD OF ENTER. `commitRename` is never
      reached, so the old name stays: `renamed` and `persists` MUST fire alone.
  `--control insert-not-delete` PRESSES INSERT, WHICH `files` BINDS TO NOTHING, in place of Delete.
      `deleted` and `persists-gone` MUST fire alone. It is what tells "the Delete key removes the
      row" apart from "the row went away at about that time".
  `--control wipe` REMOVES THE OPFS VOLUME BETWEEN THE TWO BOOTS, reusing
      `bench/m19a-seed-firefox/wipe.html`: the second boot meets a fresh volume and the kernel seeds
      a new copy of the base over the reader's tree. `persists` and `persists-new` MUST fire and
      every pre-reload clause MUST stay green.

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

#: The two fixture entries, and each has one job. `a.txt` is renamed and `doomed.txt` is deleted, so
#: neither verb acts on the directory the menu creates — which is what makes the menu control and
#: the keyboard controls move disjoint subsets. Empty `touch`ed files: nothing here decodes a byte.
RENAME_FROM = "a.txt"
DOOMED = "doomed.txt"
#: What New folder calls what it makes. `NEW_FOLDER_STEM` in `src/bin/files.mjs`, and the one string
#: in this file that is a copy of one in the program — it cannot be imported into python, and the
#: clause is "a reader finds the folder Explorer would have made", so the label is the assertion.
NEW_FOLDER = "New folder"
#: A directory's Type cell (`kindOf`), and its Size cell. A directory's size is not a question this
#: list answers, so the cell is empty — and the Date cell is NOT, which is M19's proof that the
#: directory `stat` is paid. Asserting both is what makes `created` about a DIRECTORY.
DIR_KIND = "DIR"

#: (proof, kept). A control must move a NAMED subset; a clause in neither is UNSCOPED and the run
#: prints it as such rather than letting silence read as a claim.
MENU_PROOF = ("menu", "chosen", "created", "persists-new")
KEY_KEPT = ("desktop", "renamed", "deleted", "persists", "persists-gone")
CONTROLS = {
    "left-button": (MENU_PROOF, KEY_KEPT),
    "menu-in-surface": (MENU_PROOF, KEY_KEPT),
    "esc-not-enter": (("renamed", "persists"),
                      ("desktop", "menu", "chosen", "created", "deleted", "persists-new",
                       "persists-gone")),
    "insert-not-delete": (("deleted", "persists-gone"),
                          ("desktop", "menu", "chosen", "created", "renamed", "persists",
                           "persists-new")),
    "wipe": (("persists", "persists-new"),
             ("desktop", "menu", "chosen", "created", "renamed", "deleted", "persists-gone")),
}
TAGS = ("desktop", "menu", "chosen", "created", "renamed", "deleted",
        "persists", "persists-new", "persists-gone")

#: HOW MANY BACKSPACES CLEAR THE RENAME FIELD. The draft OPENS holding the existing name
#: (`beginRename`), so a rename to an unrelated name is a clear and then a type. Pressing into an
#: empty draft is a no-op — `src/bin/files.mjs` guards on `editing.draft.length > 0` — so
#: over-pressing is idempotent and this is a ceiling rather than a count to get right.
CLEAR_SLACK = 6

#: WHAT IS ON SCREEN, in one read. Every selector is one `src/wm/` builds; `INDEX` is the landing
#: page's own globals object, published before its module so a driver polling it cannot mistake a
#: syntax error for a slow boot (`www/index.html`).
STATE = """JSON.stringify((() => {
  const M = globalThis.INDEX || {}
  const mid = (el) => { const r = el.getBoundingClientRect()
    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) } }
  const orb = document.querySelector('[data-start]')
  const log = document.getElementById('log')
  const term = document.querySelectorAll('.terminal')
  const tr = term.length ? term[0].getBoundingClientRect() : null
  return {
    state: String(M.state || ''), phase: String(M.phase || ''), why: String(M.why || ''),
    dpr: devicePixelRatio, search: location.search,
    errors: (M.errors || []).map(String).slice(0, 4),
    preflight: document.documentElement.dataset.preflight || '',
    banner: (() => { const b = document.getElementById('driver-hint')
      return b ? (b.textContent || '').slice(0, 120) : '' })(),
    taskbar: Boolean(document.querySelector('[data-taskbar]')),
    orb: orb ? mid(orb) : null,
    mark: Boolean(window.__m20Mark),
    terminals: term.length,
    term: tr ? { x: Math.round(tr.left + 30), y: Math.round(tr.top + 20) } : null,
    icons: [...document.querySelectorAll('.desk-icon')].map((c) =>
      (c.querySelector('.desk-label') || {}).textContent || ''),
    seed: (() => { const s = M.seed || {}
      return { dest: s.dest || '', home: s.home || '', drifted: Boolean(s.drifted),
               ran: Boolean((s.seed || {}).ran), why: String(s.why || '') } })(),
    tail: log ? (log.textContent || '').trim().split('\\n').slice(-3) : [],
  }
})())"""

#: One terminal's screen, as text. A pty is the one surface in this system whose whole content is
#: characters, which is why it is also the one a command's output can be asserted out of.
SCREEN = "(document.querySelector('.terminal') || {}).textContent || ''"

#: The marker the reload has to destroy. Set on `window`, so it cannot survive a navigation and
#: cannot be confused with anything the page itself keeps.
MARK = "(() => { window.__m20Mark = 1; return 1 })()"

#: INSTALL THE READER, ONCE PER PAGE. Two halves, and neither is a second copy of anything:
#:
#:   - the TAP. A surfaced window's content is a canvas, and the only way to read its rows back is
#:     the batch that drew them. The landing page publishes no kernel handle — by design, it is the
#:     product — so the tap goes on `Surface.prototype.replay`, the one function every batch passes
#:     through. It DELEGATES, so the page renders exactly what it would have, and it is on the
#:     PROTOTYPE so a re-surface does not lose it. `bench/m19-details/firefox-details.py` is the
#:     precedent and the reason: a `fillText` tap reads the strings but not which run is which.
#:   - the ARITHMETIC. `FILES_METRICS` is imported rather than restated — `columnBoxes`, `rowTop`,
#:     `rowMid`, `viewBox` and `toSurface` are the program's own, which is the whole reason that
#:     object is exported (`CLAUDE.md`'s `FILES_METRICS` row). A page may import a program's module
#:     even though a process may not import the page's.
INSTALL = """(async () => {
  const abi = await import('/src/abi.mjs')
  const surf = await import('/src/wm/surface.mjs')
  const files = await import('/src/bin/files.mjs')
  const G = globalThis.__M20FF || (globalThis.__M20FF = { last: new WeakMap() })
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
  return JSON.stringify({ ok: true, rowH: G.M.ROW_H, headH: G.M.HEAD_H,
                          cols: G.M.COLUMNS.map((c) => c.key), context: abi.WITEM_CONTEXT })
})()"""

#: WHAT THE `files` WINDOW HAS DRAWN, where to aim inside it, and what the host has recorded about
#: its menus. Nothing below compares a colour against a literal: the inks of `src/bin/files.mjs` are
#: module-private, so every discriminator here is STRUCTURAL.
#:
#:   A ROW NAME is a run whose x is the `name` column's own `textX` and which is not bold. The three
#:   metadata cells hang off their columns' RIGHT edges and the four header labels are bold, so
#:   matching the one text origin `columnBoxes` publishes for names cannot pick up any of them.
#:
#:   `emptyAt` IS THE ONLY PRESS THAT RAISES THE EMPTY-SPACE MENU, and both of its bounds are the
#:   program's own: `rowTop(n)` is past the last row and `viewBox` is the rectangle the hit test is
#:   bounded by (`inViewport`), so a point between them finds no row AND is inside the viewport.
#:   `null` when there is none, with the two numbers, because that is a run that cannot be trusted
#:   rather than a clause that failed.
READ = """JSON.stringify((() => {
  const G = globalThis.__M20FF
  if (!G || !G.abi) return { error: 'the reader was never installed' }
  const host = (globalThis.INDEX || {}).host
  if (!host) return { error: 'the landing page published no window host' }
  let entry = null
  for (const e of host.frames.values()) {
    if (e.surface && String(e.win.titleText || '').startsWith('files')) { entry = e; break }
  }
  if (!entry) return { error: 'no `files` window with a surface' }
  const bytes = G.last.get(entry.surface)
  if (!bytes || !bytes.length) {
    return { error: 'the `files` surface has replayed no batch since the reader was installed' }
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
  const rows = names.map((n) => {
    const cells = {}
    for (const c of cols) {
      if (c.key === 'name') continue
      const at = M.toSurface(c.textX, scale)
      const hit = runs.find((t) => t.x === at && Math.abs(t.y - n.y) <= 1)
      cells[c.key] = hit ? hit.text : ''
    }
    return { name: n.text, cells }
  })

  const at = (x, y) => ({ x: Math.round(r.left + x), y: Math.round(r.top + y) })
  // EMPTY SPACE, LOW IN THE VIEWPORT. `MENU_INSET` is 6: far enough inside the bottom edge that the
  // press is in the viewport, low enough that a three-row popup's bottom is below the client area.
  const ext = entry.surface.extent()
  const box = M.viewBox(wCss, ext.cssH)
  const afterLast = M.rowTop(rows.length, 0)
  const emptyY = box.y + box.h - 6
  const bodyR = entry.win.bodyEl.getBoundingClientRect()
  const popup = document.querySelector('[data-popup]')
  const pr = popup && !popup.hidden ? popup.getBoundingClientRect() : null
  return {
    title: String(entry.win.titleText || ''), id: entry.id, scale, wCss,
    cssH: r.height, clientH: ext.cssH, batches: entry.surface.batches,
    names: rows.map((x) => x.name),
    cells: rows.map((x) => x.cells),
    place: (runs.find((t) => /^\\d+ items?$/.test(t.text)
                            || /^\\d+-\\d+ of \\d+$/.test(t.text)) || {}).text || '',
    rows: rows.map((x, i) => ({ name: x.name, ...at(M.NAME_X + 10, M.rowMid(i, 0)) })),
    // The caption, for the double-click that maximizes: a Windows reader's own gesture, and the
    // only route to a client area with empty paper in it (this file's header).
    bar: (() => { const b = entry.win.barEl.getBoundingClientRect()
      return { x: Math.round(b.left + 60), y: Math.round(b.top + b.height / 2) } })(),
    empty: afterLast <= emptyY ? at(wCss / 2, emptyY) : null,
    emptyWhy: { afterLast, emptyY, rows: rows.length, box },
    // HOW FAR THE POPUP REACHES PAST THE CLIENT AREA. Printed and NOT scored: it is
    // `www/m20.html`'s `past` proof, asserted there against a budget this file has no business
    // restating. Here it is the transcript's record that the popup is the shell's and not a
    // drawing inside a surface that `overflow: hidden` would have cut.
    pastBody: pr ? Math.round(pr.bottom - bodyR.bottom) : null,
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
    host: {
      menus: host.stats.menus | 0, rows: host.stats.menuRows | 0,
      choices: host.stats.menuChoices | 0, dismisses: host.stats.menuDismisses | 0,
      unrendered: host.stats.menusUnrendered | 0,
      rightPresses: host.stats.rightPresses | 0, contextmenus: host.stats.contextmenus | 0,
      lastMenu: host.lastMenu || null,
      lastReport: host.lastMenuReport || null,
      lastContext: host.lastContextMenu || null,
    },
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
  if (pop) return { tag: String(el.tagName || ''), hits: 'the shell popup' }
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


def read(ff) -> dict:
    got = ff.evaluate(READ)
    return got if isinstance(got, dict) else {"error": "the reader returned %r" % (got,)}


def under(ff, point: dict) -> dict:
    got = ff.evaluate(UNDER % (int(point["x"]), int(point["y"])))
    return got if isinstance(got, dict) else {}


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
    print("    $ %-52s | %s" % (cmd, said[len(" ".join(cmd.split())):].strip()[:140]))
    return out


def focus_terminal(ff, st: dict):
    """Put the caret in the desktop's pty, and PROVE the keystrokes are landing in it.

    THE PROBE IS THE POINT. A harness must fail when it is not reading what it was pointed at
    (`CLAUDE.md` §Harness honesty), and a pty that has the caret is indistinguishable from one that
    does not until something is typed into it. The count is read with the point because `SCREEN`
    reads `querySelector`, which is the FIRST terminal: a second one would take the focus and every
    keystroke with it while the assertions went on reading the first (`firefox-session.py` reports
    that as a run it could not trust).
    """
    if st.get("terminals") != 1 or not st.get("term"):
        return "%s terminal(s) on screen; `SCREEN` reads the first and the keys go to the " \
               "focused one, so this run could not be trusted" % st.get("terminals")
    ff.click(st["term"]["x"], st["term"]["y"])
    time.sleep(0.3)
    probe = "m20-probe-%s" % secrets.token_hex(2)
    if probe not in at_prompt(ff, "echo %s" % probe):
        return "a real keystroke did not reach the pty: `echo %s` printed nothing back, so the " \
               "caret is not in the terminal this run reads" % probe
    return ""


def open_files(ff, directory: str, flags: str) -> dict:
    """Spawn `files` at a real prompt, maximize its window, and return what it drew.

    THE MAXIMIZE IS A FIXTURE. See this file's header: a content-fitted window has no empty paper
    for the only press that raises the empty-space menu.

    IT RETURNS THE READER'S OWN `error` RATHER THAN RAISING OR SCORING. A `files` that opened no
    window is sometimes the defect under test and sometimes a broken run, and only the caller knows
    which: after the `wipe` control the directory itself is gone, and `files` on a path that does
    not exist correctly opens nothing.
    """
    ff.type_keys("files%s %s &\n" % (flags, directory))
    time.sleep(4.0)
    state = read(ff)
    if state.get("error"):
        return state
    ff.dblclick(state["bar"]["x"], state["bar"]["y"])
    time.sleep(2.0)
    return read(ff)


def aim_row(state: dict, name: str):
    for row in state.get("rows") or []:
        if row.get("name") == name:
            return row
    return None


def aim_popup(state: dict, label: str):
    hits = [a for a in ((state.get("menu") or {}).get("aims") or []) if a.get("label") == label]
    return hits[0] if len(hits) == 1 else None


def cells_of(state: dict, name: str) -> dict:
    names = state.get("names") or []
    if name not in names:
        return {}
    return (state.get("cells") or [{}])[names.index(name)]


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
    ap.add_argument("--shot", default=str(HERE / "firefox-verbs.png"))
    ap.add_argument("--control", choices=sorted(CONTROLS), default="left-button",
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
    #: THE FIVE THINGS A CONTROL MAY CHANGE, and each world changes exactly one of them.
    button = 0 if on and args.control == "left-button" else 2
    flags = " --menu-in-surface" if on and args.control == "menu-in-surface" else ""
    commit_key = "Escape" if on and args.control == "esc-not-enter" else "Enter"
    kill_key = "Insert" if on and args.control == "insert-not-delete" else "Delete"
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
    # report a defect that is its own (`firefox-session.py`).
    wipe_url = url.rsplit("/www/", 1)[0] + "/bench/m19a-seed-firefox/wipe.html"

    stamp = secrets.token_hex(3)
    leaf = "m20ff-%s" % stamp
    # THE NEW NAME IS A NONCE AND IT IS NEVER TYPED AFTER THE RELOAD, so finding it in the second
    # boot's `ls` or in the second `files` window's rows cannot be finding something this run put
    # on the screen itself (`firefox-session.py`'s rule for an assertion about persistence).
    renamed_to = "kept-%s.txt" % secrets.token_hex(4)
    print("url      %s" % url)
    print("fixture  %s holding %s and %s; the rename lands on %s"
          % (leaf, RENAME_FROM, DOOMED, renamed_to))
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

            # ---- THE SESSION'S WRITABLE TREE, READ AND NOT TYPED --------------------------------
            seed = st.get("seed") or {}
            print("seed     %s" % seed)
            if not seed.get("dest") or seed.get("drifted"):
                print("\nthe session's writable tree could not be located (dest=%r drifted=%s "
                      "why=%r), so there is nowhere a verb could write and nothing below could be "
                      "about persistence."
                      % (seed.get("dest"), seed.get("drifted"), seed.get("why")))
                ff.screenshot(args.shot)
                return 1
            directory = "%s/%s" % (seed["dest"], leaf)

            got = ff.evaluate(INSTALL)
            print("reader   %s" % got)
            if not isinstance(got, dict) or not got.get("ok"):
                print("\nthe display-list reader could not be installed, so no row below could be "
                      "read back out of what was drawn: %s" % (got,))
                return 1
            context_bit = int(got.get("context") or 0)

            # ---- THE FIXTURE, TYPED AT A REAL PROMPT -------------------------------------------
            why = focus_terminal(ff, st)
            if why:
                print("\n%s" % why)
                ff.screenshot(args.shot)
                return 1
            at_prompt(ff, "rm -r -f %s" % directory)
            at_prompt(ff, "mkdir -p %s" % directory)
            at_prompt(ff, "touch %s/%s %s/%s" % (directory, RENAME_FROM, directory, DOOMED))
            listed = at_prompt(ff, "ls %s" % directory)
            if RENAME_FROM not in listed or DOOMED not in listed:
                print("\nthe fixture did not take: `ls %s` printed %r, so every clause below would "
                      "be about a different directory."
                      % (directory, " ".join(listed.split())[:200]))
                ff.screenshot(args.shot)
                return 1

            state = open_files(ff, directory, flags)
            if state.get("error"):
                print("\nthe `files` window could not be read, so clauses 2-9 were not run: %s"
                      % state["error"])
                ff.screenshot(args.shot)
                return 1
            print("files    title=%r scale=%s wCss=%s clientH=%s batches=%s place=%r"
                  % (state["title"], state["scale"], round(state["wCss"], 2), state["clientH"],
                     state["batches"], state["place"]))
            print("rows     %s" % state["names"])
            if sorted(state["names"]) != sorted((RENAME_FROM, DOOMED)):
                print("\nthe list is not the fixture this gate was written against: %s, wanted %s"
                      % (state["names"], sorted((RENAME_FROM, DOOMED))))
                ff.screenshot(args.shot)
                return 1
            if not str(state["place"]).endswith("items"):
                print("\nthe list is SCROLLED (%r), so `rowMid(i, 0)` is not where row i is and "
                      "every aim point below would miss." % state["place"])
                ff.screenshot(args.shot)
                return 1
            if not state.get("empty"):
                print("\nthere is no empty space inside the clipped viewport: %s. The caption "
                      "double-click did not maximize the window, so the only press that raises the "
                      "empty-space menu is unreachable and this run could not be trusted."
                      % (state.get("emptyWhy"),))
                ff.screenshot(args.shot)
                return 1
            print("empty    aim %s,%s  (%s)"
                  % (state["empty"]["x"], state["empty"]["y"], state["emptyWhy"]))

            # ---- 2. A REAL RIGHT-CLICK RAISES THIS SYSTEM'S MENU -------------------------------
            before = state["host"]["menus"]
            hit = under(ff, state["empty"])
            print("aim      hit test finds %r" % hit.get("hits"))
            if "files" not in str(hit.get("hits")):
                print("\nthe empty-space point is covered by %r, so a press there would go to "
                      "another window." % hit.get("hits"))
                ff.screenshot(args.shot)
                return 1
            ff.click(state["empty"]["x"], state["empty"]["y"], button=button)
            time.sleep(pause)
            opened = read(ff)
            menu = opened.get("menu") or {}
            hostm = opened.get("host") or {}
            print("menu     open=%s kind=%r labels=%s pastBody=%s"
                  % (menu.get("open"), menu.get("kind"), menu.get("labels"),
                     opened.get("pastBody")))
            print("host     %s" % hostm)
            ctx = hostm.get("lastContext") or {}
            if not menu.get("open") or menu.get("kind") != "context":
                bad.append(("menu", "a button-%d press on empty space opened no context popup "
                                    "(open=%s kind=%r). `win_menu`s the kernel asked the page to "
                                    "draw: %d, up from %d"
                            % (button, menu.get("open"), menu.get("kind"),
                               hostm.get("menus"), before)))
            elif menu.get("labels") != [NEW_FOLDER, "Paste"]:
                bad.append(("menu", "the popup's rows are %s, not the program's own empty-space "
                                    "menu [%r, 'Paste'] — so what opened is not the menu `files` "
                                    "published" % (menu.get("labels"), NEW_FOLDER)))
            elif hostm.get("menus", 0) <= before:
                bad.append(("menu", "a popup is on screen but no `win_menu` reached the kernel: "
                                    "host.stats.menus is still %d. A menu the page drew by itself "
                                    "is the division constraint 226 forbids"
                            % hostm.get("menus")))
            elif not ctx.get("defaultPrevented"):
                bad.append(("menu", "this system's menu opened AND the browser's own was not "
                                    "refused: lastContextMenu=%s. A foreign menu over pixels a "
                                    "process drew is the breach M16/R8 found (constraint 283's "
                                    "neighbour)" % (ctx,)))
            elif ctx.get("button") != 2 or not ctx.get("trusted"):
                bad.append(("menu", "the press that raised it was not a trusted secondary one: "
                                    "lastContextMenu=%s" % (ctx,)))
            else:
                good.append("a real right-click on empty space raised THIS system's menu %s, the "
                            "kernel counted the `win_menu`, and the browser's own menu was refused "
                            "(button %s, isTrusted %s)"
                            % (menu["labels"], ctx.get("button"), ctx.get("trusted")))

            # ---- 3. A CLICK ON `New folder` REPORTS THAT ROW ----------------------------------
            pick = aim_popup(opened, NEW_FOLDER)
            if not pick:
                bad.append(("chosen", "the popup has no single row labelled %r, so there is "
                                      "nothing to click: %s" % (NEW_FOLDER, menu.get("labels"))))
                after = opened
            else:
                print("pick     %r index=%s disabled=%s at %s,%s"
                      % (pick["label"], pick["index"], pick["disabled"], pick["x"], pick["y"]))
                choices = hostm.get("choices", 0)
                ff.click(pick["x"], pick["y"])
                time.sleep(2.0)
                after = read(ff)
                rep = (after.get("host") or {}).get("lastReport") or {}
                print("report   %s choices=%s"
                      % (rep, (after.get("host") or {}).get("choices")))
                if (after.get("host") or {}).get("choices", 0) <= choices:
                    bad.append(("chosen", "the %r row was clicked and no choice was reported: "
                                          "host.stats.menuChoices is still %s"
                                % (NEW_FOLDER, (after.get("host") or {}).get("choices"))))
                elif rep.get("index") != pick["index"]:
                    bad.append(("chosen", "the %r row publishes index %s and the report named %s — "
                                          "a reader's pick running another row's verb"
                                % (NEW_FOLDER, pick["index"], rep.get("index"))))
                elif not (int(rep.get("where") or 0) & context_bit):
                    bad.append(("chosen", "the report carries where=%s, without WITEM_CONTEXT "
                                          "(%#x) — so it indexes the window's PUBLISHED items and "
                                          "not the open menu's rows, which are two lists in the "
                                          "kernel" % (rep.get("where"), context_bit)))
                else:
                    good.append("a real click on the %r row reported row %s with WITEM_CONTEXT set"
                                % (NEW_FOLDER, rep["index"]))

            # ---- 4. AND A DIRECTORY APPEARS IN THE PROGRAM'S OWN ROWS -------------------------
            print("rows     %s" % after.get("names"))
            print("cells    %s" % after.get("cells"))
            cells = cells_of(after, NEW_FOLDER)
            if NEW_FOLDER not in (after.get("names") or []):
                bad.append(("created", "%r is not in the program's own rows after the pick: %s. "
                                       "`mkdir` never ran, or the list was not re-read"
                            % (NEW_FOLDER, after.get("names"))))
            elif cells.get("type") != DIR_KIND or cells.get("size") != "":
                bad.append(("created", "%r is in the rows but its cells are %s — a directory's "
                                       "Type cell is %r and its Size cell is empty, so what was "
                                       "created "
                                       "is not a folder" % (NEW_FOLDER, cells, DIR_KIND)))
            elif not cells.get("date"):
                bad.append(("created", "%r has an empty Date cell (%s), so the directory `lstat` "
                                       "was not paid and the row describes nothing"
                            % (NEW_FOLDER, cells)))
            else:
                good.append("a directory %r is in the list, with Type %r, an empty Size cell and "
                            "Date %r" % (NEW_FOLDER, cells["type"], cells["date"]))

            # ---- 5. F2 ON A ROW RENAMES IT ---------------------------------------------------
            time.sleep(pause)
            target = aim_row(after, RENAME_FROM)
            if not target:
                bad.append(("renamed", "the row %r is not drawn, so there is nothing to rename: %s"
                            % (RENAME_FROM, after.get("names"))))
                renamed = after
            else:
                hit = under(ff, target)
                if "files" not in str(hit.get("hits")):
                    print("\nthe row %r is covered by %r, so a press on it would go to another "
                          "window." % (RENAME_FROM, hit.get("hits")))
                    ff.screenshot(args.shot)
                    return 1
                # THE CLICK IS WHAT AIMS THE KEYBOARD as well as what focuses the row: `pointerdown`
                # calls `el.focus()` on the surface (`src/wm/winhost.mjs`), and the popup's own
                # button took the focus away when it was clicked.
                ff.click(target["x"], target["y"])
                time.sleep(pause)
                ff.press("F2")
                time.sleep(0.6)
                ff.press("Backspace", times=len(RENAME_FROM) + CLEAR_SLACK)
                ff.type_keys(renamed_to)
                time.sleep(0.4)
                ff.press(commit_key)
                time.sleep(1.6)
                renamed = read(ff)
                print("rename   %-9s -> %s  (committed with %s)"
                      % (RENAME_FROM, renamed.get("names"), commit_key))
                names = renamed.get("names") or []
                if renamed_to not in names:
                    bad.append(("renamed", "after F2, %d Backspace(s), %r and %s the list is %s — "
                                           "the new name is not in it"
                                % (len(RENAME_FROM) + CLEAR_SLACK, renamed_to, commit_key, names)))
                elif RENAME_FROM in names:
                    bad.append(("renamed", "the list holds BOTH %r and %r: %s. That is a copy and "
                                           "not a rename — the inode did not move"
                                % (RENAME_FROM, renamed_to, names)))
                else:
                    good.append("F2 on %r, the field cleared and %r typed, renamed it: the list is "
                                "%s" % (RENAME_FROM, renamed_to, names))

            # ---- 6. DELETE ON A ROW REMOVES IT -----------------------------------------------
            time.sleep(pause)
            doomed = aim_row(renamed, DOOMED)
            if not doomed:
                bad.append(("deleted", "the row %r is not drawn, so there is nothing to delete: %s"
                            % (DOOMED, renamed.get("names"))))
                gone = renamed
            else:
                ff.click(doomed["x"], doomed["y"])
                time.sleep(pause)
                ff.press(kill_key)
                time.sleep(1.6)
                gone = read(ff)
                print("delete   %-9s -> %s  (pressed %s)"
                      % (DOOMED, gone.get("names"), kill_key))
                if DOOMED in (gone.get("names") or []):
                    bad.append(("deleted", "%r was clicked and %s pressed and the row is still "
                                           "there: %s" % (DOOMED, kill_key, gone.get("names"))))
                else:
                    good.append("a click on %r and the Delete key removed it: the list is %s"
                                % (DOOMED, gone.get("names")))

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
            # what says the pty below is a new pty and clause 7 is not reading clause 4's output.
            if st2.get("mark"):
                print("\n`window.__m20Mark` survived, so the page never navigated and every clause "
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

            # ---- 7+8+9. THE READER'S THREE CHANGES, AFTER THE RELOAD -------------------------
            #
            # TWO INDEPENDENT READINGS of one directory: `ls` at a new prompt, and a NEW `files`
            # window's own display list. Either alone could be right while the other is wrong, and
            # a reader sees the second.
            again = at_prompt(ff, "ls %s" % directory)
            # ENOENT IS THE DIRECTORY ITSELF BEING GONE, which is what the `wipe` control produces:
            # the base was copied over the reader's tree, so the folder they made is not there to
            # open. `files` on a path that does not exist correctly opens no window, so the second
            # reading is UNAVAILABLE rather than failing — and the distinction matters, because a
            # missing window for any OTHER reason is a run that cannot be trusted.
            vanished = "ENOENT" in again
            back = open_files(ff, directory, flags)
            rows_after = None
            if back.get("error"):
                if not vanished:
                    print("\nno `files` window opened after the reload and `ls %s` did not report "
                          "ENOENT either (%r), so the second reading is missing for a reason this "
                          "run cannot name: %s"
                          % (directory, " ".join(again.split())[:160], back["error"]))
                    ff.screenshot(args.shot)
                    return 1
                print("rows     unavailable: %s is gone, so `files` opened no window (%s). Clauses "
                      "7-9 are scored on `ls` alone, and that is the directory having been "
                      "REPLACED rather than a reading this gate could not take"
                      % (directory, back["error"]))
            else:
                rows_after = back.get("names") or []
                print("rows     %s" % rows_after)
            for tag, name, what in (("persists", renamed_to, "the renamed file"),
                                    ("persists-new", NEW_FOLDER, "the directory the MENU created")):
                in_ls = name in again
                in_rows = rows_after is None or name in rows_after
                if in_ls and in_rows:
                    good.append("after the reload %s (%r) is in `ls`%s"
                                % (what, name,
                                   "" if rows_after is None
                                   else " AND in the file manager's own rows"))
                else:
                    # THE TWO READINGS DISAGREEING IS ITS OWN SENTENCE, because it is a different
                    # defect from both being empty: one of `ls` and the list is wrong, and a reader
                    # is being shown a directory that is not what the shell says it is.
                    both = rows_after is not None and in_ls != in_rows
                    bad.append((tag, "after the reload %s (%r) is %s: `ls` %s it, the rows are %s. "
                                     "The name was never typed on this page, so the only place it "
                                     "could have come from is the volume"
                                % (what, name,
                                   "in one reading and not the other" if both else "gone",
                                   "lists" if in_ls else "does not list",
                                   "unreadable" if rows_after is None else rows_after)))
            if DOOMED in again or (rows_after is not None and DOOMED in rows_after):
                bad.append(("persists-gone", "after the reload %r is BACK: `ls` %s it and the rows "
                                             "are %s. A delete that did not survive is a file a "
                                             "reader removed and found again"
                            % (DOOMED, "lists" if DOOMED in again else "does not list",
                               "unreadable" if rows_after is None else rows_after)))
            else:
                good.append("and %r, which was deleted, is absent from the same listing(s) the two "
                            "clauses above were read from — which is the only thing that keeps an "
                            "ABSENCE honest: a volume that lost everything fails those two in the "
                            "very same read" % DOOMED)

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
    print("\na reader can right-click and actually do things, and they stick: a real secondary "
          "press raises THIS system's menu, a click on New folder makes a directory, F2 renames a "
          "row and Delete removes one — and after a reload all three are still what the reader "
          "left, in FIREFOX, on the landing page, with real trusted input")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
