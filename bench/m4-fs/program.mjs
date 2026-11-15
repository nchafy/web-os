// M4's process program: pipes and process groups, through real syscalls from inside real processes.
//
// The milestone's proofs are written in shell syntax — `yes | head -1`, `sleep 100 | cat` — and
// there is no shell until M5. So each one is built here out of the mechanism the shell will use:
// `pipe2` + `spawn` with posix_spawn file actions + `setpgid`, which is what replaces `fork`
// (constraint 20). One process orchestrates; the others are the pipeline's stages.
//
// Orchestrator modes (argv[0]), each one proof:
//   p_yeshead      `yes | head -1` terminates: the writer must die of SIGPIPE
//   p_group        Ctrl-C on a pipeline kills both: kill(-pgid, SIGINT)
//   p_killwriter   a writer killed -9 makes its blocked reader return 0 (EOF)
//   p_killreader   a blocked writer whose reader died gets -EPIPE plus SIGPIPE
//   p_basic        a pipe carries bytes between two processes at all
//
// Stage modes, each spawned by an orchestrator:
//   yes            write "y\n" to fd 1 until something stops it
//   head1          read fd 0 once, then exit — the reader that goes away
//   catter         read fd 0 to EOF, report the total
//   blockreader    read fd 0 once and report exactly what came back
//   sleeper        clock_nanosleep, so the process is parked and interruptible
//   fillwriter     write until the pipe will not take more, then report

import {
  E, O_RDONLY, O_WRONLY, SPAWN_DUP2, SPAWN_CLOSE, SIGINT, SIGKILL, SIGPIPE, MAX_INLINE,
} from "../../src/abi.mjs";

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const SELF = "/bench/m4-fs/program.mjs";

/** A bound on every loop that would otherwise be "forever". A real hang gives a harness a timeout
 *  and no information; a bounded loop that reports it hit its cap says which loop and how far. */
const SPIN_CAP = 200000;

/* ----------------------------------- the stages ----------------------------------------- */

function yesStage(env) {
  const buf = ENC.encode("y\n");
  let writes = 0;
  let last = 0;
  for (; writes < SPIN_CAP; writes += 1) {
    last = env.fs.write(1, buf);
    if (last < 0) break;
  }
  return {
    ok: true, writes, lastErrno: last < 0 ? -last : 0,
    // TRUE means the writer was never stopped — which is the hang M4's negative control produces.
    hitCap: writes >= SPIN_CAP,
  };
}

function head1Stage(env) {
  const buf = new Uint8Array(64);
  const n = env.fs.read(0, buf);
  // Then return, which exits. The pipe loses its reader here, and that is the event the whole
  // `yes | head -1` proof turns on.
  return { ok: n > 0, read: n, text: n > 0 ? DEC.decode(buf.subarray(0, Math.min(n, 8))) : "" };
}

function catterStage(env) {
  const buf = new Uint8Array(MAX_INLINE);
  let total = 0;
  let reads = 0;
  let last = 0;
  for (; reads < SPIN_CAP; reads += 1) {
    last = env.fs.read(0, buf);
    if (last <= 0) break;      // 0 is EOF, negative is an errno
    total += last;
  }
  return { ok: true, total, reads, lastErrno: last < 0 ? -last : 0, sawEof: last === 0 };
}

function blockreaderStage(env) {
  const buf = new Uint8Array(64);
  const n = env.fs.read(0, buf);
  return {
    ok: true,
    // The number itself is the proof: 0 is EOF and is NOT an errno, which is the half of
    // docs/ABI.md decision 5 that is easiest to get backwards.
    result: n,
    isEof: n === 0,
    errno: n < 0 ? -n : 0,
  };
}

function sleeperStage(env) {
  const r = env.syscall(2, 0, 0, 0);     // clock_nanosleep, (lo, hi) ns
  return { ok: true, result: r };
}

function fillwriterStage(env) {
  // One maximal write at a time until the pipe refuses to take more. With a 64 KiB pipe the
  // second of these parks, which is what makes this process a BLOCKED writer.
  const buf = new Uint8Array(MAX_INLINE);
  let writes = 0;
  let last = 0;
  for (; writes < 64; writes += 1) {
    last = env.fs.write(1, buf);
    if (last < 0) break;
  }
  return { ok: true, writes, lastErrno: last < 0 ? -last : 0 };
}

/* -------------------------------- the orchestrators ------------------------------------- */

/** Spawn one stage with the pipe end it needs on the standard fd, and close the pipe fds it does
 *  not. Closing them in the CHILD is what makes the pipe's refcounts right: a child holding an
 *  unused end would keep the pipe alive and the EOF would never arrive. */
