#!/usr/bin/env python3
"""Negative controls for the exec path, scored on WHICH LABELS MOVE.

WHY THIS FILE EXISTS. `src/kernel/exec.mjs` is the module that decides what bytes a process may
run, and three of its properties are invisible when they hold: the execute bit is checked, the
image cache cannot serve the wrong program, and NOTHING reaches the network. A suite that passes
over a loader which silently fetched would look exactly like this one. So each property gets a
mutation that removes it, and the mutation has to turn a NAMED set of `check_m5` expectations red.

`--negative spawn-self` is the browser control `scripts/check.py` owns, because its subject is
reachable from the page through a `cfg` hook. These four are not: a permanent kernel hook for each
would be four branches in the loader serving no caller. So the control edits the module IN PLACE
and restores it in `finally` — in place, because a control that copied the file elsewhere would
change the module graph and a crash is not a control.

HOW A CONTROL IS SCORED. Not on "the check failed" — on the SET of expectations that moved. A
control that moves a label it does not declare has broken something adjacent and proves nothing
about its own subject. `held` is derived, never listed, so a new expectation cannot be quietly
excused.

TWO OF THESE ARE BROAD AND SAY SO. Removing the linker or collapsing the cache key stops nearly
every program running, so they move most of the suite. That is declared rather than excused: a
broad control still earns its place when the thing it removes is load-bearing everywhere, and the
two NARROW controls — the execute bit and the network refusal — are what show the harness can tell
one defect from another.

    python3 bench/m5-exec/controls.py                 # every control
    python3 bench/m5-exec/controls.py url-fallback
"""

import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
EXEC = ROOT / "src" / "kernel" / "exec.mjs"
#: The interpreter `check.py` is re-run under: the repo's `.venv` where it exists, otherwise THIS
#: one. A hardcoded `.venv/bin/python` made the control unrunnable from a worktree that had no
#: venv of its own — it died with FileNotFoundError before mutating anything, which is a gate that
#: cannot report rather than a gate that passed, but is still a gate nobody can run.
#: `sys.executable` is a safe fallback precisely because this file is already running under it and
#: `check.py` needs the same one dependency (`websocket-client`) this process has.
_VENV = ROOT / ".venv" / "bin" / "python"
PYTHON = _VENV if _VENV.exists() else pathlib.Path(sys.executable)
CHECK = ROOT / "scripts" / "check.py"

#: Every label `check_m5` records. Derived from the check at run time, never copied here.
LABELS_FROM = ROOT / "scripts" / "check.py"

