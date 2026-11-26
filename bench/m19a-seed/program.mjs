// M19a's measurement, part 2: WHAT DOES COPYING THE BASE COST, through real syscalls?
//
// D40 copies the read-only base into the writable volume once. Constraint 22 prices
// `createSyncAccessHandle` at 495 us — 100x a syscall — so the figure that decides whether the
// copy is synchronous at boot or deferred is a PER-FILE OPEN, not a byte rate. Nothing here
// estimates it: every phase is timed separately on the far side of a real syscall, inside a real
// process worker, against the real OPFS volume.
//
// It runs as a PROCESS and not on the kernel's thread deliberately. A copy driven from the kernel
// would price the store and say nothing about what M20's own verbs will pay, which is the same
// path: open, write, fsync, close.
//
// Modes, chosen by argv[0]:
//
//   walk            read `/usr` and report its files and bytes. NO WRITES: the reads-only floor,
//                   so the copy's figure can have the provider's cost taken off it.
//   copy DEST       the seed. One mkdir per directory, then per file: open the source, read it,
//                   create the destination, write it, fsync it, close both. Each phase timed.
//   copy-nofsync    the same without the per-file fsync, which is what prices constraint 23's
//                   "only fsync, snapshot and idle flush" for this workload.
//   verify DEST     every copied file read back and compared BYTE FOR BYTE against `/usr`. A copy
//                   that reported a time and wrote the wrong bytes is the worst outcome here.

import { E, MAX_INLINE, O_WRONLY, O_CREAT, O_EXCL, DT_DIR, DT_REG } from "../../src/abi.mjs";

/** The base. `/usr` is `FS_PROVIDER` with `MNT_RO` (src/kernel/providerfs.mjs), so these reads
 *  never touch OPFS and the `walk` floor is what they cost. */
const BASE = "/usr";

/** A millisecond with sub-microsecond resolution. `performance.now()` is 5 us-quantized without
 *  cross-origin isolation, and this process has it (constraint 1's SAB requires it), so a
 *  per-file figure of a few hundred microseconds is above the floor rather than at it. */
const now = () => performance.now();

/** A refusal, with the errno BY NAME out of `src/abi.mjs`'s own table.
 *
 * The name and not the number, because this ABI does not use Linux's values — EEXIST is 20 here —
 * and an errno literal in `probe.py` would be a second copy of the table that is right about Linux
 * and wrong about this system. The driver asserts on `errnoName`.
 */
function refused(env, what, r) {
  const name = env.std.errnoName(r);
  return { ok: false, why: `${what}: ${name}`, errno: -r, errnoName: name };
}

/** Every file under `root`, depth first, with the directories that hold them. One `listDir` per
 *  directory and no `stat` per entry: `readdir` already carries the type. */
function walkBase(env, root) {
  const dirs = [];
  const files = [];
  const queue = [root];
  for (let guard = 0; queue.length && guard < 4096; guard += 1) {
    const at = queue.shift();
    const entries = env.std.listDir(env, at);
    if (typeof entries === "number") return { errno: -entries, where: at };
    for (const e of entries) {
      if (e.name === "." || e.name === "..") continue;
      const full = at === "/" ? `/${e.name}` : `${at}/${e.name}`;
      if (e.type === DT_DIR) {
        dirs.push(full);
        queue.push(full);
      } else if (e.type === DT_REG) {
        files.push(full);
      }
    }
  }
  return { dirs, files };
}

/** The destination path for a source under `BASE`: `/usr/bin/ls` under `/base` is `/base/bin/ls`. */
function under(dest, source) {
  return dest + source.slice(BASE.length);
}

