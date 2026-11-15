#!/usr/bin/env python3
"""judge8.py <json ...> — one SUSPECT list per attack json.

judge7.py prints every loss-shaped field and leaves the reading to a human. This adds the step a
tally needs: a field is SUSPECT when its NAME says a loss and its value says that loss happened, or
when its name says an invariant and the value says it did not hold. Everything else is printed only
under --all.

The polarity table is the whole of it, and it is per name rather than per attack because the
attacks do not share a convention for `ok`.
"""
import json
import re
import sys

#: A name here means "true/non-zero is a LOSS".
BAD_IF_SET = re.compile(
    r"lost|silent|vanish|revert|resurrect|short|missing|duplicate|exhaust|refus|lie|wrong|"
    r"shrank|stale|threw|isDuplicate|isSkip|bad(Count)?$|err(Count|nos)?$|notes$", re.I)
#: A name here means "false is a LOSS".
BAD_IF_CLEAR = re.compile(
    r"kept|intact|clean|survive|consecutive|acknowledged|agree|whole|live$|held|ok$|"
    r"accepted|succeed", re.I)
SKIP = re.compile(r"clock|envKeys|envKinds|isolated|exiting|replies|abiFingerprint|^\.?diag$")


def walk(o, p="", out=None):
    out = [] if out is None else out
    if isinstance(o, dict):
        for k, v in o.items():
            if SKIP.search(k):
                continue
            walk(v, p + "." + k, out)
    elif isinstance(o, list):
        if not o:
            out.append((p, []))
        elif all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in o):
            out.append((p, o[:8]))
        else:
            for i, v in enumerate(o[:4]):
                walk(v, "%s[%d]" % (p, i), out)
    else:
        out.append((p, o))
    return out


def suspect(name, value):
    leaf = name.rsplit(".", 1)[-1]
    if SKIP.search(leaf):
        return False
    if isinstance(value, bool):
        if BAD_IF_SET.search(leaf) and value:
            return True
        return bool(BAD_IF_CLEAR.search(leaf)) and not value
    if isinstance(value, list):
        return bool(BAD_IF_SET.search(leaf)) and len(value) > 0
    if isinstance(value, (int, float)):
        return bool(BAD_IF_SET.search(leaf)) and value != 0
    return False


def main() -> int:
    paths = [a for a in sys.argv[1:] if not a.startswith("--")]
    show_all = "--all" in sys.argv
    worst = 0
    for path in paths:
        d = json.load(open(path))
        ev = {}
        for name in ("proof_a", "proof_b", "proof_c", "proof_d", "pending", "drop", "cas",
                     "orphan", "refuse", "order", "api"):
            p = d.get(name)
            if p:
                ev[name] = p.get("evidence") or {}
        rows = walk(ev)
        bad = [(k, v) for k, v in rows if suspect(k, v)]
        print("### %s  state=%s  %d suspect field(s) of %d"
              % (path, d.get("state"), len(bad), len(rows)))
        for e in (d.get("errors") or [])[:6]:
            print("    page-error:", e[:160])
        for k, v in bad:
            print("    SUSPECT %s = %s" % (k, json.dumps(v)[:120]))
        if show_all:
            for k, v in rows:
                print("      %s = %s" % (k, json.dumps(v)[:100]))
        worst = max(worst, len(bad))
    return 0


if __name__ == "__main__":
    sys.exit(main())
