#!/usr/bin/env python3
"""The verbatim notes that are load-bearing for the report, with their numbers intact."""
import json
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else \
    "/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk22.json"
d = json.load(open(PATH))
c = d["proof_a"]["evidence"]["census"]
for n in c.get("diag") or []:
    if "refused" in n or "remove" in n or "lost its base" in n:
        print(n)
print("refusedCommits =", (c.get("stats") or {}).get("refusedCommits"),
      " casExhausted =", (c.get("stats") or {}).get("casExhausted"),
      " casRefusals =", (c.get("stats") or {}).get("casRefusals"))
