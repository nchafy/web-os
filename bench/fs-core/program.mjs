// M2's process program. Every byte of every proof goes through a real syscall from inside a real
// process worker — CLAUDE.md's rule that a change is exercised through the artifact a user
// touches, and the only way to exercise constraint 15 at all: this program holds nothing but
// integers and the functions the libos handed it.
//
// Modes, chosen by argv[0]:
//
//   setup UID      (as root) make the directory tree and chown it to UID
//   mkfiles N      create N files, each with its own bytes and its own mode, fsync and close
//   verify N       reopen all N, read the bytes back, fstat the mode, report every mismatch
//   hold PATH      open PATH, read it, and REPORT — then keep the fd open until told to let go
//   hreread        read again through the fd `hold` kept, after somebody swung the inode
//   reader PATH    open the same PATH while `hold` has it, read it, report what it saw
//   overwrite PATH open PATH, rewrite it from offset 0, fsync (the copy-on-write path)
//   modebits       one file per mode in a fixed list, chmod each, read every mode back
//   deny PATH      open PATH expecting a refusal, and report the errno
//   statmode PATH  report one path's mode word, for a proof that asserts on a permission
//   apicheck       the rest of the ABI the three proofs do not reach, one row per call
//   wopen PATH     open PATH for writing and KEEP the fd across this process's next go
//   wwrite a|b     write this writer's range through the kept fd at the size it saw at open
//   wcheck PATH    reopen and report whether BOTH writers' committed bytes are there
//   wtail          an ACKNOWLEDGED append at the committed size, not fsynced
//   wstage         grow with ftruncate and do not commit: a staged generation nobody published
//   wclose         close the kept fd and REPORT WHAT CLOSE RETURNED
//   wunlink PATH   unlink while this process holds a description, then try every call on the fd
//   dcheck PATH    the drop proof's verifier: the below-write and the acknowledged append
//   kstage PATH|V   one acknowledged write below the published size, fd KEPT open, for a
//                   process the page is about to kill
//   kham PATH|N     the contender: rewrite offset 0 and fsync, N rounds, every errno kept
//   kread PATH      what the file holds now, through a fresh description
//   append PATH     two O_APPEND descriptions on one file, and what a fresh reader finds
//
// The byte pattern is derived from the index, never random, so `verify` can compute what it should
// see rather than being told. A verifier handed the expected bytes by the writer compares two
// copies of the same mistake.

// From src/abi.mjs, the one declaration both sides import. The kernel's loader resolves this
// specifier against the program's own URL, so the process gets the SAME instance its libos stub
// holds rather than a second copy (src/kernel/kernel.mjs, the program loader).
import {
  O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_DIRECTORY,
  O_APPEND, SEEK_SET, SEEK_CUR, SEEK_END, S_IFMT, S_IFREG, NAME_MAX, E,
} from "/src/abi.mjs";

/** The bytes file `i` must hold. Length varies with i so a size bug cannot hide behind a fixed
 *  record, and the first byte varies so a shifted read is visible in byte 0. */
function bytesFor(i) {
  const length = 7 + (i % 53);
  const out = new Uint8Array(length);
  for (let b = 0; b < length; b += 1) out[b] = (i * 31 + b * 7) & 0xff;
  return out;
}

/** The mode file `i` must carry. Spread across the readable range, and never 0 — a file nobody
 *  can read would make `verify` fail for the wrong reason. */
function modeFor(i) {
  const modes = [0o600, 0o640, 0o644, 0o664, 0o666, 0o700, 0o750, 0o755, 0o604, 0o660];
  return modes[i % modes.length];
}

/**
 * CONSTRAINT 29'S GROUP ARM, as two fixtures and one byte.
 *
 * The group bits are a THIRD of the mode word and nothing else in this bench reaches them: every
 * other file here is owned by the credential that opens it, so the owner arm answers first and
 * deleting the group arm from the VFS changes no result. These two files are owned by a uid no
 * process in this bench runs as, so the owner arm cannot answer — and they are checked in BOTH
 * directions, because a fixture that only ever sees the group bits GRANT cannot tell the group arm
 * from a fallthrough to `other`.
 *
 *   grp-grant  mode 0040 — group may read, owner and other may not. Must OPEN.
 *   grp-deny   mode 0004 — other may read, group may not. Must be refused, and a fallthrough to
 *              `other` is exactly what would let it through.
 */
export const GROUP_GRANT = "/d/2/grp-grant";
export const GROUP_DENY = "/d/2/grp-deny";
/** A uid nothing in this bench runs as, so neither file's owner arm can answer. */
const GROUP_STRANGER_UID = 2000;
/** The one byte both fixtures hold, so the granted open can be shown to have READ something. */
const GROUP_BYTE = 7;

function pathFor(i) {
  // Two levels, so path resolution is actually exercised: a flat namespace would never walk a
  // component and constraint 24's whole point is that a walk costs one resolution, not N.
  return `/d/${i % 16}/f${i}`;
}

export function run(env, go) {
  const mode = String((env.argv && env.argv[0]) || (go && go.argv && go.argv[0]) || "noop");
  const arg = (env.argv && env.argv[1]) !== undefined
    ? env.argv[1] : (go && go.argv ? go.argv[1] : undefined);
  const t0 = performance.now();
  let out;
  switch (mode) {
    case "setup": out = setup(env, Number(arg) || 0); break;
    case "mkfiles": out = mkfiles(env, Number(arg) || 0); break;
    case "verify": out = verify(env, Number(arg) || 0); break;
    case "hold": out = hold(env, String(arg)); break;
    case "hreread": out = hreread(env); break;
    case "reader": out = reader(env, String(arg)); break;
    case "overwrite": out = overwrite(env, String(arg)); break;
    case "modebits": out = modebits(env); break;
    case "deny": out = deny(env, String(arg)); break;
    case "statmode": out = statmode(env, String(arg)); break;
    case "apicheck": out = apicheck(env); break;
    case "wopen": out = wopen(env, String(arg)); break;
    case "wwrite": out = wwrite(env, String(arg)); break;
    case "wput": out = wput(env, String(arg)); break;
    case "wsync": out = wsync(env); break;
    case "wpend": out = wpend(env); break;
    case "wtail": out = wtail(env); break;
    case "wstage": out = wstage(env); break;
    case "wclose": out = wclose(env); break;
    case "wunlink": out = wunlink(env, String(arg)); break;
    case "wbelow": out = wbelow(env); break;
    case "wgrow": out = wgrow(env, String(arg)); break;
    case "wpeek": out = wpeek(env, String(arg)); break;
    case "cas": out = cas(env, String(arg)); break;
    case "casloop": out = casloop(env, String(arg)); break;
    case "casretry": out = casretry(env, String(arg)); break;
    case "cascheck": out = cascheck(env, String(arg)); break;
    case "gcheck": out = gcheck(env, String(arg)); break;
    case "casopen": out = casopen(env, String(arg)); break;
    case "wmkdir": out = wmkdir(env, String(arg)); break;
    case "wstat": out = wstat(env, String(arg)); break;
    case "wcheck": out = wcheck(env, String(arg)); break;
    case "pcheck": out = pcheck(env, String(arg)); break;
    case "dcheck": out = dcheck(env, String(arg)); break;
    case "kstage": out = kstage(env, String(arg)); break;
    case "kham": out = kham(env, String(arg)); break;
    case "kread": out = kread(env, String(arg)); break;
    case "append": out = appendpair(env, String(arg)); break;
    case "noop": out = { ok: true }; break;
    default: out = { ok: false, why: `unknown mode ${mode}` };
  }
  return { mode, arg, ms: performance.now() - t0, ...out };
}

/**
 * THE DIRECTORY TREE, created and given away BY ROOT. Its own mode, because of what the first run
 * of this bench measured.
 *
 * A uid-1000 process cannot `mkdir` in a root directory that is 0755 and owned by uid 0, and
 * `mkfiles` got -EACCES on all seventeen of them. That is the permission check WORKING — constraint
 * 29's mode bits doing exactly what they exist for — so the fix is a setup step that runs as root
 * and hands the tree to the user, which is what a real system does at install time. A bench that
 * ran everything as root would have passed and proved nothing about the credential.
 */
function setup(env, owner) {
  const fs = env.fs;
  const errors = [];
  const paths = ["/d", ...Array.from({ length: 16 }, (_, i) => `/d/${i}`)];
  for (const path of paths) {
    const made = fs.mkdir(path, 0o755);
    // EEXIST is success: a second setup over the same volume is not an error.
    if (made < 0 && made !== -E.EEXIST) errors.push({ path, at: "mkdir", errno: -made });
  }
  for (const path of paths) {
    // Only root may give a directory away. A uid-1000 process asking for this gets -EPERM, which
    // is the half of constraint 29 that a write test alone never reaches.
    const r = fs.chown(path, owner, owner);
    if (r < 0) errors.push({ path, at: "chown", errno: -r });
  }
  // The group-arm fixtures, created here because only root can give a file away and the group arm
  // is unreachable for a process that owns the file.
  for (const [path, mode] of [[GROUP_GRANT, 0o040], [GROUP_DENY, 0o004]]) {
    const fd = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o600);
    if (fd < 0) {
      errors.push({ path, at: "open", errno: -fd });
      continue;
    }
    const w = fs.write(fd, new Uint8Array([GROUP_BYTE]));
    if (w !== 1) errors.push({ path, at: "write", got: w });
    const s = fs.fsync(fd);
    if (s !== 0) errors.push({ path, at: "fsync", errno: -s });
    fs.close(fd);
    const ch = fs.chmod(path, mode);
    if (ch !== 0) errors.push({ path, at: "chmod", errno: -ch });
    // The gid is the running user's; the uid is not. That pair is what makes the group arm the
    // only arm that can answer.
    const co = fs.chown(path, GROUP_STRANGER_UID, owner);
    if (co !== 0) errors.push({ path, at: "chown-group-fixture", errno: -co });
  }
  return { ok: errors.length === 0, dirs: paths.length, owner, errors };
}

