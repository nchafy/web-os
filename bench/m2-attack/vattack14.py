#!/usr/bin/env python3
"""Round 14: attacks on the COMPARE-AND-SWAP itself.

The fourth pass made the commit a CAS. Its version stamp is the pair `(gen, end)` — the base
generation the copy-up copied from, and how far that generation's bytes reached when it did
(`moved()`, src/kernel/store.mjs:135-137). These attacks go after the stamp, not after the
validation: a validation is only as good as the thing it compares.

  slackrevert  THE STAMP'S BLIND SPOT. `writeFd` splits on `from < live.size` — the PUBLISHED
               size — while the stamp's extent is `live.end`, which is higher whenever an
               uncommitted append exists. A write into [size, end) is therefore an APPEND, lands
               in the current generation IN PLACE, and raises nothing: the generation does not
               move and `row.end` does not move. So (gen, end) is unchanged while the bytes under
               the staged copy changed. The stager's commit then validates clean and publishes its
               snapshot over bytes another description fsynced.

  slackclose   the same ordering with the victim never calling fsync, only close(): the bytes were
               acknowledged by pwrite and close() returns 0.

  dirtyread    `readFd` clamps a dirty description to `stagedEnd(d, d.baseEnd)` — the base the copy
               was taken FROM — while `statFd` and `endFd` use `stagedEnd(d, live.end)`, the base
               read NOW. The refactor's own header calls the fstat/pread disagreement the defect it
               removed; this is the arm it did not reach.

  threeway     three descriptions stage from one base over three disjoint ranges and each fsyncs.
               Two rebases in a row, which no previous scenario forced.

  longwait     a description stages, then SIX unrelated commits advance the generation under it,
               then it commits. Its base generation has been freed by then.
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk14")

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "vatk14": out = vatk14(env, String(arg)); break;\n')

FN = '''
/* ---------------- THE VERIFIER'S ATTACKS, ROUND 14: THE CAS'S VERSION STAMP ---------------- */

const R14 = { tailByte: 0xc3, tailLen: 4, stageByte: 0xa1, stageLen: 8,
  victimByte: 0xb2, victimLen: 4, threeLen: 2, waitRounds: 6 };

/** A fresh description over the finished file: size, and the bytes. */
function r14(fs, path) {
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

function vatk14(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const which = spec.slice(bar + 1);
  const row = { ok: true, which };

  if (which === "slackrevert" || which === "slackclose") {
    // THREE descriptions. The appender opens the slack, the stager copies it up, the victim
    // overwrites inside the slack. Three so the bytes lost belong to a description that is
    // neither the one that made the slack nor the one that staged.
    const fd1 = fs.open(path, O_RDWR);
    const fd2 = fs.open(path, O_RDWR);
    const fd3 = fs.open(path, O_RDWR);
    if (fd1 < 0 || fd2 < 0 || fd3 < 0) return { ok: false, at: "open", fd1, fd2, fd3 };
    const st = fs.fstat(fd1);
    if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
    const S = Number(st.size);
    row.S = S;

    // 1. fd1 appends AT the committed size and does NOT fsync. The bytes are in the current
    //    generation, physically above the published size: that is the SLACK.
    const w1 = fs.pwrite(fd1, new Uint8Array(R14.tailLen).fill(R14.tailByte), S);
    row.append = w1;
    if (w1 !== R14.tailLen) return { ok: false, at: "append", got: w1 };
    // NO READ HERE, and the first draft of this scenario had one. `closeFd` COMMITS, so a
    // read-only open+close of the file publishes the pending append — which raises the published
    // size to 12, turns step 3 into a copy-up instead of an in-place append, and destroys the
    // condition under test. The observation has to stay out until the end.

    // 2. fd2 writes BELOW the committed size, so it copies up. The copy takes `from.end` bytes,
    //    which INCLUDES fd1's slack, and records the base as (gen, end).
    const w2 = fs.pwrite(fd2, new Uint8Array(R14.stageLen).fill(R14.stageByte), 0);
    row.staged = w2;
    if (w2 !== R14.stageLen) return { ok: false, at: "stage", got: w2 };

    // 3. fd3 writes INSIDE THE SLACK — at the committed size, which is at or beyond `live.size`,
    //    so `writeFd` appends in place into the generation fd2 already copied. `row.end` does not
    //    rise, the generation does not change: the CAS's stamp cannot see this.
    const w3 = fs.pwrite(fd3, new Uint8Array(R14.victimLen).fill(R14.victimByte), S);
    row.victim = w3;
    if (w3 !== R14.victimLen) return { ok: false, at: "victim", got: w3 };

    // 4. the victim makes its bytes DURABLE, or merely closes.
    if (which === "slackrevert") {
      row.fsync3 = fs.fsync(fd3);
      const mid = r14(fs, path);
      row.afterFsync3 = { size: mid.size, byteAtS: mid.bytes && mid.size > S ? mid.bytes[S] : -1 };
    } else {
      row.close3 = fs.close(fd3);
    }

    // 5. the stager commits the generation it copied in step 2.
    row.fsync2 = fs.fsync(fd2);
    row.close1 = fs.close(fd1);
    row.close2 = fs.close(fd2);
    if (which === "slackrevert") row.close3 = fs.close(fd3);

    const end = r14(fs, path);
    row.final = { size: end.size, err: end.err,
      byte0: end.bytes && end.size > 0 ? end.bytes[0] : -1,
      byteAtS: end.bytes && end.size > S ? end.bytes[S] : -1 };
    row.stageKept = row.final.byte0 === R14.stageByte;
    row.victimKept = row.final.byteAtS === R14.victimByte;
    row.revertedToStaleTail = row.final.byteAtS === R14.tailByte;
    // The victim's write was acknowledged by `pwrite`, and in `slackrevert` published by `fsync`.
    row.bothKept = row.stageKept && row.victimKept;
    row.lostSilently = !row.victimKept
      && (which === "slackclose" ? row.close3 === 0 : row.fsync3 === 0)
      && row.fsync2 === 0 && row.close1 === 0 && row.close2 === 0;
    return row;
  }

  if (which === "dirtyread") {
    const fd1 = fs.open(path, O_RDWR);
    const fd2 = fs.open(path, O_RDWR);
    if (fd1 < 0 || fd2 < 0) return { ok: false, at: "open", fd1, fd2 };
    const st = fs.fstat(fd1);
    if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
    const S = Number(st.size);
    row.S = S;
    // fd1 goes dirty against the base as it is now.
    const w1 = fs.pwrite(fd1, new Uint8Array(R14.stageLen).fill(R14.stageByte), 0);
    if (w1 !== R14.stageLen) return { ok: false, at: "stage", got: w1 };
    // fd2 appends past the committed size and PUBLISHES it, so the base moved under fd1.
    const w2 = fs.pwrite(fd2, new Uint8Array(R14.tailLen).fill(R14.tailByte), S);
    if (w2 !== R14.tailLen) return { ok: false, at: "append", got: w2 };
    row.fsync2 = fs.fsync(fd2);
    // THE TWO ANSWERS fd1 NOW GIVES ABOUT ITS OWN FILE.
    const st1 = fs.fstat(fd1);
    row.fstatSize = typeof st1 === "number" ? -st1 : Number(st1.size);
    row.seekEnd = fs.seek(fd1, 0, 2);
    // `pread(fd, into, fileOffset, want)`.
    const buf = new Uint8Array(row.fstatSize);
    const n = fs.pread(fd1, buf, 0, row.fstatSize);
    row.preadAt0 = n;
    row.readAllLen = (() => { const a = fs.readAll(fd1, row.fstatSize);
      return typeof a === "number" ? a : a.length; })();
    row.divergence = row.fstatSize - (n < 0 ? -1 : n);
    // The byte fstat promises is there. A reader that trusts fstat asks for it.
    const tail = new Uint8Array(R14.tailLen);
    row.preadAtS = fs.pread(fd1, tail, S, R14.tailLen);
    row.byteAtS = row.preadAtS > 0 ? tail[0] : -1;
    row.fsync1 = fs.fsync(fd1);
    row.close1 = fs.close(fd1);
    row.close2 = fs.close(fd2);
    const end = r14(fs, path);
    row.final = { size: end.size,
      byte0: end.bytes && end.size > 0 ? end.bytes[0] : -1,
      byteAtS: end.bytes && end.size > S ? end.bytes[S] : -1 };
    row.bothKept = row.final.byte0 === R14.stageByte && row.final.byteAtS === R14.tailByte
      && row.final.size === S + R14.tailLen;
    return row;
  }

  if (which === "threeway") {
    const fd1 = fs.open(path, O_RDWR);
    const fd2 = fs.open(path, O_RDWR);
    const fd3 = fs.open(path, O_RDWR);
    if (fd1 < 0 || fd2 < 0 || fd3 < 0) return { ok: false, at: "open", fd1, fd2, fd3 };
    const st = fs.fstat(fd1);
    if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
    const S = Number(st.size);
    row.S = S;
    if (S < 3 * R14.threeLen) return { ok: false, at: "tooSmall", S };
    const L = R14.threeLen;
    // Three stagings from ONE base, three disjoint ranges, all below the committed size.
    row.w = [fs.pwrite(fd1, new Uint8Array(L).fill(0xa1), 0),
      fs.pwrite(fd2, new Uint8Array(L).fill(0xb2), L),
      fs.pwrite(fd3, new Uint8Array(L).fill(0xc3), 2 * L)];
    if (row.w.some((x) => x !== L)) return { ok: false, at: "write", w: row.w };
    row.fsync = [fs.fsync(fd1), fs.fsync(fd2), fs.fsync(fd3)];
    row.close = [fs.close(fd1), fs.close(fd2), fs.close(fd3)];
    const end = r14(fs, path);
    row.final = { size: end.size, err: end.err,
      b: end.bytes ? [end.bytes[0], end.bytes[L], end.bytes[2 * L]] : [] };
    row.allKept = row.final.size === S && row.final.b[0] === 0xa1
      && row.final.b[1] === 0xb2 && row.final.b[2] === 0xc3;
    row.lostSilently = !row.allKept && row.fsync.every((x) => x === 0);
    return row;
  }

  if (which === "longwait") {
    const fd1 = fs.open(path, O_RDWR);
    const fd2 = fs.open(path, O_RDWR);
    if (fd1 < 0 || fd2 < 0) return { ok: false, at: "open", fd1, fd2 };
    const st = fs.fstat(fd1);
    if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
    const S = Number(st.size);
    row.S = S;
    if (S < 4) return { ok: false, at: "tooSmall", S };
    // fd1 stages against the base as it is NOW, and then waits.
    const w1 = fs.pwrite(fd1, new Uint8Array(2).fill(0xa1), 0);
    if (w1 !== 2) return { ok: false, at: "stage", got: w1 };
    // Six unrelated commits from fd2, each one a new generation. fd1's base generation is freed
    // by the first of them.
    row.rounds = [];
    for (let i = 0; i < R14.waitRounds; i += 1) {
      const w = fs.pwrite(fd2, new Uint8Array(2).fill(0xd0 + i), 2);
      const s = fs.fsync(fd2);
      row.rounds.push([w, s]);
      if (w !== 2 || s !== 0) return { ok: false, at: "round", i, w, s };
    }
    // Now fd1 publishes the generation it copied six generations ago.
    row.fsync1 = fs.fsync(fd1);
    row.close1 = fs.close(fd1);
    row.close2 = fs.close(fd2);
    const end = r14(fs, path);
    row.final = { size: end.size, err: end.err,
      byte0: end.bytes ? end.bytes[0] : -1, byteAt2: end.bytes ? end.bytes[2] : -1 };
    row.bothKept = row.final.size === S && row.final.byte0 === 0xa1
      && row.final.byteAt2 === 0xd0 + R14.waitRounds - 1;
    row.lostSilently = !row.bothKept && row.fsync1 === 0;
    return row;
  }

  return { ok: false, at: "which", which };
}
'''

PAGE_FN = """
/** ROUND 14. Each scenario on its own wiped volume, with an explicit fsck afterwards: a loss fsck
 *  calls clean is the class this project names as its worst outcome. */
async function v14run(which) {
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
    out.attack = await once(k, ['vatk14', path + '|' + which], 60000)
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

async function vattack14() {
  const out = {}
  for (const which of ['slackrevert', 'slackclose', 'dirtyread', 'threeway', 'longwait']) {
    out[which] = await v14run(which)
  }
  return { ok: false, evidence: out }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack14]]) {"""


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
