#!/usr/bin/env python3
"""THE MUTATION PROOF for M21's two selfTest clauses in `src/abi.mjs`.

    python3 bench/m21-abi/mutate.py

INVERSION CANNOT PROVE EITHER CLAUSE. `--prove-failure` flips an expectation, and an assertion over
a constant still inverts and still fires (CLAUDE.md); what these two clauses own is a defect no
other clause in the file can see, so the only way to show they are alive is to introduce it.

Each mutant is written to a temp directory and IMPORTED, because `selfTest()` runs at module load:
a clause that fires makes the import itself throw, which is the property the file claims.

MUTANT A removes `realpath` from all three places and lowers NSYS to 62. The table is then
internally consistent with 62 calls, so every clause that checks the table against itself passes —
`SYS_NAME.length === NSYS`, the `INTS` prefix bijection, the uniqueness test — and only the ratchet
can tell that a published number is about to be reused.

MUTANT B renames the call on BOTH sides, `SYS_realpath` -> `SYS_canonpath` and the `SYS_NAME` row
with it. The prefix loop asserts the two sides AGREE, so it passes; only the clause that pins the
published NAME fires.

Exits 0 when both mutants fired with the expected message, 1 otherwise. A mutant that does NOT
throw is the finding: the clause it targets is dead.
"""
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = (ROOT / "src" / "abi.mjs").read_text()

MUTANTS = {}

# --- MUTANT A: a call removed and NSYS lowered with it ---------------------------------------
a = SRC.replace("  SYS_realpath: 62,\n  NSYS: 63,", "  NSYS: 62,")
a = a.replace("  SYS_utimes, SYS_realpath,\n  NSYS,", "  SYS_utimes,\n  NSYS,")
a = a.replace('  "utimes", "realpath",\n]);', '  "utimes",\n]);')
a = a.replace(
    '  if (SYS_realpath !== SYS_NAME.indexOf("realpath")) '
    'fail("SYS_realpath is not realpath\'s number");\n', "")
assert "SYS_realpath" not in a and a != SRC, "mutant A did not apply: src/abi.mjs moved under it"
MUTANTS["A (a published number reused)"] = (a, "NSYS is 62, below the 63 calls already published")

# --- MUTANT B: the call renamed on both sides -------------------------------------------------
b = SRC.replace("  SYS_realpath: 62,", "  SYS_canonpath: 62,")
b = b.replace("  SYS_utimes, SYS_realpath,", "  SYS_utimes, SYS_canonpath,")
b = b.replace('  "utimes", "realpath",', '  "utimes", "canonpath",')
b = b.replace('if (SYS_realpath !== SYS_NAME.indexOf("realpath"))',
              'if (SYS_canonpath !== SYS_NAME.indexOf("realpath"))')
b = b.replace('fail("SYS_realpath is not realpath\'s number")',
              'fail("SYS_canonpath is not realpath\'s number")')
assert b.count("SYS_canonpath") == 4, f"mutant B applied {b.count('SYS_canonpath')} of 4 edits"
MUTANTS["B (a published name renamed on both sides)"] = (
    b, "SYS_canonpath is not realpath's number")

failed = 0
with tempfile.TemporaryDirectory(prefix="m21-abi-mutate-") as tmp:
    for name, (text, want) in MUTANTS.items():
        path = os.path.join(tmp, "mutant.mjs")
        with open(path, "w") as fh:
            fh.write(text)
        run = subprocess.run([os.environ.get("NODE", "node"), "-e", f"import({path!r})"],
                             capture_output=True, text=True)
        # The MESSAGE line, not the source line the stack echoes: node prints the offending
        # `throw new Error(...)` verbatim, and that line contains "selfTest:" too.
        said = next((ln for ln in run.stderr.splitlines()
                     if ln.startswith("Error: abi.mjs selfTest:")), "")
        if run.returncode == 0:
            print(f"FAIL mutant {name}: the import did NOT throw — the clause is dead")
            failed += 1
        elif want not in said:
            print(f"FAIL mutant {name}: threw, but not the clause under test\n     {said.strip()}")
            failed += 1
        else:
            print(f"ok   mutant {name}\n     {said.strip()}")

print(f"\n{len(MUTANTS) - failed}/{len(MUTANTS)} mutant(s) fired the clause they target")
sys.exit(1 if failed else 0)
