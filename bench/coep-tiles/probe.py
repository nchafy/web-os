import json, subprocess, time, urllib.request, os, signal, sys
import websocket  # from webxp .venv

PORT = 8771
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
srv = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(__file__), "serve.py"),
                        str(PORT), "/Users/chafyni/claude/webxp"])
plain = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(__file__), "plain.py"),
                          "8772", os.path.join(os.path.dirname(__file__), "nocors")])
time.sleep(1)
prof = "/tmp/coep-probe-profile"
subprocess.run(["rm", "-rf", prof])
ch = subprocess.Popen([CHROME, "--headless=new", "--remote-debugging-port=9333",
                       f"--user-data-dir={prof}", "--no-first-run", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
                       "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(3)
try:
    tgts = json.load(urllib.request.urlopen("http://127.0.0.1:9333/json"))
    ws_url = [t for t in tgts if t["type"] == "page"][0]["webSocketDebuggerUrl"]
    ws = websocket.create_connection(ws_url, timeout=60)
    i = [0]
    def send(m, p=None):
        i[0] += 1
        ws.send(json.dumps({"id": i[0], "method": m, "params": p or {}}))
        while True:
            r = json.loads(ws.recv())
            if r.get("id") == i[0]: return r
    blocked, failed = [], []
    send("Network.enable"); send("Runtime.enable"); send("Log.enable")
    send("Runtime.addBinding",{"name":"__none"}) if False else None
    send("Page.enable")
    send("Page.navigate", {"url": f"http://127.0.0.1:{PORT}/__coep_probe.html"})
    t0 = time.time()
    while time.time() - t0 < 35:
        try:
            ws.settimeout(2); ev = json.loads(ws.recv())
        except Exception:
            continue
        m = ev.get("method")
        if m == "Runtime.exceptionThrown":
            failed.append((None,"JS: "+str(ev["params"]["exceptionDetails"].get("text"))+" "+str((ev["params"]["exceptionDetails"].get("exception") or {}).get("description",""))[:200],None))
        if m == "Network.loadingFailed":
            p = ev["params"]
            failed.append((p.get("blockedReason"), p.get("errorText"), p.get("requestId")))
            if p.get("blockedReason"): blocked.append(p)
    ws.settimeout(30)
    def ev(expr):
        r = send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
        return r.get("result", {}).get("result", {}).get("value")
    print("crossOriginIsolated :", ev("window.__isolated"))
    print("SharedArrayBuffer   :", ev("window.__sab"))
    print("map reached idle    :", ev("window.__state && window.__state.idle === true"))
    print("tile data events    :", ev("window.__state && window.__state.tilesLoaded"))
    print("maplibre errors     :", ev("JSON.stringify((window.__state&&window.__state.errors||[]).slice(0,5))"))
    print("canvas has pixels   :", ev("(()=>{const c=document.querySelector('#m canvas');if(!c)return 'no canvas';"
                                      "const g=c.getContext('webgl2')||c.getContext('webgl');if(!g)return 'no gl';"
                                      "const px=new Uint8Array(4*16);g.readPixels(c.width>>1,c.height>>1,4,4,g.RGBA,g.UNSIGNED_BYTE,px);"
                                      "return Array.from(px.slice(0,12)).join(',');})()"))
    print("raster sources ok   :", ev("JSON.stringify(window.__state&&window.__state.raster||{})"))
    print("NEG CONTROL img     :", ev("window.__neg"), " (must be BLOCKED)")
    shot = send("Page.captureScreenshot", {"format":"png"})["result"]["data"]
    import base64, pathlib
    pathlib.Path("shot.png").write_bytes(base64.b64decode(shot))
    print("screenshot          : shot.png")
    print("blocked requests    :", len(blocked))
    for b in blocked[:6]: print("   BLOCKED", b.get("blockedReason"), b.get("type"))
    print("failed requests     :", len([f for f in failed if not f[0]]))
    for f in [x for x in failed if not x[0]][:6]: print("   FAILED", f[1])
finally:
    ch.terminate(); srv.terminate(); plain.terminate()
