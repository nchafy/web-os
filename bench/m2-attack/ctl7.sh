#!/bin/bash
# Every re-runnable negative control, one at a time, on the worktree's final bytes.
#
# A control's exit code is not the verdict: a control that is DECLARED to turn a check red exits 0
# when the check went red as declared. The line to read is the "--negative NAME:" summary.
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
cd "$SRC" || exit 9
for c in "$@"; do
  echo "######## --negative $c"
  .venv/bin/python scripts/check.py --negative "$c" > "/tmp/v7-ctl-$c.log" 2>&1
  echo "exit=$?"
  grep -E "^--negative|^  \[|ran [0-9]+ " "/tmp/v7-ctl-$c.log" | tail -14
done
echo "######## CTL7 DONE"
