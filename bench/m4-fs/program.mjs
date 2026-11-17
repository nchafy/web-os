// M4's process program: pipes and process groups, through real syscalls from inside real processes.
//
// The milestone's proofs are written in shell syntax — `yes | head -1`, `sleep 100 | cat` — and
// there is no shell until M5, so each is built out of `pipe2` + `spawn` with posix_spawn file
// actions + `setpgid`, which is what replaces `fork` (constraint 20). One process orchestrates;
// the others are the pipeline's stages.
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
  packI64,
// Absolute, not relative. A program spawned by a process is loaded as a Blob URL whose path is
// opaque (src/kernel/exec.mjs), so a relative specifier has nothing to resolve against and the
// module fails to load — measured, every stage faulted with SIGABRT and "never issued a syscall".
} from "/src/abi.mjs";

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const SELF = "/bench/m4-fs/program.mjs";

/** A bound on every loop that would otherwise be "forever". A real hang gives a harness a timeout
 *  and no information; a bounded loop that reports it hit its cap says which loop and how far. */
const SPIN_CAP = 200000;

/**
 * `yes`: write forever and never check the return, which is the program the control is about. A
 * writer that breaks on a negative return makes the control's failure mode unobservable — with
 * SIGPIPE non-fatal the first write after `head` exits returns -EPIPE and `hitCap` is never true.
 */
function yesStage(env) {
  const buf = ENC.encode("y\n");
  let writes = 0;
  let last = 0;
  let errors = 0;
  for (; writes < SPIN_CAP; writes += 1) {
    last = env.fs.write(1, buf);
    if (last < 0) errors += 1;
  }
  return {
    ok: true, writes, errors, lastErrno: last < 0 ? -last : 0,
    // True means the writer was never stopped: the hang the control produces.
    hitCap: writes >= SPIN_CAP,
  };
}

function head1Stage(env) {
  const buf = new Uint8Array(64);
  const n = env.fs.read(0, buf);
  // Returning exits, so the pipe loses its reader: the event `yes | head -1` turns on.
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
    // The number itself is the proof: 0 is EOF and is not an errno (docs/ABI.md decision 5).
    result: n,
    isEof: n === 0,
    errno: n < 0 ? -n : 0,
  };
}

/** Long enough to be killed rather than to finish: a short sleep makes the two proofs that kill
 *  this stage race worker startup instead of signalling a parked process. 30 s, in nanoseconds,
 *  so a stage that outlives its orchestrator is a bounded leak rather than a hang. */
const SLEEP_NS = 30 * 1000 * 1000 * 1000;

function sleeperStage(env) {
  const [lo, hi] = packI64(SLEEP_NS);
  const r = env.syscall(2, lo, hi, 0);
  // Reached only if the sleep was interrupted or completed; a killed process never gets here.
  return { ok: true, result: r, errno: r < 0 ? -r : 0 };
}

function fillwriterStage(env) {
  // With a 64 KiB pipe the second of these parks, which makes this process a blocked writer.
  const buf = new Uint8Array(MAX_INLINE);
  let writes = 0;
  let last = 0;
  for (; writes < 64; writes += 1) {
    last = env.fs.write(1, buf);
    if (last < 0) break;
  }
  return { ok: true, writes, lastErrno: last < 0 ? -last : 0 };
}

/** Spawn one stage with the pipe end it needs on the standard fd, and close the pipe fds it does
 *  not. Closing them in the child is what makes the pipe's refcounts right: a child holding an
 *  unused end keeps the pipe alive and the EOF never arrives. */
function stage(env, mode, { stdin = -1, stdout = -1, close = [] } = {}) {
  const actions = [];
  if (stdin >= 0) actions.push({ op: SPAWN_DUP2, a: stdin, b: 0 });
  if (stdout >= 0) actions.push({ op: SPAWN_DUP2, a: stdout, b: 1 });
  // Only fds above 2 are closed, which is what `exec 3<&-` does in a shell. Closing by value
  // without this test closes the fd the dup2 above just installed: when a pipe end lands on 0 or
  // 1, closing the original closes the standard fd and the stage loses the end it was given.
  for (const fd of close) if (fd > 2) actions.push({ op: SPAWN_CLOSE, a: fd });
  return env.proc.spawn(SELF, [mode], actions);
}

