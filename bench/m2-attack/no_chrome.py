"""Scratch: run check.py's main() with Chrome unavailable or pointed at a wrong binary.

    python no_chrome.py missing   # no Chrome on the machine
    python no_chrome.py wrong     # a path that exists but is not Chrome
"""
import sys

sys.path.insert(0, "/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl/scripts")

import cdp  # noqa: E402
import check  # noqa: E402

mode = sys.argv[1]
if mode == "missing":
    cdp.CHROME_CANDIDATES = ("/Applications/NoSuchBrowser.app/Contents/MacOS/Nope",)
elif mode == "wrong":
    cdp.CHROME_CANDIDATES = ("/bin/echo",)
else:
    raise SystemExit("mode?")
cdp.Browser.timeout = 5.0
code = check.main(sys.argv[2:])
print("MAIN RETURNED %r" % code)
raise SystemExit(code)
