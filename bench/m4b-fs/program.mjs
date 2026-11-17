// M4b's process program: the pty, the line discipline, and poll — through real syscalls.
//
// The one behaviour MILESTONES.md M4 actually specifies is that Ctrl-C must raise SIGINT on the
// foreground group "even when the UI is wedged". That is what `p_wedged` proves: the stage spins
// in a compute loop issuing no syscalls, and the signal still reaches it — because delivery is a
// SAB control word checked at syscall entry (constraint 16) and not a message the process would
// have to be idle to receive.
//
// Orchestrator modes:
//   p_echo        a byte typed at the master is echoed back, and the program reads the line
//   p_canon       nothing is readable until the line is terminated
//   p_intr        Ctrl-C at the master raises SIGINT on the foreground group; the byte is eaten
//   p_wedged      the same, against a stage spinning in a compute loop
//   p_raw         ISIG off: Ctrl-C arrives as a byte instead
//   p_termios     tty_get/tty_set round-trip, including the words M4b does not use
//   p_winsize     a resize raises SIGWINCH on the foreground group
//   p_poll        one process waits on TWO fds and is woken by either
//   p_pgrp        tcgetpgrp/tcsetpgrp move the foreground group
//   p_selfwinch   a pty op whose signal lands on the CALLER is answered exactly once
//   p_emptypoll   poll(NULL, 0, -1) BLOCKS until a signal rather than answering 0
//   p_fdlimit     a refused dup leaks no reference, so the reader still reaches EOF
//   p_teardownwake a dying writer's fd sweep wakes a peer parked in poll
//   p_openleak    an open refused with -EMFILE keeps no sync access handle
//
// Stage modes:
//   ttyline       read one line from fd 0 and report it
//   ttyspin       spin without syscalls, so only a signal can stop it
//   ttysleep      park in a long sleep, so a signal interrupts a parked process
//   ttypoll       park in poll over two fds and report which one woke it

import {
  E, O_RDONLY, O_RDWR, O_CREAT, SPAWN_DUP2, SPAWN_CLOSE, SIGINT, SIGKILL, SIGWINCH,
  ISIG, ICANON, ECHO,
  VINTR, MAX_INLINE, POLLIN, packI64, SYS_read, SYS_poll, OPEN_MAX,
// Absolute, not relative. A program spawned by a process is loaded as a Blob URL whose path is
// opaque (src/kernel/exec.mjs), so a relative specifier has nothing to resolve against and the
// module fails to load — measured, every stage faulted with SIGABRT and "never issued a syscall".
} from "/src/abi.mjs";

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const SELF = "/bench/m4b-fs/program.mjs";
/** The spin's wall-clock ceiling. Generous: it is the error path, not the expected one. */
const SPIN_CEILING_MS = 10000;

function ttylineStage(env) {
  const buf = new Uint8Array(256);
  const n = env.fs.read(0, buf);
  return { ok: n > 0, read: n, text: n > 0 ? DEC.decode(buf.subarray(0, n)) : "" };
}

/**
 * Constraint 21: there is no preemption, so a compute-bound process is killable but not
 * interruptible. The SIGINT raised by the line discipline sets a SIGPEND bit this process notices
 * only at its next syscall, so the loop makes one call every SPIN_CHUNK iterations — the shape a
 * real program that polls for interruption has. A loop with no syscall at all would need SIGKILL,
 * which is the degradation the constraint names.
 */
const SPIN_CHUNK = 20000;

/**
 * Spin, and only a signal stops it. The stage behind MILESTONES.md M4's one specified behaviour.
 *
 * The ceiling is wall clock and not an iteration count: a 200,000-iteration cap is reached in under
 * the time the orchestrator takes to send the keystroke, so on a fast machine the stage exits
 * normally before the Ctrl-C arrives and the proof fails with `killed: false, code: 0` — measured
 * at 1 failure in 4 runs of `scripts/check.py --only m4b`.
 *
 * Returning at all is a failure: a delivered SIGINT is fatal at SIG_DFL, so the kernel reaps this
 * process inside `env.syscall(0)` and there is no normal exit from a working run. The ceiling is
 * the error path, so a broken delivery path ends as a failing proof naming itself in the exit code
 * rather than as a harness timeout.
 */
function ttyspinStage(env) {
  let i = 0;
  let acc = 0;
  const t0 = performance.now();
  for (;;) {
    acc += i % 7;
    i += 1;
    // The syscall at which a pending signal is drained, rare enough that the process is genuinely
    // compute-bound between them — which is the claim, since delivery travels through the SAB
    // control word and not a message this process could not service (constraint 16).
    if (i % SPIN_CHUNK === 0) {
      env.syscall(0);
      // The clock is read on the same cadence, so the spin between syscalls stays pure compute.
      if (performance.now() - t0 > SPIN_CEILING_MS) break;
    }
  }
  return { ok: false, spun: i, acc, neverSignalled: true, exit: 1 };
}

/**
 * Park in `poll` over two fds and report which woke it. Constraint 42's case: a process has one
 * futex word and one outstanding call, so without this it cannot wait on a pipe and a terminal at
 * once. fd 0 is a pipe's read end and fd 1 is a pty slave, both installed by the orchestrator's
 * spawn file actions.
 */
