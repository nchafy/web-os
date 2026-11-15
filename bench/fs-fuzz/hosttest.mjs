// M2a's host test: the fs codecs under plain Node, no Worker, no SAB, no OPFS.
//
// These are not test doubles. They are the codecs M2 uses, imported from src/fs/, which is the
// scope condition the milestone turns on: the host-runnable path must be the SAME CODE, not a
// port. If a codec ever reaches for storage inside its parse path this file stops running and
// that is the intended alarm.

import { crc32, crc32SelfTest } from "../../src/fs/crc32.mjs";
import {
  encodeRecord, decodeRecord, replay, REFUSE, HEADER_BYTES, MAX_PAYLOAD,
} from "../../src/fs/journal.mjs";
import {
  encodeSuperblock, decodeSuperblock, chooseSuperblock, SUPER_REFUSE, SUPER_BYTES, SUPER_MAJOR,
} from "../../src/fs/superblock.mjs";
import {
  VFS, FsError, FS_CODES, OP, encodeOp, decodeOp, blobName, MAX_LINKS, NAME_MAX, FORMAT_VERSION,
  PERM,
} from "../../src/fs/vfs.mjs";
import {
  encodeImage, decodeImage, IMAGE_REFUSE, IMAGE_HEADER, MAX_IMAGE,
} from "../../src/fs/image.mjs";
import { fsck, MOUNT_RW, MOUNT_RO, MOUNT_FRESH, MOUNT_REFUSE } from "../../src/fs/fsck.mjs";
import {
  MountTable, MNT_RO, FS_OPFS, FS_TMPFS, FS_PROC, FS_DEV, FS_PROVIDER, DEV_FIRST,
} from "../../src/fs/mounts.mjs";
import { E } from "../../src/abi.mjs";

const results = [];
const bytes = (...v) => new Uint8Array(v);

const asJson = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x));
function check(name, got, want) {
  const ok = asJson(got) === asJson(want);
  results.push({ name, ok, got: ok ? undefined : got, want: ok ? undefined : want });
}
function checkThat(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: ok ? undefined : detail });
}

// ---- crc32 -------------------------------------------------------------------------------
const self = crc32SelfTest();
checkThat("crc32 matches the published check value", self.ok, self.why);
checkThat("crc32 is order-sensitive", crc32(bytes(1, 2)) !== crc32(bytes(2, 1)),
  "a checksum that ignores order would not detect a swapped pair");

// ---- journal round-trip ------------------------------------------------------------------
const payload = bytes(1, 2, 3, 4, 5);
const rec = encodeRecord(7, payload);
check("record size is header + payload", rec.length, HEADER_BYTES + payload.length);
const back = decodeRecord(rec);
checkThat("record round-trips", back.ok && back.seq === 7n
  && [...back.payload].join() === [...payload].join(), back);

const empty = decodeRecord(encodeRecord(0, bytes()));
checkThat("a zero-length payload round-trips", empty.ok && empty.payload.length === 0, empty);

// ---- journal refusals, each named --------------------------------------------------------
check("a short header is refused", decodeRecord(rec.subarray(0, HEADER_BYTES - 1)).why,
  REFUSE.SHORT_HEADER);
const badMagic = rec.slice(); badMagic[0] ^= 0xff;
check("a bad magic is refused", decodeRecord(badMagic).why, REFUSE.BAD_MAGIC);
const badCrc = rec.slice(); badCrc[HEADER_BYTES] ^= 1;
check("a flipped payload byte is refused", decodeRecord(badCrc).why, REFUSE.BAD_CRC);
const badLen = rec.slice();
new DataView(badLen.buffer).setUint32(4, MAX_PAYLOAD + 1, true);
check("an impossible length is refused before it is used", decodeRecord(badLen).why,
  REFUSE.BAD_LENGTH);
const badReserved = rec.slice();
new DataView(badReserved.buffer).setUint32(20, 1, true);
check("a non-zero reserved word is refused", decodeRecord(badReserved).why, REFUSE.BAD_RESERVED);
check("a truncated payload is refused", decodeRecord(rec.subarray(0, rec.length - 1)).why,
  REFUSE.SHORT_PAYLOAD);

// A flipped LENGTH field must be caught by the CRC, because the CRC covers the header. This is
// the case that justifies covering the header: a parser trusting a corrupt length is the most
// dangerous thing in a replay path.
const flippedLen = rec.slice();
new DataView(flippedLen.buffer).setUint32(4, 4, true);
check("a flipped length is caught by the CRC", decodeRecord(flippedLen).why, REFUSE.BAD_CRC);

// ---- replay semantics --------------------------------------------------------------------
const three = new Uint8Array([
  ...encodeRecord(0, bytes(10)), ...encodeRecord(1, bytes(20)), ...encodeRecord(2, bytes(30)),
]);
const full = replay(three, { firstSeq: 0 });
checkThat("replay accepts a whole journal", full.records.length === 3 && full.stopped === null,
  full);
check("replay discards nothing from a whole journal", full.discardedBytes, 0);