function mkfiles(env, n) {
  const fs = env.fs;
  const errors = [];
  let written = 0;
  let bytes = 0;
  for (let i = 0; i < n; i += 1) {
    const path = pathFor(i);
    const want = bytesFor(i);
    const fd = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, modeFor(i));
    if (fd < 0) {
      if (errors.length < 8) errors.push({ i, path, at: "open", errno: -fd });
      continue;
    }
    const w = fs.write(fd, want);
    if (w !== want.length) {
      if (errors.length < 8) errors.push({ i, path, at: "write", got: w, want: want.length });
    }
    // fsync per file, deliberately: it is the durability point the 10k-file proof rests on, and
    // the cost it carries (constraint 23's 260 us) is the cost the proof is willing to pay.
    const s = fs.fsync(fd);
    if (s !== 0 && errors.length < 8) errors.push({ i, path, at: "fsync", errno: -s });
    const c = fs.close(fd);
    if (c !== 0 && errors.length < 8) errors.push({ i, path, at: "close", errno: -c });
    written += 1;
    bytes += want.length;
  }
  return { ok: errors.length === 0 && written === n, n, written, bytes, errors };
}

/**
 * Reopen every file and compare BOTH halves: the bytes and the mode word.
 *
 * The expected value is recomputed from the index here. A verifier told what to expect by the
 * writer would compare two copies of one mistake and pass.
 */
function verify(env, n) {
  const fs = env.fs;
  const errors = [];
  let checked = 0;
  let bytesOk = 0;
  let modesOk = 0;
  for (let i = 0; i < n; i += 1) {
    const path = pathFor(i);
    const want = bytesFor(i);
    const fd = fs.open(path, O_RDONLY);
    if (fd < 0) {
      if (errors.length < 8) errors.push({ i, path, at: "open", errno: -fd });
      continue;
    }
    const st = fs.fstat(fd);
    if (typeof st === "number") {
      if (errors.length < 8) errors.push({ i, path, at: "fstat", errno: -st });
      fs.close(fd);
      continue;
    }
    const wantMode = S_IFREG | modeFor(i);
    if (st.mode !== wantMode) {
      if (errors.length < 8) {
        errors.push({ i, path, at: "mode", got: st.mode.toString(8), want: wantMode.toString(8) });
      }
    } else {
      modesOk += 1;
    }
    if (Number(st.size) !== want.length) {
      if (errors.length < 8) {
        errors.push({ i, path, at: "size", got: Number(st.size), want: want.length });
      }
      fs.close(fd);
      continue;
    }
    const got = fs.readAll(fd, want.length);
    if (typeof got === "number") {
      if (errors.length < 8) errors.push({ i, path, at: "read", errno: -got });
      fs.close(fd);
      continue;
    }
    let same = got.length === want.length;
    for (let b = 0; same && b < want.length; b += 1) same = got[b] === want[b];
    if (same) bytesOk += 1;
    else if (errors.length < 8) {
      errors.push({ i, path, at: "bytes", first: got[0], want: want[0], len: got.length });
    }
    fs.close(fd);
    checked += 1;
  }
  return {
    ok: errors.length === 0 && checked === n && bytesOk === n && modesOk === n,
    n, checked, bytesOk, modesOk, errors,
  };
}

/**
 * CONSTRAINT 47'S CASE, the holder half. Open the file, read it, and DO NOT CLOSE.
 *
 * A sync access handle is an exclusive lock per file, so without the per-inode refcount beneath the
 * fd table the `reader` process below would get NoModificationAllowedError and `cat notes.txt |
 * wc -l` would fail while an editor had the file open.
 *
 * The fd is left open on purpose. It is released by the process exiting, which is the kernel's
 * teardown path (M1 item (d)) closing every fd — a process cannot be trusted to do it, because
 * `terminate()` runs no cleanup.
 */
function hold(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
  const got = fs.readAll(fd, Number(st.size));
  if (typeof got === "number") return { ok: false, at: "read", errno: -got };
  // Kept so a later `go` can read through THE SAME description. `hreread` is what makes the
  // held fd's view of a swing observable at all.
  keptFd = fd;
  keptSize = Number(st.size);
  return {
    ok: true, fd, size: Number(st.size), bytes: got.length,
    sum: [...got].reduce((a, b) => (a + b) & 0xffff, 0),
    held: true,
  };
}

/**
 * Read again through the fd `hold` kept, after somebody else swung the inode.
 *
 * THE CLAUSE A STALE READ FAILS. A held description is not a snapshot: POSIX has two fds on one
 * file sharing the file, so this must come back with the NEW generation's bytes. Against a
 * description that cached its generation and its size at open, this returned the superseded
 * generation's bytes while `fstat` on the same fd reported the new size — stat and read
 * disagreeing on one descriptor with no error on either.
 */
function hreread(env) {
  const fs = env.fs;
  if (keptFd < 0) return { ok: false, why: "no fd was kept; hold must run first" };
  const st = fs.fstat(keptFd);
  if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
  const size = Number(st.size);
  const buf = new Uint8Array(size);
  const n = fs.pread(keptFd, buf, 0, size);
  if (n < 0) return { ok: false, at: "pread", errno: -n };
  return {
    ok: true, size, read: n, openSize: keptSize,
    sum: [...buf.subarray(0, n)].reduce((a, b) => (a + b) & 0xffff, 0),
  };
}

/** The second opener. Must succeed while `hold` still has the file. */
function reader(env, path) {
  return { ...hold(env, path), second: true };
}

/**
 * The copy-on-write path: rewrite a file from offset 0.
 *
 * This is the write that must NOT mutate the blob the metadata points at. The bytes below the
 * committed size are being replaced, so the kernel copies up to a new generation, writes there,
 * flushes it, journals the swing and only then publishes it.
 */
function overwrite(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const before = fs.fstat(fd);
  if (typeof before === "number") return { ok: false, at: "fstat", errno: -before };
  const want = new Uint8Array(Number(before.size));
  for (let b = 0; b < want.length; b += 1) want[b] = 0xa0 | (b & 0x0f);
  const w = fs.write(fd, want);
  if (w !== want.length) return { ok: false, at: "write", got: w, want: want.length };
  const s = fs.fsync(fd);
  if (s !== 0) return { ok: false, at: "fsync", errno: -s };
  const after = fs.fstat(fd);
  const c = fs.close(fd);
  if (c !== 0) return { ok: false, at: "close", errno: -c };
  return {
    ok: true, size: Number(before.size),
    afterSize: typeof after === "number" ? -1 : Number(after.size),
    sum: [...want].reduce((a, b) => (a + b) & 0xffff, 0),
  };
}

/**
 * THE REST OF THE ABI, exercised once each.
 *
 * It exists because the three headline proofs reach twelve of the thirty-nine syscalls, and a call
 * the suite never issues is a call nobody has shown works — `pread` not touching the cursor, `dup`
 * sharing a description, `readdir`'s cookie, `truncate`'s copy-up, `rename`'s directory bookkeeping.
 * Each row names the call and says what it saw, so a failure points at one line.
 *
 * It runs as the OWNING uid, under a directory `setup` handed over, so nothing here passes by
 * being root.
 */
