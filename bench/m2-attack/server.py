"""Static server that attaches per-path isolation headers, so one process can
serve both an isolated origin and a deliberately non-isolated control origin."""
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent / "www"

# Path -> extra response headers. "/plain/*" is the negative control: no COOP/COEP,
# so cross-origin isolation must NOT be granted there.
EXTRA = {
    "isolated": [
        ("Cross-Origin-Opener-Policy", "same-origin"),
        ("Cross-Origin-Embedder-Policy", "require-corp"),
        ("Cross-Origin-Resource-Policy", "cross-origin"),
    ],
    "plain": [
        ("Cross-Origin-Resource-Policy", "cross-origin"),
    ],
}

TYPES = {".html": "text/html", ".js": "text/javascript"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def do_GET(self):
        path = self.path.split("?")[0]
        mode = "plain" if path.startswith("/plain/") else "isolated"
        name = path.rsplit("/", 1)[-1] or "top.html"
        target = ROOT / name
        if not target.is_file():
            self.send_error(404, "no %s" % name)
            return
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(target.suffix, "text/plain"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in EXTRA[mode]:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(sys.argv[1])
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
