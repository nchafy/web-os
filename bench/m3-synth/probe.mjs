// `/proc` and `/dev` under plain Node, against a hand-built process table.
//
// No browser, no SAB, no OPFS: the generated filesystems read a ProcTable and a TraceRing and
// nothing else, so the whole of M3's generated half is host-testable. What this CANNOT cover is
// the syscall path into them — that needs the kernel, and www/m3.html drives it.
import { ProcTable, RUNNING, ZOMBIE } from "../../src/kernel/table.mjs";
import { makeProcFS } from "../../src/kernel/procfs.mjs";
import { makeDevFS, renderTrace } from "../../src/kernel/devfs.mjs";
import { TraceRing, TR_ENTER, TR_EXIT } from "../../src/kernel/trace.mjs";
import { MountTable, MNT_RO, FS_OPFS, FS_PROC, FS_DEV } from "../../src/fs/mounts.mjs";
import { DIR, FILE } from "../../src/fs/vfs.mjs";

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ name, ok, got: ok ? undefined : got, want: ok ? undefined : want });
};
const checkThat = (name, ok, detail) => results.push({ name, ok: !!ok, detail: ok ? undefined : detail });
const code = (fn) => { try { fn(); return "<no throw>"; } catch (e) { return e.code || e.message; } };
const text = (fs, rel) => new TextDecoder().decode(fs.bytesAt(rel));

// ---- a table with three processes --------------------------------------------------------
const table = new ProcTable(128);
const a = table.alloc(); a.state = RUNNING; a.cmdline = "/usr/bin/sh"; a.cwd = "/home";
const b = table.alloc(); b.state = RUNNING; b.cmdline = "/usr/bin/cat"; b.ppid = a.pid;
const c = table.alloc(); c.state = RUNNING; c.cmdline = "/usr/bin/doomed";
a.fds.set(1, { kind: 0, refs: 2 });
a.fds.set(2, { kind: 0, refs: 2 });
a.fds.set(3, { kind: 1, refs: 1, ino: 42, type: "file", pos: 7, flags: 2 });

const trace = new TraceRing(64 * 1024, { enforce: false });
const mounts = new MountTable();
mounts.add("/", { fs: { tag: "opfs" }, type: FS_OPFS });
const proc = makeProcFS({ table: () => table, mounts: () => mounts });
const dev = makeDevFS({ trace: () => trace });
proc.setDev(mounts.add("/proc", { fs: proc, type: FS_PROC, flags: MNT_RO }).dev);
dev.setDev(mounts.add("/dev", { fs: dev, type: FS_DEV, flags: MNT_RO }).dev);

// ---- PROOF 1: ls /proc enumerates live pids ---------------------------------------------
check("/proc lists every live pid", proc.listRel("/").map((e) => e.name),
  [String(a.pid), String(b.pid), String(c.pid), "mounts"]);
check("/proc is a directory", proc.stat({}, "/").type, DIR);
check("a pid directory is a directory", proc.stat({}, `/${a.pid}`).type, DIR);
check("a pid directory lists its files", proc.listRel(`/${a.pid}`).map((e) => e.name),
  ["status", "cmdline", "cwd", "fd"]);

// ---- PROOF 1, the half that is the actual subject: a killed pid VANISHES -----------------
// Reaped, as waitpid does it. The directory must be gone on the very next read, because nothing
// cached the listing.
const doomed = c.pid;
checkThat("the doomed pid is listed before it dies",
  proc.listRel("/").some((e) => e.name === String(doomed)), "it was never there");
checkThat("and its status is readable", text(proc, `/${doomed}/status`).includes(`pid:\t${doomed}`),
  text(proc, `/${doomed}/status`));
table.recordExit(c, 0, 0);
table.free(c);
checkThat("a reaped pid is gone from the listing",
  !proc.listRel("/").some((e) => e.name === String(doomed)), "the killed pid lingered");
check("and its directory is ENOENT", code(() => proc.stat({}, `/${doomed}`)), "ENOENT");
check("and its status file is ENOENT", code(() => proc.bytesAt(`/${doomed}/status`)), "ENOENT");
check("the survivors are still there", proc.listRel("/").map((e) => e.name),
  [String(a.pid), String(b.pid), "mounts"]);

// A ZOMBIE is still a process: it has not been reaped and its pid is its parent's handle.
b.state = ZOMBIE;
table.recordExit(b, 0, 3);
checkThat("a zombie is still listed",
  proc.listRel("/").some((e) => e.name === String(b.pid)), "a zombie vanished before its reap");
checkThat("and reports state zombie", text(proc, `/${b.pid}/status`).includes("state:\tzombie"),
  text(proc, `/${b.pid}/status`));
checkThat("and its exit value", text(proc, `/${b.pid}/status`).includes("exitvalue:\t3"),
  text(proc, `/${b.pid}/status`));