function walk(env) {
  const t0 = now();
  const found = walkBase(env, BASE);
  if (found.errno) return refused(env, `readdir ${found.where}`, -found.errno);
  const walkMs = now() - t0;

  const t1 = now();
  let bytes = 0;
  const sizes = [];
  for (const path of found.files) {
    const b = env.std.readFileBytes(env, path);
    if (typeof b === "number") return refused(env, `read ${path}`, b);
    bytes += b.length;
    sizes.push(b.length);
  }
  const readMs = now() - t1;

  return {
    ok: true,
    dirs: found.dirs.length,
    files: found.files.length,
    bytes,
    walkMs,
    readMs,
    perFileReadMs: readMs / found.files.length,
    largest: Math.max(...sizes),
    // The order `readdir` hands them back in. Reported because the first path a REPEATED copy
    // collides on is only meaningful beside it: `/base/bin/cat` reads like a partial overwrite
    // until the order says it is the first file.
    order: found.files,
  };
}

/**
 * THE SEED, phase by phase.
 *
 * `openMs` is the figure the decision turns on: it is where `createSyncAccessHandle` lands
 * (constraint 22), charged once per file. `writeMs` is charged in MAX_INLINE chunks because that
 * is the largest payload a syscall carries (src/abi.mjs), so a 177 KB file is several calls and
 * the chunk count is reported rather than inferred from the byte total.
 */
function copy(env, dest, { fsync = true } = {}) {
  const found = walkBase(env, BASE);
  if (found.errno) return refused(env, `readdir ${found.where}`, -found.errno);

  const ph = { mkdirMs: 0, srcReadMs: 0, openMs: 0, writeMs: 0, firstWriteMs: 0, restWriteMs: 0,
    fsyncMs: 0, closeMs: 0 };
  const t0 = now();

  const rootMk = now();
  const made = env.fs.mkdir(dest, 0o755);
  if (made < 0 && made !== -E.EEXIST) {
    return refused(env, `mkdir ${dest}`, made);
  }
  for (const dir of found.dirs) {
    const r = env.fs.mkdir(under(dest, dir), 0o755);
    if (r < 0 && r !== -E.EEXIST) return refused(env, `mkdir ${dir}`, r);
  }
  ph.mkdirMs = now() - rootMk;

  let bytes = 0;
  let chunks = 0;
  /** Per-file open cost, kept so the report can carry a median and a max and not only a mean: one
   *  slow open among 39 is invisible in an average and is exactly what a boot stall looks like. */
  const opens = [];
  /** Files this run CLOSED. On a refusal it is the damage count: an ungated second seed that
   *  refuses at file 1 has written nothing, and one that refuses at file 20 has not. */
  const written = [];
  /** Each file's FIRST write, which is the call that creates its blob handle. */
  const firsts = [];
  for (const source of found.files) {
    const tr = now();
    const payload = env.std.readFileBytes(env, source);
    ph.srcReadMs += now() - tr;
    if (typeof payload === "number") {
      return refused(env, `read ${source}`, payload);
    }

    const path = under(dest, source);
    const to = now();
    // O_EXCL, not O_TRUNC: a seed that silently overwrote an existing file would be the second
    // copy constraint 28 forbids, and this measurement must fail rather than hide it.
    const fd = env.fs.open(path, O_WRONLY | O_CREAT | O_EXCL, 0o644);
    const openOne = now() - to;
    ph.openMs += openOne;
    opens.push(openOne);
    if (fd < 0) {
      return { ...refused(env, `open ${path}`, fd), at: source, written: written.length };
    }

    const tw = now();
    for (let at = 0; at < payload.length; at += MAX_INLINE) {
      const slice = payload.subarray(at, Math.min(at + MAX_INLINE, payload.length));
      const tOne = now();
      const n = env.fs.write(fd, slice);
      const oneMs = now() - tOne;
      // THE FIRST WRITE OF A FILE IS NOT THE SAME CALL AS THE REST, and the split is where the
      // seed's real cost turned out to live. A created file is at generation 0, so `openFd`'s
      // `resolve` returns without an `IO_BLOB_OPEN` (src/kernel/store.mjs:493) and the
      // `createSyncAccessHandle` constraint 22 prices at 495 us is taken by `copyUp` on the first
      // write instead (store.mjs:579). Charged to `openMs`, the figure would say the open is
      // cheap and the copy is mysteriously slow.
      if (at === 0) { firsts.push(oneMs); ph.firstWriteMs += oneMs; } else {
        ph.restWriteMs += oneMs;
      }
      chunks += 1;
      if (n < 0) { env.fs.close(fd); return refused(env, `write ${path}`, n); }
      if (n !== slice.length) {
        env.fs.close(fd);
        return { ok: false, why: `short write on ${path}: ${n} of ${slice.length}` };
      }
    }
    // A zero-length file still costs an open and a close, so it is counted as a file with no
    // chunks rather than skipped.
    ph.writeMs += now() - tw;
    bytes += payload.length;

    if (fsync) {
      const tf = now();
      const r = env.fs.fsync(fd);
      ph.fsyncMs += now() - tf;
      if (r < 0) { env.fs.close(fd); return refused(env, `fsync ${path}`, r); }
    }

    const tc = now();
    const closed = env.fs.close(fd);
    ph.closeMs += now() - tc;
    if (closed < 0) return refused(env, `close ${path}`, closed);
    written.push(path);
  }

  const totalMs = now() - t0;
  opens.sort((a, b) => a - b);
  firsts.sort((a, b) => a - b);
  return {
    firstWrite: {
      n: firsts.length,
      meanMs: firsts.length ? ph.firstWriteMs / firsts.length : null,
      medianMs: firsts[Math.floor(firsts.length / 2)] ?? null,
      maxMs: firsts[firsts.length - 1] ?? null,
    },
    ok: true,
    dest,
    fsync,
    dirs: found.dirs.length + 1,
    files: found.files.length,
    bytes,
    chunks,
    totalMs,
    phases: ph,
    perFileMs: totalMs / found.files.length,
    open: {
      meanMs: ph.openMs / found.files.length,
      medianMs: opens[Math.floor(opens.length / 2)],
      maxMs: opens[opens.length - 1],
    },
  };
}

