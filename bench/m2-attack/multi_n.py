"""Does the page itself refuse more than one N in one load? Drive it directly, bypassing
probe.py's one-cell-per-browser loop, which is the only thing that normally prevents it."""
import sys

REPO = "/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl"
sys.path.insert(0, REPO + "/scripts")
sys.path.insert(0, REPO + "/bench/syscall-contention")

from probe import Serving  # noqa: E402
from cdp import Browser  # noqa: E402
from pathlib import Path  # noqa: E402

with Serving(Path(REPO)) as s, Browser() as b:
    page = b.page()
    url = f"http://127.0.0.1:{s.port}/www/m0.html?n=1,4&window_ms=300&warmup=200"
    page.navigate(url)
    import time
    for _ in range(60):
        state = page.evaluate("globalThis.M0 && globalThis.M0.state")
        if state in ("done", "aborted", "error"):
            break
        time.sleep(0.2)
    print("state:", state)
    print("why  :", page.evaluate("globalThis.M0 && globalThis.M0.why"))
    print("cells:", page.evaluate("JSON.stringify((globalThis.M0||{}).cells)"))
    print("worker targets after:", page.call("Target.getTargets"))
