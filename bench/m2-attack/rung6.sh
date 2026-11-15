#!/bin/bash
# GAP 6, before and after: one injected append failure, then how many metadata ops still land.
#   rung6.sh <tree-name> <source-tree>
set -u
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
VENV=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl/.venv/bin/python
NAME="$1"
SRC="$2"
D="$T/mut/$NAME"
rm -rf "$D"
mkdir -p "$D"
rsync -a --exclude '.g*' --exclude .venv --exclude build "$SRC/" "$D/" || exit 9
python3 "$T/gap6.py" "$D" > "$T/$NAME.patch.log" 2>&1 || { echo "$NAME PATCH FAILED"; tail -3 "$T/$NAME.patch.log"; exit 9; }
cd "$D" || exit 9
"$VENV" bench/fs-core/probe.py --files 4 --json "$T/$NAME.json" > "$T/$NAME.log" 2>&1
echo "$NAME probe exit=$?"
