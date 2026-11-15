#!/bin/bash
# One round-6 negative control, end to end: a fresh copy of the worktree, one fix undone, the
# proofs run. A mutation SURVIVES when the probe exits 0, which would mean the new clause is not
# coupled to the fix.
#
#   sweep6.sh <mutation-name> [files]
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
VENV=$SRC/.venv/bin/python
TMP=/Users/chafyni/.claude/jobs/e856c39e/tmp
NAME="$1"
FILES="${2:-40}"
DEST="$TMP/mut/$NAME"
rm -rf "$DEST"; mkdir -p "$DEST"
rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "$DEST/" || exit 9
python3 "$TMP/mutate6.py" "$NAME" || exit 9
cd "$DEST" || exit 9
"$VENV" bench/fs-core/probe.py --files "$FILES" --json "$TMP/m6-$NAME.json" \
  > "$TMP/m6-$NAME.log" 2>&1
PB=$?
echo "MUTATION $NAME probe=$PB"
if [ "$PB" -eq 0 ]; then echo "  -> SURVIVED"; else echo "  -> CAUGHT"; fi
grep -E "^  (state|why|cas):" "$TMP/m6-$NAME.log" | head -5
