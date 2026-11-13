#!/usr/bin/env python3
"""M0: the syscall channel under closed-loop contention.

Binds `scripts/serve.py`'s Handler on the REPOSITORY ROOT — the bench page imports `/src/abi.mjs`
and `/bench/syscall-contention/summarise.mjs`, and copying `src/` into `www/` would be the
hand-synced-copy defect — then drives headless Chrome through `scripts/cdp.py`.

ONE FRESH BROWSER PER CELL. `terminate()` on the kernel worker does not reap its nested process
workers (constraint 14: a terminated worker ran on to 2004-2051 ms), so a second cell in one
renderer would take its numbers while up to N orphans from the previous cell still held worker
slots and competed for the renderer. A new browser removes that class rather than detecting it,
and the quiescence assertion below is what proves each cell started empty.

IT ABORTS WITHOUT PRINTING A FIGURE unless `crossOriginIsolated` is true in the page, in the
kernel worker and in every process. `scripts/serve.py --no-isolation` exists to prove that path is
taken; `--no-isolation` here runs it.

    bench/syscall-contention/probe.py --smoke
    bench/syscall-contention/probe.py --n 1,4,16,64,128 --window-ms 3000 --runs 3
    bench/syscall-contention/probe.py --no-isolation
    bench/syscall-contention/probe.py --serve-only      # the page in your own browser
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

HERE = Path(__file__).resolve().parent
BARS = json.loads((HERE / "bars.json").read_text(encoding="utf-8"))

#: The measurement names its own origin, and the repo's figures were taken on a DIFFERENT patch
#: build, so every number printed here carries that sentence.
PROVENANCE = (
    "docs/CONSTRAINTS.md's figures were taken on Chrome 157.0.8103.38; this run names its own "
    "build below. A different patch build is a different measurement."
)

#: The designed trade, named where the reader meets the -EIO. The ceiling itself is derived once in
#: the page (`config.busyCeilingMs`) and read from there; this is only the sentence.
BUSY_CEILING_NOTE = (
    "a kernel that is ALIVE but synchronously busy for longer than this is declared dead by every "
    "parked process. Constraint 46 leaves no alternative — elapsed time alone must never fault a "
    "process, so the heartbeat is the only liveness signal — which makes this a hard ceiling on "
    "any synchronous kernel work, M2's flush and snapshot included."
)


class Serving:
    """serve.py's Handler on an ephemeral port, in a thread, rooted at the repository."""

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
    """The full build, from CDP. `navigator.userAgent` in headless reports a REDUCED version
    (157.0.0.0), and a figure that cannot name its patch build cannot be compared with
    docs/CONSTRAINTS.md's."""
    product = (page.call("Browser.getVersion") or {}).get("product", "")
    match = re.search(r"Chrome/([\d.]+)", product)
    return match.group(1) if match else (product or "unknown")


# --------------------------------------------------------------------------- quiescence


def target_census(page) -> dict[str, int]:
    """Every target this browser holds, counted by kind."""
    census: dict[str, int] = {}
    for info in (page.call("Target.getTargets") or {}).get("targetInfos", []):
        kind = info.get("type") or "?"
        census[kind] = census.get(kind, 0) + 1
    return census


def quiescence(page) -> dict:
    """Assert the renderer holds no dedicated worker before this cell takes a figure.

    A dedicated-worker target is a kernel or a process. The profile is throwaway and the browser
    was launched for this cell, so any one of them belongs to a previous cell — alive, holding a
    worker slot against constraint 17's cap, and competing for the renderer. Measured: after a
    four-process cell finished, five worker targets were still listed 6.1 s later.

    A cell that cannot establish this reports INVALID and no number. `--reuse-browser` is the
    control that makes it fail.
    """
    census = target_census(page)
    live = census.get("worker", 0)
    limit = BARS["quiescence_max_workers"]
    return {
        "ok": live <= limit,
        "workers": live,
        "limit": limit,
        "census": census,
        "how": "CDP Target.getTargets, counting targets of type 'worker' (a dedicated worker: "
               "this bench's kernel or one of its processes) before the page is navigated",
    }


# --------------------------------------------------------------------------- driving one cell


def drive(page, url: str, *, timeout: float) -> dict:
    """Load the bench page and wait for it to finish or abort. A harness that cannot read what it
    was pointed at MUST fail rather than report clean, so a never-finishing page raises."""
    page.navigate(url)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = page.evaluate("globalThis.M0 && globalThis.M0.state")
        if state in ("done", "aborted", "error"):
            return json.loads(page.evaluate("JSON.stringify(globalThis.M0)"))
        time.sleep(0.1)
    raise CDPError(f"the bench page never reached a terminal state within {timeout}s")


