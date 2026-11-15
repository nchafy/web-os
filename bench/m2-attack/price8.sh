#!/bin/bash
# Price the volume lock: proof (a)'s own write time, with the lock and without it, alternating.
#
#   price8.sh [files] [rounds]
#
# ALTERNATING rather than batched, because a browser that has just written N files is not the
# browser that has not: two runs of A then two of B would attribute the warm-up to the lock.
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
VENV=$SRC/.venv/bin/python
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
FILES="${1:-1000}"
ROUNDS="${2:-2}"
LOCKED=$T/mut/locked
UNLOCKED=$T/mut/nolock

for tree in "$LOCKED" "$UNLOCKED"; do
  rm -rf "$tree"; mkdir -p "$tree"
  rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "$tree/" || exit 9
done
python3 "$T/nolock8.py" "$UNLOCKED" || exit 9

for i in $(seq 1 "$ROUNDS"); do
  for name in locked nolock; do
    ( cd "$T/mut/$name" && "$VENV" bench/fs-core/probe.py --files "$FILES" \
        --json "$T/v8-price-$name-$i.json" > "$T/v8-price-$name-$i.log" 2>&1 )
    echo "PRICE $name run $i exit=$? :: $(python3 - "$T/v8-price-$name-$i.json" <<'EOF'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print("no json:", e); raise SystemExit(0)
a = (d.get("proof_a") or {}).get("evidence") or {}
print("state", d.get("state"), "verdict", d.get("verdict"),
      "n", a.get("n"), "wroteMs", a.get("wroteMs"), "verifyMs", a.get("verifyMs"),
      "written", a.get("written"), "bytesOk", a.get("bytesOk"))
EOF
)"
  done
done
