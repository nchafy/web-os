#!/usr/bin/env python3
"""M23's owed measurement: IS THERE AN HONEST SITE FOR A PNG DECODE?

    python3 bench/m23-blit/probe.py                  # the measurement
    python3 bench/m23-blit/probe.py --control-never   # the subject cannot settle; MUST read so
    python3 bench/m23-blit/probe.py --prove-failure   # ...and that gate, fired on the plain world
    python3 bench/m23-blit/probe.py --no-csp          # the realm with M6's policy omitted
    python3 bench/m23-blit/probe.py --headed          # watch it
    python3 bench/m23-blit/firefox-decode.py          # ...and the same question in Firefox

`docs/PLAN-SHELL.md` §M23 "If the assumption is wrong" says "a locked-down realm has no
`createImageBitmap` (src/libos/lockdown.mjs)" and therefore that R26 may have to ship for `.rgba`
payloads with a PNG falling back to its type icon. That claim is FALSE as written —
`createImageBitmap` is not in `TARGETS`, which is the one definition of what a realm loses — so the
question the row needs answered is the next one: a present binding is not a usable one.

`createImageBitmap` is ASYNC, and constraint 219 is the precedent. M8 measured that a transferred
`OffscreenCanvas` arrives at a process only when the program AWAITS a macrotask: never while it
spins, never while it is parked in `Atomics.wait` inside a syscall (constraint 46). A promise
settles through the same event loop. So this runs a real program on a real kernel in all three
states and reports which of M23's three options the evidence permits:

    (a) in the process      a decode promise really does settle there, AND the pixels come back
    (b) in the kernel       the kernel is a worker that awaits macrotasks — but that hands the
                            kernel an image decoder, and DL_BLIT taking a data-object fd may make
                            it unnecessary
    (c) nowhere             R26 ships for `.rgba` and a PNG falls back to its type icon

THE CONTROL IS NOT OPTIONAL. Two promises — one that settles at once, one that never does — go
through the SAME watchdog as the subject in every run, and `--control-never` substitutes the second
one FOR the subject so the verdict itself flips from the command line. A probe that reported
`settled` for both has measured nothing.

ABORTS rather than reporting a number from a non-isolated context, which `CLAUDE.md` requires of
every harness here: without COOP/COEP there is no SharedArrayBuffer, so there is no kernel, no
process and no `Atomics.wait` to park in.
"""
from __future__ import annotations

import argparse
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

DOC = "/bench/m23-blit/page.html"


