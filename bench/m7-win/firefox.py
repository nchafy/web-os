#!/usr/bin/env python3
"""Render `www/m7.html` in a HEADLESS FIREFOX and keep the PNG, because these pages print their
own log as text.

    python3 bench/m7-win/firefox.py                 # the five proofs and the verdict
    python3 bench/m7-win/firefox.py --live          # the desktop only
    python3 bench/m7-win/firefox.py --hold-ms 40000 # a slower machine

WHY THIS EXISTS AT ALL. The suite drives Chrome only, and that gap has cost two milestones: M4a
shipped a window that could not be dragged in Firefox (constraint 175) and M6 shipped a policy
under which NO PROCESS STARTED in Firefox at all (constraint 206) — both with every Chrome
expectation green, both found by a person opening the page. `CLAUDE.md` makes a second engine a
condition of reporting a milestone done.

HOW IT WORKS, and the one trick that makes it work. Mozilla removed CDP, so there is no driver:
`firefox --headless --screenshot` renders the page and exits on the LOAD EVENT, which for this
page fires about seventeen seconds before the proofs finish. So this server injects a slow
subresource — an `<img>` whose response is held open — into the HTML it serves, which keeps the
load event pending until the page has had time to finish. The file on disk is untouched; only the
response is rewritten, which is the same shape as M3's `usr-404` control.

The PNG is evidence a reader looks at. This script asserts nothing: it reports what Firefox did and
leaves the verdict to whoever reads the image, which is the honest division when the only channel
is a picture.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from serve import Handler, Server  # noqa: E402

#: The subresource that holds the load event open. An `<img>` and not a script, because a script
#: would block the module graph and the page would not run at all.
SLOW_PATH = "/__slow__/hold.png"

FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox"

#: Which page is being rendered, as a one-element list so the handler closure reads the current
#: value rather than one captured at import.
PAGE = ["m7.html"]


def make_handler(hold_ms: int):
    class Injecting(Handler):
        def send_head(self):
            if self.path.startswith("/__slow__/"):
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.end_headers()
                # Held, then closed with nothing. Firefox treats the image as still loading, so
                # the load event waits — which is the whole point.
                deadline = time.monotonic() + hold_ms / 1000.0
                while time.monotonic() < deadline:
                    if getattr(self.server, "_stop", False):
                        break
                    time.sleep(0.2)
                return None
            return Handler.send_head(self)

        def do_GET(self):
            # The HTML gets the slow image appended. Everything else is served verbatim, so the
            # module graph the browser loads is the one on disk.
            if self.path.split("?")[0].endswith(PAGE[0]):
                body = (ROOT / "www" / PAGE[0]).read_bytes()
                tag = ('<img src="%s" alt="" width="1" height="1" '
                       'style="position:fixed;left:-10px">' % SLOW_PATH).encode()
                body = re.sub(rb"</body>", tag + b"</body>", body, count=1)
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                # `Handler.end_headers` adds COOP/COEP and the no-store, so the injected response
                # is isolated exactly as the file on disk would be. Without that the page aborts
                # on its own preflight, which would look like a Firefox failure and is not one.
                self.end_headers()
                self.wfile.write(body)
                return
            return Handler.do_GET(self)

    return Injecting


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--live", action="store_true", help="the desktop only, no proofs")
    ap.add_argument("--hold-ms", type=int, default=32000,
                    help="how long to hold the load event open (default 32000)")
    ap.add_argument("--page", default="m7", help="which www/<page>.html to render")
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    if not pathlib.Path(FIREFOX).exists():
        print("no Firefox at %s — install it or point FIREFOX at one" % FIREFOX)
        return 3

    PAGE[0] = "%s.html" % args.page
    out = pathlib.Path(args.out or (ROOT / "bench" / "m7-win" / ("firefox-%s.png" % args.page)))
    handler = functools.partial(make_handler(args.hold_ms), directory=str(ROOT))
    httpd = Server(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    url = "http://127.0.0.1:%d/www/%s%s" % (port, PAGE[0], "?live=1" if args.live else "")
    print("url      %s" % url)
    profile = tempfile.mkdtemp(prefix="m7-firefox-")
    try:
        # A FRESH PROFILE, so a previous run's permissions or cache cannot explain a result.
        proc = subprocess.run(
            [FIREFOX, "--headless", "--profile", profile, "--window-size", "1400,1100",
             "--screenshot", str(out), url],
            capture_output=True, text=True, timeout=args.hold_ms / 1000.0 + 60)
        print("firefox  exit %d" % proc.returncode)
        for line in (proc.stderr or "").splitlines():
            # Firefox is noisy on stderr; the lines worth keeping name a failure.
            if any(k in line for k in ("JavaScript", "Error", "error", "Warning: ", "Blocked")):
                print("  %s" % line[:200])
    finally:
        httpd._stop = True
        httpd.shutdown()
        httpd.server_close()
        shutil.rmtree(profile, ignore_errors=True)
    if not out.exists():
        print("NO SCREENSHOT was written, so Firefox did not render the page at all")
        return 1
    print("png      %s (%d bytes) — READ IT: the page prints its own log, and the verdict line is"
          " at the bottom of it" % (out, out.stat().st_size))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