// The torn tail: replay must REPORT the discard, never reseed (constraint 28). BOTH tear shapes,
// because they take different branches: a tear inside the header cannot even read a length, while
// a tear after it has a length that over-runs the buffer. The third record here is 24 header
// bytes + 1 payload byte, so dropping 3 leaves 22 — inside the header.
const tornHeader = three.subarray(0, three.length - 3);
const tornHeaderR = replay(tornHeader, { firstSeq: 0 });
checkThat("a tail torn inside a header stops replay and is reported",
  tornHeaderR.records.length === 2 && tornHeaderR.stopped === REFUSE.SHORT_HEADER
  && tornHeaderR.discardedBytes === 22, tornHeaderR);

// And a tear after a complete header, which must be refused on the length instead.
const long = new Uint8Array([
  ...encodeRecord(0, bytes(10)), ...encodeRecord(1, new Uint8Array(30).fill(7)),
]);
const tornPayload = long.subarray(0, long.length - 5);
const tornPayloadR = replay(tornPayload, { firstSeq: 0 });
checkThat("a tail torn inside a payload stops replay and is reported",
  tornPayloadR.records.length === 1 && tornPayloadR.stopped === REFUSE.SHORT_PAYLOAD
  && tornPayloadR.discardedBytes > 0, tornPayloadR);

// A sequence gap stops replay: records after a missing one are not later records, they are
// records whose predecessor is gone.
const gapped = new Uint8Array([...encodeRecord(0, bytes(10)), ...encodeRecord(2, bytes(30))]);
const gapR = replay(gapped, { firstSeq: 0 });
checkThat("a sequence gap stops replay", gapR.records.length === 1 && gapR.stopped === "seq-gap",
  gapR);

// ---- superblock --------------------------------------------------------------------------
const sb = encodeSuperblock({ generation: 5, inodeCount: 12, nextIno: 13 });
check("superblock size", sb.length, SUPER_BYTES);
const sbBack = decodeSuperblock(sb);
checkThat("superblock round-trips",
  sbBack.ok && sbBack.generation === 5n && sbBack.inodeCount === 12n && sbBack.nextIno === 13n,
  sbBack);
const sbBad = sb.slice(); sbBad[8] ^= 1;
check("a flipped superblock byte is refused", decodeSuperblock(sbBad).why, SUPER_REFUSE.BAD_CRC);
const sbFuture = sb.slice();
new DataView(sbFuture.buffer).setUint16(4, SUPER_MAJOR + 1, true);
new DataView(sbFuture.buffer).setUint32(32, 0, true);
new DataView(sbFuture.buffer).setUint32(32, crc32(sbFuture), true);
check("a future major version is refused rather than guessed",
  decodeSuperblock(sbFuture).why, SUPER_REFUSE.FUTURE_MAJOR);

// Three slots, newest valid one wins, and a corrupt slot does not take the mount down.
const slots = [
  encodeSuperblock({ generation: 9, inodeCount: 1, nextIno: 2 }),
  encodeSuperblock({ generation: 11, inodeCount: 1, nextIno: 2 }),
  encodeSuperblock({ generation: 10, inodeCount: 1, nextIno: 2 }),
];
const chosen = chooseSuperblock(slots);
checkThat("the newest valid superblock is chosen",
  chosen.ok && chosen.chose === 1 && chosen.generation === 11n, chosen);
const damaged = slots.map((s) => s.slice());
damaged[1][9] ^= 0xff;                                   // break the newest
const chosen2 = chooseSuperblock(damaged);
checkThat("a corrupt newest slot falls back to the next newest, and says so",
  chosen2.ok && chosen2.chose === 2 && chosen2.generation === 10n
  && chosen2.rejected.length === 1, chosen2);
const allBad = slots.map((s) => { const c = s.slice(); c[0] ^= 0xff; return c; });
checkThat("no valid slot is a refusal, not a reseed",
  chooseSuperblock(allBad).ok === false, chooseSuperblock(allBad));

// ---- M2: the VFS port, the image container and fsck -------------------------------------
//
// Here for the reason M2a exists: these are PURE over byte arrays, so they run under plain Node in
// milliseconds. The day one of them reaches for a sync access handle inside a parse path this file
// stops running, and that is the intended alarm rather than a silent decay into a second
// implementation.

const ROOT = { uid: 0, gid: 0 };
const ALICE = { uid: 1000, gid: 1000 };
const BOB = { uid: 1001, gid: 1001 };

// Every FsError code must BE an errno. A code with no entry in the ABI's table reaches a process
// as -EIO and the reason is lost; this is the one assertion that keeps the two files in step.
const unmapped = FS_CODES.filter((code) => E[code] === undefined);
checkThat("every FsError code maps to an errno", unmapped.length === 0,
  `src/fs/vfs.mjs can throw ${unmapped.join(", ")}, which src/abi.mjs does not name`);

let clock = 0;
const vfs = new VFS({ owner: ROOT, now: () => ++clock });
const base = vfs.serialize();
const log = [];
const note = (op) => {
  if (op) log.push(op);
  return op;
};

check("a fresh VFS is one root inode", vfs.stats().inodes, 1);
note(vfs.mkdir(ROOT, "/home", { mode: 0o755 }));
note(vfs.chown(ROOT, "/home", 1000, 1000));
note(vfs.mkdir(ALICE, "/home/alice", { mode: 0o700 }));

