// A hand-run smoke of the ported VFS, replay and fsck under plain Node. Not the gate — that is
// bench/fs-fuzz/hosttest.mjs, which scripts/fsfuzz.py runs and scores. This exists so a change to
// the port can be exercised in one second without a browser.
//
//     node bench/fs-core/smoke.mjs

import { VFS, OP, encodeOp, decodeOp } from "../../src/fs/vfs.mjs";
import { encodeImage } from "../../src/fs/image.mjs";
import { encodeSuperblock } from "../../src/fs/superblock.mjs";
import { encodeRecord } from "../../src/fs/journal.mjs";
import { fsck } from "../../src/fs/fsck.mjs";

let t = 0;
const root = { uid: 0, gid: 0 };
const alice = { uid: 1000, gid: 1000 };
const bob = { uid: 1001, gid: 1001 };
const fs = new VFS({ owner: root, now: () => ++t });
// The bare-root image, taken before any op. Replay below starts here.
const base = fs.serialize();
const ops = [];
const j = (op) => {
  if (op) ops.push(op);
  return op;
};

j(fs.mkdir(root, "/home", { mode: 0o755 }));
j(fs.mkdir(root, "/home/alice", { mode: 0o700 }));
j(fs.chown(root, "/home/alice", 1000, 1000));
const made = j(fs.openDecision(alice, "/home/alice/notes.txt",
  { create: true, wantW: true, mode: 0o640 }).created);
j(fs.commit(made.ino, 1, 11));
console.log("stat", JSON.stringify(fs.stat(alice, "/home/alice/notes.txt")));
try {
  fs.stat(bob, "/home/alice/notes.txt");
  console.log("BAD: bob resolved a path through a 0700 directory he does not own");
} catch (e) {
  console.log("bob refused:", e.code, e.message);
}
j(fs.symlink(alice, "notes.txt", "/home/alice/link"));
console.log("via link", fs.stat(alice, "/home/alice/link").ino);
console.log("realpath", fs.realpath(alice, "/home/alice/link"));
j(fs.link(alice, "/home/alice/notes.txt", "/home/alice/hard"));
console.log("nlink", fs.stat(alice, "/home/alice/notes.txt").nlink);
console.log("freed after one of two links:", j(fs.unlink(alice, "/home/alice/hard")).freed);
console.log("blobNames", JSON.stringify(fs.blobNames()));

// Replay starts from a SNAPSHOT, which is what the real boot path does: the bare root belongs to
// the image, not to a constructor the replaying kernel never ran.
const fresh = VFS.parse(base);
for (const op of ops) {
  const { freed, ...record } = op;
  fresh.applyOp(decodeOp(encodeOp(record)));
}
const left = JSON.stringify(fs.serialize());
const right = JSON.stringify(fresh.serialize());
console.log("replay through applyOp reproduces the tree:", left === right);
if (left !== right) {
  console.log("  live  ", left);
  console.log("  replay", right);
}

function volume(vfs, journalOps, firstSeq = 0, extra = {}) {
  const image = encodeImage({ ...vfs.serialize(), journalFirstSeq: String(firstSeq) });
  const counted = vfs.stats();
  const sb = encodeSuperblock({
    generation: 3, inodeCount: counted.inodes, nextIno: counted.nextIno,
  });
  const slot = new Uint8Array(sb.length + image.length);
  slot.set(sb, 0);
  slot.set(image, sb.length);
  const records = [];
  let seq = BigInt(firstSeq);
  for (const op of journalOps) {
    records.push(...encodeRecord(seq, encodeOp(op)));
    seq += 1n;
  }
  return { slots: [slot, null, null], journal: new Uint8Array(records), ...extra };
}

const snapshot = VFS.parse(base);
for (const op of ops) {
  const { freed, ...record } = op;
  snapshot.applyOp(record);
}
const present = snapshot.blobNames().map((b) => ({ name: b.name, size: b.size }));
const clean = fsck(volume(snapshot, [], 0, { blobs: present }));
console.log("clean volume ->", clean.mountable, JSON.stringify(clean.problems));
console.log("missing blob ->", fsck(volume(snapshot, [], 0, { blobs: [] })).mountable);
console.log("short blob ->",
  fsck(volume(snapshot, [], 0, { blobs: present.map((b) => ({ ...b, size: 1 })) })).mountable);

