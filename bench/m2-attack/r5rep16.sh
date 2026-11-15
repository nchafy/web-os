#!/bin/bash
# Is the duplicate journal sequence reachable with ONE fsync per round, or only with the retry?
TMP=/Users/chafyni/.claude/jobs/e856c39e/tmp
for i in 1 2 3; do
  "$TMP/r5run.sh" vattack16.py vatk16 40
  cp "$TMP/r5-vatk16.json" "$TMP/r5-vatk16-run$i.json" 2>/dev/null
  echo "RUN16 $i copied"
done
echo "REPEATS16 DONE"
