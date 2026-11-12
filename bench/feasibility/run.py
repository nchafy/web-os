#!/usr/bin/env python3
"""Drive bench.html in headless Chrome under COOP/COEP and print its output."""
import json, os, subprocess, sys, time, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'scripts'))
import websocket

PORT, DBG = 8831, 9431
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

srv = subprocess.Popen([sys.executable, os.path.join(ROOT, 'scripts', 'serve.py'),
                        '--port', str(PORT), '--root', ROOT],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)
prof = f"/tmp/feas-{PORT}"; subprocess.run(["rm", "-rf", prof])
ch = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={DBG}",
                       f"--user-data-dir={prof}", "--no-first-run",
                       "--enable-unsafe-swiftshader", "about:blank"],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(3)
try:
    t = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DBG}/json"))
    ws = websocket.create_connection([x for x in t if x["type"] == "page"][0]["webSocketDebuggerUrl"],
                                     timeout=180)
    n = [0]
    def send(m, p=None):
        n[0] += 1; ws.send(json.dumps({"id": n[0], "method": m, "params": p or {}}))
        while True:
            r = json.loads(ws.recv())
            if r.get("id") == n[0]: return r
    send("Page.enable"); send("Runtime.enable")
    send("Page.navigate", {"url": f"http://127.0.0.1:{PORT}/bench/feasibility/bench.html"})
    def ev(e):
        return send("Runtime.evaluate", {"expression": e, "returnByValue": True,
                                         "awaitPromise": True}).get("result", {}).get("result", {}).get("value")
    for _ in range(120):
        time.sleep(1)
        if ev("window.__done === true"): break
    print(ev("document.getElementById('out').textContent"))
    res = ev("JSON.stringify(window.__results)")
    open(os.path.join(os.path.dirname(__file__), 'results.json'), 'w').write(res or '{}')
    print("\nChrome:", ev("navigator.userAgent").split("Chrome/")[1].split(" ")[0])
finally:
    ch.terminate(); srv.terminate()
