#!/usr/bin/env python3
"""Build bench/fs-core/edge6.mjs in a throwaway tree: edge.mjs plus one new case.

f6 asks the question F5's volume lock does not answer. A metadata op APPLIES IN MEMORY on the
dispatch thread and its journal record is appended in a later microtask. The volume lock covers
the record. It does not cover the apply. So an apply that lands inside the snapshot's window is
folded into the image, and its record is then appended at the sequence the image says the journal
STARTS at — the same op in both places.
"""
import pathlib
import sys

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1
                    else "/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/r9edge")

CASE = '''
/**
 * F6. THE SNAPSHOT'S WINDOW AND AN APPLY THAT IS NOT UNDER THE VOLUME LOCK.
 *
 * `metaOp` (src/kernel/calls.mjs) applies the op in the VFS synchronously and journals it in a
 * later job. `snapshotHeld` serialises the tree and reads `this.seq` in one synchronous span, but
 * the span BEFORE it — `await this.flushJournalHeld()` — is a window, and an apply landing in it
 * is in the image while its record is still unallocated. The record is then appended after the
 * truncate, at the sequence the image published as the journal's first.
 *
 * Replay therefore applies an op the image already holds. There is no control arm: this is not a
 * revert of a fix, it is a question about the fix's reach.
 */
async function f6_apply_in_snapshot_window() {
  const volume = newVolume();
  let holding = null;
  const h = await mountStore(volume, {
    after: {
      [IO_JOURNAL]: async (m) => {
        if (m.op !== "flush" || !holding) return;
        await holding;
      },
    },
  });
  // Something to flush, so the snapshot's `flushJournalHeld` really awaits.
  const first = h.store.vfs.mkdir(ROOT_CRED, "/pre", { mode: 0o755 });
  await h.store.journal(first);

  let release;
  holding = new Promise((r) => { release = r; });
  const snapshot = h.store.writeSnapshot();
  await sleep(10);
  // THE APPLY, in the window. This is exactly what the dispatch thread does for a mkdir syscall.
  const seqAtApply = String(h.store.seq);
  const op = h.store.vfs.mkdir(ROOT_CRED, "/raced", { mode: 0o755 });
  const appending = h.store.journal(op);
  await sleep(10);
  release();
  holding = null;
  const r = await snapshot;
  const appended = await appending;
  // ONE MORE RECORD AFTER THE RACED ONE, because a refused record DISCARDS THE TAIL: what the
  // mount loses is not the op in the window — that one is in the image — but every op after it.
  const third = h.store.vfs.mkdir(ROOT_CRED, "/after", { mode: 0o755 });
  const appendedAfter = await h.store.journal(third);
  await h.store.flushJournal();

  const next = await mountStore(afterCrash(volume));
  const has = (p) => {
    if (!next.store.vfs) return false;
    try {
      return !!next.store.vfs.stat(ROOT_CRED, p);
    } catch {
      return false;
    }
  };
  record("f6", "the snapshot and the append both succeeded", r === 0 && appended === 0,
    { snapshot: r, appended });
  record("f6", "the remount is read-write", next.store.mode === MOUNT_RW,
    { mode: next.store.mode, problems: next.report.problems,
      seqAtApply, journalFirstSeq: String(next.store.journalFirstSeq || "") });
  record("f6", "the op applied inside the window is there, once", has("/raced") && has("/pre"),
    { raced: has("/raced"), pre: has("/pre"), problems: next.report.problems });
  record("f6", "the op journalled AFTER the raced one survives",
    appendedAfter === 0 && has("/after"),
    { appendedAfter, after: has("/after"), problems: next.report.problems });
}
'''

OLD = '''const CASES = [
  ["f1", f1_append],'''
NEW = '''const CASES = [
  ["f6", f6_apply_in_snapshot_window],
  ["f1", f1_append],'''


def main() -> int:
    src = ROOT / "bench" / "fs-core" / "edge.mjs"
    text = src.read_text()
    assert text.count(OLD) == 1, text.count(OLD)
    assert text.count('const FAMILIES = ["f1", "f2", "f3", "f4", "f5"];') == 1
    text = text.replace('const FAMILIES = ["f1", "f2", "f3", "f4", "f5"];',
                        'const FAMILIES = ["f6", "f1", "f2", "f3", "f4", "f5"];')
    text = text.replace(OLD, NEW)
    text = text.replace("/* ------------------------------------------------------------------ "
                        "the run */",
                        CASE + "\n/* ------------------------------------------------------------"
                        "------ the run */")
    out = ROOT / "bench" / "fs-core" / "edge6.mjs"
    out.write_text(text)
    print("wrote", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
