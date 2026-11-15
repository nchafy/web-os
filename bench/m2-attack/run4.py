"""Drive the system Chrome at the probe page and dump window.RESULTS."""
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, "/Users/chafyni/claude/webxp/scripts")
import cdp  # noqa: E402

HERE = Path(__file__).parent
PORT = 8731


def main() -> int:
    server = subprocess.Popen(
        [sys.executable, str(HERE / "server.py"), str(PORT)],
        stderr=subprocess.DEVNULL,
    )
    time.sleep(0.8)
    url = "http://localhost:%d/exp4.html" % (PORT,)
    try:
        with cdp.Browser() as browser:
            page = browser.page()
            page.call("Log.enable")
            page.call("Network.enable")
            page.navigate(url, timeout=60)
            deadline = time.time() + 90
            while time.time() < deadline:
                if page.evaluate("window.DONE === true"):
                    break
                time.sleep(0.5)
            else:
                print("TIMED OUT waiting for window.DONE", file=sys.stderr)
            out = page.evaluate("JSON.stringify(window.RESULTS)")
            print(out if isinstance(out, str) else json.dumps(out))
            for event in page.consume_events():
                if event.get("method") == "Log.entryAdded":
                    entry = event["params"]["entry"]
                    print("LOG %s %s %s" % (entry.get("level"), entry.get("url"), entry.get("text")),
                          file=sys.stderr)
                elif event.get("method") == "Network.loadingFailed":
                    print("NETFAIL %s" % json.dumps(event["params"]), file=sys.stderr)
    finally:
        server.terminate()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
