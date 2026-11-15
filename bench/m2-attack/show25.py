#!/usr/bin/env python3
"""Round 7f: the errno census and the stale-CAS count at two, three and four writers."""
import collections
import json
import pathlib
import re
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else \
    "/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk25.json"
ABI = pathlib.Path("/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl/src/abi.mjs")
block = re.search(r"ERRNO_NAMES = Object.freeze\(\[(.*?)\]\);", ABI.read_text(), re.S).group(1)
NAMES = re.findall(r'"([A-Z0-9]+)"', block)


def census(xs):
    c = collections.Counter(NAMES[x] if 0 <= x < len(NAMES) else x for x in xs)
    return dict(c)


def main():
    d = json.load(open(PATH))
    ev = d["proof_a"]["evidence"]
    for key in ("two", "three", "four"):
        r = ev.get(key) or {}
        st = r.get("stats") or {}
        e = r.get("errnos") or {}
        print("### %s writer(s)  rounds=%s" % (r.get("writers"), r.get("rounds")))
        print("    write errnos:", census(e.get("write") or []))
        print("    fsync errnos:", census(e.get("sync") or []))
        print("    read  errnos:", census(e.get("read") or []),
              " stat errnos:", census(e.get("stat") or []))
        print("    refusedCommits=%s casRefusals=%s casExhausted=%s restages=%s discardedStagings=%s"
              % (st.get("refusedCommits"), st.get("casRefusals"), st.get("casExhausted"),
                 st.get("restages"), st.get("discardedStagings")))
        print("    CAS-passed-a-moved-generation notes:",
              len(r.get("casPassedAMovedGeneration") or []))
        for n in (r.get("casPassedAMovedGeneration") or [])[:3]:
            print("      ", n[:190])
        b = (r.get("fsck") or {}).get("blobs") or {}
        print("    fsck verdict=%s problems=%s  blobs have=%s want=%s stale=%s reclaimable=%s"
              % ((r.get("fsck") or {}).get("mountable"), (r.get("fsck") or {}).get("problems"),
                 b.get("have"), b.get("want"), len(b.get("stale") or []),
                 b.get("reclaimableBytes")))
        print("    threw:", r.get("threw"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