def query(args, n: int, *, depth: bool) -> str:
    q = [f"n={n}", f"window_ms={args.window_ms}",
         f"call={args.call}", f"payload={args.payload}", f"warmup={args.warmup}"]
    if args.stall_us:
        q.append(f"stall_us={args.stall_us}")
    if args.think_us:
        q.append(f"think_us={args.think_us}")
    if args.truncate_overflow:
        q.append("truncate_overflow=1")
    if args.spawn_then_park:
        q.append("spawn_then_park=1")
    if args.kill_kernel:
        q.append("kill_kernel=1")
    if args.park_ms:
        q.append(f"park_ms={args.park_ms}")
        q.append(f"kill_after_ms={args.kill_after_ms}")
    if not depth:
        q.append("depth=0")
    if args.hb:
        q.append("hb=1")
    if args.overflow:
        q.append("overflow=1")
    if args.force_not_equal:
        q.append("force_not_equal=1")
    if args.over_cap:
        q.append("over_cap=1")
    if args.fault_index >= 0:
        q.append(f"fault_index={args.fault_index}")
    return "&".join(q)


def run_cell(args, serving: Serving, n: int, *, depth: bool, shared) -> dict:
    """One cell, in its own browser unless --reuse-browser was asked for."""
    with contextlib.ExitStack() as stack:
        if shared is not None:
            page = shared
        else:
            browser = stack.enter_context(Browser())
            page = browser.page()
        quiet = quiescence(page)
        version = chrome_full_version(page)
        if not quiet["ok"]:
            return {
                "state": "done",
                "chrome": version,
                "quiescence": quiet,
                "cells": [{
                    "n": n, "instrumented": depth, "invalid": True, "verdict": "INVALID",
                    "why": f"quiescence failed at cell start: {quiet['workers']} dedicated-worker "
                           f"target(s) from a previous cell are still live "
                           f"(limit {quiet['limit']}). No figure is taken.",
                }],
            }
        # Under --wrong-root the server is rooted at ./www as CLAUDE.md documents, so the page
        # itself is at /m0.html and every import below it 404s. That is the whole control.
        path = "/m0.html" if args.wrong_root else "/www/m0.html"
        url = f"http://127.0.0.1:{serving.port}{path}?{query(args, n, depth=depth)}"
        budget = 120 + args.window_ms / 1000 + 90
        m0 = drive(page, url, timeout=budget)
    m0["chrome"] = version
    m0["quiescence"] = quiet
    for cell in m0.get("cells", []):
        cell["instrumented"] = depth
        # The machine travels WITH the cell: the agent count is N-dependent, and a sweep merges
        # cells from several page loads under one header.
        cell["machine"] = dict(m0.get("machine") or {}, chrome=version)
    return m0


# --------------------------------------------------------------------------- the kernel lint


ATOMICS_WAIT = "Atomics.wait"


def kernel_never_parks() -> tuple[bool, str]:
    """Enforcement (i) of "the kernel never blocks": the string must NOT occur in src/kernel/ and
    MUST occur in src/libos/syscall.mjs. The detector is then run against a fixture containing the
    string, so it is shown capable of firing — a detector nobody has seen fire is not a check."""
    offenders = [
        str(p.relative_to(REPO))
        for p in sorted((REPO / "src" / "kernel").glob("*.mjs"))
        if ATOMICS_WAIT in p.read_text(encoding="utf-8")
    ]
    stub = (REPO / "src" / "libos" / "syscall.mjs").read_text(encoding="utf-8")
    present = ATOMICS_WAIT in stub
    fired_on_fixture = ATOMICS_WAIT in f"function f() {{ {ATOMICS_WAIT}(a, 0, 0, 1) }}"
    ok = not offenders and present and fired_on_fixture
    detail = (
        f"src/kernel offenders {offenders or 'none'} · "
        f"present in src/libos/syscall.mjs {present} · "
        f"detector fired against its fixture {fired_on_fixture}"
    )
    return ok, detail


# --------------------------------------------------------------------------- printing


#: Quiescence is asserted inside this browser only (CDP `Target.getTargets`), so load from any
#: other process on the host is invisible to every number below.
QUIESCENCE_SCOPE_NOTE = (
    "quiescence is BROWSER-SCOPED: it asserts this renderer holds no leftover worker, and it "
    "cannot see competing load elsewhere on the machine. Other work on this host would move every "
    "figure below with nothing in this output revealing it."
)


def write_results(out_dir: Path, name: str, payload) -> bool:
    """Persist a finished measurement, or say which path could not take it.

    The failure this exists for: pathlib.write_text raised FileNotFoundError at the END of an
    otherwise clean run and the whole measurement went with the traceback. The directory is
    created here as well as at start-up, because the worst moment to discover a missing output
    directory is after the figures have been taken.
    """
    path = out_dir / name
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except OSError as error:
        print(f"  the measurement finished and could NOT be written to {path}: {error}. "
              f"The figures printed above are the whole result; nothing on disk carries them.",
              file=sys.stderr)
        return False
    print(f"  wrote {path}")
    return True


