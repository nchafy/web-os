#!/usr/bin/env python3
"""Round 9: two processes whose syscalls OVERLAP inside the kernel.

Everything up to here drove one syscall at a time, so no attack could land inside the window a
kernel-side `await` opens. `writeFd` reads the live extent, picks `live.id`, and THEN awaits the
write; `commit` reads its base and THEN awaits a 260 us flush before `applyOp` uses the numbers it
read. Both are intra-operation caches, which the refactor explicitly permits.

Two `go` messages are posted back to back and both processes run at once: one rewrites the first
four bytes and fsyncs in a loop, the other appends four bytes and fsyncs in a loop. Every
acknowledged byte has to be in the file at the end, the volume has to mount, and fsck has to
account for whatever is on disk.
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk16")

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "v9a": out = v9a(env, String(arg)); break;\n'
        '    case "v9a2": out = v9a2(env); break;\n'
        '    case "v9b2": out = v9b2(env); break;\n'
        '    case "v9b": out = v9b(env, String(arg)); break;\n'
        '    case "v9check": out = v9check(env, String(arg)); break;\n')

FN = '''
/* ---------------- THE VERIFIER'S ATTACKS, ROUND 9: OVERLAPPING SYSCALLS ---------------- */

const R9 = { rounds: 200, aByte: 0xa1, bByte: 0xb2, len: 4 };

/** The in-place rewriter: a write BELOW the committed size, then fsync, sixteen times. Every one
 *  of these stages a copy-up and swings. */
function v9a(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const buf = new Uint8Array(R9.len).fill(R9.aByte);
  const writes = [];
  const syncs = [];
  for (let i = 0; i < R9.rounds; i += 1) {
    writes.push(fs.pwrite(fd, buf, 0));
    syncs.push(fs.fsync(fd));
  }
  const st = fs.fstat(fd);
  const c = fs.close(fd);
  return {
    ok: true, which: "a", close: c,
    wroteAll: writes.every((w) => w === R9.len),
    syncedAll: syncs.every((s) => s === 0),
    writeErrs: writes.filter((w) => w < 0).map((w) => -w),
    syncErrs: syncs.filter((s) => s < 0).map((s) => -s),
    fdSize: typeof st === "number" ? -st : Number(st.size),
  };
}

/** The appender: four bytes at the end, then fsync, sixteen times. Each of these publishes a size
 *  against the generation the inode is on at that instant. */
function v9b(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st0 = fs.fstat(fd);
  if (typeof st0 === "number") return { ok: false, at: "fstat", errno: -st0 };
  const S = Number(st0.size);
  const buf = new Uint8Array(R9.len).fill(R9.bByte);
  const writes = [];
  const syncs = [];
  for (let i = 0; i < R9.rounds; i += 1) {
    writes.push(fs.pwrite(fd, buf, S + i * R9.len));
    syncs.push(fs.fsync(fd));
  }
  const st = fs.fstat(fd);
  const c = fs.close(fd);
  return {
    ok: true, which: "b", S, close: c,
    wroteAll: writes.every((w) => w === R9.len),
    syncedAll: syncs.every((s) => s === 0),
    writeErrs: writes.filter((w) => w < 0).map((w) => -w),
    syncErrs: syncs.filter((s) => s < 0).map((s) => -s),
    acknowledgedEnd: S + R9.rounds * R9.len,
    fdSize: typeof st === "number" ? -st : Number(st.size),
  };
}

function fd0() { return keptFd; }

/** The rewriter and the appender again, over the fd this process ALREADY holds, so the only thing
 *  that overlaps is the write and the commit. */
function v9a2(env) {
  const fs = env.fs;
  if (keptFd < 0) return { ok: false, why: "no fd was kept" };
  const buf = new Uint8Array(R9.len).fill(R9.aByte);
  const writes = [];
  const syncs = [];
  for (let i = 0; i < R9.rounds; i += 1) {
    writes.push(fs.pwrite(fd0(), buf, 0));
    syncs.push(fs.fsync(fd0()));
  }
  const st = fs.fstat(fd0());
  return { ok: true, which: "a", wroteAll: writes.every((w) => w === R9.len),
    syncedAll: syncs.every((s) => s === 0),
    writeErrs: writes.filter((w) => w < 0).map((w) => -w),
    syncErrs: syncs.filter((s) => s < 0).map((s) => -s),
    fdSize: typeof st === "number" ? -st : Number(st.size) };
}

function v9b2(env) {
  const fs = env.fs;
  if (keptFd < 0) return { ok: false, why: "no fd was kept" };
  const buf = new Uint8Array(R9.len).fill(R9.bByte);
  const writes = [];
  const syncs = [];
  const per = [];
  for (let i = 0; i < R9.rounds; i += 1) {
    const w = fs.pwrite(fd0(), buf, keptSize + i * R9.len);
    const s = fs.fsync(fd0());
    writes.push(w);
    syncs.push(s);
    per.push({ i, at: keptSize + i * R9.len, w, s });
  }
  const st = fs.fstat(fd0());
  return { ok: true, which: "b", S: keptSize,
    wroteAll: writes.every((w) => w === R9.len),
    syncedAll: syncs.every((s) => s === 0),
    writeErrs: writes.filter((w) => w < 0).map((w) => -w),
    syncErrs: syncs.filter((s) => s < 0).map((s) => -s),
    acknowledgedEnd: keptSize + R9.rounds * R9.len, per,
    fdSize: typeof st === "number" ? -st : Number(st.size) };
}

/** A fresh description over the finished file. Every byte either process was told it wrote has to
 *  be here. */
function v9check(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const size = Number(st.size);
  const got = fs.readAll(fd, size);
  fs.close(fd);
  if (typeof got === "number") return { ok: false, at: "read", errno: -got };
  let aBytes = 0;
  for (let i = 0; i < Math.min(R9.len, size); i += 1) if (got[i] === R9.aByte) aBytes += 1;
  let bBytes = 0;
  for (let i = 0; i < size; i += 1) if (got[i] === R9.bByte) bBytes += 1;
  return { ok: true, size, read: got.length, aBytes, bBytes,
    wantA: R9.len, wantB: R9.rounds * R9.len, bytes: [...got] };
}
'''

PAGE_FN = """
/** ROUND 9. Two processes, two `go` messages posted with no await between them, so their syscalls
 *  interleave at the kernel's own await points. */
