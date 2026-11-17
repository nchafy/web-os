// M5's process program: the shell and the ten programs, through real syscalls.
//
// MILESTONES.md M5's proof is `ls /usr/bin | grep c | wc -l` "correct through three real
// processes", then `sleep 60 &`, `ps`, `kill %1`. Every line below is typed at a shell that was
// loaded out of `/usr/bin/sh` by the kernel's exec path and runs in its own process worker; the
// stages it spawns are separate processes with separate pids, pipes and exit statuses.
//
// One orchestrator per proof, spawned by the page, which then spawns `sh`. The orchestrator is the
// only thing here that is not a real program: it exists because the page cannot make syscalls.
//
// Orchestrator modes:
//   p_pipeline     `ls /usr/bin | grep c | wc -l` through three processes, against a count this
//                  program works out for itself
//   p_jobs         `sleep 60 &`, `ps`, `kill %1`
//   p_redirect     `>`, `>>`, `<`, and `echo a > f1 > f2` leaving f1 there and empty
//   p_builtins     cd / pwd / $? / $$ / complete, which run IN the shell and spawn nothing
//   p_exec         what `spawn` will and will not load: a program on a writable mount, a file
//                  with no execute bit, a program that is not there, and argv in /proc
//   p_refusals     the three things this shell refuses to guess at
//   p_tty          the shell interactive on a pty: a typed line, Ctrl-C, Ctrl-D
//   p_noturl       a process cannot make the kernel fetch a URL, by path OR by import (123)
//   p_endless      `yes | head -1` terminates through a real shell — M4's headline, now sayable

import {
  E, EACCES, ENOENT, MAX_INLINE, O_CREAT, O_RDONLY, O_TRUNC, O_WRONLY,
  POLLIN, SIGINT, SIGTERM, SPAWN_CLOSE, SPAWN_DUP2, SYS_read,
// Absolute, not relative. A program spawned by a process is loaded as a Blob URL whose path is
// opaque (src/kernel/exec.mjs), so a relative specifier has nothing to resolve against and the
// module fails to load — measured, every stage faulted with SIGABRT and "never issued a syscall".
} from "/src/abi.mjs";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

const SH = "/usr/bin/sh";

/** A wall-clock ceiling on anything that waits. It is the error path: a stopped pipeline raises no
 *  error anywhere, so a bounded wait that reports beats a harness timeout that does not. */
const WAIT_CEILING_MS = 15000;

/** Hold fd 0 before calling `pipe2`. Constraint 94: `spawn` leaves fd 0 free and `fds.add` hands
 *  out the lowest, so `pipe2` would return 0 as its read end and every convention that treats 0 as
 *  stdin would wire the pipeline backwards. */
function ensureStdin(env) {
  const fd = env.fs.open("/dev/zero", O_RDONLY);
  if (fd < 0) throw new Error(`ensureStdin: /dev/zero is ${env.std.errnoName(fd)}`);
  if (fd > 0) env.fs.close(fd);
  return fd;
}

/**
 * Run one shell line and collect everything it wrote.
 *
 * The read comes before the wait. A pipeline whose output exceeds the 64 KiB pipe buffer blocks its
 * last stage in `write`, so an orchestrator that called `waitpid` first would wait for a process
 * that is waiting for it — a deadlock with no error anywhere. Draining to EOF first cannot
 * deadlock: EOF arrives when the last writer's fds close, at its teardown, exited or killed.
 *
 * stdout and stderr both land on the pipe, because a proof about a refusal needs the message.
 */
function runSh(env, line, { argv = ["sh", "-c", line] } = {}) {
  const pipe = env.proc.pipe2();
  if (typeof pipe === "number") return { error: `pipe2 ${env.std.errnoName(pipe)}` };
  const { rfd, wfd } = pipe;
  const actions = [
    { op: SPAWN_DUP2, a: wfd, b: 1 },
    { op: SPAWN_DUP2, a: wfd, b: 2 },
  ];
  if (rfd > 2) actions.push({ op: SPAWN_CLOSE, a: rfd });
  if (wfd > 2) actions.push({ op: SPAWN_CLOSE, a: wfd });
  const pid = env.proc.spawn(SH, argv, actions);
  if (pid < 0) {
    env.fs.close(rfd);
    env.fs.close(wfd);
    return { error: `spawn ${SH}: ${env.std.errnoName(pid)}`, errno: -pid };
  }
  // While the orchestrator holds a write end the pipe has a writer and the read below never sees
  // EOF.
  env.fs.close(wfd);
  const out = env.std.slurpText(env, rfd);
  env.fs.close(rfd);
  const stat = env.proc.waitpid(pid, 0);
  return {
    pid,
    output: typeof out === "string" ? out : "",
    readErrno: typeof out === "number" ? -out : 0,
    stat: typeof stat === "object" ? stat : null,
    status: typeof stat === "object" ? (stat.killed ? 128 + stat.code : stat.code) : -1,
  };
}