def print_header(m0: dict) -> None:
    cfg = m0.get("config") or {}
    mach = m0.get("machine") or {}
    print(f"m0 · syscall channel under closed-loop contention")
    print(f"  machine   Chrome {m0.get('chrome')} · headless · "
          f"{mach.get('platform')} · navigator.hardwareConcurrency "
          f"{mach.get('hardwareConcurrency')} logical cores · dpr {mach.get('dpr')}")
    print(f"            {PROVENANCE}")
    print(f"            {QUIESCENCE_SCOPE_NOTE}")
    print(f"  isolated  page {m0.get('isolated')} · kernel {m0.get('kernelIsolated')}")
    print(f"  abi       page {m0.get('pageFingerprint')} · kernel {m0.get('kernelFingerprint')}")
    print(f"  config    rearm {cfg.get('rearmMs')} ms · hb period {cfg.get('hbPeriodMs')} ms · "
          f"hb miss limit {cfg.get('hbMissLimit')} · death threshold "
          f"{cfg.get('deathThresholdMs')} ms = rearm x (miss limit + 1)")
    print(f"            cap {cfg.get('procCap')} · MAX_INLINE {cfg.get('maxInline')} · "
          f"window {cfg.get('windowMs')} ms · warm-up {cfg.get('warmupCalls')} calls/process")
    print(f"  cfg echo  {json.dumps(m0.get('cfgEcho'))}")
    print(f"  preflight module graph {len((m0.get('preflight') or {}).get('graph') or [])} URLs, "
          f"unreachable {((m0.get('preflight') or {}).get('missing') or []) or 'none'}")
    agree = m0.get("agreementSelfTest") or {}
    print(f"  self-test counter agreement: identical {agree.get('identical')} · "
          f"disjoint {agree.get('disjoint')} · half {agree.get('half')} · "
          f"unobserved {agree.get('unobserved')} -> "
          f"{'spans 0..1 as claimed' if agree.get('ok') else 'THE FIGURE IS BROKEN'}")
    pct = m0.get("percentileSelfTest") or {}
    print(f"  self-test percentiles against hand-computed answers (q={pct.get('q')}): "
          f"{len(pct.get('want') or {})} vectors -> "
          + ("every answer matches" if pct.get("ok")
             else f"WRONG: {pct.get('wrong')} got {pct.get('got')} want {pct.get('want')}"))
    print(f"  trade     busy ceiling {cfg.get('busyCeilingMs')} ms = rearm x miss limit: "
          f"{BUSY_CEILING_NOTE}")


def print_quiescence(m0s: list[dict]) -> None:
    print()
    print("  QUIESCENCE AT CELL START (one fresh browser per cell; constraint 14, constraint 17)")
    for m0 in m0s:
        q = m0.get("quiescence") or {}
        ns = ",".join(str(c["n"]) for c in m0.get("cells", [])) or "?"
        print(f"   N={ns:<5} {'ok' if q.get('ok') else 'FAILED -> cell INVALID'}: "
              f"{q.get('workers')} dedicated-worker target(s), limit {q.get('limit')} · "
              f"census {q.get('census')}")
    print(f"   asserted by: {(m0s[0].get('quiescence') or {}).get('how')}")


