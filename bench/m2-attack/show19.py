#!/usr/bin/env python3
"""Round 9 (overlapping syscalls): did the appender's acknowledged end survive?"""
import json
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else \
    "/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk19.json"
NOISE = ("clock", "envKeys", "envKinds", "abiFingerprint", "sinkSum", "sinkBytes", "sinkWrites",
         "per")


def trim(row):
    if not isinstance(row, dict):
        return row
    return {k: v for k, v in row.items() if k not in NOISE}


def main():
    d = json.load(open(PATH))
    ev = d["proof_a"]["evidence"]
    a = trim(ev.get("a", {}))
    b = trim(ev.get("b", {}))
    print("A (rewriter):", json.dumps(a)[:700])
    print("B (appender):", json.dumps(b)[:700])
    print("check:", json.dumps(trim(ev.get("check", {})))[:500])
    print("stats:", json.dumps(ev.get("stats"))[:400])
    print("fsck:", json.dumps(ev.get("fsck"))[:600])
    print("journalSeqs:", json.dumps(ev.get("journalSeqs"))[:300])
    rm = ev.get("afterRemount", {})
    print("remount mode=%s problems=%s" % (rm.get("mode"), json.dumps(rm.get("problems"))[:200]))
    print("remount journal:", json.dumps(rm.get("journal"))[:300])
    print("remount seen:", json.dumps(trim(rm.get("seen", {})))[:400])
    print("blobsBefore:", json.dumps(ev.get("blobsBefore"))[:200])
    print("blobsAfter:", json.dumps(ev.get("blobsAfter"))[:300])

    # THE CLAUSE: the appender's acknowledged end must be in the file, live and after the remount.
    want = b.get("acknowledgedEnd")
    live = (ev.get("check") or {}).get("size")
    after = (rm.get("seen") or {}).get("size")
    print()
    print("appender acknowledgedEnd = %s   live size = %s   size after remount = %s"
          % (want, live, after))
    print("bytes short, live: %s   after remount: %s"
          % (None if (want is None or live is None) else want - live,
             None if (want is None or after is None) else want - after))
    print("threw:", ev.get("threw"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
