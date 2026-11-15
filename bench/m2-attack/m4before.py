#!/usr/bin/env python3
"""M4's BEFORE, as a mutation of the fixed tree.

A dirty description used to answer `fstat` and `SEEK_END` from its staged generation's own length —
that is, from the log replayed onto the base the COPY was taken from — rather than onto the base the
file is on now. This reverts exactly that and nothing else, so the `cas m4` clause's before/after is
one variable.

It is also that clause's negative control: if the clause passes with this applied, it is not coupled
to its subject.
"""
import pathlib
import sys

DEST = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/m4before")

EDITS = [
    (
        "src/kernel/store.mjs",
        """    if (d.dirtyGen) {
      const live = await this.resolve(d.ino);
      if (typeof live === "number") return live;
      info.size = this.stagedEnd(d, live.end);
      return info;
    }""",
        """    if (d.dirtyGen) {
      // MUTATION: the staged generation's length against the base the COPY was taken from.
      info.size = this.stagedEnd(d, d.baseEnd);
      return info;
    }""",
    ),
    (
        "src/kernel/store.mjs",
        """    return d.dirtyGen ? this.stagedEnd(d, live.end) : live.end;""",
        """    // MUTATION: SEEK_END from the copy's own base rather than the file's.
    return d.dirtyGen ? this.stagedEnd(d, d.baseEnd) : live.end;""",
    ),
]


def main() -> int:
    for rel, old, new in EDITS:
        p = DEST / rel
        text = p.read_text()
        n = text.count(old)
        if n != 1:
            print("ANCHOR %s matched %d time(s) in %s" % (old[:40], n, rel))
            return 1
        p.write_text(text.replace(old, new))
    print("patched m4before")
    return 0


if __name__ == "__main__":
    sys.exit(main())
