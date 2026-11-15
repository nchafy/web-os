#!/usr/bin/env python3
"""diff6.py <before.json> <after.json> — what an attack's own verdict fields did.

The attack scripts each define their own clause names, so a fixed vocabulary of "loss fields"
cannot judge them: `committedBytesIntact` means "the byte at S is writer A's" and in a scenario
where A never wrote there, false is the correct answer. What CAN be judged mechanically is the
CHANGE: the same script, the same page, two trees.

Prints every boolean or small-integer leaf whose value moved, and nothing else. Timing, pids and
sizes-in-bytes-of-the-journal move run to run and are dropped by name.
"""
import json
import sys

NOISE = {"ms", "pid", "calls", "replies", "clock", "envKeys", "envKinds", "sinkSum", "sinkBytes",
         "sinkWrites", "t", "waitedMs", "attempts", "bytes", "parsedTo", "stoppedAt", "consumed",
         "journalAppends", "journalFlushes", "blobWrites", "blobFlushes", "swings", "copyUps",
         "immediateFrees", "deferredFrees", "casRefusals", "restages", "discardedStagings",
         "records", "firstSeq", "fingerprint", "abiFingerprint", "errors"}


def flat(node, path, out):
    if isinstance(node, dict):
        for k, v in node.items():
            if k in NOISE:
                continue
            flat(v, f"{path}.{k}" if path else k, out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            flat(v, f"{path}[{i}]", out)
    elif isinstance(node, bool):
        out[path] = node
    elif isinstance(node, (int, float)) and abs(node) < 100000:
        out[path] = node
    elif isinstance(node, str) and len(node) < 40:
        out[path] = node


def main() -> int:
    a, b = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
    fa, fb = {}, {}
    flat(a, "", fa)
    flat(b, "", fb)
    moved = [(k, fa[k], fb[k]) for k in sorted(set(fa) & set(fb)) if fa[k] != fb[k]]
    only_a = sorted(set(fa) - set(fb))
    only_b = sorted(set(fb) - set(fa))
    print(f"### {sys.argv[1]} -> {sys.argv[2]}  moved={len(moved)}")
    for k, x, y in moved:
        print(f"    {k}: {json.dumps(x)} -> {json.dumps(y)}")
    if only_a:
        print(f"    (gone from the after run: {len(only_a)}) {only_a[:8]}")
    if only_b:
        print(f"    (new in the after run: {len(only_b)}) {only_b[:8]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
