#!/usr/bin/env python3
"""M19a: what does copying the read-only base into the writable volume COST, on real OPFS?

`bench/m19a-seed/probe.mjs` answers the GATE question under Node — which expression tells a fresh
volume from a populated one and from one that failed to mount — because three of those six worlds
cannot be built in a browser without breaking something. This script answers the two that need a
real volume:

  THE COST    constraint 22 prices `createSyncAccessHandle` at 495 us, 100x a syscall, so a seed
              pays one per file. 39 files is `USR_ENTRIES.length`, not a figure chosen here. The
              per-file OPEN time is printed beside the total, because that is the term that scales
              and the mean hides a single slow open.
  THE STATES  boot 1 meets an empty OPFS (`scripts/cdp.py` hands every run a fresh
              `--user-data-dir`), writes the copy, and boots again. Boot 2 must report `rw` and
              NOT `fresh`, the copy must still be there, and a second copy must REFUSE with
              EEXIST. The refusal is what makes an ungated seed a visible failure rather than the
              silent data loss constraint 28 names.

IT ABORTS WITHOUT A FIGURE unless `crossOriginIsolated` is true. The kernel's SharedArrayBuffer is
not constructible otherwise, so there is no volume to mount and nothing to time; `--no-isolation`
runs that path to prove the abort is taken.

    bench/m19a-seed/probe.py                    the figures
    bench/m19a-seed/probe.py --headed           ...in a window
    bench/m19a-seed/probe.py --no-isolation     the page must refuse rather than report a number
    bench/m19a-seed/probe.py --prove-failure    the UNGATED world: a second copy under another
                                                name succeeds, so the volume holds the base twice
    bench/m19a-seed/probe.py --serve-only       the page in your own browser
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
  const M = globalThis.M19A || {}
  return {
    state: String(M.state || ''), why: String(M.why || ''),
    isolated: M.isolated === true,
    phases: M.phases || {},
    errors: (M.errors || []).map(String),
    faults: (M.faults || []).map((f) => String(f.pid) + ': ' + String(f.why)),
    notes: (M.notes || []).map(String),
    bootRetries: Number(M.bootRetries || 0),
  }
})()"""

READY = ("(() => { const s = globalThis.M19A && globalThis.M19A.state; "
         "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")


class Serving:
    """serve.py's Handler on an ephemeral port, rooted at the repository.

    The page imports `/www/pagekernel.mjs` and `/bench/m19a-seed/program.mjs`, and the kernel
    worker is `/src/kernel/kernel.mjs`, so one server at the root is the only root that works.
    """

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
    t0 = time.monotonic()
    polls = 0
    while time.monotonic() - t0 < timeout:
        state = page.evaluate(READY)
        polls += 1
        if state:
            return state, time.monotonic() - t0, polls
        time.sleep(poll)
    return "", time.monotonic() - t0, polls


def ms(value) -> str:
    return "-" if value is None else f"{float(value):.2f} ms"