function stage(env, mode, { stdin = -1, stdout = -1, close = [] } = {}) {
  const actions = [];
  if (stdin >= 0) actions.push({ op: SPAWN_DUP2, a: stdin, b: 0 });
  if (stdout >= 0) actions.push({ op: SPAWN_DUP2, a: stdout, b: 1 });
  // ONLY FDS ABOVE 2 ARE CLOSED. A child must end up holding 0, 1 and 2 and nothing else of the
  // pipeline's, which is what `exec 3<&-` does in a shell. Closing by value without this test
  // closed the fd the dup2 above had just installed: when a pipe end lands on 0 or 1, the CLOSE
  // of the original is a CLOSE of the standard fd, and the stage loses the end it was given.
  for (const fd of close) if (fd > 2) actions.push({ op: SPAWN_CLOSE, a: fd });
  return env.proc.spawn(SELF, [mode], actions);
}

/**
 * Make sure this process holds fd 0 before it calls `pipe2`.
 *
 * A PROCESS STARTS WITH FD 0 FREE here: `spawn` installs the sink on 1 and 2 and deliberately
 * leaves 0 unopened so a `read(0)` is EBADF rather than a silent zero. `fds.add` hands out the
 * lowest free fd, so `pipe2` in a fresh process returns **0** as its read end — and then every
 * convention that treats 0 as stdin wires the pipeline backwards. Measured: the reader stage
 * dup'd fd 0 onto fd 0, closed it as "the pipe fd", and read from a closed descriptor.
 *
 * Opening `/dev/zero` first is what a real init does for every process, and it costs one syscall.
 * M5's shell has to do the same thing or inherit the same bug.
 */
function ensureStdin(env) {
  const fd = env.fs.open("/dev/zero", O_RDONLY);
  // Anything other than 0 means fd 0 was already open, which is fine: close the duplicate.
  if (fd > 0) env.fs.close(fd);
  return fd;
}

function pBasic(env) {
  ensureStdin(env);
  const pipe = env.proc.pipe2();
  if (typeof pipe === "number") return { ok: false, why: `pipe2 ${-pipe}` };
  const { rfd, wfd } = pipe;
  // A writer that writes a little and exits, and a reader that reads to EOF.
  const w = stage(env, "fillwriter", { stdout: wfd, close: [rfd, wfd] });
  const r = stage(env, "catter", { stdin: rfd, close: [rfd, wfd] });
  // THE PARENT MUST CLOSE BOTH ENDS. While it holds the write end the pipe has a writer, so the
  // reader never sees EOF — the classic pipeline mistake, and the reason this is explicit.
  env.fs.close(rfd);
  env.fs.close(wfd);
  const wStat = env.proc.waitpid(w);
  const rStat = env.proc.waitpid(r);
  return {
    ok: typeof w === "number" && w > 0 && typeof r === "number" && r > 0,
    writerPid: w, readerPid: r, writer: wStat, reader: rStat,
    pipe: { rfd, wfd },
  };
}

function pYesHead(env) {
  ensureStdin(env);
  const pipe = env.proc.pipe2();
  if (typeof pipe === "number") return { ok: false, why: `pipe2 ${-pipe}` };
  const { rfd, wfd } = pipe;
  const yes = stage(env, "yes", { stdout: wfd, close: [rfd, wfd] });
  const head = stage(env, "head1", { stdin: rfd, close: [rfd, wfd] });
  env.fs.close(rfd);
  env.fs.close(wfd);
  const headStat = env.proc.waitpid(head);
  const yesStat = env.proc.waitpid(yes);
  return {
    ok: typeof yes === "number" && yes > 0 && typeof head === "number" && head > 0,
    yesPid: yes, headPid: head,
    head: headStat, yes: yesStat,
    // THE PROOF: the writer was KILLED, by SIGPIPE. Not an exit, and not still running.
    yesKilledBySigpipe: !!(yesStat && yesStat.killed && yesStat.code === SIGPIPE),
    SIGPIPE,
  };
}

