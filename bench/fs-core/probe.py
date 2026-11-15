#!/usr/bin/env python3
"""M2: the three proofs, driven in headless Chrome.

Binds `scripts/serve.py`'s Handler on the REPOSITORY ROOT — `www/m2.html` imports `/src/abi.mjs`,
`/src/fs/journal.mjs` and `/bench/fs-core/program.mjs`, and copying `src/` into `www/` would be the
hand-synced-copy defect — then drives the page through `scripts/cdp.py`.

IT ABORTS WITHOUT PRINTING A VERDICT unless `crossOriginIsolated` is true in the page AND in the
kernel worker. The kernel's SharedArrayBuffer is not constructible otherwise, so there is no
filesystem to mount and no proof to take; `--no-isolation` runs that path to prove it is taken.

    bench/fs-core/probe.py                       # the three proofs, 10,000 files
    bench/fs-core/probe.py --files 200           # the fast loop
    bench/fs-core/probe.py --no-cow-order        # negative control, stage 1
    bench/fs-core/probe.py --no-crc              # negative control, stage 2
    bench/fs-core/probe.py --serve-only          # the page in your own browser
"""

from __future__ import annotations

import argparse
import contextlib
import json
import re
import sys
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))

from cdp import Browser, CDPError  # noqa: E402
from serve import Handler  # noqa: E402

READ = """(() => {
  const M = globalThis.M2 || {}
  const p = M.proofs || {}
  const one = (x) => x === null || x === undefined
    ? null : { ok: x.ok === true, evidence: x.evidence || {} }
  return {
    state: String(M.state || ''), why: String(M.why || ''),
    verdict: String(M.verdict || ''),
    isolated: M.isolated === true, kernelIsolated: M.kernelIsolated === true,
    fingerprint: String(M.pageFingerprint || ''),
    config: M.config || {},
    faults: (M.faults || []).map((f) => String(f.pid) + ': ' + String(f.why)),
    errors: (M.errors || []).map(String),
    proof_a: one(p.proof_a), proof_b: one(p.proof_b), proof_c: one(p.proof_c),
    proof_d: one(p.proof_d), pending: one(p.pending), drop: one(p.drop),
    cas: one(p.cas), orphan: one(p.orphan),
    refuse: one(p.refuse), unreadable: one(p.unreadable),
    append: one(p.append), order: one(p.order), api: one(p.api),
    asyncFail: Number(M.asyncFail), statsReads: Number(M.statsReads),
  }
})()"""

READY = ("(() => { const s = globalThis.M2 && globalThis.M2.state; "
         "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")


class Serving:
    """serve.py's Handler on an ephemeral port, in a thread, rooted at the repository."""

    def __init__(self, root: Path, *, isolate: bool = True) -> None:
        self.root = root
        self.isolate = isolate
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self.port = 0

    def __enter__(self) -> "Serving":
        root = str(self.root)

        class Bound(Handler):
            isolate = self.isolate

            def __init__(inner, *a, **kw):  # noqa: N805
                super().__init__(*a, directory=root, **kw)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Bound)
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()


def chrome_full_version(page) -> str:
    """The full build, from CDP. `navigator.userAgent` in headless reports a REDUCED version, and
    a figure that cannot name its patch build cannot be compared with docs/CONSTRAINTS.md's."""
    product = (page.call("Browser.getVersion") or {}).get("product", "")
    match = re.search(r"Chrome/([\d.]+)", product)
    return match.group(1) if match else (product or "unknown")


