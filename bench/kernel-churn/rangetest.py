#!/usr/bin/env python3
"""Is `scripts/serve.py`'s byte-range server byte-exact? And does it refuse what it cannot serve?

WHY THIS IS NOT ONLY ABOUT THE PROVIDER. `_send_range` was written because the harness is the
storage provider `/usr` mounts over (`src/kernel/providers.mjs`), so a ranged block read had to be
genuine. But the server log shows Chrome issuing **206 requests for ES modules** —
`GET /src/libos/syscall.mjs HTTP/1.1 206` — so the same hand-rolled code is on the module-loading
path for the kernel and every process worker.

That raises the stakes. A module served one byte short imports as a syntax error, and a worker
whose module graph fails to load never posts anything at all: the page sees a kernel that never
came up, with no error on any channel it watches. That is one candidate mechanism for the
intermittent `timed out waiting for spawned` in `www/m4b.html`, and unlike a timing hypothesis it
is decidable — either the ranges are byte-exact or they are not.

    python3 bench/kernel-churn/rangetest.py
"""

import functools
import http.server
import pathlib
import sys
import threading
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from serve import Handler  # noqa: E402

TARGET = "/src/abi.mjs"


def main():
    blob = (ROOT / TARGET.lstrip("/")).read_bytes()
    n = len(blob)
    httpd = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(Handler, directory=str(ROOT)))
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d%s" % (port, TARGET)
    print("%s is %d bytes" % (TARGET, n))

    def get(header):
        req = urllib.request.Request(base, headers={"Range": header})
        with urllib.request.urlopen(req) as r:
            return r.status, r.read(), dict(r.headers)

    bad = []
    #: header -> the slice it must return. The last three are the forms a resuming client sends.
    served = [
        ("bytes=0-", 0, n - 1),
        ("bytes=0-0", 0, 0),
        ("bytes=0-99", 0, 99),
        ("bytes=100-199", 100, 199),
        ("bytes=%d-" % (n - 1), n - 1, n - 1),
        ("bytes=-50", n - 50, n - 1),
        # A suffix longer than the file is the whole file, not an error.
        ("bytes=-%d" % (n + 10), 0, n - 1),
        # An end past the file is clamped, which is what makes a block device's last read work.
        ("bytes=%d-%d" % (n - 10, n + 100), n - 10, n - 1),
    ]
    for header, lo, hi in served:
        want = blob[lo:hi + 1]
        try:
            status, body, headers = get(header)
        except urllib.error.HTTPError as error:
            bad.append("%-24s HTTP %s, want 206" % (header, error.code))
            continue
        problems = []
        if status != 206:
            problems.append("status %s" % status)
        if body != want:
            problems.append("sent %d bytes, want %d" % (len(body), len(want)))
        clen = headers.get("Content-Length")
        # THE PROMISE AND THE BODY MUST AGREE. A 206 carrying more or fewer bytes than its
        # Content-Length is the failure `src/kernel/providers.mjs` refuses a provider for, and on
        # a keep-alive connection it would also desynchronise the next request.
        if clen is not None and int(clen) != len(body):
            problems.append("Content-Length %s but sent %d" % (clen, len(body)))
        if problems:
            bad.append("%-24s %s  [%s]" % (header, "; ".join(problems),
                                           headers.get("Content-Range")))
        else:
            print("%-24s ok  %6d bytes  %s" % (header, len(body),
                                               headers.get("Content-Range")))

    #: Must be REFUSED. Answering the whole file for a range this server cannot serve is the
    #: `unpkg.com` failure the provider probe exists to catch.
    refused = ("bytes=%d-" % (n + 5), "bytes=0-10,20-30", "bytes=abc", "bytes=-")
    for header in refused:
        try:
            status, body, _ = get(header)
            bad.append("%-24s HTTP %s with %d bytes, must be 416"
                       % (header, status, len(body)))
        except urllib.error.HTTPError as error:
            if error.code == 416:
                print("%-24s refused with 416 as required" % header)
            else:
                bad.append("%-24s HTTP %s, want 416" % (header, error.code))

    print()
    if bad:
        print("FAIL (%d):" % len(bad))
        for line in bad:
            print("  -", line)
        return 1
    print("every range is byte-exact, every promise matches its body, every bad range refused")
    return 0


if __name__ == "__main__":
    sys.exit(main())
