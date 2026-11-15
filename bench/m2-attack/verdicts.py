#!/usr/bin/env python3
"""verdicts.py <json ...> — the per-scenario pass/fail fields each round's attacks set.

Prints only the booleans and the small numbers, so a replay of twenty scenarios fits on a screen
without the per-process boilerplate.
"""
import json
import sys

KEEP = ("ok", "which", "lostSilently", "bothKept", "belowKept", "appendKept", "aKept", "bKept",
        "intact", "clean", "silent", "lost", "zeroes", "allZero", "size", "fdSize", "errno",
        "close", "fsync", "fsync1", "fsync2", "syncedAll", "wroteAll", "syncErrs", "writeErrs",
        "mountable", "problems", "threw", "at", "why", "read", "aBytes", "bBytes", "wantA",
        "wantB", "sizeMatches", "readMatches", "published", "publishedSize", "mode",
        "committedBytesIntact", "wantAtS", "atS", "byteAtOpenSize", "openSize", "divergence",
        "long", "short", "missing", "stale")


def flat(prefix, o, out):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in ("clock", "envKeys", "envKinds"):
                continue
            if isinstance(v, (dict, list)):
                flat(f"{prefix}.{k}" if prefix else k, v, out)
            elif k in KEEP:
                out.append(f"{prefix}.{k}={v}" if prefix else f"{k}={v}")
    elif isinstance(o, list):
        if prefix.rsplit(".", 1)[-1] in KEEP:
            out.append(f"{prefix}={json.dumps(o)[:160]}")


def main() -> int:
    for path in sys.argv[1:]:
        d = json.load(open(path))
        print(f"### {path}  state={d['state']} verdict={d['verdict']}")
        for e in d.get("errors", [])[:8]:
            print(f"    page-error: {e[:200]}")
        for name in ("proof_a", "proof_b", "proof_c", "proof_d", "pending", "drop", "cas",
                     "orphan", "refuse", "order", "api"):
            p = d.get(name)
            if not p:
                continue
            ev = p.get("evidence") or {}
            for scen, body in ev.items():
                out = []
                flat("", body, out)
                if out:
                    print(f"  [{name}/{scen}] " + "  ".join(out)[:1400])
    return 0


if __name__ == "__main__":
    sys.exit(main())