function apicheck(env) {
  const fs = env.fs;
  const rows = [];
  const ok = (call, pass, detail) => rows.push({ call, pass: !!pass, detail });
  const dir = "/d/2/api";
  const made = fs.mkdir(dir, 0o755);
  ok("mkdir", made === 0 || made === -E.EEXIST, made);

  // A file with a known pattern, written through the cursor.
  const path = `${dir}/f`;
  const body = new Uint8Array(64);
  for (let i = 0; i < body.length; i += 1) body[i] = i;
  let fd = fs.open(path, O_RDWR | O_CREAT | O_TRUNC, 0o644);
  ok("open O_CREAT|O_TRUNC", fd >= 0, fd);
  if (fd < 0) return { ok: false, rows };
  ok("write", fs.write(fd, body) === body.length);
  ok("fsync", fs.fsync(fd) === 0);

  // seek, all three whences.
  ok("seek SEEK_SET", fs.seek(fd, 8, SEEK_SET) === 8);
  ok("seek SEEK_CUR", fs.seek(fd, 4, SEEK_CUR) === 12);
  ok("seek SEEK_END", fs.seek(fd, 0, SEEK_END) === body.length);
  ok("seek before zero is EINVAL", fs.seek(fd, -1, SEEK_SET) === -E.EINVAL);

  // pread MUST NOT move the cursor. That is the whole reason it exists, and the first version of
  // the kernel's implementation moved it and put it back across an await.
  const at = fs.seek(fd, 10, SEEK_SET);
  const into = new Uint8Array(8);
  const n = fs.pread(fd, into, 32, 8);
  ok("pread reads from the offset", n === 8 && into[0] === 32 && into[7] === 39,
    { n, first: into[0], last: into[7] });
  ok("pread left the cursor alone", fs.seek(fd, 0, SEEK_CUR) === at, { at });

  // pwrite, likewise.
  const stamp = new Uint8Array([0xde, 0xad]);
  ok("pwrite writes at the offset", fs.pwrite(fd, stamp, 40) === 2);
  ok("pwrite left the cursor alone", fs.seek(fd, 0, SEEK_CUR) === at);
  const back = new Uint8Array(2);
  fs.pread(fd, back, 40, 2);
  ok("pwrite landed", back[0] === 0xde && back[1] === 0xad, [...back]);

  // dup shares the description, so a seek through one fd moves the other.
  const dup = fs.dup(fd);
  ok("dup", dup >= 0 && dup !== fd, { fd, dup });
  fs.seek(dup, 3, SEEK_SET);
  ok("dup shares the cursor", fs.seek(fd, 0, SEEK_CUR) === 3);
  ok("close(dup)", fs.close(dup) === 0);
  ok("the original fd survives its dup", fs.seek(fd, 0, SEEK_CUR) === 3);

  // ftruncate, which is a copy-up: the committed bytes below the new size must survive.
  ok("ftruncate", fs.ftruncate(fd, 16) === 0);
  const st = fs.fstat(fd);
  ok("ftruncate publishes the new size", typeof st !== "number" && Number(st.size) === 16,
    typeof st === "number" ? st : Number(st.size));
  const head = new Uint8Array(16);
  fs.pread(fd, head, 0, 16);
  ok("ftruncate kept the bytes below it", head[0] === 0 && head[15] === 15,
    { first: head[0], last: head[15] });
  ok("close", fs.close(fd) === 0);

  // stat after close reads the committed metadata.
  const after = fs.stat(path);
  ok("stat after close", typeof after !== "number" && Number(after.size) === 16,
    typeof after === "number" ? after : Number(after.size));

  // Links, symlinks and readlink.
  ok("link", fs.link(path, `${dir}/hard`) === 0);
  const linked = fs.stat(`${dir}/hard`);
  ok("a hard link is the same inode",
    typeof linked !== "number" && typeof after !== "number" && linked.ino === after.ino);
  ok("nlink counts both names", typeof linked !== "number" && linked.nlink === 2,
    typeof linked === "number" ? linked : linked.nlink);
  ok("symlink", fs.symlink("f", `${dir}/soft`) === 0);
  ok("readlink", fs.readlink(`${dir}/soft`) === "f");
  const through = fs.stat(`${dir}/soft`);
  ok("stat follows a symlink",
    typeof through !== "number" && typeof after !== "number" && through.ino === after.ino);
  const itself = fs.lstat(`${dir}/soft`);
  ok("lstat describes the link",
    typeof itself !== "number" && (itself.mode & S_IFMT) !== S_IFREG);

  // readdir, through the cookie.
  const dfd = fs.open(dir, O_RDONLY | O_DIRECTORY);
  ok("open a directory", dfd >= 0, dfd);
  const names = [];
  let cookie = 0;
  for (let guard = 0; guard < 64 && dfd >= 0; guard += 1) {
    const batch = fs.readdir(dfd, cookie);
    if (typeof batch === "number") {
      ok("readdir", false, batch);
      break;
    }
    if (batch.done) break;
    for (const entry of batch.entries) names.push(entry.name);
    cookie = batch.cookie;
  }
  ok("readdir lists every name", names.length === 4 && names.includes("f")
    && names.includes("hard") && names.includes("soft") && names.includes("dir-victim")
    ? true : names.length === 3 && names.includes("f") && names.includes("hard")
      && names.includes("soft"), names);
  if (dfd >= 0) ok("close a directory", fs.close(dfd) === 0);

  // rename, then unlink and rmdir.
  ok("rename", fs.rename(`${dir}/hard`, `${dir}/moved`) === 0);
  ok("the old name is gone", fs.stat(`${dir}/hard`) === -E.ENOENT);
  ok("the new name is there", typeof fs.stat(`${dir}/moved`) !== "number");
  ok("unlink", fs.unlink(`${dir}/moved`) === 0);
  ok("unlink dropped one of two names",
    (() => { const s = fs.stat(path); return typeof s !== "number" && s.nlink === 1; })());
  ok("truncate by path", fs.truncate(path, 4) === 0);
  ok("truncate by path published the size",
    (() => { const s = fs.stat(path); return typeof s !== "number" && Number(s.size) === 4; })());
  ok("rmdir of a non-empty directory is ENOTEMPTY", fs.rmdir(dir) === -E.ENOTEMPTY);

  // statfs reports the quota the kernel asked the browser for once at boot.
  const fsinfo = fs.statfs();
  ok("statfs", typeof fsinfo !== "number" && fsinfo.namemax === 255 && fsinfo.files > 0n,
    typeof fsinfo === "number" ? fsinfo : { namemax: fsinfo.namemax, files: String(fsinfo.files) });

  // Refusals. Each is a measurement: a path call that cannot say no has no permission model.
  ok("open of a missing name is ENOENT", fs.open(`${dir}/nope`, O_RDONLY) === -E.ENOENT);
  ok("O_EXCL over an existing name is EEXIST",
    fs.open(path, O_WRONLY | O_CREAT | O_EXCL, 0o644) === -E.EEXIST);
  ok("open of a directory for writing is EISDIR", fs.open(dir, O_WRONLY) === -E.EISDIR);
  ok("a path through a file is ENOTDIR", fs.open(`${path}/x`, O_RDONLY) === -E.ENOTDIR);
  ok("read on a closed fd is EBADF", fs.read(fd, new Uint8Array(1)) === -E.EBADF);
  ok("a NUL in a path is EINVAL", fs.open(`${dir}/a\0b`, O_RDONLY) === -E.EINVAL);
  ok("a 256-character component is ENAMETOOLONG",
    fs.mkdir(`${dir}/${"x".repeat(NAME_MAX + 1)}`) === -E.ENAMETOOLONG);
  ok("mkdir in the root as a non-root uid is EACCES", fs.mkdir("/nope", 0o755) === -E.EACCES);
  ok("chown away from one's own uid is EPERM", fs.chown(path, 0, 0) === -E.EPERM);

  // CONSTRAINT 29'S GROUP ARM, both directions. Without these two rows a third of the mode word
  // is decoration: every other file here is owned by the credential that opens it, so deleting
  // the group arm from the VFS changes no other result in this bench.
  const granted = fs.open(GROUP_GRANT, O_RDONLY);
  ok("the group bits GRANT where neither owner nor other does", granted >= 0,
    { fd: granted, file: GROUP_GRANT });
  if (granted >= 0) {
    const one = new Uint8Array(1);
    const n = fs.read(granted, one);
    // What the reader would actually hit: the open succeeding is not the claim, the byte is.
    ok("the group-granted open reads the file's byte", n === 1 && one[0] === GROUP_BYTE,
      { n, got: one[0] });
    ok("close the group-granted fd", fs.close(granted) === 0);
  }
  const refused = fs.open(GROUP_DENY, O_RDONLY);
  if (refused >= 0) fs.close(refused);
  // THE DIRECTION THAT CATCHES A FALLTHROUGH. `other` has the read bit on this file and the group
  // does not, so a #may() that stopped consulting the group arm would answer from `other` and
  // let this through.
  ok("the group bits DENY where other would grant", refused === -E.EACCES,
    { errno: -refused, file: GROUP_DENY });

  const bad = rows.filter((r) => !r.pass);
  return { ok: bad.length === 0, calls: rows.length, bad, rows: bad.length ? rows : undefined };
}

/**
 * One path's mode word.
 *
 * Its own mode because proof (b) needs it: with the CRC removed, a flipped digit inside a journal
 * record's mode field is accepted and APPLIED, and the only way to say so is to read the
 * permission back through `stat` after the mount. A report that said "the record was accepted"
 * would be a claim about the parser; this is a claim about the user's file.
 */
function statmode(env, path) {
  const st = env.fs.stat(path);
  if (typeof st === "number") return { ok: false, at: "stat", errno: -st };
  return { ok: true, mode: st.mode & 0o7777, type: st.mode & S_IFMT, size: Number(st.size) };
}

/** Every mode in the list, written and read back through two different calls. */
function modebits(env) {
  const fs = env.fs;
  const rows = [];
  // Under /d/0, which `setup` gave to this uid. A uid-1000 process cannot mkdir in a 0755 root
  // owned by uid 0, and should not be able to.
  const dir = fs.mkdir("/d/0/modes", 0o755);
  if (dir < 0 && dir !== -E.EEXIST) return { ok: false, at: "mkdir", errno: -dir };
  for (let i = 0; i < 10; i += 1) {
    const path = `/d/0/modes/m${i}`;
    const mode = modeFor(i);
    const fd = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o600);
    if (fd < 0) {
      rows.push({ path, at: "open", errno: -fd });
      continue;
    }
    fs.close(fd);
    const ch = fs.chmod(path, mode);
    if (ch !== 0) {
      rows.push({ path, at: "chmod", errno: -ch });
      continue;
    }
    const st = fs.stat(path);
    rows.push({
      path, want: mode,
      got: typeof st === "number" ? -1 : st.mode & 0o7777,
      type: typeof st === "number" ? -1 : st.mode & S_IFMT,
    });
  }
  const bad = rows.filter((r) => r.want === undefined || r.got !== r.want || r.type !== S_IFREG);
  return { ok: bad.length === 0, rows, bad };
}

/**
 * PROOF (d)'S PLAN, in one place because three parties read it: writer A, writer B, and the
 * verifier that reopens the file afterwards. A verifier handed its expectations by the writer
 * compares two copies of one mistake, so nothing here is passed between processes — each derives
 * the whole layout from this object and from `bytesFor`.
 *
 * Both writers write AT THE SIZE THEY SAW AT OPEN. That is the configuration constraint 47
 * creates and the one copy-on-write has to survive: A's range is an append past the committed
 * size, so it lands in place; B's range then starts `aLen` bytes BELOW the size A published, so
 * it must copy up. `bLen < aLen` on purpose — B overwrites only the head of A's range, so A's
 * tail is a byte range that exists only if B's commit published a size taken from the inode
 * rather than from B's own stale snapshot.
 */
export const TWO_WRITERS = Object.freeze({
  index: 1, aLen: 32, aByte: 0xa1, bLen: 8, bByte: 0xb2,
});

/**
 * THE PENDING PROOF'S EXTRA WRITE, which is the state proof (d) cannot reach.
 *
 * Both of proof (d)'s writers are CLEAN when they write, so every decision either of them makes
 * is made from a base that happens to be current. The state that is not covered is a description
 * made dirty by an append that STAGED NO GENERATION — one write, no fsync, far past the committed
 * size — while another description commits underneath it. That one state produced three distinct
 * failures: a write below another description's published size landing in the committed
 * generation in place, an ftruncate returning committed bytes as zeroes under a blob length fsck
 * could not fault, and a journalled commit the writer itself refused, which bricked the next
 * mount read-only.
 *
 * `off` is far past the committed size ON PURPOSE: it makes the file sparse, so the gap must read
 * back as zeroes and the append's own bytes must be at `off` and nowhere else. A write adjacent
 * to the committed size could not tell a carried append from an off-by-one.
 */
export const PENDING_APPEND = Object.freeze({ off: 100, len: 4, byte: 0xc3 });

/**
 * THE ORPHANED GENERATION, as one byte and one length.
 *
 * Declared here and imported by the page that injects it AND by the program that reads the file
 * back, because the whole value of the clause is that the byte found in a grown range is traced
 * to the thing that put it there. Two copies of this value is a check that can pass against the
 * wrong byte.
 *
 * `gen` is 2 because every file the bench writes is committed at generation 1, so 2 is exactly
 * the name a crash between a copy-up and its commit leaves behind. `bytes` is far larger than
 * any file here so the reused blob's tail cannot be mistaken for a short read.
 */
