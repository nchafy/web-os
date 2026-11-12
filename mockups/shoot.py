#!/usr/bin/env python3
"""Render the mockups in headless Chrome, screenshot them, and fail loudly on a JS error.

A mockup with a broken script is worse than no mockup, so this asserts the page actually
rendered: it counts innerText and collects console errors and uncaught exceptions, and exits
non-zero if any page produced one.
"""
import base64, json, os, pathlib, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import websocket  # noqa: E402

PORT, DBG = 8841, 9441
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PAGES = [
    ("milestones-M0",    "mockups/milestones.html",    None),
    ("milestones-M4a",   "mockups/milestones.html",    "document.querySelectorAll('nav button')[5].click()"),
    ("milestones-M11",   "mockups/milestones.html",    "document.querySelectorAll('nav button')[12].click()"),
    ("milestones-M14",   "mockups/milestones.html",    "document.querySelectorAll('nav button')[15].click()"),
    ("milestones-D1",    "mockups/milestones.html",    "document.querySelectorAll('nav button')[17].click()"),
    ("milestones-D3",    "mockups/milestones.html",    "document.querySelectorAll('nav button')[19].click()"),
    ("milestones-D5",    "mockups/milestones.html",    "document.querySelectorAll('nav button')[21].click()"),
    ("learning-live",    "mockups/learning-mode.html", None),
    ("learning-scrub",   "mockups/learning-mode.html", "document.getElementById('scrub').value=2;"
                                                       "document.getElementById('scrub').dispatchEvent(new Event('input'))"),
    ("learning-absent",  "mockups/learning-mode.html", "document.querySelector('[data-v=absent]').click()"),
    ("learning-matrix",  "mockups/learning-mode.html", "document.querySelector('[data-v=matrix]').click()"),
]

srv = subprocess.Popen([sys.executable, os.path.join(ROOT, 'scripts', 'serve.py'),
                        '--port', str(PORT), '--root', ROOT],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)
subprocess.run(["rm", "-rf", "/tmp/mockprof"])
ch = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={DBG}",
                       "--user-data-dir=/tmp/mockprof", "--no-first-run",
                       "--enable-unsafe-swiftshader", "about:blank"],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(3)
bad = []
try:
    tg = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DBG}/json"))
    ws = websocket.create_connection([x for x in tg if x["type"] == "page"][0]["webSocketDebuggerUrl"],
                                     timeout=60)
    n = [0]

    def send(m, p=None):
        n[0] += 1
        ws.send(json.dumps({"id": n[0], "method": m, "params": p or {}}))
        while True:
            r = json.loads(ws.recv())
            if r.get("id") == n[0]:
                return r

    send("Page.enable"); send("Runtime.enable"); send("Log.enable")
    send("Emulation.setDeviceMetricsOverride",
         {"width": 1240, "height": 880, "deviceScaleFactor": 2, "mobile": False})

    def ev(e):
        return send("Runtime.evaluate", {"expression": e, "returnByValue": True}) \
            .get("result", {}).get("result", {}).get("value")

    for name, url, extra in PAGES:
        send("Page.navigate", {"url": f"http://127.0.0.1:{PORT}/{url}"})
        time.sleep(2.0)
        # install an error collector after load, then re-trigger by interacting
        ev("window.__errs=[];addEventListener('error',e=>window.__errs.push(String(e.message)));"
           "addEventListener('unhandledrejection',e=>window.__errs.push(String(e.reason)))")
        if extra:
            ev(extra)
            time.sleep(0.6)
        chars = ev("document.body.innerText.length") or 0
        errs = ev("JSON.stringify(window.__errs||[])")
        shot = send("Page.captureScreenshot", {"format": "png"})["result"]["data"]
        pathlib.Path(os.path.join(HERE, f"{name}.png")).write_bytes(base64.b64decode(shot))
        ok = chars > 600 and errs == "[]"
        print(f"  {'ok  ' if ok else 'FAIL'} {name:18} innerText {chars:5} chars   errors {errs}")
        if not ok:
            bad.append(name)
finally:
    ch.terminate(); srv.terminate()

print(f"\n{len(PAGES) - len(bad)}/{len(PAGES)} pages rendered clean")
sys.exit(1 if bad else 0)