#: name -> (why, edits, labels that MUST fail)
#:
#: `edits` is a LIST of (anchor, replacement) pairs, because one of these controls needs two: a
#: cache defence has two halves and removing one of them proves nothing about the other. Every
#: anchor must be present or the control reports BROKEN rather than quietly editing nothing.
CONTROLS = {
    "no-exec-bit": (
        "`wantX` is dropped from the loader's `openDecision`, so the execute bit is not checked "
        "and any readable file is a program. THE NARROWEST CONTROL: it leaves every other property "
        "of the loader alone, so only the exec rows that turn on the bit may move — `a file with "
        "no execute bit is not a program` becomes a program that RUNS, which is a file nobody "
        "marked executable being evaluated in a process.",
        [('{ wantR: true, wantX: true }', '{ wantR: true }')],
        ("exec ok", "every exec row held", "verdict is ok"),
    ),
    "url-fallback": (
        "A path the FILESYSTEM cannot serve falls back to `fetch`, which is what `SYS_spawn` did "
        "before M5 (constraint 123). It is what shows the `no_url` section's PATH half is capable "
        "of failing: `/src/bin/true.mjs` is a real file on the server and is NOT in this system's "
        "filesystem, so a loader that reaches the network spawns that one and nothing else — the "
        "narrowest possible tell, and the reason that spelling is in the page's list.\n"
        "IT GOES IN THE `openDecision` CATCH AND NOT AT `resolveMount`, and that correction is "
        "worth recording: the first version guarded the mount lookup, which SUCCEEDS for "
        "`/src/bin/true.mjs` (the root mount owns the path) and fails one line later when the "
        "file is not there. The mutation never fired and the control reported MISSCORED — a "
        "control editing the wrong line looks exactly like a check that cannot fail.",
        [("""    } catch (error) {
      return errnoOfFsError(error);
    }
    if (decision.type !== FILE) return -EISDIR;""",
          """    } catch (error) {
      try {
        const res = await fetch(new URL(path, ctx.base).href, { cache: "no-store" });
        if (res.ok) return new Uint8Array(await res.arrayBuffer());
      } catch (e) { /* the control's own fallback */ }
      return errnoOfFsError(error);
    }
    if (decision.type !== FILE) return -EISDIR;""")],
        ("no_url ok", "every URL spelling was refused by the filesystem", "verdict is ok"),
    ),
    "trust-any-import": (
        "The import allowlist is removed: every specifier is rewritten through `new URL` instead "
        "of being compared against `PROGRAM_IMPORTS`. THE OTHER HALF of constraint 123, and the "
        "half the first version of this milestone got wrong — the kernel never calls `fetch`, so "
        "its own accounting stays at zero loads while the CHILD's module loader fetches and "
        "evaluates remote code. `//example.invalid/p.mjs` resolves OFF-ORIGIN through `new URL`, "
        "measured, so the mutation puts a real off-origin specifier in a real program image.",
        # RE-POINTED, and it was dead before this: the allowlist test became
        # `f.specifier` when the scanner started carrying its findings as objects, so this
        # control's anchor named a line that no longer existed and the harness refused to run it
        # rather than reporting "nothing moved". That refusal is why it was caught at all.
        [("    if (!PROGRAM_IMPORTS.includes(f.specifier)) {", "    if (false) {")],
        ("no_url ok", "and every import naming a host was refused by the linker",
         "verdict is ok"),
    ),
    "one-image": (
        "STAGE 1 of a two-stage control, and the one that must move NOTHING. The image cache key "
        "is collapsed to a constant, so every program after the first hits the same entry — which "
        "is the classic cache defect and is ABSORBED here, because a hit is confirmed by comparing "
        "the bytes. Nothing may change about what runs; only `hashCollisions` goes up.\n"
        "A control that proves a defence holds is worth as much as one that proves a check can "
        "fail, and `trust-the-hash` below is what stops this one being vacuous.",
        [('const key = `${hash}:${bytes.length}`;', 'const key = "one";')],
        (),
    ),
    "trust-the-hash": (
        "STAGE 2, and it is what makes stage 1 mean anything. The key is collapsed AND the byte "
        "comparison is removed, so a cache hit is believed. Every program after the first then "
        "RUNS THE FIRST PROGRAM'S CODE — the shell's, since that is what any proof loads first.\n"
        "This is the attack the comparison exists for: FNV-1a-32 collides on demand, so an "
        "unprivileged process can write a file whose hash and length match a program in "
        "`/usr/bin`, exec it once, and have a later `spawn` of the real program — from a root "
        "shell — run its bytes instead. If stage 1 passed either way, the comparison was testing "
        "nothing.",
        [('const key = `${hash}:${bytes.length}`;', 'const key = "one";'),
         ("        if (sameBytes(cached.source, bytes)) {", "        if (true) {")],
        None,   # measured; see MEASURED
    ),
}

#: The two broad controls' measured sets, recorded here after a --learn run so a later change that
#: narrows them is visible. Filled in below rather than left None, because a control with no
#: declaration is a control nobody scored.
MEASURED = {
    #: Measured on Chrome 157.0.8103.52 with `--learn`. The SHELL survives — it is the first
    #: program any proof loads, so it gets its own bytes and every program after it gets the
    #: shell's — which is why the builtins, the refusals and the URL refusals are NOT in this list.
    #: That is the tell: a cache that serves one program for all of them leaves the one that was
    #: loaded first working perfectly.
    "trust-the-hash": (
        "`ls /usr/bin | grep c | wc -l` printed the count this check worked out for itself",
        "`yes | head -1` terminated and printed one line",
        "a two-stage pipeline counts every name",
        "a typed line was echoed by the discipline and run by the shell",
        "and listed the shell that started it",
        "endless ok",
        "every exec row held",
        "every redirection row held",
        "exec ok",
        "jobs ok",
        "kill %1 resolved a job spec and the job died of SIGTERM",
        "pipeline ok",
        "ps listed the backgrounded sleep by pid",
        "ps printed the argv the job was given",
        "redirect ok",
        "tty ok",
        "verdict is ok",
    ),
}


def labels_of_m5():
    """`check_m5`'s inventory, read out of the check rather than copied."""
    text = LABELS_FROM.read_text()
    block = re.search(r"M5_LABELS = \((.*?)\n\)", text, re.S)
    if not block:
        return []
    return re.findall(r'^\s+"((?:[^"\\]|\\.)*)",', block.group(1), re.M)


