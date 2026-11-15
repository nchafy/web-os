#!/usr/bin/env python3
import json
import sys

d = json.load(open(sys.argv[1]))
ev = d["proof_a"]["evidence"]
g = ev.get("grown") or {}
print("path        :", ev.get("path"))
print("blobsBefore :", ev.get("blobsBefore"))
print("injected    :", ev.get("injected"))
print("remount     :", ev.get("remountMode"), ev.get("remountProblems"))
print("grown       :", json.dumps({k: v for k, v in g.items()
      if k in ("ok", "at", "errno", "S", "size", "wantZero", "zeroed", "foreignBytes", "byteAtS")}))
print("blobsAfter  :", ev.get("blobsAfter"))
print("fsck        :", json.dumps(ev.get("fsck"))[:1200])
