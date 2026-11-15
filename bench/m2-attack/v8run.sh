#!/bin/bash
# One scratch tree with one unfix applied, driven through the browser probe.
#
#   v8run.sh <tree-name> <patch.py> [files]
#
# The patch script takes the destination tree as argv[1] and must exit non-zero if its anchor is
# gone: a patch that did not apply is reported as such, never as a clean run.
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
VENV=$SRC/.venv/bin/python
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
ROOT=$T/mut
NAME="$1"
SCRIPT="$2"
FILES="${3:-40}"
DEST="$ROOT/$NAME"
rm -rf "$DEST"; mkdir -p "$DEST"
rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "$DEST/" || exit 9
python3 "$T/$SCRIPT" "$DEST" || exit 9
cd "$DEST" || exit 9
"$VENV" bench/fs-core/probe.py --files "$FILES" --json "$T/v8-$NAME.json" \
  > "$T/v8-$NAME.log" 2>&1
echo "PROBE $NAME exit=$?"
grep -E "state |^  [a-z_0-9]+: (ok|FAIL)" "$T/v8-$NAME.log"
