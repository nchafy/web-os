#!/bin/bash
# Every attack script in the scratch directory, re-run against the current worktree.
#
# An attack script patches a COPY of the tree, so the patch's anchors must still be in the source.
# Where an original's anchors have gone stale the round-5 retarget of the same attack is used, and
# which one ran is printed — a script whose patch did not apply is not a script that found nothing.
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
VENV=$SRC/.venv/bin/python
TMP=/Users/chafyni/.claude/jobs/e856c39e/tmp
TAG="${TAG:-a6}"

one() {
  local num="$1"
  local tree="vatk$num"
  local dest="$TMP/mut/$tree"
  rm -rf "$dest"; mkdir -p "$dest"
  rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "$dest/" || return 9
  local used=""
  if python3 "$TMP/vattack$num.py" > "$TMP/$TAG-patch-$tree.log" 2>&1; then
    used="vattack$num.py"
  else
    rm -rf "$dest"; mkdir -p "$dest"
    rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "$dest/" || return 9
    if python3 "$TMP/vattack${num}_r5.py" >> "$TMP/$TAG-patch-$tree.log" 2>&1; then
      used="vattack${num}_r5.py"
    else
      echo "ATTACK $tree PATCH FAILED (neither the original nor the r5 retarget applied)"
      return 1
    fi
  fi
  ( cd "$dest" && "$VENV" bench/fs-core/probe.py --files 40 --json "$TMP/$TAG-$tree.json" \
      > "$TMP/$TAG-$tree.log" 2>&1 )
  echo "ATTACK $tree via $used probe=$?"
}

for n in "" 2 4 5b 6 7 8 9 12 14 15 16 18 19; do
  one "$n"
done
echo "=== TALLY RUNS DONE"
