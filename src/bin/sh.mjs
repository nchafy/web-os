// `sh`: the shell. A userland client of the same ABI as everything else.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// ======================================================================================
// WHAT IS PORTED AND WHAT IS NEW.
//
// The FRONT END is `src/libos/shlex.mjs`, carried from `../webxp/apps/terminal/shell.mjs` and
// `glob.mjs` with the bugs-already-found comments intact. It is pure and host-testable.
//
// The EXECUTOR below is new, and it is new because the predecessor's could not survive the
// boundary: it called functions out of a `COMMANDS` table in its own process, passed stdin as a
// JavaScript string, and collected stdout into another string. There were no processes, so a
// pipeline was a variable called `stdin` being reassigned. Every stage here is a real process with
// a real pid, a real pipe and a real exit status, built from `pipe2` + `spawn` with posix_spawn
// file actions + `setpgid` — which is what replaces `fork` (constraint 20).
//
// WHAT NO `fork` COSTS, exactly, and the answer is narrower than it sounds. `( subshell )` is not
// supported, and would be fine in-process if it were — more POSIX-conformant for `$$` than a real
// fork, in fact. The real casualty is `f | g` WITH BOTH SIDES BUILTINS: one Worker cannot run
// both, and running them in sequence deadlocks as soon as the first fills the pipe buffer. This
// shell therefore REFUSES a builtin in any stage of a multi-stage pipeline rather than deadlocking
// (constraint 20a, and `pipelineBuiltin` below is where it is refused). A diagnosis is better than
// a hang, and a second shell worker is the fix a later milestone can buy.
// ======================================================================================

import {
  DT_DIR, EINTR, ENOENT, O_APPEND, O_CREAT, O_RDONLY, O_TRUNC, O_WRONLY,
  S_IFDIR, S_IFMT, SPAWN_CLOSE, SPAWN_DUP2, SIGNAL_NAME, WNOHANG,
  SIGINT, SIGQUIT, SIGTSTP, SIG_HANDLE, SIG_IGN,
} from "/src/abi.mjs";

const NAME = "sh";

/** Where a bare command name is looked up when the environment names no PATH. */
const DEFAULT_PATH = "/usr/bin";

const DEFAULT_HOME = "/";

/** A bound on the interactive read loop, so a terminal that stops answering ends the program
 *  rather than spinning. Generous: it is the error path. */
const MAX_LINES = 100000;

/* ------------------------------------------------------------------ the session --------- */

/**
 * Everything a shell session carries. A plain object, built once by `run`.
 *
 * `vars` holds only what was exported or assigned; `status` is `$?`; `jobs` is the background
 * table `%N` indexes. NOTHING HERE IS A FILE DESCRIPTION — constraint 15's rule reaches userland
 * too, and a session that cached an open fd across lines would leak one per redirection.
 */
function makeSession(env) {
  const envp = env.envp || {};
  return {
    env,
    vars: { ...envp },
    status: 0,
    lastBg: 0,
    /** Where `cd -` goes. Null until the first `cd`, and declared with the rest of the session
     *  rather than invented by the builtin that writes it. */
    oldcwd: null,
    jobs: [],
    nextJob: 1,
    cwd: "/",
    home: envp.HOME || DEFAULT_HOME,
    // `$HOME` AND `~` MUST AGREE. With no HOME in the environment `~` fell back to DEFAULT_HOME
    // while `$HOME` expanded to the empty string, so `cd ~` and `cd $HOME` went to different
    // places. The fallback is written into `vars` below, once, by `run`.
    path: envp.PATH || DEFAULT_PATH,
    // The terminal this shell controls, or -1. fd 0 when it is a tty, because that is the fd a
    // shell reads its lines from and therefore the one whose foreground group matters.
    tty: -1,
    pgid: 0,
    exiting: false,
    // A record of what ran, for the proofs. The page cannot see a pipeline from outside, so the
    // shell reports its own: one row per line, with the pids and the status.
    trace: [],
  };
}

/** `/proc/<pid>/cwd`, which is the only way to read a working directory here — there is no
 *  `getcwd` call, deliberately (src/abi.mjs SYS_chdir). */
function readCwd(sh) {
  const text = sh.env.std.readFileText(sh.env, `/proc/${sh.env.pid}/cwd`);
  if (typeof text === "number") return sh.cwd;
  return text.replace(/\n$/, "") || "/";
}

/* ------------------------------------------------------------------ expansion ----------- */

/** `$?`, `$$`, `$!` and every ordinary name, in the one place the front end asks for them. */
function lookupVar(sh, name) {
  if (name === "?") return String(sh.status);
  if (name === "$") return String(sh.env.pid);
  if (name === "!") return String(sh.lastBg);
  const v = sh.vars[name];
  return v === undefined ? "" : String(v);
}

/**
 * `%N`, `%%` and `%+` — a job spec — replaced by the job's process-group id.
 *
 * ANYWHERE IN AN UNQUOTED WORD, not only as a whole word, and that is what makes the group
 * reachable: `kill %1` signals the job's leader, and `kill -TERM -%1` signals the whole job,
 * because the `-` the user typed stays in front of the number. A shell that only expanded a whole
 * word would leave no way to say the second.
 *
 * AN UNKNOWN JOB IS AN ERROR, not an empty string. `kill %9` with no job 9 must say so rather than
 * run `kill` with no arguments.
 */
function jobPgid(sh, spec) {
  const job = (spec === "%" || spec === "+")
    ? currentJob(sh)
    : sh.jobs.find((j) => j.id === Number(spec));
  if (!job) throw new ShellError(`%${spec}: no such job`);
  /* THE JOB'S PROCESS GROUP, positive. The caller negates it and prefixes `--`, which is the only
   * spelling `kill` cannot misread — see `expandWords`.
   *
   * The first version expanded to the positive leader pid, which signalled one stage: for
   * `sleep 60 | sleep 60 &` the second stage survived, `jobs` printed `Running` for its full
   * minute, and no job spec could reach it. `src/bin/kill.mjs` takes a negative number as a
   * process group — POSIX's own spelling — reached through `--`, so `kill -9 123` still means
   * signal 9 and nothing had to be guessed.
   *
   * The whole group matters: the positive leader pid was the first version and it left the second
   * stage of `sleep 60 | sleep 60 &` running for its full minute with nothing able to reach it. */
  return job.pgid;
}

