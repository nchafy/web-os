#!/usr/bin/env python3
"""Round 7 attack 27: try to WEDGE the per-inode mutex.

A lock is new machinery and a wedge is its failure mode. Five shapes, all against ONE inode so
every operation contends for the same tail:

  1. four programs hammering one inode at once — below-write + fsync, append + fsync, ftruncate
     + fsync, and fstat/seek-END/read — so every taker of `withInode` is in flight together.
  2. a fifth program churning `link`/`rename`/`unlink` on a SECOND name for the same inode, which
     is the metadata path that takes no inode lock at all.
  3. the page posting `snapshot` and `fsck` while all of that runs.
  4. `end-process` on a hammering process, so teardown's fd closure queues behind an operation
     that may be holding the lock (kernel.mjs `teardown` cannot await, by constraint 14).
  5. THE DETECTOR: after all of it, a FRESH process opens the same path and writes. If the inode's
     tail was never released, that open parks forever and the row never arrives — which is what
     distinguishes a wedged lock from a busy one.

Nothing here patches the kernel. Every step is a syscall or a page control message.
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk27")

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "v27below": out = v27below(env, String(arg)); break;\n'
        '    case "v27append": out = v27append(env, String(arg)); break;\n'
        '    case "v27trunc": out = v27trunc(env, String(arg)); break;\n'
        '    case "v27stat": out = v27stat(env, String(arg)); break;\n'
        '    case "v27names": out = v27names(env, String(arg)); break;\n'
        '    case "v27after": out = v27after(env, String(arg)); break;\n')

FN = '''
/* ---------------- ATTACK 27: CONTENTION ON ONE INODE, AND A TEARDOWN INSIDE IT ---------------- */

function v27spec(spec) {
  const bar = spec.indexOf("|");
  return { path: spec.slice(0, bar), n: Number(spec.slice(bar + 1)) || 1 };
}

/** A write BELOW the committed size: a copy-up and a swing per fsync. */
function v27below(env, spec) {
  const fs = env.fs;
  const { path, n } = v27spec(spec);
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const buf = new Uint8Array(4).fill(0xb0);
  const errs = [];
  let done = 0;
  for (let i = 0; i < n; i += 1) {
    const w = fs.pwrite(fd, buf, 0);
    if (w < 0) { errs.push(-w); continue; }
    const s = fs.fsync(fd);
    if (s < 0) errs.push(-s);
    done += 1;
  }
  const c = fs.close(fd);
  return { ok: true, which: "below", done, close: c, errnos: errs.slice(0, 12),
    errnoCount: errs.length };
}

/** An append at the end, then fsync. */
function v27append(env, spec) {
  const fs = env.fs;
  const { path, n } = v27spec(spec);
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const buf = new Uint8Array(4).fill(0xa5);
  const errs = [];
  let acked = 0;
  for (let i = 0; i < n; i += 1) {
    const end = fs.seek(fd, 0, SEEK_END);
    if (end < 0) { errs.push(-end); continue; }
    const w = fs.pwrite(fd, buf, Number(end));
    if (w < 0) { errs.push(-w); continue; }
    acked += w;
    const s = fs.fsync(fd);
    if (s < 0) errs.push(-s);
  }
  const c = fs.close(fd);
  return { ok: true, which: "append", acked, close: c, errnos: errs.slice(0, 12),
    errnoCount: errs.length };
}

/** ftruncate between two lengths, each followed by fsync. */
function v27trunc(env, spec) {
  const fs = env.fs;
  const { path, n } = v27spec(spec);
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const errs = [];
  let done = 0;
  for (let i = 0; i < n; i += 1) {
    const t = fs.ftruncate(fd, 8 + (i % 3) * 4);
    if (t < 0) { errs.push(-t); continue; }
    const s = fs.fsync(fd);
    if (s < 0) errs.push(-s);
    done += 1;
  }
  const c = fs.close(fd);
  return { ok: true, which: "trunc", done, close: c, errnos: errs.slice(0, 12),
    errnoCount: errs.length };
}

/** The reader: fstat, SEEK_END and a read, which is the pair `extentFd` must answer from one
 *  state. A size and a read that disagree is the defect; a call that never returns is the wedge. */
function v27stat(env, spec) {
  const fs = env.fs;
  const { path, n } = v27spec(spec);
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const errs = [];
  let disagree = 0;
  let short = 0;
  let rounds = 0;
  for (let i = 0; i < n; i += 1) {
    const st = fs.fstat(fd);
    if (typeof st === "number") { errs.push(-st); continue; }
    const size = Number(st.size);
    const end = fs.seek(fd, 0, SEEK_END);
    if (end < 0) { errs.push(-end); continue; }
    if (Number(end) !== size) disagree += 1;
    // `pread(fd, into, offset)` takes a BUFFER. Passed a length, `into.length` is undefined, the
    // syscall carries NaN and comes back 0 — the clause silently does not run, which is the
    // harness-honesty failure this project names. Measured: 300 of 300 rounds "failed" with
    // errno 0 and the read clause never executed.
    const into = new Uint8Array(size);
    const n = size === 0 ? 0 : fs.pread(fd, into, 0);
    if (n < 0) { errs.push(-n); continue; }
    if (n < size) short += 1;
    rounds += 1;
  }
  const c = fs.close(fd);
  return { ok: true, which: "stat", rounds, disagree, short, close: c,
    errnos: errs.slice(0, 12), errnoCount: errs.length };
}

/** The metadata churn: a second name for the same inode, renamed and removed. metaOp takes no
 *  inode lock, which is the boundary the lock's own comment states. */
function v27names(env, spec) {
  const fs = env.fs;
  const { path, n } = v27spec(spec);
  const errs = [];
  let done = 0;
  for (let i = 0; i < n; i += 1) {
    const l = fs.link(path, path + ".ln");
    if (l < 0) { errs.push(-l); continue; }
    const r = fs.rename(path + ".ln", path + ".ln2");
    if (r < 0) errs.push(-r);
    const u = fs.unlink(r < 0 ? path + ".ln" : path + ".ln2");
    if (u < 0) errs.push(-u);
    done += 1;
  }
  return { ok: true, which: "names", done, errnos: errs.slice(0, 12), errnoCount: errs.length };
}

/** THE DETECTOR. One open, one fstat, one write, one fsync, one close on the contended inode,
 *  AFTER everything else is finished. A wedged tail shows up as a process with no result row. */
function v27after(env, spec) {
  const fs = env.fs;
  const { path } = v27spec(spec);
  const t0 = performance.now();
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd, ms: performance.now() - t0 };
  const st = fs.fstat(fd);
  const size = typeof st === "number" ? -1 : Number(st.size);
  const w = fs.pwrite(fd, new Uint8Array(4).fill(0x27), size < 0 ? 0 : size);
  const s = fs.fsync(fd);
  const c = fs.close(fd);
  return { ok: w === 4 && s === 0 && c === 0, size, write: w, fsync: s, close: c,
    ms: performance.now() - t0 };
}
'''

PAGE_FN = """
const V27 = { rounds: 150, statRounds: 300, nameRounds: 60 }

