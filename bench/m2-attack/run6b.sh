#!/bin/bash
# Round 6, the whole gate set after the control's red list was corrected, then the seven
# mutations, then every attack script. One Chrome at a time, in that order.
set -u
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
bash "$T/run6.sh"
echo "=== SEVEN MUTATIONS"
for m in m1_reseed m2_swing_before_flush m3_refcount_ignored m4_cred_ignored \
         m5_path_per_component m6_close_drops_refs m7_group_bits; do
  bash "$T/sweep.sh" /Users/chafyni/claude/web-os/.claude/worktrees/webos-impl "$m" 200
done
echo "=== EVERY ATTACK SCRIPT"
bash "$T/tally6.sh"
echo "=== RUN6B DONE"
