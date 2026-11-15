#!/usr/bin/env python3
import json
import sys

d = json.load(open(sys.argv[1]))
ev = d["proof_a"]["evidence"]
print("truncOk", ev.get("truncOk"), " poisonOk", ev.get("poisonOk"))
KEEP = ("which", "S", "fd2Pending", "ftruncate", "fsync2", "final", "mkdirAfter",
        "statAfter", "at", "errno", "got", "ok")
for which in ("trunc", "poison"):
    o = ev.get(which) or {}
    a = o.get("attack") or {}
    print("---", which)
    print("  attack  :", json.dumps({k: v for k, v in a.items() if k in KEEP}))
    print("  copyUps :", o.get("copyUps"), " inodes:", o.get("inodesBefore"), "->", o.get("inodesAfter"))
    print("  blobs   :", o.get("blobsAfter"))
    if o.get("remount"):
        print("  remount :", json.dumps(o["remount"], indent=1)[:2500])
