import json, subprocess, sys, time, urllib.request, os
sys.path.insert(0, 'scripts')
import websocket

def run(port, isolate):
    args = [sys.executable, 'scripts/serve.py', '--port', str(port), '--root', 'www']
    if not isolate: args.append('--no-isolation')
    srv = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.2)
    prof = f"/tmp/pf-{port}"; subprocess.run(["rm","-rf",prof])
    ch = subprocess.Popen(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "--headless=new", f"--remote-debugging-port={9400+port%50}", f"--user-data-dir={prof}",
        "--no-first-run", "--enable-unsafe-swiftshader", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(3)
    try:
        t = json.load(urllib.request.urlopen(f"http://127.0.0.1:{9400+port%50}/json"))
        ws = websocket.create_connection([x for x in t if x["type"]=="page"][0]["webSocketDebuggerUrl"], timeout=40)
        n=[0]
        def send(m,p=None):
            n[0]+=1; ws.send(json.dumps({"id":n[0],"method":m,"params":p or {}}))
            while True:
                r=json.loads(ws.recv())
                if r.get("id")==n[0]: return r
        send("Page.enable"); send("Runtime.enable")
        send("Page.navigate", {"url": f"http://127.0.0.1:{port}/index.html"})
        time.sleep(6)
        def ev(e):
            return send("Runtime.evaluate", {"expression": e, "returnByValue": True, "awaitPromise": True}).get("result",{}).get("result",{}).get("value")
        return ev("document.documentElement.dataset.preflight"), ev(
            "Array.from(document.querySelectorAll('#checks tr')).map(r=>r.cells[0].textContent+'='+r.cells[1].textContent).join(' | ')")
    finally:
        ch.terminate(); srv.terminate()

for isolate in (True, False):
    verdict, rows = run(8801 if isolate else 8802, isolate)
    label = "ISOLATED (must be ok)" if isolate else "--no-isolation (must be fail)"
    print(f"\n{label}\n  verdict: {verdict}\n  {rows}")