// ---- the four files M3 names -------------------------------------------------------------
const status = text(proc, `/${a.pid}/status`);
checkThat("status reports the pid", status.includes(`pid:\t${a.pid}`), status);
checkThat("status reports the state", status.includes("state:\trunning"), status);
checkThat("status reports the fd count", status.includes("fds:\t3"), status);
checkThat("status reports caps unsigned", status.includes("caps:\t0xffffffff"), status);
check("cmdline is the program, NUL-terminated", text(proc, `/${a.pid}/cmdline`), "/usr/bin/sh\0");
check("cwd is the working directory", text(proc, `/${a.pid}/cwd`), "/home\n");
check("fd lists the open descriptors", proc.listRel(`/${a.pid}/fd`).map((e) => e.name),
  ["1", "2", "3"]);
checkThat("an fd describes its description", text(proc, `/${a.pid}/fd/3`).includes("ino:\t42"),
  text(proc, `/${a.pid}/fd/3`));
check("an unopened fd is ENOENT", code(() => proc.bytesAt(`/${a.pid}/fd/9`)), "ENOENT");

// cwd must track the field, not a value captured at build time.
a.cwd = "/tmp/elsewhere";
check("cwd is read live", text(proc, `/${a.pid}/cwd`), "/tmp/elsewhere\n");

// ---- /proc is read-only, and refuses in ONE place ---------------------------------------
for (const [what, fn] of [
  ["mkdir", () => proc.mkdir({}, "/x")],
  ["rmdir", () => proc.rmdir({}, `/${a.pid}`)],
  ["unlink", () => proc.unlink({}, `/${a.pid}/status`)],
  ["rename", () => proc.rename({}, `/${a.pid}`, "/x")],
  ["symlink", () => proc.symlink({}, "t", "/x")],
  ["link", () => proc.link({}, "/a", "/b")],
  ["chmod", () => proc.chmod({}, `/${a.pid}/status`, 0o777)],
  ["chown", () => proc.chown({}, `/${a.pid}/status`, 1, 1)],
  ["open for write", () => proc.openDecision({}, `/${a.pid}/status`, { wantW: true })],
  ["open with O_CREAT", () => proc.openDecision({}, "/new", { create: true })],
]) check(`/proc refuses ${what} with EROFS`, code(fn), "EROFS");

// ---- a nonexistent or malformed path -----------------------------------------------------
check("a non-numeric pid is ENOENT", code(() => proc.stat({}, "/nonsense")), "ENOENT");
check("a pid with a trailing character is ENOENT", code(() => proc.stat({}, `/${a.pid}x`)), "ENOENT");
check("a pid with a leading zero is ENOENT", code(() => proc.stat({}, "/07")), "ENOENT");
check("an unknown per-pid file is ENOENT", code(() => proc.stat({}, `/${a.pid}/nope`)), "ENOENT");
check("a path below a per-pid file is ENOENT", code(() => proc.stat({}, `/${a.pid}/status/x`)), "ENOENT");
check("a dead pid is ENOENT", code(() => proc.stat({}, "/99999")), "ENOENT");

// ---- /proc/mounts makes the mount table readable ----------------------------------------
const mt = text(proc, "/mounts");
checkThat("mounts lists the root", mt.includes("opfs\t/\trw"), mt);
checkThat("mounts lists /proc read-only", mt.includes("proc\t/proc\tro"), mt);
checkThat("mounts lists /dev read-only", mt.includes("dev\t/dev\tro"), mt);
checkThat("mounts reports a device number per row",
  mt.split("\n").filter(Boolean).every((l) => /dev=\d+$/.test(l)), mt);

// ---- stat reports a device, and the two generated mounts differ -------------------------
checkThat("a /proc file reports /proc's device",
  proc.stat({}, `/${a.pid}/status`).dev === proc.dev && proc.dev !== 0, proc.dev);
checkThat("a /dev file reports /dev's device",
  dev.stat({}, "/trace").dev === dev.dev && dev.dev !== 0, dev.dev);
checkThat("the two generated mounts have different devices", proc.dev !== dev.dev,
  `both ${proc.dev}`);

// ---- a VOLATILE file publishes no size --------------------------------------------------
// Linux's own /proc does this, and the measurement behind it is in SynthFS's `#info`: a stat
// then a read of /proc/<pid>/status disagreed by two bytes, because the file carries the
// process's syscall counters and reading it advanced them. Any published number is stale.
for (const rel of [`/${a.pid}/status`, `/${a.pid}/cmdline`, `/${a.pid}/cwd`, "/mounts"]) {
  const label = rel.replace(String(a.pid), "<pid>");
  check(`${label} publishes no size`, proc.stat({}, rel).size, 0);
  checkThat(`${label} still reads real bytes`, proc.bytesAt(rel).length > 0,
    "a zero size must not mean an empty file");
}
// A STABLE generated file publishes its real size, so the zero above is a statement about
// volatility and not about generated files in general.
check("/dev/zero publishes its real size", dev.stat({}, "/zero").size, dev.bytesAt("/zero").length);
check("/dev/null publishes zero because it IS empty", dev.stat({}, "/null").size, 0);
check("/dev/trace publishes no size", dev.stat({}, "/trace").size, 0);
checkThat("/dev/trace still reads real bytes", dev.bytesAt("/trace").length > 0, "empty trace");
// A directory still reports its entry count.
checkThat("a directory reports its entry count",
  proc.stat({}, "/").size === proc.listRel("/").length, proc.stat({}, "/").size);

