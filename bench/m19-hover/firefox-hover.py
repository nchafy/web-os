#!/usr/bin/env python3
"""DOES A HOVER STREAM SURVIVE A SECOND ENGINE? The same 500 moves, with REAL trusted input.

    python3 bench/m19-hover/firefox-hover.py
    python3 bench/m19-hover/firefox-hover.py --moves 500 --world coalesce
    python3 bench/m19-hover/firefox-hover.py --headed
    python3 bench/m19-hover/firefox-hover.py --prove-failure

WHY THIS FILE EXISTS. `bench/m19-hover/probe.py` drives Chrome, and `CLAUDE.md` records what
driving Chrome alone has cost this project: M4a shipped a window that could not be dragged in
Firefox, M6 shipped a policy under which no process started there, and M11 and M12 each failed on an
engine whose feature was fine because a geometry came from a constant measured at dpr 2.

ONE HALF OF THE CHROME FIGURE IS ENGINE-INDEPENDENT AND THE OTHER IS NOT, and that is the whole
reason for this gate. `queued:` and `coalesced:` are the KERNEL's arithmetic over records it was
handed, and no browser has an opinion about it. But "500 moves were handed to it" is the
TRANSPORT's, and a transport that coalesced a burst of `pointermove` into one event would make the
kernel's coalescing look like a kernel's work when half of it was the engine's — the same confusion
`bench/m17-wheel/probe.py` had to rule out for the wheel (constraint 298). So the number this gate
is really after is `pointers`: how many pointer records the host sent for N driven moves.

WHAT IS ASSERTED:

  1. the engine delivers one `pointermove` per driven move — `pointers` rises by N;
  2. in the `append` world the ring laps: `dropped` rises, and `pending` is the 256-record cap;
  3. in the `coalesce` world nothing is dropped and `queued` barely moves, with `coalesced`
     carrying the stream.

`--prove-failure` drives the same stream against the tree AS IT STANDS, where
`if (!e.buttons) return;` is in place: no pointer record may reach any process. It exits 0 when that
proof SUCCEEDED, which is this repo's convention for a proof-of-failure run.

THE PATCHES ARE `probe.py`'S, imported rather than restated. A second copy of the one line being
removed is how the two drivers come to measure two different worlds.
"""
from __future__ import annotations

import argparse
import importlib.util
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

import bidi   # noqa: E402
import serve  # noqa: E402