function ttypollStage(env) {
  const r = env.tty.poll([{ fd: 0, events: POLLIN }, { fd: 1, events: POLLIN }], 5000);
  if (typeof r === "number") {
    // `exit` is how a stage's verdict reaches its parent: the kernel reaps a process-spawned child
    // and discards its result object, so the exit code is the channel. 2 = the call failed.
    return { ok: false, errno: -r, exit: 2 };
  }
  // Exactly one ready, and it must be the pipe. A timeout would report 0; both ready would mean
  // the poll was woken by something the orchestrator did not do.
  const wokeOnPipeOnly = r.nready === 1 && r.fds[0].revents !== 0 && r.fds[1].revents === 0;
  // The detail goes down the pty, which the orchestrator reads off the master: that exercises the
  // slave's output path in the same proof rather than taking it on trust.
  env.fs.write(1, ENC.encode(`poll ${r.nready} ${r.fds[0].revents} ${r.fds[1].revents}\n`));
  return {
    ok: wokeOnPipeOnly,
    nready: r.nready,
    pipeRevents: r.fds[0].revents,
    ttyRevents: r.fds[1].revents,
    wokeOnPipeOnly,
    exit: wokeOnPipeOnly ? 0 : 1,
  };
}

/** Park in a long sleep, so a signal is observable against a parked process rather than a racing
 *  one. 8 s, not 30: under the `no_isig` control nothing kills this stage and it runs to
 *  completion, so a longer sleep costs that control half a minute per proof for no extra evidence. */
function ttysleepStage(env) {
  const [lo, hi] = packI64(8 * 1000 * 1000 * 1000);
  const r = env.syscall(2, lo, hi, 0);
  // The verdict is the sleep's return value, carried in the exit code (see `ttypollStage`). A
  // non-fatal signal at a parked process is observable only as the park ending early with -EINTR:
  // the process exiting is also true of a sleep that ran its full 8 s and returned 0.
  const interrupted = r === -E.EINTR;
  return { ok: interrupted, result: r, interrupted, exit: interrupted ? 0 : 1 };
}

function stage(env, mode, { stdin = -1, stdout = -1, close = [] } = {}) {
  const actions = [];
  if (stdin >= 0) actions.push({ op: SPAWN_DUP2, a: stdin, b: 0 });
  if (stdout >= 0) actions.push({ op: SPAWN_DUP2, a: stdout, b: 1 });
  for (const fd of close) if (fd > 2) actions.push({ op: SPAWN_CLOSE, a: fd });
  return env.proc.spawn(SELF, [mode], actions);
}

/** Open fd 0 before `pty_open`, so no pty fd lands on a standard one (constraint 94). */
function ensureStdin(env) {
  const fd = env.fs.open("/dev/zero", O_RDONLY);
  if (fd < 0) throw new Error(`ensureStdin: /dev/zero errno ${-fd}`);
  if (fd > 0) env.fs.close(fd);
  return fd;
}

/** Wait until `pid` has issued a syscall, so it is inside its blocking call. Observed through
 *  /proc rather than slept for — a fixed wait races worker startup. */
function awaitStarted(env, pid, rounds = 300) {
  const buf = new Uint8Array(512);
  for (let i = 0; i < rounds; i += 1) {
    const fd = env.fs.open(`/proc/${pid}/status`, O_RDONLY);
    if (fd < 0) return { ok: false, why: `status errno ${-fd}`, rounds: i };
    const n = env.fs.read(fd, buf);
    env.fs.close(fd);
    if (n > 0) {
      const m = /calls:\t(\d+)/.exec(DEC.decode(buf.subarray(0, n)));
      if (m && Number(m[1]) >= 1) return { ok: true, rounds: i, calls: Number(m[1]) };
    }
    const [lo, hi] = packI64(2000000);
    env.syscall(2, lo, hi, 0);
  }
  return { ok: false, why: "never issued a syscall", rounds };
}

/** A pty whose slave is a child's stdin, with the child in its own foreground group. */
function withStage(env, mode) {
  ensureStdin(env);
  const pty = env.tty.ptyOpen();
  if (typeof pty === "number") return { err: `pty_open ${-pty}` };
  const { master, slave } = pty;
  const pid = stage(env, mode, { stdin: slave, stdout: slave, close: [master, slave] });
  if (pid < 0) return { err: `spawn ${-pid}` };
  // The child in its own group, and that group made the terminal's foreground: what a shell does,
  // and what makes one keystroke reach the pipeline and not the shell.
  env.proc.setpgid(pid, pid);
  const set = env.tty.setPgrp(master, pid);
  /* The slave end stays alive while any reference to its description exists, so a parent that keeps
   * its copy means the master never sees EOF, and a master read after the child dies parks forever
   * with nothing to read and no error anywhere. A shell hands the slave over and lets go of it. */
  env.fs.close(slave);
  return { master, pid, setPgrp: set, fgPgid: env.tty.getPgrp(master) };
}

function masterRead(env, master, want = 256) {
  const buf = new Uint8Array(Math.max(want, 256));
  const n = env.fs.read(master, buf, 0, want);
  return { n, text: n > 0 ? DEC.decode(buf.subarray(0, n)) : "" };
}

