#!/usr/bin/env python3
"""Round 7c: the errno census on LIVE file descriptors.

Round 7b proved the loss mechanism: `resolve()` closes the superseded handle while another
operation is still holding that handle's id across an await, so `copy` cannot find it and answers
-EBADF. `restage` turns that into destroyed data. This asks what a process that is NOT dying sees
from the same race: three writers, each looping pwrite below the published size, pread of the whole
file, and fsync, with every errno recorded per call and the diagnostic notes collected.

Same diagnostic patch as round 7b, in a throwaway tree.
"""
import pathlib
import sys

sys.path.insert(0, "/Users/chafyni/.claude/jobs/e856c39e/tmp")
from vattack21 import IOCORE, STORE  # noqa: E402  the same diagnostic, one definition

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk22")

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "v22mix": out = v22mix(env, String(arg)); break;\n'
        '    case "v22byte": out = v22byte(env, String(arg)); break;\n')

FN = '''
/* ---------------- ROUND 7c: THE ERRNO CENSUS ON LIVE FDS ---------------- */

const R22 = { len: 4 };

/** pwrite below the published size, pread of the whole file, fsync. Every errno recorded. */
function v22mix(env, spec) {
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const rest = spec.slice(bar + 1);
  const cut = rest.indexOf(",");
  const value = Number(rest.slice(0, cut));
  const rounds = Number(rest.slice(cut + 1)) || 200;
  const fs = env.fs;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st0 = fs.fstat(fd);
  if (typeof st0 === "number") return { ok: false, at: "fstat", errno: -st0 };
  const S = Number(st0.size);
  const buf = new Uint8Array(R22.len).fill(value);
  const back = new Uint8Array(64);
  const writeErrs = [];
  const readErrs = [];
  const shortReads = [];
  const syncErrs = [];
  const statErrs = [];
  let wrote = 0;
  let synced = 0;
  let readOk = 0;
  for (let i = 0; i < rounds; i += 1) {
    const w = fs.pwrite(fd, buf, 0);
    if (w === R22.len) wrote += 1;
    else if (w < 0) writeErrs.push({ i, errno: -w });
    else writeErrs.push({ i, short: w });

    const st = fs.fstat(fd);
    if (typeof st === "number") { statErrs.push({ i, errno: -st }); continue; }
    const size = Number(st.size);

    const n = fs.pread(fd, back, 0, Math.min(size, back.length));
    if (n < 0) readErrs.push({ i, errno: -n });
    else if (n < Math.min(size, back.length)) shortReads.push({ i, got: n, want: size });
    else readOk += 1;

    const s = fs.fsync(fd);
    if (s === 0) synced += 1; else syncErrs.push({ i, errno: -s });
  }
  const c = fs.close(fd);
  return { ok: true, S, value, rounds, wrote, synced, readOk, close: c,
    writeErrCount: writeErrs.length, readErrCount: readErrs.length,
    shortReadCount: shortReads.length, syncErrCount: syncErrs.length,
    statErrCount: statErrs.length,
    writeErrs: writeErrs.slice(0, 10), readErrs: readErrs.slice(0, 10),
    shortReads: shortReads.slice(0, 10), syncErrs: syncErrs.slice(0, 10),
    statErrs: statErrs.slice(0, 10) };
}

function v22byte(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const size = Number(st.size);
  const got = fs.readAll(fd, size);
  fs.close(fd);
  if (typeof got === "number") return { ok: false, at: "read", errno: -got };
  return { ok: true, size, read: got.length, at0: size > 0 ? got[0] : -1 };
}
'''

