// M21's TWO WIRED CALLS — `utimes` and `realpath` — through the REAL dispatch table, under plain
// Node, with no browser, no SAB and no OPFS.
//
//   node bench/m21-abi/probe.mjs
//   node bench/m21-abi/probe.mjs --prove-failure
//   node bench/m21-abi/probe.mjs --control=generated-tmpfs   # see CONTROLS below
//   node bench/m21-abi/probe.mjs --control=ms-times
//   python3 bench/m21-abi/mutate.py   # the two src/abi.mjs mutants the selfTest clauses own
//
// WHAT IS REAL HERE, because that is the whole claim: `buildCalls` from `src/kernel/calls.mjs`
// builds the dispatch table, so a handler is reached by its NUMBER and not by name; the root mount
// is a real `VFS`; `/proc` and `/dev` are the real generated filesystems; `/tmp` is the real
// `TmpFS`; and the journal record a `utimes` produces is encoded and decoded with the real
// `encodeOp`/`decodeOp` and replayed into a SECOND VFS. The two calls were already implemented and
// unreachable (`docs/PLAN-SHELL.md` §M21), so what needs proving is the wiring and the refusals.
//
// THE FAKES, and neither is gentler than the thing it stands for:
//
//   `store.journal` appends the record and resolves 0, as `src/kernel/store.mjs` does on the happy
//   path. It does NOT flush — constraint 23's flush points are fsync, snapshot and idle — and the
//   records it collects are replayed below, so a record the real journal could not reconstruct from
//   fails here.
//   `later` mirrors `src/kernel/kernel.mjs:335`: the job runs off the dispatch path and a THROW
//   inside it becomes -EIO rather than a rejected promise, so a handler that faults is scored.
//
// EVERY REFUSAL IS ASSERTED BY ITS OWN ERRNO. A single "it refused" passes for a filesystem that
// refused for the wrong reason — M3's `truncate` answered ENOENT where it owed EROFS.
//
// `--prove-failure` inverts every expectation, so a run that reports no failures has not been
// checked (CLAUDE.md). It exits 0 when the proof SUCCEEDED.

import { buildCalls, PENDING } from "../../src/kernel/calls.mjs";
import { VFS, encodeOp, decodeOp } from "../../src/fs/vfs.mjs";
import { TmpFS } from "../../src/kernel/tmpfs.mjs";
import { ProcTable, RUNNING } from "../../src/kernel/table.mjs";
import { makeProcFS } from "../../src/kernel/procfs.mjs";
import { makeDevFS } from "../../src/kernel/devfs.mjs";
import { TraceRing } from "../../src/kernel/trace.mjs";
import { MountTable, MNT_RO, FS_OPFS, FS_PROC, FS_DEV, FS_TMPFS } from "../../src/fs/mounts.mjs";
import {
  E, SAB_BYTES, LEN_I32, DATA_OFF, A0, A1, A2, A3,
  SYS_utimes, SYS_realpath, NSYS, SYS_NAME, packI64,
} from "../../src/abi.mjs";

const INVERT = process.argv.includes("--prove-failure");

/**
 * THE NEGATIVE CONTROLS, as DATA, because inversion alone does not prove a clause is coupled to its
 * subject — an assertion over a constant still inverts and still fires (CLAUDE.md). Each names the
 * exact set of expectations it must move, and a control that moves a different set is a control
 * that verifies something else.
 *
 * Both are re-runnable from the command line with no source edit, which is the base rule a control
 * has to satisfy.
 */
const CONTROLS = Object.freeze({
  "generated-tmpfs": {
    why: "mounts the real TmpFS with a GENERATED filesystem's type, which is the world "
      + "`LEXICAL_REALPATH` exists to refuse: a mount that can hold a symlink, answered lexically",
    fails: ["a mount that can hold a symlink and has no canonicalizer is ENOSYS"],
  },
  "ms-times": {
    why: "sends MILLISECONDS where the ABI takes nanoseconds — the unit bill M16 and M17 each paid, "
      + "and the one a clause asserting a constant against a constant cannot see",
    fails: [
      "the atime and mtime are the NANOSECONDS, truncated to the inode's milliseconds",
      "sub-millisecond precision truncates toward zero",
      "the journal record is the VFS's own utimes op",
      "and it replays, through encodeOp/decodeOp, to the same times",
      "it set the time there",
    ],
  },
});

