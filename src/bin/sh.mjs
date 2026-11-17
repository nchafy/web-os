// `sh`: the shell. A userland client of the same ABI as everything else; the program contract it
// is written against is in src/bin/true.mjs.
//
// The front end `src/libos/shlex.mjs` is pure and host-testable. The executor below builds every
// stage from `pipe2` + `spawn` file actions + `setpgid`, which is what replaces `fork`
// (constraint 20). A builtin in any stage of a multi-stage pipeline is refused (constraint 135)
// and `( subshell )` is unsupported.

import {
  DT_DIR, EINTR, ENOENT, O_APPEND, O_CREAT, O_RDONLY, O_TRUNC, O_WRONLY,
  S_IFDIR, S_IFMT, SPAWN_CLOSE, SPAWN_DUP2, SIGNAL_NAME, WNOHANG,
  SIGINT, SIGQUIT, SIGTSTP, SIG_HANDLE, SIG_IGN,
} from "/src/abi.mjs";

const NAME = "sh";

const DEFAULT_PATH = "/usr/bin";

const DEFAULT_HOME = "/";

/** A bound on the interactive read loop, so a terminal that stops answering ends the program
 *  rather than spinning. */
const MAX_LINES = 100000;

/**
 * Everything a shell session carries. No file description lives here: constraint 15 reaches
 * userland too, and a session caching an open fd would leak one per redirection.
 */
function makeSession(env) {
  const envp = env.envp || {};
  return {
    env,
    vars: { ...envp },
    status: 0,
    lastBg: 0,
    oldcwd: null,
    jobs: [],
    nextJob: 1,
    cwd: "/",
    home: envp.HOME || DEFAULT_HOME,
    // `$HOME` and `~` must agree; `run` writes this fallback into `vars`.
    path: envp.PATH || DEFAULT_PATH,
    // The terminal this shell controls, or -1 — fd 0, whose foreground group is the one that matters.
    tty: -1,
    pgid: 0,
    exiting: false,
    // A record of what ran, for the proofs: the page cannot see a pipeline from outside.
    trace: [],
  };
}

/** `/proc/<pid>/cwd` is the only way to read a working directory here: there is no `getcwd` call
 *  (constraint 128). */
function readCwd(sh) {
  const text = sh.env.std.readFileText(sh.env, `/proc/${sh.env.pid}/cwd`);
  if (typeof text === "number") return sh.cwd;
  return text.replace(/\n$/, "") || "/";
}

function lookupVar(sh, name) {
  if (name === "?") return String(sh.status);
  if (name === "$") return String(sh.env.pid);
  if (name === "!") return String(sh.lastBg);
  const v = sh.vars[name];
  return v === undefined ? "" : String(v);
}

/** A job spec — `%N`, `%%`, `%+` — to the job's process-group id, positive. `expandWords` negates
 *  it. An unknown job throws rather than expanding to nothing. */
function jobPgid(sh, spec) {
  const job = (spec === "%" || spec === "+")
    ? currentJob(sh)
    : sh.jobs.find((j) => j.id === Number(spec));
  if (!job) throw new ShellError(`%${spec}: no such job`);
  return job.pgid;
}

function currentJob(sh) {
  for (let i = sh.jobs.length - 1; i >= 0; i -= 1) if (!sh.jobs[i].done) return sh.jobs[i];
  return null;
}

class ShellError extends Error {}

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
 * One stage's words, expanded. Globbing is last and gated on `magic`, which `tokenize` computed
 * from the bare spans as typed: `ls '*'` looks for a file called `*`, and a `*` out of a variable's
 * value is not re-read as a pattern.
 */
