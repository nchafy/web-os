#!/usr/bin/env python3
"""Drive `www/m23.html` in a real Chrome and print what the page said, clause by clause.

WHY THIS EXISTS RATHER THAN A REGISTERED CHECK. M23's page is a proof page and this is the driver
that performs its gestures: the five pointer-and-key gestures the file-manager proof asks for cannot
come from the page itself, because a synthesised `PointerEvent` is `isTrusted === false` and
`setPointerCapture` refuses a pointerId no live pointer owns (constraint 175). If M23 lands a
registered check, this run is its INPUT and not its gate.

`_perform_gesture` IS IMPORTED FROM `scripts/check.py` AND NOT COPIED. It is the other half of
`www/pagekernel.mjs`'s gesture protocol and it already knows which CDP events each kind is — a
second copy here is the hand-rolled-CDP drift CLAUDE.md lists four files for. The ask/receipt loop
below is this file's own, because `drive_gestures` takes a check `Env` and there is none here.

    bench/m23-page/drive.py                       the three proofs, headless
    bench/m23-page/drive.py --headed              ...in a window you can watch
    bench/m23-page/drive.py --live                the desktop only, left open
    bench/m23-page/drive.py --control list        the four worlds and the clauses each one turns
    bench/m23-page/drive.py --control no_payloads a control, SCORED against its own declaration:
                                                  exactly those clauses red and every other green
    bench/m23-page/drive.py --dpr 2               ...and at the OTHER RATIO, where a thumbnail's
                                                  payload is resampled rather than 1:1
    bench/m23-page/drive.py --live --headless     THE BARE URL AS A GATE: the desktop must reach
                                                  `phase: live` with no thrown module (M17's bill)
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import threading
import time

REPO = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))

import cdp     # noqa: E402  (the path has to be set up first)
import check   # noqa: E402  (for `_perform_gesture`, the gesture protocol's other half)
import serve   # noqa: E402

#: What the page publishes. One global, named for the milestone, as every page here does it.
GLOB = "M23"

READ = ("(() => { const M = globalThis.%s || {}; return JSON.stringify({"
        "state: String(M.state || ''), phase: String(M.phase || ''),"
        "want: M.want || null, why: String(M.why || ''),"
        "verdict: String(M.verdict || '') }) })()" % GLOB)

#: THE FOUR WORLDS, AND THE CLAUSES EACH ONE IS DECLARED TO TURN — `{name: (query, (clauses…))}`.
#:
#: DECLARED HERE RATHER THAN TYPED AT THE COMMAND LINE, which is `Control.INVERT`'s own rule in
#: miniature: a subset kept in a shell history is a subset nobody re-runs, and a clause added to the
#: page is scored by `--control` the first time it runs rather than silently unscored. Each row
#: names a world a reader can build with one flag, and the run FAILS if the world turns a clause it
#: was not declared to turn.
#:
#: `blit_unvalidated` IS NOT HERE, and that is the finding rather than an omission: it has no world.
#: `setBlitValidated` is exported from `src/kernel/calls.mjs` and nothing calls it — there is no
#: `cfg.blitUnvalidated` in `src/kernel/kernel.mjs` — so the page measures the attempt and says so.
#: Run it with `--query blit_unvalidated=1` and read the note.
CONTROLS = {
    # The payload side-channel fails, which is the shape of every way a blit can arrive with no
    # pixels behind it. The RENDERER's world: every errno clause must hold.
    "no_payloads": ("no_payloads=1", (
        "blit.theKnownBitmapDrewEveryColourItAskedFor",
        "blit.theReadIsAByteAlphaAndNotACssFraction",
        "blit.theTranslucentPayloadComposited",
        "blit.theRendererCountedTwoBackedBlits",
        "shell.theDrawnPixelsAreThePayloadsOwn",
    )),
    # The program asks for no refusal at all, which is what says the errno clauses are coupled to
    # those six calls and not to a constant. The PICTURE must still be drawn.
    "no_refusals": ("no_refusals=1", (
        "refuse.noSuchFdIsEBADF",
        "refuse.aNegativeFdIsEBADF",
        "refuse.anFdOnAFileIsEINVAL",
        "refuse.anObjectThatNeverOfferedABitmapIsENOTSUP",
        "refuse.offeredAndNeverWrittenIsENOENT",
        "refuse.aTornPayloadIsEBADMSG",
        "refuse.theSixAttemptsAnsweredFiveDistinctErrnos",
        "refuse.theGoodFillInABadBatchWasNeverDrawn",
    )),
    # The EBADMSG attempt's payload is a WHOLE bitmap, so the kernel has nothing to refuse and the
    # batch it rode draws — which is why the blit count moves with it.
    "whole_payload": ("whole_payload=1", (
        "blit.theRendererCountedTwoBackedBlits",
        "refuse.aTornPayloadIsEBADMSG",
        "refuse.theGoodFillInABadBatchWasNeverDrawn",
        "refuse.theRefusedBatchesNeverReachedThePage",
    )),
    # `files` decodes nothing. `everyRowDrewAPictureOrItsTypeIcon` MUST HOLD, which is R26's
    # fallback: a mode with no pictures still marks every row, and that one clause is the whole
    # difference between a fallback and a blank cell.
    "no_thumbs": ("no_thumbs=1", (
        "shell.theProcessDecodedThePictures",
        "shell.everyPayloadWasReleasedOnExit",
        "shell.everyPayloadIsTheExtentThumbFitNames",
        "shell.theDrawnPixelsAreThePayloadsOwn",
        "shell.thePayloadIsTheFilesOwnPixels",
    )),
}


def drive(page, timeout: float) -> int:
    """Perform every gesture the page asks for until it reaches a terminal state.

    THE ID GUARD IS NOT OPTIONAL, and it is `drive_gestures`'s own: the page clears `want` only once
    its own poll sees the receipt, so without it the same gesture is performed two or three times —
    which for a click is a different gesture entirely.
    """
    deadline = time.monotonic() + timeout
    performed = 0
    held = False
    last = ""
    while True:
        row = json.loads(page.evaluate(READ) or "{}")
        want = row.get("want")
        if want and want.get("id") != last:
            held = check._perform_gesture(page, want, held=held)
            page.evaluate("globalThis.%s.driven = %s" % (GLOB, json.dumps(want["id"])))
            last = want["id"]
            performed += 1
            print("gesture  %-18s %s" % (want.get("kind"), want.get("id")))
            continue
        if row.get("state") in ("done", "aborted", "error"):
            return performed
        if time.monotonic() >= deadline:
            raise SystemExit(
                "the page never reached a terminal state within %.0fs: state=%r phase=%r want=%r "
                "why=%r. %d gesture(s) were performed."
                % (timeout, row.get("state"), row.get("phase"), want, row.get("why"), performed))
        time.sleep(0.02)


def clauses(evidence: dict) -> list[tuple[str, bool]]:
    """Every boolean a proof's evidence carries, in body order, less its own `ok`.

    DERIVED AND NOT LISTED, which is `held_rest`'s rule in miniature: a clause added to the page is
    scored by this driver the first time it runs, rather than silently unscored.
    """
    return [(name, value) for name, value in evidence.items()
            if isinstance(value, bool) and name != "ok"]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--live", action="store_true", help="the bare URL: the desktop, left open")
    ap.add_argument("--headed", action="store_true", help="a real window. Implied by --live")
    ap.add_argument("--headless", action="store_true", help="force headless even with --live")
    ap.add_argument("--query", action="append", default=[], help="k=v on the URL, repeatable")
    ap.add_argument("--expect-bad", default="",
                    help="comma-separated `proof.clause` names this run MUST report red, with "
                         "every other clause green. PER CLAUSE and not per proof, because a "
                         "control satisfied by any failure verifies nothing (CLAUDE.md) — a "
                         "control that turns a clause it was not about is reported as a mismatch "
                         "rather than as a pass.")
    ap.add_argument("--dpr", type=float, default=0.0,
                    help="emulate this device-pixel ratio. THE RATIO AXIS IS THE RUN'S: a "
                         "thumbnail's payload is produced at `cell * dpr` device px, so dpr 1 is "
                         "the one ratio at which a 16x16 logo is NOT resampled — and a clause right "
                         "at dpr 1 and wrong by the ratio everywhere else is the shape of defect "
                         "that cost M11, M12 and M16 (constraint 264)")
    ap.add_argument("--viewport", default="1280x900", help="WxH with --dpr, CSS px")
    ap.add_argument("--port", type=int, default=0, help="0 asks the OS for a free port")
    ap.add_argument("--timeout", type=float, default=300.0)
    ap.add_argument("--hold", type=float, default=0.0,
                    help="with --live, seconds to leave the desktop up before exiting. 0 and "
                         "headless makes the live run a GATE that returns rather than waiting")
    ap.add_argument("--out", default="", help="write the whole report as JSON to this path")
    ap.add_argument("--control", default="",
                    help="run one of the declared worlds in CONTROLS, scored against the clauses "
                         "it is declared to turn. `--control list` prints the table.")
    args = ap.parse_args(argv)

    if args.control == "list":
        for name, (query, turns) in sorted(CONTROLS.items()):
            print("%-14s ?%s turns %d clause(s)" % (name, query, len(turns)))
            for clause in turns:
                print("   %s" % clause)
        return 0
    if args.control:
        if args.control not in CONTROLS:
            print("no control named %r; %s are the four"
                  % (args.control, ", ".join(sorted(CONTROLS))))
            return 2
        query, turns = CONTROLS[args.control]
        args.query = list(args.query) + [query]
        args.expect_bad = ",".join(turns)

    # BOUND BEFORE ANYTHING IS PRINTED, so the port in the URL is the port that is listening.
    # `serve.Server` is the same COOP/COEP handler `scripts/serve.py` installs; in-process means
    # there is no second interpreter whose failure could go unread.
    os.chdir(REPO)
    httpd = serve.Server(("127.0.0.1", args.port), serve.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    headed = args.headed or (args.live and not args.headless)

    query = list(args.query)
    if not args.live:
        query.insert(0, "proofs=1")
    url = "http://127.0.0.1:%d/www/m23.html" % port
    if query:
        url += "?" + "&".join(query)
    print("url      %s" % url)
    print("mode     %s" % ("headed" if headed else "headless"))

    with cdp.Browser(extra_args=("--window-size=1400,1000",) if headed else (),
                     headless=not headed) as browser:
        page = browser.page()
        # BEFORE THE NAVIGATION, because the page reads the ratio at boot and sizes a surface from
        # the client box it was given: an emulation applied afterwards is a resize and not a world.
        if args.dpr > 0:
            w, _, h = args.viewport.partition("x")
            page.emulate_device(width=int(w), height=int(h), scale_factor=args.dpr, mobile=False)
        page.navigate(url)
        if args.live:
            # NOT A SLEEP: the bare URL is the PRODUCT and this is its gate. `stageDesktop` sets
            # `phase` to `live` only after every program's window has arrived, so waiting on it is
            # waiting for the desktop a reader would see — and M17's bill was a bare URL that threw
            # while the `?proofs=1` suite stayed green.
            deadline = time.monotonic() + args.timeout
            state = ""
            while time.monotonic() < deadline:
                row = json.loads(page.evaluate(READ) or "{}")
                state = row.get("phase") or ""
                if state == "live" or row.get("state") in ("error", "aborted"):
                    break
                time.sleep(0.05)
            row = json.loads(page.evaluate(READ) or "{}")
            frames = json.loads(page.evaluate(
                "JSON.stringify(globalThis.%s.frames ? globalThis.%s.frames() : null)"
                % (GLOB, GLOB)) or "null")
            log = page.evaluate("document.getElementById('log').textContent") or ""
            print()
            print(log.rstrip())
            print()
            print("phase    %s" % row.get("phase"))
            print("state    %s" % row.get("state"))
            if row.get("why"):
                print("why      %s" % row["why"])
            for f in frames or []:
                print("frame    %s" % json.dumps(f))
            if args.hold > 0:
                time.sleep(args.hold)
            elif headed:
                print("live     the desktop is up. Ctrl-C to end it.")
                try:
                    while True:
                        time.sleep(1)
                except KeyboardInterrupt:
                    return 0
            # THE PRODUCT PATH IS A GATE: a desktop that never reached `live`, or a module that
            # threw on the way, is a failure however green the proofs path is.
            return 0 if (row.get("phase") == "live" and not row.get("why")) else 1
        performed = drive(page, args.timeout)
        report = json.loads(page.evaluate(
            "JSON.stringify({state: %(g)s.state, verdict: %(g)s.verdict || '', "
            "why: %(g)s.why || '', dpr: %(g)s.dpr || 0, notes: %(g)s.notes, "
            "errors: %(g)s.errors, faults: %(g)s.faults, "
            "groundTruth: %(g)s.groundTruth || null, proofs: %(g)s.proofs})"
            % {"g": "globalThis." + GLOB}) or "{}")
        log = page.evaluate("document.getElementById('log').textContent") or ""

    print()
    print(log.rstrip())
    print()
    red = []
    redClauses = []
    total = 0
    for name, proof in sorted((report.get("proofs") or {}).items()):
        if not proof:
            print("%-8s NOT DRIVEN" % name)
            red.append(name)
            redClauses.append("%s.*" % name)
            continue
        rows = clauses(proof.get("evidence") or {})
        total += len(rows)
        bad = [c for c, ok in rows if not ok]
        redClauses += ["%s.%s" % (name, c) for c in bad]
        print("%-8s %s  %d/%d clause(s)" % (name, "ok " if proof.get("ok") else "BAD",
                                            len(rows) - len(bad), len(rows)))
        for clause, ok in rows:
            print("   %s %s" % ("ok " if ok else "BAD", clause))
        if not proof.get("ok"):
            red.append(name)
    for note in report.get("notes") or []:
        print("note     %s" % note)
    for row in (report.get("errors") or []) + (report.get("faults") or []):
        print("error    %s" % json.dumps(row))
    print()
    print("dpr      %s" % report.get("dpr"))
    print("clauses  %d, %d red" % (total, len(redClauses)))
    print("gestures %d performed" % performed)
    print("verdict  %s" % (report.get("verdict") or report.get("state")))
    if report.get("why"):
        print("why      %s" % report["why"])

    if args.out:
        pathlib.Path(args.out).write_text(json.dumps(report, indent=1), encoding="utf-8")
        print("wrote    %s" % args.out)

    # A CONTROL IS SCORED ON WHICH PROOFS MOVED, and a run that turned something else is a run that
    # verified nothing about what it names (CLAUDE.md: a control must move a NAMED subset).
    if args.expect_bad:
        want = sorted(n for n in args.expect_bad.split(",") if n)
        got = sorted(redClauses)
        if got != want:
            print("CONTROL  MISMATCH")
            for name in sorted(set(want) - set(got)):
                print("   held   %s (the control was declared to turn it)" % name)
            for name in sorted(set(got) - set(want)):
                print("   turned %s (the control was not declared to turn it)" % name)
            return 4
        print("CONTROL  %d clause(s) red and exactly the %d declared: %s"
              % (len(got), len(want), ", ".join(got)))
        return 0
    return 1 if red else 0


if __name__ == "__main__":
    raise SystemExit(main())
