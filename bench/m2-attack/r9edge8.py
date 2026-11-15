#!/usr/bin/env python3
"""Add f8: the snapshot's two durable steps, with the second one refusing.

`snapshotHeld` writes the new slot, flushes it, and THEN truncates the journal — the order is
right, and the comment says why. What it does not say is what happens when the truncate refuses:
the new slot is on disk and carries the higher generation, so the next mount CHOOSES it, while the
kernel's own `generation`, `slot` and `journalFirstSeq` were never advanced and the journal still
holds the records the image says it starts past.
"""
import pathlib
import sys

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1
                    else "/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/r9edge")

CASE = '''
/**
 * F8. A SNAPSHOT WHOSE JOURNAL TRUNCATE REFUSES.
 *
 * The slot is already durable when the truncate is asked for, and the truncate is what makes the
 * image's `journalFirstSeq` true. Refused, the two disagree: the disk's newest slot says the
 * journal starts at N and the journal on disk starts below N.
 *
 * The assertion is what a user keeps. Ops that returned success AFTER the failed snapshot are the
 * ones at risk, so one is written here, flushed, and looked for across the remount.
 */
async function f8_truncate_refuses() {
  const volume = newVolume();
  let refuse = false;
  const h = await mountStore(volume, {
    hooks: {
      [IO_JOURNAL]: (m) => (refuse && m.op === "truncate" ? -EIO : undefined),
    },
  });
  await h.store.journal(h.store.vfs.mkdir(ROOT_CRED, "/before", { mode: 0o755 }));
  refuse = true;
  const snap = await h.store.writeSnapshot();
  refuse = false;
  // An op that returns success AFTER the refused snapshot.
  const after = await h.store.journal(h.store.vfs.mkdir(ROOT_CRED, "/after", { mode: 0o755 }));
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
  record("f8", "the snapshot reported the refusal", snap < 0, { snap });
  record("f8", "the op after it was acknowledged", after === 0, { after });
  record("f8", "both ops survive the remount", has("/before") && has("/after"),
    { before: has("/before"), after: has("/after"), mode: next.store.mode,
      problems: next.report.problems });
  record("f8", "or the volume says it lost something",
    (has("/before") && has("/after")) || (next.report.problems || []).length > 0,
    { mode: next.store.mode, problems: next.report.problems });
}
'''

OLD = '''const CASES = [
  ["f7", f7_unreadable_superblock],'''
NEW = '''const CASES = [
  ["f8", f8_truncate_refuses],
  ["f7", f7_unreadable_superblock],'''


def main() -> int:
    src = ROOT / "bench" / "fs-core" / "edge7.mjs"
    text = src.read_text()
    assert text.count(OLD) == 1, text.count(OLD)
    text = text.replace('const FAMILIES = ["f7", "f6", "f1"',
                        'const FAMILIES = ["f8", "f7", "f6", "f1"')
    text = text.replace(OLD, NEW)
    text = text.replace("/* ------------------------------------------------------------------ "
                        "the run */",
                        CASE + "\n/* ------------------------------------------------------------"
                        "------ the run */")
    out = ROOT / "bench" / "fs-core" / "edge8.mjs"
    out.write_text(text)
    print("wrote", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
