#!/usr/bin/env python3
"""Round 7d: did an fsynced append survive two contending rewriters?"""
import collections
import json
import re
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else \
    "/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk23.json"


def main():
    d = json.load(open(PATH))
    r = d["proof_a"]["evidence"]["revert"]
    for k in ("everySyncTrueAtTheTime", "everyAckedSlotLive", "everyAckedSlotAfterRemount",
              "volumeClean", "lostAcknowledgedBytes", "silent"):
        print("%-30s %s" % (k, r.get(k)))
    print("appender:", json.dumps(r.get("appender"))[:900])
    for w in r.get("rewriters", []):
        print("rewriter:", json.dumps(w)[:400])
    print("live check:", json.dumps({k: v for k, v in (r.get("live") or {}).items()
                                     if k in ("ok", "size", "read", "acked", "right", "wantEnd",
                                              "badCount", "bad")})[:700])
    rm = r.get("remount", {})
    print("remount mode=%s problems=%s" % (rm.get("mode"), json.dumps(rm.get("problems"))))
    print("remount check:", json.dumps({k: v for k, v in (rm.get("check") or {}).items()
                                        if k in ("ok", "size", "read", "acked", "right",
                                                 "wantEnd", "badCount", "bad")})[:700])
    print("journalSeqs:", json.dumps(r.get("journalSeqs"))[:260])
    print("stats:", json.dumps(r.get("stats"))[:340])
    print("fsck:", json.dumps(r.get("fsck"))[:400])
    shapes = collections.Counter()
    for n in r.get("diag") or []:
        shapes[re.sub(r"\d+", "N", n)] += 1
    print("--- note shapes (%d notes) ---" % len(r.get("diag") or []))
    for shape, k in shapes.most_common():
        print("%4d  %s" % (k, shape[:160]))
    print("--- notes with numbers that matter ---")
    for n in r.get("diag") or []:
        if "refused" in n or "lost its base" in n:
            print("  ", n[:220])
    print("threw:", r.get("threw"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
