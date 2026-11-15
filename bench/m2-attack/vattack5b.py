#!/usr/bin/env python3
"""Round 5: four NEW attacks in the root cause's class, on a fresh scratch tree.

The root cause the triage named is "a decision reads a stale or incomplete view of durable state".
The fix changed the gate in writeFd and truncateFd. These four go after the decisions it did NOT
change.

  dropclose  the drop that close() reports as success. One description holds an ACKNOWLEDGED
             append (pwrite returned 4, fstat on its own fd showed the bytes). Another description
             writes BELOW the committed size, so it copies up `heldEnd(ITS OWN description)` and
             SWINGS. The appending description's bytes are in the superseded generation and were
             never copied. Its close() then runs `closeFd`, whose `await this.commit(d)` DISCARDS
             the errno, so the syscall returns 0 and the bytes are gone with nothing reported.

  readstale  readFd never calls syncToInode and reads `d.size` and `d.blobId` — the open-time
             snapshot. A reader fd open across another description's fsync returns the OLD bytes,
             while fstat on THAT SAME fd reports the new size, because fstat reads the live inode.

  readswing  the same read path after a copy-up SWING rather than an append: the reader is still
             pointed at the superseded blob, which the deferred free keeps alive for it.

  otrunc     O_TRUNC stages a generation and does not commit it, so the truncation is invisible to
             every other description until the truncating fd syncs or closes.
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk5b")

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "vatk5": out = vatk5(env, String(arg)); break;\n')

FN = '''
/* ---------------- THE VERIFIER'S ATTACKS, ROUND 5 ---------------- */

function r5(fs, path) {
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

function vatk5(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const which = spec.slice(bar + 1);
  const row = { ok: true, which };

  if (which === "dropclose") {
    const fd1 = fs.open(path, O_RDWR);
    const fd2 = fs.open(path, O_RDWR);
    if (fd1 < 0 || fd2 < 0) return { ok: false, at: "open", fd1, fd2 };
    const st = fs.fstat(fd1);
    if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
    const S = Number(st.size);
    row.S = S;
    // fd2's ACKNOWLEDGED append. No fsync — POSIX does not need one for the bytes to be in the
    // file, only for them to survive a crash.
    const w2 = fs.pwrite(fd2, new Uint8Array(4).fill(0xc3), S);
    row.appendReturned = w2;
    if (w2 !== 4) return { ok: false, at: "append", got: w2 };
    const st2 = fs.fstat(fd2);
    row.fd2SeesSize = typeof st2 === "number" ? -1 : Number(st2.size);
    // fd1 writes BELOW the committed size: copy-up, then the swing.
    const w1 = fs.pwrite(fd1, new Uint8Array(8).fill(0xa1), 0);
    if (w1 !== 8) return { ok: false, at: "below", got: w1 };
    const s1 = fs.fsync(fd1);
    row.fsync1 = s1;
    if (s1 !== 0) return { ok: false, at: "fsync1", errno: -s1 };
    // THE CLOSE. Its return value is the whole point: a 0 here with the bytes gone is a loss the
    // caller is never told about.
    row.close2 = fs.close(fd2);
    fs.close(fd1);
    const end = r5(fs, path);
    row.final = { size: end.size, err: end.err,
      byteAtS: end.bytes && end.size > S ? end.bytes[S] : -1 };
    row.wantSize = S + 4;
    row.wantByteAtS = 0xc3;
    row.lostSilently = row.close2 === 0 && end.size === S;
    return row;
  }

  if (which === "readstale" || which === "readswing") {
    const fdr = fs.open(path, O_RDONLY);
    const fdw = fs.open(path, O_RDWR);
    if (fdr < 0 || fdw < 0) return { ok: false, at: "open", fdr, fdw };
    const st = fs.fstat(fdr);
    if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
    const S = Number(st.size);
    row.S = S;
    // The reader reads once first, so the fd is demonstrably live before the writer acts.
    const first = fs.readAll(fdr, S);
    row.firstRead = typeof first === "number" ? { err: -first } : { n: first.length, b0: first[0] };

    if (which === "readstale") {
      // An APPEND past the committed size, then fsync: the file is now S + 32 bytes.
      const w = fs.pwrite(fdw, new Uint8Array(32).fill(0xa1), S);
      if (w !== 32) return { ok: false, at: "append", got: w };
    } else {
      // A write BELOW the committed size, then fsync: a copy-up and a SWING onto a new generation.
      const w = fs.pwrite(fdw, new Uint8Array(8).fill(0xb2), 0);
      if (w !== 8) return { ok: false, at: "below", got: w };
    }
    const s = fs.fsync(fdw);
    row.fsyncW = s;
    if (s !== 0) return { ok: false, at: "fsyncW", errno: -s };

    // What a FRESH description sees. This is the truth the reader fd must agree with.
    const fresh = r5(fs, path);
    row.fresh = { size: fresh.size, b0: fresh.bytes ? fresh.bytes[0] : -1,
      byteAtS: fresh.bytes && fresh.size > S ? fresh.bytes[S] : -1 };

    // The SAME fd, still open. fstat reads the live inode; read reads the description.
    const str = fs.fstat(fdr);
    row.readerFstatSize = typeof str === "number" ? -1 : Number(str.size);
    const want = row.readerFstatSize > 0 ? row.readerFstatSize : S;
    const buf = new Uint8Array(want);
    const n = fs.pread(fdr, buf, 0, want);
    row.readerRead = { asked: want, got: n, b0: n > 0 ? buf[0] : -1,
      byteAtS: n > S ? buf[S] : -1 };
    // One pread AT the new range, so a short whole-file read and a stale byte are told apart.
    const tail = new Uint8Array(32);
    const nt = fs.pread(fdr, tail, S, 32);
    row.readerTail = { got: nt, b0: nt > 0 ? tail[0] : -1 };
    fs.close(fdr); fs.close(fdw);
    row.agreesWithFresh = which === "readstale"
      ? row.readerRead.got === fresh.size && row.readerRead.byteAtS === 0xa1
      : row.readerRead.b0 === 0xb2;
    return row;
  }

  if (which === "otrunc") {
    const st0 = fs.stat(path);
    row.S = typeof st0 === "number" ? -1 : Number(st0.size);
    // O_TRUNC on a file with bytes. POSIX: the file is zero length when open() returns.
    const fd = fs.open(path, O_RDWR | O_TRUNC);
    if (fd < 0) return { ok: false, at: "open", errno: -fd };
    const seenByFd = fs.fstat(fd);
    row.fdSeesSize = typeof seenByFd === "number" ? -1 : Number(seenByFd.size);
    const fresh = r5(fs, path);
    row.freshSeesSize = fresh.size === undefined ? -1 : fresh.size;
    row.freshByte0 = fresh.bytes && fresh.size > 0 ? fresh.bytes[0] : -1;
    fs.close(fd);
    const after = r5(fs, path);
    row.afterCloseSize = after.size === undefined ? -1 : after.size;
    row.visibleAtOpen = row.freshSeesSize === 0;
    return row;
  }

  return { ok: false, at: "which", which };
}
'''

PAGE_FN = """
/** ROUND 5. Each scenario on its own wiped volume and its own kernel, then a remount so a
 *  scenario that left the volume unmountable cannot pass by never being asked. */