/** `/proc/<pid>/status`, as fields. The same shape `ps` parses, because it is the same file. */
function status(env, pid) {
  const text = env.std.readFileText(env, `/proc/${pid}/status`);
  if (typeof text === "number") return { errno: -text };
  const out = {};
  for (const row of text.split("\n")) {
    const cut = row.indexOf(":\t");
    if (cut > 0) out[row.slice(0, cut)] = row.slice(cut + 2);
  }
  return out;
}

/** Wait until `pid` is parked inside syscall `nr`. Observed, never slept for: a fixed wait races
 *  worker startup and signals processes that have never run. */
function awaitParkedIn(env, pid, nr, rounds = 400) {
  for (let i = 0; i < rounds; i += 1) {
    const f = status(env, pid);
    if (f.syscall !== undefined && Number(f.syscall) === nr) return { ok: true, rounds: i };
    if (f.errno) return { ok: false, why: `status errno ${f.errno}`, rounds: i };
    env.proc.nanosleep(2000000);
  }
  return { ok: false, why: `never parked in syscall ${nr}`, rounds };
}

/** Wait until a pid issues at least `want` syscalls, which for a fresh stage means it is running. */
function awaitStarted(env, pid, want = 1, rounds = 400) {
  for (let i = 0; i < rounds; i += 1) {
    const f = status(env, pid);
    if (f.errno) return { ok: false, why: `status errno ${f.errno}`, rounds: i };
    if (Number(f.calls) >= want) return { ok: true, rounds: i, calls: Number(f.calls) };
    env.proc.nanosleep(2000000);
  }
  return { ok: false, why: "never issued a syscall", rounds };
}

/** Every pid `/proc` currently lists. */
function livePids(env) {
  const entries = env.std.listDir(env, "/proc");
  if (typeof entries === "number") return [];
  return entries.filter((e) => /^\d+$/.test(e.name)).map((e) => Number(e.name)).sort((a, b) => a - b);
}

/**
 * PROOF 1. `ls /usr/bin | grep c | wc -l`, through three real processes.
 *
 * The expected number is computed here from `/usr/bin` itself, never written down: an expectation
 * edited to match the output is not an expectation. It is also the only way to tell "the pipeline
 * worked" from "the pipeline printed a plausible number" — the two routes to the same count are an
 * independent listing and three processes talking over two pipes.
 */
function pPipeline(env) {
  ensureStdin(env);
  const entries = env.std.listDir(env, "/usr/bin");
  if (typeof entries === "number") {
    return { ok: false, why: `/usr/bin: ${env.std.errnoName(entries)}` };
  }
  const names = entries.map((e) => e.name).filter((n) => !n.startsWith("."));
  const expected = names.filter((n) => n.includes("c")).length;

  const r = runSh(env, "ls /usr/bin | grep c | wc -l");
  if (r.error) return { ok: false, why: r.error };
  const printed = Number(r.output.trim());

  // `/dev/trace` is the kernel's own record of every syscall with the pid that issued it (M3), so
  // "three real processes" is read out of the kernel rather than inferred from the answer being
  // right — which is the claim the negative control attacks.
  const trace = env.std.readFileText(env, "/dev/trace");
  const pids = new Set();
  if (typeof trace === "string") {
    for (const row of env.std.lines(trace)) {
      // A record is tab-separated `seq pid nr name kind r0 extra t`; a header line is `key:\tvalue`
      // (src/kernel/devfs.mjs `renderTrace`). Selected by shape — eight fields, numeric first —
      // rather than by excluding header names, so a header row added later cannot be read as a
      // record with a pid of NaN.
      const f = row.split("\t");
      if (f.length !== 8 || !/^\d+$/.test(f[0]) || !/^\d+$/.test(f[1])) continue;
      pids.add(Number(f[1]));
    }
  }

  const two = runSh(env, "ls /usr/bin | wc -l");
  const unpiped = runSh(env, "ls /usr/bin");

  return {
    ok: !!(printed === expected && expected > 0),
    expected,
    printed,
    raw: r.output,
    status: r.status,
    shellPid: r.pid,
    // Every name `ls` printed with no pipe, so a disagreement says WHICH listing was wrong.
    unpipedLines: typeof unpiped.output === "string"
      ? env.std.lines(unpiped.output).length : -1,
    allNames: names.length,
    twoStage: two.output.trim(),
    twoStageMatchesAll: Number(two.output.trim()) === names.length,
    distinctPidsInTrace: pids.size,
    // The shell plus three stages is four; more is fine (an earlier proof's processes may still be
    // in the ring), fewer is the control.
    sawAtLeastFourPids: pids.size >= 4,
  };
}

