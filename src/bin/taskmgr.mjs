// `taskmgr`: every process, what it is doing, and what it has cost — in a window.
//
// WHAT IT CAN HONESTLY SHOW, AND WHAT IT REFUSES TO.
//
// Windows 7's Task Manager has a CPU column. THIS ONE DOES NOT, and that is the first thing to
// understand about it: there is no scheduler here. A process is a Worker, the browser decides when
// it runs, and nothing in this system is told how long it ran for. A "% CPU" column would be a
// number invented in this file — and a plausible invented number is worse than an absent one,
// which is the same argument M11 used for drawing a caption button DISABLED rather than live.
//
// So the columns are what the kernel actually measures, under names that say so:
//
//   KRNLms   the time the KERNEL spent servicing this process's syscalls (`Slot.serviceMs`).
//            Not the process's own compute: a program spinning in a tight JS loop makes no
//            syscalls and accrues none of this. It is the "busy" a kernel can see.
//   CALLS    syscalls issued, which is the other half of busy — a thousand cheap calls and one
//            expensive one are different shapes of load and this tells them apart.
//   READ /   bytes that crossed `read` and `write`, counted at the one funnel every answered call
//   WRITE    passes through (`finish` in src/kernel/kernel.mjs).
//   FDS      open file descriptions, which is the handle leak a long-running program shows first.
//   WINS     windows, and SURF their accounted surface area in device pixels — the one
//            memory-shaped figure this kernel owns, because `win_surface` charges it against a
//            budget (constraint 219).
//
// THERE IS NO PER-PROCESS HEAP FIGURE, and the window says so rather than leaving a gap a reader
// fills in with a guess: `performance.measureUserAgentSpecificMemory` is per-AGENT, so it would
// report one number for every Worker together, attributed to whichever process asked.
//
// IT IS A USERLAND CLIENT OF `/proc`, with no privilege at all — the same files `ps` reads. That
// is the point of it being a program: a task manager that needed a capability would be evidence
// the boundary leaks.
//
// The contract this program is written against is in src/bin/true.mjs.

import {
  POLLIN, POLLHUP, POLLERR, POLLNVAL, EINTR, EHOSTGONE,
  WEV_KEY, WEV_CLOSE, WEV_DESTROYED, WEV_RESIZE, WEV_FOCUS, WEV_POINTER,
  WPTR_DOWN, pointerAt, keyBytesOf,
  DL_CLEAR, DL_FILL_RECT, DL_STROKE_RECT, DLT_BOLD, DLT_MONO, DLT_RIGHT, encodeTextRun,
  SIGTERM, SIGKILL,
} from "/src/abi.mjs";

const NAME = "taskmgr";

const POLL_MS = 100;
const CEILING_MS = 600000;

/** How often the table is re-read and redrawn. Windows 7's own default is about a second, and a
 *  faster refresh would mostly measure this program's own syscalls. */
const REFRESH_MS = 1000;

/* THE LAYOUT, in surface pixels. One row per process plus a header and a footer. */
const ROW_H = 18;
const HEAD_H = 40;
const FOOT_H = 34;
const PAD = 8;
const SURFACE_W = 560;
const TEXT_PX = 12;
const TEXT_DY = 3;
/** How many processes fit. There is no wheel event (constraint 294), so the overflow is STATED. */
const MAX_ROWS = 20;

const PAPER = 0x10151bff;
const INK = 0xe8edf4ff;
const INK_DIM = 0x9aa5b4ff;
const HEAD_INK = 0xbcc8d6ff;
const RULE = 0x29313cff;
const SELECT_FILL = 0x2d4a6bff;
const ZOMBIE_INK = 0xe8946cff;
const OUTLINE = 0x9fc6f0ff;

/* THE COLUMNS, AS DATA. A column is a header, a right edge, an alignment and a function of a row —
   so adding one is a row in this array and nothing else, and the header cannot drift from the cell
   under it because both read the same entry. */
