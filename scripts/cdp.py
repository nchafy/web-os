"""Chrome DevTools Protocol client, driving the Chrome already on the machine.

Copied verbatim from the Show Up NYC project (`src/showup/cdp.py`), which is the
author's own, and unmodified below this docstring so a fix there can be re-copied.

Needs `websocket-client`; everything else is stdlib. A check harness that installs its
own browser would be a bigger dependency than the site it checks, so this drives the
system Chrome instead.
"""

from __future__ import annotations

import contextlib
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from types import TracebackType
from typing import Any, ClassVar
from urllib.parse import urlsplit

from websocket import (
    ABNF,
    WebSocketConnectionClosedException,
    WebSocketException,
    create_connection,
)

#: Shared by every browser-driving script here, so there is one list to update.
CHROME_CANDIDATES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    shutil.which("google-chrome") or "",
    shutil.which("google-chrome-stable") or "",
    shutil.which("chromium") or "",
    shutil.which("chromium-browser") or "",
)


class CDPError(RuntimeError):
    """Chrome, or the channel to it, did something we cannot continue from."""


def find_chrome() -> str | None:
    """The first Chrome or Chromium on this machine, or None."""
    return next((path for path in CHROME_CANDIDATES if path and Path(path).exists()), None)


class WebSocket:
    """A CDP-shaped channel over `websocket-client`, which owns the RFC 6455 framing —
    frame headers, client masking, continuation reassembly and pings."""

    def __init__(self, url: str, timeout: float = 30.0) -> None:
        if urlsplit(url).scheme != "ws":
            raise CDPError(f"expected a ws:// url, got {url!r}")
        try:
            self._socket = create_connection(
                url,
                timeout=timeout,
                # Chrome's debugging endpoint rejects an upgrade carrying an Origin.
                suppress_origin=True,
                # The library's validator is a per-byte Python loop, ~0.1 s per megabyte,
                # and `recv_text` decodes strictly anyway (tests/unit/test_cdp.py).
                skip_utf8_validation=True,
                # One request is ever in flight, so the read lock buys nothing.
                enable_multithread=False,
            )
        except (WebSocketException, OSError) as error:
            raise CDPError(f"websocket upgrade refused: {error}") from error

    def send_text(self, text: str) -> None:
        try:
            self._socket.send(text)
        except (WebSocketException, OSError) as error:
            raise CDPError(f"lost the channel to Chrome while sending: {error}") from error

    def recv_text(self) -> str:
        """The next complete text message, with continuation frames already reassembled."""
        try:
            opcode, payload = self._socket.recv_data()
        except WebSocketConnectionClosedException as error:
            raise CDPError("connection closed mid-frame") from error
        except (WebSocketException, OSError) as error:
            raise CDPError(f"lost the channel to Chrome: {error}") from error
        if opcode == ABNF.OPCODE_CLOSE:
            raise CDPError("Chrome closed the connection")
        return payload.decode("utf-8") if isinstance(payload, bytes) else payload

    def close(self) -> None:
        """Close the socket, tolerating a Chrome that has already gone."""
        # Bounded, because a socket that accepts the close frame and never answers would
        # otherwise hold up `Browser.__exit__`.
        with contextlib.suppress(WebSocketException, OSError):
            self._socket.close(timeout=1)