def verdict_of(row: dict, stripped: bool, control: bool) -> dict:
    """The three options of §M23, scored from the phases rather than asserted."""
    # `realmHas`, not `realm`: the libos owns the key `realm` on a result row and overwrites a
    # program's own (src/libos/process.mjs). `lockdownRan` reads the libos's report, which is the
    # evidence that these figures come from a STRIPPED realm and not from an unprotected one.
    realm = row.get("realmHas") or {}
    lockdown = row.get("realm") or {}
    cold = row.get("cold") or {}
    park = row.get("park") or {}
    spin = row.get("spin") or {}
    awaited = row.get("awaited") or {}
    controls = row.get("controls") or {}
    pixels = row.get("pixels") or {}

    present = realm.get("createImageBitmap") == "function"
    settles_awaited = awaited.get("verdict") == "settled"
    px_ok = (
        pixels.get("error") in ("", None)
        and pixels.get("opaquePx", 0) > 0
        and pixels.get("opaqueExact") == pixels.get("opaquePx")
    )

    v = {
        "lockdownRanInThisProcess": not lockdown.get("skipped", True)
                                    and len(lockdown.get("stripped") or []) > 0,
        "cspOnTheProcessRealmIsLive": realm.get("cspRefusesEval"),
        "createImageBitmapIsInLockdownTARGETS": stripped,
        "presentInAProcessRealm": present,
        "settledWhileParkedInASyscall": bool(park.get("settledDuringPark")),
        "settledWhileSpinning": bool(spin.get("settledDuringSpin")),
        "settledWhenAwaited": settles_awaited,
        "coldDecodeTurnsAndMs": [cold.get("turns"), cold.get("latencyMs")],
        "macrotaskTurnsNeededAfterUnparking": park.get("turnsAfterTheParkEnded"),
        "awaitLatencyMs": awaited.get("latencyMs"),
        "pixelsCameBack": px_ok,
        "controlsCanTellSettledFromUnsettled": bool(controls.get("canTellThemApart")),
        # What a decode in the process costs to DELIVER: derived in the program from `MAX_INLINE`
        # and `BITMAP_HEADER`, which is the next slice's sizing input.
        "payloadCeiling": row.get("payloadCeiling"),
    }
    if control:
        # In the control run the subject is a promise that CANNOT settle, so the only thing being
        # scored is whether the probe says so.
        v["M23"] = ("CONTROL: the subject was a promise that never settles, and the awaited phase "
                    "read %r" % awaited.get("verdict"))
        return v
    if not present:
        v["M23"] = ("(c): the binding is absent in a process realm, so R26 ships for `.rgba` and a "
                    "PNG falls back to its type icon")
    elif not settles_awaited:
        v["M23"] = ("(c): the binding is present but its promise never settles in a process, so "
                    "there is no decode site here")
    elif not px_ok:
        v["M23"] = ("the promise settles but the PIXELS do not come back (%s), so a decode in the "
                    "process cannot feed DL_BLIT: read `pixels`"
                    % (pixels.get("error") or "see `pixels`"))
    else:
        v["M23"] = ("(a): a decode promise settles in a process and the pixels come back exactly, "
                    "BUT ONLY WHERE THE PROGRAM AWAITS — not parked, not spinning")
    return v


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--control-never", action="store_true",
                    help="substitute a promise that never settles FOR the subject. The awaited "
                         "phase MUST then read `unsettled`; anything else means the probe cannot "
                         "tell a settled promise from an unsettled one and its figures are void.")
    ap.add_argument("--headed", action="store_true", help="show the browser")
    ap.add_argument("--no-csp", action="store_true",
                    help="omit the process realm's Content-Security-Policy, as `scripts/serve.py "
                         "--no-csp` does. `cspOnTheProcessRealmIsLive` MUST then read `no`, which "
                         "is what shows that reading is coupled to the policy and not a constant.")
    ap.add_argument("--prove-failure", action="store_true",
                    help="run the PLAIN world and apply the CONTROL'S gate to it. The subject "
                         "settles, the gate demands `unsettled`, so the gate MUST fire — exits 0 "
                         "when it did, because a gate nobody has seen fire is a gate nobody has "
                         "checked (CLAUDE.md).")
    args = ap.parse_args(argv[1:])

    os.chdir(REPO)
    serve.Handler.csp = not args.no_csp
    httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    query = "?control=never" if args.control_never else ""
    url = "http://127.0.0.1:%d%s%s" % (port, DOC, query)
    print("m23 decode probe  %s" % url, file=sys.stderr)

    try:
        with cdp.Browser(headless=not args.headed) as browser:
            page = browser.page()
            page.navigate(url, timeout=60)
            deadline = time.time() + 180
            state = ""
            while time.time() < deadline:
                state = page.evaluate(
                    "(() => { const s = globalThis.BLIT && globalThis.BLIT.state; "
                    "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()")
                if state:
                    break
                time.sleep(0.25)
            if state != "done":
                why = page.evaluate("String((globalThis.BLIT && globalThis.BLIT.why) || '')")
                # NAMED, never swallowed: a probe that could not reach its subject must say so
                # rather than print an empty result that reads as a clean run.
                print(json.dumps({"ok": False, "state": state or "timeout", "why": why}, indent=2))
                return 3
            got = page.evaluate("JSON.stringify(globalThis.BLIT.results)")
            log = page.evaluate("document.getElementById('log').textContent")
    except cdp.CDPError as error:
        print(json.dumps({"ok": False, "state": "no-browser", "why": str(error)}, indent=2))
        return 3
    finally:
        httpd.shutdown()
        httpd.server_close()

    r = json.loads(got)
    row = r.get("row") or {}
    v = verdict_of(row, bool(r.get("strippedByLockdown")), args.control_never)
    print(log)
    print(json.dumps({"ok": True, "verdict": v, "measured": row}, indent=2))

    # THE CONTROL'S OWN GATE, so a control that proved nothing is a non-zero exit and not a wall of
    # green text: the subject cannot settle, so `unsettled` is the only honest reading.
    verdict = (row.get("awaited") or {}).get("verdict")
    if args.prove_failure:
        if verdict == "unsettled":
            print("PROOF FAILED: the plain world read `unsettled` too, so the control's gate "
                  "does not discriminate", file=sys.stderr)
            return 4
        print("PROOF SUCCEEDED: the control's gate fired on the plain world — it read %r where "
              "the gate demands `unsettled`" % verdict, file=sys.stderr)
        return 0
    if args.control_never:
        if verdict != "unsettled":
            print("CONTROL FAILED: the awaited phase read %r, not `unsettled`" % verdict,
                  file=sys.stderr)
            return 4
        return 0
    if args.no_csp:
        live = str(v["cspOnTheProcessRealmIsLive"] or "")
        if live.startswith("no"):
            print("CONTROL SUCCEEDED: with the policy omitted the realm evaluated a string, so "
                  "`yes` in a plain run is the policy and not a constant", file=sys.stderr)
            return 0
        print("CONTROL FAILED: the policy was omitted and the realm still refused eval: %s"
              % live, file=sys.stderr)
        return 4
    if not v["controlsCanTellSettledFromUnsettled"]:
        print("CONTROLS FAILED: this probe cannot tell a settled promise from an unsettled one, "
              "so its figures are void", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
