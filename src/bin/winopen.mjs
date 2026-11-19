// `winopen`: open N windows and wait on all of them at once.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// THIS IS M7's HEADLINE AS A PROGRAM YOU CAN RUN. The milestone's claim is that a window is a file
// description and that `poll()` is the single wait primitive over fds — so the way to see it is one
// process holding several window fds and a pipe, printing which fd woke it and why. A process has
// ONE futex word (constraint 42), so with a per-window wait this program could not exist.
//
// It also demonstrates the two things M7 owes M9 and M10:
//
//   winopen -n 2 -o   the second window is OWNED by the first, so closing the first destroys both
//                     and `win_destroy` reports the cascade
//   winopen -O 3      the first window is owned by WIN 3, WHICH MAY BELONG TO ANOTHER PROCESS —
//                     run `winopen -n 1` in one terminal, note the winid it prints, and pass it
//                     here from another. Closing win 3 then destroys this one too, which is what
//                     a picker broker needs and what M9's owner chain is built on
//   winopen -p        a pipe fd joins the poll set, so the set holds three KINDS of fd and one
//                     wait primitive covers them all
//
// Every line it prints names the fd it came from, which is the whole point: the fd, not a winid, is
// what a process waits on.

import {
  POLLIN, POLLHUP, POLLERR, POLLNVAL, EINTR, EHOSTGONE,
  WEV_KEY, WEV_RESIZE, WEV_CLOSE, WEV_FOCUS, WEV_DESTROYED, keyBytesOf,
  WMODAL_SYSTEM, WMODE_BLOCKING,
} from "/src/abi.mjs";

const NAME = "winopen";

/** How many windows this program will open at once. Well under `WIN_CAP`, because the cap is the
 *  kernel's refusal and this is a demonstration: a reader asking for 32 windows wants a mistake
 *  caught, not a desktop full of frames. */
const WIN_LIMIT = 8;

/** How long one `poll` waits before the loop looks at its own clock. */
const POLL_MS = 250;
/** The wall-clock ceiling on a whole session. A window nobody types into raises no error — a
 *  parked `poll` is a legitimate state — so this program carries its own deadline and names it in
 *  its report. `-c` overrides it, which is what lets a harness run this program under a control
 *  where a window it expected to go does not. */
const CEILING_MS = 60000;

const EVENT_NAME = {
  [WEV_KEY]: "key",
  [WEV_RESIZE]: "resize",
  [WEV_CLOSE]: "close",
  [WEV_FOCUS]: "focus",
  [WEV_DESTROYED]: "destroyed",
};

/** A printable rendering of one event. A control byte is shown as ^X and not as itself: a terminal
 *  printing a raw 0x03 would act on it rather than report it. */
function describe(ev) {
  const name = EVENT_NAME[ev.type] || `type ${ev.type}`;
  if (ev.type === WEV_KEY) {
    const bytes = keyBytesOf(ev);
    const shown = [...bytes].map((b) => {
      if (b === 10) return "\\n";
      if (b === 13) return "\\r";
      if (b === 127) return "^?";
      if (b < 32) return `^${String.fromCharCode(64 + b)}`;
      return String.fromCharCode(b);
    }).join("");
    return `${name} '${shown}' (${bytes.length}B, mods 0x${ev.mods.toString(16)})`;
  }
  if (ev.type === WEV_RESIZE) return `${name} ${ev.a}x${ev.b} cells`;
  if (ev.type === WEV_FOCUS) return `${name} ${ev.a ? "in" : "out"}`;
  if (ev.type === WEV_DESTROYED) return `${name} win ${ev.a}`;
  return name;
}

function unInterrupted(call) {
  const first = call();
  if (first !== -EINTR) return first;
  return call();
}