async function vattack9() {
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
    const p1 = await spawnProcess(k, ['wopen', path])
    const p2 = await spawnProcess(k, ['wopen', path])
    out.open1 = await runPid(k, p1, 30000, 'wopen 1')
    out.open2 = await runPid(k, p2, 30000, 'wopen 2')
    out.path = path
    out.blobsBefore = (await listBlobs()).map((x) => x.name + ':' + x.size).sort()
    // BOTH AT ONCE. `runPid` awaits one `results` event and would race the other's, so the two
    // gos are posted here and the rows are collected out of the event log by pid.
    const mark0 = k.events.length
    k.post({ t: 'go', go: { mode: 'park', pid: p1, argv: ['v9a2'] } })
    k.post({ t: 'go', go: { mode: 'park', pid: p2, argv: ['v9b2'] } })
    const rows = {}
    const until = performance.now() + 120000
    while (!(rows[p1] && rows[p2]) && performance.now() < until) {
      for (const m of k.events.slice(mark0)) {
        if (m.t !== 'results' || !m.results) continue
        for (const r of m.results) if (r.pid === p1 || r.pid === p2) rows[r.pid] = r
      }
      if (rows[p1] && rows[p2]) break
      await new Promise((r) => setTimeout(r, 5))
    }
    out.a = rows[p1] || { missing: true }
    out.b = rows[p2] || { missing: true }
    const p3 = await spawnProcess(k, ['v9check', path])
    k.post({ t: 'go', go: { mode: 'park', pid: p3, argv: ['v9check', path] } })
    const mark1 = k.events.length
    const t3 = performance.now() + 60000
    let row3 = null
    while (!row3 && performance.now() < t3) {
      for (const m of k.events.slice(mark1)) {
        if (m.t !== 'results' || !m.results) continue
        for (const r of m.results) if (r.pid === p3) row3 = r
      }
      if (row3) break
      await new Promise((r) => setTimeout(r, 5))
    }
    out.check = row3 || { missing: true }
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
      seen: await once(k2, ['v9check', path], 30000) }
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
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack9]]) {"""


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
