#!/bin/bash
# The attack phase on its own, after retarget8b.py put every script's page anchor back on today's
# section list. Appends to v8-tally.txt like the campaign does.
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
VENV=$SRC/.venv/bin/python
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
TALLY=$T/v8-tally.txt
say() { echo "$(date +%H:%M:%S) $*" | tee -a "$TALLY"; }

strays() {
  local n
  n=$(pgrep -f "showup-chrome-" | wc -l | tr -d ' ')
  [ "$n" = "0" ] || say "WARNING: $n stray chrome(s) before $1"
}

one() {
  local script="$1" tree="$2"
  local dest="$T/mut/$tree"
  rm -rf "$dest"; mkdir -p "$dest"
  rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "$dest/" || return 9
  if python3 "$T/$script.py" > "$T/v8b-patch-$script.log" 2>&1; then
    :
  elif [ -f "$T/${script}_r5.py" ]; then
    rm -rf "$dest"; mkdir -p "$dest"
    rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "$dest/" || return 9
    if python3 "$T/${script}_r5.py" >> "$T/v8b-patch-$script.log" 2>&1; then
      script="${script}_r5"
    else
      say "ATTACK8 $script PATCH FAILED :: $(tail -1 "$T/v8b-patch-$script.log" | cut -c1-120)"
      return 1
    fi
  else
    say "ATTACK8 $script PATCH FAILED :: $(tail -1 "$T/v8b-patch-$script.log" | cut -c1-120)"
    return 1
  fi
  ( cd "$dest" && "$VENV" bench/fs-core/probe.py --files 40 --json "$T/v8b-$tree.json" \
      > "$T/v8b-$tree.log" 2>&1 )
  local rc=$?
  say "ATTACK8 $script tree=$tree probe=$rc $(grep -o 'verdict [A-Za-z-]*' "$T/v8b-$tree.log" \
    | head -1) $(grep -o 'state [a-z]*' "$T/v8b-$tree.log" | head -1)"
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

say "######## ATTACK PHASE DONE"
