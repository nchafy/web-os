#!/usr/bin/env python3
"""M7's mutation controls: break the window on purpose, and score WHICH checks move.

    python3 bench/m7-win/controls.py
    python3 bench/m7-win/controls.py --only no-cascade

`scripts/check.py --negative win-first-fd` and `--negative no-cascade` prove M7 in a browser, where
a real process waits on real fds. They cannot reach the record floor, the bounded overflow or the
id-reuse rule: those are properties of one kernel object, and `bench/m7-win/probe.mjs` asserts them
under node in milliseconds. THIS file proves that probe is coupled to its subject, which inversion
alone cannot — an assertion over a constant still inverts and still fires.

Each mutation patches `src/kernel/wins.mjs` in place, runs the probe, and restores the file — the
same discipline as `bench/m6-realm/controls.py`. SCORED ON WHICH CHECKS MOVE, never on pass/fail: a
mutation satisfied by any failure verifies nothing about its own subject. The file is restored in a
`finally`, and the restore is verified byte-for-byte before the run exits.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[2]
SUBJECT = REPO / "src" / "kernel" / "wins.mjs"
PROBE = REPO / "bench" / "m7-win" / "probe.mjs"
NODE = "node"

#: name -> (what it does, the needle, its replacement, the checks it must move).
#:
#: THE MOVED SET IS THE DECLARATION. A mutation whose set is empty, or which moves a check outside
#: it, fails this harness even though the probe "noticed something".
MUTATIONS = {
    "unbounded": dict(
        why="the queue stops being bounded: the overflow check goes and `ByteRing.push` takes what "
            "fits, so a window whose process stopped reading silently loses the tail of every "
            "event batch and the dropped counter stays at zero. This is M1's item (e) — a bound "
            "and a DEFINED overflow, charged per fd — and the counter is what makes the loss "
            "diagnosable rather than a window that just misses keys.\n\n"
            "The sibling mutation that this one replaces — making the whole-record guard "
            "`free <= 0` instead of `free < WEV_BYTES` — moved NOTHING, and that is a result "
            "rather than a defect in this harness: the ring's capacity is a whole number of "
            "records and every push and shift is a whole record, so the two tests are the same "
            "test. The guard is kept as the statement of that invariant and `src/kernel/wins.mjs` "
            "says so where it sits.",
        needle="""    if (this.events.free < WEV_BYTES) {
      this.stats.dropped += 1;
      return false;
    }""",
        replacement="""    if (this.events.free < WEV_BYTES) {
      this.events.shift(new Uint8Array(WEV_BYTES), 0, WEV_BYTES);
    }""",
        moves=(
            "the next is refused",
            "and counted",
            "the record that comes out is the oldest, not the newest",
        ),
    ),
    "no-floor": dict(
        why="the read is no longer floored to whole records, so a buffer of 2.3 records comes back "
            "with a torn tail and the decoder — which refuses a length that is not a multiple of "
            "the record size — throws inside a program instead.",
        needle="""    const whole = want - (want % WEV_BYTES);""",
        replacement="""    const whole = want;""",
        moves=(
            "a read is floored to whole records",
            "so the third is still queued",
            "and the two that came out are whole",
        ),
    ),
    "no-cascade": dict(
        why="destroying a parent destroys only the parent, which is the obvious implementation and "
            "the one that leaves a dialog on screen over a window that is gone. The caller is then "
            "told one id for an operation that should have closed three, so its fd table "
            "disagrees with the kernel's — the desynchronisation the destroy list exists to stop.",
        needle="""      for (const childId of [...w.children]) {
        const child = this.get(childId);
        if (child && !child.destroyed) walk(child);
      }""",
        replacement="""      if (w.id < 0) walk(w);""",
        moves=(
            "destroying the root reports every id, ancestor first",
            "and every one of them is destroyed",
            "and the list it is told is the same one the caller got",
            "the cascade is counted as the EXTRA windows it took",
        ),
    ),
    "notice-too-late": dict(
        why="`destroyed` goes up BEFORE the last record is queued, so `push` refuses its own "
            "destroy notice and the window answers -EHOSTGONE with nothing saying why. A process "
            "whose window was destroyed under it then cannot tell that from a window that was "
            "never there, and the cross-process case — a parent in another process taking a child "
            "down — has no event at all.",
        needle="""    this.push(notice);
    this.destroyed = true;""",
        replacement="""    this.destroyed = true;
    this.push(notice);""",
        moves=(
            "a destroyed window has exactly one record left",
            "and it is WEV_DESTROYED",
            "naming the window that went",
            # "the next read is -EHOSTGONE" HOLDS under this mutation and is DECLARED NOT TO
            # MOVE: a destroyed window refuses later reads either way. What this mutation takes
            # away is the ONE record that says why, which is what the labels below assert. The
            # count moves because the refusal now happens one read earlier.
            "and it is counted",
            "the first is answered with a record",
            "and the record is the destroy notice",
        ),
    ),
    "reuse-ids": dict(
        why="winids are reused once the table drops a row. An owner winid held by ANOTHER process "
            "then comes to name a different window, so a dialog parents itself onto a stranger — "
            "the reason pids are never reused either (constraint 13).",
        needle="""    const id = this.nextId;
    this.nextId += 1;""",
        replacement="""    const id = this.byId.size + 1;""",
        moves=(
            "the next window gets a fresh id",
        ),
    ),
}


def run_probe() -> tuple:
    """(report, stderr). A report of None means the probe DIED, which for one mutation below is the
    declared outcome: a torn record must make a program fail loudly rather than decode as noise."""
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

    baseline, baseline_err = run_probe()
    if baseline is None:
        raise SystemExit("the probe printed no JSON report, so no mutation below means "
                         "anything:\n%s" % baseline_err)
    if baseline["failed"]:
        print("BASELINE IS NOT CLEAN: %d of %d checks already fail, so no mutation below means "
              "anything.\n%s" % (baseline["failed"], baseline["total"],
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
                # A MUTATION THAT DID NOT APPLY MUST SAY SO. Silently running the unmutated file
                # and reporting "nothing moved" would read as a subject that is not covered.
                problems.append("%s: its needle is not in the subject any more, so the mutation "
                                "was never applied. The anchor moved; re-point it." % name)
                print("%s: NEEDLE NOT FOUND - not applied" % name)
                continue
            SUBJECT.write_text(original.replace(spec["needle"], spec["replacement"], 1),
                               encoding="utf-8")
            report, stderr = run_probe()
            if "crashes" in spec:
                # A DECLARED CRASH IS SCORED ON ITS MESSAGE, not on the exit status: a probe that
                # died for some unrelated reason would otherwise pass this control.
                died = report is None
                named = spec["crashes"] in stderr
                print("%-16s %s" % (name, "ok" if died and named else "MIS-SCORED"))
                if not died:
                    problems.append("%s: the probe survived, so the mutation's consequence is not "
                                    "what this control declares" % name)
                    print("    the probe survived; %d checks failed" % report["failed"])
                elif not named:
                    problems.append("%s: the probe died but did not name %r, so it may have died "
                                    "of something else" % (name, spec["crashes"]))
                    print("    died without naming %r:\n%s" % (spec["crashes"], stderr))
                else:
                    print("    the probe died naming %r, which is the declared consequence"
                          % spec["crashes"])
                print()
                continue
            if report is None:
                problems.append("%s: the probe died, and this mutation does not declare a crash: "
                                "%s" % (name, stderr.splitlines()[-1] if stderr else "no stderr"))
                print("%-16s MIS-SCORED (the probe died)" % name)
                print()
                continue
            moved = failures_of(report)
            want = set(spec["moves"])
            missing = sorted(want - moved)
            extra = sorted(moved - want)
            ok = not missing and not extra
            print("%-16s %s" % (name, "ok" if ok else "MIS-SCORED"))
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
        restored = SUBJECT.read_text(encoding="utf-8")
        if restored != original:
            print("THE SUBJECT WAS NOT RESTORED. %s differs from what this run started with; fix "
                  "it before trusting anything." % SUBJECT.relative_to(REPO))
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
