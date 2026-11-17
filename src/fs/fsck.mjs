// fsck. PURE: it takes bytes and a directory listing, and returns a report.
//
// It has no way to write, and that is a proof rather than a promise (constraint 28): it holds no
// handle, no root directory, no port and no Worker, so there is no object here through which a
// reseed could be expressed. The code that decides a volume is bad cannot be the code that could
// rebuild it.
//
// `mountable` is the one field a caller acts on:
//   'rw'        — clean, mount read-write
//   'ro'        — the image is readable and something is wrong. Mount read-only and report.
//   'refuse'    — no valid superblock slot and bytes are present. Not a fresh volume; refuse.
//   'fresh'     — nothing is there at all, so writing an initial superblock loses nothing.
//                 Distinguishing this from 'refuse' is the whole of constraint 28.

import { chooseSuperblock, SUPER_BYTES } from "./superblock.mjs";
import { decodeImage } from "./image.mjs";
import { replay } from "./journal.mjs";
import { VFS, FsError, decodeOp, parseBlobName } from "./vfs.mjs";

export const MOUNT_RW = "rw";
export const MOUNT_RO = "ro";
export const MOUNT_REFUSE = "refuse";
export const MOUNT_FRESH = "fresh";

/**
 * Every input takes three shapes and the third is load-bearing: the bytes, `null` for genuinely
 * ABSENT, or `{errno: n}` for a read that was REFUSED. An errno read as `null` makes a volume that
 * could not be read indistinguishable from one nobody has ever written, and `fresh` is the one
 * verdict whose caller may write a superblock — over live blobs, with `problems` empty.
 *
 * @param {object} input
 * @param {(Uint8Array|null|{errno: number})[]} input.slots  The three superblock slots.
 * @param {Uint8Array|null|{errno: number}} input.journal  The journal file's bytes. A refused
 *        journal is REFUSE and not read-only: the ops since the last snapshot are unknown, so a
 *        tree built from the snapshot alone is missing every op after it, presented as complete.
 * @param {{name: string, size: number}[]|{errno: number}|null} input.blobs  The flat blob
 *        directory's listing; `null` when the caller chose not to enumerate it. Constraint 33:
 *        Safari's enumeration is 0.60 ms per name, so 10k names is ~6 s and the sweep belongs on
 *        an explicit fsck or an idle task, never at boot.
 *
 *        `[]` is a fourth volume: the directory was read and holds nothing, which against metadata
 *        that names blobs is every committed blob ABSENT. A refusal converted to `[]` reports a
 *        loss that did not happen; on a volume with no files it reports a sweep that never ran as
 *        clean.
 * @param {boolean} [input.checkCrc]  false arms negative-control stage 2. The gate that this is a
 *        control and not a mode lives in the kernel, which refuses it without bench=1.
 */
