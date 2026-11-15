#!/usr/bin/env python3
"""Round 7 attack 29: O_APPEND is a seek at open, so one appender overwrites the other's bytes.

`calls.mjs:306-313` sets `d.pos = endFd(d)` ONCE, when `open` sees O_APPEND, and nothing re-reads
the end per write: `writeHeld` takes `from = d.pos` (`store.mjs:1331`) and `d.flags` is recorded at
`calls.mjs:281` and never consulted again. POSIX requires each O_APPEND write to land at the
then-current end of the file, atomically with the write — that is the entire reason the flag
exists, and `fcntl(SETFL, O_APPEND)` is in the ABI (`docs/ABI.md:119`).

No race is needed. One process, two descriptions, four calls:

    fd1 = open(p, O_WRONLY|O_APPEND)      both see end = S
    fd2 = open(p, O_WRONLY|O_APPEND)
    write(fd1, 4 bytes of 0xd1)  -> 4     lands at S, fd1's cursor becomes S+4
    fsync(fd1)                   -> 0     published: S+4
    write(fd2, 4 bytes of 0xd2)  -> 4     lands at S AGAIN, because fd2's cursor is still S
    fsync(fd2)                   -> 0

Both writes return 4 and both fsyncs return 0. The second arm runs the same thing as TWO
PROCESSES, which is the shape a shell's `cmd >> log` has.
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk29")

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "v29one": out = v29one(env, String(arg)); break;\n'
        '    case "v29open": out = v29open(env, String(arg)); break;\n'
        '    case "v29put": out = v29put(env, String(arg)); break;\n'
        '    case "v29close": out = v29close(env); break;\n'
        '    case "v29read": out = v29read(env, String(arg)); break;\n')

FN = '''
/* ---------------- ATTACK 29: TWO O_APPEND DESCRIPTIONS ---------------- */

const V29 = { a: 0xd1, b: 0xd2, len: 4 };

/** One process, two O_APPEND descriptions, in one go. Nothing concurrent. */
function v29one(env, path) {
  const fs = env.fs;
  const fd1 = fs.open(path, O_WRONLY | O_APPEND);
  if (fd1 < 0) return { ok: false, at: "open1", errno: -fd1 };
  const fd2 = fs.open(path, O_WRONLY | O_APPEND);
  if (fd2 < 0) { fs.close(fd1); return { ok: false, at: "open2", errno: -fd2 }; }
  const rd = fs.open(path, O_RDONLY);
  const st = typeof rd === "number" ? rd : fs.fstat(rd);
  const S = typeof st === "number" ? -1 : Number(st.size);
  if (rd >= 0) fs.close(rd);
  const w1 = fs.write(fd1, new Uint8Array(V29.len).fill(V29.a));
  const s1 = fs.fsync(fd1);
  const w2 = fs.write(fd2, new Uint8Array(V29.len).fill(V29.b));
  const s2 = fs.fsync(fd2);
  const c1 = fs.close(fd1);
  const c2 = fs.close(fd2);
  return { ok: true, S, w1, s1, w2, s2, c1, c2,
    // WHAT POSIX OWES THE CALLER: every byte both writes acknowledged, at distinct offsets.
    acknowledged: (w1 > 0 ? w1 : 0) + (w2 > 0 ? w2 : 0), wantEnd: S + V29.len * 2 };
}

/** The two-process arm: a description kept across this process's gos. */
let v29fd = -1;

function v29open(env, path) {
  const fs = env.fs;
  v29fd = fs.open(path, O_WRONLY | O_APPEND);
  return { ok: v29fd >= 0, fd: v29fd, errno: v29fd < 0 ? -v29fd : 0 };
}

function v29put(env, which) {
  const fs = env.fs;
  if (v29fd < 0) return { ok: false, at: "no fd" };
  const byte = which === "a" ? V29.a : V29.b;
  const w = fs.write(v29fd, new Uint8Array(V29.len).fill(byte));
  const s = fs.fsync(v29fd);
  return { ok: w === V29.len && s === 0, which, write: w, fsync: s };
}

function v29close(env) {
  const c = env.fs.close(v29fd);
  v29fd = -1;
  return { ok: c === 0, close: c };
}

/** What the file holds, byte by byte. */
function v29read(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const size = Number(st.size);
  const got = fs.readAll(fd, size);
  fs.close(fd);
  let a = 0;
  let b = 0;
  if (got) for (let i = 0; i < got.length; i += 1) {
    if (got[i] === V29.a) a += 1;
    if (got[i] === V29.b) b += 1;
  }
  return { ok: true, size, read: got ? got.length : -1, aBytes: a, bBytes: b,
    wantA: V29.len, wantB: V29.len };
}
'''

PAGE_FN = """
/** ATTACK 29. Two O_APPEND descriptions, in one process and then in two. */
async function vattack29() {
  const out = {}
  await wipe()
  const k = kernelBoot(BOOT_CFG)
  const path = pathFor(1)
  out.path = path
  try {
    const up = await k.expect('up', 20000)
    if (!up.fs || up.fs.mode !== 'rw') return { ok: false, evidence: { at: 'mount', up: up.fs } }
    await install(k)
    const made = await once(k, ['mkfiles', '4'])
    if (!made.ok) return { ok: false, evidence: { at: 'mkfiles', errors: made.errors } }
    out.before = await once(k, ['v29read', path], 30000)
    // ARM 1: one process, two descriptions, no concurrency at all.
    out.one = await once(k, ['v29one', path], 60000)
    out.afterOne = await once(k, ['v29read', path], 30000)
    // ARM 2: two processes, each holding its own O_APPEND description, writes interleaved by the
    // page rather than by chance.
    const p1 = await spawnProcess(k, ['v29open', path])
    const p2 = await spawnProcess(k, ['v29open', path])
    out.open1 = await runPid(k, p1, 30000, 'v29open 1')
    out.open2 = await runPid(k, p2, 30000, 'v29open 2')
    out.put1 = await runPid(k, p1, 30000, 'v29put a', ['v29put', 'a'])
    out.put2 = await runPid(k, p2, 30000, 'v29put b', ['v29put', 'b'])
    out.close1 = await runPid(k, p1, 30000, 'v29close 1', ['v29close'])
    out.close2 = await runPid(k, p2, 30000, 'v29close 2', ['v29close'])
    out.afterTwo = await onceByPid(k, ['v29read', path], 30000)
    k.post({ t: 'fsck' })
    const ck = await k.expect('fsck', 60000).catch(() => null)
    out.fsck = ck && ck.report
      ? { mountable: ck.report.mountable,
          problems: (ck.report.problems || []).map((p) => p.what + ': '
            + String(p.why || '').slice(0, 100)),
          blobs: ck.report.blobs }
      : null
    out.notes = (k.events || []).flatMap((m) => (m.t === 'io-note' && m.why ? [m.why] : []))
  } catch (e) {
    out.threw = String((e && e.message) || e)
  } finally {
    await shut(k)
  }
  const k2 = kernelBoot(BOOT_CFG)
  try {
    const up = await k2.expect('up', 20000)
    out.remount = { mode: up.fs && up.fs.mode,
      problems: (up.fs && up.fs.report && up.fs.report.problems ? up.fs.report.problems : [])
        .map((p) => p.what) }
    out.after = await once(k2, ['v29read', path], 30000)
    k2.post({ t: 'fsck' })
    const ck = await k2.expect('fsck', 60000).catch(() => null)
    out.fsckAfter = ck && ck.report
      ? { mountable: ck.report.mountable,
          problems: (ck.report.problems || []).map((p) => p.what),
          blobs: ck.report.blobs }
      : null
  } catch (e) {
    out.remountThrew = String((e && e.message) || e)
  } finally {
    await shut(k2)
  }
  const one = out.one || {}
  const a1 = out.afterOne || {}
  out.verdict = {
    bothWritesAcknowledged: one.w1 === 4 && one.w2 === 4 && one.s1 === 0 && one.s2 === 0,
    sizeAfterOne: a1.size, wantSizeAfterOne: one.wantEnd,
    lostInOne: typeof one.wantEnd === 'number' && typeof a1.size === 'number'
      ? one.wantEnd - a1.size : -1,
    firstWritersBytesPresent: a1.aBytes,
    secondWritersBytesPresent: a1.bBytes,
    sizeAfterTwo: (out.afterTwo || {}).size,
    aAfterTwo: (out.afterTwo || {}).aBytes, bAfterTwo: (out.afterTwo || {}).bBytes,
    fsckCleanAfter: !!(out.fsckAfter && out.fsckAfter.mountable === 'rw'
      && out.fsckAfter.problems.length === 0),
  }
  say('    O_APPEND: lost ' + out.verdict.lostInOne + ' byte(s) of 8 acknowledged; fsck clean '
    + String(out.verdict.fsckCleanAfter))
  return { ok: false, evidence: out }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack29]]) {"""


IMPORT = ("  O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_DIRECTORY,\n",
          "  O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_DIRECTORY, O_APPEND,\n")


def main() -> int:
    prog = ROOT / "bench" / "fs-core" / "program.mjs"
    text = prog.read_text()
    assert text.count(CASE[0]) == 1, text.count(CASE[0])
    # O_APPEND USED NOT TO BE IN THE PROGRAM'S IMPORT LIST, and an undefined flag makes
    # `O_WRONLY | O_APPEND` NaN — an attack whose open silently asked for something else. Round 8's
    # fix imports it for its own `append` mode, so this adds it only when it is missing: added
    # twice, program.mjs stops PARSING, the page's module graph fails to instantiate, and the page
    # sits at state 'starting' with no error reported.
    if text.count("O_APPEND,") == 0:
        assert text.count(IMPORT[0]) == 1, text.count(IMPORT[0])
        text = text.replace(*IMPORT)
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
