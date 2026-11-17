#!/usr/bin/env python3
"""M2a's gate: the fs codecs under plain Node, plus a fuzz run over torn journals.

A host-side gate rather than a check in scripts/check.py, for the same reason check_links.py is
one: there is no page and no browser here, and the whole value of M2a is that these codecs run in
milliseconds without either. scripts/check.py drives Chrome; forcing a browserless check through
it would mean launching one to ignore it.

Nine things it enforces, and the controls beside them are what make the clean verdicts worth
reading:

  1. src/fs/ IS PURE                — no module there names a storage, SAB or Worker API, does
                                      not suspend (no async/await), and imports nothing outside
                                      src/fs/ and src/abi.mjs.
  1b. THE LINT CAN FIRE             — each of its three rule families is run against a module
                                      written to break it. A lint whose clean verdict has never
                                      been shown capable of being dirty is a comment.
  2. The host tests pass            — round-trips, every refusal reason named, and CONSTRAINT
                                      29'S PERMISSION MODEL: three arms, both directions each.
                                      That last one is here because of what its absence cost —
                                      forcing `#may()` to return true passed every host test in
                                      three seconds and was caught only by the 60-second browser
                                      run, and deleting the group arm outright passed both.
  3. The fuzzer finds nothing       — no crash, and no silent acceptance of a record that was
                                      never encoded.
  4. The fuzzer CAN find something  — run with the CRC check removed, it must immediately report
                                      silent acceptances. A fuzzer nobody has seen find a bug is
                                      a fuzzer nobody has checked (constraint 39's shape).
  5. THE STORAGE EDGE'S LOCKS       — src/kernel/store.mjs takes the per-inode lock in its ten
                                      declared takers and nowhere else, takes the VOLUME's in its
                                      three, and reaches no taker from inside the module. A nested
                                      acquisition is a syscall that never settles; a missing one is
                                      lost bytes six rounds later.
  5b. THAT LINT CAN FIRE            — all four of its families are run against a class written to
                                      break them.
  6. THE FAILURE PATHS RUN          — bench/fs-core/edge.mjs drives the real Store against a
                                      scripted I/O worker, so an errno can land on one call and a
                                      snapshot's window can be held open. These are paths the
                                      browser proofs cannot schedule.
  6b. AND CAN FAIL                  — `edge.mjs --control` puts each fix back the way it was found,
                                      one line each, and every family must then report a failure.

(1) IS A LINT AND NOT AN IMPLICATION, which is the correction M2 made to this file. The purity
claim used to rest on "these modules run under Node", and that is not the same statement: Node
loads a module that reads `navigator.storage` perfectly happily, because the read does not happen
until something calls it. A codec could therefore reach for a sync access handle inside its parse
path, keep passing this gate, and quietly become unfuzzable — which is the exact decay M2a exists
to prevent. The lint checks the property directly.

Usage:
    scripts/fsfuzz.py                 # the gate
    scripts/fsfuzz.py --cases 50000   # longer run
    scripts/fsfuzz.py --seed 777      # a different corpus; a finding is reported by seed
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
HOSTTEST = REPO / "bench" / "fs-fuzz" / "hosttest.mjs"
FUZZ = REPO / "bench" / "fs-fuzz" / "fuzz.mjs"
#: The storage edge's failure paths. Not a codec: it imports src/kernel/store.mjs and drives it
#: against a scripted I/O worker, which is the only way to put an errno on one call.
EDGE = REPO / "bench" / "fs-core" / "edge.mjs"
FS_DIR = REPO / "src" / "fs"

#: What a pure module over byte arrays cannot name. Each is a capability, not a style preference:
#: reaching for any of them inside a parse path is what would make src/fs/ unfuzzable and turn this
#: whole gate into a comment. `Atomics` and `SharedArrayBuffer` are here with the storage APIs
#: because a codec that synchronised with another agent would stop being a total function over its
#: input.
FORBIDDEN = (
    "navigator.storage",
    "getDirectory",
    "getFileHandle",
    "getDirectoryHandle",
    "createSyncAccessHandle",
    "FileSystemSyncAccessHandle",
    "removeEntry",
    "indexedDB",
    "SharedArrayBuffer",
    "Atomics.",
    "new Worker",
    "postMessage",
    "importScripts",
    "fetch(",
    "localStorage",
    "caches.",
)

#: Forbidden as WORDS rather than as substrings, so `awaited` and `asynchronously` in an
#: identifier are not violations while `await x` is.
#:
#: WHY THEY ARE HERE WITH THE STORAGE APIS, and the point is that there is no violation today.
#: The fuzzer calls these codecs 10,000 times and reads a return value; an `await` anywhere in a
#: parse path turns that return value into a promise, every assertion over it into a truthy
#: object, and the whole 10,000-case gate into a loop that measures nothing. It is also the
#: cheapest way for a later change to reach for storage without naming it — `await
#: handle.getFile()` needs one more import to become legal. A codec in src/fs/ is a total
#: function over byte arrays, and a total function does not suspend.
FORBIDDEN_WORDS = ("async", "await")

#: The only modules src/fs/ may import. src/abi.mjs is permitted because it is pure integers and
#: pure codecs by its own standing rule, and is itself importable from Node — that is what lets an
#: errno name and a NAME_MAX have one declaration instead of two.
IMPORTS_ALLOWED = ("./", "../abi.mjs")

IMPORT_RE = re.compile(r"""(?:\bfrom|\bimport)\s*["']([^"']+)["']""")


def impurities(where: str, text: str) -> list[tuple[str, str]]:
    """Every way ONE module has stopped being a total function over byte arrays.

    Takes the text rather than the path, which is what lets the lint's own control lint a module
    that is not on disk. A lint nobody has seen fire is a lint nobody has checked.

    Each finding carries the RULE FAMILY that produced it, so the control below can be scored on
    which rules fired rather than on how many findings there were.
    """
    found: list[tuple[str, str]] = []
    # Comments name these APIs on purpose — the whole point of several of them is to say what
    # they do NOT do — so the lint reads code lines only.
    code = "\n".join(
        line for line in text.splitlines()
        if not line.lstrip().startswith(("//", "*", "/*"))
    )
    for name in FORBIDDEN:
        if name in code:
            found.append(("capability", (
                "%s names %s. src/fs/ must be PURE over byte arrays with all I/O at the edges "
                "in src/kernel/, or scripts/fsfuzz.py stops being able to fuzz it"
                % (where, name))))
    for word in FORBIDDEN_WORDS:
        if re.search(r"\b%s\b" % word, code):
            found.append(("suspension", (
                "%s uses `%s`. A codec in src/fs/ is a total function over byte arrays and must "
                "not suspend: the fuzzer reads a RETURN VALUE 10,000 times, and a promise there "
                "makes every assertion over it pass on a truthy object" % (where, word))))
    for specifier in IMPORT_RE.findall(code):
        if not specifier.startswith(IMPORTS_ALLOWED):
            found.append(("import", (
                "%s imports %s, which is outside src/fs/ and src/abi.mjs" % (where, specifier))))
    return found


#: src/kernel/store.mjs's declared takers of the per-inode lock, in the order `withInode`'s own
#: comment lists them. THE LIST IS THE RULE: every durable read-then-mutate in the storage edge
#: runs inside one of these, and a `withInode` reached from anywhere else is either a second entry
#: point nobody serialized against or a lock taken while one is already held — which deadlocks on
#: a tail only the holder can release.
#:
#: Checked here rather than at runtime because the failure has no runtime symptom worth waiting
#: for: a nested acquisition is a syscall that never settles, and a missing one is a race that
#: shows up as lost bytes six rounds later. Six rounds of attacks each found one more unserialized
#: sequence, so the set of them is the thing to hold still.
INODE_TAKERS = (
    "openFd", "writeFd", "readFd", "fsyncFd", "truncateFd", "statFd", "endFd", "closeFd",
    "sizeOf", "freeInode",
)

#: The VOLUME lock's declared takers, and the bodies that run under it. The second keyspace of the
#: same primitive: the journal's sequence counter and the superblock slot belong to no inode, so a
#: snapshot had nothing to hold that would exclude an append — measured as an op that returned
#: success to userland, destroyed by the truncate, with replay reporting no gap and fsck reporting
#: the volume clean.
#:
#: THE ORDER IS INODE THEN VOLUME, and it is the taker and nested rules above that hold it rather
#: than a rule of its own: the inode queue is entered only by the ten takers, and calling any of
#: them from inside this module is already a violation — so a volume-held body cannot reach one
#: without failing `nested` first.
VOLUME_TAKERS = ("journal", "flushJournal", "writeSnapshot")
VOLUME_HELD = ("journalHeld", "flushJournalHeld", "snapshotHeld")

STORE_PATH = REPO / "src" / "kernel" / "store.mjs"

#: A method header at class-body indentation: two spaces, an optional `async`, a name, a paren.
METHOD_RE = re.compile(r"^  (?:async\s+)?([A-Za-z_$][\w$]*)\s*\(")


def inode_lock(where: str, text: str) -> list[tuple[str, str]]:
    """Every way the storage edge's locking structure has broken, with the family that found it.

    Four families, because there are four ways to break it:

      `taker`   a `withInode` call inside a method that is not a declared taker. Either the lock
                grew a second entry point, or it is being taken by something a taker already calls
                — and the second case is the deadlock.
      `nested`  a declared taker called from inside this module. A taker takes the lock, so calling
                one from under the lock waits forever.
      `volume`  the same two rules for the VOLUME's key: taken outside its three declared takers,
                or declared and taken nowhere.
      `vnested` a volume taker reached from under the volume lock — `writeSnapshot` flushing the
                journal through the public `flushJournal` rather than the held body is exactly
                this, and it waits on a tail only itself can release.
    """
    found: list[tuple[str, str]] = []
    code = [
        line for line in text.splitlines()
        if not line.lstrip().startswith(("//", "*", "/*"))
    ]
    method = "<file scope>"
    seen: set[str] = set()
    seen_volume: set[str] = set()
    for line in code:
        header = METHOD_RE.match(line)
        if header:
            method = header.group(1)
        if "this.withInode(" in line:
            seen.add(method)
            if method not in INODE_TAKERS:
                found.append(("taker", (
                    "%s takes the per-inode lock in `%s`, which is not one of the declared takers "
                    "(%s). A lock taken from under the lock waits on a tail only its own holder "
                    "releases" % (where, method, ", ".join(INODE_TAKERS)))))
        if "this.withVolume(" in line:
            seen_volume.add(method)
            if method not in VOLUME_TAKERS:
                found.append(("volume", (
                    "%s takes the volume lock in `%s`, which is not one of the declared takers "
                    "(%s). The journal's sequence and the superblock slot have one queue, and a "
                    "second entry point to it is a snapshot serialising against nothing"
                    % (where, method, ", ".join(VOLUME_TAKERS)))))
        for taker in INODE_TAKERS:
            if "this.%s(" % taker in line:
                found.append(("nested", (
                    "%s calls `this.%s` from inside `%s`. %s takes the per-inode lock, so "
                    "reaching it from a method that already holds one deadlocks"
                    % (where, taker, method, taker))))
        if method in VOLUME_TAKERS or method in VOLUME_HELD:
            for taker in VOLUME_TAKERS:
                if "this.%s(" % taker in line:
                    found.append(("vnested", (
                        "%s calls `this.%s` from inside `%s`, which already holds the volume "
                        "lock. Use the `…Held` body: a second acquisition waits on a tail only "
                        "this holder releases" % (where, taker, method))))
    if where != str(STORE_PATH.relative_to(REPO)):
        return found
    missing = [t for t in INODE_TAKERS if t not in seen]
    if missing:
        found.append(("taker", (
            "%s declares %s as (a) taker(s) of the per-inode lock and %s take(s) it nowhere. An "
            "operation that reads durable state and then mutates it must hold the inode"
            % (where, ", ".join(missing), "they" if len(missing) > 1 else "it"))))
    missing_volume = [t for t in VOLUME_TAKERS if t not in seen_volume]
    if missing_volume:
        found.append(("volume", (
            "%s declares %s as (a) taker(s) of the volume lock and %s take(s) it nowhere. An "
            "append and a snapshot that are not serialised lose the record in between"
            % (where, ", ".join(missing_volume),
               "they" if len(missing_volume) > 1 else "it"))))
    return found


def locking() -> list[str]:
    """The lock structure in src/kernel/store.mjs, over both keyspaces."""
    if not STORE_PATH.exists():
        return ["%s is missing, so the inode-lock lint checked nothing"
                % STORE_PATH.relative_to(REPO)]
    return [message for _kind, message in inode_lock(
        str(STORE_PATH.relative_to(REPO)), STORE_PATH.read_text(encoding="utf-8"))]


#: THE LOCK LINT'S OWN CONTROL. One line per rule, written the way the decay arrives: a helper that
#: acquires a lock for itself, a taker reached from inside the module, and a snapshot that flushes
#: the journal through the public method rather than the held body.
LOCK_CONTROL = """
class Store {
  async copyUp(d, from, limit) {
    return this.withInode(d.ino, async () => 0);
  }
  async writeFd(d) {
    return this.withInode(d.ino, () => this.closeFd(d));
  }
  async restage(d) {
    return this.withVolume(async () => 0);
  }
  async snapshotHeld() {
    return this.flushJournal();
  }
}
"""

#: All four families must fire on it. Scored per family for the same reason the purity control is:
#: a control scored on "it found something" passes with only one rule still working.
LOCK_CONTROL_FAMILIES = ("taker", "nested", "volume", "vnested")


def purity() -> list[str]:
    """Every way a module in src/fs/ has stopped being a total function over byte arrays."""
    problems: list[str] = []
    modules = sorted(FS_DIR.glob("*.mjs"))
    if not modules:
        return ["src/fs/ holds no .mjs modules, so this lint checked nothing"]
    for path in modules:
        problems.extend(
            message for _kind, message
            in impurities(str(path.relative_to(REPO)), path.read_text(encoding="utf-8")))
    return problems


#: THE LINT'S OWN CONTROL: a module the lint must reject, one line per rule it enforces. Each line
#: is written the way a real decay would arrive — an await inside a parse path, a handle reached
#: for, an import climbing out of src/fs/ — rather than as a bare mention of a forbidden string.
#: `// nothing here` is a comment line and must be IGNORED, which is the other half of the rule:
#: these modules name the APIs they refuse to use, in prose, on purpose.
LINT_CONTROL = """
// navigator.storage and createSyncAccessHandle and await, in a comment, must not count
import { decodeRecord } from "../kernel/store.mjs";
export async function parse(bytes) {
  const file = await navigator.storage.getDirectory();
  const handle = await file.createSyncAccessHandle();
  return decodeRecord(bytes, handle);
}
"""

#: Every rule family LINT_CONTROL must make fire. Scored per FAMILY and not on a count: a control
#: scored on "it found something" passes with only the oldest rule still working, which is exactly
#: the decay it exists to catch. `suspension` is the family added for async/await.
LINT_CONTROL_FAMILIES = ("capability", "suspension", "import")


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

    impure = purity()
    modules = sorted(p.name for p in FS_DIR.glob("*.mjs"))
    print(f"  purity      {len(modules)} module(s) in src/fs/ ({', '.join(modules)}) · "
          f"{'pure' if not impure else str(len(impure)) + ' VIOLATION(S)'}")
    for problem in impure:
        print(f"     {problem}", file=sys.stderr)

    # The lint's own negative control, run every time rather than on a flag: the clean verdict
    # above is only evidence if this lint can still reject a module that breaks each rule.
    fired = sorted({kind for kind, _ in impurities("<lint control>", LINT_CONTROL)})
    missed = [f for f in LINT_CONTROL_FAMILIES if f not in fired]
    print(f"  lint ctl    {len(LINT_CONTROL_FAMILIES)} rule famil(ies), fired: "
          f"{', '.join(fired) or 'NOTHING'}"
          f"{' · MISSED ' + ', '.join(missed) if missed else ''}")

    # The storage edge's locking structure, and the control that shows this lint can reject one.
    unlocked = locking()
    print(f"  store locks {len(INODE_TAKERS)} declared taker(s) of the per-inode lock, "
          f"{len(VOLUME_TAKERS)} of the volume's · "
          f"{'held' if not unlocked else str(len(unlocked)) + ' VIOLATION(S)'}")
    for problem in unlocked:
        print(f"     {problem}", file=sys.stderr)
    lock_fired = sorted({kind for kind, _ in inode_lock("<lock control>", LOCK_CONTROL)})
    lock_missed = [f for f in LOCK_CONTROL_FAMILIES if f not in lock_fired]
    print(f"  lock ctl    {len(LOCK_CONTROL_FAMILIES)} rule famil(ies), fired: "
          f"{', '.join(lock_fired) or 'NOTHING'}"
          f"{' · MISSED ' + ', '.join(lock_missed) if lock_missed else ''}")

    # EVERY SUBPROCESS'S EXIT STATUS IS A GATE. Only `json.loads` succeeding used to count as
    # "it ran", so a script that printed its summary and then threw in a teardown path exited
    # non-zero and this reported clean -- a gate over an interpreter that failed.
    exits: list[str] = []

    rc, host, err = run_node(HOSTTEST)
    if rc != 0:
        exits.append("bench/fs-fuzz/hosttest.mjs exited %d" % rc)
    if host is None:
        print(f"  host tests  COULD NOT RUN: {err}", file=sys.stderr)
        return 3
    print(f"  host tests  {host['total'] - host['failed']}/{host['total']} pass")
    for f in host.get("failures", []):
        print(f"     FAIL {f['name']}: {json.dumps(f)[:300]}", file=sys.stderr)

    # The storage edge's failure paths, and the control that puts every fix back. Before the
    # fuzzer because it is the faster loop: a broken error path reports in 2 s.
    rc_edge, edge, err = run_node(EDGE)
    if rc_edge != 0:
        exits.append("bench/fs-core/edge.mjs exited %d" % rc_edge)
    if edge is None:
        print(f"  edge        COULD NOT RUN: {err}", file=sys.stderr)
        return 3
    print(f"  edge        {edge['total'] - edge['failed']}/{edge['total']} failure-path "
          f"assertion(s) hold over {len(edge['families'])} finding(s)")
    for f in edge.get("failures", []):
        print(f"     FAIL {f['family']} {f['name']}: {json.dumps(f)[:300]}", file=sys.stderr)
    for b in edge.get("broken", []):
        print(f"     BROKEN {b['family']}: {b['why'][:300]}", file=sys.stderr)
    rc_ectl, edgectl, err = run_node(EDGE, "--control")
    if rc_ectl != 0:
        exits.append("bench/fs-core/edge.mjs --control exited %d" % rc_ectl)
    if edgectl is None:
        print(f"  edge ctl    COULD NOT RUN: {err}", file=sys.stderr)
        return 3
    print(f"  edge ctl    every fix put back: "
          f"{edgectl['failed']} failure(s) over "
          f"{len(edgectl['families']) - len(edgectl['silentFamilies'])}/"
          f"{len(edgectl['families'])} finding(s)"
          f"{' · SILENT ' + ', '.join(edgectl['silentFamilies']) if edgectl['silentFamilies'] else ''}")

    rc_fuzz, fuzz, err = run_node(FUZZ, "--seed", str(args.seed), "--cases", str(args.cases))
    if rc_fuzz != 0:
        exits.append("bench/fs-fuzz/fuzz.mjs exited %d" % rc_fuzz)
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
    # NO EXIT-STATUS GATE ON THIS ONE, and the reason is the control's job: with the CRC check
    # removed the fuzzer MUST find silent acceptances, so it exits non-zero BY DESIGN -- measured
    # at 2767 acceptances, exit 1. Gating on the status here reported the working control as a
    # failure. What the control owes is asserted below, on the acceptance count itself.
    if nocrc is None:
        print(f"  control     COULD NOT RUN: {err}", file=sys.stderr)
        return 3
    found = nocrc["silentAcceptances"]
    print(f"  control     --no-crc found {found} silent acceptance(s) "
          f"({'the fuzzer can fail' if found else 'THE FUZZER PROVES NOTHING'})")

    problems = list(impure) + exits
    if missed:
        problems.append(
            "the purity lint did not fire on its own control for: %s, so a clean purity verdict "
            "is not evidence" % ", ".join(missed))
    problems.extend(unlocked)
    if lock_missed:
        problems.append(
            "the inode-lock lint did not fire on its own control for: %s, so a clean locking "
            "verdict is not evidence" % ", ".join(lock_missed))
    if host["failed"]:
        problems.append(f"{host['failed']} host test(s) failed")
    if edge["failed"] or edge["broken"]:
        problems.append(
            f"{edge['failed']} failure-path assertion(s) failed and {len(edge['broken'])} case(s) "
            "could not run in bench/fs-core/edge.mjs")
    if edgectl["silentFamilies"]:
        problems.append(
            "edge.mjs --control stayed clean for: %s, so those assertions are not coupled to the "
            "line the fix is on" % ", ".join(edgectl["silentFamilies"]))
    if edgectl["broken"]:
        problems.append(
            f"{len(edgectl['broken'])} edge.mjs --control case(s) threw rather than failing an "
            "assertion, which is a broken control and not a proof")
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