function pEcho(env) {
  const s = withStage(env, "ttyline");
  if (s.err) return { ok: false, why: s.err };
  const started = awaitStarted(env, s.pid);
  env.fs.write(s.master, ENC.encode("hello\n"));
  const stat = env.proc.waitpid(s.pid);
  // The echo is on the master's read side, where a terminal emulator would paint it.
  const echo = masterRead(env, s.master);
  env.fs.close(s.master);
  return {
    ok: !!(started.ok && stat && stat.exited),
    pid: s.pid, started, child: stat,
    echo: echo.text,
    // CR LF, because a bare LF leaves the cursor in the same column on a real terminal.
    echoedLine: echo.text === "hello\r\n",
    fgPgid: s.fgPgid,
  };
}

function pCanon(env) {
  const s = withStage(env, "ttyline");
  if (s.err) return { ok: false, why: s.err };
  const started = awaitStarted(env, s.pid);
  // A partial line: in canonical mode the program must read nothing yet.
  env.fs.write(s.master, ENC.encode("par"));
  // Waited for rather than sampled, on the two facts that mean parked: one call outstanding, and
  // that call being SYS_read. `state === "running"` is true of every process that is not a zombie.
  const parked = awaitParkedIn(env, s.pid, SYS_read);
  const beforeStatus = readStatus(env, s.pid);
  env.fs.write(s.master, ENC.encode("tial\n"));
  const stat = env.proc.waitpid(s.pid);
  env.fs.close(s.master);
  return {
    ok: !!(started.ok && stat && stat.exited),
    pid: s.pid, started, child: stat,
    stateWhilePartial: beforeStatus.state,
    // The child was parked in `read` while only half a line had been typed, which is what
    // canonical mode means: the bytes are held until the line is terminated.
    parkedOnPartialLine: parked.ok,
    parkedIn: parked.syscall, parkedRounds: parked.rounds, parkedWhy: parked.why,
    callsWhileParked: beforeStatus.calls, repliesWhileParked: beforeStatus.replies,
    SYS_read,
  };
}

function readStatus(env, pid) {
  const buf = new Uint8Array(512);
  const fd = env.fs.open(`/proc/${pid}/status`, O_RDONLY);
  if (fd < 0) return { errno: -fd };
  const n = env.fs.read(fd, buf);
  env.fs.close(fd);
  const text = n > 0 ? DEC.decode(buf.subarray(0, n)) : "";
  const state = /state:\t(\w+)/.exec(text);
  const calls = /calls:\t(\d+)/.exec(text);
  const replies = /replies:\t(\d+)/.exec(text);
  const sc = /syscall:\t(-?\d+)/.exec(text);
  return {
    state: state ? state[1] : null,
    calls: calls ? Number(calls[1]) : null,
    replies: replies ? Number(replies[1]) : null,
    // -1 means "in no call". `null` means the field was absent, which is a different fact and
    // must not read as "not parked".
    syscall: sc ? Number(sc[1]) : null,
    text,
  };
}

/**
 * Poll `/proc/<pid>/status` until the process is parked in syscall `nr`.
 *
 * Parked is two facts: a call outstanding (`calls` one ahead of `replies`) and which call
 * (`syscall`). Both come from /proc, so this is observed rather than inferred from timing. A clause
 * on `state === "running"` would pass whether or not the process ever reached the call, and would
 * also race the write that was supposed to park it.
 */
function awaitParkedIn(env, pid, nr, rounds = 300) {
  for (let i = 0; i < rounds; i += 1) {
    const st = readStatus(env, pid);
    if (st.errno) return { ok: false, why: `status errno ${st.errno}`, rounds: i };
    if (st.syscall === null) {
      return { ok: false, why: "/proc status publishes no `syscall` field", rounds: i };
    }
    if (st.syscall === nr && st.calls === st.replies + 1) {
      return { ok: true, rounds: i, syscall: st.syscall, calls: st.calls, replies: st.replies };
    }
    const [lo, hi] = packI64(2000000);
    env.syscall(2, lo, hi, 0);
  }
  const last = readStatus(env, pid);
  return {
    ok: false, why: `never parked in syscall ${nr}`, rounds,
    syscall: last.syscall, calls: last.calls, replies: last.replies,
  };
}

/** Ctrl-C at the master must raise SIGINT on the foreground group. */
function intrAgainst(env, mode) {
  const s = withStage(env, mode);
  if (s.err) return { ok: false, why: s.err };
  const started = awaitStarted(env, s.pid);
  env.fs.write(s.master, new Uint8Array([VINTR_BYTE]));
  const stat = env.proc.waitpid(s.pid);
  const echo = masterRead(env, s.master);
  env.fs.close(s.master);
  return {
    ok: !!(started.ok && stat),
    pid: s.pid, started, child: stat,
    fgPgid: s.fgPgid, setPgrp: s.setPgrp,
    killedByInt: !!(stat && stat.killed && stat.code === SIGINT),
    // The ^C must not appear as a byte on the master: it was consumed, not echoed as data.
    echo: echo.text,
    echoHasRawIntr: echo.text.includes("\u0003"),
    SIGINT,
  };
}

const VINTR_BYTE = 3;

function pIntr(env) {
  return intrAgainst(env, "ttysleep");
}

function pWedged(env) {
  return intrAgainst(env, "ttyspin");
}

