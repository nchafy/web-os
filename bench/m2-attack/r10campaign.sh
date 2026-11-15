#!/bin/bash
# Round 9's campaign — the FINAL review of M2, re-run by a reader who did not write the fixes.
# SEQUENTIAL: two Chromes make each other measure a different system.
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

# ---------------------------------------------------------------- 0. the host gate
"$VENV" scripts/fsfuzz.py > "$T/r10-fsfuzz.log" 2>&1
say "FSFUZZ exit=$? :: $(grep -E 'purity|lint|store locks|lock ctl|host tests|edge|fuzz |control' "$T/r10-fsfuzz.log" | tr '\n' ' | ')"
"$VENV" bench/fs-core/syntax.py > "$T/r10-syntax.log" 2>&1
say "SYNTAX exit=$? :: $(tail -2 "$T/r10-syntax.log" | tr '\n' ' ')"

# ---------------------------------------------------------------- 1. the suite
strays suite
"$VENV" scripts/check.py > "$T/r10-suite.log" 2>&1
say "SUITE exit=$? :: $(grep -E '^(ran|[0-9]+ of|[0-9]+ failure|[0-9]+ check)' "$T/r10-suite.log" | tail -4 | tr '\n' ' ')"

# ---------------------------------------------------------------- 2. --prove-failure, twice
for i in 1 2; do
  strays "prove-failure $i"
  "$VENV" scripts/check.py --prove-failure > "$T/r10-prove-$i.log" 2>&1
  say "PROVE-FAILURE run $i exit=$? :: $(grep -cE 'FAIL' "$T/r10-prove-$i.log") FAIL line(s)"
done

# ---------------------------------------------------------------- 3. every re-runnable control
for c in empty-root kernel-stall no-cow-order no-crc no-isolation no-sigpend patched-optional \
  patched-required; do
  strays "control $c"
  "$VENV" scripts/check.py --negative "$c" > "$T/r10-ctl-$c.log" 2>&1
  say "CONTROL $c exit=$? :: $(grep -E '^--negative' "$T/r10-ctl-$c.log" | tail -1)"
done

# ---------------------------------------------------------------- 4. the seven mutations
for m in m1_reseed m2_swing_before_flush m3_refcount_ignored m4_cred_ignored \
  m5_path_per_component m6_close_drops_refs m7_group_bits; do
  strays "mutation $m"
  out=$(bash "$T/sweep.sh" "$SRC" "$m" 200 2>&1)
  say "MUTATION $m :: $(echo "$out" | grep -E 'MUTATION|SURVIVED|CAUGHT' | tr '\n' ' ')"
  echo "$out" > "$T/r10-mut-$m.log"
done

# ---------------------------------------------------------------- 5. every attack script
one() {
  local script="$1" tree="$2"
  local dest="$T/mut/$tree"
  python3 "$T/mktree.py" "$dest" > /dev/null || return 9
  if ! python3 "$T/$script.py" > "$T/r10-patch-$script.log" 2>&1; then
    say "ATTACK $script PATCH FAILED :: $(tail -1 "$T/r10-patch-$script.log" | cut -c1-130)"
    return 1
  fi
  if ! node --check "$dest/bench/fs-core/program.mjs" 2>> "$T/r10-patch-$script.log"; then
    say "ATTACK $script PATCH BROKE THE PROGRAM MODULE"
    return 2
  fi
  ( cd "$dest" && "$VENV" bench/fs-core/probe.py --files 40 --timeout 300 \
      --json "$T/r10-$tree.json" > "$T/r10-$tree.log" 2>&1 )
  local rc=$?
  say "ATTACK $script tree=$tree probe=$rc $(grep -o 'state [a-z]*' "$T/r10-$tree.log" | head -1)"
}

for pair in vattack:vatk vattack2:vatk2 vattack2b:vatk2b vattack3:vatk3 vattack4:vatk4 \
  vattack4b:vatk4b vattack5:vatk5 vattack5b:vatk5b vattack6:vatk6 vattack6b:vatk6b \
  vattack7:vatk7 vattack8:vatk8 vattack9:vatk9 vattack10:vatk10 vattack11:vatk11 \
  vattack12:vatk12 vattack13:vatk13 vattack14:vatk14 vattack15:vatk15 vattack16:vatk16 \
  vattack17:vatk17 vattack18:vatk18 vattack19:vatk19 vattack20:vatk20 vattack21:vatk21 \
  vattack22:vatk22 vattack23:vatk23 vattack24:vatk24 vattack25:vatk25 vattack26:vatk26 \
  vattack27:vatk27 vattack28:vatk28 vattack29:vatk29 vattackb:vatk1b; do
  strays "attack ${pair%%:*}"
  one "${pair%%:*}" "${pair##*:}"
done

say "######## R10 CAMPAIGN DONE"