const CONTROL = process.argv.find((a) => a.startsWith("--control="))?.slice("--control=".length);
if (CONTROL && !CONTROLS[CONTROL]) {
  console.error(`no control ${JSON.stringify(CONTROL)}. Declared: ${Object.keys(CONTROLS).join(", ")}`);
  process.exit(2);
}

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ name, ok, got: ok ? undefined : got, want: ok ? undefined : want });
};
const checkThat = (name, ok, detail) =>
  results.push({ name, ok: !!ok, detail: ok ? undefined : detail });

/** A handler's return as something a clause can compare: an errno NAME for a refusal, so a wrong
 *  errno reads as `EROFS != ENOENT` rather than as `-69 != -44`. */
const errOf = (r) => (r < 0 ? (Object.keys(E).find((n) => E[n] === -r) || `errno ${-r}`) : r);

const code = (fn) => { try { fn(); return "<no throw>"; } catch (e) { return e.code || e.message; } };

/* ---- the volume, and a tree with symlinks in it -------------------------------------------- */

const ROOT = { uid: 0, gid: 0 };
// A FIXED CLOCK, not Date.now(): every clause below that asserts a timestamp asserts an exact
// number, and `VFS` has no default clock for exactly this reason (src/fs/vfs.mjs).
let clock = 1_000_000;
const vfs = new VFS({ owner: ROOT, now: () => clock });

vfs.mkdir(ROOT, "/a", { mode: 0o755 });
vfs.mkdir(ROOT, "/b", { mode: 0o755 });
vfs.openDecision(ROOT, "/b/c", { create: true, wantW: true, mode: 0o644 });
vfs.openDecision(ROOT, "/b/owned", { create: true, wantW: true, mode: 0o644 });
// `/a/rel` -> `../b`, a link in the MIDDLE of a path: the case a string transform gets wrong,
// because `..` after it means something different from `..` before it.
vfs.symlink(ROOT, "../b", "/a/rel");
vfs.symlink(ROOT, "/b/c", "/abs");
vfs.symlink(ROOT, "/loop", "/loop");

/* ---- the mounts ----------------------------------------------------------------------------- */

const table = new ProcTable(128);
const one = table.alloc();
one.state = RUNNING;
one.cmdline = "/usr/bin/sh";
one.cwd = "/";

const mounts = new MountTable();
mounts.add("/", { fs: vfs, type: FS_OPFS });
const proc = makeProcFS({ table: () => table, mounts: () => mounts });
const dev = makeDevFS({ trace: () => new TraceRing(4096, { enforce: false }) });
const tmp = new TmpFS({ now: () => clock });
proc.setDev(mounts.add("/proc", { fs: proc, type: FS_PROC, flags: MNT_RO }).dev);
dev.setDev(mounts.add("/dev", { fs: dev, type: FS_DEV, flags: MNT_RO }).dev);
tmp.setDev(mounts.add("/tmp", {
  fs: tmp, type: CONTROL === "generated-tmpfs" ? FS_PROC : FS_TMPFS,
}).dev);
tmp.mkdir(ROOT, "/d", { mode: 0o755 });
tmp.openDecision(ROOT, "/d/f", { create: true, wantW: true, mode: 0o644 });

/* ---- the kernel's two seams ----------------------------------------------------------------- */

const journalled = [];
const store = {
  vfs,
  readOnly: false,
  async journal(op) { journalled.push(op); return 0; },
  async freeInode() { return 0; },
};

let scheduled = null;
const k = {
  store,
  mounts,
  // src/kernel/kernel.mjs:335's contract, including the one that matters: a throw inside the async
  // body is -EIO, not a rejection nobody sees.
  later(_p, job) {
    scheduled = Promise.resolve().then(job).then((r) => r, () => -E.EIO);
  },
};

const calls = buildCalls(k);

