#!/bin/bash
set -u
T=/Users/chafyni/.claude/jobs/e856c39e/tmp
echo "=== PHASE 1: attacks re-run against the fixed tree"
bash $T/run7.sh vatk7 vattack7.py
cp $T/mut/vatk7.json $T/after-vatk7.json
bash $T/run7.sh vatk8 vattack8.py
cp $T/mut/vatk8.json $T/after-vatk8.json
bash $T/run7.sh vatk9 vattack9.py
cp $T/mut/vatk9.json $T/after-vatk9.json
echo "=== PHASE 2: the seven mutations"
bash $T/sweepall5.sh
echo "=== PHASE 3: the clean tree's gates"
bash $T/verify5.sh
echo "=== PHASE 4: every negative control"
bash $T/negs.sh
echo "=== ALL DONE"