async function vattack5() {
  const out = {}
  for (const which of ['dropclose', 'readstale', 'readswing', 'otrunc']) {
    await wipe()
    const k = kernelBoot(BOOT_CFG)
    const path = pathFor(1)
    try {
      const up = await k.expect('up', 20000)
      if (up.fs.mode !== 'rw') { out[which] = { at: 'mount', mode: up.fs.mode }; continue }
      await install(k)
      const made = await once(k, ['mkfiles', '4'])
      if (!made.ok) { out[which] = { at: 'mkfiles', errors: made.errors }; continue }
      k.post({ t: 'fs-state' })
      const s0 = (await k.expect('fs-state', 10000)).fs.stats
      const atk = await once(k, ['vatk5', path + '|' + which], 60000)
      k.post({ t: 'fs-state' })
      const s1 = (await k.expect('fs-state', 10000)).fs.stats
      out[which] = { attack: atk, path, copyUps: [s0.copyUps, s1.copyUps],
        swings: [s0.swings, s1.swings],
        blobsAfter: (await listBlobs()).map((x) => x.name + ':' + x.size).sort() }
    } catch (e) {
      out[which] = { threw: String(e && e.message || e) }
    } finally {
      await shut(k)
    }
    await waitForJournal()
    const k2 = kernelBoot(BOOT_CFG)
    try {
      const up2 = await k2.expect('up', 20000)
      out[which].remount = { mode: up2.fs.mode,
        problems: (up2.fs.report && up2.fs.report.problems ? up2.fs.report.problems : [])
          .map((p) => p.what) }
      const seen = await once(k2, ['wpeek', path], 30000)
      out[which].afterRemount = { ok: seen.ok, size: seen.size, errno: seen.errno }
    } catch (e) {
      out[which].remount = { threw: String(e && e.message || e) }
    } finally {
      await shut(k2)
    }
  }
  const dc = out.dropclose && out.dropclose.attack || {}
  const rs = out.readstale && out.readstale.attack || {}
  const rw = out.readswing && out.readswing.attack || {}
  const ot = out.otrunc && out.otrunc.attack || {}
  const dropOk = dc.final ? dc.final.size === dc.wantSize && dc.final.byteAtS === 0xc3 : false
  return {
    ok: dropOk && rs.agreesWithFresh === true && rw.agreesWithFresh === true
      && ot.visibleAtOpen === true,
    evidence: { dropOk, readstaleOk: rs.agreesWithFresh === true,
      readswingOk: rw.agreesWithFresh === true, otruncOk: ot.visibleAtOpen === true, ...out },
  }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack5]]) {"""


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
