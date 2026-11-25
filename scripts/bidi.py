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


#: A NAMED KEY'S BiDi VALUE: the Private-Use code point WebDriver assigns it, which the engine
#: turns back into the UI Events `key` the page reads. `scripts/cdp.py`'s `KEYS` is the same table
#: for the other wire — there it is a Windows virtual key code, here it is a character — and the
#: two cannot be one map because neither protocol can carry the other's form.
#:
#: VERIFIED BY RUNNING, not by reading the spec: `python3 scripts/bidi.py` asserts the `key` each
#: of these delivers, because a wrong code point arrives as a DIFFERENT key rather than as an
#: error, and a gate built on one would report the program at fault.
KEYS = {
    "Backspace": "\ue003", "Tab": "\ue004", "Enter": "\ue007", "Escape": "\ue00c",
    "PageUp": "\ue00e", "PageDown": "\ue00f", "End": "\ue010", "Home": "\ue011",
    "ArrowLeft": "\ue012", "ArrowUp": "\ue013", "ArrowRight": "\ue014", "ArrowDown": "\ue015",
    "Insert": "\ue016", "Delete": "\ue017",
    "Alt": "\ue00a", "Control": "\ue009", "Shift": "\ue008", "Meta": "\ue03d",
}


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

    def evaluate(self, expression: str, *, raw: bool = False):
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
            if raw:
                return text
            # AUTO-PARSING GUESSES, SO IT MUST NOT CRASH WHEN IT GUESSES WRONG. It used to parse
            # anything beginning with `{` or `[`, which a terminal's own screen text can - reading
            # a pty back through this raised JSONDecodeError on page content that was never meant
            # to be JSON. A failed parse is the string, and a caller that knows it wants text
            # passes `raw=True`.
            try:
                return json.loads(text)
            except (ValueError, TypeError):
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

    def wheel(self, x: float, y: float, dy: float, *, dx: float = 0, times: int = 1,
              pause_ms: int = 0) -> None:
        """Turn the wheel over (x, y). A `wheel` source, which is its own BiDi input type.

        THE DELTA'S UNIT IS NOT CDP'S. `Input.dispatchMouseEvent` takes DEVICE pixels and the
        `wheel` event reports `deltaY / devicePixelRatio` (constraint 297); BiDi's `scroll` takes
        CSS pixels, so the page receives what was asked for. A driver that reuses a CDP figure here
        scrolls by the ratio too far — which is the M11/M12/M16 trap from the other side, so the
        unit is stated at the one place a caller passes it.

        `pause_ms` separates the notches. A burst with no gap is still delivered one event per
        notch (constraint 298 measured that in Chrome), but a kernel that coalesces into its tail
        will merge them, and a gate about scroll DISTANCE does not care while one about record
        COUNTS does.
        """
        actions: list = [{"type": "scroll", "x": int(x), "y": int(y),
                          "deltaX": int(dx), "deltaY": int(dy)}]
        for _ in range(max(0, times - 1)):
            if pause_ms:
                actions.append({"type": "pause", "duration": int(pause_ms)})
            actions.append({"type": "scroll", "x": int(x), "y": int(y),
                            "deltaX": int(dx), "deltaY": int(dy)})
        self.call("input.performActions", {"context": self.ctx, "actions": [{
            "type": "wheel", "id": "wheel1", "actions": actions}]})

    def keys(self, actions: list) -> None:
        """One key action sequence, verbatim. The ONE place a key source is named.

        BiDi's `keyDown.value` IS EXACTLY ONE CODE POINT, which is why a named key cannot be sent
        as the string `"ArrowDown"`: the protocol would refuse it. The code points are `KEYS`.
        """
        self.call("input.performActions", {"context": self.ctx, "actions": [{
            "type": "key", "id": "keyboard1", "actions": actions}]})

    def type_keys(self, text: str) -> None:
        self.keys([a for ch in text for a in
                   ({"type": "keyDown", "value": ch}, {"type": "keyUp", "value": ch})])

    def press(self, name: str, *, alt: bool = False, ctrl: bool = False, shift: bool = False,
              meta: bool = False, times: int = 1) -> None:
        """Press a NAMED key, optionally under modifiers held down across it.

        `name` is a `KEYS` key or a single character. An unknown name RAISES rather than being
        typed as text: a gate that silently sent the eleven letters of `"ArrowDown"` would report
        a cursor that did not move and blame the program (`cdp.Page.press` refuses the same way).

        A modifier is a keyDown before and a keyUp after, because the page reads it off the key
        event's own `altKey`/`ctrlKey` — `src/wm/winhost.mjs`'s `modifierBits`. A dropped modifier
        is a DIFFERENT key, not a weaker one: Alt+Left is Back and a bare Left is bound to nothing.
        """
        if name not in KEYS and len(name) != 1:
            raise BidiError("no BiDi key value recorded for %r; KEYS has %s"
                            % (name, ", ".join(sorted(KEYS))))
        value = KEYS.get(name, name)
        held = [KEYS[m] for m, on in (("Alt", alt), ("Control", ctrl), ("Shift", shift),
                                      ("Meta", meta)) if on]
        actions = [{"type": "keyDown", "value": v} for v in held]
        for _ in range(max(1, times)):
            actions.append({"type": "keyDown", "value": value})
            actions.append({"type": "keyUp", "value": value})
        actions.extend({"type": "keyUp", "value": v} for v in reversed(held))
        self.keys(actions)

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

        # EVERY `KEYS` ROW, ASSERTED AGAINST THE `key` IT DELIVERS, and the modifier with it. A
        # code point one off arrives as a working keypress for the wrong key: no error anywhere,
        # and a gate built on it reports the program at fault for a cursor that did not move.
        ff.evaluate("(() => { window.__keys = []; document.addEventListener('keydown',"
                    " (e) => window.__keys.push([e.key, e.isTrusted, e.altKey]));"
                    " document.body.tabIndex = 0; document.body.focus(); return 1 })()")
        for name in sorted(KEYS):
            if name in ("Alt", "Control", "Shift", "Meta"):
                continue
            ff.press(name, alt=True)
        got = ff.evaluate("JSON.stringify(window.__keys)") or []
        # The held Alt is a keydown of its own, so the modifier's own records are filtered out.
        seen = [row for row in got if row[0] != "Alt"]
        want = [name for name in sorted(KEYS) if name not in ("Alt", "Control", "Shift", "Meta")]
        print("keys     %s" % [row[0] for row in seen])
        if [row[0] for row in seen] != want:
            bad.append("KEYS does not deliver what it names: wanted %s, got %s"
                       % (want, [row[0] for row in seen]))
        if not all(row[1] for row in seen):
            bad.append("a pressed key did not arrive trusted: %r" % (seen,))
        if not all(row[2] for row in seen):
            bad.append("`alt=True` did not reach the page as `altKey`, so Alt+Left is a bare "
                       "Left and the verb is lost: %r" % (seen,))
        print("firefox %s" % ff.evaluate("navigator.userAgent"))
    if bad:
        for line in bad:
            print("BAD  %s" % line)
        return 1
    print("ok: Firefox can be navigated, evaluated and given REAL trusted input")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
