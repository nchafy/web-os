// THE SESSION'S TREE: the read-only base copied into the writable volume ONCE (D40).
//
// `/usr` is `FS_PROVIDER` with `MNT_RO` and `mutErrno: "EROFS"`, which is what it already
// resembles: install media. This module makes a WRITABLE copy of it, so a session has a tree every
// verb can reach and nothing a reader meets is read-only. It runs on a FRESH volume and on no
// other.
//
// CONSTRAINT 28 IS THE WHOLE DIFFICULTY. "A bad superblock mounts read-only and reports. It never
// reseeds. webxp reseeds; that is the defect being fixed, and it is silent data loss presented as
// success." Seeding a fresh volume is not reseeding — `Store.mount` already writes an initial
// superblock on one — but a SECOND copy over a reader's edited tree is that defect through a new
// door. So `maySeed` is three conjuncts, one per failure world it has to tell apart, and
// `bench/m19a-seed/probe.mjs` scores that expression against all six worlds under plain Node.
//
// THE COPY IS NOT VISIBLE UNTIL IT IS COMPLETE. Every file lands under `SEED_STAGING` and the last
// act is ONE rename onto `SEED_DEST`, which is one journal record: a reader's tree either is the
// whole base or does not exist. A copy that refuses part way is rolled back in the same boot, and a
// page killed mid-copy leaves the staging name — which the next boot finds, reports and does not
// touch, because that volume is no longer fresh and nothing here may write over it.

import { MAX_INLINE, EIO } from "../abi.mjs";
import { DIR, FILE } from "../fs/vfs.mjs";
import { MOUNT_FRESH, MOUNT_RW, errnoOfFsError } from "./store.mjs";

/**
 * WHERE THE SESSION'S COPY LIVES.
 *
 * `docs/PLAN-SHELL.md` §7.3 proposed `/desktop`, which predates D40: with the whole base copied, a
 * home-shaped tree is expressible and a bare `/desktop` is not one. This is a Windows 7 surface, so
 * the shape is `C:\Users\<name>` — and the name is `Default` because there is no account database
 * here. Every process runs as uid 0 and `src/abi.mjs` has no user table, so a directory named after
 * a user would be an account this system cannot name; `Default` is Windows 7's own name for the
 * profile a fresh install has.
 *
 * ONE CONSTANT, and a program must not restate it. The kernel publishes it in the boot report
 * (`fsState().seed.dest`), which is the only route a process has to it: a process may not import
 * kernel code, so the shell reads the path it was told rather than carrying a second copy.
 *
 * THE SHELL STILL RESTATES THREE PATHS THAT ARE THIS ONE: `DEFAULT_DIR = "/usr/share"` in
 * `src/bin/files.mjs`, and `DESK_DIR = "/desktop"` plus the `["files", "/usr/share"]` launcher row
 * in `src/bin/desktop.mjs`. `/desktop` is §7.3's proposal and the desktop process `mkdir`s it for
 * itself, so until those three read the published destination the session's tree is seeded and
 * nothing points a reader at it. Nothing here creates a `Desktop` subdirectory: the seed copies the
 * base and invents nothing, and which directory the shell treats as the desktop is the shell's.
 */
export const SEED_DEST = "/Users/Default";

/**
 * The name the copy is built under. DERIVED from `SEED_DEST`, because the two are one fact: the
 * seed's last act renames this onto that, and a hand-written pair is how a staging directory comes
 * to be left behind under a name nothing looks for.
 */
export const SEED_STAGING = (() => {
  const cut = SEED_DEST.lastIndexOf("/");
  return `${SEED_DEST.slice(0, cut)}/.${SEED_DEST.slice(cut + 1)}.partial`;
})();

/**
 * The I/O worker's view id for the seed's own buffer. NEGATIVE for the reason `EXEC_VIEW_ID` is
 * (`src/kernel/exec.mjs`): `src/kernel/iocore.mjs` keys registered SABs by pid and pids are
 * monotonic from 1, so no process can name this buffer and a seed write cannot land in a process's
 * byte region. -1 is the loader's.
 */
export const SEED_VIEW_ID = -2;

