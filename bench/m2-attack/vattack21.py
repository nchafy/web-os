#!/usr/bin/env python3
"""Round 7b: name the -EBADF.

Round 7a measured an acknowledged 4-byte `pwrite` destroyed by a killed writer's teardown commit,
with `close of inode 22 could not publish its write: errno 8` — EBADF, not EBUSY — and two
`pwrite`s on live fds refused with the same errno under metadata load. -EBADF can only come from
src/kernel/iocore.mjs's `handles.get(id)` missing (or `views.get(pid)` missing, which no commit
uses), so the hypothesis is a stale handle id: `resolve()` re-points the per-inode row and closes
the superseded handle while another operation is still holding that id across an await.

THE DIAGNOSTIC IS IN A THROWAWAY TREE, not in the worktree. It only NAMES what already returns
-EBADF — the request kind and the id — so an observed errno can be attributed to a call site
instead of deduced.

  killvalue   the round-7a kill scenario with a DISTINCT byte per round, because the previous run
              could only detect a loss in round 0: a round whose write vanished read back the
              PREVIOUS round's byte, which looks like a survivor.
  ebadf       two writers contending for 200 rounds each, to collect the -EBADF notes on live fds.
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk21")

# --- the diagnostic: every -EBADF in iocore names the request and the id -----------------------
IOCORE = [
    ("  function write(m) {\n    const h = handles.get(m.id);\n    if (!h) return -EBADF;",
     "  function write(m) {\n    const h = handles.get(m.id);\n"
     "    if (!h) { note(`DIAG write: no handle ${m.id}`); return -EBADF; }"),
    ("  function read(m) {\n    const h = handles.get(m.id);\n    if (!h) return -EBADF;",
     "  function read(m) {\n    const h = handles.get(m.id);\n"
     "    if (!h) { note(`DIAG read: no handle ${m.id}`); return -EBADF; }"),
    ("    const from = handles.get(m.from);\n    const to = handles.get(m.to);\n"
     "    if (!from || !to) return -EBADF;",
     "    const from = handles.get(m.from);\n    const to = handles.get(m.to);\n"
     "    if (!from || !to) { note(`DIAG copy: from ${m.from}${from ? '' : ' MISSING'} to "
     "${m.to}${to ? '' : ' MISSING'}`); return -EBADF; }"),
    ("  function size(m) {\n    const h = handles.get(m.id);\n    if (!h) return -EBADF;",
     "  function size(m) {\n    const h = handles.get(m.id);\n"
     "    if (!h) { note(`DIAG size: no handle ${m.id}`); return -EBADF; }"),
    ("  function fsync(m) {\n    const h = handles.get(m.id);\n    if (!h) return -EBADF;",
     "  function fsync(m) {\n    const h = handles.get(m.id);\n"
     "    if (!h) { note(`DIAG fsync: no handle ${m.id}`); return -EBADF; }"),
    ("  function truncate(m) {\n    const h = handles.get(m.id);\n    if (!h) return -EBADF;",
     "  function truncate(m) {\n    const h = handles.get(m.id);\n"
     "    if (!h) { note(`DIAG truncate: no handle ${m.id}`); return -EBADF; }"),
    ("  function close(m) {\n    const h = handles.get(m.id);\n    if (!h) return -EBADF;",
     "  function close(m) {\n    const h = handles.get(m.id);\n"
     "    if (!h) { note(`DIAG close: no handle ${m.id}`); return -EBADF; }"),
]

# --- and the store names which of its own calls the errno came back to -------------------------
STORE = [
    ("      const r = await this.io.request(IO_COPY, { from: from.id, to: staged.id, limit: want });\n"
     "      if (typeof r === \"number\") {",
     "      const r = await this.io.request(IO_COPY, { from: from.id, to: staged.id, limit: want });\n"
     "      if (typeof r === \"number\") {\n"
     "        this.note(`DIAG copyUp of ${d.ino} from gen ${from.gen} id ${from.id} failed: `\n"
     "          + `errno ${-r}`);"),
    ("    const n = await this.io.request(IO_WRITE, { id: target, pid, srcOff, length, at: from });\n"
     "    if (n < 0) return n;",
     "    const n = await this.io.request(IO_WRITE, { id: target, pid, srcOff, length, at: from });\n"
     "    if (n < 0) { this.note(`DIAG writeFd ino ${d.ino} id ${target} errno ${-n}`); return n; }"),
    ("      const re = await this.restage(d);\n      if (re < 0) {",
     "      const re = await this.restage(d);\n      if (re < 0) {\n"
     "        this.note(`DIAG restage of ino ${d.ino} failed errno ${-re}; the staged generation `\n"
     "          + `and its acknowledged bytes are about to be dropped`);"),
]

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "v21one": out = v21one(env, String(arg)); break;\n'
        '    case "v21ham": out = v21ham(env, String(arg)); break;\n'
        '    case "v21byte": out = v21byte(env, String(arg)); break;\n')

FN = '''
/* ---------------- ROUND 7b: NAMING THE -EBADF ---------------- */

const R21 = { len: 4, hamByte: 0x54 };

/** The victim: one write at offset 4 with the value this round was given, then nothing. */
function v21one(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const value = Number(spec.slice(bar + 1));
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  keptFd = fd;
  const w = fs.pwrite(fd, new Uint8Array(R21.len).fill(value), R21.len);
  return { ok: w === R21.len, wrote: w, at: R21.len, value, fd };
}

/** The contender: rewrite offset 0 and fsync, in a loop. */
function v21ham(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const rounds = Number(spec.slice(bar + 1)) || 200;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const buf = new Uint8Array(R21.len).fill(R21.hamByte);
  const writeErrs = [];
  const syncErrs = [];
  let wrote = 0;
  let synced = 0;
  for (let i = 0; i < rounds; i += 1) {
    const w = fs.pwrite(fd, buf, 0);
    if (w === R21.len) wrote += 1; else writeErrs.push({ i, errno: -w });
    const s = fs.fsync(fd);
    if (s === 0) synced += 1; else syncErrs.push({ i, errno: -s });
  }
  const c = fs.close(fd);
  return { ok: true, rounds, wrote, synced, close: c,
    writeErrs: writeErrs.slice(0, 10), syncErrs: syncErrs.slice(0, 10),
    writeErrCount: writeErrs.length, syncErrCount: syncErrs.length };
}

/** The bytes, through a fresh description. */
function v21byte(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const size = Number(st.size);
  const got = fs.readAll(fd, size);
  fs.close(fd);
  if (typeof got === "number") return { ok: false, at: "read", errno: -got };
  return { ok: true, size, read: got.length, at0: size > 0 ? got[0] : -1,
    at4: size > R21.len ? got[R21.len] : -1 };
}
'''

PAGE_FN = """
/** A DISTINCT VALUE PER ROUND, so a round whose write vanished cannot read back as a survivor by
 *  finding the PREVIOUS round's byte at the same offset. 0x54 is the contender's and is skipped. */
