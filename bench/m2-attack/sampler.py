"""Sample every Chrome process carrying a showup-chrome- profile, 20 Hz, with its accumulated
CPU time. A cell-1 process still burning CPU while cell 2 measures shows up as two profiles
present in one sample."""
import subprocess
import sys
import time

out = open(sys.argv[1], "w")
while True:
    t = time.time()
    ps = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,time=,pcpu=,command="],
                        capture_output=True, text=True).stdout
    for line in ps.splitlines():
        if "showup-chrome-" not in line or "/bin/ps" in line:
            continue
        f = line.split()
        prof = next((x for x in f if "showup-chrome-" in x), "?")
        typ = next((x for x in f if x.startswith("--type=")), "--type=browser")
        out.write(f"{t:.3f} {f[0]} {f[1]} {f[2]} {f[3]} {typ} {prof}\n")
    out.flush()
    time.sleep(0.05)
