#!/usr/bin/env python3
"""Resolve an errno NUMBER to its name out of src/abi.mjs's own ERRNO_NAMES, so a number in a
result row is never guessed at."""
import pathlib
import re
import sys

SRC = pathlib.Path("/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl/src/abi.mjs")
text = SRC.read_text()
block = re.search(r"const ERRNO_NAMES = \[(.*?)\];", text, re.S).group(1)
names = re.findall(r'"([A-Z0-9]+)"', block)
for arg in sys.argv[1:]:
    n = int(arg)
    print("%3d -> %s" % (n, names[n] if 0 <= n < len(names) else "OUT OF RANGE"))
print("EBUSY =", names.index("EBUSY"), " ESTALE =", names.index("ESTALE"),
      " EIO =", names.index("EIO"), " total", len(names))
