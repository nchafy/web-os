#!/bin/bash
# Does each mutation's anchor still exist? A patch that cannot apply is reported as such.
set -u
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
cd "$T" || exit 9
for m in m1_reseed m2_swing_before_flush m3_refcount_ignored m4_cred_ignored \
  m5_path_per_component m6_close_drops_refs m7_group_bits; do
  rm -rf "mut/$m"; mkdir -p "mut/$m"
  rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "mut/$m/" || exit 9
  if python3 mutate.py "$m" > "mut/$m.patch.log" 2>&1; then
    echo "$m APPLIES"
  else
    echo "$m ANCHOR-GONE :: $(tail -1 "mut/$m.patch.log")"
  fi
done
