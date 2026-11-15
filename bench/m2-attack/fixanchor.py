#!/usr/bin/env python3
"""Re-point an older round's m2.html anchor at the proof list the current tree actually has.

The attack scripts assert their anchor matches exactly once, which is the right discipline — a
patch that silently no-ops would run the UNMODIFIED page and report it clean. So the anchor is
updated here rather than the assertion relaxed.

    fixanchor.py vattack.py vattack_r5.py
"""
import re
import sys
from pathlib import Path

CURRENT = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['order', ordering], ['api', apiSurface]]) {"""


def main() -> int:
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    text = src.read_text()
    m = re.search(r'^MAIN_OLD = """(.*?)"""', text, re.S | re.M)
    if not m:
        print(f"{src}: no MAIN_OLD", file=sys.stderr)
        return 1
    out = text[:m.start(1)] + CURRENT + text[m.end(1):]
    dst.write_text(out)
    print(f"{dst}: anchor re-pointed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