export function fsck(input) {
  const problems = [];
  const given = input.slots || [];
  // Told from bytes by shape rather than `instanceof`: the views arrive from another realm.
  const refused = (x) => !!x && typeof x.errno === "number";
  const unreadable = given
    .map((s, i) => (refused(s) ? { i, errno: s.errno } : null))
    .filter((e) => e !== null);
  // An unreadable slot has no bytes to decode, so the FRESH decision and the problem list are the
  // only two places that must still see the difference.
  const slots = given.map((s) => (refused(s) ? null : s));
  const journalRefused = refused(input.journal);
  const journal = journalRefused ? null : input.journal;
  const present = slots.filter((s) => s && s.length >= SUPER_BYTES);
  const report = {
    mountable: MOUNT_REFUSE,
    problems,
    superblock: null,
    image: null,
    journal: null,
    // The sweep's default is "did not run", and the reason travels with the flag so a reader of a
    // boot report meets the decision rather than a bare false (constraint 33).
    blobs: {
      swept: false,
      // `attempted` tells a decision from a failure. Both arms carry it, so neither is inferred
      // from the absence of the other.
      attempted: false,
      why: "the caller did not enumerate the blob directory. Constraint 33 prices the sweep at "
        + "0.60 ms per name, so it runs on an EXPLICIT fsck, never at mount",
    },
    // Reported so a caller can assert it: a reseed would have to appear as a write, and there is
    // no writer here to make one.
    wrote: false,
    vfs: null,
  };

  // A volume with no superblock bytes at all and no journal is a first boot; one with bytes that
  // do not decode is a damaged volume wearing the same clothes, and confusing the two is the
  // defect constraint 28 names. A refused listing, slot or journal cannot prove a volume is empty,
  // so each counts as bytes-present here rather than reaching the FRESH arm.
  const refusedListing = !!input.blobs && !Array.isArray(input.blobs);
  const anyBytes = present.length > 0 || (journal && journal.length > 0)
    || unreadable.length > 0 || journalRefused
    || refusedListing || (Array.isArray(input.blobs) && input.blobs.length > 0);
  if (!anyBytes) {
    report.mountable = MOUNT_FRESH;
    return report;
  }

  // Named before any verdict, so the report carries the reason whichever arm below returns. An
  // unreadable slot is neither damaged — there are no bytes to call damaged — nor absent.
  if (unreadable.length) {
    problems.push({
      what: "superblock",
      why: `${unreadable.length} of ${given.length} superblock slots could not be READ `
        + `(errno ${unreadable.map((e) => e.errno).join(", ")}), so this volume cannot be shown `
        + "to be empty. Refusing to treat it as a first boot: a reseed here writes a new "
        + "superblock over live data and reports success (constraint 28)",
      slots: unreadable,
    });
  }
  if (journalRefused) {
    problems.push({
      what: "journal",
      why: `the journal could not be READ (errno ${input.journal.errno}), so the ops since the `
        + "last snapshot are unknown. REFUSING rather than mounting read-only: a tree built out "
        + "of the snapshot alone is missing every op after it and would be presented as complete",
    });
    report.mountable = MOUNT_REFUSE;
    return report;
  }

  const chosen = chooseSuperblock(slots.map((s) => (s ? s.subarray(0, SUPER_BYTES)
    : new Uint8Array(SUPER_BYTES))));
  report.superblock = jsonSafe(chosen);
  if (!chosen.ok) {
    problems.push({
      what: "superblock",
      why: "no valid superblock slot, and this volume is not empty. Refusing rather than "
        + "reseeding: constraint 28, and the volume may still hold recoverable blobs",
      slots: chosen.slots,
    });
    report.mountable = MOUNT_REFUSE;
    return report;
  }
  // Absent is not invalid: a volume whose snapshots have only ever landed in slot 0 has two slots
  // that do not exist, and reporting those as rejected would mount every young filesystem
  // read-only. Only a slot with bytes that do not decode is damaged, and an unreadable slot has no
  // bytes, so it is in neither set and must not be counted as absent.
  const damaged = chosen.rejected.filter((r) => slots[r.i] && slots[r.i].length >= SUPER_BYTES);
  report.superblock.damagedSlots = damaged.length;
  report.superblock.unreadableSlots = unreadable.length;
  report.superblock.absentSlots = chosen.rejected.length - damaged.length - unreadable.length;
  if (damaged.length) {
    problems.push({
      what: "superblock",
      why: `${damaged.length} of ${chosen.of} slots hold bytes that do not decode; mounted from `
        + `slot ${chosen.chose} at generation ${chosen.generation}`,
      rejected: damaged,
    });
  }

  // The image, immediately after the superblock in the chosen slot.
  const slot = slots[chosen.chose];
  const decoded = decodeImage(slot, SUPER_BYTES, { checkCrc: input.checkCrc !== false });
  report.image = { ok: decoded.ok, why: decoded.why || "", bytes: decoded.size || 0 };
  if (!decoded.ok) {
    problems.push({ what: "image", why: `the snapshot body in slot ${chosen.chose} is `
      + `${decoded.why}`, detail: decoded.detail || "" });
    report.mountable = MOUNT_REFUSE;
    return report;
  }

  let vfs = null;
  try {
    // The clock is the caller's: this VFS is the live one for an existing volume, so it needs the
    // same clock a fresh volume gets. Replay's strictness about a missing `t` is a property of the
    // op, not of whether a clock was supplied.
    vfs = VFS.parse(decoded.object, { now: input.now });
  } catch (error) {
    problems.push({
      what: "image",
      why: error instanceof FsError ? error.message : String(error && error.message),
    });
    report.mountable = MOUNT_REFUSE;
    return report;
  }

  // Two independent records of one fact: a mismatch means one of the two writes did not land, and
  // saying so is how a torn commit is found rather than inferred.
  const counted = vfs.stats();
  if (BigInt(counted.inodes) !== chosen.super.inodeCount) {
    problems.push({
      what: "superblock",
      why: `the superblock says ${chosen.super.inodeCount} inodes and the image holds `
        + `${counted.inodes}`,
    });
  }
  if (BigInt(counted.nextIno) > chosen.super.nextIno) {
    problems.push({
      what: "superblock",
      why: `the image's highest inode needs nextIno ${counted.nextIno}; the superblock says `
        + `${chosen.super.nextIno}`,
    });
  }

  // The sequence the journal must start at, read off the image rather than assumed. Without it a
  // journal whose first record is missing replays as a shorter but valid journal: the gap rule in
  // src/fs/journal.mjs only fires once replay knows what the first sequence was supposed to be,
  // and the snapshot is the only thing that knows.
  const firstSeq = BigInt(decoded.object.journalFirstSeq ?? 0);
  const journalBytes = journal || new Uint8Array(0);
  const played = replay(journalBytes, { checkCrc: input.checkCrc !== false, firstSeq });
  report.journal = {
    firstSeq: String(firstSeq),
    bytes: journalBytes.length,
    records: played.records.length,
    consumed: played.consumed,
    discardedBytes: played.discardedBytes,
    stopped: played.stopped,
    stoppedAt: played.stoppedAt,
    applied: 0,
    rejected: [],
  };
  if (played.stopped !== null) {
    problems.push({
      what: "journal",
      why: `replay stopped at byte ${played.stoppedAt} with ${played.stopped}; `
        + `${played.discardedBytes} byte(s) of tail DISCARDED, not applied`,
      stopped: played.stopped,
      discardedBytes: played.discardedBytes,
    });
  }

  for (const record of played.records) {
    const op = decodeOp(record.payload);
    if (!op) {
      report.journal.rejected.push({ seq: String(record.seq), why: "payload is not an op" });
      problems.push({ what: "journal", why: `record ${record.seq} carries no decodable op` });
      break;
    }
    try {
      vfs.applyOp(op);
      report.journal.applied += 1;
    } catch (error) {
      report.journal.rejected.push({
        seq: String(record.seq), k: op.k,
        why: error instanceof FsError ? error.message : String(error && error.message),
      });
      problems.push({
        what: "journal",
        why: `record ${record.seq} (${op.k}) could not be applied: `
          + (error instanceof FsError ? error.message : String(error && error.message)),
      });
      // Stopped, not skipped: every later op describes a state this volume is not in, so applying
      // them would build a tree nobody wrote.
      break;
    }
  }

  // Where a dropped data-before-metadata ordering shows up: metadata pointing at a blob which is
  // absent, or shorter than the size the metadata publishes, is intact metadata over torn data —
  // the outcome copy-on-write exists to prevent.
  if (refusedListing) {
    // Unlike the `swept: false` default, the caller asked and the directory refused, so the one
    // check that can find intact metadata over absent data was not taken.
    report.blobs = {
      swept: false, attempted: true, errno: input.blobs.errno,
      why: `the blob directory could not be enumerated: errno ${input.blobs.errno}`,
    };
    problems.push({
      what: "blobs",
      why: `the blob directory could not be enumerated (errno ${input.blobs.errno}), so no `
        + "committed blob was checked against the metadata. This is NOT an empty directory and "
        + "must not be read as one",
    });
  } else if (input.blobs) {
    const have = new Map(input.blobs.map((b) => [b.name, b.size]));
    const want = vfs.blobNames();
    const missing = [];
    const short = [];
    // A blob longer than its published size is slack, not corruption, which is why it is reported
    // and does not refuse the mount. The published size is the only authority on what a file
    // contains (src/kernel/store.mjs), so bytes above it were never published to any reader and
    // the volume is consistent without them — and that is the state a crash mid-append leaves, so
    // refusing it would mount a healthy filesystem read-only over reclaimable bytes. A validator
    // that can only see truncation is half a validator.
    const long = [];
    for (const entry of want) {
      if (!have.has(entry.name)) {
        missing.push({ name: entry.name, ino: entry.ino, size: entry.size });
        continue;
      }
      const onDisk = have.get(entry.name);
      if (onDisk < entry.size) short.push({ name: entry.name, want: entry.size, have: onDisk });
      else if (onDisk > entry.size) {
        long.push({ name: entry.name, want: entry.size, have: onDisk });
      }
    }
    // A blob no inode points at is a stale generation an interrupted swing left behind, or an
    // orphan. Reclaimable, not corruption, and reported separately so the two are not confused.
    const wanted = new Set(want.map((e) => e.name));
    const stale = [];
    let reclaimableBytes = 0;
    for (const b of input.blobs) {
      if (wanted.has(b.name) || !parseBlobName(b.name)) continue;
      stale.push(b.name);
      reclaimableBytes += b.size;
    }
    for (const b of long) reclaimableBytes += b.have - b.want;
    report.blobs = {
      swept: true, attempted: true, have: input.blobs.length, want: want.length,
      missing, short, long, stale, reclaimableBytes,
    };
    if (missing.length) {
      problems.push({
        what: "blobs",
        why: `${missing.length} committed blob(s) named by the metadata are ABSENT: intact `
          + "metadata pointing at data that was never written. This is the failure "
          + "copy-on-write exists to prevent (constraint 23's ordering)",
        missing: missing.slice(0, 8),
      });
    }
    if (short.length) {
      problems.push({
        what: "blobs",
        why: `${short.length} blob(s) are SHORTER than the size the metadata publishes: torn `
          + "data behind whole metadata",
        short: short.slice(0, 8),
      });
    }
  }

  const orphans = vfs.serialize().orphans;
  if (orphans.length) {
    problems.push({
      what: "orphans",
      why: `${orphans.length} inode(s) no path can reach. Reclaimable on an idle task; never at `
        + "boot (constraint 33)",
      orphans: orphans.slice(0, 8),
    });
  }

  report.vfs = vfs;
  report.mountable = problems.length === 0 ? MOUNT_RW : MOUNT_RO;
  return report;
}

/** The report crosses a postMessage and a JSON boundary, and 64-bit fields are BigInt. */
export function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
}

