#!/usr/bin/env python3
"""Round 4: generation reuse after a lost stage, with the lost stage injected page-side.

Round 3 could not produce the state: `shut()` ends each process first, the kernel's fd teardown
runs `closeFd`, and `closeFd` COMMITS a dirty description — so the staged generation became the
committed one. A real crash (tab closed, renderer killed) has no such teardown, which is why
proof (b) injects its torn journal from the page rather than trying to crash a kernel. Same method
here: the page writes `blobs/<ino>.2` directly, which is exactly the on-disk state a crash between
`copyUp` and `commit` leaves behind.

Then `ftruncate` grows the 8-byte file. `nextGen`'s floor comes from `vfs.blobNames()`, which is
the COMMITTED generation of each inode — so it hands out gen 2 again, opens the lost generation's
file, and truncates it DOWN from 1000 bytes to 40. POSIX says the grown range reads as zeroes.
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk4b")

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "vgrow": out = vgrow(env, String(arg)); break;\n')

FN = '''
/** Grow the file with ftruncate and read the grown range back. It must be zeroes. */
function vgrow(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
  const S = Number(st.size);
  const t = fs.ftruncate(fd, S + 32);
  if (t !== 0) return { ok: false, at: "ftruncate", errno: -t };
  const s = fs.fsync(fd);
  if (s !== 0) return { ok: false, at: "fsync", errno: -s };
  fs.close(fd);
  const fd2 = fs.open(path, O_RDONLY);
  if (fd2 < 0) return { ok: false, at: "reopen", errno: -fd2 };
  const st2 = fs.fstat(fd2);
  const size = typeof st2 === "number" ? -1 : Number(st2.size);
  const got = size < 0 ? null : fs.readAll(fd2, size);
  fs.close(fd2);
  let zeroed = 0;
  let foreign = 0;
  if (got) {
    for (let b = S; b < Math.min(size, S + 32); b += 1) {
      if (got[b] === 0) zeroed += 1;
      if (got[b] === 0xee) foreign += 1;
    }
  }
  return { ok: true, S, size, wantZero: 32, zeroed, foreignBytes: foreign,
    byteAtS: got && size > S ? got[S] : -1 };
}
'''

PAGE_FN = """
/* writeBlobRaw comes from www/m2.html, which grew it for the same reason this attack needs it:
 * the page is the only agent that can touch the volume while no kernel holds it. A second
 * declaration of that name in one module scope is a SyntaxError and the page never boots. */

async function vattack4() {
  await wipe()
  const out = {}
  const path = pathFor(1)
  const k = kernelBoot(BOOT_CFG)
  try {
    const up = await k.expect('up', 20000)
    if (up.fs.mode !== 'rw') return { ok: false, evidence: { at: 'mount', mode: up.fs.mode } }
    await install(k)
    const made = await once(k, ['mkfiles', '4'])
    if (!made.ok) return { ok: false, evidence: { at: 'mkfiles', errors: made.errors } }
    k.post({ t: 'snapshot' })
    out.snapshot = await k.expect('snapshot', 20000).catch(() => null)
    out.blobsBefore = (await listBlobs()).map((x) => x.name + ':' + x.size).sort()
  } finally {
    await shut(k)
  }
  // THE LOST STAGE, injected: one orphaned second generation per committed blob, 1000 bytes of
  // 0xEE. This is what a crash between copyUp and commit leaves on disk.
  const lost = []
  for (const b of await listBlobs()) {
    const m = /^(\\d+)\\.1$/.exec(b.name)
    if (!m) continue
    await writeBlobRaw(m[1] + '.2', new Uint8Array(1000).fill(0xee))
    lost.push(m[1] + '.2')
  }
  out.injected = lost
  await waitForJournal()
  const k2 = kernelBoot(BOOT_CFG)
  try {
    const up2 = await k2.expect('up', 20000)
    out.remountMode = up2.fs.mode
    out.remountProblems = (up2.fs.report && up2.fs.report.problems
      ? up2.fs.report.problems : []).map((p) => p.what)
    out.grown = await once(k2, ['vgrow', path], 60000)
    out.blobsAfter = (await listBlobs()).map((x) => x.name + ':' + x.size).sort()
    // An explicit fsck over the result, which IS the sweep. Does it report anything?
    k2.post({ t: 'fsck' })
    const ck = await k2.expect('fsck', 30000).catch(() => null)
    out.fsck = ck && ck.report
      ? { mountable: ck.report.mountable,
          problems: (ck.report.problems || []).map((p) => p.what),
          blobs: ck.report.blobs }
      : { raw: ck ? Object.keys(ck) : null }
  } finally {
    await shut(k2)
  }
  const g = out.grown || {}
  return { ok: g.zeroed === 32 && g.foreignBytes === 0, evidence: { path, ...out } }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack4]]) {"""


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
