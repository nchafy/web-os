#!/bin/bash
# Round 9: the F1 attack and its pre-fix control, sequentially. Two Chromes make each other
# measure a different system, so nothing here overlaps.
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
VENV=$SRC/.venv/bin/python
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
TALLY=$T/r9-tally.txt

for pair in vattack30:vatk30 vattack30pre:vatk30pre; do
  script="${pair%%:*}"
  tree="${pair##*:}"
  dest="$T/mut/$tree"
  n=$(pgrep -f "showup-chrome-" | wc -l | tr -d ' ')
  [ "$n" = "0" ] || echo "WARNING: $n stray chrome(s) before $script" | tee -a "$TALLY"
  rm -rf "$dest"
  mkdir -p "$dest"
  rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "$dest/" || exit 9
  if ! python3 "$T/$script.py" > "$T/r9-patch-$script.log" 2>&1; then
    echo "R9 $script PATCH FAILED :: $(tail -2 "$T/r9-patch-$script.log" | tr '\n' ' ' \
      | cut -c1-200)" | tee -a "$TALLY"
    continue
  fi
  if ! node --check "$dest/bench/fs-core/program.mjs" 2>> "$T/r9-patch-$script.log"; then
    echo "R9 $script PATCH BROKE THE PROGRAM MODULE" | tee -a "$TALLY"
    continue
  fi
  ( cd "$dest" && "$VENV" bench/fs-core/probe.py --files 20 --timeout 600 \
      --json "$T/r9-$tree.json" > "$T/r9-$tree.log" 2>&1 )
  rc=$?
  echo "R9 $script tree=$tree probe=$rc $(grep -o 'state [a-z]*' "$T/r9-$tree.log" | head -1)" \
    | tee -a "$TALLY"
done
echo "######## R9 APPEND DONE" | tee -a "$TALLY"
