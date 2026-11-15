#!/usr/bin/env python3
"""show.py <json> [key ...] — print an attack's evidence with the per-process boilerplate dropped."""
import json
import sys

DROP = {"clock", "envKeys", "envKinds", "abiFingerprint", "sinkSum", "sinkBytes",
        "sinkWrites", "calls", "replies", "isolated", "exiting", "ms", "pid",
        "fingerprint", "config"}


def strip(o):
    if isinstance(o, dict):
        return {k: strip(v) for k, v in o.items() if k not in DROP}
    if isinstance(o, list):
        return [strip(x) for x in o]
    return o


def main() -> int:
    d = json.load(open(sys.argv[1]))
    print("state", d["state"], "verdict", d["verdict"], "why", d.get("why", "")[:200])
    for f in d.get("faults", []):
        print("FAULT", f)
    for e in d.get("errors", [])[:6]:
        print("page error", e)
    for name in ("proof_a", "proof_b", "proof_c", "proof_d", "pending", "drop", "cas",
                 "orphan", "refuse", "order", "api"):
        p = d.get(name)
        if not p:
            continue
        ev = p.get("evidence") or {}
        keys = sys.argv[2:] or list(ev.keys())
        for k in keys:
            if k not in ev:
                continue
            print("==", name, k)
            print(json.dumps(strip(ev[k]), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
