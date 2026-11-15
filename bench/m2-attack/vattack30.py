#!/usr/bin/env python3
"""Round 9 (final review): O_APPEND under REAL concurrency, which the registered check does not do.

The registered `append` proof is one process, four calls, serial. It cannot see whether the
seek-to-end is atomic WITH the write — only that the two writes were ordered by the program. These
four scenarios put the appends in different processes, so the only thing that can order them is the
kernel:

  A  two appenders, 40 appends each, one file
  B  three appenders, 40 appends each
  C  one appender racing a plain writer whose pwrite offsets START at the same end-of-file
  D  one appender racing a plain writer BELOW the committed size, which forces a copy-up and puts
     the append against the compare-and-swap rather than against the shared generation

Every byte each writer was told it wrote must be in the file, live and after a remount, except
where the plain writer's own offsets overwrote it (C, which is POSIX: pwrite writes where it says).

    python3 vattack30.py && cd mut/vatk30 && .venv/bin/python bench/fs-core/probe.py --files 20
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk30")

CASE = ('    case "append": out = appendpair(env, String(arg)); break;\n',
        '    case "append": out = appendpair(env, String(arg)); break;\n'
        '    case "v30base": out = v30base(env, String(arg)); break;\n'
        '    case "v30app": out = v30app(env, String(arg)); break;\n'
        '    case "v30plain": out = v30plain(env, String(arg)); break;\n'
        '    case "v30read": out = v30read(env, String(arg)); break;\n')

FN = '''
/* ---------------- ROUND 9: O_APPEND UNDER REAL CONCURRENCY ---------------- */

const R30 = { len: 4 };

function v30split(spec) {
  const bar = spec.indexOf("|");
  return { path: spec.slice(0, bar), rest: spec.slice(bar + 1).split(",") };
}

/** The base file: written and FSYNCED, so the inode is on generation 1 and an append is an append
 *  into the committed generation rather than the gen-0 copy-up path. */
function v30base(env, spec) {
  const { path, rest } = v30split(spec);
  const len = Number(rest[0]);
  const byte = Number(rest[1]);
  const fs = env.fs;
  const fd = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const w = len > 0 ? fs.write(fd, new Uint8Array(len).fill(byte)) : 0;
  const s = fs.fsync(fd);
  const c = fs.close(fd);
  return { ok: w === len && s === 0 && c === 0, w, s, c, len, byte };
}

/** One O_APPEND description, `rounds` writes of R30.len bytes, fsync after each. */
function v30app(env, spec) {
  const { path, rest } = v30split(spec);
  const byte = Number(rest[0]);
  const rounds = Number(rest[1]) || 40;
  const fs = env.fs;
  const fd = fs.open(path, O_WRONLY | O_APPEND);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const buf = new Uint8Array(R30.len).fill(byte);
  const wErrs = [];
  const sErrs = [];
  const shorts = [];
  let acked = 0;
  for (let i = 0; i < rounds; i += 1) {
    const n = fs.write(fd, buf);
    if (n === R30.len) acked += 1;
    else if (n < 0) wErrs.push({ i, errno: -n });
    else shorts.push({ i, n });
    const s = fs.fsync(fd);
    if (s !== 0) sErrs.push({ i, errno: -s });
  }
  const c = fs.close(fd);
  return {
    ok: wErrs.length === 0 && sErrs.length === 0 && shorts.length === 0 && c === 0,
    kind: "append", byte, rounds, acked, ackedBytes: acked * R30.len, close: c,
    wErrCount: wErrs.length, sErrCount: sErrs.length, shortCount: shorts.length,
    wErrs: wErrs.slice(0, 5), sErrs: sErrs.slice(0, 5), shorts: shorts.slice(0, 5),
  };
}

/** A PLAIN writer, no O_APPEND. `tail`: pwrite at the end it saw at open and upward, which is the
 *  same offset the appender's first write takes. `low`: pwrite at 0 every round, which is below
 *  the committed size and is the copy-up arm. */
function v30plain(env, spec) {
  const { path, rest } = v30split(spec);
  const byte = Number(rest[0]);
  const rounds = Number(rest[1]) || 40;
  const kind = String(rest[2] || "tail");
  const fs = env.fs;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const base = Number(st.size);
  const buf = new Uint8Array(R30.len).fill(byte);
  const wErrs = [];
  const sErrs = [];
  const shorts = [];
  const offs = [];
  let acked = 0;
  for (let i = 0; i < rounds; i += 1) {
    const at = kind === "low" ? 0 : base + i * R30.len;
    const n = fs.pwrite(fd, buf, at);
    if (n === R30.len) { acked += 1; offs.push(at); }
    else if (n < 0) wErrs.push({ i, at, errno: -n });
    else shorts.push({ i, at, n });
    const s = fs.fsync(fd);
    if (s !== 0) sErrs.push({ i, errno: -s });
  }
  const c = fs.close(fd);
  return {
    ok: wErrs.length === 0 && sErrs.length === 0 && shorts.length === 0 && c === 0,
    kind: "plain-" + kind, byte, rounds, acked, ackedBytes: acked * R30.len, base, close: c,
    lastOff: offs.length ? offs[offs.length - 1] : -1,
    wErrCount: wErrs.length, sErrCount: sErrs.length, shortCount: shorts.length,
    wErrs: wErrs.slice(0, 5), sErrs: sErrs.slice(0, 5), shorts: shorts.slice(0, 5),
  };
}

/** The census: the file's length and one count per byte value, through a FRESH description. */
function v30read(env, spec) {
  const fs = env.fs;
  const path = String(spec);
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const size = Number(st.size);
  const got = size > 0 ? fs.readAll(fd, size) : new Uint8Array(0);
  fs.close(fd);
  if (typeof got === "number") return { ok: false, at: "read", errno: -got, size };
  const counts = new Map();
  for (const b of got) counts.set(b, (counts.get(b) || 0) + 1);
  return {
    ok: true, size, read: got.length,
    pairs: [...counts.entries()].sort((x, y) => x[0] - y[0]),
    head: [...got.slice(0, 16)], tail: [...got.slice(Math.max(0, got.length - 16))],
  };
}
'''

PAGE_FN = """
const V30_BASE_BYTE = 0x51
const V30_PATH = '/d/0/v30'
const V30_LEN = 4

