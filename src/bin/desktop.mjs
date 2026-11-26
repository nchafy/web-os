// `desktop`: the process behind the desktop and the start menu.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// THIS IS M14's HEADLINE AS A PROGRAM YOU CAN RUN, and the thing it demonstrates is that the shell
// is DATA from a process rather than a page's hard-coded list. It opens one window, takes the
// `WROLE_DESKTOP` role, reads the filesystem, and publishes what it found as rows: the files in
// the session's own `Desktop` folder flagged for the desktop, the programs in `/usr/bin` flagged
// for the start menu. The page draws those rows as icons and menu entries, and when one is
// activated the kernel queues a `WEV_ITEM` on this window's own fd — so this program decides what
// opening something means.
//
// WHY THAT DIVISION. A desktop icon needs a label, a picture, a double-click, a selection, a
// rubber band and a context menu. A display list has no text op and no image op, and a
// `WEV_POINTER` only arrives while a button is down (`src/abi.mjs`, `src/wm/winhost.mjs`) — so a
// process cannot DRAW a desktop, and the page cannot read a filesystem. The row is the seam:
// `docs/DECISIONS.md` D39.
//
// WHAT IT DOES NOT DO, stated here rather than discovered: it does not watch the filesystem. There
// is no inotify in this ABI, so the desktop is re-read when a reader asks for it — the `Refresh`
// row in the start menu — and not when something changes underneath.

import {
  WITEM_LABEL_MAX, WIN_ITEM_CAP,
  POLLIN, POLLHUP, POLLERR, POLLNVAL, EINTR, EHOSTGONE,
  WEV_KEY, WEV_CLOSE, WEV_DESTROYED, WEV_RESIZE, WEV_FOCUS, WEV_POINTER, WEV_STATE, WEV_ITEM,
  WROLE_DESKTOP, WITEM_DESKTOP, WITEM_MENU, WITEM_JUMP, WITEM_CONTAINER, WITEM_SEPARATOR,
  WICON_COMPUTER, WICON_FOLDER, WICON_TERMINAL,
  DT_DIR,
} from "/src/abi.mjs";

const NAME = "desktop";

/**
 * Where a reader's own files live, UNDER THE SESSION'S TREE: `${std.sessionDir}/Desktop`. Created
 * if it is missing, which is the one write this program makes to the volume — and it is a mkdir
 * rather than a seed: a desktop that invented files would be a desktop that disagreed with the
 * filesystem.
 *
 * IT WAS A BARE `/desktop`, which was `docs/PLAN-SHELL.md` §7.3's proposal and predates D40. With
 * the whole base copied into the volume a home-shaped tree is expressible, and a directory at the
 * volume root beside it is a second place a reader's files could be. The seed creates no `Desktop`
 * — it copies the base and invents nothing — so this program still makes its own, which is why the
 * mkdir above is unchanged.
 *
 * ON A VOLUME WITH NO SESSION TREE it is under the read-only base and the mkdir is REFUSED, by
 * name, in `account.refusals`: the four shortcuts below still publish, so a desktop in that world
 * has rows and no file icons rather than nothing at all.
 *
 * It is resolved inside `run` and not here, because the answer is a `stat` and a module body holds
 * no `env`.
 */
const DESK_LEAF = "Desktop";

/** Where the programs are. The start menu is a listing of this directory, so a program added to
 *  `src/kernel/providerfs.mjs`'s manifest appears in the menu with no change here. */
const BIN_DIR = "/usr/bin";

/**
 * THE PROGRAMS THAT OPEN A WINDOW OF THEIR OWN. Everything else in `/usr/bin` writes to stdout and
 * owns nothing, so a menu row that spawned one bare started a process that wrote to a stdout
 * nobody was showing and exited: clicking `cat`, `ls`, `grep` or `wc` in the start menu did
 * NOTHING VISIBLE, which is most of the menu, and is how it was reported.
 *
 * So the default is inverted. A row for a program not listed here runs it INSIDE a terminal —
 * `term --run <name>` — which is what Windows 7 does with a console program and what makes every
 * row in the menu open something a reader can see. `sh` was the only member of the old set, and it
 * was the same argument applied to one program instead of to the rule.
 *
 * IT IS AN ALLOWLIST AND NOT A DENYLIST on purpose: a new program in `/usr/bin` gets a terminal
 * until someone says it draws its own window, and the failure of that default is a spare terminal
 * rather than a row that silently does nothing.
 */
