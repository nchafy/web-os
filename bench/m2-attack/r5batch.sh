#!/bin/bash
# Replay every round's scenarios against the current worktree, one Chrome at a time.
TMP=/Users/chafyni/.claude/jobs/e856c39e/tmp
for pair in "vattack_r5.py vatk" "vattack2_r5.py vatk2" "vattack4_r5.py vatk4" \
            "vattack5b_r5.py vatk5b" "vattack6_r5.py vatk6" \
            "vattack12_r5.py vatk12"; do
  set -- $pair
  echo "##### $1 -> $2"
  "$TMP/r5run.sh" "$1" "$2" 40
done
echo "##### BATCH DONE"