const V21 = [0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c]

async function v21kill() {
  const out = { rounds: [] }
  const ROUNDS = 12
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
    for (let r = 0; r < ROUNDS; r += 1) {
      const value = V21[r]
      const mark = (k.events || []).length
      const victim = await spawnProcess(k, ['v21one', path + '|' + value])
      const ham = await spawnProcess(k, ['v21ham', path + '|200'])
      k.post({ t: 'go', go: { mode: 'park', pid: ham, argv: ['v21ham', path + '|200'] } })
      k.post({ t: 'go', go: { mode: 'park', pid: victim, argv: ['v21one', path + '|' + value] } })
      const stage = await rowFor(k, victim, 60000, 'v21one')
      k.post({ t: 'end-process', pid: victim })
      const hamRow = await rowFor(k, ham, 300000, 'v21ham')
      const after = await onceByPid(k, ['v21byte', path], 60000)
      const notes = (k.events || []).slice(mark)
        .flatMap((m) => (m.t === 'io-note' && m.why ? [m.why] : []))
      out.rounds.push({ r, value, wrote: stage.wrote, at0: after.at0, at4: after.at4,
        survived: after.at4 === value, size: after.size,
        hamWrote: hamRow.wrote, hamSynced: hamRow.synced,
        hamWriteErrs: hamRow.writeErrs, hamSyncErrs: hamRow.syncErrs,
        notes: notes.slice(0, 14) })
    }
    k.post({ t: 'fsck' })
    const ck = await k.expect('fsck', 30000).catch(() => null)
    out.fsck = ck && ck.report
      ? { mountable: ck.report.mountable, problems: (ck.report.problems || []).map((p) => p.what),
          blobs: ck.report.blobs }
      : null
    k.post({ t: 'fs-state' })
    out.stats = (await k.expect('fs-state', 10000)).fs.stats
  } catch (e) {
    out.threw = String((e && e.message) || e)
  } finally {
    await shut(k)
  }
  await waitForJournal()
  k = kernelBoot(BOOT_CFG)
  try {
    const up = await k.expect('up', 20000)
    out.remount = { mode: up.fs.mode,
      problems: (up.fs.report && up.fs.report.problems ? up.fs.report.problems : [])
        .map((p) => p.what),
      byte: await once(k, ['v21byte', path], 30000) }
  } catch (e) {
    out.remount = { threw: String((e && e.message) || e) }
  } finally {
    await shut(k)
  }
  const rows = out.rounds || []
  out.acknowledged = rows.filter((x) => x.wrote === 4).length
  out.vanished = rows.filter((x) => x.wrote === 4 && x.survived !== true).length
  out.vanishedRounds = rows.filter((x) => x.wrote === 4 && x.survived !== true)
    .map((x) => ({ r: x.r, wanted: x.value, at4: x.at4, notes: x.notes }))
  out.liveFdWriteErrs = rows.flatMap((x) => x.hamWriteErrs || [])
  out.liveFdSyncErrs = rows.flatMap((x) => x.hamSyncErrs || [])
  out.volumeClean = !!(out.fsck && out.fsck.mountable === 'rw' && out.fsck.problems.length === 0)
    && (out.remount || {}).mode === 'rw'
  return out
}

async function vattack21() {
  return { ok: false, evidence: { killvalue: await v21kill() } }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack21]]) {"""


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
