#!/usr/bin/env python3
"""Print round-7's three scenarios as verdict lines, not as a JSON dump."""
import json
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else \
    "/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk20.json"
NOISE = ("clock", "envKeys", "envKinds", "abiFingerprint", "sinkSum", "sinkBytes", "sinkWrites")


def trim(row):
    if not isinstance(row, dict):
        return row
    return {k: v for k, v in row.items() if k not in NOISE}


def main():
    d = json.load(open(PATH))
    ev = d["proof_a"]["evidence"]

    sr = ev.get("shortread", {})
    print("=== SHORTREAD (fstat vs this fd's own read) ===")
    print("  attack:", json.dumps(trim(sr.get("attack", {})))[:1200])
    for k in ("readShortOfItsOwnFstat", "fstatAndSeekAgree", "bothKept", "volumeClean"):
        print("  %-28s %s" % (k, sr.get(k)))
    print("  fsck:", json.dumps(sr.get("fsck"))[:300])
    print("  notes:", json.dumps(sr.get("notes"))[:400])

    mf = ev.get("metaflood", {})
    print("=== METAFLOOD (C1 under load) ===")
    print("  loopers:", json.dumps(mf.get("loopers"))[:500])
    print("  writers:", json.dumps(mf.get("writers"))[:400])
    print("  journalSeqs:", json.dumps(mf.get("journalSeqs"))[:400])
    print("  seenLive:", json.dumps(trim(mf.get("seenLive", {})))[:400])
    print("  remount:", json.dumps(mf.get("remount", {}).get("journal"))[:300],
          "mode=", mf.get("remount", {}).get("mode"),
          "problems=", json.dumps(mf.get("remount", {}).get("problems"))[:200])
    print("  remount.seen:", json.dumps(trim(mf.get("remount", {}).get("seen", {})))[:500])
    for k in ("seqsAreStrictlyConsecutive", "enoughRecordsToMatter", "everyMetaOpSucceeded",
              "replayAcceptedEveryRecord", "everyAcknowledgedNameSurvived", "volumeClean", "ok"):
        print("  %-32s %s" % (k, mf.get(k)))
    print("  stats:", json.dumps(mf.get("stats"))[:400])
    print("  fsck:", json.dumps(mf.get("fsck"))[:400])
    print("  notes:", json.dumps(mf.get("notes"))[:600])
    print("  threw:", mf.get("threw"))

    kb = ev.get("killbusy", {})
    print("=== KILLBUSY (a killed writer's staged generation) ===")
    print("  rounds:", json.dumps(kb.get("rounds"))[:1400])
    for k in ("acknowledgedWrites", "writesThatVanished", "contenderBytesKept", "volumeClean"):
        print("  %-24s %s" % (k, kb.get(k)))
    print("  vanishedRounds:", json.dumps(kb.get("vanishedRounds"))[:500])
    print("  closeRefusals:", json.dumps(kb.get("closeRefusals"))[:300])
    print("  teardownNotes:", json.dumps(kb.get("teardownNotes"))[:800])
    print("  fsck:", json.dumps(kb.get("fsck"))[:300])
    print("  remount:", json.dumps(trim(kb.get("remount", {}).get("byte", {})))[:300],
          "mode=", kb.get("remount", {}).get("mode"))
    print("  stats:", json.dumps(kb.get("stats"))[:400])
    print("  threw:", kb.get("threw"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
