"""p99 at several window lengths, under check_syscall's OWN conditions.

One fresh browser per cell (constraint 14: terminate() does not reap a cell's process workers),
the boot page loaded first in the same tab exactly as the suite does, both servers bound, same
viewport and focus emulation. Reads the figure through check.py's own READ_SYSCALL, so this is
the number the check would assert.
"""
import json, sys, time
from pathlib import Path
REPO = Path("/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl")
sys.path.insert(0, str(REPO / "scripts"))
import cdp
import check as C


def cell(window_ms, extra=""):
    with C.serve(REPO, canonical=REPO, port=0, isolate=True, documents=("/www/m0.html",)) as repo, \
         C.serve(REPO / "www", canonical=REPO / "www", port=0, isolate=True) as www, \
         cdp.Browser() as browser:
        page = browser.page()
        page.call("Runtime.enable"); page.call("Log.enable"); page.call("Page.enable")
        page.clear_cache()
        page.emulate_device(width=C.VIEWPORT_WIDTH, height=C.VIEWPORT_HEIGHT,
                            scale_factor=C.VIEWPORT_SCALE, mobile=False)
        page.call("Emulation.setFocusEmulationEnabled", enabled=True)
        page.navigate(www.base + "/")
        page.evaluate("1")
        doc = C.SYSCALL_DOCUMENT.replace("window_ms=400", "window_ms=%d" % window_ms) + extra
        t0 = time.monotonic()
        page.navigate(repo.base + doc)
        deadline = time.monotonic() + 120
        state = ""
        while time.monotonic() < deadline:
            state = page.evaluate(C.SYSCALL_READY)
            if state:
                break
            time.sleep(0.02)
        got = page.evaluate(C.READ_SYSCALL)
        wall = time.monotonic() - t0
        c = got.get("cell")
        program = [s.path for s in repo.responses()
                   if s.path.startswith("/bench/syscall-contention/loop.mjs")]
        return {
            "window_ms": window_ms, "state": got["state"], "wall_s": round(wall, 2),
            "p99_us": c and c["p99Us"], "count": c and c["count"],
            "mean_us": c and round(c["meanUs"], 1), "depth_p50": c and c["depthP50"],
            "saturated": c and c["saturated"],
            "worst_p99_us": c and c["worstP99Us"],
            "program_responses": len(program),
            "invalid": got["invalid"], "faults": got["faults"],
        }


if __name__ == "__main__":
    windows = [int(x) for x in sys.argv[1].split(",")]
    runs = int(sys.argv[2])
    rows = []
    for w in windows:
        for r in range(runs):
            row = cell(w)
            rows.append(row)
            print(json.dumps(row), flush=True)
    print("\n%-10s %-6s %s" % ("window", "runs", "p99 us (per run)"))
    for w in windows:
        ps = [r["p99_us"] for r in rows if r["window_ms"] == w]
        ok = [p for p in ps if p is not None]
        print("%-10s %-6d %s   max %s" % (
            "%d ms" % w, len(ps), ", ".join("%.1f" % p if p is not None else "BROKEN" for p in ps),
            ("%.1f" % max(ok)) if ok else "n/a"))
