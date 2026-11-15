#!/usr/bin/env python3
"""judge6.py <attack json ...> — every loss indicator an attack script sets, found mechanically.

The attack scripts report their own verdicts under a small vocabulary of field names. This walks
the evidence and prints every field whose value SAYS A LOSS HAPPENED, with its path. A script with
no hits is closed against this tree; a script with hits names what is still open.

The rule per field is written beside it. A field nobody set is not a pass and not a failure: it is
absent, and absent is reported at the end so a renamed field cannot read as "closed".
"""
import json
import sys

# field -> (predicate on the value, what a hit means)
BAD = {
    "lostSilently": (lambda v: v is True, "acknowledged bytes gone with every call returning 0"),
    "victimKept": (lambda v: v is False, "the victim's acknowledged bytes are not in the file"),
    "bothKept": (lambda v: v is False, "one of the two writers' acknowledged ranges is gone"),
    "allKept": (lambda v: v is False, "one of the writers' acknowledged ranges is gone"),
    "stageKept": (lambda v: v is False, "the staged write is gone"),
    "revertedToStaleTail": (lambda v: v is True, "the bytes reverted to a superseded generation"),
    "revertedToTheStaleTail": (lambda v: v is True, "the bytes reverted to a superseded generation"),
    "isDuplicate": (lambda v: v is True, "two journal records share one sequence number"),
    "isSkip": (lambda v: v is True, "a journal sequence number is missing"),
    "duplicates": (lambda v: isinstance(v, int) and v > 0, "duplicated journal sequence numbers"),
    "firstBreakAt": (lambda v: isinstance(v, int) and v >= 0,
                     "the journal's sequences are not consecutive"),
    "divergence": (lambda v: isinstance(v, (int, float)) and v != 0,
                   "read and stat disagree about where the file ends"),
    "allZero": (lambda v: v is True, "the range read as zeroes"),
    "zeroes": (lambda v: isinstance(v, int) and v > 0, "bytes that should hold data read as zero"),
    "foreignBytes": (lambda v: isinstance(v, int) and v > 0,
                     "bytes from a generation nobody published"),
    "silent": (lambda v: v is True, "a loss with no error reported"),
    "lost": (lambda v: v is True, "a loss"),
}

#: Reported, never counted. `committedBytesIntact` is here rather than in BAD because it is
#: SCENARIO-RELATIVE: `wpeek` asks whether the byte at the seeded size is writer A's 0xa1, and in a
#: scenario where A never wrote there, false is the correct answer. Measured both ways in
#: vattack14's `slackrevert`: false before the fix with the stale tail 0xc3 at that offset, false
#: after it with the victim's 0xb2. The field that moved is `victimKept`.
#: A retry answering 0 is CORRECT once the stage survives the refusal —
#: the clause is whether the data is in the file, which the attack's own byte fields carry — so
#: this would otherwise flag the fix as the defect.
INFO = {"retrySaid", "retries", "refusals", "casExhausted", "committedBytesIntact",
        "atS", "wantAtS"}

#: A mount verdict, and only these two values are a failure. `mode` is also the name every process
#: row uses for its program mode, so the VALUE is what decides rather than the key.
MOUNT = {"mode", "mountable"}
MOUNT_BAD = {"ro", "refuse"}


def walk(node, path, hits, seen, info):
    if isinstance(node, dict):
        for k, v in node.items():
            if k in ("clock", "envKeys", "envKinds"):
                continue
            where = f"{path}.{k}" if path else k
            if k in INFO and not isinstance(v, (dict, list)):
                info.append((where, v))
            if k in BAD:
                seen.add(k)
                pred, why = BAD[k]
                try:
                    if pred(v):
                        hits.append((where, v, why))
                except Exception:
                    pass
            if k in MOUNT and isinstance(v, str) and v in MOUNT_BAD:
                hits.append((where, v, "the volume did not mount read-write"))
            walk(v, where, hits, seen, info)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, f"{path}[{i}]", hits, seen, info)


def main() -> int:
    worst = 0
    for p in sys.argv[1:]:
        d = json.load(open(p))
        hits, seen, info = [], set(), []
        walk({k: v for k, v in d.items() if k not in ("chrome", "config")}, "", hits, seen, info)
        print(f"### {p}  state={d.get('state')} verdict={d.get('verdict')}")
        for e in d.get("errors", [])[:3]:
            print("    page-error:", e[:150])
        for where, v in info[:8]:
            print(f"    info  {where} = {json.dumps(v)}")
        if not hits:
            print("    CLOSED - no loss indicator set. fields present:",
                  ",".join(sorted(seen)) or "(none)")
        else:
            worst = 1
            for where, v, why in hits[:14]:
                print(f"    OPEN  {where} = {json.dumps(v)}  -> {why}")
            if len(hits) > 14:
                print(f"    ... {len(hits) - 14} more")
    return worst


if __name__ == "__main__":
    sys.exit(main())
