#!/usr/bin/env python3
"""Round 7 attack 26: a SNAPSHOT concurrent with ordinary journal appends.

`writeSnapshot` is the one durable read-then-mutate in store.mjs that the per-inode mutex cannot
cover, because the state it reads and mutates is not an inode: it serialises the VFS and
`this.seq` into the image SYNCHRONOUSLY, then awaits IO_WRITE_ALL (a getFileHandle, a 495 us
createSyncAccessHandle, a write and a 260 us flush), and then TRUNCATES the journal. Every record
appended inside that window is destroyed by the truncate and is not in the image either, because
the image was serialised before it existed.

Two arms, because the two outcomes are different defects:

  rounds=1, snapshot posted first   — one record can be destroyed and nothing follows it, so the
                                      journal is EMPTY at the next mount and fsck has nothing to
                                      report. Acknowledged bytes gone, volume reported clean.
  rounds=60, writer posted first    — k records are destroyed, so every later record's sequence is
                                      k ahead of the image's journalFirstSeq. Replay stops at byte
                                      0 with seq-gap and discards the WHOLE journal: the next mount
                                      is read-only and every op after the snapshot is lost too.

Both arms are ordinary calls: no crash, no planted blob, no patched kernel. Every pwrite and every
fsync returns success.
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk26")

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "vsnapw": out = vsnapw(env, String(arg)); break;\n'
        '    case "vsnapr": out = vsnapr(env, String(arg)); break;\n')

FN = '''
/* ---------------- ATTACK 26: APPENDS THAT RACE A SNAPSHOT ---------------- */

const V26 = { byte: 0xc7, len: 4 };

/** `path|rounds`: append V26.len bytes at the end and fsync, `rounds` times. Every return value is
 *  kept, so "acknowledged" is this program's own record and not the page's assumption. */
function vsnapw(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const rounds = Number(spec.slice(bar + 1)) || 1;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const S = Number(st.size);
  const buf = new Uint8Array(V26.len).fill(V26.byte);
  const writes = [];
  const syncs = [];
  for (let i = 0; i < rounds; i += 1) {
    writes.push(fs.pwrite(fd, buf, S + i * V26.len));
    syncs.push(fs.fsync(fd));
  }
  const close = fs.close(fd);
  return {
    ok: true, rounds, S, close,
    wroteAll: writes.every((w) => w === V26.len),
    syncedAll: syncs.every((s) => s === 0),
    errnos: [...writes, ...syncs, close].filter((r) => r < 0).map((r) => -r),
    // WHAT THE PROGRAM WAS TOLD IS IN THE FILE. Only the acknowledged rounds count.
    acknowledgedEnd: S + writes.filter((w) => w === V26.len).length * V26.len,
  };
}

/** What the file holds now, through a fresh description. */
function vsnapr(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const size = Number(st.size);
  const got = fs.readAll(fd, size);
  fs.close(fd);
  let mine = 0;
  if (got && got.length) for (let i = 0; i < got.length; i += 1) if (got[i] === V26.byte) mine += 1;
  return { ok: true, size, read: got ? got.length : -1, mine };
}
'''

PAGE_FN = """
/** How many trials each arm runs. Twelve, so a rate reads as a rate. */
const V26_TRIALS = 8

/**
 * ONE TRIAL. Build a volume, start the appender and the snapshot CONCURRENTLY, then take the
 * kernel away and remount — which is what a reload does.
 *
 * `order` decides which message is posted first. Neither is awaited before the other goes out, so
 * the kernel sees both in the same dispatch turn.
 */