/**
 * Make sure this process holds fd 0 before it calls `pipe2`.
 *
 * A process starts with fd 0 free: `spawn` installs the sink on 1 and 2 and leaves 0 unopened so a
 * `read(0)` is EBADF rather than a silent zero. `fds.add` hands out the lowest free fd, so `pipe2`
 * in a fresh process returns 0 as its read end, and every convention that treats 0 as stdin then
 * wires the pipeline backwards.
 */
function ensureStdin(env) {
  const fd = env.fs.open("/dev/zero", O_RDONLY);
  // A failure must stop the proof: fd 0 left free wires the pipeline backwards, so the proof
  // fails for a reason that is not its subject, or passes by luck.
  if (fd < 0) throw new Error(`ensureStdin: open /dev/zero failed with errno ${-fd}`);
  // Anything other than 0 means fd 0 was already open, which is fine: close the duplicate.
  if (fd > 0) env.fs.close(fd);
  return fd;
}

/**
 * Wait until `pid` has issued at least one syscall, so it is inside its blocking call.
 *
 * Not a sleep. A fixed wait races worker startup, and a stage signalled while still spawning
 * proves nothing about a parked process. `/proc/<pid>/status` carries the syscall count (M3), and
 * for every stage here the first syscall is the blocking one.
 */
function awaitStarted(env, pid, rounds = 200) {
  const buf = new Uint8Array(512);
  for (let i = 0; i < rounds; i += 1) {
    const fd = env.fs.open(`/proc/${pid}/status`, O_RDONLY);
    if (fd < 0) return { ok: false, why: `status open errno ${-fd}`, rounds: i };
    const n = env.fs.read(fd, buf);
    env.fs.close(fd);
    if (n > 0) {
      const text = DEC.decode(buf.subarray(0, n));
      const calls = /calls:\t(\d+)/.exec(text);
      if (calls && Number(calls[1]) >= 1) return { ok: true, rounds: i, calls: Number(calls[1]) };
    }
    // 2 ms between looks. Short enough that the proofs stay fast, long enough that the polling
    // itself does not dominate the kernel's dispatch.
    const [lo, hi] = packI64(2000000);
    env.syscall(2, lo, hi, 0);
  }
  return { ok: false, why: "never issued a syscall", rounds };
}

function pBasic(env) {
  ensureStdin(env);
  const pipe = env.proc.pipe2();
  if (typeof pipe === "number") return { ok: false, why: `pipe2 ${-pipe}` };
  const { rfd, wfd } = pipe;
  const w = stage(env, "fillwriter", { stdout: wfd, close: [rfd, wfd] });
  const r = stage(env, "catter", { stdin: rfd, close: [rfd, wfd] });
  // The parent must close both ends. While it holds the write end the pipe has a writer, so the
  // reader never sees EOF.
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
    // The proof: the writer was killed, by SIGPIPE. Not an exit, and not still running.
    yesKilledBySigpipe: !!(yesStat && yesStat.killed && yesStat.code === SIGPIPE),
    SIGPIPE,
  };
}

