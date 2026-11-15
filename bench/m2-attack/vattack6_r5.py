#!/usr/bin/env python3
"""Round 6: the remaining leads, on a sixth scratch tree.

  swept       metadata naming a blob that is not on disk. The boot mount passes `blobs: null` to
              fsck (store.mjs:142, `cfg.sweepBlobs` is unset in www/m2.html's BOOT_CFG), so the
              sweep that would report a MISSING blob does not run at boot — and `openNamed` opens
              a blob with `{ create: true }` (iocore.mjs:190), so the read that follows gets a
              fresh empty file rather than an error. Injected from the page by DELETING one blob,
              which is the state a storage eviction or an interrupted free leaves.

  unlinkopen  a description whose inode was unlinked under it. POSIX keeps the fd working until
              close; `applyOp(UNLINK)` deletes the inode outright and the kernel frees every
              generation, so every later decision on that fd reads an inode that is gone.

  trunceq     ftruncate to EXACTLY the committed size. Nothing changes, so nothing should be
              staged or published.

  fsyncnil    fsync with nothing staged and nothing appended.

  growlost    the swallowed-errno path reached through ftruncate instead of an append: a staged
              grow that another description's swing supersedes, discarded by close().
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk6")

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "vatk6": out = vatk6(env, String(arg)); break;\n')

FN = '''
/* ---------------- THE VERIFIER'S ATTACKS, ROUND 6 ---------------- */

function r6(fs, path) {
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { err: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { err: -st }; }
  const size = Number(st.size);
  const got = fs.readAll(fd, size);
  fs.close(fd);
  if (typeof got === "number") return { err: -got, size };
  return { size, read: got.length, bytes: got };
}

function vatk6(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const which = spec.slice(bar + 1);
  const row = { ok: true, which };

  if (which === "swept") {
    // The metadata says the file has bytes. The blob it names was deleted.
    const st = fs.stat(path);
    row.statSize = typeof st === "number" ? -1 : Number(st.size);
    const got = r6(fs, path);
    row.read = { size: got.size, n: got.read, err: got.err,
      b0: got.bytes && got.bytes.length ? got.bytes[0] : -1 };
    // A write on top of the absent blob, then a commit. Does anything refuse?
    const fd = fs.open(path, O_RDWR);
    row.openRw = fd;
    if (fd >= 0) {
      row.write = fs.pwrite(fd, new Uint8Array(2).fill(0xd4), 0);
      row.fsync = fs.fsync(fd);
      row.close = fs.close(fd);
    }
    row.after = (() => { const a = r6(fs, path); return { size: a.size, n: a.read, err: a.err }; })();
    row.silentlyEmpty = row.statSize > 0 && row.read.err === undefined && row.read.n === 0;
    return row;
  }

  if (which === "unlinkopen") {
    const fd = fs.open(path, O_RDWR);
    if (fd < 0) return { ok: false, at: "open", errno: -fd };
    const st = fs.fstat(fd);
    if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
    const S = Number(st.size);
    row.S = S;
    row.unlink = fs.unlink(path);
    if (row.unlink !== 0) return { ok: false, at: "unlink", errno: -row.unlink };
    // POSIX: the fd still works. Each of these is recorded rather than asserted individually.
    const buf = new Uint8Array(S);
    row.readBack = fs.pread(fd, buf, 0, S);
    row.readB0 = row.readBack > 0 ? buf[0] : -1;
    row.writeBelow = fs.pwrite(fd, new Uint8Array(4).fill(0xa1), 0);
    row.append = fs.pwrite(fd, new Uint8Array(4).fill(0xa2), S);
    row.fstatAfter = (() => { const s = fs.fstat(fd); return typeof s === "number" ? -s : Number(s.size); })();
    row.fsync = fs.fsync(fd);
    row.close = fs.close(fd);
    row.worksAfterUnlink = row.readBack === S && row.writeBelow === 4;
    return row;
  }

  if (which === "trunceq") {
    const fd = fs.open(path, O_RDWR);
    if (fd < 0) return { ok: false, at: "open", errno: -fd };
    const st = fs.fstat(fd);
    const S = typeof st === "number" ? -1 : Number(st.size);
    row.S = S;
    row.ftruncate = fs.ftruncate(fd, S);
    row.fsync = fs.fsync(fd);
    row.close = fs.close(fd);
    const end = r6(fs, path);
    row.final = { size: end.size, n: end.read, err: end.err,
      b0: end.bytes && end.bytes.length ? end.bytes[0] : -1 };
    row.unchanged = end.size === S;
    return row;
  }

  if (which === "fsyncnil") {
    const fd = fs.open(path, O_RDWR);
    if (fd < 0) return { ok: false, at: "open", errno: -fd };
    row.fsync1 = fs.fsync(fd);
    row.fsync2 = fs.fsync(fd);
    row.close = fs.close(fd);
    const end = r6(fs, path);
    row.final = { size: end.size, n: end.read, err: end.err };
    return row;
  }

  if (which === "growlost") {
    const fd1 = fs.open(path, O_RDWR);
    const fd2 = fs.open(path, O_RDWR);
    if (fd1 < 0 || fd2 < 0) return { ok: false, at: "open", fd1, fd2 };
    const st = fs.fstat(fd1);
    const S = typeof st === "number" ? -1 : Number(st.size);
    row.S = S;
    // fd1 GROWS the file with ftruncate, which stages a generation and does not commit it.
    row.ftruncate = fs.ftruncate(fd1, S + 64);
    row.fd1Sees = (() => { const s = fs.fstat(fd1); return typeof s === "number" ? -s : Number(s.size); })();
    // fd2 writes below the committed size and fsyncs: a copy-up and a SWING past fd1's generation.
    row.write2 = fs.pwrite(fd2, new Uint8Array(8).fill(0xb2), 0);
    row.fsync2 = fs.fsync(fd2);
    // fd1's close. The commit inside closeFd is refused; the errno is discarded.
    row.close1 = fs.close(fd1);
    row.close2 = fs.close(fd2);
    const end = r6(fs, path);
    row.final = { size: end.size, n: end.read, err: end.err,
      b0: end.bytes && end.bytes.length ? end.bytes[0] : -1 };
    row.growKept = end.size === S + 64;
    return row;
  }

  return { ok: false, at: "which", which };
}
'''

PAGE_FN = """
/** One blob file DELETED from the page: the state an eviction or an interrupted free leaves. */
async function removeBlobRaw6(name) {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle(BLOB_DIR, { create: true })
  await dir.removeEntry(name)
}