function pRaw(env) {
  const s = withStage(env, "ttyline");
  if (s.err) return { ok: false, why: s.err };
  // With ISIG off a ^C is data. Read-modify-write, because a caller that built a termios from
  // scratch would clear words it never set.
  const tm = env.tty.get(s.master);
  if (typeof tm === "number") return { ok: false, why: `tty_get ${-tm}` };
  tm.lflag &= ~ISIG;
  const set = env.tty.set(s.master, tm);
  const started = awaitStarted(env, s.pid);
  env.fs.write(s.master, new Uint8Array([VINTR_BYTE]));
  env.fs.write(s.master, ENC.encode("\n"));
  const stat = env.proc.waitpid(s.pid);
  env.fs.close(s.master);
  return {
    ok: !!(started.ok && set === 0 && stat && stat.exited),
    pid: s.pid, started, setResult: set, child: stat,
    // The child exited normally, having read the ^C as a byte rather than dying of it.
    exitedNormally: !!(stat && stat.exited),
    lflagAfter: tm.lflag,
  };
}

function pTermios(env) {
  ensureStdin(env);
  const pty = env.tty.ptyOpen();
  if (typeof pty === "number") return { ok: false, why: `pty_open ${-pty}` };
  const { master, slave } = pty;
  const before = env.tty.get(master);
  // Set every word, including the three this milestone does not use, and the last cc slot.
  const next = {
    iflag: 0x11112222, oflag: 0x33334444, cflag: 0x55556666,
    lflag: ISIG, cc: before.cc.slice(),
  };
  next.cc[19] = 0x7f;
  const set = env.tty.set(master, next);
  const after = env.tty.get(master);
  // ENOTTY for an fd that is not a terminal, which is what makes isatty() expressible.
  const notTty = env.tty.get(0);
  env.fs.close(slave);
  env.fs.close(master);
  return {
    ok: set === 0 && typeof after === "object",
    defaultLflag: before.lflag,
    defaultIsCanonEchoIsig: !!(before.lflag & ICANON) && !!(before.lflag & ECHO)
      && !!(before.lflag & ISIG),
    defaultVintr: before.cc[VINTR],
    after,
    // The reserved words survived: a caller built against today's three lflag bits must not
    // silently clear a flag a later milestone adds.
    reservedPreserved: after.iflag === 0x11112222 && after.oflag === 0x33334444
      && after.cflag === 0x55556666,
    lastCcPreserved: after.cc[19] === 0x7f,
    lflagApplied: after.lflag === ISIG,
    notTtyErrno: typeof notTty === "number" ? -notTty : 0,
    ENOTTY: E.ENOTTY,
  };
}

function pWinsize(env) {
  const s = withStage(env, "ttysleep");
  if (s.err) return { ok: false, why: s.err };
  const started = awaitStarted(env, s.pid);
  const before = env.tty.winsizeGet(s.master);
  // A resize on the master must raise SIGWINCH on the slave's foreground group. The stage has
  // SIGWINCH at SIG_DFL, which is not fatal, so it keeps sleeping and the signal is observable as
  // the sleep returning -EINTR rather than as a death.
  const set = env.tty.winsizeSet(s.master, 40, 120);
  const after = env.tty.winsizeGet(s.master);
  const stat = env.proc.waitpid(s.pid);
  env.fs.close(s.master);
  return {
    ok: !!(started.ok && set === 0 && stat),
    started, setResult: set,
    before, after,
    resized: after.rows === 40 && after.cols === 120,
    child: stat,
    // The stage's own account: it exits 0 only when its sleep returned -EINTR. `stat.exited` alone
    // is true of an uninterrupted 8-second sleep and says nothing about SIGWINCH.
    sleepInterrupted: !!(stat && stat.exited && stat.code === 0),
    stageVerdict: stat ? stat.code : null,
    EINTR: E.EINTR,
  };
}

/**
 * A pty operation whose signal lands on the process making the call, which must be answered once.
 *
 * `pty_open` sets the foreground group from the opener's pgid, so until a shell moves it — and a
 * shell resizing its terminal before it spawns anything has not moved it — a resize on the master
 * raises SIGWINCH on the caller itself. `raiseOne` interrupts the in-flight call, and replying to
 * the handler's return as well would be two SEQ bumps and two G_INFLIGHT decrements for one call:
 * the depth gauge goes negative and the issued == replied identity `check_syscall` asserts breaks.
 *
 * This is checked from here rather than only in the kernel's counters because the process must
 * still be able to make calls afterwards. A channel one reply ahead of itself is the user-visible
 * wreckage, and `getpgid` returning something other than this process's own group is how a program
 * meets it.
 */
