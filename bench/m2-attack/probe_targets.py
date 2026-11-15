"""Can CDP see nested dedicated workers? Throwaway experiment for the quiescence assertion."""
import json, sys, time, threading, urllib.request
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

    def targets(label):
        js = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{b.port}/json/list").read())
        kinds = [t.get("type") for t in js]
        try:
            tg = page.call("Target.getTargets").get("targetInfos", [])
            kinds2 = [t.get("type") for t in tg]
        except Exception as e:
            kinds2 = f"ERR {e}"
        print(f"{label}: /json/list {kinds} · Target.getTargets {kinds2}", flush=True)

    targets("before navigate")
    page.navigate(f"http://127.0.0.1:{port}/www/m0.html?n=4&window_ms=1500&warmup=200")
    for i in range(40):
        st = page.evaluate("globalThis.M0 && globalThis.M0.state")
        if i in (2, 6):
            targets(f"during (state={st})")
        if st in ("done", "aborted", "error"):
            break
        time.sleep(0.25)
    targets("after done")
    time.sleep(0.3)
    targets("after done +0.3s")
srv.shutdown()
