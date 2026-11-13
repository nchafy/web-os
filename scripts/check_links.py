#!/usr/bin/env python3
"""Assert every repo-relative path referenced in an authored doc actually exists.

Only the authored docs are checked. `docs/designs/` and `docs/research/` are verbatim artifacts
kept as evidence, and a bare path in them often means a webxp file or a file a candidate design
proposed and which was never built — see CLAUDE.md, Path conventions.

Forward references to files a milestone has not created yet live in OWED, and are listed on
success so they cannot be forgotten silently.
"""
import os
import re
import sys

AUTHORED = [
    'CLAUDE.md', 'README.md', 'CONTEXT.md', 'PLAN.md', 'MILESTONES.md',
    'docs/CONSTRAINTS.md', 'docs/ABI.md', 'docs/DECISIONS.md', 'docs/GLOSSARY.md',
    'docs/LEARNING-MODE.md', 'bench/coep-tiles/README.md', 'src/README.md',
]

#: Referenced on purpose, not built yet. MILESTONES.md says which milestone owes each.
OWED = {
    'scripts/check.py',
}

PATH_RE = re.compile(
    r'[`(]((?:docs/|src/|bench/|scripts/|www/|mockups/|\.\./)[A-Za-z0-9_./\-]+'
    r'\.(?:md|py|mjs|html|json|txt))[`)]'
)


def main() -> int:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)
    broken, checked, missing_docs = [], 0, []

    sibling = set()
    for doc in AUTHORED:
        if not os.path.exists(doc):
            missing_docs.append(doc)
            continue
        text = open(doc).read()
        for m in PATH_RE.finditer(text):
            target = m.group(1)
            checked += 1
            if target in OWED:
                continue
            # References into the predecessor are to a SIBLING repository, not to this one.
            # They do not resolve from a fresh clone, or from inside a git worktree, and that
            # is not an error — CLAUDE.md tells the reader to clone it alongside. Report, never
            # fail, or the checker breaks every time it runs somewhere reasonable.
            if 'webxp/' in target:
                sibling.add(target)
                continue
            # Authored prose writes paths from the repo root; allow doc-relative too.
            candidates = [os.path.normpath(target),
                          os.path.normpath(os.path.join(os.path.dirname(doc), target))]
            if not any(os.path.exists(c) for c in candidates):
                broken.append((doc, target))

    for doc in missing_docs:
        print(f"  MISSING DOC  {doc}")
    for doc, target in sorted(set(broken)):
        print(f"  BROKEN       {doc} -> {target}")

    print(f"checked {checked} path references across {len(AUTHORED)} authored docs")
    if OWED:
        print("owed (referenced on purpose, not built yet): " + ", ".join(sorted(OWED)))
    if sibling:
        parent = os.path.dirname(root)
        here = os.path.isdir(os.path.join(parent, 'webxp'))
        state = 'present' if here else 'NOT CLONED — see CLAUDE.md, Path conventions'
        print(f"sibling repo refs: {len(sibling)} into ../webxp ({state})")
    if broken or missing_docs:
        print(f"FAIL: {len(broken)} broken, {len(missing_docs)} missing")
        return 1
    print("ok")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
