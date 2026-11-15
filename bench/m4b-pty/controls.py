#!/usr/bin/env python3
"""Negative controls for the pty probe, scored on WHICH LABELS MOVE.

WHY THIS FILE EXISTS. `bench/m4b-pty/probe.mjs` passed 94 assertions while three defects sat in
`src/kernel/pty.mjs`: an over-long canonical line wedged the terminal permanently, a `^D` typed
before the reader arrived was lost, and slave output past the 16 KiB ring was discarded with no
errno. None of the three produced an error, so none of the 94 noticed. The assertions that now
cover them are worth exactly as much as the demonstration that they can fail, which is this file.

HOW A CONTROL IS SCORED. Not on "the probe failed" — on the SET of expectations that moved. A
control that moves a label it does not claim has broken something adjacent and proves nothing
about its own subject (`docs/CONSTRAINTS.md`, and the same rule `scripts/check.py`'s `score()`
applies to the browser controls). So each row declares `moves`, and every other label in the probe
MUST hold. `held` is derived rather than listed, so a new assertion cannot be quietly excused.

WHY A MUTATION AND NOT A PAGE SWITCH. The browser controls in `scripts/check.py` arm a `cfg` hook
because their subject is reachable from the page. These four defects are gone; a permanent kernel
hook for each would be four branches in the line discipline's hot path serving no caller. So the
control edits the module IN PLACE and restores it in `finally` — in place because a control that
copied the file to a scratch directory produced `ERR_MODULE_NOT_FOUND`, which looked like a
failing check and was a BROKEN harness. A crash is not a control.

    python3 bench/m4b-pty/controls.py            # every control
    python3 bench/m4b-pty/controls.py eof-not-latched
"""

import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
PTY = ROOT / "src" / "kernel" / "pty.mjs"
PROBE = ROOT / "bench" / "m4b-pty" / "probe.mjs"

#: name -> (why, anchor, replacement, labels that MUST fail)
#:
#: Each replacement restores the ORIGINAL defect rather than inventing a new one, so the control
#: measures the fix that is actually in the file.
CONTROLS = {
    "overlong-discards-newline": (
        "The over-long branch counts the overflow and RETURNS, which is what it did before: the "
        "terminating newline is discarded with the overflow, so the line never commits, `line` "
        "stays full forever and every later keystroke is dropped. The terminal is wedged with no "
        "error anywhere — the reader simply parks. Measured before the fix: 4,106 bytes then a "
        "newline left linePending 4096 and linesReady 0.",
        """      this.stats.overlong += 1;
      this.#commitLine();
      if (this.line.pushByte(b) === 0) {""",
        """      this.stats.overlong += 1;
      this.stats.discarded += 1;
      return false;
      if (this.line.pushByte(b) === 0) {""",
        ("an over-long line still delivers",
         "and the line buffer is drained",
         "and a line was committed",
         "and the terminal still works afterwards"),
    ),
    "eof-not-latched": (
        "`^D` on an empty line wakes only the readers that are ALREADY parked, with nothing "
        "latched. A program that was computing when the key was pressed never sees the EOF and "
        "its next `read` parks forever. The overflow counter and the signal path are untouched, "
        "so this control says only that the LATCH is what delivers a late reader's EOF.",
        """          this.pendingEof = true;
          this.#wakeSlavesWithEof();""",
        """          this.#wakeSlavesWithEof();""",
        ("an EOF is latched, not lost",
         "so a reader arriving later sees it"),
    ),
    "output-drops-silently": (
        "`writeOutput` returns the ring's count on a full ring instead of parking the writer. "
        "That count is 0, `libos.write` breaks on 0 and reports a short write, and a program "
        "whose terminal is not being drained LOSES its output with no errno. Every downstream "
        "property goes with it — the wake, the EPIPE on master close, and the double-reply guard "
        "— because none of them have a parked writer to act on.",
        """    this.waitingWriters.push({ slot, seq, bytes: src.slice(), done: 0 });
    this.stats.writerParks += 1;
    return null;""",
        """    return n;""",
        ("a further write PARKS rather than returning 0",
         "the writer is recorded",
         "the master draining wakes the writer",
         "with its full count",
         "the writer parks",
         "closing the master replies to it",
         "with -EPIPE",
         "and raises SIGPIPE at the writer",
         "the signal is SIGPIPE",
         "a fatal SIGPIPE answers the call once",
         "and that one reply is teardown's"),
    ),
    "slave-always-writable": (
        "`writable` reports POLLOUT unconditionally, on the claim that neither direction of a pty "
        "ever refuses a write. False for the slave once its output ring fills: a poll-then-write "
        "loop then busy-spins on the kernel thread. ONE label moves, which is the point — the "
        "readable path, the parking and the wake are all independent of this answer.",
        """    return isMaster ? true : this.output.free > 0;""",
        """    return true;""",
        ("and is then not writable",),
    ),
    "master-close-loses-writers": (
        "Closing the master stops answering parked slave WRITERS. Nothing will ever drain the "
        "ring, so each one is parked on a wake that cannot arrive. The EOF half of the close is "
        "untouched, which is `docs/ABI.md` decision 5's asymmetry: a control that moved the "
        "reader's EOF too would mean the two directions were sharing an implementation.",
        """      const writers = this.waitingWriters;
      this.waitingWriters = [];
      for (const w of writers) {""",
        """      const writers = [];
      this.waitingWriters = [];
      for (const w of writers) {""",
        ("closing the master replies to it",
         "with -EPIPE",
         "and raises SIGPIPE at the writer",
         "the signal is SIGPIPE",
         "a fatal SIGPIPE answers the call once",
         "and that one reply is teardown's"),
    ),
}


