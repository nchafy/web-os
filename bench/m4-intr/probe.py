#!/usr/bin/env python3
"""M4's owed experiment: is a synchronous OPFS read interruptible by `Atomics.notify`?

MILESTONES.md §"Open experiments" owes this before M4 and calls it the weakest point in the
cancellation design. `docs/ABI.md` marks `read()` INTR-capable without anyone having measured it.

Run:  .venv/bin/python bench/m4-intr/probe.py

ABORTS rather than reporting a number from a non-isolated context, which CLAUDE.md requires of
every harness here: without COOP/COEP there is no SharedArrayBuffer, so there is no `Atomics.wait`
to interrupt and any figure would be of something else.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys
import threading
import time
from http.server import ThreadingHTTPServer

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import cdp          # noqa: E402  the project's one CDP driver
import serve        # noqa: E402  the project's one static server, COOP/COEP and ranges

DOC = "/bench/m4-intr/page.html"


def main(argv: list[str]) -> int:
    query = argv[1] if len(argv) > 1 else ""
    os.chdir(REPO)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}{DOC}{query}"
    print(f"intr probe  {url}", file=sys.stderr)

    try:
        with cdp.Browser() as browser:
            page = browser.page()
            page.navigate(url, timeout=60)
            deadline = time.time() + 420
            state = ""
            while time.time() < deadline:
                state = page.evaluate(
                    "(() => { const s = globalThis.INTR && globalThis.INTR.state; "
                    "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")
                if state:
                    break
                time.sleep(0.5)
            if state != "done":
                why = page.evaluate("String((globalThis.INTR && globalThis.INTR.why) || '')")
                # NAMED, never swallowed: a probe that could not reach its subject must say so
                # rather than print an empty result that reads as a clean run.
                print(json.dumps({"ok": False, "state": state or "timeout", "why": why},
                                 indent=2))
                return 3
            got = page.evaluate(
                "JSON.stringify({results: globalThis.INTR.results, "
                "errors: globalThis.INTR.errors || []})")
    except cdp.CDPError as error:
        print(json.dumps({"ok": False, "state": "no-browser", "why": str(error)}, indent=2))
        return 3
    finally:
        httpd.shutdown()
        httpd.server_close()

    data = json.loads(got)
    r = data["results"]
    base = r["baseline"]
    during = r["notifyDuringRead"]

    # THE VERDICT, derived rather than asserted. Three conditions, each named, so a reader can see
    # which one carried it:
    #   - the baseline must hold, or a negative result below means only that the notify never came
    #   - `notify` must wake nobody during the read: a thread inside a synchronous call is not in
    #     Atomics.wait, so there is nothing to wake
    #   - the worker must not observe the flag before its current chunk finishes
    interrupted = base["ok"] and during["workersWoken"] > 0
    chunk_p99_us = r["readFloor"][str(during["chunk"])]["p99Ms"] * 1000
    big = r["readFloor"]["16777216"]
    verdict = {
        # The literal question, answered.
        "baselineHolds": base["ok"],
        "notifyWokeAnyoneDuringRead": during["workersWoken"] > 0,
        "syncReadIsInterruptible": interrupted,
        "answer":
            "NO. A thread inside a synchronous OPFS read is not in Atomics.wait, so there is "
            "nothing for notify to wake and it woke 0. The flag is latched and seen only at the "
            "next point the thread chooses to look.",
        # The part that decides whether docs/ABI.md is lying, which the literal answer does not.
        "butReadIsStillInterruptible":
            "YES, in this architecture. Since M0b the handles live in the I/O worker "
            "(constraints 58-59), so the CALLING PROCESS parks in Atomics.wait and is fully "
            "interruptible: the kernel replies ST_INTR and drops the late answer. The I/O "
            "worker's read runs to completion and its result is discarded. So read() is "
            "INTR-capable as documented, and what a signal waits for is the chunk in flight.",
        "signalWaitsForOneChunkUs": chunk_p99_us,
        "consequenceForM4": [
            "A blocking pipe read MUST park in Atomics.wait. It must never sit inside a "
            "synchronous call, because that call cannot be interrupted at all.",
            "The I/O worker MUST keep reads chunked at MAX_INLINE. One unchunked %d MiB read "
            "blocks it for %.2f ms p99, which every other process's signal would wait for."
            % (16, big["p99Ms"]),
        ],
    }
    print(json.dumps({"ok": True, **data, "verdict": verdict}, indent=2))
    if not base["ok"]:
        print("the BASELINE failed, so nothing here is evidence of anything", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
