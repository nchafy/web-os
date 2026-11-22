#!/usr/bin/env python3
"""Syntax-check the inline module of every page in `www/`, without a browser.

    scripts/check_pages.py                  # every www/*.html
    scripts/check_pages.py --prove-failure  # inject a syntax error; the run MUST report it
    scripts/check_pages.py www/m14.html     # one page

WHY THIS EXISTS, and it is a cost rather than a principle. `CLAUDE.md` already names
`node -e "import('./src/kernel/kernel.mjs')"` as the fast syntax check for a module, and the reason
it names it is that a duplicate import surfaced in the browser as `worker.onerror` with the message
`undefined` while node named it at once. The pages had no equivalent: their code is an inline
`<script type="module">`, which no file-based tool reads.

MEASURED, on the defect that prompted this: a `const` that shadowed a binding 50 lines above it in
`www/m14.html` took `scripts/check.py --only m14` **420 seconds** to report, as BROKEN with
`never became true within 420.0s` — correct, honest, and a four-hundred-fold waste, because the
page threw before it rendered and the harness can only wait for a state that will never arrive.
This script names the line in about a second.

IT IS NOT A SUBSTITUTE FOR A RUN. `node --check` parses; it does not execute, does not resolve an
import, and knows nothing about whether the page works. A green run here says only that the page
can be parsed — which is exactly the class of failure that is most expensive to find any other way.
"""
from __future__ import annotations

import argparse
import pathlib
import re
import subprocess
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parent.parent

#: The inline module. `type="module"` and not every `<script>`: the classic ones are the little
#: bootstrap blocks that set `globalThis.M14`, and they are not modules — `node --check` would
#: reject a bare `import` in them for the wrong reason.
MODULE_RE = re.compile(r'<script type="module">(.*?)</script>', re.S)

#: What `--prove-failure` injects. A redeclaration rather than a stray bracket, because the defect
#: this script was written for was a redeclaration and a control must break the thing the check is
#: about (CLAUDE.md).
POISON = "\nconst __proveFailure = 1\nconst __proveFailure = 2\n"


def check_source(body: str, label: str) -> str:
    """Parse one module body. Returns "" when it parses, else the error, with its line."""
    with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False) as handle:
        handle.write(body)
        path = handle.name
    try:
        done = subprocess.run(["node", "--check", path], capture_output=True, text=True)
        if done.returncode == 0:
            return ""
        # node prints the temp path; the line number is the useful part and the temp name is not.
        out = (done.stderr or done.stdout or "").strip()
        return out.replace(path, label)
    finally:
        pathlib.Path(path).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pages", nargs="*", help="pages to check; default every www/*.html")
    ap.add_argument("--prove-failure", action="store_true",
                    help="inject a redeclaration into every module; the run MUST report it")
    args = ap.parse_args(argv)

    pages = [pathlib.Path(p) for p in args.pages] or sorted((REPO / "www").glob("*.html"))
    if not pages:
        print("no pages found under www/", file=sys.stderr)
        return 2

    checked = 0
    bad: list[str] = []
    for page in pages:
        text = page.read_text(encoding="utf-8")
        rel = page.relative_to(REPO) if page.is_absolute() else page
        bodies = MODULE_RE.findall(text)
        if not bodies:
            print("%-22s no inline module" % rel)
            continue
        for index, body in enumerate(bodies):
            label = "%s (module %d)" % (rel, index)
            if args.prove_failure:
                body += POISON
            error = check_source(body, label)
            checked += 1
            if error:
                bad.append(error)
                print("%-22s FAIL\n%s" % (label, error))
            else:
                print("%-22s ok  %d lines" % (label, body.count("\n") + 1))

    print("\n%d module(s) checked, %d failed" % (checked, len(bad)))
    if args.prove_failure:
        # EXIT 0 WHEN THE PROOF SUCCEEDED, which is `scripts/check.py`'s own convention: a
        # non-zero exit is reserved for a proof that FAILED to fail.
        if len(bad) == checked and checked:
            print("the proof succeeded: every module reported its injected redeclaration")
            return 0
        print("THE PROOF FAILED: %d of %d modules parsed with a redeclaration in them"
              % (checked - len(bad), checked))
        return 1
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