def run_check():
    """`--only m5`, and the labels that failed. Returns (outcome, failed_labels, detail)."""
    r = subprocess.run(
        [str(PYTHON), str(CHECK), "--only", "m5"],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    out = r.stdout
    row = re.search(r"\[(\s*ok\s*|FAIL |BROKEN)\]\s+m5", out)
    if not row:
        tail = (out.strip().splitlines() or ["no output"])[-1]
        return "no-row", set(), tail[:200]
    outcome = row.group(1).strip().lower()
    failed = set()
    for line in out.splitlines():
        m = re.match(r"\s+m5: (.*?)(?: - | = )", line)
        if m:
            failed.add(m.group(1))
    return outcome, failed, ""


def main(argv):
    learn = "--learn" in argv
    wanted = [a for a in argv[1:] if not a.startswith("--")] or sorted(CONTROLS)
    unknown = [n for n in wanted if n not in CONTROLS]
    if unknown:
        print("unknown control(s): %s\nknown: %s"
              % (", ".join(unknown), ", ".join(sorted(CONTROLS))))
        return 2

    every = labels_of_m5()
    if len(every) < 30:
        print("BROKEN: read %d labels out of check.py's M5_LABELS, expected the full inventory"
              % len(every))
        return 2
    print("inventory: %d expectations in check_m5" % len(every))

    outcome, failed, detail = run_check()
    if outcome != "ok":
        # A control against a failing baseline says nothing: the labels were already moving.
        print("BROKEN: the baseline must pass before a control means anything (m5 came out %s%s)"
              % (outcome, (": " + detail) if detail else ""))
        return 2
    print("baseline: m5 passes\n")

    original = EXEC.read_text()
    problems = []
    learned = {}
    try:
        for name in wanted:
            why_text, edits, moves = CONTROLS[name]
            if moves is None:
                moves = MEASURED.get(name, ())
            missing_anchor = [a for a, _ in edits if a not in original]
            if missing_anchor:
                problems.append("%s: %d of its %d anchors are not in %s, so the control is not "
                                "editing the code it describes"
                                % (name, len(missing_anchor), len(edits), EXEC.name))
                print("%s: BROKEN - anchor missing\n" % name)
                continue
            mutated = original
            for anchor, replacement in edits:
                mutated = mutated.replace(anchor, replacement, 1)
            EXEC.write_text(mutated)
            outcome, got, detail = run_check()
            if outcome == "no-row":
                problems.append("%s: the check did not report a row: %s" % (name, detail))
                print("%s: BROKEN - %s\n" % (name, detail))
                continue
            if outcome == "broken":
                # BROKEN is not a satisfied control: nothing was measured, so the mutation proved
                # nothing about any expectation.
                problems.append("%s: m5 came out BROKEN, so no expectation was scored" % name)
                print("%s: BROKEN - the check could not measure\n" % name)
                continue
            learned[name] = tuple(sorted(got))
            if learn and CONTROLS[name][2] is None:
                print("%s: learned %d label(s) move" % (name, len(got)))
                for label in sorted(got):
                    print("    %s" % label)
                print()
                continue
            declared = set(moves)
            recorded = set(every)
            unknown_labels = sorted(declared - recorded)
            missing = sorted((declared & recorded) - got)
            extra = sorted(got - declared)
            ok = not missing and not extra and not unknown_labels
            print("%s: %s" % (name, "ok" if ok else "MISSCORED"))
            print("    %d declared to move, %d moved" % (len(declared), len(got)))
            for label in missing:
                problems.append("%s declares %r must fail and it passed, so the control's own "
                                "subject is not asserted" % (name, label))
                print("    did not move (declared): %s" % label)
            for label in extra:
                problems.append("%s moved %r, which it does not declare, so it broke something "
                                "adjacent" % (name, label))
                print("    moved (undeclared):      %s" % label)
            for label in unknown_labels:
                problems.append("%s declares %r, which check_m5 records no expectation by" %
                                (name, label))
                print("    not a recorded expectation: %s" % label)
            print("    %d other expectations held" % (len(every) - len(got)))
            print()
    finally:
        EXEC.write_text(original)

    outcome, failed, detail = run_check()
    if outcome != "ok":
        problems.append("the module was not restored cleanly: m5 came out %s" % outcome)

    if learn:
        print("MEASURED = {")
        for name, labels in sorted(learned.items()):
            print("    %r: (" % name)
            for label in labels:
                print("        %r," % label)
            print("    ),")
        print("}")
        return 0

    if problems:
        print("FAIL (%d):" % len(problems))
        for p in problems:
            print("  - %s" % p)
        return 1
    print("every control moved exactly its declared expectations; %s restored clean" % EXEC.name)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
