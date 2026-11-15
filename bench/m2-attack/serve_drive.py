#!/usr/bin/env python3
"""Drive www/m0.html against a real `scripts/serve.py` process and print M0's terminal state."""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

REPO = Path("/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl")
sys.path.insert(0, str(REPO / "scripts"))
from cdp import Browser  # noqa: E402

port = int(sys.argv[1])
root = sys.argv[2]
extra = sys.argv[3:]

proc = subprocess.Popen(
    [str(REPO / ".venv/bin/python"), str(REPO / "scripts/serve.py"),
     "--port", str(port), "--root", root, *extra],
    cwd=str(REPO), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
time.sleep(1.5)
try:
    with Browser(extra_args=("--enable-features=SharedArrayBuffer",)) as browser:
        page = browser.page()
        page.navigate(f"http://127.0.0.1:{port}/{'www/' if root != 'www' else ''}m0.html?n=1&window_ms=200&warmup=100")
        deadline = time.monotonic() + 40
        state = None
        while time.monotonic() < deadline:
            state = page.evaluate("globalThis.M0 ? globalThis.M0.state : 'NO M0 OBJECT'")
            if state in ("done", "aborted", "error", "NO M0 OBJECT"):
                break
            time.sleep(0.2)
        print("M0.state =", state)
        print("M0.why   =", page.evaluate("globalThis.M0 ? (globalThis.M0.why||'') : ''"))
        print("has cells =", page.evaluate("globalThis.M0 ? (globalThis.M0.cells||[]).length : -1"))
        print("page text =", repr(page.evaluate("document.body.innerText")))
finally:
    proc.terminate()
    out = proc.communicate(timeout=10)[0]
    print("--- serve.py output ---")
    print(out[-2000:])
