#!/usr/bin/env python3
"""Round 7d: THE DECISIVE PROBE. Can a stale compare-and-swap revert an fsynced append?

Round 7c observed, in the kernel's own note:

    commit of inode 22 generation 533 over 530 was refused: inode 22: commit moves generation
    534 back to 533

`applyOp`'s only assertion is monotonicity, so for it to fire the compare-and-swap must have
PASSED over an inode whose generation had moved from 530 to 534. That is only possible if
`row.mut` had not advanced across that publish — and it cannot have, because `commitOnce` bumps
the stamp TWO AWAITS after `applyOp`: `await this.journal(op)` and `await this.flushJournal()`
(the 260 us flush) sit between the generation changing and the counter recording it.

The refused arm destroys the refusing description's own staged bytes under -EIO. This probes the
OTHER arm, which is silent: a staged commit whose generation is HIGHER passes the same stale CAS,
is accepted by `applyOp`, and publishes a size computed from a base that moved — reverting an
append another description had already fsynced.

  appender    writes a DISTINCT value into its own 4-byte slot at the end, fsyncs, and checks the
              slot back through its own fd. Every acknowledged slot must hold its own value at the
              end and after a remount.
  rewriters   two descriptions writing BELOW the published size, so every round stages a copy-up
              and publishes a size equal to the base it copied.
"""
import pathlib
import sys

sys.path.insert(0, "/Users/chafyni/.claude/jobs/e856c39e/tmp")
from vattack21 import IOCORE, STORE  # noqa: E402

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk23")

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "v23app": out = v23app(env, String(arg)); break;\n'
        '    case "v23rew": out = v23rew(env, String(arg)); break;\n'
        '    case "v23check": out = v23check(env, String(arg)); break;\n')

FN = '''
/* ---------------- ROUND 7d: CAN A STALE CAS REVERT AN FSYNCED APPEND? ---------------- */

const R23 = { len: 4 };

/** The value slot `i` must hold. Never 0 and never the rewriters' byte, so a zero-filled or
 *  rewritten slot is distinguishable from a slot that holds its own value. */
function v23value(i) { return 1 + (i % 200); }

/**
 * THE APPENDER. Per round: write this round's value into the next 4-byte slot, fsync it, then ask
 * its OWN fd where the file ends and read the slot back. Both answers are checked against the
 * acknowledgement the write already returned.
 */
function v23app(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const rounds = Number(spec.slice(bar + 1)) || 200;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st0 = fs.fstat(fd);
  if (typeof st0 === "number") return { ok: false, at: "fstat", errno: -st0 };
  const S = Number(st0.size);
  const back = new Uint8Array(R23.len);
  const writeErrs = [];
  const syncErrs = [];
  const shrank = [];
  const wrongBack = [];
  let acked = 0;
  for (let i = 0; i < rounds; i += 1) {
    const at = S + i * R23.len;
    const value = v23value(i);
    const w = fs.pwrite(fd, new Uint8Array(R23.len).fill(value), at);
    if (w !== R23.len) { writeErrs.push({ i, at, got: w }); continue; }
    const s = fs.fsync(fd);
    if (s !== 0) { syncErrs.push({ i, at, errno: -s }); continue; }
    acked += 1;
    // THE SIZE, THROUGH THIS FD, AFTER ITS OWN FSYNC RETURNED 0. It may never be below the end of
    // the slot this round just made durable.
    const st = fs.fstat(fd);
    const size = typeof st === "number" ? -1 : Number(st.size);
    if (size < at + R23.len) shrank.push({ i, at, size, value });
    const n = fs.pread(fd, back, at, R23.len);
    if (n !== R23.len || back[0] !== value) {
      wrongBack.push({ i, at, got: n, byte: n > 0 ? back[0] : -1, want: value });
    }
  }
  const stN = fs.fstat(fd);
  const c = fs.close(fd);
  return { ok: true, which: "appender", S, rounds, acked, close: c,
    acknowledgedEnd: S + rounds * R23.len,
    fdSize: typeof stN === "number" ? -stN : Number(stN.size),
    writeErrCount: writeErrs.length, syncErrCount: syncErrs.length,
    shrankCount: shrank.length, wrongBackCount: wrongBack.length,
    writeErrs: writeErrs.slice(0, 8), syncErrs: syncErrs.slice(0, 8),
    shrank: shrank.slice(0, 8), wrongBack: wrongBack.slice(0, 8) };
}

/** A rewriter: write below the published size and fsync, so every round stages a copy-up whose
 *  commit publishes the size of the base it copied. */
function v23rew(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const rest = spec.slice(bar + 1);
  const cut = rest.indexOf(",");
  const value = Number(rest.slice(0, cut));
  const rounds = Number(rest.slice(cut + 1)) || 200;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const buf = new Uint8Array(R23.len).fill(value);
  const writeErrs = [];
  const syncErrs = [];
  let wrote = 0;
  let synced = 0;
  for (let i = 0; i < rounds; i += 1) {
    const w = fs.pwrite(fd, buf, 0);
    if (w === R23.len) wrote += 1; else writeErrs.push({ i, errno: -w });
    const s = fs.fsync(fd);
    if (s === 0) synced += 1; else syncErrs.push({ i, errno: -s });
  }
  const c = fs.close(fd);
  return { ok: true, which: "rewriter", value, rounds, wrote, synced, close: c,
    writeErrCount: writeErrs.length, syncErrCount: syncErrs.length,
    writeErrs: writeErrs.slice(0, 8), syncErrs: syncErrs.slice(0, 8) };
}

/**
 * EVERY SLOT THE APPENDER ACKNOWLEDGED, CHECKED BY VALUE. `rounds` is what the appender was asked
 * for; `acked` is how many it was told were durable, and only those are required.
 */
function v23check(env, spec) {
  const fs = env.fs;
  const parts = spec.split("|");
  const path = parts[0];
  const S = Number(parts[1]);
  const acked = Number(parts[2]);
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const size = Number(st.size);
  const got = fs.readAll(fd, size);
  fs.close(fd);
  if (typeof got === "number") return { ok: false, at: "read", errno: -got };
  const bad = [];
  let right = 0;
  for (let i = 0; i < acked; i += 1) {
    const at = S + i * R23.len;
    const want = v23value(i);
    if (at + R23.len > got.length) {
      if (bad.length < 12) bad.push({ i, at, why: "past the end", size: got.length, want });
      continue;
    }
    if (got[at] !== want) {
      if (bad.length < 12) bad.push({ i, at, got: got[at], want });
      continue;
    }
    right += 1;
  }
  return { ok: bad.length === 0, size, read: got.length, acked, right,
    wantEnd: S + acked * R23.len, badCount: bad.length, bad };
}
'''

