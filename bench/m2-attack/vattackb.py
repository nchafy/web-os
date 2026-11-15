#!/usr/bin/env python3
"""The verifier's OWN attacks on M2's copy-on-write, patched into a scratch tree.

Three scenarios, all through real syscalls from inside a real process:

  b1     the triage's blocker, re-run from scratch. fd1 appends past the committed size and
         fsyncs; fd2 then writes BELOW the new committed size. A correct COW stages a new
         generation, so a THIRD fresh description reading the committed generation must still see
         fd1's bytes before fd2 commits.

  pend   the same shape with fd2 made DIRTY FIRST by an append that stages nothing. `writeFd`
         re-reads the inode's committed size only when `!Store.dirty(d)`, and `appendPending`
         makes a description dirty without a staged generation — so fd2's next write is decided
         against its stale open-time snapshot and lands in the COMMITTED generation in place.

  shrink the metadata half of the same root. fd2's commit publishes `d.stagedSize` computed from
         the stale base, and vfs applyOp's COMMIT arm permits op.gen === inode.gen, so the
         published size can move BACKWARDS over another description's fsynced bytes.
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/vatk1b")

CASE = ('    case "apicheck": out = apicheck(env); break;\n',
        '    case "apicheck": out = apicheck(env); break;\n'
        '    case "vatk": out = vatk(env, String(arg)); break;\n')

FN = '''
/* ---------------- THE VERIFIER'S ATTACKS ---------------- */

function rd(fs, path) {
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { err: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { err: -st }; }
  const size = Number(st.size);
  const got = fs.readAll(fd, size);
  fs.close(fd);
  if (typeof got === "number") return { err: -got };
  return { size, bytes: got };
}

function at(r, i) { return r.bytes && r.bytes.length > i ? r.bytes[i] : -1; }

function vatk(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const which = spec.slice(bar + 1);
  const fd1 = fs.open(path, O_RDWR);
  if (fd1 < 0) return { ok: false, at: "open1", errno: -fd1 };
  const fd2 = fs.open(path, O_RDWR);
  if (fd2 < 0) return { ok: false, at: "open2", errno: -fd2 };
  const st = fs.fstat(fd1);
  if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
  const S = Number(st.size);
  const A = new Uint8Array(32).fill(0xa1);
  const B = new Uint8Array(8).fill(0xb2);
  const C = new Uint8Array(4).fill(0xc3);
  const row = { ok: true, which, S };

  if (which === "pend" || which === "shrink") {
    // fd2 goes DIRTY with no staged generation: an append far past the committed size, which the
    // COW rule permits to land in the committed generation in place. No fsync.
    const far = which === "shrink" ? S : 100;
    const wc = fs.pwrite(fd2, which === "shrink" ? B : C, far);
    row.fd2PendingWrite = { off: far, n: wc };
    if (wc < 0) return { ok: false, at: "pendwrite", got: wc };
  }

  // fd1: an append AT the committed size, then fsync. Those 32 bytes are now COMMITTED and the
  // metadata publishes S + 32.
  const w1 = fs.pwrite(fd1, A, S);
  if (w1 !== 32) return { ok: false, at: "pwrite1", got: w1, off: S };
  const s1 = fs.fsync(fd1);
  if (s1 !== 0) return { ok: false, at: "fsync1", errno: -s1 };
  const afterA = rd(fs, path);
  row.afterA = { size: afterA.size, byteAtS: at(afterA, S), err: afterA.err };

  if (which === "shrink") {
    // No further write. fd2 is still holding `stagedSize = S + 8` from its stale base; its commit
    // publishes that size over fd1's published S + 32.
    const s2 = fs.fsync(fd2);
    row.fsync2 = s2;
    const end = rd(fs, path);
    row.final = { size: end.size, byteAtS: at(end, S), last: end.bytes ? end.bytes[end.size - 1] : -1 };
    row.wantSize = S + 32;
    row.sizeWentBackwards = end.size < S + 32;
    fs.close(fd1); fs.close(fd2);
    return row;
  }

  // fd2 writes 8 bytes at offset S. That offset is now 32 bytes BELOW the committed size, so a
  // correct copy-on-write must stage a new generation and leave the committed one alone.
  const w2 = fs.pwrite(fd2, B, S);
  row.w2 = w2;
  if (w2 !== 8) return { ok: false, at: "pwrite2", got: w2, off: S };

  // THE OBSERVATION, taken BEFORE fd2 commits, through a FRESH description that reads whatever
  // generation the metadata currently names. 0xa1 means the committed generation was left intact;
  // 0xb2 means committed bytes were overwritten in place under intact metadata.
  const mid = rd(fs, path);
  row.beforeFd2Commit = {
    size: mid.size, byteAtS: at(mid, S), byteAtS8: at(mid, S + 8),
    committedBytesIntact: at(mid, S) === 0xa1,
  };

  const s2 = fs.fsync(fd2);
  row.fsync2 = s2;
  const end = rd(fs, path);
  let prefixOk = end.bytes ? end.size >= S : false;
  const base = bytesFor(TWO_WRITERS.index);
  for (let b = 0; prefixOk && b < S && b < base.length; b += 1) prefixOk = end.bytes[b] === base[b];
  let bOk = end.size >= S + 8;
  for (let b = S; bOk && b < S + 8; b += 1) bOk = end.bytes[b] === 0xb2;
  let aTailOk = end.size >= S + 32;
  for (let b = S + 8; aTailOk && b < S + 32; b += 1) aTailOk = end.bytes[b] === 0xa1;
  row.final = {
    size: end.size, wantSize: S + 32, prefixOk, bOk, aTailOk,
    byteAtS: at(end, S), byteAtS8: at(end, S + 8), bothKept: end.size === S + 32 && prefixOk && bOk && aTailOk,
  };
  fs.close(fd1); fs.close(fd2);
  return row;
}
'''

PAGE_FN = """
/** THE VERIFIER'S ATTACK PROOF. Each scenario on its own wiped volume and its own kernel. */
async function vattack() {
  const out = {}
  for (const which of ['b1', 'pend', 'shrink']) {
    await wipe()
    const k = kernelBoot(BOOT_CFG)
    try {
      const up = await k.expect('up', 20000)
      if (up.fs.mode !== 'rw') { out[which] = { at: 'mount', mode: up.fs.mode }; continue }
      await install(k)
      const made = await once(k, ['mkfiles', '4'])
      if (!made.ok) { out[which] = { at: 'mkfiles', errors: made.errors }; continue }
      const path = pathFor(1)
      k.post({ t: 'fs-state' })
      const s0 = (await k.expect('fs-state', 10000)).fs.stats
      const blobs0 = (await listBlobs()).map((x) => x.name + ':' + x.size).sort()
      const atk = await once(k, ['vatk', path + '|' + which], 60000)
      k.post({ t: 'fs-state' })
      const s1 = (await k.expect('fs-state', 10000)).fs.stats
      const blobs1 = (await listBlobs()).map((x) => x.name + ':' + x.size).sort()
      out[which] = {
        attack: atk, path,
        copyUps: [s0.copyUps, s1.copyUps], swings: [s0.swings, s1.swings],
        blobsBefore: blobs0, blobsAfter: blobs1,
      }
    } catch (e) {
      out[which] = { threw: String(e && e.message || e) }
    } finally {
      await shut(k)
    }
  }
  // A PASS means the system defended itself in all three. Each clause is the user-visible byte.
  const b1 = out.b1 && out.b1.attack || {}
  const pend = out.pend && out.pend.attack || {}
  const shrink = out.shrink && out.shrink.attack || {}
  const b1Ok = !!(b1.beforeFd2Commit && b1.beforeFd2Commit.committedBytesIntact
    && b1.final && b1.final.bothKept)
  const pendOk = !!(pend.beforeFd2Commit && pend.beforeFd2Commit.committedBytesIntact)
  const shrinkOk = shrink.sizeWentBackwards === false
  return { ok: b1Ok && pendOk && shrinkOk, evidence: { b1Ok, pendOk, shrinkOk, ...out } }
}
"""

MAIN_OLD = """  for (const [name, fn] of [['proof_a', proof_a], ['proof_b', proof_b], ['proof_c', proof_c],
    ['proof_d', proof_d], ['pending', pendingAppend], ['drop', dropAndClose],
    ['cas', casCommit], ['orphan', orphanedGeneration],
    ['refuse', refusedMount], ['unreadable', unreadableSlot], ['append', appendPerWrite],
    ['order', ordering], ['api', apiSurface]]) {"""
MAIN_NEW = """  for (const [name, fn] of [['proof_a', vattack], ['proof_d', proof_d]]) {"""


def main() -> int:
    prog = ROOT / "bench" / "fs-core" / "program.mjs"
    text = prog.read_text()
    assert text.count(CASE[0]) == 1, text.count(CASE[0])
    text = text.replace(*CASE)
    # The program dispatcher passes one arg; a second is needed for the scenario name.
    assert text.count("const arg = ") == 1, "arg binding moved"
    prog.write_text(text + FN)
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
