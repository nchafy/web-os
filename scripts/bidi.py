#!/usr/bin/env python3
"""A WebDriver BiDi driver for Firefox: real trusted input in a second engine.

    python3 scripts/bidi.py            # a self-test: navigate, evaluate, and a REAL double-click

WHY THIS EXISTS, AND WHAT IT OVERTURNS. `CLAUDE.md` says the suite drives Chrome only, and
`bench/m7-win/firefox.py` opens with "Mozilla removed CDP, so there is no driver:
`firefox --headless --screenshot` renders the page and exits". That was true of CDP and is no
longer true of Firefox: **156 speaks WebDriver BiDi**, over a WebSocket, with `input.performActions`
that delivers events carrying `isTrusted === true`. Verified by this file's own self-test.

It matters because the Chrome-only gap has now cost this project FIVE milestones — M4a shipped a
window that could not be dragged in Firefox (constraint 175), M6 shipped a policy under which no
process started there (206), M11 placed a blur band at a constant offset that was wrong at dpr 1,
M12 asserted a dpr-2 window count (264), and M14 shipped a desktop on which a reader could not open
anything after the first launch (289). Every one was found by a person opening the page, because a
screenshot is all the old harness could get. A photograph cannot tell an inert frame from a working
one (constraint 40), and that is the whole class this closes.

WHAT IT IS NOT. It is not a second `scripts/check.py`. The registered suite stays Chrome-driven —
one engine, one set of measured constants — and this drives the few assertions that are about
whether a gesture WORKS rather than about a number. Use it when the question is "does this respond
to a real hand in another engine".

THE PROTOCOL, in the three facts that are not obvious:
  - the endpoint is `--remote-debugging-port`, but the path is `/session`, not `/`. The root
    answers 200 with httpd.js's own index page, so a handshake there fails confusingly.
  - the handshake must carry NO `Origin` header. Firefox refuses one from a non-browser client
    with "The handshake request has incorrect Origin header".
  - `session.new` comes first, then `browsingContext.getTree` for a context id. Every later call
    names that context.
"""
from __future__ import annotations

import base64
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time

#: Where Firefox lives on this machine. A path and not a PATH lookup, because `firefox` is not on
#: PATH on macOS and the app bundle is where it is.
FIREFOX_CANDIDATES = (
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
    "/usr/bin/firefox",
    "/snap/bin/firefox",
)


class BidiError(Exception):
    """The driver could not do what was asked, with the reason Firefox gave."""


def find_firefox() -> str | None:
    for path in FIREFOX_CANDIDATES:
        if pathlib.Path(path).exists():
            return path
    return shutil.which("firefox")