/**
 * ATTACK 27. Everything at once on one inode, a kill inside it, and then one ordinary operation
 * on the same inode to see whether the lock is still there.
 */
async function vattack27() {
  const out = { rounds: V27 }
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
    const spec = (n) => path + '|' + n
    const jobs = [
      ['v27below', spec(V27.rounds)],
      ['v27append', spec(V27.rounds)],
      ['v27trunc', spec(V27.rounds)],
      ['v27stat', spec(V27.statRounds)],
      ['v27names', spec(V27.nameRounds)],
    ]
    const pids = []
    for (const argv of jobs) pids.push(await spawnProcess(k, argv))
    // ALL FIVE IN ONE DISPATCH TURN.
    for (let i = 0; i < jobs.length; i += 1) {
      k.post({ t: 'go', go: { mode: 'park', pid: pids[i], argv: jobs[i] } })
    }
    // The page's own interference, posted while they run: two snapshots and an fsck.
    await new Promise((r) => setTimeout(r, 40))
    k.post({ t: 'snapshot' })
    k.post({ t: 'fsck' })
    await new Promise((r) => setTimeout(r, 60))
    // TEARDOWN INSIDE THE LOCK. The below-writer is killed mid-operation: its in-flight call is
    // answered with an errno and its fd closure is queued, neither of which can await.
    k.post({ t: 'end-process', pid: pids[0] })
    out.killed = pids[0]
    const rows = {}
    const until = performance.now() + 120000
    while (performance.now() < until) {
      for (const m of k.events) {
        if (m.t !== 'results' || !m.results) continue
        for (const r of m.results) if (pids.includes(r.pid)) rows[r.pid] = r
      }
      // EVERY PID BUT THE KILLED ONE. Counting rows alone was wrong: the killed process does
      // report (terminate() is asynchronous and it ran on), so the count reached four with a
      // survivor still running and the detector below read as a wedge.
      if (pids.slice(1).every((pid) => rows[pid])) break
      await new Promise((r) => setTimeout(r, 10))
    }
    out.ranFor = Math.round(performance.now() - (until - 120000))
    out.rows = {}
    for (let i = 0; i < jobs.length; i += 1) {
      const r = rows[pids[i]]
      out.rows[jobs[i][0]] = r
        ? { ok: r.ok, which: r.which, done: r.done, acked: r.acked, rounds: r.rounds,
            disagree: r.disagree, short: r.short, close: r.close, errnoCount: r.errnoCount,
            errnos: r.errnos, calls: r.calls, replies: r.replies }
        : { MISSING: true, pid: pids[i], killed: pids[i] === pids[0] }
    }
    out.missing = Object.entries(out.rows)
      .filter(([, v]) => v && v.MISSING && !v.killed).map(([kk]) => kk)
    out.snapshot = await k.expect('snapshot', 60000).then(
      (m) => ({ ok: m.ok, r: m.r, generation: m.generation }),
      (e) => ({ threw: String(e && e.message) }))
    out.fsckDuring = await k.expect('fsck', 60000).then(
      (m) => (m.report ? { mountable: m.report.mountable,
        problems: (m.report.problems || []).map((p) => p.what) } : { no: true }),
      (e) => ({ threw: String(e && e.message) }))
    // THE DETECTOR, with its own clock: one ordinary operation on the contended inode.
    const afterPid = await spawnProcess(k, ['v27after', spec(1)])
    k.post({ t: 'go', go: { mode: 'park', pid: afterPid, argv: ['v27after', spec(1)] } })
    out.after = await rowFor(k, afterPid, 30000, 'v27after')
      .then((r) => ({ ok: r.ok, size: r.size, write: r.write, fsync: r.fsync, close: r.close,
        ms: Math.round(r.ms), calls: r.calls, replies: r.replies }))
      .catch((e) => ({ WEDGED: String(e && e.message) }))
    k.post({ t: 'fs-state' })
    out.stats = await k.expect('fs-state', 20000).then((m) => m.fs.stats, () => null)
    out.notes = (k.events || []).flatMap((m) => (m.t === 'io-note' && m.why ? [m.why] : []))
      .slice(0, 10)
    out.faults = (globalThis.M2.faults || []).map((f) => f.pid + ': ' + f.why).slice(0, 10)
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
        .map((p) => p.what + ': ' + String(p.why || '').slice(0, 100)) }
    k2.post({ t: 'fsck' })
    const ck = await k2.expect('fsck', 120000).catch(() => null)
    out.fsck = ck && ck.report
      ? { mountable: ck.report.mountable,
          problems: (ck.report.problems || []).map((p) => p.what + ': '
            + String(p.why || '').slice(0, 100)),
          blobs: ck.report.blobs }
      : null
  } catch (e) {
    out.remountThrew = String((e && e.message) || e)
  } finally {
    await shut(k2)
  }
  out.wedged = !!(out.missing && out.missing.length) || !!(out.after && out.after.WEDGED)
  return { ok: false, evidence: out }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack27]]) {"""


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