def _load_probe():
    """`bench/m19-hover/probe.py`, as a module. It is not importable by name — `bench/` is not a
    package and the file is a script — and the alternative is a second copy of every patch."""
    spec = importlib.util.spec_from_file_location("m19_hover_probe", HERE / "probe.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


probe = _load_probe()

DOC = "/bench/m19-hover/hover.html"

#: Moves per `input.performActions` call, and the pause BiDi inserts between them. Bursts for the
#: Chrome driver's reason (`probe.hover_stream`), and `pause` inside the sequence because the engine
#: is entitled to coalesce two moves dispatched in the same instant — which is the one thing this
#: gate must not accidentally measure.
BURST = 50
PAUSE_MS = 10


def staged(ff, tries: int = 120) -> dict:
    """Wait for the page to report `staged`, and return its own report."""
    for _ in range(tries):
        got = ff.evaluate("""JSON.stringify((() => {
          const H = globalThis.HOVER || {}
          return { state: String(H.state || ''), why: String(H.why || ''), dpr: devicePixelRatio,
                   pid: H.pid | 0, win: H.win | 0, staging: H.staging || null,
                   errors: (H.errors || []).map(String).slice(0, 4) }
        })())""")
        if isinstance(got, dict) and got.get("state") in ("staged", "error", "aborted"):
            return got
        time.sleep(0.5)
    return {"state": "stuck", "why": "the page never staged a window"}


def snapshot(ff) -> dict:
    got = ff.evaluate("HOVER.snapshot()")
    return got if isinstance(got, dict) else {}


def hover_stream(ff, points) -> dict:
    """Drive the moves as real trusted input, in bursts, and say what got out."""
    t0 = time.time()
    sent = 0
    for start in range(0, len(points), BURST):
        chunk = points[start:start + BURST]
        actions: list[dict] = []
        for p in chunk:
            actions.append({"type": "pointerMove", "x": int(p["x"]), "y": int(p["y"])})
            actions.append({"type": "pause", "duration": PAUSE_MS})
        try:
            ff.pointer(actions)
        except Exception as error:   # noqa: BLE001 - BidiError or a socket error
            return {"ms": round((time.time() - t0) * 1000.0), "sent": sent,
                    "lost": "%s: %s" % (type(error).__name__, error)}
        sent += len(chunk)
    return {"ms": round((time.time() - t0) * 1000.0), "sent": sent, "lost": ""}


def run_cell(ff, base: str, world: str, hold_ms: int, moves: int) -> dict:
    ff.navigate("%s%s?hold=%d" % (base, DOC, hold_ms))
    rep = staged(ff)
    row = {"world": world, "holdMs": hold_ms, "moves": moves, "engine": "firefox",
           "state": rep.get("state"), "why": rep.get("why") or "", "dpr": rep.get("dpr"),
           "pid": rep.get("pid"), "win": rep.get("win"), "staging": rep.get("staging"),
           "errors": rep.get("errors") or []}
    if row["state"] != "staged":
        return row
    path = ff.evaluate("HOVER.aimPath(%d)" % moves)
    if not isinstance(path, dict) or not path.get("points"):
        row["state"] = "error"
        row["why"] = "the surface reported no measurable rect, so nothing could be aimed at it"
        return row
    row["rect"] = path["rect"]
    before = snapshot(ff)
    stream = hover_stream(ff, path["points"])
    row["streamMs"] = stream["ms"]
    row["dispatched"] = stream["sent"]
    if stream["lost"]:
        row["state"] = "broken"
        row["why"] = ("the channel to Firefox went away after %d of %d driven moves: %s"
                      % (stream["sent"], moves, stream["lost"]))
        return row
    time.sleep(0.6)
    after = snapshot(ff)
    row["before"] = before
    row["after"] = after
    row["delta"] = {k: (after.get(k, 0) - before.get(k, 0))
                    for k in ("queued", "coalesced", "dropped", "delivered", "suppressed",
                              "geoms", "pointers", "unknown", "focus", "raiseAsks")}
    return row


def judge(rows: list[dict], moves: int, proving: bool) -> tuple[bool, list[str], list[str]]:
    notes: list[str] = []
    bad: list[str] = []
    for row in rows:
        tag = "%s/%s" % (row["world"], "held" if row["holdMs"] else "draining")
        if row.get("state") != "staged":
            bad.append("%s: %s" % (tag, row.get("why")))
            continue
        d = row["delta"]
        notes.append("%s %d moves driven in %d ms at dpr %s: pointers +%d, queued +%d (of which %d "
                     "focus), coalesced +%d, dropped +%d; ring held %d of 256"
                     % (tag, row["dispatched"], row["streamMs"], row.get("dpr"), d["pointers"],
                        d["queued"], d["focus"], d["coalesced"], d["dropped"],
                        row["after"].get("pending", -1)))
        if proving:
            # THE GUARD IS IN PLACE: the one thing that must not happen is a pointer record.
            if d["pointers"]:
                bad.append("%s: %d pointer record(s) reached a process with "
                           "`if (!e.buttons) return;` in place" % (tag, d["pointers"]))
            continue
        # THE TRANSPORT CLAUSE, and it is the reason this file exists: if Firefox coalesced the
        # burst, the kernel would be credited for work the engine did.
        if d["pointers"] != row["dispatched"]:
            bad.append("%s: %d of %d driven moves became pointer records — THE ENGINE COALESCED, "
                       "so a kernel figure measured here is not the kernel's alone"
                       % (tag, d["pointers"], row["dispatched"]))
        if row["world"] == "append":
            if d["coalesced"]:
                bad.append("%s: an appending world coalesced %d record(s)" % (tag, d["coalesced"]))
            if row["holdMs"] and d["dropped"] <= 0:
                bad.append("%s: nothing was dropped into a HELD program, so the cap was never "
                           "reached and the overflow 223 predicted was not measured" % tag)
        if row["world"] == "coalesce":
            if d["dropped"]:
                bad.append("%s: tail replacement dropped %d record(s)" % (tag, d["dropped"]))
            if row["holdMs"] and (d["queued"] - d["focus"]) > 4:
                bad.append("%s: a held program's queue took %d records (less %d focus) from a "
                           "%d-move stream" % (tag, d["queued"], d["focus"], moves))
    return (not bad), notes, bad


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--moves", type=int, default=probe.MOVES)
    ap.add_argument("--world", action="append", default=[], choices=probe.WORLDS)
    ap.add_argument("--hold", type=int, default=probe.HOLD_MS,
                    help="`files --no-drain` ms; 0 for a draining program. Default: %d."
                         % probe.HOLD_MS)
    ap.add_argument("--prove-failure", action="store_true",
                    help="drive the same stream against the UNPATCHED tree; no pointer record may "
                         "reach a process. Exits 0 when the proof succeeded.")
    ap.add_argument("--out", default="")
    args = ap.parse_args(argv)

    worlds = ("off",) if args.prove_failure else (tuple(args.world) or ("append", "coalesce"))

    rows: list[dict] = []
    patches: dict[str, str] = {}
    try:
        for world in worlds:
            root = REPO
            tmp: pathlib.Path | None = None
            patch = probe.PATCHES[world]
            if patch is not None:
                tmp = pathlib.Path(os.environ.get("TMPDIR", "/tmp")) / ("webos-m19-ff-" + world)
                if tmp.exists():
                    shutil.rmtree(tmp)
                shutil.copytree(REPO, tmp, ignore=shutil.ignore_patterns(
                    ".git", "node_modules", "build", ".venv", "__pycache__"))
                patches[world] = patch(tmp)
                root = tmp
            print("world %-9s %s" % (world, patches.get(world, "the tree as it stands")),
                  file=sys.stderr)
            os.chdir(root)
            httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
            port = httpd.server_address[1]
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            base = "http://127.0.0.1:%d" % port
            print("  served %s from %s" % (base, root), file=sys.stderr)
            try:
                with bidi.Firefox(headless=not args.headed) as ff:
                    row = run_cell(ff, base, world, int(args.hold), args.moves)
                rows.append(row)
                d = row.get("delta") or {}
                print("  %-9s hold=%-7d state=%-7s pointers=%-4s queued=%-4s coalesced=%-4s "
                      "dropped=%s" % (world, args.hold, row.get("state"), d.get("pointers"),
                                      d.get("queued"), d.get("coalesced"), d.get("dropped")),
                      file=sys.stderr)
                if row.get("state") != "staged":
                    print("    %s" % row.get("why"), file=sys.stderr)
            finally:
                httpd.shutdown()
            if tmp is not None:
                shutil.rmtree(tmp, ignore_errors=True)
    finally:
        os.chdir(REPO)

    ok, notes, bad = judge(rows, args.moves, args.prove_failure)
    out_path = pathlib.Path(args.out) if args.out else HERE / "results-firefox.json"
    out_path.write_text(json.dumps(
        {"ok": ok, "moves": args.moves, "hold": args.hold, "worlds": list(worlds),
         "patches": patches, "notes": notes, "bad": bad, "rows": rows}, indent=2) + "\n")

    print()
    for note in notes:
        print("  %s" % note)
    print()
    if args.prove_failure:
        if not [r for r in rows if r.get("state") == "staged"]:
            print("--prove-failure: no cell staged a window, so nothing was proven.")
            print("wrote %s" % out_path)
            return 1
        if bad:
            print("--prove-failure: THE GUARD DID NOT HOLD in Firefox:")
            for line in bad:
                print("  %s" % line)
            print("wrote %s" % out_path)
            return 1
        print("--prove-failure: %d moves of REAL trusted input into the unmodified tree, and no "
              "process received one. The guard is what this gate is measuring." % args.moves)
        print("wrote %s" % out_path)
        return 0
    if bad:
        for line in bad:
            print("BAD  %s" % line)
        print("\nwrote %s" % out_path)
        return 1
    print("FIREFOX DELIVERS ONE POINTER RECORD PER DRIVEN MOVE, and the kernel's figures are the "
          "same as Chrome's.")
    print("wrote %s" % out_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
