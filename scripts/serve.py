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
    scripts/serve.py                 # serve the REPOSITORY ROOT on 8000; preflight at /www/
    scripts/serve.py --port 8771 --root www
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

#: Every response under this prefix carries the process realm's policy. A PREFIX and not the one
#: filename, because `src/libos/` IS the process realm in file form (CLAUDE.md) — and because the
#: worker's entry path is `src/kernel/kernel.mjs`'s business (`RUNTIME_URL`), so a server that
#: named the file would be a second copy of a constant the kernel owns.
PROCESS_REALM_PREFIX = "/src/libos/"

#: M6's second half. A Content-Security-Policy on the response that CREATES the process realm.
#:
#: WHERE IT IS DELIVERED IS A MEASURED FACT, not a preference. `bench/m6-realm/csp-probe.py`
#: measured all four deliveries on Chrome 157.0.8103.52: a policy on the DOCUMENT changes nothing
#: for a dedicated module worker's loader — the `document` mode is behaviour-identical to `none`,
#: with zero violations reported — so it has to be on the worker script's own response.
#: `docs/CONSTRAINTS.md` 187 carries the table, and 188 records the correction to 139, which named
#: the document.
#:
#: WHAT EACH DIRECTIVE IS FOR:
#:   script-src 'self' blob:   `'self'` because the libos's own static imports are same-origin;
#:                             `blob:` because a program image IS a blob URL (src/kernel/exec.mjs).
#:                             Absent `'unsafe-eval'`, which is what refuses `eval` and
#:                             `new Function` — measured, in the program as well as in the worker.
#:   connect-src 'none'        the network, for the bindings the strip already removed. Belt and
#:                             braces on purpose: the strip is in-realm and this is not.
#:   default-src 'none'        everything not named above.
#:
#: `worker-src 'none'` WAS HERE AND HAD TO COME OUT, because Firefox applies a worker script's own
#: `worker-src` to THAT WORKER'S OWN CREATION: with it, Firefox refuses to start the very worker
#: the policy describes, and the process worker never runs. The failure is silent by nature — an
#: error event with an empty message, no filename and line 0 — so the kernel could only report
#: `process 1 runtime: error`. Chrome applies the directive to workers created BY the realm, which
#: is what M6 wanted it for. Measured on Firefox 156.0.1 / Chrome 157.0.8103.52, both directions
#: and against `child-src 'none'` too, which Firefox treats the same. Constraint 206.
#: NOTHING IS LOST: `src/libos/lockdown.mjs` deletes `Worker`, `SharedWorker` AND
#: `URL.createObjectURL`, so a process cannot construct a worker at all. The policy was belt and
#: braces there, and the strip is the mechanism constraint 53 actually requires.
#: The two halves are disjoint and both are needed: this policy does NOT touch OPFS, `indexedDB`,
#: `caches` or `URL.createObjectURL` (measured), and the strip does not touch the module loader.
PROCESS_REALM_CSP = (
    "default-src 'none'; script-src 'self' blob:; connect-src 'none'"
)

#: Extensions the stdlib guesses wrongly or not at all. `.mjs` as `text/plain` is a module that
#: never loads, and the browser's error names neither the file nor the reason.
EXTRA_TYPES = {
    ".mjs": "text/javascript",
    ".wasm": "application/wasm",
    ".json": "application/json",
    ".pbf": "application/x-protobuf",
}


#: The sentinel `_send_range` returns when the request is not a range it serves AND it has sent
#: no response, so `send_head` may fall through to the whole-file path. A bare `None` cannot carry
#: that: `None` is also what `send_head` returns after it HAS answered (a 404 or a 416), and
#: conflating the two would send a second set of headers onto an answered request.
_RANGE_PASS = object()


class _Limited:
    """A file object that stops after `remaining` bytes.

    `SimpleHTTPRequestHandler.do_GET` hands whatever `send_head` returns to
    `shutil.copyfileobj`, which reads to EOF. A plain seek would therefore send the rest of the
    file after the requested range — a 206 carrying more bytes than it promised, which is the
    exact failure the capability probe in `src/kernel/providers.mjs` refuses a provider for.
    """

    def __init__(self, fp, remaining):
        self._fp = fp
        self._remaining = remaining

    def read(self, size=-1):
        if self._remaining <= 0:
            return b""
        if size is None or size < 0 or size > self._remaining:
            size = self._remaining
        chunk = self._fp.read(size)
        self._remaining -= len(chunk)
        return chunk

    def close(self):
        self._fp.close()


