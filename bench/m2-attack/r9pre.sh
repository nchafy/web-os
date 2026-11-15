#!/bin/bash
# Just the pre-fix control, re-run after its own patch was repaired.
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
VENV=$SRC/.venv/bin/python
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
n=$(pgrep -f "showup-chrome-" | wc -l | tr -d ' ')
[ "$n" = "0" ] || echo "WARNING: $n stray chrome(s)"
python3 "$T/mktree.py" "$T/mut/vatk30pre" || exit 9
python3 "$T/vattack30pre.py" > "$T/r9-patch-vattack30pre.log" 2>&1 || {
  tail -3 "$T/r9-patch-vattack30pre.log"; exit 1; }
node --check "$T/mut/vatk30pre/bench/fs-core/program.mjs" || exit 2
node --check "$T/mut/vatk30pre/src/kernel/calls.mjs" || exit 2
cd "$T/mut/vatk30pre" || exit 9
"$VENV" bench/fs-core/probe.py --files 20 --timeout 600 --json "$T/r9-vatk30pre.json" \
  > "$T/r9-vatk30pre.log" 2>&1
echo "R9pre probe=$? $(grep -o 'state [a-z]*' "$T/r9-vatk30pre.log" | head -1)"
