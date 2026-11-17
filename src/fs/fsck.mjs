// fsck. PURE: it takes bytes and a directory listing, and returns a report.
//
// IT HAS NO WAY TO WRITE, AND THAT IS THE PROOF RATHER THAN A PROMISE (constraint 28). This module
// imports four codecs and nothing else; it holds no handle, no root directory, no port and no
// Worker, so there is no object here through which a reseed could be expressed. webxp reseeded on
// a bad image — `VFS.reset()` plus `seed.mjs`, called from the mount path — and that is silent data
// loss presented as success. The structural answer is that the code which decides a volume is bad
// cannot be the code that could rebuild it.
//
// What a caller does with a report is its business, and `mountable` is the one field that says it:
//   'rw'        — clean, mount read-write
//   'ro'        — the image is readable and something is wrong. Mount READ-ONLY and report.
//   'refuse'    — no valid superblock slot and bytes are present. Not a fresh volume; refuse.
//   'fresh'     — nothing is there at all. A first boot, which is the ONE case where writing an
//                 initial superblock is correct, and it is correct because there is nothing to
//                 lose. Distinguishing this from 'refuse' is the whole of constraint 28.

import { chooseSuperblock, SUPER_BYTES } from "./superblock.mjs";
import { decodeImage } from "./image.mjs";
import { replay } from "./journal.mjs";
import { VFS, FsError, decodeOp, parseBlobName } from "./vfs.mjs";

export const MOUNT_RW = "rw";
export const MOUNT_RO = "ro";
export const MOUNT_REFUSE = "refuse";
export const MOUNT_FRESH = "fresh";

/**
 * @param {object} input
 * @param {(Uint8Array|null|{errno: number})[]} input.slots  The three superblock slots. The bytes,
 *        `null` for a slot that is genuinely ABSENT, or `{errno: n}` for one whose read was
 *        REFUSED.
 *
 *        THE THIRD SHAPE IS THE POINT, and it is the same correction `blobs` carries below. An
 *        errno read as `null` makes a refused read indistinguishable from a volume nobody has ever
 *        written: a volume whose slots could not be read, with an empty journal because the last
 *        snapshot truncated it, reaches the FRESH arm — and FRESH is the one verdict whose caller
 *        is allowed to write a superblock. Measured as a reseed over live blobs, read-write, with
 *        `problems` empty.
 * @param {Uint8Array|null|{errno: number}} input.journal  The journal file's bytes, `null` for
 *        absent, `{errno: n}` for a refused read. A refused journal is REFUSE and not read-only:
 *        the ops since the last snapshot are unknown, so a tree built from the snapshot alone is a
 *        tree missing every op after it, presented as complete.
 * @param {{name: string, size: number}[]|{errno: number}|null} input.blobs  The flat blob
 *        directory's listing; null when the caller chose not to enumerate it; `{errno: n}` when it
 *        TRIED and was refused. Constraint 33: Safari's enumeration is
 *        0.60 ms per name, so 10k names is ~6 s and the sweep belongs on an explicit fsck or an
 *        idle task, NEVER at boot. A null listing produces `blobs: {swept: false}` and the report
 *        says the sweep did not run rather than that it found nothing.
 *
 *        THE THREE ARE THREE DIFFERENT VOLUMES, and `[]` is only one of them: the directory was
 *        read and holds nothing, which against metadata that names blobs is the worst verdict this
 *        function has — every committed blob ABSENT, "intact metadata pointing at data that was
 *        never written". A refusal converted to `[]` therefore reports a loss that did not happen,
 *        and on a volume with no files it reports a sweep that never ran as clean. An errno is
 *        neither reading: the sweep did not happen, it is a PROBLEM, and the reason is named.
 * @param {boolean} [input.checkCrc]  false arms negative-control stage 2. The gate that this is a
 *        control and not a mode lives in the kernel, which refuses it without bench=1.
 */
