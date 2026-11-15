// M3's process program. Every assertion below goes through a real syscall from inside a real
// process worker.
//
// That is the point rather than a formality: `/proc` read from the kernel's own thread would prove
// the generator works and nothing about whether a PROCESS can reach it. The whole of M3 is a
// mount table and two generated filesystems sitting underneath the path syscalls, so the only
// honest place to test it is on the far side of those syscalls.
//
// Modes, chosen by argv[0]:
//
//   proclist          read /proc and report the pids it enumerates
//   procread PID      read every /proc/<PID> file through open/read/close
//   procgone PID      assert /proc/<PID> is gone -- open, stat and readdir must all refuse
//   devtrace          read /dev/trace and report its header counters and record count
//   mounts            read /proc/mounts and report the table
//   devices PATHS     stat several paths and report each one's st_dev, NUL-joined paths
//   usr               read /usr through the provider mount
//   readonly PATH     every mutation against PATH, each errno reported
//   knownseq          issue a KNOWN syscall sequence, then read /dev/trace back and find it
//   tracefill N       issue N syscalls as fast as possible, to lap an undersized ring
//   tmpfs             /tmp is writable: create, write, read back, append, truncate, unlink
//   regress           the defects an adversarial review found, each as the syscalls that trip it

import {
  E, O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_EXCL, O_DIRECTORY,
  S_IFREG, S_IFMT, DT_DIR, DT_REG, SEEK_END, SYS_getpid,
} from "../../src/abi.mjs";

const DEC = new TextDecoder();

/** Read a whole generated file through open/read/close. Generated files are small, so one
 *  read of a generous buffer is the whole file; the count is asserted, never assumed. */
function slurp(fs, path) {
  const fd = fs.open(path, O_RDONLY);
  if (fd < 0) return { ok: false, fd, errno: -fd };
  const buf = new Uint8Array(65536);
  const n = fs.read(fd, buf);
  const closed = fs.close(fd);
  if (n < 0) return { ok: false, errno: -n, closed };
  return { ok: true, text: DEC.decode(buf.subarray(0, n)), bytes: n, closed };
}

/** The names in a directory, through a directory fd and readdir -- not through any side channel. */
function listDir(fs, path) {
  // O_DIRECTORY, which THIS SYSTEM requires to open a directory — see constraint 82. Both the VFS
  // and the generated filesystems refuse without it.
  const fd = fs.open(path, O_RDONLY | O_DIRECTORY);
  if (fd < 0) return { ok: false, errno: -fd };
  const names = [];
  let cookie = 0;
  // Bounded: a readdir that never advanced its cookie would otherwise spin here forever, and a
  // hang is the one failure mode a harness cannot report on.
  for (let guard = 0; guard < 4096; guard += 1) {
    const page = fs.readdir(fd, cookie);
    if (typeof page === "number") {
      fs.close(fd);
      return { ok: false, errno: -page, names };
    }
    if (!page.entries.length) break;
    for (const e of page.entries) names.push({ name: e.name, type: e.type, ino: String(e.ino) });
    if (page.cookie === cookie) {
      fs.close(fd);
      return { ok: false, why: "readdir did not advance its cookie", names };
    }
    cookie = page.cookie;
  }
  fs.close(fd);
  return { ok: true, names };
}

/** Parse a `key:\tvalue` block into an object. The format /proc files use. */
function fields(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const cut = line.indexOf("\t");
    if (cut > 0) out[line.slice(0, cut).replace(/:$/, "")] = line.slice(cut + 1);
  }
  return out;
}

function proclist(env) {
  const fs = env.fs;
  const listed = listDir(fs, "/proc");
  const pids = listed.names.filter((e) => /^[0-9]+$/.test(e.name)).map((e) => Number(e.name));
  return {
    ok: listed.ok,
    pids: pids.sort((a, b) => a - b),
    names: listed.names.map((e) => e.name),
    // Every pid entry must be a DIRECTORY in the dirent type field. A readdir that reported them
    // as regular files would make `ls -l /proc` wrong while the listing looked right.
    allDirs: listed.names.filter((e) => /^[0-9]+$/.test(e.name)).every((e) => e.type === DT_DIR),
    self: env.pid,
    // The reading process must see ITSELF. A /proc that omitted the caller would be a /proc
    // generated from a stale snapshot taken before the caller existed.
    sawSelf: pids.includes(env.pid),
    why: listed.why,
    errno: listed.errno,
  };
}

