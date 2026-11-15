#!/usr/bin/env python3
"""Put F1 back the way it was found, in a scratch tree: O_APPEND as a seek at open.

Two edits, both at the line the fix lives on:
  * calls.mjs seeks to the end once, when `open` sees the flag.
  * store.mjs's writeHeld takes the offset from the cursor and never re-reads the end.

Exits non-zero if an anchor is missing or not unique, so a patch that did not apply is reported as
such rather than as an attack that found nothing.
"""
import pathlib
import sys

DEST = pathlib.Path(sys.argv[1] if len(sys.argv) > 1
                    else "/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/unfix1")

EDITS = [
    ("src/kernel/calls.mjs",
     """    // O_APPEND IS NOT A SEEK HERE, and this is where it used to be one: `d.pos = endFd(d)`, once,
    // at open. POSIX sets the offset to the end of the file atomically BEFORE EACH WRITE, and the
    // flag is recorded on the description above so `writeFd` can do exactly that under the inode's
    // lock (src/kernel/store.mjs `writeHeld`). Seeking here instead cost the first of two `>>`
    // writers its bytes, with every call returning success. The initial offset of an O_APPEND
    // description is 0, which is also POSIX and is what a read through an O_RDWR|O_APPEND fd needs.
    return p.fds.add(d);""",
     """    if (flags & 0x400) {
      const end = await k.store.endFd(d);
      if (end < 0) {
        await k.store.closeFd(d);
        return end;
      }
      d.pos = end;
    }
    return p.fds.add(d);"""),
]

START = "    const positional = at !== undefined;\n    let from;\n"
END = "    let target = d.stagingId;\n"


def main() -> int:
    for rel, old, new in EDITS:
        path = DEST / rel
        text = path.read_text(encoding="utf-8")
        if text.count(old) != 1:
            print(f"anchor in {rel} appears {text.count(old)} time(s)", file=sys.stderr)
            return 9
        path.write_text(text.replace(old, new), encoding="utf-8")

    store = DEST / "src/kernel/store.mjs"
    text = store.read_text(encoding="utf-8")
    at = text.find(START)
    end = text.find(END, at)
    if at < 0 or end < 0:
        print("writeHeld's offset block was not found", file=sys.stderr)
        return 9
    text = text[:at] + "    const positional = at !== undefined;\n" \
        "    const from = positional ? at : d.pos;\n" + text[end:]
    store.write_text(text, encoding="utf-8")
    print("unfix1 applied")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
