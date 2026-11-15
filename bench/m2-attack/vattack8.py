#!/usr/bin/env python3
"""Round 7: attacks on what the refactor declared PRIVATE, not on what it cached.

The third pass's claim is that a description holds no cached durable state, and that the one
remaining private pair — `dirtyGen` / `stagedSize` — "is invisible to every other description:
nobody else can change it, so reading it is not a stale read" (store.mjs:31-34).

These go after that claim. A staged generation's CONTENT is a copy of durable state taken at
copy-up time, and `stagedSize` is derived from it. Nobody else can change the staged blob, but
anybody can change the thing it is a copy OF — so publishing it later publishes a snapshot.

  cowbase    the copy-up is staged FIRST, then another description appends and FSYNCS, then the
             stager commits. Round 1's `shrink` had the append first, so the copy carried it.
             Here the copy was taken before the append existed.

  twostage   two descriptions each stage their own generation over DISJOINT ranges inside the
             committed size, and each fsyncs. POSIX has both ranges in the file. Two staged
             generations publish whole-file snapshots, so the second swing reverts the first.

  cowbase2p  `cowbase` across two PROCESSES, so the result cannot be an artifact of one process's
             fd table.

  slack      the crash window inside `commit`: the blob is flushed (step 2) and the journal record
             is not yet durable (step 5). That leaves a blob physically LONGER than the published
             size, which `extent()` calls "reclaimable slack ... the file really is the shorter
             length". But `extent()` returns max(size, bytes) whenever a description holds the
             inode, so the next open publishes it. Injected page-side, which is the same method
             round 4 used for a lost stage.
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk8")

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "vatk7": out = vatk7(env, String(arg)); break;\n'
        '    case "v7stage": out = v7stage(env); break;\n'
        '    case "v7tail": out = v7tail(env); break;\n'
        '    case "v7read": out = v7read(env); break;\n'
        '    case "v7stat": out = v7stat(env, String(arg)); break;\n')

FN = '''
/* ---------------- THE VERIFIER'S ATTACKS, ROUND 7 ---------------- */

const R7 = { belowByte: 0xa1, belowLen: 8, tailByte: 0xc3, tailLen: 4,
  twoAByte: 0xa1, twoBByte: 0xb2, twoLen: 4, slackByte: 0xee };

/** A fresh description over the finished file: size, and the bytes. */
function r7(fs, path) {
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { err: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { err: -st }; }
  const size = Number(st.size);
  const got = fs.readAll(fd, size);
  fs.close(fd);
  if (typeof got === "number") return { err: -got };
  return { size, bytes: got };
}

/** A write BELOW the committed size, NOT fsynced: the copy-up is staged and nothing published. */
function v7stage(env) {
  const fs = env.fs;
  if (keptFd < 0) return { ok: false, why: "no fd was kept; wopen must run first" };
  const buf = new Uint8Array(R7.belowLen).fill(R7.belowByte);
  const w = fs.pwrite(keptFd, buf, 0);
  const st = fs.fstat(keptFd);
  return { ok: w === R7.belowLen, wrote: w,
    fdSize: typeof st === "number" ? -st : Number(st.size) };
}

/** An append at the committed size, then FSYNC. Acknowledged and durable before anybody else
 *  commits. */
function v7tail(env) {
  const fs = env.fs;
  if (keptFd < 0) return { ok: false, why: "no fd was kept; wopen must run first" };
  const buf = new Uint8Array(R7.tailLen).fill(R7.tailByte);
  const w = fs.pwrite(keptFd, buf, keptSize);
  const s = fs.fsync(keptFd);
  const st = fs.fstat(keptFd);
  return { ok: w === R7.tailLen && s === 0, wrote: w, fsync: s, at: keptSize,
    fdSize: typeof st === "number" ? -st : Number(st.size) };
}

/** Read through the KEPT description, reporting the size it sees and the byte past the size the
 *  metadata published. The slack scenario's whole reading. */
function v7read(env) {
  const fs = env.fs;
  if (keptFd < 0) return { ok: false, why: "no fd was kept; wopen must run first" };
  const st = fs.fstat(keptFd);
  const size = typeof st === "number" ? -1 : Number(st.size);
  if (size < 0) return { ok: false, at: "fstat", errno: -st };
  const got = fs.readAll(keptFd, size);
  if (typeof got === "number") return { ok: false, at: "read", errno: -got };
  return { ok: true, fdSize: size, read: got.length, openSize: keptSize,
    byteAtOpenSize: got.length > keptSize ? got[keptSize] : -1,
    last: got.length ? got[got.length - 1] : -1 };
}

/** `stat` over the PATH, reporting the size it renders. The question is whether a path stat and
 *  an open description can disagree about one file at one instant. */
function v7stat(env, path) {
  const st = env.fs.stat(path);
  if (typeof st === "number") return { ok: false, at: "stat", errno: -st };
  return { ok: true, statSize: Number(st.size) };
}

function vatk7(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const which = spec.slice(bar + 1);
  const row = { ok: true, which };

  if (which === "cowbase") {
    const fd1 = fs.open(path, O_RDWR);
    const fd2 = fs.open(path, O_RDWR);
    if (fd1 < 0 || fd2 < 0) return { ok: false, at: "open", fd1, fd2 };
    const st = fs.fstat(fd1);
    if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
    const S = Number(st.size);
    row.S = S;
    const orig = r7(fs, path);
    row.origByte0 = orig.bytes ? orig.bytes[0] : -1;
    // 1. fd1 writes BELOW the committed size. A copy-up is staged NOW, from the blob as it is NOW.
    const w1 = fs.pwrite(fd1, new Uint8Array(R7.belowLen).fill(R7.belowByte), 0);
    row.below = w1;
    if (w1 !== R7.belowLen) return { ok: false, at: "below", got: w1 };
    // 2. fd2 appends AT the committed size and FSYNCS. Durable, acknowledged, published.
    const w2 = fs.pwrite(fd2, new Uint8Array(R7.tailLen).fill(R7.tailByte), S);
    row.append = w2;
    if (w2 !== R7.tailLen) return { ok: false, at: "append", got: w2 };
    row.fsync2 = fs.fsync(fd2);
    const mid = r7(fs, path);
    row.afterFsync2 = { size: mid.size, byteAtS: mid.bytes && mid.size > S ? mid.bytes[S] : -1 };
    // 3. fd1 commits the generation it staged in step 1.
    row.fsync1 = fs.fsync(fd1);
    row.close1 = fs.close(fd1);
    row.close2 = fs.close(fd2);
    const end = r7(fs, path);
    row.final = { size: end.size, err: end.err,
      byte0: end.bytes && end.size > 0 ? end.bytes[0] : -1,
      byteAtS: end.bytes && end.size > S ? end.bytes[S] : -1 };
    row.wantSize = S + R7.tailLen;
    // Both writes were acknowledged and fd2's was FSYNCED. POSIX has both in the file.
    row.belowKept = row.final.byte0 === R7.belowByte;
    row.appendKept = row.final.size === row.wantSize && row.final.byteAtS === R7.tailByte;
    row.bothKept = row.belowKept && row.appendKept;
    row.lostSilently = !row.appendKept && row.fsync2 === 0 && row.fsync1 === 0
      && row.close1 === 0 && row.close2 === 0;
    return row;
  }

  if (which === "twostage") {
    const fd1 = fs.open(path, O_RDWR);
    const fd2 = fs.open(path, O_RDWR);
    if (fd1 < 0 || fd2 < 0) return { ok: false, at: "open", fd1, fd2 };
    const st = fs.fstat(fd1);
    if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
    const S = Number(st.size);
    row.S = S;
    if (S < 2 * R7.twoLen) return { ok: false, at: "tooSmall", S };
    // Two copy-ups, two staged generations, DISJOINT ranges, both inside the committed size.
    const w1 = fs.pwrite(fd1, new Uint8Array(R7.twoLen).fill(R7.twoAByte), 0);
    const w2 = fs.pwrite(fd2, new Uint8Array(R7.twoLen).fill(R7.twoBByte), R7.twoLen);
    row.w1 = w1; row.w2 = w2;
    if (w1 !== R7.twoLen || w2 !== R7.twoLen) return { ok: false, at: "write", w1, w2 };
    row.fsync1 = fs.fsync(fd1);
    const mid = r7(fs, path);
    row.afterFsync1 = { size: mid.size, byte0: mid.bytes ? mid.bytes[0] : -1,
      byteAtLen: mid.bytes ? mid.bytes[R7.twoLen] : -1 };
    row.fsync2 = fs.fsync(fd2);
    row.close1 = fs.close(fd1);
    row.close2 = fs.close(fd2);
    const end = r7(fs, path);
    row.final = { size: end.size, err: end.err,
      byte0: end.bytes ? end.bytes[0] : -1,
      byteAtLen: end.bytes && end.size > R7.twoLen ? end.bytes[R7.twoLen] : -1 };
    row.aKept = row.final.byte0 === R7.twoAByte;
    row.bKept = row.final.byteAtLen === R7.twoBByte;
    row.bothKept = row.aKept && row.bKept;
    row.lostSilently = !row.bothKept && row.fsync1 === 0 && row.fsync2 === 0;
    return row;
  }

  return { ok: false, at: "which", which };
}
'''

PAGE_FN = """
/** ROUND 7. Each scenario on its own wiped volume, with an explicit fsck afterwards: a loss fsck
 *  calls clean is the class this project names as its worst outcome. */
