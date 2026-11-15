#!/usr/bin/env python3
"""sum6.py <json ...> — the fields round 6 is about, one line each.

C1: journalSeqs (records, firstBreakAt, around, duplicates) and the remount's mode.
C3: the EBUSY retries and what the retry answered.
C2: the slack scenarios' victimKept / lostSilently.
"""
import json
import sys


def jget(o, *path):
    for p in path:
        if not isinstance(o, dict):
            return None
        o = o.get(p)
    return o


def line(*a):
    print(" ".join(str(x) for x in a))


def one(path):
    d = json.load(open(path))
    print(f"### {path} state={d['state']} verdict={d['verdict']}")
    for e in d.get("errors", [])[:4]:
        print("   page-error:", e[:140])
    for name in ("proof_a", "proof_b", "proof_c", "proof_d", "pending", "drop", "cas",
                 "orphan", "refuse", "order", "api"):
        p = d.get(name)
        if not p:
            continue
        ev = p.get("evidence") or {}
        for scen, body in ev.items():
            if not isinstance(body, dict):
                continue
            js = body.get("journalSeqs")
            if js:
                line("  ", scen, "journalSeqs:", json.dumps(js))
            st = body.get("stats")
            if st:
                line("  ", scen, "cas:", json.dumps({k: st.get(k) for k in
                     ("casRefusals", "restages", "casExhausted", "refusedCommits",
                      "discardedStagings", "swings", "journalAppends")}))
            fk = body.get("fsck")
            if fk:
                line("  ", scen, "fsck:", json.dumps(fk)[:300])
            ar = body.get("afterRemount")
            if ar:
                line("  ", scen, "afterRemount:", json.dumps(ar)[:400])
            for who in ("a", "b"):
                w = body.get(who)
                if isinstance(w, dict) and "retries" in w:
                    line("  ", scen, f"{who}:", json.dumps({k: w.get(k) for k in
                         ("ok", "wroteAll", "syncedAll", "retries", "lastDurable",
                          "lastWritten", "fdSize")}),
                         "retried:", json.dumps(w.get("retried"))[:200])
            fin = body.get("final") or body.get("check") or body.get("seen")
            if fin is not None:
                line("  ", scen, "final:", json.dumps(fin)[:300])
            for k in ("victimKept", "lostSilently", "revertedToStaleTail", "stageKept",
                      "bothKept", "attack"):
                if k in body:
                    line("  ", scen, k + ":", json.dumps(body[k])[:400])


def main() -> int:
    for p in sys.argv[1:]:
        one(p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
