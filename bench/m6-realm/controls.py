#!/usr/bin/env python3
"""The lockdown's mutation controls: break it on purpose, and score WHICH checks move.

    python3 bench/m6-realm/controls.py
    python3 bench/m6-realm/controls.py --only no-verify

`scripts/check.py --negative no-lockdown` and `--negative no-csp` prove the two halves of M6 in a
browser. They cannot reach the lockdown's own refusal: every target on Chrome 157 is configurable,
so `lockdown()` never throws there and the branch that refuses to evaluate program text has no
caller. `bench/m6-realm/probe.mjs` reaches it with a double; THIS file proves that probe is
coupled to its subject, which inversion alone cannot (an assertion over a constant still fires).

Each mutation patches `src/libos/lockdown.mjs` in place, runs the probe, and restores the file —
the same discipline as `bench/m5-exec/controls.py`. SCORED ON WHICH CHECKS MOVE, never on
pass/fail: a mutation satisfied by any failure verifies nothing about its own subject. The file is
restored in a `finally`, and the restore is verified byte-for-byte before the run exits.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
SUBJECT = REPO / "src" / "libos" / "lockdown.mjs"
PROBE = REPO / "bench" / "m6-realm" / "probe.mjs"

#: name -> (what it does, the needle, its replacement, the checks it must move).
#:
#: THE MOVED SET IS THE DECLARATION. A mutation whose set is empty, or which moves a check outside
#: it, fails this harness even though the probe "noticed something".
MUTATIONS = {
    "shallow": dict(
        why="`removeDeep` deletes only an OWN property, which is what the obvious one-line "
            "`delete obj[name]` does. Nothing in a worker realm is an own property: `fetch` is on "
            "WorkerGlobalScope.prototype and `storage` on WorkerNavigator.prototype, so the "
            "operator returns TRUE - its answer for 'there was nothing of mine to remove' - and "
            "every binding keeps working. The lockdown must then REFUSE, which is the behaviour "
            "that turns this mistake into a dead process instead of an open hole.",
        needle="""  for (let obj = target; obj !== null && obj !== undefined; obj = Object.getPrototypeOf(obj)) {""",
        replacement="""  for (let obj = target; obj === target; obj = Object.getPrototypeOf(obj)) {""",
        moves=(
            "a realistic scope strips without refusing",
            "every target is stripped from a realistic scope",
            "and none survives",
            "and the reachability test agrees",
            "a second lockdown reports everything absent and strips nothing",
            "an absent binding is reported absent",
        ),
    ),
    "no-verify": dict(
        why="the verification after the delete is removed, so `remaining` is always empty and the "
            "lockdown NEVER refuses. This is the mutation that matters: the report would read "
            "'everything stripped' over a realm that still reaches the kernel's volume, and a "
            "green check over an open hole is the worst outcome this harness can produce.",
        needle="""    if (target.name in obj) remaining.push(key);
    else stripped.push(key);""",
        replacement="""    stripped.push(key);""",
        moves=(
            "a realm that cannot be stripped throws",
            "and the message names a survivor",
            "and says why it refuses to continue",
        ),
    ),
    "credit-absent": dict(
        why="a binding the platform never exposed is counted as STRIPPED rather than ABSENT. The "
            "report then claims credit for removing `SharedWorker` and `importScripts`, which a "
            "Chrome module worker does not have - so a reader could not tell a stripped realm "
            "from a lucky one, and a future engine that DID expose them would look identical.",
        needle="""    if (!present) {
      absent.push(key);
      continue;
    }""",
        replacement="""    if (!present) {
      stripped.push(key);
      continue;
    }""",
        moves=(
            "an absent binding is reported absent",
            "and is not counted as stripped",
            "a second lockdown reports everything absent and strips nothing",
            # The empty-scope section asserts the same property from the other end - every row in
            # a realm with nothing in it is absent - so it is the same subject and is DECLARED
            # rather than excused. The harness refused the control until it was.
            "and every row in that realm is reported absent",
        ),
    ),
}


def run_probe() -> dict:
    out = subprocess.run([NODE, str(PROBE)], capture_output=True, text=True, cwd=str(REPO))
    text = out.stdout.strip()
    start = text.find("{")
    if start < 0:
        raise SystemExit("the probe printed no JSON report:\n%s\n%s" % (out.stdout, out.stderr))
    return json.loads(text[start:])


NODE = "node"


def failures_of(report: dict) -> set:
    return {row["what"] for row in report.get("failures", [])}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only", action="append", default=[],
                    help="run one mutation by name; repeatable")
    args = ap.parse_args(argv)

    original = SUBJECT.read_text(encoding="utf-8")
    print("subject  %s (%d bytes)" % (SUBJECT.relative_to(REPO), len(original)))

    baseline = run_probe()
    if baseline["failed"]:
        print("BASELINE IS NOT CLEAN: %d of %d checks already fail, so no mutation below means "
              "anything.\n%s" % (baseline["failed"], baseline["checks"],
                                 json.dumps(baseline["failures"], indent=2)))
        return 2
    print("baseline %d checks, 0 failed\n" % baseline["checks"])

    names = args.only or list(MUTATIONS)
    problems = []
    try:
        for name in names:
            if name not in MUTATIONS:
                print("no mutation named %r; have %s" % (name, ", ".join(MUTATIONS)))
                return 2
            spec = MUTATIONS[name]
            if spec["needle"] not in original:
                # A MUTATION THAT DID NOT APPLY MUST SAY SO. Silently running the unmutated file
                # and reporting "nothing moved" would read as a subject that is not covered.
                problems.append("%s: its needle is not in the subject any more, so the mutation "
                                "was never applied. The anchor moved; re-point it." % name)
                print("%s: NEEDLE NOT FOUND - not applied" % name)
                continue
            SUBJECT.write_text(original.replace(spec["needle"], spec["replacement"], 1),
                               encoding="utf-8")
            report = run_probe()
            moved = failures_of(report)
            want = set(spec["moves"])
            missing = sorted(want - moved)
            extra = sorted(moved - want)
            ok = not missing and not extra
            print("%-14s %s" % (name, "ok" if ok else "MIS-SCORED"))
            print("    %d declared to move, %d moved, %d other checks held"
                  % (len(want), len(want & moved), report["checks"] - len(moved)))
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
        restored = SUBJECT.read_text(encoding="utf-8")
        if restored != original:
            print("THE SUBJECT WAS NOT RESTORED. %s differs from what this run started with; fix "
                  "it before trusting anything." % SUBJECT.relative_to(REPO))
            return 3
    after = run_probe()
    if after["failed"]:
        print("the subject was restored byte-for-byte but the probe now fails; that is a bug in "
              "this harness, not a result")
        return 3
    if problems:
        print("MIS-SCORED:\n  - " + "\n  - ".join(problems))
        return 1
    print("every mutation moved exactly its declared checks; lockdown.mjs restored clean")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
