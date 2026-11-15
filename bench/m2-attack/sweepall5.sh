#!/bin/bash
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
for m in m1_reseed m2_swing_before_flush m3_refcount_ignored m4_cred_ignored m5_path_per_component m6_close_drops_refs m7_group_bits; do
  bash /Users/chafyni/.claude/jobs/e856c39e/tmp/sweep.sh "$SRC" "$m" 4
done
