#!/usr/bin/env python3
"""Round 7c: the per-call errno census on live fds."""
import json
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else \
    "/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk22.json"


def main():
    d = json.load(open(PATH))
    c = d["proof_a"]["evidence"]["census"]
    for k in ("everyWriteAcknowledged", "everyReadWhole", "everySyncOk", "volumeClean"):
        print("%-26s %s" % (k, c.get(k)))
    print("fsck:", json.dumps(c.get("fsck"))[:300])
    print("remount:", c.get("remount", {}).get("mode"),
          json.dumps(c.get("remount", {}).get("problems")),
          json.dumps(c.get("remount", {}).get("journal"))[:200])
    print("journalSeqs:", json.dumps(c.get("journalSeqs"))[:300])
    print("stats:", json.dumps(c.get("stats"))[:320])
    print("notes total:", c.get("notes"))
    print("--- writers ---")
    for w in c.get("writers", []):
        print(" value=%s S=%s wrote=%s synced=%s readOk=%s close=%s"
              % (w.get("value"), w.get("S"), w.get("wrote"), w.get("synced"),
                 w.get("readOk"), w.get("close")))
        print("   counts: write=%s read=%s shortRead=%s sync=%s stat=%s"
              % (w.get("writeErrCount"), w.get("readErrCount"), w.get("shortReadCount"),
                 w.get("syncErrCount"), w.get("statErrCount")))
        for key in ("writeErrs", "readErrs", "shortReads", "syncErrs", "statErrs"):
            v = w.get(key)
            if v:
                print("   %s: %s" % (key, json.dumps(v)[:300]))
    print("--- diagnostic notes (first 40) ---")
    for n in (c.get("diag") or [])[:40]:
        print("  ", n[:190])
    print("diag count:", len(c.get("diag") or []))
    print("threw:", c.get("threw"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
