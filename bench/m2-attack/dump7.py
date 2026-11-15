#!/usr/bin/env python3
"""dump7.py <json> <scenario> — one scenario's whole evidence, with the per-process noise dropped."""
import json
import sys

NOISE = ("clock", "envKeys", "envKinds", "abiFingerprint", "sinkSum", "sinkBytes", "sinkWrites",
         "calls", "replies", "isolated", "exiting", "ms", "pid", "index", "errors")


def trim(o):
    if isinstance(o, dict):
        return {k: trim(v) for k, v in o.items() if k not in NOISE}
    if isinstance(o, list):
        return [trim(v) for v in o]
    return o


def main():
    d = json.load(open(sys.argv[1]))
    want = sys.argv[2] if len(sys.argv) > 2 else None
    for name in ("proof_a", "proof_b", "proof_c", "proof_d", "pending", "drop", "cas",
                 "orphan", "refuse", "order", "api"):
        p = d.get(name)
        if not p:
            continue
        ev = p.get("evidence") or {}
        for scen, body in ev.items():
            if want and scen != want:
                continue
            print("=== %s / %s" % (name, scen))
            print(json.dumps(trim(body), indent=1)[:6000])
    return 0


if __name__ == "__main__":
    sys.exit(main())