/**
 * PROOF 2. `sleep 60 &`, `ps`, `kill %1`.
 *
 * One shell for all three lines, because a job table does not survive a process: `%1` means
 * nothing to a second shell. The shell is therefore driven through a pipe on its stdin, which also
 * proves it can read a script rather than a `-c` argument.
 */
function pJobs(env) {
  ensureStdin(env);
  const inPipe = env.proc.pipe2();
  if (typeof inPipe === "number") return { ok: false, why: `pipe2 ${-inPipe}` };
  const outPipe = env.proc.pipe2();
  if (typeof outPipe === "number") return { ok: false, why: `pipe2 ${-outPipe}` };
  const actions = [
    { op: SPAWN_DUP2, a: inPipe.rfd, b: 0 },
    { op: SPAWN_DUP2, a: outPipe.wfd, b: 1 },
    { op: SPAWN_DUP2, a: outPipe.wfd, b: 2 },
  ];
  for (const fd of [inPipe.rfd, inPipe.wfd, outPipe.rfd, outPipe.wfd]) {
    if (fd > 2) actions.push({ op: SPAWN_CLOSE, a: fd });
  }
  const shPid = env.proc.spawn(SH, ["sh"], actions);
  if (shPid < 0) {
    return { ok: false, why: `spawn sh: ${env.std.errnoName(shPid)}` };
  }
  env.fs.close(inPipe.rfd);
  env.fs.close(outPipe.wfd);

  // The whole script in one write, then the input end closes so the shell sees EOF and exits after
  // the last line. Writing line by line and waiting for a prompt would be a second line discipline
  // in the orchestrator.
  const script = "sleep 60 &\nps\nkill %1\njobs\n";
  const wrote = env.fs.write(inPipe.wfd, ENC.encode(script));
  env.fs.close(inPipe.wfd);

  const out = env.std.slurpText(env, outPipe.rfd);
  env.fs.close(outPipe.rfd);
  const stat = env.proc.waitpid(shPid, 0);
  const text = typeof out === "string" ? out : "";

  // `[1] <pid>` announces a background job, and that pid is what `%1` had to resolve to.
  const announced = /^\[1\] (\d+)/m.exec(text);
  const sleeperPid = announced ? Number(announced[1]) : 0;
  // Found by pid, which makes this a proof about the process table rather than about the word
  // "sleep" appearing in some output.
  const psRow = sleeperPid
    ? new RegExp(`^\\s*${sleeperPid}\\s+\\d+\\s+\\d+\\s+\\S+\\s+(.*)$`, "m").exec(text) : null;
  return {
    ok: !!(sleeperPid && psRow && /Killed \(SIGTERM\)/.test(text)),
    shellPid: shPid,
    wrote,
    sleeperPid,
    // The command `ps` printed for it comes from /proc/<pid>/cmdline, so this also proves argv
    // reached the process table.
    psCommand: psRow ? psRow[1].trim() : null,
    psSawSleeper: !!psRow,
    psSawShell: new RegExp(`^\\s*${shPid}\\s`, "m").test(text),
    // `kill %1` resolved a job spec to a pid and the signal was fatal at SIG_DFL.
    jobsReportedKilled: /Killed \(SIGTERM\)/.test(text),
    shellExited: !!(typeof stat === "object" && stat.exited),
    shellStatus: typeof stat === "object" ? stat.code : -1,
    SIGTERM,
    output: text,
  };
}

