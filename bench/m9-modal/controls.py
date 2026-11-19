#!/usr/bin/env python3
"""M9's mutation controls: break the modality rules on purpose, and score WHICH checks move.

    python3 bench/m9-modal/controls.py
    python3 bench/m9-modal/controls.py --only backwards-subtree

`scripts/check.py --negative no-owner-chain` and `--negative no-modal` prove M9 in a browser, where
a real click is refused and real keys do not arrive. They cannot reach the WALK: who blocks whom at
each scope is a function of the table, and `bench/m9-modal/probe.mjs` asserts it under node in
milliseconds. THIS file proves that probe is coupled to its subject, which inversion alone cannot —
an assertion over a constant still inverts and still fires.

THE FIRST MUTATION IS THE DEFECT THIS MILESTONE ACTUALLY SHIPPED FOR AN HOUR. The blocker walk
excluded the RAISING window's subtree instead of the MODAL's — the same sentence read backwards —
so a save dialog could not block the editor that owns it. The stack order looked right the whole
time, because a dialog rides up with its owner either way; what gave it away was typing into the
blocked window. It is a mutation now so it cannot come back quietly.

Each mutation patches `src/kernel/wins.mjs` in place, runs the probe, and restores the file. SCORED
ON WHICH CHECKS MOVE, never on pass/fail: a mutation satisfied by any failure verifies nothing
about its own subject.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[2]
SUBJECT = REPO / "src" / "kernel" / "wins.mjs"
PROBE = REPO / "bench" / "m9-modal" / "probe.mjs"
NODE = "node"

MUTATIONS = {
    "backwards-subtree": dict(
        why="the blocker walk excludes the RAISING window's subtree instead of the MODAL's. The "
            "same sentence read backwards, and the defect M9 shipped for an hour: a save dialog "
            "IS its editor's child, so the editor was excluded from being blocked by its own "
            "dialog. Measured in a browser - the editor's keys arrived, `suppressed` stayed at 0 "
            "and the raise was granted - and the stack order looked RIGHT the whole time, because "
            "a dialog rides up with its owner either way.",
        needle="""      if (this.subtree(b).some((w) => w.id === win.id)) continue;""",
        replacement="""      if (this.subtree(win).some((w) => w.id === b.id)) continue;""",
        # SCORED FROM THE RUN AND NOT FROM A GUESS. The mutation inverts the exclusion, so it
        # does not merely stop blocking: it starts blocking the wrong windows. Both directions are
        # declared — the clauses that go RED because a real block disappeared, and the ones that
        # go red because a window that must stay free is now blocked.
        moves=(
            # the blocks that disappear
            "a window-modal dialog blocks the window that owns it",
            "an app-modal dialog blocks the owner",
            "the topmost blocker is the one reported",
            "and it follows the stack",
            "the raise is refused with the blocker",
            "no stack was posted",
            "but the refusal was",
            "naming both windows",
            "and it is counted",
            "a key to a blocked window is refused",
            "and counted on that window",
            "and in the table",
            "a pointer is suppressed too",
            "and the window has them",
            # and the windows that are now blocked and must not be: a modal's own child, and the
            # queue that is no longer written because the wrong window was suppressed.
            "and its own child is still free",
            "and still not its own child",
            "nothing was queued",
            # AND THE THREE-PROCESS CHAIN, which is the same exclusion read at depth 2.
            "an app-modal dialog blocks the window it is attached to",
            "a raise of the attached window is refused",
            "the order carries who is blocked",
        ),
    ),
    "app-scope-is-own-pid": dict(
        why="app scope asks the DIALOG's pid instead of its OWNER's. That is the whole point of a "
            "broker: a picker's dialog runs in the picker and is owned by the requesting app's "
            "window, so it is the APP that must be blocked. With this mutation a broker blocks "
            "itself and leaves the app it was asked to block running - and because this probe's "
            "fixture has the dialog in the owner's own process for the window-scope cases, the "
            "clause that moves is the CROSS-PROCESS one.\n\n"
            "THIS CONTROL MOVED NOTHING AND WAS SCORED AS A PASS. Every fixture owned at depth 1 "
            "and in one process, so asking the dialog's pid gave the same answer as asking its "
            "owner's for all 58 checks. The probe now carries a THREE-PROCESS chain, which is "
            "also the fixture that caught `appOf` reading the chain from the wrong end.",
        needle="""      else if (b.scope === WMODAL_APP) blocks = this.appOf(b) === win.pid;""",
        replacement="""      else if (b.scope === WMODAL_APP) blocks = b.pid === win.pid;""",
        moves=(
            "an app-modal dialog blocks the window it is attached to",
            "and that window's process sibling",
            "a raise of the attached window is refused",
            "the order carries who is blocked",
        ),
    ),
    "silent-create": dict(
        why="a new window goes on the stack and the page is never told the order. The kernel is "
            "RIGHT and the screen is wrong, which is the hardest version of this bug to see: the "
            "page assigns a `z-index` only when it renders an order, so a window that had been "
            "clicked carries one and a window created after it carries none - and the new window "
            "paints BEHIND it. The old probe reset its post log after the creates, so the missing "
            "post had already been thrown away before anything looked.",
        needle="""    });
    this.postStack();
    return win;
  }""",
        replacement="""    });
    return win;
  }""",
        moves=(
            "creating a window posts the order",
            "in that order",
            "a second create posts the order again",
            "with the new window on top",
            "and nothing is blocked",
        ),
    ),
    "passive-takes-stack": dict(
        why="a PASSIVE window raised directly goes to the top of the GLOBAL stack. `src/abi.mjs` "
            "defines it as 'raised WITH its owner and never above a sibling', and a click lands "
            "on a tooltip's frame like any other - so without the redirect a status bubble ends "
            "up above its owner's siblings and above other processes' windows.",
        needle="""    if (win.mode === WMODE_PASSIVE) {
      const up = this.ancestors(win).find((a) => a.mode !== WMODE_PASSIVE);
      if (up) return this.raise(up);
    }""",
        replacement="""    if (win.mode === WMODE_PASSIVE && win.id < 0) return null;""",
        moves=(
            "its owner came up with it",
            "so it is not above a stranger on its own",
        ),
    ),
    "no-blocked-set": dict(
        why="the order goes out without the blocked set. Suppression then covers the client area "
            "and not the frame: a drag and an arrow-key move are page-side from end to end, so a "
            "window behind a modal cannot be typed into or raised and can still be dragged "
            "around under it.",
        needle="""    const blocked = this.anyBlocking()
      ? this.live().filter((w) => this.blockingFor(w)).map((w) => w.id)
      : [];""",
        replacement="""    const blocked = [];""",
        moves=(
            "the order carries who is blocked",
        ),
    ),
    "no-riders": dict(
        why="a raise moves the window alone, which is `PLAN.md` section 5's own control for M9 - "
            "'remove the owner chain; the dialog must fall behind' - and constraint 44's defect: "
            "'without an owner chain a dialog sits behind the window that owns it'.",
        needle="""    const riders = ownerChain
      ? this.subtree(win).filter((w) => w !== win && w.ridesWithOwner())
      : [];""",
        replacement="""    const riders = [];""",
        moves=(
            "and its palette and tooltip ride above it",
            # A PASSIVE WINDOW'S REDIRECT RAISES ITS OWNER AND THE TOOLTIP RIDES BACK UP, so with
            # no riders the pair comes apart - which is the same defect this control is about.
            "its owner came up with it",
            "so it is not above a stranger on its own",
            # "and it follows the stack" is DECLARED NOT TO MOVE and it took a run to see why: the
            # window being raised moves either way, and that clause is about the topmost BLOCKER
            # following the stack, not about its riders.
        ),
    ),
    "suppress-everything": dict(
        why="a blocked window is denied EVERY event, not just input. It then never learns that it "
            "was resized, asked to close or destroyed - so once the modal goes away it is wrong "
            "about the world, and a close request made while a dialog was up is lost for ever.",
        needle="""    if (ev.type === WEV_KEY || ev.type === WEV_POINTER) {""",
        replacement="""    if (ev.type !== 0) {""",
        moves=(
            "a resize still arrives",
            "a close request still arrives",
            "and the window has them",
        ),
    ),
    "stale-stack": dict(
        why="a destroyed window keeps its place in the stack. `blockingFor` then keeps finding a "
            "modal that no longer exists, so the window it blocked can never be raised or typed "
            "into again - a desktop permanently modal to a dialog nobody can see.",
        needle="""      this.stack = this.stack.filter((id) => id !== w.id);""",
        replacement="""      if (w.id < 0) this.stack = [];""",
        moves=(
            "a destroyed window leaves the stack",
            # AND NOTHING ELSE, WHICH IS A RESULT: the two consequences this control claimed —
            # a modal that keeps blocking after it is destroyed, and a stale table — do not
            # happen, because `blockingFor` walks `live()` and a destroyed window is not in it.
            # So the stack cleanup matters for the ORDER the page is sent and not for blocking,
            # and `live()` is what makes that true (constraint 226).
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
            # AN EMPTY `moves` IS A MIS-SCORE, NOT A PASS. `want` and `moved` were compared by set
            # difference, so a mutation declaring nothing had no missing and no extra and printed
            # `ok` — which is how `app-scope-is-own-pid` broke the APP-scope rule, moved zero
            # checks, and was reported as verified for as long as it existed. A control must move a
            # NAMED subset (CLAUDE.md), and the empty set is not one (constraint 237).
            if not spec["moves"]:
                problems.append("%s: declares no checks to move, so it cannot verify anything. "
                                "Give the probe a case this mutation breaks, or delete it." % name)
                print("%-22s MIS-SCORED (declares nothing to move)" % name)
                print()
                continue
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
