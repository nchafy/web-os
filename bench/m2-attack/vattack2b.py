#!/usr/bin/env python3
"""Two more verifier attacks, on a second scratch tree.

  trunc   the truncate path's copy of the same stale-base defect. `truncateFd` re-reads the
          inode's committed size only when `!Store.dirty(d)`, so a description made dirty by an
          append copies up `keep = min(size, STALE d.size)` bytes — and the bytes between the
          stale size and the real committed size come back as zeroes.

  poison  a durable journal record the writer itself refused. `commit()` appends and FLUSHES the
          record before `vfs.applyOp(op)`, and applyOp's COMMIT arm throws when the op moves the
          generation backwards. Two fds reach that state with no crash: fd2 holds gen g while fd1
          copies up to g+1 and commits, so fd2's commit op names g. The record is on disk, the
          syscall returns -EIO, and the NEXT mount's replay stops at it — which fsck scores as a
          problem, so `mountable` is read-only and every later record is discarded.
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk2b")

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "vatk2": out = vatk2(env, String(arg)); break;\n')

FN = '''
/* ---------------- THE VERIFIER'S ATTACKS, ROUND 2 ---------------- */

function vatk2(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const which = spec.slice(bar + 1);
  const fd1 = fs.open(path, O_RDWR);
  if (fd1 < 0) return { ok: false, at: "open1", errno: -fd1 };
  const fd2 = fs.open(path, O_RDWR);
  if (fd2 < 0) return { ok: false, at: "open2", errno: -fd2 };
  const st = fs.fstat(fd1);
  if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
  const S = Number(st.size);
  const row = { ok: true, which, S };

  // fd2 goes DIRTY with no staged generation: an append far past the committed size.
  const pend = fs.pwrite(fd2, new Uint8Array(4).fill(0xc3), 100);
  row.fd2Pending = pend;
  if (pend < 0) return { ok: false, at: "pend", got: pend };

  if (which === "trunc") {
    // fd1 appends 32 bytes and fsyncs. Committed, and the metadata publishes S + 32.
    const w1 = fs.pwrite(fd1, new Uint8Array(32).fill(0xa1), S);
    if (w1 !== 32) return { ok: false, at: "pwrite1", got: w1 };
    const s1 = fs.fsync(fd1);
    if (s1 !== 0) return { ok: false, at: "fsync1", errno: -s1 };
    // fd2 truncates to the size fd1 published. Its own base is stale at S.
    const t = fs.ftruncate(fd2, S + 32);
    row.ftruncate = t;
    const s2 = fs.fsync(fd2);
    row.fsync2 = s2;
    const fd3 = fs.open(path, O_RDONLY);
    const st3 = fd3 < 0 ? -1 : fs.fstat(fd3);
    const size = typeof st3 === "number" ? -1 : Number(st3.size);
    const got = size < 0 ? null : fs.readAll(fd3, size);
    if (fd3 >= 0) fs.close(fd3);
    let aRangeOk = !!got && size >= S + 32;
    for (let b = S; aRangeOk && b < S + 32; b += 1) aRangeOk = got[b] === 0xa1;
    let zeroed = 0;
    if (got) for (let b = S; b < Math.min(size, S + 32); b += 1) if (got[b] === 0) zeroed += 1;
    row.final = { size, wantSize: S + 32, aRangeOk, zeroedOverCommitted: zeroed,
      byteAtS: got && size > S ? got[S] : -1 };
    fs.close(fd1); fs.close(fd2);
    return row;
  }

  // poison: fd1 writes BELOW the committed size, so it copies up to gen g+1 and commits.
  const w1 = fs.pwrite(fd1, new Uint8Array(8).fill(0xa1), 0);
  if (w1 !== 8) return { ok: false, at: "pwrite1", got: w1 };
  const s1 = fs.fsync(fd1);
  if (s1 !== 0) return { ok: false, at: "fsync1", errno: -s1 };
  // fd2's commit names the generation fd1 superseded. applyOp refuses it AFTER the record is
  // durable, so the syscall fails and the journal keeps the refused op.
  const s2 = fs.fsync(fd2);
  row.fsync2 = s2;
  // A metadata op AFTER the poison, whose record replay must discard once it stops.
  const made = fs.mkdir(path.slice(0, path.lastIndexOf("/")) + "/after", 0o755);
  row.mkdirAfter = made;
  const seen = fs.stat(path);
  row.statAfter = typeof seen === "number" ? { errno: -seen } : { size: Number(seen.size) };
  fs.close(fd1); fs.close(fd2);
  return row;
}
'''

PAGE_FN = """
/** THE VERIFIER'S ROUND-2 PROOF. `poison` reboots onto the same volume and reads the mount back. */
async function vattack2() {
  const out = {}
  for (const which of ['trunc', 'poison']) {
    await wipe()
    const k = kernelBoot(BOOT_CFG)
    let afterDir = null
    try {
      const up = await k.expect('up', 20000)
      if (up.fs.mode !== 'rw') { out[which] = { at: 'mount', mode: up.fs.mode }; continue }
      await install(k)
      const made = await once(k, ['mkfiles', '4'])
      if (!made.ok) { out[which] = { at: 'mkfiles', errors: made.errors }; continue }
      const path = pathFor(1)
      k.post({ t: 'fs-state' })
      const s0 = (await k.expect('fs-state', 10000)).fs
      const atk = await once(k, ['vatk2', path + '|' + which], 60000)
      k.post({ t: 'fs-state' })
      const s1 = (await k.expect('fs-state', 10000)).fs
      out[which] = {
        attack: atk, path,
        copyUps: [s0.stats.copyUps, s1.stats.copyUps],
        inodesBefore: s0.inodes ? s0.inodes.inodes : -1,
        inodesAfter: s1.inodes ? s1.inodes.inodes : -1,
        blobsAfter: (await listBlobs()).map((x) => x.name + ':' + x.size).sort(),
      }
      afterDir = path.slice(0, path.lastIndexOf('/')) + '/after'
    } catch (e) {
      out[which] = { threw: String(e && e.message || e) }
    } finally {
      await shut(k)
    }
    if (which !== 'poison' || !out[which] || out[which].threw) continue
    // THE REBOOT. Same volume, no wipe: whatever the first kernel left on disk is what mounts.
    await waitForJournal()
    const k2 = kernelBoot(BOOT_CFG)
    try {
      const up2 = await k2.expect('up', 20000)
      const fs2 = up2.fs
      const j = fs2.report && fs2.report.journal
      out[which].remount = {
        mode: fs2.mode,
        problems: (fs2.report && fs2.report.problems ? fs2.report.problems : [])
          .map((p) => p.what + ': ' + String(p.why).slice(0, 180)),
        journal: j ? { records: j.records, applied: j.applied, stopped: j.stopped,
          rejected: j.rejected } : null,
        inodes: fs2.inodes ? fs2.inodes.inodes : -1,
        afterDir,
      }
    } catch (e) {
      out[which].remount = { threw: String(e && e.message || e) }
    } finally {
      await shut(k2)
    }
  }
  const t = out.trunc && out.trunc.attack || {}
  const p = out.poison && out.poison.attack || {}
  const truncOk = !!(t.final && t.final.aRangeOk)
  const poisonOk = !!(out.poison && out.poison.remount && out.poison.remount.mode === 'rw')
  return { ok: truncOk && poisonOk, evidence: { truncOk, poisonOk, ...out } }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack2]]) {"""


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
