#!/usr/bin/env python3
"""M8's owed experiment: CAN A WINDOW'S SURFACE BE A TRANSFERRED `OffscreenCanvas`?

    python3 bench/m8-surface/probe.py

`PLAN.md` §5 and `CLAUDE.md` both say it is — "Window surfaces are transferred `OffscreenCanvas`,
which is why the window ABI is `win_*` calls and not a `/dev/wm` device file" — and nobody has
measured whether the transfer can ARRIVE at a process. A process is a dedicated worker that blocks
in `Atomics.wait` between syscalls (constraint 46) and turns no event loop while a program
computes; `postMessage` delivery needs an event-loop turn.

What the answer decides, which is why it comes before any of M8's code:

    arrives while blocked      M8 transfers a canvas on `win_create`, as planned
    arrives only on an await   a surface forces every drawing program to be async and to yield,
                               and the libos has to correlate a transfer with a syscall reply
    never arrives              the surface is KERNEL-OWNED and driven through the syscall channel

ABORTS rather than reporting a number from a non-isolated context, which `CLAUDE.md` requires of
every harness here: without COOP/COEP there is no SharedArrayBuffer, so there is no `Atomics.wait`
for a process double to block in and the question cannot be asked at all.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import cdp          # noqa: E402  the project's one CDP driver
import serve        # noqa: E402  the project's one static server, COOP/COEP and ranges

DOC = "/bench/m8-surface/page.html"


def main(argv: list[str]) -> int:
    query = argv[1] if len(argv) > 1 else ""
    os.chdir(REPO)
    httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d%s%s" % (port, DOC, query)
    print("surface probe  %s" % url, file=sys.stderr)

    try:
        with cdp.Browser() as browser:
            page = browser.page()
            page.navigate(url, timeout=60)
            deadline = time.time() + 120
            state = ""
            while time.time() < deadline:
                state = page.evaluate(
                    "(() => { const s = globalThis.SURF && globalThis.SURF.state; "
                    "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")
                if state:
                    break
                time.sleep(0.25)
            if state != "done":
                why = page.evaluate("String((globalThis.SURF && globalThis.SURF.why) || '')")
                # NAMED, never swallowed: a probe that could not reach its subject must say so
                # rather than print an empty result that reads as a clean run.
                print(json.dumps({"ok": False, "state": state or "timeout", "why": why},
                                 indent=2))
                return 3
            got = page.evaluate("JSON.stringify(globalThis.SURF.results)")
            log = page.evaluate("document.getElementById('log').textContent")
    except cdp.CDPError as error:
        print(json.dumps({"ok": False, "state": "no-browser", "why": str(error)}, indent=2))
        return 3
    finally:
        httpd.shutdown()
        httpd.server_close()

    r = json.loads(got)
    phases = r.get("phases") or {}
    worker = r.get("worker") or {}
    verdict = {
        # THE LITERAL QUESTION, ANSWERED, one line per phase a program can be in.
        "arrivedWhileSpinning": bool(phases.get("spin")),
        "arrivedWhileParked": bool(phases.get("park")),
        "arrivedAfterAnAwait": bool(phases.get("yielded")),
        "arrivedAtAll": bool(worker.get("hasCanvas")),
        "drawnOn": worker.get("drew") or worker.get("drawError"),
        "detachedInThePage": r.get("detachedInThePage"),
    }
    # The design this forces, derived from the three phases rather than asserted.
    if verdict["arrivedWhileParked"]:
        verdict["M8"] = ("a canvas MAY be transferred on `win_create`: it arrives while the "
                         "process is parked in the very call that asked for it")
    elif verdict["arrivedAfterAnAwait"]:
        verdict["M8"] = ("a transfer arrives ONLY when the program yields to its own event loop, "
                         "so a transferred surface forces every drawing program to be async and "
                         "to await after the call that creates it")
    elif verdict["arrivedAtAll"]:
        verdict["M8"] = "it arrived in a phase this probe did not expect; read `worker`"
    else:
        verdict["M8"] = ("a transfer NEVER reaches a process, so a window's surface cannot be a "
                         "transferred handle: it must be kernel-owned")
    print(log)
    print(json.dumps({"ok": True, "verdict": verdict, "measured": r}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
