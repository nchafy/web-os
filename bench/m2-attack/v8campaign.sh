#!/bin/bash
# Round 8's whole campaign, SEQUENTIALLY: nothing overlaps, because two Chromes make each other
# measure a different system. Every phase writes its own log and a one-line verdict to v8-tally.txt.
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
VENV=$SRC/.venv/bin/python
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
TALLY=$T/v8-tally.txt
: > "$TALLY"
say() { echo "$(date +%H:%M:%S) $*" | tee -a "$TALLY"; }

strays() {
  local n
  n=$(pgrep -f "showup-chrome-" | wc -l | tr -d ' ')
  [ "$n" = "0" ] || say "WARNING: $n stray chrome(s) before $1"
}

# ---------------------------------------------------------------- 0. the host gate
cd "$SRC" || exit 9
"$VENV" scripts/fsfuzz.py > "$T/v8-fsfuzz.log" 2>&1
say "FSFUZZ exit=$? :: $(grep -E 'purity|store locks|lock ctl|host tests|edge|fuzz |control' "$T/v8-fsfuzz.log" | tr '\n' ' | ')"
"$VENV" bench/fs-core/syntax.py > "$T/v8-syntax.log" 2>&1
say "SYNTAX exit=$? :: $(tail -2 "$T/v8-syntax.log" | tr '\n' ' ')"

# ---------------------------------------------------------------- 1. the suite
strays suite
"$VENV" scripts/check.py > "$T/v8-suite.log" 2>&1
say "SUITE exit=$? :: $(grep -E '^(ran|[0-9]+ of|[0-9]+ failure)' "$T/v8-suite.log" | tail -3 | tr '\n' ' ')"

# ---------------------------------------------------------------- 2. --prove-failure, twice
for i in 1 2; do
  strays "prove-failure $i"
  "$VENV" scripts/check.py --prove-failure > "$T/v8-prove-$i.log" 2>&1
  say "PROVE-FAILURE run $i exit=$? :: $(tail -3 "$T/v8-prove-$i.log" | tr '\n' ' ')"
done

# ---------------------------------------------------------------- 3. every re-runnable control
for c in empty-root kernel-stall no-cow-order no-crc no-isolation no-sigpend patched-optional \
  patched-required; do
  strays "control $c"
  "$VENV" scripts/check.py --negative "$c" > "$T/v8-ctl-$c.log" 2>&1
  say "CONTROL $c exit=$? :: $(grep -E '^--negative' "$T/v8-ctl-$c.log" | tail -1)"
done

# ---------------------------------------------------------------- 4. the seven mutations
for m in m1_reseed m2_swing_before_flush m3_refcount_ignored m4_cred_ignored \
  m5_path_per_component m6_close_drops_refs m7_group_bits; do
  strays "mutation $m"
  out=$(bash "$T/sweep.sh" "$SRC" "$m" 200 2>&1)
  say "MUTATION $m :: $(echo "$out" | grep -E 'MUTATION|SURVIVED|CAUGHT' | tr '\n' ' ')"
  echo "$out" > "$T/v8-mut-$m.log"
done

# ---------------------------------------------------------------- 5. every attack script
# The original first; the round-5 retarget only if the original's anchors are gone. A patch that
# did not apply is reported as such — it is not an attack that found nothing.
one() {
  local script="$1" tree="$2"
  local dest="$T/mut/$tree"
  rm -rf "$dest"; mkdir -p "$dest"
  rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "$dest/" || return 9
  if python3 "$T/$script.py" > "$T/v8-patch-$script.log" 2>&1; then
    :
  elif [ -f "$T/${script}_r5.py" ]; then
    rm -rf "$dest"; mkdir -p "$dest"
    rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "$dest/" || return 9
    if python3 "$T/${script}_r5.py" >> "$T/v8-patch-$script.log" 2>&1; then
      script="${script}_r5"
    else
      say "ATTACK $script PATCH FAILED (neither it nor its r5 retarget applied)"
      return 1
    fi
  else
    say "ATTACK $script PATCH FAILED (no anchor, no retarget)"
    return 1
  fi
  ( cd "$dest" && "$VENV" bench/fs-core/probe.py --files 40 --json "$T/v8-$tree.json" \
      > "$T/v8-$tree.log" 2>&1 )
  local rc=$?
  say "ATTACK $script via $script tree=$tree probe=$rc verdict=$(grep -ao 'verdict [A-Za-z]*' \
    "$T/v8-$tree.log" | head -1)"
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

say "######## CAMPAIGN DONE"