/** PROOF 3. Redirection. */
function pRedirect(env) {
  ensureStdin(env);
  const rows = [];
  const add = (name, r, want) => rows.push({ name, got: r, want, ok: r === want });

  const one = runSh(env, "echo hello > /tmp/m5a");
  const back = runSh(env, "cat /tmp/m5a");
  add("a redirected echo writes the file", back.output, "hello\n");

  runSh(env, "echo second >> /tmp/m5a");
  const both = runSh(env, "cat /tmp/m5a");
  add("append keeps what was there", both.output, "hello\nsecond\n");

  const counted = runSh(env, "wc -l < /tmp/m5a");
  add("input redirection feeds a program with no operands", counted.output.trim(), "2");

  // `echo a > f1 > f2` must create both targets and write only to the last.
  runSh(env, "echo twice > /tmp/m5b > /tmp/m5c");
  const b = runSh(env, "wc -c < /tmp/m5b");
  const c = runSh(env, "cat /tmp/m5c");
  add("every output target is created", b.output.trim(), "0");
  add("and only the last receives the output", c.output, "twice\n");

  // A redirection onto an unwritable path must report, not fail silently. `/usr` is MNT_RO.
  const refused = runSh(env, "echo x > /usr/bin/nope");
  rows.push({
    name: "a redirection onto a read-only mount is refused",
    got: { status: refused.status, output: refused.output.trim() },
    want: "a non-zero status naming EROFS",
    ok: refused.status !== 0 && /EROFS/.test(refused.output),
  });

  const failed = rows.filter((r) => !r.ok);
  return { ok: failed.length === 0, rows, failed, wroteStatus: one.status };
}

/**
 * PROOF 4. The builtins, which run in the shell and spawn nothing.
 *
 * Every row here is program-free, which is what makes M5's negative control specific rather than
 * total: `spawn_self` creates no child, so a section that reached for `echo` to print a variable
 * would go red along with the pipelines and the control would be satisfied by any failure. `$$` is
 * therefore observed by `cd /proc/$$` and `$?` by the shell's own exit status.
 */
function pBuiltins(env) {
  ensureStdin(env);
  const rows = [];
  const add = (name, got, want) => rows.push({ name, got, want, ok: got === want });

  add("pwd prints the working directory", runSh(env, "pwd").output, "/\n");
  // `cd` then `pwd` in one shell. In two shells it would prove nothing: a `cd` in a child that then
  // exits is what a `cd` program would be, which is why `cd` is a builtin.
  const script = runShScript(env, "cd /usr/bin\npwd\n");
  add("cd moves this shell's own directory", script.output, "/usr/bin\n");

  // `$$` without a program: `/proc/<pid>` exists only for a live pid, so a `cd` into it that
  // succeeds and a `pwd` that names it together prove `$$` expanded to the pid `spawn` handed back.
  const self = runShScript(env, "cd /proc/$$\npwd\n");
  rows.push({
    name: "$$ is the shell's own pid",
    got: { printed: self.output.trim(), shellPid: self.pid },
    want: `/proc/${self.pid}`,
    ok: self.output.trim() === `/proc/${self.pid}`,
  });

  // `$?` without a program: `exit $?` carries it out through the wait status, so the assertion is
  // on a number the kernel reported and not on text.
  const failedCd = runShScript(env, "cd /definitely-not-a-directory\nexit $?\n");
  rows.push({
    name: "$? carries a failed builtin's status",
    got: failedCd.status,
    want: "non-zero",
    ok: failedCd.status !== 0,
  });
  const missing = runShScript(env, "nosuchprogram\nexit $?\n");
  add("$? after a command that is not there is 127", missing.status, 127);
  const okStatus = runShScript(env, "pwd\nexit $?\n");
  add("$? after a builtin that worked is 0", okStatus.status, 0);

  // `complete` is a builtin because the answer is the shell's own PATH and builtin table.
  const comp = runSh(env, "complete l");
  rows.push({
    name: "complete offers command names for a command position",
    got: comp.output.trim().split("\n"),
    want: "includes ls",
    ok: env.std.lines(comp.output).includes("ls"),
  });
  const compPath = runSh(env, "complete cat /usr/bin/t");
  rows.push({
    name: "and paths after it",
    got: compPath.output.trim(),
    want: "/usr/bin/true",
    ok: env.std.lines(compPath.output).includes("/usr/bin/true"),
  });

  const failed = rows.filter((r) => !r.ok);
  return { ok: failed.length === 0, rows, failed };
}

/** The shell driven by a script on stdin rather than `-c`, for the proofs that need one session. */
function runShScript(env, script) {
  const started = startShScript(env, script);
  if (started.error) return { error: started.error, output: "" };
  return finishShScript(env, started);
}

