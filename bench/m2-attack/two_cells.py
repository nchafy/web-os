"""Negative control for 'one cell per page load': hand the page two Ns and read what it says."""
import json, sys, threading, time
from http.server import ThreadingHTTPServer
from pathlib import Path

REPO = Path("/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl")
sys.path.insert(0, str(REPO / "scripts"))
from cdp import Browser  # noqa
from serve import Handler  # noqa

root = str(REPO)


class Bound(Handler):
    isolate = True

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=root, **kw)


srv = ThreadingHTTPServer(("127.0.0.1", 0), Bound)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

with Browser() as b:
    page = b.page()
    page.navigate(f"http://127.0.0.1:{port}/www/m0.html?n=1,4&window_ms=300&warmup=100")
    for _ in range(80):
        st = page.evaluate("globalThis.M0 && globalThis.M0.state")
        if st in ("done", "aborted", "error"):
            break
        time.sleep(0.25)
    m0 = json.loads(page.evaluate("JSON.stringify(globalThis.M0)"))
    print("state:", m0.get("state"))
    print("why:", (m0.get("why") or "").split("\n")[0])
    print("cells:", len(m0.get("cells") or []))
srv.shutdown()