export const ORPHANED = Object.freeze({ gen: 2, byte: 0xee, bytes: 1000 });

/**
 * O_APPEND'S FIXTURE: a base, and one range per appending description.
 *
 * THE BASE IS NON-EMPTY ON PURPOSE. Both appends on an empty file would land at 0 whether the
 * offset is re-read per write or taken once at open, so the first byte of the file would be the
 * same either way and the clause would pass against the defect. With eight bytes under them the
 * two implementations differ in the file's LENGTH — 16 against 12 — and in which writer's bytes
 * are missing.
 *
 * `aByte` and `bByte` differ so the SURVIVOR can be named. A clause that only counted bytes would
 * pass with both writers' ranges holding one writer's data.
 */
export const APPEND_PAIR = Object.freeze({
  base: 8, baseByte: 0x51, len: 4, aByte: 0xa0, bByte: 0xb0,
});

/**
 * The fd this process keeps between `go`s, and the size the file published when it was opened.
 *
 * TWO INTEGERS, which is the whole of what constraint 15 permits a process to hold: no handle, no
 * buffer, nothing whose release depends on this worker running shutdown code. The kernel's fd
 * table holds the description; `terminate()` is still a legal SIGKILL.
 */
let keptFd = -1;
let keptSize = -1;

/**
 * TWO O_APPEND DESCRIPTIONS ON ONE FILE, in one process, with no race to arrange.
 *
 * `>>` is the caller this is for, and M5's shell is where it arrives. POSIX sets an O_APPEND
 * description's offset to the end of the file atomically BEFORE EACH WRITE, so two of them on one
 * file cannot write over each other however they interleave — and read once at open, they always
 * do: both get the same end, both write there, and `write` returns the full count and `fsync`
 * returns 0 to both. Measured against that code: eight bytes acknowledged, the file 12 bytes long
 * with the first writer's four gone, and an explicit fsck reporting the volume clean.
 *
 * FOUR CALLS AND NO CONCURRENCY. The file is read back through a FRESH description, because the
 * writers' own `fstat` is not the question — what another reader finds is.
 */
function appendpair(env, path) {
  const fs = env.fs;
  const base = new Uint8Array(APPEND_PAIR.base).fill(APPEND_PAIR.baseByte);
  const fd0 = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  if (fd0 < 0) return { ok: false, at: "open", errno: -fd0 };
  const w0 = fs.write(fd0, base);
  const s0 = fs.fsync(fd0);
  const c0 = fs.close(fd0);
  if (w0 !== base.length || s0 !== 0 || c0 !== 0) {
    return { ok: false, at: "base", w0, s0, c0 };
  }

  const fds = [fs.open(path, O_WRONLY | O_APPEND), fs.open(path, O_WRONLY | O_APPEND)];
  if (fds[0] < 0 || fds[1] < 0) return { ok: false, at: "open-append", fds };
  const want = [...base];
  const wrote = [];
  const synced = [];
  for (const [i, fd] of fds.entries()) {
    const byte = i === 0 ? APPEND_PAIR.aByte : APPEND_PAIR.bByte;
    wrote.push(fs.write(fd, new Uint8Array(APPEND_PAIR.len).fill(byte)));
    synced.push(fs.fsync(fd));
    for (let b = 0; b < APPEND_PAIR.len; b += 1) want.push(byte);
  }
  const closed = fds.map((fd) => fs.close(fd));

  const rd = fs.open(path, O_RDONLY);
  if (rd < 0) return { ok: false, at: "reopen", errno: -rd };
  const st = fs.fstat(rd);
  const size = typeof st === "number" ? -st : Number(st.size);
  const read = size > 0 ? fs.readAll(rd, size) : new Uint8Array(0);
  fs.close(rd);
  const got = typeof read === "number" ? [] : [...read];

  const acknowledged = wrote.every((n) => n === APPEND_PAIR.len) && synced.every((r) => r === 0);
  const whole = got.length === want.length && got.every((b, i) => b === want[i]);
  return {
    ok: acknowledged && whole && closed.every((r) => r === 0),
    acknowledged, whole, wrote, synced, closed,
    size, wantSize: want.length, got, want,
  };
}

function wopen(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
  keptFd = fd;
  keptSize = Number(st.size);
  return { ok: true, fd, size: keptSize };
}

/** One writer's range, written at the size this process saw at open. NOT fsynced: the commit is
 *  `wsync`, so a proof that needs to observe the state BETWEEN the write and the commit can. */
function wput(env, which) {
  const fs = env.fs;
  if (keptFd < 0) return { ok: false, why: "no fd was kept; wopen must run first" };
  const length = which === "a" ? TWO_WRITERS.aLen : TWO_WRITERS.bLen;
  const value = which === "a" ? TWO_WRITERS.aByte : TWO_WRITERS.bByte;
  const buf = new Uint8Array(length).fill(value);
  const w = fs.pwrite(keptFd, buf, keptSize);
  if (w !== length) return { ok: false, at: "pwrite", got: w, want: length, off: keptSize };
  const st = fs.fstat(keptFd);
  return {
    ok: true, which, at: keptSize, length, value,
    publishedSize: typeof st === "number" ? -1 : Number(st.size),
  };
}

/** Commit whatever this description is holding, and report the size the metadata now publishes. */
function wsync(env) {
  const fs = env.fs;
  if (keptFd < 0) return { ok: false, why: "no fd was kept; wopen must run first" };
  const s = fs.fsync(keptFd);
  if (s !== 0) return { ok: false, at: "fsync", errno: -s };
  const st = fs.fstat(keptFd);
  return { ok: true, publishedSize: typeof st === "number" ? -1 : Number(st.size) };
}

/**
 * THE APPEND THAT STAGES NOTHING, and it is deliberately not fsynced.
 *
 * One pwrite far past the committed size. The COW rule permits it to land in the generation the
 * inode already points at, because the committed `size` does not name those bytes — so this
 * description is now DIRTY and owns NO generation, which is the state the pending proof is about.
 *
 * `fdSize` is what THIS description sees afterwards, and it must already include the appended
 * bytes: a caller that wrote and then fstat'ed its own fd must not be told its bytes are not
 * there. The other half of the append exception is not visible from here — whether a FRESH
 * description still sees the committed size — so the page takes that reading separately. Without
 * both halves this step could have committed something and proved nothing.
 */
function wpend(env) {
  const fs = env.fs;
  if (keptFd < 0) return { ok: false, why: "no fd was kept; wopen must run first" };
  const buf = new Uint8Array(PENDING_APPEND.len).fill(PENDING_APPEND.byte);
  const w = fs.pwrite(keptFd, buf, PENDING_APPEND.off);
  if (w !== PENDING_APPEND.len) {
    return { ok: false, at: "pwrite", got: w, want: PENDING_APPEND.len, off: PENDING_APPEND.off };
  }
  const st = fs.fstat(keptFd);
  const fdSize = typeof st === "number" ? -1 : Number(st.size);
  return {
    ok: true, at: PENDING_APPEND.off, length: w, value: PENDING_APPEND.byte,
    fdSize, wantFdSize: PENDING_APPEND.off + PENDING_APPEND.len, openSize: keptSize,
  };
}

/**
 * A write BELOW the committed size, then fsync.
 *
 * The shape that stages a new generation and SWINGS the inode onto it, which is what leaves
 * another description's outstanding append one generation behind. That is the state in which a
 * commit record names a superseded generation and the VFS refuses it — so this step is what makes
 * the refusal reachable at all, and it must be a WRITE rather than a truncate because a truncate
 * would also move the size and make the refusal ambiguous.
 */
function wbelow(env) {
  const fs = env.fs;
  if (keptFd < 0) return { ok: false, why: "no fd was kept; wopen must run first" };
  const buf = new Uint8Array(TWO_WRITERS.bLen).fill(TWO_WRITERS.bByte);
  const w = fs.pwrite(keptFd, buf, 0);
  if (w !== TWO_WRITERS.bLen) return { ok: false, at: "pwrite", got: w, want: TWO_WRITERS.bLen };
  const s = fs.fsync(keptFd);
  if (s !== 0) return { ok: false, at: "fsync", errno: -s };
  const st = fs.fstat(keptFd);
  return { ok: true, at: 0, length: w, value: TWO_WRITERS.bByte,
    publishedSize: typeof st === "number" ? -1 : Number(st.size) };
}

/**
 * Grow a file with `ftruncate`, commit it, and read the grown range back through a fresh
 * description. POSIX requires zeroes there.
 *
 * `foreignBytes` counts the orphaned generation's filler instead, which is what a staging floor
 * that cannot see an uncommitted blob publishes: the floor hands that generation's name out a
 * second time, the truncate opens the orphan, and its bytes become the file's.
 */
function wgrow(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const S = Number(st.size);
  const want = S + TWO_WRITERS.aLen;
  const t = fs.ftruncate(fd, want);
  if (t !== 0) { fs.close(fd); return { ok: false, at: "ftruncate", errno: -t }; }
  const s = fs.fsync(fd);
  if (s !== 0) { fs.close(fd); return { ok: false, at: "fsync", errno: -s }; }
  fs.close(fd);
  const fd2 = fs.open(path, O_RDONLY);
  if (fd2 < 0) return { ok: false, at: "reopen", errno: -fd2 };
  const st2 = fs.fstat(fd2);
  const size = typeof st2 === "number" ? -1 : Number(st2.size);
  const got = size < 0 ? null : fs.readAll(fd2, size);
  fs.close(fd2);
  if (typeof got === "number") return { ok: false, at: "read", errno: -got };
  let zeroed = 0;
  let foreign = 0;
  if (got) {
    for (let b = S; b < Math.min(size, want); b += 1) {
      if (got[b] === 0) zeroed += 1;
      if (got[b] === ORPHANED.byte) foreign += 1;
    }
  }
  return {
    ok: size === want && zeroed === TWO_WRITERS.aLen && foreign === 0,
    S, size, wantSize: want, wantZero: TWO_WRITERS.aLen, zeroed, foreignBytes: foreign,
    foreignByte: ORPHANED.byte, atS: got && size > S ? got[S] : -1,
  };
}

