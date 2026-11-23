#!/usr/bin/env python3
"""THE CORE UTILITIES, run at a REAL prompt and scored on what the shell printed.

    python3 bench/m14-shell/coreutils.py            # the gate
    python3 bench/m14-shell/coreutils.py --headed    # ...in a window

WHY THIS SHAPE. These programs are the one part of the system whose whole observable behaviour is
TEXT, so the honest test is to type a command and assert what came back — and to do it through a
pty, a line discipline and a real shell, because that is the path a reader uses. A unit test over
`mkdir` would not have caught `mkdir: command not found`, which is what was actually wrong: the
program did not exist, and the manifest is what makes one exist.

EVERY CASE CARRIES ITS OWN NEGATIVE HALF. `mkdir` is checked by `ls` seeing the directory AND by
`mkdir` on the same name failing; `rm -r` by the tree going AND by `rmdir` having refused it first.
A row that only asserts the happy path passes for a program that prints a success it did not have.
"""
from __future__ import annotations

import argparse
import os
import pathlib
import re
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import bidi   # noqa: E402
import serve  # noqa: E402

TERM_AT = """JSON.stringify((() => {
  const t = document.querySelector('.terminal')
  if (!t) return null
  const r = t.getBoundingClientRect()
  return { x: Math.round(r.left + 30), y: Math.round(r.top + 20) }
})())"""

SCREEN = "(document.querySelector('.terminal') || {}).textContent || ''"