class Firefox:
    """A Firefox on a throwaway profile, driven over BiDi, as a context manager."""

    def __init__(self, *, headless: bool = True, width: int = 1320, height: int = 900,
                 timeout: float = 60.0) -> None:
        self.timeout = timeout
        self._headless = headless
        self._size = (width, height)
        self.profile: pathlib.Path | None = None
        self.proc: subprocess.Popen[str] | None = None
        self.ws = None
        self.ctx = ""
        self._n = 0

    def __enter__(self) -> "Firefox":
        try:
            self._launch()
        except BaseException as error:
            # Same contract as `cdp.Browser`: if this escapes __enter__, `with` never binds and
            # __exit__ never runs, so the process and its profile would be orphaned.
            self.__exit__(type(error), error, error.__traceback__)
            raise
        return self

    def _launch(self) -> None:
        binary = find_firefox()
        if not binary:
            raise BidiError("no Firefox found; looked at %s" % ", ".join(FIREFOX_CANDIDATES))
        from websocket import create_connection  # imported here: only this path needs it

        self.profile = pathlib.Path(tempfile.mkdtemp(prefix="showup-firefox-"))
        width, height = self._size
        args = [binary, "--remote-debugging-port=0", "--profile", str(self.profile),
                "--no-remote", "--width", str(width), "--height", str(height), "about:blank"]
        if self._headless:
            args.insert(1, "--headless")
        self.proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, bufsize=1)
        url = None
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline() if self.proc.stdout else ""
            if not line:
                if self.proc.poll() is not None:
                    raise BidiError("Firefox exited with %s before announcing an endpoint"
                                    % self.proc.returncode)
                continue
            found = re.search(r"(ws://[^\s]+)", line)
            if found:
                url = found.group(1)
                break
        if not url:
            raise BidiError("Firefox announced no BiDi endpoint within %.0fs" % self.timeout)
        # `/session`, and no Origin: see the module docstring.
        self.ws = create_connection(url.rstrip("/") + "/session", timeout=self.timeout,
                                    suppress_origin=True)
        self.call("session.new", {"capabilities": {}})
        tree = self.call("browsingContext.getTree", {})
        self.ctx = tree["contexts"][0]["context"]

    def __exit__(self, *_exc) -> None:
        if self.ws is not None:
            try:
                self.ws.close()
            except Exception:
                pass
            self.ws = None
        if self.proc is not None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            self.proc = None
        if self.profile is not None:
            shutil.rmtree(self.profile, ignore_errors=True)
            self.profile = None

    # ---- the protocol -------------------------------------------------------------------------

    def call(self, method: str, params: dict) -> dict:
        """One command, and its reply. Events arriving in between are discarded by id."""
        if self.ws is None:
            raise BidiError("not connected")
        self._n += 1
        mine = self._n
        self.ws.send(json.dumps({"id": mine, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") != mine:
                continue
            if "error" in msg:
                raise BidiError("%s -> %s: %s" % (method, msg["error"], msg.get("message")))
            return msg.get("result") or {}

    def navigate(self, url: str, *, wait: str = "complete") -> None:
        self.call("browsingContext.navigate",
                  {"context": self.ctx, "url": url, "wait": wait})

    def evaluate(self, expression: str):
        """Evaluate in the page. A JSON string comes back parsed, which is how the pages report.

        THE EXPRESSION SHOULD RETURN A STRING for anything structured. BiDi serialises an object
        as a typed tree rather than a value, so `JSON.stringify(...)` on the page side is the
        cheap way to get a shape back — the same thing `scripts/cdp.py`'s callers do.
        """
        out = self.call("script.evaluate", {"expression": expression,
                                            "target": {"context": self.ctx},
                                            "awaitPromise": True})
        if out.get("type") != "success":
            raise BidiError("page script failed: %s" % json.dumps(out)[:600])
        value = out.get("result") or {}
        if value.get("type") == "string":
            text = value.get("value", "")
            if text[:1] in "{[" or text in ("null", "true", "false"):
                return json.loads(text)
            return text
        return value.get("value")

    # ---- real input ---------------------------------------------------------------------------

    def pointer(self, actions: list) -> None:
        """A pointer action sequence. The events it produces carry `isTrusted === true`."""
        self.call("input.performActions", {"context": self.ctx, "actions": [{
            "type": "pointer", "id": "mouse1", "parameters": {"pointerType": "mouse"},
            "actions": actions}]})

    def move(self, x: float, y: float) -> None:
        self.pointer([{"type": "pointerMove", "x": int(x), "y": int(y)}])

    def click(self, x: float, y: float, *, button: int = 0) -> None:
        self.pointer([{"type": "pointerMove", "x": int(x), "y": int(y)},
                      {"type": "pointerDown", "button": button},
                      {"type": "pointerUp", "button": button}])

    def dblclick(self, x: float, y: float) -> None:
        # THE PAUSE IS NOT DECORATION: two down/up pairs with no gap can be coalesced, and a
        # double-click the engine did not recognise is a gesture that silently did not happen.
        self.pointer([{"type": "pointerMove", "x": int(x), "y": int(y)},
                      {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0},
                      {"type": "pause", "duration": 40},
                      {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}])

    def drag(self, start: dict, end: dict, steps: int = 10) -> None:
        actions = [{"type": "pointerMove", "x": int(start["x"]), "y": int(start["y"])},
                   {"type": "pointerDown", "button": 0}]
        for i in range(1, steps + 1):
            actions.append({
                "type": "pointerMove",
                "x": int(start["x"] + (end["x"] - start["x"]) * i / steps),
                "y": int(start["y"] + (end["y"] - start["y"]) * i / steps)})
        actions.append({"type": "pointerUp", "button": 0})
        self.pointer(actions)

    def type_keys(self, text: str) -> None:
        self.call("input.performActions", {"context": self.ctx, "actions": [{
            "type": "key", "id": "keyboard1",
            "actions": [a for ch in text for a in
                        ({"type": "keyDown", "value": ch}, {"type": "keyUp", "value": ch})]}]})

    def screenshot(self, path: str | pathlib.Path) -> None:
        out = self.call("browsingContext.captureScreenshot", {"context": self.ctx})
        pathlib.Path(path).write_bytes(base64.b64decode(out["data"]))


def main(argv: list[str] | None = None) -> int:  # pragma: no cover - smoke test only
    """The self-test, which is also the evidence the claim in the docstring rests on."""
    bad = []
    with Firefox() as ff:
        ff.navigate("data:text/html,<h1 id=x>hello</h1>")
        if ff.evaluate("document.getElementById('x').textContent") != "hello":
            bad.append("evaluate did not read the page")
        ff.evaluate("(() => { window.__hits = [];"
                    " document.body.addEventListener('dblclick',"
                    "   (e) => window.__hits.push(e.isTrusted)); return 1 })()")
        ff.dblclick(20, 20)
        hits = ff.evaluate("JSON.stringify(window.__hits)")
        print("dblclick isTrusted: %s" % hits)
        if hits != [True]:
            bad.append("a real double-click did not arrive trusted: %r" % (hits,))
        print("firefox %s" % ff.evaluate("navigator.userAgent"))
    if bad:
        for line in bad:
            print("BAD  %s" % line)
        return 1
    print("ok: Firefox can be navigated, evaluated and given REAL trusted input")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