PAGE_FN = """
async function v22run() {
  const out = {}
  await wipe()
  let k = kernelBoot(BOOT_CFG)
  const path = pathFor(1)
  const VALUES = [0x71, 0x72, 0x73]
  try {
    const up = await k.expect('up', 20000)
    if (up.fs.mode !== 'rw') return { at: 'mount', mode: up.fs.mode }
    await install(k)
    const made = await once(k, ['mkfiles', '4'])
    if (!made.ok) return { at: 'mkfiles', errors: made.errors }
    out.path = path
    const pids = []
    for (const v of VALUES) {
      pids.push(await spawnProcess(k, ['v22mix', path + '|' + v + ',200']))
    }
    for (let i = 0; i < pids.length; i += 1) {
      k.post({ t: 'go',
        go: { mode: 'park', pid: pids[i], argv: ['v22mix', path + '|' + VALUES[i] + ',200'] } })
    }
    out.writers = []
    for (let i = 0; i < pids.length; i += 1) {
      const r = await rowFor(k, pids[i], 300000, 'v22mix ' + VALUES[i])
      out.writers.push({ value: r.value, S: r.S, wrote: r.wrote, synced: r.synced,
        readOk: r.readOk, close: r.close,
        writeErrCount: r.writeErrCount, readErrCount: r.readErrCount,
        shortReadCount: r.shortReadCount, syncErrCount: r.syncErrCount,
        statErrCount: r.statErrCount,
        writeErrs: r.writeErrs, readErrs: r.readErrs, shortReads: r.shortReads,
        syncErrs: r.syncErrs, statErrs: r.statErrs })
    }
    out.after = await onceByPid(k, ['v22byte', path], 60000)
    k.post({ t: 'fs-state' })
    out.stats = (await k.expect('fs-state', 10000)).fs.stats
    k.post({ t: 'fsck' })
    const ck = await k.expect('fsck', 30000).catch(() => null)
    out.fsck = ck && ck.report
      ? { mountable: ck.report.mountable, problems: (ck.report.problems || []).map((p) => p.what),
          blobs: ck.report.blobs }
      : null
    // EVERY note, not a filtered set: the filtered run attributed -EBADF and left the -EIO
    // fsyncs unattributed, which is the same mistake as reading only the errnos you expected.
    out.diag = (k.events || []).flatMap((m) => (m.t === 'io-note' && m.why ? [m.why] : []))
    out.notes = (out.diag || []).length
  } catch (e) {
    out.threw = String((e && e.message) || e)
  } finally {
    await shut(k)
  }
  out.journalSeqs = await journalSeqs()
  k = kernelBoot(BOOT_CFG)
  try {
    const up = await k.expect('up', 20000)
    out.remount = { mode: up.fs.mode,
      journal: up.fs.report && up.fs.report.journal,
      problems: (up.fs.report && up.fs.report.problems ? up.fs.report.problems : [])
        .map((p) => p.what),
      byte: await once(k, ['v22byte', path], 30000) }
  } catch (e) {
    out.remount = { threw: String((e && e.message) || e) }
  } finally {
    await shut(k)
  }
  const w = out.writers || []
  out.everyWriteAcknowledged = w.length === 3 && w.every((x) => x.writeErrCount === 0)
  out.everyReadWhole = w.length === 3
    && w.every((x) => x.readErrCount === 0 && x.shortReadCount === 0)
  out.everySyncOk = w.length === 3 && w.every((x) => x.syncErrCount === 0)
  out.volumeClean = !!(out.fsck && out.fsck.mountable === 'rw' && out.fsck.problems.length === 0)
    && (out.remount || {}).mode === 'rw'
  return out
}

async function vattack22() {
  return { ok: false, evidence: { census: await v22run() } }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack22]]) {"""


def patch(rel, pairs):
    path = ROOT / rel
    text = path.read_text()
    for old, new in pairs:
        n = text.count(old)
        assert n == 1, "anchor in %s matched %d time(s): %r" % (rel, n, old[:60])
        text = text.replace(old, new)
    path.write_text(text)
    print("patched %s (%d anchor(s))" % (rel, len(pairs)))


def main() -> int:
    patch("src/kernel/iocore.mjs", IOCORE)
    patch("src/kernel/store.mjs", STORE)

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
