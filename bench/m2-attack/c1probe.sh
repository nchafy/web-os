#!/bin/bash
# Is the duplicate sequence number reachable in the CURRENT tree with the C1 fix undone?
#
# The question the round-6 negative control raised: `casretry` with m8a applied produced 442
# consecutive records, while vattack19's own program produced 443 with six duplicates against the
# round-5 tree. So either the race has gone or the program's shape is what reaches it. This runs
# vattack19's program against the m8a tree, which is the current tree with the C1 fix undone.
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
VENV=$SRC/.venv/bin/python
TMP=/Users/chafyni/.claude/jobs/e856c39e/tmp
FROM="$TMP/mut/${1:-m8a_seq_after_await}"
TAG="${2:-c1}"
DEST="$TMP/mut/vatk19"
rm -rf "$DEST"; mkdir -p "$DEST"
rsync -a --exclude .git --exclude .venv --exclude build "$FROM/" "$DEST/" || exit 9
python3 "$TMP/vattack19.py" || exit 9
cd "$DEST" || exit 9
"$VENV" bench/fs-core/probe.py --files 40 --json "$TMP/$TAG-vatk19.json" \
  > "$TMP/$TAG-vatk19.log" 2>&1
echo "=== $TAG probe exit $? ==="