function procread(env, pid) {
  const fs = env.fs;
  const status = slurp(fs, `/proc/${pid}/status`);
  const cmdline = slurp(fs, `/proc/${pid}/cmdline`);
  const cwd = slurp(fs, `/proc/${pid}/cwd`);
  const fdDir = listDir(fs, `/proc/${pid}/fd`);
  const st = status.ok ? fields(status.text) : {};
  // One fd, read through /proc. fd 1 is the sink every process is given at spawn.
  const fd1 = slurp(fs, `/proc/${pid}/fd/1`);
  /* A VOLATILE file publishes no size from `stat`, and an EXACT one from `fstat` on an open
   * description. The two differ on purpose: the path call cannot know what a future read will
   * generate, and the fd call holds the snapshot it will return. */
  const statted = fs.stat(`/proc/${pid}/status`);
  const fd = fs.open(`/proc/${pid}/status`, O_RDONLY);
  const fstatted = fd >= 0 ? fs.fstat(fd) : fd;
  const buf = new Uint8Array(65536);
  const fdRead = fd >= 0 ? fs.read(fd, buf) : fd;
  if (fd >= 0) fs.close(fd);
  return {
    ok: status.ok && cmdline.ok && cwd.ok && fdDir.ok && fd1.ok,
    status: st,
    statusPid: Number(st.pid),
    statusState: st.state,
    pidMatches: Number(st.pid) === pid,
    cmdline: cmdline.ok ? cmdline.text : null,
    cmdlineNulTerminated: cmdline.ok && cmdline.text.endsWith("\0"),
    cwd: cwd.ok ? cwd.text.replace(/\n$/, "") : null,
    fds: fdDir.names.map((e) => e.name),
    fd1: fd1.ok ? fields(fd1.text) : null,
    // stat publishes 0 for a volatile file; fstat publishes the snapshot's exact length.
    statSize: typeof statted === "object" && statted !== null ? Number(statted.size) : null,
    statPublishesNoSize: typeof statted === "object" && statted !== null
      && Number(statted.size) === 0,
    fstatSize: typeof fstatted === "object" && fstatted !== null ? Number(fstatted.size) : null,
    fdReadBytes: fdRead,
    fstatMatchesRead: typeof fstatted === "object" && fstatted !== null
      && Number(fstatted.size) === fdRead,
    readBytes: status.bytes,
    readIsNonEmpty: status.bytes > 0,
    // A generated file is a regular file with the type bits set, like any other.
    isReg: typeof statted === "object" && statted !== null
      && (statted.mode & S_IFMT) === S_IFREG,
  };
}

/**
 * THE SUBJECT OF PROOF 1: a dead pid's directory is GONE.
 *
 * Three independent routes to it, because a cache could live behind any one of them: the listing,
 * a direct stat, and an open. All three must refuse.
 */
function procgone(env, pid) {
  const fs = env.fs;
  const listed = listDir(fs, "/proc");
  const names = listed.names.map((e) => e.name);
  const statted = fs.stat(`/proc/${pid}`);
  const opened = fs.open(`/proc/${pid}/status`, O_RDONLY);
  if (opened >= 0) fs.close(opened);
  return {
    ok: true,
    // NOT `pid`: the kernel stamps the answering process's pid onto every result row, and a
    // program field of the same name used to overwrite it. The kernel now wins that collision,
    // but a program that still shadows a kernel field is a program whose row reads two ways.
    queried: pid,
    listed: names,
    inListing: names.includes(String(pid)),
    statErrno: typeof statted === "number" ? -statted : 0,
    statRefused: typeof statted === "number" && -statted === E.ENOENT,
    openErrno: opened < 0 ? -opened : 0,
    openRefused: opened < 0 && -opened === E.ENOENT,
    // The pids that ARE alive, so a listing that lost everything is distinguishable from one
    // that correctly lost one.
    livePids: names.filter((n) => /^[0-9]+$/.test(n)).map(Number).sort((a, b) => a - b),
  };
}

