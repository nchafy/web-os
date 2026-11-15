#!/usr/bin/env python3
"""`node --check` over every module in the repository, plus a LINKER pass.

Worth its own file because a worker's module graph is otherwise only validated by the browser, and
the browser's report of a link failure is the single least useful string in this project: a named
import that does not exist arrives as `kernel worker: undefined` with no file, no line and no
binding. Both of this file's two findings so far were that:

  * `calls.mjs` imported `PERM` from `src/abi.mjs`, where it does not exist (it is `src/fs/vfs.mjs`'s)
  * `store.mjs` imported a constant from `src/kernel/io-worker.mjs`, which assigns `self.onmessage`
    at module scope — so importing it into the DISPATCH kernel silently replaced the kernel's own
    message handler. The constant moved to `src/abi.mjs` and the rule is now checked: nothing may
    import a module that installs a global handler.

    python3 bench/fs-core/syntax.py
"""

from __future__ import annotations

import pathlib
import re
import shutil
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent.parent
SPECIFIER = re.compile(r"""(?:\bfrom|\bimport)\s*["']([^"']+)["']""")
#: `import { a, b as c } from "x"` — the named bindings only. A default or namespace import has
#: nothing to check against the target's exports.
NAMED = re.compile(r"""import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']""", re.S)
EXPORTED = re.compile(
    r"""^\s*export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)""",
    re.M)
EXPORT_LIST = re.compile(r"""export\s*\{([^}]*)\}""", re.S)
#: A module that installs a worker-global handler is an ENTRY POINT, not a library. Importing one
#: into another agent replaces that agent's handler, and nothing reports it.
INSTALLS_HANDLER = re.compile(r"""^\s*self\.on(message|error)\s*=""", re.M)


def exports_of(path: pathlib.Path) -> set[str]:
    text = path.read_text(encoding="utf-8")
    names = set(EXPORTED.findall(text))
    for group in EXPORT_LIST.findall(text):
        for part in group.split(","):
            part = part.strip()
            if not part:
                continue
            names.add(part.split(" as ")[-1].strip() if " as " in part else part)
    # `export const { a, b } = OBJ` — src/abi.mjs's destructuring re-export.
    for group in re.findall(r"""export\s+const\s*\{([^}]*)\}\s*=""", text, re.S):
        for part in group.split(","):
            part = part.strip().rstrip(",")
            if part:
                names.add(part)
    return names


def resolve(path: pathlib.Path, specifier: str) -> pathlib.Path | None:
    """A relative specifier against the importer, or a root-absolute one against the repository.

    Both forms are in use and they mean different things: `src/` resolves relatively for its own
    graph, and a program loaded from a blob URL uses `/src/abi.mjs` because a blob has no
    hierarchical base (src/kernel/kernel.mjs, the program loader).
    """
    if specifier.startswith("/"):
        return REPO / specifier.lstrip("/")
    if specifier.startswith("."):
        return (path.parent / specifier).resolve()
    return None


def main() -> int:
    node = shutil.which("node")
    if not node:
        print("node is not on PATH, so nothing was checked", file=sys.stderr)
        return 3
    files = sorted(
        p for d in ("src", "bench", "scripts") for p in (REPO / d).rglob("*.mjs")
    )
    if not files:
        print("no .mjs files found, so this check measured nothing", file=sys.stderr)
        return 3
    problems = []
    checked_bindings = 0
    for path in files:
        done = subprocess.run([node, "--check", str(path)], capture_output=True, text=True)
        if done.returncode != 0:
            problems.append("%s\n%s" % (path.relative_to(REPO), done.stderr.strip()[:600]))
        text = path.read_text(encoding="utf-8")
        for specifier in SPECIFIER.findall(text):
            target = resolve(path, specifier)
            if target is None:
                continue
            if not target.exists():
                problems.append("%s imports %s, which is not on disk"
                                % (path.relative_to(REPO), specifier))
                continue
            if INSTALLS_HANDLER.search(target.read_text(encoding="utf-8")):
                problems.append(
                    "%s imports %s, which assigns self.onmessage or self.onerror at module "
                    "scope. Importing it into another agent REPLACES that agent's handler and "
                    "nothing reports it" % (path.relative_to(REPO), specifier))
        for group, specifier in NAMED.findall(text):
            target = resolve(path, specifier)
            if target is None or not target.exists():
                continue
            available = exports_of(target)
            if not available:
                continue
            for part in group.split(","):
                name = part.strip().split(" as ")[0].strip()
                if not name or name.startswith("//"):
                    continue
                checked_bindings += 1
                if name not in available:
                    problems.append(
                        "%s imports { %s } from %s, which does not export it. The browser "
                        "reports this as `worker: undefined` with no file and no line"
                        % (path.relative_to(REPO), name, specifier))
    print("syntax.py  %d module(s), %d named import(s) checked"
          % (len(files), checked_bindings))
    for problem in problems:
        print("  FAIL " + problem, file=sys.stderr)
    if problems:
        return 1
    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
