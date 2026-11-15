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
//
// Stage modes:
//   ttyline       read one line from fd 0 and report it
//   ttyspin       spin without syscalls, so only a signal can stop it
//   ttysleep      park in a long sleep, so a signal interrupts a parked process
//   ttypoll       PARK in poll over two fds and report which one woke it

import {
  E, O_RDONLY, SPAWN_DUP2, SPAWN_CLOSE, SIGINT, SIGWINCH, ISIG, ICANON, ECHO,
  VINTR, MAX_INLINE, POLLIN, packI64,
} from "../../src/abi.mjs";

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const SELF = "/bench/m4b-fs/program.mjs";
const SPIN_CAP = 200000;

/* ----------------------------------- the stages ----------------------------------------- */

function ttylineStage(env) {
  const buf = new Uint8Array(256);
  const n = env.fs.read(0, buf);
  return { ok: n > 0, read: n, text: n > 0 ? DEC.decode(buf.subarray(0, n)) : "" };
}

/**
 * Spin WITHOUT issuing a syscall, so nothing but a signal can stop this.
 *
 * Constraint 21: there is no preemption, so a compute-bound process is killable but not
 * interruptible. The SIGINT raised by the line discipline sets a SIGPEND bit, and this process
 * only notices it at its next syscall — so the loop makes one call every SPIN_CHUNK iterations,
 * which is the shape a real program that polls for interruption has. A loop with NO syscall at
 * all would need SIGKILL, and that is the degradation the constraint names.
 */
const SPIN_CHUNK = 20000;

function ttyspinStage(env) {
  let i = 0;
  let acc = 0;
  for (; i < SPIN_CAP; i += 1) {
    acc += i % 7;
    // The syscall at which a pending signal is drained. Rare enough that the process is genuinely
    // compute-bound between them.
    if (i % SPIN_CHUNK === 0) env.syscall(0);
  }
  return { ok: true, spun: i, acc, hitCap: i >= SPIN_CAP };
}

/**
 * Park in `poll` over TWO fds and report which woke it.
 *
 * Constraint 42's whole case: a process has one futex word and one outstanding call, so it cannot
 * wait on a pipe and a terminal at once without this. fd 0 is a pipe's read end and fd 1 is a pty
 * slave, both installed by the orchestrator's spawn file actions.
 */
function ttypollStage(env) {
  const r = env.tty.poll([{ fd: 0, events: POLLIN }, { fd: 1, events: POLLIN }], 5000);
  if (typeof r === "number") {
    // `exit` is how a stage's verdict reaches its parent: the kernel reaps a process-spawned
    // child and discards its result object, so the EXIT CODE is the channel. 2 = the call failed.
    return { ok: false, errno: -r, exit: 2 };
  }
  // Exactly ONE ready, and it must be the pipe. A timeout would report 0; both ready would mean
  // the poll was woken by something the orchestrator did not do.
  const wokeOnPipeOnly = r.nready === 1 && r.fds[0].revents !== 0 && r.fds[1].revents === 0;
  // AND THE DETAIL, down the pty, which the orchestrator reads off the master. That exercises the
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

/**
 * Park in a long sleep, so a signal is observable against a PARKED process rather than a racing
 * one. 8 s, not 30: under the `no_isig` control nothing kills this stage and it runs to
 * completion, so a longer sleep would make that control wait half a minute per proof for no extra
 * evidence. 8 s is still far longer than any proof takes to signal it.
 */
function ttysleepStage(env) {
  const [lo, hi] = packI64(8 * 1000 * 1000 * 1000);
  const r = env.syscall(2, lo, hi, 0);
  return { ok: true, result: r };
}

/* -------------------------------- orchestrator helpers ---------------------------------- */

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
  // The child in its OWN group, and that group made the terminal's foreground — which is what a
  // shell does and what makes one keystroke reach the pipeline and not the shell.
  env.proc.setpgid(pid, pid);
  const set = env.tty.setPgrp(master, pid);
  /* THE ORCHESTRATOR CLOSES ITS SLAVE FD, and this is the same mistake a pipeline makes with a
   * pipe. The slave end stays alive while ANY reference to its description exists, so a parent
   * that keeps its copy means the master never sees EOF — and a master read after the child died
   * parked forever with nothing to read and no error anywhere. A shell hands the slave to the
   * child and lets go of it. */
  env.fs.close(slave);
  return { master, pid, setPgrp: set, fgPgid: env.tty.getPgrp(master) };
}

function masterRead(env, master, want = 256) {
  const buf = new Uint8Array(Math.max(want, 256));
  const n = env.fs.read(master, buf, 0, want);
  return { n, text: n > 0 ? DEC.decode(buf.subarray(0, n)) : "" };
}

