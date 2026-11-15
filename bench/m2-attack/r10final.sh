#!/bin/bash
# Round 10's closing re-run, over the FINAL tree: the three comment corrections the pre-fix browser
# run forced landed after the campaign, so the gates are taken again against the bytes that ship.
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
VENV=$SRC/.venv/bin/python
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
TALLY=$T/r10-tally.txt
say() { echo "$(date +%H:%M:%S) $*" | tee -a "$TALLY"; }

strays() {
  local n
  n=$(pgrep -f "showup-chrome-" | wc -l | tr -d ' ')
  [ "$n" = "0" ] || say "WARNING: $n stray chrome(s) before $1"
}

cd "$SRC" || exit 9

"$VENV" scripts/fsfuzz.py > "$T/r10f-fsfuzz.log" 2>&1
say "FINAL FSFUZZ exit=$? :: $(grep -E 'purity|lint ctl|store locks|lock ctl|host tests|edge|fuzz |control' "$T/r10f-fsfuzz.log" | tr '\n' ' | ')"
"$VENV" bench/fs-core/syntax.py > "$T/r10f-syntax.log" 2>&1
say "FINAL SYNTAX exit=$? :: $(tail -2 "$T/r10f-syntax.log" | tr '\n' ' ')"

strays suite
START=$(date +%s)
"$VENV" scripts/check.py > "$T/r10f-suite.log" 2>&1
RC=$?
say "FINAL SUITE exit=$RC in $(( $(date +%s) - START ))s :: $(grep -E '^(ran|  \[|[0-9]+ check)' "$T/r10f-suite.log" | tr '\n' ' | ')"

for i in 1 2; do
  strays "prove-failure $i"
  START=$(date +%s)
  "$VENV" scripts/check.py --prove-failure > "$T/r10f-prove-$i.log" 2>&1
  say "FINAL PROVE-FAILURE $i exit=$? in $(( $(date +%s) - START ))s :: $(tail -3 "$T/r10f-prove-$i.log" | tr '\n' ' | ')"
done

for c in no-cow-order no-crc; do
  strays "control $c"
  "$VENV" scripts/check.py --negative "$c" > "$T/r10f-ctl-$c.log" 2>&1
  say "FINAL CONTROL $c exit=$? :: $(grep -E '^--negative' "$T/r10f-ctl-$c.log" | tail -1)"
done

say "######## R10 FINAL DONE"