function devtrace(env) {
  const fs = env.fs;
  const got = slurp(fs, "/dev/trace");
  if (!got.ok) return { ok: false, errno: got.errno };
  const head = fields(got.text);
  const rows = got.text.split("\n").filter((l) => /^\d+\t/.test(l));
  return {
    ok: true,
    bytes: Number(head.bytes),
    capacity: Number(head.capacity),
    written: Number(head.written),
    // THE NUMBER THE THIRD CONTROL IS ABOUT. Read as a string first so an absent field is
    // distinguishable from a zero -- NaN rather than 0.
    dropped: Number(head.dropped),
    droppedPresent: head.dropped !== undefined,
    available: Number(head.available),
    undersized: head.undersized === "1",
    shown: Number(head.shown),
    rows: rows.length,
    firstRows: rows.slice(0, 4),
  };
}

/**
 * A KNOWN syscall sequence, then the trace read back to find it.
 *
 * `getpid` three times then one `stat`, which is a sequence no other part of this program issues
 * in that order. Proof 3 is that the trace REPLAYS it: the records must appear, in order, with
 * entry and exit paired.
 */
function knownseq(env) {
  const fs = env.fs;
  const before = slurp(fs, "/dev/trace");
  const beforeWritten = before.ok ? Number(fields(before.text).written) : -1;
  // The sequence. getpid is the cheapest call in the ABI and touches nothing, so a record of it
  // cannot be confused with a side effect of the trace read itself.
  const a = env.syscall(SYS_getpid);
  const b = env.syscall(SYS_getpid);
  const c = env.syscall(SYS_getpid);
  const st = fs.stat("/proc");
  const after = slurp(fs, "/dev/trace");
  if (!after.ok) return { ok: false, errno: after.errno };
  const rows = after.text.split("\n").filter((l) => /^\d+\t/.test(l))
    .map((l) => {
      const f = l.split("\t");
      return { seq: Number(f[0]), pid: Number(f[1]), nr: Number(f[2]), name: f[3], kind: f[4] };
    });
  const mine = rows.filter((r) => r.pid === env.pid);
  // Three getpid enter/exit pairs in a row, somewhere in my own records.
  const names = mine.map((r) => `${r.name}:${r.kind}`);
  const want = ["getpid:enter", "getpid:exit", "getpid:enter", "getpid:exit",
    "getpid:enter", "getpid:exit"];
  let foundAt = -1;
  for (let i = 0; i + want.length <= names.length; i += 1) {
    if (want.every((w, j) => names[i + j] === w)) { foundAt = i; break; }
  }
  const seqs = mine.map((r) => r.seq);
  return {
    ok: true,
    self: env.pid,
    getpidAgreed: a === env.pid && b === env.pid && c === env.pid,
    statOk: typeof st === "object" && st !== null,
    beforeWritten,
    afterWritten: Number(fields(after.text).written),
    // Two records per syscall: the trace must have grown by at least 2 per call issued.
    grewBy: Number(fields(after.text).written) - beforeWritten,
    myRecords: mine.length,
    sequenceFoundAt: foundAt,
    sequenceFound: foundAt >= 0,
    // Monotonic within one reader's window, which is what makes "in order" assertable at all.
    seqMonotonic: seqs.every((s, i) => i === 0 || s > seqs[i - 1]),
    sawEnterAndExit: names.includes("getpid:enter") && names.includes("getpid:exit"),
    tail: names.slice(-10),
  };
}

/** Issue N cheap syscalls, to lap an undersized ring. */
function tracefill(env, n) {
  const count = Math.max(0, Math.min(n, 200000));
  for (let i = 0; i < count; i += 1) env.syscall(SYS_getpid);
  return { ok: true, issued: count };
}

