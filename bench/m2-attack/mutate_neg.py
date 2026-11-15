#!/usr/bin/env python3
"""Apply one mutation and run check.py --negative kernel-stall."""
import pathlib
import subprocess
import sys

sys.path.insert(0, "/Users/chafyni/.claude/jobs/e856c39e/tmp")
import mutate  # noqa: E402

name = sys.argv[1]
originals = mutate.apply(name)
try:
    proc = subprocess.run(
        [mutate.PY, str(mutate.MUT / "scripts" / "check.py"),
         "--negative", "kernel-stall", "--only", "syscall",
         "--out", str(mutate.OUT / ("neg-" + name))],
        capture_output=True, text=True, timeout=600)
finally:
    for path, text in originals.items():
        path.write_text(text, encoding="utf-8")
print("MUTATION %s under --negative kernel-stall  EXIT=%d" % (name, proc.returncode))
print(proc.stdout[-4000:])
if proc.stderr.strip():
    print(proc.stderr[-1500:])
