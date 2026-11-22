#!/usr/bin/env python3
"""The check harness. One entry point, one registry, one definition of inversion.

A harness nobody has seen fail is a harness nobody has checked (docs/CONSTRAINTS.md
constraint 39). Every row below is a way this harness could report a clean tree while
measuring nothing, paired with the thing that detects it and the exit code it produces.
If you add a mechanism, add its row. If you delete a row, you are claiming the failure
mode is impossible.

| failure mode                                        | detector                                          | exit |
|---|---|---|
| nothing listening                                   | serve() binds in-process; there is no port to miss | 3   |
| a stale copy of www/, or a wrong --root             | matches_disk byte-compares against CANONICAL       | 1   |
| server serving an empty root (200 + dir listing,    | serve()'s document preflight maps "/" to           | 3   |
|   so "got 200" proves nothing)                      |   root/index.html and byte-compares                |     |
| a check pointed at a document this tree does not    | the same preflight, over every document the        | 3   |
|   have: a second root, a renamed page               |   phase's checks declare                           |     |
| COOP/COEP absent, or a value isolating nothing      | serve() compares VALUES to ISOLATION_HEADERS       | 3   |
| a --no-isolation server that still sends them       | the same assertion, inverted (gate N2)             | 3   |
| no Chrome                                           | CDPError from cdp.find_chrome/_await_port          | 3   |
| a half-built DOM read at load-event time            | Env.settle on a readiness predicate; no sleep      | 3   |
| a navigate that was a no-op                         | Env.reload epoch stamp read back as None           | 3   |
| a check precondition that never held                | Unmeasurable -> BROKEN, never PASS, never SKIP     | 3   |
| a check body raising anything else                  | run_one catches Exception -> BROKEN, run continues | 3   |
| a check that asserted nothing                       | min_expectations, and PASS with count 0 -> BROKEN  | 3   |
| min_expectations lowered to match deleted asserts   | the committed floor in scripts/check_floors.json   | 3   |
| a label renamed, added or dropped in a check body   | run_one compares recorded labels to Check.labels   | 3   |
| a control that scores only some of a check's labels | audit rule 14: failed + held must cover the        | 3   |
|                                                     |   inventory, and `held` is derived from it          |     |
| an in-page table that did not run                   | boot's row-name set asserted before any row value  | 1   |
| console errors nobody looked at                     | per-check drain of all three CDP error events      | 1   |
| a check written and never registered                | registry.audit rules 1, 2 and 7                    | 3   |
| a check nothing can invert                          | INVERT is mandatory; the opt-out needs a reason    | 3   |
| invert_query used to point the inversion phase at   | audit rule 15: every key must already be in the    | 3   |
|   a different page, flag or mode                    |   check's own document                             |     |
| a control declared and never expected to fire       | audit ties Check.controls to CONTROLS[..].expects  | 3   |
| a page that did not refuse once isolation was gone  | gate N3, per document, off the registry's own      | 1   |
|                                                     |   refusal_expr - audit rule 12 requires one        |     |
| a --prove-failure that proved nothing               | gates I1/I2/I4: every inversion must fire          | 4   |
| a dead FAIL-to-exit-code path                       | gate I5: status() of the inverted phase is non-0   | 4   |
| a control phase that passed over its own strays     | one sweep (_strays) feeds every gate               | 4   |
| a negative control that ran and the check passed    | --negative compares outcome to the declared expect | 4   |

scripts/serve.py owns the server and the one definition of COOP/COEP. scripts/cdp.py owns
the only CDP driver. This file opens no socket of its own and writes no second driver.

Every phase binds its own server in-process on port 0, and there is no --port or --url. That
removes port collisions, someone-else's-server and a stale server left running from the set of
things this harness can be wrong about, rather than detecting them afterwards.

    scripts/check.py                       # the suite
    scripts/check.py --list
    scripts/check.py --controls
    scripts/check.py --only boot
    scripts/check.py --prove-failure       # invert every invertible expectation, and
                                           #   re-run the isolation-sensitive ones unisolated
    scripts/check.py --negative no-isolation
    scripts/check.py --negative kernel-stall
    scripts/check.py --bless               # record today's min_expectations as the floor

--prove-failure proves three things: that every inversion fires, that those failures reach the
report, and (gate I5) that the report would carry them to a non-zero exit status. It exits 0 when
the proof succeeded - non-zero is reserved for a proof that failed. It does not prove the
measurement is coupled to the subject: an assertion over a constant still inverts and still
fires. Only --negative closes that.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import dataclasses
import datetime
import difflib
import functools
import http.server
import itertools
import json
import pathlib
import shutil
import signal
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import (
    Any,
    Callable,
    Dict,
    Iterator,
    List,
    Mapping,
    NamedTuple,
    NoReturn,
    Optional,
    Tuple,
)

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent

#: The subject, resolved from this file and never from --root. matches_disk compares what the
#: server returned against THIS tree, so a run pointed at a stale or foreign copy of www/ cannot
#: report clean: comparing the server with its own document root compares it with itself
#: (CLAUDE.md, harness honesty). A phase serving a fixture-built tree carries its own canonical
#: root, because there the fixture's self-verification is the pin.
CANONICAL = REPO / "www"


class Root:
    """The document roots a check can declare. Two, because the trees genuinely differ.

    WWW is what a user's browser is pointed at, and is what --root may override.

    REPO exists because `www/m0.html` imports `/src/abi.mjs` and
    `/bench/syscall-contention/summarise.mjs`: the syscall numbers, the SAB offsets and the
    percentile rules have exactly one definition each, imported by the kernel, the process stub
    and the page alike (CLAUDE.md, code conventions), and `src/` sits outside the server root.
    Copying them into www/ is the hand-synced-copy defect this project names first, so the page
    is served from the repository root instead - the same choice
    bench/syscall-contention/probe.py:4-6 already made.

    REPO is resolved from this file, like CANONICAL, and no flag overrides it: there is no
    --root for it to be wrong about, which is why serving it and byte-comparing against it is
    not the server-compared-with-itself defect that _assert_serving's canonical= argument exists
    to prevent. The byte-compare still earns its keep - a partial read or a transforming proxy
    would fail it.
    """

    WWW = "www"
    REPO = "repo"


ROOTS = (Root.WWW, Root.REPO)

#: The committed ratchet for min_expectations. A declaration the eroding edit can also lower is
#: not a floor; a data file is a reviewable diff (docs/designs/REVIEW-FINDINGS.md:649, item (2)).
FLOORS = HERE / "check_floors.json"

if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import cdp  # noqa: E402  - scripts/ is sys.path[0] when this file is the entry point
from cdp import CDPError, Session  # noqa: E402
from serve import (  # noqa: E402
    ISOLATION_HEADERS, PROCESS_REALM_CSP, PROCESS_REALM_PREFIX, Handler, Server,
)
# M11's pixel reader. A `backdrop-filter` is applied by the compositor and is unreachable from
# script — `getImageData` reads a canvas and a DOM rasteriser applies no filter at all — so the one
# honest source for "did the glass blur" is a screenshot. `bench/m11-glass/probe.py` imports the
# same three functions, so the threshold it chose and the assertion made here are one arithmetic.
from png import (  # noqa: E402
    Image as Png, band_profile, local_range, transition,
)

#: Pinned to the machine every figure in docs/CONSTRAINTS.md was measured on: dpr 2, desktop.
#: cdp.py's emulate_device defaults mobile=True (cdp.py:236-238), which is wrong for a desktop
#: OS, and constraint 36 states the blur budget "at dpr 2" - measuring at dpr 1 measures a
#: different machine from the one the constraints were written on (CLAUDE.md:184).
VIEWPORT_WIDTH = 1280
VIEWPORT_HEIGHT = 820
VIEWPORT_SCALE = 2.0

#: Chrome asks for this on every navigation and www/ does not contain it. Keyed on the exact
#: request path the server recorded, never on a substring of a console message. An entry nothing
#: requested is reported as a dead allowance in the trailer's notes, so the list cannot accrue
#: unnoticed; an entry that now answers 200 IS a failure, because it would pre-forgive a real 404.
#: A 404 the suite forgives, keyed on the path. M3's provider capability probe deliberately asks
#: for an object that is not there, because a probe that only ever saw a present object could not
#: show it refuses a missing one — so the 404 is the measurement, not an accident. One path, used
#: by both the probe and the usr-404 control, so there is one allowance rather than two.
PROBE_MISSING_PATH = "/src/does-not-exist.mjs"
ALLOWED_404 = ("/favicon.ico", PROBE_MISSING_PATH)

#: Statuses that mean the server served what was asked for. 206 joined 200 when scripts/serve.py
#: learned single byte ranges: the `local` storage provider is this server, so a ranged block read
#: is a SUCCESS and counting it as "a file this tree does not serve" turned every /usr mount into
#: 14 witness failures. A 206 body is a FRAGMENT, so it is deliberately not byte-compared against
#: disk below — comparing a 64-byte range to a 36 kB file would fail for the wrong reason.
SERVED_OK = (200, 206)


# ======================================================================================
# serve.py additions (§2). Hosted here only because this task's path allowlist forbade
# editing scripts/serve.py; see the deviation note at the end of this file. ISOLATION_HEADERS
# is imported, not restated, so the COOP/COEP pair still has exactly one definition
# (scripts/serve.py:29-32), and Handler is subclassed rather than copied.
# ======================================================================================


class ServeError(RuntimeError):
    """The server is not serving the tree the harness was pointed at.

    `reason` is a code, not prose: --negative scores its gate expectation on it, so any
    ServeError at all must not satisfy a control that names one specific gate.
    """

    def __init__(self, message: str, *, reason: str = "") -> None:
        super().__init__(message)
        self.reason = reason


class Gate:
    NO_SUCH_ROOT = "no-such-root"
    #: One code per condition, never one code for three. --negative empty-root names the gate it
    #: expects, so a shared code would let a connection reset or a 404 satisfy a control whose
    #: whole subject is a root with no index.html.
    FETCH_FAILED = "fetch-failed"
    HTTP_STATUS = "http-status"
    NO_DOCUMENT = "no-document"
    WIRE_HEADERS = "wire-headers"
    NOT_THIS_TREE = "not-this-tree"
    UNREADABLE = "unreadable-canonical"
    FIXTURE = "fixture"


#: Set by every urllib fetch in this file and by nothing else, so a recorded response can say who
#: asked for it. Env.request reads only what the browser requested: a header assertion satisfied
#: by the harness's own fetch is an assertion about the harness.
HARNESS_REQUEST_HEADER = "X-Webos-Harness"
BROWSER = "browser"
HARNESS = "harness"


def _harness_get(url: str, timeout: float = 10.0):
    return urllib.request.urlopen(
        urllib.request.Request(url, headers={HARNESS_REQUEST_HEADER: "1"}), timeout=timeout)


class Served(NamedTuple):
    """One recorded response, as it went on the wire."""

    path: str
    status: int
    headers: Dict[str, str]
    requester: str


def _mapped(root: pathlib.Path, path: str) -> pathlib.Path:
    """The file a request target resolves to. "/" -> root/index.html, "/d/" -> root/d/index.html.

    Used by matches_disk and by the witness. Env.request matches on the path as requested
    instead, because a check asserting on response headers is asserting about a request.
    """
    target = urllib.parse.unquote(urllib.parse.urlsplit(path).path)
    if target.endswith("/"):
        target += "index.html"
    return root.joinpath(target.lstrip("/"))


class Serving:
    def __init__(self, base: str, root: pathlib.Path, canonical: pathlib.Path, isolated: bool,
                 log: List[Served], lock: threading.Lock) -> None:
        self.base = base
        self.root = root
        #: What the wire is compared against, independent of what this server was told to serve.
        self.canonical = canonical
        self.isolated = isolated
        self._log = log
        self._lock = lock

    def responses(self) -> Tuple[Served, ...]:
        with self._lock:
            return tuple(self._log)

    def last(self, path: str, requester: str = BROWSER) -> Served:
        for served in reversed(self.responses()):
            if served.path == path and served.requester == requester:
                return served
        raise ServeError(
            "the %s never requested %r, so there is no response to read that says anything "
            "about it. The server served: %s"
            % (requester, path, ", ".join(sorted(
                {"%s to the %s" % (s.path, s.requester) for s in self.responses()})) or "nothing"))

    def non_200(self) -> Tuple[Served, ...]:
        return tuple(s for s in self.responses() if s.status != 200)

    def matches_disk(self, path: str) -> bool:
        """Re-fetch and byte-compare against the mapped file under the CANONICAL root.

        Not under `self.root`: that is the directory this server was handed, so comparing
        against it compares the server with itself and the detector can never fire. Proves
        "what this server returns is the subject this harness claims to measure", not "these
        exact bytes reached the page". A server returning different bytes on a second read
        would defeat it; not a mode SimpleHTTPRequestHandler has.
        """
        on_disk = _mapped(self.canonical, path)
        if not on_disk.is_file():
            return False
        try:
            with _harness_get(self.base + path) as response:
                body = response.read()
        except (urllib.error.URLError, OSError):
            return False
        try:
            expected = on_disk.read_bytes()
        except OSError as error:
            # Not False: "the file does not match" and "the harness cannot read the file it
            # compares against" are different facts, and reporting the second as the first turns
            # a broken harness into a product failure at exit 1.
            raise ServeError(
                "the harness cannot read %s, which is what it compares the wire against, so this "
                "run is not evidence about this tree: %s" % (on_disk, error),
                reason=Gate.UNREADABLE) from error
        return body == expected


def _recording_handler(isolate: bool, log: List[Served], lock: threading.Lock,
                       csp: bool = True):
    """A per-server Handler subclass.

    Per-server and not Handler itself: Handler.isolate (serve.py:45) is a class attribute and
    os.chdir (serve.py:81) is process-global, so two servers in one process would share both.
    The root arrives through functools.partial(.., directory=..) instead.
    """

    class Recording(Handler):
        pass

    Recording.isolate = isolate
    # M6's second control, per server for the reason `isolate` is: both are class attributes on
    # serve.py's Handler, and two servers in one process would otherwise share them.
    Recording.csp = csp

    def send_response(self, code, message=None):
        self._recorded_status = int(code)
        self._recorded_headers = {}
        Handler.send_response(self, code, message)

    def send_header(self, keyword, value):
        # Accumulated here, reported in end_headers: the isolation headers are appended inside
        # Handler.end_headers (serve.py:47-53), so a recorder that only hooks send_response
        # sees the status and the path but never COOP/COEP.
        if getattr(self, "_recorded_headers", None) is None:
            self._recorded_headers = {}
        self._recorded_headers[str(keyword)] = str(value)
        Handler.send_header(self, keyword, value)

    def end_headers(self):
        Handler.end_headers(self)
        with lock:
            log.append(Served(
                path=self.path,
                status=int(getattr(self, "_recorded_status", 0)),
                headers=dict(getattr(self, "_recorded_headers", None) or {}),
                requester=HARNESS if self.headers.get(HARNESS_REQUEST_HEADER) else BROWSER,
            ))

    def log_message(self, fmt, *args):
        # serve.py:61-62 writes every request line to stderr, which would interleave with the
        # report. Dropped only because the structured record strictly dominates it: every
        # response's path, status and headers go into `log`, and the witness reports every
        # non-200 and every byte mismatch. Nothing observable is being swallowed.
        pass

    Recording.send_response = send_response
    Recording.send_header = send_header
    Recording.end_headers = end_headers
    Recording.log_message = log_message
    return Recording


@contextlib.contextmanager
def serve(root, *, canonical=None, port: int = 0, isolate: bool = True, csp: bool = True,
          documents: Tuple[str, ...] = ("/",)) -> Iterator[Serving]:
    """A ThreadingHTTPServer on a daemon thread, in this process, on an OS-chosen port.

    No subprocess, so nothing parses a child's stdout and port 0 is readable from
    server_address. Asserts its own isolation mode and EVERY document its checks will navigate
    to, on the wire, before yielding: a control that cannot fire is worse than no control, and a
    check whose page 404s must not get as far as reporting that it measured nothing interesting.
    """
    root = pathlib.Path(root).resolve()
    if not root.is_dir():
        raise ServeError("no such directory to serve: %s" % root, reason=Gate.NO_SUCH_ROOT)
    canonical = pathlib.Path(canonical or CANONICAL).resolve()

    log: List[Served] = []
    lock = threading.Lock()
    handler = functools.partial(
        _recording_handler(isolate, log, lock, csp), directory=str(root))
    # `serve.Server` AND NOT `ThreadingHTTPServer`: the listen backlog is the one thing these
    # pages outgrow, and a 5-deep queue refuses a connection that `fetch` reports as
    # `TypeError: Failed to fetch` (constraint 212). One definition, in serve.py.
    httpd = Server(("127.0.0.1", port), handler)
    bound = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    serving = Serving("http://127.0.0.1:%d" % bound, root, canonical, isolate, log, lock)
    try:
        for document in documents:
            _assert_serving(serving, document)
        _assert_policy(serving, csp)
        yield serving
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=10)


#: The one response M6's policy has to be on: the script that creates a process realm. Named here
#: so the gate below and `check_m6` cannot disagree about which response they mean.
PROCESS_REALM_SCRIPT = PROCESS_REALM_PREFIX + "process.mjs"


def _assert_policy(serving: Serving, csp: bool) -> None:
    """The second gate before Chrome exists: is M6's policy on the wire, or provably not?

    Both directions, and the second is the point. `--negative no-csp` is satisfied by a loader
    that reached a `data:` module — but a run where the switch silently failed to apply would
    report the policy as broken instead of reporting the control as unapplied, which is the
    harness lying about its own world. So the mode is asserted on the wire, exactly as
    `_assert_serving` asserts COOP/COEP.

    Skipped for a root that has no `src/libos/` — a www-only or fixture tree serves no process
    realm, so there is nothing to carry a policy and nothing to claim.
    """
    on_disk = serving.root / PROCESS_REALM_SCRIPT.strip("/")
    if not on_disk.is_file():
        return
    try:
        with _harness_get(serving.base + PROCESS_REALM_SCRIPT) as response:
            response.read()
            header = response.headers.get("Content-Security-Policy")
    except (urllib.error.URLError, OSError) as error:
        raise ServeError(
            "GET %s%s failed, so this run cannot say whether the process realm is bounded: %s"
            % (serving.base, PROCESS_REALM_SCRIPT, error), reason=Gate.FETCH_FAILED) from error
    if csp and header != PROCESS_REALM_CSP:
        raise ServeError(
            "serve(csp=True) did not put scripts/serve.py's process-realm policy on %s; saw %r, "
            "want %r. A process's module loader would be unbounded and M6's loader half would be "
            "measuring a different system."
            % (PROCESS_REALM_SCRIPT, header, PROCESS_REALM_CSP), reason=Gate.WIRE_HEADERS)
    if not csp and header is not None:
        raise ServeError(
            "serve(csp=False) still sent a policy on %s (%r). The negative control did not "
            "remove what it claims to remove."
            % (PROCESS_REALM_SCRIPT, header), reason=Gate.WIRE_HEADERS)

    # THE SAME FILE, ASKED FOR ANOTHER WAY, and this is here because an adversarial review found
    # the server answering the two spellings differently: `GET /%2fsrc/libos/process.mjs` served a
    # byte-identical `process.mjs` with NO policy, because the prefix test read the request's
    # spelling instead of the file it resolves to. A process worker created from that URL had an
    # unbounded module loader. The policy must follow the BYTES; one spelling here keeps the class
    # closed rather than the instance.
    dodge = "/%2f" + PROCESS_REALM_SCRIPT.lstrip("/")
    try:
        with _harness_get(serving.base + dodge) as response:
            body = response.read()
            dodged = response.headers.get("Content-Security-Policy")
    except (urllib.error.URLError, OSError):
        # A server that refuses the spelling outright is a server that cannot serve the realm by
        # it either, which is the safe answer and not a finding.
        return
    if not body:
        return
    if bool(dodged) != bool(csp):
        raise ServeError(
            "GET %s returned %d bytes of the process realm's own script with the policy %s, "
            "while %s got it %s. Two spellings of one file must not get two policies: the one "
            "without is a realm whose module loader is unbounded."
            % (dodge, len(body), "absent" if not dodged else "present",
               PROCESS_REALM_SCRIPT, "present" if csp else "absent"),
            reason=Gate.WIRE_HEADERS)


def _assert_serving(serving: Serving, document: str = "/") -> None:
    """The gate that runs before Chrome exists: mode on the wire, document against disk.

    Run once per document a check will navigate to, so a second root or a renamed page cannot
    reach the point where a check reports BROKEN on a blank page instead of the harness saying
    which file is not there.
    """
    try:
        with _harness_get(serving.base + document) as response:
            body = response.read()
            wire = {k.lower(): v for k, v in response.headers.items()}
    except urllib.error.HTTPError as error:
        raise ServeError("GET %s%s returned %s, so there is no document to check"
                         % (serving.base, document, error.code),
                         reason=Gate.HTTP_STATUS) from error
    except (urllib.error.URLError, OSError) as error:
        raise ServeError("GET %s%s failed, so nothing is listening where this run is about to "
                         "point Chrome: %s" % (serving.base, document, error),
                         reason=Gate.FETCH_FAILED) from error

    # The VALUE, not the name. `Cross-Origin-Opener-Policy: unsafe-none` satisfies a
    # presence test and isolates nothing, so the banner would read ISOLATED over a realm
    # where SharedArrayBuffer is undefined (docs/CONSTRAINTS.md constraints 1 and 31).
    # serve.ISOLATION_HEADERS is the one definition of the pair; it is imported, never restated.
    wrong = ["%s: %r (want %r)" % (name, wire.get(name.lower()), want)
             for name, want in ISOLATION_HEADERS if wire.get(name.lower()) != want]
    present = [name for name, _ in ISOLATION_HEADERS if name.lower() in wire]
    if serving.isolated and wrong:
        raise ServeError(
            "serve(isolate=True) did not put COOP and COEP on the wire with the values "
            "scripts/serve.py defines; saw %s. SharedArrayBuffer would be undefined and every "
            "check below would be measuring a different system." % "; ".join(wrong),
            reason=Gate.WIRE_HEADERS)
    if not serving.isolated and present:
        raise ServeError(
            "serve(isolate=False) still sent %s. The negative control did not remove what it "
            "claims to remove." % ", ".join(
                "%s: %r" % (name, wire.get(name.lower())) for name in present),
            reason=Gate.WIRE_HEADERS)

    index = _mapped(serving.root, document)
    if not index.is_file():
        raise ServeError(
            "GET %s%s returned %d bytes but %s does not exist. An empty or wrong root answers "
            "200 with a directory listing, so the status proves nothing. Nothing was measured."
            % (serving.base, document, len(body), index), reason=Gate.NO_DOCUMENT)
    if body != index.read_bytes():
        raise ServeError(
            "GET %s%s does not match %s byte for byte, so this run would be measuring a tree "
            "other than the one it was pointed at." % (serving.base, document, index),
            reason=Gate.NOT_THIS_TREE)


# ======================================================================================
# Registry (§3)
# ======================================================================================


class Control:
    INVERT = "invert"
    NO_ISOLATION = "no-isolation"
    EMPTY_ROOT = "empty-root"
    PATCHED = "patched"
    KERNEL_STALL = "kernel-stall"
    #: M1 (negative control). Removes the SIGPEND check at the dispatcher's syscall entry so
    #: Ctrl-C-style signals cannot land; proof (e) in www/m1.html is the one that must fail.
    #: Installed at boot through the cfg.noSigpend hook, which refuses unless the page asked for
    #: a bench boot (src/kernel/kernel.mjs, same discipline as installStall).
    NO_SIGPEND = "no-sigpend"
    #: M2, stage 1. The commit's data-before-metadata ordering is dropped: the journal record and
    #: its flush land and the staged bytes are discarded, which is the state a crash between the
    #: two steps leaves. fsck must then report corruption. Installed through the cfg.noCowOrder
    #: hook, which refuses unless the page asked for a bench boot (src/kernel/kernel.mjs).
    #:
    #: It DISCARDS the bytes rather than only skipping flush() because skipping the flush alone
    #: changed nothing observable: an unflushed FileSystemSyncAccessHandle write is still visible
    #: to a later read in the same agent, and with blobFlushes at 0 fsck still came back clean.
    NO_COW_ORDER = "no-cow-order"
    #: M2, stage 2, and the one that makes stage 1 worth reading. The journal's and the snapshot
    #: image's CRC checks are removed, so a torn tail is ACCEPTED. The torn-journal proof must
    #: start passing a bad image; if it passed either way it was testing nothing.
    NO_CRC = "no-crc"
    #: M3, proof 1's control. `/proc`'s pid listing is served from a cache taken on first read
    #: instead of regenerated, through the cfg.procCache hook (src/kernel/procfs.mjs), which the
    #: kernel refuses without a bench boot. A killed pid must then LINGER in the listing.
    #:
    #: It caches the LISTING ONLY, not the per-pid lookup, and that is deliberately narrow: the
    #: listing is what `ls /proc` reads, so a cache there is the realistic mistake, and leaving
    #: `stat` live shows which of the two routes the proof was actually testing.
    PROC_CACHE = "proc-cache"
    #: M3, proof 2's control. `/usr`'s manifest is pointed at an object that is not there, so the
    #: provider answers 404. The MOUNT must fail and say so; an empty `/usr` that mounted
    #: successfully is the failure this control exists to forbid.
    USR_404 = "usr-404"
    #: M3, proof 3's control. The trace ring is built at 64 KiB instead of 16 MiB, below the floor
    #: trace.mjs enforces, through the cfg.traceBytes hook. At full syscall rate the ring is lapped
    #: and the dropped-record counter must go non-zero AND STILL BE DISPLAYED — which is why the
    #: "counter is displayed" label is in this control's HELD list and not its failed one.
    TRACE_TINY = "trace-tiny"
    #: M4's control. SIGPIPE stops being fatal under SIG_DFL, through the cfg.noSigpipe hook which
    #: deletes it from the kernel's fatal-default SET at boot — data, so the headline path carries
    #: one Set lookup either way and no control branch. `yes | head -1` must then HANG: head exits,
    #: the pipe loses its reader, and yes writes into a pipe nobody reads forever.
    NO_SIGPIPE = "no-sigpipe-signal"
    #: M4b. Every new pty comes up with ISIG cleared, through the cfg.noIsig hook, so the line
    #: discipline recognises no signal characters at all. MILESTONES.md M4's ONE specified
    #: behaviour, removed: Ctrl-C must then fail to reach the foreground group.
    NO_ISIG = "no-isig"
    #: M4b. Parked `poll` calls are never re-evaluated when anything replies, so a blocking poll
    #: can only ever answer from its own timeout. Constraint 42's wake, removed.
    NO_POLL_WAKE = "no-poll-wake"
    #: M4b. `finish` replies to a call whose handler's own side effect already answered it, so one
    #: call gets two replies. The double-reply class, restored.
    NO_FINISH_GUARD = "no-finish-guard"
    #: M4b. A resize still resizes but raises no SIGWINCH. Exists because the clause asserting the
    #: signal could not fail until the stage reported its own -EINTR.
    NO_WINCH = "no-winch"
    #: M5's own control, in MILESTONES.md's words: "make `spawn` return the parent's pid; `ps`
    #: must show one process and the check must fail." Nothing is created and the CALLER'S pid is
    #: the answer, through the cfg.spawnSelf hook. It subverts only a caller that was itself
    #: spawned by a process, so the page's orchestrator still starts the shell and the shell's own
    #: stages are the only thing that goes missing.
    SPAWN_SELF = "spawn-self"
    #: M4a's own control, in MILESTONES.md's words: "Detach the pty; the keystroke must not
    #: appear." A write to the pty master accepts its bytes and discards them, so the window, the
    #: device and the relay all keep working and the pty alone stops being the pty. It is what
    #: tells a real echo from a terminal widget echoing locally.
    PTY_DETACH = "pty-detach"
    #: M8's own control, in `PLAN.md` §5's words: "draw nothing; the pattern assertion must
    #: fail". `win_draw` accepts its batch, counts it and DISCARDS it, through the cfg.noDraw hook
    #: which the kernel refuses without a bench boot. Everything that CARRIES the ops keeps
    #: working — the process sends them, the kernel charges them to the window, the page is told a
    #: window has a surface — so what disappears is the PIXELS and nothing else.
    NO_DRAW = "no-draw"
    #: M9's first control, in `PLAN.md` §5's words: "remove the owner chain; the dialog must fall
    #: behind and the check must fail". A raise moves the window ALONE and leaves the dialogs that
    #: ride with it where they were, through the cfg.noOwnerChain hook.
    NO_OWNER_CHAIN = "no-owner-chain"
    #: M9's second: nothing is ever BLOCKING, so a raise is always granted and no input is
    #: suppressed. It cuts the ENFORCEMENT and leaves the close contract alone, which is how the
    #: two halves of M9 are told apart.
    NO_MODAL = "no-modal"
    #: M6, half one. The realm strip does not run, so a process keeps the whole platform — and
    #: `navigator.storage` over the kernel's own volume above all (constraints 41, 53). Through the
    #: cfg.noLockdown hook, which the kernel refuses without a bench boot and which travels to the
    #: process because that is where the strip lives. MILESTONES.md M6's own control: "Skip the
    #: stripping; the same program must succeed."
    NO_LOCKDOWN = "no-lockdown"
    #: M7's own control, in `PLAN.md` §5's words: "wake only on the first fd in the set; the
    #: two-window case must hang". A parked `poll` evaluates only the FIRST fd of its set, through
    #: the cfg.winFirstFd hook which the kernel refuses without a bench boot. A process has one
    #: futex word and one outstanding call, so that is fatal by construction: the poller's second
    #: window and its pipe can never wake it, and it runs to its own ceiling reporting exactly
    #: which fds did.
    WIN_FIRST_FD = "win-first-fd"
    #: M7. Destroying a parent destroys ONLY the parent, through the cfg.noCascade hook. The
    #: obvious implementation, and the one that leaves a dialog on screen over a window that is
    #: gone — and leaves the caller holding fds for windows the kernel has forgotten, which is the
    #: desynchronisation `win_destroy`'s returned list exists to prevent.
    NO_CASCADE = "no-cascade"
    #: M6, half two. The process realm's Content-Security-Policy is not served, so the module
    #: loader is unbounded again: a COMPUTED `import(expr)` and `eval` both work (constraint 139).
    #: A SERVER switch rather than a query parameter, because a policy is a response header — the
    #: same shape as `no-isolation`, and for the same reason.
    NO_CSP = "no-csp"
    #: M10's first control, in `PLAN.md` section 5's words: "offer only the text format; the
    #: image paste must fail cleanly, not silently paste a path". Every data object offers TEXT and
    #: nothing else, whatever its creator asked for, through the cfg.noTyped hook which the kernel
    #: refuses without a bench boot. The GESTURES still work - the clipboard still publishes, the
    #: drag still runs, the drop still lands - and what disappears is the TYPE, which is the whole
    #: claim of a typed clipboard (constraint 247).
    TEXT_ONLY = "text-only"
    #: M10's second: a drop is never delivered, through the cfg.noDrop hook. The drag half stops
    #: and the CLIPBOARD half must keep working, which is how the milestone's two gestures are told
    #: apart - the same split M9's pair makes between its two halves.
    NO_DROP = "no-drop"
    #: A MOUNTPOINT IS A REAL DIRECTORY ON THE VOLUME BENEATH IT, and it was not. Reported by a
    #: reader who typed `ls /` and got nothing; `cd /usr/..` answered ENOENT on the same cause
    #: (constraint 238).
    NO_MOUNTPOINTS = "no-mountpoints"
    #: M11's own control, and NOT the one `PLAN.md` §5 named. Every glass strip keeps its
    #: isolation, its brightness and its additive layers, and its standard deviation goes to zero:
    #: `blur(0px)`. Only the blur is cut.
    #:
    #: `PLAN.md` asks for `backdrop-filter: none`, which is `--negative no-glass` below and is the
    #: weaker cut. `docs/designs/REVIEW-FINDINGS.md` §8 measured why: removing the property also
    #: removes the isolated group the `plus-lighter` layers blend into, so it moves the pixel by a
    #: measured (31,46,71) for a reason that has nothing to do with blurring. Both are registered
    #: because the comparison IS the finding.
    #:
    #: It is a STYLE override and touches no kernel code, which is what keeps it inside M11: the
    #: frame's structure is what M7-M10 check, and a control that changed it would move labels in
    #: four other milestones and prove nothing about the glass.
    NO_BLUR = "no-blur"
    #: `backdrop-filter: none` — the control `PLAN.md` §5 named for M11, kept so the record shows
    #: what it does and does not catch. It takes the filter away entirely, so the strips stop
    #: filtering at all and proof 1's "every strip filters" clause goes red with proof 3's pixels.
    NO_GLASS = "no-glass"
    #: A WRAPPER around every window carrying `opacity:.99`. The strips are untouched and still ask
    #: for blur(9px); an ancestor with opacity below 1 establishes a backdrop root and severs the
    #: chain, so the blur silently stops. THE FAILURE WITH NO SYMPTOM, and the one the usual
    #: window-manager instinct causes — fading a window wrapper on open and close.
    SEVER = "sever"
    #: The caption's text-shadow goes. Over a blurred backdrop of unknown luminance a glyph has no
    #: contrast ratio without a halo, and the white side of the seam is where that shows: measured,
    #: the local contrast collapses from 9.3:1 and 8.9:1 to 2.1:1 and 1.7:1.
    NO_HALO = "no-halo"
    #: CONSTRAINT 50 AS A RUNNABLE WORLD: the desktop's black/white step becomes one flat colour.
    #: `blur(flat) == flat`, so the sampled pixel is then identical with the filter on and off and
    #: every pixel clause would pass against a system with no blur at all. This is the control that
    #: shows those clauses are coupled to the SEAM rather than to a constant — which inversion
    #: cannot show, because an assertion over a constant still inverts and still fires.
    FLAT_DESK = "flat-desk"
    #: M12's own control, in `PLAN.md` §5's words: "disable the governor at the same geometry".
    #: Nothing is ever flattened. Every MEASUREMENT still works — the accounting is reported, the
    #: page renders what it is told, both edges still exist as numbers — so what goes is the
    #: acting, which is how this is told apart from the two below.
    NO_GOVERNOR = "no-governor"
    #: Degrade from the TOP of the stack instead of the bottom. The plausible implementation, and
    #: the one that takes the glass from the window the user is looking at. It moves the ORDER
    #: clauses and nothing else: the half of constraint 49 that is a judgement, not an arithmetic.
    TOP_FIRST = "top-first"
    #: The admission input becomes the CURRENT blurred total rather than the all-glass one — the
    #: first version of M12's governor, and the feedback loop it was built to remove. Flattening
    #: lowers the input, which re-admits, which raises it again: the degrade counter climbs on
    #: every run over a desktop nobody touched.
    STALE_COSTS = "stale-costs"
    #: M13's first, and the one a reader would notice: `Win.apply` writes the requested box
    #: straight onto the element, so nothing holds a window inside the desktop. A drag puts a
    #: caption past the edge and leaves it unreachable — and the MIN_W/MIN_H floor goes with it,
    #: because `clampBox` is where that floor lives. A PAGE-SIDE control, not gated on a bench
    #: boot: nothing in `src/wm/` is reachable from a process, and the page is the supervisor.
    NO_CLAMP = "no-clamp"
    #: M13's second: the host tells the kernel the box the process ASKED FOR instead of the one the
    #: clamp settled on. One post changes, the frames are laid out exactly as before, and the
    #: kernel's whole record becomes a geometry no frame ever had.
    STALE_GEOM = "stale-geom"
    #: M13's third: a desktop that changes size re-clamps nothing, which is the world this project
    #: was in until M13 — frames left hanging outside a shrunken desktop with their captions out of
    #: reach, and a kernel still accounting the boxes they used to have.
    NO_RELAYOUT = "no-relayout"
    ONCE = "once"


_CONTROL_NAMES = frozenset(
    value for key, value in vars(Control).items() if not key.startswith("_"))

#: registry tag -> the `--negative NAME` runs that tag commits the check to. One definition,
#: read by audit() to require an expectation for each, and by --list/--controls so the column
#: prints what a reader can actually run: `--negative patched` exits 2.
CONTROL_RUNS = {
    Control.NO_ISOLATION: ("no-isolation",),
    Control.EMPTY_ROOT: ("empty-root",),
    Control.PATCHED: ("patched-required", "patched-optional"),
    Control.KERNEL_STALL: ("kernel-stall",),
    Control.NO_SIGPEND: ("no-sigpend",),
    Control.NO_COW_ORDER: ("no-cow-order",),
    Control.NO_CRC: ("no-crc",),
    Control.PROC_CACHE: ("proc-cache",),
    Control.USR_404: ("usr-404",),
    Control.TRACE_TINY: ("trace-tiny",),
    Control.NO_SIGPIPE: ("no-sigpipe-signal",),
    Control.NO_ISIG: ("no-isig",),
    Control.NO_POLL_WAKE: ("no-poll-wake",),
    Control.NO_FINISH_GUARD: ("no-finish-guard",),
    Control.NO_WINCH: ("no-winch",),
    Control.PTY_DETACH: ("pty-detach",),
    Control.WIN_FIRST_FD: ("win-first-fd",),
    Control.NO_DRAW: ("no-draw",),
    Control.NO_OWNER_CHAIN: ("no-owner-chain",),
    Control.NO_MODAL: ("no-modal",),
    Control.NO_CASCADE: ("no-cascade",),
    Control.NO_LOCKDOWN: ("no-lockdown",),
    Control.NO_CSP: ("no-csp",),
    Control.NO_MOUNTPOINTS: ("no-mountpoints",),
    Control.NO_BLUR: ("no-blur",),
    Control.NO_GLASS: ("no-glass",),
    Control.SEVER: ("sever",),
    Control.NO_HALO: ("no-halo",),
    Control.FLAT_DESK: ("flat-desk",),
    Control.NO_GOVERNOR: ("no-governor",),
    Control.TOP_FIRST: ("top-first",),
    Control.STALE_COSTS: ("stale-costs",),
    Control.NO_CLAMP: ("no-clamp",),
    Control.STALE_GEOM: ("stale-geom",),
    Control.NO_RELAYOUT: ("no-relayout",),
}


class RegistryError(Exception):
    """The registry cannot be trusted to run what has been written."""


class UnknownCheck(Exception):
    """A name that is not in the registry."""


@dataclasses.dataclass(frozen=True)
class Check:
    name: str
    func: Callable[["Env"], None]
    milestone: str
    controls: Tuple[str, ...]
    #: EVERY expectation label this check records, as a declaration rather than as whatever the
    #: body happened to produce. run_one refuses a run whose recorded labels differ from it, and
    #: a negative control's `held` is derived from it, so a label added to a body reaches every
    #: control's declaration or the run says so. H5's defect was the other way round: a 24th
    #: expectation was added, min_expectations stayed a floor at 23, and the control scored 23 of
    #: 24 labels while reporting "1 red and 22 intact".
    labels: Tuple[str, ...]
    min_expectations: int
    requires_isolation: bool
    #: Non-empty only for a check that genuinely cannot be inverted. Audited, and printed by
    #: gate_invert, because a silent exemption is how a milestone disarms the mode.
    no_invert_reason: str
    note: str
    control_address: str
    #: A Root member: which tree this check's page is served from.
    root: str
    #: The request path Env.reload navigates to, query included. Asserted on the wire by serve()
    #: before Chrome starts, and the key env.request() reads the document's own response back by.
    document: str
    #: Query parameters that override `document`'s for the --prove-failure INVERT phase only.
    #:
    #: WHAT IT IS FOR, because it could be a way to disarm the mode and must not be: the invert
    #: phase asks one question — does every expectation this check records invert and fire — and
    #: the answer does not depend on the size of the page's workload. m2's 10,000-file proof paid
    #: 73 s of a 300 s page-level budget to answer it in the run that passed and TIMED OUT in the
    #: run that did not, so the suite's own self-proof reported itself broken one run in two. A
    #: gate that flakes is a gate that gets ignored.
    #:
    #: Audit rule 15 holds the line: every key here must already appear in `document`, so this can
    #: only re-point a parameter the page already reads and can never introduce a mode, a flag or
    #: a different page for the phase that is supposed to be checking the normal one.
    invert_query: Tuple[Tuple[str, str], ...]
    #: The readiness predicate, polled instead of slept on, and what to say when it never holds.
    #: Declared per check because "the page finished" is a different fact for every page.
    ready_expr: str
    ready_what: str
    ready_timeout: float
    #: What this page must report when COOP/COEP are taken away, read by gate N3. Required of
    #: every check carrying the no-isolation control (audit rule 12): a page that cannot be asked
    #: whether it refused leaves the refusal itself unchecked, and the refusal is the product.
    refusal_expr: str
    refusal_want: str


#: Every check lives in this file. The design's scripts/checks/<name>.py layout is NOT in use:
#: nothing here imports it, so a module in that directory would contribute no checks and the run
#: would report clean (audit rule 1 refuses the directory outright). Split the subjects into
#: modules when there is a second one, and add the import machinery in the same change.
_REGISTRY: List[Check] = []


def check(*, name: str, milestone: str, controls: Tuple[str, ...], labels: Tuple[str, ...],
          root: str, document: str, ready_expr: str, ready_what: str, ready_timeout: float,
          requires_isolation: bool = True, no_invert_reason: str = "", note: str = "",
          control_address: str = "", refusal_expr: str = "", refusal_want: str = "",
          invert_query: Tuple[Tuple[str, str], ...] = ()):
    def decorate(func: Callable[["Env"], None]) -> Callable[["Env"], None]:
        _REGISTRY.append(Check(
            name=name,
            func=func,
            milestone=milestone,
            controls=tuple(controls),
            labels=tuple(labels),
            # The count is the inventory's length and is never written twice: a declaration a
            # reader has to keep in step with a list beside it is two renderers of one fact. The
            # committed floor in scripts/check_floors.json is still what stops the inventory
            # being shortened to match a body that stopped asserting.
            min_expectations=len(labels),
            requires_isolation=requires_isolation,
            no_invert_reason=no_invert_reason,
            note=note,
            control_address=control_address,
            root=root,
            document=document,
            invert_query=tuple(invert_query),
            ready_expr=ready_expr,
            ready_what=ready_what,
            ready_timeout=ready_timeout,
            refusal_expr=refusal_expr,
            refusal_want=refusal_want,
        ))
        return func

    return decorate


def registered() -> Tuple[Check, ...]:
    """Run order: definition order."""
    return tuple(_REGISTRY)


def by_name(name: str) -> Check:
    for candidate in registered():
        if candidate.name == name:
            return candidate
    near = difflib.get_close_matches(name, [c.name for c in registered()], n=3, cutoff=0.4)
    raise UnknownCheck("no check named %r. Did you mean: %s" % (
        name, ", ".join(near) if near else "nothing close - try --list"))


def invertible() -> Tuple[Check, ...]:
    return tuple(c for c in registered() if Control.INVERT in c.controls)


def exempt() -> Tuple[Check, ...]:
    return tuple(c for c in registered() if c.no_invert_reason)


def floors() -> Dict[str, int]:
    """The committed min_expectations floor per check name. A missing file is not a soft start:
    audit() requires an entry for every registered check, so `--bless` has to have been run."""
    if not FLOORS.is_file():
        return {}
    try:
        data = json.loads(FLOORS.read_text(encoding="utf-8"))
    except ValueError as error:
        raise RegistryError("%s is not readable JSON, so there is no floor: %s"
                            % (_relative(FLOORS), error))
    if not isinstance(data, dict):
        raise RegistryError("%s must be an object of name -> int" % _relative(FLOORS))
    out: Dict[str, int] = {}
    for key, value in data.items():
        # No coercion: int("29") and int(True) both succeed and both mean the floor was written
        # by something other than --bless. A corrupt ratchet is a registry problem (exit 3), not
        # a product failure (exit 1), so it has to leave by the same door as every other one.
        if isinstance(value, bool) or not isinstance(value, int):
            raise RegistryError(
                "%s maps %r to %r (%s); a floor must be a JSON integer. Run check.py --bless "
                "rather than editing it to something that coerces"
                % (_relative(FLOORS), key, value, type(value).__name__))
        out[str(key)] = value
    return out


def bless() -> int:
    """Record today's min_expectations as the floor. Refuses to lower one: that is the whole
    point of the file, and lowering must be a deliberate, reviewable edit to the data."""
    recorded = floors()
    lowered = ["%s: floor %d, declaration %d"
               % (c.name, recorded[c.name], c.min_expectations)
               for c in registered()
               if c.name in recorded and c.min_expectations < recorded[c.name]]
    if lowered:
        print("check.py --bless refuses to lower a floor:", file=sys.stderr)
        for line in lowered:
            print("  " + line, file=sys.stderr)
        print("Edit %s by hand if the assertions really went away, so the diff is reviewable."
              % _relative(FLOORS), file=sys.stderr)
        return 4
    # An entry is never removed. Keying the refusal on the check's name means a rename matches no
    # floor and would be written unconditionally, so dropping the old entry would launder an
    # erosion through the rename and delete the only evidence of it. Kept, the orphan makes
    # audit() refuse the run until a human deletes it from the data file - which is the ratchet.
    fresh = dict(recorded)
    fresh.update({c.name: c.min_expectations for c in registered()})
    FLOORS.write_text(json.dumps(fresh, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    changed = sorted(n for n in fresh if fresh[n] != recorded.get(n))
    orphans = sorted(set(fresh) - {c.name for c in registered()})
    print("%s: %d floor(s), %d written: %s"
          % (_relative(FLOORS), len(fresh), len(changed), ", ".join(changed) or "none"))
    if orphans:
        print("%s: %d floor(s) kept for no registered check: %s. A check was renamed or deleted; "
              "audit refuses the run until that entry is removed by hand."
              % (_relative(FLOORS), len(orphans), ", ".join(orphans)))
    return 0


def isolation_sensitive() -> Tuple[Check, ...]:
    return tuple(c for c in registered() if Control.NO_ISOLATION in c.controls)


def resting_on_once() -> Tuple[Check, ...]:
    return tuple(c for c in registered() if Control.ONCE in c.controls)


def _expect_problems(run: str, name: str, expect: "Expect",
                     candidate: Optional[Check]) -> List[str]:
    """Audit rule 10: a negative control's declaration has to be scorable and specific."""
    where = "CONTROLS[%r].expects[%r]" % (run, name)
    out: List[str] = []
    # 14. COVERAGE, at startup rather than discovered on the run: for an outcome that records
    #     labels, failed and held together must account for every label the check declares. A
    #     label no control clause names is a label that control does not constrain, and the gate
    #     would still print "1 red and 22 intact" over a check that recorded 24.
    if candidate is not None and expect.outcome in (Outcome.FAIL, Outcome.PASS):
        inventory = set(candidate.labels)
        declared = set(expect.failed) | set(expect.held)
        unknown = sorted(declared - inventory)
        unscored = sorted(inventory - declared)
        if unknown:
            out.append("%s names %s, which %s does not record. Those could never be scored"
                       % (where, ", ".join(repr(label) for label in unknown), name))
        if unscored:
            out.append(
                "%s accounts for %d of %s's %d expectations and says nothing about %s. Every "
                "label the check records must be in failed or held, or this control does not "
                "constrain them"
                % (where, len(inventory) - len(unscored), name, len(inventory),
                   ", ".join(repr(label) for label in unscored)))
    if expect.outcome == UNMEASURABLE and not expect.why:
        out.append("%s declares the measurement unobtainable and gives no reason. An undeclared "
                   "or unexplained BROKEN is a stray, not a satisfied control" % where)
    if (expect.outcome.startswith("gate ") or expect.outcome == UNMEASURABLE) and (
            expect.failed or expect.held):
        out.append("%s declares outcome %r, where no expectation label is ever recorded, and "
                   "still names labels. Those could never be scored" % (where, expect.outcome))
    if expect.outcome == Outcome.FAIL and not expect.failed:
        out.append("%s expects a failure and does not say WHICH expectation must fail, so any "
                   "failure of %s would satisfy it" % (where, name))
    if expect.outcome == Outcome.PASS and expect.failed:
        out.append("%s expects a pass and also names failing labels" % where)
    overlap = sorted(set(expect.failed) & set(expect.held))
    if overlap:
        out.append("%s names %s in both failed and held" % (where, ", ".join(overlap)))
    return out


def audit() -> None:
    """Raised at import. Rules 1, 2 and 7 are the holes the predecessor had: nothing there
    asserted that a new `def check_*` reached the registry, so an unregistered check never ran
    and the run printed "all checks passed"."""
    problems: List[str] = []
    checks = tuple(_REGISTRY)
    recorded = floors()

    # 1. Nothing in this file imports scripts/checks/, so a check written there would never run
    #    and the report would still say every check passed. Refuse the directory rather than
    #    silently dropping it.
    package = HERE / "checks"
    if package.is_dir():
        on_disk = sorted(p.name for p in package.glob("*.py") if not p.stem.startswith("_"))
        if on_disk:
            problems.append(
                "scripts/checks/ exists (%s) and nothing in check.py imports it, so every check "
                "in it would be skipped silently. Either add the import machinery and audit that "
                "each module contributes a check, or keep the checks in check.py"
                % ", ".join(on_disk))

    # 2. A callable named check_* that never reached the registry.
    registered_funcs = {id(c.func) for c in checks}
    for key, value in sorted(globals().items()):
        if key.startswith("check_") and callable(value) and id(value) not in registered_funcs:
            problems.append(
                "%s is a check_* callable that is not registered: it was written and would "
                "never run, and the report would still say every check passed" % key)

    seen: Dict[str, Check] = {}
    for candidate in checks:
        # 3.
        if candidate.name != candidate.name.strip() or " " in candidate.name:
            problems.append("check name %r contains whitespace" % candidate.name)
        if candidate.name in seen:
            problems.append(
                "two checks are named %r (--only could never address one of them)"
                % candidate.name)
        seen[candidate.name] = candidate
        # 4. Control.INVERT is mandatory: a check that cannot be inverted is a check nobody has
        #    shown capable of failing. The opt-out is explicit, carries a reason, and gate_invert
        #    prints it.
        if not candidate.controls:
            problems.append("%s declares no control, so nothing shows it capable of failing"
                            % candidate.name)
        if Control.INVERT in candidate.controls and candidate.no_invert_reason:
            problems.append(
                "%s carries both the %s control and no_invert_reason=%r. One of the two is wrong"
                % (candidate.name, Control.INVERT, candidate.no_invert_reason))
        if Control.INVERT not in candidate.controls and not candidate.no_invert_reason:
            problems.append(
                "%s does not carry the %s control and gives no no_invert_reason, so "
                "--prove-failure would skip it and still report that every inversion fired"
                % (candidate.name, Control.INVERT))
        # 15. invert_query may only RE-POINT a parameter the document already carries. Without
        #     this it would be a way to hand the inversion phase a different page, a different
        #     control flag or a mode the normal run never loads - and the phase that exists to
        #     show every check capable of failing would be checking something else.
        document_keys = set(dict(urllib.parse.parse_qsl(
            urllib.parse.urlsplit(candidate.document).query)))
        for key, value in candidate.invert_query:
            if key not in document_keys:
                problems.append(
                    "%s's invert_query sets %r=%r, which its document (%s) does not carry. "
                    "invert_query may only re-point a parameter the page already reads, never "
                    "introduce one for the inversion phase alone"
                    % (candidate.name, key, value, candidate.document))
        # 9. A declared negative control must have an expectation naming this check, or the
        #    control is decoration: --controls advertises it and no gate ever scores it.
        for tag, runs in sorted(CONTROL_RUNS.items()):
            if tag not in candidate.controls:
                continue
            for run in runs:
                if candidate.name not in CONTROLS[run].expects:
                    problems.append(
                        "%s declares the %r control but CONTROLS[%r].expects says nothing about "
                        "it, so running --negative %s would never score it"
                        % (candidate.name, tag, run, run))
        # 11. Inversion is necessary and not sufficient: an inverted assertion over a constant
        #     still fires, so a check whose only control is INVERT passes --prove-failure while
        #     never touching its subject (PROVE_LIMIT says so, and nothing enforced it). At least
        #     one control must be RE-RUNNABLE - a name in CONTROL_RUNS - which rule 9 then ties
        #     to a scored expectation.
        runnable = [tag for tag in candidate.controls if tag in CONTROL_RUNS]
        if not runnable:
            problems.append(
                "%s declares no re-runnable control (%s), so nothing re-runs it against a world "
                "where its subject is broken. Inversion alone cannot prove the measurement is "
                "coupled to the subject: an assertion over a constant still inverts and still "
                "fires" % (candidate.name, ", ".join(sorted(CONTROL_RUNS))))
        # 5b. The committed ratchet. An entry is required, so adding a check means running
        #     --bless, which is a reviewable diff.
        if candidate.name not in recorded:
            problems.append(
                "%s has no floor in %s. Run check.py --bless to record min_expectations=%d"
                % (candidate.name, _relative(FLOORS), candidate.min_expectations))
        elif candidate.min_expectations < recorded[candidate.name]:
            problems.append(
                "%s declares min_expectations=%d, below the committed floor of %d in %s. "
                "Assertions were deleted and the declaration was lowered to match"
                % (candidate.name, candidate.min_expectations, recorded[candidate.name],
                   _relative(FLOORS)))
        if Control.ONCE in candidate.controls and not (candidate.note and
                                                       candidate.control_address):
            problems.append(
                "%s rests on a once-only control and must carry note= and control_address=; a "
                "control recorded only in a comment is the predecessor's 76-of-83 problem"
                % candidate.name)
        # 5c. The inventory itself. A duplicate label cannot be scored - score() reads labels by
        #     name - and a count that disagrees with the inventory means one of the two is a
        #     second renderer of the other.
        duplicated = sorted({label for label in candidate.labels
                             if candidate.labels.count(label) > 1})
        if duplicated:
            problems.append(
                "%s declares %s twice in its label inventory; a control naming it could not say "
                "which one it meant" % (candidate.name, ", ".join(duplicated)))
        if candidate.min_expectations != len(candidate.labels):
            problems.append(
                "%s declares min_expectations=%d and a %d-label inventory"
                % (candidate.name, candidate.min_expectations, len(candidate.labels)))
        # 5.
        if candidate.min_expectations < 1:
            problems.append("%s declares min_expectations=%d; a check that can assert nothing "
                            "is not a check" % (candidate.name, candidate.min_expectations))
        # 7.
        if candidate.requires_isolation and Control.NO_ISOLATION not in candidate.controls:
            problems.append(
                "%s requires isolation but does not carry the %s control, so nobody has shown "
                "it fails without COOP/COEP" % (candidate.name, Control.NO_ISOLATION))
        # 8.
        for entry in candidate.controls:
            if entry not in _CONTROL_NAMES:
                problems.append("%s declares control %r, which is not a Control member"
                                % (candidate.name, entry))
        # 12. The page's own refusal. Gate N3 asserts it per document and reads the expression
        #     from here, so a check with no declaration would silently remove the one assertion
        #     that says the product refused rather than quietly measured a different system.
        if Control.NO_ISOLATION in candidate.controls and not (
                candidate.refusal_expr and candidate.refusal_want):
            problems.append(
                "%s carries the %s control and declares no refusal_expr/refusal_want, so gate "
                "N3 has nothing to read and the page's own refusal would go unasserted"
                % (candidate.name, Control.NO_ISOLATION))
        # 13. Where the check's page is and how it says it is ready. A document the server does
        #     not have, or a readiness predicate that is never true, both end in a BROKEN check;
        #     these are the declarations serve() and Env.reload are driven by, so they are
        #     checked before a browser is started.
        if candidate.root not in ROOTS:
            problems.append("%s declares root %r, which is not a Root member (%s)"
                            % (candidate.name, candidate.root, ", ".join(ROOTS)))
        if not candidate.document.startswith("/"):
            problems.append("%s declares document %r, which is not a request path"
                            % (candidate.name, candidate.document))
        if not (candidate.ready_expr and candidate.ready_what and candidate.ready_timeout > 0):
            problems.append(
                "%s declares no readiness predicate, so the runner would have nothing to poll "
                "and would read a half-built page" % candidate.name)

    # 6. The same two pins read the other way, so a rename or a deletion cannot leave either
    #    file pointing at a check that no longer exists.
    names = {candidate.name for candidate in checks}
    for run in sorted(CONTROLS):
        tags = sorted(tag for tag, runs in CONTROL_RUNS.items() if run in runs)
        # 10. The declaration itself. An Expect that declares no failing label is the defect B2
        #     names: `--negative patched-required` scored on Outcome.FAIL alone was satisfied by
        #     any failure of the check, including one that left the page's verdict green.
        for name, expect in sorted(CONTROLS[run].expects.items()):
            problems.extend(_expect_problems(run, name, expect, seen.get(name)))
        for name in sorted(CONTROLS[run].expects):
            if name not in names:
                problems.append(
                    "CONTROLS[%r].expects names %r, which is not a registered check, so that "
                    "expectation can never be scored" % (run, name))
            elif tags and not any(tag in seen[name].controls for tag in tags):
                problems.append(
                    "CONTROLS[%r] expects something of %s, but %s does not declare %s, so "
                    "--list and --controls understate what it rests on"
                    % (run, name, name, " or ".join(repr(tag) for tag in tags)))
    for name in sorted(set(recorded) - names):
        problems.append(
            "%s records a floor for %r, which is not a registered check. A check was renamed or "
            "deleted and its floor was left behind" % (_relative(FLOORS), name))

    if problems:
        raise RegistryError(
            "check.py: the registry is not trustworthy, so nothing was run:\n  - "
            + "\n  - ".join(problems))


# ======================================================================================
# Env (§4)
# ======================================================================================


class Unmeasurable(RuntimeError):
    """The measurement did not happen - as opposed to: what was measured is wrong.

    Never a pass. Never a skip. Not inverted: inverted mode is fail-closed on this.
    """


class ConsoleEntry(NamedTuple):
    text: str
    url: str
    kind: str


#: console.error and console.assert count; console.warn does not. A warning is not a failure,
#: and promoting one would make the sweep a style gate that checks would start suppressing.
CONSOLE_API_ERRORS = ("error", "assert")

#: How long the end-of-check sweep keeps listening after the body returns, and how often. The
#: sweep used to be time-boxed to the body's own duration (~0.17 s for boot), so an error logged
#: after the last expectation was read was never drained at all. Both numbers are judgements, not
#: measurements: 0.5 s covers a setTimeout or a worker message posted as the body returns, and a
#: fault logged later than that is still missed. Say so rather than implying a bound.
CONSOLE_QUIESCENCE_S = 0.5
CONSOLE_POLL_S = 0.1


def _console_api_text(params: Dict[str, Any]) -> str:
    """The rendered arguments of a console call. Chrome sends RemoteObjects, so a bare
    `str(args)` would report `[{'type': 'string', ...}]` instead of the message."""
    rendered = [str(arg["value"]) if "value" in arg
                else str(arg.get("description") or arg.get("type") or "?")
                for arg in params.get("args") or []]
    return " ".join(rendered) or "console.%s with no arguments" % params.get("type")


def _console_entries(events: List[Dict[str, Any]]) -> List[ConsoleEntry]:
    out: List[ConsoleEntry] = []
    for event in events:
        method = event.get("method")
        params = event.get("params") or {}
        if method == "Log.entryAdded":
            entry = params.get("entry") or {}
            if entry.get("level") == "error":
                out.append(ConsoleEntry(
                    text=str(entry.get("text") or ""), url=str(entry.get("url") or ""),
                    kind="console"))
        elif method == "Runtime.consoleAPICalled":
            # Chrome reports console.error on Runtime, not on Log, so a sweep that reads only
            # Log.entryAdded cannot see an error the page logged about itself. Measured: a
            # console.error in www/index.html arrives solely as this event.
            if params.get("type") in CONSOLE_API_ERRORS:
                frames = (params.get("stackTrace") or {}).get("callFrames") or [{}]
                out.append(ConsoleEntry(
                    text=_console_api_text(params), url=str(frames[0].get("url") or ""),
                    kind="console.%s" % params.get("type")))
        elif method == "Runtime.exceptionThrown":
            details = params.get("exceptionDetails") or {}
            description = (details.get("exception") or {}).get("description")
            out.append(ConsoleEntry(
                text=str(description or details.get("text") or "page exception"),
                url=str(details.get("url") or ""), kind="exception"))
    return out


class Env:
    """The only thing a check touches."""

    def __init__(self, *, page: Session, serving: Serving, out: pathlib.Path, check_name: str,
                 inverted: bool, epochs: Iterator[int], document: str, ready_expr: str,
                 ready_what: str, ready_timeout: float, artifact_prefix: str = "") -> None:
        self.page = page
        self.base = serving.base
        self.serving = serving
        self.out = out
        self.artifact_prefix = artifact_prefix
        self.ready_wait_s = 0.0
        self.check = check_name
        #: The request path this check's page was loaded from, query and all. Public, because a
        #: check asserting on its own document's response headers needs the key the server
        #: recorded, and a second copy of the query string in the check body is a copy to drift.
        self.document = document
        self._ready_expr = ready_expr
        self._ready_what = ready_what
        self._ready_timeout = ready_timeout
        self.count = 0
        #: Every label this check recorded, and the ones whose plain expectation did not hold.
        #: A negative control scores labels, not just the outcome, so it has to be able to say
        #: "this expectation was recorded and held" apart from "it was never recorded".
        self.labels: List[str] = []
        self.failed_labels: List[str] = []
        self.failures: List[str] = []
        self.inverted_fired: List[str] = []
        self.console_seen: List[ConsoleEntry] = []
        self.claimed: List[ConsoleEntry] = []
        self.artifacts: List[str] = []
        # Private with no accessor: a check that can read the flag can branch on it.
        self._inverted = inverted
        self._epochs = epochs
        self._pending_note = ""

    # ---- the four recorders -----------------------------------------------------------

    def _record(self, label: str, ok: bool, message: str) -> None:
        self.count += 1
        self.labels.append(label)
        if not ok:
            # The plain sense, in both modes: under inversion a non-holding expectation is still
            # a real failure of the subject, and that is what a control scores.
            self.failed_labels.append(label)
        note, self._pending_note = self._pending_note, ""
        if not self._inverted:
            if not ok:
                self.failures.append(message + (("\n         " + note) if note else ""))
            return
        if ok:
            # The expectation held, so its negation failed. That is what the flag is for.
            self.inverted_fired.append(
                "%s[inverted]: %s - held, so it can fail" % (self.check, label))
        else:
            # The expectation did NOT hold. The subject is broken and a normal run would also
            # have failed here. Reported as a real failure, never as a satisfied inversion.
            self.failures.append(
                "%s[inverted]: %s - the inverted expectation PASSED, which means the plain "
                "expectation is false: %s" % (self.check, label, message))

    def expect(self, label: str, got: Any, want: Any) -> None:
        self._record(label, got == want,
                     "%s: %s = %r, want %r" % (self.check, label, got, want))

    def expect_that(self, label: str, ok: bool, detail: str) -> None:
        self._record(label, bool(ok), "%s: %s - %s" % (self.check, label, detail))

    def expect_in(self, label: str, needle: str, haystack: str) -> None:
        self._record(label, needle in haystack,
                     "%s: %s does not contain %r; it reads %r"
                     % (self.check, label, needle, haystack[:200]))

    def expect_near(self, label: str, got: float, want: float, slack: float = 2.0) -> None:
        self._record(label, abs(got - want) <= slack,
                     "%s: %s = %.3f, want %.3f +/- %.3f (off by %.3f)"
                     % (self.check, label, got, want, slack, abs(got - want)))

    def note(self, message: str) -> None:
        """Prose attached to the next failure, and dropped if that expectation holds."""
        self._pending_note = message

    # ---- reads ------------------------------------------------------------------------

    def read(self, expr: str, shape: Mapping[str, Any], *, await_promise: bool = False) -> Any:
        value = self.page.evaluate(expr, await_promise=await_promise)
        if not isinstance(value, dict):
            raise Unmeasurable(
                "the page expression returned %s, not an object with keys %s"
                % (type(value).__name__, sorted(shape)))
        for key, declared in shape.items():
            if key not in value:
                raise Unmeasurable("the page returned no %r key, so it was never measured" % key)
            if not isinstance(value[key], declared):
                raise Unmeasurable(
                    "%r came back as %s (%r), not %s, so nothing read from it means anything"
                    % (key, type(value[key]).__name__, value[key], declared))
        return value

    def read_list(self, expr: str, *, await_promise: bool = True) -> List[str]:
        value = self.page.evaluate(expr, await_promise=await_promise)
        if not isinstance(value, list):
            raise Unmeasurable("expected a list from the page, got %s" % type(value).__name__)
        for item in value:
            if not isinstance(item, str):
                raise Unmeasurable("a list element came back as %s, not str"
                                   % type(item).__name__)
        return list(value)

    def settle(self, expr: str, *, timeout: float, what: str) -> Any:
        """Poll until expr is truthy. There is no time.sleep used as a readiness gate anywhere
        in this harness: at load-event time www/index.html has rendered only its first seven
        rows and has not set its verdict flag (measured 61 ms later on this machine), so any
        row-count or table-non-empty gate reads a half-rendered page."""
        deadline = time.monotonic() + timeout
        while True:
            value = self.page.evaluate(expr)
            if value:
                return value
            if time.monotonic() >= deadline:
                raise Unmeasurable("%s never became true within %.1fs (%s)"
                                   % (expr, timeout, what))
            time.sleep(0.02)

    def console(self) -> Tuple[str, ...]:
        return tuple(e.text for e in self.console_seen)

    def expect_console(self, needle: str, label: str) -> None:
        """For a deliberately provoked error: asserts it arrived and claims it, so the
        end-of-check sweep does not also report it as an error nobody looked at."""
        self._drain_console()
        hit = next((e for e in self.console_seen if needle in e.text), None)
        if hit is not None:
            self.claimed.append(hit)
        self.expect_that(label, hit is not None,
                         "no console error containing %r arrived, so the error path that was "
                         "supposed to fire did not" % needle)

    def claim_console(self, needle: str, why: str) -> int:
        """Claim a console entry a NEGATIVE CONTROL provokes, asserting nothing.

        WHY THIS IS NOT `expect_console`. That method records an expectation, and an expectation
        a check only sometimes records breaks the label inventory every control's `held` set is
        derived from. These messages are not a product expectation at all: in a normal run they
        cannot happen, because the binding that would produce them is gone.

        WHY IT IS NOT AN ALLOWANCE EITHER. It is reached only when the check has already read,
        from the page, that the control under which they are expected is in force — so the
        normal run stays strict and an unclaimed console error there is still a failure. `why` is
        required and goes nowhere: it exists so the call site has to say what it is excusing.

        Returns how many entries it claimed, so a caller can tell "excused" from "never arrived".
        """
        assert why, "claim_console needs a reason at the call site"
        self._drain_console()
        hits = [e for e in self.console_seen if needle in e.text and e not in self.claimed]
        self.claimed.extend(hits)
        return len(hits)

    def _drain_console(self, *, quiesce: float = 0.0) -> None:
        # A round trip first: cdp.py only reads events off the socket during a call, so without
        # one a late console error is attributed to the next check or dropped by the next
        # navigate's drain_events (cdp.py:171).
        deadline = time.monotonic() + quiesce
        while True:
            self.page.evaluate("1")
            self.console_seen.extend(_console_entries(self.page.consume_events()))
            left = deadline - time.monotonic()
            if left <= 0:
                return
            time.sleep(min(CONSOLE_POLL_S, left))

    def request(self, path: str) -> Served:
        """The response the BROWSER got for this path, as the server recorded it on the wire.

        Not the mapped file: a check asserting on headers is asserting about a request. Not the
        harness's own urllib fetch either - this file fetches "/" in serve()'s preflight and
        whatever matches_disk compares, and a header assertion satisfied by one of those is an
        assertion about the harness, not about what the page received.
        """
        return self.serving.last(path, BROWSER)

    def served_matches_disk(self, path: str) -> bool:
        return self.serving.matches_disk(path)

    def shoot(self, name: str) -> pathlib.Path:
        """An artifact, never an assertion. No assertion is ever made about a PNG or its size:
        constraint 40 (docs/CONSTRAINTS.md:269) says an inert frame and a working one are the
        same picture, and constraint 50 (:253) requires an Aero pixel check to sample across a
        high-contrast backdrop edge and assert the gradient."""
        data = self.page.call("Page.captureScreenshot", format="png").get("data")
        if not data:
            raise Unmeasurable("Page.captureScreenshot returned no data for %r" % name)
        self.out.mkdir(parents=True, exist_ok=True)
        # Namespaced by phase: --prove-failure renders the same check twice, isolated and not, and
        # one filename for two renders means the report names a file that holds the other phase's
        # page.
        target = self.out / ("%s-%s.png" % (self.artifact_prefix or MODE_NORMAL, name))
        target.write_bytes(base64.b64decode(data))
        self.artifacts.append(target.name)
        return target

    def unmeasurable(self, why: str) -> NoReturn:
        raise Unmeasurable(why)

    # ---- lifecycle --------------------------------------------------------------------

    def reload(self) -> None:
        """Per-check epoch-stamped reset. One shared page would make position in the registry
        a precondition of every check body, which makes --only unsound and a per-check negative
        control un-re-runnable. Measured cost here: 21-70 ms to navigate plus ~61 ms to settle.

        Measured for www/index.html; a check whose readiness predicate IS its measurement - the
        m0 cell - waits for as long as the cell takes.

        Once there is a kernel this reset becomes a kernel reboot plus an OPFS wipe. Re-measure
        the cost at M2 and record the decision there rather than discovering it at M5.
        """
        self.page.evaluate("window.__epoch = %d" % next(self._epochs))
        self.page.navigate(self.base + self.document)
        # Session.evaluate returns (result.get("result") or {}).get("value") (cdp.py:167), so an
        # undefined window.__epoch reads None and a navigate that did nothing is caught here.
        if self.page.evaluate("window.__epoch") is not None:
            raise Unmeasurable(
                "the reload was a no-op: window.__epoch survived, so this check would have "
                "measured the previous check's document")
        self.ready_wait_s = self._settle_ready()

    def _settle_ready(self) -> float:
        start = time.monotonic()
        self.settle(self._ready_expr, timeout=self._ready_timeout, what=self._ready_what)
        return time.monotonic() - start


# ======================================================================================
# Report (§8)
# ======================================================================================


class Outcome:
    PASS = "pass"
    FAIL = "fail"
    BROKEN = "broken"
    SKIP = "skip"
    #: Its own outcome, not PASS: every expectation it made was negated and every negation
    #: failed, so counting it as a pass makes the aggregate contradict the per-check line. It
    #: counts toward the failure total in status(), which is what gate I5 reads.
    INVERTED = "inverted"


#: The one legal skip reason. Enumerating skip reasons invites a new one per milestone; a
#: missing precondition is never a skip, it is BROKEN.
NOT_SELECTED = "not selected"

_MARK = {Outcome.PASS: "[  ok ]", Outcome.FAIL: "[FAIL ]", Outcome.BROKEN: "[BROKEN]",
         Outcome.SKIP: "[ skip ]", Outcome.INVERTED: "[inv  ]"}

_COUNTED = (Outcome.PASS, Outcome.FAIL, Outcome.BROKEN, Outcome.SKIP, Outcome.INVERTED)


@dataclasses.dataclass
class Result:
    check: Check
    outcome: str
    count: int = 0
    seconds: float = 0.0
    failures: Tuple[str, ...] = ()
    inverted_fired: Tuple[str, ...] = ()
    reason: str = ""
    artifacts: Tuple[str, ...] = ()
    console: Tuple[ConsoleEntry, ...] = ()
    #: Read by score(): which expectations this check recorded, and which did not hold.
    labels: Tuple[str, ...] = ()
    failed_labels: Tuple[str, ...] = ()
    #: The response that carried THIS check's document, as the server recorded it on the wire,
    #: and what the page's refusal_expr evaluated to after the body returned. Gates N2 and N3
    #: read these: the wire and the page, never a check's message text.
    document_headers: Dict[str, str] = dataclasses.field(default_factory=dict)
    refusal: Optional[str] = None


class Report:
    def __init__(self, *, out: pathlib.Path, mode: str) -> None:
        self.out = out
        self.mode = mode
        self.results: List[Result] = []
        self.witness_failures: List[str] = []
        self.witness_notes: List[str] = []
        #: ALLOWED_404 paths some serving in this run actually requested. ACROSS SERVINGS,
        #: because a phase binds two servers with different roots and a path only one of
        #: them serves is not a dead allowance. Deciding per-serving reported M3's
        #: deliberate 404 probe as deletable while the same run was forgiving its console
        #: error two lines further down — two statements about one path that contradicted
        #: each other.
        self.allowance_seen: set = set()
        self.witness_lines: List[str] = []
        self.console_allowed: List[str] = []

    def add(self, result: Result) -> None:
        self.results.append(result)
        inverted = result.outcome == Outcome.INVERTED
        print("  %-8s %-20s %-10s %s  %s%s" % (
            _MARK[result.outcome],
            result.check.name,
            result.check.milestone,
            ("%d inverted, all failed" % len(result.inverted_fired)) if inverted
            else ("%d expectations" % result.count) if result.outcome != Outcome.SKIP
            else "-            ",
            ("%.2fs" % result.seconds) if result.outcome != Outcome.SKIP else "-",
            ("   " + " ".join(result.artifacts)) if result.artifacts else ""))
        for line in result.inverted_fired:
            print("         " + line)
        for line in result.failures:
            print("         " + line)
        if result.reason:
            print("         " + result.reason)
        sys.stdout.flush()

    def witness(self, serving: Serving, label: str = "") -> List[str]:
        """Derived, never a hand-written list of paths: a listed witness shrinks every milestone
        while the report keeps printing "served == disk". Returns this phase's failures so a
        gate can scope strays to its own phase."""
        found: List[str] = []
        responses = serving.responses()
        paths = [s.path for s in responses]
        if not paths:
            found.append(
                "the server recorded no responses at all, so the page never loaded from it")
        unexpected = [s for s in responses
                      if s.status not in SERVED_OK and s.path not in ALLOWED_404]
        for served in unexpected:
            found.append(
                "GET %s returned %d and is not in ALLOWED_404 - the page asked for a file this "
                "tree does not serve" % (served.path, served.status))
        mismatched = []
        for path in sorted({s.path for s in responses if s.status == 200}):
            if not serving.matches_disk(path):
                mismatched.append(path)
                found.append(
                    "GET %s does not byte-match %s, so this run measured something other than "
                    "this tree" % (path, _mapped(serving.canonical, path)))
        for path in ALLOWED_404:
            statuses = sorted({s.status for s in responses if s.path == path})
            if not statuses:
                # Nothing to say yet: another serving in this phase may have requested it. The
                # dead-allowance note is emitted once, from `allowance_notes`, after every
                # serving has been witnessed.
                pass
            elif 404 not in statuses:
                # Keyed on the status, not on the request: an allowance for a path that now
                # answers 200 pre-forgives a genuine future 404 on it, and reporting it as
                # "allowed and seen" claims a 404 that did not happen.
                found.append(
                    "ALLOWED_404 allows a 404 on %s but this run recorded %s, so the allowance "
                    "no longer describes anything and would pre-forgive a real 404"
                    % (path, ", ".join(str(s) for s in statuses)))
            else:
                self.allowance_seen.add(path)
                if ("GET %s 404" % path) not in self.console_allowed:
                    self.console_allowed.append("GET %s 404" % path)
        distinct = len({s.path for s in responses if s.status == 200})
        ranged = len([s for s in responses if s.status == 206])
        self.witness_lines.append(
            "  served    %s%d responses, %d unexpected non-%s, %d of %d distinct 200 paths "
            "byte-identical to %s/%s"
            % (("[%s] " % label) if label else "", len(responses),
               len(unexpected), "/".join(str(c) for c in SERVED_OK),
               distinct - len(mismatched), distinct, _relative(serving.canonical),
               (", %d ranged (206, fragments, not byte-compared)" % ranged) if ranged else ""))
        self.witness_failures.extend(found)
        return found

    # ---- totals -----------------------------------------------------------------------

    def tally(self) -> Dict[str, int]:
        return _tally(self.results)

    def console_failures(self, results: Optional[List[Result]] = None) -> List[str]:
        out = []
        for result in (self.results if results is None else results):
            for entry in result.console:
                out.append("%s: an unclaimed %s nobody looked at: %s%s"
                           % (result.check.name, entry.kind, entry.text,
                              (" (%s)" % entry.url) if entry.url else ""))
        return out

    def allowance_notes(self) -> None:
        """A note per ALLOWED_404 path no serving in this run requested.

        A note, not a failure. A page that supplies its own favicon, or a Chrome that stops
        probing for one, is a healthy tree; turning the suite red at exit 1 — the code for "a
        product expectation failed" — and then printing "see the lines marked FAIL" when there are
        none is the harness lying about its own subject.
        """
        for path in ALLOWED_404:
            if path not in self.allowance_seen:
                self.witness_notes.append(
                    "ALLOWED_404 allows %s and no serving requested it during this run, so the "
                    "allowance is dead and can be deleted" % path)

    def trailer(self) -> None:
        counts = self.tally()
        self.allowance_notes()
        for line in self.witness_lines:
            print(line)
        for line in self.witness_notes:
            print("  note:     " + line)
        for line in self.witness_failures:
            print("  witness: " + line)
        console = self.console_failures()
        for line in console:
            print("  console: " + line)
        print("  console: %d unclaimed errors   (allowed and seen: %s)"
              % (len(console), ", ".join(self.console_allowed) or "none"))
        print("  ran %d  passed %d  failed %d  inverted %d  broken %d  skipped %d  - of %d "
              "registered"
              % (_ran(counts), counts[Outcome.PASS], counts[Outcome.FAIL],
                 counts[Outcome.INVERTED], counts[Outcome.BROKEN], counts[Outcome.SKIP],
                 len(registered())))
        print("  artifacts: %s" % self.out)

    def finish(self) -> int:
        self.trailer()
        code, message = status(self.results, self.witness_failures, self.console_failures())
        print(message)
        return code


def _tally(results: List[Result]) -> Dict[str, int]:
    counts = {outcome: 0 for outcome in _COUNTED}
    for result in results:
        counts[result.outcome] += 1
    return counts


def _ran(counts: Dict[str, int]) -> int:
    return sum(counts[outcome] for outcome in _COUNTED if outcome != Outcome.SKIP)


def status(results: List[Result], witness_failures: List[str],
           console_failures: List[str]) -> Tuple[int, str]:
    """The exit code a set of results maps to, and the line that explains it.

    Pure, and separate from printing, because gate I5 has to ask what this would return for the
    inverted phase: in --prove-failure mode nothing calls Report.finish, so without I5 a dead
    FAIL-to-exit-code path is invisible to the mode whose job is proving failures propagate.
    """
    counts = _tally(results)
    failures = (counts[Outcome.FAIL] + counts[Outcome.INVERTED]
                + len(witness_failures) + len(console_failures))
    # BROKEN wins the tie with FAIL: a run that could not read part of the subject cannot
    # vouch for the part it did read, so exit 3 ("trust nothing here") outranks exit 1.
    if counts[Outcome.BROKEN]:
        return 3, ("%d check(s) could not be measured - nothing in this run is evidence of "
                   "anything. See the BROKEN lines." % counts[Outcome.BROKEN])
    if failures:
        return 1, "%d failure(s) - see the lines marked FAIL above." % failures
    if _ran(counts) == 0:
        return 2, "nothing ran, so this run is not evidence that anything works."
    return 0, "%d check(s) passed." % counts[Outcome.PASS]


def _relative(path: pathlib.Path) -> str:
    try:
        return str(path.relative_to(REPO))
    except ValueError:
        return str(path)


# ======================================================================================
# Negative controls (§6)
# ======================================================================================


#: A declared outcome that is not an Outcome member: without the capability this control removes
#: there is no measurement to take. An M0 kernel check reads a SharedArrayBuffer, and the
#: constructor does not exist outside a cross-origin isolated context, so BROKEN in that world is
#: the capability going away rather than a defect. It satisfies the control only because it was
#: DECLARED here with a reason; an undeclared BROKEN is still a stray (gate N5).
UNMEASURABLE = "unmeasurable-without-the-capability"


@dataclasses.dataclass(frozen=True)
class Expect:
    """What one negative control must produce for one check, as a declaration the gates score.

    `outcome` is an Outcome member, `gate_reason(..)` for a world that refuses before Chrome, or
    UNMEASURABLE. `failed` and `held` name expectation labels inside the check body, because a
    control scored on the outcome enum alone cannot tell the failure it is named for from any
    other failure: `patched-required` was satisfied by a page that booted without its filesystem
    backing store, on the strength of one row the harness noticed. Audited by rule 10.
    """

    outcome: str
    why: str = ""
    failed: Tuple[str, ...] = ()
    held: Tuple[str, ...] = ()


def gate_reason(reason: str) -> str:
    """A declared outcome for a world that refuses before Chrome, naming WHICH gate refused."""
    return "gate " + reason


@dataclasses.dataclass(frozen=True)
class NegativeControl:
    name: str
    why: str
    serve_kwargs: Dict[str, Any]
    fixture: Optional[Callable[[pathlib.Path], pathlib.Path]]
    expects: Dict[str, Expect]
    #: Query parameters merged into every check's document for this control's phase. The third
    #: way to build a broken world, beside the headers and the fixture: the subject is behind a
    #: switch the PAGE owns, so the control turns it on through the page's own interface rather
    #: than by hand-editing privileged code. src/kernel/kernel.mjs:513-516 refuses the stall hook
    #: unless the page asked for a bench boot, so the switch cannot be left armed by accident.
    query: Tuple[Tuple[str, str], ...] = ()


def score(expect: Expect, name: str, result: Optional[Result], gated: str) -> List[str]:
    """Every way an observed result fails to be what was declared for it.

    One scorer for `--negative` and for the `--prove-failure no-isolation` phase, so the two
    cannot disagree about what removing a capability is supposed to do to a check.
    """
    problems: List[str] = []
    observed = gated or (result.outcome if result is not None else "did not run")
    satisfied = (observed == Outcome.BROKEN if expect.outcome == UNMEASURABLE
                 else observed == expect.outcome)
    if not satisfied:
        problems.append(
            "%s came out %s, want %s%s - %s"
            % (name, observed, expect.outcome, (" (%s)" % expect.why) if expect.why else "",
               "the check is not measuring what it claims" if expect.outcome != Outcome.PASS
               else "the control broke something the check should not care about"))
    if gated or result is None:
        # A world that refused before Chrome recorded no labels. Rule 10 forbids declaring any
        # for such an outcome, so there is nothing further to score.
        return problems
    for label in expect.failed:
        if label not in result.labels:
            problems.append(
                "%s is declared to fail %r under this control and recorded no expectation by "
                "that name, so the control's own subject is not being asserted" % (name, label))
        elif label not in result.failed_labels:
            problems.append(
                "%s recorded %r and it HELD under this control, so whatever turned the check red "
                "is not the thing this control is named for" % (name, label))
    for label in expect.held:
        if label not in result.labels:
            problems.append(
                "%s is declared to keep %r under this control and recorded no expectation by "
                "that name" % (name, label))
        elif label in result.failed_labels:
            problems.append(
                "%s recorded %r and it FAILED under this control, which the control claims not "
                "to touch" % (name, label))
    return problems


def _empty_root(_source: pathlib.Path) -> pathlib.Path:
    return pathlib.Path(tempfile.mkdtemp(prefix="webos-check-empty-"))


def _patch_probe(source: pathlib.Path, needle: str) -> pathlib.Path:
    """Copy the served tree to a tmpdir and force one capability probe to return false.

    The fixture verifies its own patch: exactly one replacement, and the written bytes differ
    from the original at exactly that offset. A control that silently patched nothing is the
    worst case in this file. Patches never go into the repo.
    """
    try:
        original = (source / "index.html").read_text(encoding="utf-8")
    except OSError as error:
        # An OSError escaping here exits 1 - the code for "a product expectation failed" - with
        # a bare traceback, so a control that could not be built would read as a product defect.
        raise ServeError("the fixture could not read %s/index.html: %s" % (source, error),
                         reason=Gate.FIXTURE) from error
    if original.count(needle) != 1:
        raise ServeError(
            "the fixture expected exactly one occurrence of %r in %s/index.html and found %d, "
            "so it would have patched the wrong thing or nothing at all"
            % (needle, source, original.count(needle)), reason=Gate.FIXTURE)
    patched = original.replace(needle, "() => false", 1)
    offset = original.index(needle)
    if patched == original:
        raise ServeError("the fixture changed nothing in %s/index.html" % source,
                         reason=Gate.FIXTURE)
    if patched[:offset] != original[:offset]:
        raise ServeError("the fixture changed bytes before offset %d, not just the probe"
                         % offset, reason=Gate.FIXTURE)
    if patched[offset:offset + len(needle)] == original[offset:offset + len(needle)]:
        raise ServeError("the fixture left the probe at offset %d untouched" % offset,
                         reason=Gate.FIXTURE)

    root = pathlib.Path(tempfile.mkdtemp(prefix="webos-check-fixture-"))
    shutil.copytree(str(source), str(root), dirs_exist_ok=True)
    (root / "index.html").write_text(patched, encoding="utf-8")
    return root


#: www/index.html:49. Required: its absence must turn the verdict to 'fail'.
_OPFS_PROBE = "() => typeof navigator?.storage?.getDirectory === 'function'"
#: The four check_boot expectations a forced-false OPFS probe turns red: the row itself, and the
#: page's verdict rendered three ways.
_PATCHED_REQUIRED_FAILS = ("OPFS state", "verdict flag", "verdict class", "verdict text")

#: www/index.html:53. The only non-required row (www/index.html:63) - Aero is cosmetic and the
#: kernel does not care. A check that cannot tell this from a required row is not checking the
#: required/optional split, it is checking that ten rows read 'present'.
_BACKDROP_PROBE = "() => CSS.supports('backdrop-filter', 'blur(9px)')"

#: The page's rows, in the page's order, with whether the page treats each as fatal. Rows 1-7
#: are the synchronous probes (www/index.html:40-55); rows 8-10 are the three the page can only
#: get from a worker, because createSyncAccessHandle exists nowhere else (www/index.html:73-74,
#: :101-108). backdrop-filter is the only non-required row (www/index.html:63).
#:
#: This tuple is the harness's own expectation and is deliberately NOT read back from the page.
#: An expectation derived from the subject is one the subject cannot fail. The cost is real and
#: points the right way: editing www/index.html fails check_boot until this tuple is edited
#: too. When the drift message fires, decide which side is right. Do not delete the assertion.
#:
#: It sits here, above the controls, because check_boot's label inventory and therefore every
#: control's `held` set are derived from it.
PREFLIGHT_ROWS = (
    ("crossOriginIsolated", True),
    ("SharedArrayBuffer", True),
    ("Atomics.wait", True),
    ("dedicated Worker", True),
    ("OPFS", True),
    ("OffscreenCanvas", True),
    ("backdrop-filter", False),
    ("worker is isolated", True),
    ("OPFS sync handle", True),
    ("worker can block", True),
)

#: state text -> the class the page paints it with (www/index.html:68-69 for the synchronous
#: rows, :113-114 for the worker rows). The pairing is the assertion: a green MISSING, or a
#: 'present' with no class, is a page telling the DOM one thing and the human reading it
#: another. ('absent', '') was measured under --negative patched-optional on Chrome 157: the
#: row reads state='absent', class='', why non-empty, and the verdict stays 'ok'. Note the
#: check passes under either state for that row, so the pass alone is not evidence the control
#: fired - the row had to be read directly.
STATE_CLASS = {"present": "ok", "MISSING": "bad", "absent": ""}

#: Every label check_boot records, in body order: the row-name set, then two per row, then the
#: painted-colour injectivity, the page's verdict three ways, two live re-probes, the two
#: response headers and the served-bytes witness. 1 + 20 + 1 + 3 + 2 + 2 + 1 = 30.
BOOT_LABELS = (
    ("row names",)
    + tuple(part for name, _ in PREFLIGHT_ROWS
            for part in ("%s state" % name, "%s cell" % name))
    + ("state colours distinguish states", "verdict flag", "verdict class", "verdict text",
       "live crossOriginIsolated", "live SharedArrayBuffer",
       "document COOP", "document COEP", "served index.html")
)


def mouse_drag(page, start, end, steps: int = 8) -> None:
    """A real press, several moves and a release, through `Input.dispatchMouseEvent`.

    SEVERAL MOVES AND NOT ONE: a program that draws a line from its last point to this one needs
    at least two points to draw anything, and one jump from press to release is what a synthesised
    drag looks like rather than what a hand does.

    The coordinates come from the page, which reads them off the canvas's own bounding rectangle: a
    surface is SCALED to its client area, so nothing outside the page knows where a surface pixel
    is on screen.
    """
    page.call("Input.dispatchMouseEvent", type="mousePressed", x=start["x"], y=start["y"],
              button="left", buttons=1, clickCount=1)
    for i in range(1, steps + 1):
        page.call("Input.dispatchMouseEvent", type="mouseMoved",
                  x=start["x"] + (end["x"] - start["x"]) * i // steps,
                  y=start["y"] + (end["y"] - start["y"]) * i // steps,
                  button="left", buttons=1)
    page.call("Input.dispatchMouseEvent", type="mouseReleased", x=end["x"], y=end["y"],
              button="left", buttons=0, clickCount=1)


#: One `Input.dispatchMouseEvent` button name and bitmask per button a gesture may ask for.
_BUTTONS = {"left": 1, "right": 2, "middle": 4}


def _perform_gesture(page, want: Dict[str, Any], *, held: bool) -> bool:
    """Perform ONE gesture a page asked for, with real input. Returns whether a button is now down.

    The page publishes what it needs and where (www/pagekernel.mjs `gestureAsker`); this is the
    other half. `press`/`move`/`release` are separate kinds so a page can MEASURE MID-GESTURE,
    which is what a snap threshold needs: arm at the edge, read the state, drag out 19 px, read it
    again. A single `drag` cannot answer a question about the middle of itself.
    """
    kind = str(want.get("kind") or "")
    at = want.get("at") or want.get("from") or {}
    button = str(want.get("button") or "left")
    mask = _BUTTONS.get(button, 1)

    def mouse(event_type, point, *, buttons, clicks=0):
        # `button` is WHICH button this event is about and `buttons` is what is held. A move with
        # nothing held must say `none`, or Chrome reports a drag of a button that is not down.
        params = {"type": event_type, "x": int(point["x"]), "y": int(point["y"]),
                  "button": button if (buttons or event_type != "mouseMoved") else "none",
                  "buttons": buttons}
        if clicks:
            params["clickCount"] = clicks
        page.call("Input.dispatchMouseEvent", **params)

    if kind == "drag":
        mouse_drag(page, want["from"], want["to"], int(want.get("steps") or 8))
        return False
    if kind == "press":
        mouse("mousePressed", at, buttons=mask, clicks=1)
        return True
    if kind == "move":
        # The button mask carries whether this is a drag or a hover, which is the one thing a
        # `mouseMoved` cannot be derived from: `src/wm/winhost.mjs` ignores a move with no button.
        mouse("mouseMoved", at, buttons=mask if held else 0)
        return held
    if kind == "release":
        mouse("mouseReleased", at, buttons=0, clicks=1)
        return False
    if kind in ("click", "rightclick"):
        mouse("mousePressed", at, buttons=mask, clicks=1)
        mouse("mouseReleased", at, buttons=0, clicks=1)
        return False
    if kind == "dblclick":
        # The SECOND press carries clickCount 2, which is what makes Blink synthesise `dblclick`;
        # two independent clicks do not.
        mouse("mousePressed", at, buttons=mask, clicks=1)
        mouse("mouseReleased", at, buttons=0, clicks=1)
        mouse("mousePressed", at, buttons=mask, clicks=2)
        mouse("mouseReleased", at, buttons=0, clicks=2)
        return False
    if kind == "hover":
        mouse("mouseMoved", at, buttons=0)
        return held
    if kind == "key":
        for _ in range(max(1, int(want.get("times") or 1))):
            page.press(str(want["key"]), shift=bool(want.get("shift")))
        return held
    if kind == "type":
        page.type_keys(str(want.get("text") or ""))
        return held
    raise Unmeasurable("the page asked for a %r gesture, which no driver here performs" % kind)


def drive_gestures(env: Env, flag: str, *, timeout: float = 300.0) -> int:
    """Perform every gesture `globalThis.<flag>` asks for until the page reaches a terminal state.

    THE PAGE CANNOT DRIVE ITS OWN. A synthesised `PointerEvent` is `isTrusted === false` and
    `setPointerCapture` refuses a pointerId no live pointer owns (constraint 175) - so a window
    manager driven by the page under test is a window manager nobody has moved. A human reading
    the page performs the same asks by hand, which is what the bench shells are for.

    Returns how many gestures were performed, so a check can assert the page was really driven
    rather than having finished without asking for anything.
    """
    deadline = time.monotonic() + timeout
    read = ("(() => { const M = globalThis.%s || {}; return JSON.stringify({"
            "state: String(M.state || ''), phase: String(M.phase || ''),"
            "want: M.want || null, why: String(M.why || '') }) })()" % flag)
    performed = 0
    held = False
    last = ""
    while True:
        row = json.loads(env.page.evaluate(read) or "{}")
        want = row.get("want")
        # THE ID GUARD, and it is not optional: the page clears `want` only once its own poll sees
        # the receipt, so without this the same gesture is performed two or three times - which for
        # a `dblclick` or a `press` is a different gesture entirely.
        if want and want.get("id") != last:
            held = _perform_gesture(env.page, want, held=held)
            env.page.evaluate("globalThis.%s.driven = %s" % (flag, json.dumps(want["id"])))
            last = want["id"]
            performed += 1
            continue
        if row.get("state") in ("done", "aborted", "error"):
            return performed
        if time.monotonic() >= deadline:
            raise Unmeasurable(
                "globalThis.%s never reached a terminal state within %.0fs: state=%r phase=%r "
                "want=%r why=%r. %d gesture(s) were performed."
                % (flag, timeout, row.get("state"), row.get("phase"), want, row.get("why"),
                   performed))
        time.sleep(0.02)


def held_rest(labels: Tuple[str, ...], failed: Tuple[str, ...]) -> Tuple[str, ...]:
    """Every label a check records that this control does not turn red - DERIVED, never listed.

    A hand-written `held` is the H5 defect in miniature: it is a subset nobody has to extend,
    so an expectation added to a check body is scored by no control and the gate still reports
    "1 red and N intact". Deriving it means a new label is held by default and the control run
    says so the first time it is not.
    """
    unknown = sorted(set(failed) - set(labels))
    if unknown:
        # Raised, not returned: a declaration naming a label the check cannot record is a
        # registry defect, and audit rule 14 reports it beside the rest. This guard is for the
        # order of definition - CONTROLS is built before audit() runs.
        raise RegistryError(
            "a negative control declares %s as failing, and the check records no label by that "
            "name" % ", ".join(repr(label) for label in unknown))
    return tuple(label for label in labels if label not in failed)


#: The four required rows COOP/COEP removal turns red, measured on Chrome 157 and recorded the
#: same way in MILESTONES.md:54-57. NOT `OPFS sync handle`: a sync access handle does not need
#: cross-origin isolation, so a control that expected all ten rows red would be wrong about the
#: platform and would start passing for the wrong reason the day that changed.
_ISOLATION_ROWS = ("crossOriginIsolated", "SharedArrayBuffer", "worker is isolated",
                   "worker can block")

#: The eleven check_boot expectations removing COOP/COEP turns red: the four rows above, the
#: page's verdict rendered three ways, the two live re-probes and the two response headers.
_NO_ISOLATION_FAILS = (
    tuple("%s state" % row for row in _ISOLATION_ROWS)
    + ("verdict flag", "verdict class", "verdict text",
       "live crossOriginIsolated", "live SharedArrayBuffer", "document COOP", "document COEP")
)

#: Every label check_syscall records, in body order. This is the registry's inventory: the count
#: below is its length, each negative control's `held` is derived from it, and run_one refuses a
#: run whose body records anything else.
SYSCALL_LABELS = (
    "cell reported",
    "page isolated",
    "kernel isolated",
    "abi fingerprint agrees",
    "kernel applied the cfg it was handed",
    "percentile known-answer vectors",
    "processes reporting",
    "getpid returns each process's own pid",
    "each process's self-reported pid",
    "every windowed call returned the right answer",
    "calls issued",
    "accounting identity",
    "no error or lost-reply path",
    "histogram represents every sample",
    "not-equal fast path reached",
    "not-equal returned the reply, not an error",
    "not-equal counted on both sides",
    "kernel reached N outstanding calls",
    "depth instrument within bounds",
    "concurrency gates",
    "page and harness read the same accept bar",
    "page and harness read the same headline quantile",
    "clock fine enough to describe the channel",
    "p99 printable",
    "the headline p99 is the 99th percentile",
    "pooled p99 within the worst per-process p99",
    "p50 under the regression bar",
    "p99 under the tail ceiling",
    "document COOP",
    "document COEP",
    "served m0.html",
)

#: Every label check_m1 records, in body order. Fourteen; one more if the added expectation
#: lands on the ratchet in scripts/check_floors.json via --bless.
M1_LABELS = (
    "cell reported",
    "page isolated",
    "kernel isolated",
    "abi fingerprint published",
    "proof_a ok",
    "proof_b ok",
    "proof_c ok",
    "proof_d ok",
    "proof_d within bound",
    "proof_e ok",
    "verdict is ok",
    "document COOP",
    "document COEP",
    "served m1.html",
)

#: What the phases that are NOT about scale use instead: both negative controls, and the
#: inversion phase. ONE number, because it is one fact — the file count at which proof (a) still
#: exercises every clause and the run is seconds rather than a minute. Measured: the inversion
#: phase went from 73 s (and a 300 s page-level timeout one run in two) to under 10 s.
M2_CONTROL_FILES = 400

#: Every label check_m2 records, in body order. The registry's inventory: the count is its length,
#: each negative control's `held` is derived from it, and run_one refuses a run whose body records
#: anything else.
M2_LABELS = (
    "cell reported",
    "page isolated",
    "kernel isolated",
    "abi fingerprint published",
    # THE NOTE CHANNEL AS A CLAUSE, page-wide. Zero is the measured normal (38 before one inode's
    # operations were serialized, none after at 60, 200 and 10,000 files), so a note that only
    # reaches a log is a failure nobody reads.
    "the storage edge raised no note in any section",
    # (a) 10,000 files survive a reload byte- and mode-intact. Split into clauses because the
    #     ordering control leaves the METADATA whole and destroys only the DATA, and a single
    #     "proof_a ok" could not have said that.
    "proof_a ok",
    "proof_a wrote every file",
    "proof_a every byte survived the reload",
    "proof_a every mode bit survived the reload",
    "proof_a mounted read-write both times",
    "proof_a boot lock taken inside its budget",
    "proof_a fsck clean after the reload",
    "proof_a fsck wrote nothing",
    "proof_a blob sweep accounts for every file",
    # (b) a journal truncated mid-record. Three tears, three guards.
    "proof_b ok",
    "proof_b1 truncated tail reported",
    "proof_b2 zero-padded tail reported",
    "proof_b3 flipped mode field reported",
    "proof_b nothing was reseeded",
    "proof_b a torn journal mounts read-only",
    "proof_b the user's file kept a mode somebody wrote",
    # (c) two concurrent opens of one file both succeed, and the swing under them.
    "proof_c ok",
    "proof_c two concurrent opens both succeeded",
    "proof_c both readers saw the committed bytes",
    "proof_c a later opener saw the new generation",
    # The HELD description, re-read after the swing. This replaced "the superseded blob outlived
    # its reader", which was the stale read in assertion form: the holder stayed pinned to the
    # generation it opened, which is how one fd came to report fstat 40 while pread on the same fd
    # returned 8. POSIX has two fds on one file sharing the FILE, so the holder must follow — and
    # with no reader left on the superseded generation its removal is immediate, which the clause
    # below reads off the directory. The DEFERRED arm moved to the `drop` section, where a
    # reference genuinely outlives the free.
    "proof_c the held fd followed the swing",
    "proof_c the holder outlived the other description's close",
    "proof_c the superseded generation left the directory",
    # (d) two concurrent WRITERS on one inode. Proof (c) has two readers and a third-process
    #     writer, and two live WRITE descriptions on one inode was the configuration in which
    #     copy-on-write was not atomic: the append-vs-copy-up test read a per-description
    #     snapshot of the committed size, so a write below a size the OTHER description had
    #     published took the append branch and overwrote committed bytes in place.
    "proof_d ok",
    "proof_d two write descriptions on one inode",
    "proof_d the second writer staged a new generation",
    "proof_d both writers' committed bytes survived",
    # An OUTSTANDING APPEND under another description's commit — the state proof (d) cannot
    #     reach, because both of its writers are clean when they write. One state, three
    #     separate failures: a write below another description's published size landing in the
    #     committed generation in place, a commit publishing a size BACKWARDS over fsynced
    #     bytes, and a commit record the writer's own VFS refused reaching the disk and bricking
    #     the next mount read-only. Split into clauses for the same reason proof (a) is: the
    #     final bytes alone came out RIGHT against the broken code, and the clause that moved
    #     was the mid-flight read.
    "pending ok",
    # "Held back" is a claim about the METADATA and is now measured as the metadata not moving —
    # no swing, no journal record. It used to be measured as a FRESH description still seeing the
    # old size, which asserted that the appended bytes were invisible to another description, and
    # that is the stale read rather than the guarantee: POSIX has two fds on one file sharing the
    # file, and `pwrite` had already returned a count for those bytes. The visibility half is now
    # its own clause and asserts the opposite of what the old one did.
    "pending the append was held back from the metadata",
    "pending the append is visible to every description",
    "pending the appending writer staged a new generation",
    "pending the committed generation was never written in place",
    "pending both writers' bytes survived",
    "pending the replay rejected nothing",
    "pending the volume still mounts read-write",
    "pending the bytes survived the remount",
    # WHAT `close()` REPORTS, AND WHAT IT LEAVES BEHIND. Three routes through one question, and
    # each was a separate silent loss that the round of attacks after the one which patched the
    # previous site found. Route 1 is the headline: an acknowledged append under another
    # description's swing, lost with `close()` returning 0 and an explicit fsck reporting the
    # volume clean, because the blob's length matched the size the metadata published.
    "drop ok",
    "drop the append was acknowledged twice",
    "drop close reported success",
    "drop the acknowledged bytes are in the file",
    "drop the volume is clean afterwards",
    "drop a superseded stage is re-based, not discarded",
    "drop a re-staged commit left no staged blob behind",
    "drop every call on an unlinked description refuses alike",
    "drop an unlinked file's blob outlived its last descriptor",
    # ROUTE 4, AND THE ONE CALLER THAT CANNOT READ A RETURN VALUE. A writer killed holding a staged
    # generation under contention: teardown commits and cannot await, so the note channel is the
    # only report there is. 3 of 12 acknowledged writes were destroyed before one inode's
    # operations were serialized, every one of them named in a note nothing asserted on — which is
    # why the second label here reads the kernel's note COUNT.
    "drop a killed writer's acknowledged bytes survive",
    "drop the note channel stayed silent under a killed writer",
    # THE COMMIT IS A COMPARE-AND-SWAP, and the five scenarios are five losses that reported
    # success. The copy a copy-up takes is speculative, and a speculative copy is only valid if
    # nothing moved underneath it — which the commit never checked. The slack pair is the other
    # half of the same sentence: the published size is the only authority on what a file contains,
    # so bytes above it are reclaimable slack, reportable by fsck and invisible to every reader.
    "cas ok",
    "cas base keeps every acknowledged byte",
    "cas twostage keeps every acknowledged byte",
    "cas m4 keeps every acknowledged byte",
    # THE SLACK PAIR AS A RACE, which is different from the slack pair as a plant below: a write
    # INSIDE the region an uncommitted append opened moves neither the generation nor the extent, so
    # a stamp made of those two numbers could not see it and the next staged commit reverted it.
    # `slackwide` is the same ordering one byte wider, where the extent does move — the boundary,
    # kept beside it so "the counter is bumped by an in-place write" is distinguishable from "the
    # extent happened to move".
    "cas slackin keeps every acknowledged byte",
    "cas slackwide keeps every acknowledged byte",
    # ONE DESCRIPTION'S read, fstat AND SEEK_END, after another description published a SHORTER
    # file. `read` clamped to the base its copy came from while the other two read the extent now.
    "cas dirtytrunc keeps every acknowledged byte",
    "cas uncommitted slack does not resurrect",
    "cas fsck reports a blob longer than its published size",
    "cas two overlapping opens of one name both succeed",
    "cas contention refuses only under EBUSY",
    # WHAT A CALLER WHO RETRIES -EBUSY IS TOLD, and what the journal looks like underneath the same
    # workload. Two different defects, one two-writer run: a retry was answered 0 over a stage the
    # refusal had discarded, and two concurrent appends took one sequence number, which makes replay
    # discard every record after it.
    "cas a retried fsync is never told a discarded write is durable",
    "cas the journal's sequences are strictly consecutive",
    # A STAGED GENERATION A CRASH LEFT BEHIND. The staging floor was seeded from the generations
    #     the METADATA names, which are the committed ones — so an orphan from a crash between a
    #     copy-up and its commit was invisible to it, the next write reused that generation
    #     number, and the orphan's bytes became the file's. fsck reported the volume clean,
    #     because the blob's length matched the size the metadata published.
    "orphan ok",
    "orphan the orphaned generation was on disk",
    "orphan a grown range reads as zeroes",
    "orphan the orphaned generation was not reused",
    # A refused mount, in the KERNEL rather than in fsck. src/fs/fsck.mjs returning 'refuse' is
    # checked under Node; the reseed lives in the caller, and the caller's refuse arm was
    # exercised by nothing — so webxp's defect could be reinstated there with every proof and
    # every host test still passing.
    "refuse all three slots were corrupted",
    "refuse the mount refused",
    "refuse the volume was not touched",
    "refuse no tree was invented",
    # A SLOT THAT CANNOT BE READ, which is the refused mount's error-path twin. A healthy volume's
    # journal is EMPTY because the last snapshot truncated it, so the slots are the only evidence
    # the volume exists — and an errno read as "absent" made all of it vanish at once and reached
    # the FRESH arm, the one arm allowed to write. Measured against the pre-fix reader: one
    # unreadable slot mounted READ-WRITE with `problems` empty, and three produced a tree of one
    # inode over a volume of 28 with its 10 blobs orphaned on disk.
    "unreadable the slot read refused with something other than absence",
    "unreadable the journal was empty, so only the slots said the volume existed",
    "unreadable one unreadable slot mounts read-only at the same generation",
    "unreadable one unreadable slot keeps its tree",
    "unreadable every unreadable slot refuses",
    "unreadable both verdicts name the slot that could not be read",
    "unreadable neither verdict wrote anything",
    # O_APPEND, WHICH WAS A SEEK AT OPEN. One process, four calls, no race: two appending
    # descriptions both get the end read once, and the second writes over the first with `write`
    # returning 4 and `fsync` returning 0 to each. M5's `>>` is the caller that will hit it.
    "append both O_APPEND writes were acknowledged",
    "append two O_APPEND writers both keep their bytes",
    "append the volume is clean afterwards",
    # EVERY ASYNC SYSCALL COMPLETION, ACROSS EVERY SECTION. `later()` is the completion path for
    # open, write, fsync, truncate and close, and its rejection arm used to answer a bare -EIO that
    # named nothing: a kernel-side exception was indistinguishable from a real storage error. The
    # count is summed over every kernel this page boots, and the second clause is its anti-vacuity
    # — a zero nobody could read is not a zero.
    "no async syscall completion was rejected in any section",
    "every kernel's counters were read before it was terminated",
    # Constraints 23 and 24, as traces off the storage edge rather than as readings of the code.
    "order the blob flush precedes the journal append",
    "order one directory handle for the module's life",
    # The rest of the ABI. Not a fourth proof — the milestone owes three — but a call the suite
    # never issues is a call nobody has shown works, and the three proofs reach twelve of the
    # thirty-nine.
    "every other syscall answers correctly",
    "verdict is ok",
    "document COOP",
    "document COEP",
    "served m2.html",
)

#: What dropping the data-before-metadata ordering turns red, MEASURED under the control at
#: a_n=8 on Chrome 157.0.8103.52 (`bench/fs-core/probe.py --files 8 --no-cow-order`):
#: bytesOk 0 of 8, modesOk 8 of 8, fsck "8 blob(s) are SHORTER than the size the metadata
#: publishes", proof_c's three readers all summing 0.
#:
#: THE SHAPE OF THIS LIST IS THE FINDING. Every metadata clause HOLDS — the files are there, the
#: modes are right, the mount is read-write, the boot lock was taken, fsck still wrote nothing —
#: and only the data clauses move. That is exactly "intact metadata pointing at torn data", which
#: is the outcome copy-on-write was chosen to prevent, and it is why `held` being derived matters:
#: a hand-written list would have been a guess about which half survives.
_NO_COW_ORDER_FAILS = (
    "proof_a ok",
    "proof_a every byte survived the reload",
    "proof_a fsck clean after the reload",
    "proof_a blob sweep accounts for every file",
    "proof_c ok",
    "proof_c both readers saw the committed bytes",
    "proof_c a later opener saw the new generation",
    # The held fd still FOLLOWS the swing under the control — it resolves the new generation and
    # reports its size — and reads 0 bytes out of it, because the control emptied the blob. So the
    # byte clause moves and the directory clause beside it does not, which is the same split as
    # everywhere else in this list. Measured at a_n=400: re-read size 8, read 0, checksum 0
    # against the overwrite's 1308.
    "proof_c the held fd followed the swing",
    # Proof (d) splits the same way: both writers still OPEN the inode and the second still STAGES
    # a new generation — the copy-up decision is metadata and the control does not touch it — and
    # the bytes are what goes. The copy-up copies out of a blob the control emptied, so the
    # surviving-bytes clause is the one that moves.
    "proof_d ok",
    "proof_d both writers' committed bytes survived",
    # The pending proof splits the same way again, and the split is sharper because it has more
    # metadata clauses: the append is still held back from the metadata, the copy-up still
    # happens, the refused commit still leaves no record, and the volume still mounts
    # READ-WRITE — only the three byte clauses move. Measured at a_n=400 under the control: the
    # mid-flight read saw 0 rather than the first writer's 0xa1, pcheck read 0 of 104 bytes, and
    # the remount came up rw with problems: [].
    "pending ok",
    "pending the committed generation was never written in place",
    "pending both writers' bytes survived",
    "pending the bytes survived the remount",
    # The drop section splits the same way, and the split is worth reading because this section is
    # ABOUT a silent loss: the append is still acknowledged, both closes still return 0, the
    # refusal is still reported, the staged blob is still freed and the unlinked blob still
    # outlives its descriptor — every one of those is metadata. What moves is the bytes, and with
    # them the fsck clause, which under the control reports `ro` with 402 blobs SHORTER than the
    # size the metadata publishes. Measured at a_n=400: check size 12 of a wanted 12 with
    # belowOk=false and tailOk=false, over blobs that are all 0 bytes long.
    "drop ok",
    "drop the acknowledged bytes are in the file",
    "drop the volume is clean afterwards",
    # THE RE-BASE CLAUSE MOVES WITH THE BYTES, and its three ranges say why: under the control the
    # merge's head, middle and grown ranges all read as zeroes, because the blob every one of them
    # was copied from was emptied after its commit.
    "drop a superseded stage is re-based, not discarded",
    # THE KILLED-WRITER ROUTE MOVES AS A PAIR, and the pair is the control's whole point here.
    # Measured at a_n=400 under the control: all twelve writes still ACKNOWLEDGED (the control
    # touches no decision, only the bytes) and all twelve vanished, with the explicit fsck
    # reporting `ro` and `blobs`. The note channel then carries 2,400 of them — "staged generation
    # 22.2 is 4 byte(s) on disk and its commit would publish 8", which is the commit refusing to
    # name bytes that are not there — so the silence clause moves too. A control under which the
    # note count stayed at zero would mean the count was not reading the channel.
    "drop a killed writer's acknowledged bytes survive",
    "drop the note channel stayed silent under a killed writer",
    # AND THE PAGE-WIDE NOTE CLAUSE WITH IT: 2,587 notes across the run under the control against
    # none on a clean one, so the count is reading the channel rather than a constant.
    "the storage edge raised no note in any section",
    # TWO CLAUSES HERE ARE THE CONTROL'S OWN SUBJECT REACHING FURTHER THAN IT USED TO, and they are
    # the only entries in this list that are not byte clauses. The commit now compares the size it
    # is about to publish against the staged blob's OWN LENGTH, and the control's state — metadata
    # that names bytes which are not there — is exactly what that comparison refuses: the copy-up
    # copies 0 of 40 bytes out of an emptied blob, so the commit will not publish 40 over a 16-byte
    # generation and `fsync` answers -EIO. Measured at a_n=400: proof (d)'s second writer still
    # takes the copy-up branch (copyUps 0 -> 1) and its staged generation is then DISCARDED, so the
    # "new blob on disk" half of that clause is what moves. Refusing to publish a size the blob
    # does not have is the invariant; a control that left it unexercised would be the weaker report.
    "proof_d the second writer staged a new generation",
    # THE CAS SECTION, and its split is the sharpest in this list: six of its seven clauses are
    # about bytes or about the counters that prove a race happened, and all six move. The seventh —
    # two overlapping opens of one name — is pure metadata and HOLDS, which is what keeps the
    # section from reading as "everything fails under the control".
    "cas ok",
    "cas base keeps every acknowledged byte",
    "cas twostage keeps every acknowledged byte",
    "cas m4 keeps every acknowledged byte",
    # THE SLACK PAIR AND THE TWO-BASE READ SPLIT THE SAME WAY, and the halves that HOLD say which
    # clause is which. Measured at a_n=400 under the control: `slackin` and `slackwide` still make
    # the compare-and-swap fire (casFired true) and lose their bytes, because the generation every
    # commit published was emptied afterwards - final.read 0 of a published 12. `dirtytrunc`'s
    # THREE ANSWERS STILL AGREE (fdSize 4, readLen 4, seekEnd 4, threeAgree true): the renderer is
    # metadata and the control does not touch it, so what moves is the byte at offset 0.
    "cas slackin keeps every acknowledged byte",
    "cas slackwide keeps every acknowledged byte",
    "cas dirtytrunc keeps every acknowledged byte",
    # THE RETRY CLAUSE MOVES BECAUSE ITS SUBJECT IS A BYTE: it reads back what a 0 from `fsync`
    # claimed. Under the control every commit's generation is emptied, so the read-back finds
    # nothing — measured 192 of 200 rounds claiming durability over a file that reads 0 bytes, and
    # the refusals arrive as EIO from the staged-length assertion rather than as EBUSY. The journal
    # clause beside it is NOT in this list and must hold: the control leaves the sequences
    # perfectly consecutive and the blobs short.
    "cas a retried fsync is never told a discarded write is durable",
    "cas uncommitted slack does not resurrect",
    "cas fsck reports a blob longer than its published size",
    # THE CONTENTION CLAUSE IS "ONE KIND OF REFUSAL", and that is a property of a HEALTHY volume.
    # Under the control every staged generation is emptied after its commit, so the staged-length
    # assertion refuses each of the next commits and says why. Measured at a_n=400: errnos
    # [10, 29 x 15] - one EBUSY from the bounded retry running out, then fifteen EIO, each with its
    # own note naming the generation, its length and the size the commit would have published
    # ("staged generation 22.7 is 4 byte(s) on disk and its commit would publish 72"). Every one of
    # those is the control's corruption being refused rather than an unnamed failure, which is what
    # the clause is for on the headline path.
    "cas contention refuses only under EBUSY",
    # The orphan proof splits the same way a third time: the orphan is still on disk, the floor
    # still refuses to reuse its generation — both read off the DIRECTORY — and only the bytes in
    # the grown range go, because the control empties the blob the truncate staged.
    "orphan ok",
    "orphan a grown range reads as zeroes",
    # The O_APPEND section splits the way every data section does: both writes are still
    # ACKNOWLEDGED — the control touches no decision, only the bytes — and what moves is what a
    # fresh reader finds, with the fsck clause beside it, because the control empties each blob
    # after its commit and fsck then reports it SHORTER than the size the metadata publishes.
    "append two O_APPEND writers both keep their bytes",
    "append the volume is clean afterwards",
    # The ordering clause is this control's own subject, read off the trace rather than inferred:
    # with the data-before-metadata ordering dropped there is NO blob flush to precede the journal
    # append. The directory-handle clause beside it is untouched, which is what keeps the two
    # separate.
    "order the blob flush precedes the journal append",
    # Two of its fifty-four rows, and both are data rows: `pread reads from the offset` saw zeros,
    # and `ftruncate kept the bytes below it` saw zeros. Every one of its refusals and all its
    # metadata rows held, which is the same split as the rest of this list.
    "every other syscall answers correctly",
    "verdict is ok",
)

#: What removing the CRC turns red, measured the same way (`--files 8 --no-crc`): b2 and b3 come
#: back `stopped: null, accepted: true`, b3 APPLIES its corrupt record, the volume mounts
#: read-write with no problems at all, and `/d/0/modes/m9` reads 0o656 — a permission nobody wrote.
#:
#: b1 HOLDS, and that is the point. A plain truncation is caught by the record's LENGTH check, not
#: by its checksum, so a control that moved all three tears would not have said which guard it
#: removed. The holding clause is the evidence that the two guards are different guards.
_NO_CRC_FAILS = (
    "proof_b ok",
    "proof_b2 zero-padded tail reported",
    "proof_b3 flipped mode field reported",
    "proof_b a torn journal mounts read-only",
    "proof_b the user's file kept a mode somebody wrote",
    "verdict is ok",
)

#: The two labels the no-sigpend control turns red. `verdict is ok` goes with proof_e because the
#: aggregate verdict reads the all-ok of every proof; naming only proof_e would let a verdict
#: regression (e.g. a page that forgets to AND the five proofs) pass under this control.
_NO_SIGPEND_FAILS = ("proof_e ok", "verdict is ok")

#: The one expectation the kernel-stall control is named for; everything else it must leave
#: standing is derived. Named here because the control is scored on WHICH expectation fails: a
#: 2 ms stall that turned the check red by breaking the accounting identity, or by starving the
#: kernel until no cell was produced at all, would satisfy a control scored on Outcome.FAIL alone
#: while proving nothing about latency. Measured on this machine under the control (probe.py
#: --n 16 --window-ms 2600 --warmup 100 --stall-us 2000 --force-not-equal): p99 29,673.6 us
#: against the 500 us bar, 1,296 samples past the 1,000 the withholding rule needs, identity
#: 2967/2967/2967/2967, depth_p50 15 of 16, every anti-vacuity clause still ok, and 1 of 3 forced
#: not-equals.
#: A 2 ms stall drives EVERY percentile to ~29,673 us, so both latency clauses must go red. Naming
#: only one would let a stall that moved the tail but not the median satisfy this control.
_STALL_FAILS = ("p50 under the regression bar", "p99 under the tail ceiling")
_STALL_HOLDS = held_rest(SYSCALL_LABELS, _STALL_FAILS)


# ======================================================================================
# M3 — /proc, /dev, mounts, the provider interface, /dev/trace
# ======================================================================================

#: Clause-level, not one label per section, and for the reason M2's are: a control must be scored
#: on WHICH expectations move. "proc_vanish ok" alone could not distinguish a cached listing from
#: a /proc that never listed the pid at all.
M3_LABELS = (
    "cell reported",
    "page isolated",
    "kernel isolated",
    "the kernel raised no error",
    # The mount table, which everything else sits on.
    "mount_table ok",
    "the table has a root, /proc and /dev",
    "every mount reports a distinct non-zero device",
    "only the OPFS root is durable",
    # PROOF 1.
    "proc_list ok",
    "proc_list enumerates the live pids",
    "proc_list shows the reading process itself",
    "proc_list reports every pid as a directory",
    "proc_vanish ok",
    "proc_vanish the killed pid left the listing",
    "proc_vanish stat refuses with ENOENT",
    "proc_vanish open refuses with ENOENT",
    "proc_vanish the survivor is still listed",
    "proc_files ok",
    "proc_files status reports the pid",
    "proc_files status reports the state",
    "proc_files cmdline is NUL-terminated",
    "proc_files cwd is readable",
    "proc_files the fd directory lists the open fds",
    "proc_files a volatile file publishes no size",
    "proc_files fstat reports the snapshot length",
    # PROOF 2.
    "provider_probe ok",
    "provider_probe a ranged GET returns the exact byte count",
    "provider_probe Content-Range is present",
    "provider_probe a missing object is refused",
    "provider_probe the missing object is refused as a bad status",
    "usr_mount ok",
    "usr_mount /usr is in the mount table",
    "usr_mount every manifest entry was read",
    # PROOF 3.
    "trace_seq ok",
    "trace_seq the known sequence is in the trace",
    "trace_seq entry and exit are both recorded",
    "trace_seq the record sequence is monotonic",
    "trace_dropped ok",
    "trace_dropped the counter is displayed",
    "trace_dropped the ring dropped nothing",
    "trace_dropped the ring meets the 16 MiB floor",
    # The table and the read-only rule, observed from userland rather than from the kernel.
    "devices ok",
    "devices stat reports three distinct devices",
    "readonly ok",
    "readonly every mutation on /proc is refused",
    "readonly every refusal is EROFS",
    # /tmp, the one writable mount besides the root.
    "tmpfs ok",
    "tmpfs /tmp is mounted writable and not durable",
    "tmpfs every call succeeded",
    # The review's findings, each as the syscalls that tripped it.
    "regress ok",
    "regress no finding reopened",
    "verdict is ok",
    "document COOP",
    "document COEP",
    "served m3.html",
)

M3_DOCUMENT = "/www/m3.html"

#: `fill` is the syscall count the trace proof issues. 4,000 is far short of the 16 MiB ring's
#: 524,288 records and far past the 64 KiB control's 2,048, which is what makes one number serve
#: both phases.
M3_FILL = 4000

M3_READY = ("(() => { const s = globalThis.M3 && globalThis.M3.state; "
            "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")

READ_M3 = """(() => {
  const M = globalThis.M3 || {}
  const P = M.proofs || {}
  const one = (x) => (x === null || x === undefined
    ? null : { ok: x.ok === true, evidence: x.evidence || {} })
  return {
    state: String(M.state || ''),
    why: String(M.why || ''),
    verdict: String(M.verdict || ''),
    isolated: M.isolated === true,
    kernelIsolated: M.kernelIsolated === true,
    fingerprint: Number(M.kernelFingerprint || 0),
    cfg: M.config || {},
    errors: (M.errors || []).map(String),
    // THE STATE A STALLED PROOF RECORDED. www/m4b.html has written this for two milestones and
    // nothing ever read it, so every BROKEN run reported a bare message and threw away the one
    // artifact that localises the stall: which proof, which handshake step, and every message the
    // kernel did send before it stopped.
    stuck: M.stuck ? JSON.stringify(M.stuck) : '',
    faults: (M.faults || []).map((f) => String(f && f.why)),
    notes: (M.notes || []).map(String),
    mount_table: one(P.mount_table),
    proc_list: one(P.proc_list),
    proc_vanish: one(P.proc_vanish),
    proc_files: one(P.proc_files),
    provider_probe: one(P.provider_probe),
    usr_mount: one(P.usr_mount),
    trace_seq: one(P.trace_seq),
    trace_dropped: one(P.trace_dropped),
    devices: one(P.devices),
    readonly: one(P.readonly),
    tmpfs: one(P.tmpfs),
    regress: one(P.regress),
  }
})()"""

M3_SHAPE = {
    "state": str, "why": str, "verdict": str,
    "isolated": bool, "kernelIsolated": bool, "fingerprint": int,
    "cfg": dict, "errors": list, "faults": list, "notes": list,
    "mount_table": (dict, type(None)),
    "proc_list": (dict, type(None)),
    "proc_vanish": (dict, type(None)),
    "proc_files": (dict, type(None)),
    "provider_probe": (dict, type(None)),
    "usr_mount": (dict, type(None)),
    "trace_seq": (dict, type(None)),
    "trace_dropped": (dict, type(None)),
    "devices": (dict, type(None)),
    "readonly": (dict, type(None)),
    "tmpfs": (dict, type(None)),
    "regress": (dict, type(None)),
}

#: Which labels each M3 control must move. Hand-listed because the POINT of a control is that it
#: moves a NAMED subset; `held` is derived from these by held_rest, which refuses a label the
#: check cannot record.
_PROC_CACHE_FAILS = (
    "proc_vanish ok",
    "proc_vanish the killed pid left the listing",
    "verdict is ok",
)
_USR_404_FAILS = (
    "usr_mount ok",
    "usr_mount /usr is in the mount table",
    "usr_mount every manifest entry was read",
    "verdict is ok",
)
_TRACE_TINY_FAILS = (
    "trace_dropped ok",
    "trace_dropped the ring dropped nothing",
    "trace_dropped the ring meets the 16 MiB floor",
    "verdict is ok",
)


# ======================================================================================
# M4 — pipes, process groups, and the dead-peer asymmetry
# ======================================================================================

#: Clause-level, so the control can be scored on WHICH expectations move. Both SIGPIPE proofs
#: depend on the same fatal disposition, and nothing else does — which is what makes the control
#: specific rather than merely destructive.
M4_LABELS = (
    "cell reported",
    "page isolated",
    "kernel isolated",
    "the kernel raised no error",
    # A pipe carries bytes between two processes at all.
    "pipe_basic ok",
    "pipe2 returns two distinct fds",
    "both pipeline stages were reaped",
    # PROOF: `yes | head -1` terminates.
    "yes_head ok",
    "the writer was killed by SIGPIPE",
    "and the reader exited cleanly",
    # PROOF: one signal kills every stage.
    "group_signal ok",
    "both stages share one process group, and the orchestrator is outside it",
    "one kill(-pgid) signalled the group",
    "both stages died of SIGINT",
    # PROOF: a killed writer gives its blocked reader EOF, not an errno.
    "killed_writer_eof ok",
    "the killed writer was reaped",
    "and its blocked reader exited cleanly",
    # PROOF: a blocked writer whose reader died gets SIGPIPE.
    "killed_reader_epipe ok",
    "the blocked writer was killed by SIGPIPE",
    "verdict is ok",
    "document COOP",
    "document COEP",
    "served m4.html",
)

M4_DOCUMENT = "/www/m4.html"

M4_READY = ("(() => { const s = globalThis.M4 && globalThis.M4.state; "
            "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")

READ_M4 = """(() => {
  const M = globalThis.M4 || {}
  const P = M.proofs || {}
  const one = (x) => (x === null || x === undefined
    ? null : { ok: x.ok === true, evidence: x.evidence || {} })
  return {
    state: String(M.state || ''),
    why: String(M.why || ''),
    verdict: String(M.verdict || ''),
    isolated: M.isolated === true,
    kernelIsolated: M.kernelIsolated === true,
    cfg: M.config || {},
    errors: (M.errors || []).map(String),
    faults: (M.faults || []).map((f) => String(f && f.why)),
    pipe_basic: one(P.pipe_basic),
    yes_head: one(P.yes_head),
    group_signal: one(P.group_signal),
    killed_writer_eof: one(P.killed_writer_eof),
    killed_reader_epipe: one(P.killed_reader_epipe),
  }
})()"""

M4_SHAPE = {
    "state": str, "why": str, "verdict": str,
    "isolated": bool, "kernelIsolated": bool,
    "cfg": dict, "errors": list, "faults": list,
    "pipe_basic": (dict, type(None)),
    "yes_head": (dict, type(None)),
    "group_signal": (dict, type(None)),
    "killed_writer_eof": (dict, type(None)),
    "killed_reader_epipe": (dict, type(None)),
}

#: The labels a non-fatal SIGPIPE must move, and only those. Both SIGPIPE proofs, their section
#: flags, and the verdict.
_NO_SIGPIPE_FAILS = (
    "yes_head ok",
    "the writer was killed by SIGPIPE",
    "killed_reader_epipe ok",
    "the blocked writer was killed by SIGPIPE",
    "verdict is ok",
)


# ======================================================================================
# M4b — the pty, the line discipline, poll
# ======================================================================================

#: Clause-level, so each control is scored on the labels it is about. The two Ctrl-C clauses and
#: the blocking-poll clause are the subjects; everything else must hold under both controls.
M4B_LABELS = (
    "cell reported",
    "page isolated",
    "kernel isolated",
    "the kernel raised no error",
    # ECHO and ICANON, whose semantics no authored document specifies — POSIX defaults, assumed.
    "echo ok",
    "a typed line is echoed to the master as CR LF",
    "canonical ok",
    "a partial line leaves the reader parked",
    # THE ONE BEHAVIOUR MILESTONES.md SPECIFIES.
    "intr ok",
    "Ctrl-C killed the foreground group with SIGINT",
    "and the Ctrl-C byte was consumed, not echoed",
    "wedged_intr ok",
    "Ctrl-C reached a process spinning in a compute loop",
    # The other side of the same flag.
    "raw_isig_off ok",
    "with ISIG off the Ctrl-C arrives as data",
    # termios.
    "termios ok",
    "a fresh pty is canonical, echoing and signal-generating",
    "the reserved termios words survive a set",
    "an fd that is not a terminal is ENOTTY",
    "winsize ok",
    "a resize raises SIGWINCH on the foreground group",
    # A pty op whose signal reaches the CALLER, which every other proof here arranges not to do.
    "self_signal ok",
    "a fresh pty's foreground group is the opener's own",
    "a resize that signals the caller still resizes",
    "and the caller observes its own interruption",
    "the channel is not left one reply ahead",
    "exactly one call was answered by its own side effect",
    "the program loader never reached its deadline",
    # A negative timeout is infinite, and a refused `dup` leaks no reference.
    "empty_poll ok",
    "poll over an empty set with no timeout blocks",
    "and only a signal ends it",
    "fd_limit ok",
    "the fd table really reached its ceiling",
    "a refused dup leaks no reference, so the reader sees EOF",
    "and the read that follows returns 0",
    # Teardown's fd sweep moves readiness without replying; a refused open keeps no handle.
    "teardown_wake ok",
    "a process parked in poll with no timeout stays parked",
    "a dying writer's fd sweep wakes a peer parked in poll",
    "and the woken poll reported the pipe readable",
    "open_leak ok",
    "an open with no fd left is refused with EMFILE",
    "and keeps no sync access handle, so the file reopens",
    # poll, which constraint 42 requires and M4's build list omits.
    "poll_ready ok",
    "poll reports an idle set as nothing ready",
    "poll reports a ready pipe and a ready terminal",
    "poll reports a closed fd as POLLNVAL",
    "poll_wait ok",
    "a process parked in poll over two fds was woken by one",
    "fg_pgrp ok",
    "the foreground group moves, and a group that does not exist is refused",
    "verdict is ok",
    "document COOP",
    "document COEP",
    "served m4b.html",
)

M4B_DOCUMENT = "/www/m4b.html"

M4B_READY = ("(() => { const s = globalThis.M4B && globalThis.M4B.state; "
             "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")

READ_M4B = """(() => {
  const M = globalThis.M4B || {}
  const P = M.proofs || {}
  const one = (x) => (x === null || x === undefined
    ? null : { ok: x.ok === true, evidence: x.evidence || {} })
  return {
    state: String(M.state || ''),
    why: String(M.why || ''),
    verdict: String(M.verdict || ''),
    isolated: M.isolated === true,
    kernelIsolated: M.kernelIsolated === true,
    cfg: M.config || {},
    errors: (M.errors || []).map(String),
    faults: (M.faults || []).map((f) => String(f && f.why)),
    echo: one(P.echo),
    canonical: one(P.canonical),
    intr: one(P.intr),
    wedged_intr: one(P.wedged_intr),
    raw_isig_off: one(P.raw_isig_off),
    termios: one(P.termios),
    winsize: one(P.winsize),
    self_signal: one(P.self_signal),
    empty_poll: one(P.empty_poll),
    fd_limit: one(P.fd_limit),
    teardown_wake: one(P.teardown_wake),
    open_leak: one(P.open_leak),
    poll_ready: one(P.poll_ready),
    poll_wait: one(P.poll_wait),
    fg_pgrp: one(P.fg_pgrp),
  }
})()"""

M4B_SHAPE = {
    "state": str, "why": str, "verdict": str,
    "isolated": bool, "kernelIsolated": bool,
    "cfg": dict, "errors": list, "faults": list,
    "echo": (dict, type(None)),
    "canonical": (dict, type(None)),
    "intr": (dict, type(None)),
    "wedged_intr": (dict, type(None)),
    "raw_isig_off": (dict, type(None)),
    "termios": (dict, type(None)),
    "winsize": (dict, type(None)),
    "self_signal": (dict, type(None)),
    "empty_poll": (dict, type(None)),
    "fd_limit": (dict, type(None)),
    "teardown_wake": (dict, type(None)),
    "open_leak": (dict, type(None)),
    "poll_ready": (dict, type(None)),
    "poll_wait": (dict, type(None)),
    "fg_pgrp": (dict, type(None)),
}


# ======================================================================================
# M5 - the shell and ten programs
# ======================================================================================

#: Clause-level, so the control is scored on the labels it is about. The builtins, the refusals and
#: the URL refusals are the HELD set under `spawn-self`: none of them creates a process.
M5_LABELS = (
    "cell reported",
    "page isolated",
    "kernel isolated",
    "the kernel raised no error",
    "the mounts the programs live on are there",
    "every mountpoint exists as a directory on the volume beneath it",
    "no program crossed the wire for a process",
    # THE HEADLINE PROOF.
    "pipeline ok",
    "`ls /usr/bin | grep c | wc -l` printed the count this check worked out for itself",
    "and the trace shows four or more distinct pids doing it",
    "a two-stage pipeline counts every name",
    # `sleep 60 &`, `ps`, `kill %1`.
    "jobs ok",
    "ps listed the backgrounded sleep by pid",
    "and listed the shell that started it",
    "ps printed the argv the job was given",
    "kill %1 resolved a job spec and the job died of SIGTERM",
    # Redirection.
    "redirect ok",
    "every redirection row held",
    # The builtins, which spawn nothing.
    "builtins ok",
    "every builtin row held",
    # The exec path.
    "exec ok",
    "every exec row held",
    # The refusals.
    "refusals ok",
    "every refusal row held",
    # The shell on a terminal.
    "tty ok",
    "the shell painted a prompt on the terminal",
    "a typed line was echoed by the discipline and run by the shell",
    "the shell survived Ctrl-C and prompted again",
    "and ended the session on Ctrl-D",
    # Constraint 123, both halves.
    "no_url ok",
    "every URL spelling was refused by the filesystem",
    "and every import naming a host was refused by the linker",
    "while the one allowlisted specifier still loads",
    # M4's headline proof, said in shell for the first time.
    "endless ok",
    "`yes | head -1` terminated and printed one line",
    "verdict is ok",
    "document COOP",
    "document COEP",
    "served m5.html",
)

M5_DOCUMENT = "/www/m5.html"

M5_READY = ("(() => { const s = globalThis.M5 && globalThis.M5.state; "
            "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")

READ_M5 = """(() => {
  const M = globalThis.M5 || {}
  const P = M.proofs || {}
  const one = (x) => (x === null || x === undefined
    ? null : { ok: x.ok === true, evidence: x.evidence || {} })
  return {
    state: String(M.state || ''),
    why: String(M.why || ''),
    verdict: String(M.verdict || ''),
    isolated: M.isolated === true,
    kernelIsolated: M.kernelIsolated === true,
    cfg: M.config || {},
    errors: (M.errors || []).map(String),
    faults: (M.faults || []).map((f) => String(f && f.why)),
    mounts: M.mounts || {},
    pipeline: one(P.pipeline),
    jobs: one(P.jobs),
    redirect: one(P.redirect),
    builtins: one(P.builtins),
    exec: one(P.exec),
    refusals: one(P.refusals),
    tty: one(P.tty),
    no_url: one(P.no_url),
    endless: one(P.endless),
  }
})()"""

M5_SHAPE = {
    "state": str, "why": str, "verdict": str,
    "isolated": bool, "kernelIsolated": bool,
    "cfg": dict, "errors": list, "faults": list, "mounts": dict,
    "pipeline": (dict, type(None)),
    "jobs": (dict, type(None)),
    "redirect": (dict, type(None)),
    "builtins": (dict, type(None)),
    "exec": (dict, type(None)),
    "refusals": (dict, type(None)),
    "tty": (dict, type(None)),
    "no_url": (dict, type(None)),
    "endless": (dict, type(None)),
}

#: What a `spawn` that creates nothing must break, and ONLY this. Measured under the control on
#: Chrome 157.0.8103.52: exactly these 17 red, the other 14 intact - the builtins, the refusals and
#: the URL refusals all hold, because none of them creates a process. `exec` moves because two of
#: its six rows need a child; its four REFUSAL rows hold, which is what shows the control subverts
#: creation and not the error paths.
_SPAWN_SELF_FAILS = (
    "pipeline ok",
    "`ls /usr/bin | grep c | wc -l` printed the count this check worked out for itself",
    "and the trace shows four or more distinct pids doing it",
    "a two-stage pipeline counts every name",
    "jobs ok",
    "ps listed the backgrounded sleep by pid",
    "and listed the shell that started it",
    "ps printed the argv the job was given",
    "kill %1 resolved a job spec and the job died of SIGTERM",
    "redirect ok",
    "every redirection row held",
    "exec ok",
    "every exec row held",
    "tty ok",
    "a typed line was echoed by the discipline and run by the shell",
    # `yes | head -1` needs two children, so it goes with the pipelines. The import rows do NOT:
    # a refusal happens in the linker, before anything is created.
    "endless ok",
    "`yes | head -1` terminated and printed one line",
    "verdict is ok",
)


# ======================================================================================
# M4a - the terminal gets a real window
# ======================================================================================

#: Clause-level, as every section here is. The HELD set under `pty-detach` is everything that is
#: not the echo: the window still delivers the keystroke to the kernel, the relay is still parked
#: in `poll` over both sources, the frame still moves, and the detector still fires both ways.
M7_LABELS = (
    "cell reported",
    "page isolated",
    "kernel isolated",
    "the kernel raised no error",
    # THE HEADLINE. `PLAN.md` §5 M7: "one process opens two windows and a pipe, and `poll()` wakes
    # it for each in turn". A process has ONE futex word and ONE outstanding call (constraint 42),
    # so with a per-window wait the program behind this section could not be written.
    "poll ok",
    "one process created two windows and the page built both frames",
    "and it waited on all three fds at once, parked in poll",
    "poll woke it for window A",
    "poll woke it for window B",
    "poll woke it for the pipe",
    "and each key arrived on the fd it was typed into",
    "the keys into window A were real browser keystrokes",
    "and the program exited because every fd had delivered, not at its ceiling",
    # The other half of what the milestone claims: a window is visible as a FILE.
    "procwin ok",
    "/proc/<pid>/win lists one entry per live window",
    "and each file names its window, its process and the fds that reach it",
    "and a winid nobody owns is ENOENT",
    "and another live process's directory does not carry this window",
    # The destroy cascade, which MILESTONES' ordering correction says M7 owes M9 and M10.
    "cascade ok",
    "destroying an owner destroys its children",
    "and win_destroy reports every id to the caller",
    "and the page takes every frame down",
    "and the program exits because its windows went, not at its ceiling",
    # Cross-process ownership, the second thing that correction names.
    "crossproc ok",
    "two processes, and one owns a window parented onto the other's",
    "one win_destroy reports both ids across the process boundary",
    "and the kernel has no live window left",
    "and the other process is told on its own fd",
    "and both frames went",
    # The X button, and the fix whose absence an independent critic found: the close request
    # was queued by the page and wiped by `destroy` two messages later.
    "close ok",
    "the X button delivers WEV_CLOSE to the process",
    "and the program is what acts on it, by destroying the window itself",
    "and only then does the frame go",
    # The not-responding detector, which moved here from `m4a` with the window ABI.
    "health ok",
    "the window worked before its process stopped reading",
    "the caption greys when events go uncollected",
    "End Process appears only at the second threshold",
    "and the kernel agrees the queue was waiting",
    "and the caption clears when the process drains the queue",
    "verdict is ok",
    "document COOP",
    "document COEP",
    "served m7.html",
)

M7_DOCUMENT = "/www/m7.html"

#: TWO TERMINAL STATES, AND `await-keys` IS ONE OF THEM — M4a's arrangement, for its reason: the
#: page sets up the session, announces that it is waiting to be typed at, and stops, so the keys
#: that arrive went through Chrome's own focus and key translation and the widget sees `isTrusted`.
M7_READY = ("(() => { const M = globalThis.M7 || {}; const s = M.state; "
            "if (s === 'done' || s === 'aborted' || s === 'error') return s; "
            "return M.phase === 'await-keys' ? 'await-keys' : '' })()")

M7_DONE = ("(() => { const s = globalThis.M7 && globalThis.M7.state; "
           "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")

READ_M7 = """(() => {
  const M = globalThis.M7 || {}
  const P = M.proofs || {}
  const one = (x) => (x === null || x === undefined
    ? null : { ok: x.ok === true, evidence: x.evidence || {} })
  return {
    state: String(M.state || ''),
    why: String(M.why || ''),
    phase: String(M.phase || ''),
    verdict: String(M.verdict || ''),
    isolated: M.isolated === true,
    kernelIsolated: M.kernelIsolated === true,
    cfg: M.config || {},
    errors: (M.errors || []).map(String),
    faults: (M.faults || []).map((f) => String(f && f.why)),
    poll_many: one(P.poll_many),
    procwin: one(P.procwin),
    cascade: one(P.cascade),
    crossproc: one(P.crossproc),
    close: one(P.close),
    health: one(P.health),
  }
})()"""

M7_SHAPE = {
    "state": str, "why": str, "phase": str, "verdict": str,
    "isolated": bool, "kernelIsolated": bool,
    "cfg": dict, "errors": list, "faults": list,
    "poll_many": (dict, type(None)),
    "procwin": (dict, type(None)),
    "cascade": (dict, type(None)),
    "crossproc": (dict, type(None)),
    "close": (dict, type(None)),
    "health": (dict, type(None)),
}

#: What EVALUATING ONLY THE FIRST FD OF A POLL SET must break, and only this.
#:
#: Measured under the control on Chrome 157: exactly these six red, the other thirty-six intact.
#: Window A still wakes the poller, the real keystroke still reaches it, `/proc/<pid>/win` still
#: lists both windows, the cascade still cascades, and the detector still greys and clears — the
#: wedge polls a ONE-fd set, so first-fd-only cannot touch it.
#:
#: THAT SPLIT IS THE WHOLE CONTROL. A `poll` that answered correctly for one fd and never for the
#: others would satisfy every other label in this check, and nothing else in the suite can tell
#: the two apart: M4b's `poll` sections use two fds of different kinds in ONE process, which is the
#: same shape, but they are the pty's check and would go red for the pty's reasons.
_WIN_FIRST_FD_FAILS = (
    "poll ok",
    "poll woke it for window B",
    "poll woke it for the pipe",
    "and each key arrived on the fd it was typed into",
    "and the program exited because every fd had delivered, not at its ceiling",
    "verdict is ok",
)

#: What A DESTROY THAT DOES NOT CASCADE must break.
#:
#: Eleven red, thirty-one intact. Both cascade sections go, including the cross-process one — a
#: child in another process is destroyed by the same walk — and so does the clause that asserts
#: each program exited BECAUSE ITS WINDOWS WENT: a program that ran to its own ceiling still exits
#: 0, so the exit status alone cannot tell the two apart.
#:
#: WHAT MUST HOLD: every poll label, every `/proc` label, and both edges of the detector. The
#: cascade is a property of `win_destroy` and has nothing to do with waiting on an fd.
_NO_CASCADE_FAILS = (
    "cascade ok",
    "destroying an owner destroys its children",
    "and win_destroy reports every id to the caller",
    "and the page takes every frame down",
    "and the program exits because its windows went, not at its ceiling",
    "crossproc ok",
    "one win_destroy reports both ids across the process boundary",
    "and the kernel has no live window left",
    "and the other process is told on its own fd",
    "and both frames went",
    "verdict is ok",
)


M8_LABELS = (
    "cell reported",
    "page isolated",
    "kernel isolated",
    "the kernel raised no error",
    # THE MILESTONE'S OWN PROOF, in `MILESTONES.md`'s words: "a process draws a known 4x4 pattern;
    # screenshot and assert the pixels". The pattern is `src/bin/paint.mjs`'s, so the proof is
    # about the path a user runs, and the pixels are read back out of the canvas the browser
    # painted — an inert canvas and a working one are the same picture (constraint 40).
    "pattern ok",
    "the process got a surface and the page made a canvas for it",
    "the program reported the batch it sent",
    "and every pixel of the pattern is on the canvas",
    "while a pixel nothing drew on is still the paper colour",
    "and the page replayed exactly the ops the kernel forwarded",
    # A surface with no input is a frame around a picture. The drag is REAL mouse input through
    # Chrome's own hit testing, which is the only thing that exercises the canvas's own listeners.
    "pointer ok",
    "a real mouse drag reached the process as pointer events",
    "and the process drew in response",
    "and the pixels under the drag changed",
    "while a corner the drag never reached did not",
    "and the surface reported a focus change",
    # The accounting, which is the whole reason the surface is kernel-owned (D31).
    "budget ok",
    "a surface larger than the per-surface cap is EINVAL",
    "the budget refuses with ENOMEM, which is a ceiling and not a transient",
    "after granting several window-sized surfaces",
    "and destroying the windows gives the area back",
    "the kernel accounts no surface once they are gone",
    # One content mode per window.
    "textmode ok",
    "a surfaced window refuses cells with EINVAL",
    "while a draw on the same window still succeeds",
    "and a batch that lies about its own size is refused four ways",
    "verdict is ok",
    "document COOP",
    "document COEP",
    "served m8.html",
)

M8_DOCUMENT = "/www/m8.html"

#: `await-pointer` is a terminal state for the ready expression, so the check can send the drag.
#: The page publishes the coordinates because the canvas is SCALED by CSS — its own bounding
#: rectangle is the only honest source for where a click lands in surface pixels.
M8_READY = ("(() => { const M = globalThis.M8 || {}; const s = M.state; "
            "if (s === 'done' || s === 'aborted' || s === 'error') return s; "
            "return M.phase === 'await-pointer' ? 'await-pointer' : '' })()")

M8_DONE = ("(() => { const s = globalThis.M8 && globalThis.M8.state; "
           "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")

READ_M8 = """(() => {
  const M = globalThis.M8 || {}
  const P = M.proofs || {}
  const one = (x) => (x === null || x === undefined
    ? null : { ok: x.ok === true, evidence: x.evidence || {} })
  return {
    state: String(M.state || ''),
    why: String(M.why || ''),
    phase: String(M.phase || ''),
    verdict: String(M.verdict || ''),
    isolated: M.isolated === true,
    kernelIsolated: M.kernelIsolated === true,
    cfg: M.config || {},
    errors: (M.errors || []).map(String),
    faults: (M.faults || []).map((f) => String(f && f.why)),
    pattern: one(P.pattern),
    pointer: one(P.pointer),
    budget: one(P.budget),
    textmode: one(P.textmode),
  }
})()"""

M8_SHAPE = {
    "state": str, "why": str, "phase": str, "verdict": str,
    "isolated": bool, "kernelIsolated": bool,
    "cfg": dict, "errors": list, "faults": list,
    "pattern": (dict, type(None)),
    "pointer": (dict, type(None)),
    "budget": (dict, type(None)),
    "textmode": (dict, type(None)),
}

#: What A DRAW THAT NEVER REACHES THE PAGE must break, and only this.
#:
#: Measured under the control on Chrome 157: exactly these seven red, the other twenty-three intact.
#: The process still gets its surface, still sends its batch, still SEES the real pointer events
#: and still draws in response; the kernel still charges the ops to the window and still refuses
#: the budget and the cells. What disappears is the pixels.
#:
#: THAT SPLIT IS THE WHOLE CONTROL. A page that drew something of its own — a canvas it filled, a
#: pattern it knew — would satisfy every pixel clause with no process behind it, and nothing else
#: in the suite can tell the two apart.
_NO_DRAW_FAILS = (
    "pattern ok",
    "and every pixel of the pattern is on the canvas",
    "while a pixel nothing drew on is still the paper colour",
    "and the page replayed exactly the ops the kernel forwarded",
    "pointer ok",
    "and the pixels under the drag changed",
    "verdict is ok",
)


M9_LABELS = (
    "cell reported",
    "page isolated",
    "kernel isolated",
    "the kernel raised no error",
    # THE DIALOG STAYS ON TOP AND THE OWNER CANNOT BE RAISED OVER IT. Constraint 44's defect in
    # one line: "without an owner chain a dialog sits behind the window that owns it".
    "stacking ok",
    "raising the owner brings its RENDER_ABOVE palette with it",
    "the X asked instead of acting, and the dialog appeared",
    "the dialog is BLOCKING at window scope",
    "and it sits above the window that owns it",
    "which the page rendered, so a reader sees it too",
    "a REAL click on the owner was refused by the kernel",
    "and the blocker it named is the dialog",
    "so the order did not change at all",
    "while an unrelated process's window still raises",
    "a window created after a raise goes on top",
    "and the page rendered it above the window that was clicked",
    # INPUT SUPPRESSION, which is what makes a modal a modal rather than a stacking rule - and it
    # has to reach the FRAME, because a drag and an arrow-key move never reach the kernel at all.
    "suppress ok",
    "typing into the blocked window changed nothing on its screen",
    "because the kernel suppressed the keys, and counted them",
    "and nothing is left queued for it either",
    "the kernel named it blocked, and the frame carries that",
    "so arrow keys on its title bar do not move it",
    "and the same keys DO move a window that is not blocked",
    "and a REAL mouse drag on its title bar moves it nowhere",
    # THE CLOSE IS A REQUEST. Constraint 44's other half: "without a close-request event, unsaved
    # work is discarded silently".
    "refuse ok",
    "the X opened a dialog and closed nothing",
    "Esc refused the close and the editor is still there",
    "and it is editable again, so the suppression lifted with the modal",
    "the program counted the request and the refusal",
    "and answering it destroyed every owned window, through the cascade",
    # THE TWO AXES ARE TWO, which is the correction MILESTONES' ordering note makes to M9's plan.
    "scope ok",
    "the dialog is BLOCKING at APP scope",
    "raising a SIBLING window of the same process was refused",
    "and the sibling's input is suppressed as well",
    # SYSTEM SCOPE NEEDS NO PRIVILEGE, so what is asserted is the ESCAPE from it.
    "a system-modal window from another process blocks these too",
    "and End Process is offered on it at once, while it is still responsive",
    "the two page races are counted apart",
    "verdict is ok",
    "document COOP",
    "document COEP",
    "served m9.html",
)

M9_DOCUMENT = "/www/m9.html"

#: `await-click` is a terminal state for the ready expression, so the check can send a REAL click
#: on the buried window. The page publishes the coordinates because only the page knows them: the
#: frame is positioned by the clamp.
M9_READY = ("(() => { const M = globalThis.M9 || {}; const s = M.state; "
            "if (s === 'done' || s === 'aborted' || s === 'error') return s; "
            "return M.phase === 'await-click' ? 'await-click' : '' })()")

M9_DONE = ("(() => { const s = globalThis.M9 && globalThis.M9.state; "
           "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")

READ_M9 = """(() => {
  const M = globalThis.M9 || {}
  const P = M.proofs || {}
  const one = (x) => (x === null || x === undefined
    ? null : { ok: x.ok === true, evidence: x.evidence || {} })
  return {
    state: String(M.state || ''),
    why: String(M.why || ''),
    phase: String(M.phase || ''),
    verdict: String(M.verdict || ''),
    isolated: M.isolated === true,
    kernelIsolated: M.kernelIsolated === true,
    cfg: M.config || {},
    errors: (M.errors || []).map(String),
    faults: (M.faults || []).map((f) => String(f && f.why)),
    stacking: one(P.stacking),
    suppress: one(P.suppress),
    refuse: one(P.refuse),
    scope: one(P.scope),
  }
})()"""

M9_SHAPE = {
    "state": str, "why": str, "phase": str, "verdict": str,
    "isolated": bool, "kernelIsolated": bool,
    "cfg": dict, "errors": list, "faults": list,
    "stacking": (dict, type(None)),
    "suppress": (dict, type(None)),
    "refuse": (dict, type(None)),
    "scope": (dict, type(None)),
}

M10_LABELS = (
    "cell reported",
    "page isolated",
    "kernel isolated",
    "the kernel raised no error",
    # AN IMAGE THROUGH THE CLIPBOARD, BETWEEN PROCESSES, WITH THE SOURCE KILLED. Constraint 45's
    # first half: "a single untyped byte blob cannot carry an image between two apps".
    "copy ok",
    "the copy offered a path list AND the image",
    "the clipboard holds one object, with both formats",
    "and the process that copied it was killed, payload intact",
    "a program reads the clipboard out of /proc/dataobj",
    "the paste drew the image",
    "and the pixels are the logo's own",
    # THE DRAG, WITH A REAL MOUSE, BETWEEN TWO PROCESSES' WINDOWS. Constraint 45's second half.
    "drag ok",
    "a press and a 1 px move start no drag",
    "the kernel ran exactly one drag session",
    "the target was entered once",
    "the drop was delivered",
    "and the source was told the effect",
    "the bytes arrived under the image format",
    "the receiver drew them",
    "and the pixels on its canvas are the logo's",
    "the payload was released once the receiver closed it",
    "driven by a REAL mouse",
    # AND THE REFUSAL, which is what "typed" MEANS: a path list is not an image.
    "refuse ok",
    "a text file is copied as text, with no image format",
    "the image view refused it as ENOTSUP",
    "and said what the object DID offer",
    "nothing was drawn as an image",
    # THE PAYLOAD IS ACCOUNTED, AND THE PAGE CANNOT FORGE A DROP.
    "account ok",
    "a PNG is copied as an opaque payload",
    "the kernel holds its bytes while anything references it",
    "the receiver reads its header and reports the size",
    "and it refuses to draw what it cannot decode",
    "the page cannot feed a drag record",
    "verdict is ok",
    "document COOP",
    "document COEP",
    "served m10.html",
)

M10_DOCUMENT = "/www/m10.html"

#: `await-pointer` is a terminal state for the ready expression, so the check can send a REAL drag
#: between two windows. The page publishes the coordinates because only the page knows them: a
#: surface is positioned by the clamp and scaled by CSS. It is the same phase name `www/m8.html`
#: uses, so one driver reads one vocabulary.
M10_READY = ("(() => { const M = globalThis.M10 || {}; const s = M.state; "
             "if (s === 'done' || s === 'aborted' || s === 'error') return s; "
             "return M.phase === 'await-pointer' ? 'await-pointer' : '' })()")

M10_DONE = ("(() => { const s = globalThis.M10 && globalThis.M10.state; "
            "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")

READ_M10 = """(() => {
  const M = globalThis.M10 || {}
  const P = M.proofs || {}
  const one = (x) => (x === null || x === undefined
    ? null : { ok: x.ok === true, evidence: x.evidence || {} })
  return {
    state: String(M.state || ''),
    why: String(M.why || ''),
    phase: String(M.phase || ''),
    verdict: String(M.verdict || ''),
    isolated: M.isolated === true,
    kernelIsolated: M.kernelIsolated === true,
    cfg: M.config || {},
    errors: (M.errors || []).map(String),
    faults: (M.faults || []).map((f) => String(f && f.why)),
    copy: one(P.copy),
    drag: one(P.drag),
    refuse: one(P.refuse),
    account: one(P.account),
  }
})()"""

M10_SHAPE = {
    "state": str, "why": str, "phase": str, "verdict": str,
    "isolated": bool, "kernelIsolated": bool,
    "cfg": dict, "errors": list, "faults": list,
    "copy": (dict, type(None)),
    "drag": (dict, type(None)),
    "refuse": (dict, type(None)),
    "account": (dict, type(None)),
}

#: What AN OBJECT THAT OFFERS ONLY TEXT must break, and only this.
#:
#: Measured on Chrome 157, and the first version of this control was WRONG in a way worth keeping
#: on the record: it broke everything. Two programs treated a refused format as fatal, so under
#: text-only `clip` published nothing and `files` never started a drag - the clipboard was empty,
#: the gesture never ran, and twenty-one of twenty-five clauses went red. A control satisfied by
#: that verifies nothing about TYPES. Both programs write what the kernel GRANTED now, so the
#: gestures run end to end and what fails is the format and the format alone.
_TEXT_ONLY_FAILS = (
    "copy ok",
    # AND THE `/proc` CLAUSE, which is in this list because of what it now greps for: `paths,bitmap`
    # is in that file only if an object offering both formats is really on the clipboard, and under
    # this control none is. Grepping the label `clipboard:` instead passed here against an empty
    # slot, which is the mis-coupling a critic found.
    "a program reads the clipboard out of /proc/dataobj",
    "the copy offered a path list AND the image",
    "the clipboard holds one object, with both formats",
    "and the process that copied it was killed, payload intact",
    "the paste drew the image",
    "and the pixels are the logo's own",
    "drag ok",
    "the bytes arrived under the image format",
    "the receiver drew them",
    "and the pixels on its canvas are the logo's",
    "account ok",
    "a PNG is copied as an opaque payload",
    "the kernel holds its bytes while anything references it",
    "the receiver reads its header and reports the size",
    "and it refuses to draw what it cannot decode",
    "verdict is ok",
)

#: What A WORLD WHERE NO DROP IS DELIVERED must break.
#:
#: The session still begins, the target is still entered and the page still renders the highlight -
#: all of which is the GESTURE - and the payload simply never reaches anybody. WHAT MUST HOLD is
#: the whole clipboard half and the whole refusal half, because neither has anything to do with a
#: drop. A control that broke both gestures could not say which one it removed.
_NO_DROP_FAILS = (
    "drag ok",
    "the drop was delivered",
    "and the source was told the effect",
    "the bytes arrived under the image format",
    "the receiver drew them",
    "and the pixels on its canvas are the logo's",
    "verdict is ok",
)

#: What REMOVING THE OWNER CHAIN from a raise must break, and only this.
#:
#: Measured on Chrome 157: the dialog is created on top, so it is still above its owner until
#: something raises the owner — and then it falls behind, which is the one thing this control is
#: about. The refusal still happens (the modal still blocks), so what moves is the ORDER after the
#: click and the page's rendering of it.
_NO_OWNER_CHAIN_FAILS = (
    "stacking ok",
    "raising the owner brings its RENDER_ABOVE palette with it",
    "verdict is ok",
)

#: What A WORLD WITH NO MODALITY must break.
#:
#: The raise is granted, so the order changes and no blocker is named; and the keys arrive, so the
#: blocked window's screen changes and nothing is suppressed. WHAT MUST HOLD is the whole close
#: contract — the X still asks, Esc still refuses, answering still cascades — because that half of
#: M9 has nothing to do with modality, and the sibling's SCOPE clauses still read the axes the
#: program set.
_NO_MODAL_FAILS = (
    "stacking ok",
    "a REAL click on the owner was refused by the kernel",
    "and the blocker it named is the dialog",
    "so the order did not change at all",
    "suppress ok",
    "typing into the blocked window changed nothing on its screen",
    "because the kernel suppressed the keys, and counted them",
    "scope ok",
    "raising a SIBLING window of the same process was refused",
    "and the sibling's input is suppressed as well",
    # AND THE FRAME GOES WITH IT: with nothing blocking, the kernel's blocked set is empty, so the
    # frame is never marked and the drag and the arrow keys MOVE THE WINDOW - which is the clause
    # that says those two are coupled to the modality and not to a disabled handler.
    "the kernel named it blocked, and the frame carries that",
    "so arrow keys on its title bar do not move it",
    "and a REAL mouse drag on its title bar moves it nowhere",
    # A system-modal window blocks nothing either, so the ENFORCEMENT clause moves.
    "a system-modal window from another process blocks these too",
    # BUT THE ESCAPE HATCH IS DECLARED TO HOLD, and the control is what made that explicit. End
    # Process is offered because the window HOLDS system scope, which is a fact about what the
    # program asked for — not about whether the kernel is enforcing it. A hatch that disappeared
    # when the modality path broke would be a hatch that fails in the one world it is for.
    "verdict is ok",
)


# ======================================================================================
# M11 — Aero glass, frame-only
# ======================================================================================

M11_LABELS = (
    "page isolated",
    "kernel isolated",
    "the kernel raised no error",
    "two windows, both framed",
    # PROOF 1. `backdrop-filter` filters the element's BORDER BOX, so a ring is only a ring if it
    # is several boxes that sum to one. One glass node with an opaque client child hides the blur
    # and saves none of it (constraint 49, `docs/designs/REVIEW-FINDINGS.md` §3).
    "ring ok",
    "the frame is FOUR separately filtered strips",
    "and their summed border boxes are what aero.ringArea says",
    "while the frame itself and the client area filter NOTHING",
    "so the ring is ~10x cheaper than the same window as one glass node",
    # PROOF 2. The failure with no symptom.
    "chain ok",
    "no ancestor of any strip severs the blur chain",
    "and both additive layers sit INSIDE a strip, on plus-lighter",
    # PROOF 3. The milestone's own proof, and the only clauses a screenshot can settle.
    "blur ok",
    "the caption straddles a hard black/white seam",
    "and the band sampled is clear of the title glyphs",
    "the BARE backdrop reads as a hard step, so the seam is real",
    "and the glass reads as a SPREAD ramp, which a step cannot fake",
    "while the band is not flat, which blur(flat) would be",
    # PROOF 4. The halo, measured as local contrast rather than as a declared colour pair.
    "legible ok",
    "the caption carries a halo, and its glyphs cross the seam",
    "the caption is legible over the BLACK side of the seam",
    "and over the WHITE side, which no single text colour manages",
    # PROOF 5. IT SAID THE OPPOSITE UNTIL M14, and the change is the milestone rather than a
    # correction: minimize and maximize were drawn and DISABLED while there was nothing to minimize
    # into, no snap state to maximize to and no state property in the window ABI. M14 added all
    # three, so what is asserted now is the WIRING and the round trip — `disabled === false` alone
    # is the live-looking-button-that-does-nothing defect the old clause existed to forbid.
    "caption ok",
    "minimize and maximize are live, drawn and labelled",
    "and a minimize round trip returns the window to the same box",
    "and a REAL mouse drag from either of them does not move the window",
    "while the close box is still live",
    "and End Process is not offered on a window that is responding",
    # PROOF 6.
    "focus ok",
    "an inactive window passes MORE backdrop through, not less",
    "and tints it LESS, which one opacity value cannot express",
    "and the remap is 0.4*b + 0.6, measured off the computed filter",
    "verdict is ok",
    "document COOP",
    "document COEP",
    "served m11.html",
)

M11_DOCUMENT = "/www/m11.html"

M11_READY = ("(() => { const M = globalThis.M11 || {}; const s = M.state; "
             "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")

M11_DONE = M11_READY

READ_M11 = """(() => {
  const M = globalThis.M11 || {}
  const P = M.proofs || {}
  const one = (x) => (x === null || x === undefined
    ? null : { ok: x.ok === true, evidence: x.evidence || {} })
  return {
    state: String(M.state || ''),
    why: String(M.why || ''),
    phase: String(M.phase || ''),
    verdict: String(M.verdict || ''),
    isolated: M.isolated === true,
    kernelIsolated: M.kernelIsolated === true,
    cfg: M.config || {},
    errors: (M.errors || []).map(String),
    faults: (M.faults || []).map((f) => String(f && f.why)),
    live: [...document.querySelectorAll('.window')].length,
    ring: one(P.ring),
    chain: one(P.chain),
    blur: one(P.blur),
    legible: one(P.legible),
    caption: one(P.caption),
    focus: one(P.focus),
  }
})()"""

#: The first window's placed box, straight off the dataset `src/wm/window.mjs` publishes — so
#: a drag's effect is read from what the frame actually did rather than from a page variable.
READ_M11_BOX = ("(() => { const w = document.querySelector('.window'); return w ? "
                "[w.dataset.x, w.dataset.y, w.dataset.w, w.dataset.h].join(',') : '' })()")

M11_SHAPE = {
    "state": str, "why": str, "phase": str, "verdict": str,
    "isolated": bool, "kernelIsolated": bool,
    "cfg": dict, "errors": list, "faults": list, "live": int,
    "ring": (dict, type(None)),
    "chain": (dict, type(None)),
    "blur": (dict, type(None)),
    "legible": (dict, type(None)),
    "caption": (dict, type(None)),
    "focus": (dict, type(None)),
}

#: How far either side of the seam the band runs, in CSS px, and how many device rows it averages.
#:
#: 8 is inside one standard deviation of a 9 px blur, which is the steep part of the ramp; a wider
#: run reaches the flat tails where a one-LSB wobble is not a defect. 6 rows because the compositor
#: dithers, and averaging is honest when the seam is VERTICAL: every row sees the same horizontal
#: profile, so the mean is of repeated measurements rather than of different ones.
M11_REACH_CSS = 8
M11_BAND_ROWS = 6

#: THE THRESHOLD THAT SEPARATES A BLUR FROM A STEP, and the reason it is not "monotonic".
#:
#: `PLAN.md` §5 asks M11 for "a monotonic gradient". MEASURED, A HARD STEP IS MONOTONIC: the bare
#: seam, the `blur(0px)` control, the `backdrop-filter: none` control and a severed chain all report
#: a monotonic rise (`bench/m11-glass/probe.py`). What separates them is CONCENTRATION — the share
#: of the whole transition that falls between one adjacent pair of samples. A step puts all of it
#: there and reads 1.00; a blur spreads it.
#:
#: Measured on Chrome 157 at dpr 2, over `www/m11.html`'s own caption:
#:
#:     glass, headless      0.078      glass, headed        0.077
#:     blur(0px)            0.963      backdrop-filter:none 0.982
#:     severed chain        0.982      bare seam            1.000
#:
#: 0.35 sits in the empty middle with a factor of four either side, so neither a slower software
#: rasteriser nor a sharper GPU one moves the answer.
M11_SPREAD_MAX = 0.35
#: And the bare seam must read as a step, or "spread" could be satisfied by a FLAT backdrop — which
#: is constraint 50 exactly. This is the reference the threshold above is relative to.
M11_STEP_MIN = 0.80
#: A flat band has no transition to spread. Measured span of the real glass band: 30.8 luma.
M11_SPAN_MIN = 8.0
#: WCAG AA for text. Measured 9.3:1 over the black side and 8.9:1 over the white one; with the halo
#: removed, 2.1:1 and 1.7:1.
M11_CONTRAST_MIN = 4.5

#: What A WORLD WITH NO BLUR must break, and only this.
#:
#: MEASURED, AND THIS IS THE WHOLE POINT OF THE MILESTONE: under `--negative no-blur` the PAGE's own
#: six proofs all stay green. The geometry is unchanged, the chain is intact, the halo is there, the
#: buttons are still inert and the focus pair still moves. Nothing reachable from script can see
#: that the blur is gone — `getImageData` reads a canvas and a DOM rasteriser applies no filter — so
#: the screenshot clauses are the only thing in this suite that can catch it.
#:
#: IT IS ONE LABEL, and the first draft of this tuple had three. The other two HELD, measured, and
#: both for reasons worth keeping: the band is not FLAT under this control, it is a step with a span
#: of 49 luma, so the flatness clause is about a different world (`--negative flat-desk`); and the
#: page's own `verdict` stays `ok` because nothing the page can read has changed. So exactly one
#: assertion in this entire suite can tell that the glass stopped blurring. That is the milestone,
#: and a wider tuple would have hidden it.
_NO_BLUR_FAILS = (
    "and the glass reads as a SPREAD ramp, which a step cannot fake",
)

#: What A FLAT BACKDROP breaks — CONSTRAINT 50 ITSELF, as a runnable world.
#:
#: `blur(flat) == flat`, so over a flat desktop the caption's band is flat whether or not anything
#: blurred: the sampled pixel is identical with the filter on and off. Every pixel clause here would
#: then pass against a system with no blur at all, which is "the same class of defect as constraint
#: 39" in constraint 50's own words.
#:
#: This control is what shows the pixel clauses are COUPLED TO THE SEAM rather than to a constant.
#: Inversion alone cannot: an assertion over a constant still inverts and still fires.
#:
#: AND RUNNING IT FOUND A DEFECT IN THIS CHECK, which is the reason it is worth its cost. The SPREAD
#: clause HELD over a flat desktop. It should not have: with nothing to blur there is no ramp. The
#: cause is `.aero-light`, the viewport-anchored specular highlight — a `background-attachment:
#: fixed` gradient, so it varies horizontally across the band ON ITS OWN, and that variation reads
#: as a spread transition with no backdrop involved at all. The highlight was satisfying the blur
#: assertion.
#:
#: So the SPAN clause is not redundant with the spread clause: it is the one that couples this check
#: to the seam, and without it `--negative flat-desk` would have reported a blurred desktop that
#: was not there. Both are asserted, and this tuple records which of them actually fires.
_FLAT_DESK_FAILS = (
    "the BARE backdrop reads as a hard step, so the seam is real",
    "while the band is not flat, which blur(flat) would be",
)

#: What `backdrop-filter: none` breaks — the control `PLAN.md` named. It is a SUPERSET of no-blur's
#: subset, which is the finding: it takes the filter away entirely, so the strips stop filtering and
#: proof 1's "nothing else filters" clause and the page's own ring verdict go with the pixels.
#: Measured, it moves SEVEN labels against no-blur's one, and the extra six are all collateral:
#: taking the property away stops the strips filtering (proof 1), and it necessarily takes the
#: active/inactive brightness remap with it, because the remap IS a term in the filter (proof 6).
#: no-blur can keep the remap and cut only the standard deviation; `none` cannot. That is the
#: precise sense in which it is the blunter instrument.
_NO_GLASS_FAILS = (
    "ring ok",
    "the frame is FOUR separately filtered strips",
    "and the glass reads as a SPREAD ramp, which a step cannot fake",
    "focus ok",
    "an inactive window passes MORE backdrop through, not less",
    "and the remap is 0.4*b + 0.6, measured off the computed filter",
    "verdict is ok",
)

#: What A SEVERED CHAIN breaks. The strips still ask for blur(9px) and the geometry is untouched —
#: the ring is still the ring — so what goes is the chain assertion and the pixels. That split is
#: what makes this control about the ANCESTOR and not about the filter.
#: The band is NOT flat under this control — the seam is still there and still shows through the
#: unfiltered translucent strip as a step with a span of 97 luma — so the flatness clause holds and
#: belongs to `--negative flat-desk`.
_SEVER_FAILS = (
    "chain ok",
    "no ancestor of any strip severs the blur chain",
    "and the glass reads as a SPREAD ramp, which a step cannot fake",
    "verdict is ok",
)

#: What REMOVING THE HALO breaks: the legibility clauses and nothing else. The glass still blurs,
#: the ring is still the ring, the chain is intact. A caption over an unknown backdrop is legible by
#: its glow or by nothing.
#: IT MOVES THE WHITE SIDE AND NOT THE BLACK ONE, measured — and that asymmetry is the argument
#: for the halo rather than an accident of this control.
#:
#: The caption's glyphs are white. Over the DARK side of the seam they have real contrast on their
#: own, so removing the glow leaves them legible there (6.0:1 measured, above AA). Over the BRIGHT
#: side they are white-on-white and have none (1.3:1), and the glow is the only thing that was
#: giving them an edge. So this control demonstrates the claim the label makes: no single text
#: colour manages both sides, which is why Windows 7 answers with DrawThemeTextEx and a glow.
#:
#: An earlier draft of this tuple listed the black side too. It held, and the gate said so.
_NO_HALO_FAILS = (
    "legible ok",
    "the caption carries a halo, and its glyphs cross the seam",
    "and over the WHITE side, which no single text colour manages",
    "verdict is ok",
)


# ======================================================================================
# M12 — the blur governor
# ======================================================================================

M12_LABELS = (
    "page isolated",
    "kernel isolated",
    "the kernel raised no error",
    # PROOF 1. The accounting, against the ABI's formula AND against the rendered strips.
    "account ok",
    "the kernel's per-window cost is what the RENDERED strips cover",
    "and the page reported its device-pixel ratio, squared",
    # THE MILESTONE'S FINDING, as an assertion rather than as prose.
    "the SHIPPED budget is out of reach, so this desktop is all glass",
    # PROOF 2. The degrade branch.
    "degrade ok",
    "over the budget, glass comes off",
    "from the BOTTOM of the stack, in stack order",
    "while the window on top keeps its glass",
    "and the total lands back under the budget",
    "and the page rendered exactly the set the kernel decided",
    # PROOF 3. Idempotence, which is what an admission controller owes once its input no longer
    # responds to its own action — see the note on `_STALE_COSTS_FAILS`.
    "hysteresis ok",
    "the two edges exist and are ordered",
    "re-running the governor over an unchanged desktop changes nothing",
    "and closing windows gives the glass back",
    # PROOF 4. The pixels, because `is-flat` and a blur that is gone are different claims.
    "pixels ok",
    "a flat caption and a glass caption both cross a hard seam",
    "a flattened window carries NO backdrop-filter, not a zero-radius one",
    "the BARE backdrop reads as a hard step, so the seam is real",
    "the GLASS caption reads as a spread ramp",
    "while the FLAT caption reads as a step, so the blur really went",
    "verdict is ok",
    "document COOP",
    "document COEP",
    "served m12.html",
)

M12_DOCUMENT = "/www/m12.html"

M12_READY = ("(() => { const M = globalThis.M12 || {}; const s = M.state; "
             "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")

READ_M12 = """(() => {
  const M = globalThis.M12 || {}
  const P = M.proofs || {}
  const one = (x) => (x === null || x === undefined
    ? null : { ok: x.ok === true, evidence: x.evidence || {} })
  return {
    state: String(M.state || ''),
    why: String(M.why || ''),
    phase: String(M.phase || ''),
    verdict: String(M.verdict || ''),
    isolated: M.isolated === true,
    kernelIsolated: M.kernelIsolated === true,
    cfg: M.config || {},
    errors: (M.errors || []).map(String),
    faults: (M.faults || []).map((f) => String(f && f.why)),
    live: [...document.querySelectorAll('.window')].length,
    account: one(P.account),
    degrade: one(P.degrade),
    hysteresis: one(P.hysteresis),
    pixels: one(P.pixels),
  }
})()"""

M12_SHAPE = {
    "state": str, "why": str, "phase": str, "verdict": str,
    "isolated": bool, "kernelIsolated": bool,
    "cfg": dict, "errors": list, "faults": list, "live": int,
    "account": (dict, type(None)),
    "degrade": (dict, type(None)),
    "hysteresis": (dict, type(None)),
    "pixels": (dict, type(None)),
}

#: What A WORLD WITH NO GOVERNOR must break. `PLAN.md` §5's own control for M12 — "disable the
#: governor at the same geometry".
#:
#: Everything that MEASURES still works: the accounting is still reported, the page still renders
#: what it is told, both edges still exist as numbers. What goes is the acting — nothing is ever
#: flattened, so the degrade half goes red and the pixel clauses go with it, because there is no
#: flat caption to sample.
_NO_GOVERNOR_FAILS = (
    "degrade ok",
    "over the budget, glass comes off",
    "from the BOTTOM of the stack, in stack order",
    "and the total lands back under the budget",
    "pixels ok",
    "a flat caption and a glass caption both cross a hard seam",
    "a flattened window carries NO backdrop-filter, not a zero-radius one",
    "while the FLAT caption reads as a step, so the blur really went",
    "verdict is ok",
)

#: What DEGRADING FROM THE TOP breaks: the ORDER, and only the order. Glass still comes off, the
#: total still lands under the budget, the hysteresis still has two edges and a flat caption is
#: still there to sample — so this control is about which window pays, which is the half of
#: constraint 49 that is a judgement rather than an arithmetic.
_TOP_FIRST_FAILS = (
    "degrade ok",
    "from the BOTTOM of the stack, in stack order",
    "while the window on top keeps its glass",
    "verdict is ok",
)

#: What READING THE POST-DEGRADE TOTAL breaks, which is the first version of this governor.
#:
#: Admission against the CURRENT blurred total makes the input respond to the action: flattening
#: lowers it, the next run re-admits everything, and the run after that flattens again. So the
#: degrade counter climbs over a desktop nobody touched, which is what oscillation looks like from
#: outside — and it is the reason the shipped governor sums the ALL-GLASS cost instead.
#:
#: This control replaced a `no-hysteresis` one. That one collapsed the two edges into a single
#: threshold and, under the corrected accounting, **broke nothing at all**: with an
#: action-independent input the band between the edges cannot change which windows are flat. A
#: control that cannot fail is worse than no control, so it was swapped for the defect that is
#: really there.
_STALE_COSTS_FAILS = (
    "hysteresis ok",
    "re-running the governor over an unchanged desktop changes nothing",
    "verdict is ok",
)


# ======================================================================================
# M13 — the geometry harness
#
# THE ONLY PROOF M7-M12 HAVE that the numbers they trade are about the window a reader can touch.
# Every clause is read off a RENDERED rect and every gesture is REAL input, for constraint 40's
# reason: an inert frame and a working one are the same picture, so no screenshot can tell a window
# manager from a drawing of one.
# ======================================================================================

M13_LABELS = (
    "page isolated",
    "kernel isolated",
    "the kernel raised no error",
    "the page was really driven",
    "the controls the page reports are the ones asked for",
    # PROOF 1. The clamp: a window cannot be put out of reach, by any of three real gestures.
    "clamp ok",
    "dragged past the bottom-right corner, the frame stops at the clamp",
    "dragged above the top, the frame stops at y = 0",
    "arrow-keyed off the left edge, the frame stops at MIN_VISIBLE - w",
    "and in every clamped state a grabbable strip of caption is still over the desktop",
    # PROOF 2. The gesture is faithful, and both ends of the keyboard step move.
    "gesture ok",
    "an unclamped drag moves the frame by exactly the pointer delta",
    "a drag after a clamped one starts from where the frame IS",
    "one arrow press is KEY_STEP px and a Shift arrow is one px",
    # PROOF 3. The kernel RECORDS geometry and never decides it.
    "record ok",
    "the kernel's box is the box the clamp settled on, for every live window",
    "the cell grid the kernel holds is what the rendered client area divides into",
    "and the cell was measured off a rendered glyph, not assumed",
    # PROOF 4. The ring and the chrome, which is what makes M12's accounting about the product.
    "ring ok",
    "the four glass strips do not overlap",
    "and their rendered areas sum to the ABI's ring formula",
    "the client area is inset by exactly the chrome the ABI declares",
    "the caption buttons sit inside the caption and clear of the title",
    # PROOF 5. The stack a reader can touch.
    "stack ok",
    "a real click on a buried window's sliver raises it to the top of the kernel's stack",
    "and the window under that same point afterwards is the one that came up",
    "no two live frames share a z-index",
    # PROOF 6. The desktop changing size.
    "relayout ok",
    "a desktop that shrinks pulls every frame back inside it",
    "and the kernel is told the box each frame settled on",
    "a desktop that grows back returns each window to the box it asked for",
    # PROOF 7. The floor.
    "limits ok",
    "a box under the minimum is floored on screen",
    "and the kernel records the floor rather than the request",
    "verdict is ok",
    "document COOP",
    "document COEP",
    "served m13.html",
)

M13_DOCUMENT = "/www/m13.html"

M13_READY = ("(() => { const M = globalThis.M13 || {}; const s = M.state; "
             "return (s === 'done' || s === 'aborted' || s === 'error' || M.want) ? 1 : 0 })()")

#: THE READY EXPRESSION IS SATISFIED BY A PENDING GESTURE as well as by a terminal state, because
#: this page BLOCKS on its first ask: it publishes a drag and waits, so a readiness predicate that
#: only accepted `done` would wait out its own timeout before anything had driven the page. The
#: check then drives every ask and settles on the terminal state itself.
READ_M13 = """(() => {
  const M = globalThis.M13 || {}
  const P = M.proofs || {}
  const one = (x) => (x === null || x === undefined
    ? null : { ok: x.ok === true, evidence: x.evidence || {} })
  return {
    state: String(M.state || ''),
    why: String(M.why || ''),
    phase: String(M.phase || ''),
    verdict: String(M.verdict || ''),
    isolated: M.isolated === true,
    kernelIsolated: M.kernelIsolated === true,
    cfg: M.config || {},
    controls: M.controlsInForce || {},
    gestures: (M.gestureLog || []).length,
    errors: (M.errors || []).map(String),
    faults: (M.faults || []).map((f) => String(f && f.why)),
    live: [...document.querySelectorAll('.window')].length,
    clamp: one(P.clamp),
    gesture: one(P.gesture),
    record: one(P.record),
    ring: one(P.ring),
    stack: one(P.stack),
    relayout: one(P.relayout),
    limits: one(P.limits),
  }
})()"""

M13_SHAPE = {
    "state": str, "why": str, "phase": str, "verdict": str,
    "isolated": bool, "kernelIsolated": bool,
    "cfg": dict, "controls": dict, "gestures": int,
    "errors": list, "faults": list, "live": int,
    "clamp": (dict, type(None)),
    "gesture": (dict, type(None)),
    "record": (dict, type(None)),
    "ring": (dict, type(None)),
    "stack": (dict, type(None)),
    "relayout": (dict, type(None)),
    "limits": (dict, type(None)),
}

#: What A WORLD WITH NO CLAMP must break. `Win.apply` writes the requested box straight onto the
#: element, so nothing holds a window inside the desktop.
#:
#: The three clamped states stop being clamped, the caption-still-grabbable clause goes with them,
#: the shrink no longer pulls anything back inside, and the minimum size goes too — `clampBox` is
#: where the MIN_W/MIN_H floor lives, which is a thing this control makes visible rather than a
#: coincidence.
#:
#: WHAT MUST HOLD, and it is most of the check: every drag still moves the frame by the pointer's
#: delta, the kernel is still told what the page did, the ring is still the ring, the stack is still
#: reachable, and a desktop that grows back still holds each window where it was asked to be.
_NO_CLAMP_FAILS = (
    "clamp ok",
    "dragged past the bottom-right corner, the frame stops at the clamp",
    "dragged above the top, the frame stops at y = 0",
    "arrow-keyed off the left edge, the frame stops at MIN_VISIBLE - w",
    "and in every clamped state a grabbable strip of caption is still over the desktop",
    "relayout ok",
    "a desktop that shrinks pulls every frame back inside it",
    "limits ok",
    "a box under the minimum is floored on screen",
    "and the kernel records the floor rather than the request",
    "verdict is ok",
)

#: What TELLING THE KERNEL THE BOX THAT WAS ASKED FOR breaks. The frames are laid out exactly as
#: before — this control changes one post — and what goes is the kernel's record: `/proc`, the blur
#: governor's area and a terminal's cell count are all arithmetic over a number the page supplied,
#: so a page that supplies the wrong one is simply believed.
#:
#: The cell clauses HOLD, which is the detail worth reading: cols and rows are computed from the
#: rendered client rect, not from the box, so they stay true while the box beside them is a fiction.
_STALE_GEOM_FAILS = (
    "record ok",
    "the kernel's box is the box the clamp settled on, for every live window",
    "relayout ok",
    "and the kernel is told the box each frame settled on",
    "limits ok",
    "and the kernel records the floor rather than the request",
    "verdict is ok",
)

#: What A DESKTOP THAT RE-CLAMPS NOTHING breaks, which is the world this file was in until M13.
#: Every gesture still clamps, so the first five proofs hold entirely; what fails is the resize,
#: and the window that was left hanging outside the desktop with its caption out of reach.
#:
#: AND THE GROW-BACK CLAUSE GOES TOO, which is worth stating because the POSITIONS would pass it:
#: a window that was never pulled in was never moved, so it is still where it was asked to be. The
#: clause asserts the re-clamp RAN as well as that the box came back, so it fails on the mechanism
#: rather than on a coincidence — the same reason M12's idempotence clause asserts the governor was
#: really re-entered.
_NO_RELAYOUT_FAILS = (
    "relayout ok",
    "a desktop that shrinks pulls every frame back inside it",
    "and the kernel is told the box each frame settled on",
    "a desktop that grows back returns each window to the box it asked for",
    "verdict is ok",
)


M4A_LABELS = (
    "cell reported",
    "page isolated",
    "kernel isolated",
    "the kernel raised no error",
    # THE HEADLINE. MILESTONES.md M4a: "Type into the window; assert the pty echoed it."
    "echo ok",
    "the shell painted a prompt on the terminal",
    "the keys were real browser keystrokes",
    "the window delivered the keystroke to the kernel",
    "and the pty echoed the typed line back onto the screen",
    "and the shell ran it",
    "the shell survived Ctrl-C and prompted again",
    "Ctrl-D ended the session and the relay exited cleanly",
    # REVIEW-FINDINGS finding 1's corrected scenario: idle, nothing flowing, two sources.
    "parked ok",
    "the relay was parked in poll, holding both a window fd and a pty master",
    # The frame. Constraint 40: an inert window and a working one are the same picture.
    "geometry ok",
    "arrow keys on the title bar move the window",
    "a pointer drag moves the window",
    "and the clamp keeps the title bar reachable at both extremes",
    # THE NOT-RESPONDING DETECTOR'S FOUR LABELS MOVED TO `m7`, with the proof. Its fixture here
    # was a window with NO PROCESS READING IT, which M7 makes unreachable: a window is created by
    # the process that will read it. `scripts/check_floors.json` carries the floor this lowered,
    # and `check_m7` carries six labels where this had four.
    "verdict is ok",
    "document COOP",
    "document COEP",
    "served m4a.html",
)

M4A_DOCUMENT = "/www/m4a.html"

#: TWO TERMINAL STATES, AND `await-keys` IS ONE OF THEM.
#:
#: The page sets up the session, announces that it is waiting to be typed at, and stops. The check
#: then focuses the terminal and presses REAL keys through `Input.dispatchKeyEvent`, which is the
#: only way the widget receives an `isTrusted` event — `CLAUDE.md`: "Drive real input, read the
#: geometry back." A page that typed for itself would be asserting on its own `dispatchEvent`, and
#: `src/wm/terminal.mjs` counts the two separately so the difference cannot be hidden.
M4A_READY = ("(() => { const M = globalThis.M4A || {}; const s = M.state; "
             "if (s === 'done' || s === 'aborted' || s === 'error') return s; "
             "return M.phase === 'await-keys' ? 'await-keys' : '' })()")

M4A_DONE = ("(() => { const s = globalThis.M4A && globalThis.M4A.state; "
            "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")

READ_M4A = """(() => {
  const M = globalThis.M4A || {}
  const P = M.proofs || {}
  const one = (x) => (x === null || x === undefined
    ? null : { ok: x.ok === true, evidence: x.evidence || {} })
  return {
    state: String(M.state || ''),
    why: String(M.why || ''),
    phase: String(M.phase || ''),
    verdict: String(M.verdict || ''),
    isolated: M.isolated === true,
    kernelIsolated: M.kernelIsolated === true,
    cfg: M.config || {},
    errors: (M.errors || []).map(String),
    faults: (M.faults || []).map((f) => String(f && f.why)),
    echo: one(P.echo),
    parked: one(P.parked),
    geometry: one(P.geometry),
  }
})()"""

M4A_SHAPE = {
    "state": str, "why": str, "phase": str, "verdict": str,
    "isolated": bool, "kernelIsolated": bool,
    "cfg": dict, "errors": list, "faults": list,
    "echo": (dict, type(None)),
    "parked": (dict, type(None)),
    "geometry": (dict, type(None)),
}

#: What a DETACHED PTY must break, and only this.
#:
#: Measured under the control on Chrome 157.0.8103.52: exactly these six red, the other twenty
#: intact. The window still delivers the keystroke (the device's own byte counter moves), the relay
#: is still parked in `poll` over both sources, the frame still moves and clamps, and the detector
#: still greys and clears. Only the characters stop arriving.
#:
#: THAT IS THE DEFECT NOTHING ELSE IN THE SUITE CAN CATCH: a terminal widget that echoed its own
#: keystrokes locally would satisfy "the pty echoed the typed line" with no pty behind it at all.
#: With the master's input side discarding, a locally-echoing widget still paints the character and
#: this control goes GREEN — which is why it is scored on labels and why `src/wm/terminal.mjs`
#: carries the no-local-echo notice at the top of the file.
_PTY_DETACH_FAILS = (
    "echo ok",
    "and the pty echoed the typed line back onto the screen",
    "and the shell ran it",
    # The discipline is what turns 0x03 into SIGINT, so a detached master raises no signal and the
    # shell never prints a second prompt. A consequence of the one removal, not collateral.
    "the shell survived Ctrl-C and prompted again",
    # And Ctrl-D never reaches VEOF, so the session does not end and the relay runs to its ceiling.
    "Ctrl-D ended the session and the relay exited cleanly",
    "verdict is ok",
)


# ======================================================================================
# M6 - neuter the process realm
# ======================================================================================

#: Clause-level, and split along the SEAM THE TWO HALVES SIT ON: the realm strip removes bindings
#: (`src/libos/lockdown.mjs`) and the policy bounds the module loader (`scripts/serve.py`). The
#: two controls below move disjoint subsets of this inventory, which is the measured claim that
#: neither half is doing the other's work.
#:
#: EACH REALM CLAUSE ASSERTS THE BINDING'S ABSENCE AND THE CALL'S FAILURE, both. A clause that
#: only asserted the call would hold under `no-lockdown`, because the policy refuses `fetch` at
#: the network while the process still HOLDS the binding - and constraint 41 is about what a
#: process can reach, not only about what the renderer will send.
#: What A WORLD WITH NO MOUNTPOINTS must break: exactly the report that names them, and nothing
#: else. Every program still RESOLVES — the mount table never needed the directory — so m5's whole
#: pipeline is a different subject and must hold.
_NO_MOUNTPOINTS_FAILS = (
    "every mountpoint exists as a directory on the volume beneath it",
)

M6_LABELS = (
    "cell reported",
    "page isolated",
    "kernel isolated",
    "the kernel raised no error",
    # The policy, on the wire, read back by the page from the response that creates the realm.
    "policy ok",
    "the process realm's script carries a policy",
    "and the policy names script-src without 'unsafe-eval'",
    # The realm. Constraint 41's list, as calls and as bindings.
    "realm ok",
    "a uid-1000 process is refused the file by the syscall channel",
    "and its own syscalls still work",
    "the lockdown reports every target stripped and none surviving",
    "ambient OPFS is gone",
    "the network is gone",
    "the durable stores are gone",
    "a process cannot construct a worker",
    "a process cannot mint a blob URL",
    # THE HEADLINE. MILESTONES.md M6: the kernel's own volume, by inode, with no credential.
    "volume ok",
    "the tamper by inode was refused",
    "and the kernel's own bytes are unchanged",
    # The loader. Constraint 139's open half.
    "loader ok",
    "a computed data: import is refused",
    "and the realm's own violation event names script-src",
    "eval and new Function are refused",
    "while the one same-origin specifier still loads",
    # MILESTONES.md M6's own proof, in its words.
    "fault ok",
    "the bypass program faulted",
    "and /proc shows it killed by SIGABRT",
    "verdict is ok",
    "document COOP",
    "document COEP",
    "served m6.html",
)

M6_DOCUMENT = "/www/m6.html"

M6_READY = ("(() => { const s = globalThis.M6 && globalThis.M6.state; "
            "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")

READ_M6 = """(() => {
  const M = globalThis.M6 || {}
  const P = M.proofs || {}
  const one = (x) => (x === null || x === undefined
    ? null : { ok: x.ok === true, evidence: x.evidence || {} })
  return {
    state: String(M.state || ''),
    why: String(M.why || ''),
    verdict: String(M.verdict || ''),
    isolated: M.isolated === true,
    kernelIsolated: M.kernelIsolated === true,
    cfg: M.kernelCfg || {},
    errors: (M.errors || []).map(String),
    faults: (M.faults || []).map((f) => String(f && f.why).slice(0, 200)),
    realm: one(P.realm),
    volume: one(P.volume),
    loader: one(P.loader),
    fault: one(P.fault),
    policy: one(P.policy),
  }
})()"""

M6_SHAPE = {
    "state": str, "why": str, "verdict": str,
    "isolated": bool, "kernelIsolated": bool,
    "cfg": dict, "errors": list, "faults": list,
    "realm": (dict, type(None)),
    "volume": (dict, type(None)),
    "loader": (dict, type(None)),
    "fault": (dict, type(None)),
    "policy": (dict, type(None)),
}

#: What SKIPPING THE REALM STRIP must break, and only this. MILESTONES.md M6's own control:
#: "Skip the stripping; the same program must succeed. If it does not, the check is testing
#: nothing."
#:
#: Measured under the control on Chrome 157.0.8103.52: `tamper REACHED 2.1:
#: "KERNEL-OWNED-SECRET" -> "TAMPERED-BY-PROCESS"`, and the kernel then read the tampered bytes
#: back through its own syscall channel.
#:
#: THE LOADER CLAUSES ARE IN THE HELD SET, and that is this control's specificity: the policy is
#: still served, so a computed `data:` import and `eval` are still refused. A control that moved
#: those too could not distinguish the realm strip from the policy - and measuring where the
#: policy has to be delivered (constraint 187) is what showed they are different mechanisms.
_NO_LOCKDOWN_FAILS = (
    "realm ok",
    "the lockdown reports every target stripped and none surviving",
    "ambient OPFS is gone",
    "the network is gone",
    "the durable stores are gone",
    "a process cannot construct a worker",
    "a process cannot mint a blob URL",
    "volume ok",
    "the tamper by inode was refused",
    "and the kernel's own bytes are unchanged",
    # `p_fault` is MILESTONES.md's "same program": with the realm intact it RETURNS the volume's
    # root listing instead of dying, so both clauses move together.
    "fault ok",
    "the bypass program faulted",
    "and /proc shows it killed by SIGABRT",
    "verdict is ok",
)

#: What WITHHOLDING THE POLICY must break, and only this. The mirror of the control above.
#:
#: Measured under the control on Chrome 157.0.8103.52: `importData REACHED data: evaluated in a
#: process`, `eval REACHED 2`, `newFunction REACHED 4` - and every realm clause HELD, with the
#: volume intact and the bypass program still faulting.
#:
#: "the policy names script-src without 'unsafe-eval'" IS IN THE FAILED SET AND HAD TO BE WRITTEN
#: THAT WAY: a clause reading "the header does not contain 'unsafe-eval'" is satisfied by a
#: response carrying NO POLICY AT ALL, so it would have passed under this control while `eval`
#: worked. The clause asserts that `script-src` is present AND lacks the keyword.
_NO_CSP_FAILS = (
    "policy ok",
    "the process realm's script carries a policy",
    "and the policy names script-src without 'unsafe-eval'",
    "loader ok",
    "a computed data: import is refused",
    "and the realm's own violation event names script-src",
    "eval and new Function are refused",
    "verdict is ok",
)


#: A pty with no ISIG recognises no signal characters. Both Ctrl-C clauses go, and so does the
#: "a fresh pty is signal-generating" clause — the control changes the DEFAULT termios, and that
#: section asserts the default. Declared rather than excused: it is a consequence of the control's
#: own mechanism, not collateral from something unrelated.
_NO_ISIG_FAILS = (
    "intr ok",
    "Ctrl-C killed the foreground group with SIGINT",
    # The ^C is DATA with ISIG off, so it is echoed like any other byte — measured as
    # `echo: '\x03'`. The harness refused the control until this was declared, which is the
    # point of scoring on labels rather than on pass/fail.
    "and the Ctrl-C byte was consumed, not echoed",
    "wedged_intr ok",
    "Ctrl-C reached a process spinning in a compute loop",
    "termios ok",
    "a fresh pty is canonical, echoing and signal-generating",
    "verdict is ok",
)

#: A parked poll that is never re-evaluated can only time out. ONE section, which is what makes
#: this control specific: `poll` reporting readiness synchronously is untouched.
_NO_POLL_WAKE_FAILS = (
    "poll_wait ok",
    "a process parked in poll over two fds was woken by one",
    "verdict is ok",
)

_NO_FINISH_GUARD_FAILS = (
    "self_signal ok",
    # The caller's own call is answered TWICE. The first reply is the signal's -EINTR and the
    # second is the handler's 0, so the resize now looks like it SUCCEEDED from the caller's side
    # — the interruption it must observe is overwritten by the reply that should not exist.
    "and the caller observes its own interruption",
    "exactly one call was answered by its own side effect",
    "verdict is ok",
)

#: WHAT MUST HOLD under no-winch is the resize itself. `setWinsize` resizes and only then signals,
#: so removing the signal must leave `a resize that signals the caller still resizes` passing —
#: a control that moved both would not say which of the two it removed.
_NO_WINCH_FAILS = (
    "winsize ok",
    "a resize raises SIGWINCH on the foreground group",
    "self_signal ok",
    # No signal reaches the caller, so there is no interruption to observe and nothing for the
    # guard to drop. Both are consequences of the one removal rather than collateral.
    "and the caller observes its own interruption",
    "exactly one call was answered by its own side effect",
    "verdict is ok",
)

CONTROLS: Dict[str, NegativeControl] = {
    "no-isolation": NegativeControl(
        name="no-isolation",
        why="serve(isolate=False): no COOP/COEP, so no SharedArrayBuffer",
        serve_kwargs={"isolate": False},
        fixture=None,
        expects={"syscall": Expect(
            UNMEASURABLE,
            why="SharedArrayBuffer is not constructible outside a cross-origin isolated "
                "context, and the syscall channel IS a SharedArrayBuffer (docs/CONSTRAINTS.md "
                "constraints 1 and 31). There is no slower kernel to measure here and no "
                "degraded figure to report: www/m0.html:120-126 aborts before it boots one, so "
                "the measurement does not happen. BROKEN is the capability going away, which is "
                "why this is declared and not a FAIL - a FAIL would claim a number was taken "
                "and found wanting",
        ), "m1": Expect(
            UNMEASURABLE,
            why="same mechanism as syscall: the kernel's SAB is not constructible without "
                "COOP/COEP, so www/m1.html aborts before any proof runs. UNMEASURABLE rather "
                "than FAIL for the same reason - a FAIL would claim four verdicts were taken.",
        ), "m2": Expect(
            UNMEASURABLE,
            why="same mechanism as syscall and m1: the kernel's SAB is not constructible without "
                "COOP/COEP, so no filesystem is mounted and www/m2.html aborts before any proof "
                "runs. Measured: state 'aborted' in 0.0 s. UNMEASURABLE rather than FAIL, because "
                "a FAIL would claim three proofs were taken and found wanting.",
        ), "m4b": Expect(
            UNMEASURABLE,
            why="the same mechanism once more: without COOP/COEP there is no SAB, so no kernel "
                "boots and there is no process to give a terminal to. UNMEASURABLE rather than "
                "FAIL, because a FAIL would claim a line discipline ran and behaved wrongly.",
        ), "m5": Expect(
            UNMEASURABLE,
            why="the same mechanism once more: without COOP/COEP there is no SAB, so no kernel "
                "boots, no process exists and there is nothing to load a shell into. UNMEASURABLE "
                "rather than FAIL, because a FAIL would claim a pipeline of three processes was "
                "built and found wrong.",
        ), "m6": Expect(
            UNMEASURABLE,
            why="the same mechanism once more: without COOP/COEP there is no SAB, so no kernel "
                "boots and there is no process realm to strip. UNMEASURABLE rather than FAIL, "
                "because a FAIL would claim a program had tried to write the kernel's volume and "
                "been stopped — and nothing ran at all. Note that the POLICY is still on the wire "
                "in this phase (it is a header on src/libos/, independent of COOP/COEP) and still "
                "proves nothing here: a policy over a realm no process ever entered bounds "
                "nothing.",
        ), "m10": Expect(
            UNMEASURABLE,
            why="the same mechanism as every kernel check: without COOP/COEP there is no SAB, so "
                "no kernel boots, no process runs, no window is created and there is no clipboard "
                "to put anything on. UNMEASURABLE rather than FAIL, because a FAIL would claim "
                "bytes were offered under a format and arrived wrong - and nothing was offered at "
                "all.",
        ), "m9": Expect(
            UNMEASURABLE,
            why="the same mechanism as every kernel check: without COOP/COEP there is no SAB, so "
                "no kernel boots, no process runs and no window is created — and a modality over "
                "no windows is nothing. UNMEASURABLE rather than FAIL, because a FAIL would claim "
                "a raise was refused when nothing was ever raised.",
        ), "m12": Expect(
            UNMEASURABLE,
            why="the same mechanism: without COOP/COEP there is no SAB, so no kernel boots, no "
                "process runs and no window is framed — so there is no blurred area to account "
                "and nothing to govern. The GLASS could still be drawn, which is why the page "
                "refuses before it installs the skin. UNMEASURABLE rather than FAIL, because a "
                "FAIL would claim a desktop was accounted and degraded wrongly.",
        ), "m13": Expect(
            UNMEASURABLE,
            why="the same mechanism: without COOP/COEP there is no SAB, so no kernel boots, no "
                "process runs and no window is framed — and a geometry harness with no frames in "
                "it measures nothing. The page refuses before it builds a host, so it never asks "
                "for a gesture either, which is what keeps the driver from waiting out its own "
                "timeout. UNMEASURABLE rather than FAIL, because a FAIL would claim a window was "
                "dragged and landed in the wrong place.",
        ), "m11": Expect(
            UNMEASURABLE,
            why="the same mechanism, and the sharpest case of it: without COOP/COEP there is no "
                "SAB, so no kernel boots, no process runs and no window is framed. The GLASS "
                "could still be drawn — it is plain CSS, and a page with no kernel at all would "
                "render a convincing Aero frame over a seam and satisfy every pixel clause here. "
                "That is exactly why www/m11.html refuses before it installs the skin. "
                "UNMEASURABLE rather than FAIL, because a FAIL would claim a window was framed by "
                "a process and found unblurred.",
        ), "m8": Expect(
            UNMEASURABLE,
            why="the same mechanism as every kernel check: without COOP/COEP there is no SAB, so "
                "no kernel boots, no process runs, no window is created and no surface is "
                "allocated. A canvas could still be DRAWN by the page, which is exactly why the "
                "page refuses before it makes one: pixels with no process behind them are the "
                "picture constraint 40 says cannot be told from a working surface. UNMEASURABLE "
                "rather than FAIL, because a FAIL would claim a process drew and was not seen.",
        ), "m7": Expect(
            UNMEASURABLE,
            why="the same mechanism, one milestone on: without COOP/COEP there is no SAB, so no "
                "kernel boots and no process runs - and a window is created BY A PROCESS now, so "
                "there is nothing to create one. The frames could still be DRAWN, which is "
                "exactly why the page refuses before it builds any: a frame with nothing behind "
                "it is the picture constraint 40 says cannot be told from a working window. "
                "UNMEASURABLE rather than FAIL, because a FAIL would claim a process waited on "
                "three fds and was woken by one.",
        ), "m4a": Expect(
            UNMEASURABLE,
            why="the same mechanism once more: without COOP/COEP there is no SAB, so no kernel "
                "boots, no console is attached and there is no process to hold a pty. The window "
                "could still be DRAWN — it is plain DOM — which is exactly why the page refuses "
                "before it builds one: a frame with nothing behind it is the picture constraint "
                "40 says cannot be distinguished from a working terminal. UNMEASURABLE rather "
                "than FAIL, because a FAIL would claim a keystroke was typed and not echoed.",
        ), "m4": Expect(
            UNMEASURABLE,
            why="the same mechanism again: without COOP/COEP there is no SAB, so no kernel boots, "
                "no process exists and nothing can be piped between two of them. UNMEASURABLE "
                "rather than FAIL, because a FAIL would claim a pipeline was built and behaved "
                "wrongly.",
        ), "m3": Expect(
            UNMEASURABLE,
            why="the same mechanism once more: without COOP/COEP there is no SAB, so the kernel "
                "never boots, there is no mount table to read and www/m3.html aborts before a "
                "process exists. UNMEASURABLE rather than FAIL, because a FAIL would claim /proc "
                "was enumerated and found wrong.",
        ), "boot": Expect(
            Outcome.FAIL,
            failed=_NO_ISOLATION_FAILS,
            # Everything else, derived from check_boot's inventory rather than listed: the ten
            # cell-coherence expectations, the six rows isolation does not touch, the row-name
            # set, the colour injectivity and the served-bytes witness. Measured under the
            # control on Chrome 157: exactly these 11 red, the other 19 intact.
            held=held_rest(BOOT_LABELS, _NO_ISOLATION_FAILS),
        )},
    ),
    "empty-root": NegativeControl(
        name="empty-root",
        why="serve(root=<fresh empty tmpdir>): the repo's own documented control, "
            "docs/designs/minimal-kernel.md:505",
        serve_kwargs={},
        fixture=_empty_root,
        # Which gate, not just "some ServeError": a missing --root, an unwritable tmpdir, a
        # connection reset, a 404 or the COOP/COEP wire assertion would otherwise satisfy this
        # control without the empty-root gate ever firing. Gate.NO_DOCUMENT is now that one
        # condition and nothing else.
        expects={"boot": Expect(gate_reason(Gate.NO_DOCUMENT),
                                why="the root has no index.html")},
    ),
    "patched-required": NegativeControl(
        name="patched-required",
        why="a copy of www/ whose OPFS probe is forced false",
        serve_kwargs={},
        fixture=lambda source: _patch_probe(source, _OPFS_PROBE),
        # The REASON, not the outcome enum: the patched row must read MISSING and the page's own
        # verdict must flip with it. A regression that downgraded OPFS to cosmetic leaves the row
        # failing (the harness's PREFLIGHT_ROWS still calls it required) while all three verdict
        # expectations hold - the page boots without a filesystem and the control is satisfied.
        # `held` carries the other half: the row must be PAINTED as missing, in a colour that
        # differs from a present row's, which is what a human actually reads.
        expects={"boot": Expect(
            Outcome.FAIL,
            why="a required capability's absence must turn the page's verdict to 'fail'",
            failed=_PATCHED_REQUIRED_FAILS,
            # The other 26, derived. "OPFS cell" is the one the comment above is about and it is
            # in here: the row must be PAINTED as missing, in a colour that differs from a
            # present row's. Measured under the control: exactly these 4 red.
            held=held_rest(BOOT_LABELS, _PATCHED_REQUIRED_FAILS),
        )},
    ),
    "patched-optional": NegativeControl(
        name="patched-optional",
        why="a copy of www/ whose backdrop-filter probe is forced false - an optional row, so "
            "the check must still pass",
        serve_kwargs={},
        fixture=lambda source: _patch_probe(source, _BACKDROP_PROBE),
        expects={"boot": Expect(
            Outcome.PASS,
            why="a cosmetic capability's absence must not block the boot",
            # All 30: a control that must leave the check passing is a control under which every
            # label holds, so there is nothing to choose between here.
            held=BOOT_LABELS,
        )},
    ),
    "no-sigpend": NegativeControl(
        name="no-sigpend",
        why="noSigpend=1: the dispatcher's SIGPEND check at syscall entry is removed, so a "
            "signal raised while the process is between syscalls cannot land. The one "
            "www/m1.html proof the control is NAMED FOR is proof (e): the intr program's next "
            "clock_nanosleep returns -EINTR and the program exits(99); without the check, it "
            "sleeps forever and the harness times out. Everything else - the four headline "
            "proofs - is deliberately not affected, because the SIGKILL path reaps through "
            "terminate() regardless, the cap refusal is pure allocator arithmetic, and the "
            "kernel-dead liveness runs through the heartbeat.",
        serve_kwargs={},
        fixture=None,
        query=(("no_sigpend", "1"),),
        expects={"m1": Expect(
            Outcome.FAIL,
            why="without the SIGPEND check, proof (e) cannot fire -EINTR. The verdict row goes "
                "red because the aggregate is 'every proof ok', so naming only proof_e would let "
                "a check that quietly deleted the verdict pass. Both labels are the control's "
                "subject; nothing else is.",
            failed=_NO_SIGPEND_FAILS,
            # Everything else, derived from the inventory. An added expectation enters `held` on
            # the first run rather than being silently unscored.
            held=held_rest(M1_LABELS, _NO_SIGPEND_FAILS),
        )},
    ),
    "no-cow-order": NegativeControl(
        name="no-cow-order",
        why="no_cow_order=1: the commit's data-before-metadata ordering is dropped. The journal "
            "record and its flush land and the staged bytes are discarded, which is the state a "
            "crash between those two steps leaves — intact metadata pointing at data that was "
            "never written. src/kernel/kernel.mjs refuses the hook without a bench boot.\n"
            "It discards the bytes rather than only skipping flush() BECAUSE SKIPPING THE FLUSH "
            "ALONE CHANGED NOTHING OBSERVABLE: an unflushed FileSystemSyncAccessHandle write is "
            "still visible to a later read in the same agent (flush() buys durability past a "
            "process death, not visibility), and with blobFlushes at 0 fsck still came back "
            "clean. The only way to observe the ordering BY ITS EFFECTS from inside one session "
            "is to reproduce the post-crash state.\n"
            "THE ORDER ITSELF IS OBSERVED SEPARATELY, and that conclusion used to be drawn too "
            "wide: the storage edge records the sequence of operations it performed, so the "
            "`order` clause reads the blob flush's sequence number against the journal append's "
            "for one commit. Under this control there is no blob flush at all, which is why that "
            "clause is in the red list beside the data clauses.\n"
            "a_n is dropped to 400 for this phase: the control is about the ordering, not about "
            "scale, and the 10,000-file figure is the headline run's job.",
        serve_kwargs={},
        fixture=None,
        query=(("no_cow_order", "1"), ("a_n", str(M2_CONTROL_FILES))),
        expects={"m2": Expect(
            Outcome.FAIL,
            why="fsck must report the corruption, and the METADATA clauses must all hold: the "
                "files are there, the modes are right, the mount is read-write and fsck still "
                "wrote nothing. Only the data is gone, which is the failure copy-on-write exists "
                "to prevent",
            failed=_NO_COW_ORDER_FAILS,
            held=held_rest(M2_LABELS, _NO_COW_ORDER_FAILS),
        )},
    ),
    "no-crc": NegativeControl(
        name="no-crc",
        why="no_crc=1: the journal's and the snapshot image's CRC checks are removed, so a torn "
            "tail is ACCEPTED. The torn-journal proof must START PASSING a bad image — if it "
            "passed either way it was testing nothing. Measured at a_n=400: the zero-padded tail "
            "and the flipped mode digit both come back stopped=null accepted=true, the flipped "
            "record is APPLIED, the volume mounts read-write with no problems reported, and "
            "/d/0/modes/m9 reads 0o656 instead of the 0o600 it was created with.\n"
            "THE TRUNCATED TEAR HOLDS, and that is what makes this control specific: a plain "
            "truncation is caught by the record's LENGTH check and never reaches the checksum, so "
            "a control that moved all three tears would not say which guard it removed.",
        serve_kwargs={},
        fixture=None,
        query=(("no_crc", "1"), ("a_n", str(M2_CONTROL_FILES))),
        expects={"m2": Expect(
            Outcome.FAIL,
            why="without the CRC, two of the three tears are accepted and one of them silently "
                "changes a permission on a user's file. The truncated tear and everything about "
                "proofs (a) and (c) must be untouched",
            failed=_NO_CRC_FAILS,
            held=held_rest(M2_LABELS, _NO_CRC_FAILS),
        )},
    ),
    "proc-cache": NegativeControl(
        name="proc-cache",
        why="proc_cache=1: `/proc`'s pid listing is taken ONCE and served from a cache instead of "
            "regenerated per read (src/kernel/procfs.mjs, the cfg.procCache hook, which the "
            "kernel refuses without a bench boot). A killed pid must then LINGER in `ls /proc`, "
            "which is the one thing proof 1 is about.\n"
            "IT CACHES THE LISTING AND NOT THE PER-PID LOOKUP, deliberately. `ls /proc` reads the "
            "listing, so a cache there is the realistic mistake; leaving `stat` live means the "
            "`stat refuses with ENOENT` and `open refuses with ENOENT` labels HOLD, and that "
            "separation is what says which of the two routes the proof was testing. Measured on "
            "the host test first (bench/m3-synth/probe.mjs): the same cache moves exactly `a "
            "reaped pid is gone from the listing` and `the survivors are still there`.\n"
            "The vanish poll is bounded at 40 x 150 ms rather than spinning, because a tight "
            "15 s spin under this control issued enough syscalls to lap even the 16 MiB trace "
            "ring and ALSO failed trace_dropped — and a control that breaks a proof it is not "
            "about verifies nothing.",
        serve_kwargs={},
        fixture=None,
        query=(("proc_cache", "1"),),
        expects={"m3": Expect(
            Outcome.FAIL,
            why="the killed pid must still be in the listing, while every other section holds — "
                "including the two per-pid refusals, which this control does not touch",
            failed=_PROC_CACHE_FAILS,
            held=held_rest(M3_LABELS, _PROC_CACHE_FAILS),
        )},
    ),
    "usr-404": NegativeControl(
        name="usr-404",
        why="usr_404=1: `/usr`'s manifest is pointed at `src/does-not-exist.mjs`, a GENUINE "
            "404 from the harness's own server. The mount must FAIL and record why; an empty "
            "`/usr` that mounted successfully is what MILESTONES.md M3 forbids in as many words — "
            "'the mount must fail loudly, never silently serve an empty /usr'.\n"
            "A REAL 404 AND NOT AN UNKNOWN PROVIDER ID: pointing at a provider that does not "
            "exist would exercise the id lookup, which is a different refusal (ENODEV from "
            "urlFor) and not the one this control is about.\n"
            "The refusal leaves no `/usr` row in the mount table at all, so a path under it falls "
            "through to the root volume and answers ENOENT — the truth — rather than resolving "
            "into an empty directory that reads like a working but bare volume. The reason "
            "reaches the page on the note channel and is asserted there.",
        serve_kwargs={},
        fixture=None,
        query=(("usr_404", "1"),),
        expects={"m3": Expect(
            Outcome.FAIL,
            why="/usr must be absent from the table with a recorded reason, and the capability "
                "probe itself must still PASS: the probe is about the provider's Range support, "
                "which a missing object does not remove",
            failed=_USR_404_FAILS,
            held=held_rest(M3_LABELS, _USR_404_FAILS),
        )},
    ),
    "trace-tiny": NegativeControl(
        name="trace-tiny",
        why="trace_bytes=65536: the trace ring is built at 64 KiB — 2,048 records — instead of "
            "the 16 MiB floor trace.mjs enforces, through the cfg.traceBytes hook with "
            "`enforce: false`, which is the only caller permitted below the floor. The proof then "
            "issues 4,000 syscalls, so the ring is lapped and the dropped-record counter must go "
            "NON-ZERO.\n"
            "AND IT MUST STILL BE DISPLAYED, which is why `trace_dropped the counter is "
            "displayed` is in this control's HELD list rather than its failed one. That split is "
            "the whole control: MILESTONES.md M3 requires the counter to go non-zero *and* be "
            "visible, and a ring that silently dropped records would show a clean picture of a "
            "broken system. The counter is read out of `/dev/trace`'s own header by a process, so "
            "a reader cannot obtain the records without also obtaining the count of the ones it "
            "is missing.",
        serve_kwargs={},
        fixture=None,
        query=(("trace_bytes", "65536"),),
        expects={"m3": Expect(
            Outcome.FAIL,
            why="dropped must be non-zero and the ring must report itself undersized, while the "
                "counter stays visible and the known-sequence proof still holds — the sequence is "
                "read from the newest records, which a lapped ring still has",
            failed=_TRACE_TINY_FAILS,
            held=held_rest(M3_LABELS, _TRACE_TINY_FAILS),
        )},
    ),
    "no-sigpipe-signal": NegativeControl(
        name="no-sigpipe-signal",
        why="no_sigpipe=1: SIGPIPE stops being fatal under SIG_DFL. The kernel keeps its "
            "fatal-default dispositions in a SET built at boot (src/kernel/kernel.mjs "
            "FATAL_DEFAULT), so the control DELETES a row rather than adding a branch — the "
            "headline path carries one Set lookup either way.\n"
            "WHAT MUST BREAK: `yes | head -1` must hang. head reads once and exits, the pipe "
            "loses its reader, and the writer's next write gets -EPIPE with a signal nothing acts "
            "on — `drainSignals` discards the bit at the next syscall entry — so it writes forever. "
            "The program caps that loop and reports `hitCap` instead of hanging, because a real "
            "hang gives the harness a timeout and no information about which loop stopped.\n"
            "BOTH SIGPIPE PROOFS MOVE and nothing else does, which is what makes this control "
            "specific: `yes | head -1` and the blocked writer whose reader died are the two "
            "clauses that turn on the disposition, while the pipe's bytes, the SIGINT sweep over a "
            "process group, and the reader's EOF are untouched. EOF is the OTHER half of "
            "docs/ABI.md decision 5 and has nothing to do with SIGPIPE — a control that moved it "
            "too would mean the two directions were sharing an implementation.",
        serve_kwargs={},
        fixture=None,
        query=(("no_sigpipe", "1"),),
        expects={"m4": Expect(
            Outcome.FAIL,
            why="the writer must survive its own failed writes, while the reader's EOF and the "
                "process-group signal still hold",
            failed=_NO_SIGPIPE_FAILS,
            held=held_rest(M4_LABELS, _NO_SIGPIPE_FAILS),
        )},
    ),
    "spawn-self": NegativeControl(
        name="spawn-self",
        why="spawn_self=1: `SYS_spawn` creates nothing and answers the CALLER'S OWN pid, through "
            "the cfg.spawnSelf hook the kernel refuses without a bench boot. MILESTONES.md M5's "
            "own control, in its words: 'make `spawn` return the parent's pid; `ps` must show one "
            "process and the check must fail.'\n"
            "IT SUBVERTS ONLY A CALLER THAT HAS A PARENT, and that narrowing is what makes it a "
            "control rather than a kernel with spawn removed. The page's orchestrator has no "
            "parent and still starts the shell; the shell has one, so none of its stages exist. "
            "Without the test every section went red together - measured, 7 of 8 - and a control "
            "satisfied by any failure verifies nothing about pipelines.\n"
            "IT IS PLACED AFTER THE PROGRAM LOADER, so every refusal still refuses: a program "
            "that is not there is still 127 and a file with no execute bit is still 126. Only the "
            "successful creation is subverted, which is why `exec`'s four refusal rows are in the "
            "HELD set while its two rows that need a child are not.\n"
            "WHAT MUST BREAK: the three-process pipeline (the count comes back empty and the "
            "trace shows two pids where four are needed), the job-control proof, redirection "
            "(nothing writes the file), the terminal's typed line, and the two exec rows above.\n"
            "WHAT MUST HOLD: every builtin - `pwd`, `cd`, `$$` via /proc, `$?` via the exit "
            "status, `complete` - every refusal, and every URL spelling refused by the "
            "filesystem. Those sections were written program-free FOR this control: a `$$` proved "
            "by `echo $$` would have gone red with the pipelines and taken the control's "
            "specificity with it.",
        serve_kwargs={},
        fixture=None,
        query=(("spawn_self", "1"),),
        expects={"m5": Expect(
            Outcome.FAIL,
            why="a shell whose stages do not exist must fail every proof about a process and no "
                "proof about itself",
            failed=_SPAWN_SELF_FAILS,
            held=held_rest(M5_LABELS, _SPAWN_SELF_FAILS),
        )},
    ),
    "no-isig": NegativeControl(
        name="no-isig",
        why="no_isig=1: every new pty comes up with ISIG cleared (src/kernel/pty.mjs's "
            "`setPtyDefaultIsig`, armed through the cfg.noIsig hook, which the kernel refuses "
            "without a bench boot). A flag on the DEFAULT rather than a branch in the discipline's "
            "hot path, so the headline path is the same single flag test either way.\n"
            "WHAT MUST BREAK: the one behaviour MILESTONES.md M4 actually specifies — Ctrl-C "
            "raising SIGINT on the foreground group, including against a process spinning in a "
            "compute loop. With ISIG off the ^C is DATA: it is buffered, echoed and delivered to "
            "the program, which then exits normally instead of dying.\n"
            "THE termios SECTION MOVES TOO, and that is the control's own mechanism rather than "
            "collateral: it changes the DEFAULT termios, and that section asserts a fresh pty is "
            "signal-generating. Declared in `failed` rather than excused.\n"
            "WHAT MUST HOLD: echo, canonical buffering, the reserved-word round trip, SIGWINCH, "
            "both poll sections and the foreground-group moves. In particular `raw_isig_off` holds, "
            "because it clears ISIG itself — so the control cannot be satisfied by the flag simply "
            "being unreadable.",
        serve_kwargs={},
        fixture=None,
        query=(("no_isig", "1"),),
        expects={"m4b": Expect(
            Outcome.FAIL,
            why="Ctrl-C must stop reaching the foreground group, while every other property of "
                "the terminal holds",
            failed=_NO_ISIG_FAILS,
            held=held_rest(M4B_LABELS, _NO_ISIG_FAILS),
        )},
    ),
    "no-finish-guard": NegativeControl(
        name="no-finish-guard",
        why="no_finish_guard=1: `finish` no longer drops a reply for a call whose handler's own "
            "side effect already answered it (the cfg.noFinishGuard hook clears the flag it "
            "tests). One call then gets TWO replies.\n"
            "WHY THE CASE IS REACHABLE AT ALL: `pty_open` sets the foreground group from the "
            "OPENER's pgid, so a resize issued before a shell has moved that group raises SIGWINCH "
            "on the process making the call. `raiseOne` interrupts the in-flight call, and the "
            "handler's return was then replied as well — two SEQ bumps and two G_INFLIGHT "
            "decrements for one call, which drives the kernel's depth gauge negative and breaks "
            "the issued == replied identity `check_syscall` asserts.\n"
            "WHAT MUST BREAK: the self_signal section. The second reply overwrites the "
            "interruption the caller has to observe, and the kernel's count of calls answered by "
            "their own side effect goes to 0.\n"
            "WHAT MUST HOLD: every other section. The guard is one branch in `finish` and touches "
            "no path where a signal does not reach the caller — in particular `winsize` holds, "
            "because it moves the foreground group to a child first, which is what made this "
            "unreachable from the nine sections that came before it.",
        serve_kwargs={},
        fixture=None,
        query=(("no_finish_guard", "1"),),
        expects={"m4b": Expect(
            Outcome.FAIL,
            why="a call whose signal answered it must not be answered a second time, while every "
                "proof that signals a CHILD rather than the caller is untouched",
            failed=_NO_FINISH_GUARD_FAILS,
            held=held_rest(M4B_LABELS, _NO_FINISH_GUARD_FAILS),
        )},
    ),
    "no-winch": NegativeControl(
        name="no-winch",
        why="no_winch=1: a resize still resizes and raises no SIGWINCH (the cfg.noWinch hook "
            "clears the flag `setWinsize` tests). The SIGNAL is removed; the SIDE EFFECT is "
            "not.\n"
            "WHY IT EXISTS: the clause asserting the signal could not fail. It read the stage's "
            "`exited` flag, which is equally true of a sleep that ran its full 8 seconds and "
            "returned 0 — so no mutation of the signal path moved it. The stage now exits 0 only "
            "when its own `clock_nanosleep` returned -EINTR, and this control is what shows that "
            "assertion is capable of failing.\n"
            "WHAT MUST BREAK: the SIGWINCH clause and the self_signal section, which both exist "
            "only because of the signal.\n"
            "WHAT MUST HOLD: `a resize that signals the caller still resizes`. The resize is "
            "applied before the signal is raised, so removing the signal must leave it — a "
            "control that moved both would not say which of the two it removed.",
        serve_kwargs={},
        fixture=None,
        query=(("no_winch", "1"),),
        expects={"m4b": Expect(
            Outcome.FAIL,
            why="the signal must stop being delivered while the resize it accompanies still "
                "happens",
            failed=_NO_WINCH_FAILS,
            held=held_rest(M4B_LABELS, _NO_WINCH_FAILS),
        )},
    ),
    "pty-detach": NegativeControl(
        name="pty-detach",
        why="pty_detach=1: a write to the pty MASTER accepts its bytes and discards them (the "
            "cfg.ptyDetach hook, read by `Pty.writeInput`). MILESTONES.md M4a's own control: "
            "\"Detach the pty; the keystroke must not appear.\"\n"
            "WHY THE CUT IS THERE AND NOT ELSEWHERE: every other link is left working. The key "
            "event reaches the widget, the widget writes /dev/console, the device wakes the relay "
            "out of `poll`, the relay writes the master and is told it succeeded. Only the pty "
            "stops being the pty, so what disappears is the ECHO and nothing else.\n"
            "WHAT IT IS ABOUT: a terminal widget that echoed its own keystrokes locally would "
            "satisfy `the pty echoed the typed line` with no pty behind it at all, and no other "
            "control in this suite can tell the two apart. Under this one a locally-echoing "
            "widget still paints the character and the control comes out GREEN - which is the "
            "whole reason src/wm/terminal.mjs draws nothing on a keypress.\n"
            "WHAT MUST HOLD: that the WINDOW still delivered the keystroke to the kernel (the "
            "device's own byte counter), that the relay is still parked in `poll` over a window "
            "fd and a pty master, and the frame's geometry and clamp. Sixteen of twenty-two "
            "labels; the detector's four went to `m7` with the window ABI.",
        serve_kwargs={},
        fixture=None,
        query=(("pty_detach", "1"),),
        expects={"m4a": Expect(
            Outcome.FAIL,
            why="the typed characters must stop appearing on the screen while everything that "
                "carried them to the pty keeps working",
            failed=_PTY_DETACH_FAILS,
            held=held_rest(M4A_LABELS, _PTY_DETACH_FAILS),
        )},
    ),
    "win-first-fd": NegativeControl(
        name="win-first-fd",
        why="win_first_fd=1: a parked `poll` evaluates only the FIRST fd of its set (the "
            "cfg.winFirstFd hook, refused without a bench boot). `PLAN.md` §5's control for M7 "
            "in its own words: 'wake only on the first fd in the set; the two-window case must "
            "hang.'\n"
            "WHAT MUST BREAK: window B and the pipe can never wake the poller, so the one process "
            "holding two windows and a pipe runs to its own ceiling with its second window's key "
            "and its child's bytes still queued. A process has ONE futex word and ONE outstanding "
            "call (constraint 42), which is what makes a single-fd wake fatal rather than slow.\n"
            "WHAT MUST HOLD, and this is what makes it a control rather than a broken world: "
            "window A still wakes it, the REAL keystroke still reaches it through Chrome's own "
            "key translation, `/proc/<pid>/win` still lists both windows with the fds that reach "
            "them, the destroy cascade still cascades across a process boundary, and both edges "
            "of the not-responding detector still fire — the wedge polls a ONE-fd set, so "
            "first-fd-only cannot touch it. Thirty-six of forty-two labels.",
        serve_kwargs={},
        fixture=None,
        query=(("win_first_fd", "1"),),
        expects={"m7": Expect(
            Outcome.FAIL,
            why="a process that waits on three fds must stop being woken by two of them, while "
                "everything that is not a wait keeps working",
            failed=_WIN_FIRST_FD_FAILS,
            held=held_rest(M7_LABELS, _WIN_FIRST_FD_FAILS),
        )},
    ),
    "no-cascade": NegativeControl(
        name="no-cascade",
        why="no_cascade=1: destroying a parent destroys ONLY the parent (the cfg.noCascade hook, "
            "refused without a bench boot). The obvious implementation, and the one SerenityOS's "
            "`destroy_window` return value exists to prevent.\n"
            "WHAT MUST BREAK: the owned window outlives the window it belongs to - measured, "
            "`one win_destroy reported [1], live after [2]` - so the page is left with a frame "
            "over a window that is gone, and the CALLER is told one id for an operation that "
            "should have closed two. The cross-process case breaks with it, because a child in "
            "another process is destroyed by the same walk. And so does each program's reason for "
            "exiting: a program that ran to its own ceiling still exits 0, so the exit status "
            "alone cannot tell the two apart.\n"
            "WHAT MUST HOLD: every poll label, including the real keystroke; every `/proc/<pid>/"
            "win` label; and both edges of the detector. The cascade is a property of "
            "`win_destroy` and has nothing to do with waiting on an fd. Thirty-one of forty-two.",
        serve_kwargs={},
        fixture=None,
        query=(("no_cascade", "1"),),
        expects={"m7": Expect(
            Outcome.FAIL,
            why="one win_destroy must stop reporting - and stop destroying - the windows owned by "
                "the one it was given",
            failed=_NO_CASCADE_FAILS,
            held=held_rest(M7_LABELS, _NO_CASCADE_FAILS),
        )},
    ),
    "no-mountpoints": NegativeControl(
        name="no-mountpoints",
        why="no_mountpoints=1: no mountpoint is created as a directory on the volume beneath it "
            "(the cfg.noMountpoints hook, refused without a bench boot). THE WORLD A READER "
            "REPORTED. The mount table resolves by longest component prefix, so every path call "
            "still works - and the volume underneath has no entry for `/usr`, `/proc`, `/dev` or "
            "`/tmp`.\n"
            "WHAT MUST BREAK: the mountpoint report, which is the only place this is visible "
            "without typing. The two symptoms a person meets are `ls /` printing NOTHING and `cd "
            "/usr/..` answering ENOENT, and `bench/shell-reports/repro.py` is where those are "
            "driven at a real prompt.\n"
            "WHAT MUST HOLD: everything else in m5 - the whole pipeline, the trace, and every "
            "program that resolves through the mount table. Nothing about EXECUTING a program "
            "depends on its mountpoint being visible from the directory above it, and a control "
            "that moved those too could not tell the two apart.",
        serve_kwargs={},
        fixture=None,
        query=(("no_mountpoints", "1"),),
        expects={"m5": Expect(
            Outcome.FAIL,
            why="the mountpoints must stop existing on the volume beneath them",
            failed=_NO_MOUNTPOINTS_FAILS,
            held=held_rest(M5_LABELS, _NO_MOUNTPOINTS_FAILS),
        )},
    ),
    "no-draw": NegativeControl(
        name="no-draw",
        why="no_draw=1: `win_draw` accepts its batch, counts it against the window, and DISCARDS "
            "it (the cfg.noDraw hook, refused without a bench boot). `PLAN.md` §5's control for "
            "M8 in its own words: 'draw nothing; the pattern assertion must fail.'\n"
            "WHAT MUST BREAK: every pixel. The pattern is not on the canvas, the drag leaves "
            "nothing behind it, and the page's own op counter stays at zero — measured, "
            "`{ops: 0, batches: 0}` against a program that reported sending seven ops.\n"
            "WHAT MUST HOLD, and this is what makes it a control rather than a broken world: the "
            "process still gets its surface and the page still makes a canvas for it, the program "
            "still reports the batch it sent, the REAL pointer events still reach the process and "
            "it still draws in response, the surface budget still refuses by name and still gives "
            "the area back, and a surfaced window still refuses cells. Twenty-three of thirty.\n"
            "WHAT IT IS ABOUT: a page that drew something of its own — a canvas it filled, a "
            "pattern it knew — would satisfy every pixel clause with no process behind it, and "
            "nothing else in this suite can tell the two apart.",
        serve_kwargs={},
        fixture=None,
        query=(("no_draw", "1"),),
        expects={"m8": Expect(
            Outcome.FAIL,
            why="the pixels must stop appearing while everything that carried the ops to the page "
                "keeps working",
            failed=_NO_DRAW_FAILS,
            held=held_rest(M8_LABELS, _NO_DRAW_FAILS),
        )},
    ),
    "no-blur": NegativeControl(
        name="no-blur",
        why="no_blur=1: every glass strip keeps its isolation, its brightness and its additive "
            "layers, and its standard deviation goes to zero — `blur(0px)`. A STYLE override, so "
            "no kernel code and no frame structure changes.\n"
            "WHAT MUST BREAK: the three screenshot clauses, and nothing else in the suite. The "
            "caption's transition concentration goes from 0.078 to 0.963 — measured — which is to "
            "say the hard seam stops being spread and reads as the step it is.\n"
            "WHAT MUST HOLD, AND THIS IS THE MILESTONE: THE PAGE'S OWN SIX PROOFS ALL STAY GREEN. "
            "The ring is still four filtered boxes summing to `aero.ringArea`, no ancestor severs "
            "the chain, the halo is still there and still legible both sides, minimize and "
            "maximize are still inert, and the active/inactive pair still moves in opposite "
            "directions. Nothing reachable from script can see that the blur is gone, because a "
            "`backdrop-filter` is applied by the compositor: `getImageData` reads a canvas and a "
            "DOM rasteriser applies no filter at all.\n"
            "WHAT IT IS ABOUT: `blur(flat) == flat`, so over a flat backdrop this control would "
            "change no pixel at all and the check would report Aero fidelity on a system with no "
            "blur (constraint 50). The seam is what makes it fire. It is ALSO the control "
            "`PLAN.md` §5 did not name — see `--negative no-glass`, which is the weaker one.",
        serve_kwargs={},
        fixture=None,
        query=(("no_blur", "1"),),
        expects={"m11": Expect(
            Outcome.FAIL,
            why="the glass must stop blurring while every structural property of the frame holds",
            failed=_NO_BLUR_FAILS,
            held=held_rest(M11_LABELS, _NO_BLUR_FAILS),
        )},
    ),
    "no-glass": NegativeControl(
        name="no-glass",
        why="no_glass=1: `backdrop-filter: none` on every strip. THE CONTROL `PLAN.md` §5 NAMED "
            "for M11 — 'set backdrop-filter: none; the gradient assertion must fail' — registered "
            "so the record shows what it does and does not catch.\n"
            "WHAT MUST BREAK: the pixels, and ALSO proof 1's 'nothing else filters' clause and the "
            "page's own ring verdict, because taking the property away stops the strips filtering "
            "at all. That is the difference between the two controls and it is why both exist: "
            "this one is a SUPERSET of no-blur's subset, so it cannot tell a missing blur from a "
            "missing filter.\n"
            "WHAT MUST HOLD: the chain, the halo and its contrast, the inert buttons, and the "
            "focus pair.\n"
            "WHY IT IS THE WEAKER CUT, measured: `docs/designs/REVIEW-FINDINGS.md` §8 found that "
            "removing the property also removes the isolated group the `plus-lighter` layers blend "
            "into, shifting the sampled pixel by (31,46,71) for a reason that has nothing to do "
            "with blurring. Over a flat backdrop it therefore passes a pixel-equality proof while "
            "catching none of blur(0px), a no-op filter, or a severed chain.",
        serve_kwargs={},
        fixture=None,
        query=(("no_glass", "1"),),
        expects={"m11": Expect(
            Outcome.FAIL,
            why="the strips must stop filtering, which takes the ring clause with the pixels",
            failed=_NO_GLASS_FAILS,
            held=held_rest(M11_LABELS, _NO_GLASS_FAILS),
        )},
    ),
    "sever": NegativeControl(
        name="sever",
        why="sever=1: each window is wrapped in an element carrying `opacity:.99`. The strips are "
            "UNTOUCHED and still ask for blur(9px); an ancestor with opacity below 1 establishes a "
            "backdrop root, which cuts every descendant's `backdrop-filter` off from the desktop.\n"
            "WHAT MUST BREAK: the chain assertion and the pixels. The concentration goes to 0.982 "
            "— measured — while the computed `backdrop-filter` on every strip still reads "
            "`blur(9px) brightness(0.49) saturate(1.25)`, which is the whole horror of it.\n"
            "WHAT MUST HOLD: the ring, because the GEOMETRY is untouched — four strips still sum "
            "to `aero.ringArea` — plus the halo, the inert buttons and the focus pair. That split "
            "is what makes this control about the ANCESTOR rather than about the filter.\n"
            "WHAT IT IS ABOUT: THE FAILURE WITH NO SYMPTOM. The usual window-manager instinct is "
            "to fade a window wrapper's opacity on open and close, and a per-window wrapper is "
            "exactly where that lands. The glass goes flat, every window reads as a grey film, and "
            "the frame-rate budget gets EASIER because there are no blurred pixels to pay for — so "
            "nothing else in this suite would report a thing.",
        serve_kwargs={},
        fixture=None,
        query=(("sever", "1"),),
        expects={"m11": Expect(
            Outcome.FAIL,
            why="an ancestor must sever the chain while the strips still ask for a blur",
            failed=_SEVER_FAILS,
            held=held_rest(M11_LABELS, _SEVER_FAILS),
        )},
    ),
    "no-halo": NegativeControl(
        name="no-halo",
        why="no_halo=1: the caption's `text-shadow` goes, and nothing else changes.\n"
            "WHAT MUST BREAK: the legibility pair. Measured, the local contrast inside the glyph "
            "band collapses from 9.3:1 to 2.1:1 over the black side of the seam and from 8.9:1 to "
            "1.7:1 over the white side — both under WCAG AA, and the white side is the one that "
            "shows why one text colour cannot answer for both.\n"
            "WHAT MUST HOLD: the glass still blurs, the ring is still the ring, the chain is "
            "intact, the buttons are still inert and the focus pair still moves.\n"
            "WHAT IT IS ABOUT: a caption crosses black and white in one drag, so no (colour, "
            "background) pair HAS a contrast ratio and a check that read a declared `color` "
            "against a declared `background` would pass on any stylesheet — webxp's own defect "
            "(constraint 39). Windows 7 answers with DrawThemeTextEx and a glow; this control is "
            "the world where that answer is absent.",
        serve_kwargs={},
        fixture=None,
        query=(("no_halo", "1"),),
        expects={"m11": Expect(
            Outcome.FAIL,
            why="the caption must stop being legible over the bright side of the seam",
            failed=_NO_HALO_FAILS,
            held=held_rest(M11_LABELS, _NO_HALO_FAILS),
        )},
    ),
    "no-governor": NegativeControl(
        name="no-governor",
        why="no_governor=1: `governBlur` accounts the desktop and then flattens NOTHING (the "
            "cfg.noGovernor hook, refused without a bench boot). `PLAN.md` §5's control for M12 in "
            "its own words: 'disable the governor at the same geometry'.\n"
            "WHAT MUST BREAK: the acting, and the pixels that follow from it. No window goes "
            "flat, so the degrade half goes red — and the pixel clauses go with it, because there "
            "is no flat caption to sample across the seam.\n"
            "WHAT MUST HOLD, and this is what makes it a control rather than a broken world: "
            "every MEASUREMENT. The per-window cost still matches the rendered strips, the dpr is "
            "still reported, the shipped budget is still 413 windows away, both edges still exist "
            "as numbers, and the governor still settles — because with nothing to flatten it "
            "trivially does.\n"
            "WHAT IT IS ABOUT: a governor that accounted correctly and never acted would satisfy "
            "every arithmetic clause in this check. The difference between accounting and "
            "admitting is the whole of constraint 49.",
        serve_kwargs={},
        fixture=None,
        query=(("no_governor", "1"),),
        expects={"m12": Expect(
            Outcome.FAIL,
            why="nothing may be flattened while every measurement still holds",
            failed=_NO_GOVERNOR_FAILS,
            held=held_rest(M12_LABELS, _NO_GOVERNOR_FAILS),
        )},
    ),
    "top-first": NegativeControl(
        name="top-first",
        why="blurTopFirst=1: the degrade walk takes the stack from the TOP instead of the bottom "
            "(the cfg.blurTopFirst hook, refused without a bench boot).\n"
            "WHAT MUST BREAK: the ORDER, and only the order. The flat set is no longer a prefix "
            "of the stack and the window on top is the first to lose its glass.\n"
            "WHAT MUST HOLD: everything else, which is the point of having this control as well "
            "as `no-governor`. Glass still comes off, the total still lands under the budget, both "
            "edges still work, and a flat caption is still there for the pixel clauses — so a "
            "reader can see that what moved is a JUDGEMENT and not an arithmetic.\n"
            "WHAT IT IS ABOUT: constraint 49 says 'MUST degrade by z-order from the bottom', and "
            "that half of it is the only half a correct-looking implementation can get backwards "
            "while every number stays right.",
        serve_kwargs={},
        fixture=None,
        query=(("top_first", "1"),),
        expects={"m12": Expect(
            Outcome.FAIL,
            why="the glass must come off the wrong end of the stack",
            failed=_TOP_FIRST_FAILS,
            held=held_rest(M12_LABELS, _TOP_FIRST_FAILS),
        )},
    ),
    "stale-costs": NegativeControl(
        name="stale-costs",
        why="blurStaleCosts=1: admission reads the CURRENT blurred total instead of the all-glass "
            "one (the cfg.blurStaleCosts hook, refused without a bench boot). This is the first "
            "version of M12's governor, restored.\n"
            "WHAT MUST BREAK: idempotence. The input now responds to the action — flattening "
            "lowers it, the next run re-admits everything, the one after flattens again — so the "
            "degrade counter climbs over a desktop nobody touched.\n"
            "WHAT MUST HOLD: the accounting, the degrade ORDER, and the pixels. A governor that "
            "oscillates still flattens and still saves the area on any single run, which is "
            "exactly why the defect is worth a control: nothing about one snapshot looks wrong.\n"
            "WHAT IT IS ABOUT, and why it replaced a `no-hysteresis` control: that one collapsed "
            "the two edges into one threshold and, against an all-glass input, broke NOTHING — the "
            "band between the edges cannot change which windows are flat when the input does not "
            "respond to the action. A control that cannot fail is worse than no control. This is "
            "the loop that was really there, and hysteresis is what would have been needed had the "
            "input stayed this way.",
        serve_kwargs={},
        fixture=None,
        query=(("stale_costs", "1"),),
        expects={"m12": Expect(
            Outcome.FAIL,
            why="the governor must stop settling over an unchanged desktop",
            failed=_STALE_COSTS_FAILS,
            held=held_rest(M12_LABELS, _STALE_COSTS_FAILS),
        )},
    ),
    "no-clamp": NegativeControl(
        name="no-clamp",
        why="no_clamp=1: `Win.apply` writes the requested box straight onto the element, so nothing "
            "holds a window inside the desktop (the `setGeometryControls` hook in "
            "src/wm/window.mjs).\n"
            "WHAT MUST BREAK: all three clamped states, the caption-still-grabbable clause that "
            "follows from them, the shrink that pulls frames back inside — and the MINIMUM SIZE, "
            "which is worth noticing rather than explaining away: `clampBox` is where the "
            "MIN_W/MIN_H floor lives, so a world with no clamp also has no floor.\n"
            "WHAT MUST HOLD, and it is most of the check: every drag still moves the frame by the "
            "pointer's delta, the kernel is still told what the page did, the ring is still the "
            "ring, the stack is still reachable by a click, and a desktop that grows back still "
            "holds each window where it was asked to be.\n"
            "WHAT IT IS ABOUT: a window a user cannot reach is a window a user has lost. The "
            "clamp is the only thing standing between a drag and that, and it is page-side from "
            "end to end — so no kernel assertion anywhere can see it.",
        serve_kwargs={},
        fixture=None,
        query=(("no_clamp", "1"),),
        expects={"m13": Expect(
            Outcome.FAIL,
            why="a frame must be draggable out of reach, and the floor must go with it",
            failed=_NO_CLAMP_FAILS,
            held=held_rest(M13_LABELS, _NO_CLAMP_FAILS),
        )},
    ),
    "stale-geom": NegativeControl(
        name="stale-geom",
        why="stale_geom=1: `WinHost.#report` posts the box the process ASKED FOR rather than the "
            "one the clamp settled on (the `setHostControls` hook in src/wm/winhost.mjs).\n"
            "WHAT MUST BREAK: the kernel's record, in all three places this check reads it — the "
            "per-window box, the box after a re-clamp, and the floored size.\n"
            "WHAT MUST HOLD: everything the page can see for itself. The frames are laid out "
            "exactly as before, so the clamp clauses, the drags, the ring and the stack are "
            "untouched — AND THE CELL GRID, which is the detail worth reading: cols and rows are "
            "computed from the rendered client rect rather than from the box, so they stay true "
            "while the box beside them is a fiction.\n"
            "WHAT IT IS ABOUT: `src/kernel/wins.mjs` says 'the kernel RECORDS geometry; it never "
            "decides it', and this one post is the only thing that makes it true. Everything "
            "downstream — `/proc`, the blur governor's area, a terminal's `stty size` — is "
            "arithmetic over a number the page supplied, so a page that supplies the wrong one is "
            "believed.",
        serve_kwargs={},
        fixture=None,
        query=(("stale_geom", "1"),),
        expects={"m13": Expect(
            Outcome.FAIL,
            why="the kernel must come to hold a geometry no frame ever had",
            failed=_STALE_GEOM_FAILS,
            held=held_rest(M13_LABELS, _STALE_GEOM_FAILS),
        )},
    ),
    "no-relayout": NegativeControl(
        name="no-relayout",
        why="no_relayout=1: the desktop changing size re-clamps nothing (the `setHostControls` "
            "hook). This is the world web-os was in until M13.\n"
            "WHAT MUST BREAK: the resize proof entirely — frames stay outside the desktop that "
            "shrank, the kernel is told nothing, and the grow-back clause goes with them because "
            "it asserts the re-clamp RAN and not merely that the boxes match. They would match: a "
            "window that was never pulled in was never moved.\n"
            "WHAT MUST HOLD: the first five proofs, unchanged. Every gesture still clamps against "
            "the desktop as it is at that moment, which is exactly why the gap was invisible.\n"
            "WHAT IT IS ABOUT: `Win.apply` clamps against the desktop's CURRENT rect, so the "
            "clamp was correct at every gesture and stale at every resize — and M14 needs the same "
            "callback for something that is not a resize at all, because the taskbar takes a strip "
            "off the bottom and the WORK AREA changes when the shell appears.",
        serve_kwargs={},
        fixture=None,
        query=(("no_relayout", "1"),),
        expects={"m13": Expect(
            Outcome.FAIL,
            why="a desktop that shrinks must leave its frames outside it",
            failed=_NO_RELAYOUT_FAILS,
            held=held_rest(M13_LABELS, _NO_RELAYOUT_FAILS),
        )},
    ),
    "flat-desk": NegativeControl(
        name="flat-desk",
        why="flat_desk=1: the desktop's hard black/white step becomes ONE FLAT COLOUR. Nothing "
            "else changes — the glass still blurs, at the same sigma, over the same strips.\n"
            "WHAT MUST BREAK: the two clauses that are about the BACKDROP. The bare reference "
            "stops being a step, and the caption's band stops having a transition to spread — "
            "`blur(flat) == flat`, so the band is flat whether or not anything blurred.\n"
            "WHAT MUST HOLD, and one of these surprised me: all six of the page's own structural "
            "proofs and the verdict, because the geometry, the chain, the halo and the focus pair "
            "have nothing to do with the backdrop — AND BOTH LEGIBILITY CLAUSES, because the "
            "halo gives a glyph local contrast against whatever is behind it, so a flat grey "
            "desktop is still a desktop the caption is legible over. An earlier draft of this "
            "prose claimed the contrast collapses; it does not, and the declared set is what was "
            "measured.\n"
            "WHAT IT IS ABOUT: CONSTRAINT 50 ITSELF — 'an Aero pixel check MUST sample across a "
            "high-contrast backdrop edge and assert the gradient. Over a flat backdrop "
            "blur(flat) == flat, so the assertion passes identically with backdrop-filter: none — "
            "the same class of defect as constraint 39.' This is the only run that shows the pixel "
            "clauses are coupled to the SEAM rather than to a constant, and `--prove-failure` "
            "cannot show it: an assertion over a constant still inverts and still fires.",
        serve_kwargs={},
        fixture=None,
        query=(("flat_desk", "1"),),
        expects={"m11": Expect(
            Outcome.FAIL,
            why="with nothing to blur, every pixel clause must go red while the structure holds",
            failed=_FLAT_DESK_FAILS,
            held=held_rest(M11_LABELS, _FLAT_DESK_FAILS),
        )},
    ),
    "no-owner-chain": NegativeControl(
        name="no-owner-chain",
        why="no_owner_chain=1: a raise moves the window ALONE and leaves the dialogs that ride "
            "with it where they were (the cfg.noOwnerChain hook, refused without a bench boot). "
            "`PLAN.md` §5's control for M9 in its own words: 'remove the owner chain; the dialog "
            "must fall behind and the check must fail.'\n"
            "WHAT MUST BREAK: the order after the click. The dialog is created on top, so it is "
            "above its owner until something raises the owner — and then it falls behind, which is "
            "constraint 44's defect exactly: 'without an owner chain a dialog sits behind the "
            "window that owns it.'\n"
            "WHAT MUST HOLD: the refusal itself, because the modal still blocks — so the click is "
            "still refused and the blocker is still named. That split is what makes this control "
            "about the CHAIN and not about modality, which `--negative no-modal` is for.",
        serve_kwargs={},
        fixture=None,
        query=(("no_owner_chain", "1"),),
        expects={"m9": Expect(
            Outcome.FAIL,
            why="a dialog must stop coming up with the window that owns it",
            failed=_NO_OWNER_CHAIN_FAILS,
            held=held_rest(M9_LABELS, _NO_OWNER_CHAIN_FAILS),
        )},
    ),
    "no-modal": NegativeControl(
        name="no-modal",
        why="no_modal=1: nothing is ever BLOCKING (the cfg.noModal hook, refused without a bench "
            "boot), so `blockingFor` answers null for every window.\n"
            "WHAT MUST BREAK: the enforcement, in both of its halves. The raise is granted so the "
            "order changes and no blocker is named, and the keys ARRIVE so the blocked editor's "
            "screen changes and `suppressed` stays at zero. The sibling's clauses go with them.\n"
            "WHAT MUST HOLD, and this is the point of having two controls: THE WHOLE CLOSE "
            "CONTRACT. The X still asks instead of acting, Esc still refuses, the editor is still "
            "editable afterwards, and answering still destroys both windows through the cascade — "
            "because that half of M9 has nothing to do with modality. A control that broke both "
            "halves could not tell them apart.",
        serve_kwargs={},
        fixture=None,
        query=(("no_modal", "1"),),
        expects={"m9": Expect(
            Outcome.FAIL,
            why="a modal must stop refusing raises and stop suppressing input, while the close "
                "request keeps working",
            failed=_NO_MODAL_FAILS,
            held=held_rest(M9_LABELS, _NO_MODAL_FAILS),
        )},
    ),
    "no-lockdown": NegativeControl(
        name="no-lockdown",
        why="no_lockdown=1: a process worker's realm is NOT stripped before its program text is "
            "evaluated (the cfg.noLockdown hook, refused without a bench boot and carried to the "
            "process, because the strip lives in the process's own realm). MILESTONES.md M6's own "
            "control, in its words: 'Skip the stripping; the same program must succeed. If it does "
            "not, the check is testing nothing.'\n"
            "WHAT MUST BREAK, and it is the whole milestone: a uid-1000 process reaches "
            "`navigator.storage`, opens the kernel's blob for a 0600 root-owned file BY INODE, and "
            "writes it - measured, KERNEL-OWNED-SECRET becomes TAMPERED-BY-PROCESS - after "
            "which the kernel reads the tampered bytes back through its own syscall channel. "
            "`indexedDB`, `caches` and `URL.createObjectURL` come back with it, a blob module "
            "evaluates, and `p_fault` - the bypass snippet with no try/catch - RETURNS the "
            "volume's root listing instead of dying.\n"
            "WHAT MUST HOLD, and this is what makes it a control rather than a broken world: "
            "every LOADER clause. The policy is still served, so a computed `data:` import and "
            "`eval` are still refused and the one same-origin specifier still loads. The syscall "
            "channel also holds - the file is still EACCES to this process, which is what shows "
            "the bypass went around the credential rather than through a system with no "
            "permissions.",
        serve_kwargs={},
        fixture=None,
        query=(("no_lockdown", "1"),),
        expects={"m6": Expect(
            Outcome.FAIL,
            why="the realm must hand a process the platform again, including the kernel's own "
                "volume, while the module loader stays bounded",
            failed=_NO_LOCKDOWN_FAILS,
            held=held_rest(M6_LABELS, _NO_LOCKDOWN_FAILS),
        )},
    ),
    "text-only": NegativeControl(
        name="text-only",
        why="no_typed=1: every data object offers TEXT and nothing else, whatever its creator "
            "asked for (the cfg.noTyped hook, refused without a bench boot). `PLAN.md` section "
            "5's control for M10 in its own words: 'offer only the text format; the image paste "
            "must fail cleanly, not silently paste a path.'\n"
            "WHAT MUST BREAK: every IMAGE. The copy carries no bitmap, the paste draws no logo, "
            "the drop arrives with nothing an image view can use, and the PNG cannot be carried "
            "at all.\n"
            "WHAT MUST HOLD, and this is what makes it a control about TYPES rather than a broken "
            "world: both GESTURES run end to end. The clipboard still publishes and a program "
            "still reads it out of `/proc/dataobj`; the real mouse still opens exactly one drag "
            "session, the target is still entered once, the drop is still delivered and the source "
            "is still told the effect. And the whole REFUSAL proof holds - a clean ENOTSUP naming "
            "what the object did offer is precisely what this control's world should produce.\n"
            "WHAT IT IS ABOUT: an untyped clipboard would hand the receiver whatever bytes it had "
            "and let it guess, and a receiver that guessed would render a filename as a picture. "
            "Nothing else in this suite can tell the two apart.",
        serve_kwargs={},
        fixture=None,
        query=(("no_typed", "1"),),
        expects={"m10": Expect(
            Outcome.FAIL,
            why="the images must stop arriving while both gestures keep working",
            failed=_TEXT_ONLY_FAILS,
            held=held_rest(M10_LABELS, _TEXT_ONLY_FAILS),
        )},
    ),
    "no-drop": NegativeControl(
        name="no-drop",
        why="no_drop=1: a drop is never delivered (the cfg.noDrop hook, refused without a bench "
            "boot). The session runs, the target highlights, the gesture ends - and no `WEV_DROP` "
            "reaches anybody and no payload is left to collect.\n"
            "WHAT MUST BREAK: the drag's delivery. No drop, no effect reported to the source, no "
            "bytes under the image format and no pixels on the receiver's canvas.\n"
            "WHAT MUST HOLD: THE WHOLE CLIPBOARD HALF, and the refusal with it. Copying an image "
            "and pasting it in another process has nothing to do with a drop, so if this control "
            "moved those clauses it would not be telling the milestone's two gestures apart - "
            "which is the only reason there are two controls.",
        serve_kwargs={},
        fixture=None,
        query=(("no_drop", "1"),),
        expects={"m10": Expect(
            Outcome.FAIL,
            why="the drop must stop arriving while the clipboard keeps working",
            failed=_NO_DROP_FAILS,
            held=held_rest(M10_LABELS, _NO_DROP_FAILS),
        )},
    ),
    "no-csp": NegativeControl(
        name="no-csp",
        why="serve(csp=False): the process realm's Content-Security-Policy is not sent on "
            "`/src/libos/`. A SERVER switch and not a query parameter, because a policy is a "
            "response header - the same shape as `no-isolation`, and `_assert_policy` asserts its "
            "absence on the wire before Chrome starts, so a control that failed to apply reports "
            "itself rather than reporting the product.\n"
            "WHAT MUST BREAK: constraint 139's half. A COMPUTED `import(expr)` is the module "
            "loader, which no scanner over program text can catch and which deleting `fetch` does "
            "not touch - measured, `data: evaluated in a process` - and `eval` and `new Function` "
            "come back with it (`script-src` without `'unsafe-eval'` is what refused them).\n"
            "WHAT MUST HOLD: every REALM clause, the volume, and the fault. The strip is "
            "in-realm and owes nothing to a header: ambient OPFS is still gone, the kernel's bytes "
            "are still intact, and the bypass program still faults with SIGABRT. The two halves "
            "being disjoint is a measured claim (constraint 187), and these two controls are where "
            "it is asserted.",
        serve_kwargs={"csp": False},
        fixture=None,
        expects={"m6": Expect(
            Outcome.FAIL,
            why="the module loader must be unbounded again while the realm stays stripped",
            failed=_NO_CSP_FAILS,
            held=held_rest(M6_LABELS, _NO_CSP_FAILS),
        )},
    ),
    "no-poll-wake": NegativeControl(
        name="no-poll-wake",
        why="no_poll_wake=1: parked `poll` calls are no longer re-evaluated when anything replies "
            "(the cfg.noPollWake hook clears the flag `reply` tests). A blocking poll can then "
            "only ever answer from its own timeout.\n"
            "WHAT MUST BREAK: constraint 42's wake. A process parked in `poll` over a pipe and a "
            "terminal must be woken by whichever becomes ready first — that is the whole reason "
            "`poll` exists here, because a process has one futex word and one outstanding call. "
            "The stage reports what it saw down the pty and signals pass or fail in its EXIT CODE, "
            "so the failure is "
            "'it timed out having seen nothing' rather than a harness timeout.\n"
            "WHAT MUST HOLD: everything else, including `poll_ready` — reporting readiness "
            "synchronously does not go through the wake at all, and a control that moved both "
            "would not say which half it removed.",
        serve_kwargs={},
        fixture=None,
        query=(("no_poll_wake", "1"),),
        expects={"m4b": Expect(
            Outcome.FAIL,
            why="the parked poll must time out instead of waking, while synchronous readiness "
                "reporting is untouched",
            failed=_NO_POLL_WAKE_FAILS,
            held=held_rest(M4B_LABELS, _NO_POLL_WAKE_FAILS),
        )},
    ),
    "kernel-stall": NegativeControl(
        name="kernel-stall",
        why="stall_us=2000: every kernel handler busy-waits 2 ms before it replies "
            "(src/kernel/kernel.mjs:513-516 installs the hook, and refuses unless the page asked "
            "for a bench boot). M0's own negative control, MILESTONES.md - the author's hand run "
            "at N=16 gave p99 29,673.6 us and a KILL verdict, and this is that run made "
            "re-runnable. window_ms is widened WITH the stall and for one reason: 2 ms per call "
            "serialises the channel, so the check's own 400 ms window yields ~200 samples and "
            "summarise.mjs:112 withholds a p99 below 1,000 of them. Without the wider window the "
            "p99 expectation would fail for want of samples rather than on a number over the "
            "bar, and the control would be named for something it did not demonstrate",
        serve_kwargs={},
        fixture=None,
        query=(("stall_us", "2000"), ("window_ms", "2600")),
        expects={"syscall": Expect(
            Outcome.FAIL,
            why="a kernel that takes 2 ms in the handler must put the p99 over the accept bar "
                "read from bench/syscall-contention/bars.json, and must break nothing else",
            failed=_STALL_FAILS,
            held=_STALL_HOLDS,
        )},
    ),
}


# ======================================================================================
# boot (§10). The design places this in scripts/checks/boot.py; the path allowlist for this
# task permitted one file. scripts/checks/*.py are not entry points and would not resolve
# `from harness import ...` if run directly.
#
# The boot gate: does this browser give the kernel what docs/CONSTRAINTS.md 1-13 and 30-33 say
# it cannot exist without, and does the page say so in a way a later milestone can rely on.
#
# www/index.html is not the kernel. It is the screen in front of it, and the whole reason it
# exists is to refuse. A harness that passes here on a page whose verdict reads 'fail' makes
# every number downstream a number about a different system (constraint 39).
# ======================================================================================

READ_PREFLIGHT = """
(() => {
  const el = document.documentElement
  const verdict = document.getElementById('verdict')
  const span = verdict ? verdict.querySelector('span') : null
  return {
    verdict: 'preflight' in el.dataset ? el.dataset.preflight : null,
    rows: Array.from(document.querySelectorAll('#checks tr')).map((tr) => ({
      name:  tr.cells[0] ? tr.cells[0].textContent : null,
      state: tr.cells[1] ? tr.cells[1].textContent : null,
      cls:   tr.cells[1] ? tr.cells[1].className   : null,
      colour: tr.cells[1] ? getComputedStyle(tr.cells[1]).color : null,
      why:   tr.cells[2] ? tr.cells[2].textContent : '',
    })),
    note:      verdict ? verdict.textContent : '',
    noteClass: span ? span.className : null,
    noteColour: span ? getComputedStyle(span).color : null,
    liveIsolated: self.crossOriginIsolated === true,
    liveSAB: typeof SharedArrayBuffer === 'function',
  }
})()
"""

SHAPE = {"verdict": (str, type(None)), "rows": list, "note": str,
         "noteClass": (str, type(None)), "noteColour": (str, type(None)),
         "liveIsolated": bool, "liveSAB": bool}


@check(
    name="boot",
    milestone="day-zero",
    controls=(Control.INVERT, Control.NO_ISOLATION, Control.EMPTY_ROOT, Control.PATCHED),
    # Every term of the inventory is fixed by PREFLIGHT_ROWS, not by what the page rendered, so a
    # page that renders no rows still records 30 - 21 of them failing - rather than passing on an
    # empty table. The floor in scripts/check_floors.json is what stops the inventory being
    # shortened to whatever the run produced.
    labels=BOOT_LABELS,
    requires_isolation=True,
    root=Root.WWW,
    document="/",
    ready_expr="'preflight' in document.documentElement.dataset",
    ready_what="the preflight flag (document.documentElement.dataset.preflight, "
               "www/index.html:129)",
    ready_timeout=15.0,
    refusal_expr="document.documentElement.dataset.preflight",
    refusal_want="fail",
    note="negative controls: --negative no-isolation turns four required rows red (measured: "
         "crossOriginIsolated, SharedArrayBuffer, worker is isolated, worker can block - NOT "
         "OPFS sync handle, which stays 'present' because a sync access handle does not need "
         "cross-origin isolation; MILESTONES.md:54-57 records the same four) and the verdict to "
         "'fail'; --negative patched-optional must still PASS; --negative empty-root must gate "
         "before Chrome is pointed at the page",
)
def check_boot(env: Env) -> None:
    got = env.read(READ_PREFLIGHT, SHAPE)

    if got["verdict"] is None:
        # The runner already settled on this flag, so its absence here is not slowness.
        # Measured readiness is ~61 ms on this machine; the gate allows 15 s.
        env.unmeasurable(
            "www/index.html never set data-preflight (www/index.html:129) though the load event "
            "fired and the runner waited %.1fs. The page did not finish its own probe, so "
            "nothing below was measured." % env.ready_wait_s)

    # Anti-vacuity, and it must come first: nine rows reading 'present' prove nothing if there
    # were meant to be ten. Assert the whole set in order before any row's value.
    got_names = tuple(row["name"] for row in got["rows"])
    want_names = tuple(name for name, _ in PREFLIGHT_ROWS)
    if got_names != want_names:
        env.note("www/index.html and PREFLIGHT_ROWS disagree. Expected and absent: %s. Present "
                 "and unexpected: %s. One of the two is out of date - decide which."
                 % (sorted(set(want_names) - set(got_names)) or ["none"],
                    sorted(set(got_names) - set(want_names)) or ["none"]))
    env.expect("row names", got_names, want_names)

    rows = {row["name"]: row for row in got["rows"]}
    for name, required in PREFLIGHT_ROWS:
        row = rows.get(name)
        if row is None:
            # An absent row is a failure, never a skip. Two expectations, so the declared floor
            # still holds when a row vanishes.
            env.expect("%s state" % name, None, "present")
            env.expect_that("%s cell" % name, False,
                            "the page rendered no row for %s, so nothing is checking it" % name)
            continue
        if required:
            env.expect("%s state" % name, row["state"], "present")
        else:
            env.expect_that(
                "%s state" % name, row["state"] in ("present", "absent"),
                "reads %r - an optional row must never read MISSING, or a cosmetic capability "
                "has been promoted to a boot blocker" % row["state"])
        # One expectation per row, pairing the painted class with the state and asserting that
        # the why cell is filled exactly when the row is not present. An error naming nothing is
        # a defect in its own right, and a row reading 'present' while still rendering a reason
        # is a page contradicting itself. (www/index.html:70 and :115: `pass ? '' : why`.)
        env.expect(
            "%s cell" % name,
            (row["cls"], bool(row["why"])),
            (STATE_CLASS.get(row["state"], "<unknown state>"), row["state"] != "present"))

    # The class pairing above is a DOM fact; a colour is what a human reads, and the stylesheet is
    # the half of the pairing nothing crossed: `.bad` repainted green leaves every class
    # assertion intact over a screen that reads as an all-clear (docs/CONSTRAINTS.md constraint
    # 39). One colour per distinct class covers both directions - two classes painting the same
    # colour, and one class painting two - and it is non-vacuous in any world that renders more
    # than one state, which is every negative control (constraint 50's discipline: sample across
    # the seam rather than assert a property that holds with the feature switched off).
    painted: Dict[Optional[str], set] = {}
    for row in got["rows"]:
        painted.setdefault(row["cls"], set()).add(row["colour"])
    painted.setdefault(got["noteClass"], set()).add(got["noteColour"])
    env.note("classes and the colours they painted: %s"
             % sorted([cls, sorted(colours)] for cls, colours in painted.items()))
    env.expect("state colours distinguish states",
               len({colour for colours in painted.values() for colour in colours}), len(painted))

    # www/index.html renders `fatal === 0` twice - the dataset flag at :129 and the prose at
    # :119-128 - so asserting both turns that duplication into a checked invariant. Asserting
    # one would let the other drift.
    env.expect("verdict flag", got["verdict"], "ok")
    env.expect("verdict class", got["noteClass"], "ok")
    env.expect_in("verdict text", "Environment is sufficient.", got["note"])

    # Read from the realm, not from the table. The table is the page's self-report, and a page
    # served without the headers is also a page that cannot tell you so. These two are the facts
    # the kernel needs (constraints 1 and 31).
    env.expect("live crossOriginIsolated", got["liveIsolated"], True)
    env.expect("live SharedArrayBuffer", got["liveSAB"], True)

    # And from outside the page entirely: the response that carried the document, as the server
    # recorded it on the wire. Three independent sources for one fact; the first two share a
    # failure mode.
    document = env.request("/")
    env.expect("document COOP", document.headers.get("Cross-Origin-Opener-Policy"),
               "same-origin")
    env.expect("document COEP", document.headers.get("Cross-Origin-Embedder-Policy"),
               "require-corp")
    env.expect_that(
        "served index.html", env.served_matches_disk("/index.html"),
        "the bytes served differ from www/index.html on disk, so this run measured something "
        "other than this tree")

    env.shoot("boot")


# ======================================================================================
# syscall (M0). The gate M0 exists to decide is already decided - the sweep ran, the verdict is
# ACCEPT at N=16 - and this check is NOT that sweep. It asserts the invariants the sweep
# established, at a size that runs in about a second, so a later milestone cannot quietly break
# one of them: the round trip returns the RIGHT pid, the four counters agree, constraint 7's
# not-equal fast path is reachable and is a reply rather than an error, the kernel really was
# saturated while the figure was taken, and the p99 at this N is under the bar in
# bench/syscall-contention/bars.json.
#
# It is a CHECK and not a benchmark: the decision figure is p99 at N=16 over a 3 s window, three
# runs, one fresh browser per cell (bench/syscall-contention/README.md). One 400 ms window in a
# browser shared with check_boot cannot produce that number and does not claim to. It is taken at
# the bar's own N, though, and read against the real accept bar, so what it guards is the margin
# the decision rests on rather than a smoke-sized version of it.
#
# NO QUIESCENCE ASSERTION, unlike probe.py: that one exists because the probe runs several cells
# per browser and a terminated kernel's process workers run on for ~2 s (constraint 14). Here the
# cell is the only one in its phase and its page is freshly navigated, so there is no previous
# cell to inherit. If a second kernel check is ever added to this file, probe.py's
# Target.getTargets census has to come with it.
# ======================================================================================

BARS_JSON = REPO / "bench" / "syscall-contention" / "bars.json"

#: loop.mjs:183 forces the not-equal path exactly three times. Declared here so an empty `forced`
#: array fails the arity instead of satisfying a comparison of two empty tuples.
FORCED_PROBES = 3

#: The anti-vacuity clauses from summarise.mjs this check asserts, by their row prefix. The
#: concurrency ones: A2a/A2b say the median dispatch saw a backlog, A2c that nearly every dispatch
#: did, A7 that the processes were inside their windows AT THE SAME TIME, A8 that the window held
#: N calls at once AND that the latch saying so was armed at N.
#:
#: A2c joins the set because this check now runs at N=16, which is the N the bench's own rule says
#: it may be read at; measured 0.999, 0.999, 0.999 over three runs against its 0.95 floor.
#:
#: A4 STAYS OUT, and this is the one place that decision is recorded. It is a two-sided clause and
#: the only one whose upward direction would catch a runaway depth counter, which is why excluding
#: it was worth re-examining - but it is a TOLERANCE on two estimators, and at N=16 a healthy run
#: spends 70% of it: depth_p50 is an integer 13 against little*N of 15.76-15.80 (three runs), i.e.
#: 2.8 of the 3.95 the clause allows, so one bin of jitter in the median dispatch fails it. A gate
#: that flakes is a gate that gets deleted. The direction it was wanted for is covered instead by
#: A10 - depth_max <= N and depth_p50 <= N, exact bounds and not tolerances, true by construction
#: for N processes with one outstanding call each - which the "depth instrument within bounds"
#: expectation asserts in the harness's own arithmetic. A3, A5 and A9 are reported in the note and
#: not asserted, as before.
CONCURRENCY_GATES = ("A2a", "A2b", "A2c", "A7", "A8")

#: Which counters must read zero. NOT `spurious`: a wake with the watched word unchanged is a
#: platform event the stub handles by re-arming (src/libos/syscall.mjs:164), and one was measured
#: in a clean run. These eight are each a lost, duplicated or misattributed reply.
QUIET_COUNTERS = ("badCallId", "lateReply", "dropped", "rlenFault", "hostGone", "timedOut",
                  "timedOutButReplied", "seqSkip")

#: One cell per page load, so one N per document (www/m0.html:232-238 refuses more). N is read
#: back OUT of this query by the page, never restated in Python.
#:
#: N=16 BECAUSE THAT IS THE N THE DECISION WAS TAKEN AT. At N=4 this check measured p99 ~45-60 us
#: against the 500 us bar - about 8x headroom - so a 2-8x contention regression at the bar's own N
#: would have flipped the verdict off ACCEPT while the suite stayed green. At N=16 over 400 ms,
#: measured on this machine: 70,293-70,479 calls, depth_p50 13 of 16, p99 175.0 / 245.0 / 235.0 us
#: over three runs, so the suite now guards the ~2x margin the sweep's ACCEPT actually rests on
#: (p99 255 us at N=16 over 3 s, three runs). It cost 0.12 s: 1.19 s at N=4, 1.31 s at N=16.
#: The sweep is still the bench - this is one 400 ms cell in a browser shared with check_boot.
SYSCALL_DOCUMENT = ("/www/m0.html?n=16&window_ms=400&warmup=100&call=getpid&payload=64"
                    "&force_not_equal=1")

#: The page's own terminal state, polled. 'done' is a finished cell, 'aborted' is the isolation
#: refusal and 'error' is a page that threw; all three are terminal, and which one it was is the
#: check body's business, not the runner's.
SYSCALL_READY = ("(() => { const s = globalThis.M0 && globalThis.M0.state; "
                 "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")

#: Everything this check reads, in one round trip, trimmed in the PAGE. The histograms behind
#: these figures are tens of thousands of bins wide and summarise.mjs owns the statistics over
#: them (one definition, imported by the bench and read here) - pulling them into Python would be
#: a second renderer of the same fact.
READ_SYSCALL = """
(() => {
  const m0 = globalThis.M0 || {}
  const cells = m0.cells || []
  const q = new URLSearchParams(location.search)
  const cfg = m0.config || {}
  const out = {
    state: String(m0.state),
    why: String(m0.why || ''),
    cells: cells.length,
    invalid: cells.filter((c) => c.invalid).map((c) => String(c.why)),
    isolated: m0.isolated === true,
    kernelIsolated: m0.kernelIsolated === true,
    pageFingerprint: String(m0.pageFingerprint || ''),
    requestedStallUs: Number(q.get('stall_us') || 0),
    echoedStallUs: Number((m0.cfgEcho || {}).stallUs || 0),
    requestedN: Number(q.get('n') || 0),
    // null, never NaN: a page that aborted before it fetched bars.json has no bar, and that
    // fact belongs to the expectation that compares the two bars - not to the shape check,
    // which would raise first and report a type where the reason is that the kernel never
    // booted. An error path must name what actually failed.
    acceptBarUs: typeof (cfg.bars || {}).accept_p99_us === 'number'
      ? cfg.bars.accept_p99_us : null,
    // summarise.mjs's own known-answer test over two fixed sample vectors, run at page start-up.
    // Reported as the verdict plus the whole comparison, because a self-test that says only
    // 'false' names nothing.
    percentileSelfTest: (m0.percentileSelfTest || {}).ok === true,
    percentileSelfTestWrong: ((m0.percentileSelfTest || {}).wrong || []).map(String),
    percentileSelfTestDetail: JSON.stringify((m0.percentileSelfTest || {}).got || null),
    errors: (m0.errors || []).map(String),
    faults: (m0.faults || []).map((f) => 'pid ' + f.pid + ': ' + f.why),
    cell: null,
  }
  const c = cells.length === 1 && !cells[0].invalid ? cells[0] : null
  if (c) {
    out.cell = {
      n: c.n,
      count: c.count,
      fingerprintsAgree: c.fingerprintsAgree === true,
      saturated: c.saturated === true,
      depthP50: c.depth.p50,
      depthMax: c.depth.max,
      quantumOk: c.quantumGuard.ok === true,
      quantumWhy: String(c.quantumGuard.why || ''),
      quantumUs: c.quantumUs,
      p99Us: c.p99.us,
      p99Text: String(c.p99.text),
      p99Why: String(c.p99.why || ''),
      // p50 carries the suite's tight bar, because it is the statistic this environment measures
      // repeatably. Read from the same cell, at the same bin geometry, as the p99 beside it.
      p50Us: c.p50 ? c.p50.us : null,
      // The quantile the figure was asked for, and the counting witness that the figure printed
      // is that quantile of the pooled histogram. Beside them, the worst per-process p99 at the
      // same quantile: the pooled one cannot exceed it.
      p99Quantile: c.p99Quantile,
      p99Witness: c.p99Witness === null || c.p99Witness === undefined ? null : {
        ok: c.p99Witness.ok === true,
        q: c.p99Witness.q,
        atOrAbove: c.p99Witness.atOrAboveFraction,
        above: c.p99Witness.aboveFraction,
        tail: c.p99Witness.tail,
      },
      worstP99Us: c.worstP99Us,
      // The latch that gives `saturated` its meaning: the threshold this window armed, and the
      // depth the hand-over fired at.
      latch: c.latch === null || c.latch === undefined ? null
        : { target: c.latch.target, depth: c.latch.depth },
      meanUs: c.meanUs,
      serviceMeanUs: c.serviceMeanUs,
      pids: c.pids,
      envPids: c.envPids,
      windowWrong: c.windowWrong,
      firstGetpid: c.firstGetpid,
      forcedPid: c.forcedPid === undefined ? null : c.forcedPid,
      forced: (c.forced || []).map((f) => ({
        notEqual: f.notEqual === true, published: f.publishedBeforePark === true, r0: f.r0,
      })),
      gates: (c.gates.rows || []).map((r) => ({
        name: String(r.name), ok: r.pass === true, evaluated: r.evaluated !== false,
        detail: String(r.detail),
      })),
      accounting: c.accounting,
      verdict: String(c.verdict),
    }
  }
  return out
})()
"""

SYSCALL_SHAPE = {"state": str, "why": str, "cells": int, "invalid": list, "isolated": bool,
                 "kernelIsolated": bool, "pageFingerprint": str, "requestedStallUs": (int, float),
                 "echoedStallUs": (int, float), "requestedN": int,
                 "acceptBarUs": (int, float, type(None)), "errors": list, "faults": list,
                 "percentileSelfTest": bool, "percentileSelfTestWrong": list,
                 "percentileSelfTestDetail": str, "cell": (dict, type(None))}

#: The quantile the headline figure must be read at, as the harness's own expectation and NOT
#: read back from the page: summarise.mjs declares HEADLINE_QUANTILE once and both of its
#: percentile call sites read it, which is what stops the two columns being two statistics - but
#: a constant the subject supplies and the harness echoes is a constant the subject cannot be
#: wrong about. A p99 is the 0.99 quantile; that is what the figure in MILESTONES.md means.
HEADLINE_QUANTILE = 0.99


def bar_us(key: str) -> float:
    """A bar, read from the file the bench reads it from. NOT restated here: a threshold written
    twice is two numbers to keep in step, and the ones in bars.json are what the sweep's verdict
    was taken against."""
    try:
        data = json.loads(BARS_JSON.read_text(encoding="utf-8"))
        return float(data[key])
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise Unmeasurable(
            "%s cannot be read from %s, so there is no bar to compare against: %s"
            % (key, _relative(BARS_JSON), error))


# WHY THIS CHECK DOES NOT ASSERT THE 500 us ACCEPT BAR, which is the opposite of what an earlier
# draft did and the reason it was flaky at about one run in five.
#
# The gate's figure and this check's figure are different measurements of the same channel. The
# gate ran one FRESH BROWSER PER CELL with quiescence asserted and 2,000 warm-up calls, took three
# runs and read the worst: p50 85-90 us, p99 200-255 us. This check runs ONE cell in a browser
# shared with every other check, after 100 warm-up calls. Measured over ten runs here, that
# environment gives p50 100-115 us and p99 230-430 us -- and a 540 us p99 was observed once, which
# is what tripped the 500 us bar.
#
# So the accept bar sits INSIDE this environment's noise band, and no window length fixes it:
# p99 at a 400 ms window spanned 230-430 us and at a 3 s window 265-390 us. The spread is
# run-to-run variance, not a short-window artifact, which was the first and wrong diagnosis.
#
# p50, measured in the same ten runs, spanned 100-115 us -- 15 us of spread against p99's 200.
# A regression that doubles channel latency doubles p50, so a 200 us p50 bar catches it with 1.7x
# margin over observed noise, and catches it MORE reliably than a 500 us p99 bar would. The loose
# p99 ceiling is there for a tail blow-up: the kernel-stall control drives every percentile to
# 29,673 us, so it clears 1,000 us by 30x.
#
# The 500 us accept bar is still verified, by the sweep that produced it --
# bench/syscall-contention/probe.py --n 1,4,16,64,128 --runs 3 -- and that is the right place for
# it, because it is the protocol the number came from. A suite check cannot assert a controlled
# measurement's bar in an uncontrolled environment; trying to is what produced the flake.


@check(
    name="syscall",
    milestone="m0",
    controls=(Control.INVERT, Control.NO_ISOLATION, Control.KERNEL_STALL),
    # Every term of the inventory is fixed by SYSCALL_LABELS and not by what the page produced, so
    # a cell that reported nothing records failing expectations rather than passing on an empty
    # object.
    labels=SYSCALL_LABELS,
    requires_isolation=True,
    root=Root.REPO,
    document=SYSCALL_DOCUMENT,
    ready_expr=SYSCALL_READY,
    ready_what="globalThis.M0.state reaching done, aborted or error (www/m0.html:297, :121)",
    # The cell itself, not a render: 400 ms of window plus warm-up normally, and ~4 s under
    # --negative kernel-stall where every call costs 2 ms. Bounded, because a wedged kernel must
    # end as a BROKEN check with a reason and not as a suite that never returns.
    ready_timeout=90.0,
    refusal_expr="globalThis.M0 && globalThis.M0.state",
    refusal_want="aborted",
    note="negative controls: --negative kernel-stall installs a 2 ms synchronous stall in the "
         "kernel handler (src/kernel/kernel.mjs:513-516) and must turn 'p99 under the accept bar' "
         "red with every other expectation in the inventory intact - M0's own negative control, "
         "made re-runnable; "
         "--negative no-isolation must come out BROKEN, because SharedArrayBuffer does not exist "
         "there and the measurement cannot be taken at all. The decision sweep itself is "
         "bench/syscall-contention/probe.py --n 1,4,16,64,128 --runs 3, which this check does not "
         "re-run",
    control_address="bench/syscall-contention/probe.py --n 16 --window-ms 2600 --warmup 100 "
                    "--stall-us 2000 --force-not-equal",
)
def check_syscall(env: Env) -> None:
    accept_bar = bar_us("accept_p99_us")
    p50_bar = bar_us("suite_p50_regression_us")
    p99_ceiling = bar_us("suite_p99_tail_us")
    got = env.read(READ_SYSCALL, SYSCALL_SHAPE)

    if got["state"] != "done":
        # The page refused or threw, so no figure exists. BROKEN, never a FAIL: a FAIL claims a
        # measurement was taken and found wanting. --negative no-isolation declares this outcome.
        env.unmeasurable(
            "www/m0.html reached state %r rather than 'done' after %.1fs, so no cell was "
            "produced and nothing below was measured: %s%s"
            % (got["state"], env.ready_wait_s, got["why"] or "no reason given",
               (" errors: %s" % "; ".join(got["errors"])) if got["errors"] else ""))

    # Anti-vacuity, and it comes first: every figure below is read off exactly one cell, and the
    # bench reports INVALID rather than a number whenever it could not stand behind one.
    env.note("the page reported %d cell(s), %d of them INVALID: %s. Faults: %s"
             % (got["cells"], len(got["invalid"]), "; ".join(got["invalid"]) or "none",
                "; ".join(got["faults"]) or "none"))
    env.expect("cell reported", (got["cells"], len(got["invalid"])), (1, 0))
    cell = got["cell"]
    if cell is None:
        env.unmeasurable(
            "the page produced %d cell(s) and %d of them are INVALID (%s), so there is no figure "
            "to read. The bench refuses to report a number it cannot stand behind."
            % (got["cells"], len(got["invalid"]), "; ".join(got["invalid"]) or "no reason given"))

    account = cell["accounting"]

    # Isolation, from the realm rather than from a self-report, in both agents. The kernel's own
    # answer is the one that matters: a page that is isolated while its worker is not has no
    # blocking channel at all (constraints 1 and 10).
    env.expect("page isolated", got["isolated"], True)
    env.expect("kernel isolated", got["kernelIsolated"], True)
    # One ABI, imported by the page, the kernel and every process. Two hand-synced copies across
    # the kernel boundary is the defect the convention in CLAUDE.md exists for, and a fingerprint
    # that agrees because all three are empty is not agreement.
    env.expect_that(
        "abi fingerprint agrees",
        bool(got["pageFingerprint"]) and cell["fingerprintsAgree"],
        "page fingerprint %r, and the page reports agreement across the kernel and every process "
        "as %r" % (got["pageFingerprint"], cell["fingerprintsAgree"]))
    # The kernel echoes the cfg it booted with, which is how a control proves it was applied
    # rather than accepted and dropped. Read against what the URL asked for, so this holds at 0
    # on a plain run and at 2000 under --negative kernel-stall without the check branching on
    # either: a stall that never reached the handler leaves the p99 under the bar and the control
    # unsatisfied, and one that reached it and was not echoed fails here.
    env.expect("kernel applied the cfg it was handed",
               got["echoedStallUs"], got["requestedStallUs"])

    # The arithmetic BEFORE the figures it produces. summarise.mjs owns every percentile in this
    # bench and the p99 is the number M0 is reported in, so its nearest-rank walk, its printed
    # band, its withholding rule and its quantile witness are pinned against hand-computed
    # answers over two fixed vectors - the pattern agreementSelfTest() and src/abi.mjs's FNV-1a
    # vectors already set here. A percentile function nobody has checked against a known answer
    # can be swapped for a different quantile without a single bound-shaped assertion noticing.
    env.expect_that(
        "percentile known-answer vectors", got["percentileSelfTest"],
        "summarise.mjs percentileSelfTest() disagrees with its hand-computed answers on %s. Got "
        "%s" % (", ".join(got["percentileSelfTestWrong"]) or "nothing it names",
                got["percentileSelfTestDetail"]))

    # The smallest end-to-end claim M0 owes, per process and not in aggregate: this pid was
    # allocated by the kernel, and the getpid that process issued came back as ITS OWN pid. A
    # check that accepted "a number" would pass against a kernel that replied with a constant.
    env.expect("processes reporting", sorted(cell["pids"]),
               list(range(1, got["requestedN"] + 1)))
    env.note("pids %s answered getpid with %s, and report their own pid as %s"
             % (cell["pids"], cell["firstGetpid"], cell["envPids"]))
    env.expect("getpid returns each process's own pid",
               tuple(cell["firstGetpid"]), tuple(cell["pids"]))
    # THE THIRD SOURCE, and the only one outside the kernel. The two above are the kernel's table
    # and the kernel's reply, so comparing them compares the kernel with itself: a kernel that
    # hands every process the pid 1 at spawn and still answers getpid correctly passes both. This
    # is env.pid, what the program is handed and what M1's getppid, setpgid and signal delivery
    # will all inherit.
    env.expect("each process's self-reported pid",
               tuple(cell["envPids"]), tuple(cell["pids"]))
    # The same claim over every call in the window instead of over one named round trip: loop.mjs
    # compares each reply against its own env.pid as it goes, so this is ~70,000 comparisons.
    env.expect_that(
        "every windowed call returned the right answer", cell["windowWrong"] == 0,
        "%s of %s calls in the window returned something other than what the caller asked for "
        "(for call=getpid that is the caller's own pid)"
        % (cell["windowWrong"], cell["count"]))

    # issued == dispatched == replied == returned, counted twice in each agent. The order matters:
    # an identity over four zeros holds, so the sample count is asserted first.
    env.expect_that(
        "calls issued", account["issued"] > 0,
        "the cell recorded %d issued calls, and an identity over zeros would hold vacuously"
        % account["issued"])
    env.expect("accounting identity",
               (account["dispatched"], account["replied"], account["returned"],
                account["identity"]),
               (account["issued"], account["issued"], account["issued"], True))
    quiet = dict((name, account[name]) for name in QUIET_COUNTERS)
    env.expect("no error or lost-reply path", quiet, dict((name, 0) for name in QUIET_COUNTERS))
    # A percentile over samples the histogram could not represent is not that percentile.
    env.expect("histogram represents every sample", account["beyondTop"], 0)

    # Constraint 7: a notify that wakes nobody returns "not-equal" from Atomics.wait, and that is
    # the ABSENCE of a park, not an error. Forced rather than waited for - the natural rate is
    # 0.1-0.3% of calls - and asserted three ways: it was reached, the reply it returned was the
    # right one, and both sides of the boundary counted the same event.
    forced = cell["forced"]
    env.note("forced not-equal probes: %s" % forced)
    env.expect_that(
        "not-equal fast path reached",
        len(forced) == FORCED_PROBES and any(f["notEqual"] for f in forced),
        "%d of %d probes took it (loop.mjs:183 forces %d). Each posts, busy-spins 5 ms without "
        "yielding so the reply is certainly published, then parks: a kernel whose reply never "
        "lands inside the spin reaches none of them, and so does a stub that treats not-equal as "
        "an error" % (sum(1 for f in forced if f["notEqual"]), len(forced), FORCED_PROBES))
    env.expect("not-equal returned the reply, not an error",
               tuple(f["r0"] for f in forced), (cell["forcedPid"],) * FORCED_PROBES)
    env.expect_that(
        "not-equal counted on both sides",
        account["notEqual"] >= 1 and account["notify0"] >= 1,
        "the processes tallied %d not-equal wakes and the kernel tallied %d notifies that woke "
        "nobody; these are two counters over one event and neither may read zero while the other "
        "does not" % (account["notEqual"], account["notify0"]))

    # Was the kernel actually loaded while the figure was taken? An unsaturated kernel produces a
    # perfectly respectable p99 that says nothing about contention, which is the whole failure
    # mode this cell exists to avoid.
    # Read as the latch's two numbers and not as the boolean alone: `saturated` means "N calls
    # were outstanding at once" only if the hand-over it reports was armed at N and fired at a
    # depth of at least N. A kernel that latched on the first dispatch sets the same flag, keeps
    # every figure plausible at this N, and leaves A8 asserting a comment.
    env.expect("kernel reached N outstanding calls",
               (cell["saturated"], (cell["latch"] or {}).get("target"),
                (cell["latch"] or {}).get("depth", -1) >= cell["n"]),
               (True, cell["n"], True))
    # The depth device's own bound, and an exact one: N processes with one outstanding call each
    # cannot put more than N in flight, so a value above N is the instrument lying rather than
    # contention being high. Every other depth clause is a lower bound, which a counter that runs
    # away to the top bin satisfies trivially while fabricating the saturation they prove.
    env.expect_that(
        "depth instrument within bounds",
        cell["depthMax"] <= cell["n"] and cell["depthP50"] <= cell["n"],
        "depth_max %s and depth_p50 %s against N=%s. Above N is impossible by construction, so "
        "this is an instrument fault and not a measurement"
        % (cell["depthMax"], cell["depthP50"], cell["n"]))
    rows = dict((row["name"].split()[0], row) for row in cell["gates"])
    env.note("the page's anti-vacuity gates: %s"
             % "; ".join("%s %s [%s]" % (row["name"], "ok" if row["ok"] else "FAIL",
                                         "n/a" if not row["evaluated"] else row["detail"])
                         for row in cell["gates"]))
    absent = [name for name in CONCURRENCY_GATES if name not in rows]
    failed = ["%s (%s)" % (rows[name]["name"], rows[name]["detail"])
              for name in CONCURRENCY_GATES if name in rows
              and not (rows[name]["ok"] and rows[name]["evaluated"])]
    env.expect_that(
        "concurrency gates", not absent and not failed,
        "absent from the page's gate rows: %s. Evaluated and failing, or not evaluated at all: "
        "%s. depth_p50 %s of N=%s, depth_max %s over %s calls"
        % (", ".join(absent) or "none", "; ".join(failed) or "none", cell["depthP50"],
           cell["n"], cell["depthMax"], cell["count"]))

    # The latency statement, and the bar is read from the file the bench reads it from.
    env.expect("page and harness read the same accept bar", got["acceptBarUs"], accept_bar)
    # And the same quantile. The bench reads one constant at both of its percentile call sites;
    # this says which constant that has to be, so "the p99" cannot quietly become some other
    # quantile reported under the same name.
    env.expect("page and harness read the same headline quantile",
               (cell["p99Quantile"], (cell["p99Witness"] or {}).get("q")),
               (HEADLINE_QUANTILE, HEADLINE_QUANTILE))
    env.expect("clock fine enough to describe the channel", cell["quantumOk"], True)
    env.expect_that(
        "p99 printable", cell["p99Us"] is not None,
        "the page withheld it: %s (%s). summarise.mjs withholds a p99 below 1,000 samples or "
        "below three clock quanta rather than printing a number it cannot stand behind, and a "
        "withheld p99 is not evidence either way" % (cell["p99Text"], cell["p99Why"]))
    # THE HEADLINE FIGURE, CHECKED BY COUNTING, because this is the number the milestone is
    # reported in and nothing else here would notice it being replaced. The witness is
    # estimator-free: more than (1-q) of the pooled samples must lie at or above the printed
    # value and no more than (1-q) strictly above it, which is true of the q-quantile of any
    # distribution. A figure computed at a lower quantile fails the second clause - and no bound
    # on the value can catch that, because a lower quantile of a tight distribution is a perfectly
    # plausible number and can even equal the right one under the stall control.
    witness = cell["p99Witness"]
    env.note("the counting witness on the printed p99: %s" % witness)
    env.expect_that(
        "the headline p99 is the 99th percentile",
        witness is not None and witness["ok"],
        "p99 %s: %.4f%% of the %d pooled samples lie at or above it and %.4f%% strictly above, "
        "against a tail of %.4f%%. The second figure exceeding the tail means the printed number "
        "sits lower in the distribution than q=%s - it is some other quantile under this one's "
        "name" % ((cell["p99Text"], witness["atOrAbove"] * 100, cell["count"],
                   witness["above"] * 100, witness["tail"] * 100, witness["q"])
                  if witness is not None
                  else (cell["p99Text"], 0.0, cell["count"], 0.0, 0.0, HEADLINE_QUANTILE)))
    # The two renderings of one quantile, against each other. The pooled q-quantile cannot exceed
    # the largest per-process q-quantile: if every process has at most (1-q) of its samples above
    # X then so does the pool. Exact, not a tolerance - and it is what catches the per-process
    # column being read at a different quantile from the headline.
    env.expect_that(
        "pooled p99 within the worst per-process p99",
        cell["p99Us"] is not None and cell["p99Us"] <= cell["worstP99Us"],
        "pooled p99 %s against the worst per-process p99 of %.1f us at the same quantile. The "
        "pooled figure cannot be the higher of the two, so the two columns are not the same "
        "statistic" % (cell["p99Text"], cell["worstP99Us"]))
    env.note("mean %.2f us, p99 %s over %d calls at N=%s, worst per-process p99 %.1f us, kernel "
             "in-handler mean %.2f us, clock quantum %.3f us"
             % (cell["meanUs"], cell["p99Text"], cell["count"], cell["n"], cell["worstP99Us"],
                cell["serviceMeanUs"], cell["quantumUs"]))
    # The tight bar is on p50, because p50 is the statistic this environment can measure
    # repeatably: 100-115 us over ten runs, against p99's 230-430. See the note above bar_us().
    env.expect_that(
        "p50 under the regression bar",
        cell["p50Us"] is not None and cell["p50Us"] < p50_bar,
        "p50 %.1f us against the %g us regression bar in %s. This is N=%s over %s calls. p50 is "
        "the bar-bearing statistic here because it is stable to +/-15 us in this environment, so a "
        "regression that doubles channel latency trips this with margin. The 500 us ACCEPT bar "
        "belongs to the sweep, which measures one fresh browser per cell over three runs"
        % (cell["p50Us"] or -1, p50_bar, _relative(BARS_JSON), cell["n"], cell["count"]))
    env.expect_that(
        "p99 under the tail ceiling",
        cell["p99Us"] is not None and cell["p99Us"] < p99_ceiling,
        "p99 %s against the %g us tail ceiling in %s. This is deliberately loose: p99 spans "
        "230-430 us run to run in a shared browser, so a bar near the 500 us accept figure sits "
        "inside the noise. What this clause catches is a tail blow-up - the kernel-stall control "
        "drives every percentile to 29,673 us and clears this by 30x"
        % (cell["p99Text"], p99_ceiling, _relative(BARS_JSON)))

    # From outside the page entirely: the response that carried the document, as the server
    # recorded it on the wire, and the bytes it served against this tree.
    document = env.request(env.document)
    env.expect("document COOP", document.headers.get("Cross-Origin-Opener-Policy"),
               "same-origin")
    env.expect("document COEP", document.headers.get("Cross-Origin-Embedder-Policy"),
               "require-corp")
    env.expect_that(
        "served m0.html", env.served_matches_disk(env.document),
        "the bytes served differ from www/m0.html on disk, so this run measured something other "
        "than this tree")

    env.shoot("syscall")


#: Everything check_m1 reads, in one round trip. The five proofs each carry an `ok` and an
#: `evidence` object; the evidence is read back into the failure message rather than summarised in
#: the page, so a failing proof says what it saw and not merely that it failed.
READ_M1 = """(() => {
  const M = globalThis.M1 || {}
  const p = M.proofs || {}
  const one = (x) => x === null || x === undefined
    ? null : { ok: x.ok === true, evidence: JSON.stringify(x.evidence || {}) }
  return {
    state: String(M.state || ''),
    why: String(M.why || ''),
    verdict: String(M.verdict || ''),
    isolated: M.isolated === true,
    kernelIsolated: M.kernelIsolated === true,
    fingerprint: String(M.pageFingerprint || ''),
    cfg: JSON.stringify(M.config || {}),
    faults: (M.faults || []).map((f) => String(f.pid) + ': ' + String(f.why)),
    errors: (M.errors || []).map(String),
    proof_a: one(p.proof_a), proof_b: one(p.proof_b), proof_c: one(p.proof_c),
    proof_d: one(p.proof_d), proof_e: one(p.proof_e),
  }
})()"""

M1_SHAPE = {
    "state": str, "why": str, "verdict": str, "isolated": bool, "kernelIsolated": bool,
    "fingerprint": str, "cfg": str, "faults": list, "errors": list,
}

M1_DOCUMENT = "/www/m1.html"

#: The page's own terminal state. 'aborted' is the isolation refusal and 'error' is a page that
#: threw; both are terminal and which one it was is the check body's business, not the runner's.
M1_READY = ("(() => { const s = globalThis.M1 && globalThis.M1.state; "
            "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")


@check(
    name="m1",
    milestone="m1",
    controls=(Control.INVERT, Control.NO_ISOLATION, Control.NO_SIGPEND),
    # Fixed by M1_LABELS, not by what the page produced: a page that ran no proof records five
    # failing expectations rather than passing on an absent object.
    labels=M1_LABELS,
    requires_isolation=True,
    root=Root.REPO,
    document=M1_DOCUMENT,
    ready_expr=M1_READY,
    ready_what="globalThis.M1.state reaching done, aborted or error (www/m1.html)",
    # Five proofs, each booting its own kernel so one cannot carry state into another, and proof
    # (d) deliberately waits out a kernel death. Bounded, because a wedged kernel must end as a
    # BROKEN check with a reason rather than a suite that never returns.
    ready_timeout=120.0,
    refusal_expr="globalThis.M1 && globalThis.M1.state",
    refusal_want="aborted",
    note="negative controls: --negative no-sigpend removes the SIGPEND check at syscall entry, "
         "which must turn proof (e) red - a signal raised on a parked process must stop being "
         "seen - while every other proof holds; --negative no-isolation must come out BROKEN, "
         "because the kernel's SAB does not exist there and no proof can be taken at all",
)
def check_m1(env: Env) -> None:
    got = env.read(READ_M1, M1_SHAPE)

    if got["state"] == "error":
        env.unmeasurable(
            "www/m1.html reported state 'error' before producing proofs: %s. Nothing below was "
            "measured." % (got["why"] or "no reason given"))
    if got["state"] != "done":
        env.unmeasurable(
            "www/m1.html reached state %r rather than 'done' though the runner waited %.1fs, so "
            "no proof completed." % (got["state"], env.ready_wait_s))

    # Anti-vacuity first: a page that produced no cell cannot have proved anything, and a fault
    # means N processes became N-1 while the proofs were being taken.
    env.expect("cell reported", (got["verdict"] != "", len(got["faults"])), (True, 0))
    if got["faults"]:
        env.note("process faults during the proofs: %s" % "; ".join(got["faults"]))
    if got["errors"]:
        env.note("page errors: %s" % "; ".join(got["errors"]))

    env.expect("page isolated", got["isolated"], True)
    env.expect("kernel isolated", got["kernelIsolated"], True)
    env.expect_that("abi fingerprint published", bool(got["fingerprint"]),
                    "the page published no ABI fingerprint, so there is nothing to say the page "
                    "and the kernel agree about the ABI")

    # The four proofs M1 owes, plus (e) for the signal path the no-sigpend control is named for.
    # Each is read as its own expectation so a control can be scored on WHICH one moved.
    for name in ("proof_a", "proof_b", "proof_c", "proof_d", "proof_e"):
        p = got[name]
        if p is None:
            env.expect_that("%s ok" % name, False,
                            "%s never ran, so its claim is untested" % name)
            continue
        env.expect_that("%s ok" % name, p["ok"],
                        "%s failed; the page's own evidence: %s" % (name, p["evidence"]))

    # Proof (d) owes a NUMBER, not just a pass: constraint 56 sets the bound at
    # REARM_MS x (HB_MISS_LIMIT + 1) and M0 measured -EIO at 168-189 ms against it. A proof that
    # passed while taking 10 s would be a different claim.
    d = got["proof_d"]
    env.expect_that(
        "proof_d within bound", d is not None and d["ok"] and "ms" in d["evidence"],
        "proof (d) must report the milliseconds from kernel death to -EIO so the 200 ms bound in "
        "constraint 56 is checked against a figure rather than asserted. Evidence: %s"
        % (d["evidence"] if d else "proof did not run"))

    env.expect("verdict is ok", got["verdict"], "ok")
    env.note("config: %s" % got["cfg"])

    document = env.request(env.document)
    env.expect("document COOP", document.headers.get("Cross-Origin-Opener-Policy"),
               "same-origin")
    env.expect("document COEP", document.headers.get("Cross-Origin-Embedder-Policy"),
               "require-corp")
    env.expect_that(
        "served m1.html", env.served_matches_disk(M1_DOCUMENT),
        "the bytes served for %s differ from the file on disk, so this run measured something "
        "other than this tree" % M1_DOCUMENT)

    env.shoot("m1")


#: Everything check_m2 reads, in one round trip. The three proofs carry an `ok` and an `evidence`
#: object; the evidence crosses as a real object rather than a JSON string, because this check
#: asserts on individual clauses inside it — a control is scored on WHICH clause moved, and a
#: string would make every clause one label.
READ_M2 = """(() => {
  const M = globalThis.M2 || {}
  const p = M.proofs || {}
  const one = (x) => x === null || x === undefined
    ? null : { ok: x.ok === true, evidence: x.evidence || {} }
  return {
    state: String(M.state || ''),
    why: String(M.why || ''),
    verdict: String(M.verdict || ''),
    isolated: M.isolated === true,
    kernelIsolated: M.kernelIsolated === true,
    fingerprint: String(M.pageFingerprint || ''),
    cfg: JSON.stringify(M.config || {}),
    faults: (M.faults || []).map((f) => String(f.pid) + ': ' + String(f.why)),
    errors: (M.errors || []).map(String),
    proof_a: one(p.proof_a), proof_b: one(p.proof_b), proof_c: one(p.proof_c),
    proof_d: one(p.proof_d), pending: one(p.pending), drop: one(p.drop),
    cas: one(p.cas), orphan: one(p.orphan),
    refuse: one(p.refuse), unreadable: one(p.unreadable),
    append: one(p.append), order: one(p.order), api: one(p.api),
    // `later()`'s rejection count summed over every kernel the page booted, and how many of them
    // answered the read. Numbers rather than a section, because this is a property of every
    // section at once.
    asyncFail: Number(M.asyncFail),
    statsReads: Number(M.statsReads),
  }
})()"""

M2_SHAPE = {
    "state": str, "why": str, "verdict": str, "isolated": bool, "kernelIsolated": bool,
    "fingerprint": str, "cfg": str, "faults": list, "errors": list,
    # Every section, declared: a page that renamed one would otherwise read as a section that
    # produced nothing, and the check would report the rename as a failed proof.
    "proof_a": (dict, type(None)), "proof_b": (dict, type(None)), "proof_c": (dict, type(None)),
    "proof_d": (dict, type(None)), "pending": (dict, type(None)),
    "drop": (dict, type(None)), "cas": (dict, type(None)),
    "orphan": (dict, type(None)),
    "refuse": (dict, type(None)), "unreadable": (dict, type(None)),
    "append": (dict, type(None)),
    "order": (dict, type(None)),
    "api": (dict, type(None)),
    "asyncFail": int, "statsReads": int,
}

def _cas_brief(row: object) -> object:
    """One process result row without its clock histogram and realm enumeration.

    A `results` row carries 200,000 clock samples' distinct values and the process's env keys. A
    failure message that pasted those would bury the four numbers the clause is about.
    """
    if not isinstance(row, dict):
        return row
    drop = ("clock", "envKeys", "envKinds", "abiFingerprint", "sinkSum", "sinkBytes",
            "sinkWrites", "isolated", "exiting", "calls", "replies", "ms")
    return {k: v for k, v in row.items() if k not in drop}


#: 10,000 is the milestone's own figure and this is the run that takes it.
M2_FILES = 10000

#: How many sections www/m2.html runs. The floor for the `statsReads` anti-vacuity clause: every
#: section boots AT LEAST one kernel and every kernel goes through `shut()`, which is where the
#: counters are read — so a run that read fewer than this did not read them all. A floor rather
#: than the exact count because several sections boot two or three.
M2_SECTIONS = 13

M2_DOCUMENT = "/www/m2.html?a_n=%d" % M2_FILES

M2_READY = ("(() => { const s = globalThis.M2 && globalThis.M2.state; "
            "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")


@check(
    name="m2",
    milestone="m2",
    controls=(Control.INVERT, Control.NO_ISOLATION, Control.NO_COW_ORDER, Control.NO_CRC),
    # Fixed by M2_LABELS, not by what the page produced: a page that ran no proof records
    # twenty-nine failing expectations rather than passing on an absent object.
    labels=M2_LABELS,
    requires_isolation=True,
    root=Root.REPO,
    document=M2_DOCUMENT,
    # The inversion phase asks whether every expectation this check records inverts and fires,
    # and that answer does not depend on proof (a)'s file count — but the 10,000-file write made
    # the phase cost 73 s of the page's own 300 s per-run budget, and hit it one run in two. See
    # Check.invert_query; audit rule 15 is what stops this becoming a way to disarm the mode.
    invert_query=(("a_n", str(M2_CONTROL_FILES)),),
    ready_expr=M2_READY,
    ready_what="globalThis.M2.state reaching done, aborted or error (www/m2.html)",
    # 10,000 files is 10,000 opens at 495 us plus 10,000 flushes at 260 us by construction
    # (constraints 22 and 23), and the measured end-to-end figure for all three proofs is 78.4 s.
    # The bound is generous against a shared browser and is still a BOUND: a wedged kernel must
    # end as a BROKEN check with a reason rather than a suite that never returns.
    ready_timeout=420.0,
    refusal_expr="globalThis.M2 && globalThis.M2.state",
    refusal_want="aborted",
    note="thirteen sections: the milestone's three proofs, (d) two concurrent WRITERS on one "
         "inode, an outstanding append under another description's commit, what close() reports "
         "and what it leaves behind, the commit's compare-and-swap under five shapes of lost race, "
         "a staged generation a crash left behind, a mount that must REFUSE a volume whose three "
         "superblock slots are all corrupt, a mount whose slot READ refuses because the page "
         "turned the slot name into a directory — read-only on one slot, refuse on all three, and "
         "never a first boot — O_APPEND per write, and the storage edge's own trace for "
         "constraints 23 and 24. Page-wide: the note channel, and `later()`'s async-completion "
         "rejection count summed over every kernel the page boots. "
         "negative controls, two stages and the second is the point: --negative no-cow-order "
         "drops the commit's data-before-metadata ordering, which must make fsck report "
         "corruption while every metadata clause holds; --negative no-crc then removes the "
         "journal's checksum and the torn-journal clauses must START PASSING a bad image, with "
         "the TRUNCATED tear still held because the length check is a different guard. "
         "--negative no-isolation must come out BROKEN: the kernel's SAB does not exist there, so "
         "no filesystem is mounted and no proof can be taken.",
)

def check_m2(env: Env) -> None:
    got = env.read(READ_M2, M2_SHAPE)

    if got["state"] == "error":
        env.unmeasurable(
            "www/m2.html reported state 'error' before producing proofs: %s. Nothing below was "
            "measured." % (got["why"] or "no reason given"))
    if got["state"] != "done":
        env.unmeasurable(
            "www/m2.html reached state %r rather than 'done' though the runner waited %.1fs, so "
            "no proof completed." % (got["state"], env.ready_wait_s))

    # Anti-vacuity first: a page that produced no verdict cannot have proved anything, and a fault
    # means a process died while the proofs were being taken.
    env.expect("cell reported", (got["verdict"] != "", len(got["faults"])), (True, 0))
    if got["faults"]:
        env.note("process faults during the proofs: %s" % "; ".join(got["faults"]))
    if got["errors"]:
        env.note("page errors: %s" % "; ".join(got["errors"]))

    env.expect("page isolated", got["isolated"], True)
    env.expect("kernel isolated", got["kernelIsolated"], True)
    env.expect_that("abi fingerprint published", bool(got["fingerprint"]),
                    "the page published no ABI fingerprint, so there is nothing to say the page "
                    "and the kernel agree about the ABI")
    # THE NOTE CHANNEL, ACROSS EVERY SECTION, and it is an EXPECTATION rather than the env.note()
    # above because of what the note-only version cost. A note is a storage refusal nobody is
    # awaiting; the case it exists for is a commit refused inside a process's teardown, where there
    # is no caller to return an errno to. For six rounds it was printed beside the other logs and
    # asserted nowhere, and a workload that destroyed 3 of 12 acknowledged writes said so in a note
    # every time while the suite passed and fsck reported the volume clean.
    #
    # ZERO IS NOW THE MEASURED NORMAL, which is what makes the clause affordable: the page emitted
    # 38 notes before operations on one inode were serialized - every one a commit that lost its
    # base four times and was refused under EBUSY - and emits none now, at 60, 200 and 10,000
    # files. The sections that deliberately provoke a refusal (the compare-and-swap under
    # contention, the torn journal, the refused mount, the planted orphan) are all inside that
    # figure.
    io_notes = [e for e in got["errors"] if e.startswith("io: ")]
    env.expect_that(
        "the storage edge raised no note in any section", not io_notes,
        "%d note(s) reached the page. A note is a failure with no caller to return to, so an "
        "unasserted one is a failure only a human reading logs can find: %s"
        % (len(io_notes), json.dumps(io_notes[:8])[:900]))

    # ---- proof (a): 10,000 files survive a reload byte- and mode-intact -----------------
    #
    # Read clause by clause rather than as one `ok`. The ordering control leaves every metadata
    # clause standing and destroys only the data, and a check with one label per proof could not
    # have reported that difference — it would have said "proof (a) failed" and left the reader to
    # guess which half.
    a = got["proof_a"]
    ea = (a or {}).get("evidence") or {}
    env.expect_that("proof_a ok", bool(a and a["ok"]),
                    "proof (a) failed; the page's own evidence: %s" % json.dumps(ea)[:1200])
    # The count comes from the PAGE, not from M2_FILES. The two controls drop `a_n` to 400 and a
    # check that compared against the headline figure would fail under them for the wrong reason —
    # and a check that read its own control flag to decide what to expect could branch on it.
    env.expect_that(
        "proof_a wrote every file",
        ea.get("written") == ea.get("n") and (ea.get("n") or 0) > 0,
        "%s of %s files were created; errors: %s"
        % (ea.get("written"), ea.get("n"), json.dumps(ea.get("writeErrors"))[:600]))
    env.note("proof (a): %s files, %s B, %s ms to write and %s ms to verify"
             % (ea.get("n"), ea.get("bytes"), ea.get("wroteMs"), ea.get("verifyMs")))
    env.expect_that(
        "proof_a every byte survived the reload",
        ea.get("bytesOk") == ea.get("n") and ea.get("checked") == ea.get("n"),
        "%s of %s files read back byte-identical after the remount; the verifier recomputes the "
        "expected bytes from the index rather than being handed them. First mismatches: %s"
        % (ea.get("bytesOk"), ea.get("n"), json.dumps(ea.get("verifyErrors"))[:600]))
    env.expect_that(
        "proof_a every mode bit survived the reload", ea.get("modesOk") == ea.get("n"),
        "%s of %s files came back with the mode they were created with. POSIX metadata lives "
        "outside OPFS (constraint 25), so a lost mode is a lost snapshot or a lost journal record"
        % (ea.get("modesOk"), ea.get("n")))
    env.expect("proof_a mounted read-write both times",
               (ea.get("mode1"), ea.get("mode2")), ("rw", "rw"))
    lock = ea.get("bootLock") or {}
    env.expect_that(
        "proof_a boot lock taken inside its budget",
        bool(lock.get("ok")) and lock.get("waitedMs", 1e9) <= ea.get("bootLockBudgetMs", 0),
        "constraint 48: the second kernel races the first's journal handle, so the lock must "
        "RETRY rather than declare another tab. Taken=%s after %s ms and %s attempt(s) against a "
        "%s ms budget; why=%r. A boot lock that gave up here brings a normal reboot up read-only "
        "at random" % (lock.get("ok"), lock.get("waitedMs"), lock.get("attempts"),
                       ea.get("bootLockBudgetMs"), lock.get("why")))
    env.expect_that(
        "proof_a fsck clean after the reload", ea.get("fsckClean") is True,
        "an explicit fsck over the remounted volume, blob sweep included, must find nothing. It "
        "reported: %s" % json.dumps(ea.get("fsckProblems"))[:900])
    env.expect_that(
        "proof_a fsck wrote nothing",
        ea.get("fsckWrote") is False and ea.get("fsckBefore") == ea.get("fsckAfter"),
        "constraint 28: fsck must never reseed. src/fs/fsck.mjs holds no handle and no root "
        "directory, so there is no object there a write could go through — asserted anyway, "
        "against the superblock generation and slot before and after: %s -> %s, wrote=%s"
        % (ea.get("fsckBefore"), ea.get("fsckAfter"), ea.get("fsckWrote")))
    blobs = ea.get("fsckBlobs") or {}
    env.expect_that(
        "proof_a blob sweep accounts for every file",
        bool(blobs.get("swept")) and blobs.get("have") == blobs.get("want")
        and not blobs.get("missing") and not blobs.get("short") and not blobs.get("long"),
        "the flat blob directory (constraint 26) must hold exactly one blob per committed file, "
        "each EXACTLY the size the metadata publishes. Shorter is torn data behind whole "
        "metadata; longer is uncommitted slack, which is permitted on a volume a crash "
        "interrupted and is not permitted here — every description on this volume closed, and a "
        "close publishes the extent. Swept=%s, have %s of %s wanted, %s missing, %s short, %s "
        "long: %s %s"
        % (blobs.get("swept"), blobs.get("have"), blobs.get("want"),
           len(blobs.get("missing") or []), len(blobs.get("short") or []),
           len(blobs.get("long") or []),
           json.dumps(blobs.get("short"))[:400], json.dumps(blobs.get("long"))[:400]))

    # ---- proof (b): a journal truncated mid-record -------------------------------------
    b = got["proof_b"]
    eb = (b or {}).get("evidence") or {}
    env.expect_that("proof_b ok", bool(b and b["ok"]),
                    "proof (b) failed; the page's own evidence: %s" % json.dumps(eb)[:1200])
    # One label per tear, because each is caught by a DIFFERENT guard and the CRC control must be
    # scored on exactly the two it removes.
    for shape, label, guard in (
        ("b1", "proof_b1 truncated tail reported", "the record's LENGTH check"),
        ("b2", "proof_b2 zero-padded tail reported", "the record's CRC"),
        ("b3", "proof_b3 flipped mode field reported", "the record's CRC"),
    ):
        tear = eb.get(shape) or {}
        env.expect_that(
            label,
            tear.get("reported") is True and tear.get("accepted") is False
            and (tear.get("discardedBytes") or 0) > 0,
            "%s: replay must stop and REPORT the discarded tail rather than reseeding "
            "(constraint 28). This tear is caught by %s. Got stopped=%r, %s byte(s) discarded, "
            "accepted=%r, %s record(s) replayed, %s applied, mount %r"
            % (shape, guard, tear.get("stopped"), tear.get("discardedBytes"),
               tear.get("accepted"), tear.get("records"), tear.get("applied"), tear.get("mode")))
    env.expect_that(
        "proof_b nothing was reseeded",
        all(not (eb.get(s) or {}).get("reseeded", True) for s in ("b1", "b2", "b3")),
        "webxp reset on a bad image and that is silent data loss presented as success. Measured "
        "against the inode count and the superblock generation across the tear: %s"
        % json.dumps({s: {k: (eb.get(s) or {}).get(k)
                          for k in ("inodesBefore", "inodesNow", "generationBefore",
                                    "generationNow", "reseeded")}
                      for s in ("b1", "b2", "b3")})[:700])
    env.expect_that(
        "proof_b a torn journal mounts read-only",
        all((eb.get(s) or {}).get("mode") == "ro" for s in ("b1", "b2", "b3")),
        "constraint 28: a snapshot that fails validation mounts READ-ONLY and surfaces the "
        "failure. Got %s"
        % json.dumps({s: (eb.get(s) or {}).get("mode") for s in ("b1", "b2", "b3")}))
    env.expect_that(
        "proof_b the user's file kept a mode somebody wrote",
        all((eb.get(s) or {}).get("victimKeptCreateMode") is True
            and (eb.get(s) or {}).get("victimMadeUp") is False
            for s in ("b1", "b2", "b3")),
        "THE CLAIM ABOUT THE FILE rather than about the parser. The chmod in the discarded tail "
        "was never applied, so %s must read back with the mode it was created with. Got %s"
        % (((eb.get("b3") or {}).get("victim")),
           json.dumps({s: (eb.get(s) or {}).get("victimMode") for s in ("b1", "b2", "b3")})))

    # ---- proof (c): two concurrent opens of one file both succeed ----------------------
    c = got["proof_c"]
    ec = (c or {}).get("evidence") or {}
    env.expect_that("proof_c ok", bool(c and c["ok"]),
                    "proof (c) failed; the page's own evidence: %s" % json.dumps(ec)[:1200])
    env.expect_that(
        "proof_c two concurrent opens both succeeded", ec.get("bothOpened") is True,
        "constraint 47: a sync access handle is an exclusive lock per file, so a second open "
        "throws NoModificationAllowedError unless the handles are refcounted per inode BENEATH "
        "the fd table. `cat notes.txt | wc -l` must not fail while an editor holds the file. "
        "holder=%s second=%s" % (json.dumps(ec.get("holder")), json.dumps(ec.get("second"))))
    env.expect_that(
        "proof_c both readers saw the committed bytes", ec.get("sameBytes") is True,
        "both openers must read the committed generation, not an empty or a half-written one. "
        "Wanted checksum %s; holder saw %s and the second saw %s"
        % (ec.get("wantSum"), (ec.get("holder") or {}).get("sum"),
           (ec.get("second") or {}).get("sum")))
    env.expect_that(
        "proof_c a later opener saw the new generation", ec.get("newBytes") is True,
        "after the copy-on-write swing a NEW opener must resolve the inode's new generation. "
        "overwrite=%s, third opener=%s"
        % (json.dumps(ec.get("overwrite")), json.dumps(ec.get("thirdOpener"))))
    env.expect_that(
        "proof_c the held fd followed the swing", ec.get("heldFollowed") is True,
        "THE SAME fd, THE SAME DESCRIPTION, re-read after another process swung the inode under "
        "it. POSIX has two fds on one file sharing the FILE, not a snapshot each, so this must "
        "come back with the new generation's bytes and the new size. Against a description that "
        "cached its generation and its size at open, the read returned the SUPERSEDED "
        "generation's bytes while fstat on the same fd reported the new size - stat and read "
        "disagreeing on one descriptor with no error on either. It opened at %s and re-read %s "
        "against the overwrite's %s"
        % ((ec.get("heldAgain") or {}).get("openSize"), json.dumps(ec.get("heldAgain")),
           json.dumps(ec.get("overwrite"))))
    env.expect_that(
        "proof_c the holder outlived the other description's close",
        ec.get("outlivedTheClose") is True,
        "A SYNC ACCESS HANDLE IS AN EXCLUSIVE LOCK PER FILE, so every description on one inode "
        "rests on one handle — and the count that decides when it is released is a count of "
        "DESCRIPTIONS, which only the kernel's fd table can know. Released on the FIRST of two "
        "closes instead, the holder's next read has no handle to read through. The bytes are not "
        "asserted here, only that the fd still answers at the size the file publishes: the "
        "dropped-ordering control empties the blob and would fail a byte clause for its own "
        "reason. close of the other description %s, holder's read %s against the overwrite's %s"
        % (json.dumps(ec.get("letGo")), json.dumps(ec.get("outlived")),
           (ec.get("overwrite") or {}).get("afterSize")))
    env.expect_that(
        "proof_c the superseded generation left the directory", ec.get("supersededLeft") is True,
        "THE CONSTRAINT-47 INTERACTION, which is the hard part of the COW decision: during the "
        "swing two blobs exist for one logical file, so the REFCOUNT TABLE takes the decision and "
        "the directory only records the outcome. With the held description following the swing "
        "nothing is left reading the superseded generation, so its removal is IMMEDIATE and "
        "exactly one name must be replaced by exactly one other. The DEFERRED arm is scored in "
        "the drop section, on an unlink under an open description. gone %s, new %s, blobs %s -> "
        "%s, deferred frees %s, immediate frees %s"
        % (json.dumps(ec.get("gone")), json.dumps(ec.get("newBlobs")),
           json.dumps(ec.get("blobsBefore")), json.dumps(ec.get("blobsAfter")),
           ec.get("deferredFrees"), ec.get("immediateFrees")))

    # ---- proof (d): two concurrent WRITERS on one inode --------------------------------
    #
    # THE CONFIGURATION COPY-ON-WRITE WAS NOT ATOMIC IN, and it needed no crash. Both writers
    # write at the size the file published when THEY opened it: A's range appends past the
    # committed size and lands in place, and B's range then starts below the size A published, so
    # it must stage a new generation. Against a per-description snapshot of the committed size,
    # B's write read as an append, went into A's committed generation in place, and B's commit
    # published a size computed from the same stale base — losing A's committed bytes outright.
    d = got["proof_d"]
    ed = (d or {}).get("evidence") or {}
    env.expect_that("proof_d ok", bool(d and d["ok"]),
                    "proof (d) failed; the page's own evidence: %s" % json.dumps(ed)[:1200])
    env.expect_that(
        "proof_d two write descriptions on one inode", ed.get("bothOpened") is True,
        "constraint 47 again, in the configuration proof (c) does not reach: two processes must "
        "both hold a WRITE description on one inode, and both must see the same committed size "
        "at open. A=%s B=%s against size %s"
        % (json.dumps(ed.get("openA")), json.dumps(ed.get("openB")), ed.get("size0")))
    env.expect_that(
        "proof_d the second writer staged a new generation", ed.get("stagedNewGeneration") is True,
        "the second writer's range starts %s byte(s) below the size the first writer published, "
        "so the append-vs-copy-up test must copy up: exactly one copy-up and exactly one new "
        "blob generation on disk. copyUps %s -> %s (delta %s), new blob(s) %s. A delta of 0 is "
        "the defect: that write took the APPEND branch and overwrote committed bytes in place"
        % ((ed.get("plan") or {}).get("aLen"), ed.get("copyUpsBefore"), ed.get("copyUpsAfter"),
           ed.get("copyUps"), json.dumps(ed.get("newBlobs"))))
    env.expect_that(
        "proof_d both writers' committed bytes survived", ed.get("bothKept") is True,
        "POSIX has two fds on one file sharing the file, so BOTH writers' committed ranges must "
        "be readable through a third description. Wanted %s bytes; the reader recomputed every "
        "expectation from the plan rather than being handed it: %s"
        % (ed.get("wantSize"), json.dumps({k: (ed.get("check") or {}).get(k)
                                           for k in ("ok", "size", "wantSize", "prefixOk",
                                                     "bRangeOk", "aTailOk", "atS", "atBEnd")})))

    # ---- an outstanding append under another description's commit ----------------------
    #
    # THE STATE PROOF (d) CANNOT REACH. Both of its writers are clean when they write, so every
    # decision either of them makes happens to be made from a current base. Here the second
    # description is made dirty FIRST by an append that stages no generation, and the question
    # the whole milestone turns on is which base its NEXT decision reads: its own, or the
    # inode's.
    pend = got["pending"]
    ep = (pend or {}).get("evidence") or {}
    ep2 = ep.get("phase2") or {}
    env.expect_that("pending ok", bool(pend and pend["ok"]),
                    "the pending proof failed; the page's own evidence: %s" % json.dumps(ep)[:1400])
    env.expect_that(
        "pending the append was held back from the metadata", ep.get("pendingHeldBack") is True,
        "ANTI-VACUITY, and it is constraint 60's append exception read where the exception "
        "actually lives: the appending description must already see its own bytes, and the "
        "METADATA must not have moved - no swing and no journal record - because a crash here has "
        "to leave the intact prefix the metadata already pointed at. Either half failing means "
        "this proof never reached the state it is about: it committed something. %s"
        % json.dumps(ep.get("pend")))
    env.expect_that(
        "pending the append is visible to every description", ep.get("pendingVisible") is True,
        "THE OTHER HALF, and it asserts the OPPOSITE of what this clause used to. A FRESH "
        "description must see the appended bytes, because `pwrite` already returned a count for "
        "them and POSIX has two fds on one file sharing the file. Reporting the old size to "
        "another description is not durability - it is the stale read, and the same cache that "
        "produced it had one fd reporting fstat 40 while pread on that fd returned 8. The "
        "appending fd saw %s and a fresh description saw %s"
        % ((ep.get("pend") or {}).get("wantFdSize"), (ep.get("pend") or {}).get("freshSize")))
    env.expect_that(
        "pending the appending writer staged a new generation",
        ep.get("stagedNewGeneration") is True,
        "the appending description's next write starts %s byte(s) below the size the OTHER "
        "description published, so the append-vs-copy-up test must copy up. Exactly one copy-up: "
        "%s -> %s (delta %s). A delta of 0 IS the defect - the write took the append branch "
        "against the base this description saw at open, and landed in the committed generation "
        "in place. blobs: %s"
        % ((ep.get("plan") or {}).get("aLen"), ep.get("copyUpsBefore"), ep.get("copyUpsAfter"),
           ep.get("copyUps"), json.dumps(ep.get("blobsAfter"))))
    env.expect_that(
        "pending the committed generation was never written in place",
        ep.get("committedBytesIntact") is True,
        "THE CLAUSE THAT CATCHES IT, and it is read mid-flight because the final bytes do not: "
        "with the second writer's bytes written and NOT yet committed, a third fresh description "
        "must still read the first writer's fsynced byte at that offset. The other value there "
        "means intact metadata is pointing at overwritten data, which is the one outcome "
        "copy-on-write exists to prevent. %s"
        % json.dumps(ep.get("peek")))
    env.expect_that(
        "pending both writers' bytes survived", ep.get("bothKept") is True,
        "five ranges, every expectation recomputed by the reader from the plan: the original "
        "prefix, the second writer's range, the first writer's uncovered tail, the sparse gap "
        "which POSIX requires to read as zeroes, and the appended bytes at their own offset. "
        "Wanted %s bytes: %s"
        % (ep.get("wantSize"), json.dumps({k: (ep.get("check") or {}).get(k)
                                           for k in ("ok", "size", "wantSize", "prefixOk",
                                                     "bRangeOk", "aTailOk", "gapZeroed",
                                                     "pendingOk", "atS", "atGap", "atPend")})))
    env.expect_that(
        "pending the replay rejected nothing", ep.get("replayRejectedNothing") is True,
        "phase two: the other description's write goes BELOW the committed size, so it swings "
        "the inode onto a new generation and the appending description commits against a base "
        "that has moved. NO RECORD THE VFS WOULD REFUSE MAY REACH THE DISK, because replay must "
        "then refuse it too and every later record is discarded - the measured version of that "
        "was a mount at 'record 51 (commit) could not be applied' which threw away a mkdir that "
        "had already returned success. The commit reads its base now and validates it before "
        "publishing, so there is no refusal here to recover from; the clause is what a refusal "
        "would have cost. The mkdir issued after that commit must still resolve on the next "
        "mount, and the journal must report nothing rejected. phase two: %s. remount: %s. the "
        "directory afterwards: %s"
        % (json.dumps(ep2), json.dumps(ep.get("remount"))[:400],
           json.dumps(ep.get("dirAfterRemount"))))
    env.expect_that(
        "pending the volume still mounts read-write", ep.get("mountsReadWrite") is True,
        "the whole sequence is unprivileged userland: two opens of a file the caller owns, one "
        "write each. It must not be able to brick the volume. remount: %s"
        % json.dumps({"mode": (ep.get("remount") or {}).get("mode"),
                      "problems": (ep.get("remount") or {}).get("problems")}))
    env.expect_that(
        "pending the bytes survived the remount", ep.get("survivedRemount") is True,
        "and the bytes have to be there on the next boot, which is a different fact from the "
        "mode: the dropped-ordering control leaves this volume mounting read-write with the data "
        "gone. The same five ranges, recomputed by a process on the SECOND kernel: %s"
        % json.dumps({k: (ep.get("rereadAfterRemount") or {}).get(k)
                      for k in ("ok", "size", "wantSize", "prefixOk", "bRangeOk", "aTailOk",
                                "gapZeroed", "pendingOk")}))

    # ---- what close() reports, and what it leaves behind -------------------------------
    #
    # THE ORDINARY PATH: write, then exit without fsync. Two fds, no crash, no privilege. The
    # commit inside close() was refused and its errno discarded, so close() answered 0 after
    # losing bytes pwrite had already acknowledged — and an explicit fsck afterwards reported the
    # volume clean, because the blob's length matched the size the metadata published. Nothing in
    # the system could surface it.
    dr = got["drop"]
    edr = (dr or {}).get("evidence") or {}
    eap = edr.get("append") or {}
    eref = edr.get("refused") or {}
    eun = edr.get("unlinked") or {}
    env.expect_that("drop ok", bool(dr and dr["ok"]),
                    "the drop section failed; the page's own evidence: %s" % json.dumps(edr)[:1400])
    env.expect_that(
        "drop the append was acknowledged twice", edr.get("acknowledged") is True,
        "ANTI-VACUITY, and it is what makes the loss below a LOSS rather than a write that never "
        "happened: pwrite must return the full count at the committed size, and the appending "
        "description's own fstat must then report the longer file. A caller told four bytes were "
        "written and then told the file is the old length has been lied to once already, before "
        "any close. %s" % json.dumps(eap.get("tail")))
    env.expect_that(
        "drop close reported success", edr.get("closeReportedSuccess") is True,
        "both descriptions must close cleanly on this route: there is nothing wrong with the "
        "volume, so a non-zero close here would mean the fix had turned a silent loss into a "
        "spurious error. close(B)=%s close(A)=%s"
        % (eap.get("closeB"), eap.get("closeA")))
    env.expect_that(
        "drop the acknowledged bytes are in the file",
        edr.get("acknowledgedBytesKept") is True,
        "THE CLAUSE THE LOSS MOVED. The other description's write went BELOW the committed size, "
        "so it staged a generation and swung onto it — and the copy that filled that generation "
        "must take its length from the SOURCE BLOB, which is physically longer than the copying "
        "description had ever been told about. Asked for the copying description's own view "
        "instead, the swing published a generation the appended bytes were not in: the file came "
        "back at the original length with close() returning 0. A fresh description recomputes "
        "both ranges from the plan: %s. blobs: %s"
        % (json.dumps(eap.get("check")), json.dumps(eap.get("blobs"))))
    env.expect_that(
        "drop the volume is clean afterwards", edr.get("volumeStillClean") is True,
        "AND NOTHING COULD SURFACE THE LOSS, which is why this clause is here beside the bytes: "
        "the explicit fsck came back `rw` with no problems against the broken code too, because "
        "the blob's length matched the size the metadata published exactly. It must still come "
        "back clean now that the bytes are there — a volume that reported corruption here would "
        "mean the fix published a size over a blob that does not have it. %s"
        % json.dumps(eap.get("fsck")))
    env.expect_that(
        "drop a superseded stage is re-based, not discarded",
        edr.get("bothChangesSurvived") is True,
        "THE SECOND ROUTE: a grow staged with ftruncate, then another description writes below "
        "the committed size and swings PAST it, so the grow was copied from a base that no longer "
        "exists. BOTH changes were acknowledged — ftruncate returned 0 and the other "
        "description's fsync returned 0 — so the commit's compare-and-swap must re-copy from the "
        "new base and replay the grow onto it. The old behaviour was to refuse, report the errno "
        "from close() and discard the grow, which is honest about a loss that did not have to "
        "happen. The three ranges are checked by name, and the CAS counters are the anti-vacuity "
        "clause: a run where the base never moved would pass the bytes and prove nothing. "
        "grown=%s, swung=%s, close(C)=%s close(E)=%s, merged=%s, casRefusals=%s restages=%s "
        "exhausted=%s"
        % (json.dumps(eref.get("grown")), json.dumps(eref.get("swung")),
           eref.get("closeC"), eref.get("closeE"),
           json.dumps({k: v for k, v in (eref.get("merged") or {}).items()
                       if k in ("ok", "size", "wantSize", "read", "headOk", "middleOk",
                                "grownOk")}),
           eref.get("casRefusals"), eref.get("restages"), eref.get("casExhausted")))
    env.expect_that(
        "drop a re-staged commit left no staged blob behind",
        edr.get("noStagedBlobLeft") is True,
        "and the superseded staged generation must be FREED, because nothing will ever publish it "
        "now. Against the broken code a %s-byte blob stayed in the flat directory for the life of "
        "the volume with no inode naming it, which is a leak fsck can only report and never "
        "explain; a re-stage opens a replacement and must free what it replaced, so a leak here "
        "is now reachable from two directions. blobs %s -> %s"
        % ((edr.get("plan") or {}).get("grow"),
           json.dumps(eref.get("blobsBefore")), json.dumps(eref.get("blobs"))))
    env.expect_that(
        "drop every call on an unlinked description refuses alike",
        edr.get("refusedConsistently") is True and edr.get("closeAfterUnlinkSucceeded") is True,
        "THE THIRD ROUTE, and the decision is stated rather than implied: M2 does NOT keep an "
        "unlinked file alive until its last descriptor closes — that needs an orphan table in the "
        "VFS and a journal that can replay one — so every operation on a description whose inode "
        "is gone refuses under ONE errno, and `close` releases and succeeds. The old mix of "
        "working reads and -EIO writes was the worst of both. errnos %s, close %s"
        % (json.dumps((eun.get("row") or {}).get("errnos")), eun.get("closeU")))
    env.expect_that(
        "drop an unlinked file's blob outlived its last descriptor",
        edr.get("blobOutlivedTheUnlink") is True,
        "THE DEFERRED FREE, scored where a reference genuinely outlives the free. The unlink frees "
        "every generation, but the description still holds a handle on the committed one, so the "
        "refcount table defers the directory removal to its close — and the entry must then "
        "actually go. This is the arm proof (c) used to score before a held fd started following "
        "a swing. deferred frees %s; blobs before %s, while open %s, after the close %s"
        % (eun.get("deferredFrees"), json.dumps(eun.get("blobsBefore")),
           json.dumps(eun.get("blobsDuring")), json.dumps(eun.get("blobsAfter"))))
    ekl = edr.get("killed") or {}
    env.expect_that(
        "drop a killed writer's acknowledged bytes survive",
        edr.get("killedWriterKeptEveryByte") is True
        and edr.get("killedVolumeClean") is True,
        "THE FOURTH ROUTE: a writer KILLED holding a staged generation while a second writer "
        "contends on the same inode, twelve rounds, each with its own byte so a round whose write "
        "vanished cannot read back as a survivor on the previous round's byte. The victim's range "
        "is DISJOINT from the contender's, so nothing may legitimately overwrite it. Measured "
        "before operations on one inode were serialized: 3 of 12 acknowledged 4-byte writes "
        "destroyed, with the volume `rw` and fsck reporting no problems afterwards. All twelve "
        "must be acknowledged - a round whose pwrite failed would pass by writing nothing - and "
        "all twelve must be in the file. acknowledged=%s of %s, vanished=%s %s, clean=%s %s, "
        "stats=%s"
        % (ekl.get("acknowledged"), ekl.get("rounds"), ekl.get("vanished"),
           json.dumps(ekl.get("vanishedRounds"))[:400], edr.get("killedVolumeClean"),
           json.dumps(ekl.get("fsck")), json.dumps(ekl.get("stats"))))
    env.expect_that(
        "drop the note channel stayed silent under a killed writer",
        edr.get("killedWriterLeftNothingUnpublished") is True,
        "AND THE ONLY REPORT THAT EXISTS FOR IT MUST BE EMPTY. A process's teardown closes its "
        "fds synchronously and cannot await the answer (constraint 14's quarantine is what gives "
        "the commit time to land), so `closeFd`'s errno has no caller to return to and the note "
        "channel is the whole of the report. It carried `close of inode 22 could not publish its "
        "write: errno 8` on every lost round and nothing asserted on it: a failure only a human "
        "reading logs can find is not reported. So the kernel COUNTS notes at one exit and this "
        "reads the count - zero on a workload where nothing may be refused - together with the "
        "contender's live fd, whose every pwrite and fsync must succeed (the -EBADF came from one "
        "operation closing a superseded handle while another held its id across an await). "
        "notes=%s %s liveFdErrs=%s"
        % (ekl.get("notes"), json.dumps(ekl.get("noteTexts"))[:600],
           json.dumps(ekl.get("liveFdErrs"))[:400]))

    # ---- the commit is a compare-and-swap ---------------------------------------------
    #
    # FIVE SCENARIOS, and every one of them was a loss that reported success. The clauses are the
    # page's own, recomputed there from CAS and TWO_WRITERS rather than from the program's verdict,
    # and each scenario carries an anti-vacuity clause of its own: the CAS counters for the three
    # races, "the slack was on disk" for the slack, and two live pids for the opens.
    cs = got["cas"]
    ecs = (cs or {}).get("evidence") or {}
    env.expect_that("cas ok", bool(cs and cs["ok"]),
                    "the cas section failed; the page's own evidence: %s"
                    % json.dumps({k: _cas_brief(v) for k, v in ecs.items()})[:1600])
    for scenario, what in (
        ("base", "AN APPEND PUBLISHED UNDER A STAGED COPY-UP. fd1 writes below the committed "
                 "size, which stages a whole-file copy from the blob as it is now; fd2 then "
                 "appends AT the committed size and FSYNCS. fd1's commit then publishes a "
                 "generation copied from a base that has moved. Measured against the old code: "
                 "fd2's four fsynced bytes gone, fsync 0 for both, close 0 for both, and the "
                 "explicit fsck `rw` with `short: []` — because the surviving blob's length "
                 "matched the size the metadata published"),
        ("twostage", "TWO STAGED GENERATIONS OVER DISJOINT RANGES, each fsynced. Two staged "
                     "generations are two whole-file snapshots, so the second swing reverted the "
                     "first. POSIX has both ranges in the file: pwrite returned a count and fsync "
                     "returned 0 to both descriptions"),
        ("m4", "THE SAME RACE, READ THROUGH fstat AND SEEK_END. A dirty description answered from "
               "its own staged generation alone, so once another description published a longer "
               "file it under-reported the file and SEEK_END landed BELOW the real end — which "
               "turns the next append into an overwrite of committed bytes. Reachable without any "
               "commit race, which is why it is scored separately"),
        ("slackin", "A WRITE INSIDE THE SLACK, which is the region an uncommitted append opens: "
                    "above the published size, below how far the file's bytes now reach. It "
                    "changes bytes in the generation the inode already points at and moves "
                    "NEITHER the generation NOR the extent, so a compare-and-swap stamped "
                    "(gen, end) passed and the next staged commit reverted it. Measured: four "
                    "bytes that pwrite AND fsync both acknowledged, gone, with every call "
                    "returning 0 and fsck reporting the volume clean because the blob's length "
                    "still matched the published size. The stamp is now a per-inode MUTATION "
                    "COUNTER bumped by any change to the current generation's bytes or length, so "
                    "the CAS fires here - which is what casFired asserts"),
        ("slackwide", "THE BOUNDARY, and it is here because it is the case the OLD stamp could "
                      "see: the same three calls with the patch one byte longer, so the extent "
                      "moves and (gen, end) changed. It kept its bytes against the broken code "
                      "too. Both must pass now - if only this one does, the counter is not being "
                      "bumped by an in-place write and `slackin` is the only clause that says so"),
        ("dirtytrunc", "ONE DESCRIPTION'S read, fstat AND SEEK_END, WHICH USED TWO DIFFERENT "
                       "BASES. fd1 holds a staged generation copied from the 8-byte base; fd2 then "
                       "publishes a SHORTER file. `read` clamped to the base the copy came FROM "
                       "while `fstat` and `SEEK_END` read the extent NOW, so the same fd reported "
                       "a 4-byte file and then handed out 8 bytes with no error on either call - "
                       "the same defect the storage edge lists as fixed at seven addresses, at an "
                       "eighth. The three now come through one renderer, read at one time, and "
                       "`threeAgree` is the clause"),
    ):
        row = ecs.get(scenario) or {}
        env.expect_that(
            "cas %s keeps every acknowledged byte" % scenario, row.get("ok") is True,
            "%s. Every call must succeed, every range must be at its own offset after the commit "
            "AND after a remount, a read past the end must stop at the end, the volume must stay "
            "clean, and the moved base must actually have been CAUGHT - by the commit's "
            "compare-and-swap (casRefusals), or by a reader re-basing a stale stage before it "
            "answers (readRebases), either of which ends in a re-stage. row=%s want=%s "
            "survived=%s movedBaseWasCaught=%s clean=%s stats=%s"
            % (what, json.dumps(_cas_brief(row.get("row"))), json.dumps(row.get("want")),
               row.get("survivedTheRemount"), row.get("movedBaseWasCaught"),
               row.get("volumeClean"), json.dumps(row.get("stats"))))
    sl = ecs.get("slack") or {}
    env.expect_that(
        "cas uncommitted slack does not resurrect", sl.get("publishedSizeHeld") is True,
        "BYTES ABOVE THE PUBLISHED SIZE, planted page-side, which is the state a crash between a "
        "commit's flush and its journal record leaves. The extent was max(published size, blob "
        "length), so after the remount `stat` reported 40 over a published 8, a read returned 32 "
        "bytes nobody wrote, and the next close() published them — uncommitted bytes made durable "
        "by a reader. The published size is the only authority on what a file contains, so stat, "
        "fstat, SEEK_END, a read that ASKS for the slack, the close and the next mount must all "
        "say %s. planted=%s onDisk=%s row=%s second=%s"
        % (ecs.get("S"), json.dumps(sl.get("planted")), sl.get("slackOnDisk"),
           json.dumps(_cas_brief(sl.get("row"))), json.dumps(_cas_brief(
               (sl.get("second") or {}).get("read")))))
    env.expect_that(
        "cas fsck reports a blob longer than its published size",
        sl.get("fsckReportedTheSlack") is True,
        "AND THE SWEEP MUST SEE IT. fsck tested `onDisk < entry.size` and nothing else, so every "
        "silent failure across four rounds of attacks passed it: each one ended with a blob at "
        "least as long as its published size. The bytes stay on disk — a mount must not write — "
        "so the clause is that the sweep NAMES them and counts them reclaimable, beside the stale "
        "generations and not as a refusal to mount. blobs=%s"
        % json.dumps((sl.get("fsck") or {}).get("blobs")))
    cd = ecs.get("contend") or {}
    env.expect_that(
        "cas contention refuses only under EBUSY", cd.get("ok") is True,
        "TWO WRITERS, SIXTEEN ROUNDS EACH, posted together so their syscalls interleave at the "
        "kernel's own await points and a commit really does run out of its four attempts. A "
        "bounded retry has exactly one refusal to offer and it must arrive under its own name: "
        "every failing call here must be -EBUSY and nothing else, the volume must still mount "
        "read-write with a clean fsck, and no byte below the published size may come from anywhere "
        "but the two writers and the seed. Measured value of the errno clause: the exhaustion arm "
        "returned an errno this module never imported, so it threw a ReferenceError and the "
        "kernel's catch-all answered -EIO - a refusal under a name that says nothing about what "
        "happened, on a file that was entirely healthy. errnos=%s a=%s b=%s check=%s remount=%s "
        "stats=%s notes=%s"
        % (json.dumps(cd.get("errnos")), json.dumps(cd.get("a")), json.dumps(cd.get("b")),
           json.dumps(_cas_brief(cd.get("check"))),
           json.dumps({k: v for k, v in (cd.get("remount") or {}).items() if k != "check"}),
           json.dumps(cd.get("stats")), json.dumps(cd.get("notes"))[:400]))

    rt = ecs.get("retry") or {}
    ra = rt.get("a") or {}
    env.expect_that(
        "cas a retried fsync is never told a discarded write is durable",
        rt.get("everyAcknowledgementWasDurable") is True
        and rt.get("theRaceHappened") is True
        and rt.get("noCallerWasRefused") is True
        and rt.get("onlyEbusyRefusals") is True
        and rt.get("lastDurableValueSurvived") is True,
        "THE SAME TWO WRITERS, WITH THE CALLER DOING THE RIGHT THING ABOUT -EBUSY. A bounded "
        "compare-and-swap has one refusal to offer and the only correct response is to ask again. "
        "The exhaustion arm FREED the staged generation first, so the retry found nothing staged, "
        "took the 'nothing to publish' arm and answered 0 - a caller was told the data it had just "
        "been refused was durable, and it was not there. Measured at 13 of 200 fsyncs (6.5%%) with "
        "every retry answering 0. Every round writes a DISTINCT value, so each 0 from `fsync` is "
        "checked against the byte a fresh description reads back rather than counted, and the last "
        "acknowledged value must still be at offset 0 after the remount. THE ANTI-VACUITY CLAUSE "
        "MOVED TO THE KERNEL'S COUNTERS and the caller-side one got stronger: a commit now holds "
        "the inode across its re-stage, so the base cannot move twice under one commit, one "
        "re-stage is always enough and -EBUSY never reaches a caller. So the race must still be "
        "SHOWN (casRefusals and restages above zero - 83 of 400 commits at 200 rounds per writer) "
        "and no caller may be refused at all (casExhausted 0, refusals 0), where the same workload "
        "exhausted 13 of 200 before. a=%s refused=%s lastDurableSurvived=%s read=%s stats=%s "
        "notes=%s"
        % (json.dumps({k: ra.get(k) for k in ("ok", "rounds", "acked", "refusals",
                                              "retriesThatSaidZero", "liedTimes", "lies",
                                              "lastDurable", "close")}),
           json.dumps(ra.get("refused")),
           rt.get("lastDurableValueSurvived"),
           json.dumps(_cas_brief((rt.get("remount") or {}).get("read"))),
           json.dumps(rt.get("stats")), json.dumps(rt.get("notes"))[:300]))
    env.expect_that(
        "cas the journal's sequences are strictly consecutive",
        rt.get("seqsAreStrictlyConsecutive") is True
        and rt.get("enoughRecordsToMatter") is True
        and rt.get("replayAcceptedEveryRecord") is True,
        "AND THE JOURNAL UNDERNEATH THAT WORKLOAD, READ STRAIGHT OFF THE DISK. Three callers reach "
        "the journal append concurrently and the sequence number was allocated AFTER the append's "
        "await, so two records took the same number. Replay stops at a sequence that is not its "
        "predecessor's plus one and DISCARDS the tail - which is correct, the later records' "
        "predecessor is gone - so the duplicate threw away everything after it: measured off this "
        "workload's own disk as 443 records with a duplicated 59 at record 60, a remount that came "
        "up READ-ONLY, and 37,409 bytes of tail discarded including ops that had returned success "
        "to userland. The sequences are READ rather than inferred from the mount's verdict, "
        "because a duplicate and a skip stop replay at the same place and are different defects. "
        "The record count is the anti-vacuity clause. seqs=%s fsck=%s remount=%s"
        % (json.dumps(rt.get("journalSeqs")), json.dumps(rt.get("fsck"))[:400],
           json.dumps({k: v for k, v in (rt.get("remount") or {}).items() if k != "read"})[:400]))

    op = ecs.get("opens") or {}
    env.expect_that(
        "cas two overlapping opens of one name both succeed", op.get("ok") is True,
        "CONSTRAINT 47'S HEADLINE CASE, with the two opens OVERLAPPING. A sync access handle is an "
        "exclusive lock per file and the per-name refcount table makes a second open a reference "
        "on the first handle — but an open is not in that table until its handle exists, so two "
        "opens issued in one dispatch turn both missed it and the second "
        "createSyncAccessHandle threw. Measured: `open` returned -EBUSY, which the storage edge "
        "itself calls a kernel defect, and the process died. Both must now open the same file and "
        "agree about its size. a=%s b=%s io notes=%s"
        % (json.dumps(op.get("a")), json.dumps(op.get("b")),
           json.dumps(op.get("errors"))[:300]))

    # ---- a staged generation a crash left behind --------------------------------------
    orph = got["orphan"]
    eo2 = (orph or {}).get("evidence") or {}
    eg = eo2.get("grown") or {}
    env.expect_that("orphan ok", bool(orph and orph["ok"]),
                    "the orphan proof failed; the page's own evidence: %s"
                    % json.dumps({k: v for k, v in eo2.items() if k != "grown"})[:1200])
    env.expect_that(
        "orphan the orphaned generation was on disk",
        eo2.get("orphansOnDisk") is True and eo2.get("remountMode") == "rw",
        "ANTI-VACUITY: the orphans must be present at their full %s bytes before the second "
        "kernel boots, and that kernel must mount read-write - a volume that refused to mount "
        "would pass the clauses below by never writing anything. injected %s into %s; the mount "
        "came up %r"
        % ((eo2.get("plan") or {}).get("bytes"), json.dumps(eo2.get("injected")),
           json.dumps(eo2.get("blobsBefore")), eo2.get("remountMode")))
    env.expect_that(
        "orphan a grown range reads as zeroes", eo2.get("grownRangeZeroed") is True,
        "POSIX: the range an ftruncate GROWS a file into reads as zeroes. Against a staging "
        "floor seeded from the committed generations instead of from the blob directory, the "
        "floor handed the orphan's generation number out a second time, the truncate opened the "
        "orphan, and %s of its filler bytes (0x%02x) became the file's. %s"
        % ((eo2.get("plan") or {}).get("bytes"), (eo2.get("plan") or {}).get("byte", 0),
           json.dumps({k: eg.get(k) for k in ("ok", "S", "size", "wantSize", "wantZero",
                                              "zeroed", "foreignBytes", "atS")})))
    env.expect_that(
        "orphan the orphaned generation was not reused", eo2.get("orphanUntouched") is True,
        "and the orphan itself must be untouched at its own length: a floor that reused the name "
        "truncates it DOWN to the file's new size, which is the shape of the defect read off the "
        "directory rather than off the bytes. blobs afterwards: %s. The explicit fsck is "
        "RECORDED and not asserted clean - stale blobs are real and reporting them is correct: %s"
        % (json.dumps(eo2.get("blobsAfter")), json.dumps(eo2.get("fsck"))))

    # ---- a refused mount, in the kernel -----------------------------------------------
    r = got["refuse"]
    er = (r or {}).get("evidence") or {}
    env.expect_that(
        "refuse all three slots were corrupted", er.get("allThreeCorrupted") is True,
        "ANTI-VACUITY: all %s superblock slots must have been present and overwritten before the "
        "second kernel booted, or the refusal below is a refusal of something else. Slots as "
        "left: %s" % (er.get("slots"), json.dumps(er.get("slotBefore"))))
    env.expect_that(
        "refuse the mount refused", er.get("refused") is True,
        "constraint 28: a volume whose bytes are present and do not decode mounts REFUSED. fsck "
        "returning 'refuse' is checked under Node; this is the KERNEL's arm, where the reseed "
        "would live. Got mode %r with problems %s: %s"
        % (er.get("mode"), json.dumps(er.get("problems")), json.dumps(er.get("why"))[:400]))
    env.expect_that(
        "refuse the volume was not touched",
        er.get("slotsUnchanged") is True and er.get("journalUnchanged") is True
        and er.get("blobsUnchanged") is True and er.get("wroteFalse") is True,
        "webxp reseeded here, and that is silent data loss presented as success. 'It wrote "
        "nothing' is a claim about the VOLUME: the slot bytes, the journal length and the blob "
        "listing are read back after the refused mount. slots %s -> %s, journal %s -> %s B, "
        "blobs %s -> %s, report.wrote=%s"
        % (json.dumps(er.get("slotBefore")), json.dumps(er.get("slotAfter")),
           er.get("journalBytesBefore"), er.get("journalBytesAfter"),
           er.get("blobsBefore"), er.get("blobsAfter"), er.get("wrote")))
    env.expect_that(
        "refuse no tree was invented", er.get("noInventedTree") is True,
        "a reseeded volume comes up with one inode in it. A refusing kernel has NO tree, which is "
        "the honest state: there is no image to read without a valid slot. The volume held %s "
        "inodes at generation %s; the refusing mount reports inodes=%s at generation %s"
        % (er.get("inodesBefore"), er.get("generationBefore"), json.dumps(er.get("inodesAfter")),
           er.get("generationAfter")))

    # ---- a superblock slot that cannot be READ ----------------------------------------
    #
    # The refused mount's error-path twin, and the more dangerous of the two: a healthy volume's
    # journal is EMPTY because the last snapshot truncated it, so the slots carry the only evidence
    # the volume exists. An errno read as "this slot is absent" made all of that evidence vanish at
    # once, which is a FRESH verdict — the one verdict whose caller may write a superblock.
    un = got["unreadable"]
    eun = (un or {}).get("evidence") or {}
    env.expect_that(
        "unreadable the slot read refused with something other than absence",
        eun.get("readRefusedNotAbsent") is True,
        "ANTI-VACUITY, and it carries the whole scenario. The page turns a slot NAME into a "
        "DIRECTORY, so the kernel's `getFileHandle(name, {create: false})` refuses it — and the "
        "refusal must not be NotFoundError, because an absent slot is the other volume and the "
        "distinction src/kernel/iocore.mjs keeps is exactly between those two. The page read the "
        "slot back itself and got: %r on %s"
        % (eun.get("refusedWith"), eun.get("oldest")))
    env.expect_that(
        "unreadable the journal was empty, so only the slots said the volume existed",
        eun.get("journalWasEmpty") is True,
        "the second half of the anti-vacuity. A non-empty journal is bytes-present on its own, so "
        "the FRESH arm would be unreachable whatever the slots said and this section would be "
        "measuring nothing. Three snapshots were taken, so the journal must be 0 bytes: it is %s"
        % (eun.get("journalBytesBefore"),))
    env.expect_that(
        "unreadable one unreadable slot mounts read-only at the same generation",
        eun.get("oneReadOnly") is True and eun.get("oneSameGeneration") is True,
        "two slots still decode, so the volume is there and must come up READ-ONLY on the "
        "generation they name — not read-write, which is what the pre-fix reader did with nothing "
        "to report, and which lets the next snapshot round-robin into the slot it cannot read. "
        "mode=%r (was %r), generation %s -> %s, unreadableSlots=%s, problems=%s %s"
        % (eun.get("modeOne"), eun.get("modeBefore"), eun.get("generationBefore"),
           eun.get("generationOne"), eun.get("unreadableSlotsOne"),
           json.dumps(eun.get("problemsOne")), json.dumps(eun.get("whyOne"))[:500]))
    env.expect_that(
        "unreadable one unreadable slot keeps its tree", eun.get("oneKeptItsTree") is True,
        "read-only means readable: the inode count must be the one the volume had, not a fresh "
        "tree and not nothing. %s inodes before, %s after"
        % (eun.get("inodesBefore"), eun.get("inodesOne")))
    env.expect_that(
        "unreadable every unreadable slot refuses",
        eun.get("allRefused") is True and eun.get("allInventedNothing") is True,
        "with no readable slot there is no image, so REFUSE and no tree. A FRESH verdict here is "
        "constraint 28's defect: mode=%r, inodes=%s, problems=%s %s"
        % (eun.get("modeAll"), json.dumps(eun.get("inodesAll")),
           json.dumps(eun.get("problemsAll")), json.dumps(eun.get("whyAll"))[:500]))
    env.expect_that(
        "unreadable both verdicts name the slot that could not be read",
        bool(eun.get("whyOne")) and bool(eun.get("whyAll"))
        and any("could not be READ" in str(w) for w in eun.get("whyOne") or [])
        and any("could not be READ" in str(w) for w in eun.get("whyAll") or []),
        "an error path must name what failed, and `problems` is the only place a mount's reader "
        "meets it. read-only said: %s; refused said: %s"
        % (json.dumps(eun.get("whyOne"))[:500], json.dumps(eun.get("whyAll"))[:500]))
    env.expect_that(
        "unreadable neither verdict wrote anything",
        eun.get("wroteNothing") is True and eun.get("blobsUntouched") is True
        and eun.get("journalUntouched") is True,
        "measured off the VOLUME rather than off the report: the blob directory and the journal "
        "must both come back unchanged, because a reseed writes a slot and truncates the journal. "
        "blobs %s -> %s -> %s, journal %s -> %s -> %s bytes, wrote=%s"
        % (eun.get("blobsBefore"), eun.get("blobsAfterOne"), eun.get("blobsAfterAll"),
           eun.get("journalBytesBefore"), eun.get("journalBytesOne"),
           eun.get("journalBytesAll"), eun.get("wroteNothing")))

    # ---- O_APPEND is an offset per write ----------------------------------------------
    ap = got["append"]
    eap = (ap or {}).get("evidence") or {}
    env.expect_that(
        "append both O_APPEND writes were acknowledged", eap.get("acknowledged") is True,
        "ANTI-VACUITY: both writes must return their full count and both fsyncs must return 0, or "
        "the clause below is asserting over a write that never happened. wrote=%s synced=%s "
        "at=%s errno=%s"
        % (json.dumps(eap.get("wrote")), json.dumps(eap.get("synced")), eap.get("at"),
           eap.get("errno")))
    env.expect_that(
        "append two O_APPEND writers both keep their bytes",
        eap.get("bothRangesSurvived") is True
        and eap.get("size") == eap.get("wantSize"),
        "POSIX sets an O_APPEND description's offset to the end of the file atomically BEFORE "
        "EACH WRITE. Taken once at open instead, two `>>` descriptions get the same end and the "
        "second writes over the first with every call returning success. One process, four calls, "
        "no race: the file must be %s bytes and hold both ranges. Got %s bytes: %s (want %s)"
        % (eap.get("wantSize"), eap.get("size"), json.dumps(eap.get("got")),
           json.dumps(eap.get("want"))))
    env.expect_that(
        "append the volume is clean afterwards", eap.get("clean") is True,
        "and the volume must be clean: the lost-append version left a blob whose length matched "
        "its published size, so fsck reported no problem and the loss was silent. fsck: %s"
        % json.dumps(eap.get("fsck")))

    # ---- every async syscall completion, across every section --------------------------
    #
    # `later()` runs an async syscall body off the dispatch path and answers when it settles, and
    # it is the completion path for open, write, fsync, truncate and close. Its rejection arm used
    # to be a bare `fail(p, EIO)`: the rejection value was dropped, nothing was noted and no
    # counter moved, so ANY kernel-side exception in ANY of those bodies became an anonymous -EIO
    # that a caller cannot tell from a real storage failure. The reason now goes out on the note
    # channel — which the page-wide note clause above also asserts on — and the count is read off
    # each kernel before it is terminated and summed here.
    env.expect_that(
        "no async syscall completion was rejected in any section", got["asyncFail"] == 0,
        "%d async syscall completion(s) rejected. Each one is a throw inside a kernel-side open, "
        "write, fsync, truncate or close body, answered to the process as -EIO. The reason is on "
        "the note channel; the page's own errors: %s"
        % (got["asyncFail"],
           json.dumps([e for e in got["errors"] if "asyncFail" in e or e.startswith("io: ")])[:900]))
    env.expect_that(
        "every kernel's counters were read before it was terminated",
        got["statsReads"] >= M2_SECTIONS,
        "ANTI-VACUITY for the clause above: the count is summed from a `stats` round trip taken in "
        "`shut()`, so a zero that nobody could read is not a zero. %d kernel(s) answered against "
        "at least %d sections, each of which boots one or more. A kernel that would not answer "
        "says so in the page's errors: %s"
        % (got["statsReads"], M2_SECTIONS,
           json.dumps([e for e in got["errors"] if e.startswith("shut: ")])[:600]))

    # ---- the write ordering and the directory-handle budget ----------------------------
    o = got["order"]
    eo = (o or {}).get("evidence") or {}
    env.expect_that(
        "order the blob flush precedes the journal append",
        eo.get("ordered") is True and eo.get("flushedBlob") is True,
        "constraint 23's ordering is blob -> flush -> journal -> flush, and it is MEASURED here "
        "rather than read: an in-session read cannot see an unflushed write, so the sequence of "
        "operations the storage edge performed is the observation. For the last commit the blob's "
        "flush must carry a lower sequence number than the journal append that points at it, and "
        "the thing flushed must be a BLOB rather than the journal. Commit: %s. Edge tail: %s"
        % (json.dumps(eo.get("commit")), json.dumps(eo.get("tail"))))
    env.expect_that(
        "order one directory handle for the module's life", eo.get("oneDirectoryHandle") is True,
        "constraint 24: `getDirectoryHandle` is 85 us per component, so a path that costs one per "
        "component is 23 syscalls for a four-component walk. This kernel takes ONE for the life "
        "of the module — path resolution runs over the in-memory inode tree and a blob is one "
        "flat `<ino>.<gen>` name. Counted across the run: %s"
        % json.dumps(eo.get("counts")))

    # ---- the rest of the ABI -----------------------------------------------------------
    api = got["api"]
    eapi = (api or {}).get("evidence") or {}
    env.expect_that(
        "every other syscall answers correctly", bool(api and api["ok"]),
        "%s of the calls the three proofs do not reach failed. Each row names the call and what "
        "it saw: %s"
        % (len(eapi.get("bad") or []), json.dumps(eapi.get("bad"))[:1400]))
    env.note("the rest of the ABI: %s calls exercised" % eapi.get("calls"))

    env.expect("verdict is ok", got["verdict"], "ok")
    env.note("config: %s" % got["cfg"])

    document = env.request(env.document)
    env.expect("document COOP", document.headers.get("Cross-Origin-Opener-Policy"),
               "same-origin")
    env.expect("document COEP", document.headers.get("Cross-Origin-Embedder-Policy"),
               "require-corp")
    env.expect_that(
        "served m2.html", env.served_matches_disk(env.document),
        "the bytes served for %s differ from the file on disk, so this run measured something "
        "other than this tree" % env.document)

    env.shoot("m2")


# ======================================================================================
# Phases, the loop and the gates (§5, §7, §9)
# ======================================================================================

MODE_NORMAL = "normal"
MODE_INVERT = "invert"
MODE_NO_ISOLATION = "no-isolation"
MODE_NEGATIVE = "negative"

PROVE_LIMIT = (
    "--prove-failure proves that every inversion fires, that those failures reach the report, and "
    "(gate I5) that the report would carry them to a non-zero status. It exits 0 when the proof "
    "succeeded; non-zero is a proof that failed. It does not prove the measurement is coupled to "
    "the subject: an assertion over a constant still inverts and still fires. Only --negative "
    "closes that.")


@dataclasses.dataclass
class Phase:
    mode: str
    #: Root name -> (the directory this phase serves for it, what the served bytes are compared
    #: against). One server per entry, all of them bound before Chrome starts. The comparison
    #: tree is the repository's own for every phase that serves a real tree, and the fixture's
    #: root where a fixture built a deliberately different one and verified its own patch.
    roots: Dict[str, Tuple[pathlib.Path, pathlib.Path]]
    isolated: bool
    #: M6. False serves no process-realm policy. The third way a phase builds a broken world,
    #: beside the headers and the fixture, and a server-side one because a policy is a header.
    csp: bool
    checks: Tuple[Check, ...]
    #: Selected, and not run by this phase. Carried so the report can say so with a reason
    #: instead of leaving a gap for the reader to infer.
    filtered: Tuple[Tuple[Check, str], ...]
    inverted: bool
    label: str
    #: Query parameters a negative control merged into every document this phase loads.
    query: Tuple[Tuple[str, str], ...] = ()
    #: Temporary trees this phase owns and main() must remove.
    cleanup: Tuple[pathlib.Path, ...] = ()


def phase_document(candidate: Check, phase: "Phase") -> str:
    """The request path a check's page is loaded from, with this phase's parameters merged in.

    One definition, because serve() asserts this exact path on the wire before Chrome starts,
    Env.reload navigates it, and the check reads its own response headers back by it. Three
    copies of a query string is three chances for the assertion to be about a different URL
    than the one the browser fetched.

    Two sources merge, and the phase's own win: a negative control's `query`, and a check's
    `invert_query` in the inversion phase only.
    """
    query = phase.query
    if phase.mode == MODE_INVERT and candidate.invert_query:
        query = tuple(candidate.invert_query) + tuple(query)
    if not query:
        return candidate.document
    parts = urllib.parse.urlsplit(candidate.document)
    merged = dict(urllib.parse.parse_qsl(parts.query))
    merged.update(dict(query))
    return urllib.parse.urlunsplit(
        ("", "", parts.path, urllib.parse.urlencode(merged), ""))


def phase_roots(checks: Tuple[Check, ...], *, www: pathlib.Path,
                www_canonical: pathlib.Path) -> Dict[str, Tuple[pathlib.Path, pathlib.Path]]:
    """The servers a set of checks needs. Derived from what they declare, never listed: a root
    nothing declares is a server nothing loads from, and a check whose root is unserved would
    read a 404 instead of its page.

    --root overrides Root.WWW only, which is what it has always meant: the tree a user's browser
    is pointed at. Root.REPO is resolved from this file - see Root.
    """
    out: Dict[str, Tuple[pathlib.Path, pathlib.Path]] = {}
    for candidate in checks:
        if candidate.root == Root.WWW:
            out[Root.WWW] = (www, www_canonical)
        else:
            out[Root.REPO] = (REPO, REPO)
    return out


def run_one(candidate: Check, env: Env, *, inverted: bool) -> Result:
    started = time.monotonic()
    outcome = Outcome.PASS
    reason = ""
    try:
        env.reload()
        candidate.func(env)
    except Unmeasurable as error:
        outcome = Outcome.BROKEN
        reason = "%s: could not measure - %s Nothing was tested." % (candidate.name, error)
    except CDPError as error:
        outcome = Outcome.BROKEN
        reason = "%s: could not measure - the channel to the page failed: %s" % (
            candidate.name, error)
    except ServeError as error:
        outcome = Outcome.BROKEN
        reason = "%s: could not measure - %s" % (candidate.name, error)
    except Exception as error:
        # A KeyError in check #3 must not stop checks #4-21 from running: an uncaught exception
        # exits with no trailer and no line for any later check, which is the gap the report
        # promises never to leave. KeyboardInterrupt and SystemExit are BaseException and still
        # propagate, so the ExitStack unwinds and Chrome comes down.
        outcome = Outcome.BROKEN
        reason = "%s: could not measure - the check body raised %s: %s" % (
            candidate.name, type(error).__name__, error)
    # Read before the console drain and whatever the body did: the document's response as the
    # server recorded it, and what this page says about its own verdict. Gates N2 and N3 score
    # these, so they are collected for every check in every phase rather than only where a gate
    # happens to want them - a gate that can only read what the phase remembered to keep is a
    # gate the next phase disarms.
    document_headers: Dict[str, str] = {}
    try:
        document_headers = dict(env.serving.last(env.document).headers)
    except ServeError:
        # Not a failure here: a phase that gated before the navigate recorded no response, and
        # that check is already BROKEN above. An empty mapping carries no header to leak.
        pass
    refusal: Optional[str] = None
    if candidate.refusal_expr:
        try:
            value = env.page.evaluate(candidate.refusal_expr)
            refusal = None if value is None else str(value)
        except CDPError:
            refusal = None
    # Drained whatever happened: an error the page logged on its way down is evidence, and
    # erasing it would be the swallowed failure this harness exists to prevent. A channel that
    # died here is recorded, never suppressed: a renderer that went away after the body returned
    # took with it both whatever it was about to log and any reason to trust what it already said.
    try:
        env._drain_console(quiesce=CONSOLE_QUIESCENCE_S)
    except CDPError as error:
        died = ("%s: could not measure - the channel to the page died after the body returned, "
                "so anything it logged on its way down was lost: %s" % (candidate.name, error))
        reason = (reason + " " + died) if outcome == Outcome.BROKEN else died
        outcome = Outcome.BROKEN
    seconds = time.monotonic() - started

    unclaimed = _unclaimed(env)
    if outcome != Outcome.BROKEN:
        if env.count == 0:
            outcome = Outcome.BROKEN
            reason = ("%s: reported ok without asserting anything. A check that asserts nothing "
                      "cannot fail." % candidate.name)
        elif env.count < candidate.min_expectations:
            # Belt and braces with gate I2, which only runs under --prove-failure. A check that
            # quietly stopped asserting must not be able to pass a plain run either: 29
            # expectations becoming 3 is erosion, not a product verdict.
            outcome = Outcome.BROKEN
            reason = ("%s: recorded %d, declared %d. The check stopped asserting most of what "
                      "it claims, so neither a pass nor a fail from it means anything."
                      % (candidate.name, env.count, candidate.min_expectations))
        elif sorted(env.labels) != sorted(candidate.labels):
            # The inventory, read the other way round: a body that recorded a label the registry
            # does not declare, renamed one, or recorded one twice is not a product verdict
            # either. This is what keeps every negative control's derived `held` honest, because
            # that set is computed from the inventory - the count gate above cannot see a label
            # added and another dropped in the same edit.
            outcome = Outcome.BROKEN
            recorded = sorted(env.labels)
            declared = sorted(candidate.labels)
            reason = (
                "%s: recorded expectation labels its registry entry does not declare. Recorded "
                "and undeclared: %s. Declared and not recorded: %s. Until the two agree, no "
                "negative control can say which labels it left unscored."
                % (candidate.name,
                   [label for label in recorded if label not in declared] or "none",
                   [label for label in declared if label not in recorded] or "none"))
        elif env.failures:
            outcome = Outcome.FAIL
        elif unclaimed:
            outcome = Outcome.FAIL
        elif inverted:
            outcome = Outcome.INVERTED
    return Result(check=candidate, outcome=outcome, count=env.count, seconds=seconds,
                  failures=tuple(env.failures), inverted_fired=tuple(env.inverted_fired),
                  reason=reason, artifacts=tuple(env.artifacts), console=tuple(unclaimed),
                  labels=tuple(env.labels), failed_labels=tuple(env.failed_labels),
                  document_headers=document_headers, refusal=refusal)


def _unclaimed(env: Env) -> List[ConsoleEntry]:
    """Console errors nobody looked at, minus the ones the server's own record allows.

    Keyed on the entry's structured url field mapped to a path, intersected with ALLOWED_404
    and with a non-200 the server actually recorded for that exact path. Never on a substring
    of a console message.
    """
    non_200 = {s.path for s in env.serving.non_200()}
    out = []
    for entry in env.console_seen:
        if entry in env.claimed:
            continue
        path = urllib.parse.urlsplit(entry.url).path if entry.url else ""
        if path in ALLOWED_404 and path in non_200:
            continue
        out.append(entry)
    return out


def phases(args, selected: Tuple[Check, ...]) -> Tuple[List[Phase], Optional[int]]:
    """The phases to run, or an exit code if a gate refuses before anything runs."""
    root = pathlib.Path(args.root).resolve()
    if args.negative:
        control = CONTROLS[args.negative]
        fixture_root = control.fixture(root) if control.fixture else root
        isolated = bool(control.serve_kwargs.get("isolate", True))
        policy = bool(control.serve_kwargs.get("csp", True))
        # Only what this control scores. A check the control declares nothing about would be
        # dragged through a broken world, and gate_negative would neither score it nor be able
        # to say what its result meant: under --negative empty-root a kernel check would serve a
        # tree the fixture never touched and pass, which reads as the control having been
        # harmless when it was simply absent.
        scored = tuple(c for c in selected if c.name in control.expects)
        return [Phase(mode=MODE_NEGATIVE,
                      # A fixture tree is meant to differ from www/, and _patch_probe verifies
                      # its own single replacement, so the pin there is the fixture, not www/.
                      roots=phase_roots(scored, www=fixture_root,
                                        www_canonical=fixture_root if control.fixture
                                        else CANONICAL),
                      isolated=isolated, csp=policy, checks=scored,
                      filtered=tuple(
                          (c, "CONTROLS[%r] declares no expectation for it, so this phase would "
                              "run it against a broken world and score nothing"
                           % control.name)
                          for c in selected if c not in scored),
                      inverted=False, query=control.query,
                      label="negative %s (%s)" % (control.name, control.why),
                      cleanup=(fixture_root,) if control.fixture else ())], None

    out: List[Phase] = []
    if args.prove_failure in (MODE_INVERT, "both"):
        if not [c for c in selected if Control.INVERT in c.controls]:
            print("check.py: the selection contains 0 invertible checks. Narrowing the run "
                  "cannot quietly disarm it.", file=sys.stderr)
            return [], 4
        out.append(Phase(mode=MODE_INVERT,
                         roots=phase_roots(selected, www=root, www_canonical=CANONICAL),
                         isolated=True, csp=True, checks=selected, filtered=(),
                         inverted=True, label="--prove-failure invert"))
    if args.prove_failure in (MODE_NO_ISOLATION, "both"):
        sensitive = tuple(c for c in selected if Control.NO_ISOLATION in c.controls)
        if not sensitive:
            print("check.py: the isolation-sensitive selection is empty, so --no-isolation "
                  "would prove nothing.", file=sys.stderr)
            return [], 4
        out.append(Phase(
            mode=MODE_NO_ISOLATION,
            roots=phase_roots(sensitive, www=root, www_canonical=CANONICAL),
            isolated=False, csp=True, checks=sensitive,
            filtered=tuple((c, "not isolation-sensitive (no %s control), so this phase does not "
                               "run it" % Control.NO_ISOLATION)
                           for c in selected if c not in sensitive),
            inverted=False, label="--prove-failure no-isolation"))
    if not out:
        out.append(Phase(mode=MODE_NORMAL,
                         roots=phase_roots(selected, www=root, www_canonical=CANONICAL),
                         isolated=True, csp=True, checks=selected, filtered=(),
                         inverted=False, label="normal"))
    return out, None


class PhaseRun(NamedTuple):
    phase: Phase
    results: List[Result]
    witness_failures: List[str]


def run_phase(phase: Phase, report: Report, header: Callable[[str], None]) -> PhaseRun:
    results: List[Result] = []
    documents = dict((c.name, phase_document(c, phase)) for c in phase.checks)
    with contextlib.ExitStack() as stack:
        # One server per declared root, every one of them asserting its own isolation mode and
        # every document the checks on it will navigate to, before Chrome exists. Two servers in
        # one process is safe because the root travels as functools.partial(.., directory=..)
        # and the isolation mode as a per-server Handler subclass; serve.py's os.chdir is in its
        # main() and is never reached from here.
        servings: Dict[str, Serving] = {}
        for name in phase.roots:
            served, canonical = phase.roots[name]
            servings[name] = stack.enter_context(serve(
                served, canonical=canonical, port=0, isolate=phase.isolated,
                csp=phase.csp,
                documents=tuple(dict.fromkeys(
                    documents[c.name] for c in phase.checks if c.root == name))))
        # Nesting order is load-bearing: ExitStack unwinds last-in-first-out, so Chrome closes
        # before the servers. A page mid-fetch against a dead server logs a console error the
        # sweep would otherwise attribute to the product.
        # cdp.Browser tears its own Chrome and temp profile down when __enter__ raises
        # (cdp.py:__enter__), so a failed launch here leaks neither.
        instance = stack.enter_context(cdp.Browser())
        page = instance.page()
        # Before any navigate, so an evaluate cannot hit an execution context Runtime never
        # announced.
        page.call("Runtime.enable")
        page.call("Log.enable")
        page.call("Page.enable")
        page.clear_cache()
        page.emulate_device(width=VIEWPORT_WIDTH, height=VIEWPORT_HEIGHT,
                            scale_factor=VIEWPORT_SCALE, mobile=False)
        page.call("Emulation.setFocusEmulationEnabled", enabled=True)
        # Recorded, not asserted: a Chrome upgrade must not fail the suite, but a silent bump
        # must not be invisible either. Browser.getVersion over a page-target session was
        # verified on Chrome 157.0.8103.38 on this machine.
        header(str(page.call("Browser.getVersion").get("product") or "?"))
        for name in phase.roots:
            serving = servings[name]
            print("  server    %s/  root=%s (%s)  %s" % (
                serving.base, _relative(serving.root), name,
                "ISOLATED (COOP+COEP verified on the wire)" if serving.isolated
                else "NOT ISOLATED (both headers verified absent on the wire)"))
        print("  viewport  %dx%d @ dpr %g, mobile=false, focus emulation on"
              % (VIEWPORT_WIDTH, VIEWPORT_HEIGHT, VIEWPORT_SCALE))
        if phase.query:
            print("  injected  %s, merged into every document this phase loads"
                  % "&".join("%s=%s" % pair for pair in phase.query))
        print("  phase     %s\n" % phase.label)
        sys.stdout.flush()

        epochs = itertools.count(1)
        for candidate in phase.checks:
            inverted = phase.inverted and Control.INVERT in candidate.controls
            env = Env(page=page, serving=servings[candidate.root], out=report.out,
                      check_name=candidate.name, inverted=inverted, epochs=epochs,
                      document=documents[candidate.name], ready_expr=candidate.ready_expr,
                      ready_what=candidate.ready_what, ready_timeout=candidate.ready_timeout,
                      artifact_prefix=phase.mode)
            result = run_one(candidate, env, inverted=inverted)
            results.append(result)
            report.add(result)
        # Not appended to `results`: a gate scores what this phase measured, and a check it
        # never ran is not a measurement. It still gets its line and its reason.
        for candidate, why in phase.filtered:
            report.add(Result(check=candidate, outcome=Outcome.SKIP,
                              reason="%s: %s" % (candidate.name, why)))
        witness_failures: List[str] = []
        for name in phase.roots:
            witness_failures.extend(report.witness(servings[name], "%s %s" % (phase.mode, name)))
    return PhaseRun(phase, results, witness_failures)


def _header_printer(report: Report, selected: int) -> Callable[[str], None]:
    """Prints the run header once, on the first thing that learns the Chrome version."""
    done = []

    def once(version: str) -> None:
        if done:
            return
        done.append(version)
        stamp = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
        print("check.py  %s  %s" % (stamp, version))
        print("  registry  %d check%s, %d invertible, %d exempt, %d resting on a once-only "
              "control" % (len(registered()), "" if len(registered()) == 1 else "s",
                           len(invertible()), len(exempt()), len(resting_on_once())))
        print("  selected  %d of %d    mode %s" % (selected, len(registered()), report.mode))

    return once


# ---- gates ---------------------------------------------------------------------------


def _strays(run: PhaseRun, report: Report, excused: Tuple[str, ...] = ()) -> List[str]:
    """Everything wrong with a phase that is not an expectation the phase expected to fail.

    One definition for all three gates. gate_invert swept these and the other two did not, so a
    byte mismatch, a page exception or an unmeasurable check turned a plain run red at exit 1
    and left --prove-failure and --negative at 0 on the same tree.

    `excused` names checks whose registry declaration says this phase cannot measure them at
    all. Scored elsewhere, by score(), against that declaration - so the excuse costs a reader
    nothing and an UNDECLARED BROKEN is still a stray here.
    """
    found = ["%s could not be measured: %s" % (r.check.name, r.reason)
             for r in run.results
             if r.outcome == Outcome.BROKEN and r.check.name not in excused]
    found.extend("unclaimed console error: %s" % line
                 for line in report.console_failures(run.results))
    found.extend("witness: %s" % line for line in run.witness_failures)
    return found


def gate_invert(run: PhaseRun, report: Report) -> int:
    results = run.results
    inverted = [r for r in results if Control.INVERT in r.check.controls]
    plain = [r for r in results if Control.INVERT not in r.check.controls]

    # I1. Every check this phase ran was either inverted or carries an audited reason it cannot
    # be. Derived from the registry, never from a hand-bumped constant: a constant only detects
    # erosion if someone remembers to raise it.
    #
    # audit() rule 4 is the LIVE gate for this: it refuses a check carrying neither
    # Control.INVERT nor a no_invert_reason before any phase starts, so `uninverted` below is
    # always empty and its branch cannot be made to fire without bypassing audit. It is kept as
    # the backstop for the day someone builds a phase that skips the audit - do not spend an
    # afternoon trying to reproduce it.
    for candidate in sorted(exempt(), key=lambda c: c.name):
        print("  gate I1: %s is never inverted: %s" % (candidate.name,
                                                       candidate.no_invert_reason))
    uninverted = [r.check.name for r in results
                  if not r.check.no_invert_reason and Control.INVERT not in r.check.controls]
    if uninverted:
        print("  gate I1: %s ran in the invert phase and was not inverted"
              % ", ".join(uninverted))
        print("--prove-failure: %d of %d checks in this phase were never inverted, so 'all "
              "failed as required' would describe a phase that did not test them."
              % (len(uninverted), len(results)))
        return 4

    # I2 before I3: a check that raised records no inversions and must trip the count gate.
    short = [r for r in inverted if r.count < r.check.min_expectations]
    if short:
        for result in short:
            print("  gate I2: %s recorded %d, declared %d"
                  % (result.check.name, result.count, result.check.min_expectations))
        print("--prove-failure: an invertible check asserted less than it declares, so the "
              "inversion proves nothing.")
        return 4

    already = [line for r in inverted for line in r.failures]
    if already:
        for line in already:
            print("  gate I3: " + line)
        print("%d inverted expectation(s) passed, so the plain expectations are false - these "
              "were already failing - run without --prove-failure." % len(already))
        return 1

    strays: List[str] = []
    for result in plain:
        strays.extend("a non-invertible check failed: %s" % line for line in result.failures)
    strays.extend(_strays(run, report))
    if strays:
        for line in strays:
            print("  gate I4: " + line)
        print("--prove-failure: %d stray failure(s) outside the inversion, so a clean exit "
              "would have been a lie." % len(strays))
        return 4

    fired = sum(len(r.inverted_fired) for r in inverted)
    print("--prove-failure invert: %d expectations across %d of %d registered checks all failed "
          "as required%s"
          % (fired, len(inverted), len(registered()),
             (" (%d never inverted, by audited exemption)" % len(exempt())) if exempt() else ""))
    return 0


def gate_no_isolation(run: PhaseRun, report: Report) -> int:
    results = run.results
    # Presence, not value, and per document: this control claims to omit the pair, so any value
    # for either name on any page this phase loaded is a leak. The value is printed so the reader
    # sees which. Read off the response the BROWSER got, as the server recorded it.
    leaked = ["%s's document (%s) carried %s: %r"
              % (r.check.name, phase_document(r.check, run.phase), name,
                 r.document_headers[name])
              for r in results for name, _ in ISOLATION_HEADERS if name in r.document_headers]
    if leaked:
        print("  gate N2: under --no-isolation %s. The control did not remove what it claims to."
              % "; ".join(leaked))
        return 3
    # N3. Each page's OWN refusal, read from the registry rather than hardcoded here: without
    # COOP/COEP www/index.html must set data-preflight='fail' and www/m0.html must reach state
    # 'aborted'. "The capability is gone" is not the product claim - "the page refused to
    # proceed and said why" is - and a gate that knew about one page would have left the other's
    # refusal unasserted. audit rule 12 is what keeps every isolation-sensitive check declaring
    # one.
    silent = ["%s: %s reads %r, want %r"
              % (r.check.name, r.check.refusal_expr, r.refusal, r.check.refusal_want)
              for r in results if r.check.refusal_expr and r.refusal != r.check.refusal_want]
    if silent:
        print("  gate N3: %s. Without COOP/COEP the page must refuse." % "; ".join(silent))
        return 1
    # Printed when it holds as well: a gate nobody can see run is a gate nobody has checked.
    print("  gate N3: %s" % "; ".join(
        "%s's page refused: %s reads %r" % (r.check.name, r.check.refusal_expr, r.refusal)
        for r in results if r.check.refusal_expr))
    # N4. Each check against the outcome CONTROLS['no-isolation'] declares for it - the same
    # declaration --negative no-isolation scores, so the two phases cannot disagree. A check that
    # DECLARES its measurement unobtainable without COOP/COEP (an M0 kernel check: there is no
    # SharedArrayBuffer to read) satisfies this control by coming out BROKEN, because being
    # unmeasurable IS the capability going away. A check with no declaration here is scored as
    # "did not declare", which nothing satisfies.
    declared = CONTROLS[MODE_NO_ISOLATION].expects
    problems: List[str] = []
    for result in results:
        expect = declared.get(result.check.name)
        if expect is None:
            problems.append(
                "%s ran in this phase and CONTROLS[%r] declares no outcome for it, so there is "
                "nothing to score it against" % (result.check.name, MODE_NO_ISOLATION))
            continue
        problems.extend(score(expect, result.check.name, result, ""))
    if problems:
        for line in problems:
            print("  gate N4: " + line)
        print("--prove-failure no-isolation: %d check(s) did not come out the way the registry "
              "says removing COOP/COEP must make them come out." % len(problems))
        return 1
    # N5. An UNDECLARED BROKEN is not a satisfied negative control. A check that could not be
    # measured, and never said this world would stop it being measurable, did not fail because
    # isolation was removed - it measured nothing, and this phase proved nothing about it. BROKEN
    # outranking FAIL is this file's own rule (see status()).
    excused = tuple(name for name, expect in declared.items()
                    if expect.outcome == UNMEASURABLE)
    strays = _strays(run, report, excused)
    if strays:
        for line in strays:
            print("  gate N5: " + line)
        print("--prove-failure no-isolation: %d stray failure(s) and unmeasurable check(s), so "
              "this phase is not evidence that removing isolation is what turned it red."
              % len(strays))
        return 4
    print("--prove-failure no-isolation: %s, as declared, without COOP/COEP."
          % ", ".join("%s came out %s" % (r.check.name, declared[r.check.name].outcome)
                      for r in results))
    return 0


def gate_negative(control: NegativeControl, run: Optional[PhaseRun], report: Report,
                  gated: str, selected: Tuple[str, ...]) -> int:
    results = run.results if run else []
    by_check = {r.check.name: r for r in results}
    # Only what the selection ran. Scoring a check --only deselected reports it as "not measuring
    # what it claims" for having measured nothing, which is exactly what the user asked of it,
    # and buries the run's real result under a false line.
    deselected = sorted(name for name in control.expects if name not in selected)
    for name in deselected:
        print("  gate: %s is in this control's expectations and --only left it out of the run, "
              "so this phase does not score it." % name)
    scored = {name: expect for name, expect in control.expects.items() if name in selected}
    if not scored:
        print("--negative %s: --only deselected every check this control scores, so the run is "
              "not evidence about the control." % control.name)
        return 4
    problems: List[str] = []
    for name, expect in sorted(scored.items()):
        problems.extend("negative control %r ran and %s" % (control.name, line)
                        for line in score(expect, name, by_check.get(name), gated))
    if problems:
        for line in problems:
            print("  gate: " + line)
        print("--negative %s: %d expectation(s) about the control itself unmet. The harness has "
              "not been shown capable of failing here." % (control.name, len(problems)))
        return 4
    excused = tuple(name for name, expect in scored.items()
                    if expect.outcome == UNMEASURABLE)
    strays = _strays(run, report, excused) if run else []
    if strays:
        for line in strays:
            print("  gate: " + line)
        print("--negative %s: the declared outcomes held, but %d stray failure(s) in the same "
              "phase mean something other than the control was also broken."
              % (control.name, len(strays)))
        return 4
    print("--negative %s: %s" % (control.name, "; ".join(
        "%s came out %s as required%s"
        % (name, expect.outcome,
           (", with %s red and %s intact" % (len(expect.failed), len(expect.held)))
           if expect.failed or expect.held else "")
        for name, expect in sorted(scored.items()))))
    return 0


# ---- CLI -----------------------------------------------------------------------------


def parse(argv: Optional[List[str]]):
    ap = argparse.ArgumentParser(prog="check.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", action="append", default=[], metavar="NAME",
                    help="run exactly this check, repeatable. Exact names only: a substring "
                         "can widen or narrow a run silently.")
    ap.add_argument("--root", default=str(REPO / "www"),
                    help="the tree to serve for checks declaring Root.WWW. src/ sits outside "
                         "www/, so M0's kernel page is served from the repository root instead "
                         "(Root.REPO) - which is resolved from this file and not overridable, "
                         "because the one definition of a syscall number cannot be copied into "
                         "www/ to suit a server root.")
    ap.add_argument("--out", default="", metavar="DIR",
                    help="artifact directory. Defaults under /tmp, because a harness that "
                         "dirties the tree it is measuring is one more way to measure the "
                         "wrong thing.")
    ap.add_argument("--list", action="store_true", help="print the registry and exit")
    ap.add_argument("--controls", action="store_true",
                    help="print the control audit and exit")
    ap.add_argument("--prove-failure", nargs="?", const="both", default="",
                    choices=["invert", "no-isolation", "both"],
                    help="invert every invertible expectation, and/or re-run the "
                         "isolation-sensitive ones unisolated. " + PROVE_LIMIT)
    ap.add_argument("--negative", default="", metavar="CONTROL",
                    help="run the selection against a deliberately broken world: %s"
                         % ", ".join(sorted(CONTROLS)))
    ap.add_argument("--bless", action="store_true",
                    help="record each check's min_expectations as the committed floor in "
                         "scripts/check_floors.json and exit. Refuses to lower one.")
    return ap.parse_args(argv)


def runnable_controls(candidate: Check) -> str:
    """The controls column as something a reader can run. `patched` is a registry tag and
    `--negative patched` exits 2; the runnable names are patched-required and patched-optional."""
    out: List[str] = []
    for tag in candidate.controls:
        out.extend(CONTROL_RUNS.get(tag, (tag,)))
    return ",".join(out)


def select(only: List[str]) -> Tuple[Tuple[Check, ...], Tuple[Check, ...]]:
    if not only:
        return registered(), ()
    wanted = {by_name(name).name for name in only}
    return (tuple(c for c in registered() if c.name in wanted),
            tuple(c for c in registered() if c.name not in wanted))


def _list() -> None:
    print("name|milestone|root|document|controls|invertible|min_expectations|floor")
    recorded = floors()
    for candidate in registered():
        print("%s|%s|%s|%s|%s|%s|%d|%s" % (
            candidate.name, candidate.milestone, candidate.root, candidate.document,
            runnable_controls(candidate),
            "yes" if Control.INVERT in candidate.controls
            else "no: " + candidate.no_invert_reason,
            candidate.min_expectations, recorded.get(candidate.name, "-")))
    print("check.py --list measured nothing.", file=sys.stderr)


def _controls() -> None:
    print("name|milestone|controls|note|address")
    for candidate in registered():
        print("%s|%s|%s|%s|%s" % (
            candidate.name, candidate.milestone, runnable_controls(candidate),
            candidate.note.replace("\n", " "), candidate.control_address or "-"))
    print()
    print("re-runnable controls (--negative NAME):")
    for name in sorted(CONTROLS):
        control = CONTROLS[name]
        print("  %-18s %s" % (name, control.why))
        for check_name, expect in sorted(control.expects.items()):
            print("  %-18s expects %s -> %s%s" % (
                "", check_name, expect.outcome,
                ("; must fail: %s; must hold: %s"
                 % (", ".join(expect.failed) or "-", ", ".join(expect.held) or "-"))
                if (expect.failed or expect.held) else ""))
    print()
    print("%d of %d checks rest on a once-only control." % (len(resting_on_once()),
                                                            len(registered())))
    print(PROVE_LIMIT)
    print("check.py --controls measured nothing.", file=sys.stderr)


def _install_signal_handlers() -> None:
    """Raise, so the ExitStack unwinds and Chrome and the server come down with it. A failed
    launch is the driver's own business (cdp.Browser.__enter__)."""

    def raise_it(signum, _frame):
        raise KeyboardInterrupt("signal %d" % signum)

    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(ValueError, OSError):
            signal.signal(sig, raise_it)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse(argv)
    # Before audit(): a new check has no floor yet, and --bless is how it gets one.
    if args.bless:
        try:
            return bless()
        except RegistryError as error:
            print(error, file=sys.stderr)
            return 3
    try:
        audit()
    except RegistryError as error:
        print(error, file=sys.stderr)
        return 3

    if args.list:
        _list()
        return 0
    if args.controls:
        _controls()
        return 0
    if args.prove_failure and args.negative:
        print("check.py: --prove-failure and --negative are mutually exclusive. Inverting "
              "assertions in a world that is already broken proves nothing: the inversions "
              "'fire' because the subject is red.", file=sys.stderr)
        return 2
    if args.negative and args.negative not in CONTROLS:
        near = ", ".join(sorted(CONTROLS))
        print("check.py: no negative control named %r. Known: %s" % (args.negative, near),
              file=sys.stderr)
        return 2

    try:
        selected, skipped = select(args.only)
    except UnknownCheck as error:
        print("check.py: %s" % error, file=sys.stderr)
        return 2
    if not selected:
        print("check.py: the selection is empty, so nothing would be measured.", file=sys.stderr)
        return 2

    out = pathlib.Path(args.out) if args.out else pathlib.Path(
        "/tmp/webos-check") / datetime.datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    mode = (MODE_NEGATIVE + " " + args.negative if args.negative
            else args.prove_failure or MODE_NORMAL)
    report = Report(out=out, mode=mode)

    _install_signal_handlers()
    header = _header_printer(report, len(selected))
    try:
        plan, refusal = phases(args, selected)
    except ServeError as error:
        header("Chrome not started")
        print("  gate: the fixture could not build its broken world: %s" % error)
        print("--negative %s: the control has not been shown to break anything." % args.negative)
        return 4
    if refusal is not None:
        return refusal

    cleanup = [path for phase in plan for path in phase.cleanup]
    gated = ""
    runs: List[PhaseRun] = []
    try:
        for phase in plan:
            try:
                runs.append(run_phase(phase, report, header))
            except ServeError as error:
                header("Chrome not started")
                print("  gate: %s" % error)
                if args.negative:
                    gated = "gate %s" % (error.reason or "unnamed")
                    break
                print("nothing was measured, so the absence of failure means nothing.")
                return 3
            except CDPError as error:
                header("Chrome not started")
                print("  gate: Chrome could not be driven: %s" % error)
                print("nothing was measured, so the absence of failure means nothing.")
                return 3
    finally:
        for path in cleanup:
            shutil.rmtree(str(path), ignore_errors=True)

    # Every registered check gets a line in every report, with a reason when it did not run, so
    # a non-run is never inferred from a gap.
    for candidate in skipped:
        report.add(Result(check=candidate, outcome=Outcome.SKIP,
                          reason="%s (--only %s)" % (NOT_SELECTED, " ".join(args.only))))

    if args.negative:
        report.trailer()
        return gate_negative(CONTROLS[args.negative], runs[0] if runs else None, report, gated,
                             tuple(c.name for c in selected))

    if args.prove_failure:
        report.trailer()
        code = 0
        for run in runs:
            outcome = (gate_invert(run, report) if run.phase.mode == MODE_INVERT
                       else gate_no_isolation(run, report))
            code = code or outcome
            if run.phase.mode == MODE_INVERT:
                code = code or _gate_reporting_path(run, report)
        return code

    return report.finish()


#: Gate I5's instrument. A Check that is never registered and never run: status() reads nothing
#: from it but the Result's outcome, and building one here is what lets I5 ask about a FAIL
#: without needing a phase that produced one.

@check(
    name="m3",
    milestone="m3",
    controls=(Control.INVERT, Control.NO_ISOLATION, Control.PROC_CACHE, Control.USR_404,
              Control.TRACE_TINY),
    labels=M3_LABELS,
    requires_isolation=True,
    root=Root.REPO,
    document=M3_DOCUMENT + "?fill=" + str(M3_FILL),
    ready_expr=M3_READY,
    ready_what="globalThis.M3.state reaching done, aborted or error (www/m3.html)",
    # The headline run is 2.7 s measured. The bound is generous against a shared browser and is
    # still a BOUND: the proof waits on a ~2.2 s terminate quarantine and polls for it, so a
    # kernel that never freed the slot must end as a BROKEN check with a reason rather than a
    # suite that never returns.
    ready_timeout=180.0,
    refusal_expr="globalThis.M3 && globalThis.M3.state",
    refusal_want="aborted",
    note="ten sections: the mount table and its device numbers; proof 1 as three sections — the "
         "listing, the killed pid's directory going, and the four per-pid files; proof 2 as the "
         "provider capability probe plus the /usr mount that depends on it; proof 3 as the known "
         "syscall sequence and the dropped-record counter; then the table and the read-only rule "
         "observed from USERLAND through stat and through every mutation in turn. Every "
         "assertion is taken from inside a process worker through real syscalls — reading the "
         "generators on the kernel's own thread would prove they work and nothing about whether "
         "a process can reach them. "
         "negative controls, one per proof: --negative proc-cache serves a cached /proc listing "
         "and the killed pid must linger; --negative usr-404 points the provider manifest at a "
         "missing object and the MOUNT must fail rather than serve an empty /usr; --negative "
         "trace-tiny builds the ring at 64 KiB and the dropped counter must go non-zero WHILE "
         "STAYING VISIBLE, which is why the 'counter is displayed' label is held and not failed. "
         "--negative no-isolation must come out BROKEN: the kernel's SAB does not exist there, so "
         "nothing is mounted and no proof can be taken.",
)
def check_m3(env: Env) -> None:
    got = env.read(READ_M3, M3_SHAPE)

    if got["state"] == "error":
        env.unmeasurable(
            "www/m3.html reported state 'error' before producing proofs: %s. Nothing below was "
            "measured." % (got["why"] or "no reason given"))
    if got["state"] == "aborted":
        env.unmeasurable(
            "www/m3.html aborted: %s. The kernel's SAB is not constructible without cross-origin "
            "isolation, so there is no mount table and no proof to take."
            % (got["why"] or "no reason given"))
    if got["state"] != "done":
        env.unmeasurable("www/m3.html never reached a terminal state (state=%r)" % got["state"])

    # Anti-vacuity FIRST, as every check here does: a page that produced no section must record
    # failing expectations rather than pass on an absent object.
    sections = ("mount_table", "proc_list", "proc_vanish", "proc_files", "provider_probe",
                "usr_mount", "trace_seq", "trace_dropped", "devices", "readonly", "tmpfs",
                "regress")
    env.expect_that(
        "cell reported",
        all(got[name] is not None for name in sections),
        "sections absent: %s" % ", ".join(n for n in sections if got[n] is None))

    env.expect("page isolated", got["isolated"], True)
    env.expect("kernel isolated", got["kernelIsolated"], True)
    env.expect_that("the kernel raised no error", not got["errors"],
                    "kernel errors: %s" % "; ".join(got["errors"][:4]))

    def ev(name):
        """One section's evidence, or an empty mapping.

        A section the page never produced has already failed `cell reported`; returning {} here
        means its clause labels record a failure too rather than raising and losing the rest of
        the inventory, which `run_one` would report as a label-set mismatch.
        """
        row = got[name]
        return (row or {}).get("evidence") or {}

    def section_ok(name):
        row = got[name]
        return bool(row and row.get("ok"))

    # ---- the mount table ----------------------------------------------------------------
    mt = ev("mount_table")
    env.expect_that("mount_table ok", section_ok("mount_table"), mt)
    paths = mt.get("paths") or []
    env.expect_that("the table has a root, /proc and /dev",
                    all(x in paths for x in ("/", "/proc", "/dev")), paths)
    env.expect_that("every mount reports a distinct non-zero device",
                    mt.get("devsDistinct") is True and mt.get("anyZeroDev") is False, mt)
    env.expect_that("only the OPFS root is durable",
                    mt.get("rootDurable") is True and mt.get("procDurable") is False, mt)

    # ---- PROOF 1 -----------------------------------------------------------------------
    pl = ev("proc_list")
    env.expect_that("proc_list ok", section_ok("proc_list"), pl)
    pids = pl.get("pids") or []
    env.expect_that("proc_list enumerates the live pids",
                    pl.get("reader") in pids and pl.get("victim") in pids, pl)
    env.expect_that("proc_list shows the reading process itself", pl.get("sawSelf") is True, pl)
    env.expect_that("proc_list reports every pid as a directory",
                    pl.get("allPidsAreDirs") is True, pl)

    pv = ev("proc_vanish")
    env.expect_that("proc_vanish ok", section_ok("proc_vanish"), pv)
    env.expect_that("proc_vanish the killed pid left the listing",
                    pv.get("stillListed") is False,
                    "pid %s, polled %s time(s), live %s"
                    % (pv.get("victim"), pv.get("polls"), pv.get("livePids")))
    env.expect_that("proc_vanish stat refuses with ENOENT",
                    pv.get("statRefusedENOENT") is True, pv.get("statErrno"))
    env.expect_that("proc_vanish open refuses with ENOENT",
                    pv.get("openRefusedENOENT") is True, pv.get("openErrno"))
    env.expect_that("proc_vanish the survivor is still listed",
                    pv.get("readerStillListed") is True, pv)

    pf = ev("proc_files")
    env.expect_that("proc_files ok", section_ok("proc_files"), pf)
    env.expect_that("proc_files status reports the pid",
                    pf.get("statusPid") == (pl.get("reader")), pf.get("statusPid"))
    env.expect("proc_files status reports the state", pf.get("state"), "running")
    env.expect_that("proc_files cmdline is NUL-terminated",
                    isinstance(pf.get("cmdline"), str) and pf["cmdline"].endswith("\x00"),
                    pf.get("cmdline"))
    env.expect("proc_files cwd is readable", pf.get("cwd"), "/")
    env.expect_that("proc_files the fd directory lists the open fds",
                    bool(pf.get("fds")), pf.get("fds"))
    # The volatile-size contract, both halves. A published size would be stale by the time the
    # caller read it, so the path call publishes none; the fd call holds a snapshot and reports
    # its exact length.
    env.expect_that("proc_files a volatile file publishes no size",
                    pf.get("statPublishesNoSize") is True
                    and pf.get("readIsNonEmpty") is True,
                    {"statSize": pf.get("statSize"), "readBytes": pf.get("readBytes")})
    env.expect_that("proc_files fstat reports the snapshot length",
                    pf.get("fstatMatchesRead") is True,
                    {"fstatSize": pf.get("fstatSize"), "fdReadBytes": pf.get("fdReadBytes")})

    # ---- PROOF 2 -----------------------------------------------------------------------
    pp = ev("provider_probe")
    env.expect_that("provider_probe ok", section_ok("provider_probe"), pp)
    env.expect_that("provider_probe a ranged GET returns the exact byte count",
                    pp.get("exactByteCount") is True, pp.get("local"))
    env.expect_that("provider_probe Content-Range is present",
                    pp.get("contentRangePresent") is True, pp.get("local"))
    env.expect_that("provider_probe a missing object is refused",
                    pp.get("missingObjectRefused") is True, pp.get("missingObjectWhy"))
    # WHICH refusal, not just that one happened. `providers.mjs` separates a bad status from an
    # unreachable host on purpose — a 404 and a dead network are different problems and the
    # browser withholds the reason for the second — so a probe that reported "unreachable" for a
    # present server would be the wrong diagnosis passing as the right one.
    #
    # The 404 itself needs no claiming here: it is declared in ALLOWED_404, which is what adds it
    # to the run's forgiven-console list. An earlier version asserted a console error had arrived
    # and was brittle for a reason worth recording — a 404 is a SUCCESSFUL fetch at the network
    # level, `fetch` resolves with status 404, and Chrome does not reliably log anything.
    env.expect("provider_probe the missing object is refused as a bad status",
               pp.get("missingObjectWhy"), "bad-status")

    um = ev("usr_mount")
    env.expect_that("usr_mount ok", section_ok("usr_mount"), um)
    env.expect_that("usr_mount /usr is in the mount table", um.get("mounted") is True,
                    {"mounted": um.get("mounted"), "code": um.get("refusalCode"),
                     "why": um.get("refusalWhy")})
    usr = um.get("usr") or {}
    env.expect_that("usr_mount every manifest entry was read",
                    usr.get("ok") is True and (usr.get("bytes") or 0) > 0, usr)

    # ---- PROOF 3 -----------------------------------------------------------------------
    ts = ev("trace_seq")
    env.expect_that("trace_seq ok", section_ok("trace_seq"), ts)
    env.expect_that("trace_seq the known sequence is in the trace",
                    ts.get("sequenceFound") is True,
                    {"at": ts.get("sequenceFoundAt"), "tail": ts.get("tail")})
    env.expect_that("trace_seq entry and exit are both recorded",
                    ts.get("sawEnterAndExit") is True, ts.get("tail"))
    env.expect_that("trace_seq the record sequence is monotonic",
                    ts.get("seqMonotonic") is True, ts)

    td = ev("trace_dropped")
    env.expect_that("trace_dropped ok", section_ok("trace_dropped"), td)
    # HELD under trace-tiny: the counter must be visible whether or not it is zero.
    env.expect_that("trace_dropped the counter is displayed",
                    td.get("droppedDisplayed") is True, td)
    env.expect_that("trace_dropped the ring dropped nothing", td.get("dropped") == 0,
                    {"dropped": td.get("dropped"), "written": td.get("written"),
                     "capacity": td.get("capacity")})
    env.expect_that("trace_dropped the ring meets the 16 MiB floor",
                    (td.get("bytes") or 0) >= 16 * 1024 * 1024
                    and td.get("undersized") is False,
                    {"bytes": td.get("bytes"), "undersized": td.get("undersized")})

    # ---- the table and the read-only rule, from userland --------------------------------
    dv = ev("devices")
    env.expect_that("devices ok", section_ok("devices"), dv)
    env.expect_that("devices stat reports three distinct devices",
                    dv.get("distinctDevices") == 3 and dv.get("anyZeroDevice") is False,
                    dv.get("statDevs"))

    ro = ev("readonly")
    env.expect_that("readonly ok", section_ok("readonly"), ro)
    env.expect_that("readonly every mutation on /proc is refused",
                    ro.get("allRefused") is True, ro.get("rows"))
    env.expect_that("readonly every refusal is EROFS", ro.get("allEROFS") is True,
                    {"errnos": ro.get("errnos"), "EROFS": ro.get("EROFS")})

    tm = ev("tmpfs")
    env.expect_that("tmpfs ok", section_ok("tmpfs"), tm.get("failed"))
    env.expect_that("tmpfs /tmp is mounted writable and not durable",
                    tm.get("mounted") is True and tm.get("writable") is True
                    and tm.get("notDurable") is True, tm)
    # Per-call, so a failure names the syscall. A single "it worked" would pass for a tmpfs that
    # wrote correctly and forgot a chmod.
    env.expect_that("tmpfs every call succeeded",
                    not (tm.get("failed") or []),
                    {"failed": tm.get("failed"), "calls": tm.get("calls")})

    rg = ev("regress")
    env.expect_that("regress ok", section_ok("regress"), rg.get("failed"))
    # Named, so a reopened defect says WHICH. These are the three uncaught-throw paths an
    # unprivileged process could reach, the append bug, and the dotdot semantics.
    env.expect_that("regress no finding reopened",
                    not (rg.get("failed") or []),
                    {"failed": rg.get("failed"), "calls": rg.get("calls")})

    env.expect("verdict is ok", got["verdict"], "ok")

    # The wire, as every check here ends: the document's own headers and a byte-for-byte witness
    # that the page served is the page on disk.
    served = env.request(env.document)
    env.expect("document COOP", served.headers.get("Cross-Origin-Opener-Policy"), "same-origin")
    env.expect("document COEP", served.headers.get("Cross-Origin-Embedder-Policy"), "require-corp")
    env.expect_that("served m3.html", env.served_matches_disk(env.document),
                    "the m3.html served does not match www/m3.html on disk")


@check(
    name="m4",
    milestone="m4",
    controls=(Control.INVERT, Control.NO_ISOLATION, Control.NO_SIGPIPE),
    labels=M4_LABELS,
    requires_isolation=True,
    root=Root.REPO,
    document=M4_DOCUMENT,
    ready_expr=M4_READY,
    ready_what="globalThis.M4.state reaching done, aborted or error (www/m4.html)",
    # The headline run is 1.1 s measured, over five fresh kernels. The bound is generous and is
    # still a BOUND: a deadlocked pipeline raises no error anywhere, so a pipe that stopped must
    # end as a BROKEN check carrying the kernel's park and refcount state — which www/m4.html
    # attaches to the timeout — rather than as a suite that never returns.
    ready_timeout=240.0,
    refusal_expr="globalThis.M4 && globalThis.M4.state",
    refusal_want="aborted",
    note="five sections, each a pipeline built from the mechanism the shell will use — `pipe2` + "
         "`spawn` with posix_spawn file actions + `setpgid`, which is what replaces `fork`. The "
         "milestone states its proofs in shell syntax and there is no shell until M5, so an "
         "orchestrator process spawns its own stages and every byte and every signal crosses a "
         "real syscall from inside a real process worker. "
         "THE ASYMMETRY IS THE SUBJECT (docs/ABI.md decision 5): a blocked reader whose last "
         "writer went sees 0, meaning EOF and NOT an errno, while a blocked writer whose last "
         "reader went gets -EPIPE plus SIGPIPE. Getting it backwards makes `yes | head -1` either "
         "hang or report a spurious error. "
         "negative control: --negative no-sigpipe-signal stops SIGPIPE being fatal, and the two "
         "proofs that turn on that disposition must fail while the reader's EOF and the "
         "process-group signal hold. --negative no-isolation must come out BROKEN: no SAB, so no "
         "kernel and no processes to pipe between.",
)
def check_m4(env: Env) -> None:
    got = env.read(READ_M4, M4_SHAPE)

    if got["state"] == "error":
        env.unmeasurable(
            "www/m4.html reported state 'error' before producing proofs: %s. Nothing below was "
            "measured." % (got["why"] or "no reason given"))
    if got["state"] == "aborted":
        env.unmeasurable(
            "www/m4.html aborted: %s. The kernel's SAB is not constructible without cross-origin "
            "isolation, so no process exists and nothing can be piped."
            % (got["why"] or "no reason given"))
    if got["state"] != "done":
        env.unmeasurable("www/m4.html never reached a terminal state (state=%r)" % got["state"])

    sections = ("pipe_basic", "yes_head", "group_signal", "killed_writer_eof",
                "killed_reader_epipe")
    env.expect_that(
        "cell reported",
        all(got[name] is not None for name in sections),
        "sections absent: %s" % ", ".join(n for n in sections if got[n] is None))

    env.expect("page isolated", got["isolated"], True)
    env.expect("kernel isolated", got["kernelIsolated"], True)
    env.expect_that("the kernel raised no error", not got["errors"],
                    "kernel errors: %s" % "; ".join(got["errors"][:4]))

    def ev(name):
        row = got[name]
        return (row or {}).get("evidence") or {}

    def section_ok(name):
        row = got[name]
        return bool(row and row.get("ok"))

    # ---- a pipe carries bytes between two processes --------------------------------------
    pb = ev("pipe_basic")
    env.expect_that("pipe_basic ok", section_ok("pipe_basic"), pb)
    env.expect_that("pipe2 returns two distinct fds", pb.get("twoDistinctFds") is True,
                    pb.get("pipe"))
    env.expect_that("both pipeline stages were reaped", pb.get("bothReaped") is True,
                    {"writer": pb.get("writer"), "reader": pb.get("reader")})

    # ---- PROOF: `yes | head -1` terminates -----------------------------------------------
    yh = ev("yes_head")
    env.expect_that("yes_head ok", section_ok("yes_head"), yh)
    # THE CLAUSE THE CONTROL MOVES. Killed, and by SIGPIPE — not exited, and not still running.
    env.expect_that("the writer was killed by SIGPIPE", yh.get("yesKilledBySigpipe") is True,
                    {"yes": yh.get("yes"), "SIGPIPE": yh.get("SIGPIPE")})
    env.expect_that("and the reader exited cleanly",
                    bool(yh.get("head") and yh["head"].get("exited")), yh.get("head"))

    # ---- PROOF: one signal kills every stage of the pipeline ------------------------------
    gs = ev("group_signal")
    env.expect_that("group_signal ok", section_ok("group_signal"), gs)
    # THE GROUP IS THE SUBJECT. Two separate kill(pid) calls passed this section while
    # `deliverSignal`'s target < 0 branch and the pgid inheritance M4 added went untested.
    pgids = gs.get("stagePgids") or []
    env.expect_that("both stages share one process group, and the orchestrator is outside it",
                    len(pgids) == 2 and pgids[0] == gs.get("sleeperPid")
                    and pgids[1] == gs.get("sleeperPid")
                    and gs.get("orchestratorOutsideTheGroup") is True,
                    {"stagePgids": pgids, "sleeperPid": gs.get("sleeperPid"),
                     "myPgid": gs.get("myPgid"), "setpgid": gs.get("setpgidResults")})
    env.expect_that("one kill(-pgid) signalled the group", gs.get("groupKillResult") == 0,
                    gs.get("groupKillResult"))
    env.expect_that("both stages died of SIGINT", gs.get("bothKilledByInt") is True,
                    {"sleeper": gs.get("sleeper"), "catter": gs.get("catter"),
                     "started": gs.get("started"), "SIGINT": gs.get("SIGINT")})

    # ---- PROOF: a killed writer gives its blocked reader EOF, not an errno ----------------
    kw = ev("killed_writer_eof")
    env.expect_that("killed_writer_eof ok", section_ok("killed_writer_eof"), kw)
    env.expect_that("the killed writer was reaped", kw.get("writerWasKilled") is True,
                    kw.get("writer"))
    # EOF is 0 and not an errno, so the reader must EXIT CLEANLY rather than fault or error.
    env.expect_that("and its blocked reader exited cleanly",
                    kw.get("readerExitedCleanly") is True, kw.get("reader"))

    # ---- PROOF: a blocked writer whose reader died gets SIGPIPE ---------------------------
    kr = ev("killed_reader_epipe")
    env.expect_that("killed_reader_epipe ok", section_ok("killed_reader_epipe"), kr)
    env.expect_that("the blocked writer was killed by SIGPIPE",
                    kr.get("writerKilledBySigpipe") is True,
                    {"writer": kr.get("writer"), "SIGPIPE": kr.get("SIGPIPE")})

    env.expect("verdict is ok", got["verdict"], "ok")

    served = env.request(env.document)
    env.expect("document COOP", served.headers.get("Cross-Origin-Opener-Policy"), "same-origin")
    env.expect("document COEP", served.headers.get("Cross-Origin-Embedder-Policy"), "require-corp")
    env.expect_that("served m4.html", env.served_matches_disk(env.document),
                    "the m4.html served does not match www/m4.html on disk")


@check(
    name="m4b",
    milestone="m4b",
    controls=(Control.INVERT, Control.NO_ISOLATION, Control.NO_ISIG, Control.NO_POLL_WAKE,
              Control.NO_FINISH_GUARD, Control.NO_WINCH),
    labels=M4B_LABELS,
    requires_isolation=True,
    root=Root.REPO,
    document=M4B_DOCUMENT,
    ready_expr=M4B_READY,
    ready_what="globalThis.M4B.state reaching done, aborted or error (www/m4b.html)",
    # 3.0 s measured for the headline run, 11 s under no-isig where two stages are no longer
    # killed and run their 8 s sleep to completion. The bound is generous and is still a BOUND: a
    # stuck pty raises no error, so a terminal that stopped must end as a BROKEN check carrying the
    # kernel's park state — which www/m4b.html attaches to its own timeout.
    ready_timeout=240.0,
    refusal_expr="globalThis.M4B && globalThis.M4B.state",
    refusal_want="aborted",
    note="eleven sections over eleven fresh kernels. The milestone specifies exactly ONE "
         "behaviour of "
         "the discipline — Ctrl-C raising SIGINT on the foreground group 'even when the UI is "
         "wedged' — and `wedged_intr` is that proof, against a stage spinning in a compute loop "
         "and issuing a syscall only every 20,000 iterations. ICANON and ECHO semantics are "
         "specified in NO authored document, so those sections assert POSIX's defaults taken as "
         "an assumption, said so in src/kernel/pty.mjs. "
         "`poll` is here because constraint 42 is normative — the single wait primitive over fds — "
         "even though M4's build list omits it: a process has one futex word and one outstanding "
         "call, so one terminal plus a pipe cannot otherwise wake it, which is the case M4a's "
         "terminal hits first. Both halves are proved: reporting readiness, and PARKING over two "
         "fds and being woken by one. "
         "negative controls, four: --negative no-isig clears ISIG on every new pty and both "
         "Ctrl-C sections must fail while echo, canonical buffering and the poll sections hold; "
         "--negative no-poll-wake stops re-evaluating parked polls — on a reply AND on a timeout, "
         "because removing only the first left the timeout answering correctly five seconds late "
         "and the control broke nothing a check could see; --negative no-finish-guard answers a "
         "call its handler's own side effect already answered, which only `self_signal` reaches; "
         "--negative no-winch leaves the resize and removes its signal, which is what shows the "
         "SIGWINCH clause is capable of failing at all. --negative no-isolation must come out BROKEN: no SAB, so no kernel and "
         "no process to give a terminal to.",
)
def check_m4b(env: Env) -> None:
    got = env.read(READ_M4B, M4B_SHAPE)

    if got["state"] == "error":
        env.unmeasurable(
            "www/m4b.html reported state 'error' before producing proofs: %s. Nothing below was "
            "measured.%s"
            % (got["why"] or "no reason given",
               # The stalled proof's own record: the step that timed out and the kernel messages
               # that did arrive. Without it a stall is only a sentence.
               ("\n    stalled: %s" % got["stuck"]) if got["stuck"] else
               "\n    (www/m4b.html recorded no `stuck` state, so the stall was not in a proof's "
               "handshake)"))
    if got["state"] == "aborted":
        env.unmeasurable(
            "www/m4b.html aborted: %s. Without cross-origin isolation the kernel's SAB is not "
            "constructible, so no process exists to give a terminal to."
            % (got["why"] or "no reason given"))
    if got["state"] != "done":
        env.unmeasurable("www/m4b.html never reached a terminal state (state=%r)" % got["state"])

    sections = ("echo", "canonical", "intr", "wedged_intr", "raw_isig_off", "termios",
                "winsize", "self_signal", "empty_poll", "fd_limit",
                "teardown_wake", "open_leak", "poll_ready", "poll_wait", "fg_pgrp")
    env.expect_that(
        "cell reported",
        all(got[name] is not None for name in sections),
        "sections absent: %s" % ", ".join(n for n in sections if got[n] is None))

    env.expect("page isolated", got["isolated"], True)
    env.expect("kernel isolated", got["kernelIsolated"], True)
    env.expect_that("the kernel raised no error", not got["errors"],
                    "kernel errors: %s" % "; ".join(got["errors"][:4]))

    def ev(name):
        return (got[name] or {}).get("evidence") or {}

    def same(d, measured, constant):
        """Two fields from the page, NEITHER allowed to be absent.

        `d.get(a) == d.get(b)` is True when both are missing, because `None == None` — so a clause
        written that way passes against a page that published neither the errno it measured nor
        the constant it was compared against. Two clauses here read exactly that way: the ENOTTY
        check and the POLLNVAL check, each comparing a measurement to a constant that travels in
        the same evidence object, so one typo in the page would have taken both halves out
        together and left the clause green.
        """
        a, b = d.get(measured), d.get(constant)
        return a is not None and b is not None and a == b

    def section_ok(name):
        row = got[name]
        return bool(row and row.get("ok"))

    # ---- ECHO and ICANON: POSIX defaults, assumed ----------------------------------------
    e = ev("echo")
    env.expect_that("echo ok", section_ok("echo"), e)
    # CR LF, because a bare LF leaves the cursor in the same column on a real terminal.
    env.expect_that("a typed line is echoed to the master as CR LF",
                    e.get("echoedAsCrLf") is True, e.get("echo"))

    c = ev("canonical")
    env.expect_that("canonical ok", section_ok("canonical"), c)
    env.expect_that("a partial line leaves the reader parked",
                    c.get("parkedOnPartialLine") is True,
                    {"state": c.get("stateWhilePartial"), "child": c.get("child")})

    # ---- THE ONE SPECIFIED BEHAVIOUR ------------------------------------------------------
    i = ev("intr")
    env.expect_that("intr ok", section_ok("intr"), i)
    env.expect_that("Ctrl-C killed the foreground group with SIGINT",
                    i.get("killedByInt") is True,
                    {"child": i.get("child"), "fgPgid": i.get("fgPgid"),
                     "SIGINT": i.get("SIGINT")})
    # The byte must be CONSUMED. Echoing it would put a stray ^C in the output; delivering it
    # would hand the program its own interrupt as data.
    env.expect_that("and the Ctrl-C byte was consumed, not echoed",
                    i.get("echoHasRawIntr") is False, i.get("echo"))

    w = ev("wedged_intr")
    env.expect_that("wedged_intr ok", section_ok("wedged_intr"), w)
    env.expect_that("Ctrl-C reached a process spinning in a compute loop",
                    w.get("killedByInt") is True, w.get("child"))

    r = ev("raw_isig_off")
    env.expect_that("raw_isig_off ok", section_ok("raw_isig_off"), r)
    env.expect_that("with ISIG off the Ctrl-C arrives as data",
                    r.get("exitedNormally") is True and r.get("setResult") == 0,
                    {"child": r.get("child"), "lflag": r.get("lflagAfter")})

    # ---- termios -------------------------------------------------------------------------
    tm = ev("termios")
    env.expect_that("termios ok", section_ok("termios"), tm)
    env.expect_that("a fresh pty is canonical, echoing and signal-generating",
                    tm.get("defaultIsCanonEchoIsig") is True,
                    {"lflag": tm.get("defaultLflag"), "vintr": tm.get("defaultVintr")})
    # A caller built against today's three lflag bits must not silently clear a later one.
    env.expect_that("the reserved termios words survive a set",
                    tm.get("reservedPreserved") is True and tm.get("lastCcPreserved") is True
                    and tm.get("lflagApplied") is True, tm)
    env.expect_that("an fd that is not a terminal is ENOTTY",
                    same(tm, "notTtyErrno", "ENOTTY"),
                    {"got": tm.get("notTtyErrno"), "ENOTTY": tm.get("ENOTTY")})

    ws = ev("winsize")
    env.expect_that("winsize ok", section_ok("winsize"), ws)
    # A NON-FATAL SIGNAL AT A PARKED PROCESS IS OBSERVABLE ONLY AS THE PARK ENDING EARLY. This
    # read `sleepInterrupted`, which was the stage's `exited` flag — true of a sleep that ran its
    # full 8 seconds and returned 0, so the clause passed whether or not SIGWINCH was delivered
    # and no mutation of the signal path could move it. The stage now exits 0 only when its own
    # `clock_nanosleep` returned -EINTR, and its verdict is what is asserted here.
    env.expect_that("a resize raises SIGWINCH on the foreground group",
                    ws.get("resized") is True and ws.get("sleepInterrupted") is True
                    and ws.get("stageVerdict") == 0,
                    {"before": ws.get("before"), "after": ws.get("after"),
                     "stageVerdict": ws.get("stageVerdict"), "child": ws.get("child")})

    # ---- a pty operation whose signal lands on THE CALLER ---------------------------------
    #
    # Every other proof here moves the foreground group to a child before signalling, which is
    # what a shell does per pipeline — so none of them reached the case where the signal's target
    # is the process making the call. `pty_open` sets the foreground group from the OPENER's pgid,
    # so a resize before the group moves raises SIGWINCH on the caller. The kernel interrupted the
    # in-flight call AND then replied to the handler's return as well: two replies for one call,
    # two SEQ bumps, two G_INFLIGHT decrements.
    ss = ev("self_signal")
    env.expect_that("self_signal ok", section_ok("self_signal"), ss)
    env.expect_that("a fresh pty's foreground group is the opener's own",
                    ss.get("foregroundIsMine") is True,
                    {"fgBefore": ss.get("fgBefore"), "myPgid": ss.get("myPgid")})
    # The resize happens, then the signal — so an interrupted caller still finds it resized. A
    # resize lost to its own signal would be the other plausible outcome and is not this one.
    env.expect_that("a resize that signals the caller still resizes",
                    ss.get("resized") is True,
                    {"after": ss.get("after"), "setResult": ss.get("setResult")})
    env.expect_that("and the caller observes its own interruption",
                    ss.get("sawEintr") is True and ss.get("EINTR") is not None
                    and ss.get("setResult") == -ss["EINTR"],
                    {"setResult": ss.get("setResult"), "EINTR": ss.get("EINTR")})
    # THE CLAUSE WITH THE TEETH. A second reply leaves the channel one ahead of itself, and a
    # program meets that as a call returning an answer it never asked for.
    env.expect_that("the channel is not left one reply ahead",
                    ss.get("channelIntact") is True and same(ss, "nextCall", "myPgid"),
                    {"drained": ss.get("drained"), "nextCall": ss.get("nextCall"),
                     "myPgid": ss.get("myPgid")})
    # And the kernel's own account: EXACTLY ONE call was answered by its own side effect. An exact
    # count rather than a bound, so the counter cannot absorb a genuine double reply elsewhere.
    env.expect("exactly one call was answered by its own side effect",
               ss.get("answeredDuringCall"), 1)
    # THE PROGRAM FETCH'S DEADLINE DID NOT FIRE. It exists so a stalled load fails `spawn` rather
    # than hanging it (constraint 155), and a healthy run must never reach it — a non-zero count
    # means the bound has become the normal path, which is a different system from the one every
    # other expectation here was measured against.
    env.expect_that("the program loader never reached its deadline",
                    ss.get("programFetchTimeouts") == 0 and ss.get("programFetchRetries") == 0,
                    {"timeouts": ss.get("programFetchTimeouts"),
                     "retries": ss.get("programFetchRetries")})

    # ---- a negative timeout is INFINITE, and a refused `dup` leaks nothing ---------------
    ep = ev("empty_poll")
    env.expect_that("empty_poll ok", section_ok("empty_poll"), ep)
    # `poll(NULL, 0, -1)` is POSIX's "block until a signal". It answered 0 immediately, which is a
    # busy-wait where the caller asked to park. Asserted as the stage still being parked IN `poll`
    # when the orchestrator looks — not merely alive, which is true of every non-zombie.
    env.expect_that("poll over an empty set with no timeout blocks",
                    ep.get("parkedInEmptyPoll") is True and same(ep, "parkedIn", "SYS_poll"),
                    {"parkedIn": ep.get("parkedIn"), "why": ep.get("parkedWhy")})
    env.expect_that("and only a signal ends it",
                    ep.get("endedBySignal") is True,
                    {"child": ep.get("child"), "SIGINT": ep.get("SIGINT")})

    fl = ev("fd_limit")
    env.expect_that("fd_limit ok", section_ok("fd_limit"), fl)
    # Without this the refused dups never happened, so the clause below would assert nothing.
    env.expect_that("the fd table really reached its ceiling",
                    fl.get("tableFilled") is True and same(fl, "refusedErrno", "EMFILE"),
                    {"duped": fl.get("duped"), "refusedErrno": fl.get("refusedErrno"),
                     "EMFILE": fl.get("EMFILE")})
    # `dup` raised the description's refcount BEFORE asking for an fd, so every refusal left it
    # one high and the kind's `close` op — which fires only when the last reference goes — never
    # fired. A pipe whose writer count never drops leaves its reader on an EOF that cannot
    # arrive: constraint 92's deadlock reached through -EMFILE, with no error anywhere.
    # ASKED THROUGH `poll` so the failure REPORTS: with a leaked reference the reader sees
    # nothing, and a `read` would park forever — ending as a BROKEN check with no expectations,
    # indistinguishable from a harness fault. A check has to be able to fail, not wedge.
    env.expect_that("a refused dup leaks no reference, so the reader sees EOF",
                    fl.get("eofAfterRefusedDups") is True and fl.get("pollResult") == 1
                    and fl.get("revents") is not None
                    and (fl["revents"] & fl.get("POLLIN", 0)) != 0,
                    {"pollResult": fl.get("pollResult"), "revents": fl.get("revents"),
                     "POLLIN": fl.get("POLLIN")})
    env.expect("and the read that follows returns 0", fl.get("readResult"), 0)

    tw = ev("teardown_wake")
    env.expect_that("teardown_wake ok", section_ok("teardown_wake"), tw)
    env.expect_that("a process parked in poll with no timeout stays parked",
                    tw.get("parkedInPoll") is True and same(tw, "parkedIn", "SYS_poll"),
                    {"parkedIn": tw.get("parkedIn"), "why": tw.get("parkedWhy")})
    # The wake is hooked on `reply` so no pollable kind can forget it, and teardown is the one
    # path that moves readiness without replying: its only `reply` runs BEFORE the fd sweep that
    # drops the dying process's pipe `writers` to 0. The poller waited forever.
    env.expect_that("a dying writer's fd sweep wakes a peer parked in poll",
                    tw.get("wokenByTeardown") is True,
                    {"wokeRounds": tw.get("wokeRounds"), "stateAfter": tw.get("stateAfter")})
    # Woke with the RIGHT answer, not merely woke: the stage exits 0 only if revents carried
    # POLLIN, which is what a pipe with no writer left must report.
    env.expect("and the woken poll reported the pipe readable", tw.get("pollerVerdict"), 0)

    ol = ev("open_leak")
    env.expect_that("open_leak ok", section_ok("open_leak"), ol)
    env.expect_that("an open with no fd left is refused with EMFILE",
                    ol.get("openRefused") is True and same(ol, "refusedOpenErrno", "EMFILE"),
                    {"refusedOpenErrno": ol.get("refusedOpenErrno"), "EMFILE": ol.get("EMFILE")})
    # `createSyncAccessHandle` is an exclusive lock per file, so a handle the refused open kept
    # made this one file unopenable by any process for the lifetime of the page — a retryable
    # errno turned into permanent loss of one file.
    env.expect_that("and keeps no sync access handle, so the file reopens",
                    ol.get("reopened") is True and ol.get("text") == "hello",
                    {"reopenErrno": ol.get("reopenErrno"), "bytes": ol.get("bytes"),
                     "text": ol.get("text")})

    # ---- poll, both halves ---------------------------------------------------------------
    pr = ev("poll_ready")
    env.expect_that("poll_ready ok", section_ok("poll_ready"), pr)
    env.expect_that("poll reports an idle set as nothing ready", pr.get("idleReady") == 0, pr)
    env.expect_that("poll reports a ready pipe and a ready terminal",
                    pr.get("pipeReady") == 1 and pr.get("ttyReady") == 1
                    and pr.get("pipeQuietAfterDrain") is True,
                    {"pipe": pr.get("pipeRevents"), "tty": pr.get("ttyRevents"),
                     "quietAfterDrain": pr.get("pipeQuietAfterDrain")})
    env.expect_that("poll reports a closed fd as POLLNVAL",
                    same(pr, "badRevents", "POLLNVAL"),
                    {"got": pr.get("badRevents"), "POLLNVAL": pr.get("POLLNVAL")})

    pw = ev("poll_wait")
    env.expect_that("poll_wait ok", section_ok("poll_wait"), pw)
    # The stage's OWN account, read off the pty, plus its exit code. Asserting on what it saw
    # rather than only that it finished.
    env.expect_that("a process parked in poll over two fds was woken by one",
                    pw.get("parkedInPoll") is True and pw.get("wokeOnPipeOnly") is True
                    and pw.get("stageVerdict") == 0,
                    {"said": pw.get("stageSaid"), "exit": pw.get("stageVerdict"),
                     "parked": pw.get("parkedInPoll")})

    fg = ev("fg_pgrp")
    env.expect_that("fg_pgrp ok", section_ok("fg_pgrp"), fg)
    env.expect_that("the foreground group moves, and a group that does not exist is refused",
                    fg.get("initialIsTheStage") is True and fg.get("bogusRefused") is True
                    and fg.get("bogusErrno") == fg.get("ESRCH")
                    and fg.get("movedToMine") is True and fg.get("movedBack") is True, fg)

    env.expect("verdict is ok", got["verdict"], "ok")

    served = env.request(env.document)
    env.expect("document COOP", served.headers.get("Cross-Origin-Opener-Policy"), "same-origin")
    env.expect("document COEP", served.headers.get("Cross-Origin-Embedder-Policy"), "require-corp")
    env.expect_that("served m4b.html", env.served_matches_disk(env.document),
                    "the m4b.html served does not match www/m4b.html on disk")


@check(
    name="m5",
    milestone="m5",
    controls=(Control.INVERT, Control.NO_ISOLATION, Control.SPAWN_SELF,
              Control.NO_MOUNTPOINTS),
    labels=M5_LABELS,
    requires_isolation=True,
    root=Root.REPO,
    document=M5_DOCUMENT,
    ready_expr=M5_READY,
    ready_what="globalThis.M5.state reaching done, aborted or error (www/m5.html)",
    # 9.7 s measured for the headline run over nine fresh kernels, each of which mounts /usr (15
    # objects) and /bench (3) over the local provider before a process exists. It was 38 s until
    # `p_exec` stopped draining a pipe a backgrounded `sleep 30` was holding open — 30.9 s of
    # waiting for a process it was about to kill (constraint 185). The bound is generous and is
    # still a BOUND: a deadlocked pipeline raises no error anywhere - a parked
    # reader and a parked writer are both legitimate states - so a shell that stopped must end as
    # a BROKEN check carrying the kernel's park and refcount state, which www/m5.html attaches to
    # its own timeout, rather than as a suite that never returns.
    ready_timeout=300.0,
    refusal_expr="globalThis.M5 && globalThis.M5.state",
    refusal_want="aborted",
    note="eight sections over nine fresh kernels. The headline is MILESTONES.md M5's own proof - "
         "`ls /usr/bin | grep c | wc -l` correct through three real processes, then `sleep 60 &`, "
         "`ps`, `kill %1`. THE EXPECTED COUNT IS NOT WRITTEN DOWN: the orchestrator lists "
         "/usr/bin through syscalls and works it out, so the two routes to the same number are an "
         "independent listing and three processes talking over two pipes. 'Three real processes' "
         "is read out of /dev/trace, the kernel's own record of which pid issued which syscall, "
         "rather than inferred from the answer being right.\n"
         "M5 ALSO CLOSED A HOLE IT DID NOT SET OUT TO. `SYS_spawn` used to hand its caller's path "
         "to `fetch`, so a process could name any origin and have the kernel evaluate the reply "
         "as a program (constraint 123). Programs now come out of the filesystem, and the "
         "`no_url` section asserts every spelling that used to work is refused BY THE MOUNT "
         "TABLE - including `/src/bin/true.mjs`, which is a real file on the server and is not in "
         "this system's filesystem, so a kernel that still reached the network would spawn that "
         "one and nothing else.\n"
         "negative control: --negative spawn-self makes `spawn` answer the caller's own pid and "
         "create nothing. The pipeline, the job control, the redirection and the terminal's typed "
         "line must fail; the builtins, the refusals and the URL refusals must HOLD, which is why "
         "those sections are written to spawn nothing at all. --negative no-isolation must come "
         "out BROKEN: no SAB, so no kernel and nothing to load a shell into.",
)
def check_m5(env: Env) -> None:
    got = env.read(READ_M5, M5_SHAPE)

    if got["state"] == "error":
        env.unmeasurable(
            "www/m5.html reported state 'error' before producing proofs: %s. Nothing below was "
            "measured." % (got["why"] or "no reason given"))
    if got["state"] == "aborted":
        env.unmeasurable(
            "www/m5.html aborted: %s. Without cross-origin isolation the kernel's SAB is not "
            "constructible, so no process exists and there is nothing to load a shell into."
            % (got["why"] or "no reason given"))
    if got["state"] != "done":
        env.unmeasurable("www/m5.html never reached a terminal state (state=%r)" % got["state"])

    sections = ("pipeline", "jobs", "redirect", "builtins", "exec", "refusals", "tty", "no_url",
                "endless")
    env.expect_that(
        "cell reported",
        all(got[name] is not None for name in sections),
        "sections absent: %s" % ", ".join(n for n in sections if got[n] is None))

    env.expect("page isolated", got["isolated"], True)
    env.expect("kernel isolated", got["kernelIsolated"], True)
    env.expect_that("the kernel raised no error", not got["errors"],
                    "kernel errors: %s" % "; ".join(got["errors"][:4]))

    def ev(name):
        return (got[name] or {}).get("evidence") or {}

    def section_ok(name):
        row = got[name]
        return bool(row and row.get("ok"))

    # ---- the mounts the ten programs live on ---------------------------------------------
    mounts = got["mounts"] or {}
    usr = mounts.get("usr") or {}
    bench = mounts.get("bench") or {}
    env.expect_that(
        "the mounts the programs live on are there",
        bool(usr.get("ok")) and (usr.get("entries") or 0) >= 11
        and bool(bench.get("ok")) and "/usr" in (mounts.get("rows") or []),
        {"rows": mounts.get("rows"), "usr": usr, "bench": bench})
    # ---- AND EVERY MOUNTPOINT IS A DIRECTORY ON THE VOLUME BENEATH IT ------------------
    #
    # REPORTED BY A READER WHO TYPED `ls /` AND GOT NOTHING. The mount table resolves by longest
    # component prefix, so `/usr` worked without existing anywhere - and the volume underneath had
    # no entry for it, so the root listing was EMPTY and `cd /usr/..` answered ENOENT on a `/usr`
    # that every other path call could reach. Both symptoms are one cause (constraint 238).
    #
    # THE SET IS NAMED, not counted: a count passes while the one mountpoint a reader cd's into is
    # the missing one.
    points = {row.get("path"): row for row in (mounts.get("mountpoints") or [])}
    env.expect_that(
        "every mountpoint exists as a directory on the volume beneath it",
        set(points) >= {"/proc", "/dev", "/tmp", "/usr", "/bench"}
        and not [r for r in points.values() if r.get("why")],
        {"mountpoints": mounts.get("mountpoints")})
    # THE EXEC LOADER HAS NO `fetches` FIELD because src/kernel/exec.mjs contains no fetch to
    # count. What is asserted here is the state the counters are in on a kernel that has just
    # booted and run nothing: a loader that had been to the network for a process would have to
    # have loaded an image to do it.
    exec_stats = mounts.get("exec") or {}
    env.expect_that(
        "no program crossed the wire for a process",
        exec_stats.get("loads") == 0 and exec_stats.get("images") == 0
        and "fetches" not in exec_stats,
        exec_stats)

    # ---- PROOF: `ls /usr/bin | grep c | wc -l` through three real processes ---------------
    pl = ev("pipeline")
    env.expect_that("pipeline ok", section_ok("pipeline"), pl)
    # THE TWO NUMBERS MUST AGREE AND NEITHER MAY BE ABSENT. `pl.get(a) == pl.get(b)` is True when
    # both are missing, which is a clause that passes against a page that published neither.
    env.expect_that(
        "`ls /usr/bin | grep c | wc -l` printed the count this check worked out for itself",
        pl.get("printed") is not None and pl.get("expected") is not None
        and pl["printed"] == pl["expected"] and pl["expected"] > 0,
        {"printed": pl.get("printed"), "expected": pl.get("expected"), "raw": pl.get("raw")})
    # THE CLAUSE THE CONTROL MOVES: the kernel's own record of how many processes did it.
    env.expect_that("and the trace shows four or more distinct pids doing it",
                    pl.get("sawAtLeastFourPids") is True,
                    {"distinct": pl.get("distinctPidsInTrace")})
    env.expect_that("a two-stage pipeline counts every name",
                    pl.get("twoStageMatchesAll") is True,
                    {"twoStage": pl.get("twoStage"), "allNames": pl.get("allNames"),
                     "unpipedLines": pl.get("unpipedLines")})

    # ---- PROOF: `sleep 60 &`, `ps`, `kill %1` --------------------------------------------
    jb = ev("jobs")
    env.expect_that("jobs ok", section_ok("jobs"), jb)
    env.expect_that("ps listed the backgrounded sleep by pid",
                    jb.get("psSawSleeper") is True and (jb.get("sleeperPid") or 0) > 0,
                    {"sleeperPid": jb.get("sleeperPid"), "output": jb.get("output")})
    env.expect_that("and listed the shell that started it", jb.get("psSawShell") is True,
                    {"shellPid": jb.get("shellPid"), "output": jb.get("output")})
    # The argv came out of /proc/<pid>/cmdline, so this is also a proof that argv reached the
    # process table rather than that `ps` printed its own operand back.
    env.expect_that("ps printed the argv the job was given",
                    jb.get("psCommand") == "sleep 60", jb.get("psCommand"))
    env.expect_that("kill %1 resolved a job spec and the job died of SIGTERM",
                    jb.get("jobsReportedKilled") is True,
                    {"SIGTERM": jb.get("SIGTERM"), "output": jb.get("output")})

    # ---- the row-wise sections ------------------------------------------------------------
    # Each is a table of rows the orchestrator scored, and the clause names the failures rather
    # than reporting "the section failed": a redirection bug and a builtin bug must not read the
    # same in the report.
    for name, label in (
        ("redirect", "every redirection row held"),
        ("builtins", "every builtin row held"),
        ("exec", "every exec row held"),
        ("refusals", "every refusal row held"),
    ):
        row = ev(name)
        env.expect_that("%s ok" % name, section_ok(name), row)
        env.expect_that(label, not (row.get("failed") or []),
                        {"failed": row.get("failed"), "rows": len(row.get("rows") or [])})

    # ---- PROOF: the shell interactive on a real pty --------------------------------------
    tt = ev("tty")
    env.expect_that("tty ok", section_ok("tty"), tt)
    env.expect_that("the shell painted a prompt on the terminal",
                    tt.get("sawPrompt") is True and tt.get("parkedInRead") is True,
                    {"banner": tt.get("banner"), "parkedWhy": tt.get("parkedWhy")})
    env.expect_that("a typed line was echoed by the discipline and run by the shell",
                    tt.get("echoedTheLine") is True and tt.get("ranTheLine") is True,
                    {"echoed": tt.get("echoed")})
    # A SHELL MUST NOT DIE OF THE KEYSTROKE IT FORWARDS. Both halves: it survived, and it prompted
    # again — the second is what shows the pending-bit interruption of the NEXT call is handled
    # (constraint 131), and without it the shell was alive and silent.
    env.expect_that("the shell survived Ctrl-C and prompted again",
                    tt.get("survivedCtrlC") is True and tt.get("promptAfterCtrlC") is True,
                    {"afterIntr": tt.get("afterIntr"), "child": tt.get("child")})
    env.expect_that("and ended the session on Ctrl-D", tt.get("exitedOnCtrlD") is True,
                    tt.get("child"))

    # ---- PROOF: a process cannot make the kernel fetch a URL (constraint 123) -------------
    nu = ev("no_url")
    env.expect_that("no_url ok", section_ok("no_url"), nu)
    env.expect_that("every URL spelling was refused by the filesystem",
                    nu.get("allLookupFailures") is True and not (nu.get("spawned") or []),
                    {"spawned": nu.get("spawned"), "rows": nu.get("rows")})
    # THE OTHER HALF OF CONSTRAINT 123. The first version of this section only checked the PATH
    # given to `spawn`; a program's own `import` naming a host had the child's module loader fetch
    # and evaluate remote code while the kernel's own accounting stayed at zero loads.
    env.expect_that("and every import naming a host was refused by the linker",
                    not (nu.get("importFailures") or []),
                    {"failed": nu.get("importFailures"), "rows": nu.get("imports")})
    # THE POSITIVE CONTROL, named separately: a loader that refused everything would satisfy the
    # clause above and run no programs at all.
    env.expect_that("while the one allowlisted specifier still loads",
                    nu.get("allowedStillRuns") is True,
                    {"imports": nu.get("imports")})

    # ---- PROOF: `yes | head -1` terminates -----------------------------------------------
    en = ev("endless")
    env.expect_that("endless ok", section_ok("endless"), en)
    # THE PROOF IS THAT IT ANSWERED AT ALL. `head` exits after one line, the pipe loses its
    # reader, and `yes` must die of SIGPIPE — if it did not, these calls would take the harness's
    # timeout instead of a value. The count through three stages is the second half.
    env.expect_that("`yes | head -1` terminated and printed one line",
                    en.get("oneLine") == "y\n" and en.get("counted") == "5",
                    {"oneLine": en.get("oneLine"), "counted": en.get("counted"),
                     "threeLines": en.get("threeLines")})

    env.expect("verdict is ok", got["verdict"], "ok")

    served = env.request(env.document)
    env.expect("document COOP", served.headers.get("Cross-Origin-Opener-Policy"), "same-origin")
    env.expect("document COEP", served.headers.get("Cross-Origin-Embedder-Policy"), "require-corp")
    env.expect_that("served m5.html", env.served_matches_disk(env.document),
                    "the m5.html served does not match www/m5.html on disk")

@check(
    name="m4a",
    milestone="m4a",
    controls=(Control.INVERT, Control.NO_ISOLATION, Control.PTY_DETACH),
    labels=M4A_LABELS,
    requires_isolation=True,
    root=Root.REPO,
    document=M4A_DOCUMENT,
    ready_expr=M4A_READY,
    ready_what="globalThis.M4A reaching done/aborted/error, or phase 'await-keys' (www/m4a.html)",
    # 60 s measured for a run whose longest wait is the not-responding detector's own second
    # threshold at 5 s, plus two fresh kernels each mounting /usr (15 objects) and /bench (3). The
    # bound is generous and is still a BOUND, for the reason M5's is: a stopped terminal raises no
    # error anywhere - a parked `poll` is a legitimate state - so a relay that wedged must end as
    # a BROKEN check carrying the kernel's park and console state, which www/m4a.html attaches to
    # its own timeouts, rather than as a suite that never returns.
    ready_timeout=300.0,
    refusal_expr="globalThis.M4A && globalThis.M4A.state",
    refusal_want="aborted",
    note="THE KEYS ARE REAL. The page builds the session, announces `phase: await-keys` and "
         "stops; this check focuses the terminal and presses them through "
         "`Input.dispatchKeyEvent`, so the widget receives `isTrusted` events that went through "
         "Chrome's own focus and key translation. `src/wm/terminal.mjs` counts trusted and "
         "synthesised keys separately and the check asserts on the trusted count, because a page "
         "that typed for itself would be asserting on its own `dispatchEvent` - CLAUDE.md: 'A "
         "window manager cannot be checked by screenshot. Drive real input, read the geometry "
         "back.'\n"
         "THE ECHO IS THE MILESTONE. Nothing in `src/wm/terminal.mjs` draws on a keypress: the "
         "character on the screen travelled widget -> /dev/console -> `term` -> write(master) -> "
         "the kernel's line discipline -> back. The geometry is read out of the DOM dataset "
         "`apply()` wrote, never off the Win object, because an inert frame and a working one are "
         "the same picture (constraint 40).\n"
         "THE DETECTOR'S PROOF MOVED TO `m7` WITH THE SEAM. M7 deleted `/dev/console`: the "
         "relay calls `win_create`, so this page creates no window and the old fixture - a "
         "window with no process reading it - is unreachable. `check_m7` carries both edges "
         "against `bench/m7-win/wedge.mjs`, a process that HAS a window and stops collecting "
         "its events.\n"
         "negative control: --negative pty-detach makes a write to the master discard its bytes. "
         "Six labels red - the echo, the line being run, Ctrl-C, Ctrl-D and the verdict - and "
         "sixteen intact, including `the window delivered the keystroke to the kernel`. "
         "--negative no-isolation must come out BROKEN: no SAB, so no kernel and no pty.",
)
def check_m4a(env: Env) -> None:
    # ---- drive the keys, then wait for the page to finish ---------------------------------
    #
    # `ready_expr` admits `await-keys` as a terminal state precisely so this runs. A page that is
    # aborted or errored never reaches that phase, so this arm is skipped and the read below
    # reports the refusal.
    phase = env.page.evaluate("globalThis.M4A && globalThis.M4A.phase")
    state = env.page.evaluate(M4A_DONE)
    if not phase and not state:
        # NEITHER WAITING NOR FINISHED. `ready_expr` resolved on one of the two, so arriving here
        # means the page moved under the check - and the arm below would silently not type, the
        # page would never finish, and the read would report "never reached a terminal state"
        # with nothing to say why. Said here instead.
        env.unmeasurable(
            "www/m4a.html satisfied its ready expression and then reported neither a phase nor a "
            "terminal state, so no keystroke was typed and nothing below was measured")
    if phase == "await-keys":
        focused = env.page.evaluate(
            "(() => { const t = document.querySelector('.terminal');"
            " if (!t) return 'no terminal element';"
            " t.focus();"
            " return document.activeElement === t ? '' : 'the terminal refused focus' })()")
        if focused:
            # A FOCUS THAT DID NOT TAKE MUST STOP THE CHECK. Keys would go to the body, the page
            # would time out waiting for an echo, and the report would blame the pty.
            env.unmeasurable("www/m4a.html: %s, so no keystroke could reach it" % focused)
        # DECLARED BEFORE THE FIRST KEY. The page cannot otherwise tell this check's keystrokes
        # from a person's — both are `isTrusted` — and it reported a hand-driven session as a
        # FAILED one because of it. With the flag set the page claims the strict clauses; without
        # it, it reports `hand-driven` and says which clauses it could not measure.
        env.page.evaluate("globalThis.M4A.driver = 'check'")
        env.page.type_keys("echo typed\n")
        env.settle(M4A_DONE, timeout=120.0,
                   what="globalThis.M4A.state reaching done after the keys were typed")

    got = env.read(READ_M4A, M4A_SHAPE)

    if got["state"] == "error":
        env.unmeasurable(
            "www/m4a.html reported state 'error' before producing proofs: %s. Nothing below was "
            "measured." % (got["why"] or "no reason given"))
    if got["state"] == "aborted":
        env.unmeasurable(
            "www/m4a.html aborted: %s. Without cross-origin isolation the kernel's SAB is not "
            "constructible, so no console is attached and no process holds a pty."
            % (got["why"] or "no reason given"))
    if got["state"] != "done":
        env.unmeasurable("www/m4a.html never reached a terminal state (state=%r)" % got["state"])

    sections = ("echo", "parked", "geometry")
    env.expect_that(
        "cell reported",
        all(got[name] is not None for name in sections),
        "sections absent: %s" % ", ".join(n for n in sections if got[n] is None))

    env.expect("page isolated", got["isolated"], True)
    env.expect("kernel isolated", got["kernelIsolated"], True)
    env.expect_that("the kernel raised no error", not got["errors"],
                    "kernel errors: %s" % "; ".join(got["errors"][:4]))

    def ev(name):
        return (got[name] or {}).get("evidence") or {}

    def section_ok(name):
        row = got[name]
        return bool(row and row.get("ok"))

    # ---- PROOF: typed into the window, the pty echoed it ---------------------------------
    e = ev("echo")
    env.expect_that("echo ok", section_ok("echo"), e)
    env.expect_that("the shell painted a prompt on the terminal",
                    e.get("sawPrompt") is True,
                    {"promptMs": e.get("promptMs"), "banner": e.get("banner")})
    # REAL KEYS, NOT SYNTHESISED ONES. `drivenBy` is the page's own account of which happened and
    # `trustedKeys` is the browser's; both are asserted, because the page's account could be wrong
    # and the count alone would not say the page had stopped to be driven.
    # `check` AND NOT MERELY "SOMETHING TRUSTED TYPED". The value distinguishes this check from a
    # person at the keyboard, which matters because only the scripted line makes the two clauses
    # below mean what they say — and `verdict is ok` refuses a `hand-driven` verdict, so a human
    # typing into the page while the gate runs cannot be mistaken for a pass.
    env.expect_that("the keys were real browser keystrokes",
                    e.get("drivenBy") == "check" and (e.get("trustedKeys") or 0) > 0,
                    {"drivenBy": e.get("drivenBy"), "trusted": e.get("trustedKeys"),
                     "synthetic": e.get("synthKeys")})
    # THE CLAUSE THE CONTROL LEAVES STANDING: the keystroke reached the KERNEL. Asserted from the
    # device's own byte counter, so "the window is wired up" and "the pty echoed" are two findings
    # and not one.
    # THREE FACTS, so a failure says which: the device counted the bytes, it took every byte it was
    # offered, and it dropped none. A console whose queue overflowed would satisfy the first alone.
    env.expect_that("the window delivered the keystroke to the kernel",
                    e.get("windowDelivered") is True,
                    {"keyBytesOut": e.get("keyBytesOut"), "fed": e.get("fed"),
                     "window": e.get("window")})
    # THE MILESTONE'S OWN PROOF.
    env.expect_that("and the pty echoed the typed line back onto the screen",
                    e.get("echoedTheLine") is True,
                    {"echoMs": e.get("echoMs"), "screen": e.get("afterTyping")})
    # The second half: the bytes reached a PROGRAM, not just the discipline. `echo typed` prints
    # `typed` on a line of its own, which the echo of the typed line does not.
    env.expect_that("and the shell ran it", e.get("ranTheLine") is True,
                    {"screen": e.get("afterTyping")})
    # A SHELL MUST NOT DIE OF THE KEYSTROKE IT FORWARDS, and it must prompt again — the second
    # half is what shows the interruption of the NEXT call is handled (constraint 131).
    env.expect_that("the shell survived Ctrl-C and prompted again",
                    e.get("promptAfterCtrlC") is True and e.get("shellAliveAfterIntr") is True,
                    {"screen": e.get("afterTyping")})
    env.expect_that("Ctrl-D ended the session and the relay exited cleanly",
                    e.get("relayExited") is True,
                    {"why": e.get("relayWhy"), "relay": e.get("relay")})

    # ---- PROOF: the relay was waiting on BOTH sources ------------------------------------
    #
    # REVIEW-FINDINGS finding 1's corrected scenario, which is the one its critic did not name:
    # idle, with no output flowing, a process holding a window and a pty master has to be parked
    # in `poll` or it is deaf to one of them. Read from the kernel's own park state, not inferred
    # from the keystroke having worked.
    p = ev("parked")
    env.expect_that("parked ok", section_ok("parked"), p)
    kinds = p.get("kinds") or []
    # THE KIND NUMBERS COME FROM THE PAGE, which imported them from `src/abi.mjs`. Writing 5 and 8
    # here would be a second place the ABI's fd kinds are recorded, in a language that cannot
    # import the first - the same reason every other check reads its errnos and signals off the
    # evidence. `p.get("F_WIN") is None` therefore fails the clause rather than passing vacuously.
    want_win, want_pty = p.get("F_WIN"), p.get("F_PTY_M")
    env.expect_that("the relay was parked in poll, holding both a window fd and a pty master",
                    p.get("inflight") == "poll" and want_win is not None and want_pty is not None
                    and want_win in kinds and want_pty in kinds,
                    {"inflight": p.get("inflight"), "kinds": kinds, "fds": p.get("fds"),
                     "F_WIN": want_win, "F_PTY_M": want_pty})

    # ---- PROOF: the window is a window ---------------------------------------------------
    g = ev("geometry")
    env.expect_that("geometry ok", section_ok("geometry"), g)
    env.expect_that("arrow keys on the title bar move the window",
                    g.get("keyboardDelta") == {"x": 20, "y": 10},
                    {"delta": g.get("keyboardDelta"), "start": g.get("start"),
                     "moved": g.get("moved")})
    # THE CAPTURE ERROR TRAVELS WITH THE FAILURE. A drag that moved nothing used to be
    # indistinguishable from a window that will not move, and the real cause was a
    # `setPointerCapture` throw on an untrusted pointerId — which Chrome does not raise and
    # Firefox does, so this check passed on the engine it runs on while the window was dead to the
    # mouse on another.
    env.expect_that("a pointer drag moves the window",
                    g.get("pointerDelta") == {"x": 40, "y": 30},
                    {"delta": g.get("pointerDelta"), "dragged": g.get("dragged"),
                     "setPointerCapture": g.get("captureError")})
    # BOTH EXTREMES, not one: the window must still be grabbable pushed hard left AND hard right,
    # and the clamp must not have resized it on the way.
    left = g.get("clampedLeft") or {}
    right = g.get("clampedRight") or {}
    surface = g.get("surface") or {}
    env.expect_that("and the clamp keeps the title bar reachable at both extremes",
                    bool(left) and bool(right) and bool(surface)
                    and left.get("x", 0) > -left.get("w", 0)
                    and right.get("x", 0) < surface.get("w", 0)
                    and left.get("w") == right.get("w") == (g.get("start") or {}).get("w"),
                    {"left": left, "right": right, "surface": surface})

    # THE NOT-RESPONDING DETECTOR'S PROOF IS `check_m7`'s, with the window ABI that made its
    # fixture possible. See M4A_LABELS.

    env.expect("verdict is ok", got["verdict"], "ok")

    served = env.request(env.document)
    env.expect("document COOP", served.headers.get("Cross-Origin-Opener-Policy"), "same-origin")
    env.expect("document COEP", served.headers.get("Cross-Origin-Embedder-Policy"), "require-corp")
    env.expect_that("served m4a.html", env.served_matches_disk(env.document),
                    "the m4a.html served does not match www/m4a.html on disk")


@check(
    name="m7",
    milestone="m7",
    controls=(Control.INVERT, Control.NO_ISOLATION, Control.WIN_FIRST_FD, Control.NO_CASCADE),
    labels=M7_LABELS,
    requires_isolation=True,
    root=Root.REPO,
    document=M7_DOCUMENT,
    ready_expr=M7_READY,
    ready_what="globalThis.M7 reaching done/aborted/error, or phase 'await-keys' (www/m7.html)",
    # 17 s measured over five fresh kernels, whose longest waits are the detector's own second
    # threshold at 5 s and its drain. The bound is generous and is still a BOUND, for the reason
    # M5's is: a window nobody reads raises no error anywhere - a parked `poll` is a legitimate
    # state - so a program that wedged must end as a BROKEN check carrying the kernel's park and
    # window state, which www/m7.html attaches to its own timeouts, rather than as a suite that
    # never returns.
    ready_timeout=300.0,
    refusal_expr="globalThis.M7 && globalThis.M7.state",
    refusal_want="aborted",
    note="A WINDOW IS A FILE DESCRIPTION. `win_create` returns an fd, the window's events are "
         "that fd's readable set, and `poll()` is the single wait primitive over it "
         "(constraint 42). M4a's `/dev/console` is GONE: it was one window, created by the page "
         "before any process existed, and a process with two windows could not have been woken "
         "by both.\n"
         "THE HEADLINE IS A PROGRAM YOU CAN RUN. `bench/m7-win/poller.mjs` opens two windows and "
         "a pipe, spawns a child to write the pipe, and polls all three - reporting which fd woke "
         "it and what arrived there. Its first exit condition was VACUOUS and the browser found "
         "it: the page reports each frame's geometry the instant it builds it, so both windows "
         "had a WEV_RESIZE queued before anything was typed and all three fds were ready on the "
         "first poll. It now runs until each window has delivered a KEY and the pipe has "
         "delivered bytes or end of input.\n"
         "THE KEYS INTO WINDOW A ARE REAL. The page announces `phase: await-keys` and stops; this "
         "check focuses the first terminal and presses them through `Input.dispatchKeyEvent`, so "
         "the widget receives `isTrusted` events. Window B's key is synthesised, because what "
         "needs to be real is the trip through the browser's own key translation and window A has "
         "made it.\n"
         "THE CASCADE AND THE OWNER CHAIN are what MILESTONES' ordering correction says M7 owes "
         "M9 and M10: destroying a parent destroys its children, `win_destroy` RETURNS the list "
         "of ids it destroyed, and an owner may name a window in ANOTHER PROCESS - `winopen -O "
         "<winid>` from the shell is that, and the page drives it as two processes.\n"
         "THE DETECTOR MOVED HERE FROM `m4a`, both edges, against `bench/m7-win/wedge.mjs`: a "
         "process that creates a window, stops reading it for nine seconds and then comes back "
         "and drains. M4a's fixture was a window with NO process reading it, which this milestone "
         "makes unreachable.\n"
         "negative control: --negative win-first-fd makes a parked `poll` evaluate only the FIRST "
         "fd of its set - `PLAN.md` §5's own words, 'the two-window case must hang'. Six labels "
         "red and thirty-six intact, including the real keystroke into window A and both edges of "
         "the detector. --negative no-cascade destroys a parent without its children: eleven red, "
         "thirty-one intact, including every poll and `/proc` label. --negative no-isolation must "
         "come out BROKEN: no SAB, so no kernel and no windows.",
)
def check_m7(env: Env) -> None:
    # ---- drive the keys, then wait for the page to finish ---------------------------------
    #
    # `ready_expr` admits `await-keys` as a terminal state precisely so this runs. A page that is
    # aborted or errored never reaches that phase, so this arm is skipped and the read below
    # reports the refusal.
    phase = env.page.evaluate("globalThis.M7 && globalThis.M7.phase")
    state = env.page.evaluate(M7_DONE)
    if not phase and not state:
        env.unmeasurable(
            "www/m7.html satisfied its ready expression and then reported neither a phase nor a "
            "terminal state, so no keystroke was typed and nothing below was measured")
    if phase == "await-keys":
        # THE FIRST TERMINAL IS WINDOW A's, because the page focused it before announcing the
        # phase. Asserted rather than assumed: keys sent to the body would make the page time out
        # waiting for an event and the report would blame the window.
        focused = env.page.evaluate(
            "(() => { const t = document.querySelector('.terminal');"
            " if (!t) return 'no terminal element';"
            " t.focus();"
            " return document.activeElement === t ? '' : 'the terminal refused focus' })()")
        if focused:
            env.unmeasurable("www/m7.html: %s, so no keystroke could reach it" % focused)
        # DECLARED BEFORE THE FIRST KEY. The page cannot otherwise tell this check's keystrokes
        # from a person's - both are `isTrusted` - and M4a reported a hand-driven session as a
        # FAILED one before it had this.
        env.page.evaluate("globalThis.M7.driver = 'check'")
        env.page.type_keys("a")
        env.settle(M7_DONE, timeout=240.0,
                   what="globalThis.M7.state reaching done after the key was typed")

    got = env.read(READ_M7, M7_SHAPE)

    if got["state"] == "error":
        env.unmeasurable(
            "www/m7.html reported state 'error' before producing proofs: %s. Nothing below was "
            "measured." % (got["why"] or "no reason given"))
    if got["state"] == "aborted":
        env.unmeasurable(
            "www/m7.html aborted: %s. Without cross-origin isolation the kernel's SAB is not "
            "constructible, so no process runs and no window is created."
            % (got["why"] or "no reason given"))
    if got["state"] != "done":
        env.unmeasurable("www/m7.html never reached a terminal state (state=%r)" % got["state"])

    sections = ("poll_many", "procwin", "cascade", "crossproc", "close", "health")
    env.expect_that(
        "cell reported",
        all(got[name] is not None for name in sections),
        "sections absent: %s" % ", ".join(n for n in sections if got[n] is None))

    env.expect("page isolated", got["isolated"], True)
    env.expect("kernel isolated", got["kernelIsolated"], True)
    env.expect_that("the kernel raised no error", not got["errors"],
                    "kernel errors: %s" % "; ".join(got["errors"][:4]))

    def ev(name):
        return (got[name] or {}).get("evidence") or {}

    def section_ok(name):
        row = got[name]
        return bool(row and row.get("ok"))

    # ---- PROOF 1: two windows and a pipe, in one poll ------------------------------------
    e = ev("poll_many")
    woke = e.get("wokeBy") or {}
    fds = e.get("fds") or []
    kinds = e.get("fdKinds") or []
    env.expect_that("poll ok", section_ok("poll_many"), e)
    env.expect_that("one process created two windows and the page built both frames",
                    len(e.get("created") or []) == 2 and len(fds) == 2,
                    {"created": e.get("created"), "fds": fds, "framesMs": e.get("framesMs")})
    # THE KIND NUMBERS COME FROM THE PAGE, which imported them from `src/abi.mjs`: a kind number
    # written here as well would be one fact in two languages, and the harness cannot import a
    # .mjs. Every other check publishes its errnos and signals the same way.
    cfg = got["cfg"] or {}
    env.expect_that("and it waited on all three fds at once, parked in poll",
                    e.get("parkedInPoll") is True
                    and kinds.count(cfg.get("F_WIN")) == 2
                    and cfg.get("F_PIPE_R") in kinds,
                    {"inflight": e.get("inflight"), "kinds": kinds, "F_WIN": cfg.get("F_WIN"),
                     "F_PIPE_R": cfg.get("F_PIPE_R")})
    env.expect_that("poll woke it for window A", e.get("wokeOnA") is True, {"wokeBy": woke})
    env.expect_that("poll woke it for window B", e.get("wokeOnB") is True, {"wokeBy": woke})
    env.expect_that("poll woke it for the pipe", e.get("wokeOnPipe") is True,
                    {"wokeBy": woke, "pipeFd": e.get("pipeFd")})
    # THE DISCRIMINATING CLAUSE. A poll that reported every fd ready whenever anything happened
    # would satisfy the three above and fail this one.
    env.expect_that("and each key arrived on the fd it was typed into",
                    e.get("keyOnA") is True and e.get("keyOnB") is True,
                    {"keysSeen": e.get("keysSeen"), "fds": fds})
    env.expect_that("the keys into window A were real browser keystrokes",
                    e.get("drivenBy") == "check"
                    and ((e.get("keyCounts") or {}).get("trusted") or 0) > 0,
                    {"drivenBy": e.get("drivenBy"), "keyCounts": e.get("keyCounts")})
    # BECAUSE EVERY FD DELIVERED, not merely "it exited": a program that ran to its own ceiling
    # exits 0 too, and under `--negative win-first-fd` that is exactly what happens.
    env.expect_that("and the program exited because every fd had delivered, not at its ceiling",
                    (e.get("result") or {}).get("exit") == 0
                    and "delivered" in str(e.get("why") or ""),
                    {"why": e.get("why"), "exit": (e.get("result") or {}).get("exit"),
                     "wokeBy": woke})

    # ---- PROOF 2: /proc/<pid>/win --------------------------------------------------------
    pw = ev("procwin")
    wins = pw.get("wins") or []
    names = pw.get("names")
    env.expect_that("procwin ok", section_ok("procwin"), pw)
    env.expect_that("/proc/<pid>/win lists one entry per live window",
                    isinstance(names, list) and sorted(names) == sorted(wins) and len(wins) == 2,
                    {"names": names, "wins": wins})
    env.expect_that("and each file names its window, its process and the fds that reach it",
                    pw.get("fieldsOk") is True,
                    {"files": pw.get("files"), "pid": pw.get("pid")})
    env.expect_that("and a winid nobody owns is ENOENT", pw.get("absent") == "ENOENT",
                    {"absent": pw.get("absent")})
    # THE PID IS PART OF THE PATH'S MEANING. The winid space is global, so a lookup that ignored
    # the pid would make every window readable under every process. The clause requires the other
    # process to be ALIVE at the moment of the read, or an ENOENT about a reaped pid would pass
    # for an ENOENT about a window.
    env.expect_that("and another live process's directory does not carry this window",
                    pw.get("otherAlive") is True and pw.get("foreign") == "ENOENT",
                    {"otherPid": pw.get("otherPid"), "alive": pw.get("otherAlive"),
                     "foreign": pw.get("foreign")})

    # ---- PROOF 3: the destroy cascade ----------------------------------------------------
    c = ev("cascade")
    env.expect_that("cascade ok", section_ok("cascade"), c)
    env.expect_that("destroying an owner destroys its children",
                    c.get("liveAfter") == [] and (c.get("owned") or {}).get("owner")
                    == (c.get("owner") or {}).get("win"),
                    {"owner": c.get("owner"), "owned": c.get("owned"),
                     "liveBefore": c.get("liveBefore"), "liveAfter": c.get("liveAfter"),
                     "rows": c.get("allRows")})
    env.expect_that("and win_destroy reports every id to the caller",
                    len(c.get("reportedList") or []) == 2
                    and (c.get("reportedList") or [None])[0] == (c.get("owner") or {}).get("win"),
                    {"reported": c.get("reportedList"), "cascades": c.get("cascades")})
    env.expect_that("and the page takes every frame down",
                    c.get("framesAtCascade") == 0 and len(c.get("destroyed") or []) == 2,
                    {"frames": c.get("framesAtCascade"), "destroyed": c.get("destroyed"),
                     "goneMs": c.get("goneMs")})
    env.expect_that("and the program exits because its windows went, not at its ceiling",
                    (c.get("result") or {}).get("exit") == 0
                    and (c.get("result") or {}).get("why") == "every window is gone",
                    {"result": c.get("result")})

    # ---- PROOF 4: cross-process ownership ------------------------------------------------
    x = ev("crossproc")
    env.expect_that("crossproc ok", section_ok("crossproc"), x)
    env.expect_that("two processes, and one owns a window parented onto the other's",
                    x.get("differentPids") is True and x.get("childOwner") == x.get("ownerWin"),
                    {"ownerPid": x.get("ownerPid"), "ownerWin": x.get("ownerWin"),
                     "childPid": x.get("childPid"), "childWin": x.get("childWin"),
                     "childOwner": x.get("childOwner")})
    env.expect_that("one win_destroy reports both ids across the process boundary",
                    len(x.get("ownerCascade") or []) == 2,
                    {"cascade": x.get("ownerCascade"), "ownerResult": x.get("ownerResult")})
    # TWO CLAUSES AND NOT ONE, because a single conjunction here went red once in five runs and
    # could not say which half moved (www/m7.html carries the record).
    env.expect_that("and the kernel has no live window left", x.get("liveAfter") == [],
                    {"liveAfter": x.get("liveAfter"), "rows": x.get("allRows")})
    # THE DESTROY NOTICE, not "some event arrived": the child's window was destroyed by another
    # process's call, so the only thing that can tell it is the WEV_DESTROYED record on its own fd.
    env.expect_that("and the other process is told on its own fd",
                    ((x.get("childResult") or {}).get("destroyedSeen") or 0) > 0
                    and (x.get("childResult") or {}).get("exit") == 0,
                    {"childResult": x.get("childResult")})
    env.expect_that("and both frames went", x.get("framesAtCascade") == 0,
                    {"frames": x.get("framesAtCascade"), "goneMs": x.get("goneMs")})

    # ---- PROOF 6: the X button delivers the close request --------------------------------
    #
    # A FIX'S CHECK. `Window.destroy` cleared the event queue before queueing its own notice, and
    # the page posts `win-in [WEV_CLOSE]` and then `win-gone` as two messages, so the close record
    # was wiped before any process could read it. Nothing asserted it until the critic said so.
    cl = ev("close")
    env.expect_that("close ok", section_ok("close"), cl)
    env.expect_that("the X button delivers WEV_CLOSE to the process",
                    (cl.get("closes") or 0) > 0,
                    {"closes": cl.get("closes"), "result": cl.get("result")})
    # AND THE PROGRAM IS WHAT ACTS ON IT, which is M9's change to this contract: the X posts the
    # event and nothing else, so the frame stands until the program calls `win_destroy` — and the
    # ids it reports are what prove it did. The clause that used to be here asserted a
    # WEV_DESTROYED record, which is right only when the PAGE destroys the window; a program that
    # destroys its own is not told, and the cross-process case is where that notice is asserted.
    env.expect_that("and the program is what acts on it, by destroying the window itself",
                    len(cl.get("cascades") or []) == 1
                    and cl.get("win") in ((cl.get("cascades") or [[]])[0] or []),
                    {"cascades": cl.get("cascades"), "win": cl.get("win")})
    env.expect_that("and only then does the frame go",
                    cl.get("framesAfter") == 0 and cl.get("goneMs", -1) >= 0,
                    {"framesAfter": cl.get("framesAfter"), "goneMs": cl.get("goneMs")})

    # ---- PROOF 5: the not-responding detector, both edges ---------------------------------
    h = ev("health")
    env.expect_that("health ok", section_ok("health"), h)
    env.expect_that("the window worked before its process stopped reading",
                    h.get("paintedMs", -1) >= 0, {"paintedMs": h.get("paintedMs")})
    env.expect_that("the caption greys when events go uncollected",
                    h.get("greyMs", -1) >= 0 and " (Not Responding)" in (h.get("caption1") or ""),
                    {"greyMs": h.get("greyMs"), "caption": h.get("caption1"),
                     "transitions": h.get("transitions")})
    # HYSTERESIS, as a clause: the affordance must be ABSENT at the first threshold and present at
    # the second. One threshold doing both jobs would pass a check that only asked "is it there".
    env.expect_that("End Process appears only at the second threshold",
                    h.get("endHiddenAtGrey") is True and h.get("endShown") is True
                    and h.get("endMs", -1) >= 0,
                    {"hiddenAtGrey": h.get("endHiddenAtGrey"), "shown": h.get("endShown"),
                     "endMs": h.get("endMs")})
    # THE CAPTION IS NOT THE ONLY WITNESS. A page that greyed a caption on its own would satisfy
    # the clauses above; these are the kernel's own numbers for that window.
    env.expect_that("and the kernel agrees the queue was waiting",
                    (h.get("pending") or 0) > 0 and (h.get("staleMs") or 0) >= 1000,
                    {"pending": h.get("pending"), "staleMs": h.get("staleMs"),
                     "level": h.get("level")})
    env.expect_that("and the caption clears when the process drains the queue",
                    h.get("clearedMs", -1) >= 0
                    and " (Not Responding)" not in (h.get("caption3") or "x (Not Responding)")
                    and ((h.get("result") or {}).get("drained") or 0) > 0,
                    {"clearedMs": h.get("clearedMs"), "caption": h.get("caption3"),
                     "result": h.get("result")})

    env.expect("verdict is ok", got["verdict"], "ok")

    served = env.request(env.document)
    env.expect("document COOP", served.headers.get("Cross-Origin-Opener-Policy"), "same-origin")
    env.expect("document COEP", served.headers.get("Cross-Origin-Embedder-Policy"), "require-corp")
    env.expect_that("served m7.html", env.served_matches_disk(env.document),
                    "the m7.html served does not match www/m7.html on disk")


@check(
    name="m8",
    milestone="m8",
    controls=(Control.INVERT, Control.NO_ISOLATION, Control.NO_DRAW),
    labels=M8_LABELS,
    requires_isolation=True,
    root=Root.REPO,
    document=M8_DOCUMENT,
    ready_expr=M8_READY,
    ready_what="globalThis.M8 reaching done/aborted/error, or phase 'await-pointer' (www/m8.html)",
    # 1 s measured for the whole page over four fresh kernels: no proof here waits on a threshold,
    # so this is the fastest window check. The bound is generous for the reason M5's is - a
    # program parked in `poll` raises no error, so a wedge must end as a BROKEN check carrying the
    # page's own state rather than as a suite that never returns.
    ready_timeout=300.0,
    refusal_expr="globalThis.M8 && globalThis.M8.state",
    refusal_want="aborted",
    note="A PROCESS PUTS PIXELS IN ITS OWN WINDOW, AND HOLDS NOTHING. The surface is kernel-owned "
         "and a process draws by sending a DISPLAY LIST through the channel it already has - one "
         "syscall per batch, not per operation. `docs/DECISIONS.md` D31 is the choice and "
         "constraint 219 is the measurement that forced it: a transferred `OffscreenCanvas` does "
         "NOT arrive at a process that is spinning, and does not arrive at one parked in "
         "`Atomics.wait`, which is the state a process is in during the very syscall that would "
         "carry it. `bench/m8-surface/probe.py` is that measurement, and it ran before any of "
         "this was built.\n"
         "THE PATTERN IS A SHIPPED PROGRAM'S, not a fixture's. `src/bin/paint.mjs -t` draws it and "
         "exports the ops it drew, so this check derives what it expects instead of agreeing a "
         "list of coordinates with the thing it is checking - and `paint` with no arguments is a "
         "window you can draw in with the mouse.\n"
         "THE PIXELS ARE READ BACK OUT OF THE CANVAS the browser painted, at the centre of each "
         "square, plus one pixel NOTHING drew on - which is what stops a canvas filled entirely "
         "with one colour from satisfying the rest. `src/abi.mjs` renders a colour for both "
         "purposes (`cssColor` for a canvas, `pixelColor` for a pixel read back), because the two "
         "APIs disagree about alpha and a check that rendered it itself reported four correct "
         "pixels as four failures.\n"
         "THE DRAG IS REAL MOUSE INPUT through `Input.dispatchMouseEvent`, at coordinates the page "
         "publishes from the canvas's own bounding rectangle: the canvas is SCALED by CSS, so "
         "nothing else knows where a surface pixel is on screen. Several moves and not one, "
         "because a program that draws from the last point to this one needs two points.\n"
         "negative control: --negative no-draw makes `win_draw` accept its batch, count it and "
         "discard it. Seven labels red and twenty-three intact - the surface is still created, the "
         "batch is still reported, the real pointer events still reach the process and it still "
         "draws in response, and the budget and the cell refusal are untouched. "
         "--negative no-isolation must come out BROKEN: no SAB, so no kernel and no surface.",
)
def check_m8(env: Env) -> None:
    # ---- send the drag, then wait for the page to finish ----------------------------------
    phase = env.page.evaluate("globalThis.M8 && globalThis.M8.phase")
    state = env.page.evaluate(M8_DONE)
    if not phase and not state:
        env.unmeasurable(
            "www/m8.html satisfied its ready expression and then reported neither a phase nor a "
            "terminal state, so no pointer event was sent and nothing below was measured")
    if phase == "await-pointer":
        drag = env.page.evaluate("JSON.stringify(globalThis.M8.drag || null)")
        if not drag or drag == "null":
            env.unmeasurable(
                "www/m8.html asked for a pointer drag and published no coordinates, so there was "
                "nowhere to send one")
        where = json.loads(drag)
        # DECLARED BEFORE THE FIRST EVENT. The page cannot otherwise tell this check's drag from a
        # person's - both are trusted - and it would report a hand-driven session as a failed one.
        env.page.evaluate("globalThis.M8.driver = 'check'")
        mouse_drag(env.page, where["from"], where["to"])
        env.settle(M8_DONE, timeout=240.0,
                   what="globalThis.M8.state reaching done after the drag was sent")

    got = env.read(READ_M8, M8_SHAPE)

    if got["state"] == "error":
        env.unmeasurable(
            "www/m8.html reported state 'error' before producing proofs: %s. Nothing below was "
            "measured." % (got["why"] or "no reason given"))
    if got["state"] == "aborted":
        env.unmeasurable(
            "www/m8.html aborted: %s. Without cross-origin isolation the kernel's SAB is not "
            "constructible, so no process runs, no window is created and no surface exists."
            % (got["why"] or "no reason given"))
    if got["state"] != "done":
        env.unmeasurable("www/m8.html never reached a terminal state (state=%r)" % got["state"])

    sections = ("pattern", "pointer", "budget", "textmode")
    env.expect_that(
        "cell reported",
        all(got[name] is not None for name in sections),
        "sections absent: %s" % ", ".join(n for n in sections if got[n] is None))

    env.expect("page isolated", got["isolated"], True)
    env.expect("kernel isolated", got["kernelIsolated"], True)
    env.expect_that("the kernel raised no error", not got["errors"],
                    "kernel errors: %s" % "; ".join(got["errors"][:4]))

    def ev(name):
        return (got[name] or {}).get("evidence") or {}

    def section_ok(name):
        row = got[name]
        return bool(row and row.get("ok"))

    # ---- PROOF 1: the pattern is on the canvas -------------------------------------------
    p = ev("pattern")
    probes = p.get("probes") or []
    wrong = p.get("wrong") or []
    surfaces = p.get("surfaces") or {}
    env.expect_that("pattern ok", section_ok("pattern"), p)
    env.expect_that("the process got a surface and the page made a canvas for it",
                    len(surfaces) == 1 and p.get("surfacedMs", -1) >= 0,
                    {"surfaces": surfaces, "framedMs": p.get("framedMs"),
                     "surfacedMs": p.get("surfacedMs")})
    env.expect_that("the program reported the batch it sent",
                    ((p.get("result") or {}).get("batches") or 0) >= 1
                    and ((p.get("result") or {}).get("ops") or 0) == len(p.get("pattern") or []),
                    {"result": p.get("result"), "ops": len(p.get("pattern") or [])})
    # THE MILESTONE'S OWN ASSERTION. Every filled square, read back at its centre.
    env.expect_that("and every pixel of the pattern is on the canvas",
                    len(probes) >= 4 and not wrong,
                    {"probes": probes, "wrong": wrong})
    # AND THE ONE THAT STOPS IT BEING VACUOUS: a canvas filled entirely with the pattern's own
    # colour would satisfy the clause above.
    env.expect_that("while a pixel nothing drew on is still the paper colour",
                    bool(p.get("paper"))
                    and (p.get("paper") or {}).get("got") == (p.get("paper") or {}).get("want"),
                    {"paper": p.get("paper")})
    # The page's own count against the kernel's: a replay that dropped an op, or one that did not
    # recognise it, is a different defect from a pixel in the wrong place.
    first = next(iter(surfaces.values()), {})
    env.expect_that("and the page replayed exactly the ops the kernel forwarded",
                    first.get("ops") == len(p.get("pattern") or []) and first.get("unknown") == 0,
                    {"surface": first, "sent": len(p.get("pattern") or [])})

    # ---- PROOF 2: a real drag, and the pixels under it ------------------------------------
    q = ev("pointer")
    host = q.get("hostStats") or {}
    result = q.get("result") or {}
    env.expect_that("pointer ok", section_ok("pointer"), q)
    # REAL EVENTS, NOT SYNTHESISED ONES. `drivenBy` is the page's own account of which happened
    # and the host's counter is the browser's; both are asserted, because the page's account could
    # be wrong and the count alone would not say the page had stopped to be driven.
    env.expect_that("a real mouse drag reached the process as pointer events",
                    q.get("drivenBy") == "check" and (host.get("pointers") or 0) > 0
                    and (result.get("pointers") or 0) > 2,
                    {"drivenBy": q.get("drivenBy"), "host": host.get("pointers"),
                     "process": result.get("pointers")})
    env.expect_that("and the process drew in response", (result.get("strokes") or 0) > 0,
                    {"result": result})
    env.expect_that("and the pixels under the drag changed",
                    q.get("paintedMs", -1) >= 0 and q.get("after") != q.get("before"),
                    {"before": q.get("before"), "after": q.get("after"),
                     "paintedMs": q.get("paintedMs")})
    env.expect_that("while a corner the drag never reached did not",
                    q.get("untouched") == q.get("before"),
                    {"untouched": q.get("untouched"), "before": q.get("before")})
    # A SURFACE EMITS FOCUS EVENTS, which it stopped doing when the text widget it replaced took
    # its focus listeners with it (constraint 225). The drag's own pointerdown focuses the canvas,
    # so a run that saw a pointer must have seen a focus too.
    env.expect_that("and the surface reported a focus change",
                    (result.get("focus") or 0) > 0, {"result": result})

    # ---- PROOF 3: the budget refuses and releases ----------------------------------------
    b = ev("budget")
    br = b.get("result") or {}
    env.expect_that("budget ok", section_ok("budget"), b)
    env.expect_that("a surface larger than the per-surface cap is EINVAL",
                    br.get("tooBig") == "EINVAL", {"tooBig": br.get("tooBig")})
    # ENOMEM AND NOT EAGAIN, asserted by name: the budget is a ceiling, and a caller told to try
    # again would try for ever.
    env.expect_that("the budget refuses with ENOMEM, which is a ceiling and not a transient",
                    br.get("refusedWith") == "ENOMEM",
                    {"refusedWith": br.get("refusedWith"), "rounds": br.get("rounds")})
    env.expect_that("after granting several window-sized surfaces",
                    (br.get("granted") or 0) >= 2, {"granted": br.get("granted")})
    env.expect_that("and destroying the windows gives the area back",
                    br.get("released") == "ESUCCESS", {"released": br.get("released")})
    env.expect_that("the kernel accounts no surface once they are gone",
                    (b.get("wins") or {}).get("surfacePx") == 0
                    and (b.get("wins") or {}).get("surfaces") == 0,
                    {"wins": b.get("wins")})

    # ---- PROOF 4: one content mode per window --------------------------------------------
    t = ev("textmode")
    tr = t.get("result") or {}
    env.expect_that("textmode ok", section_ok("textmode"), t)
    env.expect_that("a surfaced window refuses cells with EINVAL",
                    tr.get("cellsRefused") == "EINVAL",
                    {"cellsRefused": tr.get("cellsRefused")})
    # AND THE WINDOW STILL WORKS, which is what makes the refusal about the MODE rather than about
    # a window that stopped answering.
    env.expect_that("while a draw on the same window still succeeds",
                    tr.get("drewAfter") == "ESUCCESS", {"drewAfter": tr.get("drewAfter")})
    # FOUR REFUSALS AND ONE ACCEPTANCE, each by errno. `win_draw` was the one handler that did not
    # bound its byte length by MAX_INLINE, and `subarray` CLAMPS rather than throwing — so an
    # oversized batch was truncated, charged as 2,043.875 ops and reported as a SUCCESS
    # (constraint 225). The honest call in the same breath is what makes the refusals specific.
    bad = tr.get("badOps") or {}
    env.expect_that("and a batch that lies about its own size is refused four ways",
                    bad.get("tooMany") == "EINVAL" and bad.get("tooFew") == "EINVAL"
                    and bad.get("zero") == "EINVAL" and bad.get("negative") == "EINVAL"
                    and bad.get("honest") == "ESUCCESS",
                    {"badOps": bad})

    env.expect("verdict is ok", got["verdict"], "ok")

    served = env.request(env.document)
    env.expect("document COOP", served.headers.get("Cross-Origin-Opener-Policy"), "same-origin")
    env.expect("document COEP", served.headers.get("Cross-Origin-Embedder-Policy"), "require-corp")
    env.expect_that("served m8.html", env.served_matches_disk(env.document),
                    "the m8.html served does not match www/m8.html on disk")


@check(
    name="m9",
    milestone="m9",
    controls=(Control.INVERT, Control.NO_ISOLATION, Control.NO_OWNER_CHAIN, Control.NO_MODAL),
    labels=M9_LABELS,
    requires_isolation=True,
    root=Root.REPO,
    document=M9_DOCUMENT,
    ready_expr=M9_READY,
    ready_what="globalThis.M9 reaching done/aborted/error, or phase 'await-click' (www/m9.html)",
    # 5 s measured over three fresh kernels. The bound is generous for the reason M5's is: a
    # program parked in `poll` raises no error, so a wedge must end as a BROKEN check carrying the
    # page's own state rather than as a suite that never returns.
    ready_timeout=300.0,
    refusal_expr="globalThis.M9 && globalThis.M9.state",
    refusal_want="aborted",
    note="AN OWNED WINDOW IS TWO THINGS AT ONCE, and M9's own plan had only one of them. "
         "`modal in {none, window, app, system}` describes the SCOPE - which windows are affected "
         "- and SerenityOS's enforced `WindowMode` describes the BEHAVIOUR: `Modeless`, "
         "`Passive`, `RenderAbove`, `Blocking`. `MILESTONES.md`'s ordering correction says an "
         "owned window needs both, and a tooltip and a save dialog are the proof: both are 'owned "
         "by that window' and nothing else about them is the same.\n"
         "THE KERNEL OWNS THE STACK, which is the structural half of this milestone. A page that "
         "owned the order could be asked to put a window above the modal that blocks it, and "
         "would - it has no way to know better. So `win_raise` is a syscall, the kernel computes "
         "the blocker by walking the owner chain, and `win-stack` carries the WHOLE order to the "
         "page rather than a 'raise this one' instruction (constraint 226, `docs/DECISIONS.md` "
         "D32).\n"
         "THE CLICK IS REAL, through `Input.dispatchMouseEvent` at coordinates the page publishes "
         "from the frame's own rectangle: the frame is positioned by the clamp, so nothing outside "
         "the page knows where its title bar is.\n"
         "AND THE SUPPRESSION IS WHAT MAKES A MODAL A MODAL. Typing into the blocked editor must "
         "change nothing on its screen, the kernel's `suppressed` counter must move, and nothing "
         "may be left queued - the order on its own would pass for a window that is merely "
         "underneath. A resize, a close request and a destroy notice are NOT suppressed, because "
         "a window that missed them would be wrong about the world once the modal went away.\n"
         "THE CLOSE IS A REQUEST. The X posts WEV_CLOSE and nothing else; the editor opens a "
         "dialog, Esc refuses the close, the editor is editable again, and answering destroys both "
         "through M7's cascade. A process that ignores the request is not a trap and needs nothing "
         "new: the event sits uncollected, so the not-responding detector greys the caption at "
         "1,000 ms and offers End Process at 5,000.\n"
         "negative control: --negative no-owner-chain raises a window without the dialogs that "
         "ride with it - `PLAN.md` §5's own words, 'the dialog must fall behind'. --negative "
         "no-modal makes nothing blocking: the raise is granted, the keys arrive, and the whole "
         "close contract must still hold. --negative no-isolation must come out BROKEN: no SAB, "
         "so no kernel and no windows.",
)
def check_m9(env: Env) -> None:
    # ---- send the real click, then wait for the page to finish ----------------------------
    phase = env.page.evaluate("globalThis.M9 && globalThis.M9.phase")
    state = env.page.evaluate(M9_DONE)
    if not phase and not state:
        env.unmeasurable(
            "www/m9.html satisfied its ready expression and then reported neither a phase nor a "
            "terminal state, so no click was sent and nothing below was measured")
    if phase == "await-click":
        where = env.page.evaluate("JSON.stringify(globalThis.M9.click || null)")
        if not where or where == "null":
            env.unmeasurable(
                "www/m9.html asked for a click on the buried window and published no coordinates, "
                "so there was nowhere to send one")
        at = json.loads(where)
        # DECLARED BEFORE THE CLICK. The page cannot otherwise tell this check's click from a
        # person's - both are trusted - and it would report a hand-driven session as a failed one.
        env.page.evaluate("globalThis.M9.driver = 'check'")
        env.page.call("Input.dispatchMouseEvent", type="mousePressed", x=at["x"], y=at["y"],
                      button="left", buttons=1, clickCount=1)
        env.page.call("Input.dispatchMouseEvent", type="mouseReleased", x=at["x"], y=at["y"],
                      button="left", buttons=0, clickCount=1)
        # ---- THE SECOND GESTURE: a REAL DRAG on a window a modal is blocking --------------
        #
        # A drag and an arrow-key move are handled page-side from end to end, so the kernel's
        # suppression covered the client area and not the frame: the editor could be dragged around
        # under its own dialog. `#startDrag` calls `setPointerCapture`, so a pointer id the page
        # invented is not a path a person takes - hence a real mouse, from here.
        env.settle("globalThis.M9 && (globalThis.M9.phase === 'await-drag'"
                   " || globalThis.M9.state === 'done' ? 1 : 0)",
                   timeout=120.0, what="www/m9.html reaching the await-drag phase")
        where = env.page.evaluate("JSON.stringify(globalThis.M9.drag || null)")
        if not where or where == "null":
            env.unmeasurable(
                "www/m9.html asked for a drag on the blocked window and published no coordinates")
        d = json.loads(where)
        env.page.evaluate("globalThis.M9.driver2 = 'check'")
        mouse_drag(env.page, {"x": d["x"], "y": d["y"]},
                   {"x": d["x"] + d["dx"], "y": d["y"] + d["dy"]})
        env.page.evaluate("globalThis.M9.dragDone = true")
        env.settle(M9_DONE, timeout=240.0,
                   what="globalThis.M9.state reaching done after the click and drag were sent")

    got = env.read(READ_M9, M9_SHAPE)

    if got["state"] == "error":
        env.unmeasurable(
            "www/m9.html reported state 'error' before producing proofs: %s. Nothing below was "
            "measured." % (got["why"] or "no reason given"))
    if got["state"] == "aborted":
        env.unmeasurable(
            "www/m9.html aborted: %s. Without cross-origin isolation the kernel's SAB is not "
            "constructible, so no process runs and no window is created - and a modal with no "
            "windows is nothing." % (got["why"] or "no reason given"))
    if got["state"] != "done":
        env.unmeasurable("www/m9.html never reached a terminal state (state=%r)" % got["state"])

    sections = ("stacking", "suppress", "refuse", "scope")
    env.expect_that(
        "cell reported",
        all(got[name] is not None for name in sections),
        "sections absent: %s" % ", ".join(n for n in sections if got[n] is None))

    env.expect("page isolated", got["isolated"], True)
    env.expect("kernel isolated", got["kernelIsolated"], True)
    env.expect_that("the kernel raised no error", not got["errors"],
                    "kernel errors: %s" % "; ".join(got["errors"][:4]))

    def ev(name):
        return (got[name] or {}).get("evidence") or {}

    def section_ok(name):
        row = got[name]
        return bool(row and row.get("ok"))

    cfg = got["cfg"] or {}

    # ---- PROOF 1: the dialog stays on top and the owner cannot be raised over it ----------
    a = ev("stacking")
    modal = a.get("modal") or {}
    stack = a.get("stack") or []
    after = a.get("stackAfter") or []
    z = a.get("z") or {}
    blocked = a.get("lastBlocked") or {}
    env.expect_that("stacking ok", section_ok("stacking"), a)
    # THE CHAIN, MEASURED WHILE NOTHING IS BLOCKING, and the CONTROL is what forced this clause to
    # exist: with the modal already up a raise of the editor is REFUSED, so removing the owner
    # chain changed nothing and `--negative no-owner-chain` came out GREEN against a check that
    # claimed to be about the chain. A palette is RENDER_ABOVE and blocks nothing, so the raise is
    # granted and the rider is the whole of what is asserted.
    pal = a.get("paletteMode") or {}
    env.expect_that("raising the owner brings its RENDER_ABOVE palette with it",
                    a.get("rodeMs", -1) >= 0
                    and pal.get("mode") == cfg.get("WMODE_RENDER_ABOVE")
                    and pal.get("scope") == cfg.get("WMODAL_NONE"),
                    {"rodeMs": a.get("rodeMs"), "stack": a.get("stackWithPalette"),
                     "palette": pal})
    # THE COUNT IS COMPARED AGAINST THE COUNT BEFORE, not against a literal: a 4 written here
    # went stale the moment this proof opened one more window, and a stale literal reports as a
    # defect rather than as an edit.
    env.expect_that("the X asked instead of acting, and the dialog appeared",
                    a.get("dialogMs", -1) >= 0
                    and a.get("framesWithDialog") == (a.get("framesBeforeDialog") or 0) + 1,
                    {"dialogMs": a.get("dialogMs"), "frames": a.get("framesWithDialog"),
                     "before": a.get("framesBeforeDialog")})
    # THE TWO AXES, read out of the kernel's own report and compared against the numbers the page
    # imported from `src/abi.mjs` - a value written here as well would be one fact in two places.
    env.expect_that("the dialog is BLOCKING at window scope",
                    modal.get("mode") == cfg.get("WMODE_BLOCKING")
                    and modal.get("scope") == cfg.get("WMODAL_WINDOW"),
                    {"modal": modal, "cfg": cfg})
    withDialog = a.get("stackWithDialog") or []
    env.expect_that("and it sits above the window that owns it",
                    withDialog and withDialog[-1] == a.get("dialogWin"),
                    {"stack": withDialog, "dialog": a.get("dialogWin")})
    # AND THE PAGE RENDERED IT. The kernel's order is the authority and the DOM is what the page
    # did with it; an inert frame and a working one are the same picture (constraint 40).
    env.expect_that("which the page rendered, so a reader sees it too",
                    (z.get(str(a.get("dialogWin"))) or 0) > (z.get(str(a.get("editorWin"))) or 0),
                    {"zIndex": z, "dialog": a.get("dialogWin"), "editor": a.get("editorWin")})
    env.expect_that("a REAL click on the owner was refused by the kernel",
                    a.get("drivenBy") == "check" and a.get("refusedMs", -1) >= 0,
                    {"drivenBy": a.get("drivenBy"), "refusedMs": a.get("refusedMs")})
    env.expect_that("and the blocker it named is the dialog",
                    blocked.get("by") == a.get("dialogWin")
                    and blocked.get("win") == a.get("editorWin"),
                    {"blocked": blocked, "dialog": a.get("dialogWin")})
    # THE WHOLE ORDER, ELEMENT BY ELEMENT. Checking only the top passed whether the raise was
    # refused or granted — the dialog is BLOCKING, so it rides up with its owner either way and
    # ends on top regardless, and `--negative no-modal` found that by holding when it should have
    # moved. A refused raise changes NOTHING.
    env.expect_that("so the order did not change at all", after == stack,
                    {"before": stack, "after": after})
    # AND THE SCOPE IS NOT A LIE: a window-modal dialog affects its OWNER. If an unrelated
    # process's window were refused too, every clause above would still pass.
    env.expect_that("while an unrelated process's window still raises",
                    a.get("strangerRaisedMs", -1) >= 0
                    and (a.get("stackEnd") or [None])[-1] == a.get("strangerWin"),
                    {"stackEnd": a.get("stackEnd"), "stranger": a.get("strangerWin")})
    # A WINDOW CREATED AFTER A CLICK IS ON TOP OF IT, in the kernel AND on the screen. `create`
    # grew the kernel's stack and posted no order, so the kernel was right and the page never
    # heard: a window that had been raised carried a `z-index` and a window created afterwards
    # carried none, and the new one painted BEHIND it (constraint 230).
    zlate = a.get("zWithLate") or {}
    env.expect_that("a window created after a raise goes on top",
                    a.get("lateMs", -1) >= 0
                    and (a.get("stackWithLate") or [None])[-1] == a.get("lateWin"),
                    {"stack": a.get("stackWithLate"), "late": a.get("lateWin")})
    env.expect_that("and the page rendered it above the window that was clicked",
                    (zlate.get(str(a.get("lateWin"))) or 0)
                    > (zlate.get(str(a.get("strangerWin"))) or 0)
                    and a.get("lateDepth") == len(a.get("stackWithLate") or []) - 1,
                    {"zIndex": zlate, "late": a.get("lateWin"),
                     "depth": a.get("lateDepth"), "stack": a.get("stackWithLate")})

    # ---- PROOF 2: input to a blocked window is suppressed ---------------------------------
    b = ev("suppress")
    env.expect_that("suppress ok", section_ok("suppress"), b)
    env.expect_that("typing into the blocked window changed nothing on its screen",
                    b.get("screenUnchanged") is True,
                    {"before": b.get("before"), "after": b.get("after")})
    # THE KERNEL'S OWN COUNTER, because "the screen did not change" is also true of a keyboard that
    # stopped working, and a program whose keys silently stopped arriving could not tell.
    env.expect_that("because the kernel suppressed the keys, and counted them",
                    (b.get("suppressed") or 0) >= 3, {"suppressed": b.get("suppressed")})
    env.expect_that("and nothing is left queued for it either",
                    (b.get("pending") or 0) == 0,
                    {"pending": b.get("pending"), "queuedEver": b.get("queuedEver")})
    # ---- AND THE FRAME, which is the other half of suppression ---------------------------
    #
    # A drag and an arrow-key move never reach `feed`, so "input to a blocked window is suppressed"
    # was false for the gesture a user tries first: the editor could be dragged around under its
    # own dialog and its `pointerup` posted a geometry the kernel accepted (constraint 233). TWO
    # READINGS of the blocked set, because the one a drag consults is the FRAME's.
    env.expect_that("the kernel named it blocked, and the frame carries that",
                    a.get("editorWin") in (b.get("blockedSet") or [])
                    and a.get("editorWin") in (b.get("frameBlocked") or []),
                    {"kernel": b.get("blockedSet"), "frames": b.get("frameBlocked"),
                     "editor": a.get("editorWin")})
    env.expect_that("so arrow keys on its title bar do not move it",
                    b.get("boxBefore") == b.get("boxAfterKeys"),
                    {"before": b.get("boxBefore"), "after": b.get("boxAfterKeys")})
    # THE NEGATIVE CONTROL INSIDE THE PROOF: the same keys on a window nothing blocks MUST move it,
    # or this would pass against a key route that never worked.
    env.expect_that("and the same keys DO move a window that is not blocked",
                    b.get("freeMoved") is True, {"freeMoved": b.get("freeMoved")})
    env.expect_that("and a REAL mouse drag on its title bar moves it nowhere",
                    b.get("dragDrivenBy") == "check" and b.get("dragRefused") is True,
                    {"drivenBy": b.get("dragDrivenBy"), "before": b.get("boxBeforeDrag"),
                     "after": b.get("boxAfterDrag")})

    # ---- PROOF 3: the close is a request -------------------------------------------------
    c = ev("refuse")
    cr = c.get("result") or {}
    env.expect_that("refuse ok", section_ok("refuse"), c)
    # THREE FRAMES: the editor, its palette and the dialog — and the palette is why the cascade
    # below takes three windows rather than two.
    env.expect_that("the X opened a dialog and closed nothing",
                    c.get("framesWithDialog") == 3, {"frames": c.get("framesWithDialog")})
    env.expect_that("Esc refused the close and the editor is still there",
                    c.get("refusedMs", -1) >= 0 and c.get("editorStillUp") is True,
                    {"refusedMs": c.get("refusedMs"), "screen": c.get("screenAfterRefusal")})
    env.expect_that("and it is editable again, so the suppression lifted with the modal",
                    c.get("editableAgainMs", -1) >= 0,
                    {"editableAgainMs": c.get("editableAgainMs")})
    env.expect_that("the program counted the request and the refusal",
                    (cr.get("closes") or 0) >= 2 and (cr.get("refusals") or 0) >= 1,
                    {"result": cr})
    env.expect_that("and answering it destroyed every owned window, through the cascade",
                    c.get("bothGoneMs", -1) >= 0 and c.get("framesAtEnd") == 0
                    and len(cr.get("destroyed") or []) == 3,
                    {"destroyed": cr.get("destroyed"), "frames": c.get("framesAtEnd")})

    # ---- PROOF 4: app scope blocks a sibling ---------------------------------------------
    d = ev("scope")
    dmodal = d.get("modal") or {}
    dblocked = d.get("lastBlocked") or {}
    env.expect_that("scope ok", section_ok("scope"), d)
    env.expect_that("the dialog is BLOCKING at APP scope",
                    dmodal.get("mode") == cfg.get("WMODE_BLOCKING")
                    and dmodal.get("scope") == cfg.get("WMODAL_APP"),
                    {"modal": dmodal, "cfg": cfg})
    # THE SIBLING IS NOT THE DIALOG'S OWNER, which is why this is the clause that tells the two
    # scopes apart: a window-scoped modal would let it raise.
    env.expect_that("raising a SIBLING window of the same process was refused",
                    d.get("refusedMs", -1) >= 0 and dblocked.get("win") == d.get("scratchWin")
                    and dblocked.get("by") == d.get("dialogWin"),
                    {"blocked": dblocked, "scratch": d.get("scratchWin")})
    env.expect_that("and the sibling's input is suppressed as well",
                    d.get("siblingScreenUnchanged") is True
                    and (d.get("siblingSuppressed") or 0) > 0,
                    {"unchanged": d.get("siblingScreenUnchanged"),
                     "suppressed": d.get("siblingSuppressed")})
    # ---- SYSTEM SCOPE, AND THE WAY OUT OF IT ---------------------------------------------
    #
    # ANY PROGRAM CAN TAKE SYSTEM SCOPE: there is no capability to gate it on and no privileged
    # caller to gate it to. So the guarantee is the ESCAPE, and the escape that was documented did
    # not exist for this case - End Process is driven by UNCOLLECTED events, and a process that
    # keeps reading its own queue never goes stale while the windows it froze get nothing queued
    # either. `health == 0` is asserted BESIDE the button, because that is the clause that says the
    # hatch does not depend on the detector (constraint 236).
    # THE DIALOG IS THE WINDOW THAT TELLS THE SCOPES APART. The app-modal dialog already blocks
    # the editor and its sibling, so asserting those says nothing about SYSTEM scope; the dialog
    # itself is blocked by nothing until a window outside its own subtree claims everything.
    env.expect_that("a system-modal window from another process blocks these too",
                    d.get("sysMs", -1) >= 0
                    and d.get("dialogWin") in (d.get("sysBlocked") or [])
                    and d.get("editorWin") in (d.get("sysBlocked") or []),
                    {"blocked": d.get("sysBlocked"), "dialog": d.get("dialogWin"),
                     "editor": d.get("editorWin")})
    env.expect_that("and End Process is offered on it at once, while it is still responsive",
                    d.get("sysWin") in (d.get("endOffered") or [])
                    and d.get("sysHealth") == 0,
                    {"endOffered": d.get("endOffered"), "sysWin": d.get("sysWin"),
                     "health": d.get("sysHealth")})
    # TWO RACES, TWO COUNTERS. A click and a geometry report can each cross a destroy in the page's
    # own queue, and one number for both diagnoses neither (constraint 235).
    env.expect_that("the two page races are counted apart",
                    isinstance(d.get("lateGeoms"), int) and isinstance(d.get("lateRaises"), int),
                    {"lateGeoms": d.get("lateGeoms"), "lateRaises": d.get("lateRaises")})

    env.expect("verdict is ok", got["verdict"], "ok")

    served = env.request(env.document)
    env.expect("document COOP", served.headers.get("Cross-Origin-Opener-Policy"), "same-origin")
    env.expect("document COEP", served.headers.get("Cross-Origin-Embedder-Policy"), "require-corp")
    env.expect_that("served m9.html", env.served_matches_disk(env.document),
                    "the m9.html served does not match www/m9.html on disk")


@check(
    name="m10",
    milestone="m10",
    controls=(Control.INVERT, Control.NO_ISOLATION, Control.TEXT_ONLY, Control.NO_DROP),
    labels=M10_LABELS,
    requires_isolation=True,
    root=Root.REPO,
    document=M10_DOCUMENT,
    ready_expr=M10_READY,
    ready_what="globalThis.M10 reaching done/aborted/error, or phase 'await-pointer' "
               "(www/m10.html)",
    # 9 s measured over five fresh kernels: four proofs, nine processes, two surfaces and a real
    # drag. The bound is generous for M5's reason - a program parked in `poll` raises no error, so
    # a wedge must end as a BROKEN check carrying the page's own state rather than as a suite that
    # never returns.
    ready_timeout=300.0,
    refusal_expr="globalThis.M10 && globalThis.M10.state",
    refusal_want="aborted",
    note="A CLIPBOARD CALL WITH NO FORMAT TAG IS AN ABI DEFECT, not a missing feature, and that "
         "is what this milestone removes. `docs/designs/REVIEW-FINDINGS.md` section 2: "
         "`clipboard_write(bytes)` 'leaves a receiver structurally unable to distinguish a pasted "
         "PNG from pasted UTF-8'. So the untyped pair is deleted and five `dataobj_*` calls "
         "replace it - create, set, get, offer, open - and the clipboard and a drag are the same "
         "object published to two places (constraint 240).\n"
         "THE PAYLOAD IS THE KERNEL'S, which is the whole reason either gesture works. A "
         "clipboard whose bytes lived in the copying process would be empty the moment that "
         "process exited: this check KILLS the copier with End Process and pastes afterwards. A "
         "drag whose bytes lived in the source could not survive the source dying mid-gesture, "
         "which the review names as the requirement (constraint 241).\n"
         "THE DRAG IS A REAL MOUSE, through `Input.dispatchMouseEvent` at coordinates the page "
         "publishes from its own canvas rectangle - a surface is positioned by the clamp and "
         "scaled by CSS, so nothing outside the page knows where a file row is. A synthesized "
         "drag exercises the page and not the browser's pointer capture, so the clause that needs "
         "a trusted gesture reports NOT MEASURED rather than passing.\n"
         "AND THE PIXELS ARE READ BACK. 'The bytes arrived' is asserted from the receiver's own "
         "report of the FORMAT they arrived under, and the picture is asserted from "
         "`getImageData` on the canvas the browser painted - the logo's amber corner pixel beside "
         "its blue neighbour, so 'it is amber everywhere' cannot pass (constraints 40, 224).\n"
         "negative control: --negative text-only makes every object offer TEXT alone - "
         "`PLAN.md` section 5's own words, 'the image paste must fail cleanly, not silently paste "
         "a path'. Both gestures must still run end to end and the REFUSAL proof must hold. "
         "--negative no-drop delivers no drop at all: the clipboard half must be untouched. "
         "--negative no-isolation must come out BROKEN: no SAB, so no kernel, no windows and no "
         "clipboard.",
)
def check_m10(env: Env) -> None:
    # ---- send the real drag, then wait for the page to finish ------------------------------
    phase = env.page.evaluate("globalThis.M10 && globalThis.M10.phase")
    state = env.page.evaluate(M10_DONE)
    if not phase and not state:
        env.unmeasurable(
            "www/m10.html satisfied its ready expression and then reported neither a phase nor a "
            "terminal state, so no drag was sent and nothing below was measured")
    if phase == "await-pointer":
        where = env.page.evaluate("JSON.stringify(globalThis.M10.drag || null)")
        if not where or where == "null":
            env.unmeasurable(
                "www/m10.html asked for a drag between two windows and published no coordinates, "
                "so there was nowhere to send one")
        d = json.loads(where)
        # DECLARED BEFORE THE DRAG. The page cannot otherwise tell this check's gesture from a
        # person's - both are trusted - and it would report a hand-driven session as a failed one.
        env.page.evaluate("globalThis.M10.driver = 'check'")
        mouse_drag(env.page, d["from"], d["to"])
        env.page.evaluate("globalThis.M10.dragDone = true")
        env.settle(M10_DONE, timeout=240.0,
                   what="globalThis.M10.state reaching done after the drag was sent")

    got = env.read(READ_M10, M10_SHAPE)

    if got["state"] == "error":
        env.unmeasurable(
            "www/m10.html reported state 'error' before producing proofs: %s. Nothing below was "
            "measured." % (got["why"] or "no reason given"))
    if got["state"] == "aborted":
        env.unmeasurable(
            "www/m10.html aborted: %s. Without cross-origin isolation the kernel's SAB is not "
            "constructible, so no process runs, no window is created and there is no clipboard to "
            "put anything on." % (got["why"] or "no reason given"))
    if got["state"] != "done":
        env.unmeasurable("www/m10.html never reached a terminal state (state=%r)" % got["state"])

    sections = ("copy", "drag", "refuse", "account")
    env.expect_that(
        "cell reported",
        all(got[name] is not None for name in sections),
        "sections absent: %s" % ", ".join(n for n in sections if got[n] is None))

    env.expect("page isolated", got["isolated"], True)
    env.expect("kernel isolated", got["kernelIsolated"], True)
    env.expect_that("the kernel raised no error", not got["errors"],
                    "kernel errors: %s" % "; ".join(got["errors"][:4]))

    def ev(name):
        return (got[name] or {}).get("evidence") or {}

    def section_ok(name):
        row = got[name]
        return bool(row and row.get("ok"))

    cfg = got["cfg"] or {}

    # ---- PROOF 1: an image through the clipboard, across processes, the copier killed -------
    a = ev("copy")
    env.expect_that("copy ok", section_ok("copy"), a)
    # TWO FORMATS FROM ONE FILE: the path list a file manager wants and the bytes an image view
    # wants. Windows' own answer, and the reason is a receiver that can read only one of them.
    env.expect_that("the copy offered a path list AND the image",
                    (a.get("formats") or []) == ["paths", "bitmap"],
                    {"formats": a.get("formats"), "copier": a.get("copier")})
    clip = a.get("clipboard") or {}
    env.expect_that("the clipboard holds one object, with both formats",
                    (clip.get("formats") or []) == ["paths", "bitmap"],
                    {"clipboard": clip, "objects": a.get("objects")})
    # THE COPIER IS KILLED AND THE PAYLOAD IS INTACT. End Process is the kernel's own teardown
    # path and it closes every fd: if the clipboard's bytes were the copier's, this is where they
    # would disappear (constraint 241). Without this clause the proof would also pass for a
    # clipboard that was a handle into a live process's memory.
    env.expect_that("and the process that copied it was killed, payload intact",
                    a.get("copierGoneMs", -1) >= 0
                    and (a.get("afterKill") or {}).get("bytes") == a.get("bytesHeld")
                    and (a.get("afterKill") or {}).get("refs") == 1,
                    {"gone": a.get("copierGoneMs"), "held": a.get("bytesHeld"),
                     "after": a.get("afterKill"), "procs": a.get("procs")})
    # AND A PROGRAM READS IT OFF A PATH, which is the only reading of this a person has from a
    # prompt: `/proc/dataobj` is regenerated per read like everything else in `/proc`.
    #
    # THE PATTERN IS THE OFFER AND NOT THE WORD `clipboard:`, because that label is printed even
    # for an empty slot — so the first version of this clause passed against a kernel holding
    # nothing, which is the world `--negative text-only` produces. Found by a critic.
    env.expect_that("a program reads the clipboard out of /proc/dataobj",
                    (a.get("grep") or {}).get("exit") == 0
                    and ((a.get("grep") or {}).get("matched") or 0) >= 1,
                    {"grep": a.get("grep")})
    shown = a.get("shown") or {}
    env.expect_that("the paste drew the image",
                    a.get("drewMs", -1) >= 0 and shown.get("source") == "clipboard"
                    and shown.get("drawn") is True
                    and (shown.get("bitmap") or {}).get("w") == 16,
                    {"drewMs": a.get("drewMs"), "shown": shown, "surface": a.get("surface")})
    # THE CORNER PIXEL, read back out of the canvas the browser painted. It is the one an
    # upside-down or mirrored render would move, and it is asserted BESIDE its neighbour so a
    # window filled with one colour cannot pass (constraint 40).
    env.expect_that("and the pixels are the logo's own",
                    a.get("corner") == cfg.get("AMBER") and a.get("edge") == cfg.get("BLUE"),
                    {"corner": a.get("corner"), "edge": a.get("edge"), "cfg": cfg,
                     "at": a.get("cornerAt")})

    # ---- PROOF 2: a REAL mouse drags a row from one process's window into another's ---------
    b = ev("drag")
    data = b.get("data") or {}
    env.expect_that("drag ok", section_ok("drag"), b)
    # THE THRESHOLD'S LOWER EDGE. A press alone must not start a drag, or every click on a row
    # would begin a gesture the next release cancels.
    env.expect_that("a press and a 1 px move start no drag",
                    b.get("dragAfterNudge") is None,
                    {"dragAfterNudge": b.get("dragAfterNudge")})
    env.expect_that("the kernel ran exactly one drag session", data.get("drags") == 1,
                    {"data": data, "host": b.get("hostStats")})
    # THE RECEIVER'S OWN COUNT. The kernel's global one is not it: the gesture begins inside the
    # SOURCE's window, so the first sample enters that one - a drag's own window is a legitimate
    # target.
    env.expect_that("the target was entered once",
                    ((b.get("viewer") or {}).get("enters") or 0) == 1
                    and (data.get("enters") or 0) >= 1,
                    {"viewerEnters": (b.get("viewer") or {}).get("enters"), "data": data})
    env.expect_that("the drop was delivered",
                    data.get("drops") == 1 and data.get("dropsLost") == 0,
                    {"data": data})
    # THE SOURCE'S RECEIPT, which a MOVE source cannot do without: effect 0 means the bytes went
    # nowhere and the original must stay.
    effects = ((b.get("source") or {}).get("effects") or [])
    env.expect_that("and the source was told the effect",
                    len(effects) == 1
                    and effects[0].get("effect") == cfg.get("DOBJ_EFFECT_COPY"),
                    {"effects": effects, "cfg": cfg})
    # THE MILESTONE'S OWN PROOF SENTENCE: "assert the bytes arrived under the image format".
    drop = b.get("shown") or {}
    env.expect_that("the bytes arrived under the image format",
                    drop.get("source") == "drop"
                    and (drop.get("bitmap") or {}).get("w") == 16
                    and (drop.get("bitmap") or {}).get("h") == 16
                    and (drop.get("bitmap") or {}).get("bytes", 0) > 0,
                    {"shown": drop, "viewer": b.get("viewer")})
    env.expect_that("the receiver drew them",
                    drop.get("drawn") is True and b.get("drewMs", -1) >= 0,
                    {"shown": drop, "drewMs": b.get("drewMs"), "surface": b.get("surface")})
    env.expect_that("and the pixels on its canvas are the logo's",
                    b.get("corner") == cfg.get("AMBER") and b.get("edge") == cfg.get("BLUE"),
                    {"corner": b.get("corner"), "edge": b.get("edge")})
    # AND THE PAYLOAD GOES BACK. The drop's fd was closed by the receiver, which is where a
    # kernel-owned allocation returns to the budget.
    env.expect_that("the payload was released once the receiver closed it",
                    data.get("bytes") == 0 and (data.get("pending") or []) == [],
                    {"data": data})
    env.expect_that("driven by a REAL mouse", b.get("drivenBy") == "check",
                    {"drivenBy": b.get("drivenBy")})

    # ---- PROOF 3: a text-only object is refused by name, and no path is drawn ---------------
    c = ev("refuse")
    env.expect_that("refuse ok", section_ok("refuse"), c)
    env.expect_that("a text file is copied as text, with no image format",
                    "text" in (c.get("formats") or [])
                    and "bitmap" not in (c.get("formats") or [])
                    and "png" not in (c.get("formats") or []),
                    {"formats": c.get("formats")})
    # THE REFUSAL IS THE KERNEL'S ERRNO AND NOT THE PROGRAM'S OPINION: `imgview` asks for the
    # bitmap on purpose so the name in its report is the one the kernel answered (constraint 247).
    env.expect_that("the image view refused it as ENOTSUP",
                    (c.get("shown") or {}).get("refused") == "ENOTSUP",
                    {"shown": c.get("shown")})
    env.expect_that("and said what the object DID offer",
                    len(c.get("refusals") or []) >= 1
                    and "text" in (c.get("refusals") or [""])[0],
                    {"refusals": c.get("refusals")})
    # AND THE THING THAT MUST NOT HAPPEN. `PLAN.md` section 5: "the image paste must fail cleanly,
    # not silently paste a path".
    env.expect_that("nothing was drawn as an image",
                    (c.get("shown") or {}).get("drawn") is not True
                    and not (c.get("shown") or {}).get("bitmap")
                    and not (c.get("shown") or {}).get("png"),
                    {"shown": c.get("shown"), "surface": c.get("surface")})

    # ---- PROOF 4: the payload is accounted, and the page cannot forge a drop ----------------
    e = ev("account")
    env.expect_that("account ok", section_ok("account"), e)
    env.expect_that("a PNG is copied as an opaque payload",
                    "png" in (e.get("formats") or []),
                    {"formats": e.get("formats")})
    env.expect_that("the kernel holds its bytes while anything references it",
                    (e.get("heldBytes") or 0) > 0 and e.get("heldRows") == 1,
                    {"bytes": e.get("heldBytes"), "rows": e.get("heldRows")})
    # NOTHING HERE DECODES PNG, and that is the point: the header is what says the opaque bytes
    # crossed two processes intact.
    png = (e.get("shown") or {}).get("png") or {}
    env.expect_that("the receiver reads its header and reports the size",
                    png.get("w") == 16 and png.get("h") == 16 and png.get("bytes", 0) > 0,
                    {"png": png, "shown": e.get("shown")})
    # ASSERTED OF A PNG THAT ARRIVED, not of a window that drew nothing. The first version read
    # only `drawn is not True`, which HELD under `--negative text-only` where no PNG arrives at
    # all - the control found it, and a clause satisfied by an empty clipboard asserts the symptom
    # rather than the invariant (CLAUDE.md, verification).
    env.expect_that("and it refuses to draw what it cannot decode",
                    bool(png) and (e.get("shown") or {}).get("drawn") is not True,
                    {"shown": e.get("shown"), "png": png})
    # THE PAGE REPORTS WHERE THE POINTER IS; WHAT A DRAG IS BELONGS TO THE KERNEL. Without the
    # refusal in `feed` a page could post a WEV_DROP naming an offer no object carries, and a
    # target would ask for a drop that does not exist (constraint 243).
    forged = e.get("forged") or {}
    env.expect_that("the page cannot feed a drag record",
                    forged.get("offered") == 2 and forged.get("queued") == 0
                    and e.get("forgedCount") == 2
                    and (e.get("pendingAfterForge") or []) == [],
                    {"forged": forged, "count": e.get("forgedCount"),
                     "pending": e.get("pendingAfterForge")})

    env.expect("verdict is ok", got["verdict"], "ok")

    served = env.request(env.document)
    env.expect("document COOP", served.headers.get("Cross-Origin-Opener-Policy"), "same-origin")
    env.expect("document COEP", served.headers.get("Cross-Origin-Embedder-Policy"), "require-corp")
    env.expect_that("served m10.html", env.served_matches_disk(env.document),
                    "the m10.html served does not match www/m10.html on disk")


@check(
    name="m11",
    milestone="m11",
    controls=(Control.INVERT, Control.NO_ISOLATION, Control.NO_BLUR, Control.NO_GLASS,
              Control.SEVER, Control.NO_HALO, Control.FLAT_DESK),
    labels=M11_LABELS,
    requires_isolation=True,
    root=Root.REPO,
    document=M11_DOCUMENT,
    ready_expr=M11_READY,
    ready_what="globalThis.M11 reaching done/aborted/error (www/m11.html)",
    # One kernel, one process, two windows and no threshold waited on, so this is among the
    # fastest window checks. The bound is generous for M5's reason: a program parked in `poll`
    # raises no error, so a wedge must end as a BROKEN check carrying the page's own state.
    ready_timeout=300.0,
    refusal_expr="globalThis.M11 && globalThis.M11.state",
    refusal_want="aborted",
    note="AERO GLASS, FRAME-ONLY, AND THE FRAME IS FOUR FILTERED STRIPS. `backdrop-filter` filters "
         "an element's BORDER BOX, so one glass node with an opaque client child hides the blur "
         "and saves none of it: measured at 640x440, four strips filter 27,260 CSS px^2 against "
         "281,600 for the box, which is 531 windows to gap-04's 58 M wall against 51. The box "
         "figure reproduces gap-04's own measured ~51 exactly, which is what makes the ring figure "
         "trustworthy. So `docs/DECISIONS.md` D13's '~11x cheaper' is true of the ring and false "
         "of the box, and `bench/m11-glass/probe.py` is the measurement that settled it before any "
         "of this was built (constraint 49, `docs/designs/REVIEW-FINDINGS.md` §3).\n"
         "THE PIXELS COME OUT OF A SCREENSHOT, because they cannot come from anywhere else: a "
         "`backdrop-filter` is applied by the compositor, `getImageData` reads a canvas, and a DOM "
         "rasteriser applies no filter at all. `scripts/png.py` decodes it and samples the band; "
         "the page publishes WHERE to sample in device pixels and never claims to have read it.\n"
         "THE BACKDROP IS A HARD BLACK/WHITE SEAM, which is constraint 50: over a flat backdrop "
         "`blur(flat) == flat` and every assertion here would pass with the blur switched off. The "
         "seam is placed at the midpoint of the caption's own rendered TEXT, so glass and glyphs "
         "both straddle it, and the bare backdrop is sampled too — without that reference, "
         "'spread' could be satisfied by a flat desktop.\n"
         "AND THE ASSERTION IS NOT 'MONOTONIC'. `PLAN.md` §5 asks for a monotonic gradient and "
         "MEASURED, A HARD STEP IS MONOTONIC: the bare seam, blur(0px), `none` and a severed chain "
         "all report a monotonic rise. What separates a ramp from a step is the CONCENTRATION of "
         "the transition — 0.078 for real glass against 1.000 for the bare step.\n"
         "THE CAPTION IS LEGIBLE BY ITS HALO, not by a colour. The same caption crosses black and "
         "white in one drag, so no (colour, background) pair has a contrast ratio; Windows 7 "
         "answers with a glow and the measurement is LOCAL contrast inside the glyph band, each "
         "side of the seam. Reading a declared `color` against a declared `background` is webxp's "
         "own defect (constraint 39).\n"
         "negative control: --negative no-blur keeps the isolation, the brightness and the "
         "additive layers and sets the standard deviation to zero. THE PAGE'S OWN SIX PROOFS ALL "
         "STAY GREEN under it — the geometry, the chain, the halo, the inert buttons and the focus "
         "pair are all unchanged — so the three screenshot clauses are the only thing in this "
         "suite that can catch a missing blur. That is the milestone. "
         "--negative no-glass is `backdrop-filter: none`, the control `PLAN.md` named, and it is "
         "the WEAKER cut: `REVIEW-FINDINGS` §8 measured that removing the property also removes "
         "the isolated group the additive layers blend into, so it moves the pixel for a reason "
         "unrelated to blurring. --negative sever puts `opacity:.99` on a wrapper and leaves the "
         "strips asking for blur(9px): the failure with no symptom. --negative no-halo collapses "
         "the caption's local contrast from 9.3:1 and 8.9:1 to 2.1:1 and 1.7:1. "
         "--negative no-isolation must come out BROKEN: no SAB, so no kernel and no window.",
)
def check_m11(env: Env) -> None:
    got = env.read(READ_M11, M11_SHAPE)

    if got["state"] == "error":
        env.unmeasurable(
            "www/m11.html reported state 'error' before producing proofs: %s. Nothing below was "
            "measured." % (got["why"] or "no reason given"))
    if got["state"] == "aborted":
        env.unmeasurable(
            "www/m11.html aborted: %s. Without cross-origin isolation the kernel's SAB is not "
            "constructible, so no process runs and no window is framed — and the glass could "
            "still be DRAWN, which is exactly why the page refuses before it draws any."
            % (got["why"] or "no reason given"))
    if got["state"] != "done":
        env.unmeasurable("www/m11.html never reached a terminal state (state=%r)" % got["state"])

    env.expect("page isolated", got["isolated"], True)
    env.expect("kernel isolated", got["kernelIsolated"], True)
    env.expect_that("the kernel raised no error", not got["errors"],
                    "kernel errors: %s" % "; ".join(got["errors"][:4]))
    # TWO WINDOWS, because proof 6 cannot express "inactive" with one — and because a page that
    # framed nothing would satisfy several structural clauses vacuously.
    env.expect_that("two windows, both framed", got["live"] >= 2,
                    {"framesInTheDom": got["live"], "faults": got["faults"][:3]})

    def ev(name):
        return (got[name] or {}).get("evidence") or {}

    def section_ok(name):
        row = got[name]
        return bool(row and row.get("ok"))

    # ---- PROOF 1: the filtered area IS the ring --------------------------------------------
    r = ev("ring")
    env.expect_that("ring ok", section_ok("ring"), r)
    env.expect_that("the frame is FOUR separately filtered strips",
                    r.get("stripCount") == 4 and r.get("everyStripFilters") is True,
                    {"strips": r.get("parts"), "count": r.get("stripCount")})
    # AGAINST THE ONE FORMULA. M12's admission controller must call `aero.ringArea` rather than
    # restate it: a second copy is how a governor comes to account a frame nobody renders, which is
    # the ~17x under-read constraint 49 exists to forbid.
    env.expect_that("and their summed border boxes are what aero.ringArea says",
                    r.get("agreesWithFormula") is True,
                    {"rendered": r.get("renderedRingArea"), "formula": r.get("formulaRingArea"),
                     "box": r.get("box")})
    # AND THE CLAUSE THAT STOPS IT BEING VACUOUS: if the frame or the client area filtered too,
    # their border boxes would be the whole window and the ring would be a lie.
    env.expect_that("while the frame itself and the client area filter NOTHING",
                    r.get("frameFilter") == "none" and r.get("clientFilter") == "none"
                    and r.get("clientOpaque") is True,
                    {"frame": r.get("frameFilter"), "client": r.get("clientFilter"),
                     "clientBackground": r.get("clientBackground")})
    at = r.get("at640x440") or {}
    env.expect_that("so the ring is ~10x cheaper than the same window as one glass node",
                    (at.get("cheaperBy") or 0) >= 10.0 and (r.get("cheaperBy") or 0) > 5,
                    {"at640x440": at, "atThisWindow": r.get("cheaperBy"), "box": r.get("box")})

    # ---- PROOF 2: nothing severs the blur chain ---------------------------------------------
    c = ev("chain")
    env.expect_that("chain ok", section_ok("chain"), c)
    env.expect_that("no ancestor of any strip severs the blur chain",
                    (c.get("stripsChecked") or 0) >= 8 and not c.get("severed"),
                    {"checked": c.get("stripsChecked"), "severed": c.get("severed")})
    env.expect_that("and both additive layers sit INSIDE a strip, on plus-lighter",
                    (c.get("layerCount") or 0) >= 16
                    and c.get("everyLayerInsideAStrip") is True
                    and c.get("everyLayerAdditive") is True,
                    {"layers": c.get("layerCount"),
                     "inside": c.get("everyLayerInsideAStrip"),
                     "additive": c.get("everyLayerAdditive")})

    # ---- PROOF 3: the glass blurs, read out of the composited pixels -----------------------
    b = ev("blur")
    env.expect_that("blur ok", section_ok("blur"), b)
    env.expect_that("the caption straddles a hard black/white seam",
                    b.get("straddles") is True and bool(b.get("capFilter")),
                    {"seamDeviceX": b.get("seamDeviceX"), "caption": b.get("caption"),
                     "filter": b.get("capFilter")})
    # Sampled at the caption's vertical middle the run crosses the title's glyph edges, which are
    # hard steps: measured, 0.74 against 0.078 for the same glass clear of them. That would have
    # put the threshold on the wrong side of the answer.
    env.expect_that("and the band sampled is clear of the title glyphs",
                    b.get("bandIsTextFree") is True,
                    {"bandY": b.get("bandY"), "rows": b.get("bandRows"),
                     "textTop": b.get("textTop")})

    shot = env.shoot("m11-glass")
    try:
        img = Png.decode(shot.read_bytes())
    except Exception as error:                 # noqa: BLE001 - named, never swallowed
        env.unmeasurable("the screenshot at %s could not be decoded (%s), so no pixel below was "
                         "measured" % (_relative(shot), error))
    # VIEWPORT_SCALE, which is what this suite actually emulates. `DEVICE_SCALE` does not
    # exist, so the fallback raised NameError instead of falling back — reachable whenever
    # the page reports `done` with no blur evidence, which `?live=1` does by construction.
    dpr = b.get("dpr") or VIEWPORT_SCALE
    seam = int(b.get("seamDeviceX") or 0)

    def band(y, rows):
        """One sample run across the seam, or None if it fell outside the image — which is a
        geometry bug in the page, not a measurement, so it is reported rather than clamped."""
        try:
            _, lumas = band_profile(img, seam_x=seam, y=int(y), rows=int(rows),
                                    dpr=dpr, reach_css=M11_REACH_CSS)
        except Exception:                      # noqa: BLE001 - the decoder raises on a bad read
            return None
        return transition(lumas)

    # THE DEPTH THE PAGE PUBLISHED, not a constant here. A caption's text-free gap is about 7 device
    # rows at dpr 2 and 3 at dpr 1, so the page places the band in the gap it measured and says how
    # deep it made it; a fixed depth here would sample into the glyphs on any other display.
    rows = int(b.get("bandRows") or M11_BAND_ROWS)
    glass = band(b.get("bandY") or 0, rows)
    # The bare band has no text anywhere near it, so it keeps the full depth.
    bare = band((b.get("bareY") or 0) - M11_BAND_ROWS // 2, M11_BAND_ROWS)

    # THE REFERENCE FIRST. Without it "spread" could be satisfied by a flat backdrop, which is
    # exactly the defect constraint 50 names — so the bare seam has to read as a step before the
    # glass reading means anything.
    env.expect_that("the BARE backdrop reads as a hard step, so the seam is real",
                    bare is not None and bare.concentration >= M11_STEP_MIN
                    and bare.span >= 64.0,
                    {"bare": bare.as_dict() if bare else None, "want": {
                        "concentrationAtLeast": M11_STEP_MIN, "spanAtLeast": 64.0},
                     "seamDeviceX": seam, "shot": _relative(shot)})
    env.expect_that("and the glass reads as a SPREAD ramp, which a step cannot fake",
                    glass is not None and glass.concentration <= M11_SPREAD_MAX,
                    {"glass": glass.as_dict() if glass else None,
                     "want": {"concentrationAtMost": M11_SPREAD_MAX},
                     "control": b.get("control"), "shot": _relative(shot)})
    # And the band must have something to spread. A flat band has a concentration of 1.0 by this
    # arithmetic's own convention, but asserting the span says so in the register a reader needs.
    env.expect_that("while the band is not flat, which blur(flat) would be",
                    glass is not None and glass.span >= M11_SPAN_MIN,
                    {"span": glass.span if glass else None, "want": {"spanAtLeast": M11_SPAN_MIN},
                     "lumas": glass.as_dict()["lumas"] if glass else None})

    # ---- PROOF 4: the caption is legible at both ends of the seam --------------------------
    g = ev("legible")
    env.expect_that("legible ok", section_ok("legible"), g)
    env.expect_that("the caption carries a halo, and its glyphs cross the seam",
                    g.get("hasHalo") is True and g.get("glyphsStraddle") is True,
                    {"textShadow": g.get("textShadow"), "color": g.get("color"),
                     "text": g.get("text"), "textRect": g.get("textRect")})
    sides = {}
    for side in ("dark", "light"):
        box = g.get(side)
        try:
            sides[side] = local_range(img, box) if box else None
        except Exception:                      # noqa: BLE001
            sides[side] = None
    env.expect_that("the caption is legible over the BLACK side of the seam",
                    bool(sides["dark"]) and (sides["dark"]["ratio"] or 0) >= M11_CONTRAST_MIN,
                    {"dark": sides["dark"], "want": {"ratioAtLeast": M11_CONTRAST_MIN},
                     "box": g.get("dark")})
    # THE SIDE THAT NEEDS THE HALO. White glyphs over a bright blurred backdrop have no contrast at
    # all without a dark glow, which is why one text colour cannot answer for both.
    env.expect_that("and over the WHITE side, which no single text colour manages",
                    bool(sides["light"]) and (sides["light"]["ratio"] or 0) >= M11_CONTRAST_MIN,
                    {"light": sides["light"], "want": {"ratioAtLeast": M11_CONTRAST_MIN},
                     "box": g.get("light")})

    # ---- PROOF 5: the caption's commands are live, and a minimize round trip returns the box ----
    #
    # UNTIL M14 THIS ASSERTED THE OPPOSITE, and the change is a milestone rather than a correction:
    # the buttons were disabled because there was nothing to minimize into, no snap state to
    # maximize to, and no state property in the window ABI. M14 added `WIN_SET_STATE`, a taskbar
    # and a work area, so the three reasons are gone — and the clause had to move with the product,
    # because a check that still demanded `disabled` would be demanding the feature back.
    i = ev("caption")
    env.expect_that("caption ok", section_ok("caption"), i)
    buttons = i.get("buttons") or []
    env.expect_that("minimize and maximize are live, drawn and labelled",
                    i.get("live") is True,
                    {"buttons": buttons})
    # THE WIRING AND THE GEOMETRY TOGETHER. `disabled === false` on its own is the live-looking
    # button that does nothing; and a minimize that came back somewhere else would be a close with
    # extra steps. The state is read out of the KERNEL's own report, not the page's.
    env.expect_that("and a minimize round trip returns the window to the same box",
                    i.get("roundTripped") is True,
                    {"wentMs": i.get("wentMs"), "backMs": i.get("backMs"),
                     "stateWhileMinimized": i.get("stateWhileMinimized"),
                     "before": i.get("before"), "after": i.get("after"),
                     "boxUnchanged": i.get("boxUnchanged")})
    # A REAL MOUSE DRAG FROM EACH OF THEM, and `btn.click()` on its own proved nothing:
    # `HTMLElement.click()` returns early for a disabled form control, so no event was dispatched
    # and "the box did not move" could not have failed however the buttons behaved. A press, some
    # movement and a release is the gesture that actually moves a window — and it is also what
    # tests that the press does not fall through to the caption underneath and start a drag there.
    moved = []
    for row in (i.get("buttons") or []):
        at = row.get("at") or {}
        if not at:
            continue
        before_box = env.page.evaluate(READ_M11_BOX)
        # `mouse_drag` takes mappings, not tuples.
        mouse_drag(env.page, at, {"x": at["x"] + 40, "y": at["y"] + 24})
        after_box = env.page.evaluate(READ_M11_BOX)
        moved.append({"button": row.get("name"), "from": at,
                      "before": before_box, "after": after_box,
                      "same": before_box == after_box})
    env.expect_that("and a REAL mouse drag from either of them does not move the window",
                    len(moved) == 2 and all(m["same"] for m in moved),
                    {"drags": moved,
                     "pageClickBox": {"before": i.get("before"), "after": i.get("after")}})
    env.expect_that("while the close box is still live", i.get("closeEnabled") is True,
                    {"closeEnabled": i.get("closeEnabled"), "width": i.get("closeWidth")})
    # AND END PROCESS IS NOT OFFERED ON A HEALTHY WINDOW. `src/wm/window.mjs` sets `hidden`
    # correctly and M7 asserts on that; an AUTHOR `display` declaration beats the UA stylesheet's
    # `[hidden] { display: none }`, and `.title-box` carries `display: grid` — so this skin offered
    # the kill affordance on every healthy window from the moment it existed, and M7's check could
    # not see it because M7's page is unskinned. Found by looking at a screenshot of the real
    # desktop, which is why the clause reads the COMPUTED style and not the attribute.
    env.expect_that("and End Process is not offered on a window that is responding",
                    i.get("endNotOffered") is True,
                    {"hiddenAttribute": i.get("endHiddenAttr"), "display": i.get("endDisplay"),
                     "health": i.get("health")})

    # ---- PROOF 6: inactive glass is brighter and less tinted -------------------------------
    f = ev("focus")
    env.expect_that("focus ok", section_ok("focus"), f)
    # `documentHasFocus` travels with this one so a failure names its cause: `:focus-within` matches
    # nothing in an unfocused document, so without it BOTH windows read inactive and the pair cannot
    # be compared. The suite drives Chrome with focus emulation on; headless Firefox does not, and
    # `bench/m7-win/firefox.py --page m11` reports exactly that.
    env.expect_that("an inactive window passes MORE backdrop through, not less",
                    f.get("inactivePassesMoreBackdrop") is True
                    and f.get("focusIsDistinct") is True,
                    {"active": f.get("activeBlurBalance"),
                     "inactive": f.get("inactiveBlurBalance"),
                     "focusIsDistinct": f.get("focusIsDistinct"),
                     "documentHasFocus": f.get("documentHasFocus")})
    env.expect_that("and tints it LESS, which one opacity value cannot express",
                    f.get("inactiveTintsLess") is True,
                    {"activeAlpha": f.get("activeTintAlpha"),
                     "inactiveAlpha": f.get("inactiveTintAlpha"),
                     "scale": f.get("expectedTintScale")})
    env.expect_that("and the remap is 0.4*b + 0.6, measured off the computed filter",
                    f.get("matchesTheRemap") is True,
                    {"got": f.get("inactiveBlurBalance"),
                     "want": f.get("expectedInactiveBlurBalance")})

    env.expect("verdict is ok", got["verdict"], "ok")

    served = env.request(env.document)
    env.expect("document COOP", served.headers.get("Cross-Origin-Opener-Policy"), "same-origin")
    env.expect("document COEP", served.headers.get("Cross-Origin-Embedder-Policy"), "require-corp")
    env.expect_that("served m11.html", env.served_matches_disk(env.document),
                    "the m11.html served does not match www/m11.html on disk")


@check(
    name="m12",
    milestone="m12",
    controls=(Control.INVERT, Control.NO_ISOLATION, Control.NO_GOVERNOR, Control.TOP_FIRST,
              Control.STALE_COSTS),
    labels=M12_LABELS,
    requires_isolation=True,
    root=Root.REPO,
    document=M12_DOCUMENT,
    ready_expr=M12_READY,
    ready_what="globalThis.M12 reaching done/aborted/error (www/m12.html)",
    ready_timeout=300.0,
    refusal_expr="globalThis.M12 && globalThis.M12.state",
    refusal_want="aborted",
    note="AN ADMISSION CONTROLLER OVER BLURRED AREA, NOT A DRAG HOOK (constraint 49). It runs on "
         "every event that can change the area — a window opening, the page reporting a box after "
         "a clamp or a resize, a window being destroyed — and degrades by z-order FROM THE "
         "BOTTOM, because the window the user is looking at is on top and glass costs the same "
         "wherever it sits.\n"
         "THE GATE `PLAN.md` §5 SPECIFIES CANNOT FIRE, and that is this milestone's finding. Both "
         "it and constraint 49 size M12's kill gate at '52 glass terminals at 640x440 (53.7 M "
         "device px)' — which is BOX accounting, one filtered node per window. M11 shipped the "
         "ring: four filtered strips summing to 27,260 CSS px^2, so 52 of them are 5.7 M device "
         "px, 10% of the measured wall. Reaching 45 M needs 413 windows against `WIN_CAP` 32 per "
         "process. A gate needing 413 windows cannot fail — the EXACT defect constraint 49 was "
         "itself corrected for once (`docs/DECISIONS.md` §Corrections, the 4x dpr error that made "
         "the Aero gate structurally green). So the finding is asserted instead: at the shipped "
         "budget this desktop is entirely glass, and `--negative blur-tiny` is not needed because "
         "the page arms a budget it MEASURED off the windows on screen.\n"
         "AND NO FRAME-RATE FIGURE COMES FROM HERE. `PLAN.md` asks for '>= 110 fps'; this suite "
         "runs headless with `--disable-gpu` and SwiftShader, pinned at 60 Hz — measured, a "
         "trivial geometry reads 60.0 fps and a headed CDP window is throttled to 8.9 because "
         "Chrome will not paint a window it believes occluded. A frame time from either is a "
         "number about the rasteriser wearing the name of a number about Aero. "
         "`bench/m12-governor/probe.py --headed` is where that question lives, and it refuses to "
         "draw a conclusion rather than printing one.\n"
         "THE PIXELS ARE READ OUT OF A SCREENSHOT, because `is-flat` in the DOM and a blur that "
         "is gone are DIFFERENT CLAIMS and only the second is the product: a governor that set a "
         "class and changed no pixel would save nothing and every other clause here would still "
         "pass. A flat caption must read as a STEP across a hard seam and a glass one as a spread "
         "ramp, on the same arithmetic M11 uses (`scripts/png.py`).\n"
         "negative control: --negative no-governor is `PLAN.md`'s own — nothing is ever "
         "flattened, so the degrade half and the pixel clauses go red while every measurement "
         "holds. --negative top-first degrades from the TOP, which moves the ORDER clauses and "
         "nothing else: the half of constraint 49 that is a judgement rather than an arithmetic. "
         "--negative stale-costs makes admission read the post-degrade total, which is the "
         "feedback loop this governor removed: it stops settling. "
         "--negative no-isolation must come out BROKEN: no SAB, no kernel, no windows.",
)
def check_m12(env: Env) -> None:
    got = env.read(READ_M12, M12_SHAPE)

    if got["state"] == "error":
        env.unmeasurable(
            "www/m12.html reported state 'error' before producing proofs: %s. Nothing below was "
            "measured." % (got["why"] or "no reason given"))
    if got["state"] == "aborted":
        env.unmeasurable(
            "www/m12.html aborted: %s. Without cross-origin isolation the kernel's SAB is not "
            "constructible, so no process runs, no window is framed and there is nothing to "
            "govern." % (got["why"] or "no reason given"))
    if got["state"] != "done":
        env.unmeasurable("www/m12.html never reached a terminal state (state=%r)" % got["state"])

    env.expect("page isolated", got["isolated"], True)
    env.expect("kernel isolated", got["kernelIsolated"], True)
    env.expect_that("the kernel raised no error", not got["errors"],
                    "kernel errors: %s" % "; ".join(got["errors"][:4]))

    def ev(name):
        return (got[name] or {}).get("evidence") or {}

    def section_ok(name):
        row = got[name]
        return bool(row and row.get("ok"))

    # ---- PROOF 1: the accounting ------------------------------------------------------------
    a = ev("account")
    env.expect_that("account ok", section_ok("account"), a)
    # THE CLAUSE THAT MAKES THE ARITHMETIC ABOUT THE PRODUCT. A governor accounting a frame nobody
    # renders is constraint 49's ~17x under-read, and the only way to tell is to measure the
    # strips the browser actually laid out.
    env.expect_that("the kernel's per-window cost is what the RENDERED strips cover",
                    a.get("kernelAgreesWithTheRenderedStrips") is True,
                    {"rendered": a.get("renderedDevicePx"), "kernel": a.get("kernelDevicePx"),
                     "mismatched": a.get("mismatched")})
    env.expect_that("and the page reported its device-pixel ratio, squared",
                    a.get("dprReported") is True,
                    {"dpr": a.get("dpr"), "kernelDprSq": a.get("dprSqAsKernelSeesIt")})
    # THE FINDING. Four strips per window moved the wall out of reach, so the shipped budget does
    # not bind on any desktop a person could build — stated as an assertion, not as prose.
    # A FLOOR, NOT THE FIGURE. 413 is a dpr-2 number and a second engine found that out: headless
    # Firefox renders at dpr 1, where the same geometry needs 1,651 windows, so an assertion on 413
    # failed on an engine whose governor was fine. The claim is that the budget is out of REACH,
    # and `PROC_CAP` is the honest bound for that — needing more windows than the process table
    # allows one each means no desktop gets there. `bench/m12-governor/probe.mjs` asserts the exact
    # dpr-2 figure, where the ratio is fixed.
    env.expect_that("the SHIPPED budget is out of reach, so this desktop is all glass",
                    (a.get("windowsToRealBudget") or 0) >= (a.get("unreachableFloor") or 128)
                    and a.get("wouldDegradeAtRealBudget") is False,
                    {"windowsToRealBudget": a.get("windowsToRealBudget"),
                     "floor": a.get("unreachableFloor"), "dpr": a.get("dpr"),
                     "allGlassCost": a.get("blurPxIfAllGlass"),
                     "realBudget": a.get("realBudget")})

    # ---- PROOF 2: the degrade branch --------------------------------------------------------
    d = ev("degrade")
    env.expect_that("degrade ok", section_ok("degrade"), d)
    env.expect_that("over the budget, glass comes off", d.get("someWentFlat") is True,
                    {"flat": d.get("flat"), "blurPx": d.get("blurPx"),
                     "budget": d.get("budget")})
    # BOTTOM-FIRST, which constraint 49 requires and which `--negative top-first` inverts.
    env.expect_that("from the BOTTOM of the stack, in stack order",
                    d.get("fromTheBottom") is True,
                    {"flat": d.get("flat"), "stack": d.get("stack")})
    env.expect_that("while the window on top keeps its glass",
                    d.get("topKeptItsGlass") is True,
                    {"stack": d.get("stack"), "flat": d.get("flat")})
    env.expect_that("and the total lands back under the budget", d.get("underBudget") is True,
                    {"blurPx": d.get("blurPx"), "budget": d.get("budget"),
                     "ifAllGlass": d.get("blurPxIfAllGlass")})
    # The page's own rendering of it, which is the second reading: a kernel that decided and a page
    # that never applied it is a desktop still paying for glass it was told to drop.
    env.expect_that("and the page rendered exactly the set the kernel decided",
                    d.get("pageRenderedIt") is True,
                    {"kernel": d.get("flat"), "pageFrames": d.get("hostFrameFlat"),
                     "pageSet": d.get("hostFlatSet")})

    # ---- PROOF 3: both edges ----------------------------------------------------------------
    h = ev("hysteresis")
    env.expect_that("hysteresis ok", section_ok("hysteresis"), h)
    env.expect_that("the two edges exist and are ordered",
                    h.get("hasHysteresis") is True,
                    {"restore": h.get("restoreEdge"), "budget": h.get("budget")})
    # THE THING HYSTERESIS EXISTS TO PREVENT: with one threshold, flattening a window lowers the
    # total, which re-admits it, which raises it again — for ever.
    env.expect_that("re-running the governor over an unchanged desktop changes nothing",
                    h.get("settled") is True,
                    {"degradesBefore": h.get("degradesAtStart"),
                     "degradesAfter": h.get("degradesAfterSettling"),
                     "flat": h.get("flatWhileSettling")})
    env.expect_that("and closing windows gives the glass back",
                    h.get("glassCameBack") is True and h.get("pageAgrees") is True,
                    {"flatAfter": h.get("flatAfterClosing"), "ended": h.get("endedPids"),
                     "liveAfter": h.get("liveAfter"), "pageFlat": h.get("hostFlatAfter")})

    # ---- PROOF 4: the pixels ----------------------------------------------------------------
    px = ev("pixels")
    env.expect_that("pixels ok", section_ok("pixels"), px)
    env.expect_that("a flat caption and a glass caption both cross a hard seam",
                    px.get("haveBoth") is True,
                    {"overlap": px.get("overlap"), "flatBand": px.get("flatBand"),
                     "glassBand": px.get("glassBand")})
    # NO FILTER AT ALL, not `blur(0px)`: a zero-radius filter still costs an offscreen buffer and a
    # pass, which is exactly the cost the governor exists to shed.
    env.expect_that("a flattened window carries NO backdrop-filter, not a zero-radius one",
                    px.get("flatFilterIsNone") is True,
                    {"flatBand": px.get("flatBand")})

    shot = env.shoot("m12-governor")
    try:
        img = Png.decode(shot.read_bytes())
    except Exception as error:                 # noqa: BLE001 - named, never swallowed
        env.unmeasurable("the screenshot at %s could not be decoded (%s), so no pixel below was "
                         "measured" % (_relative(shot), error))
    dpr = px.get("dpr") or VIEWPORT_SCALE
    seam = int(px.get("seamDeviceX") or 0)

    def band(spec, rows=None):
        if not spec:
            return None
        try:
            _, lumas = band_profile(
                img, seam_x=seam, y=int(spec["bandY"]),
                rows=int(rows or spec.get("bandRows") or M11_BAND_ROWS),
                dpr=dpr, reach_css=M11_REACH_CSS)
        except Exception:                      # noqa: BLE001 - the decoder raises on a bad read
            return None
        return transition(lumas)

    bare = None
    try:
        _, lumas = band_profile(img, seam_x=seam,
                                y=int(px.get("bareY") or 0) - M11_BAND_ROWS // 2,
                                rows=M11_BAND_ROWS, dpr=dpr, reach_css=M11_REACH_CSS)
        bare = transition(lumas)
    except Exception:                          # noqa: BLE001
        bare = None
    glass = band(px.get("glassBand"))
    flat = band(px.get("flatBand"))

    # THE REFERENCE FIRST, as M11 does it: without a seam that really is a step, "spread" could be
    # satisfied by a flat desktop and every clause below would pass with no blur anywhere.
    env.expect_that("the BARE backdrop reads as a hard step, so the seam is real",
                    bare is not None and bare.concentration >= M11_STEP_MIN
                    and bare.span >= 64.0,
                    {"bare": bare.as_dict() if bare else None, "seamDeviceX": seam,
                     "shot": _relative(shot)})
    env.expect_that("the GLASS caption reads as a spread ramp",
                    glass is not None and glass.concentration <= M11_SPREAD_MAX
                    and glass.span >= M11_SPAN_MIN,
                    {"glass": glass.as_dict() if glass else None,
                     "band": px.get("glassBand"),
                     "want": {"concentrationAtMost": M11_SPREAD_MAX,
                              "spanAtLeast": M11_SPAN_MIN}})
    # THE CLAUSE THE WHOLE MILESTONE RESTS ON. A class is not a saving; the blur has to be gone.
    env.expect_that("while the FLAT caption reads as a step, so the blur really went",
                    flat is not None and flat.concentration >= M11_STEP_MIN,
                    {"flat": flat.as_dict() if flat else None, "band": px.get("flatBand"),
                     "want": {"concentrationAtLeast": M11_STEP_MIN},
                     "glassForComparison": glass.as_dict() if glass else None})

    env.expect("verdict is ok", got["verdict"], "ok")

    served = env.request(env.document)
    env.expect("document COOP", served.headers.get("Cross-Origin-Opener-Policy"), "same-origin")
    env.expect("document COEP", served.headers.get("Cross-Origin-Embedder-Policy"), "require-corp")
    env.expect_that("served m12.html", env.served_matches_disk(env.document),
                    "the m12.html served does not match www/m12.html on disk")


@check(
    name="m6",
    milestone="m6",
    controls=(Control.INVERT, Control.NO_ISOLATION, Control.NO_LOCKDOWN, Control.NO_CSP),
    labels=M6_LABELS,
    requires_isolation=True,
    root=Root.REPO,
    document=M6_DOCUMENT,
    ready_expr=M6_READY,
    ready_what="globalThis.M6.state reaching done, aborted or error (www/m6.html)",
    # 0.8 s measured for the whole page on one kernel: six processes, no I/O beyond one 20-byte
    # file. The bound is generous because a process that faults when it should not leaves the page
    # waiting, and a BROKEN check carrying the page's own log beats a suite that never returns.
    ready_timeout=180.0,
    refusal_expr="globalThis.M6 && globalThis.M6.state",
    refusal_want="aborted",
    note="five proofs over ONE kernel, because the victim file has to outlive the process that "
         "wrote it. MILESTONES.md M6's proof is 'a program containing the bypass snippet fails, "
         "and /proc shows it faulted', and its control is 'skip the stripping; the same program "
         "must succeed' - `p_fault` in bench/m6-realm/program.mjs is that program, four lines "
         "with no try/catch, and it is a separate mode from the one that reports the detail "
         "because a faulted process has no result.\n"
         "THE HEADLINE IS THE VOLUME. A uid-1000 process is told EACCES by the syscall channel "
         "for a 0600 root-owned file, then tries the same write through ambient OPFS, by inode, "
         "against the kernel's own flat blob directory (constraint 26) - and a third process, "
         "uid 0, reads the file back through the syscall channel to say whether the bytes moved. "
         "Under --negative no-lockdown they DO: KERNEL-OWNED-SECRET becomes "
         "TAMPERED-BY-PROCESS and the kernel serves the tampered bytes as though nothing had "
         "happened.\n"
         "M6 IS TWO HALVES AND THEY ARE MEASURABLY DISJOINT. The realm strip "
         "(src/libos/lockdown.mjs) removes bindings; the Content-Security-Policy "
         "(scripts/serve.py) bounds the module loader, which no strip can reach because "
         "`import(expr)` is not `fetch`. WHERE the policy is delivered was measured rather than "
         "assumed: on the DOCUMENT it changes nothing at all for a dedicated module worker, so it "
         "goes on the response that creates the realm (bench/m6-realm/csp-probe.py, constraints "
         "187 and 188 - 188 corrects constraint 139, which named the document).\n"
         "negative controls: --negative no-lockdown must break every realm clause, the volume and "
         "the fault while every LOADER clause holds; --negative no-csp must break every loader "
         "clause while every REALM clause, the volume and the fault hold. Neither is satisfiable "
         "by the other's mechanism, which is the point. --negative no-isolation must come out "
         "BROKEN: no SAB, so no kernel, so no process realm to strip.\n"
         "LABELLED HONESTLY, in the docs and here: this is HARDENING, NOT A SECURITY BOUNDARY. "
         "Same-origin is not a security boundary and the threat model is first-party only. What "
         "remains reachable is recorded rather than implied - `script-src 'self'` means a program "
         "can still dynamically import any same-origin module, which is why "
         "'while the one same-origin specifier still loads' is written as a positive control and "
         "not as a boast.",
)
def check_m6(env: Env) -> None:
    got = env.read(READ_M6, M6_SHAPE)

    if got["state"] == "error":
        env.unmeasurable(
            "www/m6.html reported state 'error' before producing proofs: %s. Nothing below was "
            "measured." % (got["why"] or "no reason given"))
    if got["state"] == "aborted":
        env.unmeasurable(
            "www/m6.html aborted: %s. Without cross-origin isolation there is no SAB, so no "
            "kernel, so no process realm to strip." % (got["why"] or "no reason given"))
    if got["state"] != "done":
        env.unmeasurable("www/m6.html never reached a terminal state (state=%r)" % got["state"])

    sections = ("realm", "volume", "loader", "fault", "policy")
    env.expect_that(
        "cell reported",
        all(got[name] is not None for name in sections),
        "sections absent: %s" % ", ".join(n for n in sections if got[n] is None))

    env.expect("page isolated", got["isolated"], True)
    env.expect("kernel isolated", got["kernelIsolated"], True)
    # A FAULT IS NOT AN ERROR HERE, and that distinction is this check's subject: proof 4 is a
    # program that MUST fault. `errors` carries only what the kernel reported as an error or a
    # panic, so a faulted process does not appear in it (constraint 140).
    env.expect_that("the kernel raised no error", not got["errors"],
                    "kernel errors: %s" % "; ".join(got["errors"][:4]))

    def ev(name):
        return (got[name] or {}).get("evidence") or {}

    def section_ok(name):
        row = got[name]
        return bool(row and row.get("ok"))

    def refused(rows, name):
        """A row the attacker reported, and it must NOT have succeeded.

        `not row.get("ok")` would be True for a row that is ABSENT, so the row's presence is
        asserted separately: a page that stopped reporting `tamper` at all would otherwise read
        as a tamper that was refused.
        """
        row = rows.get(name)
        return isinstance(row, dict) and row.get("ok") is False

    def reached(rows, name):
        row = rows.get(name)
        return isinstance(row, dict) and row.get("ok") is True

    # ---- PROOF 5: the policy, on the wire ------------------------------------------------
    # FIRST, because it decides what the loader clauses below mean. A page that measured
    # refusals without knowing whether a policy was served could not tell a bounded realm from a
    # broken one.
    po = ev("policy")
    env.expect_that("policy ok", section_ok("policy"), po)
    env.expect_that("the process realm's script carries a policy", po.get("present") is True,
                    {"header": po.get("header"), "status": po.get("status")})
    # BOTH HALVES IN ONE CLAUSE, and the first half is why: "the header does not contain
    # 'unsafe-eval'" is satisfied by a response carrying no policy at all, so it would pass under
    # --negative no-csp while `eval` worked.
    env.expect_that(
        "and the policy names script-src without 'unsafe-eval'",
        bool(po.get("scriptSrc")) and po.get("unsafeEval") is False,
        {"script-src": po.get("scriptSrc"), "unsafe-eval": po.get("unsafeEval")})

    # ---- PROOF 1: the realm ---------------------------------------------------------------
    rl = ev("realm")
    keys = rl.get("realmKeys") or {}
    env.expect_that("realm ok", section_ok("realm"), rl)
    # THE BASELINE EVERY ROW BELOW IS READ AGAINST. If the syscall channel had not refused this
    # process, the rows below would be measuring a system with no permissions rather than a realm
    # with a hole in it.
    env.expect_that("a uid-1000 process is refused the file by the syscall channel",
                    (rl.get("syscallRefused") or {}).get("ok") is True,
                    rl.get("syscallRefused"))
    env.expect_that("and its own syscalls still work",
                    (rl.get("syscallsStillWork") or {}).get("ok") is True,
                    rl.get("syscallsStillWork"))
    env.expect_that(
        "the lockdown reports every target stripped and none surviving",
        rl.get("skipped") is False and len(rl.get("stripped") or []) >= 6
        and bool(keys) and all(value is False for value in keys.values()),
        {"skipped": rl.get("skipped"), "stripped": rl.get("stripped"),
         "absent": rl.get("absent"), "present": {k: v for k, v in keys.items() if v}})
    env.expect_that(
        "ambient OPFS is gone",
        keys.get("navigator.storage") is False and refused(rl, "storage"),
        {"binding": keys.get("navigator.storage"), "storage": rl.get("storage")})
    env.expect_that(
        "the network is gone",
        keys.get("fetch") is False and keys.get("XMLHttpRequest") is False
        and refused(rl, "fetch") and refused(rl, "xhr"),
        {"fetch": keys.get("fetch"), "XMLHttpRequest": keys.get("XMLHttpRequest"),
         "rows": [rl.get("fetch"), rl.get("xhr")]})
    env.expect_that(
        "the durable stores are gone",
        keys.get("indexedDB") is False and keys.get("caches") is False
        and refused(rl, "indexedDB") and refused(rl, "caches"),
        {"indexedDB": keys.get("indexedDB"), "caches": keys.get("caches"),
         "rows": [rl.get("indexedDB"), rl.get("caches")]})
    # Constraint 53, which is why this is a correctness requirement and not only hardening: a
    # worker a process makes for itself is invisible to the process table while still holding a
    # renderer slot, so the cap in constraint 17 is enforced over a number that is not the real
    # one until this is gone.
    env.expect_that(
        "a process cannot construct a worker",
        keys.get("Worker") is False and keys.get("SharedWorker") is False
        and refused(rl, "nestedWorker"),
        {"Worker": keys.get("Worker"), "SharedWorker": keys.get("SharedWorker"),
         "nested": rl.get("nestedWorker")})
    # The policy MUST allow `blob:` - a program image is one - so this is the only thing standing
    # between a program and an image of its own making.
    env.expect_that(
        "a process cannot mint a blob URL",
        keys.get("URL.createObjectURL") is False and refused(rl, "createObjectURL"),
        {"binding": keys.get("URL.createObjectURL"), "row": rl.get("createObjectURL")})

    # UNDER --negative no-lockdown THE POLICY DOES THE TALKING, and it talks in the console.
    #
    # With the realm unstripped a process HOLDS `fetch`, `WebSocket` and `Worker` again, so the
    # calls are made and the policy refuses them out loud — three messages that cannot occur in a
    # normal run, because there the bindings are not there to call. Claimed rather than asserted
    # (see Env.claim_console), and reached only on the page's own report that the strip was
    # skipped, so the normal run stays strict.
    # CHROME HAS TWO WORDINGS FOR A REFUSED CONNECTION and the first version of this list only
    # had one: `fetch` logged "Refused to connect because it violates the document's Content
    # Security Policy" in one run and "Connecting to '<url>' violates the following Content
    # Security Policy directive: \"connect-src 'none'\"" in the next. Both are claimed, by the
    # directive name where it appears and by the other wording where it does not.
    if rl.get("skipped") is True:
        for needle, why in (
            ("""directive: "connect-src 'none'\"""",
             "fetch, XHR and WebSocket exist again; connect-src 'none' refuses each request"),
            ("Refused to connect because it violates",
             "the same refusal, in Chrome's other wording for it"),
        ):
            env.claim_console(needle, why)

    # ---- PROOF 2: THE HEADLINE. The kernel's own volume ----------------------------------
    vo = ev("volume")
    env.expect_that("volume ok", section_ok("volume"), vo)
    env.expect_that("the tamper by inode was refused",
                    (vo.get("tamper") or {}).get("ok") is False, vo.get("tamper"))
    # READ BACK THROUGH THE SYSCALL CHANNEL by a third process, not asserted from the attacker's
    # own report: the question is what the KERNEL now serves for that file, and only the kernel
    # can answer it.
    env.expect_that(
        "and the kernel's own bytes are unchanged",
        vo.get("intact") is True and vo.get("tampered") is False,
        {"got": vo.get("got"), "want": vo.get("want"), "ino": vo.get("ino")})

    # ---- PROOF 3: the loader (constraint 139's open half) --------------------------------
    lo = ev("loader")
    env.expect_that("loader ok", section_ok("loader"), lo)
    env.expect_that("a computed data: import is refused",
                    (lo.get("importData") or {}).get("ok") is False, lo.get("importData"))
    # THE REFUSAL, NAMED BY THE REALM THAT WAS REFUSED. A thrown
    # "Failed to fetch dynamically imported module" cannot attribute anything: it reads the same
    # whether a policy refused the load or nothing was listening at the other end. The
    # `securitypolicyviolation` event names the blocked URI and the directive, from inside the
    # process realm, so this is the clause that says the POLICY did it.
    #
    # FIRST WRITTEN AS env.expect_console AND THAT WAS WRONG: the needle
    # "violates the following Content Security Policy directive" also matches the worker-src
    # message the no-lockdown control provokes, which arrives FIRST, so the clause claimed the
    # wrong entry and left the one it was about unclaimed. An in-realm event cannot be confused
    # with another refusal in the same way.
    data_violations = [v for v in (lo.get("violations") or [])
                       if str(v.get("blockedURI", "")).startswith("data")
                       and "script-src" in str(v.get("directive", ""))]
    env.expect_that("and the realm's own violation event names script-src",
                    bool(data_violations),
                    {"violations": lo.get("violations")})
    # The same refusal, as Chrome logs it. CLAIMED and not asserted: the event above is the
    # evidence, and this only keeps the end-of-check sweep from reporting the renderer's own
    # correct behaviour as an error nobody looked at.
    env.claim_console("Loading the script 'data:text/javascript",
                      "the policy refused the computed data: import, which is proof 3's subject")
    env.expect_that(
        "eval and new Function are refused",
        (lo.get("eval") or {}).get("ok") is False
        and (lo.get("newFunction") or {}).get("ok") is False,
        {"eval": lo.get("eval"), "newFunction": lo.get("newFunction")})
    # THE POSITIVE CONTROL. A policy that refused everything would satisfy every clause above and
    # run no program at all. It is also the honest statement of what remains reachable.
    env.expect_that("while the one same-origin specifier still loads",
                    (lo.get("allowedImport") or {}).get("ok") is True, lo.get("allowedImport"))

    # ---- PROOF 4: MILESTONES.md M6's own proof -------------------------------------------
    fa = ev("fault")
    # AN EXPIRED READ IS AN UNTAKEN MEASUREMENT, NOT A FAILED PROOF, and reporting it as the
    # second would be this harness scoring correct kernel behaviour as a defect. A reaped pid
    # leaves the table when the ~2.2 s terminate quarantine ends (constraint 14), so a read that
    # lands after it finds ENOENT and says nothing about whether the process faulted. The page
    # runs that read on an already-live process to make this rare; this keeps it honest when it
    # happens anyway. Raised BEFORE the clauses below, so no label is recorded from a run that
    # could not answer.
    if fa.get("expired") is True:
        env.unmeasurable(
            "/proc lost the faulted pid before it could be read: %s. The fault itself was "
            "observed (faulted=%s), but the quarantine had expired, so the state could not be. "
            "Re-run; if it repeats on an idle machine, the read is too slow rather than flaky."
            % (fa.get("why"), fa.get("faulted")))
    env.expect_that("fault ok", section_ok("fault"), fa)
    env.expect_that("the bypass program faulted",
                    fa.get("faulted") is True and fa.get("bypassed") is False,
                    {"faulted": fa.get("faulted"), "bypassed": fa.get("bypassed"),
                     "names": fa.get("names"), "why": fa.get("faultWhy")})
    # NOT "the directory is gone": a reaped process is a zombie for the ~2 s terminate quarantine
    # (constraint 14), so /proc both can and should still show it - with the kind and value it
    # died of. An absence clause here would be racing the quarantine.
    env.expect_that(
        "and /proc shows it killed by SIGABRT",
        fa.get("state") == "zombie" and fa.get("exitKind") == fa.get("wantKind")
        and fa.get("exitValue") == fa.get("wantValue"),
        {"state": fa.get("state"), "exitkind": fa.get("exitKind"),
         "exitvalue": fa.get("exitValue"), "status": fa.get("status")})

    env.expect("verdict is ok", got["verdict"], "ok")

    served = env.request(env.document)
    env.expect("document COOP", served.headers.get("Cross-Origin-Opener-Policy"), "same-origin")
    env.expect("document COEP", served.headers.get("Cross-Origin-Embedder-Policy"), "require-corp")
    env.expect_that("served m6.html", env.served_matches_disk(env.document),
                    "the m6.html served does not match www/m6.html on disk")


@check(
    name="m13",
    milestone="m13",
    controls=(Control.INVERT, Control.NO_ISOLATION, Control.NO_CLAMP, Control.STALE_GEOM,
              Control.NO_RELAYOUT),
    labels=M13_LABELS,
    requires_isolation=True,
    root=Root.REPO,
    document=M13_DOCUMENT,
    ready_expr=M13_READY,
    ready_what="globalThis.M13 reaching done/aborted/error, or asking for its first gesture "
               "(www/m13.html)",
    ready_timeout=300.0,
    refusal_expr="globalThis.M13 && globalThis.M13.state",
    refusal_want="aborted",
    note="THE GEOMETRY HARNESS, which is the only proof M7-M12 have that the numbers they trade "
         "are about the window a reader can touch. `PLAN.md` §5 costs it at five days and says it "
         "is new work rather than a port, and the reason is constraint 40: an inert frame and a "
         "working one are the same picture, so every clause here is read off a RENDERED rect and "
         "every gesture is REAL input through `Input.dispatchMouseEvent` and "
         "`Input.dispatchKeyEvent`.\n"
         "THE PAGE ASKS AND THIS CHECK PERFORMS. A page cannot drive its own pointer — a "
         "synthesised `PointerEvent` is `isTrusted === false` and `setPointerCapture` refuses a "
         "pointerId no live pointer owns (constraint 175) — so `www/m13.html` publishes the "
         "gesture it needs at coordinates it measures off its own rects and blocks until something "
         "performs it (`gestureAsker` in www/pagekernel.mjs, `drive_gestures` here). A human "
         "opening the page performs the same asks by hand.\n"
         "THE THREE EDGES OF THE CLAMP ARE THREE DIFFERENT GESTURES, and that is arithmetic rather "
         "than variety: the right and bottom bounds sit inside the desktop so a pointer can "
         "overshoot them, and the LEFT bound is `MIN_VISIBLE - w` — 348 px of window off the edge "
         "for a 420 px frame, which needs a negative client coordinate. The keyboard route reaches "
         "it with real trusted keys, which is why every gesture in src/wm/window.mjs has a "
         "keyboard spelling.\n"
         "WHAT THIS MILESTONE CHANGED IN THE PRODUCT: the desktop changing size re-clamped "
         "nothing. `Win.apply` clamps against the desktop's CURRENT rect, so the clamp was correct "
         "at every gesture and stale at every resize — frames left outside a shrunken desktop with "
         "their captions out of reach, and a kernel still accounting the boxes they used to have. "
         "`WinHost.relayout` and a ResizeObserver are M13's own addition, and "
         "`--negative no-relayout` is the world without them.\n"
         "negative controls: --negative no-clamp removes the clamp, so a frame can be dragged out "
         "of reach and the MIN_W/MIN_H floor goes with it, since `clampBox` is where that floor "
         "lives. --negative stale-geom reports the box that was ASKED for, so the kernel's record "
         "becomes a geometry no frame ever had while the cell grid beside it stays true. "
         "--negative no-relayout leaves the resize unhandled. --negative no-isolation must come "
         "out BROKEN: no SAB, no kernel, no windows, no geometry.",
)
def check_m13(env: Env) -> None:
    # EVERY GESTURE THE PAGE ASKS FOR, PERFORMED, before anything is read: the page blocks on its
    # first ask, so a check that read the state first would read a page that had not started.
    performed = drive_gestures(env, "M13", timeout=280.0)

    got = env.read(READ_M13, M13_SHAPE)

    if got["state"] == "error":
        env.unmeasurable(
            "www/m13.html reported state 'error' before producing proofs: %s. Nothing below was "
            "measured." % (got["why"] or "no reason given"))
    if got["state"] == "aborted":
        env.unmeasurable(
            "www/m13.html aborted: %s. Without cross-origin isolation the kernel's SAB is not "
            "constructible, so no process runs, no window is framed and there is no geometry to "
            "measure." % (got["why"] or "no reason given"))
    if got["state"] != "done":
        env.unmeasurable("www/m13.html never reached a terminal state (state=%r)" % got["state"])

    env.expect("page isolated", got["isolated"], True)
    env.expect("kernel isolated", got["kernelIsolated"], True)
    env.expect_that("the kernel raised no error", not got["errors"],
                    "kernel errors: %s" % "; ".join(got["errors"][:4]))
    # THE DRIVING ITSELF IS ASSERTED. A page that finished without asking for a gesture would have
    # measured a desktop nobody touched, and every clause below would still produce numbers - which
    # is M12's "a function nobody ran had changed nothing" in a second place.
    env.expect_that("the page was really driven",
                    performed >= 8 and got["gestures"] == performed,
                    {"performed": performed, "pageLogged": got["gestures"]})
    # AND THE WORLD IS ASSERTED TO BE THE ONE ASKED FOR, read back out of the modules that own the
    # switches: a control a run believed was on and was not is a green run over an unmodified world.
    cfg = got["cfg"] or {}
    live = got["controls"] or {}
    env.expect_that("the controls the page reports are the ones asked for",
                    bool(live) and live.get("noClamp") is bool(cfg.get("noClamp"))
                    and live.get("staleGeom") is bool(cfg.get("staleGeom"))
                    and live.get("noRelayout") is bool(cfg.get("noRelayout")),
                    {"asked": cfg, "inForce": live})

    def ev(name):
        return (got[name] or {}).get("evidence") or {}

    def section_ok(name):
        row = got[name]
        return bool(row and row.get("ok"))

    # ---- PROOF 1: the clamp ------------------------------------------------------------------
    c = ev("clamp")
    states = c.get("states") or {}
    env.expect_that("clamp ok", section_ok("clamp"), c)
    env.expect_that("dragged past the bottom-right corner, the frame stops at the clamp",
                    c.get("bottomRightHeld") is True,
                    {"state": states.get("bottomRight"), "desk": c.get("desk"),
                     "minVisible": c.get("minVisible")})
    env.expect_that("dragged above the top, the frame stops at y = 0",
                    c.get("topHeld") is True, {"state": states.get("top")})
    env.expect_that("arrow-keyed off the left edge, the frame stops at MIN_VISIBLE - w",
                    c.get("leftHeld") is True, {"state": states.get("left")})
    # THE CLAUSE A READER WOULD NOTICE, and the only one that is about the product rather than
    # about an arithmetic: in every clamped state there is still a strip of caption to grab.
    env.expect_that(
        "and in every clamped state a grabbable strip of caption is still over the desktop",
        c.get("stillGrabbable") is True,
        {"overlaps": {k: (v or {}).get("overlap") for k, v in states.items()},
         "minVisible": c.get("minVisible")})

    # ---- PROOF 2: the gesture ----------------------------------------------------------------
    g = ev("gesture")
    env.expect_that("gesture ok", section_ok("gesture"), g)
    env.expect_that("an unclamped drag moves the frame by exactly the pointer delta",
                    g.get("exactHeld") is True, g.get("exact"))
    # THE TWO-BOX DESIGN. Without it a clamped window jumps out from under the pointer on the next
    # press, by exactly the amount the clamp had absorbed.
    env.expect_that("a drag after a clamped one starts from where the frame IS",
                    g.get("noJumpHeld") is True, g.get("noJump"))
    # BOTH ENDS OF THE STEP, which is constraint 39's rule applied to a discrete input: a check
    # that only pressed the coarse arrow would pass against a Shift that did nothing.
    env.expect_that("one arrow press is KEY_STEP px and a Shift arrow is one px",
                    g.get("stepHeld") is True, g.get("step"))

    # ---- PROOF 3: the kernel's record --------------------------------------------------------
    r = ev("record")
    env.expect_that("record ok", section_ok("record"), r)
    # THE FIXTURE IS PART OF THE CLAUSE. With every window inside the desktop, `box` and `placed`
    # hold the same numbers — so a host reporting the REQUESTED box reports an identical number and
    # `--negative stale-geom` came out GREEN against the one check that is about this. Measured, by
    # running it. The page now asks one window for a box far outside the desktop and asserts the
    # clamp really absorbed something.
    env.expect_that("the kernel's box is the box the clamp settled on, for every live window",
                    r.get("boxesAgree") is True,
                    {"mismatched": r.get("boxMismatch"), "windows": r.get("windows"),
                     "fixtureIsClamped": r.get("fixtureIsClamped")})
    env.expect_that("the cell grid the kernel holds is what the rendered client area divides into",
                    r.get("cellsAgree") is True,
                    {"mismatched": r.get("cellMismatch"), "cell": r.get("cell")})
    env.expect_that("and the cell was measured off a rendered glyph, not assumed",
                    r.get("cellMeasured") is True, {"cell": r.get("cell")})

    # ---- PROOF 4: the ring and the chrome ----------------------------------------------------
    ring = ev("ring")
    env.expect_that("ring ok", section_ok("ring"), ring)
    env.expect_that("the four glass strips do not overlap", ring.get("disjoint") is True,
                    {"overlaps": ring.get("overlaps"), "strips": ring.get("strips")})
    # THE CLAUSE M12 RESTS ON, FROM THE OTHER SIDE: its accounting calls `blurRingArea`, and this is
    # where that formula is compared against what the browser actually laid out.
    env.expect_that("and their rendered areas sum to the ABI's ring formula",
                    ring.get("sumsToFormula") is True,
                    {"measured": ring.get("measuredRingCssPx"),
                     "formula": ring.get("formulaRingCssPx"), "placed": ring.get("placed")})
    env.expect_that("the client area is inset by exactly the chrome the ABI declares",
                    ring.get("insetExact") is True,
                    {"inset": ring.get("inset"), "chrome": ring.get("chrome")})
    env.expect_that("the caption buttons sit inside the caption and clear of the title",
                    ring.get("buttonsPlaced") is True, {"buttons": ring.get("buttons")})

    # ---- PROOF 5: the stack a reader can touch -----------------------------------------------
    s = ev("stack")
    env.expect_that("stack ok", section_ok("stack"), s)
    env.expect_that(
        "a real click on a buried window's sliver raises it to the top of the kernel's stack",
        s.get("cameUp") is True,
        {"clickedAt": s.get("at"), "before": s.get("stackBefore"), "after": s.get("stackAfter"),
         "low": s.get("low"), "high": s.get("high")})
    env.expect_that("and the window under that same point afterwards is the one that came up",
                    s.get("readerSeesIt") is True,
                    {"underBefore": s.get("underBefore"), "underAfter": s.get("underAfter"),
                     "zIndex": s.get("zIndex")})
    env.expect_that("no two live frames share a z-index", s.get("zUnique") is True,
                    {"zIndex": s.get("zIndex")})

    # ---- PROOF 6: the desktop changing size --------------------------------------------------
    rl = ev("relayout")
    env.expect_that("relayout ok", section_ok("relayout"), rl)
    env.expect_that("a desktop that shrinks pulls every frame back inside it",
                    rl.get("pulledInside") is True,
                    {"desk": rl.get("shrunkDesk"), "frames": rl.get("shrunk"),
                     "relayouts": [rl.get("relayoutsBefore"), rl.get("relayoutsAfter")],
                     "skipped": rl.get("skipped"), "waitedMs": rl.get("shrankMs")})
    env.expect_that("and the kernel is told the box each frame settled on",
                    rl.get("kernelToldOfIt") is True,
                    {"frames": rl.get("shrunk"), "geoms": [rl.get("geomsBefore"),
                                                           rl.get("geomsAfter")]})
    env.expect_that("a desktop that grows back returns each window to the box it asked for",
                    rl.get("cameBack") is True,
                    {"restored": rl.get("restored"), "waitedMs": rl.get("grewMs")})

    # ---- PROOF 7: the floor ------------------------------------------------------------------
    lim = ev("limits")
    env.expect_that("limits ok", section_ok("limits"), lim)
    env.expect_that("a box under the minimum is floored on screen",
                    lim.get("flooredOnScreen") is True,
                    {"asked": lim.get("asked"), "floor": lim.get("floor"),
                     "placed": lim.get("placed"), "rendered": lim.get("rendered")})
    env.expect_that("and the kernel records the floor rather than the request",
                    lim.get("kernelRecordsTheFloor") is True,
                    {"kernel": lim.get("kernel"), "floor": lim.get("floor")})

    env.expect("verdict is ok", got["verdict"], "ok")
    # AN ARTIFACT AND NOT AN ASSERTION: nothing here is read out of the PNG, because an inert frame
    # and a working one are the same picture. It is for a human reading a failure.
    env.shoot("m13-geometry")

    served = env.request(env.document)
    env.expect("document COOP", served.headers.get("Cross-Origin-Opener-Policy"), "same-origin")
    env.expect("document COEP", served.headers.get("Cross-Origin-Embedder-Policy"), "require-corp")
    env.expect_that("served m13.html", env.served_matches_disk(env.document),
                    "the m13.html served does not match www/m13.html on disk")


_STATUS_PROBE = Check(name="status-probe", func=lambda env: None, milestone="-", controls=(),
                      labels=("-",), min_expectations=1,
                      requires_isolation=False, no_invert_reason="",
                      note="", control_address="", root=Root.WWW, document="/",
                      invert_query=(),
                      ready_expr="true", ready_what="-", ready_timeout=1.0,
                      refusal_expr="", refusal_want="")


def _gate_reporting_path(run: PhaseRun, report: Report) -> int:
    """Gate I5: a FAIL must reach a non-zero exit code.

    Nothing calls Report.finish in --prove-failure mode, so the failure-to-exit-code mapping -
    the one path the mode exists to exercise - is never run by it.

    Asked of a CONSTRUCTED tally, not only of the phase that ran. The invert phase produces no
    FAIL at all: gates I3 and I4 return before this one if it does, so `counts[Outcome.FAIL]`
    is never on the measured path and deleting it from status()'s sum left a red suite exiting 0
    in normal mode while --prove-failure still printed I5 holding, on the strength of
    counts[Outcome.INVERTED] alone. A one-FAIL tally is the honest instrument because FAIL is the
    outcome a normal run reports and the inverted phase structurally cannot: I5 is a claim about
    status(), so status() is what it has to interrogate. The phase's own tally is checked too -
    an inversion that could not reach the exit code is just as dead.
    """
    asked = [
        ("this phase", status(run.results, run.witness_failures,
                              report.console_failures(run.results))),
        ("a tally of one FAIL and nothing else",
         status([Result(check=_STATUS_PROBE, outcome=Outcome.FAIL, count=1)], [], [])),
    ]
    for label, (code, message) in asked:
        if code == 0:
            print("  gate I5: the reporting path maps %s to exit 0 (%s). A failure cannot reach "
                  "the exit code." % (label, message))
            return 4
        # Printed on success too: a gate that is silent when it holds is a gate nobody can see run.
        print("  gate I5: the reporting path maps %s to exit %d (%s), so these failures would "
              "reach the exit code." % (label, code, message))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
