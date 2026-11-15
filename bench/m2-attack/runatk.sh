#!/bin/bash
# runatk.sh <source-tree> <vatkN-dirname> <vattackN.py> [files]
# Fresh copy of a source tree, the attack page patched in, probe.py driven in headless Chrome.
set -u
SRC="$1"; NAME="$2"; PATCHER="$3"; FILES="${4:-8}"
VENV=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl/.venv/bin/python
ROOT=/Users/chafyni/.claude/jobs/e856c39e/tmp/mut
DEST="$ROOT/$NAME"
rm -rf "$DEST"; mkdir -p "$DEST"
rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "$DEST/" || exit 9
python3 "$PATCHER" || exit 9
cd "$DEST" || exit 9
"$VENV" bench/fs-core/probe.py --files "$FILES" --json "$DEST/out.json" > "$DEST/probe.log" 2>&1
echo "probe exit=$?"
