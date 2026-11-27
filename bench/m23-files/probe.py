#!/usr/bin/env python3
"""M23's owed measurement for `src/bin/files.mjs`: the Explorer surface no registered check reaches.

    python3 bench/m23-files/probe.py                     # the suite's own world: headless, dpr 2
    python3 bench/m23-files/probe.py --dpr 1             # the ratio Firefox renders at here
    python3 bench/m23-files/probe.py --headed            # ...in a real window
    python3 bench/m23-files/probe.py --no-thumbs         # CONTROL: the program decodes nothing
    python3 bench/m23-files/probe.py --thumb-no-fallback # CONTROL: a refused decode draws NOTHING
    python3 bench/m23-files/probe.py --prove-failure     # every expectation inverted; MUST report red

**WHY A BENCH AND NOT A REGISTERED CHECK.** The six checks over this program — m10 (37), m17 (35),
m18 (38), m19 (60), m20 (61), m21 (72) — all drive the DETAILS view, which is the mode `files`
opens in. Four of M23's five R-numbers are unreachable from there BY CONSTRUCTION:

  * R26's thumbnails are scoped by the PRD to "Medium icons and larger", so the Details view draws
    the type icon and emits no `DL_BLIT` at all.
  * R27's other six modes have no registered driver.
  * R28's address strip is a band the registered pages deliberately never press: `VIEW_TOP / 2` is
    the one point they aim above the viewport and it is inside the COLUMN band.
  * R31's search field is reached by Ctrl+F or by a press in that strip.

This probe is therefore the INPUT to M23's registered check and not its gate, which is the shape
`bench/m16-resize/probe.py` carries and says so in its own header.

**THE FOUR THINGS IT MEASURES, each with its own failure.**

  1. A `DL_BLIT` CROSSED THE SYSCALL CHANNEL AND BECAME PIXELS. Three readings, because they are
     three different facts: the op is in the batch (the program sent it), `surface.blits` rose (the
     renderer drew it), and `surface.blitsUnbacked` is ZERO (the payload reached the renderer). The
     third is the one that separates "the payload channel dropped it" from "the program drew
     nothing", which are the same picture — `src/wm/surface.mjs` says so where the counter is
     declared. And then the PIXELS: `/usr/share/logo.rgba` is amber at its corner and blue inside,
     so a sample two pixels inside the op's own origin says the bytes that arrived are the file's.

  2. THE VIEW MODE IS REACHABLE BY A REAL GESTURE. Both routes: a driven Ctrl+wheel (PRD A1's
     slider) and a driven press on the view button. Neither can be a keyboard chord —
     `bytesForKey` answers null for every Ctrl chord that is not a C0 letter, so Windows' own
     Ctrl+Shift+1..7 never reaches a program.

  3. A BREADCRUMB SEGMENT NAVIGATES. The press is aimed with `FILES_METRICS.crumbSegments`, which
     is the rectangle the program drew the label inside, and the assertion is that the program's
     own `dir` became the path THAT SEGMENT NAMED — not a path this probe worked out.

  4. SEARCH NARROWS AND SAYS WHAT IT COST. A driven Ctrl+F, real typed keys, and then the program's
     own `matched` of `listed`; Enter runs the bounded walk and `searchCost` is what it paid.

**IT REFUSES TO CONCLUDE FROM A RATIO IT DID NOT GET** (constraint 264), and from a run in which no
gesture was delivered: a thumbnail clause that passed because the window never repainted is the
harness dishonesty CLAUDE.md names.
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

import cdp     # noqa: E402
import serve   # noqa: E402

DOC = "/bench/m23-files/page.html"

#: THE DIRECTORY WITH THE IMAGES IN IT, and it is not the one a window opens on. `src/kernel/seed.mjs`
#: makes `/Users/Default` a writable copy of the whole of `/usr`, so the session tree's top level is
#: four DIRECTORIES — `bin`, `include`, `lib`, `share` — and nothing in it can have a thumbnail.
#: `/usr/share`'s copy is where `logo.png` and `logo.rgba` live, which are the two files in this
#: repository that a decode can be asserted against (`bench/m23-blit/` measured the same pair).
#: MEASURED, not assumed: the first run of this probe reported `blits: 0` over a listing whose text
#: runs were `bin include lib share`.
SUBJECT_DIR = "/Users/Default/share"

#: What a headed run needs to produce frames and events at all. Chrome throttles a window it
#: believes is occluded, and a CDP-launched window on macOS is not foregrounded.
HEADED_FLAGS = (
    "--window-size=1440,900",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
)

#: Chrome's own modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. The protocol's number and not
#: this project's; `scripts/cdp.py` records the same table beside its `CTRL = 2`.
CTRL = 2

#: `/usr/share/logo.rgba`'s two colours as `getImageData` reports them — restated from
#: `www/m10.html`, which restates them from the file. A corner pixel is amber and an interior one is
#: blue, which is what makes a sampled thumbnail a reading of THAT FILE'S bytes rather than of some
#: bytes. The format is `pixelColor`'s (constraint 224).
AMBER = "rgba(216,209,74,255)"
BLUE = "rgba(74,155,216,255)"

#: `/usr/share/logo.png` and `/usr/share/logo.rgba` are both 16x16. Read off the files, not assumed:
#: `node -e "const b=require('fs').readFileSync('src/share/logo.rgba'); console.log(b.readUInt32LE(0))"`
#: prints 16, and `logo.rgba` is the same image as `logo.png` by `src/share/readme.txt`.
LOGO_PX = 16

#: What the page publishes about one `files` window, plus the two geometry facts a driver needs to
#: aim: the canvas's own client rect and the measured scale.
STATE = """JSON.stringify((() => {
  const M = globalThis.M23F || {}
  const h = M.host
  const e = M.entry
  if (!h || !e || !e.surface) {
    return { phase: String(M.phase || ''), state: String(M.state || ''),
             why: String(M.why || ''), ready: false }
  }
  const r = e.surface.el.getBoundingClientRect()
  return {
    phase: String(M.phase || ''), state: String(M.state || ''), why: String(M.why || ''),
    ready: true,
    dpr: window.devicePixelRatio || 1,
    win: e.id,
    title: e.win.titleText,
    rect: { x: Math.round(r.left), y: Math.round(r.top),
            w: Math.round(r.width), h: Math.round(r.height) },
    store: { w: e.surface.w, h: e.surface.h },
    client: { w: e.win.bodyEl.clientWidth, h: e.win.bodyEl.clientHeight },
    scale: e.surface.w / e.surface.extent().cssW,
    surface: e.surface.report(),
  }
})())"""


def read(page, expr):
    raw = page.evaluate(expr)
    return json.loads(raw) if raw else None


def wait_phase(page, want, timeout=90.0, step=0.25):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = read(page, STATE)
        if last and last.get("phase") == want:
            return last
        if last and last.get("state") in ("error", "aborted"):
            return last
        time.sleep(step)
    return last


def click(page, at, *, modifiers=0, clicks=1):
    """A real press and release at a VIEWPORT point."""
    page.call("Input.dispatchMouseEvent", type="mousePressed", x=at["x"], y=at["y"],
              button="left", buttons=1, clickCount=clicks, modifiers=modifiers)
    page.call("Input.dispatchMouseEvent", type="mouseReleased", x=at["x"], y=at["y"],
              button="left", buttons=0, clickCount=clicks, modifiers=modifiers)


def wheel(page, at, dy, *, modifiers=0, times=1):
    """A real wheel. `deltaY` IS DEVICE px over CDP and the page reports `deltaY / dpr`
    (constraint 297), which is why nothing here asserts a distance from a dispatched constant —
    the view slider steps ONCE per record whatever the delta, which is the only property this
    probe needs from it."""
    for _ in range(times):
        page.call("Input.dispatchMouseEvent", type="mouseWheel", x=at["x"], y=at["y"],
                  deltaX=0, deltaY=dy, button="none", buttons=0, modifiers=modifiers)


def account(page):
    """The program's account, once it has exited. The page reads it with `resultOf`."""
    return read(page, "JSON.stringify((globalThis.M23F || {}).row || null)")