def print_cells(cells: list[dict], m0: dict) -> None:
    good = [c for c in cells if not c.get("invalid")]
    # The clamp, beside every figure it applies to and not only in the page's own log: the cell
    # asks the kernel for N + 1 processes when an observer is wanted, and at N = PROC_CAP that is
    # one more than the table has. A clamp nobody printed is a figure labelled with an N the
    # reader chose and the run did not use.
    for c in cells:
        clamp = c.get("clamp")
        if clamp:
            print()
            print(f"  N={c['n']}  CLAMPED — {clamp['why']}")
    for c in cells:
        if c.get("invalid"):
            print()
            print(f"  N={c['n']}  INVALID — {c['why']}")
            for f in c.get("faults") or []:
                print(f"         fault: pid {f['pid']}: {f['why'].splitlines()[0]}")
    if not good:
        return
    print()
    print("   N  instr  procs  calls      thru/s   mean      p50        p95        p99            "
          "worst-p99  >bar          max")
    for c in good:
        q = c["quantumUs"]
        print(f"  {c['n']:>3}  {'yes' if c['instrumented'] else 'NO ':>5}  "
              f"{c['isolatedProcesses']:>5}  {c['count']:>9}  "
              f"{c['throughputPerS']:>8.0f}  {c['meanUs']:>7.2f}us  "
              f"{c['p50']['text']:<10} {c['p95']['text']:<10} {c['p99']['text']:<14} "
              f"{c['worstP99Us']:>8.1f}  "
              f"{c['exceedAccept']['count']} ({c['exceedAccept']['fraction'] * 100:.3f}%)  "
              f"{c['maxUs']:>8.1f}   [quantum {q:.3f} us]")
    print()
    print("  ACHIEVED CONCURRENCY (the kernel's view, inside the barrier-held window only)")
    print("   N  depth_p50  depth_max  depth_p01  q_frac  little  duty_min  rho    agents/cores")
    for c in good:
        d = c["depth"]
        mach = c.get("machine") or {}
        cores = mach.get("hardwareConcurrency")
        agents = mach.get("agents")
        # The page reports both, so a missing value means an older results file, not a 1.00x host.
        ratio = (f"{agents}/{cores} ({agents / cores:.2f}x)" if cores and agents
                 else "not reported by the page")
        print(f"  {c['n']:>3}  {d['p50']:>9}  {d['max']:>9}  {d['p01']:>9}  "
              f"{d['queuedFraction']:>6.3f}  {c['little']:>6.3f}  {c['dutyMin']:>8.3f}  "
              f"{c['rho']:>5.3f}  {ratio}")
    print("   agents/cores: N process workers + the kernel worker + the main thread against "
          "navigator.hardwareConcurrency. Above 1.00x the processes are oversubscribed and the "
          "wake latency inside every figure is partly a scheduling queue.")
    print()
    print("  WITNESSES — REPORTED, NOT CHECKED. No value of either can fail a run, by design.")
    for c in good:
        d = c["depth"]
        empty = "" if d["dispatches"] else "  <-- the window histogram is EMPTY: no dispatch was " \
                                          "taken inside a saturated window, so these two read 0 " \
                                          "for want of samples (see A8)"
        print(f"   N={c['n']:<4} depth_min {d['min']} · dispatches at depth <= 1 {d['atOne']} of "
              f"{d['dispatches']} ({d['atOneFraction'] * 100:.3f}%){empty}")
    print("   why they are witnesses: reply() decrements G_INFLIGHT before the woken process "
          "re-issues (src/kernel/kernel.mjs), so every")
    print("   process has an un-outstanding interval equal to its own wake latency; over hundreds "
          "of thousands of dispatches those")
    print("   intervals coincide across all N at least once, which makes depth_min read 1 on a "
          "saturated kernel AND 1 on a rate-limited")
    print("   one. It does not discriminate, so it does not gate. The gate on the same question is "
          "A2b, over the median.")
    print()
    print("  THE ANTI-VACUITY GATES (any evaluated clause failing at the bar's N => NO VERDICT)")
    for c in good:
        print(f"   N={c['n']}")
        for row in c["gates"]["rows"]:
            mark = "ok  " if row["pass"] else "FAIL"
            if not row.get("evaluated", True):
                mark = "n/a "
            print(f"     {mark} {row['name']:<42} {row['detail']}")
    print()
    print("  THE BARRIER (without it the windows are staggered and the first dispatch of each "
          "sees depth 1)")
    for c in good:
        o = c.get("overlap")
        b = c.get("barrier") or {}
        da = c.get("depthAll") or {}
        if o:
            print(f"   N={c['n']:<4} windows overlap {o['overlapMs']} ms of "
                  f"{m0['config']['windowMs']} ms ({o['fraction'] * 100:.2f}%) over "
                  f"{o['processes']} processes · release spread {o['releaseSpreadMs']} ms · "
                  f"end spread {o['endSpreadMs']} ms")
        else:
            print(f"   N={c['n']:<4} no overlap measured")
        print(f"         kernel: {b.get('phase')} · arrivals took {b.get('goToReleaseMs')} ms "
              f"from go to release · saturates at {b.get('saturateAt')} outstanding calls · "
              f"failed {b.get('failed') or 'no'}")
        dr = c.get("depthRamp") or {}
        print(f"         release ramp (released -> first N outstanding): "
              f"{dr.get('dispatches')} dispatches, depth {dr.get('min')}..{dr.get('max')}; "
              f"reached N: {c.get('saturated')}")
        print(f"         depth over ALL dispatches since boot (warm-up and ramp included): "
              f"p50 {da.get('p50')} min {da.get('min')} max {da.get('max')} over "
              f"{da.get('dispatches')} — the gates read the window histogram above")
    print()
    print("  HEARTBEAT GAP (Decision 2: this distribution is the input that sets HB_MISS_LIMIT)")
    for c in good:
        hb = c.get("heartbeat")
        if hb:
            print(f"   N={c['n']:<4} observer process: advances {hb['advances']:>6}  "
                  f"p50 {hb['p50Ms']:.3f} ms  p99 {hb['p99Ms']:.3f} ms  "
                  f"p999 {hb['p999Ms']:.3f} ms  max {hb['maxMs']:.3f} ms")
        else:
            print(f"   N={c['n']:<4} observer not spawned (pass --hb)")
        k = c.get("hbGapKernel")
        if k:
            # A percentile past the top bin prints as such. Clamping it to the top bin would
            # report a 128 ms figure for a 400 ms gap, and the top bin is the one place this
            # histogram cannot answer the question.
            def ms(value, top=k["topMs"]):
                return f"> {top} ms" if value is None else f"{value:.3f} ms"
            print(f"         kernel tick gap, bounded histogram: {k['count']} gaps · "
                  f"mean {k['meanMs']:.3f} ms · p50 {ms(k['p50Ms'])} · "
                  f"p99 {ms(k['p99Ms'])} · p999 {ms(k['p999Ms'])} · "
                  f"max {k['maxMs']:.3f} ms · past the top bin {k['over']}")
    print()
    print("  INTEGRITY")
    for c in good:
        a = c["accounting"]
        print(f"   N={c['n']:<4} issued {a['issued']} dispatched {a['dispatched']} "
              f"replied {a['replied']} returned {a['returned']} -> identity "
              f"{'holds' if a['identity'] else 'BROKEN (run INVALID)'}")
        print(f"         wait: ok {a['ok']} · not-equal {a['notEqual']} "
              f"({a['notEqualFraction'] * 100:.3f}%, tallied not asserted — it is "
              f"reply-latency dependent) · "
              f"timed-out {a['timedOut']} · timed-out-but-replied {a['timedOutButReplied']} · "
              f"spurious {a['spurious']} · seqSkip {a['seqSkip']} · hostGone {a['hostGone']}")
        agreement = a["raceAgreement"]
        agreement_text = ("no not-equal event on either side, so there is nothing to agree about"
                          if agreement is None else f"agree to {agreement * 100:.1f}%")
        print(f"         notify-woke-0 {a['notify0']} vs not-equal {a['notEqual']} "
              f"({agreement_text}; gate A9 above) · notifyWoke {a['notifyWoke']} · "
              f"badCallId {a['badCallId']} · lateReply {a['lateReply']} · dropped {a['dropped']}")
        if a["hostGone"]:
            print(f"         {a['hostGone']} process(es) returned -EIO on the heartbeat: "
                  f"busy ceiling {m0['config']['busyCeilingMs']} ms — {BUSY_CEILING_NOTE}")
        print(f"         histogram samples no bin can represent: {a['beyondTop']}"
              f"{'' if a['beyondTop'] == 0 else '  <-- RUN INVALID'}")
        kinds = c.get("envKinds") or []
        leak = [k for k in kinds if k in ("buffer", "port")]
        print(f"         constraint 15: the program was handed {len(kinds)} values, "
              f"kinds {sorted(set(kinds))} -> {'no transferable object' if not leak else 'LEAK: ' + str(leak)}")
        if c.get("forced"):
            got = sum(1 for f in c["forced"] if f["notEqual"])
            print(f"         forced not-equal (post, spin, park): {got}/{len(c['forced'])}")
        if c.get("overflow"):
            o = c["overflow"]
            print(f"         overflow: len 0 -> {o['zero']} · MAX_INLINE -> {o['exact']} in 1 call · "
                  f"MAX_INLINE+1 via layer 2 -> {o['overReturned']} in {o['overCalls']} calls · "
                  f"1 MiB -> {o['megabyteWrote']} in {o['megabyteCalls']} calls · "
                  f"raw length MAX_INLINE+1 -> r0 {o['rawOverLength']} r1 {o['rawOverR1']}")
            sinks = c.get("sinks") or []
            match = sum(1 for s in sinks
                        if s["sinkSum"] == s["sentSum"] and s["sinkBytes"] == s["sentBytes"])
            total = sum(s["sinkBytes"] for s in sinks)
            print(f"         write checksum + byte count, process vs kernel sink: "
                  f"{match}/{len(sinks)} match · {total} bytes delivered")
        print(f"         kernel in-handler mean {c['serviceMeanUs']:.2f} us · "
              f"ready in {c['readyMs']:.0f} ms")
        print(f"         one named getpid round trip per process: returned "
              f"{c['firstGetpid']} for pids {c['pids']} -> "
              f"{'right pid' if c['firstGetpidOk'] else 'WRONG PID'}")
        # Three sources for one fact, and the third is the only one outside the kernel: the pid
        # the kernel's table holds, the pid its getpid answered, and the pid the PROCESS was
        # handed at spawn and reports from userland.
        env_pids = c.get("envPids") or []
        print(f"         self-reported pid (env.pid, what a program reads): {env_pids} -> "
              f"{'agrees with the kernel' if env_pids == c['pids'] else 'DISAGREES WITH THE KERNEL'}"
              f" · replies in the window that were not the caller's own pid: {c.get('windowWrong')}")
        w = c.get("p99Witness")
        print(f"         headline read at q={c.get('p99Quantile')} · counting witness: "
              + ("not computed (no printable p99)" if not w else
                 f"{w['atOrAboveFraction'] * 100:.3f}% at or above it, "
                 f"{w['aboveFraction'] * 100:.3f}% strictly above, tail {w['tail'] * 100:.3f}% -> "
                 f"{'the printed number is that quantile' if w['ok'] else 'IT IS NOT THAT QUANTILE'}")
              + f" · worst per-process p99 {c['worstP99Us']:.1f} us")


