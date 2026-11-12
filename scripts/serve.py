#!/usr/bin/env python3
"""Static server that sends the two headers the kernel cannot exist without.

`SharedArrayBuffer` is only constructible in a cross-origin isolated context, and the whole
syscall channel is a SAB. Without these headers there is no kernel, so this file is not a
convenience — it is the first dependency.

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp

`require-corp` and not `credentialless`: credentialless is Chrome 96 / Firefox 119 / Safari
never, so it is a relaxation and never a plan. See docs/CONSTRAINTS.md constraint 31.

Usage:
    scripts/serve.py                 # serve ./www on 8000
    scripts/serve.py --port 8771 --root .
    scripts/serve.py --no-isolation  # deliberately omit the headers, to prove a check fails
"""

from __future__ import annotations

import argparse
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

#: Sent on every response, including errors. A header set on only the document is not enough:
#: a worker script fetched without COEP is a worker that cannot hold a SAB.
ISOLATION_HEADERS = (
    ("Cross-Origin-Opener-Policy", "same-origin"),
    ("Cross-Origin-Embedder-Policy", "require-corp"),
)

#: Extensions the stdlib guesses wrongly or not at all. `.mjs` as `text/plain` is a module that
#: never loads, and the browser's error names neither the file nor the reason.
EXTRA_TYPES = {
    ".mjs": "text/javascript",
    ".wasm": "application/wasm",
    ".json": "application/json",
    ".pbf": "application/x-protobuf",
}


class Handler(SimpleHTTPRequestHandler):
    isolate = True

    def send_head(self):
        # The default root is the repository root, which contains .git and .claude. Nothing
        # dot-prefixed is ever part of the OS being served, so refuse it rather than rely on
        # this only ever binding to loopback.
        from urllib.parse import unquote, urlparse
        path = unquote(urlparse(self.path).path)
        if any(seg.startswith(".") and seg not in ("", ".") for seg in path.split("/")):
            self.send_error(404, "Not Found")
            return None
        return super().send_head()

    def list_directory(self, path):
        # Hide what send_head already refuses: a listing that advertises .git and then 404s
        # every link is a worse version of the same answer. Written out rather than monkey-
        # patching os.listdir, because this is a ThreadingHTTPServer and that would race.
        import html
        import io
        from urllib.parse import quote, unquote, urlparse
        try:
            names = sorted(n for n in os.listdir(path) if not n.startswith("."))
        except OSError:
            self.send_error(404, "No permission to list directory")
            return None
        here = html.escape(unquote(urlparse(self.path).path), quote=False)
        rows = []
        for name in names:
            disp = name + ("/" if os.path.isdir(os.path.join(path, name)) else "")
            rows.append(f'<li><a href="{quote(disp)}">{html.escape(disp)}</a></li>')
        body = (
            "<!doctype html><meta charset=utf-8>"
            f"<title>{here}</title>"
            "<style>body{font:14px/1.6 ui-monospace,Menlo,monospace;margin:2rem;color:#1a2430}"
            "a{color:#2f7fd4}h1{font-size:15px}ul{list-style:none;padding:0}</style>"
            f"<h1>{here}</h1><ul>{''.join(rows)}</ul>"
        ).encode("utf-8", "surrogateescape")
        self.send_response(200)
        self.send_header("Content-type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        return io.BytesIO(body)

    def end_headers(self) -> None:
        if self.isolate:
            for name, value in ISOLATION_HEADERS:
                self.send_header(name, value)
        # No-store, because a cached pre-isolation response is a confusing half-hour.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        for ext, mime in EXTRA_TYPES.items():
            if str(path).endswith(ext):
                return mime
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


#: Resolved from this file's own location, not the caller's cwd. `serve.py` has to work from
#: anywhere — running it from a parent directory used to fail with "no such directory: ./www",
#: which blamed the user for the script's assumption.
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument(
        "--root",
        default=REPO,
        help="directory to serve. Defaults to the repository root, so /, /mockups/ and /bench/ "
        "are all reachable from one server — the harnesses in bench/ already assume that.",
    )
    ap.add_argument(
        "--no-isolation",
        action="store_true",
        help="omit COOP/COEP. Only for proving that a check which requires isolation fails "
        "without it — a harness nobody has seen fail is a harness nobody has checked.",
    )
    args = ap.parse_args(argv)

    root = os.path.abspath(args.root)
    if not os.path.isdir(root):
        print(f"serve.py: no such directory: {root}", file=sys.stderr)
        print(f"serve.py: the default is the repository root, {REPO}", file=sys.stderr)
        return 2
    os.chdir(root)

    Handler.isolate = not args.no_isolation
    state = "ISOLATED" if Handler.isolate else "NOT ISOLATED (--no-isolation)"
    print(f"serve.py: {root}", file=sys.stderr)
    print(f"serve.py: http://127.0.0.1:{args.port}/  [{state}]", file=sys.stderr)
    if os.path.isdir(os.path.join(root, "www")):
        print(f"serve.py:   preflight  http://127.0.0.1:{args.port}/www/", file=sys.stderr)
    if os.path.isdir(os.path.join(root, "mockups")):
        print(f"serve.py:   mockups    http://127.0.0.1:{args.port}/mockups/", file=sys.stderr)
    if not Handler.isolate:
        print(
            "serve.py: SharedArrayBuffer will be undefined. The kernel cannot boot.",
            file=sys.stderr,
        )

    # Loopback only. Nothing here is meant to be reachable from another machine.
    try:
        ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