/** The most recent job that has not been reaped — `%%` and `%+`. */
function currentJob(sh) {
  for (let i = sh.jobs.length - 1; i >= 0; i -= 1) if (!sh.jobs[i].done) return sh.jobs[i];
  return null;
}

class ShellError extends Error {}

/** The filesystem operations `expandGlob` needs, over real syscalls. */
function globOps(sh) {
  const env = sh.env;
  return {
    list: (dir) => {
      const entries = env.std.listDir(env, dir);
      return typeof entries === "number" ? null : entries.map((e) => e.name);
    },
    exists: (path) => typeof env.fs.lstat(path) === "object",
    isDirectory: (path) => {
      const st = env.fs.stat(path);
      return typeof st === "object" && (st.mode & S_IFMT) === S_IFDIR;
    },
  };
}

/**
 * One stage's words, expanded: tilde, variables and job specs SPAN BY SPAN, then globs.
 *
 * THE EXPANSION RULES ARE `src/libos/shlex.mjs`'s and are pure; this function supplies the three
 * things only a running shell knows — the variables, the home directory and the job table — and
 * then does the one step that needs the filesystem.
 *
 * WHAT THIS USED TO GET WRONG, measured: it tested a per-WORD `quoted` flag and skipped every
 * expansion when any part of the word had been quoted, so `echo "$HOME"` printed the literal
 * `$HOME` and `ls "no"*` did not glob. Spans fixed it — see `tokenize`.
 *
 * GLOBBING IS LAST and is gated on `magic`, which `tokenize` computed from the BARE spans as
 * typed. So `ls '*'` looks for a file called `*`, and a `*` that arrived out of a variable's value
 * is not re-read as a pattern.
 */
function expandWords(sh, words) {
  const out = [];
  const shlex = sh.env.shlex;
  for (const word of words) {
    /* A JOB SPEC EXPANDS TO TWO WORDS: `--` and the NEGATIVE process group.
     *
     * TWO, because one is ambiguous and this system makes the ambiguity the common case rather
     * than a corner. `kill` reads a leading `-<digits>` as a signal — POSIX's obsolescent form —
     * so `%1` expanding to `-3` had `kill %1` answer `kill: usage:` with signal 3 consumed and no
     * target left. Pids here start at 1, so a job's group is routinely a number that is also a
     * signal; `kill -TERM -3` and `kill -- -3` are the only spellings that cannot be misread, and
     * the shell writes the second one. A reader never sees the `--`, and `kill` needed nothing
     * added for it: POSIX's end-of-options was already the answer.
     *
     * The NEGATIVE group, so one signal reaches every stage. The positive leader pid was the first
     * version and it left the second stage of `sleep 60 | sleep 60 &` running for its full minute
     * with no job spec able to reach it. */
    const spec = shlex.jobSpecOf(word);
    if (spec !== null) {
      out.push("--", String(-jobPgid(sh, spec)));
      continue;
    }
    const text = expandOneWord(sh, word);
    if (word.magic) out.push(...shlex.expandGlob(text, globOps(sh)));
    else out.push(text);
  }
  return out;
}

/** One token, expanded. The two callbacks are the whole of what this shell adds to the pure
 *  rules: its variables and its home directory. */
function expandOneWord(sh, word) {
  return sh.env.shlex.expandWord(word, {
    lookup: (n) => lookupVar(sh, n),
    home: sh.home,
  });
}

/* ------------------------------------------------------------------ PATH ---------------- */

/**
 * A command name to a program path, or null.
 *
 * A NAME CONTAINING `/` IS USED AS WRITTEN and is never searched for — POSIX, and the reason
 * `./prog` means the one here and not whatever is first in PATH.
 *
 * THE EXECUTE BIT IS NOT CHECKED HERE. `SYS_spawn` checks it against the caller's credential in
 * the kernel (src/kernel/exec.mjs), and a second check in userland would be a second permission
 * model that could disagree — the shell would report "not found" for a file that is there and
 * merely not executable. What the search tests is EXISTENCE, so a later EACCES from `spawn` is
 * reported as what it is.
 */
function resolveCommand(sh, name) {
  if (name.includes("/")) return name;
  for (const dir of sh.path.split(":")) {
    if (!dir) continue;
    const candidate = dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
    const st = sh.env.fs.stat(candidate);
    if (typeof st === "object" && (st.mode & S_IFMT) !== S_IFDIR) return candidate;
  }
  return null;
}

/** Every command name a completion could offer: the builtins, plus every name in PATH. */
function commandNames(sh) {
  const names = new Set(Object.keys(BUILTINS));
  for (const dir of sh.path.split(":")) {
    if (!dir) continue;
    const entries = sh.env.std.listDir(sh.env, dir);
    if (typeof entries === "number") continue;
    for (const e of entries) if (e.type !== DT_DIR) names.add(e.name);
  }
  return [...names];
}

/* ------------------------------------------------------------------ builtins ------------ */

/**
 * The builtins, as a table.
 *
 * A BUILTIN IS A COMMAND THAT CANNOT BE A PROGRAM, and that is the whole membership rule. `cd`
 * changes this process's working directory; `exit` ends this process; `jobs` and `wait` read a
 * table only this process has. Everything else is in `/usr/bin` — `echo` especially, because a
 * shell with a built-in echo and a program echo has one fact with two renderers.
 *
 * Each returns an exit status.
 */