/* ---- a process, as the twelve fields a path call actually touches --------------------------- */

const sab = new ArrayBuffer(SAB_BYTES);
const proc0 = {
  pid: one.pid,
  uid: 0,
  gid: 0,
  cwd: "/",
  rlen: 0,
  ctl: new Int32Array(sab),
  bytes: new Uint8Array(sab),
};

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** Put a path in the byte region the way `src/libos/syscall.mjs`'s `pathBytes` does. */
function setPath(path) {
  const bytes = ENC.encode(path);
  proc0.bytes.set(bytes, DATA_OFF);
  proc0.ctl[LEN_I32] = bytes.length;
}

/** Dispatch by NUMBER, and settle a PENDING handler the way `finish` does. */
async function call(nr, path, args = []) {
  setPath(path);
  proc0.ctl[A0] = args[0] | 0;
  proc0.ctl[A1] = args[1] | 0;
  proc0.ctl[A2] = args[2] | 0;
  proc0.ctl[A3] = args[3] | 0;
  proc0.rlen = 0;
  scheduled = null;
  const r = calls[nr](proc0);
  if (r !== PENDING) return r;
  if (!scheduled) throw new Error("a handler returned PENDING and scheduled nothing");
  return scheduled;
}

const realpath = async (path) => {
  const r = await call(SYS_realpath, path);
  if (r < 0) return errOf(r);
  return DEC.decode(proc0.bytes.subarray(DATA_OFF, DATA_OFF + r));
};

const utimes = async (path, atimeNs, mtimeNs) => {
  /* `ms-times` sends the value in the WRONG UNIT and changes nothing else, so the clauses that move
   * are exactly the ones asserting the conversion. A NEGATIVE TIME IS LEFT ALONE: measured, the
   * first version of this control divided it too, and `-1n / 1000000n` is `0n` — which moved the
   * two EINVAL clauses as well and made the control one that "any failure" satisfies. The control
   * is about the unit of a legal time, not about the sign. */
  const scale = CONTROL === "ms-times" ? 1000000n : 1n;
  const scaled = (v) => (BigInt(v) < 0n ? BigInt(v) : BigInt(v) / scale);
  const [alo, ahi] = packI64(scaled(atimeNs));
  const [mlo, mhi] = packI64(scaled(mtimeNs));
  return errOf(await call(SYS_utimes, path, [alo, ahi, mlo, mhi]));
};

/* ---- PROOF 1: the table carries both calls, reached by number ------------------------------ */

// `buildCalls` throws if a SYS_NAME entry has no handler, so reaching this line is the assertion.
// Stated as a clause anyway, because "the import did not throw" is not a scored expectation.
check("the dispatch table has one row per declared call", calls.length, NSYS);
check("utimes and realpath dispatch by number",
  [typeof calls[SYS_utimes], typeof calls[SYS_realpath]], ["function", "function"]);
check("and SYS_NAME names them at those numbers",
  [SYS_NAME[SYS_utimes], SYS_NAME[SYS_realpath]], ["utimes", "realpath"]);

/* ---- PROOF 2: realpath on the volume, which is the canonicalizer that already existed ------ */

check("a symlink in the MIDDLE of a path is spliced", await realpath("/a/rel/c"), "/b/c");
check("a link's relative target resolves against the link's own directory",
  await realpath("/a/rel"), "/b");
check("an absolute target resets the walk", await realpath("/abs"), "/b/c");
check("`.` and `..` collapse around a link", await realpath("/a/./rel/../b/c"), "/b/c");
check("the root is its own canonical path", await realpath("/"), "/");
// The caller's cwd, which `resolveMount` applies before the mount is picked: a relative path that
// reached the VFS un-absolutized would be resolved against the FILESYSTEM's root instead.
proc0.cwd = "/a";
check("a RELATIVE path is canonicalized against the caller's cwd", await realpath("rel/c"), "/b/c");
proc0.cwd = "/";
check("a missing component is ENOENT", await realpath("/a/rel/missing"), "ENOENT");
check("a self-referential link is ELOOP", await realpath("/loop"), "ELOOP");

