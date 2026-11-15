#!/usr/bin/env python3
"""Build vattack16.py from vattack12_r5.py: the same two overlapping writers, 200 rounds.

Round 9 ran 16 rounds and exhausted the CAS's retry bound once. Both of the remaining
intra-operation windows the refactor permits — `writeFd` picking `live.id` and then awaiting the
write, and `commitOnce` reading its base and then awaiting a 260 us flush — are a few microseconds
wide, so 16 attempts is a thin sample. This raises it to 200 to find out whether the window is
merely narrow or genuinely unreachable from the harness.
"""
import pathlib
import sys

SRC = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/vattack12_r5.py")
DST = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/vattack16.py")


def main() -> int:
    t = SRC.read_text()
    assert t.count("const R9 = { rounds: 16,") == 1
    t = t.replace("const R9 = { rounds: 16,", "const R9 = { rounds: 200,")
    assert t.count('/mut/vatk12"') == 1
    t = t.replace('/mut/vatk12"', '/mut/vatk16"')
    DST.write_text(t)
    print("wrote", DST)
    return 0


if __name__ == "__main__":
    sys.exit(main())
