#!/bin/bash
# Fresh scratch tree per round, patch applied, probe run. Round 5 of the review.
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
VENV=$SRC/.venv/bin/python
ROOT=/Users/chafyni/.claude/jobs/e856c39e/tmp/mut
for pair in "vattackb.py vatk1b" "vattack2b.py vatk2b" "vattack4b.py vatk4b" "vattack5b.py vatk5b" "vattack6b.py vatk6b"; do
  set -- $pair
  SCRIPT=$1; NAME=$2
  DEST="$ROOT/$NAME"
  rm -rf "$DEST"; mkdir -p "$DEST"
  rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "$DEST/" || exit 9
  python3 "/Users/chafyni/.claude/jobs/e856c39e/tmp/$SCRIPT" || exit 9
  cd "$DEST" || exit 9
  "$VENV" bench/fs-core/probe.py --files 4 --json "$ROOT/$NAME.json" > "$ROOT/$NAME.log" 2>&1
  echo "REPLAY $NAME exit=$?"
done
