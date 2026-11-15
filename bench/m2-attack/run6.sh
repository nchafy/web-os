#!/bin/bash
# Round 6's gates, one Chrome at a time so nothing contends.
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
V=$SRC/.venv/bin/python
T=/Users/chafyni/.claude/jobs/e856c39e/tmp/g6
mkdir -p "$T"
cd "$SRC" || exit 9

run() {
  local name="$1"; shift
  local s=$(date +%s)
  "$@" > "$T/$name.log" 2>&1
  local rc=$?
  echo "=== $name exit=$rc seconds=$(( $(date +%s) - s ))"
}

run fsfuzz    $V scripts/fsfuzz.py
run probe200  $V bench/fs-core/probe.py --files 200
run suite     $V scripts/check.py
run controls  $V scripts/check.py --controls
run prove1    $V scripts/check.py --prove-failure both
run prove2    $V scripts/check.py --prove-failure both
run negcow    $V scripts/check.py --negative no-cow-order
run negcrc    $V scripts/check.py --negative no-crc
run negiso    $V scripts/check.py --negative no-isolation
echo "=== GATES DONE"
