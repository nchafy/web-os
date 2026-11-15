#!/bin/bash
# Round 6 BASELINE: the three reproductions that name C1-C4, against the unmodified worktree.
set -u
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
for pair in "vattack19.py vatk19" "vattack15.py vatk15" "vattack14.py vatk14"; do
  set -- $pair
  echo "##### BEFORE $1 -> $2"
  "$T/r5run.sh" "$1" "$2" 40
  cp "$T/r5-$2.json" "$T/b6-$2.json" 2>/dev/null
done
echo "##### BEFORE DONE"