/**
 * Start a shell on a script and return before draining its output, so the caller decides when to
 * drain.
 *
 * Split from `runShScript` because draining waits for the last writer, and a backgrounded job is
 * one: EOF cannot arrive until the backgrounded `sleep` closes the stdout it inherited, so a
 * caller that drains first sits in `read` for the whole sleep — measured at 30.9 s of a 40.3 s
 * page, by timestamping the page's own log lines.
 *
 * The obvious fix is not available. `sleep 30 > /dev/null &` would stop the job holding the pipe,
 * but `/dev` is mounted MNT_RO so the `O_CREAT` in a `>` redirection is -EROFS. Shortening the
 * sleep does not work either: the drain's own duration is what the job has to outlive.
 */
function startShScript(env, script) {
  const inPipe = env.proc.pipe2();
  if (typeof inPipe === "number") return { error: `pipe2 ${-inPipe}` };
  const outPipe = env.proc.pipe2();
  if (typeof outPipe === "number") return { error: `pipe2 ${-outPipe}` };
  const actions = [
    { op: SPAWN_DUP2, a: inPipe.rfd, b: 0 },
    { op: SPAWN_DUP2, a: outPipe.wfd, b: 1 },
    { op: SPAWN_DUP2, a: outPipe.wfd, b: 2 },
  ];
  for (const fd of [inPipe.rfd, inPipe.wfd, outPipe.rfd, outPipe.wfd]) {
    if (fd > 2) actions.push({ op: SPAWN_CLOSE, a: fd });
  }
  const pid = env.proc.spawn(SH, ["sh"], actions);
  if (pid < 0) return { error: `spawn ${env.std.errnoName(pid)}` };
  env.fs.close(inPipe.rfd);
  env.fs.close(outPipe.wfd);
  env.fs.write(inPipe.wfd, ENC.encode(script));
  // The script's end is the shell's EOF, so the shell runs to the last line and exits on its own.
  env.fs.close(inPipe.wfd);
  return { pid, rfd: outPipe.rfd };
}

/** Drain a started shell and reap it. Safe only once every writer that inherited its stdout has
 *  gone — which for a background job means after it has been killed. */
function finishShScript(env, started) {
  const out = env.std.slurpText(env, started.rfd);
  env.fs.close(started.rfd);
  const stat = env.proc.waitpid(started.pid, 0);
  return {
    pid: started.pid,
    output: typeof out === "string" ? out : "",
    status: typeof stat === "object" ? stat.code : -1,
  };
}

/** The pid of a live process whose cmdline matches, found by scanning `/proc`. The shell announces
 *  a background job's pid on the stdout this proof is deliberately not draining yet, so the pid is
 *  read out of the process table instead. Bounded: a process that never appears is reported. */
function awaitProcByCmdline(env, want, rounds = 400) {
  for (let i = 0; i < rounds; i += 1) {
    for (const pid of livePids(env)) {
      const raw = env.std.readFileText(env, `/proc/${pid}/cmdline`);
      if (typeof raw !== "string") continue;
      const argv = raw.split("\0").filter((x) => x !== "");
      if (argv.join(" ") === want) return { ok: true, pid, cmdline: argv.join(" "), rounds: i };
    }
    env.proc.nanosleep(2000000);
  }
  return { ok: false, why: `no live process with cmdline ${JSON.stringify(want)}`, rounds };
}

/**
 * PROOF 5. What `spawn` will and will not load.
 *
 * The subject is the exec path, not the shell: a program on a writable mount runs, a file without
 * an execute bit does not, a path that is not there is 127, and the argv reaches
 * `/proc/<pid>/cmdline`. The first is the only thing in this milestone that proves a program can
 * come from somewhere other than the read-only `/usr`.
 */
