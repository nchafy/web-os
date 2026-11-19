#!/usr/bin/env python3
"""M8's mutation controls: break the surface accounting on purpose, and score WHICH checks move.

    python3 bench/m8-surface/controls.py
    python3 bench/m8-surface/controls.py --only leak-on-resize

`scripts/check.py --negative no-draw` proves M8 in a browser, where a real process draws real
pixels. It cannot reach the accounting: a budget is arithmetic over integers, and
`bench/m8-surface/probe.mjs` asserts it under node in milliseconds. THIS file proves that probe is
coupled to its subject, which inversion alone cannot — an assertion over a constant still inverts
and still fires.

Each mutation patches `src/kernel/wins.mjs` in place, runs the probe, and restores the file. SCORED
ON WHICH CHECKS MOVE, never on pass/fail: a mutation satisfied by any failure verifies nothing
about its own subject. The file is restored in a `finally`, and the restore is verified
byte-for-byte before the run exits.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[2]
SUBJECT = REPO / "src" / "kernel" / "wins.mjs"
PROBE = REPO / "bench" / "m8-surface" / "probe.mjs"
NODE = "node"

MUTATIONS = {
    "leak-on-resize": dict(
        why="a resize CHARGES THE NEW AREA WITHOUT RELEASING THE OLD, which is the obvious "
            "implementation and the one that exhausts a budget a program never exceeded: fifty "
            "resizes of one window and the system is full. The window still has exactly one "
            "surface, so the count stays right while the area does not — which is why the probe "
            "asserts both.",
        needle="""    this.stats.surfacePx += want - held;""",
        replacement="""    this.stats.surfacePx += want;""",
        moves=(
            "and charges the difference, not the sum",
            "and the budget shrinks to the smaller area",
        ),
    ),
    "no-revocation": dict(
        why="a destroyed window keeps its area charged. REVOCATION IS THE OTHER HALF OF "
            "ACCOUNTING and it is the half a transferred `OffscreenCanvas` could not have had "
            "(constraint 219): without it a long session runs out of surface it no longer has, "
            "and M12's governor would admit against a number that only ever grows.",
        # A NO-OP AND NOT AN INVERTED GUARD: inverting it made the function dereference a null
        # surface and the PROBE DIED, which scores nothing. The plausible defect is forgetting to
        # release at all.
        needle="""  releaseSurface(win) {
    if (!win.surface) return 0;""",
        replacement="""  releaseSurface(win) {
    if (win.surface || !win.surface) return 0;""",
        moves=(
            "destroying them all releases every pixel",
            "and the surface count returns to zero",
            "so the same size is granted again",
        ),
    ),
    "budget-as-eagain": dict(
        why="the budget answers -EAGAIN instead of -ENOMEM. A CEILING REPORTED AS A TRANSIENT: a "
            "caller told to try again would try for ever, because nothing is going to free the "
            "area it is waiting for. The errno is the only thing that tells a program whether to "
            "ask for less or to give up.",
        needle="""      this.stats.refusedSurface += 1;
      return -ENOMEM;""",
        replacement="""      this.stats.refusedSurface += 1;
      return -EINVAL;""",
        moves=(
            "the budget refuses with -ENOMEM",
        ),
    ),
    "draw-without-surface": dict(
        why="a draw on a window with NO SURFACE is accepted and forwarded. The page has no canvas "
            "for it, so the ops are replayed against nothing — and the program is told 0, which it "
            "reads as success. A silent discard, which is the one failure a user cannot diagnose.",
        needle="""    if (!win.surface) {
      win.stats.refusedDraws += 1;
      return -EINVAL;
    }""",
        replacement="""    if (false) {
      win.stats.refusedDraws += 1;
      return -EINVAL;
    }""",
        moves=(
            "a draw on a window with no surface is EINVAL",
            "and nothing was posted",
            "and the refusal is counted on the window",
            # AND THE COUNTS AFTER IT, declared rather than excused: the accepted batch is charged
            # to the window and to the table, so every count in that section is one too high. A
            # consequence of the one removal, and the harness refused this control until it was
            # written down.
            "charged to the window",
            "by op count and not byte count",
            "and to the table",
        ),
    ),
    "cells-after-surface": dict(
        why="a surfaced window ACCEPTS CELLS again. There is no text widget behind it — the page "
            "replaced it with a canvas — so the bytes are accepted, posted, and dropped by a host "
            "that has nowhere to put them. One content mode per window is the rule this removes.",
        needle="""    if (this.surface) {
      this.stats.goneWrites += 1;
      return -EINVAL;
    }""",
        replacement="""    if (false) {
      this.stats.goneWrites += 1;
      return -EINVAL;
    }""",
        moves=(
            "a surfaced window refuses them",
            "and the refusal is counted",
        ),
    ),
}


def run_probe() -> tuple:
    out = subprocess.run([NODE, str(PROBE)], capture_output=True, text=True, cwd=str(REPO))
    text = out.stdout.strip()
    start = text.find("{")
    if start < 0:
        return None, out.stderr.strip()
    return json.loads(text[start:]), out.stderr.strip()


def failures_of(report: dict) -> set:
    return {row["name"] for row in report.get("failures", [])}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only", action="append", default=[],
                    help="run one mutation by name; repeatable")
    args = ap.parse_args(argv)

    original = SUBJECT.read_text(encoding="utf-8")
    print("subject  %s (%d bytes)" % (SUBJECT.relative_to(REPO), len(original)))

    baseline, err = run_probe()
    if baseline is None:
        raise SystemExit("the probe printed no JSON report, so no mutation means anything:\n%s"
                         % err)
    if baseline["failed"]:
        print("BASELINE IS NOT CLEAN: %d of %d checks already fail.\n%s"
              % (baseline["failed"], baseline["total"],
                 json.dumps(baseline["failures"], indent=2)))
        return 2
    print("baseline %d checks, 0 failed\n" % baseline["total"])

    names = args.only or list(MUTATIONS)
    problems = []
    try:
        for name in names:
            if name not in MUTATIONS:
                print("no mutation named %r; have %s" % (name, ", ".join(MUTATIONS)))
                return 2
            spec = MUTATIONS[name]
            if spec["needle"] not in original:
                problems.append("%s: its needle is not in the subject any more, so the mutation "
                                "was never applied. The anchor moved; re-point it." % name)
                print("%s: NEEDLE NOT FOUND - not applied" % name)
                continue
            SUBJECT.write_text(original.replace(spec["needle"], spec["replacement"], 1),
                               encoding="utf-8")
            report, stderr = run_probe()
            if report is None:
                problems.append("%s: the probe died: %s"
                                % (name, stderr.splitlines()[-1] if stderr else "no stderr"))
                print("%-22s MIS-SCORED (the probe died)" % name)
                print()
                continue
            moved = failures_of(report)
            want = set(spec["moves"])
            missing = sorted(want - moved)
            extra = sorted(moved - want)
            ok = not missing and not extra
            print("%-22s %s" % (name, "ok" if ok else "MIS-SCORED"))
            print("    %d declared to move, %d moved, %d other checks held"
                  % (len(want), len(want & moved), report["total"] - len(moved)))
            if missing:
                print("    declared and HELD: %s" % ", ".join(missing))
                problems.append("%s: %s held, so the control's own subject is not asserted"
                                % (name, ", ".join(missing)))
            if extra:
                print("    moved and NOT declared: %s" % ", ".join(extra))
                problems.append("%s: %s moved and is not declared, so this mutation also breaks "
                                "something it is not about" % (name, ", ".join(extra)))
            print()
    finally:
        SUBJECT.write_text(original, encoding="utf-8")
        if SUBJECT.read_text(encoding="utf-8") != original:
            print("THE SUBJECT WAS NOT RESTORED. Fix %s before trusting anything."
                  % SUBJECT.relative_to(REPO))
            return 3
    after, _ = run_probe()
    if after is None or after["failed"]:
        print("the subject was restored byte-for-byte but the probe now fails; that is a bug in "
              "this harness, not a result")
        return 3
    if problems:
        print("MIS-SCORED:\n  - " + "\n  - ".join(problems))
        return 1
    print("every mutation moved exactly its declared checks; wins.mjs restored clean")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
