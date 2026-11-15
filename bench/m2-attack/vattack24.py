#!/usr/bin/env python3
"""Round 7e: read the compare-and-swap's own two numbers at the moment it lets a stale base past.

Round 7c's kernel note was

    commit of inode 22 generation 533 over 530 was refused: inode 22: commit moves generation
    534 back to 533

which can only happen if `moved(base, now)` returned false across a generation that moved. This
prints the two integers it compared, plus the generation it had just read and the generation the
VFS actually holds, so the claim rests on the numbers rather than on the deduction.

The hypothesis under test: `commitOnce` changes the generation at `applyOp` (store.mjs:1001) and
stamps the counter at `row.mut += 1` (store.mjs:1062), with `await this.journal(op)`,
`await this.flushJournal()` and `await this.closeBlob(previous)` in between — so for the width of
a 260 us journal flush the inode's generation has moved and the counter has not.
"""
import pathlib
import sys

sys.path.insert(0, "/Users/chafyni/.claude/jobs/e856c39e/tmp")
from vattack22 import CASE, FN, PAGE_FN, MAIN_OLD, MAIN_NEW  # noqa: E402
from vattack21 import IOCORE  # noqa: E402

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk24")

STORE = [
    # The refusal, with the CAS's own operands.
    ('      this.stats.refusedCommits += 1;\n'
     '      this.note(`commit of inode ${d.ino} generation ${op.gen} over ${at.gen} was refused: `\n'
     '        + `${(error && error.message) || error}`);',
     '      this.stats.refusedCommits += 1;\n'
     '      this.note(`DIAG CAS PASSED A MOVED GENERATION: ino ${d.ino} baseMut ${base.mut} `\n'
     '        + `nowMut ${now.mut} atGen ${at.gen} nowGen ${now.gen} opGen ${op.gen} `\n'
     '        + `vfsGen ${this.vfs.committed(d.ino).gen} staging ${d.dirtyGen}`);\n'
     '      this.note(`commit of inode ${d.ino} generation ${op.gen} over ${at.gen} was refused: `\n'
     '        + `${(error && error.message) || error}`);'),
    # And a stamp of the window itself: how far apart the publish and the bump are.
    # RE-TARGETED round 8: the comment block between the step-4 banner and the append grew when
    # the apply's undo landed, so the anchor is now the append statement alone. Still unique.
    ('    const appended = await this.journal(op);',
     '    this.diagApplied = (this.diagApplied || 0) + 1;\n'
     '    const appended = await this.journal(op);'),
    # `row.mut += 1;` alone is NOT unique — `writeFd`'s append arm carries the same statement at a
    # deeper indent — so the anchor runs to the next statement.
    ('      row.mut += 1;\n    }\n    if (op.prevGen',
     '      row.mut += 1;\n'
     '      this.diagStamped = (this.diagStamped || 0) + 1;\n    }\n    if (op.prevGen'),
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
    patch("src/kernel/iocore.mjs", IOCORE)
    patch("src/kernel/store.mjs", STORE)

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
