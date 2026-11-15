#!/bin/bash
# Re-run every attack script that can still find its anchors, against the CURRENT worktree.
# One fresh copy per script. The probe exits 1 by design for most of them (the attack returns
# ok:false so the page prints its evidence), so the exit code is not the verdict - judge7.py is.
set -u
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
for pair in "$@"; do
  tree="${pair%%:*}"
  script="${pair##*:}"
  out=$(bash "$T/run7.sh" "$tree" "$script.py" 2>&1)
  echo "$script -> $(echo "$out" | tail -1)"
  if echo "$out" | grep -q "AssertionError\|NO ANCHOR"; then
    echo "  !! $script COULD NOT BE PATCHED"
  fi
  cp "$T/mut/$tree.json" "$T/r8-$script.json" 2>/dev/null || echo "  !! $script produced no json"
done
echo "######## ATK8 DONE"