// CONSTRAINT 29, the half a write test never reaches: a credential that lacks the bit is TURNED
// AWAY. Without this the mode bits are decoration and every process shares one identity.
//
// It asserts on a name INSIDE the 0700 directory, which is what the bit governs. `stat` of the
// directory itself needs execute on its PARENT, not on the directory — the first version of this
// test asserted the wrong thing and the port was right: a 0700 directory is listed by anyone who
// can read the directory above it, and only entering it is refused.
checkThat("the owner may stat a 0700 directory", vfs.stat(ALICE, "/home/alice").mode === 0o700,
  "alice was refused her own directory");
checkThat("a non-owner may stat it too, because that needs execute on the PARENT",
  vfs.stat(BOB, "/home/alice").mode === 0o700, "bob could not stat a name in a 0755 directory");
checkThat("a non-root chown away from one's own uid is EPERM",
  refuses(() => vfs.chown(ALICE, "/home/alice", 1001, 1001), "EPERM"),
  "alice gave her directory away");
checkThat("a non-owner cannot chmod",
  refuses(() => vfs.chmod(BOB, "/home/alice", 0o777), "EPERM"), "bob chmodded alice's directory");

// ---- THE PERMISSION MODEL, IN THE FAST GATE ----------------------------------------------
//
// Here because of what its absence cost: forcing `#may()` to return true passed all 84 host tests
// in three seconds, and only the 60-second browser run caught it. The VFS is pure and lives in
// src/fs/, so the model costs nothing to check under Node — and a gate that cannot see a
// permission model is a gate that cannot defend constraint 29.
//
// THREE ARMS, BOTH DIRECTIONS EACH, and the directions are the point. A table that only ever sees
// an arm GRANT cannot tell that arm from a fallthrough to the next one: the group rows where the
// group bits are clear and `other`'s are set are the rows that fail if the group arm is deleted,
// and every DENY row is a row that fails if `#may()` stops reading the mode at all.
const { R: PR, W: PW, X: PX } = PERM;
const CAROL = { uid: 1002, gid: 1000 };     // not the owner, IN the owner's group
const perms = new VFS({ owner: ROOT, now: () => ++clock });
perms.mkdir(ROOT, "/p", { mode: 0o755 });
/** name, mode, the file's [uid, gid], the asking credential, the bits asked for, allowed? */
const PERM_CASES = [
  // The owner arm, and its exclusivity: owner bits are the ANSWER for the owner, not a floor.
  ["owner r on 0600", 0o600, [1000, 1000], ALICE, PR, true],
  ["owner w on 0600", 0o600, [1000, 1000], ALICE, PW, true],
  ["owner x on 0600", 0o600, [1000, 1000], ALICE, PX, false],
  ["owner w on 0400", 0o400, [1000, 1000], ALICE, PW, false],
  ["owner r+w on 0400", 0o400, [1000, 1000], ALICE, PR | PW, false],
  ["owner bits WIN over a wider group and other: 0077 to its owner",
    0o077, [1000, 1000], ALICE, PR, false],
  // The group arm. CAROL is in gid 1000 and owns nothing.
  ["group r on 0040", 0o040, [1000, 1000], CAROL, PR, true],
  ["group w on 0040", 0o040, [1000, 1000], CAROL, PW, false],
  ["group bits WIN over other: 0004 to a group member", 0o004, [1000, 1000], CAROL, PR, false],
  ["group bits WIN over other: 0707 to a group member", 0o707, [1000, 1000], CAROL, PR, false],
  ["group rwx on 0070", 0o070, [1000, 1000], CAROL, PR | PW | PX, true],
  // The other arm.
  ["other r on 0004", 0o004, [1000, 1000], BOB, PR, true],
  ["other r on 0040", 0o040, [1000, 1000], BOB, PR, false],
  ["other r on 0000", 0o000, [1000, 1000], BOB, PR, false],
  // Root: read and write bits do not apply, one execute bit still must exist to run a file.
  ["root r on 0000", 0o000, [1000, 1000], ROOT, PR, true],
  ["root w on 0000", 0o000, [1000, 1000], ROOT, PW, true],
  ["root x on 0000", 0o000, [1000, 1000], ROOT, PX, false],
  ["root x on 0100", 0o100, [1000, 1000], ROOT, PX, true],
];
const permFailures = [];
PERM_CASES.forEach(([what, mode, [uid, gid], cred, bits, allowed], i) => {
  const path = `/p/f${i}`;
  perms.openDecision(ROOT, path, { create: true, wantW: true, mode });
  perms.chown(ROOT, path, uid, gid);
  let got = true;
  try {
    perms.access(cred, path, bits);
  } catch (error) {
    if (!(error instanceof FsError) || error.code !== "EACCES") throw error;
    got = false;
  }
  if (got !== allowed) {
    permFailures.push(`${what}: mode ${mode.toString(8).padStart(4, "0")} uid ${uid} gid ${gid}`
      + ` asked ${bits} by uid ${cred.uid}/gid ${cred.gid} — ${got ? "allowed" : "refused"}`
      + `, want ${allowed ? "allowed" : "refused"}`);
  }
});
checkThat(`all ${PERM_CASES.length} permission cases answer correctly`, permFailures.length === 0,
  permFailures);
