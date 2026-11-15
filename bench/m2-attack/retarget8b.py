#!/usr/bin/env python3
"""Re-target every attack script's `MAIN_OLD` onto today's section list in www/m2.html.

WHY: each vattack*.py replaces the page's section loop with one that runs only its own section, and
it anchors on the loop's EXACT text. This round added an `append` section to that list, so all
forty scripts' anchors went stale at once and every one reported PATCH FAILED — which is a patch
that did not apply, not an attack that found nothing.

The replacement text is READ OUT OF www/m2.html rather than typed, so it cannot be wrong in the way
a typed anchor is. A script whose OTHER anchors are stale still fails on those, and that failure is
the honest one.
"""
import pathlib
import re
import sys

T = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp")
PAGE = pathlib.Path("/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl/www/m2.html")

START = "  for (const [name, fn] of [['proof_a', proof_a]"
END = "]) {"


def main() -> int:
    html = PAGE.read_text(encoding="utf-8")
    at = html.find(START)
    if at < 0:
        print("the page's section loop is not where it was", file=sys.stderr)
        return 9
    end = html.find(END, at)
    loop = html[at:end + len(END)]
    if html.count(loop) != 1:
        print("the loop text is not unique in the page", file=sys.stderr)
        return 9

    pattern = re.compile(r'MAIN_OLD = """.*?"""', re.S)
    touched = 0
    skipped = []
    for path in sorted(T.glob("vattack*.py")):
        text = path.read_text(encoding="utf-8")
        if not pattern.search(text):
            skipped.append(path.name)
            continue
        new = pattern.sub('MAIN_OLD = """%s"""' % loop, text, count=1)
        if new != text:
            path.write_text(new, encoding="utf-8")
            touched += 1
    print(f"re-targeted MAIN_OLD in {touched} script(s)"
          + (f"; no MAIN_OLD in {', '.join(skipped)}" if skipped else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