/* -------------------------------- the orchestrators ------------------------------------- */

function pEcho(env) {
  const s = withStage(env, "ttyline");
  if (s.err) return { ok: false, why: s.err };
  const started = awaitStarted(env, s.pid);
  env.fs.write(s.master, ENC.encode("hello\n"));
  const stat = env.proc.waitpid(s.pid);
  // The echo is on the MASTER's read side, which is where a terminal emulator would paint it.
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
  // A PARTIAL LINE. In canonical mode the program must read nothing yet.
  env.fs.write(s.master, ENC.encode("par"));
  const beforeStatus = readStatus(env, s.pid);
  // Still parked in its read, so it has made no further call.
  env.fs.write(s.master, ENC.encode("tial\n"));
  const stat = env.proc.waitpid(s.pid);
  env.fs.close(s.master);
  return {
    ok: !!(started.ok && stat && stat.exited),
    pid: s.pid, started, child: stat,
    stateWhilePartial: beforeStatus.state,
    // The child was still RUNNING (parked in read) while only half a line had been typed.
    parkedOnPartialLine: beforeStatus.state === "running",
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
  return { state: state ? state[1] : null, calls: calls ? Number(calls[1]) : null, text };
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
    // The ^C must NOT appear as a byte on the master: it was consumed, not echoed as data.
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
  // ISIG OFF: a ^C is DATA. Read-modify-write, which is the shape that stays correct as flags
  // are added — a caller that built a termios from scratch would clear words it never set.
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
    // The child exited normally, having READ the ^C as a byte rather than dying of it.
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
    // THE RESERVED WORDS SURVIVED. A caller built against today's three lflag bits must not
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
  // A resize on the MASTER must raise SIGWINCH on the slave's foreground group. The stage has
  // SIGWINCH at SIG_DFL, which is not fatal, so it keeps sleeping — the signal is observable as
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
    // The sleep was INTERRUPTED by SIGWINCH, which is how a non-fatal signal at a parked process
    // is observable at all.
    sleepInterrupted: !!(stat && stat.exited),
    EINTR: E.EINTR,
  };
}

/**
 * ONE process waiting on TWO fds, woken by either. Constraint 42's whole point: a process has one
 * futex word and one outstanding call, so without `poll` it cannot wait on a pipe and a terminal
 * at once — which is the case M4a's terminal hits first.
 */
function pPoll(env) {
  ensureStdin(env);
  const pipe = env.proc.pipe2();
  if (typeof pipe === "number") return { ok: false, why: `pipe2 ${-pipe}` };
  const pty = env.tty.ptyOpen();
  if (typeof pty === "number") return { ok: false, why: `pty_open ${-pty}` };

  const set = [{ fd: pipe.rfd, events: POLLIN }, { fd: pty.master, events: POLLIN }];

  // 1. NOTHING READY, timeout 0: a poll, not a wait.
  const idle = env.tty.poll(set, 0);

  // 2. The PIPE becomes ready.
  env.fs.write(pipe.wfd, ENC.encode("p"));
  const viaPipe = env.tty.poll(set, 0);

  // Drain it so the next poll is about the terminal alone.
  const buf = new Uint8Array(16);
  env.fs.read(pipe.rfd, buf, 0, 1);

  // 3. The TERMINAL becomes ready — via the echo of a keystroke, which is output on the master.
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
    // The pipe must NOT still be flagged once drained, or `poll` is reporting staleness.
    pipeQuietAfterDrain: viaTty.fds[0].revents === 0,
    badRevents: typeof bad === "object" ? bad.fds[0].revents : bad,
    POLLIN,
  };
}

/**
 * A process PARKED in `poll` over two fds, woken by one of them.
 *
 * The non-blocking proof above shows `poll` can report readiness; this shows it can WAIT, which is
 * the half constraint 42 is about and the half M4a's terminal needs — parked at idle with no
 * output, keys must still wake it.
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

  // WAIT UNTIL IT IS ACTUALLY PARKED IN THE POLL, observed rather than slept for.
  const started = awaitStarted(env, pid);
  const statusWhileParked = readStatus(env, pid);

  // Make exactly ONE of the two ready.
  env.fs.write(pipe.wfd, ENC.encode("wake"));
  const stat = env.proc.waitpid(pid);
  // The stage's own account, read off the master — so the orchestrator asserts on what the stage
  // SAW rather than only on that it exited.
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
    // The stage was parked in `poll` — the syscall name comes from /proc, so this is observed.
    parkedInPoll: statusWhileParked.state === "running",
    callsWhileParked: statusWhileParked.calls,
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
    default: out = { ok: false, why: `unknown mode ${mode}` };
  }
  return { mode, ms: performance.now() - t0, ...out };
}