function pGroup(env) {
  ensureStdin(env);
  const pipe = env.proc.pipe2();
  if (typeof pipe === "number") return { ok: false, why: `pipe2 ${-pipe}` };
  const { rfd, wfd } = pipe;
  // A new process group for the pipeline, which is what a shell does and what makes one signal
  // reach every stage. The children inherit it at spawn.
  const pgid = env.proc.setpgid(0, 0);
  const sleeper = stage(env, "sleeper", { stdout: wfd, close: [rfd, wfd] });
  const catter = stage(env, "catter", { stdin: rfd, close: [rfd, wfd] });
  env.fs.close(rfd);
  env.fs.close(wfd);
  // CTRL-C, as the line discipline will deliver it: one signal to the whole foreground group.
  // Negative pid is the group. The orchestrator is in the group too, so it signals the two
  // children by pid instead — a process that killed its own group would kill itself and the
  // proof would have nobody left to report it.
  const k1 = env.proc.kill(sleeper, SIGINT);
  const k2 = env.proc.kill(catter, SIGINT);
  const sStat = env.proc.waitpid(sleeper);
  const cStat = env.proc.waitpid(catter);
  return {
    ok: typeof sleeper === "number" && sleeper > 0 && typeof catter === "number" && catter > 0,
    myPgid: env.proc.getpgid(0), setpgid: pgid,
    sleeperPid: sleeper, catterPid: catter,
    killResults: [k1, k2],
    sleeper: sStat, catter: cStat,
    // BOTH died, and by the signal rather than by running out of work.
    bothKilledByInt: !!(sStat && sStat.killed && sStat.code === SIGINT
      && cStat && cStat.killed && cStat.code === SIGINT),
    SIGINT,
  };
}

function pKillWriter(env) {
  ensureStdin(env);
  const pipe = env.proc.pipe2();
  if (typeof pipe === "number") return { ok: false, why: `pipe2 ${-pipe}` };
  const { rfd, wfd } = pipe;
  // A writer that never writes, and a reader that blocks on it. The writer is then killed -9,
  // which runs no cleanup in the process — teardown closes its fds kernel-side, and THAT is what
  // must wake the reader.
  const writer = stage(env, "sleeper", { stdout: wfd, close: [rfd, wfd] });
  const reader = stage(env, "blockreader", { stdin: rfd, close: [rfd, wfd] });
  env.fs.close(rfd);
  env.fs.close(wfd);
  // Give the reader a moment to reach its blocking read. A sleep, and the honest instrument:
  // "the reader is parked inside read()" is not observable from here.
  env.syscall(2, 50000000, 0, 0);          // clock_nanosleep 50 ms
  const k = env.proc.kill(writer, SIGKILL);
  const rStat = env.proc.waitpid(reader);
  const wStat = env.proc.waitpid(writer);
  return {
    ok: typeof writer === "number" && writer > 0 && typeof reader === "number" && reader > 0,
    writerPid: writer, readerPid: reader, killResult: k,
    reader: rStat, writer: wStat,
    SIGKILL,
  };
}

function pKillReader(env) {
  ensureStdin(env);
  const pipe = env.proc.pipe2();
  if (typeof pipe === "number") return { ok: false, why: `pipe2 ${-pipe}` };
  const { rfd, wfd } = pipe;
  // A writer that fills the pipe and then blocks, and a reader that never reads and is killed.
  const writer = stage(env, "fillwriter", { stdout: wfd, close: [rfd, wfd] });
  const reader = stage(env, "sleeper", { stdin: rfd, close: [rfd, wfd] });
  env.fs.close(rfd);
  env.fs.close(wfd);
  env.syscall(2, 100000000, 0, 0);         // 100 ms, long enough for the writer to fill and park
  const k = env.proc.kill(reader, SIGKILL);
  const wStat = env.proc.waitpid(writer);
  const rStat = env.proc.waitpid(reader);
  return {
    ok: typeof writer === "number" && writer > 0 && typeof reader === "number" && reader > 0,
    writerPid: writer, readerPid: reader, killResult: k,
    writer: wStat, reader: rStat,
    // The writer must have died of SIGPIPE. -EPIPE is what it would have SEEN; a SIG_DFL SIGPIPE
    // is fatal, so it usually never gets to see it — which is the point.
    writerKilledBySigpipe: !!(wStat && wStat.killed && wStat.code === SIGPIPE),
    SIGPIPE,
  };
}

export function run(env, go) {
  const mode = String((env.argv && env.argv[0]) || (go && go.argv && go.argv[0]) || "noop");
  const t0 = performance.now();
  let out;
  switch (mode) {
    case "yes": out = yesStage(env); break;
    case "head1": out = head1Stage(env); break;
    case "catter": out = catterStage(env); break;
    case "blockreader": out = blockreaderStage(env); break;
    case "sleeper": out = sleeperStage(env); break;
    case "fillwriter": out = fillwriterStage(env); break;
    case "p_basic": out = pBasic(env); break;
    case "p_yeshead": out = pYesHead(env); break;
    case "p_group": out = pGroup(env); break;
    case "p_killwriter": out = pKillWriter(env); break;
    case "p_killreader": out = pKillReader(env); break;
    default: out = { ok: false, why: `unknown mode ${mode}` };
  }
  return { mode, ms: performance.now() - t0, ...out };
}
