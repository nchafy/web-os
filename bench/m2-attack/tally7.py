#!/usr/bin/env python3
"""tally7.py <json ...> — per-attack verdict, compressed to the fields that would mean a defect.

An attack returns `ok: false` on purpose so the page prints its evidence, so the exit code and the
proof-level ok say nothing. What says something is the shape of the field NAME: a `lost*` that is
non-zero, a `kept*`/`intact*`/`clean*`/`survived*` that is false, a `reverted*`/`silent*` that is
true. Everything else is printed only as a count, so a clean attack is one line.

A json whose page did not reach `done` is reported as NOT RUN, which is not the same as clean.
"""
import json
import re
import sys

BAD_IF_TRUE = re.compile(r"lost|silent|revert|resurrect|vanish|duplicat|stale|wedge|missing|"
                         r"short|discard", re.I)
BAD_IF_FALSE = re.compile(r"kept|intact|clean|survived|consecutive|ok$|present|agree", re.I)
SKIP = ("clock", "envKeys", "envKinds", "distinct", "notes", "note", "why", "diag", "trace")


def walk(prefix, o, hits):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in SKIP:
                continue
            path = f"{prefix}.{k}" if prefix else k
            if isinstance(v, (dict, list)):
                walk(path, v, hits)
            elif BAD_IF_TRUE.search(k) and (v is True or (isinstance(v, (int, float))
                                                          and not isinstance(v, bool) and v > 0)):
                hits.append((path, v))
            elif BAD_IF_FALSE.search(k) and v is False:
                hits.append((path, v))
    elif isinstance(o, list):
        for i, v in enumerate(o[:6]):
            walk(f"{prefix}[{i}]", v, hits)


def main() -> int:
    for path in sys.argv[1:]:
        try:
            d = json.load(open(path))
        except Exception as e:                                   # noqa: BLE001
            print(f"{path}: UNREADABLE {e}")
            continue
        state = d.get("state")
        errs = d.get("errors") or []
        hits = []
        sections = 0
        for name in ("proof_a", "proof_b", "proof_c", "proof_d", "pending", "drop", "cas",
                     "orphan", "refuse", "order", "api"):
            p = d.get(name)
            if not p:
                continue
            sections += 1
            walk(name, p.get("evidence") or {}, hits)
        tag = "NOT RUN" if state != "done" else "ran"
        print(f"{path}: {tag} state={state} sections={sections} flags={len(hits)} "
              f"page-errors={len(errs)}")
        seen = set()
        for k, v in hits[:14]:
            key = (k, str(v))
            if key in seen:
                continue
            seen.add(key)
            print(f"    {k} = {json.dumps(v)}")
        for e in errs[:2]:
            print(f"    page-error: {str(e)[:140]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