/** One write's payload. `MAX_INLINE` is the largest buffer this ABI agrees on, so the seed pays
 *  what a process's `write(2)` pays rather than inventing a chunk size of its own. */
export const SEED_CHUNK = MAX_INLINE;

/**
 * How deep a base may be. The manifest is a frozen table in this repository
 * (`USR_ENTRIES`), so the real depth is 2 — this is here because a walk with no floor under a
 * provider that grew a cycle is a boot that never finishes and says nothing.
 */
const MAX_DEPTH = 16;

/** The seed's credential, passed on every path call rather than held as state (constraint 29).
 *  Root, because this runs inside the kernel before any process exists — and it is also who the
 *  copy belongs to, which is what the mode note in the file loop is about. */
const CRED = { uid: 0, gid: 0 };

/**
 * THE GATE, and it is one expression because a second copy of it is constraint 28's defect.
 * `bench/m19a-seed/probe.mjs` drives the real `Store` through six worlds and scores this:
 *
 *   `report.mountable === MOUNT_FRESH` — the volume had NO bytes. Not implied by `mode`: after a
 *     successful fresh mount `mode` is `rw`, exactly as it is for a populated volume.
 *   `mode === MOUNT_RW` — the initial superblock landed. Not implied by `report.mountable`:
 *     `Store.mount` OVERWRITES that field to `MOUNT_RO` on two fresh-volume paths (an unreadable
 *     blob directory, so the staging floor is unknown; and a refused initial superblock write), and
 *     the measured `floor-unknown` world has `vfs` set with both fields `ro`.
 *   `vfs` — there is a tree to copy into. The boot-lock arm returns a report with no VFS at all.
 *
 * `!store.readOnly` is the expression a reader reaches for first and it is TRUE on a populated
 * volume; `probe.mjs --control` seeds one with it.
 */
export function maySeed(store) {
  return !!store && store.report !== null
    && store.report.mountable === MOUNT_FRESH
    && store.mode === MOUNT_RW
    && !!store.vfs;
}

/**
 * The tail of a metadata mutation: the op the VFS has already applied, journalled, and the inode
 * whose last link went reclaimed AFTER the record is durable — a blob deleted ahead of the record
 * that unlinks it reappears after replay with nothing behind it (constraint 60).
 *
 * Exported because the kernel's mountpoint creation is its other caller. `metaOp` in
 * `src/kernel/calls.mjs` is the third and still carries its own copy.
 */
export async function journalMeta(store, op) {
  // `null` is a legal no-op: rename of a name onto itself.
  if (op === null) return 0;
  // `freed` is an instruction to the store, not a field of the record; journalling it would write
  // a record no replay understands.
  const { freed, ...record } = op;
  const r = await store.journal(record);
  if (r < 0) return r;
  if (freed) await store.freeInode(freed);
  return 0;
}

/** Every ancestor of `path`, shallowest first: `/Users/Default` needs `/Users` to exist. */
function ancestorsOf(path) {
  const parts = path.split("/").filter((s) => s.length);
  const out = [];
  for (let i = 1; i < parts.length; i += 1) out.push(`/${parts.slice(0, i).join("/")}`);
  return out;
}

/**
 * The base's directories (parent first) and its files, out of the mounted provider.
 *
 * THE WHOLE BASE, not the data part of it, and the argument is content rather than fidelity.
 * `/usr/share` is three files and about a kilobyte — a file manager with three 150-byte rows in it
 * is a file manager nothing can be measured on, and M20's copy, paste, delete and rename all need
 * a tree with real sizes and a real count. The base is the only real content this system has: 39
 * files, 623,827 bytes, largest 177,933 (`include/abi.mjs`), which is big enough that a copy of it
 * is visible. The owner's words are "a copy of the read only base", and install media holds the
 * programs as well as the data.
 *
 * WHAT COPYING `bin/` DOES NOT DO: it does not give the shell a second program directory. `/usr`
 * stays mounted and `src/bin/desktop.mjs`'s start menu is a listing of `/usr/bin` — the copy is a
 * reader's to rename and delete, which is the whole of D40. The cost D40 names is real and is not a
 * defect: a program added to the manifest after a volume was seeded is in the base and absent from
 * the copy, which is what every installed system does.
 *
 * `fs` is the `SynthFS` a provider mount is made of (`src/kernel/providerfs.mjs`): its bytes were
 * read in full at mount, so a walk here reaches no network and no OPFS. Anything that is neither a
 * directory nor a regular file is COUNTED, never skipped silently.
 */
