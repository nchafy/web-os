// `/proc`: the process table as files, REGENERATED PER READ AND NEVER CACHED. M3's negative
// control is a cached listing, which must make a killed pid linger in `ls /proc`.

import { DIR, FILE } from "../fs/vfs.mjs";
import { SynthFS, relParts } from "./synth.mjs";
import { RUNNING, SPAWNING, ZOMBIE, DEAD } from "./table.mjs";

const STATE_NAME = {
  [SPAWNING]: "spawning",
  [RUNNING]: "running",
  [ZOMBIE]: "zombie",
  [DEAD]: "dead",
};

/** `/proc/<pid>`'s children. `fd` is a directory and is handled separately, its children not being
 *  a fixed set. */
const PID_FILES = {
  /** One `key: value` line per fact, as Linux's own `status` is, so `grep` needs no parser. */
  status: (slot) => [
    `pid:\t${slot.pid}`,
    `ppid:\t${slot.ppid}`,
    `pgid:\t${slot.pgid}`,
    `sid:\t${slot.sid}`,
    `state:\t${STATE_NAME[slot.state] ?? slot.state}`,
    `uid:\t${slot.uid}`,
    `gid:\t${slot.gid}`,
    // Unsigned, because CAP_ALL is -1 as an i32 and "caps: -1" does not read as every bit set.
    `caps:\t0x${(slot.caps >>> 0).toString(16)}`,
    `fds:\t${countFds(slot)}`,
    `calls:\t${slot.calls}`,
    `replies:\t${slot.replies}`,
    // THE CALL THIS PROCESS IS PARKED IN, or -1. `state` is `running` for everything that is not a
    // zombie, so without this "blocked in `read`" is indistinguishable from "has not exited".
    // `calls` minus `replies` gives the DEPTH; this gives the IDENTITY.
    `syscall:\t${slot.inflight ? slot.inflight.nr : -1}`,
    `errors:\t${slot.errors}`,
    // Meaningful only for a zombie, printed always: a field that appears and disappears is one
    // every reader has to branch on.
    `exitkind:\t${slot.exitKind}`,
    `exitvalue:\t${slot.exitValue}`,
    "",
  ].join("\n"),

  /** NUL-terminated like Linux's, so a later `argv` is more entries rather than a format change. */
  cmdline: (slot) => `${slot.cmdline || ""}\0`,

  /** A plain file holding the path, where Linux has a symlink: `SynthFS` refuses to grow symlinks
   *  it cannot resolve (see its `lstat`). */
  cwd: (slot) => `${slot.cwd}\n`,
};

function countFds(slot) {
  let n = 0;
  for (const d of slot.fds.fds) if (d) n += 1;
  return n;
}

/** Every open fd number on a slot, ascending. */
function fdNumbers(slot) {
  const out = [];
  slot.fds.fds.forEach((d, i) => {
    if (d) out.push(i);
  });
  return out;
}

/** A line of facts, not Linux's symlink: an fd on a pipe or a window has no path to point at. */
function fdLine(d) {
  const parts = [`kind:\t${d.kind}`, `refs:\t${d.refs}`];
  if (d.ino !== undefined) parts.push(`ino:\t${d.ino}`);
  if (d.type !== undefined) parts.push(`type:\t${d.type}`);
  if (d.pos !== undefined) parts.push(`pos:\t${d.pos}`);
  if (d.flags !== undefined) parts.push(`flags:\t0x${(d.flags >>> 0).toString(16)}`);
  return `${parts.join("\n")}\n`;
}

/** `ctx.table` and `ctx.mounts` are getters, called per read and never captured. */
export function makeProcFS(ctx) {
  // A ZOMBIE still has a row: unreaped, its pid is still its parent's handle.
  const slotOf = (pid) => {
    const t = ctx.table();
    return t ? t.get(pid) : undefined;
  };

  /** M3's FIRST NEGATIVE CONTROL, and the one deliberate cache here: `ctx.cache` is false in every
   *  real boot and the kernel refuses to set it without bench=1. */
  let cached = null;
  const livePids = () => {
    const t = ctx.table();
    if (!t) return [];
    if (ctx.cache) {
      if (cached === null) cached = [...t.live].map((s) => s.pid).sort((a, b) => a - b);
      return cached;
    }
    return [...t.live].map((s) => s.pid).sort((a, b) => a - b);
  };

  /** `/proc/mounts`: the mount table, one row per line. */
  const mountsText = () => {
    const m = ctx.mounts();
    if (!m) return "";
    return `${m.rows().map((r) => [
      r.type, r.path, r.readOnly ? "ro" : "rw", `dev=${r.dev}`,
    ].join("\t")).join("\n")}\n`;
  };

  const lookup = (rel) => {
    const parts = relParts(rel);

    if (parts.length === 0) return { type: DIR };
    if (parts.length === 1 && parts[0] === "mounts") {
      // A mount can be added or removed, so a published size would go stale.
      return { type: FILE, content: mountsText(), volatile: true };
    }

    // A non-numeric first component is ENOENT, not a parse error.
    const pid = pidOf(parts[0]);
    if (pid === null) return null;
    const slot = slotOf(pid);
    if (!slot) return null;

    if (parts.length === 1) return { type: DIR };

    if (parts[1] === "fd") {
      if (parts.length === 2) return { type: DIR };
      if (parts.length === 3) {
        const n = pidOf(parts[2]);
        if (n === null) return null;
        const d = slot.fds.get(n);
        if (!d) return null;
        return { type: FILE, content: fdLine(d), volatile: true };
      }
      return null;
    }

    if (parts.length === 2 && Object.prototype.hasOwnProperty.call(PID_FILES, parts[1])) {
      return { type: FILE, content: PID_FILES[parts[1]](slot), volatile: true };
    }
    return null;
  };

  const list = (rel) => {
    const parts = relParts(rel);
    if (parts.length === 0) return [...livePids().map(String), "mounts"];
    const pid = pidOf(parts[0]);
    if (pid === null) return null;
    const slot = slotOf(pid);
    if (!slot) return null;
    if (parts.length === 1) return [...Object.keys(PID_FILES), "fd"];
    if (parts.length === 2 && parts[1] === "fd") return fdNumbers(slot).map(String);
    return null;
  };

  return new SynthFS({ name: "proc", lookup, list, mutErrno: "EROFS" });
}

/** Strict on purpose: `Number("7 ")` and `parseInt("7x")` are both 7, and either would make
 *  `/proc/7x/status` an alias for `/proc/7/status`. */
function pidOf(text) {
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}