async function v26trial(rounds, delayMs) {
  const rec = { rounds, delayMs }
  await wipe()
  const k = kernelBoot(BOOT_CFG)
  const path = pathFor(1)
  rec.path = path
  try {
    const up = await k.expect('up', 20000)
    if (!up.fs || up.fs.mode !== 'rw') { rec.at = 'mount'; rec.mode = up.fs && up.fs.mode; return rec }
    await install(k)
    const made = await once(k, ['mkfiles', '4'])
    if (!made.ok) { rec.at = 'mkfiles'; rec.errors = made.errors; return rec }
    const pid = await spawnProcess(k, ['vsnapw', path + '|' + rounds])
    const go = { t: 'go', go: { mode: 'park', pid, argv: ['vsnapw', path + '|' + rounds] } }
    // delayMs < 0: the snapshot goes first. Otherwise the writer goes first and the snapshot
    // follows after delayMs, so the window opens with appends already in flight.
    if (delayMs < 0) { k.post({ t: 'snapshot' }); k.post(go) }
    else if (delayMs === 0) { k.post(go); k.post({ t: 'snapshot' }) }
    else {
      k.post(go)
      await new Promise((r) => setTimeout(r, delayMs))
      k.post({ t: 'snapshot' })
    }
    rec.row = await rowFor(k, pid, 120000, 'vsnapw')
    rec.snap = await k.expect('snapshot', 120000).then(
      (m) => ({ ok: m.ok, r: m.r, generation: m.generation, slot: m.slot,
        journalFirstSeq: m.journalFirstSeq }), (e) => ({ threw: String(e && e.message) }))
    // What the LIVE kernel says the file is, before anything is remounted. The loss is at the
    // next mount, so a live read that still shows the bytes is part of the evidence.
    rec.live = await onceByPid(k, ['vsnapr', path], 60000)
  } catch (e) {
    rec.threw = String((e && e.message) || e)
  } finally {
    await shut(k)
  }
  rec.journal = await journalSeqs()
  const k2 = kernelBoot(BOOT_CFG)
  try {
    const up = await k2.expect('up', 20000)
    rec.remount = {
      mode: up.fs && up.fs.mode,
      journal: up.fs && up.fs.report ? up.fs.report.journal : null,
      problems: (up.fs && up.fs.report && up.fs.report.problems ? up.fs.report.problems : [])
        .map((p) => p.what + ': ' + String(p.why || '').slice(0, 120)),
    }
    rec.after = await once(k2, ['vsnapr', path], 60000)
    k2.post({ t: 'fsck' })
    const ck = await k2.expect('fsck', 120000).catch(() => null)
    rec.fsck = ck && ck.report
      ? { mountable: ck.report.mountable,
          problems: (ck.report.problems || []).map((p) => p.what + ': ' + String(p.why || '').slice(0, 120)),
          blobs: ck.report.blobs }
      : null
  } catch (e) {
    rec.remountThrew = String((e && e.message) || e)
  } finally {
    await shut(k2)
  }
  // THE VERDICT FOR THIS TRIAL, computed from the program's own acknowledged end.
  const ack = rec.row && rec.row.acknowledgedEnd !== undefined ? rec.row.acknowledgedEnd : -1
  const got = rec.after && rec.after.size !== undefined ? rec.after.size : -1
  rec.ack = ack
  rec.sizeAfter = got
  rec.lostBytes = ack >= 0 && got >= 0 ? Math.max(0, ack - got) : -1
  rec.fsckClean = !!(rec.fsck && rec.fsck.mountable === 'rw' && rec.fsck.problems.length === 0)
  rec.remountRW = !!(rec.remount && rec.remount.mode === 'rw')
  // A loss NOTHING reports: bytes gone, the volume read-write, fsck with no problems.
  rec.silentLoss = rec.lostBytes > 0 && rec.fsckClean && rec.remountRW
  rec.loudLoss = rec.lostBytes > 0 && !rec.silentLoss
  return rec
}

/** ATTACK 26. Both arms, eight trials each. */
async function vattack26() {
  const out = { arms: {} }
  for (const [name, rounds, delayMs, n] of [['one-snapfirst', 1, -1, 12],
    ['long-middle', 400, 60, 4]]) {
    const trials = []
    for (let i = 0; i < n; i += 1) {
      try {
        trials.push(await v26trial(rounds, delayMs))
      } catch (e) {
        trials.push({ rounds, delayMs, threw: String((e && e.message) || e) })
      }
    }
    const silent = trials.filter((t) => t.silentLoss).length
    const loud = trials.filter((t) => t.loudLoss).length
    const ro = trials.filter((t) => t.remount && t.remount.mode !== 'rw').length
    out.arms[name] = {
      trials: trials.length, silentLoss: silent, loudLoss: loud, remountedReadOnly: ro,
      lostBytes: trials.map((t) => t.lostBytes),
      sizes: trials.map((t) => String(t.ack) + '->' + String(t.sizeAfter)),
      modes: trials.map((t) => (t.remount && t.remount.mode) || '?'),
      fsckClean: trials.map((t) => t.fsckClean === true),
      journalRecords: trials.map((t) => (t.journal && t.journal.records) !== undefined
        ? t.journal.records : -1),
      // One trial in full, so every number above has an address.
      worst: trials.find((t) => t.silentLoss) || trials.find((t) => t.loudLoss) || trials[0],
    }
    say('    arm ' + name + ': silent ' + silent + '/' + trials.length + ', loud ' + loud
      + ', read-only remounts ' + ro)
  }
  return { ok: false, evidence: out }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack26]]) {"""


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
