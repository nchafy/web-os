"""Do dedicated-worker targets disappear once the orphans die? Throwaway experiment."""
import json, sys, time, threading
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

    def workers():
        tg = page.call("Target.getTargets").get("targetInfos", [])
        return [(t.get("title"), t.get("url")) for t in tg if t.get("type") == "worker"]

    page.navigate(f"http://127.0.0.1:{port}/www/m0.html?n=4&window_ms=1000&warmup=200")
    t0 = time.monotonic()
    while time.monotonic() - t0 < 30:
        st = page.evaluate("globalThis.M0 && globalThis.M0.state")
        if st in ("done", "aborted", "error"):
            break
        time.sleep(0.2)
    print("state", st, flush=True)
    w = workers()
    print("at done:", len(w), w, flush=True)
    t1 = time.monotonic()
    for _ in range(24):
        time.sleep(0.25)
        w = workers()
        print(f"  +{time.monotonic()-t1:.2f}s workers={len(w)} {[t[0] for t in w]}", flush=True)
        if not w:
            break
srv.shutdown()
