#!/bin/bash
# The two attacks whose patches needed a re-target: 29 (its O_APPEND import now collides with the
# fix's own) and 24 (the journal-step anchor the apply's undo moved).
#
# A `node --check` on the patched program module comes BEFORE the probe, because a module that does
# not parse makes the page sit at state 'starting' with nothing reported — which is what cost this
# round ten minutes of probe timeout and read exactly like a kernel hang.
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
VENV=$SRC/.venv/bin/python
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
TALLY=$T/v8-tally.txt

for pair in vattack29:vatk29 vattack24:vatk24; do
  script="${pair%%:*}"
  tree="${pair##*:}"
  dest="$T/mut/$tree"
  rm -rf "$dest"
  mkdir -p "$dest"
  rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "$dest/" || exit 9
  if ! python3 "$T/$script.py" > "$T/v8c-patch-$script.log" 2>&1; then
    echo "ATTACK8b $script PATCH FAILED :: $(tail -1 "$T/v8c-patch-$script.log" | cut -c1-140)" \
      | tee -a "$TALLY"
    continue
  fi
  if ! node --check "$dest/bench/fs-core/program.mjs" 2>> "$T/v8c-patch-$script.log"; then
    echo "ATTACK8b $script PATCH BROKE THE PROGRAM MODULE" | tee -a "$TALLY"
    continue
  fi
  ( cd "$dest" && "$VENV" bench/fs-core/probe.py --files 40 --timeout 200 \
      --json "$T/v8c-$tree.json" > "$T/v8c-$tree.log" 2>&1 )
  rc=$?
  echo "ATTACK8b $script tree=$tree probe=$rc $(grep -o 'state [a-z]*' "$T/v8c-$tree.log" \
    | head -1)" | tee -a "$TALLY"
done
echo "######## TWO RE-TARGETED ATTACKS DONE" | tee -a "$TALLY"
