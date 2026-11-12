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


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--root", default="www")
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
        return 2
    os.chdir(root)

    Handler.isolate = not args.no_isolation
    state = "ISOLATED" if Handler.isolate else "NOT ISOLATED (--no-isolation)"
    print(f"serve.py: {root}", file=sys.stderr)
    print(f"serve.py: http://127.0.0.1:{args.port}/  [{state}]", file=sys.stderr)
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