/**
 * THE DROP PROOF'S ACKNOWLEDGED APPEND, adjacent to the committed size.
 *
 * `off` is the file's own size, so this writes at exactly the boundary the COW rule splits on —
 * which is the shape the ordinary `>> file` does and the shape `dropclose` found the loss in.
 * `PENDING_APPEND` is sparse on purpose and could not have found this one: a sparse append's
 * offset is far enough out that a copy length taken from the wrong view is obviously wrong, while
 * an adjacent one is off by exactly the bytes nobody counted.
 */
export const DROP_APPEND = Object.freeze({ len: 4, byte: 0xc3 });

/** How far `wstage` grows the file past its committed size, with ftruncate and no commit. */
export const DROP_GROW = 64;

/**
 * THE COMPARE-AND-SWAP PROOF'S THREE BYTE VALUES AND ONE LENGTH.
 *
 * Three distinct values because the scenarios have three writers' ranges to tell apart, and
 * telling them apart IS the proof: a revert leaves the wrong one of them at an offset, never a
 * missing byte. `len` is shorter than the seeded file so a write at 0 and a write at `len` are
 * both strictly inside the committed size, which is what makes both of them stage a copy-up.
 */
export const CAS = Object.freeze({
  len: 4, belowByte: 0xd1, tailByte: 0xd2, thirdByte: 0xd3,
});

/**
 * How far past a file's end the CAS proof's reads ASK for.
 *
 * A read that only ever asks for `fstat`'s answer cannot catch a resurrection: the two numbers
 * come from the same place. Asking for more and getting exactly `fstat`'s answer back is the
 * clause — and 32 is the number of slack bytes `www/m2.html` plants, so the `slack` scenario asks
 * for precisely the bytes that are physically there and must still not get them.
 */
export const CAS_SLACK = 32;

/**
 * How many write-and-fsync rounds each of the two contending writers takes.
 *
 * The race has to happen rather than be hoped for: at one round apiece the two processes' syscalls
 * can serialise by luck. Sixteen was enough to make a commit lose its base, so the bounded retry
 * was exercised; it was NOT enough to reach either of the two states this number now has to
 * produce. Measured at 200 rounds per writer and not at 16: 13 of 200 fsyncs exhausted their
 * attempts and were refused under -EBUSY, and two concurrent journal appends collided on one
 * sequence number — 443 records with a duplicated 59, a remount that came up read-only and 37,409
 * bytes of discarded tail. Both are what `casretry` below is pointed at, so the number is theirs.
 */
export const CAS_ROUNDS = 200;

/**
 * An ACKNOWLEDGED append at the committed size, not fsynced.
 *
 * Two readings come back and both are the acknowledgement: `pwrite`'s own return value, and this
 * description's `fstat` afterwards. A caller told four bytes were written and then told the file
 * is the old length has been lied to once already, before any close.
 */
function wtail(env) {
  const fs = env.fs;
  if (keptFd < 0) return { ok: false, why: "no fd was kept; wopen must run first" };
  const buf = new Uint8Array(DROP_APPEND.len).fill(DROP_APPEND.byte);
  const w = fs.pwrite(keptFd, buf, keptSize);
  const st = fs.fstat(keptFd);
  return {
    ok: w === DROP_APPEND.len, at: keptSize, wrote: w, want: DROP_APPEND.len,
    fdSize: typeof st === "number" ? -st : Number(st.size),
    wantFdSize: keptSize + DROP_APPEND.len,
  };
}

/** Grow the file with `ftruncate` and DO NOT commit: a staged generation nothing has published. */
function wstage(env) {
  const fs = env.fs;
  if (keptFd < 0) return { ok: false, why: "no fd was kept; wopen must run first" };
  const want = keptSize + DROP_GROW;
  const t = fs.ftruncate(keptFd, want);
  const st = fs.fstat(keptFd);
  return {
    ok: t === 0, ftruncate: t, want,
    fdSize: typeof st === "number" ? -st : Number(st.size),
  };
}

/**
 * Close the kept fd and REPORT WHAT CLOSE RETURNED.
 *
 * The return value is the whole point of the mode. `close()` answering 0 after a commit it could
 * not publish is a loss the caller is never told about, on the ordinary path of write-then-exit:
 * no crash, no privilege, and an fsck that comes back clean afterwards because the blob length
 * matches the size the metadata published.
 */
function wclose(env) {
  const fs = env.fs;
  if (keptFd < 0) return { ok: false, why: "no fd was kept; wopen must run first" };
  const c = fs.close(keptFd);
  keptFd = -1;
  return { ok: true, close: c, errno: c < 0 ? -c : 0 };
}

/** `unlink` a path while THIS process still holds a description on it, and report every call made
 *  on the fd afterwards. S1's clauses read off this one row. */
function wunlink(env, path) {
  const fs = env.fs;
  if (keptFd < 0) return { ok: false, why: "no fd was kept; wopen must run first" };
  const u = fs.unlink(path);
  if (u !== 0) return { ok: false, at: "unlink", errno: -u };
  const buf = new Uint8Array(Math.max(1, keptSize));
  const r = fs.pread(keptFd, buf, 0, keptSize);
  const w = fs.pwrite(keptFd, new Uint8Array(1).fill(0xa5), 0);
  const st = fs.fstat(keptFd);
  const s = fs.fsync(keptFd);
  const t = fs.ftruncate(keptFd, 0);
  return {
    ok: true, unlink: u,
    read: r, write: w, fsync: s, ftruncate: t,
    fstat: typeof st === "number" ? st : Number(st.size),
    // Every operation refused, and every one of them under the SAME name. A mix of working reads
    // and failing writes is the one outcome S1 rules out.
    errnos: [r, w, s, t, typeof st === "number" ? st : 0].filter((x) => x < 0).map((x) => -x),
  };
}

/**
 * The drop proof's verifier: a FRESH description over the finished file.
 *
 * Both ranges are recomputed here from `bytesFor`, `TWO_WRITERS` and `DROP_APPEND` rather than
 * handed over by either writer. `tailOk` is the clause the loss moved: the appending description's
 * four acknowledged bytes are either in the file or they are gone, and `close()` returned 0 either
 * way against the old code.
 */
function dcheck(env, path) {
  const fs = env.fs;
  const S = bytesFor(TWO_WRITERS.index).length;
  const want = S + DROP_APPEND.len;
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const size = Number(st.size);
  const got = fs.readAll(fd, size);
  fs.close(fd);
  if (typeof got === "number") return { ok: false, at: "read", errno: -got };
  let belowOk = size >= TWO_WRITERS.bLen;
  for (let b = 0; belowOk && b < TWO_WRITERS.bLen; b += 1) belowOk = got[b] === TWO_WRITERS.bByte;
  let tailOk = size >= want;
  for (let b = S; tailOk && b < want; b += 1) tailOk = got[b] === DROP_APPEND.byte;
  return {
    ok: size === want && belowOk && tailOk,
    size, wantSize: want, read: got.length, belowOk, tailOk,
    atS: size > S ? got[S] : -1, wantAtS: DROP_APPEND.byte,
  };
}

/** A metadata op, and a test for one. Issued AFTER a commit the VFS refused: its journal record
 *  sits past the refused commit's position, so a volume that journalled a record its own VFS
 *  rejected discards this one at replay — a directory that had already returned success. */
function wmkdir(env, path) {
  const r = env.fs.mkdir(path, 0o755);
  return { ok: r === 0, errno: r < 0 ? -r : 0, path };
}

function wstat(env, path) {
  const st = env.fs.stat(path);
  return { ok: typeof st !== "number", errno: typeof st === "number" ? -st : 0, path };
}

/** One writer's range, written at the size this process saw at open and then FSYNCED, so the
 *  bytes are committed before the other writer is let near the inode. */
function wwrite(env, which) {
  const put = wput(env, which);
  if (!put.ok) return put;
  const synced = wsync(env);
  if (!synced.ok) return synced;
  return { ...put, publishedSize: synced.publishedSize };
}

/**
 * A FRESH description's view of the file, taken BETWEEN a writer's write and its commit.
 *
 * The question it answers is the one copy-on-write exists for: with the second writer's bytes
 * written but not committed, does the generation the metadata names still hold the FIRST writer's
 * fsynced bytes? `atS` is the byte that answers it — the first writer's value means the committed
 * generation was left alone, the second writer's means committed bytes were overwritten in place
 * under intact metadata.
 */
/**
 * THE COMPARE-AND-SWAP'S SCENARIOS, each one two descriptions over one inode.
 *
 * Both descriptions live in THIS process, which is not where the defect lives: the same shapes were
 * measured across two processes and behaved identically, because a description is kernel-side
 * either way and the race is between two commits rather than between two agents. One process keeps
 * the scenario in one call, so the interleaving is the program's rather than the page's.
 *
 * Every byte either description was told it wrote has to be in the file at the end. That is the
 * clause, and it is POSIX's: `pwrite` returned a count and `fsync` returned 0 to BOTH of them.
 */
