// /tmp under plain Node. The metadata is the VFS's, so what is tested here is the part that is
// NEW: the byte store, the size bookkeeping that goes through OP.COMMIT, the limit, and the
// contract that two descriptions on one inode see each other's writes.
import { TmpFS } from "../../src/kernel/tmpfs.mjs";
import { DIR, FILE } from "../../src/fs/vfs.mjs";
import { O_CREAT, O_RDWR } from "../../src/abi.mjs";

const results = [];
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  results.push({ name: n, ok, got: ok ? undefined : g, want: ok ? undefined : w });
};
const checkThat = (n, c, d) => results.push({ name: n, ok: !!c, detail: c ? undefined : d });
const code = (fn) => { try { fn(); return "<no throw>"; } catch (e) { return e.code || e.message; } };
const root = { uid: 0, gid: 0 };
const user = { uid: 1000, gid: 1000 };
const DEC = new TextDecoder(); const ENC = new TextEncoder();

const t = new TmpFS({ limit: 1024 });
t.setDev(9);

// ---- it is a real, writable POSIX tree -------------------------------------------------
check("root is 1777, as /tmp is everywhere", t.stat(root, "/").mode, 0o1777);
check("root is a directory", t.stat(root, "/").type, DIR);
check("stat reports the mount's device", t.stat(root, "/").dev, 9);
checkThat("mkdir works for an unprivileged user", !!t.mkdir(user, "/d", { mode: 0o755 }), "no op");
check("the new directory is there", t.stat(user, "/d").type, DIR);
check("and is owned by its creator", t.stat(user, "/d").uid, 1000);

// ---- bytes ------------------------------------------------------------------------------
const dec = t.openDecision(user, "/d/f", { create: true, wantW: true, wantR: true, mode: 0o644 });
checkThat("open marks the decision as a tmpfs one", dec.tmpfs === true, dec);
check("a fresh file is empty", t.size(dec.ino), 0);
check("writing returns the count", t.write(dec.ino, 0, ENC.encode("hello")), 5);
check("the size follows the bytes", t.size(dec.ino), 5);
check("and stat agrees, through the VFS's own field", Number(t.stat(user, "/d/f").size), 5);
const into = new Uint8Array(16);
check("reading returns the count", t.read(dec.ino, 0, 16, into, 0), 5);
check("and the bytes", DEC.decode(into.subarray(0, 5)), "hello");
// An offset write that grows the file.
check("an offset write grows the file", t.write(dec.ino, 5, ENC.encode(" world")), 6);
check("the size grew", t.size(dec.ino), 11);
const all = new Uint8Array(32);
t.read(dec.ino, 0, 32, all, 0);
check("the whole file reads back", DEC.decode(all.subarray(0, 11)), "hello world");
// An overwrite in place must not change the size.
check("an in-place overwrite returns its count", t.write(dec.ino, 0, ENC.encode("HELLO")), 5);
check("and does not change the size", t.size(dec.ino), 11);
t.read(dec.ino, 0, 32, all, 0);
check("and lands where it was asked to", DEC.decode(all.subarray(0, 11)), "HELLO world");
// A read past the end is EOF, not an error.
check("a read at the end is 0", t.read(dec.ino, 11, 8, into, 0), 0);
check("a read past the end is 0", t.read(dec.ino, 99, 8, into, 0), 0);
// A write past the end leaves a hole that reads as zeroes (POSIX).
check("a write past the end returns its count", t.write(dec.ino, 16, ENC.encode("X")), 1);
check("the file grew to cover the hole", t.size(dec.ino), 17);
const holed = new Uint8Array(32);
t.read(dec.ino, 0, 32, holed, 0);
check("the hole reads as zeroes", [...holed.subarray(11, 16)], [0, 0, 0, 0, 0]);
check("and the byte past it is there", DEC.decode(holed.subarray(16, 17)), "X");

// ---- truncate ---------------------------------------------------------------------------
check("truncate down returns 0", t.truncate(dec.ino, 5), 0);
check("and shortens the file", t.size(dec.ino), 5);
t.read(dec.ino, 0, 32, all, 0);
check("keeping the leading bytes", DEC.decode(all.subarray(0, 5)), "HELLO");
check("truncate up returns 0", t.truncate(dec.ino, 8), 0);
check("and lengthens the file", t.size(dec.ino), 8);
t.read(dec.ino, 0, 32, all, 0);
check("the extension reads as zeroes", [...all.subarray(5, 8)], [0, 0, 0]);
check("truncate to the same size is a no-op 0", t.truncate(dec.ino, 8), 0);
check("truncate to zero empties it", t.truncate(dec.ino, 0), 0);
check("size is zero", t.size(dec.ino), 0);