function v30count(census, byte) {
  if (!census || !census.pairs) return -1
  for (const [b, n] of census.pairs) if (b === byte) return n
  return 0
}

/**
 * One scenario. Every writer is its own PROCESS, started before any of them runs, so the kernel
 * is the only thing that can order their writes.
 */
async function v30one(label, spec) {
  const out = { label, rounds: spec.rounds, base: spec.base, appenders: spec.appenders }
  await wipe()
  let k = kernelBoot(BOOT_CFG)
  try {
    const up = await k.expect('up', 20000)
    if (up.fs.mode !== 'rw') return { ...out, at: 'mount', mode: up.fs.mode }
    await install(k)
    const made = await onceByPid(k, ['v30base', V30_PATH + '|' + spec.base + ',' + V30_BASE_BYTE],
      60000)
    if (!made.ok) return { ...out, at: 'base', made }
    const argvs = spec.appenders.map((b) =>
      ['v30app', V30_PATH + '|' + b + ',' + spec.rounds])
    if (spec.plain) {
      argvs.push(['v30plain',
        V30_PATH + '|' + spec.plain.byte + ',' + spec.rounds + ',' + spec.plain.kind])
    }
    const pids = []
    for (const a of argvs) pids.push(await spawnProcess(k, a))
    for (let i = 0; i < pids.length; i += 1) {
      k.post({ t: 'go', go: { mode: 'park', pid: pids[i], argv: argvs[i] } })
    }
    out.workers = []
    for (let i = 0; i < pids.length; i += 1) {
      out.workers.push(await rowFor(k, pids[i], 300000, argvs[i].join(' ')))
    }
    out.live = await onceByPid(k, ['v30read', V30_PATH], 60000)
    k.post({ t: 'fs-state' })
    out.stats = (await k.expect('fs-state', 10000)).fs.stats
    k.post({ t: 'fsck' })
    const ck = await k.expect('fsck', 30000).catch(() => null)
    out.fsck = ck && ck.report
      ? { mountable: ck.report.mountable,
          problems: (ck.report.problems || []).map((p) => p.what) }
      : null
    out.notes = (k.events || []).flatMap((m) => (m.t === 'io-note' && m.why ? [m.why] : []))
  } catch (e) {
    out.threw = String((e && e.message) || e)
  } finally {
    await shut(k)
  }

  k = kernelBoot(BOOT_CFG)
  try {
    const up = await k.expect('up', 20000)
    out.remount = { mode: up.fs.mode,
      problems: ((up.fs.report || {}).problems || []).map((p) => p.what) }
    out.after = await onceByPid(k, ['v30read', V30_PATH], 60000)
  } catch (e) {
    out.remount = { threw: String((e && e.message) || e) }
  } finally {
    await shut(k)
  }

  /* THE CLAUSES. `survived` is per appender byte and is counted out of the file a FRESH
   * description read, not out of the writer's own fstat. */
  const workers = out.workers || []
  out.everyCallAcknowledged = workers.length === argvsLen(spec)
    && workers.every((w) => w && w.ok === true)
  const appAcked = workers.filter((w) => w && w.kind === 'append')
    .reduce((n, w) => n + w.ackedBytes, 0)
  out.appendedBytesAcknowledged = appAcked
  out.sizeLive = out.live && out.live.size
  out.sizeAfter = out.after && out.after.size
  /* EVERY O_APPEND WRITE EXTENDED THE FILE. Read once at open, `rounds` appends land on each
   * other and the file is `base + len` long instead of `base + rounds*len`. */
  out.wantAtLeast = spec.base + appAcked
  out.fileGrewByEveryAppend = Number(out.sizeLive) >= out.wantAtLeast
    && Number(out.sizeAfter) >= out.wantAtLeast
  out.perAppender = spec.appenders.map((b) => {
    const w = workers.find((x) => x && x.kind === 'append' && x.byte === b)
    return { byte: b, ackedBytes: w ? w.ackedBytes : -1,
      live: v30count(out.live, b), after: v30count(out.after, b) }
  })
  /* The plain writer at `tail` overwrites appended bytes AT THE OFFSETS IT NAMED, which is POSIX,
   * so an exact survival count is only the oracle when nothing else wrote into the appended
   * range. `low` writes below the base and cannot touch it. */
  const exact = !spec.plain || spec.plain.kind === 'low'
  out.exactOracle = exact
  out.everyAppendedByteSurvived = exact
    ? out.perAppender.every((r) => r.ackedBytes >= 0 && r.live === r.ackedBytes
        && r.after === r.ackedBytes)
    : out.perAppender.every((r) => r.live >= r.ackedBytes - spec.rounds * V30_LEN
        && r.after === r.live)
  out.volumeClean = !!(out.fsck && out.fsck.mountable === 'rw'
    && out.fsck.problems.length === 0) && (out.remount || {}).mode === 'rw'
  /* The decisive one: data the kernel acknowledged is gone AND nothing reports it. */
  out.silentLoss = out.everyCallAcknowledged
    && !(out.fileGrewByEveryAppend && out.everyAppendedByteSurvived) && out.volumeClean
  out.ok = out.everyCallAcknowledged && out.fileGrewByEveryAppend
    && out.everyAppendedByteSurvived && out.volumeClean
  return out
}

function argvsLen(spec) {
  return spec.appenders.length + (spec.plain ? 1 : 0)
}

async function vattack30() {
  const a = await v30one('A: two appenders', { base: 8, rounds: 40, appenders: [0xa0, 0xb0] })
  const b = await v30one('B: three appenders',
    { base: 8, rounds: 40, appenders: [0xa1, 0xb1, 0xc1] })
  const c = await v30one('C: appender vs plain writer at the same offset',
    { base: 8, rounds: 40, appenders: [0xa2], plain: { byte: 0xd2, kind: 'tail' } })
  const d = await v30one('D: appender vs plain writer below the committed size',
    { base: 64, rounds: 40, appenders: [0xa3], plain: { byte: 0xd3, kind: 'low' } })
  const all = [a, b, c, d]
  return {
    ok: all.every((x) => x.ok === true),
    evidence: {
      verdict: all.map((x) => ({ label: x.label, ok: x.ok, silentLoss: x.silentLoss })),
      a, b, c, d,
    },
  }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack30]]) {"""


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
