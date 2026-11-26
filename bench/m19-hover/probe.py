#!/usr/bin/env python3
"""IS A HOVER SURVIVABLE? 500 buttonless pointer moves into one window, counted in the kernel.

    python3 bench/m19-hover/probe.py                 # the grid: three worlds x two drain states
    python3 bench/m19-hover/probe.py --moves 500     # the stream length (default 500)
    python3 bench/m19-hover/probe.py --world coalesce --hold 120000  # one cell
    python3 bench/m19-hover/probe.py --headed
    python3 bench/m19-hover/probe.py --prove-failure # the control MUST come out empty

WHAT IS BEING DECIDED. `docs/CONSTRAINTS.md` 223 says "A HOVER IS NOT SENT", and the argument is
arithmetic: "a hover would be one event per `pointermove` against a 256-record queue (constraint
213), so a second of hovering would overflow a queue the process is being asked to drain".
`docs/PLAN-SHELL.md` M19's A5 reverses that, and the row is explicit that the amendment must rest on
a measurement and not on 223's own closing escape clause. So the overflow is a PREDICTION, and this
is where it is counted.

THE INSTRUMENTS ARE `queued:` AND `coalesced:`, NOT `dropped:`. `dropped` moves only on a FULL ring
(`Window.push`), so a program that is servicing its fd never moves it however long the stream —
M17's own coalescing proof needed `files --no-drain` to reach a single drop. `queued` counts events
OFFERED to the queue and `coalesced` counts records MERGED into its tail, so those two are what tell
a 500-record stream apart from a 500-record stream that became one record. `dropped` is read and
reported beside them because it is the number 223 actually predicted.

THE THREE WORLDS, each served out of its own PATCHED COPY of the tree — the repository is never
edited, which is `bench/kernel-ready/probe.py`'s rule and for its reason: a probe that rewrites the
source it measures can leave the tree broken.

  off        the tree as it stands. `if (!e.buttons) return;` is in place, so no hover is delivered
             at all. THE CONTROL: no pointer record may be sent, and nothing may enter the queue
             that a focus event does not account for. A run in which either moves is a run
             measuring something other than the guard.
  append     that one line removed, and nothing else. The world the removal ALONE produces: every
             move is a record, through `Window.push`.
  coalesce   that, plus tail replacement for a buttonless move — `Window.pushPointer`, written in
             the shape `pushClient` and `pushWheel` already share. The world A5 builds.

AND EACH IS MEASURED AGAINST A DRAINING PROGRAM AND A HELD ONE (`files --no-drain`), because 223's
sentence is about "a queue the process is being asked to drain" and the two halves answer different
questions. A held program is the bound: the ring fills and cannot empty, which is the only world in
which a 256-record cap is reachable at all.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import cdp  # noqa: E402
import serve  # noqa: E402

DOC = "/bench/m19-hover/hover.html"

#: The same flags M16's and M17's probes use headed, and for their reason: a headed run is for a
#: human watching, and the suite is headless, so headless is the world a clause will run in.
HEADED_FLAGS = ("--force-color-profile=srgb", "--disable-lcd-text")

#: 500 MOVES, which is the figure `docs/PLAN-SHELL.md` M19 names. Against `WIN_EVENT_CAP` of 256 it
#: is just under two full rings, so an appending world cannot avoid lapping and a replacing one has
#: to be seen not to.
MOVES = 500

#: Milliseconds asked for between one dispatched move and the next. It is a floor and not the rate:
#: a `Input.dispatchMouseEvent` round trip dominates it, and 500 moves measure ~17.9 s on this
#: machine — about 28 a second, which every row reports as `streamMs` rather than assuming.
#:
#: THE RATE IS NOT WHAT IS BEING MEASURED. A ring has no time dimension: `WIN_EVENT_CAP` bounds a
#: COUNT, so what decides whether a stream laps is how many records arrive between two drains. A
#: faster stream reaches the same cap sooner and not differently.
GAP_MS = 10

#: Moves per burst, and the pause between bursts. A hand hovering a list moves in bursts, and a
#: burst boundary is the one place a draining program can empty the ring mid-stream — which is where
#: tail replacement has to be seen to start a new record rather than to lose one. See `hover_stream`
#: for what this is NOT evidence of.
BURST = 50
BURST_PAUSE_MS = 150

#: `files --no-drain MS` for the held half. It must outlast staging AND the whole stream: the hold
#: starts when the window is painted, which is before the page has raised it, settled its geometry
#: or driven a move. 500 moves at GAP_MS plus a CDP round trip each is ~20 s, so this is ~4x it.
HOLD_MS = 120000

WORLDS = ("off", "append", "coalesce")


# ---- the patches ------------------------------------------------------------------------------
#
# Each asserts its needle and raises rather than patching nothing. A control that silently failed to
# apply is a green run over an unmodified world, which is the failure mode every one of these
# functions exists to make impossible.

HOVER_GUARD = """    el.addEventListener("pointermove", (e) => {
      if (!e.buttons) return;
      send(WPTR_MOVE, e);"""

HOVER_DELIVERED = """    el.addEventListener("pointermove", (e) => {
      send(WPTR_MOVE, e);"""


def deliver_hover(root: pathlib.Path) -> str:
    """Remove the ONE line that makes a hover unreachable, in a copy of the tree."""
    path = root / "src/wm/winhost.mjs"
    src = path.read_text()
    if HOVER_GUARD not in src:
        raise SystemExit("could not deliver hover: `#wirePointer`'s pointermove listener did not "
                         "match. Update this patch beside the listener rather than reporting a "
                         "measurement over an unmodified host.")
    path.write_text(src.replace(HOVER_GUARD, HOVER_DELIVERED, 1))
    return "src/wm/winhost.mjs: `if (!e.buttons) return;` removed from the pointermove listener"


#: The method, inserted into `Window` so that it can reach `#popTail`. It is `pushClient`'s shape —
#: REPLACEMENT and not summing, because a stale hover position has no history worth keeping, which
#: is the same argument a stale client box answers to — and `pushWheel`'s accounting: a merge returns
#: without calling `push`, so `queued` counts records that ENTERED the ring and `coalesced` counts
#: the offers that did not.
#:
#: A HOVER IS DEFINED BY WHAT IT IS NOT: neither a press nor a release, with no button held. `c`
#: carries `event.buttons`, so a drag's move is excluded by the record itself rather than by a flag
#: the page sets. `WPTR_MOVE` is deliberately not tested, because `wins.mjs` does not import it and a
#: patch that added an import would be measuring a different file's text than the one M19 will write.
PUSH_POINTER = """  pushPointer(ev) {
    if (this.destroyed) return false;
    const mods = ev.mods | 0;
    const hover = !(mods & (WPTR_DOWN | WPTR_UP)) && !(ev.c | 0);
    if (hover) {
      const tail = this.#popTail();
      if (tail) {
        const dv = new DataView(tail.buffer);
        const prev = decodeWinEvent(dv, 0);
        const like = prev.type === WEV_POINTER && (prev.mods | 0) === mods && !(prev.c | 0);
        if (like) {
          encodeWinEvent(dv, 0, { type: WEV_POINTER, mods, a: ev.a, b: ev.b, c: ev.c });
          this.events.push(tail);
          this.stats.coalesced += 1;
          return true;
        }
        this.events.push(tail);
      }
    }
    return this.push(ev);
  }

"""

PUSH_CLIENT_HEAD = "  pushClient(w, h) {"

FEED_TAIL = """    return w.push(ev);
  }"""

FEED_POINTER = """    if (ev.type === WEV_POINTER) {
      return w.pushPointer(ev);
    }
    return w.push(ev);
  }"""


def coalesce_hover(root: pathlib.Path) -> str:
    """Deliver hover AND give a buttonless move the tail replacement `WEV_CLIENT` already has."""
    note = deliver_hover(root)
    path = root / "src/kernel/wins.mjs"
    src = path.read_text()
    if PUSH_CLIENT_HEAD not in src:
        raise SystemExit("could not add `pushPointer`: `Window.pushClient`'s signature did not "
                         "match, so there is no anchor to insert beside.")
    if src.count(FEED_TAIL) != 1:
        raise SystemExit("could not route a pointer to `pushPointer`: `WinMgr.feed`'s final "
                         "`return w.push(ev);` is not unique in src/kernel/wins.mjs (%d matches). "
                         "Re-anchor this patch rather than guessing." % src.count(FEED_TAIL))
    src = src.replace(PUSH_CLIENT_HEAD, PUSH_POINTER + PUSH_CLIENT_HEAD, 1)
    src = src.replace(FEED_TAIL, FEED_POINTER, 1)
    path.write_text(src)
    return (note + "; src/kernel/wins.mjs: `Window.pushPointer` added and `WinMgr.feed` routes a "
            "WEV_POINTER through it")


PATCHES = {"off": None, "append": deliver_hover, "coalesce": coalesce_hover}


# ---- driving ----------------------------------------------------------------------------------


def jload(raw):
    if not isinstance(raw, str):
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def read_report(page) -> dict:
    return jload(page.evaluate("""(() => {
      const H = globalThis.HOVER || {}
      return JSON.stringify({
        state: String(H.state || ''), why: String(H.why || ''),
        pid: H.pid | 0, win: H.win | 0,
        staging: H.staging || null, notes: (H.notes || []).map(String),
        faults: (H.faults || []).map((f) => ({ pid: f.pid, why: String(f.why).slice(0, 200) })),
        errors: (H.errors || []).map(String),
      })
    })()""")) or {}


def snapshot(page) -> dict:
    return jload(page.evaluate("HOVER.snapshot()", await_promise=True)) or {}


def hover_stream(page, points, gap_ms: float) -> dict:
    """Dispatch one buttonless `mouseMoved` per point, in bursts, and say what got out.

    `button="none"` with `buttons=0` is the hover dispatch `scripts/check.py`'s own `hover` gesture
    uses. A move claiming a button nobody pressed would be a DRAG, which the host already delivers
    and which is not the thing 223 refuses.

    IN BURSTS, WITH A PAUSE: a hand hovering a list moves in bursts, and a burst boundary is the one
    place a DRAINING program empties the ring mid-stream, which is where tail replacement has to be
    seen to open a new record rather than to lose one.

    THE BURSTS ARE NOT EVIDENCE OF A RENDERER CEILING, and this docstring said they were. Four
    500-move runs lost the channel to Chrome mid-stream — `connection closed mid-frame`, `connection
    reset by peer`, no crash report on this machine — and 250 never did, which read exactly like a
    limit in the engine. It was not: `pgrep` found a CONCURRENT process in this repository whose own
    command began `pkill -9 -f "showup-chrome-"`, which is `CLAUDE.md`'s instruction to kill stray
    Chrome between control runs, and it was killing this probe's browser. A plausible cause is not an
    observed one.

    A LOST CHANNEL IS REPORTED, NEVER SWALLOWED. The count that got out comes back with the error,
    because a partial stream cannot satisfy a clause about 500 moves and a run that quietly
    measured 312 of them would be the worst outcome available (`CLAUDE.md`, harness honesty). The
    retry in `main` is sized for exactly the collision above.
    """
    t0 = time.time()
    sent = 0
    for i, p in enumerate(points):
        try:
            page.call("Input.dispatchMouseEvent", type="mouseMoved",
                      x=int(p["x"]), y=int(p["y"]), button="none", buttons=0)
        except Exception as error:   # noqa: BLE001 - the type is cdp.CDPError or a socket error
            return {"ms": round((time.time() - t0) * 1000.0), "sent": sent,
                    "lost": "%s: %s" % (type(error).__name__, error)}
        sent += 1
        if gap_ms > 0:
            time.sleep(gap_ms / 1000.0)
        if BURST and (i + 1) % BURST == 0:
            time.sleep(BURST_PAUSE_MS / 1000.0)
    return {"ms": round((time.time() - t0) * 1000.0), "sent": sent, "lost": ""}


def run_cell(page, base: str, world: str, hold_ms: int, moves: int, gap_ms: float) -> dict:
    """One world, one drain state: stage, snap, stream, snap, grep `/proc`."""
    url = "%s%s?hold=%d" % (base, DOC, hold_ms)
    page.navigate(url, timeout=60)
    deadline = time.time() + 120
    rep: dict = {}
    while time.time() < deadline:
        rep = read_report(page)
        if rep.get("state") in ("staged", "error", "aborted"):
            break
        time.sleep(0.3)
    row = {"world": world, "holdMs": hold_ms, "moves": moves, "gapMs": gap_ms, "url": url,
           "state": rep.get("state") or "stuck", "why": rep.get("why") or "",
           "pid": rep.get("pid"), "win": rep.get("win"), "staging": rep.get("staging"),
           "pageNotes": rep.get("notes") or [], "errors": rep.get("errors") or []}
    if row["state"] != "staged":
        row["why"] = row["why"] or "the page never staged a window within 120 s"
        return row

    path = jload(page.evaluate("HOVER.aimPath(%d)" % moves))
    if not path or not path.get("points"):
        row["state"] = "error"
        row["why"] = "the surface reported no measurable rect, so nothing could be aimed at it"
        return row
    row["rect"] = path["rect"]

    before = snapshot(page)
    stream = hover_stream(page, path["points"], gap_ms)
    row["streamMs"] = stream["ms"]
    row["dispatched"] = stream["sent"]
    if stream["lost"]:
        row["state"] = "broken"
        row["why"] = ("the channel to Chrome went away after %d of %d dispatched moves: %s"
                      % (stream["sent"], moves, stream["lost"]))
        return row
    # ONE SETTLING PAUSE, and it is not slack in the measurement: the last dispatches are still in
    # flight when the loop returns, and a snapshot taken then undercounts the stream it is reading.
    time.sleep(0.6)
    after = snapshot(page)
    row["before"] = before
    row["after"] = after
    row["delta"] = {k: (after.get(k, 0) - before.get(k, 0))
                    for k in ("queued", "coalesced", "dropped", "delivered", "suppressed",
                              "geoms", "pointers", "unknown", "focus", "raiseAsks")}

    # `/proc`, WHILE THE PROGRAM IS STILL NOT DRAINING in the held cells. The patterns are built
    # from the numbers the kernel just reported, so a line that merely EXISTS does not satisfy
    # them — `grep -c` with a fixed string and its exit status is the answer.
    row["greps"] = {}
    for field in ("queued", "coalesced", "dropped"):
        pattern = "%s:\t%d" % (field, after.get(field, 0))
        got = jload(page.evaluate("HOVER.grepProc(%s)" % json.dumps(pattern),
                                  await_promise=True))
        row["greps"][field] = got or {"pattern": pattern, "exit": None}
    return row


# ---- the verdict ------------------------------------------------------------------------------


def judge(rows: list[dict], moves: int) -> tuple[bool, list[str], list[str]]:
    """Score each cell against what its world predicts. Returns (ok, notes, bad)."""
    notes: list[str] = []
    bad: list[str] = []
    by: dict[tuple[str, bool], dict] = {}
    for row in rows:
        if row.get("state") != "staged":
            bad.append("%s/%s: %s" % (row["world"], "held" if row["holdMs"] else "draining",
                                      row.get("why")))
            continue
        by[(row["world"], bool(row["holdMs"]))] = row
        d = row["delta"]
        tag = "%s/%s" % (row["world"], "held" if row["holdMs"] else "draining")

        # EVERY CELL: the geometry must not have moved. `coalesced` counts client replacements in
        # the same field, so a `win-geom` mid-stream makes the number mean two things.
        if d["geoms"]:
            bad.append("%s: the page reported geometry %d time(s) DURING the stream, so "
                       "`coalesced` is not pointer merges alone" % (tag, d["geoms"]))
        if d["unknown"]:
            notes.append("%s: the host counted %d unknown message(s)" % (tag, d["unknown"]))
        if d["suppressed"]:
            bad.append("%s: %d event(s) were SUPPRESSED by a modal, so the stream did not reach "
                       "the queue being measured" % (tag, d["suppressed"]))

        if row["world"] == "off":
            # THE CONTROL, AND IT MOVES A NAMED NUMBER AND NOT "nothing failed": no pointer record
            # may be sent, and nothing may enter the queue that a focus event does not account for.
            #
            # THE FOCUS TERM IS MEASURED AND NOT ALLOWED FOR IN ADVANCE. With the guard in place and
            # 30 moves dispatched, `queued` rose by 1 with `pointers` at 0 — the first synthetic
            # mouse event moves the browser's focus, `src/wm/winhost.mjs`'s `#focus` queues one
            # `WEV_FOCUS` for it, and that event is not a hover. Subtracting it is what makes the
            # control's zero a statement about the guard rather than about the whole queue.
            if d["pointers"]:
                bad.append("%s: THE CONTROL MOVED. %d pointer record(s) with "
                           "`if (!e.buttons) return;` in place — this probe is not measuring the "
                           "guard" % (tag, d["pointers"]))
            if d["queued"] - d["focus"]:
                bad.append("%s: %d record(s) entered the queue that %d focus event(s) do not "
                           "account for, so the figures the hover worlds report contain a term "
                           "this probe cannot name" % (tag, d["queued"], d["focus"]))
            continue

        # THE FIXTURE CLAUSE both hover worlds are vacuous without: the page really routed the
        # stream. If the TRANSPORT coalesced, the kernel would be credited for its work.
        if d["pointers"] < moves:
            bad.append("%s: %d of %d moves reached the host's listener, so the transport or the "
                       "hit-test lost %d — the kernel cannot be credited for them"
                       % (tag, d["pointers"], moves, moves - d["pointers"]))

        if row["world"] == "append":
            if d["coalesced"]:
                bad.append("%s: an appending world coalesced %d record(s)" % (tag, d["coalesced"]))
            if row["holdMs"] and d["dropped"] <= 0:
                bad.append("%s: an appending world dropped nothing into a HELD program, so the "
                           "256-record cap was never reached and the world 223 predicted was not "
                           "measured" % tag)
        if row["world"] == "coalesce":
            if d["dropped"]:
                bad.append("%s: tail replacement dropped %d record(s)" % (tag, d["dropped"]))
            # THE FOCUS TERM IS SUBTRACTED, for the reason the control states: one `WEV_FOCUS` is
            # not a hover, and a ceiling that allowed for it blindly would also allow for a merge
            # that did not happen.
            if row["holdMs"] and (d["queued"] - d["focus"]) > 4:
                bad.append("%s: a held program's queue took %d records (less %d focus) from a "
                           "%d-move stream; tail replacement is not replacing"
                           % (tag, d["queued"], d["focus"], moves))

        for field, got in (row.get("greps") or {}).items():
            if got.get("exit") != 0:
                bad.append("%s: `grep -c %r %s` exited %r, so the number this run asserts is not "
                           "the one `/proc` prints"
                           % (tag, got.get("pattern"), got.get("path"), got.get("exit")))

    # ---- the figures the amendment cites ----
    for key in (("append", True), ("coalesce", True), ("append", False), ("coalesce", False)):
        row = by.get(key)
        if not row:
            continue
        d = row["delta"]
        notes.append("%s/%-8s %d moves routed in %d ms: queued +%d (of which %d focus), "
                     "coalesced +%d, dropped +%d, delivered +%d; ring held %d of %d at the end"
                     % (key[0], "held" if key[1] else "draining", d["pointers"],
                        row.get("streamMs", -1), d["queued"], d["focus"], d["coalesced"],
                        d["dropped"], d["delivered"], row["after"].get("pending", -1), 256))
    held_append = by.get(("append", True))
    held_coal = by.get(("coalesce", True))
    if held_append and held_coal:
        a = held_append["delta"]
        c = held_coal["delta"]
        notes.append("THE AMENDMENT'S FIGURE: into a program that is not draining, %d moves "
                     "APPENDED lose %d records (%.0f%%); the same %d moves with tail replacement "
                     "lose %d, as queued +%d / coalesced +%d."
                     % (a["pointers"], a["dropped"], 100.0 * a["dropped"] / max(1, a["pointers"]),
                        c["pointers"], c["dropped"], c["queued"], c["coalesced"]))
    drained = by.get(("coalesce", False))
    if drained:
        d = drained["delta"]
        notes.append("AND A DRAINING PROGRAM LOSES NOTHING EITHER WAY, with nothing to replace: "
                     "dropped +%d, coalesced +%d, and %d records handed straight to a parked "
                     "reader against %d moves and %d focus event(s)."
                     % (d["dropped"], d["coalesced"], d["delivered"], d["pointers"], d["focus"]))
    return (not bad), notes, bad


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true",
                    help="drive a real window, for a human watching. The suite is headless.")
    ap.add_argument("--moves", type=int, default=MOVES)
    ap.add_argument("--gap-ms", type=float, default=GAP_MS)
    ap.add_argument("--world", action="append", default=[], choices=WORLDS,
                    help="a world to measure, repeatable. Default: all three.")
    ap.add_argument("--hold", type=int, action="append", default=[],
                    help="a `--no-drain` figure in ms, repeatable; 0 means a draining program. "
                         "Default: 0 and %d." % HOLD_MS)
    ap.add_argument("--prove-failure", action="store_true",
                    help="assert the CONTROL instead: with the guard in place a 500-move stream "
                         "MUST reach no process. Exits 0 when that proof succeeded.")
    ap.add_argument("--out", default="")
    args = ap.parse_args(argv)

    worlds = tuple(args.world) if args.world else WORLDS
    holds = tuple(args.hold) if args.hold else (0, HOLD_MS)
    if args.prove_failure:
        worlds, holds = ("off",), (0, HOLD_MS)

    rows: list[dict] = []
    controls: dict[str, str] = {}
    try:
        for world in worlds:
            root = REPO
            tmp: pathlib.Path | None = None
            patch = PATCHES[world]
            if patch is not None:
                # A COPY, so a patch cannot leave the repository holding a broken kernel.
                tmp = pathlib.Path(os.environ.get("TMPDIR", "/tmp")) / ("webos-m19-hover-" + world)
                if tmp.exists():
                    shutil.rmtree(tmp)
                # THE PNGs COME TOO, and that is not a size oversight. `src/share/logo.png` is a
                # data file `/usr/share` mounts through `src/kernel/providerfs.mjs`, so a copy that
                # excluded it served a 404 where a provider expected bytes — and `files /usr/bin`
                # then opened no window at all. Measured: the first run of this probe reported "the
                # files window never surfaced within 30000 ms" for exactly that reason.
                shutil.copytree(REPO, tmp, ignore=shutil.ignore_patterns(
                    ".git", "node_modules", "build", ".venv", "__pycache__"))
                controls[world] = patch(tmp)
                root = tmp
            print("world %-9s %s" % (world, controls.get(world, "the tree as it stands")),
                  file=sys.stderr)
            os.chdir(root)
            httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
            port = httpd.server_address[1]
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            base = "http://127.0.0.1:%d" % port
            print("  served %s from %s" % (base, root), file=sys.stderr)
            try:
                for hold in holds:
                    # A FRESH BROWSER PER CELL, AND ONE RETRY IF THE CHANNEL GOES AWAY.
                    #
                    # ONE BROWSER FOR THE WHOLE WORLD IS WHAT THE FIRST VERSION DID, and it is how
                    # a lost channel in the first cell became a traceback instead of five more rows:
                    # the `with` block owned every cell, so the first `CDPError` ended the world. A
                    # browser per cell also keeps one cell's renderer state out of the next, which
                    # matters when the ceiling in the way is a renderer's.
                    #
                    # THE RETRY IS BOUNDED AT ONE AND IS RECORDED: `attempts` goes in the row, so a
                    # flake is reported rather than hidden.
                    row: dict = {}
                    for attempt in (1, 2):
                        with cdp.Browser(extra_args=HEADED_FLAGS if args.headed else (),
                                         headless=not args.headed) as browser:
                            page = browser.page()
                            page.call("Runtime.enable")
                            row = run_cell(page, base, world, int(hold), args.moves, args.gap_ms)
                        row["attempts"] = attempt
                        if row.get("state") != "broken":
                            break
                        print("    attempt %d: %s" % (attempt, row.get("why")), file=sys.stderr)
                    rows.append(row)
                    d = row.get("delta") or {}
                    print("  %-9s hold=%-7d state=%-7s routed=%-4s queued=%-4s coalesced=%-4s "
                          "dropped=%-4s pending=%s"
                          % (world, hold, row.get("state"), d.get("pointers"),
                             d.get("queued"), d.get("coalesced"), d.get("dropped"),
                             (row.get("after") or {}).get("pending")), file=sys.stderr)
                    if row.get("state") != "staged":
                        print("    %s" % row.get("why"), file=sys.stderr)
            finally:
                httpd.shutdown()
            if tmp is not None:
                shutil.rmtree(tmp, ignore_errors=True)
    finally:
        os.chdir(REPO)

    ok, notes, bad = judge(rows, args.moves)
    out = {"ok": ok, "moves": args.moves, "gapMs": args.gap_ms, "holds": list(holds),
           "worlds": list(worlds), "controls": controls, "notes": notes, "bad": bad, "rows": rows}
    out_path = pathlib.Path(args.out) if args.out else HERE / "results.json"
    out_path.write_text(json.dumps(out, indent=2) + "\n")

    print()
    for note in notes:
        print("  %s" % note)
    print()

    if args.prove_failure:
        # THE CONTROL'S OWN PROOF: with the guard in place the stream must reach nothing. Here a
        # moved number is the success, so the scoring is inverted and NAMED.
        moved = [r for r in rows if r.get("state") == "staged"
                 and ((r.get("delta") or {}).get("pointers") or 0) > 0]
        staged = [r for r in rows if r.get("state") == "staged"]
        if not staged:
            print("--prove-failure: no cell staged a window, so the control proved nothing.")
            print("wrote %s" % out_path)
            return 1
        if moved:
            print("--prove-failure: THE GUARD DID NOT HOLD. %d cell(s) delivered a pointer record "
                  "with `if (!e.buttons) return;` in place, so this probe's `off` world is not a "
                  "control." % len(moved))
            print("wrote %s" % out_path)
            return 1
        print("--prove-failure: %d cell(s) drove %d moves each into the unmodified tree and no "
              "process received one. The `off` world is a control." % (len(staged), args.moves))
        print("wrote %s" % out_path)
        return 0

    if bad:
        for line in bad:
            print("BAD  %s" % line)
        print("\nwrote %s" % out_path)
        return 1
    # THE HEADLINE NAMES WHAT RAN. A partial grid is a legitimate invocation — `--world coalesce`
    # is how one cell is re-measured — and printing the amendment's conclusion over it would be a
    # claim about worlds this run never loaded.
    measured = {(r["world"], bool(r["holdMs"])) for r in rows if r.get("state") == "staged"}
    if {("append", True), ("coalesce", True), ("off", False)} <= measured:
        print("A %d-MOVE HOVER STREAM IS SURVIVABLE WITH TAIL REPLACEMENT AND NOT WITHOUT IT. "
              "`coalesced` is where it goes." % args.moves)
    else:
        print("every cell this run asked for came out as its world predicts: %s"
              % ", ".join("%s/%s" % (w, "held" if h else "draining")
                          for (w, h) in sorted(measured)))
    print("wrote %s" % out_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