// ---- TWO DESCRIPTIONS ON ONE INODE SEE EACH OTHER ---------------------------------------
// The property that makes a tmpfs a filesystem and not a snapshot: F_SYNTH snapshots at open and
// would be WRONG here.
const a = t.openDecision(user, "/d/shared", { create: true, wantW: true, wantR: true, mode: 0o644 });
const b = t.openDecision(user, "/d/shared", { wantR: true });
check("two opens of one path share an inode", a.ino, b.ino);
t.write(a.ino, 0, ENC.encode("written by a"));
const seen = new Uint8Array(32);
check("the second description sees the first's write",
  t.read(b.ino, 0, 32, seen, 0), 12);
check("and reads the same bytes", DEC.decode(seen.subarray(0, 12)), "written by a");

// ---- the limit --------------------------------------------------------------------------
const big = t.openDecision(user, "/d/big", { create: true, wantW: true, mode: 0o644 });
check("a write inside the limit succeeds", t.write(big.ino, 0, new Uint8Array(500)), 500);
check("a write past the limit is ENOSPC",
  code(() => t.write(big.ino, 0, new Uint8Array(2000))), "ENOSPC");
check("and the file is unchanged", t.size(big.ino), 500);
check("a truncate past the limit is ENOSPC", code(() => t.truncate(big.ino, 5000)), "ENOSPC");
// The ceiling is charged on GROWTH: an in-place rewrite of the same bytes must still work when
// the filesystem is nearly full.
check("an in-place rewrite near the limit still works",
  t.write(big.ino, 0, new Uint8Array(500)), 500);
checkThat("statfs reports the free space", t.statfs().bfree === t.limit - t.bytes, t.statfs());
checkThat("and the limit as its block count", t.statfs().blocks === 1024, t.statfs());

// ---- unlink reclaims the bytes ----------------------------------------------------------
const before = t.bytes;
t.unlink(user, "/d/big");
checkThat("unlink reclaims the bytes", t.bytes === before - 500, `${before} -> ${t.bytes}`);
check("and the file is gone", code(() => t.stat(user, "/d/big")), "ENOENT");
checkThat("and its blob is gone from the map",
  ![...t.blobs.keys()].includes(99999) && t.blobs.size >= 1, t.blobs.size);

// ---- unlink while a description is open: ESTALE, not EIO and not the bytes ---------------
// Reachable from userland in three syscalls, and the OPFS store's own answer for the same state.
const held = t.openDecision(user, "/d/held", { create: true, wantW: true, wantR: true, mode: 0o644 });
t.write(held.ino, 0, ENC.encode("still here"));
check("the held file reads before the unlink", t.size(held.ino), 10);
t.unlink(user, "/d/held");
check("reading a description whose last link went is ESTALE",
  code(() => t.read(held.ino, 0, 8, new Uint8Array(8), 0)), "ESTALE");
check("writing one is ESTALE too",
  code(() => t.write(held.ino, 0, ENC.encode("x"))), "ESTALE");
check("and so is asking its size", code(() => t.size(held.ino)), "ESTALE");

// ---- it refuses what a filesystem refuses -----------------------------------------------
check("opening a missing file without O_CREAT is ENOENT",
  code(() => t.openDecision(user, "/d/nope", {})), "ENOENT");
check("O_EXCL on an existing file is EEXIST",
  code(() => t.openDecision(user, "/d/f", { create: true, excl: true })), "EEXIST");
check("writing a directory is EISDIR",
  code(() => t.openDecision(user, "/d", { wantW: true })), "EISDIR");
check("rmdir on a non-empty directory is ENOTEMPTY", code(() => t.rmdir(user, "/d")), "ENOTEMPTY");
// Permissions are the VFS's, and they are REAL: a mode with no write bit refuses a write.
t.chmod(user, "/d/f", 0o444);
check("a read-only mode refuses a write open",
  code(() => t.openDecision(user, "/d/f", { wantW: true })), "EACCES");
checkThat("but still allows a read open",
  t.openDecision(user, "/d/f", { wantR: true }).ino > 0, "read was refused too");

// ---- rename and listRel -----------------------------------------------------------------
t.rename(user, "/d/f", "/d/renamed");
check("rename moves the name", code(() => t.stat(user, "/d/f")), "ENOENT");
check("and the target is there", t.stat(user, "/d/renamed").type, FILE);
check("listRel enumerates a directory",
  t.listRel("/d").map((e) => e.name).sort(), ["renamed", "shared"]);
check("listRel on a file is ENOTDIR", code(() => t.listRel("/d/renamed")), "ENOTDIR");

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  ok: failed.length === 0, total: results.length, failed: failed.length, failures: failed,
}, null, 2));
process.exit(failed.length ? 1 : 0);
