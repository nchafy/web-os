#!/usr/bin/env python3
"""Does each attack script's patch anchor still exist in the worktree it would be pointed at?

A reproduction whose anchor has drifted cannot be re-run, and an unrunnable reproduction MUST NOT
be reported as closed. This reads each script's own MAIN_OLD / CASE constants and counts them in
the current tree, so the tally can say "unrunnable" with a reason rather than guessing.
"""
import importlib.util
import pathlib
import sys

SRC = pathlib.Path("/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl")
TMP = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp")
PAGE = (SRC / "www" / "m2.html").read_text()
PROG = (SRC / "bench" / "fs-core" / "program.mjs").read_text()

NAMES = sys.argv[1:] or [
    "vattack", "vattack2", "vattack4", "vattack5b", "vattack6", "vattack7", "vattack8",
    "vattack9", "vattack12", "vattack14", "vattack15", "vattack16", "vattack18", "vattack19",
]

print("%-12s %-10s %-10s %s" % ("script", "page", "program", "verdict"))
for name in NAMES:
    path = TMP / (name + ".py")
    if not path.exists():
        print("%-12s %-10s %-10s %s" % (name, "-", "-", "ABSENT"))
        continue
    spec = importlib.util.spec_from_file_location("atk_" + name, path)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except SystemExit:
        pass
    except Exception as e:                                    # noqa: BLE001 report, never hide
        print("%-12s %-10s %-10s IMPORT FAILED: %s" % (name, "?", "?", e))
        continue
    main_old = getattr(mod, "MAIN_OLD", None)
    case = getattr(mod, "CASE", None)
    page_n = PAGE.count(main_old) if main_old else None
    prog_n = PROG.count(case[0]) if case else None
    ok = page_n == 1 and prog_n == 1
    print("%-12s %-10s %-10s %s" % (name, page_n, prog_n,
                                    "applies" if ok else "ANCHOR DRIFTED"))