function mounts(env) {
  const got = slurp(env.fs, "/proc/mounts");
  if (!got.ok) return { ok: false, errno: got.errno };
  const rows = got.text.split("\n").filter(Boolean).map((l) => {
    const f = l.split("\t");
    return { type: f[0], path: f[1], mode: f[2], dev: f[3] };
  });
  return {
    ok: true,
    rows,
    paths: rows.map((r) => r.path).sort(),
    // Every row must carry a device number, and they must all differ: that is what makes the
    // table observable rather than decorative.
    devs: rows.map((r) => r.dev),
    devsDistinct: new Set(rows.map((r) => r.dev)).size === rows.length,
    rootIsRw: rows.some((r) => r.path === "/" && r.mode === "rw"),
    procIsRo: rows.some((r) => r.path === "/proc" && r.mode === "ro"),
  };
}

/** st_dev per path, which is how POSIX says to tell two filesystems apart. */
function devices(env, joined) {
  const fs = env.fs;
  const paths = String(joined).split("\0").filter(Boolean);
  const rows = paths.map((path) => {
    const st = fs.stat(path);
    if (typeof st === "number") return { path, errno: -st };
    return { path, dev: Number(st.dev), ino: String(st.ino), mode: st.mode };
  });
  const ok = rows.filter((r) => r.dev !== undefined);
  return {
    ok: ok.length === rows.length,
    rows,
    // The root volume and the two generated mounts must report three different devices.
    distinct: new Set(ok.map((r) => r.dev)).size,
    anyZero: ok.some((r) => r.dev === 0),
  };
}

function usr(env) {
  const fs = env.fs;
  const top = listDir(fs, "/usr");
  const lib = listDir(fs, "/usr/lib");
  const file = slurp(fs, "/usr/lib/syscall.mjs");
  const st = fs.stat("/usr/lib/syscall.mjs");
  return {
    ok: top.ok && lib.ok && file.ok,
    topNames: top.names.map((e) => e.name).sort(),
    libNames: lib.names.map((e) => e.name).sort(),
    bytes: file.ok ? file.bytes : 0,
    // The bytes must be the real module, not an empty file a failed mount left behind.
    looksLikeSource: file.ok && file.text.includes("export function"),
    dev: typeof st === "object" && st !== null ? Number(st.dev) : null,
    topErrno: top.errno,
    libErrno: lib.errno,
    fileErrno: file.errno,
  };
}

/**
 * Every mutation against a read-only mount, each errno reported separately.
 *
 * A single "it refused" would pass for a filesystem that refused for the wrong reason, or that
 * refused one call and silently accepted another.
 */
function readonly(env, path) {
  const fs = env.fs;
  const rows = [];
  const add = (call, r) => rows.push({ call, errno: typeof r === "number" && r < 0 ? -r : 0, raw: r });
  add("open O_WRONLY", (() => { const fd = fs.open(path, O_WRONLY); if (fd >= 0) fs.close(fd); return fd; })());
  add("open O_CREAT", (() => {
    const fd = fs.open(`${path}.new`, O_WRONLY | O_CREAT); if (fd >= 0) fs.close(fd); return fd;
  })());
  add("unlink", fs.unlink(path));
  add("chmod", fs.chmod(path, 0o777));
  add("chown", fs.chown(path, 1, 1));
  add("truncate", fs.truncate(path, 0));
  add("rename", fs.rename(path, `${path}.moved`));
  add("mkdir", fs.mkdir(`${path}.dir`, 0o755));
  add("rmdir", fs.rmdir(path));
  add("symlink", fs.symlink("target", `${path}.link`));
  return {
    ok: true,
    rows,
    // EVERY one must be a refusal. A zero anywhere is a mutation that landed on a read-only mount.
    allRefused: rows.every((r) => r.errno !== 0),
    allRofs: rows.every((r) => r.errno === E.EROFS),
    errnos: rows.map((r) => r.errno),
  };
}


/**
 * `/tmp` is the one mount besides the root that accepts a write, so this is the only place the
 * writable path is exercised through real syscalls on a non-OPFS filesystem.
 *
 * Every row is `{call, ok, detail}` so a failure names the call rather than the section.
 */
