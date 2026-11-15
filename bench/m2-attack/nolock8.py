#!/usr/bin/env python3
"""Price the volume lock: remove it from a scratch tree and leave everything else alone.

`withVolume` becomes a pass-through, so `journal`, `flushJournal` and `writeSnapshot` run exactly
as they did before this round. One line, so the difference between the two trees' proof (a) write
times is the lock and nothing else.
"""
import pathlib
import sys

DEST = pathlib.Path(sys.argv[1] if len(sys.argv) > 1
                    else "/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/nolock")

OLD = """  async withVolume(body) {
    return this.withKey(VOLUME, body);
  }"""
NEW = """  async withVolume(body) {
    // PRICING CONTROL: no lock at all.
    return body();
  }"""


def main() -> int:
    path = DEST / "src/kernel/store.mjs"
    text = path.read_text(encoding="utf-8")
    if text.count(OLD) != 1:
        print(f"anchor appears {text.count(OLD)} time(s)", file=sys.stderr)
        return 9
    path.write_text(text.replace(OLD, NEW), encoding="utf-8")
    print("nolock8 applied")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