export function fsck(input) {
  const problems = [];
  const given = input.slots || [];
  // A REFUSED READ, told from bytes by SHAPE rather than by `instanceof`: this module is pure and
  // every caller hands it views it built itself, so the test is "does it carry an errno".
  const refused = (x) => !!x && typeof x.errno === "number";
  const unreadable = given
    .map((s, i) => (refused(s) ? { i, errno: s.errno } : null))
    .filter((e) => e !== null);
  // The slots AS BYTES. An unreadable slot has none, so every length test below reads it as having
  // nothing to decode — which is correct, and is why the FRESH decision and the problem list are
  // the two places that must see the difference.
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
    // THE SWEEP'S DEFAULT IS "DID NOT RUN", and the reason travels with the flag so a reader of a
    // boot report meets the decision rather than a false. Constraint 33: 0.60 ms per name on
    // Safari, so a 10k-name volume would spend ~6 s in the sweep before the first process runs.
    blobs: {
      swept: false,
      // `attempted` is what tells a DECISION from a FAILURE, and both arms carry it so a reader
      // never has to infer one from the absence of the other.
      attempted: false,
      why: "the caller did not enumerate the blob directory. Constraint 33 prices the sweep at "
        + "0.60 ms per name, so it runs on an EXPLICIT fsck, never at mount",
    },
    // Written by nothing in this module. Reported so a caller can assert it: a reseed would have
    // to appear as a write, and there is no writer here to make one.
    wrote: false,
    vfs: null,
  };

  // A volume with no superblock bytes AT ALL and no journal is a first boot. One with bytes that
  // do not decode is a damaged volume wearing the same clothes, and the two must never be
  // confused — that confusion IS the defect constraint 28 names.
  // A REFUSED LISTING CANNOT PROVE A VOLUME IS EMPTY, so it is bytes-present for this decision.
  // Read as "no blobs", it would let a volume whose directory could not be enumerated reach the
  // FRESH arm — and FRESH is the one verdict whose caller is allowed to write a superblock.
  // A REFUSED SLOT OR JOURNAL READ CANNOT PROVE A VOLUME WAS NEVER WRITTEN either, for the same
  // reason, so both are bytes-present for this decision.
  const refusedListing = !!input.blobs && !Array.isArray(input.blobs);
  const anyBytes = present.length > 0 || (journal && journal.length > 0)
    || unreadable.length > 0 || journalRefused
    || refusedListing || (Array.isArray(input.blobs) && input.blobs.length > 0);
  if (!anyBytes) {
    report.mountable = MOUNT_FRESH;
    return report;
  }

  // NAMED BEFORE ANY VERDICT IS REACHED, so the report carries the reason whichever arm below
  // returns. An unreadable slot is not a damaged one — there are no bytes to call damaged — and it
  // is not an absent one either, which is the whole of this problem's text.
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
  // ABSENT IS NOT INVALID. A volume whose snapshots have only ever landed in slot 0 has two slots
  // that do not exist, and reporting those as rejected would make every young filesystem mount
  // read-only. Only a slot with BYTES that do not decode is a problem.
  const damaged = chosen.rejected.filter((r) => slots[r.i] && slots[r.i].length >= SUPER_BYTES);
  report.superblock.damagedSlots = damaged.length;
  // AND UNREADABLE IS NEITHER. A refused read has no bytes, so it falls in neither set above and
  // would otherwise be counted as absent — the one reading this change exists to prevent.
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
    // THE CLOCK IS THE CALLER'S. The VFS this returns is the LIVE one for an existing
    // volume, so it needs the same clock a fresh volume gets; replay's strictness about a
    // missing `t` is a property of the op, not of whether a clock was supplied.
    vfs = VFS.parse(decoded.object, { now: input.now });
  } catch (error) {
    problems.push({
      what: "image",
      why: error instanceof FsError ? error.message : String(error && error.message),
    });
    report.mountable = MOUNT_REFUSE;
    return report;
  }

  // The superblock's own counts against the image it introduces. Two independent records of one
  // fact: a mismatch means one of the two writes did not land, and saying so is how a torn commit
  // is found rather than inferred.
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

  // The journal. Replay REPORTS the discarded tail rather than reseeding, and it stops at the
  // first record it will not accept — including a sequence gap, because records after a missing
  // one are not later records, they are records whose predecessor is gone.
  // THE SEQUENCE THE JOURNAL MUST START AT, read off the image rather than assumed. Without it a
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
      // Stopped, not skipped. An op that cannot apply leaves every later op describing a state
      // this volume is not in, and applying them anyway builds a tree nobody wrote.
      break;
    }
  }

  // The blob sweep. THIS IS WHERE A DROPPED data-before-metadata ORDERING SHOWS UP: metadata that
  // points at a blob which is absent, or shorter than the size the metadata publishes, is exactly
  // "intact metadata pointing at torn data" — the outcome copy-on-write exists to prevent.
  if (refusedListing) {
    // THE SWEEP DID NOT RUN AND THAT IS A PROBLEM, which is the difference between this and the
    // `swept: false` default: the caller ASKED for the sweep and the directory refused, so the one
    // check that can find intact metadata over absent data was not taken on a volume somebody is
    // about to mount.
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
    // A BLOB LONGER THAN THE SIZE ITS METADATA PUBLISHES, which this sweep could not see at all:
    // it tested `onDisk < entry.size` and nothing else, so every silent failure across four rounds
    // of attacks passed it — each one ended with a blob whose length matched its published size, or
    // longer. A validator that can only see truncation is half a validator.
    //
    // THOSE BYTES ARE SLACK AND NOT CORRUPTION, which is why this is reported and does not refuse
    // the mount. The published size is the only authority on what a file contains
    // (src/kernel/store.mjs), so bytes above it were never published to any reader and the volume
    // is consistent without them. The state a crash leaves mid-append is exactly this one, and
    // mounting every such volume read-only would refuse a healthy filesystem over reclaimable
    // bytes. They are counted into `reclaimableBytes` beside the stale generations for the same
    // reason.
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
    // orphan. Reclaimable; not corruption, and reported as its own thing so the two are not
    // confused.
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

