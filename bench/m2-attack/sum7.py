#!/usr/bin/env python3
"""Pull the load-bearing fields out of a vatk7/8/9 probe json. Aggregates, not transcripts."""
import json
import sys


def row(d, keys):
    return {k: d.get(k) for k in keys if k in d}


def main(path):
    doc = json.load(open(path))
    print("verdict", doc.get("verdict"), "state", doc.get("state"))
    print("errors", json.dumps(doc.get("errors"))[:600])
    ev = (doc.get("proof_a") or {}).get("evidence") or {}
    if "a" in ev and "b" in ev:  # vattack9 shape
        for k in ("a", "b"):
            r = ev[k]
            print(k, json.dumps(row(r, ["ok", "at", "errno", "which", "S", "close", "wroteAll",
                                        "syncedAll", "writeErrs", "syncErrs", "fdSize",
                                        "acknowledgedEnd"])))
        print("check", json.dumps(row(ev.get("check") or {}, ["ok", "at", "errno", "size", "read",
                                                             "aBytes", "bBytes", "wantA",
                                                             "wantB"])))
        print("threw", ev.get("threw"))
        print("fsck", json.dumps(ev.get("fsck")))
        print("afterRemount.mode", (ev.get("afterRemount") or {}).get("mode"),
              "problems", (ev.get("afterRemount") or {}).get("problems"))
        seen = (ev.get("afterRemount") or {}).get("seen") or {}
        print("afterRemount.seen", json.dumps(row(seen, ["ok", "size", "aBytes", "bBytes",
                                                         "wantA", "wantB"])))
        return 0
    for name, sc in ev.items():
        if not isinstance(sc, dict):
            print(name, sc)
            continue
        print("===", name)
        atk = sc.get("attack")
        if atk:
            print("  attack", json.dumps(row(atk, ["ok", "at", "which", "S", "below", "append",
                                                   "fsync1", "fsync2", "close1", "close2", "w1",
                                                   "w2", "afterFsync1", "afterFsync2", "final",
                                                   "wantSize", "belowKept", "appendKept", "aKept",
                                                   "bKept", "bothKept", "lostSilently",
                                                   "errno"])))
        for k in ("open1", "open2", "stage1", "tail2", "peekMid", "sync1", "close1", "close2",
                  "final", "planted", "remount", "fsckBeforeOpen", "statClosed", "peekClosed",
                  "openSize", "readThrough", "peekOpen", "close", "peekAfterClose"):
            if k in sc:
                v = sc[k]
                if isinstance(v, dict):
                    v = row(v, ["ok", "at", "errno", "why", "size", "fdSize", "wrote", "fsync",
                                "bytes", "byte0", "byteAtS", "read", "openSize", "byteAtOpenSize",
                                "last", "mode", "problems", "mountable", "blobs", "name", "was",
                                "now", "byte", "sum", "head", "tail"])
                print(" ", k, json.dumps(v)[:500])
        print("  stats", json.dumps(sc.get("stats")))
        print("  fsck", json.dumps(sc.get("fsck"))[:700])
        print("  blobsBefore", sc.get("blobsBefore"), "blobsAfter", sc.get("blobsAfter"))
        ar = sc.get("afterRemount") or {}
        print("  afterRemount", json.dumps(row(ar, ["mode", "problems", "threw"])))
        seen = ar.get("seen")
        if isinstance(seen, dict):
            print("  afterRemount.seen", json.dumps(row(seen, ["ok", "size", "sum", "head",
                                                               "tail", "bytes", "errno"]))[:400])
        print("  threw", sc.get("threw"))
    return 0


if __name__ == "__main__":
    for p in sys.argv[1:]:
        print("######", p)
        main(p)
