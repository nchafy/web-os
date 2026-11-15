"""Isolate the thundering herd: 16 module workers importing the same program at once.

The worker script is served over HTTP (synthetic path) so its base URL is hierarchical and a
'/bench/...' specifier resolves exactly as it does in src/libos/process.mjs.

Variants:
  http      16 workers each `await import('/bench/syscall-contention/loop.mjs')`
  blobhttp  one blob of the source with the abi specifier rewritten to an absolute HTTP URL
  bloblink  one blob of abi.mjs + one blob of the program pointing at it (no HTTP in the import)
  text      the source text handed over and evaluated with new Function (no URL at all)
"""
import json, sys, time
from pathlib import Path
REPO = Path("/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl")
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "bench/syscall-contention"))
from cdp import Browser
from serve import Handler
import http.server, threading, collections

COUNTS = collections.Counter()
ERRORS = []

WORKER_JS = b"""
self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.kind === 'url') {
      const mod = await import(m.url);
      self.postMessage({ok: typeof mod.run === 'function'});
    } else {
      self.postMessage({ok: typeof m.text === 'string' && m.text.length > 0});
    }
  } catch (e) { self.postMessage({ok: false, why: String(e && e.message)}); }
};
"""

class Counting(Handler):
    isolate = True
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(REPO), **kw)
    def log_message(self, fmt, *args):
        pass
    def handle_one_request(self):
        try:
            super().handle_one_request()
        except Exception as e:  # noqa: BLE001
            ERRORS.append("handle_one_request: %r" % (e,))
            raise
    def do_GET(self):
        COUNTS[self.path.split("?")[0]] += 1
        if self.path.split("?")[0] == "/__herdworker.mjs":
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript")
            self.send_header("Content-Length", str(len(WORKER_JS)))
            self.end_headers()
            self.wfile.write(WORKER_JS)
            return
        return super().do_GET()

EXP = r"""
(async (variant, n, rounds) => {
  const src = await (await fetch('/bench/syscall-contention/loop.mjs')).text();
  let payload = null;
  if (variant === 'http') payload = {kind: 'url', url: '/bench/syscall-contention/loop.mjs'};
  if (variant === 'blobhttp') {
    const abs = src.replace('"/src/abi.mjs"', JSON.stringify(location.origin + '/src/abi.mjs'));
    payload = {kind: 'url', url: URL.createObjectURL(new Blob([abs], {type: 'text/javascript'}))};
  }
  if (variant === 'bloblink') {
    const abiSrc = await (await fetch('/src/abi.mjs')).text();
    const abiUrl = URL.createObjectURL(new Blob([abiSrc], {type: 'text/javascript'}));
    const linked = src.replace('"/src/abi.mjs"', JSON.stringify(abiUrl));
    payload = {kind: 'url', url: URL.createObjectURL(new Blob([linked], {type: 'text/javascript'}))};
  }
  if (variant === 'text') payload = {kind: 'text', text: src};
  const fails = [];
  let workerErrors = 0;
  for (let r = 0; r < rounds; r++) {
    const ws = [];
    const ps = [];
    for (let i = 0; i < n; i++) {
      const w = new Worker('/__herdworker.mjs', {type: 'module'});
      ws.push(w);
      ps.push(new Promise((res) => {
        w.onmessage = (e) => res(e.data);
        w.onerror = (e) => { workerErrors++; res({ok: false, why: 'worker script error: ' + e.message}); };
        setTimeout(() => res({ok: false, why: 'timeout'}), 20000);
      }));
    }
    for (const w of ws) w.postMessage(payload);
    const got = await Promise.all(ps);
    for (const w of ws) w.terminate();
    const bad = got.filter((g) => !g.ok);
    if (bad.length) fails.push({round: r, n: bad.length, why: bad[0].why});
    await new Promise((res) => setTimeout(res, 60));
  }
  return {variant, rounds, n, failedRounds: fails.length, workerScriptErrors: workerErrors, fails: fails.slice(0, 16)};
})(%s, %d, %d)
"""

def run(variant, n, rounds, queue_size):
    COUNTS.clear(); del ERRORS[:]
    class Srv(http.server.ThreadingHTTPServer):
        request_queue_size = queue_size
        daemon_threads = True
    httpd = Srv(("127.0.0.1", 0), Counting)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        with Browser() as b:
            page = b.page()
            page.navigate("http://127.0.0.1:%d/www/index.html" % port)
            time.sleep(0.8)
            r = page.evaluate(EXP % (json.dumps(variant), n, rounds), await_promise=True)
    finally:
        httpd.shutdown(); httpd.server_close()
    r["queue_size"] = queue_size
    r["serverErrors"] = ERRORS[:6]
    r["serverErrorCount"] = len(ERRORS)
    r["requests"] = dict(COUNTS)
    return r

if __name__ == "__main__":
    variant = sys.argv[1]
    rounds = int(sys.argv[2])
    qs = int(sys.argv[3]) if len(sys.argv) > 3 else 5
    print(json.dumps(run(variant, 16, rounds, qs), indent=2))
