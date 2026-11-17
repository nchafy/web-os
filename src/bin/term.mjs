// `term`: the terminal emulator, as a userland process. It owns a pty master and a window, and it
// moves bytes between them:
//
//     window -> read(/dev/console) -> write(master) -> line discipline -> read(slave) by the shell
//     shell  -> write(slave)       -> read(master)  -> write(/dev/console) -> cells on the screen
//
// A process and not the page: a window agent cannot `Atomics.wait` (constraint 1) so it cannot hold
// the master, and the shell needs a real pty so Ctrl-C raises SIGINT on the foreground group
// (constraint 16). `/dev/console` is the seam.
//
// The relay must `poll` both sources, because it has one futex word: parked in `read(master)` it is
// deaf to the keyboard, and parked in `read(console)` the pty's 16 KiB output ring fills and the
// shell blocks in `write` (constraint 42).

// Absolute, not relative (constraint 125): a program's image is a Blob URL with an opaque path.
import {
  MAX_INLINE, O_RDONLY, O_RDWR, POLLIN, POLLHUP, POLLERR, POLLNVAL,
  SIGHUP, EINTR, EHOSTGONE, SPAWN_DUP2, SPAWN_CLOSE,
} from "/src/abi.mjs";

const SHELL = "/usr/bin/sh";

/** How long one `poll` waits before looking at the clock. A bound, not a cadence: every wake is an
 *  event, so this is only how long the loop can be asleep while its deadline passes. */
const POLL_MS = 250;

/** The wall-clock ceiling on a whole session, overridable with `--ceiling`. A stopped terminal
 *  raises no error — a parked `poll` and a thinking shell are both legitimate — so the relay
 *  carries its own deadline and reports with its counters attached. */
const CEILING_MS = 30000;

/** One read's buffer. The region is MAX_INLINE, so a bigger one could never be filled. */
const CHUNK = Math.min(MAX_INLINE, 8192);

/** Hold fd 0 before opening anything, or the console or the pty master lands on it and every
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
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] !== "--ceiling") continue;
    // Refused, not silently defaulted: `Number(x) || ceiling` accepts both `0` and `abc`.
    const raw = argv[i + 1];
    const ms = Number(raw);
    if (raw === undefined || !Number.isFinite(ms) || ms <= 0) {
      return { exit: 1, program: "term", why: `--ceiling wants a positive number, got ${raw}` };
    }
    ceiling = ms;
  }
  const t0 = performance.now();
  const account = {
    program: "term",
    keyBytes: 0, cellBytes: 0, polls: 0, wakes: 0, interrupted: 0,
    shellPid: 0, shellStatus: null, why: "",
  };

  const zero = ensureStdin(env);
  if (zero < 0) return { exit: 1, ...account, why: `/dev/zero: ${env.std.errnoName(zero)}` };

  // The window first, so -ENXIO (no window attached to this kernel) is reported before a pty and a
  // shell exist to clean up, and the caller can tell it from a crash.
  const con = env.fs.open("/dev/console", O_RDWR);
  if (con < 0) {
    return { exit: 2, ...account, why: `/dev/console: ${env.std.errnoName(con)}`, errno: -con };
  }

  const pty = env.tty.ptyOpen();
  if (typeof pty === "number") {
    env.fs.close(con);
    return { exit: 3, ...account, why: `pty_open: ${env.std.errnoName(pty)}` };
  }
  const { master, slave } = pty;

  // The shell on the slave, with both pty fds closed in the child: a program must not hold the
  // other end of its own terminal.
  const actions = [
    { op: SPAWN_DUP2, a: slave, b: 0 },
    { op: SPAWN_DUP2, a: slave, b: 1 },
    { op: SPAWN_DUP2, a: slave, b: 2 },
  ];
  if (master > 2) actions.push({ op: SPAWN_CLOSE, a: master });
  if (slave > 2) actions.push({ op: SPAWN_CLOSE, a: slave });
  const pid = env.proc.spawn(SHELL, ["sh"], actions);
  if (pid < 0) {
    env.fs.close(master);
    env.fs.close(slave);
    env.fs.close(con);
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
    env.fs.close(con);
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
  /** Whether the shell has already been reaped by its own exit, so the hangup below is not owed. */
  let shellGone = false;

  // Every exit from this loop names itself in `why`, or the reason for stopping is not reportable.
  for (;;) {
    if (performance.now() - t0 > ceiling) {
      why = `ceiling ${ceiling} ms reached with the session still open`;
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
    if (r.nready > 0) account.wakes += 1;
    const conRev = r.fds[0].revents;
    const mstRev = r.fds[1].revents;

    // Keystrokes first: a user who types while output is flowing must not wait for it to stop.
    if (conRev & POLLIN) {
      const n = unInterrupted(() => env.fs.read(con, buf, 0, buf.length));
      if (n === -EHOSTGONE) { why = "the window was destroyed"; break; }
      if (n < 0 && n !== -EINTR) { why = `read(console): ${env.std.errnoName(n)}`; break; }
      if (n > 0) {
        account.keyBytes += n;
        // write(master) is input: it runs the line discipline, where echo and Ctrl-C happen.
        const w = unInterrupted(() => env.fs.write(master, buf.subarray(0, n)));
        if (w < 0 && w !== -EINTR) { why = `write(master): ${env.std.errnoName(w)}`; break; }
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
        if (w < 0 && w !== -EINTR) { why = `write(console): ${env.std.errnoName(w)}`; break; }
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
  env.fs.close(con);
  account.why = why;
  account.ms = performance.now() - t0;
  // Exit 0 only for the ways a session ends; a deadline or an errno gets a code the page asserts on.
  const clean = why === "the shell exited" || why === "the terminal reached end of output"
    || why === "the window was destroyed";
  return { exit: clean ? 0 : 5, ...account };
}
