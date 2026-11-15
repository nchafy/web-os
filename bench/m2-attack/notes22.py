#!/usr/bin/env python3
"""Every note the census kernel emitted, grouped by shape, so an errno can be attributed."""
import collections
import json
import re
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else \
    "/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk22.log"

# The probe log carries the page's own say() lines; the JSON carries the notes we collected. Read
# the JSON, and fall back to the log's raw io-note lines if the field is absent.
JSON_PATH = PATH.replace(".log", ".json")
d = json.load(open(JSON_PATH))
c = d["proof_a"]["evidence"]["census"]
diag = c.get("diag") or []
shapes = collections.Counter()
for n in diag:
    shapes[re.sub(r"\d+", "N", n)] += 1
print("collected notes:", len(diag), " total io-notes:", c.get("notes"))
for shape, k in shapes.most_common():
    print("%4d  %s" % (k, shape[:170]))