function pSelfwinch(env) {
  const pty = env.tty.ptyOpen();
  if (typeof pty === "number") return { ok: false, why: `pty_open ${-pty}` };
  const { master, slave } = pty;
  const mine = env.proc.getpgid(0);
  // Deliberately not moved. `withStage` puts the stage's own group in the foreground, which is
  // what a shell does per pipeline and what makes every other proof here signal a child.
  const fgBefore = env.tty.getPgrp(master);
  const before = env.tty.winsizeGet(master);
  const set = env.tty.winsizeSet(master, 40, 120);
  /* The pending bit is drained at the next syscall entry, which answers -EINTR without making a
   * call at all (src/libos/syscall.mjs's `interruptedAtEntry`). So the first call after a signal is
   * expected to refuse — that is delivery, not damage — and the call after that is the one that
   * says whether the channel is still in step: it must return my group, not the resize's answer.
   *
   * The order is load-bearing: every read of the terminal's state comes after the drain. A
   * `winsizeGet` placed first absorbs the drain, so `after` comes back as the integer -EINTR and
   * `resized` compares an errno's `.rows` against 40. */
  const drained = env.proc.getpgid(0);
  const nextCall = env.proc.getpgid(0);
  const after = env.tty.winsizeGet(master);
  env.fs.close(slave);
  env.fs.close(master);
  return {
    ok: !!(fgBefore === mine && nextCall === mine && after.rows === 40 && after.cols === 120),
    myPgid: mine, fgBefore,
    foregroundIsMine: fgBefore === mine,
    before, after,
    // The side effect completed. `setWinsize` resizes and only then signals, so an interrupted
    // caller must still find the terminal resized; anything else means the resize was lost to its
    // own signal.
    resized: after.rows === 40 && after.cols === 120,
    // The caller observes its own interruption. -EINTR, not 0: the call was answered by the
    // signal rather than by the handler.
    setResult: set,
    sawEintr: set === -E.EINTR,
    // The channel is not one reply ahead: the next call returns its own answer.
    drained, drainedAtEntry: drained === -E.EINTR,
    nextCall, channelIntact: nextCall === mine,
    EINTR: E.EINTR,
  };
}

/**
 * One process waiting on two fds, woken by either. Constraint 42's point: a process has one futex
 * word and one outstanding call, so without `poll` it cannot wait on a pipe and a terminal at once,
 * which is the case M4a's terminal hits first.
 */
function pPoll(env) {
  ensureStdin(env);
  const pipe = env.proc.pipe2();
  if (typeof pipe === "number") return { ok: false, why: `pipe2 ${-pipe}` };
  const pty = env.tty.ptyOpen();
  if (typeof pty === "number") return { ok: false, why: `pty_open ${-pty}` };

  const set = [{ fd: pipe.rfd, events: POLLIN }, { fd: pty.master, events: POLLIN }];

  // 1. Nothing ready, timeout 0: a poll, not a wait.
  const idle = env.tty.poll(set, 0);

  // 2. The pipe becomes ready.
  env.fs.write(pipe.wfd, ENC.encode("p"));
  const viaPipe = env.tty.poll(set, 0);

  // Drain it so the next poll is about the terminal alone.
  const buf = new Uint8Array(16);
  env.fs.read(pipe.rfd, buf, 0, 1);

  // 3. The terminal becomes ready, via the echo of a keystroke, which is output on the master.
  env.fs.write(pty.master, ENC.encode("k"));
  const viaTty = env.tty.poll(set, 0);

  // 4. A poll on a closed fd is POLLNVAL, reported whether or not it was asked for.
  const bad = env.tty.poll([{ fd: 999, events: POLLIN }], 0);

  env.fs.close(pipe.rfd); env.fs.close(pipe.wfd);
  env.fs.close(pty.slave); env.fs.close(pty.master);
  return {
    ok: typeof idle === "object" && typeof viaPipe === "object" && typeof viaTty === "object",
    idleReady: idle.nready,
    pipeReady: viaPipe.nready,
    pipeRevents: viaPipe.fds[0].revents,
    ttyReady: viaTty.nready,
    ttyRevents: viaTty.fds[1].revents,
    // The pipe must not still be flagged once drained, or `poll` is reporting staleness.
    pipeQuietAfterDrain: viaTty.fds[0].revents === 0,
    badRevents: typeof bad === "object" ? bad.fds[0].revents : bad,
    POLLIN,
  };
}

/**
 * A process parked in `poll` over two fds, woken by one of them. The non-blocking proof above shows
 * `poll` can report readiness; this shows it can wait, which is the half constraint 42 is about and
 * the half M4a's terminal needs — parked at idle with no output, keys must still wake it.
 */
