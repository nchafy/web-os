#!/bin/bash
# One mutation, end to end: a fresh copy of a source tree, the mutation applied, both gates run.
#
#   sweep.sh <source-tree> <mutation-name> [files]
#
# Gate 1: scripts/fsfuzz.py        — purity lint, host tests, the fuzzer and its control.
# Gate 2: bench/fs-core/probe.py   — the proofs in headless Chrome.
# A mutation SURVIVES when both exit 0.
set -u
SRC="$1"
# One interpreter for every tree: the mutated trees carry no .venv of their own.
VENV=/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl/.venv/bin/python
NAME="$2"
FILES="${3:-200}"
ROOT=/Users/chafyni/.claude/jobs/e856c39e/tmp/mut
DEST="$ROOT/$NAME"
rm -rf "$DEST"
mkdir -p "$DEST"
rsync -a --exclude .git --exclude .venv --exclude build "$SRC/" "$DEST/" || exit 9
python3 /Users/chafyni/.claude/jobs/e856c39e/tmp/mutate.py "$NAME" || exit 9
cd "$DEST" || exit 9
"$VENV" scripts/fsfuzz.py > "$DEST/fsfuzz.log" 2>&1
FZ=$?
"$VENV" bench/fs-core/probe.py --files "$FILES" > "$DEST/probe.log" 2>&1
PB=$?
echo "MUTATION $NAME  fsfuzz=$FZ probe=$PB"
if [ "$FZ" -eq 0 ] && [ "$PB" -eq 0 ]; then echo "  -> SURVIVED"; else echo "  -> CAUGHT"; fi
grep -E "host tests|purity|FAIL|VIOLATION" "$DEST/fsfuzz.log" | head -5
grep -E "^  (state|proof_a|proof_b|proof_c|proof_d|api|refuse|order):" "$DEST/probe.log" | head -10