function cas(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const which = spec.slice(bar + 1);
  const read = (p) => {
    const fd = fs.open(p, O_RDONLY);
    if (fd < 0) return { err: -fd };
    const st = fs.fstat(fd);
    if (typeof st === "number") { fs.close(fd); return { err: -st }; }
    const size = Number(st.size);
    // ASKED FOR MORE THAN THE FILE HOLDS, deliberately: a read past the end must stop at the end.
    // `readAll` returns what it got, so `bytes.length` is where the file really stops and a
    // resurrection of uncommitted slack shows up as a longer answer than `fstat` gave.
    const got = fs.readAll(fd, size + CAS_SLACK);
    fs.close(fd);
    if (typeof got === "number") return { err: -got };
    return { size, bytes: got };
  };

  if (which === "base" || which === "twostage" || which === "m4") {
    const fd1 = fs.open(path, O_RDWR);
    const fd2 = fs.open(path, O_RDWR);
    if (fd1 < 0 || fd2 < 0) return { ok: false, at: "open", fd1, fd2 };
    const st = fs.fstat(fd1);
    if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
    const S = Number(st.size);
    const row = { ok: true, which, S, wantBelow: CAS.belowByte, wantTail: CAS.tailByte };
    if (S < 2 * CAS.len) return { ok: false, at: "tooSmall", S };

    if (which === "twostage") {
      // Two staged generations over DISJOINT ranges, both inside the committed size, each fsynced.
      row.w1 = fs.pwrite(fd1, new Uint8Array(CAS.len).fill(CAS.belowByte), 0);
      row.w2 = fs.pwrite(fd2, new Uint8Array(CAS.len).fill(CAS.tailByte), CAS.len);
      row.fsync1 = fs.fsync(fd1);
      row.fsync2 = fs.fsync(fd2);
      row.close1 = fs.close(fd1);
      row.close2 = fs.close(fd2);
      const end = read(path);
      row.final = { size: end.size, err: end.err, at0: end.bytes ? end.bytes[0] : -1,
        atLen: end.bytes ? end.bytes[CAS.len] : -1 };
      row.calls = [row.w1, row.w2, row.fsync1, row.fsync2, row.close1, row.close2];
      row.everyCallSucceeded = row.w1 === CAS.len && row.w2 === CAS.len && row.fsync1 === 0
        && row.fsync2 === 0 && row.close1 === 0 && row.close2 === 0;
      row.bothKept = row.final.size === S && row.final.at0 === CAS.belowByte
        && row.final.atLen === CAS.tailByte;
      return row;
    }

    // `base` and `m4` share their first two steps: fd1 stages a copy-up by writing BELOW the
    // committed size, and fd2 then appends AT it and fsyncs — so fd1's copy was taken before the
    // bytes fd2 published existed.
    row.w1 = fs.pwrite(fd1, new Uint8Array(CAS.len).fill(CAS.belowByte), 0);
    row.w2 = fs.pwrite(fd2, new Uint8Array(CAS.len).fill(CAS.tailByte), S);
    row.fsync2 = fs.fsync(fd2);
    if (which === "m4") {
      // WHAT A DIRTY DESCRIPTION REPORTS once the file has grown underneath it. Its own staged
      // generation does not hold fd2's bytes; the FILE does, and `pwrite` returned their count.
      const mid = fs.fstat(fd1);
      row.dirtyFdSize = typeof mid === "number" ? -mid : Number(mid.size);
      row.wantDirtyFdSize = S + CAS.len;
      row.seekEnd = fs.seek(fd1, 0, SEEK_END);
      // An append through the DIRTY description, at the end `SEEK_END` just reported. Landing
      // below the real end makes this an overwrite of fd2's committed bytes.
      row.w3 = fs.write(fd1, new Uint8Array(CAS.len).fill(CAS.thirdByte));
      row.wantFinalSize = S + 2 * CAS.len;
    } else {
      row.wantFinalSize = S + CAS.len;
    }
    row.fsync1 = fs.fsync(fd1);
    row.close1 = fs.close(fd1);
    row.close2 = fs.close(fd2);
    const end = read(path);
    row.final = { size: end.size, err: end.err,
      at0: end.bytes && end.size > 0 ? end.bytes[0] : -1,
      atS: end.bytes && end.size > S ? end.bytes[S] : -1,
      atS2: end.bytes && end.size > S + CAS.len ? end.bytes[S + CAS.len] : -1,
      read: end.bytes ? end.bytes.length : -1 };
    row.everyCallSucceeded = row.w1 === CAS.len && row.w2 === CAS.len && row.fsync1 === 0
      && row.fsync2 === 0 && row.close1 === 0 && row.close2 === 0
      && (which !== "m4" || row.w3 === CAS.len);
    row.belowKept = row.final.at0 === CAS.belowByte;
    row.appendKept = row.final.atS === CAS.tailByte;
    row.bothKept = row.final.size === row.wantFinalSize && row.belowKept && row.appendKept
      && (which !== "m4" || row.final.atS2 === CAS.thirdByte);
    // The file stops where `fstat` says it does, which is the clause a read past the end fails.
    row.readStopsAtTheEnd = row.final.read === row.final.size;
    return row;
  }

  if (which === "read") {
    // The file as a fresh description finds it, every offset the scenarios write to reported by
    // name. The page recomputes what each one should be from `CAS` and `TWO_WRITERS`, so a changed
    // constant cannot make a clause pass.
    const end = read(path);
    if (end.err) return { ok: false, at: "read", errno: end.err };
    const S = bytesFor(TWO_WRITERS.index).length;
    return {
      ok: true, which, size: end.size, read: end.bytes.length,
      at0: end.size > 0 ? end.bytes[0] : -1,
      atLen: end.size > CAS.len ? end.bytes[CAS.len] : -1,
      atS: end.size > S ? end.bytes[S] : -1,
      atS2: end.size > S + CAS.len ? end.bytes[S + CAS.len] : -1,
      readStopsAtTheEnd: end.bytes.length === end.size,
    };
  }

  if (which === "slackin" || which === "slackwide") {
    // A WRITE INSIDE THE SLACK, which is the region an uncommitted append opens: above the
    // published size, below how far the file's bytes now reach. It changes bytes in the generation
    // the inode already points at and moves NO derived number — not the generation, not the
    // extent — so a compare-and-swap stamped `(gen, end)` could not see it and another
    // description's staged commit reverted it. Three calls, two descriptions, one process, no
    // crash, every call returning success.
    //
    // `slackwide` IS THE BOUNDARY, and it is here because it is the case the old stamp COULD see:
    // the same ordering with the patch one byte longer, so the extent moves. Both must keep the
    // patch. If only the wide one does, the counter is not being bumped by an in-place write.
    const fd1 = fs.open(path, O_RDWR);
    const fd2 = fs.open(path, O_RDWR);
    if (fd1 < 0 || fd2 < 0) return { ok: false, at: "open", fd1, fd2 };
    const st = fs.fstat(fd1);
    if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
    const S = Number(st.size);
    const patchLen = which === "slackwide" ? CAS.len + 1 : CAS.len;
    const row = { ok: true, which, S, patchLen };
    // 1. fd1 appends at the committed size. No fsync and no read: the slack stays open.
    row.w1 = fs.pwrite(fd1, new Uint8Array(CAS.len).fill(CAS.tailByte), S);
    // 2. fd2 writes below the committed size, so it copies the whole file up and records its base.
    row.w2 = fs.pwrite(fd2, new Uint8Array(CAS.len).fill(CAS.belowByte), 0);
    // 3. fd1 patches what it appended, in place, and makes it durable.
    row.w3 = fs.pwrite(fd1, new Uint8Array(patchLen).fill(CAS.thirdByte), S);
    row.fsync1 = fs.fsync(fd1);
    // 4. fd2 commits the generation it copied in step 2 — the one the patch is not in.
    row.fsync2 = fs.fsync(fd2);
    row.close1 = fs.close(fd1);
    row.close2 = fs.close(fd2);
    const end = read(path);
    row.final = { size: end.size, err: end.err,
      at0: end.bytes && end.size > 0 ? end.bytes[0] : -1,
      atS: end.bytes && end.size > S ? end.bytes[S] : -1,
      read: end.bytes ? end.bytes.length : -1 };
    row.wantFinalSize = S + patchLen;
    row.everyCallSucceeded = row.w1 === CAS.len && row.w2 === CAS.len && row.w3 === patchLen
      && row.fsync1 === 0 && row.fsync2 === 0 && row.close1 === 0 && row.close2 === 0;
    row.belowKept = row.final.at0 === CAS.belowByte;
    // THE WHOLE PATCH, not just its first byte: a revert that kept one byte and lost the rest is
    // the same defect.
    let patchKept = end.bytes ? end.size === row.wantFinalSize : false;
    for (let b = S; patchKept && b < S + patchLen; b += 1) {
      patchKept = end.bytes[b] === CAS.thirdByte;
    }
    row.patchKept = patchKept;
    row.revertedToTheStaleTail = row.final.atS === CAS.tailByte;
    row.bothKept = row.belowKept && row.patchKept;
    row.readStopsAtTheEnd = row.final.read === row.final.size;
    return row;
  }

  if (which === "dirtytrunc") {
    // WHERE ONE DESCRIPTION'S `read`, `fstat` AND `SEEK_END` CAN DISAGREE, which is what having two
    // renderers of the same number costs. fd1 holds a staged generation copied from an 8-byte base;
    // fd2 then publishes a SHORTER file. `read` clamped to the base the copy came FROM while
    // `fstat` and `SEEK_END` read the extent NOW, so the same description reported a 4-byte file
    // and then handed out 8 bytes, with no error on either call.
    const fd1 = fs.open(path, O_RDWR);
    const fd2 = fs.open(path, O_RDWR);
    if (fd1 < 0 || fd2 < 0) return { ok: false, at: "open", fd1, fd2 };
    const st = fs.fstat(fd1);
    if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
    const S = Number(st.size);
    const row = { ok: true, which, S };
    row.w1 = fs.pwrite(fd1, new Uint8Array(CAS.len).fill(CAS.belowByte), 0);
    row.t2 = fs.ftruncate(fd2, CAS.len);
    row.fsync2 = fs.fsync(fd2);
    // fd1's three answers, taken together. The read comes before the seek: `readAll` reads at the
    // cursor and `SEEK_END` leaves it at the end, where a read correctly returns nothing.
    const mid = fs.fstat(fd1);
    row.fdSize = typeof mid === "number" ? -mid : Number(mid.size);
    const got = fs.readAll(fd1, row.fdSize + CAS_SLACK);
    row.readLen = typeof got === "number" ? -got : got.length;
    row.seekEnd = fs.seek(fd1, 0, SEEK_END);
    row.fsync1 = fs.fsync(fd1);
    row.close1 = fs.close(fd1);
    row.close2 = fs.close(fd2);
    const end = read(path);
    row.final = { size: end.size, err: end.err,
      at0: end.bytes && end.size > 0 ? end.bytes[0] : -1,
      read: end.bytes ? end.bytes.length : -1 };
    row.wantFinalSize = CAS.len;
    row.everyCallSucceeded = row.w1 === CAS.len && row.t2 === 0 && row.fsync1 === 0
      && row.fsync2 === 0 && row.close1 === 0 && row.close2 === 0;
    // THE CLAUSE: one description, one answer. A read that stops short of the size the same fd
    // reports, or runs past it, is two renderers disagreeing.
    row.threeAgree = row.fdSize === CAS.len && row.seekEnd === CAS.len
      && row.readLen === row.fdSize;
    row.bothKept = row.final.size === row.wantFinalSize && row.final.at0 === CAS.belowByte
      && row.threeAgree;
    row.readStopsAtTheEnd = row.final.read === row.final.size;
    return row;
  }

  if (which === "slack") {
    // Bytes above the published size, planted page-side. Nothing here may see them: not `stat`,
    // not `fstat`, not a read that ASKS for them, and not the close.
    const byPath = fs.stat(path);
    const row = { ok: true, which,
      statSize: typeof byPath === "number" ? -byPath : Number(byPath.size) };
    const fd = fs.open(path, O_RDWR);
    if (fd < 0) return { ok: false, at: "open", errno: -fd };
    const st = fs.fstat(fd);
    row.fdSize = typeof st === "number" ? -st : Number(st.size);
    // THE READ COMES FIRST, from offset 0: `readAll` reads at the CURSOR, and `SEEK_END` below
    // leaves the cursor at the end, where a read correctly returns nothing.
    const got = fs.readAll(fd, row.fdSize + CAS_SLACK);
    row.read = typeof got === "number" ? -got : got.length;
    row.seekEnd = fs.seek(fd, 0, SEEK_END);
    row.close = fs.close(fd);
    const after = read(path);
    row.afterClose = { size: after.size, err: after.err,
      read: after.bytes ? after.bytes.length : -1 };
    row.nothingResurrected = row.statSize === row.fdSize && row.read === row.fdSize
      && row.seekEnd === row.fdSize && row.close === 0 && row.afterClose.size === row.fdSize
      && row.afterClose.read === row.fdSize;
    return row;
  }

  return { ok: false, at: "which", which };
}