// The group arm, named on its own as well as inside the table, because it is the arm nothing else
// in this project reaches: every other file in every bench is owned by the credential that opens
// it, so the owner arm answers first and the group arm could be deleted unnoticed.
const groupOnly = PERM_CASES.filter(([, , [, gid], cred]) => cred.uid !== 1000 && cred.uid !== 0
  && cred.gid === gid);
checkThat("the table reaches the group arm in both directions",
  groupOnly.some((row) => row[5]) && groupOnly.some((row) => !row[5]),
  `${groupOnly.length} group-arm case(s), and a direction is missing — a table that only sees `
  + "the group bits grant cannot tell the group arm from a fallthrough to other");

// The file lifecycle, through the decision the kernel executes.
const decision = vfs.openDecision(ALICE, "/home/alice/notes", {
  create: true, wantW: true, mode: 0o640,
});
note(decision.created);
checkThat("a created file starts with no blob", decision.gen === 0 && decision.size === 0, decision);
checkThat("O_EXCL on an existing name is EEXIST",
  refuses(() => vfs.openDecision(ALICE, "/home/alice/notes", { create: true, excl: true }), "EEXIST"),
  "an exclusive create succeeded over an existing name");
note(vfs.commit(decision.ino, 1, 11));
check("the committed size is published", vfs.stat(ALICE, "/home/alice/notes").size, 11);
check("the blob is named by inode and generation", vfs.blobNames()[0].name,
  blobName(decision.ino, 1));
checkThat("a commit cannot move a generation backwards",
  refuses(() => vfs.commit(decision.ino, 0, 3), "EIO"),
  "an older generation was published over a newer one");

// Links and the MAX_LINKS ceiling, which is the one number a cycle and a long chain share.
note(vfs.link(ALICE, "/home/alice/notes", "/home/alice/second"));
check("a hard link is a second name for one inode", vfs.stat(ALICE, "/home/alice/second").ino,
  decision.ino);
check("nlink counts the names", vfs.stat(ALICE, "/home/alice/notes").nlink, 2);
const firstUnlink = vfs.unlink(ALICE, "/home/alice/second");
note(firstUnlink);
checkThat("unlinking one of two names frees nothing", firstUnlink.freed === null, firstUnlink);
note(vfs.symlink(ALICE, "notes", "/home/alice/link"));
check("a symlink resolves to its target", vfs.stat(ALICE, "/home/alice/link").ino, decision.ino);
check("lstat describes the link itself", vfs.lstat(ALICE, "/home/alice/link").type, "link");
check("realpath resolves the link away", vfs.realpath(ALICE, "/home/alice/link"),
  "/home/alice/notes");
note(vfs.symlink(ALICE, "/home/alice/loop", "/home/alice/loop"));
checkThat("a self-referential symlink is ELOOP, not a hang",
  refuses(() => vfs.stat(ALICE, "/home/alice/loop"), "ELOOP"), "a symlink cycle did not stop");
checkThat("MAX_LINKS is Linux's 40", MAX_LINKS === 40, MAX_LINKS);
checkThat("a name past NAME_MAX is ENAMETOOLONG",
  refuses(() => vfs.mkdir(ALICE, `/home/alice/${"x".repeat(NAME_MAX + 1)}`), "ENAMETOOLONG"),
  "a 256-character component was accepted");
checkThat("a path with a NUL is EINVAL",
  refuses(() => vfs.stat(ALICE, "/home/alice/no\0pe"), "EINVAL"), "a NUL in a path was accepted");
checkThat("rmdir of a non-empty directory is ENOTEMPTY",
  refuses(() => vfs.rmdir(ALICE, "/home/alice"), "ENOTEMPTY"), "a populated directory was removed");
checkThat("rename into one's own subtree is EINVAL",
  refuses(() => vfs.rename(ROOT, "/home", "/home/alice/home"), "EINVAL"),
  "a directory was moved inside itself");

// REPLAY IS THE SAME CODE AS THE WRITER. Every op above, re-applied to the snapshot the writer
// started from, must reproduce the writer's tree exactly. A replay implemented beside the writer
// drifts from it, and this is the assertion that would catch the drift.
const replayed = VFS.parse(base);
let replayFailed = "";
for (const op of log) {
  const { freed, ...record } = op;
  const decoded = decodeOp(encodeOp(record));
  if (!decoded) {
    replayFailed = `an op did not survive encode/decode: ${JSON.stringify(record)}`;
    break;
  }
  try {
    replayed.applyOp(decoded);
  } catch (error) {
    replayFailed = `${record.k} would not re-apply: ${error.message}`;
    break;
  }
}
checkThat("every op survives encode/decode", !replayFailed, replayFailed);
check("replay through applyOp reproduces the writer's tree byte for byte",
  asJson(replayed.serialize()), asJson(vfs.serialize()));

// applyOp REFUSES rather than guessing. fsck's whole job rests on this: an op that cannot be
// applied to this state is corruption to be reported, not a tree to be invented.
checkThat("an op naming a missing directory is refused",
  refuses(() => replayed.applyOp({ k: OP.MKDIR, ino: 900, dir: 8000, name: "x", mode: 0o755,
    uid: 0, gid: 0, t: 1 }), "EIO"), "an op built a directory under an inode that is not there");
