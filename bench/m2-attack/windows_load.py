"""p99 at several window lengths WITH competing CPU load on the machine.

A short window's p99 is the 1% tail of few samples, so one multi-millisecond renderer hiccup can
own it; a long window's p99 is the 1% tail of many, so one hiccup cannot. This puts hiccups on the
machine on purpose and reads the p99 at each window length, which is the measurement the window
choice rests on.

  windows_load.py 400,1000,2000,3000 5 6     # window list, runs per window, load processes
"""
import json, subprocess, sys, time
from pathlib import Path
REPO = Path("/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl")
sys.path.insert(0, str(sys.argv[0].rsplit("/", 1)[0]))
from windows import cell  # noqa: E402

HOG = "x=0.0\nwhile True:\n    x = (x + 1.0) * 1.000001\n"


def hogs(k):
    return [subprocess.Popen([str(REPO / ".venv/bin/python"), "-I", "-c", HOG],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(k)]


if __name__ == "__main__":
    windows = [int(x) for x in sys.argv[1].split(",")]
    runs = int(sys.argv[2])
    load = int(sys.argv[3])
    procs = hogs(load)
    time.sleep(1.0)
    rows = []
    try:
        for w in windows:
            got = 0
            attempts = 0
            while got < runs and attempts < runs * 3:
                attempts += 1
                try:
                    row = cell(w)
                except Exception as error:  # noqa: BLE001 - a starved CDP channel, not a figure
                    print(json.dumps({"window_ms": w, "cdp_error": str(error)}), flush=True)
                    continue
                row["load"] = load
                rows.append(row)
                got += 1
                print(json.dumps(row), flush=True)
    finally:
        for p in procs:
            p.kill()
        for p in procs:
            p.wait()
    print("\n%-10s %-6s %s" % ("window", "runs", "p99 us (per run), load=%d" % load))
    for w in windows:
        ps = [r["p99_us"] for r in rows if r["window_ms"] == w]
        ok = [p for p in ps if p is not None]
        over = [p for p in ok if p >= 500]
        print("%-10s %-6d %s   max %s   over-bar %d/%d" % (
            "%d ms" % w, len(ps), ", ".join("%.1f" % p if p is not None else "BROKEN" for p in ps),
            ("%.1f" % max(ok)) if ok else "n/a", len(over), len(ps)))