class Session:
    """A CDP session against one page target.

    Every `call` is synchronous and buffers events that arrive before its response, so
    one request is ever in flight and no reader thread or future registry is needed.
    """

    def __init__(self, websocket: WebSocket) -> None:
        self._websocket = websocket
        self._last_id = 0
        self._events: list[dict[str, Any]] = []

    def call(self, method: str, **params: Any) -> dict[str, Any]:
        self._last_id += 1
        request_id = self._last_id
        self._websocket.send_text(
            json.dumps({"id": request_id, "method": method, "params": params})
        )
        while True:
            message = json.loads(self._websocket.recv_text())
            if message.get("id") == request_id:
                if "error" in message:
                    raise CDPError(f"{method}: {message['error'].get('message')}")
                return message.get("result") or {}
            if "method" in message:
                self._events.append(message)

    def drain_events(self) -> None:
        """Forget buffered events, so a `wait_for` cannot match a stale one."""
        self._events.clear()

    def consume_events(self) -> list[dict[str, Any]]:
        """Take every buffered event, leaving the buffer empty."""
        events, self._events = self._events, []
        return events

    def wait_for(self, method: str, timeout: float = 30.0) -> dict[str, Any]:
        for index, message in enumerate(self._events):
            if message["method"] == method:
                return self._events.pop(index).get("params") or {}
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            message = json.loads(self._websocket.recv_text())
            if message.get("method") == method:
                return message.get("params") or {}
            if "method" in message:
                self._events.append(message)
        raise CDPError(f"timed out after {timeout}s waiting for {method}")

    def evaluate(self, expression: str, *, await_promise: bool = False) -> Any:
        """Run JavaScript in the page and return the value.

        A page exception raises rather than returning None, so a check that could not run
        cannot report clean.
        """
        result = self.call(
            "Runtime.evaluate",
            expression=expression,
            returnByValue=True,
            awaitPromise=await_promise,
        )
        if "exceptionDetails" in result:
            details = result["exceptionDetails"]
            description = (details.get("exception") or {}).get("description")
            raise CDPError(f"page script failed: {description or details.get('text')}")
        return (result.get("result") or {}).get("value")

    def navigate(self, url: str, timeout: float = 60.0) -> None:
        self.call("Page.enable")
        self.drain_events()
        self.call("Page.navigate", url=url)
        self.wait_for("Page.loadEventFired", timeout=timeout)

    #: Key name -> (virtual key code, the text the key inserts, if it inserts any).
    KEYS: ClassVar[dict[str, tuple[int, str]]] = {
        "Tab": (9, ""),
        "Enter": (13, "\r"),
        "Escape": (27, ""),
        "Space": (32, " "),
        # The combobox pattern is driven with these, so they have to be real keypresses
        # rather than synthesised events.
        "ArrowUp": (38, ""),
        "ArrowDown": (40, ""),
        # M13 drives a window's keyboard move with these, and asserts both ends of the step: a
        # plain arrow is KEY_STEP px and Shift one px (src/wm/window.mjs).
        "ArrowLeft": (37, ""),
        "ArrowRight": (39, ""),
    }

    @staticmethod
    def _event_type_for_key(inserted_text: str) -> str:
        """`keyDown` for a key that inserts text, `rawKeyDown` for one that does not.

        A text-less `keyDown` leaves Chrome waiting for a `char` event and Tab never moves
        focus; Enter as `rawKeyDown` skips Blink's implicit form submission.
        """
        return "keyDown" if inserted_text else "rawKeyDown"

    def press(self, key: str, *, shift: bool = False) -> None:
        """Dispatch a real keypress."""
        if key not in self.KEYS:
            raise CDPError(f"no virtual key code recorded for {key!r}")
        virtual_key_code, inserted_text = self.KEYS[key]
        for event_type in (self._event_type_for_key(inserted_text), "keyUp"):
            params = {
                "type": event_type,
                "key": key,
                "code": key,
                "windowsVirtualKeyCode": virtual_key_code,
                "nativeVirtualKeyCode": virtual_key_code,
                "modifiers": 8 if shift else 0,
            }
            if inserted_text and event_type == "keyDown":
                params["text"] = inserted_text
                params["unmodifiedText"] = inserted_text
            self.call("Input.dispatchKeyEvent", **params)

    def type_text(self, text: str) -> None:
        """Put text into the focused field in one `Input.insertText`.

        This does NOT produce key events. It is right for a form field, which reads `value`,
        and WRONG for anything that listens for keystrokes - M4a's terminal is the first such
        thing in this project, and `type_keys` below is what it needs.
        """
        self.call("Input.insertText", text=text)

    def type_keys(self, text: str) -> None:
        """Type `text` as real per-character key events.

        One `keyDown` carrying `text`, then `keyUp`, per character - so a `keydown` listener sees
        a trusted event with the right `key`, which `insertText` never delivers. `Enter` is sent
        as its own named key because its `key` is "Enter" and not "\\n", and a terminal's line
        discipline is driven by the byte that mapping produces.

        The virtual key code is left at 0 for printable characters: Chrome does not need it to
        deliver a `text`-carrying `keyDown`, and a table of codes per character would be a second
        keyboard layout to keep correct.
        """
        for ch in text:
            if ch in ("\n", "\r"):
                self.press("Enter")
                continue
            for event_type in ("keyDown", "keyUp"):
                params = {"type": event_type, "key": ch, "code": "", "modifiers": 0}
                if event_type == "keyDown":
                    params["text"] = ch
                    params["unmodifiedText"] = ch
                self.call("Input.dispatchKeyEvent", **params)

    #: Chrome's `modifiers` bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8.
    CTRL = 2

    def press_ctrl(self, letter: str) -> None:
        """Ctrl plus one letter, as a real keypress.

        NO `text`, deliberately. A real Ctrl-C delivers `key: "c"` with the control modifier set
        and inserts nothing; it is the LISTENER that turns that into byte 0x03 (see
        `src/wm/terminal.mjs` `bytesForKey`). Sending `text: "\\x03"` would test a translation
        Chrome does not perform and the widget would never see the modifier.
        """
        code = ord(letter.upper())
        for event_type in ("rawKeyDown", "keyUp"):
            self.call(
                "Input.dispatchKeyEvent",
                type=event_type,
                key=letter.lower(),
                code=f"Key{letter.upper()}",
                windowsVirtualKeyCode=code,
                nativeVirtualKeyCode=code,
                modifiers=self.CTRL,
            )

    def throttle(self, *, download_bps: float, upload_bps: float, latency_ms: float, cpu: float):
        """Shape the network and CPU to the reference profile.

        Both halves matter: an unthrottled developer CPU parses a document several times
        faster than the mid-tier Android the budget is written for.
        """
        self.call("Network.enable")
        self.call(
            "Network.emulateNetworkConditions",
            offline=False,
            latency=latency_ms,
            downloadThroughput=download_bps,
            uploadThroughput=upload_bps,
        )
        self.call("Emulation.setCPUThrottlingRate", rate=cpu)

    def emulate_device(
        self, *, width: int, height: int, scale_factor: float = 2.0, mobile: bool = True
    ) -> None:
        """Override the viewport, independent of the OS window.

        `--window-size` cannot go below ~500 px on macOS and crops silently instead of
        reporting it (docs/OBSERVATIONS.md, 2026-09-23), so a phone width can only be
        measured this way. Sets the initial containing block, which is what a reflow check
        needs: content that cannot fit widens the layout viewport past `width`, and
        `window.innerWidth` then reports the widened value rather than this one.
        """
        self.call(
            "Emulation.setDeviceMetricsOverride",
            width=width,
            height=height,
            deviceScaleFactor=scale_factor,
            mobile=mobile,
        )

    def clear_device_emulation(self) -> None:
        """Hand the viewport back to the window, so one session can mix widths."""
        self.call("Emulation.clearDeviceMetricsOverride")

    def clear_cache(self) -> None:
        """Make the next load genuinely cold."""
        self.call("Network.enable")
        self.call("Network.clearBrowserCache")
        self.call("Network.setCacheDisabled", cacheDisabled=True)


