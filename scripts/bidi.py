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
import contextlib
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
    #: THE FUNCTION KEYS, WHICH M18 MADE REACHABLE AND NOTHING COULD SEND. `WKEY_F1..WKEY_F12` are
    #: keysyms in `src/abi.mjs` and `KEYSYM_BY_KEY` in `src/wm/winhost.mjs` maps every one of them,
    #: but this table stopped at Delete — so F2, which is `files`' rename, had no spelling on
    #: this wire at all. U+E031..U+E03C is WebDriver's own contiguous block, immediately before the
    #: U+E03D that `Meta` above already carries, which is what makes the reading checkable rather
    #: than copied.
    #:
    #: F10 AND F11 ARE THE BROWSER'S OWN and are listed anyway, because the self-test is what says
    #: whether they arrive — measured, all twelve do, trusted and under a held Alt. A table that
    #: omitted a key the page can in fact read would leave `press` refusing it for ever, which is
    #: loud but wrong.
    "F1": "\ue031", "F2": "\ue032", "F3": "\ue033", "F4": "\ue034", "F5": "\ue035",
    "F6": "\ue036", "F7": "\ue037", "F8": "\ue038", "F9": "\ue039", "F10": "\ue03a",
    "F11": "\ue03b", "F12": "\ue03c",
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

    def set_viewport(self, width: int, height: int) -> None:
        """Resize the VIEWPORT, which is not the same thing as the window `--width` launched with.

        THE SHELL'S OWN LAYOUT IS WHAT THIS IS FOR. The Superbar band only overflows when the
        desktop is narrower than its buttons, and the gap between "narrower than the content" and
        "wider than one button" is about ten pixels — so a gate that needs that state has to SEARCH
        for it rather than launch at a guessed size (`bench/m22-band/probe.py`'s viewport search is
        the technique, measured at 234 CSS px in Chrome and 232 in Firefox).

        CSS PIXELS, like everything else BiDi takes. Firefox renders at dpr 1 on this machine, so a
        caller must not reach for a device-px figure measured in Chrome (constraints 264, 297).
        The ratio is now a caller's to choose, which does not change that rule: `set_dpr` chooses
        what the CONTEXT reports, and the figure still has to be derived rather than copied.
        """
        self.call("browsingContext.setViewport",
                  {"context": self.ctx,
                   "viewport": {"width": int(width), "height": int(height)}})

    def set_dpr(self, ratio: float | None) -> None:
        """Set this context's DEVICE PIXEL RATIO, or `None` to put the engine's own back.

        THIS OVERTURNS "FIREFOX RENDERS AT dpr 1, WHICH IS WHERE A UNIT ERROR HIDES". That sentence
        is in `CLAUDE.md` and in every Firefox gate in `bench/`, and it is still true of the display
        — but it is no longer true of the context: Firefox 156's `browsingContext.setViewport` takes
        `devicePixelRatio`, so a second engine can be driven at a ratio the run CHOSE. Measured by
        the self-test, which is the only reason this method is claimed rather than hoped for: 2 and
        1.5 both arrive, the ratio SURVIVES A NAVIGATION, and `None` puts 1 back.

        IT MATTERS BECAUSE THE RATIO IS THIS PROJECT'S MOST EXPENSIVE CLASS OF DEFECT. M11 placed a
        band at a constant offset, M12 asserted a dpr-2 window count, M16 handed `win_surface` a
        CSS-px box and M17 dispatched a wheel delta in the wrong unit — four milestones, every
        expectation green, each one wrong by exactly the ratio. Until now the only engine that could
        be asked about a ratio other than its own was Chrome, so "a geometry derived from a measured
        rect survives a second engine" was checkable at ONE ratio per engine.

        A NON-INTEGER IS THE CASE THAT RULES OUT A CLAMP, which is why the self-test asks for 1.5
        as well as 2: a host that silently rounded to the nearest integer would satisfy a dpr-2
        reading and answer dpr 1 for every fractional ratio a reader's display actually has.

        `None` IS THE OFF SWITCH and it is not decoration: a ratio outlives a navigation, so a run
        that set one and did not put it back would hand every later gate in the same session a
        viewport nobody asked for.
        """
        self.call("browsingContext.setViewport",
                  {"context": self.ctx,
                   "devicePixelRatio": None if ratio is None else float(ratio)})

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

    @contextlib.contextmanager
    def held(self, *names: str):
        """Hold modifier keys DOWN across whatever the block does, POINTER AND WHEEL ACTIONS INCLUDED.

        WHY THIS IS NOT `press(..., ctrl=True)`. That helper opens and closes the modifier inside
        ONE key sequence, so nothing but a key can happen under it. Every modifier-plus-pointer
        gesture this shell has is therefore unreachable from here: Ctrl+press extends a selection
        (`src/bin/files.mjs`'s `WMOD_CTRL` branch) and a Ctrl-drag is what reports
        `DOBJ_EFFECT_COPY` rather than a move. A driver that could not hold a modifier over a press
        could only drive the unmodified half of M21's row — and the unmodified half is the one whose
        unit errors this project has already paid for twice in Chrome.

        IT RESTS ON WEBDRIVER'S INPUT STATE OUTLIVING ONE `performActions`, WHICH IS MEASURED AND
        NOT READ OFF THE SPEC: `python3 scripts/bidi.py` holds Control, clicks, and asserts the
        `mousedown` arrived with `ctrlKey === true` and `isTrusted === true`, then releases and
        asserts the next one did not. A modifier that silently did not stick turns a Ctrl-click into
        a plain click — a DIFFERENT gesture that replaces the selection instead of extending it, and
        a gate built on one would report the program at fault for a row that went away.

        AND IT HOLDS OVER A `wheel` SOURCE TOO, which is a SECOND reading and was unmeasured until
        M23 needed it. A wheel is its own BiDi input type — `self.wheel` names a source of its own,
        not the pointer's — so "the modifier state is global to the session" was an assumption about
        a different source. Measured by the self-test: a `wheel` event under this block arrives
        `ctrlKey === true`, `isTrusted === true`, `deltaMode === 0`, and the next one does not.
        It matters because Ctrl+wheel is the ONLY wheel gesture in this system that means something
        other than scrolling — `src/bin/files.mjs` reads it as the view slider (PRD A1), and Windows'
        own Ctrl+Shift+1..7 cannot reach a program at all (`bytesForKey` drops a Ctrl chord that is
        not a C0 letter). A dropped modifier there does not fail: it SCROLLS, which is a working
        gesture for the wrong verb and reads as a view mode that would not change.

        THE RELEASE IS IN A `finally` BECAUSE A STUCK MODIFIER POISONS THE REST OF THE SESSION, not
        just the block: every later keystroke would arrive as Ctrl+key, and `input.releaseActions`
        is the only other thing that would undo it.
        """
        unknown = [n for n in names if n not in KEYS]
        if unknown:
            raise BidiError("no BiDi key value recorded for %s; KEYS has %s"
                            % (", ".join(map(repr, unknown)), ", ".join(sorted(KEYS))))
        self.keys([{"type": "keyDown", "value": KEYS[n]} for n in names])
        try:
            yield self
        finally:
            self.keys([{"type": "keyUp", "value": KEYS[n]} for n in reversed(names)])

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
        # `held` HOLDS A MODIFIER OVER A POINTER PRESS, which is the claim its docstring rests on.
        # Three readings in one, because each alone passes in a world the others catch: the press
        # under the block carries `ctrlKey`, it is still trusted, and the press AFTER the block does
        # NOT — a modifier that never released is as wrong as one that never arrived, and both look
        # like a working click.
        ff.evaluate("(() => { window.__mods = []; document.body.addEventListener('mousedown',"
                    " (e) => window.__mods.push([e.ctrlKey, e.isTrusted])); return 1 })()")
        with ff.held("Control"):
            ff.click(30, 30)
        ff.click(30, 30)
        mods = ff.evaluate("JSON.stringify(window.__mods)")
        print("held     mousedown [ctrlKey, isTrusted] %s" % (mods,))
        if mods != [[True, True], [False, True]]:
            bad.append("`held('Control')` did not hold a modifier over a trusted pointer press "
                       "and release it afterwards: wanted [[true,true],[false,true]], got %r"
                       % (mods,))

        # `held` OVER A WHEEL SOURCE, which is `held`'s second claim and a different one: a wheel is
        # its own BiDi input type, so a modifier that is held over a POINTER press says nothing
        # about one. Three readings again, and the third is the one that catches a stuck modifier —
        # a Ctrl+wheel that never released would make every later scroll a view change.
        #
        # THE DELTA IS ASSERTED TOO, in the unit this wire uses: `deltaMode === 0` is pixels and the
        # page receives the CSS figure that was asked for, where a CDP delta is device px and the
        # event reports `deltaY / devicePixelRatio` (constraint 297). A gate that mixed the two
        # scrolls by the ratio too far.
        ff.evaluate("(() => { window.__wheel = []; document.addEventListener('wheel',"
                    " (e) => { e.preventDefault();"
                    "   window.__wheel.push([e.ctrlKey, e.isTrusted, e.deltaY, e.deltaMode]) },"
                    " { passive: false }); return 1 })()")
        with ff.held("Control"):
            ff.wheel(40, 40, 120)
        ff.wheel(40, 40, 120)
        wheels = ff.evaluate("JSON.stringify(window.__wheel)")
        print("held     wheel [ctrlKey, isTrusted, deltaY, deltaMode] %s" % (wheels,))
        if wheels != [[True, True, 120, 0], [False, True, 120, 0]]:
            bad.append("`held('Control')` did not hold a modifier over a trusted WHEEL and release "
                       "it afterwards, or the delta did not arrive in CSS px: wanted "
                       "[[true,true,120,0],[false,true,120,0]], got %r" % (wheels,))

        # `set_viewport` ASSERTED, because a driver method nobody ran is a method that silently
        # does not work — and the gate that needs it NARROWS until a band overflows, so a no-op
        # resize would report "no viewport leaves the band overflowing" and blame the shell.
        ff.set_viewport(420, 500)
        narrow = ff.evaluate("JSON.stringify([innerWidth, innerHeight, devicePixelRatio])")
        print("viewport %s after set_viewport(420, 500)" % (narrow,))
        if narrow[:2] != [420, 500]:
            bad.append("set_viewport did not resize the viewport: wanted [420, 500], got %r"
                       % (narrow[:2],))

        # `set_dpr` ASSERTED AT FOUR READINGS, because the claim in its docstring is the one that
        # overturns a sentence in `CLAUDE.md` and each reading alone passes in a world the others
        # catch: an integer ratio arrives, a FRACTIONAL one arrives unrounded (a clamp to the
        # nearest integer would pass the first reading and fail every real display), the ratio
        # SURVIVES A NAVIGATION — which is what lets a gate choose a ratio before loading the page
        # it is about — and `None` puts the engine's own back, because a ratio left set would hand
        # the next thing driven in this session a viewport nobody asked for.
        ratios = []
        for ask in (2, 1.5):
            ff.set_dpr(ask)
            ratios.append(ff.evaluate("devicePixelRatio"))
        ff.navigate("data:text/html,<h3 id=y>after</h3>")
        ratios.append(ff.evaluate("devicePixelRatio"))
        ff.set_dpr(None)
        ratios.append(ff.evaluate("devicePixelRatio"))
        print("dpr      %s after set_dpr(2), set_dpr(1.5), a navigation, and set_dpr(None)"
              % (ratios,))
        if ratios != [2, 1.5, 1.5, 1]:
            bad.append("set_dpr did not choose the context's ratio, keep it across a navigation "
                       "and release it: wanted [2, 1.5, 1.5, 1], got %r" % (ratios,))

        print("firefox %s" % ff.evaluate("navigator.userAgent"))
    if bad:
        for line in bad:
            print("BAD  %s" % line)
        return 1
    print("ok: Firefox can be navigated, evaluated and given REAL trusted input")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
