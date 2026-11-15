#!/bin/bash
set -u
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
VENV=$SRC/.venv/bin/python
echo "=== attacks, re-run against the fixed tree"
bash $T/run7.sh vatk7 vattack7.py
cp $T/mut/vatk7.json $T/after-vatk7.json
bash $T/run7.sh vatk8 vattack8.py
cp $T/mut/vatk8.json $T/after-vatk8.json
bash $T/run7.sh vatk9 vattack9.py
cp $T/mut/vatk9.json $T/after-vatk9.json
echo "=== M4 before: the fixed tree with fstat/SEEK_END reverted"
D=$T/mut/m4before
rm -rf "$D"; mkdir -p "$D"
rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "$D/" || exit 9
python3 $T/m4before.py || exit 9
cd "$D" || exit 9
"$VENV" bench/fs-core/probe.py --files 4 --json "$T/m4before.json" > "$T/m4before.log" 2>&1
echo "m4before probe exit=$?"
echo "=== the clean tree's gates, re-run with nothing editing underneath"
bash $T/verify5.sh
echo "=== AFTER DONE"