function walkBase(fs, rel, depth, found) {
  if (depth > MAX_DEPTH) {
    found.tooDeep.push(rel);
    return;
  }
  for (const entry of fs.listRel(rel)) {
    const child = rel === "/" ? `/${entry.name}` : `${rel}/${entry.name}`;
    if (entry.type === DIR) {
      found.dirs.push(child);
      walkBase(fs, child, depth + 1, found);
    } else if (entry.type === FILE) {
      found.files.push(child);
    } else {
      found.skipped.push(child);
    }
  }
}

/**
 * THE COPY. `store` is the writable volume, `fs` the base's filesystem, `label` the base's
 * mountpoint for the report, `view` a `Uint8Array` over the SAB registered under `SEED_VIEW_ID`.
 *
 * Returns the report `fsState()` publishes. It never throws: a seed that failed is a fact a reader
 * must be told at boot, and a throw out of here would take the boot with it.
 *
 * `ran` is whether the copy landed and `why` is the one reason field. `ran: false` with a `why` is
 * a seed that did not happen; `ran: true` WITH a `why` is the one in-between state — the tree is
 * published and journalled and something after it refused, which is a different thing to be told.
 *
 * WHAT A REFUSAL COSTS, stated because nothing can undo it: freshness is spent by `Store.mount`
 * writing the initial superblock, not by this function, so a volume whose first boot found no base
 * to copy is never fresh again and never gets a session tree. The alternative — seeding whenever
 * `SEED_DEST` is absent — is constraint 28's defect exactly: it copies back over a reader who
 * deleted it.
 */
