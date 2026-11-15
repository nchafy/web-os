#!/usr/bin/env python3
"""Round 13: a SNAPSHOT taken while commits are in flight.

`writeSnapshot` flushes the journal, encodes the in-memory image, writes the slot, and THEN
truncates the journal and moves `journalFirstSeq` to `this.seq`. Three awaits sit between the
encode and the truncate. A commit that appends its record inside that window is in neither place
afterwards: not in the image (encoded before it), and not in the journal (truncated after it).

One process fsyncs in a loop; the page posts snapshots while it runs. Every range whose `fsync`
returned 0 must be in the file after a remount.
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk13")

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "v13": out = v13(env, String(arg)); break;\n'
        '    case "v13check": out = v13check(env, String(arg)); break;\n')

FN = '''
/* ---------------- THE VERIFIER'S ATTACKS, ROUND 13: A SNAPSHOT MID-COMMIT ---------------- */

const R13 = { rounds: 40, byte: 0xd7, len: 4 };

function v13(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
  const S = Number(st.size);
  const buf = new Uint8Array(R13.len).fill(R13.byte);
  const per = [];
  for (let i = 0; i < R13.rounds; i += 1) {
    const at = S + i * R13.len;
    const w = fs.pwrite(fd, buf, at);
    const s = fs.fsync(fd);
    per.push({ i, at, w, s });
  }
  const end = fs.fstat(fd);
  const c = fs.close(fd);
  return { ok: true, S, close: c, per,
    acknowledged: per.filter((r) => r.w === R13.len && r.s === 0).length,
    fdSize: typeof end === "number" ? -end : Number(end.size) };
}

/** Which acknowledged ranges are actually in the file. */
function v13check(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const size = Number(st.size);
  const got = fs.readAll(fd, size);
  fs.close(fd);
  if (typeof got === "number") return { ok: false, at: "read", errno: -got };
  let marked = 0;
  for (let i = 0; i < size; i += 1) if (got[i] === R13.byte) marked += 1;
  return { ok: true, size, read: got.length, marked, bytes: [...got] };
}
'''

PAGE_FN = """
/** ROUND 13. Snapshots posted while a process is committing. */
async function vattack13() {
  const out = {}
  await wipe()
  const k = kernelBoot(BOOT_CFG)
  const path = pathFor(1)
  try {
    const up = await k.expect('up', 20000)
    if (up.fs.mode !== 'rw') return { ok: false, evidence: { at: 'mount', mode: up.fs.mode } }
    await install(k)
    const made = await once(k, ['mkfiles', '4'])
    if (!made.ok) return { ok: false, evidence: { at: 'mkfiles', errors: made.errors } }
    const p1 = await spawnProcess(k, ['v13', path])
    out.path = path
    const mark0 = k.events.length
    k.post({ t: 'go', go: { mode: 'park', pid: p1, argv: ['v13', path] } })
    // Snapshots WHILE it runs. Nothing waits for one before posting the next.
    out.snapshotsPosted = 0
    for (let i = 0; i < 8; i += 1) {
      k.post({ t: 'snapshot' })
      out.snapshotsPosted += 1
      await new Promise((r) => setTimeout(r, 12))
    }
    let row = null
    const until = performance.now() + 120000
    while (!row && performance.now() < until) {
      for (const m of k.events.slice(mark0)) {
        if (m.t !== 'results' || !m.results) continue
        for (const r of m.results) if (r.pid === p1) row = r
      }
      if (row) break
      await new Promise((r) => setTimeout(r, 5))
    }
    out.writer = row || { missing: true }
    out.snapshotReplies = k.events.slice(mark0).filter((m) => m.t === 'snapshot')
      .map((m) => ({ ok: m.ok, r: m.r, generation: m.generation, slot: m.slot }))
    k.post({ t: 'fs-state' })
    out.stats = (await k.expect('fs-state', 10000)).fs.stats
    k.post({ t: 'fsck' })
    const ck = await k.expect('fsck', 30000).catch(() => null)
    out.fsck = ck && ck.report
      ? { mountable: ck.report.mountable, problems: (ck.report.problems || []).map((p) => p.what),
          blobs: ck.report.blobs }
      : null
    const mark1 = k.events.length
    const p2 = await spawnProcess(k, ['v13check', path])
    k.post({ t: 'go', go: { mode: 'park', pid: p2, argv: ['v13check', path] } })
    let row2 = null
    const t2 = performance.now() + 60000
    while (!row2 && performance.now() < t2) {
      for (const m of k.events.slice(mark1)) {
        if (m.t !== 'results' || !m.results) continue
        for (const r of m.results) if (r.pid === p2) row2 = r
      }
      if (row2) break
      await new Promise((r) => setTimeout(r, 5))
    }
    out.inSession = row2 || { missing: true }
    out.blobsAfter = (await listBlobs()).map((x) => x.name + ':' + x.size).sort()
  } catch (e) {
    out.threw = String(e && e.message || e)
  } finally {
    await shut(k)
  }
  await waitForJournal()
  const k2 = kernelBoot(BOOT_CFG)
  try {
    const up = await k2.expect('up', 20000)
    out.afterRemount = { mode: up.fs.mode,
      problems: (up.fs.report && up.fs.report.problems ? up.fs.report.problems : [])
        .map((p) => p.what),
      journal: up.fs.report && up.fs.report.journal ? up.fs.report.journal : null,
      seen: await once(k2, ['v13check', path], 30000) }
  } catch (e) {
    out.afterRemount = { threw: String(e && e.message || e) }
  } finally {
    await shut(k2)
  }
  return { ok: false, evidence: out }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack13]]) {"""


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
