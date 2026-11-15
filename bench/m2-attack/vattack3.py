#!/usr/bin/env python3
"""Round 3: generation reuse after a lost stage.

`store.mjs:160-164` calls its loop "the staging floor. Every generation already on disk is spoken
for, committed or not" — but it reads `vfs.blobNames()`, which `vfs.mjs:948` builds from the
COMMITTED generation of each inode. A generation that was staged and never committed is on disk
and is NOT in that list, so after a reboot `nextGen` hands its name out again and the new
generation opens the old one's file with `create: true`.

The observable: `ftruncate` growing a file must read back as ZEROES. Against a reused generation
the handle is truncated DOWN from the lost generation's length, so the grown range comes back
carrying the lost generation's bytes.

  kernel 1: write 1000 bytes below the committed size -> copy-up stages ino.2 -> NO fsync, and
            the kernel is terminated, so ino.2 is on disk and uncommitted.
  kernel 2: ftruncate the 8-byte file to 40. POSIX says bytes 8..40 are zero.
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk3")

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "vstage": out = vstage(env, String(arg)); break;\n'
        '    case "vgrow": out = vgrow(env, String(arg)); break;\n')

FN = '''
/* ---------------- THE VERIFIER'S ATTACKS, ROUND 3 ---------------- */

/** Stage a generation and never commit it. The fd is left open on purpose: the kernel is about to
 *  be terminated, so nothing runs closeFd and the staged blob is orphaned on disk. */
function vstage(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
  const S = Number(st.size);
  // Below the committed size, so this copies up and stages a NEW generation.
  const buf = new Uint8Array(1000).fill(0xee);
  let put = 0;
  while (put < buf.length) {
    const n = fs.pwrite(fd, buf.subarray(put, Math.min(put + 4096, buf.length)), put);
    if (n <= 0) return { ok: false, at: "pwrite", got: n, put };
    put += n;
  }
  return { ok: true, S, staged: put };
}

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
/** Round 3: a lost staged generation, then a reboot that hands its name out again. */
async function vattack3() {
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
    out.staged = await once(k, ['vstage', path], 60000)
    out.blobsAfterStage = (await listBlobs()).map((x) => x.name + ':' + x.size).sort()
  } finally {
    // TERMINATED, not shut down: nothing commits the staged generation.
    await shut(k)
  }
  await waitForJournal()
  const k2 = kernelBoot(BOOT_CFG)
  try {
    const up2 = await k2.expect('up', 20000)
    out.remountMode = up2.fs.mode
    out.remountProblems = (up2.fs.report && up2.fs.report.problems
      ? up2.fs.report.problems : []).map((p) => p.what)
    out.grown = await once(k2, ['vgrow', path], 60000)
    out.blobsAfterGrow = (await listBlobs()).map((x) => x.name + ':' + x.size).sort()
  } finally {
    await shut(k2)
  }
  const g = out.grown || {}
  // POSIX: a grown range reads as zeroes. Anything else is another generation's bytes.
  return { ok: g.zeroed === 32 && g.foreignBytes === 0, evidence: { path, ...out } }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack3]]) {"""


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
