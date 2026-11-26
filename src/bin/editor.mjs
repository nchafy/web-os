// `editor`: a window you type in, and a MODAL DIALOG it will not close without.
//
// The contract this program is written against is in src/bin/true.mjs.
//
// THIS IS M9's HEADLINE AS A PROGRAM YOU CAN RUN. The milestone's claim is that an owned window is
// two things at once — a SCOPE (which windows it affects) and a BEHAVIOUR (what happens to them) —
// and that a close is a REQUEST the program may refuse. Both are visible here in about ten
// seconds:
//
//   type something, then press the X          the editor does NOT close. A dialog appears, and the
//                                             editor is still there behind it
//   click the editor's title bar               it does not come up. The dialog is BLOCKING, so the
//                                             kernel refuses the raise and flashes the dialog
//   type into the editor                       nothing arrives. Input to a blocked window is
//                                             suppressed by the kernel, and the editor's own
//                                             counter says how much
//   press Esc in the dialog                    the dialog goes and the editor is editable again —
//                                             which is the REFUSAL: the close was asked and denied
//   press y or n                               both windows go, because destroying the owner
//                                             cascades (M7)
//
// The dialog is a TEXT window and not a surface: a question is words, and a window with no surface
// shows what a process writes to it (M7). That is why M9 needs no text op.
//
// TWO FLAGS, AND NEITHER BELONGS ON A PROMPT. Both open an extra window that exists to show a rule
// rather than to be useful, so the PRODUCT path — `editor <path>`, which is what the file
// association runs for a `.txt` or `.md` — opens exactly ONE window:
//
//   -a   a second window of this process, so an APP-modal dialog can be seen blocking it where a
//        WINDOW-modal one does not. That difference is the whole reason there are two axes.
//   -p   the tool PALETTE: owned, RENDER_ABOVE, blocking nothing. It is the only thing that shows
//        the owner CHAIN apart from modality. It was unconditional until a reader pointed out that
//        opening a text file put a second window on their desktop; `www/m9.html` passes it now.
//
// M16: EVERY WINDOW THIS PROGRAM OPENS IS A TEXT WINDOW, so it answers no `WEV_CLIENT` and calls
// none of `src/libos/std.mjs`'s re-surface helpers. The `WEV_CLIENT` branch below states
// what asking for a surface here would cost, because a reader diffing M16 across the other four
// programs will come looking for the call that is absent.

import {
  POLLIN, POLLHUP, POLLERR, POLLNVAL, EINTR, EHOSTGONE,
  WEV_KEY, WEV_CLOSE, WEV_DESTROYED, WEV_RESIZE, WEV_FOCUS, WEV_CLIENT,
  WMODAL_NONE, WMODAL_WINDOW, WMODAL_APP, WMODE_BLOCKING, WMODE_RENDER_ABOVE,
  keyBytesOf,
} from "/src/abi.mjs";

const NAME = "editor";

const POLL_MS = 200;
const CEILING_MS = 120000;

/** What the dialog asks. Written into the dialog window as cells, because a window with no
 *  surface is a text window and a question is text. */
const ASK = [
  "",
  "  Save changes before closing?",
  "",
  "    y   save and close",
  "    n   close without saving",
  "    Esc keep editing",
  "",
].join("\r\n");

function unInterrupted(call) {
  const first = call();
  if (first !== -EINTR) return first;
  return call();
}

