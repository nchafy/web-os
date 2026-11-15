#!/usr/bin/env python3
"""Round 7 (final audit): three attacks the five previous rounds did not drive.

  shortread   ONE description's `fstat` and its own `read`, after another description publishes an
              append. `extentFd` pairs `stagedEnd(d, live.end)` — the LIVE base — with
              `d.stagingId` — a copy of the OLD base — so the number and the blob behind it come
              from different states. The claim under test: `read` short-counts with no error while
              `fstat` on the same fd reports the larger number.

  metaflood   HEAVY CONCURRENT METADATA TRAFFIC, which is what C1's three journal callers are:
              four processes looping mkdir + chmod + open(O_CREAT) + write + fsync + close, all
              posted at once, plus two data writers committing. The journal is then read straight
              off the disk with no kernel holding it: strictly consecutive, no duplicate, no gap.
              Then remounted, and every acknowledged name must still be there.

  killbusy    A WRITER THAT IS KILLED HOLDING A STAGED GENERATION, while another writer contends.
              Teardown closes the fd, so `closeFd` commits; the commit may be refused, and nobody
              reads the errno of a dead process's close. The claim under test: the acknowledged
              bytes vanish and fsck reports the volume clean.
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk20")

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "v20short": out = v20short(env, String(arg)); break;\n'
        '    case "v20meta": out = v20meta(env, String(arg)); break;\n'
        '    case "v20seen": out = v20seen(env, String(arg)); break;\n'
        '    case "v20ham": out = v20ham(env, String(arg)); break;\n'
        '    case "v20one": out = v20one(env, String(arg)); break;\n'
        '    case "v20byte": out = v20byte(env, String(arg)); break;\n')

FN = '''
/* ---------------- THE VERIFIER'S ATTACKS, ROUND 7: THE FINAL AUDIT ---------------- */

const R20 = { stageByte: 0x51, appByte: 0x52, quietByte: 0x53, hamByte: 0x54, len: 4,
  meta: 40, rounds: 200 };

/**
 * ONE DESCRIPTION'S fstat AGAINST ITS OWN read.
 *
 * fd2 writes BELOW the published size, so it stages a copy of the base. fd1 then appends AT the
 * published size and fsyncs, so the LIVE extent is four bytes past what fd2's staged blob holds.
 * fd2 then asks where its file ends and reads that many bytes through the same fd.
 */
function v20short(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const row = { ok: true };
  const fd1 = fs.open(path, O_RDWR);
  const fd2 = fs.open(path, O_RDWR);
  if (fd1 < 0 || fd2 < 0) return { ok: false, at: "open", fd1, fd2 };
  const st = fs.fstat(fd1);
  if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
  const S = Number(st.size);
  row.S = S;

  row.staged = fs.pwrite(fd2, new Uint8Array(R20.len).fill(R20.stageByte), 0);
  row.appended = fs.pwrite(fd1, new Uint8Array(R20.len).fill(R20.appByte), S);
  row.fsync1 = fs.fsync(fd1);

  // THE TWO ANSWERS ONE DESCRIPTION GIVES, read back to back with nothing between them.
  const st2 = fs.fstat(fd2);
  row.fstatSize = typeof st2 === "number" ? -st2 : Number(st2.size);
  const end = fs.seek(fd2, 0, SEEK_END);
  row.seekEnd = end;
  fs.seek(fd2, 0, SEEK_SET);
  const got = fs.readAll(fd2, row.fstatSize);
  row.readGot = typeof got === "number" ? -got : got.length;
  row.readErr = typeof got === "number" ? -got : 0;
  row.readIsShort = row.readErr === 0 && row.readGot < row.fstatSize;
  row.bytesMissingFromRead = row.fstatSize - row.readGot;
  // The appended byte is the one a reader would be looking for at offset S.
  row.sawAppendedByte = typeof got !== "number" && got.length > S && got[S] === R20.appByte;

  row.close2 = fs.close(fd2);
  row.close1 = fs.close(fd1);

  const fd3 = fs.open(path, O_RDONLY);
  const st3 = fs.fstat(fd3);
  const size3 = typeof st3 === "number" ? -1 : Number(st3.size);
  const g3 = size3 < 0 ? null : fs.readAll(fd3, size3);
  fs.close(fd3);
  row.final = { size: size3, got: g3 ? g3.length : -1,
    at0: g3 && size3 > 0 ? g3[0] : -1, atS: g3 && size3 > S ? g3[S] : -1 };
  row.bothKept = row.final.at0 === R20.stageByte && row.final.atS === R20.appByte;
  return row;
}

/**
 * THE JOURNAL'S THREE CALLERS AT ONCE. `mkdir` and `chmod` are metaOp; `open(O_CREAT)` journals its
 * own create record; `fsync` commits. Everything that returns 0 is an acknowledgement a remount
 * has to honour.
 */
function v20meta(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const tag = spec.slice(0, bar);
  const n = Number(spec.slice(bar + 1)) || R20.meta;
  const errs = [];
  let dirs = 0;
  let files = 0;
  for (let i = 0; i < n; i += 1) {
    const dir = "/d/3/" + tag + "-" + i;
    const m = fs.mkdir(dir, 0o755);
    if (m !== 0) { errs.push({ at: "mkdir", i, errno: -m }); continue; }
    dirs += 1;
    const c = fs.chmod(dir, 0o700);
    if (c !== 0) errs.push({ at: "chmod", i, errno: -c });
    const file = dir + "/f";
    const fd = fs.open(file, O_WRONLY | O_CREAT | O_EXCL, 0o600);
    if (fd < 0) { errs.push({ at: "open", i, errno: -fd }); continue; }
    const w = fs.write(fd, new Uint8Array(R20.len).fill((i + 1) & 0xff));
    if (w !== R20.len) errs.push({ at: "write", i, got: w });
    const s = fs.fsync(fd);
    if (s !== 0) errs.push({ at: "fsync", i, errno: -s });
    const cl = fs.close(fd);
    if (cl !== 0) errs.push({ at: "close", i, errno: -cl });
    files += 1;
  }
  return { ok: errs.length === 0, tag, n, dirs, files,
    errCount: errs.length, errs: errs.slice(0, 8) };
}

/** Every name the loopers acknowledged, looked for again. `want` is computed from the tags. */
function v20seen(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const tags = spec.slice(0, bar).split(",");
  const n = Number(spec.slice(bar + 1));
  const missing = [];
  let dirs = 0;
  let files = 0;
  let modes = 0;
  for (const tag of tags) {
    for (let i = 0; i < n; i += 1) {
      const dir = "/d/3/" + tag + "-" + i;
      const st = fs.stat(dir);
      if (typeof st === "number") {
        if (missing.length < 12) missing.push({ p: dir, errno: -st });
        continue;
      }
      dirs += 1;
      if ((Number(st.mode) & 0o7777) === 0o700) modes += 1;
      const f = dir + "/f";
      const sf = fs.stat(f);
      if (typeof sf === "number") {
        if (missing.length < 12) missing.push({ p: f, errno: -sf });
        continue;
      }
      if (Number(sf.size) !== R20.len) {
        if (missing.length < 12) missing.push({ p: f, size: Number(sf.size) });
        continue;
      }
      files += 1;
    }
  }
  return { ok: missing.length === 0, dirs, files, modes,
    want: tags.length * n, missingCount: missing.length, missing };
}

/** The contender: rewrite byte 0 below the published size and fsync, in a loop. Every round of
 *  this stages a copy-up and swings, which is what makes another description lose its base. */
function v20ham(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const rounds = Number(spec.slice(bar + 1)) || R20.rounds;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const buf = new Uint8Array(R20.len).fill(R20.hamByte);
  const errnos = [];
  let wrote = 0;
  let synced = 0;
  for (let i = 0; i < rounds; i += 1) {
    const w = fs.pwrite(fd, buf, 0);
    if (w === R20.len) wrote += 1; else errnos.push(-w);
    const s = fs.fsync(fd);
    if (s === 0) synced += 1; else errnos.push(-s);
  }
  const c = fs.close(fd);
  return { ok: true, which: "ham", rounds, wrote, synced, close: c,
    errnos: errnos.slice(0, 12), errCount: errnos.length };
}

/**
 * The victim, in ONE step so its result row cannot be confused with an earlier one: open, write
 * below the published size — which stages a copy-up and records a base — and then nothing. The fd
 * stays open, so the staged generation is live and uncommitted when the process is killed.
 */
function v20one(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  keptFd = fd;
  // AT OFFSET 4, DISJOINT FROM THE CONTENDER'S RANGE AND STILL BELOW THE PUBLISHED SIZE. Both
  // writers overwriting offset 0 would make a lost byte indistinguishable from last-writer-wins,
  // which is a legal outcome; two disjoint acknowledged ranges must BOTH be in the file.
  const w = fs.pwrite(fd, new Uint8Array(R20.len).fill(R20.quietByte), R20.len);
  const st = fs.fstat(fd);
  return { ok: w === R20.len, wrote: w, at: R20.len, value: R20.quietByte, fd,
    fdSize: typeof st === "number" ? -st : Number(st.size) };
}

/** What byte 0 is now, through a fresh description. */
function v20byte(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const size = Number(st.size);
  const got = fs.readAll(fd, size);
  fs.close(fd);
  if (typeof got === "number") return { ok: false, at: "read", errno: -got };
  return { ok: true, size, read: got.length,
    at0: size > 0 ? got[0] : -1,
    at4: size > R20.len ? got[R20.len] : -1,
    isQuiet: size > R20.len && got[R20.len] === R20.quietByte,
    isHam: size > 0 && got[0] === R20.hamByte };
}
'''

PAGE_FN = """
/** ROUND 7 (a): the short read. One kernel, one process, two descriptions. */
async function v20short() {
  const out = {}
  await wipe()
  const k = kernelBoot(BOOT_CFG)
  const path = pathFor(1)
  try {
    const up = await k.expect('up', 20000)
    if (up.fs.mode !== 'rw') return { at: 'mount', mode: up.fs.mode }
    await install(k)
    const made = await once(k, ['mkfiles', '4'])
    if (!made.ok) return { at: 'mkfiles', errors: made.errors }
    out.path = path
    out.attack = await once(k, ['v20short', path + '|x'], 60000)
    k.post({ t: 'fs-state' })
    out.stats = (await k.expect('fs-state', 10000)).fs.stats
    k.post({ t: 'fsck' })
    const ck = await k.expect('fsck', 30000).catch(() => null)
    out.fsck = ck && ck.report
      ? { mountable: ck.report.mountable, problems: (ck.report.problems || []).map((p) => p.what),
          blobs: ck.report.blobs }
      : null
    out.notes = (k.events || []).flatMap((m) => (m.t === 'io-note' && m.why ? [m.why] : []))
  } catch (e) {
    out.threw = String((e && e.message) || e)
  } finally {
    await shut(k)
  }
  const a = out.attack || {}
  // THE FINDING, as a boolean: one fd reported a larger size than its own read could produce, and
  // the bytes it could not produce were another description's acknowledged, fsynced bytes.
  out.readShortOfItsOwnFstat = a.readIsShort === true && a.readErr === 0
  out.fstatAndSeekAgree = a.fstatSize === a.seekEnd
  out.volumeClean = !!(out.fsck && out.fsck.mountable === 'rw' && out.fsck.problems.length === 0)
  out.bothKept = a.bothKept === true
  return out
}

