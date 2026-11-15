"""Does a blob module's absolute-URL import hit the worker's EXISTING module map?

The worker script (served over HTTP, like src/libos/process.mjs) statically imports
/src/abi.mjs. It then dynamically imports a blob whose abi specifier was rewritten to the
absolute URL of the same module. If the module map dedupes, /src/abi.mjs is fetched once per
worker and the two bindings are the same object.
"""
import json, sys, time, collections, http.server, threading
from pathlib import Path
REPO = Path("/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl")
sys.path.insert(0, str(REPO / "scripts"))
from cdp import Browser
from serve import Handler

COUNTS = collections.Counter()

WORKER_JS = b"""
import { ABI_FINGERPRINT, SYS_getpid } from '/src/abi.mjs';
import * as abi from '/src/abi.mjs';
self.onmessage = async (ev) => {
  try {
    const mod = await import(ev.data);
    const same = mod.abiNamespace === abi;
    self.postMessage({ok: typeof mod.run === 'function', fingerprint: ABI_FINGERPRINT,
                      sameInstance: same, sys: SYS_getpid});
  } catch (e) { self.postMessage({ok: false, why: String(e && e.message)}); }
};
"""

class Counting(Handler):
    isolate = True
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(REPO), **kw)
    def log_message(self, fmt, *args):
        pass
    def do_GET(self):
        COUNTS[self.path.split("?")[0]] += 1
        if self.path.split("?")[0] == "/__mapworker.mjs":
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript")
            self.send_header("Content-Length", str(len(WORKER_JS)))
            self.end_headers()
            self.wfile.write(WORKER_JS)
            return
        return super().do_GET()

EXP = r"""
(async (n, rounds) => {
  const src = await (await fetch('/bench/syscall-contention/loop.mjs')).text();
  const abs = src.replace('"/src/abi.mjs"', JSON.stringify(location.origin + '/src/abi.mjs'))
    + "\nexport * as abiNamespace from " + JSON.stringify(location.origin + '/src/abi.mjs') + ";\n";
  const url = URL.createObjectURL(new Blob([abs], {type: 'text/javascript'}));
  const fails = [];
  let sameAll = true;
  for (let r = 0; r < rounds; r++) {
    const ws = [], ps = [];
    for (let i = 0; i < n; i++) {
      const w = new Worker('/__mapworker.mjs', {type: 'module'});
      ws.push(w);
      ps.push(new Promise((res) => {
        w.onmessage = (e) => res(e.data);
        w.onerror = (e) => res({ok: false, why: 'worker script error: ' + e.message});
        setTimeout(() => res({ok: false, why: 'timeout'}), 20000);
      }));
    }
    for (const w of ws) w.postMessage(url);
    const got = await Promise.all(ps);
    for (const w of ws) w.terminate();
    for (const g of got) if (g.sameInstance !== true) sameAll = false;
    const bad = got.filter((g) => !g.ok);
    if (bad.length) fails.push({round: r, n: bad.length, why: bad[0].why});
    await new Promise((res) => setTimeout(res, 60));
  }
  return {rounds, n, failedRounds: fails.length, fails: fails.slice(0, 8), sameInstanceEverywhere: sameAll};
})(%d, %d)
"""

if __name__ == "__main__":
    rounds = int(sys.argv[1])
    class Srv(http.server.ThreadingHTTPServer):
        request_queue_size = 5
        daemon_threads = True
    httpd = Srv(("127.0.0.1", 0), Counting)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        with Browser() as b:
            page = b.page()
            page.navigate("http://127.0.0.1:%d/www/index.html" % port)
            time.sleep(0.8)
            r = page.evaluate(EXP % (16, rounds), await_promise=True)
    finally:
        httpd.shutdown(); httpd.server_close()
    r["requests"] = dict(COUNTS)
    print(json.dumps(r, indent=2))
