#!/usr/bin/env python3
"""judge7.py <json ...> — the per-attack verdict fields, and every loss-shaped field at any depth.

The attacks do not share one convention: some return `ok` as "the system behaved correctly" and
some return `ok: false` unconditionally so the page prints their evidence. So this prints BOTH the
proof-level ok and the booleans the attack itself computed, and separately every field whose NAME
says something about a loss, wherever it sits.
"""
import json
import re
import sys

LOSS = re.compile(r"lost|silent|kept|intact|clean|consecutive|duplicates|vanish|survived|"
                  r"reverted|discarded|resurrect|short|missing|stale|refused|exhaust", re.I)
SKIP = ("clock", "envKeys", "envKinds", "per", "rounds", "notes", "diag")


def walk(prefix, o, hits, depth=0):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in SKIP:
                continue
            path = f"{prefix}.{k}" if prefix else k
            if isinstance(v, (dict, list)):
                walk(path, v, hits, depth + 1)
            elif LOSS.search(k):
                hits.append((path, v))
    elif isinstance(o, list):
        for i, v in enumerate(o[:4]):
            walk(f"{prefix}[{i}]", v, hits, depth + 1)


def main() -> int:
    for path in sys.argv[1:]:
        d = json.load(open(path))
        print("### %s  state=%s verdict=%s" % (path, d.get("state"), d.get("verdict")))
        for e in (d.get("errors") or [])[:4]:
            print("    page-error:", e[:180])
        for name in ("proof_a", "proof_b", "proof_c", "proof_d", "pending", "drop", "cas",
                     "orphan", "refuse", "order", "api"):
            p = d.get(name)
            if not p:
                continue
            ev = p.get("evidence") or {}
            print("  %s: attack-level ok=%s" % (name, p.get("ok")))
            flags = {k: v for k, v in ev.items() if isinstance(v, bool)}
            if flags:
                print("    attack flags:", json.dumps(flags))
            hits = []
            walk("", ev, hits)
            seen = set()
            for k, v in hits:
                key = (k, str(v))
                if key in seen:
                    continue
                seen.add(key)
                print("      %s = %s" % (k, json.dumps(v)[:90]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