const BUILTINS = {
  ":": () => 0,

  cd(sh, args) {
    const target = args[0] === undefined ? sh.home
      : args[0] === "-" ? (sh.oldcwd || sh.cwd) : args[0];
    const expanded = sh.env.shlex.expandTilde(target, sh.home);
    const r = sh.env.fs.chdir(expanded);
    if (r < 0) return sh.env.std.complainErrno(sh.env, "cd", expanded, r);
    // THE KERNEL IS ASKED WHERE IT PUT US rather than told. `chdir` normalizes lexically, so
    // computing the answer here would be a second implementation of that rule — and `cd ..` out of
    // a symlinked directory is exactly where the two would disagree.
    sh.oldcwd = sh.cwd;
    sh.cwd = readCwd(sh);
    sh.vars.PWD = sh.cwd;
    return 0;
  },

  pwd(sh) {
    sh.env.std.say(sh.env, `${sh.cwd}\n`);
    return 0;
  },

  exit(sh, args) {
    const code = args.length ? sh.env.std.wholeNumber(args[0]) : sh.status;
    if (code === null) {
      return sh.env.std.complain(sh.env, "exit", args[0], "numeric argument required", 2);
    }
    sh.exiting = true;
    return code & 0xff;
  },

  jobs(sh) {
    reapJobs(sh);
    for (const job of sh.jobs) {
      if (job.done && job.reported) continue;
      job.reported = true;
      sh.env.std.say(sh.env, `[${job.id}] ${job.done ? job.how : "Running"}\t${job.line}\n`);
    }
    // A JOB IS FORGOTTEN ONCE IT HAS BEEN REPORTED DONE, which is what makes `jobs` twice in a row
    // print a finished job once. Keeping them forever would also keep `%1` resolving to a pid that
    // has been reused — and pids here are monotonic precisely so that cannot silently happen.
    sh.jobs = sh.jobs.filter((j) => !j.done);
    return 0;
  },

  wait(sh, args) {
    reapJobs(sh);
    const targets = args.length
      ? args.map((a) => Number(a)).filter((n) => Number.isInteger(n))
      : sh.jobs.filter((j) => !j.done).map((j) => j.pgid);
    let status = 0;
    for (const target of targets) {
      /* A PID **OR** A PGID, and the first version took only a pgid — which made `wait $!` a
       * silent no-op for every multi-stage background pipeline. `$!` is POSIX's LAST stage's pid
       * and `job.pgid` is the FIRST stage's, so for `sleep 1 | cat &` they are different numbers:
       * the lookup missed, `wait` returned 0 immediately, and the pipeline was still running. */
      const job = sh.jobs.find((j) => j.pgid === target || j.pids.includes(target));
      if (!job) continue;
      status = waitJob(sh, job);
    }
    sh.jobs = sh.jobs.filter((j) => !j.done);
    return status;
  },

  export(sh, args) {
    for (const arg of args) {
      const cut = arg.indexOf("=");
      if (cut < 0) continue;
      sh.vars[arg.slice(0, cut)] = arg.slice(cut + 1);
    }
    // PATH IS RE-READ HERE AND NOWHERE ELSE, so `export PATH=/x` takes effect on the next command
    // rather than at the next prompt.
    if (sh.vars.PATH !== undefined) sh.path = String(sh.vars.PATH);
    if (sh.vars.HOME !== undefined) sh.home = String(sh.vars.HOME);
    return 0;
  },

  unset(sh, args) {
    for (const arg of args) delete sh.vars[arg];
    return 0;
  },

  /**
   * `complete <line>`: what Tab would offer for that line.
   *
   * A BUILTIN BECAUSE THE ANSWER IS THE SHELL'S. It needs the builtin table and this session's
   * PATH, neither of which a program can see — and it exists as a command rather than as an
   * unreachable function so the completion half of the ported front end has a caller. M7's
   * terminal calls the same `shlex.complete`; until there is a Tab key to press, this is how it is
   * exercised and checked.
   */
  complete(sh, args) {
    const line = args.join(" ");
    const r = sh.env.shlex.complete(line, {
      commands: () => commandNames(sh),
      home: sh.home,
      list: (dir) => {
        const entries = sh.env.std.listDir(sh.env, dir);
        return typeof entries === "number"
          ? null : entries.map((e) => ({ name: e.name, dir: e.type === DT_DIR }));
      },
    });
    for (const match of r.matches) sh.env.std.say(sh.env, `${match}\n`);
    return r.matches.length ? 0 : 1;
  },
};

/* ------------------------------------------------------------------ jobs ---------------- */

/** How a status reads in `jobs`. */
function howDone(stat) {
  if (!stat) return "Done";
  if (stat.killed) return `Killed (SIG${SIGNAL_NAME[stat.code] || stat.code})`;
  return stat.code ? `Exit ${stat.code}` : "Done";
}

/**
 * Reap whatever has finished, WITHOUT BLOCKING.
 *
 * Called at each prompt and by `jobs`/`wait`. A shell that never reaped would leave a zombie per
 * background command — and a zombie here holds a pid and a SAB in the ~2 s quarantine
 * (constraint 14), so the leak is bounded but real.
 */
function reapJobs(sh) {
  for (const job of sh.jobs) {
    if (job.done) continue;
    for (let i = 0; i < job.pids.length; i += 1) {
      if (job.reaped[i]) continue;
      const stat = sh.env.proc.waitpid(job.pids[i], WNOHANG);
      // 0 means "alive and nothing to report", which `waitpid` answers as pid 0 — NOT an error and
      // not a reason to mark the job done.
      if (typeof stat === "number" || !stat.pid) continue;
      job.reaped[i] = stat;
    }
    if (job.reaped.every((r) => r)) {
      job.done = true;
      job.how = howDone(job.reaped[job.reaped.length - 1]);
    }
  }
}