function expandWords(sh, words) {
  const out = [];
  const shlex = sh.env.shlex;
  for (const word of words) {
    /* Negative, so one signal reaches every stage rather than the leader alone. `--` because
     * `kill` reads a leading `-<digits>` as a signal and pids start at 1, so a job's group is
     * routinely also a signal number: `kill %1` as `kill -3` would leave no target. */
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

function expandOneWord(sh, word) {
  return sh.env.shlex.expandWord(word, {
    lookup: (n) => lookupVar(sh, n),
    home: sh.home,
  });
}

/**
 * A command name to a program path, or null; a name containing `/` is used as written. Existence
 * only: `SYS_spawn` checks the execute bit against the caller's credential (src/kernel/exec.mjs),
 * and a second check here would be a second permission model that could disagree with it.
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

/**
 * The builtins, as a table; each returns an exit status. The membership rule is that a builtin is a
 * command that cannot be a program. Everything else lives in `/usr/bin`, or one fact has two
 * renderers.
 */
const BUILTINS = {
  ":": () => 0,

  cd(sh, args) {
    const target = args[0] === undefined ? sh.home
      : args[0] === "-" ? (sh.oldcwd || sh.cwd) : args[0];
    const expanded = sh.env.shlex.expandTilde(target, sh.home);
    const r = sh.env.fs.chdir(expanded);
    if (r < 0) return sh.env.std.complainErrno(sh.env, "cd", expanded, r);
    // Asked where we landed, not assumed: a second lexical normalizer here would disagree with the
    // kernel's under symlinks.
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
    // A job is forgotten once reported done, so `jobs` twice prints a finished job once.
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
      /* A pid or a pgid: `$!` is the last stage's pid and `job.pgid` the first stage's, so a
       * pgid-only lookup makes `wait $!` a no-op that returns 0 while the pipeline runs. */
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
    // PATH is re-read here and nowhere else, so `export PATH=/x` takes effect on the next command.
    if (sh.vars.PATH !== undefined) sh.path = String(sh.vars.PATH);
    if (sh.vars.HOME !== undefined) sh.home = String(sh.vars.HOME);
    return 0;
  },

  unset(sh, args) {
    for (const arg of args) delete sh.vars[arg];
    return 0;
  },

  /** `complete <line>`: what Tab would offer. A builtin because the answer needs the builtin table
   *  and this session's PATH, neither of which a program can see. */
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

function howDone(stat) {
  if (!stat) return "Done";
  if (stat.killed) return `Killed (SIG${SIGNAL_NAME[stat.code] || stat.code})`;
  return stat.code ? `Exit ${stat.code}` : "Done";
}

/** Reap whatever has finished, without blocking. An unreaped background command leaves a zombie
 *  holding a pid and a SAB for the ~2 s quarantine (constraint 14). */
function reapJobs(sh) {
  for (const job of sh.jobs) {
    if (job.done) continue;
    for (let i = 0; i < job.pids.length; i += 1) {
      if (job.reaped[i]) continue;
      const stat = sh.env.proc.waitpid(job.pids[i], WNOHANG);
      // `waitpid` answers pid 0 for "alive, nothing to report": not an error, and not done.
      if (typeof stat === "number" || !stat.pid) continue;
      job.reaped[i] = stat;
    }
    if (job.reaped.every((r) => r)) {
      job.done = true;
      job.how = howDone(job.reaped[job.reaped.length - 1]);
    }
  }
}

/** Wait for every process in a job and return the last stage's status, which is the pipeline's. */
function waitJob(sh, job) {
  let last = 0;
  for (let i = 0; i < job.pids.length; i += 1) {
    const stat = job.reaped[i] || sh.env.proc.waitpid(job.pids[i], 0);
    if (typeof stat === "number") {
      // -ECHILD means `reapJobs` already took it, and its status is the one to keep.
      continue;
    }
    job.reaped[i] = stat;
    if (i === job.pids.length - 1) last = statusOf(stat);
  }
  job.done = true;
  job.how = howDone(job.reaped[job.reaped.length - 1]);
  return last;
}

/** How many pipeline rows the trace keeps. The trace is returned whole and `MAX_LINES` is 100,000,
 *  so an uncapped row per line is a message that grows without limit. */
const TRACE_KEEP = 256;

function pushTrace(sh, row) {
  sh.trace.push(row);
  if (sh.trace.length > TRACE_KEEP) sh.trace.shift();
}

/** A wait status as a shell status: 128 + signal for a death, the exit code otherwise. */
function statusOf(stat) {
  if (!stat) return 0;
  return stat.killed ? 128 + stat.code : stat.code;
}

/** Open one stage's redirections. Returns `{stdin, stdout, opened}` or an error. Every `>` target
 *  is opened and only the last receives output, so `echo a > f1 > f2` leaves `f1` there and empty. */
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
  /* Every throw out of `expandOne` becomes an error return, and the fds already opened go with it.
   * An escaped throw leaks one fd per occurrence, and 1,021 of them exhaust OPEN_MAX. */
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
    // A ShellError or UsageError from expansion is a message for the user, not a defect.
    if (error instanceof ShellError || error.name === "UsageError"
        || error.constructor.name === "UsageError") {
      return { error: error.message };
    }
    throw error;
  }
  return { stdin, stdout, opened };
}

/** A redirection target, expanded to one word. It takes the token, so quoting is honoured: `> '*'`
 *  is a file called `*`, and a glob matching several files is an ambiguous redirect. */
function expandOne(sh, word) {
  const text = expandOneWord(sh, word);
  if (!word.magic) return text;
  const matches = sh.env.shlex.expandGlob(text, globOps(sh));
  if (matches.length !== 1) throw new ShellError(`${word.text}: ambiguous redirect`);
  return matches[0];
}

/** Whether a multi-stage pipeline names a builtin. Constraints 20a and 135: with no `fork` this
 *  process cannot be two stages at once, and serialising them hangs once the 64 KiB pipe buffer
 *  fills with nobody reading. */
function pipelineBuiltin(stages, names) {
  if (stages.length < 2) return null;
  for (const name of names) if (Object.hasOwn(BUILTINS, name)) return name;
  return null;
}

/**
 * Run one parsed pipeline: a `pipe2` per boundary, one `spawn` per stage with file actions wiring
 * 0 and 1, every stage in one new process group led by the first so a Ctrl-C reaches the pipeline
 * and not the shell, and that group as the terminal's foreground group for the wait.
 *
 * A pipe end nobody needs must be closed in both the child and the shell: whoever still holds a
 * write end is the reason the reader never sees EOF.
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

  // A single builtin runs in this process: `cd` in a child would change a directory and then exit.
  if (stages.length === 1 && Object.hasOwn(BUILTINS, expanded[0][0])) {
    if (!background) return runBuiltinStage(sh, stages[0], expanded[0]);
    // Refused here rather than falling through to the PATH search, which would answer
    // `cd: command not found` about a command this shell has.
    return std.complain(env, NAME, expanded[0][0],
      "a builtin cannot be backgrounded — there is no fork (constraint 20a)", 2);
  }

  const pipes = [];
  const children = [];
  const myOpened = [];
  let failed = null;
  let cleaned = false;

  /* Runs on every path, including a throw: a skipped cleanup leaves a stage parked in `write` or
   * `read` for ever. `cleaned` makes it idempotent, so the normal path can run it before the wait. */
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
    /* A child this shell started is always reaped. On the throw path there is no job row, so
     * `reapJobs` never sees it and its pid and SAB leak into the quarantine (constraint 14). */
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

/** The spawn loop. Extracted so `runPipeline`'s cleanup is a `finally` over the whole of it rather
 *  than a sequence a `break` or a throw can step past. */
function spawnStages(sh, stages, expanded, pipes, children, myOpened, fail) {
  const env = sh.env;
  const std = env.std;
  for (let i = 0; i < stages.length; i += 1) {
    const words = expanded[i];
    const program = resolveCommand(sh, words[0]);
    if (program === null) {
      // The name is printed even when it is empty, or `sh -c "''"` reports no subject at all.
      fail(std.complain(env, NAME, words[0] === "" ? "''" : words[0], "command not found", 127));
      return;
    }
    const red = openRedirections(sh, stages[i]);
    if (red.error) {
      fail(std.complain(env, NAME, null, red.error, 1));
      return;
    }
    myOpened.push(...red.opened);

    // The pipe to the next stage exists before this spawn, so its write end can be a file action.
    let toNext = null;
    if (i + 1 < stages.length) {
      toNext = env.proc.pipe2();
      if (typeof toNext === "number") {
        fail(std.complainErrno(env, NAME, "pipe2", toNext));
        return;
      }
      pipes.push(toNext);
    }

    const stdin = red.stdin >= 0 ? red.stdin : (i > 0 ? pipes[i - 1].rfd : -1);
    const stdout = red.stdout >= 0 ? red.stdout : (toNext ? toNext.wfd : -1);

    const actions = [];
    if (stdin >= 0) actions.push({ op: SPAWN_DUP2, a: stdin, b: 0 });
    if (stdout >= 0) actions.push({ op: SPAWN_DUP2, a: stdout, b: 1 });
    // Only fds above 2 are closed in the child: a pipe end that landed on 0 or 1 is still reachable
    // by its original number, so closing by value would undo the `dup2` just installed.
    for (const p of pipes) {
      if (p.rfd > 2) actions.push({ op: SPAWN_CLOSE, a: p.rfd });
      if (p.wfd > 2) actions.push({ op: SPAWN_CLOSE, a: p.wfd });
    }
    for (const fd of red.opened) if (fd > 2) actions.push({ op: SPAWN_CLOSE, a: fd });

    const pid = env.proc.spawn(program, words, actions);
    if (pid < 0) {
      // 127 for a program that is not there, 126 for one that could not be run. `-ENOENT`, never a
      // literal: this errno space is WASI's, where ENOENT is 44, so `-2` classifies everything 126.
      fail(std.complainErrno(env, words[0], null, pid, pid === -ENOENT ? 127 : 126));
      return;
    }
    children.push(pid);
    // The group is the first child's pid, set from the shell because the child may already be
    // running. A child left in the shell's own group would make the shell's group the terminal's
    // foreground group below, so the return is checked.
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

/** A backgrounded pipeline: recorded, announced, not waited for. `$!` is the last stage's pid. */
function startBackground(sh, job, children, line) {
  sh.nextJob += 1;
  sh.jobs.push(job);
  sh.lastBg = children[children.length - 1];
  sh.env.std.say(sh.env, `[${job.id}] ${sh.lastBg}\n`);
  pushTrace(sh, { line, pids: children, pgid: job.pgid, background: true });
  return 0;
}

/** A foreground pipeline: the terminal's foreground group, the wait, and the terminal back on every
 *  path — a shell reading its next line without it is a background process on a terminal. */
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

/** A single builtin, with its redirections applied to this process and then undone in a `finally`:
 *  a builtin that threw with stdout still on a file would send every later prompt into that file. */
function runBuiltinStage(sh, stage, words) {
  const env = sh.env;
  const red = openRedirections(sh, stage);
  if (red.error) return env.std.complain(env, NAME, null, red.error, 1);
  const saved = [];
  /** Point `fd` at `to`, remembering what was there; false if the save failed. fd 0 is guaranteed by
   *  `ensureStdin` and 1 and 2 by `spawn`, so a negative return is a failed `dup`, never a closed
   *  fd — treating it as closed would leave the shell with no stdout at all. */
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
      /* A UsageError from expansion rather than parsing: `echo ${}` is four characters a user can
       * type, and without this branch it is reported as a shell defect with exit 70. `instanceof`
       * is unusable: `shlex` arrives through `env`, so a second module instance makes it false. */
      env.std.warn(env, `${NAME}: ${error.message}`);
      sh.status = 2;
    } else {
      // A throw that is not a ShellError is a defect in this program, reported as one.
      env.std.warn(env, `${NAME}: internal error: ${(error && error.stack) || error}`);
      sh.status = 70;
    }
  }
  return sh.status;
}

function prompt(sh) {
  const cwd = sh.cwd === sh.home ? "~" : sh.cwd;
  return `${cwd}$ `;
}

/**
 * Write the prompt, retrying once past an -EINTR. One signal costs two -EINTRs on this ABI
 * (constraint 131): the second lands here, so without the retry Ctrl-C at a prompt prints no new
 * prompt at all. One retry is exactly enough, because the libos entry check clears what it reports.
 */
function writePrompt(sh) {
  const r = sh.env.std.say(sh.env, prompt(sh));
  if (r !== -EINTR) return r;
  return sh.env.std.say(sh.env, prompt(sh));
}

/**
 * The read loop: a prompt, a line, a pipeline.
 *
 * It must buffer a partial line, because this loop also reads a script and `cat script | sh` has a
 * pipe on fd 0 with no line discipline: splitting each 4096-byte read on newlines tears a line at
 * the seam and runs both halves. The decoder is per-loop with `{stream: true}`, so a character
 * split across two reads decodes once. `MAX_LINE` bounds `rest` rather than the file, so input with
 * no newline in it cannot make this process allocate without limit.
 */
function interactive(sh) {
  const env = sh.env;
  const buf = new Uint8Array(4096);
  const dec = new TextDecoder();
  let rest = "";
  const MAX_LINE = 1024 * 1024;
  for (let i = 0; i < MAX_LINES && !sh.exiting; i += 1) {
    reapJobs(sh);
    // Finished jobs are announced before the prompt is painted, not after.
    for (const job of sh.jobs) {
      if (!job.done || job.reported) continue;
      job.reported = true;
      env.std.say(env, `[${job.id}] ${job.how}\t${job.line}\n`);
    }
    sh.jobs = sh.jobs.filter((j) => !j.done);
    // A prompt only when somebody is there to read it (constraint 132). `sh.tty` is `isatty(0)`,
    // asked once at startup.
    if (sh.tty >= 0) writePrompt(sh);
    const n = env.fs.read(0, buf, 0, buf.length);
    // 0 is end of input — the terminal closed, or Ctrl-D — and is not an error.
    if (n === 0) {
      rest += dec.decode();
      if (rest.trim() && !sh.exiting) runLine(sh, rest);
      break;
    }
    if (n < 0) {
      if (n === -EINTR) {
        // A signal discards the half-typed line.
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
 * This process must hold fd 0 before it calls `pipe2`. Constraint 94: `spawn` leaves 0 unopened and
 * `fds.add` hands out the lowest free fd, so `pipe2` would return 0 as its read end and a pipeline
 * wired on the convention that 0 is stdin runs backwards. A `-c` shell with no stdin lands here.
 */
function ensureStdin(env) {
  const probe = env.fs.fstat(0);
  if (typeof probe === "object") return 0;
  /* `/dev/null`, not `/dev/zero`: `/dev/zero` is a finite 256-byte file here
   * (src/kernel/devfs.mjs), so `sh -c "wc -c"` would print 256 where it must print 0. */
  const fd = env.fs.open("/dev/null", O_RDONLY);
  // Fatal to the shell: with fd 0 free the first pipeline is wired backwards, which surfaces as a
  // hang somewhere else entirely.
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

  /* Constraint 130: a shell must not die of the keystroke it exists to forward. SIGINT is handled
   * rather than ignored, because an ignored signal does not interrupt the parked `read` and the
   * half-typed line stays in the buffer. ^Z is ignored because there is no job suspension here, so
   * SIG_DFL would stop a shell nothing can resume. */
  sh.dispositions = {
    SIGINT: env.proc.sigaction(SIGINT, SIG_HANDLE),
    SIGQUIT: env.proc.sigaction(SIGQUIT, SIG_IGN),
    SIGTSTP: env.proc.sigaction(SIGTSTP, SIG_IGN),
  };
  // `tty_get` answering ENOTTY is `isatty()`: a `-c` shell on a pipe must not call `tcsetpgrp`.
  sh.tty = typeof env.tty.get(0) === "object" ? 0 : -1;

  const args = (env.argv || []).slice(1);
  if (args[0] === "-c") {
    if (args.length < 2) {
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

