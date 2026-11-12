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
| COOP/COEP absent, or a value isolating nothing      | serve() compares VALUES to ISOLATION_HEADERS       | 3   |
| a --no-isolation server that still sends them       | the same assertion, inverted (gate N2)             | 3   |
| no Chrome                                           | CDPError from cdp.find_chrome/_await_port          | 3   |
| a half-built DOM read at load-event time            | Env.settle on a readiness predicate; no sleep      | 3   |
| a navigate that was a no-op                         | Env.reload epoch stamp read back as None           | 3   |
| a check precondition that never held                | Unmeasurable -> BROKEN, never PASS, never SKIP     | 3   |
| a check body raising anything else                  | run_one catches Exception -> BROKEN, run continues | 3   |
| a check that asserted nothing                       | min_expectations, and PASS with count 0 -> BROKEN  | 3   |
| min_expectations lowered to match deleted asserts   | the committed floor in scripts/check_floors.json   | 3   |
| an in-page table that did not run                   | boot's row-name set asserted before any row value  | 1   |
| console errors nobody looked at                     | per-check drain of all three CDP error events      | 1   |
| a check written and never registered                | registry.audit rules 1, 2 and 7                    | 3   |
| a check nothing can invert                          | INVERT is mandatory; the opt-out needs a reason    | 3   |
| a control declared and never expected to fire       | audit ties Check.controls to CONTROLS[..].expects  | 3   |
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
def serve(root, *, canonical=None, port: int = 0, isolate: bool = True) -> Iterator[Serving]:
    """A ThreadingHTTPServer on a daemon thread, in this process, on an OS-chosen port.

    No subprocess, so nothing parses a child's stdout and port 0 is readable from
    server_address. Asserts its own isolation mode and its own document on the wire before
    yielding: a control that cannot fire is worse than no control.
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
        _assert_serving(serving)
        yield serving
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=10)


def _assert_serving(serving: Serving) -> None:
    """The gate that runs before Chrome exists: mode on the wire, document against disk."""
    try:
        with _harness_get(serving.base + "/") as response:
            body = response.read()
            wire = {k.lower(): v for k, v in response.headers.items()}
    except urllib.error.HTTPError as error:
        raise ServeError("GET %s/ returned %s, so there is no document to check"
                         % (serving.base, error.code), reason=Gate.HTTP_STATUS) from error
    except (urllib.error.URLError, OSError) as error:
        raise ServeError("GET %s/ failed, so nothing is listening where this run is about to "
                         "point Chrome: %s" % (serving.base, error),
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

    index = _mapped(serving.root, "/")
    if not index.is_file():
        raise ServeError(
            "GET %s/ returned %d bytes but %s does not exist. An empty or wrong root answers "
            "200 with a directory listing, so the status proves nothing. Nothing was measured."
            % (serving.base, len(body), index), reason=Gate.NO_DOCUMENT)
    if body != index.read_bytes():
        raise ServeError(
            "GET %s/ does not match %s byte for byte, so this run would be measuring a tree "
            "other than the one it was pointed at." % (serving.base, index),
            reason=Gate.NOT_THIS_TREE)


# ======================================================================================
# Registry (§3)
# ======================================================================================


class Control:
    INVERT = "invert"
    NO_ISOLATION = "no-isolation"
    EMPTY_ROOT = "empty-root"
    PATCHED = "patched"
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
    min_expectations: int
    requires_isolation: bool
    #: Non-empty only for a check that genuinely cannot be inverted. Audited, and printed by
    #: gate_invert, because a silent exemption is how a milestone disarms the mode.
    no_invert_reason: str
    note: str
    control_address: str


#: Every check lives in this file. The design's scripts/checks/<name>.py layout is NOT in use:
#: nothing here imports it, so a module in that directory would contribute no checks and the run
#: would report clean (audit rule 1 refuses the directory outright). Split the subjects into
#: modules when there is a second one, and add the import machinery in the same change.
_REGISTRY: List[Check] = []


def check(*, name: str, milestone: str, controls: Tuple[str, ...], min_expectations: int,
          requires_isolation: bool = True, no_invert_reason: str = "", note: str = "",
          control_address: str = ""):
    def decorate(func: Callable[["Env"], None]) -> Callable[["Env"], None]:
        _REGISTRY.append(Check(
            name=name,
            func=func,
            milestone=milestone,
            controls=tuple(controls),
            min_expectations=min_expectations,
            requires_isolation=requires_isolation,
            no_invert_reason=no_invert_reason,
            note=note,
            control_address=control_address,
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


def _expect_problems(run: str, name: str, expect: "Expect") -> List[str]:
    """Audit rule 10: a negative control's declaration has to be scorable and specific."""
    where = "CONTROLS[%r].expects[%r]" % (run, name)
    out: List[str] = []
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

    # 6. The same two pins read the other way, so a rename or a deletion cannot leave either
    #    file pointing at a check that no longer exists.
    names = {candidate.name for candidate in checks}
    for run in sorted(CONTROLS):
        tags = sorted(tag for tag, runs in CONTROL_RUNS.items() if run in runs)
        # 10. The declaration itself. An Expect that declares no failing label is the defect B2
        #     names: `--negative patched-required` scored on Outcome.FAIL alone was satisfied by
        #     any failure of the check, including one that left the page's verdict green.
        for name, expect in sorted(CONTROLS[run].expects.items()):
            problems.extend(_expect_problems(run, name, expect))
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
                 inverted: bool, epochs: Iterator[int], artifact_prefix: str = "") -> None:
        self.page = page
        self.base = serving.base
        self.serving = serving
        self.out = out
        self.artifact_prefix = artifact_prefix
        self.ready_wait_s = 0.0
        self.check = check_name
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

        Once there is a kernel this reset becomes a kernel reboot plus an OPFS wipe. Re-measure
        the cost at M2 and record the decision there rather than discovering it at M5.
        """
        self.page.evaluate("window.__epoch = %d" % next(self._epochs))
        self.page.navigate(self.base + "/")
        # Session.evaluate returns (result.get("result") or {}).get("value") (cdp.py:167), so an
        # undefined window.__epoch reads None and a navigate that did nothing is caught here.
        if self.page.evaluate("window.__epoch") is not None:
            raise Unmeasurable(
                "the reload was a no-op: window.__epoch survived, so this check would have "
                "measured the previous check's document")
        self.ready_wait_s = self._settle_ready()

    def _settle_ready(self) -> float:
        start = time.monotonic()
        self.settle(
            "'preflight' in document.documentElement.dataset",
            timeout=15.0,
            what="preflight flag (document.documentElement.dataset.preflight, "
                 "www/index.html:129)")
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
#: www/index.html:53. The only non-required row (www/index.html:63) - Aero is cosmetic and the
#: kernel does not care. A check that cannot tell this from a required row is not checking the
#: required/optional split, it is checking that ten rows read 'present'.
_BACKDROP_PROBE = "() => CSS.supports('backdrop-filter', 'blur(9px)')"

#: The four required rows COOP/COEP removal turns red, measured on Chrome 157 and recorded the
#: same way in MILESTONES.md:54-57. NOT `OPFS sync handle`: a sync access handle does not need
#: cross-origin isolation, so a control that expected all ten rows red would be wrong about the
#: platform and would start passing for the wrong reason the day that changed.
_ISOLATION_ROWS = ("crossOriginIsolated", "SharedArrayBuffer", "worker is isolated",
                   "worker can block")

CONTROLS: Dict[str, NegativeControl] = {
    "no-isolation": NegativeControl(
        name="no-isolation",
        why="serve(isolate=False): no COOP/COEP, so no SharedArrayBuffer",
        serve_kwargs={"isolate": False},
        fixture=None,
        expects={"boot": Expect(
            Outcome.FAIL,
            failed=tuple("%s state" % row for row in _ISOLATION_ROWS)
                   + ("verdict flag", "verdict class", "verdict text",
                      "live crossOriginIsolated", "live SharedArrayBuffer",
                      "document COOP", "document COEP"),
            held=("row names", "OPFS state", "OPFS sync handle state", "backdrop-filter state",
                  "crossOriginIsolated cell", "state colours distinguish states",
                  "served index.html"),
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
            failed=("OPFS state", "verdict flag", "verdict class", "verdict text"),
            held=("row names", "OPFS cell", "state colours distinguish states",
                  "live SharedArrayBuffer", "served index.html"),
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
            held=("backdrop-filter state", "backdrop-filter cell", "verdict flag",
                  "state colours distinguish states"),
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

#: The page's rows, in the page's order, with whether the page treats each as fatal. Rows 1-7
#: are the synchronous probes (www/index.html:40-55); rows 8-10 are the three the page can only
#: get from a worker, because createSyncAccessHandle exists nowhere else (www/index.html:73-74,
#: :101-108). backdrop-filter is the only non-required row (www/index.html:63).
#:
#: This tuple is the harness's own expectation and is deliberately NOT read back from the page.
#: An expectation derived from the subject is one the subject cannot fail. The cost is real and
#: points the right way: editing www/index.html fails check_boot until this tuple is edited
#: too. When the drift message fires, decide which side is right. Do not delete the assertion.
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
    # 1 row-name set + 10 row states + 10 cell coherence + 1 painted-colour injectivity
    # + 1 verdict flag + 1 verdict class + 1 verdict text + 2 live re-probes + 2 response headers
    # + 1 served-bytes witness = 30.
    # Every term is fixed by PREFLIGHT_ROWS, not by what the page rendered, so a page that
    # renders no rows still records 30 - 21 of them failing - rather than passing on an empty
    # table. Correct this declaration to the arithmetic if the arithmetic changes; the floor in
    # scripts/check_floors.json is what stops it being lowered to whatever the run produced.
    min_expectations=30,
    requires_isolation=True,
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
    root: pathlib.Path
    #: What the served bytes are compared against. The repository's own www/ for every phase
    #: that serves a real tree; the fixture's root where a fixture built a deliberately
    #: different one and verified its own patch.
    canonical: pathlib.Path
    isolated: bool
    checks: Tuple[Check, ...]
    #: Selected, and not run by this phase. Carried so the report can say so with a reason
    #: instead of leaving a gap for the reader to infer.
    filtered: Tuple[Tuple[Check, str], ...]
    inverted: bool
    label: str


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
        elif env.failures:
            outcome = Outcome.FAIL
        elif unclaimed:
            outcome = Outcome.FAIL
        elif inverted:
            outcome = Outcome.INVERTED
    return Result(check=candidate, outcome=outcome, count=env.count, seconds=seconds,
                  failures=tuple(env.failures), inverted_fired=tuple(env.inverted_fired),
                  reason=reason, artifacts=tuple(env.artifacts), console=tuple(unclaimed),
                  labels=tuple(env.labels), failed_labels=tuple(env.failed_labels))


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
        return [Phase(mode=MODE_NEGATIVE, root=fixture_root,
                      # A fixture tree is meant to differ from www/, and _patch_probe verifies
                      # its own single replacement, so the pin there is the fixture, not www/.
                      canonical=fixture_root if control.fixture else CANONICAL,
                      isolated=isolated, checks=selected, filtered=(), inverted=False,
                      label="negative %s (%s)" % (control.name, control.why))], None

    out: List[Phase] = []
    if args.prove_failure in (MODE_INVERT, "both"):
        if not [c for c in selected if Control.INVERT in c.controls]:
            print("check.py: the selection contains 0 invertible checks. Narrowing the run "
                  "cannot quietly disarm it.", file=sys.stderr)
            return [], 4
        out.append(Phase(mode=MODE_INVERT, root=root, canonical=CANONICAL, isolated=True,
                         checks=selected, filtered=(), inverted=True,
                         label="--prove-failure invert"))
    if args.prove_failure in (MODE_NO_ISOLATION, "both"):
        sensitive = tuple(c for c in selected if Control.NO_ISOLATION in c.controls)
        if not sensitive:
            print("check.py: the isolation-sensitive selection is empty, so --no-isolation "
                  "would prove nothing.", file=sys.stderr)
            return [], 4
        out.append(Phase(
            mode=MODE_NO_ISOLATION, root=root, canonical=CANONICAL, isolated=False,
            checks=sensitive,
            filtered=tuple((c, "not isolation-sensitive (no %s control), so this phase does not "
                               "run it" % Control.NO_ISOLATION)
                           for c in selected if c not in sensitive),
            inverted=False, label="--prove-failure no-isolation"))
    if not out:
        out.append(Phase(mode=MODE_NORMAL, root=root, canonical=CANONICAL, isolated=True,
                         checks=selected, filtered=(), inverted=False, label="normal"))
    return out, None


class PhaseRun(NamedTuple):
    phase: Phase
    results: List[Result]
    witness_failures: List[str]
    #: Gates N2 and N3 read the wire and the page, never a check's message text: the document
    #: response as the server recorded it, and the page's own verdict flag.
    headers: Dict[str, str]
    verdict: Optional[str]


def run_phase(phase: Phase, report: Report, header: Callable[[str], None]) -> PhaseRun:
    results: List[Result] = []
    headers: Dict[str, str] = {}
    verdict: Optional[str] = None
    with contextlib.ExitStack() as stack:
        serving = stack.enter_context(serve(phase.root, canonical=phase.canonical, port=0,
                                           isolate=phase.isolated))
        # Nesting order is load-bearing: ExitStack unwinds last-in-first-out, so Chrome closes
        # before the server. A page mid-fetch against a dead server logs a console error the
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
        print("  server    %s/  root=%s  %s" % (
            serving.base, _relative(serving.root),
            "ISOLATED (COOP+COEP verified on the wire)" if serving.isolated
            else "NOT ISOLATED (both headers verified absent on the wire)"))
        print("  viewport  %dx%d @ dpr %g, mobile=false, focus emulation on"
              % (VIEWPORT_WIDTH, VIEWPORT_HEIGHT, VIEWPORT_SCALE))
        print("  phase     %s\n" % phase.label)
        sys.stdout.flush()

        epochs = itertools.count(1)
        for candidate in phase.checks:
            inverted = phase.inverted and Control.INVERT in candidate.controls
            env = Env(page=page, serving=serving, out=report.out, check_name=candidate.name,
                      inverted=inverted, epochs=epochs, artifact_prefix=phase.mode)
            result = run_one(candidate, env, inverted=inverted)
            results.append(result)
            report.add(result)
        # Not appended to `results`: a gate scores what this phase measured, and a check it
        # never ran is not a measurement. It still gets its line and its reason.
        for candidate, why in phase.filtered:
            report.add(Result(check=candidate, outcome=Outcome.SKIP,
                              reason="%s: %s" % (candidate.name, why)))
        if phase.mode == MODE_NO_ISOLATION:
            headers = dict(serving.last("/").headers)
            verdict = page.evaluate("document.documentElement.dataset.preflight")
        witness_failures = report.witness(serving, phase.mode)
    return PhaseRun(phase, results, witness_failures, headers, verdict)


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
    # Presence, not value: this control claims to omit the pair, so any value for either name
    # is a leak. The value is printed so the reader sees which.
    leaked = ["%s: %r" % (name, run.headers[name])
              for name, _ in ISOLATION_HEADERS if name in run.headers]
    if leaked:
        print("  gate N2: the document response under --no-isolation still carried %s. The "
              "control did not remove what it claims to." % ", ".join(leaked))
        return 3
    if run.verdict != "fail":
        print("  gate N3: data-preflight reads %r, want 'fail'. Without COOP/COEP the page must "
              "refuse." % run.verdict)
        return 1
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
                    help="the tree to serve. www/ is the server root (serve.py:68) and src/ "
                         "sits outside it; M0 must choose between serving the repository root "
                         "and symlinking into www/, and this default moves with that decision.")
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
    print("name|milestone|controls|invertible|min_expectations|floor")
    recorded = floors()
    for candidate in registered():
        print("%s|%s|%s|%s|%d|%s" % (
            candidate.name, candidate.milestone, runnable_controls(candidate),
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

    cleanup = [p.root for p in plan if p.root != pathlib.Path(args.root).resolve()]
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
                      min_expectations=1, requires_isolation=False, no_invert_reason="",
                      note="", control_address="")


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