function pPollWait(env) {
  ensureStdin(env);
  const pipe = env.proc.pipe2();
  if (typeof pipe === "number") return { ok: false, why: `pipe2 ${-pipe}` };
  const pty = env.tty.ptyOpen();
  if (typeof pty === "number") return { ok: false, why: `pty_open ${-pty}` };
  // The pipe's read end on fd 0 and the pty slave on fd 1, which is what the stage polls.
  const pid = env.proc.spawn(SELF, ["ttypoll"], [
    { op: SPAWN_DUP2, a: pipe.rfd, b: 0 },
    { op: SPAWN_DUP2, a: pty.slave, b: 1 },
    { op: SPAWN_CLOSE, a: pipe.rfd }, { op: SPAWN_CLOSE, a: pipe.wfd },
    { op: SPAWN_CLOSE, a: pty.master }, { op: SPAWN_CLOSE, a: pty.slave },
  ]);
  if (pid < 0) return { ok: false, why: `spawn ${-pid}` };
  // The parent lets go of the ends it handed over, keeping only the pipe's writer and the master.
  env.fs.close(pipe.rfd);
  env.fs.close(pty.slave);

  // Parked in the poll, observed rather than slept for. `awaitStarted` alone waits only for the
  // stage's first syscall, several calls before the `poll`.
  const started = awaitStarted(env, pid);
  const parkedInPollObserved = awaitParkedIn(env, pid, SYS_poll);
  const statusWhileParked = readStatus(env, pid);

  // Make exactly one of the two ready.
  env.fs.write(pipe.wfd, ENC.encode("wake"));
  const stat = env.proc.waitpid(pid);
  // The stage's own account, read off the master, so the orchestrator asserts on what the stage saw
  // rather than only on that it exited.
  const said = masterRead(env, pty.master, 128);
  env.fs.close(pipe.wfd);
  env.fs.close(pty.master);
  const fields = /^poll (\d+) (\d+) (\d+)/.exec(said.text || "");
  return {
    ok: !!(started.ok && stat && stat.exited && stat.code === 0 && fields),
    pid, started, child: stat,
    // Exit 0 is the stage's verdict: it woke on the pipe alone.
    stageVerdict: stat ? stat.code : null,
    stageSaid: said.text,
    nready: fields ? Number(fields[1]) : null,
    pipeRevents: fields ? Number(fields[2]) : null,
    ttyRevents: fields ? Number(fields[3]) : null,
    wokeOnPipeOnly: !!(fields && Number(fields[1]) === 1 && Number(fields[2]) !== 0
      && Number(fields[3]) === 0),
    // The stage was parked in `poll`: the syscall number comes from /proc, and `calls` one ahead of
    // `replies` is what makes it a park rather than a call in progress.
    parkedInPoll: parkedInPollObserved.ok,
    parkedIn: parkedInPollObserved.syscall,
    parkedRounds: parkedInPollObserved.rounds,
    parkedWhy: parkedInPollObserved.why,
    SYS_poll,
    callsWhileParked: statusWhileParked.calls,
  };
}

/**
 * A stage that parks in `poll` over nothing, which is POSIX's `poll(NULL, 0, -1)`. It must block
 * until a signal arrives. A kernel that answers 0 immediately is a busy-wait where the caller asked
 * to block — the one shape where a program spins the kernel by doing exactly what POSIX says.
 * Returning at all means it did not block, so the verdict is in the exit code.
 */
function ttyemptypollStage(env) {
  const r = env.tty.poll([], -1);
  // Reached only if the kernel refused to block. A signal does not come back here: SIGINT at
  // SIG_DFL is fatal and the kernel reaps this process inside the call.
  return { ok: false, returned: r, neverBlocked: true, exit: 1 };
}

/**
 * `poll(NULL, 0, -1)` blocks until a signal, and the signal ends it. The proof is the stage still
 * being parked in SYS_poll when the orchestrator looks, and dying of the signal rather than
 * exiting. A kernel that answers immediately gives a stage that exits 1 before the first look.
 */
function pEmptyPoll(env) {
  const pid = stage(env, "ttyemptypoll", {});
  if (pid < 0) return { ok: false, why: `spawn ${-pid}` };
  const started = awaitStarted(env, pid);
  const parked = awaitParkedIn(env, pid, SYS_poll);
  env.proc.kill(pid, SIGINT);
  const stat = env.proc.waitpid(pid);
  return {
    ok: !!(started.ok && parked.ok && stat && stat.killed && stat.code === SIGINT),
    pid, started,
    // Parked, not merely alive: a call outstanding, and that call being `poll`.
    parkedInEmptyPoll: parked.ok, parkedIn: parked.syscall, parkedWhy: parked.why,
    child: stat,
    // Killed by the signal. A stage that returned from the poll would have exited 1 instead.
    endedBySignal: !!(stat && stat.killed && stat.code === SIGINT),
    SIGINT, SYS_poll,
  };
}

/**
 * An fd table driven to `OPEN_MAX`, and then the pipe closed.
 *
 * A `dup` that raises the description's refcount before asking for an fd leaves the count one high
 * on every refusal, and a kind's `close` op fires only when the last reference goes. A pipe whose
 * writer count never drops leaves its reader on an EOF that cannot arrive, which is constraint 92's
 * deadlock reached through -EMFILE. The observable is the read: EOF, or a hang with no error.
 */