export function run(env) {
  const argv = (env.argv || []).map(String);
  const { flags, bad, why: badWhy } = env.std.getopt(argv.slice(1), "ap");
  if (bad) return env.std.complain(env, NAME, bad, badWhy, env.std.EXIT_USAGE);
  /** `-a` makes the dialog APP-modal rather than window-modal, which blocks EVERY window of the
   *  owner's process rather than just the one it belongs to. The difference is only visible with a
   *  second window, which this program opens under `-a` so there is something to block. */
  const appModal = flags.a === true;
  /* `-p`: open the tool PALETTE. A fixture for M9's owner-chain proof and not a product feature —
   * see the palette's own block below for what leaving it unconditional cost a reader. */
  const wantPalette = flags.p === true;
  const t0 = performance.now();
  const account = {
    program: NAME, win: 0, fd: 0, second: 0, dialog: 0, palette: 0,
    typed: "", keys: 0, closes: 0, refusals: 0, clients: 0, suppressedWhileModal: 0,
    opened: "", openError: "",
    raiseRefused: 0, why: "",
  };

  const made = env.win.create({
    title: `${NAME} — notes`, w: 460, h: 220,
    // CLEAR OF THE DESKTOP'S ICON COLUMN: see `WIN_ORIGIN_X` in src/libos/std.mjs.
    x: env.std.WIN_ORIGIN_X, y: env.std.WIN_ORIGIN_Y,
  });
  if (typeof made === "number") {
    return { exit: 2, ...account, why: `win_create: ${env.std.errnoName(made)}`, errno: -made };
  }
  account.win = made.win;
  account.fd = made.fd;
  /**
   * M14. AN OPERAND OPENS A FILE, which is what a double-click on a text icon has to mean: the
   * desktop names a path and this program shows what is in it.
   *
   * IT IS SHOWN AND NOT LOADED FOR EDITING, and the difference is stated because the window invites
   * typing: this is a text window with a buffer of its own, so the file's bytes are WRITTEN to the
   * screen and the buffer stays empty. Saving does not exist here — there is no `write` path in
   * this program at all — and a program that looked like it was editing a file it could not save
   * would be the live-looking-button defect with a file attached.
   */
  const opening = argv.slice(1).find((a) => a[0] !== "-") || "";
  if (opening) {
    const body = env.std.readFileText(env, opening);
    account.opened = opening;
    if (typeof body === "number") {
      account.openError = env.std.errnoName(body);
      env.fs.write(made.fd, env.std.bytes(
        `${NAME}: ${opening}: ${env.std.errnoName(body)}\r\n\r\n> `));
    } else {
      env.win.setTitle(made.fd, `${NAME} — ${opening}`);
      // CRLF, because a window is a terminal-shaped surface and a bare LF leaves the cursor in
      // the column it was in (`src/wm/terminal.mjs`).
      env.fs.write(made.fd, env.std.bytes(
        `${opening} (read-only view)\r\n\r\n${body.replace(/\n/g, "\r\n")}\r\n\r\n> `));
    }
  } else {
    env.fs.write(made.fd, env.std.bytes(
      `${NAME}: win ${made.win} on fd ${made.fd}\r\n`
      + "type something, then press the X on this window.\r\n\r\n> "));
  }

  /** A SECOND WINDOW OF THE SAME PROCESS, under `-a` only: an app-modal dialog blocks it and a
   *  window-modal one does not, and that difference is the whole reason there are two axes. */
  let second = null;
  if (appModal) {
    const other = env.win.create({ title: `${NAME} — scratch`, w: 300, h: 140, x: 520, y: 40 });
    if (typeof other !== "number") {
      second = other;
      account.second = other.win;
      env.fs.write(other.fd, env.std.bytes(
        "a second window of the same process.\r\n"
        + "an APP-modal dialog blocks this too; a window-modal one does not.\r\n"));
    }
  }

  /**
   * A PALETTE: owned by the editor, RENDER_ABOVE and NOT modal. It is here because it is the one
   * thing that shows the owner CHAIN apart from modality — it rides up when the editor is raised
   * and it blocks nothing, so a raise that is granted still has to bring it along.
   *
   * `MILESTONES.md`'s ordering correction is the reason both exist: `Passive` vs `RenderAbove` vs
   * `Blocking` are three different things an owned window can be, and a design with only "modal"
   * cannot tell a tool palette from a save dialog.
   *
   * IT IS BEHIND `-p` NOW, AND IT USED TO BE UNCONDITIONAL. That made it part of the PRODUCT: the
   * file association opens `editor <path>` for a `.txt` or `.md` (`src/libos/std.mjs`'s
   * `OPENS_FILES`), so double-clicking a text file put TWO windows on the desktop — the document
   * and a 150x90 palette reading "tools / above the editor, and blocks nothing". A reader asked for
   * it to stop, and they were right: a tool palette nothing in this program uses is a demonstration,
   * not a feature, and M9's own page is where a demonstration belongs.
   *
   * SO IT IS A FIXTURE, on the same footing as `-a`'s scratch window above it and as
   * `files --no-drain`: a shipped flag whose only job is to put the system in a state a check
   * needs. `www/m9.html` passes it, which is what keeps M9's owner-chain proof measuring a real
   * chain rather than an empty one.
   */
  let palette = null;
  if (wantPalette) {
    const pal = env.win.create({
      title: `${NAME} — tools`, owner: made.win, w: 150, h: 90, x: 520, y: 200,
    });
    if (typeof pal !== "number") {
      const r = env.win.setModal(pal.fd, WMODAL_NONE, WMODE_RENDER_ABOVE);
      if (r < 0) {
        env.win.destroy(pal.fd);
      } else {
        palette = pal;
        account.palette = pal.win;
        env.fs.write(pal.fd, env.std.bytes(
          "tools\r\n\r\nabove the editor,\r\nand blocks nothing.\r\n"));
      }
    }
  }

  let dialog = null;
  let dirty = false;

  /** Open the dialog, owned by the editor, BLOCKING at the chosen scope. The two calls are
   *  separate on purpose: `win_create` names the owner and `win_set` sets the modality, so a
   *  window is never modal for an instant before its owner is known. */
  const ask = () => {
    const d = env.win.create({
      title: "Save changes?", owner: made.win, w: 320, h: 160, x: 150, y: 120,
    });
    if (typeof d === "number") return d;
    const scope = appModal ? WMODAL_APP : WMODAL_WINDOW;
    const r = env.win.setModal(d.fd, scope, WMODE_BLOCKING);
    if (r < 0) {
      env.win.destroy(d.fd);
      return r;
    }
    env.fs.write(d.fd, env.std.bytes(ASK));
    dialog = d;
    account.dialog = d.win;
    return 0;
  };

  const windows = () => {
    const set = [{ fd: made.fd, events: POLLIN }];
    if (second) set.push({ fd: second.fd, events: POLLIN });
    if (palette) set.push({ fd: palette.fd, events: POLLIN });
    if (dialog) set.push({ fd: dialog.fd, events: POLLIN });
    return set;
  };

  for (;;) {
    if (performance.now() - t0 > CEILING_MS) {
      account.why = `ceiling ${CEILING_MS} ms reached`;
      break;
    }
    const r = unInterrupted(() => env.tty.poll(windows(), POLL_MS));
    if (typeof r === "number") {
      if (r === -EINTR) continue;
      account.why = `poll: ${env.std.errnoName(r)}`;
      break;
    }
    for (const row of r.fds) {
      if (row.revents === 0) continue;
      if (row.revents & (POLLHUP | POLLERR | POLLNVAL)) {
        if (row.fd === made.fd) account.why = "the editor's window hung up";
        continue;
      }
      const evs = env.win.read(row.fd, 32);
      if (typeof evs === "number") {
        if (evs === -EHOSTGONE && row.fd === made.fd) {
          account.why = "the editor's window was destroyed";
        }
        continue;
      }
      const isDialog = dialog && row.fd === dialog.fd;
      for (const ev of evs) {
        if (ev.type === WEV_FOCUS) continue;
        // CELLS, not pixels (`src/kernel/wins.mjs`'s `setBox`), and nothing here reflows: the text
        // is written to the window's own screen and `src/wm/terminal.mjs` owns the grid.
        if (ev.type === WEV_RESIZE) continue;
        if (ev.type === WEV_CLIENT) {
          /**
           * M16. THIS PROGRAM HOLDS NO SURFACE AND MUST NOT ACQUIRE ONE, so
           * `env.std.resurface` MUST NOT be called here. The swap is one-way: a window is a text
           * window until `win_surface` succeeds and a pixel window afterwards, after which
           * `writeCells` answers -EINVAL to every `write` on the fd and counts it `refusedCells`
           * (`src/kernel/wins.mjs`). An editor that answered this event the way `files` does
           * would go blank at its first resize and echo nothing a reader typed.
           *
           * COUNTED RATHER THAN DISCARDED SILENTLY, because a deliberate discard and an event
           * that never fired are the same bare `continue` otherwise. The count is the only thing
           * that tells them apart from outside the process.
           */
          account.clients += 1;
          continue;
        }
        if (ev.type === WEV_DESTROYED) {
          if (row.fd === made.fd) account.why = "the editor's window was destroyed";
          continue;
        }
        if (ev.type === WEV_CLOSE) {
          /* THE CLOSE IS A REQUEST AND THIS IS THE REFUSAL. Nothing is destroyed here: the X has
           * posted an event, the frame is still up, and the program decides. A clean buffer
           * closes at once; a dirty one asks. */
          account.closes += 1;
          if (isDialog) {
            // The X on the dialog is a cancel, which is the same answer as Esc.
            env.win.destroy(dialog.fd);
            dialog = null;
            account.refusals += 1;
            continue;
          }
          if (!dirty) {
            account.why = "closed with nothing to save";
            break;
          }
          if (!dialog) {
            const opened = ask();
            if (opened < 0) {
              account.why = `the dialog could not open: ${env.std.errnoName(opened)}`;
              break;
            }
          }
          continue;
        }
        if (ev.type !== WEV_KEY) continue;
        const bytes = keyBytesOf(ev);
        if (bytes.length === 0) continue;
        account.keys += 1;
        if (isDialog) {
          const ch = String.fromCharCode(bytes[0]);
          if (ch === "y" || ch === "n") {
            if (ch === "y") env.fs.write(made.fd, env.std.bytes("\r\n[saved]\r\n"));
            // DESTROYING THE OWNER TAKES THE DIALOG WITH IT (M7's cascade), so this is one call
            // and the ids it returns say both went.
            const ids = env.win.destroy(made.fd);
            account.destroyed = Array.isArray(ids) ? ids : [];
            account.why = ch === "y" ? "saved and closed" : "closed without saving";
            dialog = null;
            break;
          }
          if (bytes[0] === 27) {
            // ESC: THE REFUSAL. The dialog goes, the editor stays, and the close that was asked
            // for did not happen.
            env.win.destroy(dialog.fd);
            dialog = null;
            account.refusals += 1;
            env.fs.write(made.fd, env.std.bytes("\r\n[still editing]\r\n> "));
          }
          continue;
        }
        // The editor itself. Typed text is echoed by this program — there is no pty here, so
        // nothing else would show it.
        dirty = true;
        const ch = bytes[0] === 10 ? "\r\n" : env.std.text(bytes);
        account.typed += ch;
        env.fs.write(made.fd, env.std.bytes(ch));
      }
      if (account.why) break;
    }
    if (account.why) break;
    // HOW MUCH INPUT THE MODAL ATE, read out of `/proc` rather than guessed: the kernel suppresses
    // keys to a blocked window and this is the only way the program can know it happened.
    if (dialog) {
      const text = env.std.readFileText(env, `/proc/${env.pid}/win/${made.win}`);
      if (typeof text !== "number") {
        const line = text.split("\n").find((l) => l.startsWith("suppressed:\t"));
        if (line) account.suppressedWhileModal = Number(line.slice("suppressed:\t".length)) || 0;
      }
    }
  }

  if (dialog) env.win.destroy(dialog.fd);
  if (palette) env.win.destroy(palette.fd);
  if (second) env.win.destroy(second.fd);
  const left = env.win.destroy(made.fd);
  account.left = Array.isArray(left) ? left : [];
  account.ms = performance.now() - t0;
  env.std.say(env, `${NAME}: ${account.why}. ${account.keys} keys, ${account.closes} close `
    + `request(s), ${account.refusals} refused\n`);
  return { exit: 0, ...account };
}