checkThat("an op onto an existing name is refused",
  refuses(() => replayed.applyOp({ k: OP.MKDIR, ino: 901, dir: 1, name: "home", mode: 0o755,
    uid: 0, gid: 0, t: 1 }), "EEXIST"), "an op created a second entry under one name");
check("a payload that is not an op decodes to null",
  decodeOp(new TextEncoder().encode('{"k":"nonsense"}')), null);
check("a payload that is not JSON decodes to null",
  decodeOp(new Uint8Array([0xff, 0x00, 0x41])), null);

// VFS.parse refuses what would not hold together. Each of these came back as a plausible tree in
// the predecessor, which is worse than refusing: a mode defaulted to 0644 is a file whose
// permissions were invented, and the 10k-file proof would compare two copies of that invention.
const image = vfs.serialize();
const withoutMode = structured(image, (row) => { delete row.mode; });
checkThat("an inode with no mode is refused, not defaulted",
  refuses(() => VFS.parse(withoutMode), "EIO"), "a missing mode was defaulted");
const dangling = structured(image, null, (data) => {
  data.inodes.find((r) => r.type === "dir" && r.entries.length).entries[0][1] = 7777;
});
checkThat("an entry pointing at a missing inode is refused",
  refuses(() => VFS.parse(dangling), "EIO"), "a dangling directory entry was loaded");
const noRoot = structured(image, null, (data) => { data.rootIno = 9999; });
checkThat("an image with no root is refused", refuses(() => VFS.parse(noRoot), "EIO"),
  "an image with no root directory was loaded");
const futureVersion = structured(image, null, (data) => { data.version = FORMAT_VERSION + 1; });
checkThat("a future format version is refused rather than migrated",
  refuses(() => VFS.parse(futureVersion), "EIO"), "a newer image was guessed at");
const sizeNoBlob = structured(image, null, (data) => {
  const file = data.inodes.find((r) => r.type === "file");
  file.size = 10;
  file.gen = 0;
});
checkThat("a file claiming bytes with no blob generation is refused",
  refuses(() => VFS.parse(sizeNoBlob), "EIO"), "metadata naming no blob was loaded");
checkThat("VFS has no reset(): this filesystem never reseeds (constraint 28)",
  typeof VFS.prototype.reset === "undefined" && typeof VFS.reset === "undefined",
  "a reseed path survived the port from webxp");

// The snapshot image container.
const encoded = encodeImage({ hello: "world", n: 7 });
checkThat("an image round-trips", decodeImage(encoded).object.n === 7, decodeImage(encoded));
check("a short image header is refused", decodeImage(encoded.subarray(0, 4)).why,
  IMAGE_REFUSE.SHORT_HEADER);
const imageBadMagic = encoded.slice(); imageBadMagic[0] ^= 0xff;
check("a bad image magic is refused", decodeImage(imageBadMagic).why, IMAGE_REFUSE.BAD_MAGIC);
const imageBadCrc = encoded.slice(); imageBadCrc[IMAGE_HEADER] ^= 1;
check("a flipped image byte is refused", decodeImage(imageBadCrc).why, IMAGE_REFUSE.BAD_CRC);
const imageBadLen = encoded.slice();
new DataView(imageBadLen.buffer).setUint32(4, MAX_IMAGE + 1, true);
check("an impossible image length is refused before it is used", decodeImage(imageBadLen).why,
  IMAGE_REFUSE.BAD_LENGTH);
check("a short image body is refused", decodeImage(encoded.subarray(0, encoded.length - 2)).why,
  IMAGE_REFUSE.SHORT_BODY);
const imageBadReserved = encoded.slice();
new DataView(imageBadReserved.buffer).setUint32(12, 1, true);
check("a non-zero image reserved word is refused", decodeImage(imageBadReserved).why,
  IMAGE_REFUSE.BAD_RESERVED);

// fsck. The ONE thing it must never do is reseed, and the structural proof is that it holds no
// writer: these assertions are about which verdict it reaches for each volume.
checkThat("fsck writes nothing, by construction",
  fsck({ slots: [null, null, null], journal: null }).wrote === false, "fsck reported a write");
check("an empty volume is FRESH, not corrupt",
  fsck({ slots: [null, null, null], journal: null, blobs: [] }).mountable, MOUNT_FRESH);
check("a volume whose bytes do not decode is REFUSED, never reseeded",
  fsck({ slots: [new Uint8Array(SUPER_BYTES).fill(9), null, null], journal: null }).mountable,
  MOUNT_REFUSE);
// AN ERRNO IS NOT AN ABSENT SLOT, and an empty journal is what makes the confusion fatal: the
// last snapshot truncates it, so on a healthy volume the slots are the only evidence left that
// the volume exists. Read as absent, they make it a FIRST BOOT — the one verdict whose caller is
// allowed to write a superblock.
check("a volume whose slots could not be READ is never FRESH",
  fsck({ slots: [{ errno: 5 }, { errno: 5 }, { errno: 5 }], journal: null }).mountable,
  MOUNT_REFUSE);
