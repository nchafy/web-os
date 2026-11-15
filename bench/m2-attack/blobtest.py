import json, sys, time
from pathlib import Path
REPO = Path("/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl")
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "bench/syscall-contention"))
from cdp import Browser
from probe import Serving

EXP = r"""
(async () => {
  const out = {origin: location.origin};
  const src = await (await fetch('/bench/syscall-contention/loop.mjs')).text();
  out.srcBytes = src.length;
  const blob = URL.createObjectURL(new Blob([src], {type: 'text/javascript'}));
  out.blobUrl = blob;
  try { const m = await import(blob); out.windowImport = 'ok, exports=' + Object.keys(m).join(','); }
  catch (e) { out.windowImport = 'FAIL: ' + (e && e.message); }
  const workerSrc = `
    self.onmessage = async (ev) => {
      try { const m = await import(ev.data); self.postMessage('ok, exports=' + Object.keys(m).join(',')); }
      catch (e) { self.postMessage('FAIL: ' + (e && e.message)); }
    };
  `;
  const wUrl = URL.createObjectURL(new Blob([workerSrc], {type: 'text/javascript'}));
  const w = new Worker(wUrl, {type: 'module'});
  const p1 = new Promise((res) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => res('WORKER ERROR: ' + e.message); setTimeout(() => res('timeout'), 8000); });
  w.postMessage(blob);
  out.workerImport = await p1;
  w.terminate();
  const abs = src.replace(/"\/src\/abi\.mjs"/g, JSON.stringify(location.origin + '/src/abi.mjs'));
  out.rewrote = abs !== src;
  const blob2 = URL.createObjectURL(new Blob([abs], {type: 'text/javascript'}));
  const w2 = new Worker(wUrl, {type: 'module'});
  const p2 = new Promise((res) => { w2.onmessage = (e) => res(e.data); w2.onerror = (e) => res('WORKER ERROR: ' + e.message); setTimeout(() => res('timeout'), 8000); });
  w2.postMessage(blob2);
  out.workerImportAbsolute = await p2;
  w2.terminate();
  return out;
})()
"""

with Serving(REPO) as s, Browser() as b:
    page = b.page()
    page.navigate("http://127.0.0.1:%d/www/index.html" % s.port)
    time.sleep(1.0)
    r = page.evaluate(EXP, await_promise=True)
    print(json.dumps(r, indent=2))