// ---- PROOF 3: /dev/trace, and the dropped counter ---------------------------------------
check("/dev lists its devices", dev.listRel("/").map((e) => e.name), ["trace", "null", "zero"]);
check("/dev/trace is read-only to a process", dev.stat({}, "/trace").mode, 0o444);
check("/dev/null is writable in its mode bits", dev.stat({}, "/null").mode, 0o666);

// A known syscall sequence: getpid(0) enter/exit, then write(1) enter/exit.
trace.put(TR_ENTER, a.pid, 0, 1, 0, 0, 1.0);
trace.put(TR_EXIT, a.pid, 0, 1, a.pid, 0, 1.0);
trace.put(TR_ENTER, a.pid, 1, 2, 1, 5, 2.0);
trace.put(TR_EXIT, a.pid, 1, 2, 5, 5, 2.0);
const tr = text(dev, "/trace");
checkThat("the trace header reports dropped", /^dropped:\t0$/m.test(tr), tr.slice(0, 200));
checkThat("the trace header reports the ring size", /^bytes:\t65536$/m.test(tr), tr.slice(0, 200));
checkThat("the trace names the syscall, not just its number", tr.includes("\tgetpid\t"), tr);
checkThat("the trace distinguishes enter from exit",
  tr.includes("\tgetpid\tenter\t") && tr.includes("\tgetpid\texit\t"), tr);
checkThat("the trace replays the sequence in order",
  tr.indexOf("\tgetpid\tenter") < tr.indexOf("\tgetpid\texit")
  && tr.indexOf("\tgetpid\texit") < tr.indexOf("\twrite\tenter"), tr);
check("four records written", trace.stats().written, 4);
checkThat("reading /dev/trace does not consume it", text(dev, "/trace") === tr, "two reads differed");

// THE CONTROL'S SUBJECT: lap the ring and the counter must move.
for (let i = 0; i < 5000; i += 1) trace.put(TR_ENTER, a.pid, 0, i, 0, 0, 3.0);
const lapped = text(dev, "/trace");
checkThat("a lapped ring reports a non-zero dropped count",
  /^dropped:\t(?!0$)\d+$/m.test(lapped), lapped.slice(0, 200));
check("and the count is exactly what was overwritten", trace.dropped, 5004 - 2048);
checkThat("and it is marked undersized", /^undersized:\t1$/m.test(lapped), lapped.slice(0, 200));

// A ring at the floor is not undersized and drops nothing over the same sequence.
const big = new TraceRing();
for (let i = 0; i < 5000; i += 1) big.put(TR_ENTER, 1, 0, i, 0, 0, 1.0);
const bigText = renderTrace(big);
checkThat("a 16 MiB ring drops nothing over 5,000 records", /^dropped:\t0$/m.test(bigText),
  bigText.slice(0, 200));
checkThat("and is not marked undersized", /^undersized:\t0$/m.test(bigText), bigText.slice(0, 200));
checkThat("and says how many of them it showed", /^shown:\t256$/m.test(bigText),
  bigText.slice(0, 200));

// /dev is read-only too.
check("/dev refuses unlink with EROFS", code(() => dev.unlink({}, "/trace")), "EROFS");
check("/dev refuses an unknown device with ENOENT", code(() => dev.stat({}, "/sda")), "ENOENT");

// ---- openDecision hands back a snapshot -------------------------------------------------
const dec = proc.openDecision({}, `/${a.pid}/status`, {});
checkThat("open marks the decision synthetic", dec.synth === true, dec);
checkThat("open carries the bytes", dec.bytes.length > 0, dec.bytes.length);
checkThat("open carries the device", dec.dev === proc.dev, dec.dev);
// A directory needs O_DIRECTORY here, as it does on the OPFS volume (constraint 82).
check("open on a directory with O_DIRECTORY succeeds",
  proc.openDecision({}, "/", { dirOk: true }).type, DIR);
check("open on a directory without O_DIRECTORY is EISDIR",
  code(() => proc.openDecision({}, "/", {})), "EISDIR");
check("O_DIRECTORY on a file is ENOTDIR",
  code(() => proc.openDecision({}, `/${a.pid}/status`, { dirOk: true })), "ENOTDIR");
// The snapshot must NOT follow later changes -- that is what makes a two-read status coherent.
const before = new TextDecoder().decode(dec.bytes);
a.calls += 99;
checkThat("the snapshot does not change under the reader",
  new TextDecoder().decode(dec.bytes) === before, "the snapshot moved");
checkThat("but a fresh open sees the change",
  text(proc, `/${a.pid}/status`) !== before, "a fresh read was stale");

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  ok: failed.length === 0, total: results.length, failed: failed.length, failures: failed,
}, null, 2));
process.exit(failed.length ? 1 : 0);