async function v7run(which) {
  const out = {}
  await wipe()
  let k = kernelBoot(BOOT_CFG)
  const path = pathFor(1)
  try {
    const up = await k.expect('up', 20000)
    if (up.fs.mode !== 'rw') return { at: 'mount', mode: up.fs.mode }
    await install(k)
    const made = await once(k, ['mkfiles', '4'])
    if (!made.ok) return { at: 'mkfiles', errors: made.errors }
    out.path = path
    out.blobsBefore = (await listBlobs()).map((x) => x.name + ':' + x.size).sort()

    if (which === 'cowbase' || which === 'twostage') {
      out.attack = await once(k, ['vatk7', path + '|' + which], 60000)
    } else if (which === 'cowbase2p') {
      // The same ordering as `cowbase`, across two processes. Each keeps its own description.
      const p1 = await spawnProcess(k, ['wopen', path])
      out.open1 = await runPid(k, p1, 30000, 'wopen 1')
      const p2 = await spawnProcess(k, ['wopen', path])
      out.open2 = await runPid(k, p2, 30000, 'wopen 2')
      out.stage1 = await runPid(k, p1, 30000, 'v7stage', ['v7stage'])
      out.tail2 = await runPid(k, p2, 30000, 'v7tail', ['v7tail'])
      out.peekMid = await once(k, ['wpeek', path], 30000)
      out.sync1 = await runPid(k, p1, 30000, 'wsync', ['wsync'])
      out.close1 = await runPid(k, p1, 30000, 'wclose', ['wclose'])
      out.close2 = await runPid(k, p2, 30000, 'wclose', ['wclose'])
      out.final = await once(k, ['wpeek', path], 30000)
    } else if (which === 'slack') {
      // A durable snapshot first, so the published size is in the superblock rather than only in
      // the journal, then the kernel goes away and the page plants the slack.
      k.post({ t: 'snapshot' })
      out.snapshot = await k.expect('snapshot', 20000).catch(() => null)
      await shut(k)
      const ino = await v7ino()
      out.ino = ino
      const name = ino + '.1'
      const was = await v7readBlob(name)
      const grown = new Uint8Array(was.length + 32)
      grown.set(was, 0)
      grown.fill(0xee, was.length)
      await writeBlobRaw(name, grown)
      out.planted = { name, was: was.length, now: grown.length, byte: 0xee }
      await waitForJournal()
      k = kernelBoot(BOOT_CFG)
      const up2 = await k.expect('up', 20000)
      out.remount = { mode: up2.fs.mode,
        problems: (up2.fs.report && up2.fs.report.problems ? up2.fs.report.problems : [])
          .map((p) => p.what) }
      // fsck FIRST, with the sweep on, over the planted state and with nothing open.
      k.post({ t: 'fsck' })
      const ck0 = await k.expect('fsck', 30000).catch(() => null)
      out.fsckBeforeOpen = ck0 && ck0.report
        ? { mountable: ck0.report.mountable, problems: (ck0.report.problems || []).map((p) => p.what),
            blobs: ck0.report.blobs }
        : null
      // `stat` with no description holding the inode.
      out.statClosed = await once(k, ['v7stat', path], 30000)
      // A path stat and an open description, in that order, with nothing else holding the inode.
      const ps = await spawnProcess(k, ['v7stat', path])
      out.statBeforeOpen = await runPid(k, ps, 30000, 'v7stat')
      out.peekClosed = await once(k, ['wpeek', path], 30000)
      // Now a description holds it: fstat, and a read through the same fd.
      const p = await spawnProcess(k, ['wopen', path])
      out.openSize = await runPid(k, p, 30000, 'wopen')
      out.readThrough = await runPid(k, p, 30000, 'v7read', ['v7read'])
      out.peekOpen = await once(k, ['wpeek', path], 30000)
      out.close = await runPid(k, p, 30000, 'wclose', ['wclose'])
      out.peekAfterClose = await once(k, ['wpeek', path], 30000)
    }

    k.post({ t: 'fs-state' })
    out.stats = (await k.expect('fs-state', 10000)).fs.stats
    k.post({ t: 'fsck' })
    const ck = await k.expect('fsck', 30000).catch(() => null)
    out.fsck = ck && ck.report
      ? { mountable: ck.report.mountable, problems: (ck.report.problems || []).map((p) => p.what),
          blobs: ck.report.blobs }
      : null
    out.blobsAfter = (await listBlobs()).map((x) => x.name + ':' + x.size).sort()
  } catch (e) {
    out.threw = String(e && e.message || e)
  } finally {
    await shut(k)
  }
  // A remount, so a scenario that left the volume unmountable cannot pass by never being asked.
  await waitForJournal()
  const k2 = kernelBoot(BOOT_CFG)
  try {
    const up = await k2.expect('up', 20000)
    out.afterRemount = { mode: up.fs.mode,
      problems: (up.fs.report && up.fs.report.problems ? up.fs.report.problems : [])
        .map((p) => p.what),
      seen: await once(k2, ['wpeek', path], 30000) }
  } catch (e) {
    out.afterRemount = { threw: String(e && e.message || e) }
  } finally {
    await shut(k2)
  }
  return out
}

async function vattack7() {
  const out = {}
  for (const which of ['slack']) {
    out[which] = await v7run(which)
  }
  return { ok: false, evidence: out }
}

/** The target file's inode number, identified the only way the page can: the blob whose size is
 *  the file's seeded byte length. Asserted by finding exactly one. */
async function v7ino() {
  const want = bytesFor(1).length
  const hits = (await listBlobs()).filter((b) => b.size === want && /\\.1$/.test(b.name))
  if (hits.length !== 1) throw new Error('cannot identify the blob: ' + hits.length
    + ' blobs of ' + want + ' bytes')
  return hits[0].name.split('.')[0]
}

async function v7readBlob(name) {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle(BLOB_DIR, { create: true })
  const fh = await dir.getFileHandle(name, { create: false })
  return new Uint8Array(await (await fh.getFile()).arrayBuffer())
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack7]]) {"""


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