function pExec(env) {
  ensureStdin(env);
  const rows = [];
  const add = (name, ok, got, want) => rows.push({ name, ok: !!ok, got, want });

  // A program this process writes, then runs: the kernel reading program text out of a filesystem
  // a process can write, which is what makes `/usr/bin` a directory rather than a special case.
  const path = "/tmp/m5prog.mjs";
  const source = "export function run() { return { exit: 7 } }\n";
  const fd = env.fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  if (fd < 0) return { ok: false, why: `open ${path}: ${env.std.errnoName(fd)}` };
  env.fs.write(fd, ENC.encode(source));
  env.fs.close(fd);

  // With no execute bit: EACCES, which the shell reports as 126.
  const noX = runSh(env, path);
  add("a file with no execute bit is not a program", noX.status === 126 && /EACCES/.test(noX.output),
    { status: noX.status, output: noX.output.trim() }, "126 and EACCES");

  const chmod = env.fs.chmod(path, 0o755);
  const withX = runSh(env, path);
  add("and with one, it runs", withX.status === 7,
    { status: withX.status, chmod, output: withX.output.trim() }, 7);

  const absent = runSh(env, "/usr/bin/definitely-not-here");
  add("a program that is not there is 127", absent.status === 127 && /not found|ENOENT/.test(absent.output),
    { status: absent.status, output: absent.output.trim() }, "127");

  const dir = runSh(env, "/usr/bin");
  add("a directory is not a program", dir.status !== 0,
    { status: dir.status, output: dir.output.trim() }, "non-zero");

  const t = runSh(env, "true");
  add("/usr/bin/true exits 0", t.status === 0, t.status, 0);

  /* Argv reaches the process table. A long-running program is backgrounded by a real shell, found
   * in `/proc` while it is still alive, killed, and only then drained — see `startShScript` for
   * why the drain cannot come first. The pid comes from the process table rather than from the
   * shell's announcement, which also removes a parse of this shell's own output format. */
  const bg = startShScript(env, "sleep 30 &\necho ready\n");
  let cmdline = "";
  let found = { ok: false, why: bg.error || "not started" };
  if (!bg.error) {
    found = awaitProcByCmdline(env, "sleep 30");
    if (found.ok) {
      cmdline = found.cmdline;
      env.proc.kill(found.pid, SIGTERM);
      env.proc.waitpid(found.pid, 0);
    }
    // Only now: the pipe's last writer has gone, so EOF is immediate.
    finishShScript(env, bg);
  }
  add("argv reaches /proc/<pid>/cmdline", cmdline === "sleep 30",
    { cmdline, found: found.ok ? found.rounds : found.why }, "sleep 30");

  const failed = rows.filter((r) => !r.ok);
  return { ok: failed.length === 0, rows, failed, EACCES, ENOENT };
}

/** PROOF 6. The three things this shell refuses rather than guesses at. */
function pRefusals(env) {
  ensureStdin(env);
  const rows = [];
  const add = (name, r, pattern, wantStatus) => rows.push({
    name,
    got: { status: r.status, output: r.output.trim() },
    want: `${wantStatus} matching ${pattern}`,
    ok: r.status === wantStatus && new RegExp(pattern).test(r.output),
  });

  add("a pipeline with no last stage is a syntax error",
    runSh(env, "ls |"), "syntax error near", 2);
  add("&& is refused rather than read as a filename",
    runSh(env, "mkdir /tmp/x && echo x"), "not supported", 2);
  // Constraint 20a: with no fork one worker cannot be two stages, and running them in sequence
  // deadlocks when the pipe fills. The refusal names the reason.
  add("a builtin in a pipeline is refused, not deadlocked",
    runSh(env, "echo a | cd /tmp"), "there is no fork", 2);
  add("an unknown command is 127", runSh(env, "nosuchprogram"), "command not found", 127);
  add("an unterminated quote is a syntax error", runSh(env, "echo 'x"), "unterminated", 2);

  const failed = rows.filter((r) => !r.ok);
  return { ok: failed.length === 0, rows, failed };
}

/**
 * PROOF 7. The shell interactive on a real pty — the only proof that uses the line discipline.
 * Everything above drives the shell through a pipe, where there is no echo, no canonical buffering
 * and no foreground process group. Here a line is typed at the master, the discipline echoes it
 * and delivers it whole, the shell runs it, and the output comes back up the master.
 */