function tmpfs(env) {
  const fs = env.fs;
  const rows = [];
  // EVERY CALL IS EVALUATED ONCE, into a variable, and then asserted. Putting the call in the
  // detail argument as well runs it twice, which for `unlink` means the second one reports ENOENT
  // on a file the first correctly removed — a test that breaks its own subject.
  //
  // The detail is reduced to a primitive for the same reason `regress` does it: a stat record
  // carries BigInt fields and BigInt cannot cross the CDP boundary.
  const flat = (v) => (typeof v === "bigint" ? String(v)
    : (v !== null && typeof v === "object" ? `{${Object.keys(v).join(",")}}` : v));
  const ok = (call, pass, detail) => rows.push({ call, ok: !!pass, detail: flat(detail) });
  const dir = `/tmp/d${env.pid}`;
  const path = `${dir}/f`;
  const ENC = new TextEncoder();

  const made = fs.mkdir(dir, 0o755);
  ok("mkdir", made === 0, made);
  const again = fs.mkdir(dir, 0o755);
  ok("mkdir again is EEXIST", again === -E.EEXIST, again);

  const fd = fs.open(path, O_RDWR | O_CREAT, 0o644);
  ok("open O_CREAT", fd >= 0, fd);
  if (fd < 0) return { ok: false, rows, failed: ["open O_CREAT"] };

  const body = ENC.encode("hello tmpfs");
  const wrote = fs.write(fd, body);
  ok("write", wrote === body.length, wrote);

  // fstat must report the CURRENT size, not one captured at open.
  const st = fs.fstat(fd);
  ok("fstat reports the written size",
    typeof st === "object" && Number(st.size) === body.length, st && String(st.size));
  // fsync on a tmpfs SUCCEEDS: there is nothing to force, and -ENOSYS would make a program that
  // checked the return treat a correct no-op as a failure.
  const synced = fs.fsync(fd);
  ok("fsync succeeds", synced === 0, synced);

  // A SECOND description must see the first's bytes — the property that makes this a filesystem
  // and not a snapshot, and the one F_SYNTH deliberately does not have.
  const fd2 = fs.open(path, O_RDONLY);
  ok("a second open succeeds", fd2 >= 0, fd2);
  const buf = new Uint8Array(256);
  const n = fs.read(fd2, buf);
  ok("the second description sees the first's bytes", n === body.length, n);
  const text = n > 0 ? new TextDecoder().decode(buf.subarray(0, n)) : "";
  ok("and the bytes are right", text === "hello tmpfs", text);

  const end = fs.seek(fd2, 0, SEEK_END);
  ok("seek SEEK_END is the file length", end === body.length, end);

  const cut = fs.ftruncate(fd, 5);
  ok("ftruncate", cut === 0, cut);
  const pst = fs.stat(path);
  ok("stat through the path sees the truncation",
    typeof pst === "object" && Number(pst.size) === 5, pst && String(pst.size));
  ok("a tmpfs file is a regular file",
    typeof pst === "object" && (pst.mode & S_IFMT) === S_IFREG,
    typeof pst === "object" ? pst.mode : pst);
  ok("and reports /tmp's device, not zero",
    typeof pst === "object" && Number(pst.dev) !== 0,
    typeof pst === "object" ? String(pst.dev) : pst);

  const dfd = fs.open(dir, O_RDONLY | O_DIRECTORY);
  ok("open the directory", dfd >= 0, dfd);
  const page = dfd >= 0 ? fs.readdir(dfd, 0) : -1;
  ok("readdir lists the file",
    typeof page === "object" && page.entries.some((e) => e.name === "f"),
    typeof page === "object" ? page.entries.map((e) => e.name) : page);
  if (dfd >= 0) fs.close(dfd);

  const moded = fs.chmod(path, 0o600);
  ok("chmod", moded === 0, moded);
  const after = fs.stat(path);
  ok("the mode stuck", typeof after === "object" && (after.mode & 0o7777) === 0o600,
    typeof after === "object" ? (after.mode & 0o7777).toString(8) : after);

  fs.close(fd);
  if (fd2 >= 0) fs.close(fd2);

  const gone = fs.unlink(path);
  ok("unlink", gone === 0, gone);
  const statted = fs.stat(path);
  ok("stat after unlink is ENOENT", statted === -E.ENOENT, statted);
  const reopened = fs.open(path, O_RDONLY);
  ok("open after unlink is ENOENT", reopened === -E.ENOENT, reopened);
  if (reopened >= 0) fs.close(reopened);
  const rmd = fs.rmdir(dir);
  ok("rmdir", rmd === 0, rmd);

  return { ok: rows.every((r) => r.ok), rows, failed: rows.filter((r) => !r.ok).map((r) => r.call) };
}


