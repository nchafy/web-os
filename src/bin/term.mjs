// `term`: the terminal emulator, as a userland process. It owns a pty master and a window, and it
// moves bytes between them:
//
//     window -> read(winfd) -> key events -> write(master) -> line discipline -> read(slave) by sh
//     shell  -> write(slave) -> read(master) -> write(winfd) -> cells on the screen
//
// A process and not the page: a window agent cannot `Atomics.wait` (constraint 1) so it cannot hold
// the master, and the shell needs a real pty so Ctrl-C raises SIGINT on the foreground group
// (constraint 16).
//
// M7 CHANGED THE SEAM AND NOTHING ELSE ABOUT THIS PROGRAM'S SHAPE. It used to open
// `/dev/console` — a device the PAGE had created, one per kernel. It calls `win_create` now, so a
// second terminal is a second process calling the same syscall, and the window it gets is its own.
//
// The relay must `poll` both sources, because it has one futex word: parked in `read(master)` it is
// deaf to the keyboard, and parked in `read(winfd)` the pty's 16 KiB output ring fills and the
// shell blocks in `write` (constraint 42).

// Absolute, not relative (constraint 125): a program's image is a Blob URL with an opaque path.
import {
  MAX_INLINE, O_RDONLY, POLLIN, POLLHUP, POLLERR, POLLNVAL,
  SIGHUP, EINTR, EHOSTGONE, SPAWN_DUP2, SPAWN_CLOSE,
  WEV_KEY, WEV_RESIZE, WEV_CLOSE, WEV_DESTROYED, WEV_ITEM, keyBytesOf,
  WITEM_JUMP, WICON_TERMINAL,
} from "/src/abi.mjs";

const SHELL = "/usr/bin/sh";

/** How long one `poll` waits before looking at the clock. A bound, not a cadence: every wake is an
 *  event, so this is only how long the loop can be asleep while its deadline passes. */
const POLL_MS = 250;

/**
 * How long the relay may be IDLE before it closes, overridable with `--ceiling`.
 *
 * IDLE AND NOT TOTAL, which is the fix for a real complaint: a terminal a person opened by typing
 * `term &` died after 30 seconds. Every page spawns its own terminal with `--ceiling 3600000`, so
 * the only caller left on the default was a HUMAN — and the default was sized for a check.
 *
 * The reason a deadline exists at all survives the change: a stopped terminal raises no error, a
 * parked `poll` and a thinking shell are both legitimate, so the relay carries its own deadline and
 * reports with its counters attached. A STOPPED relay has no wakes, so it still reports; a relay
 * being used is never stopped (constraint 239).
 */
const CEILING_MS = 1800000;

/** One read's buffer. The region is MAX_INLINE, so a bigger one could never be filled. */
const CHUNK = Math.min(MAX_INLINE, 8192);

/** Hold fd 0 before opening anything, or the window or the pty master lands on it and every
 *  convention that treats 0 as stdin is wrong. Constraint 94. */
function ensureStdin(env) {
  const fd = env.fs.open("/dev/zero", O_RDONLY);
  if (fd < 0) return fd;
  if (fd > 0) env.fs.close(fd);
  return fd;
}

/** Retry a call once if it was interrupted. One signal costs two -EINTRs (constraint 131), so a
 *  relay reading an interruption as the end of the session would close on the first Ctrl-C. */
function unInterrupted(call) {
  const first = call();
  if (first !== -EINTR) return first;
  return call();
}

