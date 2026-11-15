#!/usr/bin/env python3
"""Round 9 F2: force a kernel-side exception inside an ASYNC SYSCALL BODY and read the report.

`later()` is the completion path for open, write, fsync, truncate and close. Its rejection arm used
to be a bare `fail(p, EIO)`: the rejection value dropped, nothing noted, no counter moved. This
patch makes the FIRST `writeFd` on each Store throw a TypeError, which is the shape of any
kernel-side defect in any of those bodies, and the run then shows:

  * the note, naming the pid, the call number and the stack;
  * the counter, `kstats().asyncFail`, summed over every kernel by the page's `shut()`;
  * the suite's clause failing, which is what makes a zero on a clean run evidence.

One throw per Store rather than per call: one is enough to move the counter, and a kernel that
threw on every write would report the throw's consequences rather than the throw.

Usage: f9inject.py <destination-tree>
"""
import pathlib
import sys

ANCHOR = """  async writeFd(d, pid, srcOff, length, at) {
    if (this.readOnly) return -EROFS;"""

PATCHED = """  async writeFd(d, pid, srcOff, length, at) {
    if (!this.__injected) {
      this.__injected = 1;
      throw new TypeError("INJECTED F2: an exception inside write's async body");
    }
    if (this.readOnly) return -EROFS;"""


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: f9inject.py <destination-tree>", file=sys.stderr)
        return 2
    root = pathlib.Path(sys.argv[1])
    path = root / "src" / "kernel" / "store.mjs"
    if not path.exists():
        print(f"{path} is not there, so nothing was patched", file=sys.stderr)
        return 3
    text = path.read_text(encoding="utf-8")
    n = text.count(ANCHOR)
    if n != 1:
        print(f"anchor in src/kernel/store.mjs matched {n} time(s); nothing was patched",
              file=sys.stderr)
        return 1
    path.write_text(text.replace(ANCHOR, PATCHED), encoding="utf-8")
    print("patched src/kernel/store.mjs writeFd to throw once per Store")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