const OPENS_OWN_WINDOW = new Set([
  "term", "winopen", "files", "imgview", "paint", "editor", "taskmgr", NAME,
]);

/** Programs the menu does not list. ONE ENTRY AND A REASON: a second `desktop` is refused by the
 *  kernel with -EBUSY (there is one desktop, and `WinMgr.setRole` enforces it), so a row for it
 *  would be a row that always fails. Everything else in `/usr/bin` is listed, including the ones
 *  that do their work without a window — a menu that hid programs a reader can run would be a
 *  menu that disagreed with the filesystem. */
const HIDDEN_FROM_MENU = new Set([NAME]);

/** How long one `poll` waits before the loop looks at its own clock. */
const POLL_MS = 250;

/** A desktop is meant to outlive everything else on screen, so its ceiling is an hour rather than
 *  the minute a demonstration program takes. `-c` overrides it. */
const CEILING_MS = 3600000;

/**
 * A LABEL THE ABI CAN CARRY: at most `WITEM_LABEL_MAX` bytes, cut on a character boundary.
 *
 * THE PUBLISHER TRUNCATES, which `src/abi.mjs` says in as many words — "a refusal would make a
 * long filename unpublishable" — and this program did not. A critic found what that cost: one file
 * in `/desktop` with a 65-byte name made `encodeWinItems` return null, `win_items` answer -EINVAL,
 * and EVERY row disappear — no icons, no start menu, no jump list — because the list is published
 * whole. An ellipsis is what a reader should see instead.
 */
function label(name) {
  const text = String(name);
  const bytes = (s2) => new TextEncoder().encode(s2).length;
  if (bytes(text) <= WITEM_LABEL_MAX) return text;
  let cut = [...text];
  while (cut.length > 1 && bytes(`${cut.join("")}…`) > WITEM_LABEL_MAX) cut.pop();
  return `${cut.join("")}…`;
}

function unInterrupted(call) {
  const first = call();
  if (first !== -EINTR) return first;
  return call();
}