export function run(env) {
  const argv = (env.argv || []).map(String);
  let ceiling = CEILING_MS;
  let title = "Terminal";
  let owner = 0;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--title") {
      const text = argv[i + 1];
      if (text === undefined) return { exit: 1, program: "term", why: "--title wants a string" };
      title = text;
      i += 1;
      continue;
    }
    if (argv[i] === "--owner") {
      // A window id, from whoever spawned this relay. Parented onto ANOTHER PROCESS'S window is
      // the normal case for a broker, so this is not restricted to ids this process made.
      const id = Number(argv[i + 1]);
      if (!Number.isInteger(id) || id < 0) {
        return { exit: 1, program: "term", why: `--owner wants a winid, got ${argv[i + 1]}` };
      }
      owner = id;
      i += 1;
      continue;
    }
    if (argv[i] !== "--ceiling") continue;
    // Refused, not silently defaulted: `Number(x) || ceiling` accepts both `0` and `abc`.
    const raw = argv[i + 1];
    const ms = Number(raw);
    if (raw === undefined || !Number.isFinite(ms) || ms <= 0) {
      return { exit: 1, program: "term", why: `--ceiling wants a positive number, got ${raw}` };
    }
    ceiling = ms;
    i += 1;
  }
  const t0 = performance.now();
  const account = {
    program: "term",
    win: 0, keyBytes: 0, cellBytes: 0, events: 0, resizes: 0, closes: 0,
    polls: 0, wakes: 0, interrupted: 0,
    shellPid: 0, shellStatus: null, why: "",
    // M14: jump-list rows acted on, and the terminals opened from one.
    items: 0, spawned: [],
  };

  const zero = ensureStdin(env);
  if (zero < 0) return { exit: 1, ...account, why: `/dev/zero: ${env.std.errnoName(zero)}` };

  // The window first, so a refusal is reported before a pty and a shell exist to clean up, and the
  // caller can tell it from a crash.
  const made = env.win.create({ title, owner, w: 640, h: 400 });
  if (typeof made === "number") {
    return { exit: 2, ...account, why: `win_create: ${env.std.errnoName(made)}`, errno: -made };
  }
  const con = made.fd;
  account.win = made.win;

  /**
   * M14. A JUMP LIST: "New terminal", which is Windows 7's own first row for most programs and is
   * a thing this one can really do — it is the program that owns a window, a pty and a shell, so
   * another terminal is another one of itself.
   *
   * IT IS PUBLISHED BEFORE THE PTY EXISTS, so a refusal is reported next to the window's own and
   * not after a shell has been started. A failure here is not fatal: a terminal with no jump list
   * is a terminal.
   */
  const JUMP_NEW = 0;
  const jumped = env.win.items(made.fd, [
    { icon: WICON_TERMINAL, flags: WITEM_JUMP, label: "New terminal" },
  ]);
  if (jumped < 0) account.why = `win_items: ${env.std.errnoName(jumped)}`;

  const pty = env.tty.ptyOpen();
  if (typeof pty === "number") {
    env.win.destroy(con);
    return { exit: 3, ...account, why: `pty_open: ${env.std.errnoName(pty)}` };
  }
  const { master, slave } = pty;

  // The shell on the slave, with both pty fds closed in the child: a program must not hold the
  // other end of its own terminal. THE WINDOW FD IS NOT INHERITED EITHER — it is not in the file
  // actions and it is above 2 — so the shell cannot write cells behind this relay's back.
  const actions = [
    { op: SPAWN_DUP2, a: slave, b: 0 },
    { op: SPAWN_DUP2, a: slave, b: 1 },
    { op: SPAWN_DUP2, a: slave, b: 2 },
  ];
  if (master > 2) actions.push({ op: SPAWN_CLOSE, a: master });
  if (slave > 2) actions.push({ op: SPAWN_CLOSE, a: slave });
  if (con > 2) actions.push({ op: SPAWN_CLOSE, a: con });
  const pid = env.proc.spawn(SHELL, ["sh"], actions);
  if (pid < 0) {
    env.fs.close(master);
    env.fs.close(slave);
    env.win.destroy(con);
    return { exit: 4, ...account, why: `spawn ${SHELL}: ${env.std.errnoName(pid)}` };
  }
  account.shellPid = pid;
  /* The shell goes in its own group and that group becomes the terminal's foreground, which is what
   * makes Ctrl-C reach the shell's pipeline rather than this relay (constraint 16). Both returns
   * are checked: with `setpgid` refused, the teardown below sends SIGHUP to a group that does not
   * exist, gets -ESRCH, and parks in `waitpid` on a shell nothing has hung up. */
  const grouped = env.proc.setpgid(pid, pid);
  const fg = grouped < 0 ? grouped : env.tty.setPgrp(master, pid);
  if (grouped < 0 || fg < 0) {
    // Killed by pid, the only spelling that is certainly right when the group is in doubt.
    env.proc.kill(pid, SIGHUP);
    env.proc.waitpid(pid, 0);
    env.fs.close(master);
    env.fs.close(slave);
    env.win.destroy(con);
    return {
      exit: 6,
      ...account,
      why: grouped < 0
        ? `setpgid(${pid}): ${env.std.errnoName(grouped)}`
        : `tcsetpgrp(${pid}): ${env.std.errnoName(fg)}`,
    };
  }
  // The slave must be let go: while any description of it is open the master never sees EOF.
  env.fs.close(slave);

  const buf = new Uint8Array(CHUNK);
  let why = "";
  /**
   * When the relay last had something to do. The deadline is measured from here.
   *
   * SET NOW AND NOT AT `t0`, because everything above it — the window, the pty, the shell — is the
   * relay STARTING and not the relay idling. Measured against `t0` a `--ceiling 4000` terminal
   * exited before its own window appeared, since opening a pty and spawning `sh` takes longer than
   * that and produces no wake while it happens.
   */
  let lastWake = performance.now();
  /** Whether the shell has already been reaped by its own exit, so the hangup below is not owed. */
  let shellGone = false;

  // Every exit from this loop names itself in `why`, or the reason for stopping is not reportable.
  for (;;) {
    // SINCE THE LAST WAKE, not since the start: see `CEILING_MS`.
    if (performance.now() - lastWake > ceiling) {
      why = `idle for ${ceiling} ms with the session still open`;
      break;
    }
    account.polls += 1;
    const r = unInterrupted(() => env.tty.poll([
      { fd: con, events: POLLIN },
      { fd: master, events: POLLIN },
    ], POLL_MS));
    if (typeof r === "number") {
      if (r === -EINTR) { account.interrupted += 1; continue; }
      why = `poll: ${env.std.errnoName(r)}`;
      break;
    }
    if (r.nready > 0) {
      account.wakes += 1;
      lastWake = performance.now();
    }
    const conRev = r.fds[0].revents;
    const mstRev = r.fds[1].revents;

    // Events first: a user who types while output is flowing must not wait for it to stop.
    if (conRev & POLLIN) {
      const evs = unInterrupted(() => env.win.read(con));
      if (evs === -EHOSTGONE) { why = "the window was destroyed"; break; }
      if (typeof evs === "number") {
        if (evs < 0 && evs !== -EINTR) { why = `read(win): ${env.std.errnoName(evs)}`; break; }
      } else {
        for (const ev of evs) {
          account.events += 1;
          if (ev.type === WEV_KEY) {
            const bytes = keyBytesOf(ev);
            if (bytes.length === 0) continue;
            account.keyBytes += bytes.length;
            // write(master) is input: it runs the line discipline, where echo and Ctrl-C happen.
            const w = unInterrupted(() => env.fs.write(master, bytes));
            if (w < 0 && w !== -EINTR) { why = `write(master): ${env.std.errnoName(w)}`; break; }
          } else if (ev.type === WEV_RESIZE) {
            account.resizes += 1;
            // THE RESIZE IS WHY THE EVENT STREAM IS NOT JUST KEYSTROKES: a set on the master
            // raises SIGWINCH on the slave's foreground group, so the shell learns its new size
            // through POSIX's own channel rather than through anything window-shaped.
            env.tty.winsizeSet(master, ev.b, ev.a);
          } else if (ev.type === WEV_CLOSE) {
            // M7 DELIVERS THE REQUEST AND DOES NOT ENFORCE IT. The page still takes the frame down
            // after posting this, so the session ends either way; M9 is what makes the refusal
            // real, and until then a relay that pretended to refuse would be lying to the user.
            account.closes += 1;
            why = "the window asked to close";
          } else if (ev.type === WEV_ITEM) {
            /* A JUMP-LIST ROW. The index is into the list THIS process published, which the kernel
             * validated against that list — so the only row that exists is row 0, and anything
             * else is a page naming something that was never published. `spawn` and not a shell
             * command: the path and the argv are this program's own, and there is no string for
             * anything to re-parse. */
            account.items += 1;
            if (ev.a === JUMP_NEW) {
              const pid = env.proc.spawn("/usr/bin/term", ["term", "--ceiling", String(ceiling)]);
              if (pid < 0) {
                account.why = `spawn term: ${env.std.errnoName(pid)}`;
              } else {
                account.spawned.push(pid);
              }
            }
          } else if (ev.type === WEV_DESTROYED) {
            why = "the window was destroyed";
          }
        }
        if (why) break;
      }
    }

    if (mstRev & POLLIN) {
      const n = unInterrupted(() => env.fs.read(master, buf, 0, buf.length));
      if (n === 0) { why = "the terminal reached end of output"; shellGone = true; break; }
      if (n < 0 && n !== -EINTR) { why = `read(master): ${env.std.errnoName(n)}`; break; }
      if (n > 0) {
        account.cellBytes += n;
        const w = unInterrupted(() => env.fs.write(con, buf.subarray(0, n)));
        if (w === -EHOSTGONE) { why = "the window was destroyed"; break; }
        if (w < 0 && w !== -EINTR) { why = `write(win): ${env.std.errnoName(w)}`; break; }
      }
    }

    // Hangups are checked after the reads: a shell that printed and exited in one breath leaves the
    // master both readable and hung up in one `poll`, and taking the hangup first loses that line.
    if (mstRev & (POLLHUP | POLLERR | POLLNVAL)) {
      for (;;) {
        const n = unInterrupted(() => env.fs.read(master, buf, 0, buf.length));
        if (n <= 0) break;
        account.cellBytes += n;
        if (unInterrupted(() => env.fs.write(con, buf.subarray(0, n))) < 0) break;
      }
      why = why || "the shell exited";
      shellGone = true;
      break;
    }
    if (conRev & (POLLHUP | POLLERR | POLLNVAL)) {
      why = "the window was destroyed";
      break;
    }
  }

  // The shell is hung up on before it is waited for, unless it has already gone: `waitpid` blocks,
  // so any loop exit that leaves a live child parks this process for ever.
  if (!shellGone) env.proc.kill(-pid, SIGHUP);
  const stat = env.proc.waitpid(pid, 0);
  account.shellStatus = typeof stat === "object" ? stat : { errno: -stat };
  env.fs.close(master);
  // DESTROY RATHER THAN CLOSE, so the cascade is reported: a terminal that owns a child window
  // takes it down with it, and `win_destroy` is the call that says which ids went.
  const destroyed = env.win.destroy(con);
  account.destroyed = Array.isArray(destroyed) ? destroyed : [];
  account.why = why;
  account.ms = performance.now() - t0;
  // Exit 0 only for the ways a session ends; a deadline or an errno gets a code the page
  // asserts on.
  const clean = why === "the shell exited" || why === "the terminal reached end of output"
    || why === "the window was destroyed" || why === "the window asked to close";
  return { exit: clean ? 0 : 5, ...account };
}