checkThat("and the refusal names the errno",
  fsck({ slots: [{ errno: 5 }, null, null], journal: null }).problems.some(
    (p) => p.what === "superblock" && /could not be READ/.test(p.why) && /errno 5/.test(p.why)),
  fsck({ slots: [{ errno: 5 }, null, null], journal: null }).problems);
check("a journal that could not be READ is REFUSED, never replayed as empty",
  fsck({ slots: [null, null, null], journal: { errno: 5 }, blobs: [] }).mountable, MOUNT_REFUSE);
const good = buildVolume(vfs, []);
const cleanReport = fsck(good);
// The same volume with one of its two ABSENT slots refused instead. The chosen slot still decodes,
// so there is a tree to mount — read-only, with the refused read counted as its own thing rather
// than folded into `absentSlots` and reported as a young filesystem.
const oneRefused = fsck({
  ...good,
  slots: good.slots.map((s, i) => (s && s.length ? s : (i === 1 ? { errno: 5 } : s))),
});
checkThat("a volume with one unreadable slot mounts READ-ONLY and names it",
  oneRefused.mountable === MOUNT_RO && oneRefused.problems.some(
    (p) => p.what === "superblock" && /could not be READ/.test(p.why)),
  oneRefused.problems);
checkThat("an unreadable slot is counted apart from an absent and a damaged one",
  oneRefused.superblock.unreadableSlots === 1
  && oneRefused.superblock.damagedSlots === 0
  && oneRefused.superblock.absentSlots === cleanReport.superblock.absentSlots - 1,
  { refused: oneRefused.superblock, clean: cleanReport.superblock });
checkThat("a clean volume mounts read-write",
  cleanReport.mountable === MOUNT_RW && cleanReport.problems.length === 0,
  cleanReport.problems);
checkThat("absent slots are not reported as damaged",
  cleanReport.superblock.absentSlots === 2 && cleanReport.superblock.damagedSlots === 0,
  cleanReport.superblock);
const noBlobs = fsck({ ...good, blobs: [] });
checkThat("metadata pointing at an absent blob mounts READ-ONLY and names it",
  noBlobs.mountable === MOUNT_RO && noBlobs.problems.some((p) => p.what === "blobs"),
  noBlobs.problems);
const shortBlobs = fsck({ ...good, blobs: good.blobs.map((b) => ({ ...b, size: 0 })) });
checkThat("a blob shorter than its metadata mounts READ-ONLY and names it",
  shortBlobs.mountable === MOUNT_RO && shortBlobs.problems.some((p) => p.what === "blobs"),
  shortBlobs.problems);
const staleBlobs = fsck({ ...good, blobs: [...good.blobs, { name: "4242.9", size: 5 }] });
checkThat("a blob no inode points at is RECLAIMABLE, reported apart from corruption",
  staleBlobs.blobs.stale.length === 1 && staleBlobs.blobs.reclaimableBytes === 5,
  staleBlobs.blobs);

// The journal's three tear shapes, and they matter because THREE DIFFERENT GUARDS catch them. The
// browser-side control that removes the CRC must move the second and third and leave the first
// standing; a control that moved all three would not say which guard it removed.
const late = { k: OP.MKDIR, ino: 950, dir: 1, name: "late", mode: 0o755, uid: 0, gid: 0, t: 9 };
const later = { k: OP.MKDIR, ino: 951, dir: 1, name: "later", mode: 0o750, uid: 0, gid: 0, t: 10 };
const journalled = buildVolume(vfs, [late, later]);
checkThat("a whole journal replays and applies every record",
  fsck(journalled).journal.stopped === null && fsck(journalled).journal.applied === 2,
  fsck(journalled).journal);
const cutTail = { ...journalled, journal: journalled.journal.subarray(0, journalled.journal.length - 5) };
check("a truncated tail is caught by the LENGTH check", fsck(cutTail).journal.stopped,
  REFUSE.SHORT_PAYLOAD);
check("and the length check does not depend on the CRC",
  fsck({ ...cutTail, checkCrc: false }).journal.stopped, REFUSE.SHORT_PAYLOAD);
const zeroPadded = { ...journalled, journal: journalled.journal.slice() };
zeroPadded.journal.fill(0, zeroPadded.journal.length - 5);
check("a tail whose block was allocated and not written is caught by the CRC",
  fsck(zeroPadded).journal.stopped, REFUSE.BAD_CRC);
checkThat("with the CRC removed that torn tail is ACCEPTED",
  fsck({ ...zeroPadded, checkCrc: false }).journal.stopped === null,
  "the CRC is not what catches a zero-padded tail, so the control proves nothing");
// ONE DIGIT INSIDE A MODE FIELD. Not an arbitrary byte: the claim is that the CRC is the only
// thing between a flipped bit and a tree whose permissions nobody wrote, and a flip that landed on
// a timestamp would not have shown that. 488 is 0o750; 480 is 0o740.
//
// SEARCHED IN THE BYTES, not in a decoded string. A record's header holds bytes above 0x7F, which
// TextDecoder turns into replacement characters — so a character index is not a byte index, and
// the first version of this flipped the digit one place to the left and made 0630 instead.
const flippedByte = { ...journalled, journal: journalled.journal.slice() };
const modeAt = lastIndexOfBytes(flippedByte.journal, '"mode":488');
checkThat("the corpus holds the mode field the flip is aimed at", modeAt > 0,
  'the journal does not contain "mode":488, so the flip below would prove nothing');
