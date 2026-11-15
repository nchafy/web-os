#!/bin/bash
# The gates, serially: one Chrome at a time so nothing contends.
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
VENV=$SRC/.venv/bin/python
TMP=/Users/chafyni/.claude/jobs/e856c39e/tmp
cd "$SRC" || exit 9

run() {
  local tag="$1"; shift
  local t0=$(date +%s)
  "$@" > "$TMP/gate-$tag.log" 2>&1
  local rc=$?
  echo "GATE $tag exit=$rc secs=$(( $(date +%s) - t0 ))"
}

run fsfuzz      "$VENV" scripts/fsfuzz.py
run suite       "$VENV" scripts/check.py
run controls    "$VENV" scripts/check.py --controls
run prove1      "$VENV" scripts/check.py --prove-failure
run prove2      "$VENV" scripts/check.py --prove-failure
run probe       "$VENV" bench/fs-core/probe.py --files 200
run nocow       "$VENV" bench/fs-core/probe.py --files 40 --no-cow-order
run nocrc       "$VENV" bench/fs-core/probe.py --files 40 --no-crc
run noiso       "$VENV" bench/fs-core/probe.py --files 40 --no-isolation
echo "GATES DONE"
