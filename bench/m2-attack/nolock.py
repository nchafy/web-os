#!/usr/bin/env python3
"""Replace `withInode` with a pass-through, so proof (a) can be timed WITHOUT the per-inode mutex.

This is the lock's cost in isolation and nothing else: the Held/taker split, the CAS, the stamp and
every read-at-the-point-of-use stay exactly as they are. It is NOT the pre-lock tree — that tree
also lacked the split — so it answers "what does serialization cost" and not "what did the previous
commit measure".
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/nolock")

OLD = """  async withInode(ino, body) {
    const prior = this.inodeTail.get(ino);
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    this.inodeTail.set(ino, mine);
    if (prior) await prior;
    try {
      return await body();
    } finally {
      // Only the LAST holder clears the entry: a waiter that has already swapped itself in is the
      // tail now, and deleting its promise would let the operation after it skip the queue.
      if (this.inodeTail.get(ino) === mine) this.inodeTail.delete(ino);
      release();
    }
  }"""

NEW = """  async withInode(ino, body) {
    // MEASUREMENT MUTATION: no serialization. Every taker runs immediately.
    return body();
  }"""


def main() -> int:
    f = ROOT / "src" / "kernel" / "store.mjs"
    text = f.read_text()
    assert text.count(OLD) == 1, text.count(OLD)
    f.write_text(text.replace(OLD, NEW))
    print("patched store.mjs: withInode is a pass-through")
    return 0


if __name__ == "__main__":
    sys.exit(main())
