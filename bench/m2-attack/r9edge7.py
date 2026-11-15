#!/usr/bin/env python3
"""Add f7 to the edge harness copy: an errno from the SUPERBLOCK and JOURNAL reads.

F2 (gap 63) fixed the blob listing. The same conversion is still on the other two reads
(src/kernel/store.mjs:408 and :410-412, and :568 in `check`): an errno becomes `null` for a slot
and an EMPTY Uint8Array for the journal, which is what iocore returns for ABSENT — and absent is
the one state whose caller is allowed to write a superblock.
"""
import pathlib
import sys

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1
                    else "/Users/chafyni/.claude/jobs/e856c39e/tmp/mut/r9edge")

CASE = '''
/**
 * F7. A SUPERBLOCK SLOT THAT COULD NOT BE READ IS NOT AN ABSENT ONE.
 *
 * `iocore.readAll` keeps them apart deliberately — `{absent: true}` for NotFoundError and an
 * errno for everything else, with the comment saying why — and `mount` throws the distinction
 * away: `slots.push(typeof r === "number" || !r.bytes ? null : …)`, and the journal read gets a
 * zero-length array on the same line of reasoning. fsck is then given a volume with no slot bytes
 * and no journal, which is its definition of a FIRST BOOT, and FRESH is the one verdict whose
 * caller writes a superblock.
 *
 * The blob directory cannot rescue it: constraint 33 keeps the sweep off the boot path, so
 * `blobs` is null at mount and the blobs this volume holds are not evidence of anything.
 *
 * QuotaExceededError, NotAllowedError and SecurityError all arrive here as errnos.
 */
async function f7_unreadable_superblock() {
  const volume = newVolume();
  const h = await mountStore(volume);
  // A populated volume: a tree, a file with a committed blob, and a snapshot, so all three
  // superblock slots and the image are real bytes on disk.
  await h.store.journal(h.store.vfs.mkdir(ROOT_CRED, "/keep", { mode: 0o755 }));
  const d = await makeFile(h, "/keep/data");
  await write(h, d, filled(16, 0x77), undefined);
  await h.store.fsyncFd(d);
  await h.store.closeFd(d);
  await h.store.writeSnapshot();
  const slotNames = [...volume.files.keys()];
  const was = new Map([...volume.files].map(([k, v]) => [k, hex(v)]));
  const blobsBefore = volume.blobs.size;

  // Every read of the superblock slots and the journal refuses. NOT NotFoundError: this is a
  // quota error or a revoked storage permission over a volume whose bytes are all still there.
  const copy = afterCrash(volume);
  const next = await mountStore(copy, { hooks: { [IO_READ_ALL]: () => -EIO } });
  const now = new Map([...copy.files].map(([k, v]) => [k, hex(v)]));
  const rewritten = slotNames.filter((n) => was.get(n) !== now.get(n));

  record("f7", "the volume really was populated",
    slotNames.length > 0 && blobsBefore > 0, { slotNames, blobsBefore });
  record("f7", "a volume whose slots cannot be READ does not mount as a fresh one",
    next.store.mode !== MOUNT_RW && next.report.mountable !== "fresh",
    { mode: next.store.mode, mountable: next.report.mountable,
      problems: next.report.problems });
  record("f7", "and it says why",
    (next.report.problems || []).length > 0, next.report.problems);
  record("f7", "and nothing was written over the volume", rewritten.length === 0,
    { rewritten, slotNames });
}
'''

OLD = '''const CASES = [
  ["f6", f6_apply_in_snapshot_window],'''
NEW = '''const CASES = [
  ["f7", f7_unreadable_superblock],
  ["f6", f6_apply_in_snapshot_window],'''


def main() -> int:
    src = ROOT / "bench" / "fs-core" / "edge6.mjs"
    text = src.read_text()
    assert text.count(OLD) == 1, text.count(OLD)
    text = text.replace('const FAMILIES = ["f6", "f1"', 'const FAMILIES = ["f7", "f6", "f1"')
    text = text.replace(OLD, NEW)
    text = text.replace("/* ------------------------------------------------------------------ "
                        "the run */",
                        CASE + "\n/* ------------------------------------------------------------"
                        "------ the run */")
    out = ROOT / "bench" / "fs-core" / "edge7.mjs"
    out.write_text(text)
    print("wrote", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
