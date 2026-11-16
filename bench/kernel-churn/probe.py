#!/usr/bin/env python3
"""Boot N kernels, report how many stalled and where. The lever is N.

WHY. `scripts/check.py --only m4b` reports BROKEN about 1 run in 12 on a page-level
`timed out waiting for spawned`, and it is the only check that does. It is also the only check
that boots one kernel per proof — thirteen per run, where every other check boots one. Two
explanations fit: a kernel boot has a small per-boot failure probability and m4b merely rolls the
dice thirteen times, or something in m4b's own proofs is responsible. Running m4b at eleven proofs
instead of thirteen cannot separate them, because a 15% change in the number of rolls is invisible
in a dozen samples.

This removes m4b from the question. It boots N kernels and does nothing else: no pty, no pipes, no
signals, one trivial process each. Sweep N and see whether the failure rate tracks it.

    python3 bench/kernel-churn/probe.py --n 10 --runs 6
    python3 bench/kernel-churn/probe.py --n 10,60 --runs 4      # the comparison

WHAT A STALL MEANS, which is the half that decides whether anything needs fixing. The kernel posts
`up` before it loads anything and `spawned` only after `await programImage` resolves its fetch,
so the step that stalls localises it:

    stalled at `up`       the kernel worker never started         — harness/Chrome churn
    stalled at `spawned`  the program fetch never settled         — harness/Chrome churn
    stalled at `ready`    the child process worker never reported — A DEFECT IN `spawn`

Only the third is a defect in the system under test, and it would mean `spawn` can hang.
"""

import argparse
import contextlib
import http.server
import json
import pathlib
import statistics
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import cdp  # noqa: E402
from serve import Handler  # noqa: E402


#: The path that never answers. A request for it is accepted and then simply held, which is the
#: shape the deadline in `programImage` exists for — a fetch that neither resolves nor rejects.
#: It is NOT a dropped connection: a reset would reject the fetch and `spawn` would already
#: answer -ENOEXEC without any deadline, so a control built on a reset would prove nothing.
STALL_PATH = "/__stall__/program.mjs"


class _Stalling(Handler):
    def send_head(self):
        if self.path.startswith("/__stall__/"):
            # Headers, then nothing. The body never arrives and the connection stays open, so the
            # client's `fetch` promise is left pending for as long as it will wait.
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript")
            self.send_header("Content-Length", "1000000")
            self.end_headers()
            while not getattr(self.server, "_stop_stalling", False):
                time.sleep(0.2)
            return None
        return Handler.send_head(self)


@contextlib.contextmanager
def serving():
    """The repo root with COOP/COEP, in this process. `Handler` is serve.py's, so the isolation
    headers and the dotfile refusal are the ones the rest of the harness uses."""
    import functools
    handler = functools.partial(_Stalling, directory=str(ROOT))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield "http://127.0.0.1:%d" % port
    finally:
        # Release any thread parked in the stalling handler, or `shutdown()` waits on it.
        httpd._stop_stalling = True
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=10)


def one_run(base, n, timeout_s, program=None, mode=None):
    """One page load that boots `n` kernels. Returns the page's own record."""
    import urllib.parse
    query = {"n": str(n)}
    if program:
        query["program"] = program
    if mode:
        query["mode"] = mode
    with cdp.Browser() as browser:
        page = browser.page()
        page.navigate("%s/bench/kernel-churn/page.html?%s"
                      % (base, urllib.parse.urlencode(query)))
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            state = page.evaluate("globalThis.CHURN && globalThis.CHURN.state")
            if state in ("done", "error", "aborted"):
                break
            time.sleep(0.25)
        return page.evaluate(
            "JSON.stringify(globalThis.CHURN || {state: 'missing'})")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n", default="10",
                    help="kernels per run; a comma list sweeps (default 10)")
    ap.add_argument("--runs", type=int, default=4, help="page loads per N (default 4)")
    ap.add_argument("--timeout", type=float, default=600.0, help="seconds per run")
    ap.add_argument("--program", default=None,
                    help="the program each kernel spawns; the stall is on the fetch of it, so "
                         "this is a lever (default bench/m1-lifecycle/program.mjs)")
    ap.add_argument("--mode", default=None, help="argv[0] handed to the program")
    ap.add_argument("--stall", action="store_true",
                    help="point every kernel at a URL that answers headers and then never sends "
                         "a body. The deadline in `programImage` must turn that into a failed "
                         "spawn; without it the kernel hangs and this never completes.")
    args = ap.parse_args(argv)
    sizes = [int(x) for x in str(args.n).split(",") if x.strip()]
    program = STALL_PATH if args.stall else args.program

    report = {"sizes": {}}
    with serving() as base:
        for n in sizes:
            booted = stalled = 0
            runs_with_a_stall = 0
            where = {}
            refused_by_kernel = []
            durations = []
            for _ in range(args.runs):
                raw = one_run(base, n, args.timeout, program, args.mode)
                got = json.loads(raw) if raw else {"state": "missing"}
                if got.get("state") == "aborted":
                    # A run without cross-origin isolation measures a different system. Refusing
                    # rather than reporting a number is the rule the whole bench/ tree follows.
                    print("ABORTED: %s" % got.get("why"))
                    return 3
                if got.get("state") != "done":
                    print("BROKEN: page state %r (%s)"
                          % (got.get("state"), str(got.get("why"))[:200]))
                    return 3
                rows = got.get("rows") or []
                booted += len(rows)
                bad = [r for r in rows if not r.get("ok")]
                stalled += len(bad)
                runs_with_a_stall += 1 if bad else 0
                for r in bad:
                    where[r.get("stalledAt") or "?"] = where.get(r.get("stalledAt") or "?", 0) + 1
                    if r.get("kernelRefused"):
                        refused_by_kernel.append(r["kernelRefused"][:120])
                durations += [r.get("ms", 0) for r in rows if r.get("ok")]
            report["sizes"][n] = {
                "runs": args.runs, "kernels_booted": booted, "kernels_stalled": stalled,
                "runs_with_a_stall": runs_with_a_stall,
                "per_kernel_failure_rate": (stalled / booted) if booted else None,
                "stalled_at": where,
                # A stall the KERNEL ended, by its own program-fetch deadline, rather than one
                # the page gave up on. With `--stall` every entry must be here; without the
                # deadline the list is empty and the kernels simply hang.
                "refused_by_the_kernel": refused_by_kernel,
                "boot_ms_median": round(statistics.median(durations), 1) if durations else None,
                "boot_ms_max": max(durations) if durations else None,
            }
            s = report["sizes"][n]
            print("n=%-4d runs=%d booted=%-5d stalled=%-3d (%.3f%% per kernel)  "
                  "runs with a stall: %d/%d  median boot %s ms, max %s ms  %s"
                  % (n, args.runs, booted, stalled,
                     100.0 * (s["per_kernel_failure_rate"] or 0.0),
                     runs_with_a_stall, args.runs, s["boot_ms_median"], s["boot_ms_max"],
                     s["stalled_at"] or ""))
            if refused_by_kernel:
                print("      the kernel refused %d of them itself: %s"
                      % (len(refused_by_kernel), refused_by_kernel[0]))
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