function pFdLimit(env) {
  ensureStdin(env);
  const pipe = env.proc.pipe2();
  if (typeof pipe === "number") return { ok: false, why: `pipe2 ${-pipe}` };
  // Copies of the write end, so every refused dup is a chance to leak a reference to the
  // description whose closure the reader's EOF depends on.
  const copies = [];
  let refused = 0;
  for (let i = 0; i < OPEN_MAX + 8; i += 1) {
    const fd = env.fs.dup(pipe.wfd);
    if (fd < 0) { refused = -fd; break; }
    copies.push(fd);
  }
  for (const fd of copies) env.fs.close(fd);
  env.fs.close(pipe.wfd);
  /* Asked through `poll`, not `read`. Every reference to the write end is gone, so the reader must
   * see EOF — but with a leaked reference it sees nothing and a `read` would park forever. A proof
   * whose failure mode is a hang ends as a BROKEN check carrying no expectations, indistinguishable
   * from a harness fault; `poll` with a deadline turns the same defect into a reported
   * `nready: 0`. */
  const ready = env.tty.poll([{ fd: pipe.rfd, events: POLLIN }], 500);
  const sawEof = typeof ready !== "number" && ready.nready === 1
    && (ready.fds[0].revents & POLLIN) !== 0;
  // Only then the read, which is now known to be answerable.
  const buf = new Uint8Array(16);
  const n = sawEof ? env.fs.read(pipe.rfd, buf) : null;
  env.fs.close(pipe.rfd);
  return {
    ok: !!(refused > 0 && sawEof && n === 0),
    duped: copies.length, refusedErrno: refused,
    // The table really did fill: otherwise the refused dups never happened and nothing was tested.
    tableFilled: refused > 0,
    // A pipe with no writer left is readable: the read returns 0, and EOF is a readable event
    // rather than a condition a poller should sleep through.
    eofAfterRefusedDups: sawEof,
    pollResult: typeof ready === "number" ? ready : ready.nready,
    revents: typeof ready === "number" ? null : ready.fds[0].revents,
    readResult: n,
    POLLIN, EMFILE: E.EMFILE,
  };
}

/**
 * A stage that parks in `poll` over a pipe forever, so only a wake can end it. An infinite timeout
 * is the only way to assert the wake itself: a finite one is answered correctly by the timeout's
 * own rescan (`docs/DECISIONS.md` D20), so it cannot tell a working wake from a late one.
 */
function ttyhuppollStage(env) {
  const r = env.tty.poll([{ fd: 0, events: POLLIN }], -1);
  if (typeof r === "number") return { ok: false, errno: -r, exit: 2 };
  // POLLIN because a pipe with no writer is readable: the read returns 0, and EOF is a readable
  // event rather than a condition a poller should sleep through.
  const hup = (r.fds[0].revents & POLLIN) !== 0;
  return { ok: hup, nready: r.nready, revents: r.fds[0].revents, exit: hup ? 0 : 1 };
}

/** Wait, bounded, for a process to stop being runnable. Returns what it last saw. */
function awaitExit(env, pid, rounds = 400) {
  for (let i = 0; i < rounds; i += 1) {
    const st = readStatus(env, pid);
    if (st.errno || st.state === "zombie" || st.state === "dead") {
      return { ok: true, rounds: i, state: st.state ?? null, errno: st.errno ?? null };
    }
    const [lo, hi] = packI64(2000000);
    env.syscall(2, lo, hi, 0);
  }
  return { ok: false, rounds, state: readStatus(env, pid).state };
}

/**
 * Teardown's fd sweep must wake a peer's parked `poll`.
 *
 * The wake is hooked on `reply`, the single funnel every state change passes through, so no
 * pollable kind can forget it (constraint 109). Teardown is the one path that moves readiness and
 * does not reply: its only `reply` runs before the sweep that drops the dying process's pipe
 * `writers` to 0, leaving a peer parked over that pipe waiting forever.
 *
 * The orchestrator owns the deadline, not the kernel. The stage polls with an infinite timeout,
 * because a finite one would be answered by its own rescan and prove nothing, so a missing wake is
 * a process that never returns. Rather than let that become a harness timeout and a BROKEN check
 * carrying no expectations, this waits a bounded number of rounds and then SIGKILLs, so the failure
 * is reported as `wokenByTeardown: false` with the stage still parked.
 */
function pTeardownWake(env) {
  ensureStdin(env);
  const pipe = env.proc.pipe2();
  if (typeof pipe === "number") return { ok: false, why: `pipe2 ${-pipe}` };
  // The poller gets the read end on fd 0. The writer is a second stage holding the write end, and
  // killing it is what makes the pipe readable through teardown rather than through a close.
  const poller = stage(env, "ttyhuppoll", { stdin: pipe.rfd, close: [pipe.rfd, pipe.wfd] });
  if (poller < 0) return { ok: false, why: `spawn poller ${-poller}` };
  const writer = stage(env, "ttyspin", { stdout: pipe.wfd, close: [pipe.rfd, pipe.wfd] });
  if (writer < 0) return { ok: false, why: `spawn writer ${-writer}` };
  // The orchestrator lets go of both ends, or the poller's EOF depends on this process too.
  env.fs.close(pipe.rfd);
  env.fs.close(pipe.wfd);
  const pollerStarted = awaitStarted(env, poller);
  const writerStarted = awaitStarted(env, writer);
  const parked = awaitParkedIn(env, poller, SYS_poll);
  // The writer's teardown closes the write end, which is the state change that must wake the
  // poller, and it goes through no `reply` at all.
  const killed = env.proc.kill(writer, SIGKILL);
  const woke = awaitExit(env, poller, 400);
  if (!woke.ok) env.proc.kill(poller, SIGKILL);
  const pollerStat = env.proc.waitpid(poller);
  const writerStat = env.proc.waitpid(writer);
  return {
    ok: !!(pollerStarted.ok && writerStarted.ok && parked.ok && killed === 0 && woke.ok
      && pollerStat && pollerStat.exited && pollerStat.code === 0),
    pollerPid: poller, writerPid: writer,
    parkedInPoll: parked.ok, parkedIn: parked.syscall, parkedWhy: parked.why,
    killResult: killed,
    // The subject. False means the poller was still parked after its only writer was torn down.
    wokenByTeardown: woke.ok, wokeRounds: woke.rounds, stateAfter: woke.state,
    // And it woke with the right answer: its exit code is 0 only if revents carried POLLIN.
    pollerVerdict: pollerStat ? pollerStat.code : null,
    poller: pollerStat, writer: writerStat,
    SYS_poll,
  };
}