/** Wait for every process in a job and return the LAST stage's status, which is the pipeline's. */
function waitJob(sh, job) {
  let last = 0;
  for (let i = 0; i < job.pids.length; i += 1) {
    const stat = job.reaped[i] || sh.env.proc.waitpid(job.pids[i], 0);
    if (typeof stat === "number") {
      // -ECHILD means somebody already reaped it, which for a job this shell owns means `reapJobs`
      // did. Not an error, and not a status to report over the one already recorded.
      continue;
    }
    job.reaped[i] = stat;
    // THE STATUS OF A PIPELINE IS ITS LAST STAGE'S. `ls missing | wc -l` succeeds, which is POSIX
    // and is also why a check on a pipeline's status must name the stage it means.
    if (i === job.pids.length - 1) last = statusOf(stat);
  }
  job.done = true;
  job.how = howDone(job.reaped[job.reaped.length - 1]);
  return last;
}

/**
 * Record one line's pipeline, BOUNDED.
 *
 * The trace exists because a page cannot see a pipeline from outside: the shell reports its own
 * pids and statuses so a proof can assert "three processes" without parsing output. It is returned
 * whole in the result, so it is capped — `MAX_LINES` is 100,000 and an unbounded row per line is a
 * message that grows without limit for a session nobody is measuring.
 */
const TRACE_KEEP = 256;

function pushTrace(sh, row) {
  sh.trace.push(row);
  if (sh.trace.length > TRACE_KEEP) sh.trace.shift();
}

/** A wait status as a shell status: 128 + signal for a death, the exit code otherwise. The 128
 *  offset is the convention every shell uses, and it is what makes `$?` distinguish `exit 2` from
 *  a SIGINT. */
function statusOf(stat) {
  if (!stat) return 0;
  return stat.killed ? 128 + stat.code : stat.code;
}

/* ------------------------------------------------------------------ redirection --------- */

/**
 * Open one stage's redirections. Returns `{stdin, stdout, opened}` or an error.
 *
 * EVERY `>` TARGET IS OPENED and only the last receives the output: `echo a > f1 > f2` leaves `f1`
 * there and empty, which is what a shell does and what writing only the last one got wrong in the
 * predecessor — it created neither the file nor a word about it.
 */
function openRedirections(sh, stage) {
  const env = sh.env;
  const opened = [];
  let stdin = -1;
  let stdout = -1;
  const closeAll = () => {
    for (const fd of opened) env.fs.close(fd);
  };
  const fail = (path, r) => {
    closeAll();
    return { error: `${path}: ${env.std.errnoName(r)}` };
  };
  /* EVERY THROW BECOMES AN ERROR RETURN, and the fds already opened go with it.
   *
   * `expandOne` throws — an ambiguous redirect, an unknown job spec, a bad substitution — and the
   * throw used to escape with `opened` as a dead local: measured, `cat < notes.txt > '*'` leaked
   * the fd for `notes.txt` on every occurrence, and 1,021 of them exhaust OPEN_MAX. Worse, the
   * throw escaped `runPipeline` too, so a multi-stage line skipped BOTH the pipe-close loop and
   * `waitJob`: `cat big | cat > '*'` left the first stage parked in `write` on a pipe whose reader
   * the shell still held open, forever, with no job spec to kill it by. One try/catch here and one
   * try/finally in `runPipeline` close both halves.
   */
  try {
    if (stage.in !== null) {
      const path = expandOne(sh, stage.in);
      const fd = env.fs.open(path, O_RDONLY);
      if (fd < 0) return fail(path, fd);
      opened.push(fd);
      stdin = fd;
    }
    for (let i = 0; i < stage.outs.length; i += 1) {
      const { word, append } = stage.outs[i];
      const target = expandOne(sh, word);
      const flags = O_WRONLY | O_CREAT | (append ? O_APPEND : O_TRUNC);
      const fd = env.fs.open(target, flags, 0o644);
      if (fd < 0) return fail(target, fd);
      opened.push(fd);
      if (i === stage.outs.length - 1) stdout = fd;
    }
  } catch (error) {
    closeAll();
    // A ShellError or a UsageError from expansion is a message for the user, not a defect; it is
    // returned as this function's own error so the caller's cleanup runs on the normal path.
    if (error instanceof ShellError || error.name === "UsageError"
        || error.constructor.name === "UsageError") {
      return { error: error.message };
    }
    throw error;
  }
  return { stdin, stdout, opened };
}

/**
 * A redirection target, expanded. ONE word.
 *
 * It takes the TOKEN, so the quoting the user wrote is honoured: `> '*'` is a file called `*`, and
 * a glob that matches several files is an error — which is what a shell does for `> *`, because a
 * redirection has one destination. Rebuilding the target from its text and calling it unquoted was
 * the data-loss defect: `echo hi > '*'` globbed and truncated an unrelated file.
 */
function expandOne(sh, word) {
  const text = expandOneWord(sh, word);
  if (!word.magic) return text;
  const matches = sh.env.shlex.expandGlob(text, globOps(sh));
  if (matches.length !== 1) throw new ShellError(`${word.text}: ambiguous redirect`);
  return matches[0];
}

/* ------------------------------------------------------------------ the executor -------- */

/**
 * Whether a multi-stage pipeline names a builtin. Constraint 20a.
 *
 * REFUSED, NOT DEADLOCKED. With no `fork` this process cannot be two stages at once, and running
 * them in sequence hangs the moment the first fills the 64 KiB pipe buffer with nobody reading.
 * The refusal names the stage and the reason, which is strictly better than a terminal that stops
 * responding.
 */
function pipelineBuiltin(stages, names) {
  if (stages.length < 2) return null;
  for (const name of names) if (Object.hasOwn(BUILTINS, name)) return name;
  return null;
}

