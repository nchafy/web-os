// `term`: the terminal emulator, as a userland process.
//
// It owns a pty master and a window, and it moves bytes between them. That is the whole program:
//
//     window -> read(/dev/console) -> write(master) -> line discipline -> read(slave) by the shell
//     shell  -> write(slave)       -> read(master)  -> write(/dev/console) -> cells on the screen
//
// WHY A PROCESS AND NOT THE PAGE. The shell must be talking to a real pty with a real line
// discipline, because Ctrl-C has to raise SIGINT on the foreground group even when the UI is
// wedged (constraint 16, and `src/kernel/pty.mjs`'s header). The page cannot hold the master: a
// window agent cannot `Atomics.wait` (constraint 1), so it cannot make a syscall at all. So the
// master is held by a process, the pixels are drawn by the page, and `/dev/console` is the seam.
//
// THE POLL IS THE POINT, and it is the thing `docs/designs/REVIEW-FINDINGS.md` finding 1 exists to
// force. This program has TWO sources and one futex word. Parked in `read(master)` it is deaf to
// the keyboard — the corrected scenario in that finding, "parked in read(master) at idle with no
// output, keys dead indefinitely". Parked in `read(console)` it never drains the master, so the
// pty's 16 KiB output ring fills, the shell blocks in `write`, and the screen stops. `poll` over
// both is the only shape that is not broken, which is why `poll` was built in M4b for a milestone
// that had no window yet (constraint 42).
//
// THIS PROGRAM IS NOT SPECIAL-CASED; the device it opens is. `MILESTONES.md` M4a: "This window is
// special-cased, not an ABI. M7 generalises it and deletes the special case." When M7 lands,
// `open("/dev/console")` becomes `win_create` and the loop below is unchanged — it already treats
// the window as an fd that `poll` waits on.

// ABSOLUTE, NOT RELATIVE, and constraint 125 is why: a program's image is a Blob URL with an
// opaque path, so a relative specifier inside it has nothing to resolve against and the module
// fails to load. `/src/abi.mjs` is the one specifier the loader's allowlist carries.
import {
  MAX_INLINE, O_RDONLY, O_RDWR, POLLIN, POLLHUP, POLLERR, POLLNVAL,
  SIGHUP, EINTR, EHOSTGONE, SPAWN_DUP2, SPAWN_CLOSE,
} from "/src/abi.mjs";

const SHELL = "/usr/bin/sh";

/**
 * How long one `poll` waits before looking at the clock.
 *
 * A BOUND AND NOT A CADENCE. Every wake is an event — a keystroke or a byte of output — so this
 * timeout is not how often the loop runs; it is how long the loop can be asleep while its
 * deadline passes. 250 ms costs four wakes a second on a terminal nobody is using, which is the
 * price of being able to report a stopped session instead of being killed by a harness timeout.
 */
const POLL_MS = 250;

/**
 * The wall-clock ceiling on a whole session, overridable with `--ceiling`.
 *
 * A STOPPED TERMINAL RAISES NO ERROR. A parked `poll` is a legitimate state and so is a shell that
 * is thinking, so nothing in this system will tell the caller that the session has gone quiet for
 * ever. The relay therefore carries its own deadline and REPORTS, with its counters attached —
 * `docs/handoff/CONTINUE-HERE.md`: "A timeout must carry state."
 */
const CEILING_MS = 30000;

/** One read's buffer. The region is MAX_INLINE, so a bigger one could never be filled. */
const CHUNK = Math.min(MAX_INLINE, 8192);

/**
 * Hold fd 0 before opening anything. Constraint 94.
 *
 * `spawn` leaves fd 0 free and `fds.add` hands out the lowest, so the console or the pty master
 * would land on fd 0 and every convention that treats 0 as stdin would be wrong. The orchestrators
 * under `bench/` and `sh` itself do the same thing for the same reason.
 */
function ensureStdin(env) {
  const fd = env.fs.open("/dev/zero", O_RDONLY);
  if (fd < 0) return fd;
  // fd 0 WAS ALREADY TAKEN, so nothing needs holding and the spare is closed. Only the fd === 0
  // case keeps its description, which is the whole job. The fd is returned rather than a 0 so a
  // caller can say WHICH it was.
  if (fd > 0) env.fs.close(fd);
  return fd;
}

/**
 * Retry a call once if it was interrupted.
 *
 * ONE SIGNAL COSTS TWO -EINTRs (constraint 131, `docs/DECISIONS.md` D20): the kernel was
 * deliberately not changed to deliver once, so any call made immediately after a signal may answer
 * -EINTR, and a program that cares must retry. A relay that treated an interruption as the end of
 * the session would close the terminal on the first Ctrl-C.
 */