/**
 * An `open` refused with -EMFILE must not keep the file's sync access handle.
 *
 * `createSyncAccessHandle` is an exclusive lock per file, so a handle leaked by a refused open makes
 * that one file unopenable by any process for the lifetime of the page: a retryable errno turned
 * into permanent loss of one file. The observable is the second open, after room is made.
 */
function pOpenLeak(env) {
  ensureStdin(env);
  const path = "/tmp/openleak";
  const seed = env.fs.open(path, O_RDWR | O_CREAT, 0o600);
  if (seed < 0) return { ok: false, why: `seed open ${-seed}` };
  env.fs.write(seed, ENC.encode("hello"));
  env.fs.close(seed);
  // Copies of something cheap, so the open below is refused for want of an fd rather than for any
  // reason of its own.
  const copies = [];
  let refused = 0;
  for (let i = 0; i < OPEN_MAX + 8; i += 1) {
    const fd = env.fs.dup(0);
    if (fd < 0) { refused = -fd; break; }
    copies.push(fd);
  }
  const refusedOpen = env.fs.open(path, O_RDONLY);
  // Room again.
  for (const fd of copies) env.fs.close(fd);
  // The subject: the file must still be openable. A leaked handle makes this fail forever.
  const second = env.fs.open(path, O_RDONLY);
  const buf = new Uint8Array(16);
  const n = second >= 0 ? env.fs.read(second, buf) : -1;
  if (second >= 0) env.fs.close(second);
  return {
    ok: !!(refused > 0 && refusedOpen < 0 && second >= 0 && n === 5),
    tableFilled: refused > 0, duped: copies.length, refusedErrno: refused,
    refusedOpenErrno: refusedOpen < 0 ? -refusedOpen : 0,
    openRefused: refusedOpen < 0,
    // The file is still there and still readable.
    reopened: second >= 0, reopenErrno: second < 0 ? -second : 0,
    bytes: n, text: n > 0 ? DEC.decode(buf.subarray(0, n)) : "",
    EMFILE: E.EMFILE,
  };
}

function pPgrp(env) {
  const s = withStage(env, "ttysleep");
  if (s.err) return { ok: false, why: s.err };
  const started = awaitStarted(env, s.pid);
  const initial = env.tty.getPgrp(s.master);
  // Point the terminal at a group that does not exist: ESRCH, not a terminal whose Ctrl-C goes
  // nowhere observable.
  const bogus = env.tty.setPgrp(s.master, 99999);
  // Then at my own group, and back.
  const mine = env.proc.getpgid(0);
  const toMine = env.tty.setPgrp(s.master, mine);
  const afterMine = env.tty.getPgrp(s.master);
  const back = env.tty.setPgrp(s.master, s.pid);
  const afterBack = env.tty.getPgrp(s.master);
  env.proc.kill(-s.pid, SIGINT);
  const stat = env.proc.waitpid(s.pid);
  env.fs.close(s.master);
  return {
    ok: !!(started.ok && stat),
    initial, stagePid: s.pid, myPgid: mine,
    initialIsTheStage: initial === s.pid,
    bogusErrno: bogus < 0 ? -bogus : 0,
    bogusRefused: bogus < 0,
    toMine, afterMine, movedToMine: afterMine === mine,
    back, afterBack, movedBack: afterBack === s.pid,
    child: stat,
    ESRCH: E.ESRCH,
  };
}

export function run(env, go) {
  const mode = String((env.argv && env.argv[0]) || (go && go.argv && go.argv[0]) || "noop");
  const t0 = performance.now();
  let out;
  switch (mode) {
    case "ttyline": out = ttylineStage(env); break;
    case "ttyspin": out = ttyspinStage(env); break;
    case "ttysleep": out = ttysleepStage(env); break;
    case "ttypoll": out = ttypollStage(env); break;
    case "ttyemptypoll": out = ttyemptypollStage(env); break;
    case "ttyhuppoll": out = ttyhuppollStage(env); break;
    case "p_echo": out = pEcho(env); break;
    case "p_canon": out = pCanon(env); break;
    case "p_intr": out = pIntr(env); break;
    case "p_wedged": out = pWedged(env); break;
    case "p_raw": out = pRaw(env); break;
    case "p_termios": out = pTermios(env); break;
    case "p_winsize": out = pWinsize(env); break;
    case "p_poll": out = pPoll(env); break;
    case "p_pollwait": out = pPollWait(env); break;
    case "p_pgrp": out = pPgrp(env); break;
    case "p_selfwinch": out = pSelfwinch(env); break;
    case "p_emptypoll": out = pEmptyPoll(env); break;
    case "p_fdlimit": out = pFdLimit(env); break;
    case "p_teardownwake": out = pTeardownWake(env); break;
    case "p_openleak": out = pOpenLeak(env); break;
    default: out = { ok: false, why: `unknown mode ${mode}` };
  }
  return { mode, ms: performance.now() - t0, ...out };
}