export async function seedVolume({ store, fs, label, view, note = () => {} }) {
  const began = Date.now();
  const report = {
    ran: false, why: "", dest: SEED_DEST, staging: SEED_STAGING, base: label,
    dirs: 0, files: 0, bytes: 0, chunks: 0, ms: 0,
    rolledBack: null, partial: null,
  };

  if (!maySeed(store)) {
    // The field, not a description of it: a reader comparing two volumes needs to know WHICH
    // conjunct refused.
    const mountable = store && store.report ? store.report.mountable : null;
    // "not a fresh read-write mount" rather than "not fresh": one of the three worlds this refuses
    // IS fresh and could not come up read-write, and a message that called it populated would send
    // a reader looking for a tree that is not there.
    report.why = "this is not a fresh read-write mount "
      + `(mountable=${mountable}, mode=${store && store.mode}, vfs=${!!(store && store.vfs)})`;
    // A VOLUME THAT EXISTS MAY STILL CARRY A HALF-COPY, from a page killed mid-seed. It is
    // REPORTED and NOT touched: this volume is not fresh, and removing a tree the reader did not
    // ask to lose is the silent data loss constraint 28 is about, arriving as a tidy-up.
    if (store && store.vfs && store.vfs.exists(CRED, SEED_STAGING)) {
      report.partial = SEED_STAGING;
      note(`${SEED_STAGING} is a seed that did not finish; ${SEED_DEST} was never created. This `
        + "volume is not fresh, so nothing here will copy over it or remove it");
    }
    report.ms = Date.now() - began;
    return report;
  }
  if (!fs) {
    report.why = `there is no base to copy: ${label} is not mounted`;
    report.ms = Date.now() - began;
    return report;
  }

  const found = { dirs: [], files: [], skipped: [], tooDeep: [] };
  try {
    walkBase(fs, "/", 1, found);
  } catch (error) {
    report.why = `the base could not be walked: ${String((error && error.message) || error)}`;
    report.ms = Date.now() - began;
    note(report.why);
    return report;
  }
  if (found.tooDeep.length || found.skipped.length) {
    report.why = `the base holds ${found.skipped.length} entr(ies) that are neither a directory `
      + `nor a file and ${found.tooDeep.length} deeper than ${MAX_DEPTH}`;
    report.ms = Date.now() - began;
    note(report.why);
    return report;
  }

  /** What this run created, in order. The rollback walks it backwards. */
  const made = [];
  const fail = async (why) => {
    report.why = why;
    note(`the session's copy of ${label} failed and was rolled back: ${why}`);
    report.rolledBack = await rollBack(store, made, note);
    if (report.rolledBack.left.length) report.partial = SEED_STAGING;
    report.ms = Date.now() - began;
    return report;
  };

  // The destination's parents, then the staging root, then the base's own directories under it.
  // `SEED_DEST` itself is NOT created: the rename makes it, which is what makes its appearance the
  // signal that the copy is whole.
  for (const dir of [...ancestorsOf(SEED_DEST), SEED_STAGING]) {
    const r = await mkdirAt(store, dir, 0o755, made);
    if (r < 0) return fail(`mkdir ${dir}: errno ${-r}`);
  }
  for (const dir of found.dirs) {
    const r = await mkdirAt(store, `${SEED_STAGING}${dir}`, 0o755, made);
    if (r < 0) return fail(`mkdir ${SEED_STAGING}${dir}: errno ${-r}`);
  }

  for (const source of found.files) {
    let bytes;
    let mode;
    try {
      bytes = fs.bytesAt(source);
      mode = fs.lstat(CRED, source).mode;
    } catch (error) {
      return fail(`read ${label}${source}: ${String((error && error.message) || error)}`);
    }
    const path = `${SEED_STAGING}${source}`;
    // THE OWNER WRITE BIT IS ADDED. The base's modes are 0o555 for a program and 0o444 for a data
    // file, and a copy that kept them would be unmodifiable by its mode where the base was
    // unmodifiable by its mount — the same refusal through a different door, which is the whole
    // thing D40 removes. The X bit is the source's, so a copied program is still a program.
    //
    // THE OWNER'S BIT IS ENOUGH ONLY BECAUSE THERE IS ONE IDENTITY. The copy is owned by uid 0
    // (`CRED`) and `www/pagekernel.mjs` spawns every process as uid 0, so owner-write is the bit
    // that answers. The day a process runs as anyone else, a 0o644 root-owned copy answers EACCES
    // to the reader it was made for — then this has to chown to the session's uid, not widen.
    const written = await copyFile(store, path, bytes, mode | 0o200, view, made);
    if (written < 0) return fail(`copy ${label}${source}: errno ${-written}`);
    report.bytes += bytes.length;
    report.chunks += written;
    report.files += 1;
  }
  report.dirs = made.filter((m) => m.dir).length;

  // THE ONE OP THAT MAKES THE COPY VISIBLE.
  let renamed;
  try {
    renamed = store.vfs.rename(CRED, SEED_STAGING, SEED_DEST);
  } catch (error) {
    return fail(`rename ${SEED_STAGING} -> ${SEED_DEST}: errno ${-errnoOfFsError(error)}`);
  }
  const jr = await journalMeta(store, renamed);
  if (jr < 0) return fail(`journal the rename onto ${SEED_DEST}: errno ${-jr}`);

  // A snapshot, so the next boot mounts the seeded tree from a slot rather than replaying every
  // record of the copy. One of constraint 23's three flush points, and the only one taken here:
  // per-file `fsync` costs 95 ms of the measured 208-248 and buys no durability a `close` has not
  // already taken (`close` commits, and a commit flushes the blob it publishes).
  const snap = await store.writeSnapshot();
  if (snap < 0) {
    // The tree is published and in the journal; only the slot is behind. Reported, not undone:
    // rolling back 39 journalled files to correct a superblock write would be a bigger write.
    note(`the session's copy of ${label} is journalled but its snapshot refused (errno ${-snap})`);
    report.why = `the snapshot after the copy refused: errno ${-snap}`;
  }

  report.ran = true;
  report.ms = Date.now() - began;
  return report;
}

