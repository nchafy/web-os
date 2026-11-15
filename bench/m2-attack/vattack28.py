#!/usr/bin/env python3
"""Round 7 attack 28: an explicit fsck that races a blob free reports the volume CORRUPT.

`store.blobListing()` turns an errno from IO_LIST into an EMPTY ARRAY, and `fsck()` tests
`if (input.blobs)` — `[]` is truthy, so a listing that FAILED is indistinguishable from a blob
directory that is empty. Every committed blob is then "missing", which is the loudest verdict this
filesystem has: "intact metadata pointing at torn data", the thing copy-on-write exists to prevent.

The listing fails because `list` does a `getFile()` per name (constraint 33's 0.60 ms) and a
copy-on-write swing REMOVES the superseded generation's directory entry. Enumerate while a writer
is swinging and one of those `getFile()` calls lands on a name that has just gone:
NotFoundError, which iocore correctly notes and converts to an errno — and which the Store then
discards.

The writer here does nothing exotic: pwrite at offset 0, fsync, in a loop. The page asks for an
fsck while it runs, which is what constraint 33 says the explicit fsck is FOR.
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk28")

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "v28churn": out = v28churn(env, String(arg)); break;\n')

FN = '''
/* ---------------- ATTACK 28: A SWEEP THAT RACES A FREE ---------------- */

/** `path|rounds`: a below-the-size write and an fsync, which is one copy-up, one swing and one
 *  free per round. Nothing else. */
function v28churn(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const rounds = Number(spec.slice(bar + 1)) || 1;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const buf = new Uint8Array(4).fill(0x28);
  const errs = [];
  let done = 0;
  for (let i = 0; i < rounds; i += 1) {
    const w = fs.pwrite(fd, buf, 0);
    if (w < 0) { errs.push(-w); continue; }
    const s = fs.fsync(fd);
    if (s < 0) { errs.push(-s); continue; }
    done += 1;
  }
  const c = fs.close(fd);
  return { ok: true, done, rounds, close: c, errnoCount: errs.length,
    errnos: errs.slice(0, 8) };
}
'''

PAGE_FN = """
const V28 = { rounds: 600, fscks: 14 }

/** ATTACK 28. An fsck per 30 ms while one process swings a generation per fsync. */
async function vattack28() {
  const out = { rounds: V28 }
  await wipe()
  const k = kernelBoot(BOOT_CFG)
  const path = pathFor(1)
  out.path = path
  try {
    const up = await k.expect('up', 20000)
    if (!up.fs || up.fs.mode !== 'rw') return { ok: false, evidence: { at: 'mount', up: up.fs } }
    await install(k)
    const made = await once(k, ['mkfiles', '8'])
    if (!made.ok) return { ok: false, evidence: { at: 'mkfiles', errors: made.errors } }
    const argv = ['v28churn', path + '|' + V28.rounds]
    const pid = await spawnProcess(k, argv)
    k.post({ t: 'go', go: { mode: 'park', pid, argv } })
    const reports = []
    for (let i = 0; i < V28.fscks; i += 1) {
      k.post({ t: 'fsck' })
      const ck = await k.expect('fsck', 60000).catch(() => null)
      const r = ck && ck.report
      reports.push(r ? {
        mountable: r.mountable,
        problems: (r.problems || []).map((p) => p.what),
        why: (r.problems || []).map((p) => String(p.why || '').slice(0, 90))[0] || '',
        have: r.blobs ? r.blobs.have : -1,
        want: r.blobs ? r.blobs.want : -1,
        missing: r.blobs ? r.blobs.missing.length : -1,
        swept: r.blobs ? r.blobs.swept : null,
      } : { no: true })
      await new Promise((rr) => setTimeout(rr, 30))
    }
    out.during = reports
    out.row = await rowFor(k, pid, 180000, 'v28churn').then(
      (r) => ({ ok: r.ok, done: r.done, rounds: r.rounds, close: r.close,
        errnoCount: r.errnoCount, errnos: r.errnos }),
      (e) => ({ MISSING: String(e && e.message) }))
    // QUIESCENT, with the same code and the same volume: the control for the verdicts above.
    k.post({ t: 'fsck' })
    const quiet = await k.expect('fsck', 120000).catch(() => null)
    out.quiet = quiet && quiet.report
      ? { mountable: quiet.report.mountable,
          problems: (quiet.report.problems || []).map((p) => p.what),
          have: quiet.report.blobs ? quiet.report.blobs.have : -1,
          want: quiet.report.blobs ? quiet.report.blobs.want : -1 }
      : null
    out.notes = (k.events || []).flatMap((m) => (m.t === 'io-note' && m.why ? [m.why] : []))
      .slice(0, 6)
  } catch (e) {
    out.threw = String((e && e.message) || e)
  } finally {
    await shut(k)
  }
  const k2 = kernelBoot(BOOT_CFG)
  try {
    const up = await k2.expect('up', 20000)
    out.remount = { mode: up.fs && up.fs.mode,
      problems: (up.fs && up.fs.report && up.fs.report.problems ? up.fs.report.problems : [])
        .map((p) => p.what) }
    k2.post({ t: 'fsck' })
    const ck = await k2.expect('fsck', 120000).catch(() => null)
    out.fsckAfter = ck && ck.report
      ? { mountable: ck.report.mountable,
          problems: (ck.report.problems || []).map((p) => p.what),
          blobs: ck.report.blobs }
      : null
  } catch (e) {
    out.remountThrew = String((e && e.message) || e)
  } finally {
    await shut(k2)
  }
  const bad = (out.during || []).filter((r) => r.problems && r.problems.length)
  const empty = (out.during || []).filter((r) => r.have === 0)
  out.falseCorrupt = bad.length
  out.emptyListings = empty.length
  out.ofN = (out.during || []).length
  // THE VOLUME WAS HEALTHY THE WHOLE TIME, which is what makes the verdicts above false.
  out.healthyAfter = !!(out.fsckAfter && out.fsckAfter.mountable === 'rw'
    && out.fsckAfter.problems.length === 0)
  say('    fsck under churn: ' + out.falseCorrupt + '/' + out.ofN + ' reported problems, '
    + out.emptyListings + ' saw an empty blob directory; healthy afterwards '
    + String(out.healthyAfter))
  return { ok: false, evidence: out }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack28]]) {"""


def main() -> int:
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