def run_probe():
    """The probe's report, or (None, reason) when it did not produce one.

    A PROBE THAT CRASHES UNDER ITS OWN CONTROL IS BROKEN, NOT FAILING. Two of these controls did
    exactly that on first run — `slaveRead(...).n` on a parked read, and `groupSignals[0]` with no
    signal raised — and a crash cannot be distinguished from the defect it was meant to catch. The
    probe's accessors are total for that reason, and this function keeps the distinction visible.
    """
    r = subprocess.run(["node", str(PROBE)], capture_output=True, text=True, cwd=ROOT)
    if not r.stdout.strip():
        tail = (r.stderr.strip().splitlines() or ["no output at all"])[-1]
        return None, "the probe produced no report: %s" % tail[:160]
    try:
        return json.loads(r.stdout), None
    except json.JSONDecodeError as exc:
        return None, "the probe's report is not JSON: %s" % exc


def main(argv):
    wanted = argv[1:] or sorted(CONTROLS)
    unknown = [n for n in wanted if n not in CONTROLS]
    if unknown:
        print("unknown control(s): %s\nknown: %s" % (", ".join(unknown), ", ".join(sorted(CONTROLS))))
        return 2

    base, why = run_probe()
    if base is None:
        print("BROKEN: %s" % why)
        return 2
    if not base["ok"]:
        # A control against a failing baseline says nothing: the labels were already moving. This
        # is the check that made M4's first interruptibility experiment reportable.
        print("BROKEN: the baseline must pass before a control means anything (%d failed)"
              % base["failed"])
        return 2
    every = set(base["labels"])
    print("baseline: %d expectations, all passing\n" % base["total"])

    original = PTY.read_text()
    problems = []
    try:
        for name in wanted:
            why_text, anchor, replacement, moves = CONTROLS[name]
            if anchor not in original:
                problems.append("%s: its anchor is not in %s, so the control is not editing the "
                                "code it describes" % (name, PTY.name))
                print("%s: BROKEN - anchor missing\n" % name)
                continue
            PTY.write_text(original.replace(anchor, replacement, 1))
            out, crash = run_probe()
            if out is None:
                problems.append("%s: %s" % (name, crash))
                print("%s: BROKEN - %s\n" % (name, crash))
                continue

            failed = {f["name"] for f in out["failures"]}
            recorded = set(out["labels"])
            declared = set(moves)
            # A DECLARED LABEL THE PROBE DOES NOT RECORD IS A TYPO, not a passing check, and the
            # two need different diagnoses: "it passed" sent a reader looking at the behaviour
            # when the fault was in this file's spelling. Taken out of `missing` so each problem
            # names what actually went wrong.
            unknown = sorted(declared - recorded)
            missing = sorted((declared & recorded) - failed)
            extra = sorted(failed - declared)
            ok = not missing and not extra and not unknown
            print("%s: %s" % (name, "ok" if ok else "MISSCORED"))
            print("    %d declared to move, %d moved" % (len(declared), len(failed)))
            for label in missing:
                problems.append("%s declares %r must fail and it passed, so the control's own "
                                "subject is not asserted" % (name, label))
                print("    did not move (declared): %s" % label)
            for label in extra:
                problems.append("%s moved %r, which it does not declare, so it broke something "
                                "adjacent" % (name, label))
                print("    moved (undeclared):      %s" % label)
            for label in unknown:
                problems.append("%s declares %r, which the probe records no expectation by - so "
                                "the declaration names nothing and asserts nothing" % (name, label))
                print("    not a recorded expectation: %s" % label)
            print("    %d other expectations held" % (len(every) - len(failed)))
            print()
    finally:
        PTY.write_text(original)

    after, why = run_probe()
    if after is None or not after["ok"]:
        problems.append("the module was not restored cleanly: %s"
                        % (why or "%d expectations failing" % after["failed"]))

    if problems:
        print("FAIL (%d):" % len(problems))
        for p in problems:
            print("  - %s" % p)
        return 1
    print("every control moved exactly its declared expectations; %s restored clean" % PTY.name)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
