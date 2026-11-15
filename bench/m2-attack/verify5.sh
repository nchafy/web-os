#!/bin/bash
# The clean tree's own gates, each timed. Run from the worktree.
set -u
cd /Users/chafyni/claude/web-os/.claude/worktrees/webos-impl || exit 9
V=.venv/bin/python
T=/Users/chafyni/.claude/jobs/e856c39e/tmp/v5
mkdir -p "$T"
run() {
  local name="$1"; shift
  local s=$(date +%s)
  "$@" > "$T/$name.log" 2>&1
  local rc=$?
  local e=$(date +%s)
  echo "=== $name exit=$rc seconds=$((e-s))"
}
run fsfuzz        $V scripts/fsfuzz.py
run probe         $V bench/fs-core/probe.py --files 200
run suite         $V scripts/check.py
run controls      $V scripts/check.py --controls
run prove1        $V scripts/check.py --prove-failure both
run prove2        $V scripts/check.py --prove-failure both
