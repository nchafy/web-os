#!/bin/bash
# The gates and the three reproductions, re-run on the FINAL bytes of the worktree.
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
bash "$T/run6.sh"
echo "=== THE THREE REPRODUCTIONS ON THE FINAL BYTES"
for n in 19 15 14; do
  d="$T/mut/vatk$n"
  rm -rf "$d"; mkdir -p "$d"
  rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "$d/" || exit 9
  python3 "$T/vattack$n.py" > /dev/null || exit 9
  ( cd "$d" && "$SRC/.venv/bin/python" bench/fs-core/probe.py --files 40 \
      --json "$T/f6-vatk$n.json" > "$T/f6-vatk$n.log" 2>&1 )
  echo "ATTACK vatk$n probe=$?"
done
echo "=== FINAL6 DONE"