async function vattack6() {
  const out = {}
  for (const which of ['swept', 'unlinkopen', 'trunceq', 'fsyncnil', 'growlost']) {
    await wipe()
    const path = pathFor(1)
    let k = kernelBoot(BOOT_CFG)
    try {
      const up = await k.expect('up', 20000)
      if (up.fs.mode !== 'rw') { out[which] = { at: 'mount', mode: up.fs.mode }; continue }
      await install(k)
      const made = await once(k, ['mkfiles', '4'])
      if (!made.ok) { out[which] = { at: 'mkfiles', errors: made.errors }; continue }
      k.post({ t: 'snapshot' })
      await k.expect('snapshot', 20000).catch(() => null)
      out[which] = { path, blobsBefore: (await listBlobs()).map((x) => x.name + ':' + x.size).sort() }
    } catch (e) {
      out[which] = { threw: String(e && e.message || e) }
      await shut(k); continue
    }
    if (which === 'swept') {
      // Shut the kernel, delete the blob the target file's metadata names, and mount again.
      await shut(k)
      const st = await once2(path)
      out[which].targetIno = st
      for (const b of await listBlobs()) {
        if (b.name === st + '.1') { await removeBlobRaw6(b.name); out[which].deleted = b.name }
      }
      await waitForJournal()
      k = kernelBoot(BOOT_CFG)
      const up2 = await k.expect('up', 20000)
      out[which].remountMode = up2.fs.mode
      out[which].remountProblems = (up2.fs.report && up2.fs.report.problems
        ? up2.fs.report.problems : []).map((p) => p.what)
    }
    try {
      out[which].attack = await once(k, ['vatk6', path + '|' + which], 60000)
      k.post({ t: 'fs-state' })
      out[which].state = (await k.expect('fs-state', 10000)).fs.stats
      out[which].blobsAfter = (await listBlobs()).map((x) => x.name + ':' + x.size).sort()
      if (which === 'swept') {
        k.post({ t: 'fsck' })
        const ck = await k.expect('fsck', 30000).catch(() => null)
        out[which].fsck = ck && ck.report
          ? { mountable: ck.report.mountable,
              problems: (ck.report.problems || []).map((p) => p.what),
              blobs: ck.report.blobs }
          : null
      }
    } catch (e) {
      out[which].attackThrew = String(e && e.message || e)
    } finally {
      await shut(k)
    }
  }
  return { ok: false, evidence: out }
}

/* The target file's inode number, read from the blob directory is not enough — the name must come
 * from the kernel. `wpeek` cannot report it, so the inode is derived the only way the page can:
 * the blob whose SIZE matches the file's seeded byte length. mkfiles seeds file i with i+6 bytes,
 * so file 1's blob is the 7-byte one. Asserted by the caller finding exactly one match. */
async function once2(path) {
  const want = bytesFor(1).length
  const hits = (await listBlobs()).filter((b) => b.size === want && /\\.1$/.test(b.name))
  if (hits.length !== 1) throw new Error('cannot identify the blob for ' + path
    + ': ' + hits.length + ' blobs of ' + want + ' bytes')
  return hits[0].name.split('.')[0]
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack6]]) {"""


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