/**
 * Run one parsed pipeline.
 *
 * THE SHAPE, and every line of it is the mechanism M4 proved:
 *   1. a pipe per boundary (`pipe2`)
 *   2. one `spawn` per stage, with file actions putting the right end on 0 and 1 and CLOSING the
 *      pipe fds the stage does not need — a stage holding an unused end keeps the pipe alive and
 *      the EOF never arrives
 *   3. every stage in ONE new process group, led by the first, so one Ctrl-C reaches the pipeline
 *      and not the shell
 *   4. the shell closes its own copies of every pipe fd — while it holds a write end the reader
 *      never sees EOF, which is the classic pipeline mistake
 *   5. the group becomes the terminal's foreground group, and the shell takes it back afterwards
 */
function runPipeline(sh, stages, background, line) {
  const env = sh.env;
  const std = env.std;

  // Expand first, so a failure costs no fd and no process.
  const expanded = [];
  for (const stage of stages) {
    const words = expandWords(sh, stage.words);
    if (!words.length) throw new ShellError("syntax error: command expanded to nothing");
    expanded.push(words);
  }

  const builtin = pipelineBuiltin(stages, expanded.map((w) => w[0]));
  if (builtin) {
    return std.complain(env, NAME, builtin,
      "a builtin cannot be a stage of a pipeline — there is no fork (constraint 20a)", 2);
  }

  // A SINGLE BUILTIN RUNS IN THIS PROCESS, redirections and all. `cd` in a child would change a
  // directory and then exit, which is the oldest shell bug there is.
  if (stages.length === 1 && Object.hasOwn(BUILTINS, expanded[0][0])) {
    if (!background) return runBuiltinStage(sh, stages[0], expanded[0]);
    /* A BACKGROUNDED BUILTIN IS REFUSED WITH A REASON. It used to fall through to the PATH search
     * and come back `cd: command not found`, exit 127 — which says "there is no such command"
     * about a command this shell has and is simply declining to background. With no fork there is
     * nothing to put in the background, so this is constraint 20a's refusal in its second
     * spelling. */
    return std.complain(env, NAME, expanded[0][0],
      "a builtin cannot be backgrounded — there is no fork (constraint 20a)", 2);
  }

  const pipes = [];
  const children = [];
  const myOpened = [];
  let failed = null;
  let cleaned = false;

  /* THE CLEANUP IS A FUNCTION AND IT RUNS ON EVERY PATH, including a throw.
   *
   * While the shell holds a pipe's write end the pipe has a writer and no reader ever sees EOF;
   * while it holds the read end a writer never sees EPIPE. A throw out of the loop below used to
   * skip this entirely, which left a stage parked in `write` forever — `cat big | cat > '*'`,
   * measured. `cleaned` makes it idempotent so the normal path can run it early, before the wait.
   */
  const closeMine = () => {
    if (cleaned) return;
    cleaned = true;
    for (const p of pipes) {
      env.fs.close(p.rfd);
      env.fs.close(p.wfd);
    }
    for (const fd of myOpened) env.fs.close(fd);
  };

  try {
    spawnStages(sh, stages, expanded, pipes, children, myOpened, (code) => { failed = code; });
  } finally {
    closeMine();
    /* A CHILD THIS SHELL STARTED IS ALWAYS REAPED. On the throw path there is no job row, so
     * `reapJobs` would never see it either: the pid and its SAB would sit in the quarantine with
     * nobody holding them, which is a leak constraint 14 bounds in time and not in count. */
    if (children.length && failed !== null) {
      for (const pid of children) env.proc.waitpid(pid, 0);
    }
  }

  if (!children.length) return failed === null ? 1 : failed;
  if (failed !== null) return failed;

  const job = buildJob(sh, children, line);
  if (background) return startBackground(sh, job, children, line);
  return runForeground(sh, job, children, line);
}

/** The spawn loop. Extracted so `runPipeline`'s cleanup can be a `finally` over the whole of it
 *  rather than a sequence a `break` or a throw can step past. */
function spawnStages(sh, stages, expanded, pipes, children, myOpened, fail) {
  const env = sh.env;
  const std = env.std;
  for (let i = 0; i < stages.length; i += 1) {
    const words = expanded[i];
    const program = resolveCommand(sh, words[0]);
    if (program === null) {
      // THE NAME IS PRINTED EVEN WHEN IT IS EMPTY. `sh -c "''"` and a command name that expanded
      // to nothing used to say `sh: command not found` with no subject at all.
      fail(std.complain(env, NAME, words[0] === "" ? "''" : words[0], "command not found", 127));
      return;
    }
    const red = openRedirections(sh, stages[i]);
    if (red.error) {
      fail(std.complain(env, NAME, null, red.error, 1));
      return;
    }
    myOpened.push(...red.opened);

    // The pipe to the NEXT stage, created before this stage is spawned so the write end can be an
    // action on it.
    let toNext = null;
    if (i + 1 < stages.length) {
      toNext = env.proc.pipe2();
      if (typeof toNext === "number") {
        fail(std.complainErrno(env, NAME, "pipe2", toNext));
        return;
      }
      pipes.push(toNext);
    }

    // `< file` WINS OVER THE PIPE for the first stage, and the pipe wins where there is no
    // redirection. POSIX's rule is "last one applies", and for a stage that is both piped into and
    // redirected the redirection is written later on the line.
    const stdin = red.stdin >= 0 ? red.stdin : (i > 0 ? pipes[i - 1].rfd : -1);
    const stdout = red.stdout >= 0 ? red.stdout : (toNext ? toNext.wfd : -1);

    const actions = [];
    if (stdin >= 0) actions.push({ op: SPAWN_DUP2, a: stdin, b: 0 });
    if (stdout >= 0) actions.push({ op: SPAWN_DUP2, a: stdout, b: 1 });
    // ONLY FDS ABOVE 2 ARE CLOSED IN THE CHILD. A pipe end that landed on 0 or 1 is reachable by
    // its original number too, and closing by value without this test closed the fd the `dup2`
    // had just installed — measured in M4, where a stage lost the end it had been given.
    for (const p of pipes) {
      if (p.rfd > 2) actions.push({ op: SPAWN_CLOSE, a: p.rfd });
      if (p.wfd > 2) actions.push({ op: SPAWN_CLOSE, a: p.wfd });
    }
    for (const fd of red.opened) if (fd > 2) actions.push({ op: SPAWN_CLOSE, a: fd });

    const pid = env.proc.spawn(program, words, actions);
    if (pid < 0) {
      // 127 FOR A PROGRAM THAT IS NOT THERE and 126 for one that is and could not be run,
      // which is the convention every shell follows and the pair a script actually branches on.
      // Written as `-ENOENT` and not as a literal: the errno space here is WASI's, where ENOENT is
      // 44 — a hardcoded `-2` would have silently classified every failure as 126.
      fail(std.complainErrno(env, words[0], null, pid, pid === -ENOENT ? 127 : 126));
      return;
    }
    children.push(pid);
    // THE GROUP IS THE FIRST CHILD'S PID. Set from the shell AND not from the child, because the
    // child may already be running — the race is why POSIX has both ends do it, and the shell's
    // call is the one that must not be skipped.
    // THE RETURN IS CHECKED. `setpgid` can answer -ESRCH or -EPERM, and a child left in the
    // shell's own group would then be made the terminal's foreground group below — which makes the
    // SHELL a background process reading from its own terminal. Reported rather than discarded.
    const grouped = env.proc.setpgid(pid, children[0]);
    if (grouped < 0) {
      std.warn(env, `${NAME}: setpgid ${pid}: ${std.errnoName(grouped)}`);
    }
  }
}