export function run(env) {
  const argv = (env.argv || []).map(String);
  const { flags, bad, why: badWhy } = env.std.getopt(argv.slice(1), "c:");
  if (bad) return env.std.complain(env, NAME, bad, badWhy, env.std.EXIT_USAGE);
  const ceiling = flags.c === undefined ? CEILING_MS : env.std.wholeNumber(flags.c);
  if (ceiling === null || ceiling <= 0) {
    return env.std.complain(env, NAME, `-c ${flags.c}`, "wants a positive number of ms",
      env.std.EXIT_USAGE);
  }
  const t0 = performance.now();
  const account = {
    program: NAME, win: 0, fd: 0, role: 0, items: 0, publishes: 0,
    activations: 0, launched: [], refusals: [], states: [], why: "",
    /* M19a. BOTH DIRECTORIES AND THE REASON, because a driver reading `deskDir` alone cannot tell a
     * desktop folder inside the session's tree from one under the read-only base (D40).
     * `sessionWhy` is "" exactly when the tree is there. */
    deskDir: "", madeDeskDir: false, sessionDir: "", sessionWhy: "",
  };

  /* THE WINDOW FIRST, THEN THE ROLE. `win_create` carries no role — it has no spare register and
   * `win_set` is where a field of a window changes — so there is one frame's worth of time in
   * which this is an ordinary window. The alternative is a seventh argument to `win_create` for a
   * case that happens once per session. */
  const made = env.win.create({ title: "Desktop", w: 800, h: 600, x: 0, y: 0 });
  if (typeof made === "number") {
    return { exit: 2, ...account, why: `win_create: ${env.std.errnoName(made)}`, errno: -made };
  }
  account.win = made.win;
  account.fd = made.fd;
  const role = env.win.setRole(made.fd, WROLE_DESKTOP);
  if (role < 0) {
    env.win.destroy(made.fd);
    return { exit: 3, ...account, why: `win_set ROLE: ${env.std.errnoName(role)}`, errno: -role };
  }
  account.role = WROLE_DESKTOP;

  /** The rows AS PUBLISHED, and what each one MEANS — this program's own array, never sent
   *  anywhere: `WEV_ITEM` reports an INDEX into it, so the shell never learns a path. It is
   *  replaced only when `win_items` has ACCEPTED the list, or the two sides disagree about what
   *  row 3 is. */
  let published = [];

  /** Make the desktop folder if it is not there. A DIRECTORY AND NOTHING IN IT: a program that
   *  wrote example files would be a program that invented a reader's documents. */
  const ensureDeskDir = (deskDir) => {
    const st = env.fs.stat(deskDir);
    if (typeof st !== "number") return 0;
    const r = env.fs.mkdir(deskDir, 0o755);
    if (r < 0) {
      account.refusals.push(`mkdir ${deskDir}: ${env.std.errnoName(r)}`);
      return r;
    }
    account.madeDeskDir = true;
    return 0;
  };

  /**
   * Read the filesystem and publish. Returns how many rows went out, or a negative errno.
   *
   * THE ORDER IS THE ORDER A READER SEES: the fixed rows first, then the desktop folder's
   * contents, then the programs. Every row carries its own `WITEM_*` flags, which is what lets ONE
   * list be a desktop, a start menu and a jump list at once (`src/abi.mjs`).
   */
  const publish = () => {
    /* M19a. RESOLVED PER PUBLISH AND NOT ONCE AT STARTUP. `Refresh` is this ABI's whole answer to
     * having no inotify, so a reader who asks for a re-read must get the filesystem as it is now —
     * and the session's tree is a `stat`, which is exactly the kind of fact a cached copy gets
     * wrong. */
    const session = env.std.sessionDir(env);
    const deskDir = `${session.dir}/${DESK_LEAF}`;
    account.sessionDir = session.dir;
    account.sessionWhy = session.why;
    account.deskDir = deskDir;
    /* BUILT INTO A SEPARATE LIST AND COMMITTED ONLY ON SUCCESS, which a critic found this did not
     * do: `rows` was replaced before the publish was attempted, so a refused publish left the
     * KERNEL holding the previous list while this process held the new one — and a `WEV_ITEM`
     * index the kernel validated against the old list was then looked up in the new array and
     * launched the wrong row. */
    const next = [];
    const rows = next;
    /* THE SHORTCUTS, which are this program's own idea rather than files — Windows 7's fresh
     * desktop has the same kind: Computer, a user's folder, the Recycle Bin. EVERY ONE OF THEM
     * DOES SOMETHING, which is the rule the caption buttons follow too: a row that opened nothing
     * would be the live-looking-button defect with a label on it. They are what makes a desktop
     * usable before a reader has put anything in their desktop folder.
     *
     * THERE IS NO RECYCLE BIN, and that is why: nothing in this system has a trash. A row for it
     * would be a drawing of a feature. */
    rows.push({
      icon: WICON_COMPUTER,
      flags: WITEM_DESKTOP | WITEM_MENU,
      label: "Computer",
      run: () => ["files", "/"],
    });
    rows.push({
      icon: WICON_FOLDER,
      flags: WITEM_DESKTOP | WITEM_CONTAINER,
      label: "Programs",
      run: () => ["files", BIN_DIR],
    });
    /* THE SESSION'S OWN TREE, which is Windows 7's user-folder row and the one place a reader can
     * change anything (D40). It was `Shared files` on `/usr/share` — a READ-ONLY mount, so the row
     * a reader was most likely to press was the one where nothing could be deleted or renamed.
     *
     * THE LABEL IS THE FOLDER'S OWN NAME, so the icon, the file manager's title and the path all
     * say one thing. A fixed label would be a second opinion about where the row goes, and on a
     * volume with no session tree it would be the wrong one.
     *
     * THE BASE IS STILL REACHABLE: `Computer` lists the mount table and `Programs` opens `/usr/bin`
     * directly. A shell that could not show the system would be a worse answer than a read-only
     * default. */
    rows.push({
      icon: WICON_FOLDER,
      flags: WITEM_DESKTOP | WITEM_CONTAINER,
      label: session.dir.split("/").filter((s) => s.length).pop() || "/",
      run: () => ["files", session.dir],
    });
    rows.push({
      icon: WICON_TERMINAL,
      flags: WITEM_DESKTOP | WITEM_MENU,
      label: "Terminal",
      run: () => ["term", "--ceiling", String(ceiling)],
    });

    ensureDeskDir(deskDir);
    const desk = env.std.listDir(env, deskDir);
    if (typeof desk === "number") {
      account.refusals.push(`${deskDir}: ${env.std.errnoName(desk)}`);
    } else {
      for (const entry of desk) {
        if (entry.name === "." || entry.name === "..") continue;
        const path = `${deskDir}/${entry.name}`;
        const isDir = entry.type === DT_DIR;
        // THE ASSOCIATION IS USERLAND'S AND IT HAS ONE DEFINITION, in `src/libos/std.mjs` beside
        // `FORMAT_BY_EXT` and `iconForPath`. It lived here while the desktop was its only reader;
        // M18 gives `files` an activation verb, and a second reader is what moved it.
        const open = env.std.openerForPath(entry.name);
        rows.push({
          icon: env.std.iconForPath(path, { isDir }),
          flags: WITEM_DESKTOP | (isDir ? WITEM_CONTAINER : 0),
          label: entry.name,
          /* A DIRECTORY OPENS IN THE FILE MANAGER, a known file in the program that can show it,
           * and ANYTHING ELSE OPENS ITS FOLDER — which is honest: nothing here can display an
           * arbitrary file, and `files` at least shows it beside its siblings and lets it be
           * dragged to something that can. */
          run: () => {
            if (isDir) return ["files", path];
            if (open) return open.argv(path);
            return ["files", deskDir];
          },
        });
      }
    }

    const bin = env.std.listDir(env, BIN_DIR);
    if (typeof bin === "number") {
      account.refusals.push(`${BIN_DIR}: ${env.std.errnoName(bin)}`);
    } else {
      const names = bin
        .filter((e) => e.name !== "." && e.name !== "..")
        .map((e) => e.name)
        .sort();
      for (const name of names) {
        if (HIDDEN_FROM_MENU.has(name)) continue;
        const ownWindow = OPENS_OWN_WINDOW.has(name);
        rows.push({
          icon: env.std.iconForPath(`${BIN_DIR}/${name}`, { isProgram: true }),
          flags: WITEM_MENU,
          label: ownWindow ? name : `${name} (in a terminal)`,
          /* `sh` IS THE ONE PROGRAM A TERMINAL RUNS BY DEFAULT, so a row for it needs no --run:
           * asking the shell to run `sh` would nest a second one inside the first for nothing. */
          run: () => (ownWindow
            ? [name]
            : name === "sh"
              ? ["term", "--ceiling", String(ceiling)]
              : ["term", "--ceiling", String(ceiling), "--run", name]),
        });
      }
    }

    /* AND THE START MENU'S OWN TWO. A separator, because a Windows 7 menu groups with lines rather
     * than gaps, and Refresh — which is the answer to "this ABI has no inotify": the desktop is
     * re-read when a reader asks. */
    rows.push({ icon: 0, flags: WITEM_MENU | WITEM_SEPARATOR, label: "", run: null });
    rows.push({
      icon: WICON_FOLDER,
      flags: WITEM_MENU | WITEM_JUMP,
      label: "Refresh the desktop",
      run: null,
      refresh: true,
    });
    /* A JUMP LIST FOR THIS WINDOW, so the taskbar has something to show for the desktop — and so
     * one list really does serve three renderings. `term` is the row a reader wants from a
     * right-click on the desktop's own button. */
    rows.push({
      icon: WICON_TERMINAL,
      flags: WITEM_JUMP,
      label: "Open a terminal",
      run: () => ["term", "--ceiling", String(ceiling)],
    });

    /* AND CAPPED, for the same reason the labels are: the list is published whole, so the 65th
     * row would take the other 64 with it. The cut is RECORDED rather than silent — a desktop that
     * is showing less than the filesystem holds has to say so. */
    const capped = next.slice(0, WIN_ITEM_CAP);
    if (capped.length < next.length) {
      account.refusals.push(
        `${next.length} rows is over WIN_ITEM_CAP ${WIN_ITEM_CAP}; ${next.length - capped.length} `
        + "not published");
    }
    const sent = env.win.items(made.fd, capped.map((row) => ({
      icon: row.icon, flags: row.flags, label: label(row.label),
    })));
    if (sent < 0) {
      account.refusals.push(`win_items: ${env.std.errnoName(sent)}`);
      return sent;
    }
    // THE PROCESS'S ARRAY MATCHES THE KERNEL'S LIST FROM HERE, and not before: `WEV_ITEM` carries
    // an index into exactly this list.
    published = capped;
    account.publishes += 1;
    account.items = sent;
    return sent;
  };

  /** Run one row. `spawn` AND NOT A SHELL: the path is this program's, the argv is this program's,
   *  and there is no string for a shell to re-parse. */
  const launch = (row) => {
    if (row.refresh) {
      publish();
      return "refresh";
    }
    if (typeof row.run !== "function") return "inert";
    const argvOf = row.run();
    const path = `${BIN_DIR}/${argvOf[0]}`;
    const pid = env.proc.spawn(path, argvOf);
    if (pid < 0) {
      account.refusals.push(`spawn ${path}: ${env.std.errnoName(pid)}`);
      return `refused ${env.std.errnoName(pid)}`;
    }
    account.launched.push({ pid, argv: argvOf });
    env.std.say(env, `${NAME}: ${argvOf.join(" ")} -> pid ${pid}\n`);
    return `pid ${pid}`;
  };

  publish();
  env.std.say(env, `${NAME}: win ${made.win} on fd ${made.fd}, ${account.items} rows published\n`);
  env.std.say(env, "double-click an icon, or use the start menu. Ctrl-C here ends the session.\n");

  for (;;) {
    if (performance.now() - t0 > ceiling) {
      account.why = `ceiling ${ceiling} ms reached`;
      break;
    }
    const r = unInterrupted(() => env.tty.poll([{ fd: made.fd, events: POLLIN }], POLL_MS));
    if (typeof r === "number") {
      if (r === -EINTR) { account.why = "interrupted"; break; }
      account.why = `poll: ${env.std.errnoName(r)}`;
      break;
    }
    const rev = r.fds[0].revents;
    if (rev & (POLLHUP | POLLERR | POLLNVAL)) {
      account.why = "the window hung up";
      break;
    }
    if (!(rev & POLLIN)) continue;
    const evs = env.win.read(made.fd, 64);
    if (typeof evs === "number") {
      if (evs === -EHOSTGONE) { account.why = "the window was destroyed"; break; }
      if (evs !== -EINTR) { account.why = `read: ${env.std.errnoName(evs)}`; break; }
      continue;
    }
    let done = false;
    for (const ev of evs) {
      if (ev.type === WEV_RESIZE || ev.type === WEV_FOCUS || ev.type === WEV_POINTER) continue;
      if (ev.type === WEV_STATE) {
        // THE DESKTOP HAS NO SHOW STATE — the kernel refuses one (`WinMgr.setState`) — so an event
        // here would mean the two sides disagree. Recorded rather than ignored.
        account.states.push({ a: ev.a, b: ev.b });
        continue;
      }
      if (ev.type === WEV_ITEM) {
        account.activations += 1;
        const row = published[ev.a];
        if (!row) {
          account.refusals.push(`item ${ev.a} is not a row this process published`);
          continue;
        }
        env.std.say(env, `${NAME}: ${row.label} (row ${ev.a}) -> ${launch(row)}\n`);
        continue;
      }
      if (ev.type === WEV_KEY) continue;
      if (ev.type === WEV_CLOSE) {
        /* A DESKTOP DOES NOT CLOSE ON A CLOSE REQUEST, and it has no X to send one — the frame has
         * no caption. If one arrives it is counted and refused, which is a program exercising the
         * close CONTRACT: the request is the page's and the answer is the program's
         * (constraint 44). */
        account.refusals.push("a close request: a desktop has nothing to close to");
        continue;
      }
      if (ev.type === WEV_DESTROYED) {
        account.why = `win ${ev.a} was destroyed`;
        done = true;
        break;
      }
    }
    if (done) break;
  }

  env.win.items(made.fd, []);
  env.win.destroy(made.fd);
  env.std.say(env, `${NAME}: ${account.why}. ${account.activations} activations, `
    + `${account.launched.length} launched\n`);
  return { exit: 0, ...account };
}