class Handler(SimpleHTTPRequestHandler):
    isolate = True
    #: M6. False omits the process realm's policy, to prove a check that needs it fails without
    #: it. The same role `isolate` plays for COOP/COEP — a control that cannot be switched off has
    #: not been shown to be the control.
    csp = True

    def _in_process_realm(self) -> bool:
        """Does this response create, or sit inside, the process realm?

        ASKED OF THE RESOLVED FILE, never of the request's spelling, and that is the whole point
        of this function. Two spellings of one file must not get two different policies, in either
        direction: `/src/libos/../kernel/kernel.mjs` is the KERNEL, which fetches providers and
        mints program images, so handing it `connect-src 'none'` would break the system with no
        visible cause — and anything that resolves to `src/libos/` is a process realm and must
        carry the policy however it was asked for.

        A NORMALIZED PREFIX TEST WAS NOT ENOUGH, and an adversarial review measured it:
        `GET /%2fsrc/libos/process.mjs` served the real `process.mjs` — byte-identical, 13,675
        bytes — with NO policy, because `unquote` runs after `urlparse` and `normpath` keeps the
        two leading slashes that `%2f` produces, while `translate_path` collapses them and serves
        the file anyway. A process worker created from that URL would have had an unbounded module
        loader: `eval` and a computed `import(expr)` both work. Deferring to `translate_path` —
        the same resolution that decides which bytes are sent — closes the whole class rather than
        the spelling that was found.
        """
        try:
            resolved = os.path.realpath(self.translate_path(self.path))
            realm = os.path.realpath(os.path.join(
                getattr(self, "directory", os.getcwd()),
                *PROCESS_REALM_PREFIX.strip("/").split("/")))
        except (OSError, ValueError):
            # A path the resolver cannot make sense of is not a response this server will serve
            # from the process realm either. Fail closed in the direction that matters: no claim.
            return False
        return resolved == realm or resolved.startswith(realm + os.sep)

    def send_head(self):
        # The default root is the repository root, which contains .git and .claude. Nothing
        # dot-prefixed is ever part of the OS being served, so refuse it rather than rely on
        # this only ever binding to loopback.
        from urllib.parse import unquote, urlparse
        path = unquote(urlparse(self.path).path)
        if any(seg.startswith(".") and seg not in ("", ".") for seg in path.split("/")):
            self.send_error(404, "Not Found")
            return None
        if self.headers.get("Range"):
            handled = self._send_range(self.headers["Range"])
            # None means "not a range this server serves" AND no response sent, so fall through
            # to the whole-file path. A range that WAS handled, or refused with 416, has already
            # answered and must not be answered twice.
            if handled is not _RANGE_PASS:
                return handled
        return super().send_head()

    def _send_range(self, header):
        """Serve one byte range, or refuse.

        THIS EXISTS BECAUSE THE HARNESS IS A STORAGE PROVIDER. `src/kernel/providers.mjs` mounts
        `/usr` over a provider that must serve genuine ranged block reads, and the `local`
        provider is this server — so a check of the provider interface against a server that
        ignored `Range` would be testing nothing, and `mountProvider`'s capability probe correctly
        refused to mount at all. Measured 2026-11-15: before this, a ranged request for 64 B
        returned 200 with the whole file, which is the `unpkg.com` failure
        (docs/LEARNING-MODE.md §5) reproduced locally.

        Single range only, which is all a block device needs. A multipart range is refused rather
        than silently answered with the first part.
        """
        import os as _os
        import re as _re
        path = self.translate_path(self.path)
        if _os.path.isdir(path):
            return _RANGE_PASS
        m = _re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
        if not m or (not m.group(1) and not m.group(2)):
            # Not a form this server handles. Answering the whole file would be a 200 for a
            # ranged request, so refuse explicitly instead.
            self.send_error(416, "Requested Range Not Satisfiable")
            return None
        try:
            fp = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None
        try:
            size = _os.fstat(fp.fileno()).st_size
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                # A suffix range: the last N bytes.
                start = max(0, size - int(m.group(2)))
                end = size - 1
            if start >= size or start > end:
                fp.close()
                self.send_response(416, "Requested Range Not Satisfiable")
                self.send_header("Content-Range", "bytes */%d" % size)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None
            end = min(end, size - 1)
            length = end - start + 1
            fp.seek(start)
            self.send_response(206, "Partial Content")
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            return _Limited(fp, length)
        except Exception:
            fp.close()
            raise

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
        if self.csp and self._in_process_realm():
            self.send_header("Content-Security-Policy", PROCESS_REALM_CSP)
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
    ap.add_argument(
        "--no-csp",
        action="store_true",
        help="omit the process realm's Content-Security-Policy on %s. M6's second negative "
        "control: a program's computed `import(expr)` and its `eval` must then SUCCEED."
        % PROCESS_REALM_PREFIX,
    )
    args = ap.parse_args(argv)

    root = os.path.abspath(args.root)
    if not os.path.isdir(root):
        print(f"serve.py: no such directory: {root}", file=sys.stderr)
        print(f"serve.py: the default is the repository root, {REPO}", file=sys.stderr)
        return 2
    os.chdir(root)

    Handler.isolate = not args.no_isolation
    Handler.csp = not args.no_csp
    state = "ISOLATED" if Handler.isolate else "NOT ISOLATED (--no-isolation)"
    if not Handler.csp:
        state += ", NO PROCESS-REALM CSP (--no-csp)"
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
