#!/usr/bin/env python3
"""Round 7b: per-round survival, and the notes from the rounds that lost a write."""
import json
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else \
    "/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk21.json"


def main():
    d = json.load(open(PATH))
    kv = d["proof_a"]["evidence"]["killvalue"]
    print("acknowledged=%s vanished=%s volumeClean=%s"
          % (kv.get("acknowledged"), kv.get("vanished"), kv.get("volumeClean")))
    print("fsck:", json.dumps(kv.get("fsck"))[:300])
    print("remount mode=%s problems=%s at4=%s"
          % (kv.get("remount", {}).get("mode"),
             json.dumps(kv.get("remount", {}).get("problems")),
             (kv.get("remount", {}).get("byte") or {}).get("at4")))
    print("liveFdWriteErrs:", json.dumps(kv.get("liveFdWriteErrs"))[:400])
    print("liveFdSyncErrs:", json.dumps(kv.get("liveFdSyncErrs"))[:400])
    print("stats:", json.dumps(kv.get("stats"))[:300])
    print("--- per round ---")
    for r in kv.get("rounds", []):
        print("  r=%-2s want=%s at4=%s at0=%s survived=%-5s wrote=%s hamW=%s hamS=%s"
              % (r.get("r"), r.get("value"), r.get("at4"), r.get("at0"), r.get("survived"),
                 r.get("wrote"), r.get("hamWrote"), r.get("hamSynced")))
        for n in r.get("notes", []):
            print("      note:", n[:200])
    print("--- vanished rounds ---")
    print(json.dumps(kv.get("vanishedRounds"), indent=1)[:3000])
    print("threw:", kv.get("threw"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
