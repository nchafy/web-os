#!/usr/bin/env python3
"""Round 7f: does the suite's own concurrency reach the stale compare-and-swap?

`www/m2.html`'s `casContend` and `casRetry` drive TWO writers for CAS_ROUNDS=200 rounds each, and
`cas contention refuses only under EBUSY` is a registered clause that an -EIO from the stale-CAS
refusal would turn red. The full suite passed, so either the clause is too weak or two writers do
not reach the window. This runs the round-7c census at two writers and at three, on the same
volume shape, and reports `refusedCommits` and the per-errno census for each — so "the suite does
not reach it" is a measurement rather than an excuse.
"""
import pathlib
import sys

sys.path.insert(0, "/Users/chafyni/.claude/jobs/e856c39e/tmp")
from vattack21 import IOCORE, STORE  # noqa: E402
from vattack22 import CASE, FN  # noqa: E402

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk25")

PAGE_FN = """
async function v25run(values) {
  const out = { writers: values.length }
  await wipe()
  let k = kernelBoot(BOOT_CFG)
  const path = pathFor(1)
  try {
    const up = await k.expect('up', 20000)
    if (up.fs.mode !== 'rw') return { at: 'mount', mode: up.fs.mode }
    await install(k)
    const made = await once(k, ['mkfiles', '4'])
    if (!made.ok) return { at: 'mkfiles', errors: made.errors }
    const pids = []
    for (const v of values) pids.push(await spawnProcess(k, ['v22mix', path + '|' + v + ',200']))
    for (let i = 0; i < pids.length; i += 1) {
      k.post({ t: 'go',
        go: { mode: 'park', pid: pids[i], argv: ['v22mix', path + '|' + values[i] + ',200'] } })
    }
    const errnos = { write: [], sync: [], read: [], stat: [] }
    let rounds = 0
    for (let i = 0; i < pids.length; i += 1) {
      const r = await rowFor(k, pids[i], 300000, 'v22mix ' + values[i])
      rounds += r.rounds
      for (const e of r.writeErrs || []) errnos.write.push(e.errno)
      for (const e of r.syncErrs || []) errnos.sync.push(e.errno)
      for (const e of r.readErrs || []) errnos.read.push(e.errno)
      for (const e of r.statErrs || []) errnos.stat.push(e.errno)
    }
    out.rounds = rounds
    out.errnos = errnos
    k.post({ t: 'fs-state' })
    out.stats = (await k.expect('fs-state', 10000)).fs.stats
    k.post({ t: 'fsck' })
    const ck = await k.expect('fsck', 30000).catch(() => null)
    out.fsck = ck && ck.report
      ? { mountable: ck.report.mountable, problems: (ck.report.problems || []).map((p) => p.what),
          blobs: ck.report.blobs }
      : null
    out.casPassedAMovedGeneration = (k.events || []).flatMap(
      (m) => (m.t === 'io-note' && m.why && /CAS PASSED/.test(m.why) ? [m.why] : []))
    out.refusalNotes = (k.events || []).flatMap(
      (m) => (m.t === 'io-note' && m.why && /was refused/.test(m.why) ? [m.why] : []))
  } catch (e) {
    out.threw = String((e && e.message) || e)
  } finally {
    await shut(k)
  }
  return out
}

async function vattack25() {
  const out = {}
  out.two = await v25run([0x71, 0x72])
  out.three = await v25run([0x71, 0x72, 0x73])
  out.four = await v25run([0x71, 0x72, 0x73, 0x74])
  return { ok: false, evidence: out }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack25]]) {"""

DIAG = [
    ('      this.stats.refusedCommits += 1;\n'
     '      this.note(`commit of inode ${d.ino} generation ${op.gen} over ${at.gen} was refused: `\n'
     '        + `${(error && error.message) || error}`);',
     '      this.stats.refusedCommits += 1;\n'
     '      this.note(`DIAG CAS PASSED A MOVED GENERATION: ino ${d.ino} baseMut ${base.mut} `\n'
     '        + `nowMut ${now.mut} atGen ${at.gen} nowGen ${now.gen} opGen ${op.gen} `\n'
     '        + `vfsGen ${this.vfs.committed(d.ino).gen} staging ${d.dirtyGen}`);\n'
     '      this.note(`commit of inode ${d.ino} generation ${op.gen} over ${at.gen} was refused: `\n'
     '        + `${(error && error.message) || error}`);'),
]


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
    patch("src/kernel/store.mjs", STORE + DIAG)

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