/* ---- PROOF 3: realpath on a GENERATED mount, where the lexical answer is the real one ------ */

const pid = String(one.pid);
check("a generated mount gets its MOUNTPOINT back on the answer",
  await realpath(`/proc/${pid}/../${pid}`), `/proc/${pid}`);
check("the mountpoint itself canonicalizes to itself", await realpath("/proc"), "/proc");
check("`.` collapses under a generated mount", await realpath("/dev/./null"), "/dev/null");
check("a missing row under a generated mount is ENOENT",
  await realpath("/proc/999999/status"), "ENOENT");
/* THE REFUSAL THAT IS THE POINT OF THE TYPE LIST. `TmpFS` forwards `symlink` to a real VFS, so it
 * CAN hold a link and has no canonicalizer — and a lexical answer there would be a wrong path
 * returned with no error, which is worse than -ENOSYS. The clause below proves the premise rather
 * than asserting it: the link is really created. */
checkThat("a tmpfs really can hold a symlink", !!tmp.symlink(ROOT, "/d/f", "/d/link"),
  "tmpfs refused a symlink, so the ENOSYS below guards nothing");
check("a mount that can hold a symlink and has no canonicalizer is ENOSYS",
  await realpath("/tmp/d/link"), "ENOSYS");

/* ---- PROOF 4: utimes sets the times, and the JOURNAL carries them -------------------------- */

clock = 5_000_000;
check("utimes answers 0", await utimes("/b/c", 1_700_000_000_123_000_000n, 1_600_000_000_456_000_000n), 0);
const after = vfs.stat(ROOT, "/b/c");
check("the atime and mtime are the NANOSECONDS, truncated to the inode's milliseconds",
  [after.atime, after.mtime], [1_700_000_000_123, 1_600_000_000_456]);
/* A TIMESTAMP IN NANOSECONDS IS NOT A SAFE INTEGER — 1.7e18 — so the `Number(unpackI64(...))` that
 * `truncate` uses would have refused every real time with EINVAL. The clause above is what makes
 * that a measurement rather than a worry: it passes only because `msOfNs` divides in BigInt. */
checkThat("...and a ns timestamp really is outside Number's safe range",
  !Number.isSafeInteger(1_700_000_000_123_000_000), "the clause above proves nothing");
check("ctime moves to the op's own clock, not to the time that was set", after.ctime, 5_000_000);
check("sub-millisecond precision truncates toward zero",
  (await utimes("/b/c", 1_500_999_999n, 1_999_999n), [vfs.stat(ROOT, "/b/c").atime,
    vfs.stat(ROOT, "/b/c").mtime]), [1500, 1]);

const record = journalled[journalled.length - 1];
check("the journal record is the VFS's own utimes op",
  [record.k, record.ino === after.ino, record.atime, record.mtime, record.t],
  ["utimes", true, 1500, 1, 5_000_000]);
/* DURABILITY, through the REAL CODEC and not through the object: `src/kernel/store.mjs` journals
 * `encodeOp(op)` and replay hands `decodeOp`'s result to `applyOp`, so a record that survives the
 * object and not the bytes is a record that is lost. */
const replayed = new VFS({ owner: ROOT, now: () => clock });
replayed.mkdir(ROOT, "/a", { mode: 0o755 });
replayed.mkdir(ROOT, "/b", { mode: 0o755 });
replayed.openDecision(ROOT, "/b/c", { create: true, wantW: true, mode: 0o644 });
replayed.applyOp(decodeOp(encodeOp(record)));
check("and it replays, through encodeOp/decodeOp, to the same times",
  [replayed.stat(ROOT, "/b/c").atime, replayed.stat(ROOT, "/b/c").mtime], [1500, 1]);

/* ---- PROOF 5: every utimes refusal, by its OWN errno --------------------------------------- */

check("a path that does not exist is ENOENT", await utimes("/b/missing", 0n, 0n), "ENOENT");
check("a NEGATIVE atime is EINVAL", await utimes("/b/c", -1n, 0n), "EINVAL");
check("a NEGATIVE mtime is EINVAL, scored separately", await utimes("/b/c", 0n, -1n), "EINVAL");
/* AN EPOCH TIME IS LEGAL AND MUST NOT BE REFUSED, which is what makes the two clauses above a
 * check on the sign rather than on zero. */