def crumb_points(page, state):
    """Where every breadcrumb segment is, in VIEWPORT coordinates — read out of
    `FILES_METRICS.crumbSegments`, which is the rectangle the program drew the label inside.

    NO SCALE IS INVOLVED, which is `FILES_METRICS`'s own docstring: "a driver working in page
    coordinates needs no scale at all, because the canvas's CSS box IS the client area these are
    measured in". So the point is `rect.left + xCss`, and that is the whole conversion."""
    raw = page.evaluate("""JSON.stringify((() => {
      const M = globalThis.M23F || {}
      const e = M.entry
      if (!e || !e.surface) return []
      const r = e.surface.el.getBoundingClientRect()
      const F = M.metrics
      const segs = F.crumbSegments(M.dir || '', e.win.bodyEl.clientWidth)
      return segs.map((s) => ({
        label: s.label, path: s.path,
        x: Math.round(r.left + s.x + s.w / 2), y: Math.round(r.top + F.CRUMB_MID),
      }))
    })())""")
    return json.loads(raw) if raw else []


def one_run(page, base: str, dpr: float, argv: str, control: str) -> dict:
    page.emulate_device(width=1280, height=900, scale_factor=dpr, mobile=False)
    url = base + DOC + "?dir=" + SUBJECT_DIR + ("&argv=" + argv.replace(" ", "%20")
                                                            if argv else "")
    page.navigate(url, timeout=60)
    live = wait_phase(page, "live")
    out: dict = {"askedDpr": dpr, "argv": argv, "control": control}
    if not live or not live.get("ready"):
        out["ok"] = False
        out["why"] = "the page never reached phase 'live': %s" % json.dumps(live)[:400]
        return out
    out["ok"] = True
    out["reportedDpr"] = live["dpr"]
    out["ratioApplied"] = abs(live["dpr"] - dpr) < 1e-6
    out["before"] = live

    rect = live["rect"]
    centre = {"x": rect["x"] + rect["w"] // 2, "y": rect["y"] + rect["h"] // 2}

    # ---- 1. THE BLIT AND ITS PIXELS --------------------------------------------------------
    out["blitAtStart"] = read(page, """JSON.stringify((() => {
      const s = (globalThis.M23F.entry || {}).surface
      const r = s ? s.report() : {}
      return { blits: r.blits | 0, unbacked: r.blitsUnbacked | 0, ops: r.ops | 0 }
    })())""")
    # THE PAGE'S OWN READING, taken at phase 'read' before any gesture: the ops it decoded, the
    # blit counters off the renderer and the pixels it sampled at each op's own origin. Read here
    # rather than recomputed, because the page has the batch and this process does not.
    out["seenAtStart"] = read(page, "JSON.stringify((globalThis.M23F || {}).seen || null)")

    # ---- 2. THE VIEW MODE, BY TWO REAL GESTURES --------------------------------------------
    views = []
    before = read(page, "JSON.stringify((globalThis.M23F.entry || {}).win.titleText || '')")
    wheel(page, centre, 120, modifiers=CTRL, times=1)
    time.sleep(0.45)
    views.append({"by": "ctrl-wheel-down", "view": live_view(page)})
    wheel(page, centre, -120, modifiers=CTRL, times=1)
    time.sleep(0.45)
    views.append({"by": "ctrl-wheel-up", "view": live_view(page)})
    btn = read(page, """JSON.stringify((() => {
      const M = globalThis.M23F
      const e = M.entry
      const r = e.surface.el.getBoundingClientRect()
      const F = M.metrics
      return { x: Math.round(r.left + e.win.bodyEl.clientWidth - F.VIEWBTN_W / 2),
               y: Math.round(r.top + F.CRUMB_MID) }
    })())""")
    click(page, btn)
    time.sleep(0.45)
    views.append({"by": "view-button", "view": live_view(page), "at": btn})
    out["views"] = views
    out["titleBefore"] = before

    # ---- 3. A BREADCRUMB SEGMENT ------------------------------------------------------------
    segs = crumb_points(page, live)
    out["crumbs"] = segs
    out["crumbNav"] = None
    if len(segs) >= 2:
        want = segs[-2]
        click(page, {"x": want["x"], "y": want["y"]})
        time.sleep(0.6)
        got = read(page, "JSON.stringify((globalThis.M23F.entry || {}).win.titleText || '')")
        out["crumbNav"] = {"pressed": want["label"], "wanted": want["path"], "title": got,
                           "at": {"x": want["x"], "y": want["y"]}}

    # ---- 4. SEARCH --------------------------------------------------------------------------
    page.call("Input.dispatchMouseEvent", type="mouseMoved", x=centre["x"], y=centre["y"],
              button="none", buttons=0)
    click(page, centre)
    page.press_ctrl("f")
    time.sleep(0.3)
    out["stripAfterCtrlF"] = read(page, """JSON.stringify((() => {
      const M = globalThis.M23F
      return { phase: String(M.phase || '') }
    })())""")
    page.type_keys("o")
    time.sleep(0.5)
    out["afterTyping"] = read(page, """JSON.stringify((() => {
      const s = (globalThis.M23F.entry || {}).surface
      return { ops: s ? s.ops : 0 }
    })())""")
    page.press("Enter")
    time.sleep(1.2)
    out["afterWalk"] = read(page, """JSON.stringify((() => {
      const s = (globalThis.M23F.entry || {}).surface
      return { ops: s ? s.ops : 0, title: (globalThis.M23F.entry || {}).win.titleText }
    })())""")
    # THE FIELD IS CLOSED BEFORE THE QUIT, and that is a fact about the program rather than
    # housekeeping: an open search field TAKES THE WHOLE KEYBOARD (`src/bin/files.mjs` says so
    # where it is read), so a `q` sent with the field open is a `q` TYPED INTO THE QUERY. The
    # first run of this probe timed out waiting for a result row for exactly that reason.
    page.press("Escape")
    time.sleep(0.3)
    # BACK INTO A THUMBNAIL MODE BEFORE THE QUIT, so the LAST frame — which is the one the account's
    # `drewPictures`/`drewIcons` describe — is a frame that had pictures in it. The two counters are
    # per-frame by design (a cumulative pair cannot say whether the frame on screen now has a blank
    # square in it), so a run that ended in Small icons would report the fallback clause over a mode
    # that has no fallback to make.
    wheel(page, centre, -120, modifiers=CTRL, times=1)
    time.sleep(1.4)
    out["lastFrame"] = live_view(page)

    # ---- hand back, quit, read the account -------------------------------------------------
    page.evaluate("(globalThis.M23F.driven = true, 1)")
    deadline = time.time() + 40
    row = None
    while time.time() < deadline:
        row = account(page)
        if row:
            break
        time.sleep(0.25)
    out["row"] = row
    out["seen"] = read(page, "JSON.stringify((globalThis.M23F || {}).seen || null)")
    return out


def live_view(page):
    """The view mode the program is in, read from the window TITLE and the strip's own label.

    THE TITLE IS NOT ENOUGH ON ITS OWN — it names the directory and not the mode — so the mode is
    read out of the sort strip's text run, which is the words a reader sees. The account carries the
    id and is read at the end; these two are the LIVE reading, and a clause needs both because a
    program that changed its internal state and drew nothing is a mode a reader cannot see."""
    raw = page.evaluate("""JSON.stringify((() => {
      const M = globalThis.M23F
      const e = M.entry
      if (!e || !e.surface) return null
      return { ops: e.surface.ops, blits: e.surface.report().blits,
               unbacked: e.surface.report().blitsUnbacked }
    })())""")
    return json.loads(raw) if raw else None


def verdict_of(rows, control, prove_failure):
    """Score the run. One clause per fact, and each names what it is about."""
    measured = [r for r in rows if r.get("ok")]
    wrong = [r for r in measured if not r.get("ratioApplied")]
    if not measured:
        return {"ok": False, "why": "nothing was measured; read `rows`.", "clauses": {}}
    if wrong:
        return {"ok": False, "clauses": {},
                "why": "THE RATIO ASKED FOR WAS NOT THE RATIO RENDERED (%s), so no figure here is "
                       "about the machine it is labelled with. Constraint 264."
                       % ", ".join("asked %g, got %g" % (r["askedDpr"], r["reportedDpr"])
                                   for r in wrong)}

    c = {}
    for r in measured:
        row = r.get("row") or {}
        seen = r.get("seenAtStart") or {}
        blits = (seen.get("blits") or {})
        t = row.get("thumbs") or {}
        label = "dpr %g" % r["reportedDpr"]

        # 1. THE BLIT. Three readings, because they are three facts.
        c["%s: the program sent a DL_BLIT" % label] = len(blits.get("ops") or []) > 0
        c["%s: the renderer drew it" % label] = (blits.get("drawn") or 0) > 0
        c["%s: no blit was unbacked" % label] = (blits.get("unbacked") or 0) == 0
        pixels = seen.get("pixels") or []
        c["%s: the pixels are the logo's" % label] = bool(pixels) and all(
            p.get("corner") == AMBER and p.get("edge") == BLUE for p in pixels)
        # THE PAYLOAD'S EXTENT, AND IT IS THE ONE CLAUSE THAT DOES NOT NEED THE PAGE'S PAYLOAD
        # CHANNEL. `thumbFit` is where the display's ratio enters a thumbnail, and a payload made
        # at the wrong size is the class of defect that cost M11, M12 and M16 a milestone each --
        # so it is asserted against the FIT's own arithmetic rather than against a constant:
        # `logo.png` is 16x16 and an image pixel is a CSS pixel until the cell is smaller, so the
        # payload is `min(cell, 16) * dpr` square. At the Medium cell (48 CSS px) and dpr 2 that is
        # 32, and at dpr 1 it is 16 -- which is exactly the pair a constant would get wrong.
        made = t.get("made") or []
        want = [min(m.get("cell", 0), LOGO_PX) * m.get("scale", 1) for m in made]
        c["%s: every payload is its fitted extent in DEVICE px" % label] = bool(made) and all(
            m["w"] == w and m["h"] == w for m, w in zip(made, want))
        # ...and the program's own account of the same thing.
        # THE HIGH-WATER MARK AND NOT THE LIVE FIGURE. `bytes` is the last fill pass's, and this
        # run deliberately walks OUT of the directory with the images in it — so a live reading
        # would be 0 for a program that behaved correctly. `peakBytes` is cumulative.
        c["%s: the program allocated a payload" % label] = (t.get("peakBytes") or 0) > 0
        c["%s: a decode ran" % label] = (t.get("decoded") or 0) > 0
        # EVERY PICTURE DECODED WAS EVENTUALLY RELEASED. Both counters are cumulative, so this is
        # the invariant and not a snapshot: a leak shows as `released < decoded`.
        c["%s: every picture decoded was released" % label] = (
            (t.get("released") or 0) == (t.get("decoded") or 0) and (t.get("decoded") or 0) > 0)

        # 2. THE VIEW MODE.
        c["%s: the view mode changed under a gesture" % label] = (row.get("viewSwitches") or 0) >= 2
        c["%s: the layout reports its lanes" % label] = (row.get("lanes") or 0) >= 1

        # 3. THE BREADCRUMB.
        nav = r.get("crumbNav") or {}
        c["%s: the trail has a segment per component" % label] = len(r.get("crumbs") or []) >= 2
        c["%s: a crumb press went where the segment named" % label] = bool(
            nav.get("title") and nav.get("wanted") and nav["wanted"] in nav["title"])
        c["%s: and it went through the Back stack" % label] = (row.get("crumbNav") or 0) >= 1

        # 4. SEARCH.
        c["%s: a typed query narrowed the listing" % label] = (row.get("searches") or 0) >= 1
        c["%s: the walk ran and said what it cost" % label] = (
            (row.get("deepSearches") or 0) >= 1
            and ((row.get("searchCost") or {}).get("dirsRead") or 0) >= 1)

        # A10, reported rather than asserted: this probe owns no opinion about what it should be.
        c["%s: the lstat cost was measured" % label] = (row.get("stats") or 0) > 0

        # R26'S FALLBACK, AS ARITHMETIC OVER THE LAST FRAME. Every item drawn has a mark of one
        # kind or the other, so the two counts SUM to the items drawn — which is the clause
        # "a fallback to the type icon" without reading a pixel. `readme.txt` is what makes it a
        # real test over this fixture: it is a row in a thumbnail mode with no format to decode.
        # THE LAST FRAME'S OWN COUNTS, out of the program's account. The probe steps back into a
        # thumbnail mode before quitting for exactly this (see `wheel` above the Escape).
        snap = {"drewPictures": t.get("drewPictures"), "drewIcons": t.get("drewIcons"),
                "shownRows": row.get("shownRows")}
        c["%s: every drawn item has a picture or an icon" % label] = (
            (snap.get("drewPictures") or 0) + (snap.get("drewIcons") or 0)
            == (snap.get("shownRows") or -1) and (snap.get("shownRows") or 0) > 0)
        c["%s: and some rows fell back to the icon" % label] = (snap.get("drewIcons") or 0) > 0

    if control == "thumb-no-fallback":
        # ITS NAMED SUBSET IS THE FALLBACK AND NOTHING ELSE: the pictures that DID decode are
        # unmoved, which is what makes the control scoped to the fallback alone.
        subject = [k for k in c if "picture or an icon" in k or "fell back to the icon" in k]
        turned = [k for k in subject if not c[k]]
        held = [k for k in c if k not in subject and c[k]]
        return {"ok": len(turned) == len(subject) and len(subject) > 0, "clauses": c,
                "control": control, "turned": turned, "stillGreen": len(held),
                "why": "--thumb-no-fallback turned %d of %d fallback clauses and left %d other "
                       "clauses green" % (len(turned), len(subject), len(held))}
    if control == "no-thumbs":
        # THE CONTROL'S NAMED SUBSET: the PICTURE and nothing else. A control satisfied by any
        # failure verifies nothing (CLAUDE.md).
        #
        # THE FALLBACK IS NOT IN IT, AND THAT IS MEASURED RATHER THAN REASONED. `--no-thumbs` draws
        # the type icon everywhere, so "every drawn item has a picture or an icon" STILL HOLDS — the
        # run reported it green while this list claimed it, which scored the control as having
        # turned 7 of 8 and verified nothing about the eighth. The fallback belongs to
        # `--thumb-no-fallback`, which is the world that removes it.
        subject = [k for k in c if "DL_BLIT" in k or "drew it" in k or "pixels are the logo" in k
                   or "a decode ran" in k or "allocated a payload" in k
                   or "decoded was released" in k or "fitted extent" in k]
        turned = [k for k in subject if not c[k]]
        held = [k for k in c if k not in subject and c[k]]
        return {"ok": len(turned) == len(subject), "clauses": c, "control": control,
                "turned": turned, "stillGreen": len(held),
                "why": "--no-thumbs turned %d of %d blit clauses and left %d other clauses green"
                       % (len(turned), len(subject), len(held))}

    failed = [k for k, v in c.items() if not v]
    # ---- THE ONE DIAGNOSIS THIS PROBE OWES, because the failure it found is not in the program --
    #
    # A BATCH THE KERNEL ACCEPTED, WITH BLIT OPS IN IT, AND NOTHING DRAWN. `win_draw` resolves every
    # blit fd BEFORE it draws and answers one of five errnos if any is wrong, so a batch that
    # arrived at the page with `DL_BLIT` ops in it is a batch the kernel validated — the payload was
    # present, offered and well-formed. `blitsUnbacked` rising is therefore not the program's fault
    # and not the kernel's validator's: it is the one state `src/wm/surface.mjs` declares that
    # counter for, "the payload channel dropped the map".
    diag = ""
    for r in measured:
        seen = r.get("seenAtStart") or {}
        b = seen.get("blits") or {}
        if (b.get("ops") and not b.get("drawn")) and b.get("unbacked"):
            diag = (
                "THE DL_BLIT PAYLOAD CHANNEL IS NOT CONNECTED END TO END, and it is three lines in "
                "three files none of which is `src/bin/files.mjs`:\n"
                "  1. `src/kernel/calls.mjs:1303` calls `k.wins.draw(d.win, region, blits)` with "
                "THREE arguments.\n"
                "  2. `src/kernel/wins.mjs` declares `draw(win, ops)` with TWO, so `blits` is "
                "dropped on the floor, and its `K.post({t:'win-draw', win, ops})` carries no "
                "payloads.\n"
                "  3. `src/wm/winhost.mjs:782` calls `entry.surface.replay(bytes)` with ONE "
                "argument, so `replay`'s `blits = null` default applies.\n"
                "MEASURED HERE: %d blit op(s) in a batch the kernel ACCEPTED (it validates every "
                "fd before drawing and would have answered EBADF/EINVAL/ENOTSUP/ENOENT/EBADMSG), "
                "%d drawn, %d UNBACKED. The program's own side is complete: %d decode(s), %d peak "
                "payload bytes, and every payload at its fitted extent. R26 cannot be shown as a "
                "PIXEL until those three lines agree."
                % (len(b["ops"]), b.get("drawn") or 0, b.get("unbacked") or 0,
                   ((r.get("row") or {}).get("thumbs") or {}).get("decoded") or 0,
                   ((r.get("row") or {}).get("thumbs") or {}).get("peakBytes") or 0))
            break
    if prove_failure:
        # INVERSION IS PER EXPECTATION AND NOT "EVERYTHING MUST FAIL", which is `scripts/check.py`'s
        # own contract: a clause that passes becomes a FAILURE, and the run MUST then report
        # failures — so the proof SUCCEEDS when at least one inverted expectation is red, and the
        # exit code is 0 for that (non-zero is reserved for a proof that failed). A first spelling
        # here asked for every clause to be false, which is a different and unreachable thing.
        inverted = [k for k, v in c.items() if v]
        return {"ok": len(inverted) > 0, "clauses": c, "failed": inverted,
                "why": "--prove-failure inverted %d expectations; %d of them reported red, which "
                       "is the proof succeeding. The %d clause(s) that were already red are now "
                       "green and are listed in `wasRed`."
                       % (len(c), len(inverted), len(failed)),
                "wasRed": failed}
    out = {"ok": not failed, "clauses": c, "failed": failed,
           "why": ("all %d expectations green" % len(c)) if not failed
                  else ("%d of %d red: %s" % (len(failed), len(c), ", ".join(failed)))}
    if diag:
        out["diagnosis"] = diag
    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--dpr", type=float, action="append", default=[])
    ap.add_argument("--view", default="medium",
                    help="the view mode the window opens in. Default `medium`, which is the "
                         "smallest mode the PRD scopes thumbnails to.")
    ap.add_argument("--no-thumbs", action="store_true",
                    help="CONTROL: pass `--no-thumbs` to the program. The blit clauses MUST turn "
                         "and the rest MUST hold.")
    ap.add_argument("--thumb-no-fallback", action="store_true",
                    help="CONTROL: pass `--thumb-no-fallback`. A row with no thumbnail draws "
                         "nothing at all.")
    ap.add_argument("--prove-failure", action="store_true",
                    help="invert every expectation; the run MUST report red.")
    ap.add_argument("--out", default="")
    args = ap.parse_args(argv[1:])
    ratios = args.dpr or [2.0]

    flags = ["--view", args.view]
    control = ""
    if args.no_thumbs:
        flags.append("--no-thumbs")
        control = "no-thumbs"
    if args.thumb_no_fallback:
        flags.append("--thumb-no-fallback")
        control = "thumb-no-fallback"
    program_argv = " ".join(flags)

    os.chdir(REPO)
    httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % port
    engine = "gpu" if args.headed else "swiftshader"
    name = "results-%s%s.json" % (engine, ("-" + control) if control else "")
    out_path = pathlib.Path(args.out) if args.out else HERE / name
    print("m23 files probe  %s%s  argv: files %s  (%s)"
          % (base, DOC, program_argv, engine), file=sys.stderr)

    rows: list[dict] = []
    try:
        with cdp.Browser(extra_args=HEADED_FLAGS if args.headed else (),
                         headless=not args.headed) as browser:
            page = browser.page()
            page.call("Runtime.enable")
            page.call("Log.enable")
            page.call("Page.enable")
            for dpr in ratios:
                row = one_run(page, base, dpr, program_argv, control)
                rows.append(row)
                if not row.get("ok"):
                    print("  dpr %-4g FAILED  %s" % (dpr, row.get("why")), file=sys.stderr)
                    continue
                acc = row.get("row") or {}
                seen = row.get("seen") or {}
                b = (seen.get("blits") or {})
                print("  dpr %-4g  view %s  lanes %s  blits %s op(s)/%s drawn/%s unbacked  "
                      "thumbs %s of %s  query %r  %s match(es)"
                      % (dpr, acc.get("view"), acc.get("lanes"),
                         len(b.get("ops") or []), b.get("drawn"), b.get("unbacked"),
                         (acc.get("thumbs") or {}).get("ready"),
                         (acc.get("thumbs") or {}).get("wanted"),
                         acc.get("query"), acc.get("matched")),
                      file=sys.stderr)
    except cdp.CDPError as error:
        print(json.dumps({"ok": False, "why": str(error)}, indent=2))
        return 3
    finally:
        httpd.shutdown()
        httpd.server_close()

    verdict = verdict_of(rows, control, args.prove_failure)
    out = {"verdict": verdict, "rows": rows}
    out_path.write_text(json.dumps(out, indent=2))
    print(json.dumps({"verdict": verdict, "results": str(out_path)}, indent=2))
    # 4 FOR A CONTROL THAT PROVED NOTHING, which is `bench/m23-blit/probe.py`'s own exit code for
    # the same state: a control that turned no clause it was named for verifies nothing.
    if control and not verdict.get("ok"):
        return 4
    return 0 if verdict.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