/** ROUND 7 (b): heavy concurrent metadata traffic, the journal read off the disk, then a remount. */
async function v20meta() {
  const out = {}
  const TAGS = ['ma', 'mb', 'mc', 'md']
  const N = 40
  await wipe()
  let k = kernelBoot(BOOT_CFG)
  const path = pathFor(1)
  try {
    const up = await k.expect('up', 20000)
    if (up.fs.mode !== 'rw') return { at: 'mount', mode: up.fs.mode }
    await install(k)
    const made = await once(k, ['mkfiles', '4'])
    if (!made.ok) return { at: 'mkfiles', errors: made.errors }
    const pids = []
    for (const tag of TAGS) pids.push(await spawnProcess(k, ['v20meta', tag + '|' + N]))
    const w1 = await spawnProcess(k, ['v20ham', path + '|60'])
    const w2 = await spawnProcess(k, ['v20ham', path + '|60'])
    // ALL SIX AT ONCE, with no await between the posts, so their syscalls interleave at the
    // kernel's own await points — which is where the sequence number is allocated.
    for (let i = 0; i < TAGS.length; i += 1) {
      k.post({ t: 'go', go: { mode: 'park', pid: pids[i], argv: ['v20meta', TAGS[i] + '|' + N] } })
    }
    k.post({ t: 'go', go: { mode: 'park', pid: w1, argv: ['v20ham', path + '|60'] } })
    k.post({ t: 'go', go: { mode: 'park', pid: w2, argv: ['v20ham', path + '|60'] } })
    out.loopers = []
    for (let i = 0; i < TAGS.length; i += 1) {
      const r = await rowFor(k, pids[i], 300000, 'v20meta ' + TAGS[i])
      out.loopers.push({ tag: r.tag, ok: r.ok, dirs: r.dirs, files: r.files,
        errCount: r.errCount, errs: r.errs })
    }
    const a = await rowFor(k, w1, 300000, 'v20ham 1')
    const b = await rowFor(k, w2, 300000, 'v20ham 2')
    out.writers = [{ wrote: a.wrote, synced: a.synced, close: a.close, errnos: a.errnos },
      { wrote: b.wrote, synced: b.synced, close: b.close, errnos: b.errnos }]
    out.seenLive = await onceByPid(k, ['v20seen', TAGS.join(',') + '|' + N], 60000)
    k.post({ t: 'fs-state' })
    out.stats = (await k.expect('fs-state', 10000)).fs.stats
    k.post({ t: 'fsck' })
    const ck = await k.expect('fsck', 30000).catch(() => null)
    out.fsck = ck && ck.report
      ? { mountable: ck.report.mountable, journal: ck.report.journal,
          problems: (ck.report.problems || []).map((p) => p.what + ': ' + String(p.why || '')),
          blobs: ck.report.blobs }
      : null
    out.notes = (k.events || []).flatMap((m) => (m.t === 'io-note' && m.why ? [m.why] : []))
  } catch (e) {
    out.threw = String((e && e.message) || e)
  } finally {
    await shut(k)
  }
  // THE JOURNAL, READ WITH NO KERNEL HOLDING IT.
  out.journalSeqs = await journalSeqs()
  k = kernelBoot(BOOT_CFG)
  try {
    const up = await k.expect('up', 20000)
    out.remount = { mode: up.fs.mode,
      journal: up.fs.report && up.fs.report.journal,
      problems: (up.fs.report && up.fs.report.problems ? up.fs.report.problems : [])
        .map((p) => p.what + ': ' + String(p.why || '')),
      seen: await once(k, ['v20seen', TAGS.join(',') + '|' + N], 60000) }
  } catch (e) {
    out.remount = { threw: String((e && e.message) || e) }
  } finally {
    await shut(k)
  }
  const js = out.journalSeqs || {}
  out.seqsAreStrictlyConsecutive = js.consecutive === true && js.duplicates === 0
  out.enoughRecordsToMatter = (js.records || 0) > 300
  const loop = out.loopers || []
  out.everyMetaOpSucceeded = loop.length === TAGS.length && loop.every((l) => l.errCount === 0)
  const rj = (out.remount || {}).journal || {}
  out.replayAcceptedEveryRecord = (out.remount || {}).mode === 'rw'
    && rj.stopped === null && rj.discardedBytes === 0
  const seen = (out.remount || {}).seen || {}
  out.everyAcknowledgedNameSurvived = seen.ok === true && seen.dirs === TAGS.length * N
    && seen.files === TAGS.length * N && seen.modes === TAGS.length * N
  out.volumeClean = !!(out.fsck && out.fsck.mountable === 'rw' && out.fsck.problems.length === 0)
  out.ok = out.seqsAreStrictlyConsecutive === true && out.enoughRecordsToMatter === true
    && out.everyMetaOpSucceeded === true && out.replayAcceptedEveryRecord === true
    && out.everyAcknowledgedNameSurvived === true && out.volumeClean === true
  return out
}

