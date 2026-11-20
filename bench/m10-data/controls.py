#!/usr/bin/env python3
"""M10's mutation controls: break the data-object rules on purpose, and score WHICH checks move.

    python3 bench/m10-data/controls.py
    python3 bench/m10-data/controls.py --only leak-on-lost-drop

`scripts/check.py --negative text-only` and `--negative no-drop` prove M10 in a browser, where a
real mouse drags a real file between two processes. They cannot reach the ARITHMETIC: who holds a
reference, when the budget comes back, what a full queue does to a drop and where the idle bound
sits are functions of the table, and `bench/m10-data/probe.mjs` asserts them under node in
milliseconds. THIS file proves that probe is coupled to its subject, which inversion alone cannot -
an assertion over a constant still inverts and still fires.

EVERY ONE OF THESE MUTATIONS IS A PLAUSIBLE IMPLEMENTATION. Retaining a payload for a drop that was
never queued is what the obvious code does; releasing on a drop the target already collected is the
other half of the same mistake; and a drag session bounded by its own age rather than by idle time
is the bug `term` actually shipped (constraint 239). None of them has a symptom a user could
describe: the clipboard works, the drag works, and the kernel's budget quietly stops coming back.

Each mutation patches `src/kernel/dataobj.mjs` in place, runs the probe, and restores the file.
SCORED ON WHICH CHECKS MOVE, never on pass/fail: a mutation satisfied by any failure verifies
nothing about its own subject, and an EMPTY `moves` tuple is a mis-score rather than a pass
(constraint 237).
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[2]
SUBJECT = REPO / "src" / "kernel" / "dataobj.mjs"
PROBE = REPO / "bench" / "m10-data" / "probe.mjs"
NODE = "node"

MUTATIONS = {
    "leak-on-lost-drop": dict(
        why="the payload is retained for a drop whose event was never queued. THE OBVIOUS "
            "IMPLEMENTATION: retain, set the pending entry, report the effect, and only then look "
            "at whether the target actually took the record. `push` drops the NEWEST event, so a "
            "target whose queue is full never learns of the drop - and the object is then held for "
            "a collection that can never happen, which keeps the budget charged until that window "
            "dies (constraint 245). The source is also told an effect took place, so a MOVE source "
            "would delete the original.",
        needle="""      const queued = target.push({ type: WEV_DROP, a: x | 0, b: y | 0, c: obj.offer });
      if (queued) {""",
        replacement="""      const queued = target.push({ type: WEV_DROP, a: x | 0, b: y | 0, c: obj.offer });
      if (true) {""",
        # AND THE HOVER NEVER ENDS, which is the same mutation seen from the other side: with the
        # drop reported as delivered, the session ends believing the target got it — so the window
        # is never told the pointer left, and nothing ever will be.
        moves=(
            "the drop reports nothing happened",
            "it is counted as lost",
            "no payload is pending",
            "and the object is back to one reference",
            "so the budget comes back",
            "a drop that was lost still ends the hover",
            "the LEAVE was attempted",
        ),
    ),
    "repeatable-drop": dict(
        why="a collected drop is left in the pending map, so a target can open the same drop "
            "again and again - one reference handed out per open and never taken back. The "
            "symptom is a budget that never returns and a map that grows for the life of the "
            "window; there is nothing a user could see.",
        needle="""      this.pending.delete(win.id);""",
        replacement="""      if (win.id < 0) this.pending.delete(win.id);""",
        moves=(
            "a second open is ENOENT",
        ),
    ),
    "unsealed-publish": dict(
        why="publishing does not seal, so the source can rewrite the bytes two other processes "
            "are reading. The clipboard still works and the paste still arrives, which is exactly "
            "why this is the dangerous version: the defect only appears when somebody reads the "
            "same object twice and gets two answers (constraint 242).",
        needle="""  seal(obj) {
    if (obj.sealed) return 0;
    obj.sealed = true;""",
        replacement="""  seal(obj) {
    if (obj.sealed) return 0;
    obj.sealed = obj.id < 0;""",
        # AND THE CONSEQUENCE OF THE WRITE GOING THROUGH, which is what makes this mutation
        # worth having: the probe's next write REPLACES six bytes with one, so the clause that
        # reads the payload back after the creator's fd closed moves too. Declared rather than
        # trimmed away — it is the defect, observed one step later.
        moves=(
            "a published object is sealed",
            "so a write to it is EPERM",
            "and the bytes did not change",
            "and it is still in the table",
            "and the payload is sealed",
        ),
    ),
    "no-gesture-gate": dict(
        why="a drag may be started with no button down. A program can then hold the one session "
            "whenever it likes - and what ENDS a session is the page reporting a pointerup that "
            "is never coming, so every later drag is refused -EBUSY until the idle bound fires "
            "(constraint 244). The window that armed it need not even be the one under the "
            "pointer.",
        needle="""    if (!pointer || !pointer.down || pointer.win !== win.id) {
      this.stats.refusedDrag += 1;
      return -EPERM;
    }""",
        replacement="""    if (false) return -EPERM;""",
        # THE SESSION THE UNGATED CALL TOOK IS THE SECOND HALF, and it is the user-visible one:
        # the first `beginDrag` succeeds with no button down, so the LEGITIMATE drag that follows
        # is refused -EBUSY. A program that never asked for a drag cannot start one, and a program
        # that did cannot get one. (`and it is counted` is NOT declared: the refusal total happens
        # to land on the same number by a different route, which is why a control is scored on
        # named checks and not on a count.)
        moves=(
            "a drag with no button down is EPERM",
            "a press in ONE window does not arm a drag from another",
            "and the page is told, with the formats",
            "with a button down the drag begins",
            # AND THE FAIL-CLOSED HALF: with no gate at all, a pointer record the suppression
            # cleared is no longer consulted either, so the drag a stale `down` would have allowed
            # is simply allowed outright.
            "so a drag from the window that WAS pressed is refused",
            "a fresh press arms it again",
        ),
    ),
    "drag-over-per-sample": dict(
        why="every motion sample posts an ENTER to the target instead of only the edge. A drag is "
            "a pointer with a button down, so this streams at full rate: 256 records is one "
            "`WIN_EVENT_CAP`, about a second of moves, and `push` drops the NEWEST - which is the "
            "DROP itself. The feature every drag-and-drop API has, and the one this ABI leaves out "
            "on arithmetic (constraint 243).",
        needle="""    const id = target ? target.id : 0;
    if (id === this.drag.target) return id;""",
        replacement="""    const id = target ? target.id : 0;
    if (id === this.drag.target && id === 0) return id;""",
        moves=(
            "ten more samples over the same window queue nothing",
            "and post nothing",
            "the enter was counted once",
        ),
    ),
    "session-age-bound": dict(
        why="the drag session is bounded by its own AGE rather than by idle time. That is the bug "
            "`term` shipped and a reader found in five minutes (constraint 239): a slow careful "
            "drag across a desktop is a gesture that lasts as long as the user wants, and a bound "
            "on the whole gesture cancels it mid-flight with the pointer still down. The idle "
            "bound catches what actually goes wrong - a pointer that stopped reporting.",
        needle="""    const idle = K.now() - this.drag.lastMs;""",
        replacement="""    const idle = K.now() - this.drag.startedMs;""",
        # THE SECOND SAMPLE IS THE EDGE, and the later ones are not: the probe advances the clock
        # by just under the bound each time, so an AGE bound fires on sample 2 — and from then on
        # there is no session, so samples 3..6 hold for the wrong reason. Declaring them would have
        # been declaring a cascade rather than a subject.
        moves=(
            "a drag used past the bound survives (sample 2)",
            "so a gesture far longer than the bound is still live",
            # The cancellation then arrives EARLY, so the clause that asserts the ceiling fired at
            # the right time reads a tick with nothing left to cancel.
            "an idle one is cancelled",
        ),
    ),
    "leave-through-targetof": dict(
        why="the window being LEFT is resolved through `#targetOf`, which re-applies the blocked "
            "filter - so a window that was entered and then became BLOCKED mid-drag never gets "
            "its `WEV_DRAG_LEAVE`. A CRITIC FOUND THIS IN THE SHIPPED CODE. The receiver's hover "
            "frame then stays on screen for the rest of its life and its own enter/leave counts "
            "never balance. It is M9's rule read correctly: an ENTER offers something and is "
            "input, so a modal refuses it - a LEAVE retracts something already delivered, and a "
            "window that missed it would be wrong about the world once the modal went away.",
        needle="""    const was = this.drag.target ? this.#liveWindow(this.drag.target) : null;""",
        replacement="""    const was = this.drag.target ? this.#targetOf(this.drag.target) : null;""",
        # "a sample elsewhere leaves it" is NOT declared: its assertion is `dragAt(0) === 0`,
        # which is the new target's id and is 0 either way. The LEAVE record is the subject.
        moves=(
            "the LEAVE arrived",
            "and it is counted",
        ),
    ),
    "no-leave-on-end": dict(
        why="a session that ends WITHOUT delivering a drop does not tell the window it was over. "
            "The second instance of the same defect, found by reading the first: an idle "
            "cancellation and a drop whose event could not queue both left the receiver believing "
            "the pointer was still over it. A drop that LANDED is terminal and needs no leave, "
            "which is the half this mutation must not disturb.",
        needle="""    if (session.target && !(effect !== 0 && targetId === session.target)) {""",
        replacement="""    if (session.target && effect === -1) {""",
        moves=(
            "a cancelled drag leaves the window it was over",
            "the LEAVE was attempted",
        ),
    ),
    "blocked-is-a-target": dict(
        why="a window behind a modal may be dropped on. A drop is INPUT, and suppression that "
            "stops at keys and pointers leaves the gesture a user tries next: the same defect as "
            "a blocked window that could still be dragged around under its own dialog "
            "(constraint 233).",
        needle="""    if (wins.blockingFor(w)) return null;""",
        replacement="""    if (wins.blockingFor(w) && w.id < 0) return null;""",
        moves=(
            "a sample over a blocked window finds no target",
            "so no ENTER was queued for it",
            "and a release over it drops nothing",
        ),
    ),
    "offer-not-narrowed": dict(
        why="the offer mask is stored as asked for instead of being masked against the format "
            "table. A bit nobody defines then reaches a target as an offer, which the target will "
            "ask for and be refused - and an offer of nothing at all is accepted, so an object "
            "with no readers is created instead of the call being refused (constraint 240).",
        needle="""    let offer = 0;
    for (const f of fmtsOf(asked)) offer |= fmtBit(f);""",
        replacement="""    let offer = asked;""",
        moves=(
            "a mask outside the table is narrowed to it",
            "and an offer of only unknown formats is too",
            "the refusal is counted",
        ),
    ),
    "one-budget-for-two-ceilings": dict(
        why="the object's own ceiling answers -ENOMEM like the system's. Two facts, one errno: a "
            "program that asked for something impossible is told the system is full and will "
            "retry for ever, and a program that hit the real budget cannot tell that from its own "
            "mistake. M3's `truncate` answering ENOENT where it owed EROFS is the same defect, and "
            "only a per-call assertion catches it (constraint 246).",
        needle="""      this.stats.refusedBig += 1;
      return -EFBIG;""",
        replacement="""      this.stats.refusedBig += 1;
      return -ENOMEM;""",
        # ONE CHECK MOVES, AND THAT IS THE RESULT: the global-budget clauses assert that ENOMEM
        # appears and that EFBIG does NOT, and turning EFBIG into ENOMEM satisfies both. Only the
        # per-call assertion on the object's own ceiling can tell the two facts apart, which is the
        # whole argument for asserting each refusal by its own errno.
        moves=(
            "one byte past it is EFBIG",
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
            # AN EMPTY `moves` IS A MIS-SCORE, NOT A PASS. `want` and `moved` compared by set
            # difference let a mutation declaring nothing print `ok`, which is how M9's
            # `app-scope-is-own-pid` broke a rule, moved zero checks and was reported as verified
            # (constraint 237).
            if not spec["moves"]:
                problems.append("%s: declares no checks to move, so it cannot verify anything. "
                                "Give the probe a case this mutation breaks, or delete it." % name)
                print("%-28s MIS-SCORED (declares nothing to move)" % name)
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
                print("%-28s MIS-SCORED (the probe died)" % name)
                print()
                continue
            moved = failures_of(report)
            want = set(spec["moves"])
            missing = sorted(want - moved)
            extra = sorted(moved - want)
            ok = not missing and not extra
            print("%-28s %s" % (name, "ok" if ok else "MIS-SCORED"))
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
    print("every mutation moved exactly its declared checks; dataobj.mjs restored clean")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