#: (command, [substrings that must appear], [substrings that must NOT])
CASES = [
    # ---- mkdir, and the refusal that proves it really made one ----
    ("mkdir /tmp/one", [], ["not found", "mkdir:"]),
    ("ls /tmp", ["one"], []),
    # THE ERRNO BY NAME, which is what `std.complainErrno` prints and what this project asserts
    # on elsewhere: "it refused" passes for a filesystem that refused for the wrong reason.
    ("mkdir /tmp/one", ["EEXIST"], []),
    ("mkdir /tmp/a/b/c", ["use -p"], []),
    ("mkdir -p /tmp/a/b/c", [], ["mkdir:"]),
    ("ls /tmp/a/b", ["c"], []),

    # ---- touch, and a file that is a file ----
    ("touch /tmp/one/hello.txt", [], ["touch:"]),
    ("ls /tmp/one", ["hello.txt"], []),
    ("stat /tmp/one/hello.txt", ["regular file", "Size: 0"], []),
    ("stat /tmp/one", ["directory"], []),

    # ---- writing, then reading it back ----
    ("echo hello > /tmp/one/hello.txt", [], ["sh:"]),
    ("cat /tmp/one/hello.txt", ["hello"], []),
    ("wc -l /tmp/one/hello.txt", ["1"], []),

    # ---- cp, and that the copy has the same bytes ----
    ("cp /tmp/one/hello.txt /tmp/one/copy.txt", [], ["cp:"]),
    ("cat /tmp/one/copy.txt", ["hello"], []),

    # ---- mv, and that the old name is gone ----
    ("mv /tmp/one/copy.txt /tmp/one/moved.txt", [], ["mv:"]),
    ("ls /tmp/one", ["moved.txt"], ["copy.txt"]),
    ("cat /tmp/one/copy.txt", ["ENOENT"], []),

    # ---- rmdir refuses a full directory; rm -r does it ----
    ("rmdir /tmp/one", ["not empty"], []),
    ("rm /tmp/one", ["use -r"], []),
    ("rm -r /tmp/one", [], ["rm:"]),
    ("ls /tmp", [], ["one"]),
    ("rmdir /tmp/a/b/c", [], ["rmdir:"]),

    # ---- rm -f is quiet about absence and only about absence ----
    ("rm /tmp/nothing-here", ["ENOENT"], []),
    ("rm -f /tmp/nothing-here", [], ["rm:"]),

    # ---- pwd follows cd, which is what proves the cwd crossed spawn ----
    ("cd /usr/bin", [], ["sh:"]),
    ("pwd", ["/usr/bin"], []),
    ("cd /", [], ["sh:"]),
    ("pwd", ["/"], []),

    # ---- the text tools, over a pipeline so the pipe is exercised too ----
    ("df -h", ["Filesystem", "Use%"], []),
    ("ls /usr/bin | sort | tail -3", ["yes"], []),
    ("ls /usr/bin | wc -l", [], ["wc:"]),
    ("echo b > /tmp/s.txt", [], []),
    ("echo a >> /tmp/s.txt", [], []),
    ("echo b >> /tmp/s.txt", [], []),
    ("sort /tmp/s.txt", ["a"], []),
    ("sort /tmp/s.txt | uniq -c", ["2 b", "1 a"], []),
    ("sort -u /tmp/s.txt | wc -l", ["2"], []),

    # ---- /dev/null TAKES A WRITE, AND IT IS THE ONLY ROW OF /dev THAT DOES ----
    #
    # `cmd > /dev/null` is the most-used redirection a shell has and it answered EROFS: `/dev` is a
    # generated mount and every row of it refused a write-open. Found while writing a task-manager
    # gate that needed a deliberately busy process — `yes > /dev/null &` failed at the open, so
    # there was no busy process and the column under test had nothing in it.
    ("echo hi > /dev/null", [], ["EROFS", "sh:"]),
    ("echo $?", ["0"], []),
    # AND THE EXCEPTION IS EXACTLY ONE ROW: `/dev/trace` is still read-only, which is what makes
    # the change a declared sink rather than a mount that stopped being read-only.
    ("echo x > /dev/trace", ["EROFS"], []),
    ("cat /dev/null", [], ["EROFS", "cat:"]),
]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--url", default="")
    ap.add_argument("--only", default="", help="run only cases whose command contains this")
    args = ap.parse_args(argv)

    httpd = None
    url = args.url
    if not url:
        os.chdir(REPO)
        httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d/www/m14.html" % httpd.server_address[1]
    print("url      %s" % url)

    bad: list[str] = []
    ran = 0
    try:
        with bidi.Firefox(headless=not args.headed, width=1560, height=1010) as ff:
            ff.navigate(url)
            at = None
            deadline = time.time() + 90
            while time.time() < deadline:
                at = ff.evaluate(TERM_AT)
                if at:
                    break
                time.sleep(0.5)
            if not at:
                print("no terminal on the page")
                return 1
            ff.click(at["x"], at["y"])
            time.sleep(0.3)

            for cmd, musts, musnts in CASES:
                if args.only and args.only not in cmd:
                    continue
                before = len(ff.evaluate(SCREEN, raw=True))
                ff.type_keys(cmd + "\n")
                # WAIT FOR THE PROMPT, not for a timer: a command that takes longer than a guess
                # would have its output read as the next command's.
                out = ""
                for _ in range(40):
                    time.sleep(0.15)
                    screen = ff.evaluate(SCREEN, raw=True)
                    out = screen[before:]
                    if re.search(r"\$ $|\$\s*$", out) and len(out.strip()) > len(cmd):
                        break
                ran += 1
                flat = " ".join(out.split())
                missing = [m for m in musts if m not in out]
                present = [m for m in musnts if m in out]
                ok = not missing and not present
                print("%-44s %s" % (cmd, "ok" if ok else "BAD"))
                if not ok:
                    print("    got: %s" % flat[:260])
                    if missing:
                        bad.append("%r did not print %s" % (cmd, missing))
                    if present:
                        bad.append("%r printed %s and should not have" % (cmd, present))
            ff.screenshot(HERE / "coreutils.png")
    finally:
        if httpd is not None:
            httpd.shutdown()

    print("\n%d case(s) run" % ran)
    if bad:
        for line in bad:
            print("BAD  %s" % line)
        return 1
    print("every core utility did what it says, at a real prompt")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