/** One directory, applied then journalled, recorded for the rollback. */
async function mkdirAt(store, path, mode, made) {
  if (store.vfs.exists(CRED, path)) return 0;
  let op;
  try {
    op = store.vfs.mkdir(CRED, path, { mode });
  } catch (error) {
    return errnoOfFsError(error);
  }
  made.push({ dir: true, path });
  return journalMeta(store, op);
}

/**
 * One file: created O_EXCL, written in `SEED_CHUNK` chunks through the registered buffer, closed.
 * Returns the chunk count, or a negative errno.
 *
 * EXCL AND NEVER TRUNC. A seed that silently overwrote an existing file is the second copy
 * constraint 28 forbids; EEXIST here must stop the run, and `O_TRUNC` would hide it.
 *
 * THE PER-FILE COST IS IN THE FIRST WRITE, NOT THE OPEN, and the plain reading of constraint 22
 * gets that backwards for a copy: `openFd` on a file this call just created resolves at generation
 * 0, so no `IO_BLOB_OPEN` is taken and `copyUp` creates the handle on the first write instead.
 * Measured over the base: open 0.21 ms mean, first write 2.72 ms mean (max 8.39), later chunks
 * 0.14 ms (`bench/m19a-seed/probe.py`).
 */
async function copyFile(store, path, bytes, mode, view, made) {
  let decision;
  try {
    decision = store.vfs.openDecision(CRED, path, {
      create: true, excl: true, wantW: true, mode,
    });
  } catch (error) {
    return errnoOfFsError(error);
  }
  // The CREATE is already applied in memory, so the file counts as made whether or not its record
  // or its bytes land: the rollback has to be able to remove it.
  made.push({ dir: false, path });
  const created = await journalMeta(store, decision.created);
  if (created < 0) return created;

  const d = await store.openFd(decision);
  if (typeof d === "number") return d;
  // The fields `Store` expects on a description it did not finish building; no fd is installed.
  d.refs = 1;
  d.pos = 0;
  d.flags = 0;
  let chunks = 0;
  let failed = 0;
  for (let at = 0; at < bytes.length; at += SEED_CHUNK) {
    const n = Math.min(SEED_CHUNK, bytes.length - at);
    view.set(bytes.subarray(at, at + n), 0);
    // POSITIONAL, so the description's cursor is never consulted.
    const w = await store.writeFd(d, SEED_VIEW_ID, 0, n, at);
    chunks += 1;
    if (w < 0) { failed = w; break; }
    if (w !== n) {
      // A short write is not an errno and must not pass as one: the file would be published at a
      // size its bytes do not reach. `EIO` comes from `src/abi.mjs`'s table — this ABI's numbers
      // are not Linux's, so a literal here would be wrong about this system.
      failed = -EIO;
      break;
    }
  }
  // CLOSED ON BOTH PATHS. `closeFd` publishes the generation — which is why there is no `fsync`
  // here — and a leaked sync access handle is an EXCLUSIVE LOCK that makes the file unopenable by
  // any process for the life of the page.
  const closed = await store.closeFd(d);
  if (failed < 0) return failed;
  if (closed < 0) return closed;
  return chunks;
}

/**
 * Everything this run created, removed newest first, so a refused copy leaves no half-tree claiming
 * to be a session. `left` is what could not be removed — reported rather than swallowed, because an
 * error path that names nothing is a defect.
 */
async function rollBack(store, made, note) {
  const out = { files: 0, dirs: 0, left: [] };
  for (let i = made.length - 1; i >= 0; i -= 1) {
    const { dir, path } = made[i];
    try {
      const op = dir ? store.vfs.rmdir(CRED, path) : store.vfs.unlink(CRED, path);
      const r = await journalMeta(store, op);
      if (r < 0) {
        out.left.push({ path, why: `journal errno ${-r}` });
        continue;
      }
      if (dir) out.dirs += 1; else out.files += 1;
    } catch (error) {
      out.left.push({ path, why: String((error && error.message) || error) });
    }
  }
  if (out.left.length) {
    note(`${out.left.length} path(s) of a failed seed could not be removed, so ${SEED_STAGING} `
      + `is still on the volume: ${out.left.map((e) => e.path).join(", ")}`);
  }
  return out;
}