flippedByte.journal[modeAt + 9] = "0".charCodeAt(0);
check("one flipped byte inside a whole record is caught by the CRC",
  fsck(flippedByte).journal.stopped, REFUSE.BAD_CRC);
const silent = fsck({ ...flippedByte, checkCrc: false });
checkThat("with the CRC removed it is accepted, applied, and the volume mounts CLEAN",
  silent.journal.stopped === null && silent.journal.applied === 2 && silent.mountable === MOUNT_RW,
  silent);
checkThat("and the tree comes back with a mode nobody wrote",
  silent.vfs && silent.vfs.stat(ROOT, "/later").mode === 0o740,
  `the flipped digit should make /later 0740; it read ${
    silent.vfs ? silent.vfs.stat(ROOT, "/later").mode.toString(8) : "no tree"}`);
const resequenced = buildVolume(vfs, [late, later], 5n);
checkThat("a journal whose first sequence is not the snapshot's is a GAP, not a short journal",
  fsck(resequenced).journal.stopped === "seq-gap", fsck(resequenced).journal);

/** The last byte offset at which `text`'s ASCII bytes appear in `hay`. A byte search, because a
 *  journal is not text and a character index into its decoded form is not a byte index. */
function lastIndexOfBytes(hay, text) {
  const needle = new TextEncoder().encode(text);
  outer: for (let at = hay.length - needle.length; at >= 0; at -= 1) {
    for (let i = 0; i < needle.length; i += 1) if (hay[at + i] !== needle[i]) continue outer;
    return at;
  }
  return -1;
}

/** Did `fn` refuse with this FsError code? A refusal is the product here, so "it threw" is not
 *  enough — a TypeError would also throw and would mean something entirely different. */
function refuses(fn, code) {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof FsError && error.code === code;
  }
}

/** A deep copy of a serialized image with one field broken, for VFS.parse's refusals. */
function structured(data, perRow, whole) {
  const copy = JSON.parse(JSON.stringify(data));
  if (perRow) for (const row of copy.inodes) perRow(row);
  if (whole) whole(copy);
  return copy;
}

/** A volume as fsck sees it: one superblock slot carrying the image, plus journalled ops. */
function buildVolume(source, ops, firstSeq = 0n) {
  const body = encodeImage({ ...source.serialize(), journalFirstSeq: "0" });
  const counted = source.stats();
  const sb = encodeSuperblock({
    generation: 4, inodeCount: counted.inodes, nextIno: counted.nextIno,
  });
  const slot = new Uint8Array(sb.length + body.length);
  slot.set(sb, 0);
  slot.set(body, sb.length);
  const records = [];
  let seq = firstSeq;
  for (const op of ops) {
    records.push(...encodeRecord(seq, encodeOp(op)));
    seq += 1n;
  }
  return {
    slots: [slot, null, null],
    journal: new Uint8Array(records),
    blobs: source.blobNames().map((b) => ({ name: b.name, size: b.size })),
  };
}