def settle(page, timeout: float, poll: float = 0.25):
    """Poll until the page is terminal.

    `poll` is a parameter because the interval is not free and the harness has to be able to
    price its own instrument: scripts/check.py polls at 20 ms, and every poll is a
    `Runtime.evaluate` that runs on the page's main thread — the same thread the page's
    `worker.onmessage` handlers and promise continuations run on.
    """
    t0 = time.monotonic()
    polls = 0
    while time.monotonic() - t0 < timeout:
        state = page.evaluate(READY)
        polls += 1
        if state:
            return state, time.monotonic() - t0, polls
        time.sleep(poll)
    return "", time.monotonic() - t0, polls


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--files", type=int, default=10000,
                    help="proof (a)'s file count. 10,000 is the milestone's figure.")
    ap.add_argument("--timeout", type=float, default=600.0)
    ap.add_argument("--no-isolation", action="store_true",
                    help="serve without COOP/COEP, to prove the page refuses")
    ap.add_argument("--no-cow-order", action="store_true",
                    help="negative control stage 1: drop the data-before-metadata ordering")
    ap.add_argument("--no-crc", action="store_true",
                    help="negative control stage 2: stop checking the journal's CRC")
    ap.add_argument("--poll", type=float, default=0.25,
                    help="readiness poll interval in seconds. scripts/check.py "
                         "uses 0.02; this is how that cost is priced.")
    ap.add_argument("--like-check", action="store_true",
                    help="apply scripts/check.py's page setup, to attribute a "
                         "difference between this probe and the suite")
    ap.add_argument("--serve-only", action="store_true")
    ap.add_argument("--json", type=Path, default=None)
    args = ap.parse_args(argv)

    query = [f"a_n={args.files}"]
    if args.no_cow_order:
        query.append("no_cow_order=1")
    if args.no_crc:
        query.append("no_crc=1")
    path = "/www/m2.html?" + "&".join(query)

    with Serving(REPO, isolate=not args.no_isolation) as serving:
        url = f"http://127.0.0.1:{serving.port}{path}"
        if args.serve_only:
            print(f"serving {url}  (ctrl-c to stop)")
            try:
                while True:
                    time.sleep(1)
            except KeyboardInterrupt:
                return 0
        try:
            with contextlib.ExitStack() as stack:
                browser = stack.enter_context(Browser())
                page = browser.page()
                if args.like_check:
                    # Exactly what scripts/check.py does to a page before it navigates. Here as a
                    # switch rather than always-on because it is the only difference between this
                    # probe and the suite, and a 5x gap between the two had to be attributed to
                    # something rather than guessed at.
                    page.call("Runtime.enable")
                    page.call("Log.enable")
                    page.call("Page.enable")
                    page.clear_cache()
                    page.emulate_device(width=1280, height=820, scale_factor=2, mobile=False)
                    page.call("Emulation.setFocusEmulationEnabled", enabled=True)
                build = chrome_full_version(page)
                print(f"fs-core/probe.py  Chrome {build}  files {args.files}  "
                      f"isolation {'off' if args.no_isolation else 'on'}"
                      f"{'  no-cow-order' if args.no_cow_order else ''}"
                      f"{'  no-crc' if args.no_crc else ''}")
                page.navigate(url, timeout=60)
                state, waited, polls = settle(page, args.timeout, args.poll)
                # Read it either way. A page that did not finish still knows which proof it was
                # in, and the alternative measured here was a bare "never reached a terminal
                # state" with no way to tell a hung kernel from a hung proof.
                got = page.evaluate(READ)
                if not state:
                    print(f"  the page never reached a terminal state in {waited:.1f}s; "
                          f"it was at state {got['state']!r}", file=sys.stderr)
                    for fault in got["faults"]:
                        print(f"    FAULT {fault}", file=sys.stderr)
                    for error in got["errors"][:10]:
                        print(f"    page error: {error}", file=sys.stderr)
                    return 3
        except CDPError as error:
            print(f"  could not drive Chrome: {error}", file=sys.stderr)
            return 3

    print(f"  state {got['state']}  verdict {got['verdict'] or '-'}  "
          f"settled in {waited:.1f}s after {polls} poll(s) at {args.poll * 1000:.0f} ms")
    if got["why"]:
        print(f"  why: {got['why'][:400]}")
    print(f"  config: {json.dumps(got['config'])}")
    print(f"  asyncFail {got['asyncFail']} over {got['statsReads']} kernel(s) read")
    for name in ("proof_a", "proof_b", "proof_c", "proof_d", "pending", "drop", "cas", "orphan",
                 "refuse", "unreadable", "append", "order", "api"):
        p = got[name]
        if p is None:
            print(f"  {name}: DID NOT RUN")
            continue
        print(f"  {name}: {'ok' if p['ok'] else 'FAIL'}")
        print("    " + json.dumps(p["evidence"])[:3000])
    for fault in got["faults"]:
        print(f"  FAULT {fault}", file=sys.stderr)
    for error in got["errors"][:10]:
        print(f"  page error: {error}", file=sys.stderr)

    if args.json:
        args.json.write_text(json.dumps({"chrome": build, **got}, indent=2), encoding="utf-8")

    if args.no_isolation:
        # The refusal IS the product here: a page that measured anything without COOP/COEP would
        # be measuring a different system.
        ok = got["state"] == "aborted"
        print(f"  no-isolation: the page {'refused' if ok else 'DID NOT REFUSE'}")
        return 0 if ok else 1
    return 0 if got["state"] == "done" and got["verdict"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
