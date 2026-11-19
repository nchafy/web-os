// M7's headline, as one process: TWO WINDOWS AND A PIPE, in one `poll`.
//
// `PLAN.md` §5's proof for M7 in its own words — "one process opens two windows and a pipe, and
// `poll()` wakes it for each in turn". A process has ONE futex word and ONE outstanding call
// (constraint 42), so with a per-window wait this program could not be written at all: parked on
// window A it would be deaf to window B, and parked on either it would be deaf to the pipe.
//
// It also reads `/proc/<pid>/win`, because the directory is the other half of what the milestone
// claims and a program reading it through real syscalls is the only honest witness: the kernel
// could satisfy a page that asked for the same facts over its own message port without a
// filesystem existing at all.
//
// WHAT IT REPORTS, and the shape is what `www/m7.html` asserts on:
//
//   wokeBy      fd -> how many times `poll` reported that fd ready
//   keysSeen    fd -> the printable bytes that arrived on that fd, in order
//   procWin     the `/proc/<pid>/win` listing and the fields of each window's file
//
// It writes a line into WINDOW A for every wake, which is how the page knows a step has landed
// without this program needing a channel back to it — and is incidentally a second demonstration
// that `write(2)` on a window fd paints it.

import {
  POLLIN, POLLHUP, POLLERR, POLLNVAL, O_RDONLY, EINTR, EHOSTGONE, WEV_KEY, SPAWN_DUP2,
  keyBytesOf,
} from "/src/abi.mjs";

const POLL_MS = 200;

/** The wall-clock ceiling. A window nobody types into raises no error — a parked `poll` is a
 *  legitimate state — so this program carries its own deadline and reports its counters with it. */
const CEILING_MS = 45000;

function unInterrupted(call) {
  const first = call();
  if (first !== -EINTR) return first;
  return call();
}

/** `key:\tvalue` lines into an object, which is the shape every `/proc` file here is written in. */
function fields(text) {
  const out = Object.create(null);
  for (const line of String(text).split("\n")) {
    const cut = line.indexOf(":\t");
    if (cut < 0) continue;
    out[line.slice(0, cut)] = line.slice(cut + 2);
  }
  return out;
}

