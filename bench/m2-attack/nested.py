#!/usr/bin/env python3
"""Independent check of M0: smallest kernel boot + one getpid, and who constructs the process worker.

Serves the repository with scripts/serve.py's Handler (COOP/COEP) plus two virtual routes held in
memory, so nothing is written into the repository. Drives Chrome through scripts/cdp.py.
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

from cdp import Browser, CDPError  # noqa: E402
from serve import Handler  # noqa: E402

PROG = """
import { SYS_getpid } from '/src/abi.mjs'
export function run(env) {
  return {
    getpid: env.syscall(SYS_getpid),
    pid: env.pid,
    workerName: self.name,
    href: self.location.href,
    isWindow: typeof window !== 'undefined',
    constructor: self.constructor.name,
  }
}
"""

BOOM = """
export function run(env) {
  setTimeout(() => { throw new Error('deliberate uncaught error inside the process worker') }, 0)
  return { armed: true }
}
"""

PAGE = """<!doctype html><meta charset="utf-8"><body><pre id="o"></pre>
<script type="module">
globalThis.P = { state: 'running', pageWorkerUrls: [], kernelMsgs: [], panics: [], workerErrors: [] }
const Native = Worker
globalThis.Worker = class extends Native {
  constructor(url, opts) { globalThis.P.pageWorkerUrls.push(String(url)); super(url, opts) }
}
import { ABI_FINGERPRINT } from '/src/abi.mjs'

function boot() {
  const w = new Worker('/src/kernel/kernel.mjs', { type: 'module', name: 'kernel' })
  const pending = []
  const waiters = new Map()
  w.onerror = (e) => { globalThis.P.workerErrors.push(String(e.message || e.type)) }
  w.onmessageerror = (e) => { globalThis.P.workerErrors.push('messageerror') }
  w.onmessage = (ev) => {
    const m = ev.data
    globalThis.P.kernelMsgs.push(m.t)
    if (m.t === 'panic') globalThis.P.panics.push(m.why)
    const f = waiters.get(m.t)
    if (f) { waiters.delete(m.t); f(m); return }
    pending.push(m)
  }
  const expect = (t, ms = 20000) => new Promise((res, rej) => {
    const i = pending.findIndex((m) => m.t === t)
    if (i >= 0) return res(pending.splice(i, 1)[0])
    const timer = setTimeout(() => { waiters.delete(t); rej(new Error('timeout waiting for ' + t)) }, ms)
    waiters.set(t, (m) => { clearTimeout(timer); res(m) })
  })
  return { w, expect, post: (m) => w.postMessage(m) }
}

async function main() {
  globalThis.P.isolated = self.crossOriginIsolated === true
  globalThis.P.pageFingerprint = ABI_FINGERPRINT

  const k = boot()
  k.post({ t: 'boot', cfg: {} })
  const up = await k.expect('up')
  globalThis.P.up = { fingerprint: up.abiFingerprint, isolated: up.isolated }
  k.post({ t: 'spawn', count: 1, programUrl: '/__prog.mjs', cfg: { clockReads: 2000 }, readyTimeoutMs: 10000 })
  globalThis.P.spawned = await k.expect('spawned')
  globalThis.P.ready = await k.expect('ready')
  k.post({ t: 'go', go: {} })
  const res = await k.expect('results')
  globalThis.P.results = res.results
  globalThis.P.kernelStats = { calls: res.kernel.calls, perProcess: res.kernel.perProcess }

  // Second kernel: an uncaught error inside the process worker. The handler that can see it is
  // whichever realm holds the Worker object.
  const k2 = boot()
  k2.post({ t: 'boot', cfg: {} })
  await k2.expect('up')
  k2.post({ t: 'spawn', count: 1, programUrl: '/__boom.mjs', cfg: { clockReads: 500 }, readyTimeoutMs: 10000 })
  await k2.expect('spawned')
  await k2.expect('ready')
  k2.post({ t: 'go', go: {} })
  try { globalThis.P.boomPanic = (await k2.expect('panic', 5000)).why }
  catch (e) { globalThis.P.boomPanic = 'no panic reached the page: ' + e.message }

  globalThis.P.state = 'done'
  document.getElementById('o').textContent = JSON.stringify(globalThis.P, null, 1)
}
main().catch((e) => { globalThis.P.state = 'error'; globalThis.P.why = String(e && e.stack || e) })
</script>
"""

VIRTUAL = {
    "/__probe.html": ("text/html", PAGE),
    "/__prog.mjs": ("text/javascript", PROG),
    "/__boom.mjs": ("text/javascript", BOOM),
}


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
            if "--attach" in sys.argv:
                page.call("Target.setAutoAttach", autoAttach=True,
                          waitForDebuggerOnStart=False, flatten=True)
            page.navigate(f"http://127.0.0.1:{port}/__probe.html")
            deadline = time.monotonic() + 90
            state = None
            while time.monotonic() < deadline:
                state = page.evaluate("globalThis.P && globalThis.P.state")
                if state in ("done", "error"):
                    break
                time.sleep(0.1)
            p = json.loads(page.evaluate("JSON.stringify(globalThis.P)"))
            print("STATE", state)
            print(json.dumps(p, indent=1))
            targets = page.call("Target.getTargets")
            print("Target.getTargets:")
            for t in targets.get("targetInfos", []):
                print("  ", {k: t.get(k) for k in ("type", "url", "targetId", "openerId")})
            print("buffered Target.* events:")
            for ev in page.consume_events():
                if ev.get("method", "").startswith("Target."):
                    print("  ", json.dumps({
                        "method": ev["method"],
                        "envelopeSessionId": ev.get("sessionId"),
                        "params": ev.get("params"),
                    }))
    except CDPError as e:
        print("CDP ERROR", e)
        return 1
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
