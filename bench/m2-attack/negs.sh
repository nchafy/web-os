#!/bin/bash
# Every re-runnable negative control, one line each: name, exit code, wall time, last line.
cd /Users/chafyni/claude/web-os/.claude/worktrees/webos-impl || exit 9
PY=.venv/bin/python
for c in empty-root patched-required patched-optional no-isolation kernel-stall no-sigpend no-cow-order no-crc; do
  t0=$(date +%s)
  "$PY" scripts/check.py --negative "$c" > "/Users/chafyni/.claude/jobs/e856c39e/tmp/neg-$c.log" 2>&1
  rc=$?
  t1=$(date +%s)
  printf '%-18s exit=%d  %ds  %s\n' "$c" "$rc" "$((t1-t0))" "$(tail -1 "/Users/chafyni/.claude/jobs/e856c39e/tmp/neg-$c.log")"
done