const COLUMNS = [
  { head: "PID", x: 44, right: true, of: (r) => String(r.pid) },
  { head: "PROG", x: 52, right: false, of: (r) => r.prog },
  { head: "STAT", x: 240, right: false, of: (r) => r.state },
  { head: "CALLS", x: 322, right: true, of: (r) => String(r.calls) },
  { head: "KRNLms", x: 386, right: true, of: (r) => r.kernelMs.toFixed(1) },
  { head: "READ", x: 444, right: true, of: (r) => bytes(r.readBytes) },
  { head: "WRITE", x: 500, right: true, of: (r) => bytes(r.writeBytes) },
  { head: "FD", x: 526, right: true, of: (r) => String(r.fds) },
  { head: "WIN", x: 552, right: true, of: (r) => String(r.wins) },
];

/** Bytes, short enough for a column. Binary units, as a filesystem's own figures are. */
function bytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return String(v);
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)}K`;
  return `${(v / (1024 * 1024)).toFixed(1)}M`;
}

/** `key:\tvalue` lines into an object, which is the shape `/proc/<pid>/status` is written in for
 *  exactly this reason: no parser. */
function parseStatus(text) {
  const out = Object.create(null);
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (at < 0) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

/** One row per live pid, read out of `/proc`. A pid that exits between the listing and the read is
 *  skipped rather than reported as a zero row: it is gone, not idle. */
function readTable(env) {
  const names = env.std.listDir(env, "/proc");
  if (typeof names === "number") return names;
  const rows = [];
  for (const entry of names) {
    if (!/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const status = env.std.readFileText(env, `/proc/${pid}/status`);
    if (typeof status === "number") continue;
    const st = parseStatus(status);
    const cmdline = env.std.readFileText(env, `/proc/${pid}/cmdline`);
    // NUL-SEPARATED, as the file says it is; the first entry is the program.
    const argv0 = typeof cmdline === "string"
      ? (cmdline.split("\u0000").filter((s) => s.length)[0] || "?")
      : "?";
    const fds = env.std.listDir(env, `/proc/${pid}/fd`);
    const wins = env.std.listDir(env, `/proc/${pid}/win`);
    rows.push({
      pid,
      ppid: Number(st.ppid || 0),
      prog: argv0.replace(/^.*\//, ""),
      state: st.state || "?",
      calls: Number(st.calls || 0),
      // ABSENT MEANS ZERO AND NOT UNKNOWN only because this program and that file ship together;
      // a missing field would otherwise print as NaN, which is a number that reads like a figure.
      kernelMs: Number(st.kernelms || 0),
      readBytes: Number(st.readbytes || 0),
      writeBytes: Number(st.writebytes || 0),
      fds: typeof fds === "number" ? 0 : fds.filter((e) => /^\d+$/.test(e.name)).length,
      wins: typeof wins === "number" ? 0 : wins.filter((e) => /^\d+$/.test(e.name)).length,
    });
  }
  rows.sort((a, b) => a.pid - b.pid);
  return rows;
}

export function run(env) {
  const std = env.std;
  const { flags, bad } = std.getopt((env.argv || []).slice(1), "c:");
  if (bad) {
    return { exit: std.complain(env, NAME, null, `unknown option ${bad}`, std.EXIT_USAGE) };
  }
  let ceiling = CEILING_MS;
  if (flags.c !== undefined) {
    const ms = std.wholeNumber(flags.c);
    if (ms === null || ms === 0) {
      return { exit: std.complain(env, NAME, null, `bad ceiling: ${flags.c}`, std.EXIT_USAGE) };
    }
    ceiling = ms;
  }

  const account = {
    program: NAME, win: 0, fd: 0, refreshes: 0, rows: 0, kills: [], why: "",
  };

  let rows = readTable(env);
  if (typeof rows === "number") {
    return { exit: std.complainErrno(env, NAME, "/proc", rows), program: NAME, errno: -rows };
  }

  const surfaceH = HEAD_H + MAX_ROWS * ROW_H + FOOT_H;
  const made = env.win.create({
    title: "Task Manager", w: SURFACE_W + 20, h: surfaceH + 40,
    x: env.std.WIN_ORIGIN_X, y: env.std.WIN_ORIGIN_Y,
  });
  if (typeof made === "number") {
    return { exit: 2, ...account, why: `win_create: ${std.errnoName(made)}`, errno: -made };
  }
  account.win = made.win;
  account.fd = made.fd;
  const surf = env.win.surface(made.fd, SURFACE_W, surfaceH);
  if (surf < 0) {
    env.win.destroy(made.fd);
    return { exit: 3, ...account, why: `win_surface: ${std.errnoName(surf)}`, errno: -surf };
  }

  let selected = 0;
  const rowTop = (i) => HEAD_H + i * ROW_H;
  /** The inverse of `rowTop`, so a press selects the row a reader is pointing at. */
  const rowAt = (y) => {
    const i = Math.floor((y - HEAD_H) / ROW_H);
    return i >= 0 && i < Math.min(rows.length, MAX_ROWS) ? i : -1;
  };

  const paint = () => {
    const shown = rows.slice(0, MAX_ROWS);
    const hidden = rows.length - shown.length;
    const ops = [{ op: DL_CLEAR, a0: PAPER }];

    /* THE TITLE SAYS WHAT THE NUMBERS ARE. A reader who thinks KRNLms is CPU time will draw the
     * wrong conclusion from it, and the one place that misreading can be headed off is here. */
    ops.push(...encodeTextRun(`${rows.length} process${rows.length === 1 ? "" : "es"}`, {
      x: PAD, y: PAD - 2, size: TEXT_PX + 1, rgba: INK, flags: DLT_BOLD,
    }));
    ops.push(...encodeTextRun("KRNLms is kernel time servicing syscalls, not CPU", {
      x: SURFACE_W - PAD, y: PAD - 1, size: TEXT_PX - 2, rgba: INK_DIM, flags: DLT_RIGHT,
    }));

    for (const col of COLUMNS) {
      ops.push(...encodeTextRun(col.head, {
        x: col.x, y: HEAD_H - 16, size: TEXT_PX - 1, rgba: HEAD_INK,
        flags: DLT_BOLD | DLT_MONO | (col.right ? DLT_RIGHT : 0),
      }));
    }
    ops.push({
      op: DL_FILL_RECT, a0: PAD, a1: HEAD_H - 3, a2: SURFACE_W - PAD * 2, a3: 1, a4: RULE,
    });

    shown.forEach((row, i) => {
      const top = rowTop(i);
      if (i === selected) {
        ops.push({
          op: DL_FILL_RECT, a0: PAD, a1: top, a2: SURFACE_W - PAD * 2, a3: ROW_H, a4: SELECT_FILL,
        });
        ops.push({
          op: DL_STROKE_RECT, a0: PAD, a1: top, a2: SURFACE_W - PAD * 2, a3: ROW_H,
          a4: OUTLINE, a5: 1,
        });
      }
      // A ZOMBIE IS NOT A RUNNING PROCESS and must not read like one: it holds a pid and an exit
      // status and nothing else, which is why `kill` on it does nothing and `wait` is what clears
      // it. The colour is the only way a table can say that at a glance.
      const ink = row.state === "zombie" ? ZOMBIE_INK : INK;
      for (const col of COLUMNS) {
        ops.push(...encodeTextRun(col.of(row), {
          x: col.x, y: top + TEXT_DY, size: TEXT_PX - 1,
          rgba: col.head === "PROG" ? ink : (row.state === "zombie" ? ZOMBIE_INK : INK_DIM),
          flags: DLT_MONO | (col.right ? DLT_RIGHT : 0),
        }));
      }
    });

    const footY = HEAD_H + Math.min(shown.length, MAX_ROWS) * ROW_H + 6;
    if (hidden > 0) {
      ops.push(...encodeTextRun(`+${hidden} more — run \`ps\` to see them all`, {
        x: PAD, y: footY, size: TEXT_PX - 1, rgba: INK_DIM,
      }));
    }
    ops.push(...encodeTextRun(
      "u/j select   click a row   t = SIGTERM   x = SIGKILL   r = refresh   q = quit", {
        x: PAD, y: surfaceH - 16, size: TEXT_PX - 1, rgba: INK_DIM,
      }));
    return env.win.draw(made.fd, ops);
  };

  const refresh = () => {
    const got = readTable(env);
    if (typeof got === "number") return got;
    rows = got;
    account.refreshes += 1;
    account.rows = rows.length;
    if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
    paint();
    return 0;
  };
  paint();
  std.say(env, `${NAME}: win ${made.win}, ${rows.length} process(es)\n`);
  std.say(env, "KRNLms is the kernel's own service time, not CPU: there is no scheduler here.\n");

  /** SIGTERM or SIGKILL to the selected pid. `kill` AND NOT A PRIVILEGE: this program may signal
   *  exactly what any process may signal, which is what keeps it a userland client. */
  const signal = (sig) => {
    const row = rows[selected];
    if (!row) return;
    // NOT ITSELF. A task manager that killed itself would be a window that closed on a keystroke
    // the reader meant for something else, and the pid is right there to compare.
    if (row.pid === env.pid) {
      account.kills.push({ pid: row.pid, refused: "self" });
      return;
    }
    const r = env.proc.kill(row.pid, sig);
    account.kills.push({ pid: row.pid, sig, r });
    refresh();
  };

  let lastRefresh = performance.now();
  let lastWake = performance.now();
  let why = "";
  for (;;) {
    if (performance.now() - lastWake > ceiling) {
      why = `idle for ${ceiling} ms`;
      break;
    }
    if (performance.now() - lastRefresh >= REFRESH_MS) {
      lastRefresh = performance.now();
      const r = refresh();
      if (r < 0 && r !== -EINTR) { why = `refresh: ${std.errnoName(r)}`; break; }
    }
    const got = env.tty.poll([{ fd: made.fd, events: POLLIN }], POLL_MS);
    if (typeof got === "number") {
      if (got === -EINTR) continue;
      if (got < 0) { why = `poll: ${std.errnoName(got)}`; break; }
      continue;
    }
    const rev = got.fds[0].revents;
    if (rev & (POLLHUP | POLLERR | POLLNVAL)) { why = "the window went away"; break; }
    if (!(rev & POLLIN)) continue;
    const evs = env.win.read(made.fd);
    if (evs === -EHOSTGONE) { why = "the window was destroyed"; break; }
    if (typeof evs === "number") {
      if (evs < 0 && evs !== -EINTR) { why = `read(win): ${std.errnoName(evs)}`; break; }
      continue;
    }
    for (const ev of evs) {
      lastWake = performance.now();
      if (ev.type === WEV_KEY) {
        const text = new TextDecoder().decode(keyBytesOf(ev));
        /* LETTERS AND NOT ARROWS, because the ARROWS BELONG TO THE FRAME: `src/wm/window.mjs`
         * binds them to move the window and to snap it, so they are consumed before a process
         * ever sees them. A program that advertised arrow keys here would advertise a key it
         * cannot receive.
         *
         * `x` AND NOT `k` FOR SIGKILL. The first version of this bound `k` to both the kill and
         * the up-arrow in one `else if` chain, so one of them was dead code — `x` for "kill it"
         * reads as a close box and collides with nothing. */
        if (text === "q") { why = "the reader asked to quit"; break; }
        if (text === "r") refresh();
        else if (text === "t") signal(SIGTERM);
        else if (text === "x") signal(SIGKILL);
        else if (text === "u") { selected = Math.max(0, selected - 1); paint(); }
        else if (text === "j") {
          selected = Math.min(Math.min(rows.length, MAX_ROWS) - 1, selected + 1);
          paint();
        }
      } else if (ev.type === WEV_POINTER) {
        if (!(ev.b & WPTR_DOWN)) continue;
        const at = pointerAt(ev);
        const hit = rowAt(at.y);
        if (hit >= 0) { selected = hit; paint(); }
      } else if (ev.type === WEV_CLOSE) {
        why = "the window asked to close";
      } else if (ev.type === WEV_DESTROYED) {
        why = "the window was destroyed";
      } else if (ev.type === WEV_RESIZE || ev.type === WEV_FOCUS) {
        paint();
      }
    }
    if (why) break;
  }

  env.win.destroy(made.fd);
  return { exit: 0, ...account, why: why || "done" };
}
