#!/usr/bin/env python3
"""DOES THE DECODE SITE EXIST IN A SECOND ENGINE? M23's measurement, in Firefox.

    python3 bench/m23-blit/firefox-decode.py
    python3 bench/m23-blit/firefox-decode.py --headed
    python3 bench/m23-blit/firefox-decode.py --prove-failure

WHY THIS FILE EXISTS. `bench/m23-blit/probe.py` answers "can a process decode a PNG?" in Chrome,
and an ABI decision — whether `DL_BLIT` is fed by a process or by the kernel — would be taken on
that one engine's answer. CLAUDE.md records the bill for exactly that: five milestones, every
Chrome expectation green each time. Two of the three facts this probe rests on are platform
behaviour and not arithmetic, so either could differ here:

  1. **Is `createImageBitmap` even in a worker's realm?** It is not in `src/libos/lockdown.mjs`'s
     `TARGETS`, so nothing in this project removes it — but nothing in this project put it there
     either, and `importScripts` and `SharedWorker` are already in that file with the note that a
     binding the platform happens not to expose is not a boundary.
  2. **Does the promise settle only on an await?** Constraint 219's measurement — a transfer
     reaching a process only when it awaits a macrotask — was taken in Chrome.
  3. **Is `OffscreenCanvas` + `getImageData` the same round trip?** A 2d canvas stores
     premultiplied alpha, and whether the un-premultiply is exact for an opaque pixel is the
     engine's arithmetic, not this repo's.

And constraint 206 is the reason the run is worth making even if all three agree: M6 shipped a
policy under which NO PROCESS STARTED in Firefox, with the Chrome suite green. A spawn that fails
here is itself the finding.

`--prove-failure` drives `?control=never`, where the subject is a promise that cannot settle: the
gate MUST then read `unsettled`. It exits 0 when the proof SUCCEEDED, which is this repo's
convention — non-zero is reserved for a proof that failed.
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

import bidi         # noqa: E402  the project's one WebDriver BiDi driver
import serve        # noqa: E402  the project's one static server, COOP/COEP and ranges

DOC = "/bench/m23-blit/page.html"
#: How long the whole run may take. A kernel boot plus a spawn plus two 400 ms blocking phases is
#: about three seconds in Chrome; this is an order above it, because a cold Firefox profile fetches
#: the libos module graph with `Cache-Control: no-store` on every response.
DEADLINE_S = 180.0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--headed", action="store_true", help="show the browser")
    ap.add_argument("--prove-failure", action="store_true",
                    help="drive `?control=never`, where the subject cannot settle. The gate MUST "
                         "read `unsettled`; it exits 0 when it did.")
    args = ap.parse_args(argv[1:])

    os.chdir(REPO)
    if not bidi.find_firefox():
        print(json.dumps({"ok": False, "state": "no-firefox",
                          "why": "no Firefox on this machine; scripts/bidi.py needs one"},
                         indent=2))
        return 3
    httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    query = "?control=never" if args.prove_failure else ""
    url = "http://127.0.0.1:%d%s%s" % (port, DOC, query)
    print("m23 firefox decode gate  %s" % url, file=sys.stderr)

    try:
        with bidi.Firefox(headless=not args.headed) as ff:
            ff.navigate(url)
            deadline = time.time() + DEADLINE_S
            state = ""
            while time.time() < deadline:
                state = ff.evaluate(
                    "(() => { const s = globalThis.BLIT && globalThis.BLIT.state; "
                    "return (s === 'done' || s === 'aborted' || s === 'error') ? s : '' })()",
                    raw=True)
                if state:
                    break
                time.sleep(0.5)
            if state != "done":
                # NAMED, never swallowed, and the page's own log goes with it: constraint 206's
                # failure mode is a process that never starts, and "timeout" alone does not say so.
                why = ff.evaluate("String((globalThis.BLIT && globalThis.BLIT.why) || '')",
                                  raw=True)
                log = ff.evaluate("document.getElementById('log').textContent", raw=True)
                print(log)
                print(json.dumps({"ok": False, "state": state or "timeout", "why": why}, indent=2))
                return 3
            row = ff.evaluate("JSON.stringify((globalThis.BLIT.results || {}).row || {})")
            dpr = ff.evaluate("String(devicePixelRatio)", raw=True)
            log = ff.evaluate("document.getElementById('log').textContent", raw=True)
    except bidi.BidiError as error:
        print(json.dumps({"ok": False, "state": "driver", "why": str(error)}, indent=2))
        return 3
    finally:
        httpd.shutdown()
        httpd.server_close()

    realm = row.get("realmHas") or {}
    park = row.get("park") or {}
    spin = row.get("spin") or {}
    awaited = row.get("awaited") or {}
    controls = row.get("controls") or {}
    pixels = row.get("pixels") or {}
    found = {
        "engine": "firefox",
        "devicePixelRatio": dpr,
        "aProcessStarted": bool(row.get("mode")),
        "createImageBitmapInTheRealm": realm.get("createImageBitmap"),
        "OffscreenCanvasInTheRealm": realm.get("OffscreenCanvas"),
        "cspRefusesEval": realm.get("cspRefusesEval"),
        "settledWhileParkedInASyscall": bool(park.get("settledDuringPark")),
        "settledWhileSpinning": bool(spin.get("settledDuringSpin")),
        "awaited": awaited.get("verdict"),
        "awaitLatencyMs": awaited.get("latencyMs"),
        "coldDecodeTurns": (row.get("cold") or {}).get("turns"),
        "pixels": pixels,
        "controlsCanTellThemApart": bool(controls.get("canTellThemApart")),
    }
    print(log)
    print(json.dumps({"ok": True, "firefox": found}, indent=2))

    if args.prove_failure:
        if awaited.get("verdict") == "unsettled":
            print("PROOF SUCCEEDED: with a subject that cannot settle, Firefox read `unsettled`",
                  file=sys.stderr)
            return 0
        print("PROOF FAILED: the awaited phase read %r where the subject was a promise that "
              "cannot settle" % awaited.get("verdict"), file=sys.stderr)
        return 4
    if not found["controlsCanTellThemApart"]:
        print("CONTROLS FAILED in Firefox: a settled and an unsettled promise read the same, so "
              "these figures are void", file=sys.stderr)
        return 4
    # THE GATE IS THE AGREEMENT, not the answer: a Firefox that disagrees with Chrome about any of
    # the three is the finding this file exists to surface, so it is a non-zero exit and not a note.
    disagreements = []
    if found["createImageBitmapInTheRealm"] != "function":
        disagreements.append("createImageBitmap is %s in a Firefox process realm"
                             % found["createImageBitmapInTheRealm"])
    if found["awaited"] != "settled":
        disagreements.append("the awaited decode read %r" % found["awaited"])
    if found["settledWhileParkedInASyscall"] or found["settledWhileSpinning"]:
        disagreements.append("a decode settled while the process was blocked, which Chrome's "
                             "measurement says it cannot")
    if found["awaited"] == "settled" and pixels.get("opaqueExact") != pixels.get("opaquePx"):
        disagreements.append("the pixel round trip is not exact: %s" % json.dumps(pixels))
    if disagreements:
        print("FIREFOX DISAGREES WITH CHROME: " + "; ".join(disagreements), file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