function buildJob(sh, children, line) {
  return {
    id: sh.nextJob,
    pgid: children[0],
    pids: children,
    reaped: children.map(() => null),
    line,
    done: false,
    reported: false,
    how: "Running",
  };
}

/** A backgrounded pipeline: recorded, announced, and NOT waited for. `$!` is the last stage's pid,
 *  which is POSIX; `%N` resolves to the job's process GROUP, so the two are deliberately different
 *  numbers for a multi-stage job and `wait` has to accept either. */
function startBackground(sh, job, children, line) {
  sh.nextJob += 1;
  sh.jobs.push(job);
  sh.lastBg = children[children.length - 1];
  sh.env.std.say(sh.env, `[${job.id}] ${sh.lastBg}\n`);
  pushTrace(sh, { line, pids: children, pgid: job.pgid, background: true });
  return 0;
}

/**
 * A foreground pipeline: the terminal's foreground group, the wait, and the terminal back.
 *
 * A shell that read its next line while a background group held the terminal would be a background
 * process reading from the terminal, which is what SIGTTIN is for — so the group goes back before
 * anything else happens, on every path.
 */
function runForeground(sh, job, children, line) {
  const env = sh.env;
  if (sh.tty >= 0) env.tty.setPgrp(sh.tty, job.pgid);
  try {
    const status = waitJob(sh, job);
    pushTrace(sh, { line, pids: children, pgid: job.pgid, status, background: false });
    return status;
  } finally {
    if (sh.tty >= 0) env.tty.setPgrp(sh.tty, sh.pgid);
  }
}

/**
 * A single builtin, with its redirections applied to THIS process and then undone.
 *
 * `dup`/`dup2` AND NOT A SECOND PROCESS: the point of a builtin is that it runs here. The saved
 * copies are restored in a `finally`, because a builtin that threw with stdout still pointing at a
 * file would send every later prompt into that file.
 */
function runBuiltinStage(sh, stage, words) {
  const env = sh.env;
  const red = openRedirections(sh, stage);
  if (red.error) return env.std.complain(env, NAME, null, red.error, 1);
  const saved = [];
  /**
   * Point `fd` at `to`, remembering what was there. Returns false if the SAVE failed.
   *
   * THE SAVE IS CHECKED, and that is the fix. The first version pushed `dup`'s return unchecked and
   * the restore branch read a negative copy as "the fd was not open before" and CLOSED it — so a
   * `dup` answering -EMFILE turned `pwd > out.txt` into a shell with no stdout at all: every later
   * `say` returned -EBADF and the next `pipe2` handed out fd 1 as a pipe end (constraint 94). The
   * branch's premise was never true either: `ensureStdin` guarantees fd 0 and `spawn` guarantees
   * 1 and 2, so a negative `dup` was the ONLY way to reach it.
   */
  const point = (fd, to) => {
    const copy = env.fs.dup(fd);
    if (copy < 0) return false;
    saved.push([fd, copy]);
    env.fs.dup2(to, fd);
    return true;
  };
  try {
    if (red.stdin >= 0 && !point(0, red.stdin)) {
      return env.std.complain(env, NAME, words[0], "cannot save fd 0 for a redirection", 1);
    }
    if (red.stdout >= 0 && !point(1, red.stdout)) {
      return env.std.complain(env, NAME, words[0], "cannot save fd 1 for a redirection", 1);
    }
    return BUILTINS[words[0]](sh, words.slice(1));
  } finally {
    // Every saved fd is a real one, so every restore is a dup2 back. There is no "it was closed"
    // case any more — see `point`.
    for (const [fd, copy] of saved) {
      env.fs.dup2(copy, fd);
      env.fs.close(copy);
    }
    for (const fd of red.opened) env.fs.close(fd);
  }
}

