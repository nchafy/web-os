#!/bin/bash
set -u
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
echo "=== vattack9 re-run after the EBUSY import fix"
bash $T/run7.sh vatk9 vattack9.py
cp $T/mut/vatk9.json $T/after2-vatk9.json
echo "=== the seven mutations"
bash $T/sweepall5.sh
echo "=== the clean tree's gates"
bash $T/verify5.sh
echo "=== every negative control"
bash $T/negs.sh
echo "=== FINAL DONE"