def report(got: dict, *, ungated: bool) -> int:
    """Print the table, then score the clauses. Returns the exit code."""
    p = got["phases"]
    rows: list[tuple[str, bool, str]] = []

    def clause(name: str, ok: bool, detail) -> None:
        rows.append((name, bool(ok), json.dumps(detail)[:400]))

    boot1 = p.get("boot1") or {}
    boot2 = p.get("boot2") or {}
    walk = p.get("walk") or {}
    copy = p.get("copy") or {}
    nofsync = p.get("nofsync") or {}
    verify = p.get("verify") or {}
    reverify = p.get("verifyAfterReboot") or {}
    second = p.get("secondCopy") or {}

    print("  THE TWO VOLUME STATES, on real OPFS")
    print(f"    boot 1   mountable {boot1.get('mountable')!r:10} mode {boot1.get('mode')!r:6} "
          f"readOnly {boot1.get('readOnly')}")
    print(f"    boot 2   mountable {boot2.get('mountable')!r:10} mode {boot2.get('mode')!r:6} "
          f"readOnly {boot2.get('readOnly')}")

    print("  THE BASE, counted through readdir from inside a process")
    print(f"    {walk.get('files')} files, {walk.get('dirs')} directories, "
          f"{walk.get('bytes')} bytes; largest {walk.get('largest')}")
    print(f"    reading all of it from the PROVIDER mount: {ms(walk.get('readMs'))} total, "
          f"{ms(walk.get('perFileReadMs'))} per file (no OPFS in this path)")

    print("  THE COPY, phase by phase")
    ph = copy.get("phases") or {}
    print(f"    total {ms(copy.get('totalMs'))} for {copy.get('files')} files "
          f"({copy.get('bytes')} bytes in {copy.get('chunks')} write chunks)")
    print(f"      mkdir   {ms(ph.get('mkdirMs'))}   ({copy.get('dirs')} directories)")
    print(f"      src read{ms(ph.get('srcReadMs'))}")
    print(f"      open    {ms(ph.get('openMs'))}")
    print(f"      write   {ms(ph.get('writeMs'))}")
    first = copy.get("firstWrite") or {}
    print(f"        of which the FIRST write of each file: {ms(ph.get('firstWriteMs'))} over "
          f"{first.get('n')} file(s) — mean {ms(first.get('meanMs'))}, median "
          f"{ms(first.get('medianMs'))}, max {ms(first.get('maxMs'))}")
    print(f"        every later chunk:                     {ms(ph.get('restWriteMs'))} over "
          f"{(copy.get('chunks') or 0) - (first.get('n') or 0)} chunk(s)")
    print(f"      fsync   {ms(ph.get('fsyncMs'))}")
    print(f"      close   {ms(ph.get('closeMs'))}")
    opens = copy.get("open") or {}
    print(f"    PER-FILE OPEN: mean {ms(opens.get('meanMs'))}, median "
          f"{ms(opens.get('medianMs'))}, max {ms(opens.get('maxMs'))}  "
          f"(constraint 22 says 495 us)")
    print(f"    per file, all phases: {ms(copy.get('perFileMs'))}")
    print(f"    the same copy WITHOUT a per-file fsync: {ms(nofsync.get('totalMs'))} "
          f"(fsync was {ms(ph.get('fsyncMs'))} of the {ms(copy.get('totalMs'))} above)")

    print("  THE COPY IS RIGHT, AND IT SURVIVES A REBOOT")
    print(f"    verify now:          {verify.get('compared')}/{verify.get('files')} files "
          f"byte-identical, {verify.get('bytes')} bytes, wrong {verify.get('wrong')}")
    print(f"    verify after reboot: {reverify.get('compared')}/{reverify.get('files')} files, "
          f"wrong {reverify.get('wrong')}")
    print(f"    a SECOND copy over it: ok={second.get('ok')} "
          f"errno {second.get('errnoName')} at {second.get('at')!r}, "
          f"{second.get('written')} file(s) written before it refused")
    order = walk.get("order") or []
    print(f"    (readdir's order starts {order[:3]}, so that refusal is the FIRST file)")

    clause("boot 1 of a run meets a FRESH volume", boot1.get("mountable") == "fresh"
           and boot1.get("mode") == "rw", boot1)
    clause("boot 2 of the same OPFS reports rw and NOT fresh",
           boot2.get("mountable") == "rw" and boot2.get("mode") == "rw", boot2)
    clause("the walk found every row in USR_ENTRIES", walk.get("files") == 39, walk.get("files"))
    clause("the copy wrote every file", copy.get("ok") is True
           and copy.get("files") == walk.get("files"), {"ok": copy.get("ok"),
                                                        "why": copy.get("why")})
    clause("every copied byte matches the base",
           verify.get("ok") is True and verify.get("compared") == verify.get("files"), verify)
    clause("the copy is still byte-identical after a kernel reboot",
           reverify.get("ok") is True and reverify.get("compared") == reverify.get("files"),
           reverify)
    # THE LOAD-BEARING ONE. The errno is asserted BY NAME, not as "it refused": a refusal for the
    # wrong reason passes for a volume that refused because it was read-only. By name and not by
    # number because this ABI is not Linux's — EEXIST is 20 here, and the first draft of this
    # clause asserted 17 and failed over a correct refusal.
    clause("a SECOND copy over the seeded tree refuses with EEXIST",
           second.get("ok") is False and second.get("errnoName") == "EEXIST",
           {k: second.get(k) for k in ("ok", "errnoName", "why", "at", "written")})
    # The refusal must land on the FIRST file, or an ungated seed has already overwritten some of
    # the reader's tree by the time anything says no.
    clause("...on the first file, having written nothing",
           second.get("written") == 0 and second.get("at") == (walk.get("order") or [None])[0],
           {"at": second.get("at"), "first": (walk.get("order") or [None])[0],
            "written": second.get("written")})

    if ungated:
        again = p.get("ungated") or {}
        print("  THE UNGATED WORLD")
        print(f"    a second copy under another name: ok={again.get('ok')} "
              f"{again.get('files')} files, {again.get('bytes')} bytes, "
              f"{ms(again.get('totalMs'))}")
        clause("an UNGATED seed writes the base a second time and nothing refuses",
               again.get("ok") is True and again.get("files") == walk.get("files"), again)

    print("  CLAUSES")
    failed = 0
    for name, ok, detail in rows:
        print(f"    {'ok  ' if ok else 'FAIL'} {name}")
        if not ok:
            failed += 1
            print(f"         {detail}")
    print(f"  {len(rows) - failed}/{len(rows)} clauses")

    for fault in got["faults"]:
        print(f"  FAULT {fault}", file=sys.stderr)
    for error in got["errors"][:10]:
        print(f"  page error: {error}", file=sys.stderr)
    for note in got["notes"][:10]:
        print(f"  note: {note}", file=sys.stderr)

    if ungated:
        # The control's claim is that the second copy LANDED. Its exit code is 0 when that is what
        # happened, because the proof succeeded (CLAUDE.md's `--prove-failure` convention).
        again = p.get("ungated") or {}
        return 0 if again.get("ok") is True else 1
    return 0 if failed == 0 else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--timeout", type=float, default=300.0)
    ap.add_argument("--poll", type=float, default=0.25)
    ap.add_argument("--headed", action="store_true", help="a real window, not headless")
    ap.add_argument("--no-isolation", action="store_true",
                    help="serve without COOP/COEP, to prove the page refuses")
    ap.add_argument("--prove-failure", action="store_true",
                    help="the UNGATED world: the base copied a second time, which must succeed")
    ap.add_argument("--serve-only", action="store_true")
    ap.add_argument("--json", type=Path, default=None)
    args = ap.parse_args(argv)

    path = "/bench/m19a-seed/seed.html"
    if args.prove_failure:
        path += "?ungated=1"

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
                browser = stack.enter_context(Browser(headless=not args.headed))
                page = browser.page()
                build = chrome_full_version(page)
                print(f"m19a-seed/probe.py  Chrome {build}  "
                      f"isolation {'off' if args.no_isolation else 'on'}"
                      f"{'  UNGATED' if args.prove_failure else ''}")
                page.navigate(url, timeout=60)
                state, waited, polls = settle(page, args.timeout, args.poll)
                got = page.evaluate(READ)
                if not state:
                    print(f"  the page never reached a terminal state in {waited:.1f}s; "
                          f"it was at state {got['state']!r}", file=sys.stderr)
                    print(f"  phases reached: {sorted(got['phases'].keys())}", file=sys.stderr)
                    for fault in got["faults"]:
                        print(f"    FAULT {fault}", file=sys.stderr)
                    for error in got["errors"][:10]:
                        print(f"    page error: {error}", file=sys.stderr)
                    return 3
        except CDPError as error:
            print(f"  could not drive Chrome: {error}", file=sys.stderr)
            return 3

    print(f"  state {got['state']}  settled in {waited:.1f}s after {polls} poll(s); "
          f"boot retries {got['bootRetries']}")
    if got["why"]:
        print(f"  why: {got['why'][:600]}")

    if args.json:
        args.json.write_text(json.dumps({"chrome": build, **got}, indent=2), encoding="utf-8")

    if args.no_isolation:
        # The refusal IS the product here: a figure measured without COOP/COEP is a figure from a
        # different system.
        ok = got["state"] == "aborted"
        print(f"  no-isolation: the page {'refused' if ok else 'DID NOT REFUSE'}")
        return 0 if ok else 1
    if got["state"] != "done":
        print(f"  the page did not finish: state {got['state']!r}", file=sys.stderr)
        return 1
    return report(got, ungated=args.prove_failure)


if __name__ == "__main__":
    raise SystemExit(main())
