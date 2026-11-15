#!/usr/bin/env python3
"""Does terminating the kernel worker reap its nested process workers?

Boots the kernel, spawns one process, lists worker targets, terminates the kernel worker from the
page, waits, and lists worker targets again.
"""
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
import { SYS_getpid, G_HEARTBEAT } from '/src/abi.mjs'
export function run(env) {
  // Keep calling for a long time. Once the kernel is gone the stub returns -EIO without parking,
  // so a still-running process is one that keeps incrementing this counter.
  const t0 = performance.now()
  let n = 0
  let lastR = 0
  while (performance.now() - t0 < 20000) { lastR = env.syscall(SYS_getpid); n += 1 }
  return { n, lastR }
}
"""

PAGE = """<!doctype html><meta charset="utf-8"><body><pre id="o"></pre>
<script type="module">
globalThis.P = { state: 'running', msgs: [] }
import '/src/abi.mjs'
const w = new Worker('/src/kernel/kernel.mjs', { type: 'module', name: 'kernel' })
const pending = []
w.onmessage = (e) => { globalThis.P.msgs.push(e.data.t); pending.push(e.data) }
const expect = (t, ms = 20000) => new Promise((res, rej) => {
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
globalThis.P.state = 'running-program'
globalThis.P.kill = () => { w.terminate(); globalThis.P.state = 'killed'; return 'terminated' }
</script>
"""

VIRTUAL = {"/__orphan.html": ("text/html", PAGE), "/__prog.mjs": ("text/javascript", PROG)}


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


def workers(page, port):
    rows = []
    for t in page.call("Target.getTargets").get("targetInfos", []):
        if f"127.0.0.1:{port}" in (t.get("url") or ""):
            rows.append({k: t.get(k) for k in ("type", "url", "targetId", "openerId")})
    return rows


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Bound)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with Browser(extra_args=("--enable-features=SharedArrayBuffer",)) as browser:
            page = browser.page()
            page.navigate(f"http://127.0.0.1:{port}/__orphan.html")
            time.sleep(3)
            print("state:", page.evaluate("globalThis.P.state"), page.evaluate("JSON.stringify(globalThis.P.msgs)"))
            print("targets BEFORE kill:")
            print(json.dumps(workers(page, port), indent=1))
            import subprocess
            def cpu():
                out = subprocess.run(["ps", "-A", "-o", "pid=,time=,command="],
                                     capture_output=True, text=True).stdout
                rows = {}
                for line in out.splitlines():
                    if "showup-chrome-" in line and "--type=renderer" in line:
                        parts = line.split()
                        rows[parts[0]] = parts[1]
                return rows
            before = cpu()
            target_pid = max(before, key=lambda k: before[k])
            print("renderer cputime before kill:", before)
            print("busiest renderer (the page):", target_pid, before[target_pid])
            print("kill:", page.evaluate("globalThis.P.kill()"))
            t0 = time.monotonic()
            for _ in range(16):
                time.sleep(0.5)
                print(f"  +{time.monotonic()-t0:4.1f}s  {cpu().get(target_pid)}")
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
