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

    stalled at `up`       the kernel worker never started         — Chrome's own startup
    stalled at `spawned`  the program fetch never settled         — OURS: `spawn` awaits it
    stalled at `ready`    the child process worker never reported — OURS: the ready handshake

A `spawned` stall is where the defect this probe found actually lived. `spawn` cannot answer until
the program is loaded, so an unbounded `fetch` there makes process creation HANG rather than fail —
no errno, nothing in the trace. `programImage` is bounded and retried for that reason
(constraint 155), and `--stall` is the demonstration. Only a stall at `up` belongs to Chrome.
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
from serve import Handler, Server  # noqa: E402


#: The path that never answers. A request for it is accepted and then simply held, which is the
#: shape the deadline in `programImage` exists for — a fetch that neither resolves nor rejects.
STALL_PATH = "/__stall__/program.mjs"

#: The path whose FIRST request is dropped at the transport — the connection is closed before any
#: byte of a response — and whose second serves the real program. `fetch` reports that as
#: `TypeError: Failed to fetch`, with no status.
#:
#: THE CLAIM THIS CONTROL CORRECTS WAS WRITTEN HERE. `STALL_PATH`'s note used to add that a
#: dropped connection "would reject the fetch and `spawn` would already answer -ENOEXEC without
#: any deadline, so a control built on a reset would prove nothing". That was wrong, and
#: `www/m7.html` is where it cost something: a TypeError was NOT retried and NOT caught, so it
#: escaped `programText` through `spawnBatch` to `self.onmessage`, which has no try/catch — the
#: kernel PANICKED, and the page reported `timed out waiting for spawned` with nothing naming the
#: cause. About one run in three on a page that boots five kernels. Constraint 212.
DROP_PATH = "/__drop__/program.mjs"

#: What the second request for DROP_PATH actually serves: a real program, so a kernel that got
#: past the drop goes on to spawn and report `ready` like any other.
DROP_TARGET = "/bench/m1-lifecycle/program.mjs"


class _Stalling(Handler):
    def send_head(self):
        if self.path.startswith("/__drop__/"):
            # CLOSED BEFORE A SINGLE BYTE, once per server. `self.connection.close()` and
            # `close_connection` together: the first makes the client's fetch reject, the second
            # stops the handler trying to write a response into a dead socket.
            with self.server._drop_lock:
                first = self.server._dropped == 0
                self.server._dropped += 1 if first else 0
            if first:
                self.close_connection = True
                try:
                    self.connection.close()
                except OSError:
                    pass
                return None
            # The retry gets the real program, so the kernel goes on to spawn it.
            self.path = DROP_TARGET
            return Handler.send_head(self)
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
    # `serve.Server` carries the listen backlog these pages need; see constraint 212.
    httpd = Server(("127.0.0.1", 0), handler)
    httpd._drop_lock = threading.Lock()
    httpd._dropped = 0
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
    ap.add_argument("--drop", action="store_true",
                    help="drop the FIRST program fetch at the transport — the connection is "
                         "closed before any response — and serve the real program on the retry. "
                         "Every kernel must still boot and spawn, and at least one must report a "
                         "non-zero `transport` retry: that counter is the only direct evidence "
                         "the retry in `programText` did anything. Without it the kernel panics "
                         "(constraint 212).")
    ap.add_argument("--stall", action="store_true",
                    help="point every kernel at a URL that answers headers and then never sends "
                         "a body. The deadline in `programImage` must turn that into a failed "
                         "spawn; without it the kernel hangs and this never completes.")
    args = ap.parse_args(argv)
    sizes = [int(x) for x in str(args.n).split(",") if x.strip()]
    if args.stall and args.drop:
        ap.error("--stall and --drop are two different failures; run them separately")
    program = STALL_PATH if args.stall else (DROP_PATH if args.drop else args.program)

    report = {"sizes": {}}
    with serving() as base:
        for n in sizes:
            booted = stalled = 0
            runs_with_a_stall = 0
            transport = retries = 0
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
                transport += sum(r.get("transport") or 0 for r in rows)
                retries += sum(r.get("retries") or 0 for r in rows)
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
                # THE RETRY, OBSERVED. With `--drop` the first program fetch of each server is
                # closed at the transport, so a kernel that went on to spawn did it on a retry —
                # and `transport` is the kernel's own count of exactly that.
                "transport_retries": transport,
                "retries": retries,
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
            if retries:
                print("      %d retried program fetch(es): %d at the transport, %d at the deadline"
                      % (retries, transport, retries - transport))
    print(json.dumps(report, indent=2))
    if args.drop:
        # THE CONTROL SCORES ITSELF, and on BOTH halves: every kernel got past a dropped fetch,
        # AND at least one kernel's own counter says it took a retry to do it. The first half
        # alone would pass against a server that never dropped anything.
        totals = [v for v in report["sizes"].values()]
        stalls = sum(v["kernels_stalled"] for v in totals)
        seen = sum(v["transport_retries"] for v in totals)
        if stalls:
            print("--drop: %d kernel(s) stalled, so the retry did NOT cover the transport failure"
                  % stalls)
            return 1
        if not seen:
            print("--drop: no kernel reported a transport retry, so nothing was actually dropped "
                  "and this control proved nothing")
            return 1
        print("--drop: every kernel booted and spawned, and %d of their program fetches took a "
              "transport retry to do it" % seen)
    return 0


if __name__ == "__main__":
    sys.exit(main())
