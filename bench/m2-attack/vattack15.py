#!/usr/bin/env python3
"""Round 15: the slack-region revert, minimised and then moved across processes.

Round 14's `slackrevert` showed the CAS's version stamp `(gen, end)` cannot see an in-place write
into [published size, row.end) — the region an uncommitted append opens. These narrow it:

  slack2fd    TWO descriptions, which is the minimum. The appender is also the victim: append a
              record, stage elsewhere, then patch the record's first bytes and fsync. The patch
              reverts to the pre-patch bytes.

  slackwiden  THE ANTI-VACUITY CONTROL. The same ordering, except the victim's write extends ONE
              byte PAST `row.end`, so the stamp does move and the CAS must fire. If this loses
              bytes too, the finding is not about the slack; if it keeps them, the boundary is
              exactly where `moved()` can see.

  slack2p     the same ordering with three PROCESSES, so the result cannot be an artifact of one
              process's fd table or of three fds in one description table.
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk15")

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "vatk15": out = vatk15(env, String(arg)); break;\n'
        '    case "v15app": out = v15app(env); break;\n'
        '    case "v15stage": out = v15stage(env); break;\n'
        '    case "v15vic": out = v15vic(env); break;\n'
        '    case "v15see": out = v15see(env, String(arg)); break;\n')

FN = '''
/* ---------------- THE VERIFIER'S ATTACKS, ROUND 15: THE SLACK REGION ---------------- */

const R15 = { tailByte: 0xc3, tailLen: 4, stageByte: 0xa1, stageLen: 8,
  victimByte: 0xb2, victimLen: 4 };

/** The appender: pwrite AT the committed size, no fsync. This opens the slack. */
function v15app(env) {
  const fs = env.fs;
  if (keptFd < 0) return { ok: false, why: "no fd was kept; wopen must run first" };
  const w = fs.pwrite(keptFd, new Uint8Array(R15.tailLen).fill(R15.tailByte), keptSize);
  return { ok: w === R15.tailLen, wrote: w, at: keptSize };
}

/** The stager: pwrite BELOW the committed size, which copies up and records the base. */
function v15stage(env) {
  const fs = env.fs;
  if (keptFd < 0) return { ok: false, why: "no fd was kept; wopen must run first" };
  const w = fs.pwrite(keptFd, new Uint8Array(R15.stageLen).fill(R15.stageByte), 0);
  return { ok: w === R15.stageLen, wrote: w, at: 0 };
}

/** The victim: pwrite INSIDE the slack, then fsync. Acknowledged and published. */
function v15vic(env) {
  const fs = env.fs;
  if (keptFd < 0) return { ok: false, why: "no fd was kept; wopen must run first" };
  const w = fs.pwrite(keptFd, new Uint8Array(R15.victimLen).fill(R15.victimByte), keptSize);
  const s = fs.fsync(keptFd);
  return { ok: w === R15.victimLen && s === 0, wrote: w, fsync: s, at: keptSize };
}

/** A fresh description over the finished file, reporting the byte at the ORIGINAL size. */
function v15see(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const S = Number(spec.slice(bar + 1));
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const size = Number(st.size);
  const got = fs.readAll(fd, size);
  fs.close(fd);
  if (typeof got === "number") return { ok: false, at: "read", errno: -got };
  return { ok: true, size, byte0: size > 0 ? got[0] : -1,
    byteAtS: size > S ? got[S] : -1,
    victimKept: size > S && got[S] === R15.victimByte,
    revertedToStaleTail: size > S && got[S] === R15.tailByte };
}

function vatk15(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const which = spec.slice(bar + 1);
  const row = { ok: true, which };

  const fd1 = fs.open(path, O_RDWR);
  const fd2 = fs.open(path, O_RDWR);
  if (fd1 < 0 || fd2 < 0) return { ok: false, at: "open", fd1, fd2 };
  const st = fs.fstat(fd1);
  if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
  const S = Number(st.size);
  row.S = S;

  // 1. fd1 appends at the committed size. No fsync, no read: the slack is open.
  const w1 = fs.pwrite(fd1, new Uint8Array(R15.tailLen).fill(R15.tailByte), S);
  row.append = w1;
  if (w1 !== R15.tailLen) return { ok: false, at: "append", got: w1 };

  // 2. fd2 writes below the committed size, so it copies up and takes its base.
  const w2 = fs.pwrite(fd2, new Uint8Array(R15.stageLen).fill(R15.stageByte), 0);
  row.staged = w2;
  if (w2 !== R15.stageLen) return { ok: false, at: "stage", got: w2 };

  // 3. fd1 patches what it appended. `slackwiden` makes the patch one byte LONGER than the slack,
  //    so `row.end` rises and the CAS's stamp moves.
  const patchLen = which === "slackwiden" ? R15.tailLen + 1 : R15.victimLen;
  const w3 = fs.pwrite(fd1, new Uint8Array(patchLen).fill(R15.victimByte), S);
  row.patch = { len: patchLen, wrote: w3 };
  if (w3 !== patchLen) return { ok: false, at: "patch", got: w3 };
  row.fsync1 = fs.fsync(fd1);

  // 4. the stager commits the generation it copied in step 2.
  row.fsync2 = fs.fsync(fd2);
  row.close1 = fs.close(fd1);
  row.close2 = fs.close(fd2);

  const fd3 = fs.open(path, O_RDONLY);
  const st3 = fs.fstat(fd3);
  const size = typeof st3 === "number" ? -1 : Number(st3.size);
  const got = size < 0 ? null : fs.readAll(fd3, size);
  fs.close(fd3);
  row.final = { size, byte0: got && size > 0 ? got[0] : -1,
    byteAtS: got && size > S ? got[S] : -1 };
  row.stageKept = row.final.byte0 === R15.stageByte;
  row.victimKept = row.final.byteAtS === R15.victimByte;
  row.revertedToStaleTail = row.final.byteAtS === R15.tailByte;
  row.bothKept = row.stageKept && row.victimKept;
  row.lostSilently = !row.victimKept && row.fsync1 === 0 && row.fsync2 === 0
    && row.close1 === 0 && row.close2 === 0;
  return row;
}
'''

PAGE_FN = """
/** ROUND 15. Each scenario on its own wiped volume, with an explicit fsck afterwards. */
async function v15run(which) {
  const out = {}
  await wipe()
  let k = kernelBoot(BOOT_CFG)
  const path = pathFor(1)
  const S = bytesFor(1).length
  try {
    const up = await k.expect('up', 20000)
    if (up.fs.mode !== 'rw') return { at: 'mount', mode: up.fs.mode }
    await install(k)
    const made = await once(k, ['mkfiles', '4'])
    if (!made.ok) return { at: 'mkfiles', errors: made.errors }
    out.path = path
    out.S = S
    out.blobsBefore = (await listBlobs()).map((x) => x.name + ':' + x.size).sort()

    if (which === 'slack2p') {
      // THREE PROCESSES, each with its own description. Nothing reads the file until the end: a
      // read-only open+close COMMITS a pending append and would close the slack window.
      const p1 = await spawnProcess(k, ['wopen', path])
      out.open1 = await runPid(k, p1, 30000, 'wopen 1')
      const p2 = await spawnProcess(k, ['wopen', path])
      out.open2 = await runPid(k, p2, 30000, 'wopen 2')
      const p3 = await spawnProcess(k, ['wopen', path])
      out.open3 = await runPid(k, p3, 30000, 'wopen 3')
      out.append1 = await runPid(k, p1, 30000, 'v15app', ['v15app'])
      out.stage2 = await runPid(k, p2, 30000, 'v15stage', ['v15stage'])
      out.victim3 = await runPid(k, p3, 30000, 'v15vic', ['v15vic'])
      out.sync2 = await runPid(k, p2, 30000, 'wsync', ['wsync'])
      out.close1 = await runPid(k, p1, 30000, 'wclose', ['wclose'])
      out.close2 = await runPid(k, p2, 30000, 'wclose', ['wclose'])
      out.close3 = await runPid(k, p3, 30000, 'wclose', ['wclose'])
      out.final = await once(k, ['v15see', path + '|' + S], 30000)
    } else {
      out.attack = await once(k, ['vatk15', path + '|' + which], 60000)
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
  await waitForJournal()
  const k2 = kernelBoot(BOOT_CFG)
  try {
    const up = await k2.expect('up', 20000)
    out.afterRemount = { mode: up.fs.mode,
      problems: (up.fs.report && up.fs.report.problems ? up.fs.report.problems : [])
        .map((p) => p.what),
      seen: await once(k2, ['v15see', path + '|' + S], 30000) }
  } catch (e) {
    out.afterRemount = { threw: String(e && e.message || e) }
  } finally {
    await shut(k2)
  }
  return out
}

async function vattack15() {
  const out = {}
  for (const which of ['slack2fd', 'slackwiden', 'slack2p']) {
    out[which] = await v15run(which)
  }
  return { ok: false, evidence: out }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack15]]) {"""


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