def print_overhead(cells: list[dict]) -> None:
    """The instrumentation's own cost, as a first-class row. The HEADLINE stays the instrumented
    number — the slower, honest one — and this is what it costs."""
    pairs = {}
    for c in cells:
        if c.get("invalid"):
            continue
        pairs.setdefault(c["n"], {})[bool(c["instrumented"])] = c
    rows = [(n, p[True], p[False]) for n, p in sorted(pairs.items()) if True in p and False in p]
    if not rows:
        return
    print()
    print("  INSTRUMENTATION OVERHEAD (paired, same N, same window, separate fresh browsers)")
    print("   N   mean instr   mean --no-depth   delta      p99 instr    p99 --no-depth  delta")
    for n, a, b in rows:
        pa = a["p99"]["us"]
        pb = b["p99"]["us"]
        pd = ("n/a" if pa is None or pb is None else f"{pa - pb:+.1f}us")
        print(f"  {n:>3}  {a['meanUs']:>9.3f}us  {b['meanUs']:>13.3f}us  "
              f"{a['meanUs'] - b['meanUs']:>+8.3f}us  "
              f"{'—' if pa is None else f'{pa:.1f}us':>10}  {'—' if pb is None else f'{pb:.1f}us':>14}  {pd}")
    print()
    print("   PER-DISPATCH COST, from aggregate throughput. The per-call mean and the p99 above "
          "are the wrong instrument:")
    print("   the device is two atomic loads and two increments, tens of nanoseconds against a "
          "5 us clock quantum, so their")
    print("   difference is dominated by run-to-run variance. The reciprocal of the kernel's "
          "aggregate throughput resolves it.")
    print("   N   us/dispatch instr   us/dispatch --no-depth   delta")
    for n, a, b in rows:
        ia = 1e6 / a["throughputPerS"]
        ib = 1e6 / b["throughputPerS"]
        print(f"  {n:>3}  {ia:>16.4f}  {ib:>22.4f}  {ia - ib:>+8.4f}us")
    print("   the headline p99 stays the INSTRUMENTED number — the slower, honest one — with this "
          "delta stated beside it.")