// THE THREE TEAR SHAPES, and they are three because they are caught by three different guards.
// The negative control that removes the CRC must move the second and third and leave the first
// standing — a control that moved all three would not say which guard it removed.
const first = { k: OP.MKDIR, ino: 90, dir: 1, name: "one", mode: 0o755, uid: 0, gid: 0, t: 1 };
const second = { k: OP.MKDIR, ino: 91, dir: 1, name: "two", mode: 0o750, uid: 0, gid: 0, t: 2 };

// (b1) A plain truncation. The LENGTH check catches it; the CRC never runs.
const cut = volume(snapshot, [first, second], 0, { blobs: present });
cut.journal = cut.journal.subarray(0, cut.journal.length - 5);
console.log("b1 truncated        ->", JSON.stringify(fsck(cut).journal.stopped),
  "records", fsck(cut).journal.records);
console.log("b1 truncated, no CRC->", JSON.stringify(fsck({ ...cut, checkCrc: false })
  .journal.stopped));

// (b2) Truncated and ZERO-PADDED back to the record's own length: the block was allocated and
// not written, which is what a torn append leaves. The length checks out; only the CRC does not.
const padded = volume(snapshot, [first, second], 0, { blobs: present });
const whole = padded.journal.slice();
whole.fill(0, whole.length - 5);
padded.journal = whole;
console.log("b2 zero-padded      ->", JSON.stringify(fsck(padded).journal.stopped),
  "records", fsck(padded).journal.records);
const b2NoCrc = fsck({ ...padded, checkCrc: false });
console.log("b2 zero-padded,noCRC->", JSON.stringify(b2NoCrc.journal.stopped),
  "records", b2NoCrc.journal.records, "problems",
  b2NoCrc.problems.map((x) => x.what).join(","));

// (b3) ONE FLIPPED DIGIT inside a whole record's payload, turning mode 0o750 into 0o710. Every
// length is right and the record applies cleanly; the CRC is the only thing between this and a
// tree that comes back with a permission nobody wrote.
const flipped = volume(snapshot, [first, second], 0, { blobs: present });
// Searched in the BYTES. A record's header holds bytes above 0x7F, which TextDecoder turns into
// replacement characters, so a character index into the decoded form is not a byte index.
const bytes = flipped.journal.slice();
const at = lastIndexOfBytes(bytes, '"mode":488');
bytes[at + 9] = "0".charCodeAt(0);              // 488 (0o750) -> 480 (0o740)
flipped.journal = bytes;
console.log("b3 flipped digit    ->", JSON.stringify(fsck(flipped).journal.stopped),
  "records", fsck(flipped).journal.records);
const b3NoCrc = fsck({ ...flipped, checkCrc: false });
const victim = b3NoCrc.vfs ? b3NoCrc.vfs.stats() : null;
console.log("b3 flipped, no CRC  ->", JSON.stringify(b3NoCrc.journal.stopped),
  "records", b3NoCrc.journal.records, "applied", b3NoCrc.journal.applied,
  "mountable", b3NoCrc.mountable,
  "mode of 'two' ->", b3NoCrc.vfs
    ? b3NoCrc.vfs.stat({ uid: 0, gid: 0 }, "/two").mode.toString(8) : "n/a",
  victim ? `inodes ${victim.inodes}` : "");
console.log("empty volume ->", fsck({ slots: [null, null, null], journal: null }).mountable);
console.log("garbage volume ->",
  fsck({ slots: [new Uint8Array(64).fill(7), null, null], journal: null }).mountable);

/** The last byte offset at which `text`'s ASCII bytes appear in `hay`. */
function lastIndexOfBytes(hay, text) {
  const needle = new TextEncoder().encode(text);
  outer: for (let at = hay.length - needle.length; at >= 0; at -= 1) {
    for (let i = 0; i < needle.length; i += 1) if (hay[at + i] !== needle[i]) continue outer;
    return at;
  }
  return -1;
}