check("zero is a legal time", await utimes("/b/c", 0n, 0n), 0);
// A READ-ONLY MOUNT REFUSES AT TWO INDEPENDENT LAYERS (constraint 28's rule, M20's `readOnly`
// proof): the kernel's mount flag, and the generated filesystem's own answer.
check("a read-only mount is EROFS at the kernel's layer",
  await utimes(`/proc/${pid}/status`, 0n, 0n), "EROFS");
check("...and EROFS again at the filesystem's own layer",
  code(() => proc.utimes(ROOT, `/${pid}/status`)), "EROFS");
// `VFS.utimes` needs W on the inode, so an unprivileged caller is refused by the credential the
// kernel built for THIS call (constraint 29) and not by any stored identity.
proc0.uid = 1000;
proc0.gid = 1000;
check("no write permission on the inode is EACCES", await utimes("/b/owned", 0n, 0n), "EACCES");
proc0.uid = 0;
proc0.gid = 0;

/* ---- PROOF 6: a mount with no durable state journals NOTHING ------------------------------- */

const before = journalled.length;
check("utimes on a tmpfs answers 0", await utimes("/tmp/d/f", 2_000_000_000n, 2_000_000_000n), 0);
check("it set the time there", tmp.stat(ROOT, "/d/f").mtime, 2000);
/* A JOURNAL RECORD FOR A TMPFS WOULD DESCRIBE THE OPFS VOLUME, and replay would set the time on
 * whatever inode number happened to collide. `metaOp` returns before journaling for a mount with no
 * durable state, and this is the clause that says so. */
check("and journalled nothing", journalled.length - before, 0);

/* ---- the verdict ---------------------------------------------------------------------------- */

const scored = results.map((r) => ({ ...r, ok: INVERT ? !r.ok : r.ok }));
const failed = scored.filter((r) => !r.ok);
for (const r of scored) {
  const line = `${r.ok ? "ok  " : "FAIL"}  ${r.name}`;
  if (r.ok) console.log(line);
  else console.log(`${line}\n        got  ${JSON.stringify(r.got ?? r.detail)}`
    + `${r.want === undefined ? "" : `\n        want ${JSON.stringify(r.want)}`}`);
}
console.log(`\n${scored.length - failed.length}/${scored.length} expectations`
  + `${INVERT ? " INVERTED" : ""}`);
if (INVERT) {
  // A PROOF THAT SUCCEEDED EXITS 0, which is `scripts/check.py --prove-failure`'s convention:
  // non-zero is reserved for a proof that failed to fail.
  const flipped = results.length - results.filter((r) => r.ok).length;
  console.log(`--prove-failure: ${results.length} expectation(s) inverted, `
    + `${flipped} were already failing`);
  process.exit(flipped === 0 ? 0 : 1);
}
if (CONTROL) {
  // THE NAMED SET, IN BOTH DIRECTIONS. A control satisfied by any failure verifies nothing, so an
  // extra failure is as much a defect as a missing one — M3's first control lapped the trace ring
  // and so also failed a proof it was not about.
  const want = new Set(CONTROLS[CONTROL].fails);
  const got = new Set(failed.map((r) => r.name));
  const missing = [...want].filter((n) => !got.has(n));
  const extra = [...got].filter((n) => !want.has(n));
  console.log(`\ncontrol ${CONTROL}: ${CONTROLS[CONTROL].why}`);
  console.log(`  moved ${got.size} of ${results.length}; declared ${want.size}`);
  for (const n of missing) console.log(`  DID NOT MOVE (declared): ${n}`);
  for (const n of extra) console.log(`  MOVED BUT NOT DECLARED: ${n}`);
  console.log(missing.length || extra.length
    ? "CONTROL FAILED: the set that moved is not the set declared"
    : "CONTROL HELD: exactly the declared expectations moved");
  process.exit(missing.length || extra.length ? 1 : 0);
}
process.exit(failed.length === 0 ? 0 : 1);