PAGE_FN = """
async function v23run() {
  const out = {}
  await wipe()
  let k = kernelBoot(BOOT_CFG)
  const path = pathFor(1)
  const ROUNDS = 200
  try {
    const up = await k.expect('up', 20000)
    if (up.fs.mode !== 'rw') return { at: 'mount', mode: up.fs.mode }
    await install(k)
    const made = await once(k, ['mkfiles', '4'])
    if (!made.ok) return { at: 'mkfiles', errors: made.errors }
    out.path = path
    const app = await spawnProcess(k, ['v23app', path + '|' + ROUNDS])
    const r1 = await spawnProcess(k, ['v23rew', path + '|200,' + ROUNDS])
    const r2 = await spawnProcess(k, ['v23rew', path + '|201,' + ROUNDS])
    k.post({ t: 'go', go: { mode: 'park', pid: r1, argv: ['v23rew', path + '|200,' + ROUNDS] } })
    k.post({ t: 'go', go: { mode: 'park', pid: r2, argv: ['v23rew', path + '|201,' + ROUNDS] } })
    k.post({ t: 'go', go: { mode: 'park', pid: app, argv: ['v23app', path + '|' + ROUNDS] } })
    const a = await rowFor(k, app, 300000, 'v23app')
    const b1 = await rowFor(k, r1, 300000, 'v23rew 1')
    const b2 = await rowFor(k, r2, 300000, 'v23rew 2')
    out.appender = { S: a.S, acked: a.acked, rounds: a.rounds, close: a.close,
      acknowledgedEnd: a.acknowledgedEnd, fdSize: a.fdSize,
      writeErrCount: a.writeErrCount, syncErrCount: a.syncErrCount,
      shrankCount: a.shrankCount, wrongBackCount: a.wrongBackCount,
      writeErrs: a.writeErrs, syncErrs: a.syncErrs, shrank: a.shrank, wrongBack: a.wrongBack }
    out.rewriters = [b1, b2].map((x) => ({ value: x.value, wrote: x.wrote, synced: x.synced,
      close: x.close, writeErrCount: x.writeErrCount, syncErrCount: x.syncErrCount,
      writeErrs: x.writeErrs, syncErrs: x.syncErrs }))
    out.live = await onceByPid(k, ['v23check', path + '|' + a.S + '|' + a.acked], 60000)
    k.post({ t: 'fs-state' })
    out.stats = (await k.expect('fs-state', 10000)).fs.stats
    k.post({ t: 'fsck' })
    const ck = await k.expect('fsck', 30000).catch(() => null)
    out.fsck = ck && ck.report
      ? { mountable: ck.report.mountable, problems: (ck.report.problems || []).map((p) => p.what),
          blobs: ck.report.blobs }
      : null
    out.diag = (k.events || []).flatMap((m) => (m.t === 'io-note' && m.why ? [m.why] : []))
    out.ackedBy = a.acked
    out.S = a.S
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
      check: await once(k, ['v23check', path + '|' + out.S + '|' + out.ackedBy], 60000) }
  } catch (e) {
    out.remount = { threw: String((e && e.message) || e) }
  } finally {
    await shut(k)
  }
  const a = out.appender || {}
  const live = out.live || {}
  const after = (out.remount || {}).check || {}
  out.everySyncTrueAtTheTime = a.shrankCount === 0 && a.wrongBackCount === 0
  out.everyAckedSlotLive = live.ok === true && live.badCount === 0
  out.everyAckedSlotAfterRemount = after.ok === true && after.badCount === 0
  out.volumeClean = !!(out.fsck && out.fsck.mountable === 'rw' && out.fsck.problems.length === 0)
    && (out.remount || {}).mode === 'rw'
  out.lostAcknowledgedBytes = out.everyAckedSlotAfterRemount !== true
    || out.everyAckedSlotLive !== true
  out.silent = out.lostAcknowledgedBytes === true && out.volumeClean === true
  return out
}

async function vattack23() {
  return { ok: false, evidence: { revert: await v23run() } }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack23]]) {"""


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
