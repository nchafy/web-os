#!/bin/bash
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
for m in m1_reseed m2_swing_before_flush m3_refcount_ignored; do
  bash /Users/chafyni/.claude/jobs/e856c39e/tmp/sweep.sh "$SRC" "$m" 4
done