/**
 * The defects the M3 review found, each reduced to the syscalls that trip it.
 *
 * Every row here FAULTED THE KERNEL or lost a caller's bytes before it was fixed, and none of M3's
 * ten sections reached any of them — which is the argument for the mode existing. A fixed bug
 * becomes a check that would have caught it.
 */
function regress(env) {
  const fs = env.fs;
  const rows = [];
  // THE DETAIL IS ALWAYS A PRIMITIVE. A stat record's `ino` and `size` are BigInt — the ABI's own
  // choice, so a u64 cannot lose precision as a double — and BigInt cannot cross the CDP boundary
  // the page is read through: handing one back made the whole check BROKEN with
  // "Object couldn't be returned by value", which says nothing about the subject.
  const show = (v) => {
    if (typeof v === "bigint") return String(v);
    if (v === null || v === undefined) return String(v);
    if (typeof v === "object") {
      return Array.isArray(v) ? v.map(show).join(",") : `{${Object.keys(v).join(",")}}`;
    }
    return v;
  };
  const ok = (call, pass, detail) => rows.push({ call, ok: !!pass, detail: show(detail) });
  const ENC = new TextEncoder();

  // (1) An inherited key on /dev's file table was a phantom file, and reading one faulted the
  //     kernel: `/dev/constructor` produced an object where bytes were expected.
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    const st = fs.stat(`/dev/${name}`);
    ok(`/dev/${name} is ENOENT`, st === -E.ENOENT, st);
    const fd = fs.open(`/dev/${name}`, O_RDONLY);
    ok(`opening /dev/${name} is ENOENT`, fd === -E.ENOENT, fd);
    if (fd >= 0) {
      // If it opened, read it: that is the call that faulted. Reaching here at all is a failure,
      // and the read must still not take the kernel down with it.
      const n = fs.read(fd, new Uint8Array(64));
      ok(`reading /dev/${name} did not fault`, typeof n === "number", n);
      fs.close(fd);
    }
  }
  // The real devices must still be there, so the guard did not refuse everything.
  const traceSt = fs.stat("/dev/trace");
  ok("/dev/trace is still there", typeof traceSt === "object", traceSt);

  // (2) seek(SEEK_END) on a /tmp DIRECTORY fd asked a directory for its byte length and threw
  //     out of a handler the dispatcher does not wrap.
  const dfd = fs.open("/tmp", O_RDONLY | O_DIRECTORY);
  ok("/tmp opens as a directory", dfd >= 0, dfd);
  if (dfd >= 0) {
    const r = fs.seek(dfd, 0, SEEK_END);
    ok("seek SEEK_END on a directory is EISDIR, not a fault", r === -E.EISDIR, r);
    fs.close(dfd);
  }

  // (3) O_APPEND resolved its offset ONCE at open, so two appending descriptions both started at
  //     the same end and the second overwrote the first. The file must end up holding BOTH.
  const path = `/tmp/append${env.pid}`;
  const a = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  ok("open the append target", a >= 0, a);
  const b = fs.open(path, O_WRONLY | O_APPEND);
  const c = fs.open(path, O_WRONLY | O_APPEND);
  ok("two O_APPEND descriptions open", b >= 0 && c >= 0, [b, c]);
  if (a >= 0) fs.close(a);
  if (b >= 0 && c >= 0) {
    const wb = fs.write(b, ENC.encode("BBBB"));
    const wc = fs.write(c, ENC.encode("CCCC"));
    ok("both appends report their count", wb === 4 && wc === 4, [wb, wc]);
    fs.close(b);
    fs.close(c);
    const rfd = fs.open(path, O_RDONLY);
    const buf = new Uint8Array(64);
    const n = rfd >= 0 ? fs.read(rfd, buf) : -1;
    if (rfd >= 0) fs.close(rfd);
    const text = n > 0 ? new TextDecoder().decode(buf.subarray(0, n)) : "";
    // EIGHT bytes, both writers' payloads present. Four means one overwrote the other.
    ok("both appends survived", n === 8, { n, text });
    ok("the first writer's bytes are there", text.includes("BBBB"), text);
    ok("and the second writer's", text.includes("CCCC"), text);
  }
  fs.unlink(path);

  // (4) `..` was stripped lexically at the kernel edge, so a `..` through a component that does
  //     not exist stopped failing. The VFS resolves it per component against real parents.
  //
  //     BOTH ENDS ON THE ROOT VOLUME, deliberately: the mount lookup is lexical by necessity, so
  //     a path whose normalized form lands in ANOTHER mount is decided before any walk happens.
  //     That case is asserted separately below as the documented behaviour it is.
  //     The TARGET is `/` itself, which needs nothing created: this process runs as uid 1000 and
  //     the root directory is root-owned 0755, so a `mkdir` here is correctly EACCES and would
  //     have made the test fail for a reason that is not its subject.
  const rootSt = fs.stat("/");
  ok("the root resolves", typeof rootSt === "object", rootSt);
  const through = fs.stat("/definitely-not-here/../");
  ok("a dotdot through a missing component is ENOENT", through === -E.ENOENT, through);
  const deeper = fs.stat("/definitely-not-here/also-not-here/../../");
  ok("and through two of them", deeper === -E.ENOENT, deeper);

  // A dotdot above the root stays at the root, which is POSIX.
  const aboveRoot = fs.stat("/../tmp");
  ok("a dotdot above the root stays at the root", typeof aboveRoot === "object", aboveRoot);
  // A dotdot INSIDE a generated mount is lexical, and that is correct there: it has no symlinks.
  const inProc = fs.stat(`/proc/${env.pid}/../${env.pid}/status`);
  ok("a dotdot inside /proc resolves", typeof inProc === "object", inProc);
  // THE DOCUMENTED LEXICAL CASE (constraint 77's family): a path whose normalized form lands in
  // another mount is resolved by the mount lookup, which cannot walk. So this SUCCEEDS even
  // though `/definitely-not-here` does not exist, and that is recorded rather than asserted away.
  const crossing = fs.stat("/definitely-not-here/../tmp");
  ok("a dotdot whose normalized form lands in another mount is lexical",
    typeof crossing === "object", crossing);

  return { ok: rows.every((r) => r.ok), rows, failed: rows.filter((r) => !r.ok).map((r) => r.call) };
}

export function run(env, go) {
  const mode = String((env.argv && env.argv[0]) || (go && go.argv && go.argv[0]) || "noop");
  const arg = (env.argv && env.argv[1]) !== undefined
    ? env.argv[1] : (go && go.argv ? go.argv[1] : undefined);
  const t0 = performance.now();
  let out;
  switch (mode) {
    case "proclist": out = proclist(env); break;
    case "procread": out = procread(env, Number(arg)); break;
    case "procgone": out = procgone(env, Number(arg)); break;
    case "devtrace": out = devtrace(env); break;
    case "knownseq": out = knownseq(env); break;
    case "tracefill": out = tracefill(env, Number(arg) || 0); break;
    case "mounts": out = mounts(env); break;
    case "devices": out = devices(env, arg); break;
    case "usr": out = usr(env); break;
    case "readonly": out = readonly(env, String(arg)); break;
    case "tmpfs": out = tmpfs(env); break;
    case "regress": out = regress(env); break;
    default: out = { ok: false, why: `unknown mode ${mode}` };
  }
  return { mode, ms: performance.now() - t0, ...out };
}