/** Run one line of input. Returns the status, and never throws for anything a user can type. */
export function runLine(sh, line) {
  const env = sh.env;
  if (!line.trim()) return sh.status;
  let parsed;
  try {
    parsed = env.shlex.parse(line);
  } catch (error) {
    env.std.warn(env, `${NAME}: ${error.message}`);
    sh.status = 2;
    return sh.status;
  }
  if (!parsed.stages.length) return sh.status;
  try {
    sh.status = runPipeline(sh, parsed.stages, parsed.background, line.trim());
  } catch (error) {
    if (error instanceof ShellError) {
      env.std.warn(env, `${NAME}: ${error.message}`);
      sh.status = 1;
    } else if (error && (error.name === "UsageError"
        || error.constructor.name === "UsageError")) {
      /* A UsageError RAISED DURING EXPANSION, not during parsing. `parse` is wrapped separately
       * above, so `echo ${}` reached the branch below and was reported as a DEFECT IN THIS SHELL,
       * with a stack trace and exit 70, for four characters a user can type. `instanceof` is not
       * usable across the module boundary here — the shell receives `shlex` through `env`, so a
       * future second instance of the module would make the check silently false — hence the name
       * test, which is also why `ShellError` above is this module's own class. */
      env.std.warn(env, `${NAME}: ${error.message}`);
      sh.status = 2;
    } else {
      // A throw that is not a ShellError is a DEFECT IN THIS PROGRAM, and it is reported as one
      // rather than as a command that failed. Swallowing it would make a shell bug look like a
      // user error on every line.
      env.std.warn(env, `${NAME}: internal error: ${(error && error.stack) || error}`);
      sh.status = 70;
    }
  }
  return sh.status;
}

/* ------------------------------------------------------------------ the loop ------------ */

function prompt(sh) {
  const cwd = sh.cwd === sh.home ? "~" : sh.cwd;
  return `${cwd}$ `;
}

/**
 * Write the prompt, RETRYING ONCE PAST AN -EINTR.
 *
 * ONE SIGNAL COSTS TWO -EINTRs ON THIS ABI, and the retry is here because that is where it shows.
 * `docs/ABI.md` decision 1 has the kernel do both halves of delivery: it sets the SIGPEND bit AND
 * interrupts the call in flight. So a Ctrl-C at a prompt interrupts the parked `read` — which is
 * the one the shell wants — and leaves the bit pending, so the libos's entry check interrupts the
 * NEXT call too (src/libos/syscall.mjs, `drainSignals` at entry) before the bits are cleared by
 * the exchange. That next call is this write.
 *
 * MEASURED, not reasoned: without the retry, Ctrl-C at a prompt printed no new prompt at all —
 * `afterIntr` came back empty in www/m5.html's PROOF 7 while the shell was demonstrably alive and
 * still read the next line. Recorded as docs/CONSTRAINTS.md 131, which also says why the kernel
 * was not changed instead: clearing the bit when the kernel interrupts an in-flight call is
 * arguably the right fix and it moves a delivery rule that 298 existing expectations rest on.
 *
 * ONE retry is exactly enough and the bound is not a guess: the entry check CLEARS the bits it
 * reports, so the second attempt cannot be interrupted by the same signal.
 */
function writePrompt(sh) {
  const r = sh.env.std.say(sh.env, prompt(sh));
  if (r !== -EINTR) return r;
  return sh.env.std.say(sh.env, prompt(sh));
}

/**
 * The read loop: a prompt, a line, a pipeline.
 *
 * IT BUFFERS A PARTIAL LINE, and it has to. The first version read 4096 bytes and split them on
 * newlines, justified by the terminal's canonical mode — but this loop is also how a SCRIPT is
 * read, and `cat script | sh` has a pipe on fd 0 where there is no line discipline at all.
 * Measured with a 4090-byte first line: `echo hello` on the next line became `echo h` plus
 * `sh: ello: command not found`, and with a multi-byte character at the seam the word `echo`
 * itself was torn in half and both halves ran. Silent wrong execution, not a diagnostic.
 *
 * `rest` carries the incomplete tail between reads and the decoder is per-loop with
 * `{stream: true}`, so a character split across two reads decodes once and correctly. At end of
 * input an unterminated tail is still run — a script with no final newline has a last command.
 *
 * `maxLine` is a bound on `rest` rather than on the file: input with no newline in it would
 * otherwise let a pipe make this process allocate without limit.
 */
function interactive(sh) {
  const env = sh.env;
  const buf = new Uint8Array(4096);
  const dec = new TextDecoder();
  let rest = "";
  const MAX_LINE = 1024 * 1024;
  for (let i = 0; i < MAX_LINES && !sh.exiting; i += 1) {
    reapJobs(sh);
    // Finished jobs are announced BEFORE the prompt, which is where a shell reports them: after
    // the prompt is painted it is too late to put them above it.
    for (const job of sh.jobs) {
      if (!job.done || job.reported) continue;
      job.reported = true;
      env.std.say(env, `[${job.id}] ${job.how}\t${job.line}\n`);
    }
    sh.jobs = sh.jobs.filter((j) => !j.done);
    // A PROMPT ONLY WHEN THERE IS SOMEBODY TO READ IT. A shell whose stdin is a pipe or a file is
    // running a SCRIPT, and a prompt printed into its output stream becomes part of that output —
    // measured: `cd /usr/bin` then `pwd` down a pipe answered `~$ /usr/bin\n/usr/bin$ ` and every
    // proof that compared the output failed on the decoration rather than on the result. `sh.tty`
    // is `isatty(0)`, asked once at startup.
    if (sh.tty >= 0) writePrompt(sh);
    const n = env.fs.read(0, buf, 0, buf.length);
    // 0 IS END OF INPUT — the terminal closed or Ctrl-D was typed — and it is NOT an error. A
    // negative is: -EINTR means a signal arrived with a handler, and the loop continues, which is
    // what makes Ctrl-C at a prompt print a new prompt rather than ending the session.
    if (n === 0) {
      rest += dec.decode();
      // THE LAST LINE WITHOUT ITS NEWLINE. A script that does not end in one still has a final
      // command, and dropping it would lose the line a user typed before Ctrl-D.
      if (rest.trim() && !sh.exiting) runLine(sh, rest);
      break;
    }
    if (n < 0) {
      if (n === -EINTR) {
        // A SIGNAL DISCARDS THE HALF-TYPED LINE, which is what Ctrl-C at a prompt means
        // everywhere: the next prompt starts empty.
        rest = "";
        continue;
      }
      env.std.warn(env, `${NAME}: read: ${env.std.errnoName(n)}`);
      break;
    }
    rest += dec.decode(buf.subarray(0, n), { stream: true });
    if (rest.length > MAX_LINE) {
      env.std.warn(env, `${NAME}: a line longer than ${MAX_LINE} bytes was discarded`);
      rest = "";
      continue;
    }
    let cut = rest.indexOf("\n");
    while (cut >= 0 && !sh.exiting) {
      const line = rest.slice(0, cut);
      rest = rest.slice(cut + 1);
      runLine(sh, line);
      cut = rest.indexOf("\n");
    }
  }
  return sh.status;
}