export function run(env) {
  const argv = (env.argv || []).map(String);
  const { flags, operands, bad, why: badWhy } = env.std.getopt(argv.slice(1), "n:O:c:opS");
  if (bad) return env.std.complain(env, NAME, bad, badWhy, env.std.EXIT_USAGE);
  // The refusal is the program's: `Number("banana")` is NaN, which compares false against every
  // bound and so would behave like `-n 0`.
  const count = flags.n === undefined ? 1 : env.std.wholeNumber(flags.n);
  if (count === null || count < 1 || count > WIN_LIMIT) {
    return env.std.complain(env, NAME, `-n ${flags.n}`, `wants 1..${WIN_LIMIT}`,
      env.std.EXIT_USAGE);
  }
  const own = flags.o === true;
  // A WINID FROM THE COMMAND LINE, which may name a window in ANOTHER PROCESS. Not restricted to
  // ids this process made: that is the whole point of an owner chain a broker can use.
  const outerOwner = flags.O === undefined ? 0 : env.std.wholeNumber(flags.O);
  if (outerOwner === null) {
    return env.std.complain(env, NAME, `-O ${flags.O}`, "wants a winid", env.std.EXIT_USAGE);
  }
  const ceiling = flags.c === undefined ? CEILING_MS : env.std.wholeNumber(flags.c);
  if (ceiling === null || ceiling <= 0) {
    return env.std.complain(env, NAME, `-c ${flags.c}`, "wants a positive number of ms",
      env.std.EXIT_USAGE);
  }
  const wantPipe = flags.p === true;
  /** `-S` MAKES THE FIRST WINDOW SYSTEM-MODAL AND BLOCKING, which freezes every window outside it.
   *  It is here to be RUN: a scope that needs no privilege to take is easier to believe in when a
   *  reader can take it, and the escape hatch it proves - End Process offered on the blocker's own
   *  frame, whether or not it has gone stale - is the answer to "what if a program does this"
   *  (constraint 236). Without that hatch the only recovery is closing the tab. */
  const systemModal = flags.S === true;
  const label = operands.length ? operands[0] : NAME;
  const t0 = performance.now();

  /** fd -> {win, label}. The MAP IS KEYED BY FD because that is what `poll` reports and what this
   *  program is about; the winid is carried for the cascade report. */
  const held = new Map();
  const made = [];
  for (let i = 0; i < count; i += 1) {
    // Each window asks for a different top-left, so N windows are not one window N times over.
    const spec = {
      title: `${label} ${i + 1}`,
      w: 420, h: 260, x: 60 + i * 48, y: 60 + i * 44,
      owner: own && made.length ? made[0].win : outerOwner,
    };
    const r = env.win.create(spec);
    if (typeof r === "number") {
      for (const fd of held.keys()) env.win.destroy(fd);
      return env.std.complainErrno(env, NAME, `win_create #${i + 1}`, r);
    }
    held.set(r.fd, { win: r.win, owner: spec.owner });
    made.push(r);
    // A WRITE INTO THE WINDOW, so a fresh frame is not a blank rectangle and so this program
    // exercises both directions of its own fd rather than only the readable one.
    env.fs.write(r.fd, env.std.bytes(
      `${spec.title}\r\n  fd ${r.fd}   win ${r.win}`
      + `${spec.owner ? `   owner win ${spec.owner}` : ""}\r\n`
      + "  type here. q closes this window.\r\n"));
    env.std.say(env, `win ${r.win} on fd ${r.fd}`
      + (spec.owner ? ` owned by win ${spec.owner}` : "")
      + `  /proc/${env.pid}/win/${r.win}\n`);
  }

  if (systemModal && made.length) {
    const r = env.win.setModal(made[0].fd, WMODAL_SYSTEM, WMODE_BLOCKING);
    if (r < 0) return env.std.complainErrno(env, NAME, "win_set MODAL", r);
    env.std.say(env, `win ${made[0].win} is SYSTEM-modal and BLOCKING: every other window is `
      + "frozen. End Process on its own frame is the way out.\n");
  }

  let pipeRead = -1;
  if (wantPipe) {
    const pipe = env.proc.pipe2(0);
    if (typeof pipe === "number") {
      for (const fd of held.keys()) env.win.destroy(fd);
      return env.std.complainErrno(env, NAME, "pipe2", pipe);
    }
    pipeRead = pipe.rfd;
    // The write end is closed immediately, so the pipe is readable-at-EOF and the poll set has a
    // third KIND of fd in it without this program needing a second process to feed it.
    env.fs.close(pipe.wfd);
    env.std.say(env, `pipe read end on fd ${pipeRead}\n`);
  }

  env.std.say(env, "type in a window; press q there to close it. Ctrl-C here ends the session.\n");

  const account = {
    program: NAME, polls: 0, wakes: 0, events: 0, keys: 0, cascades: [],
    // DESTROY NOTICES AND HANGUPS, counted apart from `events`: a window being taken down under
    // this process is the one thing an owner chain does to it, and `events` includes the geometry
    // the page reports the instant it builds a frame.
    destroyedSeen: 0, hangups: 0, resizes: 0, closes: 0,
  };
  for (;;) {
    if (held.size === 0) { account.why = "every window is gone"; break; }
    if (performance.now() - t0 > ceiling) {
      account.why = `ceiling ${ceiling} ms reached`;
      break;
    }
    const set = [...held.keys()].map((fd) => ({ fd, events: POLLIN }));
    if (pipeRead >= 0) set.push({ fd: pipeRead, events: POLLIN });
    account.polls += 1;
    const r = unInterrupted(() => env.tty.poll(set, POLL_MS));
    if (typeof r === "number") {
      if (r === -EINTR) { account.why = "interrupted"; break; }
      account.why = `poll: ${env.std.errnoName(r)}`;
      break;
    }
    if (r.nready > 0) account.wakes += 1;
    for (const row of r.fds) {
      if (row.revents === 0) continue;
      if (row.fd === pipeRead) {
        // A pipe in the same set as the windows, reported the same way: the point is that ONE wait
        // primitive covers both (constraint 42).
        if (row.revents & (POLLHUP | POLLIN)) {
          env.std.say(env, `fd ${row.fd}: pipe at end of input\n`);
          env.fs.close(pipeRead);
          pipeRead = -1;
        }
        continue;
      }
      const entry = held.get(row.fd);
      if (!entry) continue;
      if (row.revents & POLLIN) {
        const evs = env.win.read(row.fd);
        if (typeof evs === "number") {
          if (evs === -EHOSTGONE) {
            env.std.say(env, `fd ${row.fd}: win ${entry.win} is gone\n`);
            env.fs.close(row.fd);
            held.delete(row.fd);
            continue;
          }
          if (evs < 0 && evs !== -EINTR) {
            env.std.say(env, `fd ${row.fd}: read: ${env.std.errnoName(evs)}\n`);
            continue;
          }
          continue;
        }
        for (const ev of evs) {
          account.events += 1;
          env.std.say(env, `fd ${row.fd} (win ${entry.win}): ${describe(ev)}\n`);
          if (ev.type === WEV_KEY) {
            account.keys += 1;
            const bytes = keyBytesOf(ev);
            // `q` closes THIS window, which is how the cascade is reachable from the keyboard:
            // close the owner and the owned window goes with it.
            if (bytes.length === 1 && (bytes[0] === 0x71 || bytes[0] === 0x51)) {
              const ids = env.win.destroy(row.fd);
              const list = Array.isArray(ids) ? ids : [];
              account.cascades.push(list);
              env.std.say(env, `win_destroy(fd ${row.fd}) -> ${list.length} window(s): `
                + `${list.join(", ")}\n`);
              held.delete(row.fd);
              // Every fd whose window the cascade took is dropped here, or this process keeps
              // polling fds for windows the kernel has forgotten — the desynchronisation the
              // destroy list exists to prevent.
              for (const [fd, other] of [...held]) {
                if (!list.includes(other.win)) continue;
                env.std.say(env, `fd ${fd} (win ${other.win}) went with it\n`);
                env.fs.close(fd);
                held.delete(fd);
              }
              break;
            }
          }
          if (ev.type === WEV_RESIZE) account.resizes += 1;
          /* THE CLOSE REQUEST, HONOURED. It is counted because it did not arrive at all until an
           * independent critic found that `destroy` cleared the queue the page had just put it in
           * — and since M9 it is ACTED ON here rather than by the page: the X asks, and a program
           * that has nothing to save agrees by destroying the window (constraint 44, and
           * `src/bin/editor.mjs` is the program that refuses). */
          if (ev.type === WEV_CLOSE) {
            account.closes += 1;
            const ids = env.win.destroy(row.fd);
            const list = Array.isArray(ids) ? ids : [];
            account.cascades.push(list);
            env.std.say(env, `win ${entry.win} asked to close; destroyed ${list.join(", ")}\n`);
            held.delete(row.fd);
            for (const [fd, other] of [...held]) {
              if (!list.includes(other.win)) continue;
              env.fs.close(fd);
              held.delete(fd);
            }
            break;
          }
          if (ev.type === WEV_DESTROYED) {
            account.destroyedSeen += 1;
            env.fs.close(row.fd);
            held.delete(row.fd);
            break;
          }
        }
        continue;
      }
      if (row.revents & (POLLHUP | POLLERR | POLLNVAL)) {
        account.hangups += 1;
        env.std.say(env, `fd ${row.fd} (win ${entry.win}): hung up\n`);
        env.fs.close(row.fd);
        held.delete(row.fd);
      }
    }
  }

  for (const fd of [...held.keys()]) env.win.destroy(fd);
  if (pipeRead >= 0) env.fs.close(pipeRead);
  env.std.say(env,
    `${NAME}: ${account.why}. ${account.events} events over ${account.wakes} wakes\n`);
  return { exit: 0, ...account };
}
