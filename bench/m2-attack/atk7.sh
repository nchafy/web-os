#!/bin/bash
# Re-run named attack scripts against the FINAL bytes of the worktree, one fresh copy each.
#
#   atk7.sh vatk7:vattack7 vatk15:vattack15 ...
#
# The tree name must be the one the script hardcodes as its own ROOT, which is why it is given
# explicitly rather than derived.
#
# THE PROBE EXITS 1 BY DESIGN for every one of these: an attack returns ok:false so the page's
# verdict is FAIL and its evidence prints. The exit code is therefore not the tally; the
# per-scenario booleans in the json are. run7.sh exits 9 when the patch did not apply, which is
# the one exit code that means "this reproduction could not be run at all".
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
  cp "$T/mut/$tree.json" "$T/r7-$script.json" 2>/dev/null || echo "  !! $script produced no json"
done
echo "######## ATK7 DONE"
