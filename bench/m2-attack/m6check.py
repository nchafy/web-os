"""M6 alignment: with the constraint-41 list deleted from the process realm, can a process still
import a kernel-made blob URL? And can it still reach the network with import()?"""
import json, sys, time, http.server, threading
from pathlib import Path
REPO = Path("/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl")
sys.path.insert(0, str(REPO / "scripts"))
from cdp import Browser
from serve import Handler

# The constraint-41 list, deleted before the program image is imported.
WORKER_JS = b"""
import '/src/abi.mjs';
const deleted = [];
function strip(obj, key, label) {
  try { delete obj[key]; deleted.push(label + (key in obj ? ':STILL-THERE' : ':gone')); }
  catch (e) { deleted.push(label + ':THREW ' + e.message); }
}
const WGS = Object.getPrototypeOf(Object.getPrototypeOf(self));
strip(WGS, 'fetch', 'fetch');
strip(WGS, 'importScripts', 'importScripts');
strip(self, 'XMLHttpRequest', 'XMLHttpRequest');
strip(self, 'WebSocket', 'WebSocket');
strip(self, 'Worker', 'Worker');
strip(WGS, 'indexedDB', 'indexedDB');
strip(WGS, 'caches', 'caches');
strip(URL, 'createObjectURL', 'URL.createObjectURL');
strip(WorkerNavigator.prototype, 'storage', 'navigator.storage');
self.onmessage = async (ev) => {
  const out = {deleted};
  try { const mod = await import(ev.data.blob); out.blobImport = typeof mod.run === 'function' ? 'ok' : 'no run export'; }
  catch (e) { out.blobImport = 'FAIL: ' + (e && e.message); }
  try { await import(ev.data.http); out.httpImport = 'ok'; }
  catch (e) { out.httpImport = 'FAIL: ' + (e && e.message); }
  self.postMessage(out);
};
"""

class H(Handler):
    isolate = True
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(REPO), **kw)
    def log_message(self, fmt, *args):
        pass
    def do_GET(self):
        if self.path.split("?")[0] == "/__m6worker.mjs":
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript")
            self.send_header("Content-Length", str(len(WORKER_JS)))
            self.end_headers()
            self.wfile.write(WORKER_JS)
            return
        return super().do_GET()

EXP = r"""
(async () => {
  const src = await (await fetch('/bench/syscall-contention/loop.mjs')).text();
  const abs = src.replace('"/src/abi.mjs"', JSON.stringify(location.origin + '/src/abi.mjs'));
  const blob = URL.createObjectURL(new Blob([abs], {type: 'text/javascript'}));
  const w = new Worker('/__m6worker.mjs', {type: 'module'});
  const p = new Promise((res) => {
    w.onmessage = (e) => res(e.data);
    w.onerror = (e) => res({why: 'worker error ' + e.message});
    setTimeout(() => res({why: 'timeout'}), 15000);
  });
  w.postMessage({blob, http: location.origin + '/bench/syscall-contention/summarise.mjs'});
  const r = await p;
  w.terminate();
  return r;
})()
"""

if __name__ == "__main__":
    class Srv(http.server.ThreadingHTTPServer):
        daemon_threads = True
    httpd = Srv(("127.0.0.1", 0), H)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        with Browser() as b:
            page = b.page()
            page.navigate("http://127.0.0.1:%d/www/index.html" % port)
            time.sleep(0.8)
            print(json.dumps(page.evaluate(EXP, await_promise=True), indent=2))
    finally:
        httpd.shutdown(); httpd.server_close()
