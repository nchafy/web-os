#!/usr/bin/env python3
"""v8judge.py <json ...> — each attack's OWN verdict, and nothing inferred from a field's name.

WHY NOT tally7.py's regex sweep: these attacks overwrite bytes on purpose, so a mid-flight
`committedBytesIntact: false` is the attack's own write and not a loss, and a `readstaleOk: true`
is a PASS whose name happens to contain "stale". The regex cannot know the polarity, so it reports
both as flags. What does know is the attack script: each one computes its own verdict booleans and
puts them at the TOP of its evidence (`<case>Ok`), plus a `lostSilently` per case where it has one.

So this reports exactly those two kinds of field, and the page errors. Anything it calls OPEN has
to be read by hand; anything it calls CLOSED is the attack's own arithmetic saying so.
"""
import json
import re
import sys

OK_NAME = re.compile(r"Ok$")


def collect_lost(prefix, o, out):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in ("clock", "envKeys", "envKinds"):
                continue
            path = f"{prefix}.{k}" if prefix else k
            if isinstance(v, (dict, list)):
                collect_lost(path, v, out)
            elif k in ("lostSilently", "silentLoss", "vanished", "sizeWentBackwards"):
                out.append((path, v))
    elif isinstance(o, list):
        for i, v in enumerate(o):
            collect_lost(f"{prefix}[{i}]", v, out)


def main() -> int:
    closed = []
    open_ = []
    notrun = []
    for path in sys.argv[1:]:
        try:
            d = json.load(open(path))
        except Exception as e:                                   # noqa: BLE001
            notrun.append((path, f"UNREADABLE {e}"))
            continue
        if d.get("state") != "done":
            notrun.append((path, f"state={d.get('state')}"))
            continue
        verdicts = {}
        lost = []
        for name in ("proof_a", "proof_b", "proof_c", "proof_d", "pending", "drop", "cas",
                     "orphan", "refuse", "append", "order", "api"):
            section = d.get(name)
            if not section:
                continue
            ev = section.get("evidence") or {}
            for k, v in ev.items():
                if OK_NAME.search(k) and isinstance(v, bool):
                    verdicts[f"{name}.{k}"] = v
            collect_lost(name, ev, lost)
        bad_ok = {k: v for k, v in verdicts.items() if v is False}
        bad_lost = [(k, v) for k, v in lost if v is True]
        errs = [e for e in (d.get("errors") or []) if str(e).startswith("io: ")]
        row = (path, len(verdicts), len(lost), bad_ok, bad_lost, errs)
        (open_ if (bad_ok or bad_lost) else closed).append(row)

    print(f"CLOSED {len(closed)}  OPEN {len(open_)}  NOT-RUN {len(notrun)}")
    for path, nv, nl, _bo, _bl, errs in closed:
        print(f"  closed {path}: {nv} self-verdict(s) true, {nl} loss field(s) all false"
              + (f", {len(errs)} io note(s)" if errs else ""))
    for path, nv, nl, bo, bl, errs in open_:
        print(f"  OPEN   {path}: {json.dumps(bo)} {json.dumps(bl)}"
              + (f" io notes: {json.dumps(errs[:2])}" if errs else ""))
    for path, why in notrun:
        print(f"  NOT RUN {path}: {why}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
