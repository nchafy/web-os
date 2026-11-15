#!/bin/bash
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
VENV=$SRC/.venv/bin/python
ROOT=/Users/chafyni/.claude/jobs/e856c39e/tmp/mut
NAME="${1:-vatk7}"
SCRIPT="${2:-vattack7.py}"
DEST="$ROOT/$NAME"
rm -rf "$DEST"; mkdir -p "$DEST"
rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "$DEST/" || exit 9
python3 "/Users/chafyni/.claude/jobs/e856c39e/tmp/$SCRIPT" || exit 9
cd "$DEST" || exit 9
"$VENV" bench/fs-core/probe.py --files 4 --json "$ROOT/$NAME.json" > "$ROOT/$NAME.log" 2>&1
echo "PROBE $NAME exit=$?"
