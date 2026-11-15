#!/usr/bin/env python3
"""Add a `twofd` program mode and wire it into proof_c, in the scratch copy only.

The attack: two file descriptions on ONE inode (which constraint 47 exists to permit). fd1 appends
at the committed size and fsyncs, so the metadata now publishes size0+32. fd2's `d.size` is still
size0, so fd2's write at offset size0 is AT ITS OWN d.size and takes the append branch — into the
blob generation the metadata currently points at, with no copy-up. If `copyUps` does not move and
no new blob name appears, committed bytes were overwritten in place.
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/atk_twofd")

PROGRAM_CASE = ('    case "apicheck": out = apicheck(env); break;\n',
                '    case "apicheck": out = apicheck(env); break;\n'
                '    case "twofd": out = twofd(env, String(arg)); break;\n')

PROGRAM_FN = '''
/** THE ATTACK. Two descriptions on one inode; the second one's committed-size snapshot is stale. */
function twofd(env, path) {
  const fs = env.fs;
  const fd1 = fs.open(path, O_RDWR);
  if (fd1 < 0) return { ok: false, at: "open1", errno: -fd1 };
  const fd2 = fs.open(path, O_RDWR);
  if (fd2 < 0) return { ok: false, at: "open2", errno: -fd2 };
  const st = fs.fstat(fd1);
  if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
  const size0 = Number(st.size);

  // fd1 appends 32 bytes of 0xAA at the committed size and FSYNCS. After this the metadata
  // publishes size0+32 and those 32 bytes are COMMITTED data.
  const a = new Uint8Array(32).fill(0xaa);
  const w1 = fs.pwrite(fd1, a, size0);
  if (w1 !== 32) return { ok: false, at: "pwrite1", got: w1 };
  const s1 = fs.fsync(fd1);
  if (s1 !== 0) return { ok: false, at: "fsync1", errno: -s1 };
  const mid = fs.stat(path);
  const sizeAfter1 = typeof mid === "number" ? -1 : Number(mid.size);

  // fd2 now writes 32 bytes of 0xBB at the SAME offset. Those bytes are below the committed size
  // the metadata publishes, so a correct copy-on-write must stage a new generation here.
  const b = new Uint8Array(32).fill(0xbb);
  const w2 = fs.pwrite(fd2, b, size0);
  const s2 = w2 === 32 ? fs.fsync(fd2) : -1;

  // Read the committed bytes back through a THIRD, fresh description.
  const fd3 = fs.open(path, O_RDONLY);
  const st3 = fd3 < 0 ? null : fs.fstat(fd3);
  const seen = fd3 < 0 || typeof st3 === "number"
    ? null : fs.readAll(fd3, Number(st3.size));
  const tailA = seen && seen.length > size0 ? seen[size0] : -1;
  if (fd3 >= 0) fs.close(fd3);
  fs.close(fd1);
  fs.close(fd2);
  return {
    ok: true, size0, sizeAfter1, w1, w2, s2,
    tailByteAfterSecondWrite: tailA,
    sizeFinal: seen ? seen.length : -1,
  };
}
'''

PAGE_ANCHOR = """    const made = await once(k, ['mkfiles', '4'])
    if (!made.ok) return { ok: false, evidence: { at: 'mkfiles', errors: made.errors } }
"""

PAGE_PATCH = """    const made = await once(k, ['mkfiles', '4'])
    if (!made.ok) return { ok: false, evidence: { at: 'mkfiles', errors: made.errors } }
    // ---- THE TWO-FD COW ATTACK, scratch copy only ----
    {
      const atkPath = pathFor(2)
      k.post({ t: 'fs-state' })
      const s0 = (await k.expect('fs-state', 10000)).fs.stats
      const blobs0 = (await listBlobs()).map((x) => x.name + ':' + x.size)
      const atk = await once(k, ['twofd', atkPath], 30000)
      k.post({ t: 'fs-state' })
      const s1 = (await k.expect('fs-state', 10000)).fs.stats
      const blobs1 = (await listBlobs()).map((x) => x.name + ':' + x.size)
      return { ok: false, evidence: { ATTACK: atk, path: atkPath,
        copyUpsBefore: s0.copyUps, copyUpsAfter: s1.copyUps,
        swingsBefore: s0.swings, swingsAfter: s1.swings,
        blobsBefore: blobs0, blobsAfter: blobs1 } }
    }
"""


def main() -> int:
    prog = ROOT / "bench" / "fs-core" / "program.mjs"
    text = prog.read_text()
    assert text.count(PROGRAM_CASE[0]) == 1
    text = text.replace(*PROGRAM_CASE)
    text = text + PROGRAM_FN
    prog.write_text(text)
    print("patched program.mjs")

    page = ROOT / "www" / "m2.html"
    html = page.read_text()
    assert html.count(PAGE_ANCHOR) == 1, html.count(PAGE_ANCHOR)
    page.write_text(html.replace(PAGE_ANCHOR, PAGE_PATCH))
    print("patched m2.html")
    return 0


if __name__ == "__main__":
    sys.exit(main())
