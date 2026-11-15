#!/usr/bin/env python3
"""Re-target the two mutations whose source lines the hardening pass changed.

The originals patched `cell(pooled, 0.99, 1000)` and `depth >= satTarget`; both are gone, so
these aim at whatever replaced them. If a mutation cannot be applied, that is reported rather
than counted as caught.
"""
import pathlib
import subprocess
import sys

MUT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut")
PY = "/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl/.venv/bin/python"
OUT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mutruns2")

MUTATIONS = {
    # H1's replacement: the headline quantile is now declared once. Swap the declaration itself,
    # which is strictly harder to catch than the old call-site swap.
    "headline-quantile-50": [("bench/syscall-contention/summarise.mjs",
                              "export const HEADLINE_QUANTILE = 0.99;",
                              "export const HEADLINE_QUANTILE = 0.50;")],
    # H4's replacement: the saturation latch.
    "sat-latch-1": [("src/kernel/kernel.mjs",
                     "if (depthTarget !== depthWindow && depth >= satTarget) {",
                     "if (depthTarget !== depthWindow && depth >= 1) {")],
    # And a new one the triage did not anticipate: the latch target itself is published and
    # asserted, so lie about it at the source instead of at the comparison.
    "sat-target-published-wrong": [("src/kernel/kernel.mjs",
                                    "    satTarget = saturateAt;",
                                    "    satTarget = 1;")],
}


def run(name):
    originals = {}
    for rel, old, new in MUTATIONS[name]:
        path = MUT / rel
        text = path.read_text(encoding="utf-8")
        if text.count(old) != 1:
            print("MUTATION %s  NOT-APPLICABLE: %r occurs %d times in %s"
                  % (name, old, text.count(old), rel))
            return
        originals[path] = text
        path.write_text(text.replace(old, new, 1), encoding="utf-8")
    try:
        proc = subprocess.run(
            [PY, str(MUT / "scripts" / "check.py"), "--only", "syscall",
             "--out", str(OUT / name)],
            capture_output=True, text=True, timeout=600)
    finally:
        for path, text in originals.items():
            path.write_text(text, encoding="utf-8")
    print("MUTATION %s  EXIT=%d" % (name, proc.returncode))
    for line in proc.stdout.splitlines():
        if any(k in line for k in ("[", "FAIL", "quantile", "witness", "saturat", "depth",
                                   "failure(s)", "passed")):
            print("   " + line[:200])
    if proc.stderr.strip():
        print("   --- stderr ---")
        print("   " + proc.stderr[-600:])


if __name__ == "__main__":
    for n in (sys.argv[1:] or list(MUTATIONS)):
        run(n)
        print()