/** ROUND 7 (c): a writer killed holding a staged generation, against a contender. */
async function v20kill() {
  const out = { rounds: [] }
  const ROUNDS = 10
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
      const victim = await spawnProcess(k, ['v20one', path])
      const ham = await spawnProcess(k, ['v20ham', path + '|200'])
      // The contender starts first and is NOT awaited, so the victim's stage and its kill land
      // INSIDE the contender's loop — which is the only way the victim's teardown commit can lose
      // a race. Every row here is collected by pid, because both are running.
      k.post({ t: 'go', go: { mode: 'park', pid: ham, argv: ['v20ham', path + '|200'] } })
      k.post({ t: 'go', go: { mode: 'park', pid: victim, argv: ['v20one', path] } })
      const stage = await rowFor(k, victim, 60000, 'v20one')
      // KILLED, holding the staged generation. Teardown closes the fd and commits; nothing reads
      // the errno of a dead process's close.
      k.post({ t: 'end-process', pid: victim })
      const hamRow = await rowFor(k, ham, 300000, 'v20ham')
      const after = await onceByPid(k, ['v20byte', path], 60000)
      out.rounds.push({ r, stagedOk: stage.ok === true, wrote: stage.wrote,
        at0: after.at0, at4: after.at4, quietSurvived: after.isQuiet === true, size: after.size,
        hamWrote: hamRow.wrote, hamSynced: hamRow.synced, hamClose: hamRow.close,
        hamErrnos: hamRow.errnos })
    }
    k.post({ t: 'fs-state' })
    out.stats = (await k.expect('fs-state', 10000)).fs.stats
    k.post({ t: 'fsck' })
    const ck = await k.expect('fsck', 30000).catch(() => null)
    out.fsck = ck && ck.report
      ? { mountable: ck.report.mountable, problems: (ck.report.problems || []).map((p) => p.what),
          blobs: ck.report.blobs }
      : null
    out.notes = (k.events || []).flatMap((m) => (m.t === 'io-note' && m.why ? [m.why] : []))
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
      byte: await once(k, ['v20byte', path], 30000) }
  } catch (e) {
    out.remount = { threw: String((e && e.message) || e) }
  } finally {
    await shut(k)
  }
  const rows = out.rounds || []
  out.acknowledgedWrites = rows.filter((x) => x.wrote === 4).length
  // THE LOSS. The victim's range is disjoint from the contender's, so nothing may legitimately
  // overwrite it: an acknowledged write whose byte is not at offset 4 afterwards is gone.
  out.writesThatVanished = rows.filter((x) => x.wrote === 4 && x.quietSurvived !== true).length
  out.vanishedRounds = rows.filter((x) => x.wrote === 4 && x.quietSurvived !== true)
    .map((x) => ({ r: x.r, at4: x.at4, at0: x.at0, size: x.size }))
  out.contenderBytesKept = rows.filter((x) => x.at0 === 0x54).length
  out.closeRefusals = rows.flatMap((x) => x.hamErrnos || [])
  out.volumeClean = !!(out.fsck && out.fsck.mountable === 'rw' && out.fsck.problems.length === 0)
    && (out.remount || {}).mode === 'rw'
  out.teardownNotes = (out.notes || []).filter((w) => /could not publish/.test(w))
  return out
}

async function vattack20() {
  const out = {}
  out.shortread = await v20short()
  out.metaflood = await v20meta()
  out.killbusy = await v20kill()
  return { ok: false, evidence: out }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack20]]) {"""


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