function unInterrupted(call) {
  const first = call();
  if (first !== -EINTR) return first;
  return call();
}

export function run(env) {
  const argv = (env.argv || []).map(String);
  let ceiling = CEILING_MS;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--ceiling" && i + 1 < argv.length) ceiling = Number(argv[i + 1]) || ceiling;
  }
  const t0 = performance.now();
  const account = {
    program: "term",
    keyBytes: 0, cellBytes: 0, polls: 0, wakes: 0, interrupted: 0,
    shellPid: 0, shellStatus: null, why: "",
  };

  const zero = ensureStdin(env);
  if (zero < 0) return { exit: 1, ...account, why: `/dev/zero: ${env.std.errnoName(zero)}` };

  // THE WINDOW FIRST. A terminal with no window has nothing to be, and opening it first means the
  // -ENXIO case (no window attached to this kernel) is reported before a pty and a shell exist to
  // clean up. ENXIO is not a failure of this program: it is the honest state of a device file
  // whose device is not there, and the caller needs to be able to tell it from a crash.
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

  // The shell on the slave, with the master and the slave both closed in the child: a program must
  // not hold the other end of its own terminal. `bench/m5-sh/program.mjs`'s `p_tty` is the same
  // sequence and the working example the handoff points at.
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
  // The shell in its own group, and that group made the terminal's foreground — what a session
  // leader does for the shell it starts, and what makes Ctrl-C reach the shell's pipeline rather
  // than this relay.
  env.proc.setpgid(pid, pid);
  env.tty.setPgrp(master, pid);
  // AND LET GO OF THE SLAVE. While any description of it is open the master never sees EOF, so a
  // read after the shell exits would park for ever with no error anywhere. M4 recorded this twice.
  env.fs.close(slave);

  const buf = new Uint8Array(CHUNK);
  let why = "";
  /** Whether the shell has already been reaped by its own exit, so the hangup below is not owed. */
  let shellGone = false;

  // `break` is the only way out, and every exit names itself in `why`. A loop whose exits are a
  // flag somebody else sets is a loop whose reason for stopping is not reportable.
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

    // KEYSTROKES FIRST. A user who types while output is flowing must not wait for the output to
    // stop: the typing is the interactive half and the half a person is watching.
    if (conRev & POLLIN) {
      const n = unInterrupted(() => env.fs.read(con, buf, 0, buf.length));
      if (n === -EHOSTGONE) { why = "the window was destroyed"; break; }
      if (n < 0 && n !== -EINTR) { why = `read(console): ${env.std.errnoName(n)}`; break; }
      if (n > 0) {
        account.keyBytes += n;
        // write(master) is INPUT: it runs the line discipline, which is where echo and Ctrl-C
        // happen. THIS WRITE IS THE WHOLE OF M4a's PROOF — the character on the screen comes back
        // through the pty's echo, never from this program and never from the widget.
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

    // HANGUPS ARE CHECKED AFTER THE READS, so the last bytes are not thrown away. A shell that
    // printed and exited in one breath leaves the master both readable and hung up in the same
    // `poll`, and answering the hangup first would lose its final line — which for a login shell
    // is the whole session.
    if (mstRev & (POLLHUP | POLLERR | POLLNVAL)) {
      // The slave is gone, so the shell has exited. Drain whatever is left, then stop.
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

  // THE SHELL IS HUNG UP ON BEFORE IT IS WAITED FOR, unless it has already gone.
  //
  // `waitpid` BLOCKS, so every exit from the loop that leaves a live child would park this process
  // for ever — and the one that matters is the CEILING, which is the path that exists to report a
  // session that stopped. It would have hung in the act of reporting the hang. SIGHUP is the right
  // signal and not merely a convenient one: the window behind this terminal is gone or
  // unreachable, which is precisely the event the signal is named for, and a shell left on a pty
  // nobody reads would sit there until something else killed it.
  if (!shellGone) env.proc.kill(-pid, SIGHUP);
  const stat = env.proc.waitpid(pid, 0);
  account.shellStatus = typeof stat === "object" ? stat : { errno: -stat };
  env.fs.close(master);
  env.fs.close(con);
  account.why = why;
  account.ms = performance.now() - t0;
  // EXIT 0 MEANS THE SESSION ENDED THE WAY A SESSION ENDS: the shell exited, or the window went.
  // A deadline or an errno is a different outcome and gets a different code, because the page
  // asserts on it — "the relay stopped" and "the relay was never started" must not read alike.
  const clean = why === "the shell exited" || why === "the terminal reached end of output"
    || why === "the window was destroyed";
  return { exit: clean ? 0 : 5, ...account };
}
