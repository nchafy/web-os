#!/bin/bash
# The seven mutations, one at a time, against the FINAL bytes of the worktree.
#
# A mutation that does not apply is a LOUDER failure than one that survives: mutate.py exits
# non-zero when no anchor matched, and sweep.sh passes that through as exit 9, so "CAUGHT" can
# never be read off a mutation that was never introduced.
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
for m in "$@"; do
  echo "######## $m"
  bash "$T/sweep.sh" "$SRC" "$m" 200 2>&1 | tail -12
done
echo "######## MUT7 DONE"
