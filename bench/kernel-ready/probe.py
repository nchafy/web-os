#!/usr/bin/env python3
"""WHOSE READINESS IS IT? The kernel's spawn-ready accounting, driven in a real isolated Chrome.

    python3 bench/kernel-ready/probe.py                  # the gate
    python3 bench/kernel-ready/probe.py --order term,files,taskmgr
    python3 bench/kernel-ready/probe.py --headed

THE DEFECT THIS EXISTS FOR, as it was found. `src/kernel/kernel.mjs`'s `spawnBatch` waited on
`G_READY` — one cumulative word incremented by ANY process reaching `ready`, children created by
`SYS_spawn` included. It sampled the counter before the batch and waited for `already + count`, so
an increment from a process no batch asked for satisfied the target. The page then posted `go` to a
worker still inside `init`, where `program` is null, and the worker faulted with
`TypeError: Cannot read properties of null (reading 'run')` (`src/libos/process.mjs:244`).

`term` is what makes it reachable, because it spawns `sh` by syscall. So `term` followed by
anything else is the world. `www/shell.mjs` found it while being extracted and REFUSES that order
rather than reordering it silently; `bench/kernel-ready/fixture.html` is the same world without
that guard, which is the only place the kernel's behaviour is observable.

THE ABSOLUTE-VS-RELATIVE HALF WAS ALREADY FIXED and the comment at `spawnBatch` says so — "a
second batch against one kernel otherwise finds the counter past its own count". What was missing
is WHOSE readiness it is. A count cannot tell "mine came up" from "one more came up", so
`awaitReady` now waits on the batch's own pids and asks the process table directly.

WHAT IS ASSERTED: for each order, the page reports no fault AND every pid it spawned is still in
`table.live`. The second half is the one the counter could be satisfied without — a pid reported
ready whose worker then faulted is absent from the table, and a run that only counted spawns would
show nothing wrong.

--prove-failure RESTORES THE COUNTER, in a copy of the kernel served to the page instead of the
real one, and the bad order MUST then fault. A gate nobody has seen fail is a gate nobody has
checked. It exits 0 when the proof succeeded.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import shutil
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import cdp  # noqa: E402
import serve  # noqa: E402

DOC = "/bench/kernel-ready/fixture.html"

#: The orders worth driving. `term` LAST is the shipped staging's rule and must work; `term` FIRST
#: is the world the defect lived in; the three-program order is the same hazard with a batch in
#: between, which is where a fix that only special-cased "the next spawn" would still fail.
ORDERS = (
    "desktop,files,taskmgr,term",   # the shipped staging's rule: a child-spawner LAST
    "desktop,term,files",           # THE MEASURED FAULT: `stageDesktop` spawns `desktop` first
    "desktop,term,files,taskmgr",   # the same hazard with a batch after it
    "term,files",                   # and without `desktop`, which is NOT the world it was found in
)

READ = """(() => {
  const R = globalThis.READY || {}
  return JSON.stringify({
    state: String(R.state || ''), why: String(R.why || ''),
    verdict: String(R.verdict || ''), order: R.order || null,
    spawns: R.spawns || [], livePids: R.livePids || null, missing: R.missing || null,
    faults: (R.faults || []).map((f) => ({ pid: f.pid, why: String(f.why).slice(0, 300) })),
    errors: (R.errors || []).map(String),
  })
})()"""


def read(page):
    raw = page.evaluate(READ)
    if not isinstance(raw, str):
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def drive(page, base: str, order: str, timeout: float = 90.0) -> dict:
    page.navigate("%s%s?order=%s" % (base, DOC, order), timeout=60)
    deadline = time.time() + timeout
    got: dict = {}
    while time.time() < deadline:
        got = read(page)
        if got.get("state") in ("done", "error", "aborted"):
            return got
        time.sleep(0.3)
    got["why"] = got.get("why") or ("never reached a terminal state within %.0fs" % timeout)
    got["state"] = got.get("state") or "stuck"
    return got


def break_the_wait(root: pathlib.Path) -> str:
    """Make `awaitReady` report ready IMMEDIATELY, in a COPY of the tree served to the page.

    WHY THIS CONTROL AND NOT "RESTORE THE OLD COUNTER". The first version of this control put the
    cumulative-`G_READY` wait back, because that is the shape the reported fault was attributed to.
    It was verified faithful — the generated kernel really did wait on
    `Atomics.load(g, G_READY) >= already + m.count` — and FOUR spawn orders against it, including
    the exact one reported to fault, came up clean. That control turned nothing, and a control that
    turns nothing verifies nothing.

    What this probe can actually detect is the property `awaitReady` exists for: that the kernel
    does not announce a batch ready before the batch is running. So the control removes the wait
    altogether. `www/pagekernel.mjs` posts `go` as soon as it sees `ready`, so a worker still inside
    `init` receives it and faults in `src/libos/process.mjs` — which is the symptom the probe reads.

    The repo is never edited: a control that rewrites the source it checks can leave the tree broken.
    """
    path = root / "src/kernel/kernel.mjs"
    src = path.read_text()
    needle = """  const check = () => {
    const ready = upNow();
    if (ready >= want) {"""
    if needle not in src:
        raise SystemExit("could not break the wait: `awaitReady`'s text did not match. Update "
                         "this control beside the function rather than reporting a proof over an "
                         "unmodified kernel.")
    src = src.replace(needle, """  const check = () => {
    const ready = upNow();
    if (true) {""", 1)
    path.write_text(src)
    return "awaitReady announces `ready` on its first poll, without waiting for any process"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--order", action="append", default=[],
                    help="a comma-separated spawn order, repeatable. Default: three orders.")
    ap.add_argument("--prove-failure", action="store_true",
                    help="serve a kernel whose awaitReady does not wait at all; a spawn order MUST "
                         "then fault or lose a pid. Exits 0 when the proof succeeded.")
    args = ap.parse_args(argv)
    orders = tuple(args.order) if args.order else ORDERS

    root = REPO
    tmp: pathlib.Path | None = None
    control = ""
    if args.prove_failure:
        # A COPY, so the control cannot leave the repository holding a broken kernel.
        tmp = pathlib.Path(os.environ.get("TMPDIR", "/tmp")) / "webos-kernel-ready-control"
        if tmp.exists():
            shutil.rmtree(tmp)
        shutil.copytree(REPO, tmp, ignore=shutil.ignore_patterns(
            ".git", "node_modules", "*.png", "build", ".venv"))
        control = break_the_wait(tmp)
        root = tmp
        print("control  %s" % control)
        print("served   %s" % root)

    os.chdir(root)
    httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % port
    print("url      %s%s" % (base, DOC))

    rows: list[dict] = []
    try:
        with cdp.Browser(headless=not args.headed) as browser:
            page = browser.page()
            page.call("Runtime.enable")
            for order in orders:
                got = drive(page, base, order)
                rows.append({"order": order, **got})
                faults = got.get("faults") or []
                print("%-22s state=%-6s verdict=%-28s spawned=%d missing=%s faults=%d"
                      % (order, got.get("state"), got.get("verdict") or "-",
                         len(got.get("spawns") or []),
                         (got.get("missing") or []) or "-", len(faults)))
                for f in faults[:2]:
                    print("    fault pid=%s %s" % (f.get("pid"), f.get("why")))
    finally:
        httpd.shutdown()

    bad: list[str] = []
    for row in rows:
        if row.get("state") != "done":
            bad.append("%s: state %s — %s" % (row["order"], row.get("state"), row.get("why")))
            continue
        if row.get("verdict") != "ok":
            bad.append("%s: %s" % (row["order"], row.get("verdict")))
        # A FAULT IS A FAILURE HERE EVEN WHEN THE PAGE SAID `ok`, and this probe needed that
        # lesson. A fault from a `go` posted too early arrives AFTER the spawn loop returns, so
        # the page's own verdict is computed before it lands — the no-wait control printed
        # `verdict=ok` beside `faults=4` and this function reported the run clean. The page is one
        # witness and its timing is its own; the fault list is the other, and it is read here. 
        if row.get("faults"):
            bad.append("%s: %d fault(s), first: %s"
                       % (row["order"], len(row["faults"]),
                          (row["faults"][0] or {}).get("why", "")[:140]))
        if row.get("livePids") is None:
            bad.append("%s: the process table was unreadable, so nothing is proven" % row["order"])

    print()
    if args.prove_failure:
        if tmp is not None:
            shutil.rmtree(tmp, ignore_errors=True)
        if bad:
            print("--prove-failure: the no-wait kernel was reported bad %d time(s), as required:"
                  % len(bad))
            for line in bad:
                print("  %s" % line)
            return 0
        print("--prove-failure: EVERY ORDER CAME OUT CLEAN against a kernel that never waits "
              "for a process to start. This probe is not reading readiness at all.")
        return 1

    if bad:
        for line in bad:
            print("BAD  %s" % line)
        return 1
    print("every spawn order came up clean: no faults, and every pid still in the process table")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