def print_liveness(m0: dict) -> None:
    live = m0.get("liveness")
    if not live:
        return
    print()
    print("  LIVENESS (constraint 46: the heartbeat decides, the timeout only re-arms)")
    subject = "kernel-dead" if live["killed"] else "slow-reply"
    expected = live["of"] if live["killed"] else 0
    ok = live["faulted"] == expected
    print(f"   {subject}: {live['faulted']} of {live['of']} processes concluded the kernel was "
          f"gone, expected {expected} -> {'FIRED as designed' if ok else 'DID NOT BEHAVE AS DESIGNED'}")
    print(f"   one sleep of {live['sleepMs']} ms against a {m0['config']['rearmMs']} ms re-arm; "
          f"death threshold {m0['config']['deathThresholdMs']} ms "
          f"= rearm x (miss limit + 1)")
    print(f"   bound {live['boundMs']:.0f} ms = threshold x {live['boundFactor']} "
          f"(bars.json), declared once in the page and read from there; the poll ran "
          f"{live['pollSlackMs']} ms past it so an overrun could be seen rather than clipped")
    if live["killed"]:
        inside = live["withinMs"] <= live["boundMs"]
        print(f"   {live['withinMs']:.0f} ms from terminate() to all {live['of']} verdicts -> "
              f"{'inside the bound' if inside else 'OUTSIDE THE BOUND'}")
    seen = [p for p in live["perProcess"] if p["seen"]]
    if seen:
        print(f"   per-process park-entry to verdict "
              f"{[p['ms'] for p in seen]} ms for pids {[p['pid'] for p in seen]}; these start "
              f"{live['killAfterMs']} ms BEFORE the kill, so they exceed the figure above by "
              f"about that much and are not the same measurement")
        print(f"   busy ceiling {m0['config']['busyCeilingMs']} ms — {BUSY_CEILING_NOTE}")
    else:
        print("   per-process park-entry to verdict: not reached — no process concluded the "
              "kernel was gone, so the word was never written")


# --------------------------------------------------------------------- across runs, pure


def worst_rank(cell: dict) -> tuple[int, float]:
    """The sort key for "the worst run at the bar's N". ACCEPT is asserted on the maximum of this.

    An UNPRINTABLE p99 ranks ABOVE every number. The version this replaces read
    `cell["p99"]["us"] or 0`, which scored an unmeasurable cell as 0 µs — the best possible run —
    so a run that failed to measure was silently superseded by any run that did, and the
    across-runs line could report a verdict off a run with no figure in it.
    """
    us = cell["p99"]["us"]
    return (1, 0.0) if us is None else (0, us)


