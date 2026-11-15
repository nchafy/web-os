#!/usr/bin/env python3
"""vattack30's NEGATIVE CONTROL: the same four scenarios against the PRE-F1 code.

F1 is reverted in the throwaway tree — the per-write seek-to-end is switched off in
`writeHeld` and `open` seeks to the end once, which is what calls.mjs:306 says it used to do — so
a run that still reports every byte surviving would be a check that is not reading O_APPEND at all.

    python3 vattack30pre.py && cd mut/vatk30pre && .venv/bin/python bench/fs-core/probe.py --files 20
"""
import pathlib
import sys

sys.path.insert(0, "/Users/chafyni/.claude/jobs/e856c39e/tmp")
from vattack30 import CASE, FN, PAGE_FN, MAIN_OLD, MAIN_NEW  # noqa: E402

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk30pre")

STORE = [
    # The per-write seek-to-end, switched off. The `else` arm then answers every write, which is
    # `from = positional ? at : d.pos` — the pre-fix body exactly.
    ("    if (!positional && (d.flags & O_APPEND)) {",
     "    if (false && !positional && (d.flags & O_APPEND)) {"),
]

CALLS = [
    # O_APPEND IS NOT IMPORTED HERE ANY MORE — the fix removed the only use. Without this line the
    # control's `flags & O_APPEND` is a ReferenceError inside `k.later`, and `later`'s rejection
    # arm answers a bare -EIO: every `open` in the tree failed and nothing named why.
    ("  O_ACCMODE, O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC,",
     "  O_ACCMODE, O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_APPEND,"),
    ("description is 0, which is also POSIX and is what a read through an O_RDWR|O_APPEND fd "
     "needs.\n    return p.fds.add(d);",
     "description is 0, which is also POSIX and is what a read through an O_RDWR|O_APPEND fd "
     "needs.\n"
     "    // ROUND 9 CONTROL: the seek at open this fix removed, put back.\n"
     "    if (flags & O_APPEND) {\n"
     "      const e = await k.store.endFd(d);\n"
     "      if (e >= 0) d.pos = e;\n"
     "    }\n"
     "    return p.fds.add(d);"),
]


def patch(rel, pairs):
    path = ROOT / rel
    text = path.read_text()
    for old, new in pairs:
        n = text.count(old)
        assert n == 1, "anchor in %s matched %d time(s): %r" % (rel, n, old[:70])
        text = text.replace(old, new)
    path.write_text(text)
    print("patched %s (%d anchor(s))" % (rel, len(pairs)))


def main() -> int:
    patch("src/kernel/store.mjs", STORE)
    patch("src/kernel/calls.mjs", CALLS)

    prog = ROOT / "bench" / "fs-core" / "program.mjs"
    text = prog.read_text()
    assert text.count(CASE[0]) == 1, text.count(CASE[0])
    prog.write_text(text.replace(*CASE) + FN)
    print("patched program.mjs")

    page = ROOT / "www" / "m2.html"
    html = page.read_text()
    assert html.count(MAIN_OLD) == 1, html.count(MAIN_OLD)
    html = html.replace(MAIN_OLD, MAIN_NEW)
    html = html.replace("async function main() {", PAGE_FN + "\nasync function main() {", 1)
    page.write_text(html)
    print("patched m2.html")
    return 0


if __name__ == "__main__":
    sys.exit(main())