/**
 * MAKE SURE THIS PROCESS HOLDS FD 0 BEFORE IT CALLS `pipe2`. Constraint 94.
 *
 * `spawn` installs the sink on 1 and 2 and deliberately leaves 0 unopened, so a `read(0)` is EBADF
 * rather than a silent zero — and `fds.add` hands out the LOWEST free fd, so `pipe2` in a process
 * with no stdin returns **0** as its read end. Every convention that treats 0 as stdin then wires
 * the pipeline backwards: measured in M4, where a stage dup'd fd 0 onto fd 0, closed it as "the
 * pipe fd", and read from a closed descriptor.
 *
 * A shell started on a terminal already has fd 0 and this is a no-op plus one close. A shell
 * started with `-c` and no stdin needs it, and `bench/m4-fs/program.mjs` records in as many words
 * that "M5's shell has to do the same thing or inherit the same bug".
 */
function ensureStdin(env) {
  const probe = env.fs.fstat(0);
  if (typeof probe === "object") return 0;
  /* `/dev/null`, NOT `/dev/zero`. Both hold fd 0, which is all this function is for, and only one
   * of them means "no stdin": `/dev/zero` is an honest finite 256-byte file here
   * (src/kernel/devfs.mjs), so a `-c` shell with no stdin fed 256 NUL bytes to every reader —
   * `sh -c "wc -c"` printed 256 where it must print 0. */
  const fd = env.fs.open("/dev/null", O_RDONLY);
  // A FAILURE IS FATAL TO THE SHELL and is not ignored: with fd 0 free, the first pipeline this
  // shell builds is wired backwards and the failure appears as a hang somewhere else entirely.
  if (fd < 0) return fd;
  if (fd > 0) env.fs.close(fd);
  return fd;
}

export function run(env) {
  const sh = makeSession(env);
  const stdin = ensureStdin(env);
  if (stdin < 0) {
    return {
      exit: env.std.complain(env, NAME, "/dev/null",
        `cannot hold fd 0: ${env.std.errnoName(stdin)}`, 1),
    };
  }
  sh.cwd = readCwd(sh);
  sh.vars.PWD = sh.cwd;
  if (sh.vars.HOME === undefined) sh.vars.HOME = sh.home;
  sh.pgid = env.proc.getpgid(0);

  /* A SHELL MUST NOT DIE OF THE KEYSTROKE IT EXISTS TO FORWARD.
   *
   * The line discipline raises SIGINT on the terminal's FOREGROUND group (M4b). While the shell is
   * waiting for a line that group is the shell's own, so a Ctrl-C at a prompt is delivered here —
   * and at SIG_DFL it is fatal: measured, the shell was reaped with `killed: true, code: 2` and
   * the session ended on the first Ctrl-C.
   *
   * SIG_HANDLE and not SIG_IGN, and the difference is visible to a user. Ignored, the pending
   * `read` would not be interrupted at all and the half-typed line would stay in the buffer;
   * handled, the kernel sets the bit, `read` answers -EINTR, and the loop prints a fresh prompt —
   * which is what every shell does. The three signals are the ones a terminal can generate at a
   * prompt; ^Z is included because there is no job suspension here, so SIG_DFL for it would stop a
   * shell nothing can resume.
   *
   * A CHILD IS UNAFFECTED: dispositions are per process and are NOT inherited through `spawn`
   * (src/kernel/kernel.mjs), so a foreground pipeline still dies of Ctrl-C — which M4 proved and
   * PROOF 7 re-checks from the other side.
   */
  sh.dispositions = {
    SIGINT: env.proc.sigaction(SIGINT, SIG_HANDLE),
    SIGQUIT: env.proc.sigaction(SIGQUIT, SIG_IGN),
    SIGTSTP: env.proc.sigaction(SIGTSTP, SIG_IGN),
  };
  // IS FD 0 A TERMINAL? `tty_get` answering ENOTTY is `isatty()`, and the answer decides whether
  // this shell does job control at all: a `-c` shell on a pipe must not call `tcsetpgrp`.
  sh.tty = typeof env.tty.get(0) === "object" ? 0 : -1;

  const args = (env.argv || []).slice(1);
  if (args[0] === "-c") {
    if (args.length < 2) {
      // `sh -c` with no operand exited 0 in silence. A missing operand is a usage error, named.
      return { exit: env.std.complain(env, NAME, "-c", "needs a line to run", 2) };
    }
    const line = args.slice(1).join(" ");
    const status = runLine(sh, line);
    return { exit: status & 0xff, status, trace: sh.trace, cwd: sh.cwd };
  }
  if (args.length) {
    return {
      exit: env.std.complain(env, NAME, null, "usage: sh [-c line]", 2),
    };
  }
  const status = interactive(sh);
  return { exit: status & 0xff, status, trace: sh.trace, cwd: sh.cwd };
}

/** Exported for the host probe and for `complete`: the parts that need no kernel. */
export const _BUILTINS = BUILTINS;
export const _statusOf = statusOf;
export const _howDone = howDone;
export const _commandNames = commandNames;
