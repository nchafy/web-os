// `/proc`: the process table as files, REGENERATED PER READ AND NEVER CACHED. M3's negative
// control is a cached listing, which must make a killed pid linger in `ls /proc`.

import { DIR, FILE } from "../fs/vfs.mjs";
import { WEV_BYTES } from "../abi.mjs";
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

/**
 * `/proc/<pid>/win/<winid>`: one window as facts. The DIRECTORY IS NAMED BY WINID AND NOT BY FD,
 * which `PLAN.md` §5 specifies and which is the only choice that works: a window may be held on
 * several fds through `dup`, and an owner in another process names the winid and has no fd for it
 * at all. The fds that reach it are published as a field, so the mapping is still readable.
 */
function winLines(win, slot) {
  const fds = [];
  slot.fds.fds.forEach((d, i) => {
    if (d && d.win === win) fds.push(i);
  });
  return [
    `win:\t${win.id}`,
    `pid:\t${win.pid}`,
    `fds:\t${fds.join(",")}`,
    `title:\t${win.title}`,
    `owner:\t${win.owner}`,
    `children:\t${win.children.join(",")}`,
    `box:\t${win.box.x},${win.box.y},${win.box.w},${win.box.h}`,
    `cells:\t${win.cols}x${win.rows}`,
    `attached:\t${win.attached ? 1 : 0}`,
    `destroyed:\t${win.destroyed ? 1 : 0}`,
    `opens:\t${win.opens}`,
    // The queue depth, its overflow and the detector's clock. A window that stopped being read
    // raises no error — a parked reader is a legitimate state — so these three are the only way to
    // tell a working window from a wedged one.
    `pending:\t${win.events.length / WEV_BYTES}`,
    `dropped:\t${win.stats.dropped}`,
    `parked:\t${win.waitingReaders.length}`,
    `level:\t${win.level}`,
    `stalems:\t${Math.round(win.staleMs())}`,
    `queued:\t${win.stats.queued}`,
    `delivered:\t${win.stats.delivered}`,
    `cellbytes:\t${win.stats.cellBytes}`,
    "",
  ].join("\n");
}

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
  // THE ONE FIELD THAT JOINS THE TWO NAMESPACES: an fd on a window names its winid, so
  // `/proc/<pid>/fd/4` and `/proc/<pid>/win/<winid>` can be read against each other.
  if (d.win !== undefined) parts.push(`win:\t${d.win.id}`);
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

  /** A window of this process, by winid. The pid check is what keeps `/proc/<a>/win/<n>` from
   *  reading a window belonging to process <b>: the winid space is global, and a path that ignored
   *  the pid would make every window readable under every process. */
  const winOf = (id, pid) => {
    const mgr = ctx.wins();
    if (!mgr) return null;
    const win = mgr.get(id);
    return win && !win.destroyed && win.pid === pid ? win : null;
  };

  const winIds = (pid) => {
    const mgr = ctx.wins();
    return mgr ? mgr.ofPid(pid).map((w) => w.id) : [];
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

    // `/proc/<pid>/win` and `/proc/<pid>/win/<winid>`. A DESTROYED window is not listed and is not
    // openable: its fd still answers -EHOSTGONE, which is the fd's business, and a directory entry
    // for a window that is gone would be a window the page no longer has a frame for.
    if (parts[1] === "win") {
      if (parts.length === 2) return { type: DIR };
      if (parts.length === 3) {
        const id = pidOf(parts[2]);
        if (id === null) return null;
        const win = winOf(id, pid);
        if (!win) return null;
        return { type: FILE, content: winLines(win, slot), volatile: true };
      }
      return null;
    }

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
    if (parts.length === 1) return [...Object.keys(PID_FILES), "fd", "win"];
    if (parts.length === 2 && parts[1] === "fd") return fdNumbers(slot).map(String);
    if (parts.length === 2 && parts[1] === "win") return winIds(pid).map(String);
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