function pGroup(env) {
  ensureStdin(env);
  const pipe = env.proc.pipe2();
  if (typeof pipe === "number") return { ok: false, why: `pipe2 ${-pipe}` };
  const { rfd, wfd } = pipe;
  const sleeper = stage(env, "sleeper", { stdout: wfd, close: [rfd, wfd] });
  const catter = stage(env, "catter", { stdin: rfd, close: [rfd, wfd] });
  env.fs.close(rfd);
  env.fs.close(wfd);
  if (sleeper < 0 || catter < 0) return { ok: false, why: `spawn ${sleeper} ${catter}` };

  /* The pipeline gets its own process group and the orchestrator stays out of it, as a shell does
   * so one signal reaches every stage without touching the shell. Two separate `kill(pid, SIGINT)`
   * calls would exercise neither `deliverSignal`'s target < 0 branch nor pgid inheritance. */
  const g1 = env.proc.setpgid(sleeper, sleeper);
  const g2 = env.proc.setpgid(catter, sleeper);

  /* Both stages must be inside their blocking call before the signal. One sent immediately lands
   * on processes that are still spawning, which have never run, never piped and never parked. */
  const started = [awaitStarted(env, sleeper), awaitStarted(env, catter)];

  // Read back before the kill: asking after it returns -ESRCH, the stages being reaped by then.
  const stagePgids = [env.proc.getpgid(sleeper), env.proc.getpgid(catter)];

  // Ctrl-C as the line discipline will deliver it: one signal, to the whole foreground group.
  const killed = env.proc.kill(-sleeper, SIGINT);
  const sStat = env.proc.waitpid(sleeper);
  const cStat = env.proc.waitpid(catter);
  return {
    ok: sleeper > 0 && catter > 0 && started.every((s) => s.ok),
    myPgid: env.proc.getpgid(0),
    sleeperPid: sleeper, catterPid: catter,
    setpgidResults: [g1, g2],
    // The group both stages were moved into, read back from the kernel rather than assumed.
    stagePgids,
    started,
    // One kill, negative pid. 0 means the group was found and every member signalled.
    groupKillResult: killed,
    sleeper: sStat, catter: cStat,
    bothKilledByInt: !!(sStat && sStat.killed && sStat.code === SIGINT
      && cStat && cStat.killed && cStat.code === SIGINT),
    // The orchestrator must survive its own pipeline's Ctrl-C, which is what putting the stages in
    // their own group buys.
    orchestratorSurvived: true,
    SIGINT,
  };
}

function pKillWriter(env) {
  ensureStdin(env);
  const pipe = env.proc.pipe2();
  if (typeof pipe === "number") return { ok: false, why: `pipe2 ${-pipe}` };
  const { rfd, wfd } = pipe;
  // A writer that never writes, and a reader that blocks on it. SIGKILL runs no cleanup in the
  // process; kernel-side teardown closes its fds, and that is what must wake the reader.
  const writer = stage(env, "sleeper", { stdout: wfd, close: [rfd, wfd] });
  const reader = stage(env, "blockreader", { stdin: rfd, close: [rfd, wfd] });
  env.fs.close(rfd);
  env.fs.close(wfd);
  // The reader must be inside its read, observed rather than slept for.
  const readerStarted = awaitStarted(env, reader);
  const k = env.proc.kill(writer, SIGKILL);
  const rStat = env.proc.waitpid(reader);
  const wStat = env.proc.waitpid(writer);
  return {
    ok: writer > 0 && reader > 0 && readerStarted.ok,
    writerPid: writer, readerPid: reader, killResult: k,
    reader: rStat, writer: wStat,
    readerStarted,
    SIGKILL,
  };
}

function pKillReader(env) {
  ensureStdin(env);
  const pipe = env.proc.pipe2();
  if (typeof pipe === "number") return { ok: false, why: `pipe2 ${-pipe}` };
  const { rfd, wfd } = pipe;
  const writer = stage(env, "fillwriter", { stdout: wfd, close: [rfd, wfd] });
  const reader = stage(env, "sleeper", { stdin: rfd, close: [rfd, wfd] });
  env.fs.close(rfd);
  env.fs.close(wfd);
  // The writer must be parked on a full pipe before its reader goes, or the proof is about a
  // write that never blocked. Observed through /proc, not slept for.
  const writerStarted = awaitStarted(env, writer);
  const k = env.proc.kill(reader, SIGKILL);
  const wStat = env.proc.waitpid(writer);
  const rStat = env.proc.waitpid(reader);
  return {
    ok: writer > 0 && reader > 0 && writerStarted.ok,
    writerPid: writer, readerPid: reader, killResult: k,
    writer: wStat, reader: rStat, writerStarted,
    // The writer must have died of SIGPIPE. -EPIPE is what it would have seen, but a SIG_DFL
    // SIGPIPE is fatal so it usually never gets to see it.
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
