#!/usr/bin/env python3
"""Round 9 F1, the browser-side BEFORE: put the pre-fix slot reader back and boot the real page.

`Store.readWhole` is the one method the mount and the explicit fsck read superblock slots through.
The pre-fix code collapsed an errno and an absent file onto the same `null`, which is what let a
populated volume with an empty journal read as a FIRST BOOT. This patch restores exactly that line
and nothing else, so www/m2.html's `unreadable` section runs against the old reader.

What it is expected to show, and the reason the AFTER's evidence lives in edge.mjs instead: the
reseed's own superblock write lands on a slot name the page turned into a DIRECTORY, and
src/kernel/iocore.mjs `writeAll` has no try/catch — so the pre-fix kernel does not reseed here, it
PANICS. Either outcome is a failure; which one it is, is the thing this run measures.

Usage: f9unfix_slot.py <destination-tree>
"""
import pathlib
import sys

ANCHOR = """  async readWhole(name) {
    const r = await this.io.request(IO_READ_ALL, { dir: "", name });
    if (typeof r === "number") return { errno: -r };
    if (r.absent || !r.bytes) return null;
    return new Uint8Array(r.bytes);
  }"""

PATCHED = """  async readWhole(name) {
    const r = await this.io.request(IO_READ_ALL, { dir: "", name });
    return typeof r === "number" || !r.bytes ? null : new Uint8Array(r.bytes);
  }"""


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: f9unfix_slot.py <destination-tree>", file=sys.stderr)
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
    print("put the pre-fix slot reader back in src/kernel/store.mjs readWhole")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
