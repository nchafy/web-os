#!/usr/bin/env python3
"""M2a's gate: the fs codecs under plain Node, plus a fuzz run over torn journals.

A host-side gate rather than a check in scripts/check.py, for the same reason check_links.py is
one: there is no page and no browser here, and the whole value of M2a is that these codecs run in
milliseconds without either. scripts/check.py drives Chrome; forcing a browserless check through
it would mean launching one to ignore it.

Three things it enforces, and the third is what makes the first two worth reading:

  1. The host tests pass            — round-trips, and every refusal reason named.
  2. The fuzzer finds nothing       — no crash, and no silent acceptance of a record that was
                                      never encoded.
  3. The fuzzer CAN find something  — run with the CRC check removed, it must immediately report
                                      silent acceptances. A fuzzer nobody has seen find a bug is
                                      a fuzzer nobody has checked (constraint 39's shape).

Usage:
    scripts/fsfuzz.py                 # the gate
    scripts/fsfuzz.py --cases 50000   # longer run
    scripts/fsfuzz.py --seed 777      # a different corpus; a finding is reported by seed
"""

from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
HOSTTEST = REPO / "bench" / "fs-fuzz" / "hosttest.mjs"
FUZZ = REPO / "bench" / "fs-fuzz" / "fuzz.mjs"


def run_node(script: pathlib.Path, *args: str) -> tuple[int, dict | None, str]:
    node = shutil.which("node")
    if not node:
        # Named, not swallowed: a gate that cannot reach its interpreter must say so rather than
        # report nothing found.
        return 127, None, "node is not on PATH, so nothing was measured"
    proc = subprocess.run(
        [node, str(script), *args], capture_output=True, text=True, timeout=600,
    )
    try:
        return proc.returncode, json.loads(proc.stdout), proc.stderr
    except json.JSONDecodeError:
        return proc.returncode, None, (proc.stdout + proc.stderr)[-2000:]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cases", type=int, default=10000)
    ap.add_argument("--seed", type=int, default=12345)
    args = ap.parse_args(argv)

    print(f"fsfuzz.py  node {shutil.which('node') or 'MISSING'}  seed {args.seed}  "
          f"cases {args.cases}")

    rc, host, err = run_node(HOSTTEST)
    if host is None:
        print(f"  host tests  COULD NOT RUN: {err}", file=sys.stderr)
        return 3
    print(f"  host tests  {host['total'] - host['failed']}/{host['total']} pass")
    for f in host.get("failures", []):
        print(f"     FAIL {f['name']}: {json.dumps(f)[:300]}", file=sys.stderr)

    rc, fuzz, err = run_node(FUZZ, "--seed", str(args.seed), "--cases", str(args.cases))
    if fuzz is None:
        print(f"  fuzz        COULD NOT RUN: {err}", file=sys.stderr)
        return 3
    print(f"  fuzz        {fuzz['cases']} cases · {fuzz['truncations']} truncations · "
          f"{fuzz['bitFlips']} bit flips · {fuzz['recordsAccepted']} records accepted")
    print(f"              crashes {fuzz['crashes']} · silent acceptances "
          f"{fuzz['silentAcceptances']}")
    for f in fuzz.get("findings", [])[:6]:
        print(f"     {f['kind']}: {json.dumps(f)[:300]}", file=sys.stderr)

    # The negative control. Without the CRC check the fuzzer MUST find silent acceptances, or the
    # clean run above was not evidence of anything.
    rc_nc, nocrc, err = run_node(FUZZ, "--seed", str(args.seed),
                                 "--cases", str(args.cases), "--no-crc")
    if nocrc is None:
        print(f"  control     COULD NOT RUN: {err}", file=sys.stderr)
        return 3
    found = nocrc["silentAcceptances"]
    print(f"  control     --no-crc found {found} silent acceptance(s) "
          f"({'the fuzzer can fail' if found else 'THE FUZZER PROVES NOTHING'})")

    problems = []
    if host["failed"]:
        problems.append(f"{host['failed']} host test(s) failed")
    if not fuzz["crc32SelfTest"]["ok"]:
        problems.append("crc32 does not match its published check value")
    if fuzz["crashes"]:
        problems.append(f"{fuzz['crashes']} crash(es) in replay")
    if fuzz["silentAcceptances"]:
        problems.append(f"{fuzz['silentAcceptances']} silent acceptance(s) WITH the CRC check")
    if found == 0:
        problems.append("the --no-crc control found nothing, so the clean run is not evidence")
    if fuzz["recordsAccepted"] == 0:
        problems.append("no record was accepted in any case, so replay was never exercised")

    if problems:
        print("fsfuzz.py: " + "; ".join(problems), file=sys.stderr)
        return 1
    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