def across_runs_line(bar_cells: list[dict], runs: int, bar_n: int) -> str:
    """The sentence a reader quotes, and it must carry how many runs are actually behind it.

    `bar_cells` is one cell per run that produced a non-INVALID instrumented cell at the bar's N;
    `runs` is how many were launched. When they differ the sentence says so, because "ACCEPT is
    asserted on the WORST run" reads as though it covered all of them.
    """
    worst = max(bar_cells, key=worst_rank)
    survived = len(bar_cells)
    scope = (f"the WORST of {survived} run(s) that produced a figure at N={bar_n}"
             + (f", of {runs} launched — {runs - survived} did not"
                if survived != runs else f", all {runs} of {runs}"))
    return (f"  ACROSS RUNS, ACCEPT is asserted on {scope}: "
            f"{worst['verdict']} — {worst['why']}")


# --------------------------------------------------------------------------- main


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n", default="1,16", help="comma-separated process counts; ONE CELL PER "
                                               "BROWSER, in this order")
    ap.add_argument("--window-ms", type=int, default=1000)
    ap.add_argument("--warmup", type=int, default=2000)
    ap.add_argument("--call", default="getpid", choices=("getpid", "write", "nanosleep"))
    ap.add_argument("--payload", type=int, default=64)
    ap.add_argument("--runs", type=int, default=1, help="browser launches; ACCEPT reads the worst")
    ap.add_argument("--smoke", action="store_true",
                    help="N=1, one short window: kernel boots, one process spawns, getpid returns")
    ap.add_argument("--hb", action="store_true", help="spawn the heartbeat-gap observer process")
    ap.add_argument("--overflow", action="store_true", help="run the MAX_INLINE edge checks")
    ap.add_argument("--force-not-equal", action="store_true")
    ap.add_argument("--no-depth", action="store_true", help="the uninstrumented variant")
    ap.add_argument("--overhead", action="store_true",
                    help="run each N twice, instrumented and --no-depth, and print the delta")
    ap.add_argument("--stall-us", type=int, default=0, help="control 7.1: stall every handler")
    ap.add_argument("--think-us", type=int, default=0, help="control 7.2: rate-limit the callers")
    ap.add_argument("--truncate-overflow", action="store_true", help="control 7.3")
    ap.add_argument("--park-ms", type=int, default=0,
                    help="controls 7.4/7.5: every process issues one sleep this long, far past "
                         "the re-arm interval. No window is measured on this path.")
    ap.add_argument("--kill-after-ms", type=int, default=100)
    ap.add_argument("--kill-kernel", action="store_true",
                    help="control 7.4: terminate the kernel worker while they are parked. "
                         "Requires --park-ms; without it nothing is parked and nothing can fault.")
    ap.add_argument("--spawn-then-park", action="store_true", help="control 7.6")
    ap.add_argument("--no-isolation", action="store_true",
                    help="control 7.7: serve without COOP/COEP. The probe MUST abort with no "
                         "figures — the declared unmeasurable outcome.")
    ap.add_argument("--fault-index", type=int, default=-1,
                    help="control 7.8: the process at this index throws. The kernel must name the "
                         "pid and the cell must report INVALID, fast.")
    ap.add_argument("--reuse-browser", action="store_true",
                    help="control 7.9: one browser for every cell, which is what the quiescence "
                         "assertion exists to catch. It MUST report INVALID from the second cell.")
    ap.add_argument("--over-cap", action="store_true",
                    help="control 7.11: ask the kernel for PROC_CAP + 1 processes. The spawn the "
                         "hard cap refuses (constraint 17) MUST be reported as the cap, naming "
                         "the process number and the cap, and never as kernel-starved-children "
                         "— children that were never created cannot report ready, which is the "
                         "same symptom and a different cause. Use with --expect-invalid.")
    ap.add_argument("--wrong-root", action="store_true",
                    help="control 7.10: serve ./www, as CLAUDE.md documents. Every import 404s "
                         "and the module-graph preflight must say which.")
    ap.add_argument("--expect-invalid", action="store_true",
                    help="for the controls above: exit 0 only if a cell DID report INVALID")
    ap.add_argument("--serve-only", action="store_true",
                    help="serve the repository root with COOP/COEP and print the page URL, so the "
                         "page can be opened in a real browser. Ctrl-C to stop.")
    ap.add_argument("--out", default=str(HERE))
    args = ap.parse_args(argv)

    root = REPO / "www" if args.wrong_root else REPO

    # Before any browser is launched: an --out that cannot be written is a flag typo, and finding
    # out after a three-run sweep costs the sweep. Reported with the path, never as a traceback.
    out_dir = Path(args.out)
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        print(f"  --out {out_dir} cannot be created: {error}. Refusing to start: a finished "
              f"measurement with nowhere to go is a measurement lost.", file=sys.stderr)
        return 1

    if args.serve_only:
        with Serving(root, isolate=not args.no_isolation) as serving:
            print(f"  serving {root} with COOP/COEP on http://127.0.0.1:{serving.port}")
            print(f"  the page: http://127.0.0.1:{serving.port}/www/m0.html?n=4&window_ms=1000")
            print("  python3 -m http.server CANNOT serve this: no COOP/COEP, so no "
                  "SharedArrayBuffer. Ctrl-C to stop.")
            try:
                while True:
                    time.sleep(3600)
            except KeyboardInterrupt:
                return 0

    if args.smoke:
        args.n = "1"
        args.window_ms = min(args.window_ms, 200)
        args.warmup = min(args.warmup, 100)

    ns = [int(x) for x in args.n.split(",") if x]

    lint_ok, lint_detail = kernel_never_parks()
    print(f"  lint      no {ATOMICS_WAIT} in src/kernel/: "
          f"{'ok' if lint_ok else 'FAILED'} · {lint_detail}")
    if not lint_ok:
        print("  the kernel-never-blocks lint failed. No figures.", file=sys.stderr)
        return 1

    if args.overhead and args.no_depth:
        print("  --overhead measures the instrumented path against --no-depth, so it cannot be "
              "given --no-depth: there would be no instrumented side.", file=sys.stderr)
        return 1

    #: (N, instrumented). --overhead pairs each N with its uninstrumented twin.
    jobs: list[tuple[int, bool]] = []
    for n in ns:
        jobs.append((n, not args.no_depth))
        if args.overhead:
            jobs.append((n, False))

    bar_cells_per_run: list[dict] = []
    all_runs = []
    any_invalid = False
    for run_index in range(args.runs):
        with Serving(root, isolate=not args.no_isolation) as serving:
            cell_m0s: list[dict] = []
            shared = None
            shared_stack = contextlib.ExitStack()
            try:
                if args.reuse_browser:
                    shared = shared_stack.enter_context(Browser()).page()
                for n, depth in jobs:
                    m0 = run_cell(args, serving, n, depth=depth, shared=shared)
                    m0["run"] = run_index + 1
                    cell_m0s.append(m0)
                    if m0.get("state") != "done":
                        print()
                        print(f"  run {run_index + 1}, N={n}: {str(m0.get('state')).upper()} — "
                              f"{m0.get('why')}")
                        if args.no_isolation or args.wrong_root:
                            label = ("DECLARED UNMEASURABLE: no figures, as required. The negative "
                                     "control for the isolation gate fired."
                                     if args.no_isolation else
                                     "The module-graph preflight named what 404'd instead of "
                                     "leaving a blank page. The control fired.")
                            print(f"  {label}")
                            stem = "no-isolation" if args.no_isolation else "wrong-root"
                            return 0 if write_results(out_dir, f"results-{stem}.json", m0) else 1
                        return 1
            finally:
                shared_stack.close()

        cells = [c for m0 in cell_m0s for c in m0.get("cells", [])]
        # The base is the first cell that actually booted a kernel: a cell refused for failing
        # quiescence has no config to report, and reading the header off it would print a header
        # of Nones.
        merged = dict(next((m0 for m0 in cell_m0s if m0.get("config")), cell_m0s[0]))
        merged["cells"] = cells
        merged["quiescencePerCell"] = [m0.get("quiescence") for m0 in cell_m0s]
        merged["liveness"] = next(
            (m0["liveness"] for m0 in reversed(cell_m0s) if m0.get("liveness")), None)
        merged["faults"] = [f for m0 in cell_m0s for f in (m0.get("faults") or [])]
        all_runs.append(merged)
        any_invalid = any_invalid or any(c.get("invalid") for c in cells)

        if not merged.get("isolated") or not merged.get("kernelIsolated"):
            print("  isolation is not true in both agents. No figures.", file=sys.stderr)
            return 1

        print()
        print(f"  ---- run {run_index + 1} of {args.runs} ----")
        print_header(merged)
        print_quiescence(cell_m0s)
        print_cells(cells, merged)
        print_overhead(cells)
        print_liveness(merged)

        print()
        for c in cells:
            if not c.get("invalid"):
                print(f"  VERDICT N={c['n']}"
                      f"{'' if c['instrumented'] else ' (--no-depth, NOT the headline)'}  "
                      f"{c['verdict']} — {c['why']}")

        bar_cells = [c for c in cells
                     if c["n"] == BARS["bar_n"] and not c.get("invalid") and c["instrumented"]]
        bar_cells_per_run.extend(bar_cells)

    stamp = "smoke" if args.smoke else "sweep"
    print()
    wrote = write_results(out_dir, f"results-{stamp}.json", all_runs)
    if bar_cells_per_run:
        print(across_runs_line(bar_cells_per_run, args.runs, BARS["bar_n"]))
    elif args.park_ms:
        print("  no window was measured on this path: --park-ms runs the liveness controls only, "
              "and the block above is the whole result.")
    elif not args.smoke and not any_invalid:
        print(f"  N={BARS['bar_n']} was not in this sweep, so no verdict is available: the bar is "
              f"read at that N and nowhere else.")
    if args.expect_invalid:
        print(f"  --expect-invalid: a cell reported INVALID -> "
              f"{'the control fired' if any_invalid else 'IT DID NOT, and that is the failure'}")
        return 0 if any_invalid and wrote else 1
    return 1 if any_invalid or not wrote else 0


if __name__ == "__main__":
    raise SystemExit(main())