function pTty(env) {
  ensureStdin(env);
  const pty = env.tty.ptyOpen();
  if (typeof pty === "number") return { ok: false, why: `pty_open ${-pty}` };
  const { master, slave } = pty;
  const actions = [
    { op: SPAWN_DUP2, a: slave, b: 0 },
    { op: SPAWN_DUP2, a: slave, b: 1 },
    { op: SPAWN_DUP2, a: slave, b: 2 },
  ];
  if (master > 2) actions.push({ op: SPAWN_CLOSE, a: master });
  if (slave > 2) actions.push({ op: SPAWN_CLOSE, a: slave });
  const pid = env.proc.spawn(SH, ["sh"], actions);
  if (pid < 0) return { ok: false, why: `spawn sh: ${env.std.errnoName(pid)}` };
  // The shell in its own group, and that group made the terminal's foreground — what a session
  // leader does for the shell it starts.
  env.proc.setpgid(pid, pid);
  env.tty.setPgrp(master, pid);
  // While any reference to the slave exists the master never sees EOF, and a read after the shell
  // exits would park forever with no error anywhere.
  env.fs.close(slave);

  const started = awaitStarted(env, pid, 1);
  // The shell is parked in `read` on the terminal, which is where an interactive shell waits.
  const parked = awaitParkedIn(env, pid, SYS_read);

  const transcript = [];
  const drain = (ms = 400) => {
    const buf = new Uint8Array(MAX_INLINE);
    let text = "";
    const until = performance.now() + ms;
    for (;;) {
      const r = env.tty.poll([{ fd: master, events: POLLIN }], 100);
      if (typeof r === "number") break;
      if (r.nready > 0) {
        const n = env.fs.read(master, buf, 0, buf.length);
        if (n <= 0) break;
        text += DEC.decode(buf.subarray(0, n));
        continue;
      }
      if (performance.now() > until) break;
    }
    transcript.push(text);
    return text;
  };

  const banner = drain();
  env.fs.write(master, ENC.encode("echo typed\n"));
  const echoed = drain(1500);

  // Ctrl-C at a prompt. The shell's foreground group is its own, so the discipline raises SIGINT on
  // the shell itself, and the shell must survive it and print another prompt. A program dies.
  env.fs.write(master, ENC.encode("\x03"));
  const afterIntr = drain(800);
  const aliveAfterIntr = status(env, pid).state === "running";

  // Ctrl-D ends the session: `read` returns 0, which the loop treats as end of input.
  env.fs.write(master, ENC.encode("\x04"));
  const stat = env.proc.waitpid(pid, 0);
  drain(200);
  env.fs.close(master);

  return {
    ok: !!(started.ok && parked.ok && /typed/.test(echoed)
      && aliveAfterIntr && typeof stat === "object" && stat.exited),
    pid,
    started,
    parkedInRead: parked.ok,
    parkedWhy: parked.why,
    sawPrompt: /\$ /.test(banner),
    banner,
    // Both on the master: the discipline echoed the keystrokes and the program's own write came
    // back the same way.
    echoedTheLine: /echo typed/.test(echoed),
    ranTheLine: /^typed$/m.test(echoed.replace(/\r/g, "")),
    echoed,
    survivedCtrlC: aliveAfterIntr,
    promptAfterCtrlC: /\$ /.test(afterIntr),
    afterIntr,
    exitedOnCtrlD: !!(typeof stat === "object" && stat.exited),
    child: typeof stat === "object" ? stat : null,
    SIGINT,
  };
}

/**
 * PROOF 8. A process cannot make the kernel fetch a URL. Constraint 123.
 *
 * Every URL spelling must be refused by the filesystem, which is what the errnos below assert:
 * ENOENT means the path was looked up in the mount table and was not there. A kernel that resolved
 * these against `location` and fetched them would let a process name any origin and have the reply
 * evaluated as a program.
 */
