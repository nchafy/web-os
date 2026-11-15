#!/usr/bin/env python3
"""GAP 6: one failed journal append must not wedge the appender for the rest of the mount.

    gap6.py <tree>

The appender refuses any record whose sequence is not the one it expects, and its expectation only
advances on a SUCCESSFUL append — while src/kernel/store.mjs allocates the number before the append
and burns it on failure. So the first transient append error used to make every later append refuse
for the life of the mount.

THE INJECTION IS A TRANSIENT WRITE FAILURE, placed after the appender's invariant check and before
the bytes land, which is exactly the state a quota or I/O error leaves: the number was allocated,
the record did not land, and nothing told the appender. It fires once, on the record that carries
the name `g6-5`, so which op fails is deterministic rather than a count of appends nobody can
predict.

The measurement is the number of metadata ops that SUCCEED AFTER the injected failure.
"""
import pathlib
import sys

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "")

IOCORE = [
    ('      case "append": {\n'
     '        const bytes = new Uint8Array(m.bytes);',
     '      case "append": {\n'
     '        const bytes = new Uint8Array(m.bytes);\n'
     '        // GAP 6 INJECTION: one transient write failure, after the invariant check and\n'
     '        // before the write, on the record that carries this name.\n'
     '        if (!g6Fired && new TextDecoder().decode(bytes).includes("g6-5")) {\n'
     '          g6Fired = true;\n'
     '          note("G6 INJECTED a transient append failure");\n'
     '          return -EIO;\n'
     '        }'),
    ('  let journalSeq = null;',
     '  let journalSeq = null;\n  let g6Fired = false;'),
]

FN = '''
/** GAP 6: N mkdirs, each one's errno kept. The record naming g6-5 is the one the injection fails. */
function g6ops(env, spec) {
  const fs = env.fs;
  const n = Number(spec) || 10;
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const r = fs.mkdir(`/d/2/g6-${i}`, 0o755);
    rows.push({ i, errno: r < 0 ? -r : 0 });
  }
  const st = fs.stat(`/d/2/g6-${n - 1}`);
  return { ok: true, n, rows,
    failed: rows.filter((x) => x.errno !== 0).map((x) => x.i),
    lastExists: typeof st === "number" ? -st : 0 };
}
'''

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "g6ops": out = g6ops(env, String(arg)); break;\n')

PAGE_FN = """
async function gap6() {
  const out = {}
  await wipe()
  let k = kernelBoot(BOOT_CFG)
  try {
    const up = await k.expect('up', 20000)
    if (up.fs.mode !== 'rw') return { ok: false, evidence: { at: 'mount', mode: up.fs.mode } }
    await install(k)
    out.ops = await once(k, ['g6ops', '10'], 60000)
    k.post({ t: 'fs-state' })
    const st = (await k.expect('fs-state', 10000)).fs
    out.stats = st.stats
    out.mode = st.mode
    out.notes = (k.events || []).flatMap((m) => (m.t === 'io-note' && m.why ? [m.why] : []))
  } catch (e) {
    out.threw = String((e && e.message) || e)
  } finally {
    await shut(k)
  }
  k = kernelBoot(BOOT_CFG)
  try {
    const up = await k.expect('up', 20000)
    out.remount = { mode: up.fs.mode,
      problems: (up.fs.report && up.fs.report.problems ? up.fs.report.problems : [])
        .map((p) => p.what),
      journal: up.fs.report && up.fs.report.journal }
  } catch (e) {
    out.remount = { threw: String((e && e.message) || e) }
  } finally {
    await shut(k)
  }
  const rows = (out.ops || {}).rows || []
  const failed = rows.filter((x) => x.errno !== 0).map((x) => x.i)
  const firstFail = failed.length ? failed[0] : -1
  out.firstFailure = firstFail
  out.failedOps = failed
  out.opsAfterTheFailure = firstFail < 0 ? 0 : rows.length - firstFail - 1
  out.succeededAfterTheFailure = firstFail < 0
    ? 0 : rows.filter((x) => x.i > firstFail && x.errno === 0).length
  // THE CLAIM: exactly one op failed - the injected one - and every op after it landed.
  out.theAppenderKeptWorking = firstFail >= 0 && failed.length === 1
    && out.succeededAfterTheFailure === out.opsAfterTheFailure
    && out.opsAfterTheFailure > 0
  out.burns = (out.stats || {}).journalBurns
  return { ok: out.theAppenderKeptWorking === true, evidence: out }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', gap6]]) {"""


def patch(rel, pairs):
    path = ROOT / rel
    text = path.read_text()
    for old, new in pairs:
        n = text.count(old)
        assert n == 1, "anchor in %s matched %d time(s): %r" % (rel, n, old[:70])
        text = text.replace(old, new)
    path.write_text(text)
    print("patched %s (%d anchor(s))" % (rel, len(pairs)))


def main() -> int:
    patch("src/kernel/iocore.mjs", IOCORE)
    prog = ROOT / "bench" / "fs-core" / "program.mjs"
    text = prog.read_text()
    assert text.count(CASE[0]) == 1, text.count(CASE[0])
    prog.write_text(text.replace(*CASE) + FN)
    print("patched program.mjs")
    page = ROOT / "www" / "m2.html"
    html = page.read_text()
    assert html.count(MAIN_OLD) == 1, html.count(MAIN_OLD)
    html = html.replace(MAIN_OLD, MAIN_NEW)
    html = html.replace("async function main() {", PAGE_FN + "\nasync function main() {", 1)
    page.write_text(html)
    print("patched m2.html")
    return 0


if __name__ == "__main__":
    sys.exit(main())
