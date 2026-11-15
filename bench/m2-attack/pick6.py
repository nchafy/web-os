#!/usr/bin/env python3
"""pick6.py <json> <dotted.path> [...] — print named fields out of an attack's evidence."""
import json
import sys


def get(node, path):
    for part in path.split("."):
        if isinstance(node, list):
            node = node[int(part)]
        elif isinstance(node, dict):
            node = node.get(part)
        else:
            return None
        if node is None:
            return None
    return node


def main() -> int:
    d = json.load(open(sys.argv[1]))
    for path in sys.argv[2:]:
        v = get(d, path)
        if isinstance(v, dict):
            v = {k: x for k, x in v.items()
                 if k not in ("clock", "envKeys", "envKinds", "bytes", "distinct")}
        print(f"{path} = {json.dumps(v)[:700]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
