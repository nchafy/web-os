#!/usr/bin/env python3
"""Build vattack17.py from vattack16.py: what a caller that RETRIES a failed fsync is told.

`commit` frees the staged generation before it returns -EBUSY (src/kernel/store.mjs:784). So the
question a 6.5% EBUSY rate raises is whether a caller can recover. The reasonable reading of a
failed `fsync` is "the flush did not happen, flush again" — `pwrite` already returned success, so
re-issuing the write is not indicated. This writes a DISTINCT value per round so the final byte
names which round survived, and retries only the fsync.
"""
import pathlib
import sys

SRC = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/vattack16.py")
DST = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/vattack17.py")

OLD_A = """function v9a2(env) {
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
}"""

NEW_A = """function v9a2(env) {
  const fs = env.fs;
  if (keptFd < 0) return { ok: false, why: "no fd was kept" };
  const writes = [];
  const syncs = [];
  const retried = [];
  let lastDurable = -1;
  let lastWritten = -1;
  for (let i = 0; i < R9.rounds; i += 1) {
    // A DISTINCT VALUE PER ROUND, so the byte left in the file names the round that survived.
    const value = 1 + (i % 250);
    const buf = new Uint8Array(R9.len).fill(value);
    const w = fs.pwrite(fd0(), buf, 0);
    writes.push(w);
    if (w === R9.len) lastWritten = value;
    let s = fs.fsync(fd0());
    if (s < 0) {
      // THE CALLER'S REASONABLE READING: the flush did not happen, so flush again. It does not
      // re-issue the write, because pwrite already returned success.
      retried.push({ i, value, errno: -s });
      s = fs.fsync(fd0());
      if (s === 0) retried[retried.length - 1].retrySaid = 0;
    }
    syncs.push(s);
    if (s === 0) lastDurable = value;
  }
  const st = fs.fstat(fd0());
  return { ok: true, which: "a", wroteAll: writes.every((w) => w === R9.len),
    syncedAll: syncs.every((s) => s === 0), lastDurable, lastWritten,
    retries: retried.length, retried: retried.slice(-6),
    writeErrs: writes.filter((w) => w < 0).map((w) => -w),
    syncErrs: syncs.filter((s) => s < 0).map((s) => -s),
    fdSize: typeof st === "number" ? -st : Number(st.size) };
}"""

OLD_CHECK = """  return { ok: true, size, read: got.length, aBytes, bBytes,
    wantA: R9.len, wantB: R9.rounds * R9.len, bytes: [...got] };"""

NEW_CHECK = """  return { ok: true, size, read: got.length, aBytes, bBytes,
    byte0: size > 0 ? got[0] : -1,
    wantA: R9.len, wantB: R9.rounds * R9.len };"""


def main() -> int:
    t = SRC.read_text()
    for old, new in ((OLD_A, NEW_A), (OLD_CHECK, NEW_CHECK)):
        assert t.count(old) == 1, (old[:40], t.count(old))
        t = t.replace(old, new)
    assert t.count('/mut/vatk16"') == 1
    t = t.replace('/mut/vatk16"', '/mut/vatk17"')
    DST.write_text(t)
    print("wrote", DST)
    return 0


if __name__ == "__main__":
    sys.exit(main())
