"""Load www/m1.html and dump the page's own log plus its proof objects."""
import pathlib
import sys

REPO = pathlib.Path("/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl")
sys.path.insert(0, str(REPO / "scripts"))

import cdp  # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402
import threading  # noqa: E402
import serve as serve_mod  # noqa: E402


class H(serve_mod.Handler):
    isolate = True

    def translate_path(self, path):
        import posixpath
        import urllib.parse
        p = urllib.parse.urlparse(path).path
        p = posixpath.normpath(urllib.parse.unquote(p)).lstrip("/")
        return str(REPO / p)


httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
port = httpd.server_address[1]

q = sys.argv[1] if len(sys.argv) > 1 else ""
url = f"http://127.0.0.1:{port}/www/m1.html{q}"
print("url:", url)

with cdp.Browser() as b:
    page = b.page()
    page.navigate(url)
    import time
    for _ in range(140):
        state = page.evaluate("globalThis.M1 && globalThis.M1.state")
        if state in ("done", "aborted", "error"):
            break
        time.sleep(1)
    print("state:", page.evaluate("globalThis.M1 && globalThis.M1.state"))
    print("why:", page.evaluate("String(globalThis.M1 && globalThis.M1.why || '')"))
    print("verdict:", page.evaluate("String(globalThis.M1 && globalThis.M1.verdict || '')"))
    print("faults:", page.evaluate("JSON.stringify((globalThis.M1||{}).faults||[])"))
    print("errors:", page.evaluate("JSON.stringify((globalThis.M1||{}).errors||[])"))
    print("--- proof_e ---")
    print(page.evaluate("JSON.stringify(((globalThis.M1||{}).proofs||{}).proof_e||null)"))
    print("--- page log ---")
    print(page.evaluate("document.body.innerText")[-4000:])

httpd.shutdown()