/**
 * THE MERGE OF A STAGED GROW AND ANOTHER DESCRIPTION'S WRITE, range by range.
 *
 * C's `ftruncate` to `S + DROP_GROW` and E's write of `bLen` bytes at 0 were both acknowledged, so
 * all three ranges have an owner: E's bytes at the head, the seeded file's own bytes between there
 * and `S`, and ftruncate's zeroes above `S`. The middle range is what tells a real merge from a
 * truncate that re-grew a file somebody else had already replaced.
 */
function gcheck(env, path) {
  const fs = env.fs;
  const base = bytesFor(TWO_WRITERS.index);
  const S = base.length;
  const want = S + DROP_GROW;
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const size = Number(st.size);
  const got = fs.readAll(fd, size);
  fs.close(fd);
  if (typeof got === "number") return { ok: false, at: "read", errno: -got };
  let headOk = size >= TWO_WRITERS.bLen;
  for (let b = 0; headOk && b < TWO_WRITERS.bLen; b += 1) headOk = got[b] === TWO_WRITERS.bByte;
  let middleOk = size >= S;
  for (let b = TWO_WRITERS.bLen; middleOk && b < S; b += 1) middleOk = got[b] === base[b];
  let grownOk = size >= want;
  for (let b = S; grownOk && b < want; b += 1) grownOk = got[b] === 0;
  return {
    ok: size === want && got.length === size && headOk && middleOk && grownOk,
    size, wantSize: want, read: got.length, headOk, middleOk, grownOk,
  };
}

/**
 * ONE OF THE TWO CONTENDING WRITERS: `CAS_ROUNDS` rounds of one write and one fsync.
 *
 * `a` rewrites the same four bytes BELOW the committed size, so every round stages a copy-up and
 * swings. `b` appends four bytes at the end it saw at open, so every round publishes a size against
 * the generation the inode is on at that instant. Run at once, their syscalls interleave at the
 * kernel's own await points, and a commit that keeps losing its base runs out of attempts.
 *
 * EVERY ERRNO IS REPORTED, which is the clause: the ONLY refusal this is allowed to produce is the
 * bounded CAS's own -EBUSY. Measured value of that clause: the exhaustion path threw a
 * ReferenceError — the errno it meant to return was never imported — and the kernel's catch-all
 * turned it into -EIO, so a refusal arrived under a name that says nothing about what happened.
 */
function casloop(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const which = spec.slice(bar + 1);
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd, which };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st, which }; }
  const S = Number(st.size);
  const byte = which === "a" ? CAS.belowByte : CAS.tailByte;
  const buf = new Uint8Array(CAS.len).fill(byte);
  const writes = [];
  const syncs = [];
  for (let i = 0; i < CAS_ROUNDS; i += 1) {
    writes.push(fs.pwrite(fd, buf, which === "a" ? 0 : S + i * CAS.len));
    syncs.push(fs.fsync(fd));
  }
  const close = fs.close(fd);
  return {
    ok: true, which, S, close,
    wroteAll: writes.every((w) => w === CAS.len),
    errnos: [...writes, ...syncs, close].filter((r) => r < 0).map((r) => -r),
    acknowledgedEnd: which === "a" ? S : S + CAS_ROUNDS * CAS.len,
  };
}

/** One byte of a file, through a FRESH description. The read-back `casretry` checks a claim of
 *  durability against: a description of its own would answer out of its own staged generation. */
function byteAt(env, path, at) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return -fd > 0 ? { err: -fd } : { err: 1 };
  const into = new Uint8Array(1);
  const n = fs.pread(fd, into, at, 1);
  fs.close(fd);
  if (n < 0) return { err: -n };
  return { byte: n === 1 ? into[0] : -1, read: n };
}

/**
 * THE CONTENDING WRITER THAT DOES THE RIGHT THING WITH -EBUSY: it retries the fsync.
 *
 * A bounded compare-and-swap has one refusal to offer, and a caller's only correct response to it
 * is to ask again. The exhaustion arm used to free the staged generation first — so the retry found
 * nothing staged, took the "nothing to publish" arm and answered 0. The caller was told the data it
 * had just been refused was durable, and it was not there. Measured at 13 of 200 fsyncs with every
 * retry answering 0 (6.5%).
 *
 * WHICH IS WHY EVERY ROUND WRITES A DISTINCT VALUE: the byte at offset 0 then names the round whose
 * commit actually landed, so a claim of durability can be CHECKED rather than counted. A fresh
 * description is what reads it back — this writer's own fd would answer out of its staged
 * generation, which is the thing in question.
 *
 * `a` rewrites offset 0; `b` appends, which is what keeps moving the base `a` stages from.
 */
function casretry(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const which = spec.slice(bar + 1);
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd, which };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st, which }; }
  const S = Number(st.size);
  if (which === "b") {
    const buf = new Uint8Array(CAS.len).fill(CAS.tailByte);
    const calls = [];
    for (let i = 0; i < CAS_ROUNDS; i += 1) {
      calls.push(fs.pwrite(fd, buf, S + i * CAS.len));
      calls.push(fs.fsync(fd));
    }
    const close = fs.close(fd);
    return { ok: true, which, S, close,
      wroteAll: calls.filter((_, i) => i % 2 === 0).every((w) => w === CAS.len),
      errnos: [...calls, close].filter((r) => r < 0).map((r) => -r),
      acknowledgedEnd: S + CAS_ROUNDS * CAS.len };
  }
  const refused = [];
  const lies = [];
  let acked = 0;
  let retriesThatSaidZero = 0;
  /** The value of the last round whose `fsync` answered 0. What the file must hold at offset 0
   *  after the remount: the last write this caller was told was durable. */
  let lastDurable = 0;
  for (let i = 0; i < CAS_ROUNDS; i += 1) {
    const value = 1 + (i % 250);
    const w = fs.pwrite(fd, new Uint8Array(CAS.len).fill(value), 0);
    if (w !== CAS.len) { fs.close(fd); return { ok: false, at: "pwrite", i, got: w, which }; }
    let s = fs.fsync(fd);
    if (s < 0) {
      // The retry. It does NOT re-issue the write: `pwrite` already returned success, and a caller
      // that has to re-write its bytes after a refused flush has not been given a retryable error.
      const first = -s;
      s = fs.fsync(fd);
      if (s === 0) retriesThatSaidZero += 1;
      refused.push({ i, value, errno: first, retrySaid: s < 0 ? -s : 0 });
    }
    // Only a 0 is a claim of durability. A refusal that stayed refused claimed nothing and is
    // counted, not checked.
    if (s !== 0) continue;
    acked += 1;
    lastDurable = value;
    const seen = byteAt(env, path, 0);
    if (seen.err || seen.byte !== value) {
      lies.push({ i, value, seen: seen.err ? -seen.err : seen.byte,
        afterRetry: refused.length > 0 && refused[refused.length - 1].i === i });
    }
  }
  const close = fs.close(fd);
  return {
    ok: true, which, S, close, rounds: CAS_ROUNDS, acked, lastDurable,
    refusals: refused.length, retriesThatSaidZero, refused: refused.slice(-6),
    liedTimes: lies.length, lies: lies.slice(0, 6),
    errnos: [close].filter((r) => r < 0).map((r) => -r),
  };
}

/**
 * The contended file, byte by byte, against every value that has an owner.
 *
 * NO FOREIGN BYTE below the published size: each one is `a`'s value, `b`'s value, or the seeded
 * file's own byte at that offset. A zero where one of those belongs is a copy that carried the
 * wrong length, and a byte from neither writer is a generation from somewhere else.
 */
function cascheck(env, path) {
  const fs = env.fs;
  const base = bytesFor(TWO_WRITERS.index);
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const size = Number(st.size);
  const got = fs.readAll(fd, size);
  fs.close(fd);
  if (typeof got === "number") return { ok: false, at: "read", errno: -got };
  const foreign = [];
  let aBytes = 0;
  let bBytes = 0;
  for (let i = 0; i < got.length; i += 1) {
    if (got[i] === CAS.belowByte) aBytes += 1;
    else if (got[i] === CAS.tailByte) bBytes += 1;
    else if (i < base.length && got[i] === base[i]) continue;
    else if (foreign.length < 8) foreign.push({ at: i, byte: got[i] });
  }
  return {
    ok: got.length === size && foreign.length === 0,
    size, read: got.length, aBytes, bBytes, foreign,
    base: base.length, maxEnd: base.length + CAS_ROUNDS * CAS.len,
  };
}