class Browser:
    """A headless Chrome on a throwaway profile, as a context manager.

    The profile is temporary and removed on exit, which is what makes `clear_cache`
    believable and keeps a run out of the developer's own Chrome state.
    """

    def __init__(self, *, extra_args: tuple[str, ...] = (), timeout: float = 30.0,
                 headless: bool = True) -> None:
        self.timeout = timeout
        self._extra_args = extra_args
        #: Headless is the default and is what the suite runs. A HEADED window exists for the one
        #: question headless cannot answer honestly: `--disable-gpu` plus SwiftShader composites
        #: correctly but not at the speed a real GPU does, and gap-04's whole Aero budget was
        #: measured in a headed window at 120 Hz. A frame-rate figure taken headless would be a
        #: number about SwiftShader wearing the name of a number about Aero.
        self._headless = headless
        self._process: subprocess.Popen[bytes] | None = None
        self._profile: Path | None = None
        self._sockets: list[WebSocket] = []
        self.port = 0

    def __enter__(self) -> Browser:
        chrome = find_chrome()
        if not chrome:
            raise CDPError("no Chrome or Chromium found")
        try:
            self._launch(chrome)
        except BaseException as error:
            # _await_port raises when Chrome dies before listening or never writes
            # DevToolsActivePort. If that escapes __enter__, `with` never binds, __exit__ never
            # runs, and the Chrome started here plus its temp profile are orphaned - measured as
            # 12 showup-chrome processes at ppid 1 on this machine. Tear down what was already
            # started, then re-raise unchanged.
            self.__exit__(type(error), error, error.__traceback__)
            raise
        return self

    def _launch(self, chrome: str) -> None:
        self._profile = Path(tempfile.mkdtemp(prefix="showup-chrome-"))
        # The two flags a headed run must NOT carry. `--disable-gpu` is the whole point of asking
        # for a window: it routes compositing through SwiftShader, which is correct and slow.
        mode = ["--headless=new", "--disable-gpu"] if self._headless else []
        self._process = subprocess.Popen(
            [
                chrome,
                *mode,
                # Port 0 asks the OS for a free one; a fixed port collides across runs.
                "--remote-debugging-port=0",
                f"--user-data-dir={self._profile}",
                "--no-first-run",
                "--no-default-browser-check",
                "--hide-scrollbars",
                # Software WebGL2, which the map needs and `--disable-gpu` does not give.
                # Chrome no longer falls back to SwiftShader on its own, so without these
                # three MapLibre raises "WebGL2 is required" and every gate would report
                # clean over a map that drew nothing (measured 2026-10-21). A page that
                # creates no GL context is unaffected.
                "--enable-unsafe-swiftshader",
                "--use-gl=angle",
                "--use-angle=swiftshader",
                # Small /dev/shm on CI runners makes Chrome crash on navigation.
                "--disable-dev-shm-usage",
                *self._extra_args,
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.port = self._await_port()

    def _await_port(self) -> int:
        """Read the debugging port Chrome writes to `DevToolsActivePort` once listening."""
        assert self._profile is not None
        port_file = self._profile / "DevToolsActivePort"
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            if self._process is not None and self._process.poll() is not None:
                raise CDPError(f"Chrome exited with {self._process.returncode} before listening")
            if port_file.exists():
                lines = port_file.read_text(encoding="utf-8").splitlines()
                if lines and lines[0].strip().isdigit():
                    return int(lines[0].strip())
            time.sleep(0.05)
        raise CDPError("Chrome never reported a debugging port")

    def page(self) -> Session:
        """A session against Chrome's initial `about:blank` page target."""
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{self.port}/json/list", timeout=self.timeout
                ) as response:
                    targets = json.loads(response.read())
            except (urllib.error.URLError, OSError):
                time.sleep(0.05)
                continue
            for target in targets:
                if target.get("type") == "page" and target.get("webSocketDebuggerUrl"):
                    websocket = WebSocket(target["webSocketDebuggerUrl"], timeout=self.timeout)
                    self._sockets.append(websocket)
                    return Session(websocket)
            time.sleep(0.05)
        raise CDPError("Chrome never offered a page target")

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        for websocket in self._sockets:
            websocket.close()
        if self._process is not None:
            self._process.terminate()
            try:
                self._process.wait(timeout=10)
            except subprocess.TimeoutExpired:  # pragma: no cover - Chrome ignoring SIGTERM
                self._process.kill()
        if self._profile is not None:
            shutil.rmtree(self._profile, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:  # pragma: no cover - smoke test only
    """Load a URL and print its title, to prove the channel works end to end."""
    url = (argv or sys.argv[1:] or ["about:blank"])[0]
    with Browser() as browser:
        page = browser.page()
        page.navigate(url)
        print(page.evaluate("document.title"))
    return 0


if __name__ == "__main__":  # pragma: no cover - entry point
    raise SystemExit(main())
