// `/proc`: the process table as files, generated on every read.
//
// MILESTONES.md M3 calls this "the clearest demonstration that a process is a first-class object",
// and that is the whole reason it is in the spine rather than in a later milestone. A process with
// a pid you cannot enumerate is a promise; `ls /proc` is the proof.
//
// NOTHING HERE CACHES. Every function reads the live table at the moment it is called. The
// milestone's negative control is a cached `/proc` listing, and it must make a killed pid linger —
// so the absence of a cache is the subject under test, not an implementation detail.

import { DIR, FILE } from "../fs/vfs.mjs";
import { SynthFS, relParts } from "./synth.mjs";
import { RUNNING, SPAWNING, ZOMBIE, DEAD } from "./table.mjs";

/** The process states, as names. A number in a file is a number the reader has to look up. */
const STATE_NAME = {
  [SPAWNING]: "spawning",
  [RUNNING]: "running",
  [ZOMBIE]: "zombie",
  [DEAD]: "dead",
};

/**
 * `/proc/<pid>`'s children. A TABLE, so adding `/proc/<pid>/wchan` later is one row.
 *
 * Each value renders one file's content from a slot. `fd` is the one directory among them and is
 * handled separately, because its children are not a fixed set.
 */
const PID_FILES = {
  /** One `key: value` line per fact, which is what Linux's own `status` is and what makes it
   *  greppable by M5's `grep` without a parser. */
  status: (slot) => [
    `pid:\t${slot.pid}`,
    `ppid:\t${slot.ppid}`,
    `pgid:\t${slot.pgid}`,
    `sid:\t${slot.sid}`,
    `state:\t${STATE_NAME[slot.state] ?? slot.state}`,
    `uid:\t${slot.uid}`,
    `gid:\t${slot.gid}`,
    // The capability bitmask as hex. Unsigned, because CAP_ALL is -1 as an i32 and "caps: -1"
    // reads as a bug rather than as every bit set.
    `caps:\t0x${(slot.caps >>> 0).toString(16)}`,
    `fds:\t${countFds(slot)}`,
    `calls:\t${slot.calls}`,
    `replies:\t${slot.replies}`,
    `errors:\t${slot.errors}`,
    // Only meaningful once the process is a zombie. Printed always, with the sentinel visible,
    // because a field that appears and disappears is a field every reader has to branch on.
    `exitkind:\t${slot.exitKind}`,
    `exitvalue:\t${slot.exitValue}`,
    "",
  ].join("\n"),

  /** The program this process is running. NUL-terminated like Linux's, so a later `argv` is more
   *  NUL-separated entries rather than a format change. */
  cmdline: (slot) => `${slot.cmdline || ""}\0`,

  /**
   * The working directory, as a plain file holding the path.
   *
   * Linux makes this a symlink. It is a file here because `SynthFS` deliberately refuses to grow
   * symlinks it cannot resolve — see its `lstat` — and a file holding the path answers the one
   * question `/proc/<pid>/cwd` exists to answer. `table.mjs` records that the `cwd` field is M2's
   * and the call that moves it is M3's.
   */
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

/**
 * One fd, described.
 *
 * Linux makes this a symlink to the open file. The description here is a line of facts instead,
 * for the same reason `cwd` is: a symlink this filesystem cannot resolve would be a lie, and an
 * fd on a pipe or a window has no path to point at in the first place.
 */
function fdLine(d) {
  const parts = [`kind:\t${d.kind}`, `refs:\t${d.refs}`];
  if (d.ino !== undefined) parts.push(`ino:\t${d.ino}`);
  if (d.type !== undefined) parts.push(`type:\t${d.type}`);
  if (d.pos !== undefined) parts.push(`pos:\t${d.pos}`);
  if (d.flags !== undefined) parts.push(`flags:\t0x${(d.flags >>> 0).toString(16)}`);
  return `${parts.join("\n")}\n`;
}

/**
 * Build the `/proc` filesystem.
 *
 * @param {object} ctx
 * @param {Function} ctx.table   () => ProcTable — called per read, never captured
 * @param {Function} ctx.mounts  () => MountTable
 */
export function makeProcFS(ctx) {
  // The live slots, by pid, read fresh. A ZOMBIE still has a row — it has not been reaped and its
  // pid is still its parent's handle — which is what makes `ps` able to show a dead child.
  const slotOf = (pid) => {
    const t = ctx.table();
    return t ? t.get(pid) : undefined;
  };

  /**
   * M3's FIRST NEGATIVE CONTROL: serve a cached listing instead of regenerating.
   *
   * `ctx.cache` is false in every real boot and the kernel refuses to set it without bench=1, so
   * the headline path carries one `if` on a constant and no behaviour. It is a runtime flag rather
   * than a hand edit for the reason the handoff gives: a fix that cannot be switched off has not
   * been shown to be the fix, and a control needing a hand edit is a control nobody re-runs.
   *
   * What it must break: a killed pid must LINGER in `ls /proc`. If it does not, the proof that a
   * dead process's directory vanishes was never testing a live read.
   */
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

  /**
   * `/proc/mounts`: the mount table, one row per line.
   *
   * Not in M3's file list, and added anyway: the mount table is M3's headline build item and a
   * table with no way to read it is a table nobody can check. This is where every Unix puts it.
   */
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
      // Volatile: a mount can be added or removed, so a published size could go stale.
      return { type: FILE, content: mountsText(), volatile: true };
    }

    // Everything below here is addressed by pid. A non-numeric first component is ENOENT, not a
    // parse error: `/proc/nonsense` is simply absent, which is what a shell completing a path
    // expects.
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

/**
 * A path component as a non-negative integer, or null.
 *
 * Strict on purpose: `Number("7 ")` is 7 and `parseInt("7x")` is 7, and either would make
 * `/proc/7x/status` an alias for `/proc/7/status`. A pid that can be spelled two ways is a pid two
 * different `kill` commands disagree about.
 */
function pidOf(text) {
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}
