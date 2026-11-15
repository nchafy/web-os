#!/bin/bash
# r5run.sh <attack-script> <tree-name> [files]
# Refresh a scratch tree from the live worktree, apply the attack patch, drive it in Chrome.
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
VENV=$SRC/.venv/bin/python
TMP=/Users/chafyni/.claude/jobs/e856c39e/tmp
SCRIPT="$1"
NAME="$2"
FILES="${3:-40}"
DEST="$TMP/mut/$NAME"
rm -rf "$DEST"; mkdir -p "$DEST"
rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "$DEST/" || exit 9
python3 "$TMP/$SCRIPT" || exit 9
cd "$DEST" || exit 9
"$VENV" bench/fs-core/probe.py --files "$FILES" --json "$TMP/r5-$NAME.json" \
  > "$TMP/r5-$NAME.log" 2>&1
echo "=== $NAME probe exit $? ==="
