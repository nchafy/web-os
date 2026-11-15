#!/usr/bin/env python3
"""What happens to a process-level fault? process.mjs posts {t:'fault'}; who reads it?"""
from __future__ import annotations

import json
import sys
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

REPO = Path("/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl")
sys.path.insert(0, str(REPO / "scripts"))
from cdp import Browser  # noqa: E402
from serve import Handler  # noqa: E402

PROG = """
export function run(env) {
  throw new Error('the program failed: unknown call "frobnicate"')
}
"""

PAGE = """<!doctype html><meta charset="utf-8"><body><pre id="o"></pre>
<script type="module">
globalThis.P = { state: 'running', msgs: [], all: [] }
import '/src/abi.mjs'
const w = new Worker('/src/kernel/kernel.mjs', { type: 'module', name: 'kernel' })
const pending = []
w.onmessage = (e) => { globalThis.P.msgs.push(e.data.t); globalThis.P.all.push(e.data); pending.push(e.data) }
w.onerror = (e) => { globalThis.P.msgs.push('WORKER-ERROR:' + e.message) }
const expect = (t, ms = 10000) => new Promise((res, rej) => {
  const t0 = performance.now()
  const poll = () => {
    const i = pending.findIndex((m) => m.t === t)
    if (i >= 0) return res(pending.splice(i, 1)[0])
    if (performance.now() - t0 > ms) return rej(new Error('timeout ' + t))
    setTimeout(poll, 10)
  }
  poll()
})
w.postMessage({ t: 'boot', cfg: {} })
await expect('up')
w.postMessage({ t: 'spawn', count: 1, programUrl: '/__prog.mjs', cfg: { clockReads: 500 } })
await expect('spawned')
await expect('ready')
w.postMessage({ t: 'go', go: {} })
try { await expect('results', 4000); globalThis.P.gotResults = true }
catch (e) { globalThis.P.gotResults = false; globalThis.P.resultsWhy = e.message }
w.postMessage({ t: 'stats' })
const s = await expect('stats')
globalThis.P.kernel = { dropped: s.kernel.dropped, calls: s.kernel.calls,
                        perProcess: s.kernel.perProcess, spawned: s.kernel.spawned }
globalThis.P.state = 'done'
</script>
"""

VIRTUAL = {"/__fault.html": ("text/html", PAGE), "/__prog.mjs": ("text/javascript", PROG)}


class Bound(Handler):
    isolate = True

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(REPO), **kw)

    def do_GET(self):  # noqa: N802
        route = VIRTUAL.get(self.path.split("?")[0])
        if route is None:
            return super().do_GET()
        ctype, body = route
        raw = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
        return None


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Bound)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with Browser(extra_args=("--enable-features=SharedArrayBuffer",)) as browser:
            page = browser.page()
            page.navigate(f"http://127.0.0.1:{port}/__fault.html")
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                if page.evaluate("globalThis.P.state") == "done":
                    break
                time.sleep(0.2)
            print(json.dumps(json.loads(page.evaluate("JSON.stringify(globalThis.P)")), indent=1))
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
