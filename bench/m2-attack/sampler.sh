#!/bin/zsh
# Sample every Chrome process whose command line carries a showup-chrome- profile, with its
# accumulated CPU time, so a cell-1 process still burning CPU while cell 2 measures is visible.
out=$1
: > "$out"
while true; do
  now=$(/usr/bin/python3 -c 'import time;print("%.3f"%time.monotonic())')
  /bin/ps -axo pid=,ppid=,time=,pcpu=,command= \
    | /usr/bin/grep -F "showup-chrome-" \
    | /usr/bin/grep -v grep \
    | /usr/bin/awk -v t="$now" '{prof=""; for(i=1;i<=NF;i++) if ($i ~ /showup-chrome-/) {prof=$i; break}
        type="browser"; for(i=1;i<=NF;i++) if ($i ~ /^--type=/) type=$i
        print t, $1, $2, $3, $4, type, prof}' >> "$out"
  /bin/sleep 0.1
done