/** One open, reported with its errno. Two processes run this against ONE path with no await
 *  between their `go` messages, so the two opens OVERLAP inside the kernel — which is the case
 *  constraint 47's refcount table could not arbitrate, because an open is not in the table until
 *  its handle exists. -EBUSY here is the kernel's own name for its own defect. */
function casopen(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  const size = typeof st === "number" ? -1 : Number(st.size);
  const c = fs.close(fd);
  return { ok: size >= 0 && c === 0, size, close: c };
}

function wpeek(env, path) {
  const fs = env.fs;
  const S = bytesFor(TWO_WRITERS.index).length;
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const size = Number(st.size);
  const got = fs.readAll(fd, size);
  fs.close(fd);
  if (typeof got === "number") return { ok: false, at: "read", errno: -got };
  return {
    ok: true, size, atS: size > S ? got[S] : -1,
    wantAtS: TWO_WRITERS.aByte,
    committedBytesIntact: size >= S + TWO_WRITERS.aLen && got[S] === TWO_WRITERS.aByte,
  };
}

/**
 * The pending proof's verifier: every byte of both writers, plus the sparse gap.
 *
 * Five ranges, each named, every expectation recomputed here from `TWO_WRITERS`,
 * `PENDING_APPEND` and `bytesFor` rather than handed over by a writer. The gap clause is what
 * separates "the append was carried" from "the append's offset happens to hold something": a
 * copy-up that carried the wrong length leaves foreign bytes or a short file there.
 */
function pcheck(env, path) {
  const fs = env.fs;
  const base = bytesFor(TWO_WRITERS.index);
  const S = base.length;
  const aEnd = S + TWO_WRITERS.aLen;
  const pendEnd = PENDING_APPEND.off + PENDING_APPEND.len;
  const want = Math.max(aEnd, pendEnd);
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const size = Number(st.size);
  const got = fs.readAll(fd, size);
  fs.close(fd);
  if (typeof got === "number") return { ok: false, at: "read", errno: -got };
  let prefixOk = size >= S;
  for (let b = 0; prefixOk && b < S; b += 1) prefixOk = got[b] === base[b];
  let bRangeOk = size >= S + TWO_WRITERS.bLen;
  for (let b = S; bRangeOk && b < S + TWO_WRITERS.bLen; b += 1) {
    bRangeOk = got[b] === TWO_WRITERS.bByte;
  }
  let aTailOk = size >= aEnd;
  for (let b = S + TWO_WRITERS.bLen; aTailOk && b < aEnd; b += 1) aTailOk = got[b] === TWO_WRITERS.aByte;
  let gapZeroed = size >= PENDING_APPEND.off;
  for (let b = aEnd; gapZeroed && b < PENDING_APPEND.off; b += 1) gapZeroed = got[b] === 0;
  let pendingOk = size >= pendEnd;
  for (let b = PENDING_APPEND.off; pendingOk && b < pendEnd; b += 1) {
    pendingOk = got[b] === PENDING_APPEND.byte;
  }
  return {
    ok: size === want && prefixOk && bRangeOk && aTailOk && gapZeroed && pendingOk,
    size, wantSize: want, read: got.length,
    prefixOk, bRangeOk, aTailOk, gapZeroed, pendingOk,
    atS: size > S ? got[S] : -1,
    atBEnd: size > S + TWO_WRITERS.bLen ? got[S + TWO_WRITERS.bLen] : -1,
    atGap: size > aEnd ? got[aEnd] : -1,
    atPend: size > PENDING_APPEND.off ? got[PENDING_APPEND.off] : -1,
  };
}

/**
 * Reopen the file and report whether every committed byte of BOTH writers is there.
 *
 * Three ranges, each named: the original bytes below the first write, writer B's range, and the
 * tail of writer A's range that B did not cover. The last one is the clause that fails when a
 * commit publishes a size computed from a stale base — the bytes are still in a blob and no
 * length names them.
 */
function wcheck(env, path) {
  const fs = env.fs;
  const base = bytesFor(TWO_WRITERS.index);
  const S = base.length;
  const fd3 = fs.open(path, O_RDONLY);
  if (fd3 < 0) return { ok: false, at: "open", errno: -fd3 };
  const st = fs.fstat(fd3);
  if (typeof st === "number") return { ok: false, at: "fstat", errno: -st };
  const size = Number(st.size);
  const got = fs.readAll(fd3, size);
  fs.close(fd3);
  if (typeof got === "number") return { ok: false, at: "read", errno: -got };
  const want = S + TWO_WRITERS.aLen;
  let prefixOk = size >= S;
  for (let b = 0; prefixOk && b < S; b += 1) prefixOk = got[b] === base[b];
  let bRangeOk = size >= S + TWO_WRITERS.bLen;
  for (let b = S; bRangeOk && b < S + TWO_WRITERS.bLen; b += 1) {
    bRangeOk = got[b] === TWO_WRITERS.bByte;
  }
  let aTailOk = size >= want;
  for (let b = S + TWO_WRITERS.bLen; aTailOk && b < want; b += 1) {
    aTailOk = got[b] === TWO_WRITERS.aByte;
  }
  return {
    ok: size === want && prefixOk && bRangeOk && aTailOk,
    size, wantSize: want, read: got.length,
    prefixOk, bRangeOk, aTailOk,
    // The bytes themselves at each boundary, so a failure says WHAT was there rather than only
    // that something was not.
    atS: size > S ? got[S] : -1,
    atBEnd: size > S + TWO_WRITERS.bLen ? got[S + TWO_WRITERS.bLen] : -1,
    last: size > 0 ? got[size - 1] : -1,
  };
}

/**
 * THE KILLED WRITER'S FIXTURE: one range, one contender, and a distinct value per round.
 *
 * `at` is `len`, so the victim's four bytes sit strictly BELOW the published size of the 8-byte
 * seeded file — which makes the write a copy-up with a recorded base — and strictly DISJOINT from
 * the contender's range at 0. Both halves matter: overlapping ranges would make a lost byte
 * indistinguishable from last-writer-wins, which is a legal outcome, while a write at or above the
 * published size would take the append arm and stage nothing at all.
 *
 * A DISTINCT VALUE PER ROUND, because a round whose write vanished reads back as a SURVIVOR if the
 * previous round left the same byte at the same offset. Twelve rounds, and 0x54 — the contender's
 * byte — is not among them.
 *
 * `hamRounds` is the contender's loop length. The victim's stage and its kill have to land INSIDE
 * that loop: the race is what is under test, and a contender that had already finished would leave
 * the teardown commit nothing to lose to.
 */
export const KILLED = Object.freeze({
  len: 4, at: 4, hamByte: 0x54, rounds: 12, hamRounds: 200,
  values: Object.freeze([0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c]),
});

/**
 * The victim: open, one acknowledged write below the published size, and then nothing.
 *
 * THE FD IS KEPT OPEN ON PURPOSE. The staged generation is live and uncommitted when the process
 * is killed, so the kernel's teardown is what closes the fd and `closeFd` is what commits — and
 * teardown cannot await the answer, which is the whole reason the note channel exists.
 */
function kstage(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const value = Number(spec.slice(bar + 1));
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  keptFd = fd;
  const w = fs.pwrite(fd, new Uint8Array(KILLED.len).fill(value), KILLED.at);
  return { ok: w === KILLED.len, wrote: w, at: KILLED.at, value, fd };
}

/**
 * The contender: rewrite offset 0 below the published size and fsync, in a loop.
 *
 * EVERY ERRNO IS KEPT, per call and with its round number. These are calls on a LIVE fd of a
 * process nobody is killing, so every one of them must succeed: the -EBADF measured here came from
 * another operation closing a superseded handle while this one held its id across an await, and a
 * count of successes would have reported that as a smaller number rather than as a failure.
 */
function kham(env, spec) {
  const fs = env.fs;
  const bar = spec.indexOf("|");
  const path = spec.slice(0, bar);
  const rounds = Number(spec.slice(bar + 1)) || KILLED.hamRounds;
  const fd = fs.open(path, O_RDWR);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const buf = new Uint8Array(KILLED.len).fill(KILLED.hamByte);
  const writeErrs = [];
  const syncErrs = [];
  let wrote = 0;
  let synced = 0;
  for (let i = 0; i < rounds; i += 1) {
    const w = fs.pwrite(fd, buf, 0);
    if (w === KILLED.len) wrote += 1; else writeErrs.push({ i, errno: -w });
    const s = fs.fsync(fd);
    if (s === 0) synced += 1; else syncErrs.push({ i, errno: -s });
  }
  const c = fs.close(fd);
  return { ok: true, rounds, wrote, synced, close: c,
    writeErrs: writeErrs.slice(0, 10), syncErrs: syncErrs.slice(0, 10),
    writeErrCount: writeErrs.length, syncErrCount: syncErrs.length };
}

/** What the file holds now, through a FRESH description: the size, the contender's byte and the
 *  victim's. Neither writer is asked what it thinks it wrote. */
function kread(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, at: "open", errno: -fd };
  const st = fs.fstat(fd);
  if (typeof st === "number") { fs.close(fd); return { ok: false, at: "fstat", errno: -st }; }
  const size = Number(st.size);
  const got = fs.readAll(fd, size);
  fs.close(fd);
  if (typeof got === "number") return { ok: false, at: "read", errno: -got };
  return { ok: true, size, read: got.length,
    at0: size > 0 ? got[0] : -1,
    atVictim: size > KILLED.at ? got[KILLED.at] : -1 };
}

/** A refusal is a measurement too: constraint 29's mode bits mean nothing unless a credential
 *  that lacks the bit is actually turned away. */
function deny(env, path) {
  const fs = env.fs;
  const fd = fs.open(path, O_RDONLY);
  if (fd >= 0) {
    fs.close(fd);
    return { ok: false, why: "the open SUCCEEDED, so the mode bits are decoration", fd };
  }
  return { ok: true, errno: -fd, uid: env.pid };
}

export { bytesFor, modeFor, pathFor };
