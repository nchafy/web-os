#!/bin/bash
set -u
cd /Users/chafyni/claude/web-os/.claude/worktrees/webos-impl || exit 9
V=.venv/bin/python
T=/Users/chafyni/.claude/jobs/e856c39e/tmp/v6
mkdir -p "$T"
run() {
  local n="$1"; shift
  local s=$(date +%s)
  "$@" > "$T/$n.log" 2>&1
  local rc=$?
  local e=$(date +%s)
  echo "=== $n exit=$rc seconds=$((e-s))"
}
run fsfuzz   $V scripts/fsfuzz.py
run suite    $V scripts/check.py
run controls $V scripts/check.py --controls
run prove1   $V scripts/check.py --prove-failure both
run prove2   $V scripts/check.py --prove-failure both
