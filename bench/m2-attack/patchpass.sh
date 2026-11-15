#!/bin/bash
# PATCH-ONLY PASS: can each attack script still find its anchors in the current worktree?
# Chrome is not involved. One fresh copy per script, the patch applied, APPLIED or NO-ANCHOR.
set -u
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
SRC=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl
OUT=$T/patchpass.txt
: > "$OUT"
cd "$T" || exit 9
for f in vattack*.py; do
  script="${f%.py}"
  tree=$(grep -m1 -o 'mut/[A-Za-z0-9_]*' "$f" | head -1)
  tree="${tree#mut/}"
  D="$T/mut/$tree"
  rm -rf "$D"
  mkdir -p "$D"
  rsync -a --exclude '.g*' --exclude .venv --exclude build "$SRC/" "$D/" || { echo "$script COPY-FAILED" >> "$OUT"; continue; }
  if python3 "$T/$f" > "$T/patch-$script.log" 2>&1; then
    echo "$script APPLIED $tree" >> "$OUT"
  else
    why=$(grep -m1 -o "anchor in [^\"]*" "$T/patch-$script.log" | head -1)
    echo "$script NO-ANCHOR $tree :: ${why:-$(tail -2 "$T/patch-$script.log" | tr '\n' ' ')}" >> "$OUT"
  fi
done
sort "$OUT" | awk '{print}'
echo "---- $(grep -c APPLIED "$OUT") applied, $(grep -c NO-ANCHOR "$OUT") could not be patched"