/** Every copied file against its source, byte for byte. A timing figure over a wrong copy is
 *  worse than no figure. */
function verify(env, dest) {
  const found = walkBase(env, BASE);
  if (found.errno) return refused(env, `readdir ${found.where}`, -found.errno);
  const wrong = [];
  let compared = 0;
  let bytes = 0;
  for (const source of found.files) {
    const want = env.std.readFileBytes(env, source);
    if (typeof want === "number") return refused(env, `read ${source}`, want);
    const path = under(dest, source);
    const got = env.std.readFileBytes(env, path);
    if (typeof got === "number") { wrong.push({ path, why: `errno ${-got}` }); continue; }
    if (got.length !== want.length) {
      wrong.push({ path, why: `${got.length} bytes, want ${want.length}` });
      continue;
    }
    let differs = -1;
    for (let i = 0; i < want.length; i += 1) {
      if (got[i] !== want[i]) { differs = i; break; }
    }
    if (differs >= 0) { wrong.push({ path, why: `byte ${differs} differs` }); continue; }
    compared += 1;
    bytes += want.length;
  }
  // The DIRECTORIES too: a copy that made every file and no directory would compare clean on the
  // files it did write and be a tree a reader cannot navigate.
  const dirsMissing = [];
  for (const dir of found.dirs) {
    const st = env.fs.stat(under(dest, dir));
    if (typeof st === "number") dirsMissing.push({ dir, errno: -st });
  }
  return {
    ok: wrong.length === 0 && dirsMissing.length === 0,
    compared, bytes, files: found.files.length,
    wrong: wrong.slice(0, 8), dirsMissing: dirsMissing.slice(0, 8),
  };
}

export function run(env, go) {
  const argv = (env.argv && env.argv.length ? env.argv : (go && go.argv) || []);
  const mode = String(argv[0] || "walk");
  const dest = String(argv[1] || "/base");
  const t0 = now();
  let out;
  switch (mode) {
    case "walk": out = walk(env); break;
    case "copy": out = copy(env, dest, { fsync: true }); break;
    case "copy-nofsync": out = copy(env, dest, { fsync: false }); break;
    case "verify": out = verify(env, dest); break;
    default: out = { ok: false, why: `unknown mode ${mode}` };
  }
  return { mode, ms: now() - t0, ...out };
}