export function run(env) {
  const argv = (env.argv || []).map(String);
  let ceiling = CEILING_MS;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] !== "--ceiling") continue;
    const ms = Number(argv[i + 1]);
    if (!Number.isFinite(ms) || ms <= 0) {
      return { exit: 1, why: `--ceiling wants a positive number, got ${argv[i + 1]}` };
    }
    ceiling = ms;
  }
  const t0 = performance.now();
  const account = {
    program: "poller",
    wins: [], fds: [], pipeFd: 0, childPid: 0,
    wokeBy: {}, keysSeen: {}, cells: 0, polls: 0, wakes: 0,
    pipeDelivered: false, pipeBytes: 0, resizes: 0,
    procWin: null, why: "",
  };

  /* HOLD fd 0 BEFORE CREATING ANYTHING. `spawn` leaves fd 0 free, so the first window landed ON
   * fd 0 — measured — and every convention that treats 0 as stdin was then wrong about it. The
   * same defect `pipe2` had at M4 (constraint 94), reached through a different call. */
  const zero = env.fs.open("/dev/zero", O_RDONLY);
  if (zero < 0) return { exit: 1, ...account, why: `/dev/zero: ${env.std.errnoName(zero)}` };
  if (zero > 0) env.fs.close(zero);

  // TWO WINDOWS, side by side, from one process.
  const a = env.win.create({ title: "poller A", w: 360, h: 180, x: 40, y: 40 });
  if (typeof a === "number") return { exit: 2, ...account, why: `win_create A: ${-a}` };
  const b = env.win.create({ title: "poller B", w: 360, h: 180, x: 420, y: 150 });
  if (typeof b === "number") {
    env.win.destroy(a.fd);
    return { exit: 2, ...account, why: `win_create B: ${-b}` };
  }
  account.wins = [a.win, b.win];
  account.fds = [a.fd, b.fd];

  // AND A PIPE, so the set holds three KINDS of fd. A CHILD writes it, which is what makes the
  // pipe's readiness asynchronous: this process writing its own pipe would prove only that a pipe
  // it had already filled was reported ready.
  const pipe = env.proc.pipe2(0);
  if (typeof pipe === "number") {
    env.win.destroy(a.fd);
    env.win.destroy(b.fd);
    return { exit: 3, ...account, why: `pipe2: ${-pipe}` };
  }
  account.pipeFd = pipe.rfd;
  const child = env.proc.spawn("/usr/bin/echo", ["echo", "pipe-side"], [
    { op: SPAWN_DUP2, a: pipe.wfd, b: 1 },     // the child's stdout IS the pipe
  ]);
  if (child < 0) {
    env.win.destroy(a.fd);
    env.win.destroy(b.fd);
    return { exit: 4, ...account, why: `spawn echo: ${-child}` };
  }
  account.childPid = child;
  /* A SECOND, LONG-LIVED PROCESS, for one clause and one only: `/proc/<other>/win/<winid>` must
   * refuse a window that belongs to THIS process. The winid space is global, so a path that
   * ignored the pid would make every window readable under every process.
   *
   * It needs its own pid because the first attempt read `/proc/1/win/<winid>` — and this program
   * IS pid 1, so it read its own window and reported READABLE, correctly, about a path that was
   * never foreign. And it needs to be LONG-LIVED because an exited process's `/proc` entry goes
   * when the slot is freed, which would make the refusal arrive for the wrong reason. The clause
   * therefore asserts that `<other>/status` is readable at the same moment. */
  // LONGER THAN THIS PROGRAM'S OWN CEILING, deliberately: under `--negative win-first-fd` the
  // poller runs to that ceiling, and a 30-second sleeper had exited and been reaped by then — so
  // the clause it exists for reported NOT MEASURED exactly in the run where it matters most.
  const other = env.proc.spawn("/usr/bin/sleep", ["sleep", "90"], []);
  account.otherPid = other;
  // THIS PROCESS MUST LET GO OF THE WRITE END, or the pipe never reaches end of input and the
  // hangup half of the proof cannot happen (the pipe's own refcount, constraint 92).
  env.fs.close(pipe.wfd);

  const note = (text) => {
    const n = env.fs.write(a.fd, env.std.bytes(`${text}\r\n`));
    if (n > 0) account.cells += n;
  };
  note(`A win ${a.win} fd ${a.fd}`);
  note(`B win ${b.win} fd ${b.fd}`);
  note(`pipe fd ${pipe.rfd} from pid ${child}`);

  const bump = (fd) => { account.wokeBy[fd] = (account.wokeBy[fd] || 0) + 1; };
  const seen = (fd, text) => { account.keysSeen[fd] = (account.keysSeen[fd] || "") + text; };
  let pipeOpen = true;
  /** The window fds still in the poll set. A DESTROYED WINDOW LEAVES IT: `readable()` is true for
   *  ever once a window is gone, so an fd left in the set makes `poll` answer immediately on every
   *  turn and the loop spins at renderer speed — which starves the kernel it shares a renderer
   *  with, the defect `bench/m7-win/wedge.mjs` chose `nanosleep` to avoid. */
  const open = new Set([a.fd, b.fd]);

  for (;;) {
    /* EVERY FD MUST HAVE DELIVERED WHAT IT IS FOR — a key on each window, and bytes or end of
     * input on the pipe. NOT "every fd woke this process once", which is what this loop asked
     * first and which was VACUOUS: the page reports each frame's geometry the moment it builds it,
     * so both windows have a WEV_RESIZE queued before anything is typed and all three fds were
     * ready on the first poll. Measured — `wokeBy {0:1, 3:1}` with `keysSeen {}` and the program
     * exiting before a key was pressed. A condition satisfied by the system's own setup is not a
     * proof of anything. */
    const all = (account.keysSeen[a.fd] || "").length > 0
      && (account.keysSeen[b.fd] || "").length > 0
      && account.pipeDelivered;
    if (all) { account.why = "every fd in the set delivered to this process"; break; }
    if (performance.now() - t0 > ceiling) {
      account.why = `ceiling ${ceiling} ms reached with wokeBy `
        + `${JSON.stringify(account.wokeBy)}`;
      break;
    }
    if (open.size === 0) {
      account.why = "every window of this process is gone";
      break;
    }
    const set = [...open].map((fd) => ({ fd, events: POLLIN }));
    if (pipeOpen) set.push({ fd: pipe.rfd, events: POLLIN });
    account.polls += 1;
    const r = unInterrupted(() => env.tty.poll(set, POLL_MS));
    if (typeof r === "number") {
      if (r === -EINTR) continue;
      account.why = `poll: ${env.std.errnoName(r)}`;
      break;
    }
    if (r.nready > 0) account.wakes += 1;
    for (const row of r.fds) {
      if (row.revents === 0) continue;
      if (row.fd === pipe.rfd) {
        const buf = new Uint8Array(256);
        const n = env.fs.read(pipe.rfd, buf, 0, buf.length);
        bump(row.fd);
        if (n > 0) {
          account.pipeDelivered = true;
          account.pipeBytes += n;
          seen(row.fd, env.std.text(buf.subarray(0, n)));
          note(`wake fd ${row.fd} (pipe): ${n} bytes`);
        } else {
          // End of input. The fd leaves the set rather than being polled for ever at EOF, which
          // would spin this loop at the poll's own rate.
          account.pipeDelivered = true;
          note(`wake fd ${row.fd} (pipe): end of input`);
          env.fs.close(pipe.rfd);
          pipeOpen = false;
        }
        continue;
      }
      if (!(row.revents & POLLIN)) {
        if (row.revents & (POLLHUP | POLLERR | POLLNVAL)) {
          account.why = `fd ${row.fd} hung up`;
          bump(row.fd);
          // OUT OF THE SET, not merely noted: see `open`.
          env.fs.close(row.fd);
          open.delete(row.fd);
        }
        continue;
      }
      const evs = env.win.read(row.fd);
      if (typeof evs === "number") {
        if (evs === -EHOSTGONE) {
          account.why = `fd ${row.fd} is gone`;
          env.fs.close(row.fd);
          open.delete(row.fd);
        }
        continue;
      }
      bump(row.fd);
      for (const ev of evs) {
        if (ev.type !== WEV_KEY) {
          // Counted rather than ignored: the geometry the page reports back is an event too, and
          // the first version of this loop mistook those for the keys it was waiting for.
          account.resizes += 1;
          continue;
        }
        const text = env.std.text(keyBytesOf(ev));
        seen(row.fd, text);
        note(`wake fd ${row.fd}: key ${JSON.stringify(text)}`);
      }
    }
  }

  /* ---- AND THEN `/proc/<pid>/win`, READ THROUGH REAL SYSCALLS -----------------------------
   *
   * The directory is named by WINID and not by fd, which is the only choice that works: a window
   * may be held on several fds through `dup`, and an owner in another process names the winid and
   * has no fd for it at all. Each file publishes the fds that reach it, so the two namespaces can
   * be read against each other — which is what this reports.
   */
  const listing = env.std.listDir(env, `/proc/${env.pid}/win`);
  account.procWin = {
    pid: env.pid,
    names: Array.isArray(listing) ? listing.map((e) => e.name).sort() : { errno: -listing },
    files: {},
  };
  for (const id of [a.win, b.win]) {
    const text = env.std.readFileText(env, `/proc/${env.pid}/win/${id}`);
    account.procWin.files[id] = typeof text === "number" ? { errno: -text } : fields(text);
  }
  // A WINDOW OF ANOTHER PROCESS MUST NOT BE READABLE UNDER THIS ONE. The winid space is global, so
  // a path that ignored the pid would make every window readable under every process.
  account.procWin.fdFile = env.std.readFileText(env, `/proc/${env.pid}/fd/${a.fd}`);
  if (other > 0) {
    const status = env.std.readFileText(env, `/proc/${other}/status`);
    const foreign = env.std.readFileText(env, `/proc/${other}/win/${a.win}`);
    account.procWin.otherPid = other;
    account.procWin.otherAlive = typeof status !== "number";
    account.procWin.foreign = typeof foreign === "number"
      ? env.std.errnoName(foreign) : "READABLE";
  } else {
    // NOT MEASURED, and said so: a clause that passed because the second process never started
    // would be asserting nothing.
    account.procWin.otherAlive = false;
    account.procWin.foreign = `no second process: ${env.std.errnoName(other)}`;
  }
  // And a winid NOBODY owns, which tests the existence check rather than the pid check.
  const absent = env.std.readFileText(env, `/proc/${env.pid}/win/${a.win + 1000}`);
  account.procWin.absent = typeof absent === "number"
    ? env.std.errnoName(absent) : "READABLE";

  note(account.why);
  for (const fd of open) env.win.destroy(fd);
  if (pipeOpen) env.fs.close(pipe.rfd);
  env.proc.waitpid(child, 0);
  if (other > 0) {
    // SIGTERM and then reaped: a `sleep 30` left running would hold a process slot for the rest
    // of the page's life and show up in every later `ps`.
    env.proc.kill(other, 15);
    env.proc.waitpid(other, 0);
  }
  account.ms = performance.now() - t0;
  const ok = (account.keysSeen[a.fd] || "").length > 0
    && (account.keysSeen[b.fd] || "").length > 0 && account.pipeDelivered;
  return { exit: ok ? 0 : 5, ...account };
}
