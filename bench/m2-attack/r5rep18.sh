#!/bin/bash
# Repeat the fsync-retry attack: one run came up READ-ONLY with a rejected journal record and a
# missing blob. Either that is a rare race or it was noise, and the only way to tell is repetition.
TMP=/Users/chafyni/.claude/jobs/e856c39e/tmp
for i in 1 2 3 4 5; do
  "$TMP/r5run.sh" vattack18.py vatk18 40
  cp "$TMP/r5-vatk18.json" "$TMP/r5-vatk18-run$i.json" 2>/dev/null
  echo "RUN $i copied"
done
echo "REPEATS DONE"