// ---- M3: the mount table -----------------------------------------------------------------
//
// The one defect this table exists to prevent is a LONGEST PREFIX TAKEN ON THE STRING rather than
// on component boundaries, which puts `/usrlocal` inside the `/usr` mount. That reads fine and
// writes to the wrong volume, so the boundary cases below are the subject and the rest is shape.
// Mutating `resolve` to a string-prefix match fails exactly the four labels naming `/usrlocal`
// and `/usrx`, and nothing else — measured, `node bench/fs-fuzz/hosttest.mjs`.
{
  const t = new MountTable();
  const root = t.add("/", { fs: { tag: "opfs" }, type: FS_OPFS });
  const usr = t.add("/usr", { fs: { tag: "usr" }, type: FS_PROVIDER, flags: MNT_RO });
  const tmp = t.add("/tmp", { fs: { tag: "tmp" }, type: FS_TMPFS });
  const proc = t.add("/proc", { fs: { tag: "proc" }, type: FS_PROC });
  const dev = t.add("/dev", { fs: { tag: "dev" }, type: FS_DEV });
  const all = [root, usr, tmp, proc, dev];

  // A device number per mount, distinct and non-zero. encodeFilestat writes `st.dev || 0`, so a
  // zero device and an unset one are the same bytes — which is why DEV_FIRST is 1.
  check("the root mount's device number is DEV_FIRST", root.dev, DEV_FIRST);
  check("every mount has a distinct device number", new Set(all.map((r) => r.dev)).size, all.length);
  checkThat("no mount has device number zero", all.every((r) => r.dev !== 0),
    "a zero device is indistinguishable from a filesystem that never set one");

  // THE SUBJECT.
  check("/usrlocal resolves to the root, not the /usr mount",
    t.resolve("/usrlocal").mount.fs.tag, "opfs");
  check("/usrlocal keeps its whole path", t.resolve("/usrlocal").rel, "/usrlocal");
  check("/usrx/y resolves to the root", t.resolve("/usrx/y").mount.fs.tag, "opfs");
  checkThat("/usrlocal is not read-only", t.readOnlyAt("/usrlocal") === false,
    "a string-prefix match would inherit the /usr mount's read-only flag");

  // Resolution, and the relative path a filesystem actually sees.
  check("/usr resolves to the /usr mount", t.resolve("/usr").mount.fs.tag, "usr");
  check("a mountpoint itself is that mount's root", t.resolve("/usr").rel, "/");
  check("/usr/bin/ls resolves to the /usr mount", t.resolve("/usr/bin/ls").mount.fs.tag, "usr");
  check("a mounted path is relative to its mount", t.resolve("/usr/bin/ls").rel, "/bin/ls");
  check("an unmounted path resolves to the root", t.resolve("/home/a").rel, "/home/a");
  check("/proc/<pid>/fd/<n> is relative to /proc", t.resolve("/proc/7/fd/3").rel, "/7/fd/3");

  // Lexical normalization happens before matching, so `..` can leave a mount.
  check("repeated slashes do not change the mount", t.resolve("//usr//bin").rel, "/bin");
  check("a dot component is dropped", t.resolve("/usr/./bin").rel, "/bin");
  check("a dotdot can enter a mount", t.resolve("/tmp/../usr").mount.fs.tag, "usr");
  check("a dotdot can leave a mount", t.resolve("/usr/..").mount.fs.tag, "opfs");

  // Read-only is a mount property with one renderer.
  checkThat("a read-only mount reports read-only", t.readOnlyAt("/usr/bin/ls"), "/usr is MNT_RO");
  checkThat("a writable mount does not", t.readOnlyAt("/home/a") === false, "/ is rw");

  // A deeper mount wins over a shallower one, and rows() is deepest-first for a umount sweep.
  const nested = new MountTable();
  nested.add("/", { fs: { tag: "r" }, type: FS_OPFS });
  nested.add("/a/b/c", { fs: { tag: "deep" }, type: FS_TMPFS });
  nested.add("/a", { fs: { tag: "shallow" }, type: FS_TMPFS });
  check("rows() is deepest-first", nested.rows().map((r) => r.path), ["/a/b/c", "/a", "/"]);
  check("the deepest mount wins", nested.resolve("/a/b/c/d").mount.fs.tag, "deep");
  check("a path above it takes the shallower mount", nested.resolve("/a/b").mount.fs.tag, "shallow");

  // Refusals, each named rather than collapsed. An errno becoming a benign default is this
  // codebase's recurring bug, so every one of these asserts the CODE.
  const code = (fn) => { try { fn(); return "<no throw>"; } catch (e) { return e.code; } };
  check("a relative path cannot be resolved", code(() => t.resolve("usr/bin")), "EINVAL");
  check("a non-string path cannot be resolved", code(() => t.resolve(null)), "EINVAL");
  check("a duplicate mountpoint is EBUSY",
    code(() => t.add("/usr", { fs: {}, type: FS_TMPFS })), "EBUSY");
  check("an unknown filesystem type is ENODEV",
    code(() => t.add("/x", { fs: {}, type: "ntfs" })), "ENODEV");
  check("a relative mountpoint is EINVAL",
    code(() => t.add("rel", { fs: {}, type: FS_TMPFS })), "EINVAL");
  check("a mount with no filesystem is EINVAL",
    code(() => t.add("/y", { fs: null, type: FS_TMPFS })), "EINVAL");

  // docs/ABI.md: "`/` always OPFS". An invariant, not a comment.
  const bare = new MountTable();
  check("the root mount must be opfs",
    code(() => bare.add("/", { fs: {}, type: FS_TMPFS })), "EINVAL");
  check("nothing mounts before the root",
    code(() => bare.add("/usr", { fs: {}, type: FS_TMPFS })), "EINVAL");
  check("resolution without a root is EINVAL", code(() => bare.resolve("/a")), "EINVAL");

  check("the table counts its mounts", t.size, 5);
  check("at() is an exact lookup, not resolution", t.at("/usr").dev, usr.dev);
  check("at() misses a path that is not a mountpoint", t.at("/nope"), undefined);
  checkThat("a mount row is frozen", Object.isFrozen(root),
    "a mutable row would let a caller clear the read-only flag it was refused by");
  // Every code this module raises must have an errno, or it reaches a process as -EIO and loses
  // the reason. FS_CODES is the VFS's table; ENODEV was added to it for `mount`.
  for (const c of ["EINVAL", "EBUSY", "ENODEV"]) {
    checkThat(`${c} is a known fs code with an errno`,
      FS_CODES.includes(c) && typeof E[c] === "number", `${c} would reach a process as EIO`);
  }
}

const failed = results.filter((r) => !r.ok);
// BigInt is not JSON-serialisable, and the codecs return BigInt for every 64-bit field on
// purpose: a u64 inode number or generation counter silently losing precision as a double is the
// defect that would be hardest to find later. Rendered as decimal strings only at the boundary.
const bigs = (_k, v) => (typeof v === "bigint" ? String(v) : v);
console.log(JSON.stringify({
  ok: failed.length === 0, total: results.length, failed: failed.length,
  failures: failed, names: results.map((r) => r.name),
}, bigs, 2));
process.exit(failed.length === 0 ? 0 : 1);
