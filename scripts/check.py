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
from serve import ISOLATION_HEADERS, Handler  # noqa: E402

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
ALLOWED_404 = ("/favicon.ico",)


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


def _recording_handler(isolate: bool, log: List[Served], lock: threading.Lock):
    """A per-server Handler subclass.

    Per-server and not Handler itself: Handler.isolate (serve.py:45) is a class attribute and
    os.chdir (serve.py:81) is process-global, so two servers in one process would share both.
    The root arrives through functools.partial(.., directory=..) instead.
    """

    class Recording(Handler):
        pass

    Recording.isolate = isolate

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
def serve(root, *, canonical=None, port: int = 0, isolate: bool = True,
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
        _recording_handler(isolate, log, lock), directory=str(root))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    bound = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    serving = Serving("http://127.0.0.1:%d" % bound, root, canonical, isolate, log, lock)
    try:
        for document in documents:
            _assert_serving(serving, document)
        yield serving
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=10)


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
          control_address: str = "", refusal_expr: str = "", refusal_want: str = ""):
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
        unexpected = [s for s in responses if s.status != 200 and s.path not in ALLOWED_404]
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
                # A note, not a failure. A page that supplies its own favicon, or a Chrome that
                # stops probing for one, is a healthy tree; turning the suite red at exit 1 - the
                # code for "a product expectation failed" - and then printing "see the lines
                # marked FAIL" when there are none is the harness lying about its own subject.
                self.witness_notes.append(
                    "ALLOWED_404 allows %s and nothing requested it during this run, so the "
                    "allowance is dead and can be deleted" % path)
            elif 404 not in statuses:
                # Keyed on the status, not on the request: an allowance for a path that now
                # answers 200 pre-forgives a genuine future 404 on it, and reporting it as
                # "allowed and seen" claims a 404 that did not happen.
                found.append(
                    "ALLOWED_404 allows a 404 on %s but this run recorded %s, so the allowance "
                    "no longer describes anything and would pre-forgive a real 404"
                    % (path, ", ".join(str(s) for s in statuses)))
            elif ("GET %s 404" % path) not in self.console_allowed:
                self.console_allowed.append("GET %s 404" % path)
        distinct = len({s.path for s in responses if s.status == 200})
        self.witness_lines.append(
            "  served    %s%d responses, %d unexpected non-200, %d of %d distinct 200 paths "
            "byte-identical to %s/"
            % (("[%s] " % label) if label else "", len(responses), len(unexpected),
               distinct - len(mismatched), distinct, _relative(serving.canonical)))
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

    def trailer(self) -> None:
        counts = self.tally()
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
    "p99 under the accept bar",
    "document COOP",
    "document COEP",
    "served m0.html",
)

#: The one expectation the kernel-stall control is named for; everything else it must leave
#: standing is derived. Named here because the control is scored on WHICH expectation fails: a
#: 2 ms stall that turned the check red by breaking the accounting identity, or by starving the
#: kernel until no cell was produced at all, would satisfy a control scored on Outcome.FAIL alone
#: while proving nothing about latency. Measured on this machine under the control (probe.py
#: --n 16 --window-ms 2600 --warmup 100 --stall-us 2000 --force-not-equal): p99 29,673.6 us
#: against the 500 us bar, 1,296 samples past the 1,000 the withholding rule needs, identity
#: 2967/2967/2967/2967, depth_p50 15 of 16, every anti-vacuity clause still ok, and 1 of 3 forced
#: not-equals.
_STALL_FAILS = ("p99 under the accept bar",)
_STALL_HOLDS = held_rest(SYSCALL_LABELS, _STALL_FAILS)

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


def accept_bar_us() -> float:
    """The accept bar, read from the file the bench reads it from. NOT restated here: 500 us
    written twice is two numbers to keep in step, and the one in bars.json is the one the sweep's
    verdict was taken against."""
    try:
        data = json.loads(BARS_JSON.read_text(encoding="utf-8"))
        return float(data["accept_p99_us"])
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise Unmeasurable(
            "the accept bar cannot be read from %s, so there is no bar to compare a p99 against: "
            "%s" % (_relative(BARS_JSON), error))


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
    bar_us = accept_bar_us()
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
    env.expect("page and harness read the same accept bar", got["acceptBarUs"], bar_us)
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
    env.expect_that(
        "p99 under the accept bar",
        cell["p99Us"] is not None and cell["p99Us"] < bar_us,
        "p99 %s against the %g us accept bar in %s. This is N=%s over %s calls in a 400 ms "
        "window, which is the bar's own N but not the decision figure - that one is p99 at N=16 "
        "over a 3 s window, three runs, one fresh browser per cell, and it is ACCEPT"
        % (cell["p99Text"], bar_us, _relative(BARS_JSON), cell["n"], cell["count"]))

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


def phase_document(candidate: Check, query: Tuple[Tuple[str, str], ...]) -> str:
    """The request path a check's page is loaded from, with a control's parameters merged in.

    One definition, because serve() asserts this exact path on the wire before Chrome starts,
    Env.reload navigates it, and the check reads its own response headers back by it. Three
    copies of a query string is three chances for the assertion to be about a different URL
    than the one the browser fetched.
    """
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
                      isolated=isolated, checks=scored,
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
                         isolated=True, checks=selected, filtered=(), inverted=True,
                         label="--prove-failure invert"))
    if args.prove_failure in (MODE_NO_ISOLATION, "both"):
        sensitive = tuple(c for c in selected if Control.NO_ISOLATION in c.controls)
        if not sensitive:
            print("check.py: the isolation-sensitive selection is empty, so --no-isolation "
                  "would prove nothing.", file=sys.stderr)
            return [], 4
        out.append(Phase(
            mode=MODE_NO_ISOLATION,
            roots=phase_roots(sensitive, www=root, www_canonical=CANONICAL),
            isolated=False, checks=sensitive,
            filtered=tuple((c, "not isolation-sensitive (no %s control), so this phase does not "
                               "run it" % Control.NO_ISOLATION)
                           for c in selected if c not in sensitive),
            inverted=False, label="--prove-failure no-isolation"))
    if not out:
        out.append(Phase(mode=MODE_NORMAL,
                         roots=phase_roots(selected, www=root, www_canonical=CANONICAL),
                         isolated=True, checks=selected, filtered=(), inverted=False,
                         label="normal"))
    return out, None


class PhaseRun(NamedTuple):
    phase: Phase
    results: List[Result]
    witness_failures: List[str]


def run_phase(phase: Phase, report: Report, header: Callable[[str], None]) -> PhaseRun:
    results: List[Result] = []
    documents = dict((c.name, phase_document(c, phase.query)) for c in phase.checks)
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
              % (r.check.name, phase_document(r.check, run.phase.query), name,
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
_STATUS_PROBE = Check(name="status-probe", func=lambda env: None, milestone="-", controls=(),
                      labels=("-",), min_expectations=1,
                      requires_isolation=False, no_invert_reason="",
                      note="", control_address="", root=Root.WWW, document="/",
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
