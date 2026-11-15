"""Re-point the attack scripts' MAIN_OLD at www/m2.html's runner as it now reads.

The attack PAYLOADS are untouched. m2.html's runner now carries nine sections, so the list
literal the scripts replace has moved again; without this their own assert fires.
"""
import pathlib
import re

NEW_LITERAL = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['order', ordering], ['api', apiSurface]]) {"""

PAGE = pathlib.Path(
    "/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl/www/m2.html").read_text()
assert PAGE.count(NEW_LITERAL) == 1, PAGE.count(NEW_LITERAL)

PATTERN = re.compile(r'MAIN_OLD = """.*?"""', re.S)
for name in ("vattack.py", "vattack2.py", "vattack3.py", "vattack4.py"):
    p = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp") / name
    t = p.read_text()
    new, n = PATTERN.subn('MAIN_OLD = """%s"""' % NEW_LITERAL, t, count=1)
    assert n == 1, name
    p.write_text(new)
    print("%s: MAIN_OLD re-pointed" % name)