function pNoUrl(env) {
  ensureStdin(env);
  const rows = [];
  for (const spec of [
    "https://example.invalid/x.mjs",
    "http://127.0.0.1:8000/src/bin/true.mjs",
    "//example.invalid/x.mjs",
    "data:text/javascript,export function run(){}",
    "/src/bin/true.mjs",
    "blob:http://localhost/abc",
  ]) {
    const r = env.proc.spawn(spec, ["x"], []);
    rows.push({ spec, r, errno: r < 0 ? -r : 0, name: r < 0 ? env.std.errnoName(r) : "SPAWNED" });
  }

  /* The other half: a program's own import naming a host. The kernel never calls `fetch`, so its
   * accounting can read zero loads while the child's module loader fetches and evaluates remote
   * code on its behalf. Measured: `new URL("//evil/p.mjs", base)` resolves off-origin, and a bare
   * `https://…` specifier is not matched by a path-shaped rewriter at all.
   *
   * Each program below is written to `/tmp`, made executable, and spawned. Every one must be
   * refused with ENOEXEC by the linker, before any Blob exists. `/src/abi.mjs` is the positive
   * control: the one specifier that must still work, so a refusal of everything is not mistaken
   * for a working allowlist. */
  const imports = [];
  for (const [name, specifier, want] of [
    ["offorigin", "//example.invalid/p.mjs", "refused"],
    ["absolute-url", "https://example.invalid/p.mjs", "refused"],
    ["backslash", "/\\example.invalid/p.mjs", "refused"],
    ["same-origin-path", "/admin/whatever.mjs", "refused"],
    ["relative", "../../src/abi.mjs", "refused"],
    ["dynamic-literal", "", "refused"],
    ["allowed", "/src/abi.mjs", "runs"],
  ]) {
    const path = `/tmp/m5imp-${name}.mjs`;
    const text = name === "dynamic-literal"
      ? 'export function run() { import("//example.invalid/p.mjs"); return { exit: 5 } }\n'
      : `import ${JSON.stringify(specifier)};\nexport function run() { return { exit: 5 } }\n`;
    const fd = env.fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o755);
    if (fd < 0) {
      imports.push({ name, error: env.std.errnoName(fd) });
      continue;
    }
    env.fs.write(fd, ENC.encode(text));
    env.fs.close(fd);
    env.fs.chmod(path, 0o755);
    const pid = env.proc.spawn(path, [name], []);
    let stat = null;
    if (pid >= 0) stat = env.proc.waitpid(pid, 0);
    imports.push({
      name, specifier, want,
      spawn: pid,
      errno: pid < 0 ? -pid : 0,
      errName: pid < 0 ? env.std.errnoName(pid) : "SPAWNED",
      stat: typeof stat === "object" ? stat : null,
      // A refusal is -ENOEXEC from `spawn` itself. A program that spawned and then faulted would
      // mean the Blob was built and the child's loader did the refusing: the browser declining,
      // not this kernel.
      ok: want === "refused" ? (pid === -E.ENOEXEC)
        : (pid > 0 && typeof stat === "object" && stat.exited && stat.code === 5),
    });
  }

  // `/src/bin/true.mjs` is a real file on the server and not in this system's filesystem, so it
  // must be refused too. A kernel that still reached the network would spawn that one and nothing
  // else, which is the narrowest possible tell.
  const importFailures = imports.filter((row) => !row.ok);
  return {
    ok: rows.every((row) => row.r < 0) && importFailures.length === 0,
    rows,
    refused: rows.filter((row) => row.r < 0).length,
    spawned: rows.filter((row) => row.r >= 0).map((row) => row.spec),
    allLookupFailures: rows.every((row) => row.errno === ENOENT || row.errno === E.ENOTDIR
      || row.errno === E.EINVAL),
    imports,
    importFailures,
    // The positive control, named separately in the report.
    allowedStillRuns: !!(imports.find((row) => row.name === "allowed") || {}).ok,
    ENOEXEC: E.ENOEXEC,
  };
}

/**
 * PROOF 9. `yes | head -1` terminates — M4's headline proof, said in shell.
 *
 * docs/ABI.md decision 5 is the asymmetry: a blocked reader whose last writer went sees EOF, and a
 * blocked writer whose last reader went gets -EPIPE plus SIGPIPE. `head` exits after one line, the
 * pipe loses its reader, and `yes` dies of the signal — which is also why `cat`, `head`, `grep`
 * and `std.eachLine` all stream instead of waiting for an end that never comes. `yes` is the
 * system's only endless source; `/dev/zero` here is a finite 256-byte file.
 */
function pEndless(env) {
  ensureStdin(env);
  const one = runSh(env, "yes | head -1");
  // The whole pipeline's status is its last stage's, which is `head` exiting cleanly.
  const many = runSh(env, "yes hello | head -3");
  const counted = runSh(env, "yes | head -5 | wc -l");
  return {
    ok: one.output === "y\n" && many.output === "hello\nhello\nhello\n"
      && counted.output.trim() === "5",
    oneLine: one.output,
    oneStatus: one.status,
    threeLines: many.output,
    counted: counted.output.trim(),
    // The proof is that it returned at all. If SIGPIPE were not fatal, `yes` would write until its
    // own cap and these calls would take the harness's timeout instead of answering.
    terminated: true,
  };
}

export function run(env, go) {
  const mode = String((env.argv && env.argv[0]) || (go && go.argv && go.argv[0]) || "noop");
  const t0 = performance.now();
  let out;
  try {
    switch (mode) {
      case "p_pipeline": out = pPipeline(env); break;
      case "p_jobs": out = pJobs(env); break;
      case "p_redirect": out = pRedirect(env); break;
      case "p_builtins": out = pBuiltins(env); break;
      case "p_exec": out = pExec(env); break;
      case "p_refusals": out = pRefusals(env); break;
      case "p_tty": out = pTty(env); break;
      case "p_noturl": out = pNoUrl(env); break;
      case "p_endless": out = pEndless(env); break;
      default: out = { ok: false, why: `unknown mode ${mode}` };
    }
  } catch (error) {
    // Left to `self.onerror` a throw arrives as a process fault with no mode attached, and the
    // page waits out its timeout for a result that can never come.
    out = { ok: false, why: `${mode} threw: ${(error && error.stack) || error}` };
  }
  return { mode, ms: performance.now() - t0, ceiling: WAIT_CEILING_MS, ...out };
}
