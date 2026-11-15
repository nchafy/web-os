"""Re-point the verifier's three attack scripts at the new main() loop in www/m2.html.

The attack PAYLOADS (FN, PAGE_FN) are untouched: the only thing that moved is the list literal
the script replaces, because m2.html's runner now carries an eighth section. Without this the
scripts' own assert fires rather than silently patching nothing.
"""
import pathlib

OLD = """MAIN_OLD = \"\"\"  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['refuse', refusedMount], ['order', ordering],
    ['api', apiSurface]]) {\"\"\""""

NEW = """MAIN_OLD = \"\"\"  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['refuse', refusedMount],
    ['order', ordering], ['api', apiSurface]]) {\"\"\""""

for name in ("vattack.py", "vattack2.py", "vattack3.py", "vattack4.py"):
    p = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp") / name
    t = p.read_text()
    if OLD not in t:
        print("%s: already re-pointed or different" % name)
        continue
    p.write_text(t.replace(OLD, NEW))
    print("%s: MAIN_OLD re-pointed" % name)
