#!/usr/bin/env python3
"""M6's measurement: what a process realm reaches, and where a policy has to be delivered.

Run BEFORE writing M6, and again after, because two facts decide the whole design and neither
may be answered from memory:

  1. Which of constraint 41's bindings a same-origin dedicated MODULE worker can actually USE.
     Every row is a call, not a `typeof`.
  2. Whether a Content-Security-Policy delivered on the DOCUMENT bounds that worker's module
     loader, or whether it has to be delivered on the WORKER SCRIPT's own response. Constraint
     139 says "a Content-Security-Policy on the document is the answer"; that is the claim under
     test here, and the four modes are the measurement.

Four modes, one page load each:

    none        neither response carries a policy  — the hole, in both directions
    worker      only /bench/m6-realm/csp-worker.mjs carries one
    document    only the document carries one
    both        both do

THE OFF-ORIGIN ROW NEEDS A COOPERATING SERVER, so this probe starts a second one on a second
port — a second origin — which sends `Access-Control-Allow-Origin: *`. Without it a cross-origin
module fetch fails CORS and the row would read "refused" for a reason the policy had nothing to
do with, which is a check that proves nothing. Constraint 139 records the same point.

    python3 bench/m6-realm/csp-probe.py
    python3 bench/m6-realm/csp-probe.py --modes none        # just the hole
    python3 bench/m6-realm/csp-probe.py --no-isolation      # the probe must refuse to report

Isolation is asserted before anything is measured and the probe ABORTS without it: a row taken
in a non-isolated renderer is a row about a different renderer (CLAUDE.md §Verification).
"""

from __future__ import annotations

import argparse
import functools
import http.server
import json
import pathlib
import sys
import threading

REPO = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))

import cdp  # noqa: E402  (after sys.path, by design: scripts/ is not a package)
from serve import PROCESS_REALM_CSP  # noqa: E402

#: THE POLICY THIS REPOSITORY SERVES, imported and never restated. A bench measuring a policy the
#: server does not send is a bench about a system nobody runs — and this file carried its own copy
#: until the shipped one lost `worker-src 'none'`, at which point the two disagreed about the
#: subject. `scripts/serve.py` is the one definition and says why each directive is there.
WORKER_CSP = PROCESS_REALM_CSP

#: The document's policy. Every www page carries INLINE script, and the server serves static
#: bytes that `scripts/check.py` byte-compares against disk — so a nonce cannot be injected and
#: `'unsafe-inline'` is what a policy on these documents means today.
DOCUMENT_CSP = (
    "script-src 'self' 'unsafe-inline' blob:; worker-src 'self' blob:; "
    "object-src 'none'; base-uri 'none'"
)

MODES = ("none", "worker", "document", "both")


class ProbeHandler(http.server.SimpleHTTPRequestHandler):
    """The repository root, with COOP/COEP, and a policy applied per response by query."""

    isolate = True

    def _mode(self) -> str:
        from urllib.parse import parse_qs, urlparse
        return (parse_qs(urlparse(self.path).query).get("csp") or [""])[0]

    def end_headers(self) -> None:
        if self.isolate:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        mode = self._mode()
        path = self.path.split("?")[0]
        if path.endswith("csp-worker.mjs") and mode in ("worker", "both"):
            self.send_header("Content-Security-Policy", WORKER_CSP)
        if path.endswith("csp-probe.html") and mode in ("document", "both"):
            self.send_header("Content-Security-Policy", DOCUMENT_CSP)
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        if str(path).endswith(".mjs"):
            return "text/javascript"
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        pass


class HostileHandler(http.server.SimpleHTTPRequestHandler):
    """The second origin. One directory, CORS-open, no isolation headers of its own.

    `Access-Control-Allow-Origin: *` is what makes the off-origin row honest: a module script is
    fetched in CORS mode, so this header is also what satisfies the embedder policy. A hostile
    host that wants its code evaluated sends it.
    """

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        if str(path).endswith(".mjs"):
            return "text/javascript"
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        pass


def serve(handler, root: pathlib.Path):
    """A ThreadingHTTPServer on a daemon thread, on an OS-chosen port. Returns (base, httpd)."""
    httpd = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(handler, directory=str(root)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return "http://127.0.0.1:%d" % httpd.server_address[1], httpd


READ = """(() => {
  const M = globalThis.M6PROBE || {}
  return { state: String(M.state || ''), why: String(M.why || ''),
           isolated: M.isolated === true, modes: M.modes || {} }
})()"""


def one_mode(page, base: str, remote: str, mode: str, timeout: float = 90.0) -> dict:
    page.navigate("%s/bench/m6-realm/csp-probe.html?modes=%s&csp=%s&remote=%s"
                  % (base, mode, mode, remote))
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        got = page.evaluate(READ)
        if got["state"] in ("done", "aborted", "error"):
            return got
        time.sleep(0.25)
    return {"state": "timeout", "why": "the page never reached a terminal state", "modes": {}}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--modes", default=",".join(MODES))
    ap.add_argument("--no-isolation", action="store_true",
                    help="omit COOP/COEP, to prove this probe refuses to report a number")
    args = ap.parse_args(argv)

    ProbeHandler.isolate = not args.no_isolation
    base, httpd = serve(ProbeHandler, REPO)
    remote, hostile = serve(HostileHandler, REPO / "bench" / "m6-realm")
    print("probe server  : %s  [%s]" % (base, "ISOLATED" if ProbeHandler.isolate else "NOT ISOLATED"))
    print("hostile origin: %s  (CORS-open, second port = second origin)" % remote)
    print()
    rows = {}
    try:
        with cdp.Browser() as browser:
            page = browser.page()
            for mode in args.modes.split(","):
                got = one_mode(page, base, remote, mode)
                if got["state"] != "done":
                    print("csp=%-8s  NOT MEASURED: %s %s" % (mode, got["state"], got["why"]))
                    rows[mode] = {"state": got["state"], "why": got["why"]}
                    continue
                if not got["isolated"]:
                    print("csp=%-8s  NOT MEASURED: the renderer was not isolated" % mode)
                    rows[mode] = {"state": "not isolated"}
                    continue
                rows[mode] = got["modes"].get(mode, {})
                report(mode, rows[mode])
    finally:
        httpd.shutdown()
        hostile.shutdown()

    out = REPO / "bench" / "m6-realm" / "csp-probe.json"
    out.write_text(json.dumps(rows, indent=2) + "\n")
    print("\nwritten: %s" % out.relative_to(REPO))
    return 0


def report(mode: str, row: dict) -> None:
    if not row.get("started"):
        print("csp=%-8s  THE WORKER DID NOT RUN: %s" % (mode, row.get("why")))
        print("           (a realm with no rows is not a bounded realm — the policy refused the "
              "worker's own module)")
        return
    print("csp=%s" % mode)
    for name, r in (row.get("rows") or {}).items():
        if name == "imports":
            for key, value in r.items():
                print("   import %-12s %s" % (
                    key, ("REACHED  " + str(value.get("value"))) if value.get("ok")
                    else ("refused  " + str(value.get("why"))[:90])))
        else:
            print("   %-19s %s" % (
                name, ("REACHED  " + str(r.get("value"))[:70]) if r.get("ok")
                else ("refused  " + str(r.get("why"))[:90])))
    violations = row.get("violations") or []
    print("   violations        %s" % (
        json.dumps([v.get("directive", "") + " " + v.get("blockedURI", "") for v in violations])
        if violations else "none"))
    print()


if __name__ == "__main__":
    raise SystemExit(main())
