"""Scratch: crash the browser in the middle of a check, two ways.

    python crash.py kill     # SIGKILL the Chrome this run spawned, mid-check
    python crash.py renderer # Page.crash: the renderer dies, the browser lives
"""
import sys

sys.path.insert(0, "/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl/scripts")

import cdp  # noqa: E402
import check  # noqa: E402

mode = sys.argv[1]
live = {}

_page = cdp.Browser.page


def page(self):
    live["browser"] = self
    return _page(self)


cdp.Browser.page = page

_read = check.Env.read


def read(self, expr, shape, **kw):
    if mode == "kill":
        proc = live["browser"]._process
        print("  [scratch] SIGKILL on chrome pid %d, mid-check" % proc.pid, flush=True)
        proc.kill()
    else:
        print("  [scratch] Page.crash, mid-check", flush=True)
        try:
            self.page.call("Page.crash")
        except Exception as error:  # the target dies, so the call may never answer
            print("  [scratch] Page.crash raised %s: %s" % (type(error).__name__, error),
                  flush=True)
            raise
    return _read(self, expr, shape, **kw)


check.Env.read = read
code = check.main(sys.argv[2:])
print("MAIN RETURNED %r" % code)
raise SystemExit(code)
